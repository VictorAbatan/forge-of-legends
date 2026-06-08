// ═══════════════════════════════════════════════════════════════
//  THE GOLDEN FLAGON — Pub / Tavern System  (pub.js)
//
//  Games:
//    1. Tavern Dice (D20 number-pick, multiplayer)   — LIVE
//    2. Against the House (D6, solo vs Barkeep)       — LIVE
//    3. Highest Roll (D20, multiplayer)               — LIVE
//    4. Devil's Hand (card matching, 3–4 players)     — LIVE
//
//  Architecture: each multiplayer game is a Firestore doc under
//  "pubGames/{gameId}" — real-time via onSnapshot.
// ═══════════════════════════════════════════════════════════════

import { db } from "../firebase/firebase.js";
import {
  doc, getDoc, addDoc, updateDoc, deleteDoc, onSnapshot,
  collection, query, where, orderBy, limit,
  serverTimestamp, getDocs, runTransaction, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

const _functions     = getFunctions(getApp(), "europe-west1");
const _fnCreateGame       = httpsCallable(_functions, "createPubGame");
const _fnJoinGame         = httpsCallable(_functions, "joinPubGame");
const _fnRollGame         = httpsCallable(_functions, "rollPubGame");
const _fnCreateDevilsHand = httpsCallable(_functions, "createDevilsHandGame");
const _fnJoinDevilsHand   = httpsCallable(_functions, "joinDevilsHandGame");

// ── Module state ───────────────────────────────────────────────
let _uid      = null;
let _charData = null;
let _activeGameUnsub = null;
let _activeGameId    = null;
let _resultsUnsub    = null;
let _lobbyGamesUnsub = null;
let _awardedGameIds  = new Set();
let _tdCancelTimer   = null;
let _hrCancelTimer   = null;
let _dhCancelTimer   = null;

// ── Location constants ─────────────────────────────────────────
// ── Live countdown helper ──────────────────────────────────────
// Starts a 1-second interval that rewrites only the countdown portion
// of a status bar element. Returns the interval id.
// buildText(secsLeft) → full string to set on statusEl.textContent
// Clears itself automatically when secsLeft hits 0.
function _startCancelCountdown(statusEl, createdMs, buildText) {
  const expiresMs = createdMs + 3 * 60 * 1000;
  function tick() {
    if (!statusEl || !document.body.contains(statusEl)) { clearInterval(id); return; }
    const secsLeft = Math.max(0, Math.ceil((expiresMs - Date.now()) / 1000));
    statusEl.textContent = buildText(secsLeft);
    if (secsLeft === 0) clearInterval(id);
  }
  tick(); // fire immediately so there's no 1-second blank
  const id = setInterval(tick, 1000);
  return id;
}

const PUB_LOCATIONS = {
  northern: {
    location:    "Frostspire",
    travelId:    "The Frosty Flagon — Frostspire",
    label:       "The Frosty Flagon",
    continent:   "Northern Continent",
    continentId: "frostveil",
    capitalDest: "Frostspire — Gladys Kingdom",
    capitalCost: 100, capitalTime: 60,
  },
  western: {
    location:    "Solmere",
    travelId:    "The Sunken Cask — Solmere",
    label:       "The Sunken Cask",
    continent:   "Western Continent",
    continentId: "verdantis",
    capitalDest: "Solmere — Elaria Kingdom",
    capitalCost: 100, capitalTime: 60,
  },
};

function _isAtPub() {
  const loc = (_charData?.kingdom || _charData?.location || "").toLowerCase();
  return Object.values(PUB_LOCATIONS).some(p => loc.includes(p.label.toLowerCase()));
}
function _isAtCapitalOf(p) {
  const loc = (_charData?.kingdom || _charData?.location || "").toLowerCase();
  return loc.includes(p.location.toLowerCase()) && !loc.includes(p.label.toLowerCase());
}
function _isInContinentOf(p) {
  const stored = (_charData?.continent || _charData?.travelContinent || "").toLowerCase();
  if (stored && p.continent.toLowerCase().split(" ")[0]) {
    if (stored.includes(p.continent.toLowerCase().split(" ")[0])) return true;
  }
  const loc = (_charData?.kingdom || _charData?.location || "").toLowerCase();
  const KEYWORDS = {
    frostveil: ["frostspire","whitecrest","icerun","paleglow","mistveil","frostfang","sheen lake","misty hollow","dark cathedral","wisteria","silver lake","hobbit cave","arctic willow","dream river","suldan mine","shrine of secrets","aurora basin","forgotten estuary"],
    verdantis: ["solmere","sunpetal","basil","riverend","verdance","whispering forest","golden plains","element valley","defiled sanctum","asahi valley","moss stream","argent grotto","golden river","shiny cavern","purgatory","temple of verdict","heart garden","valley of overflowing"],
  };
  return (KEYWORDS[p.continentId] || []).some(kw => loc.includes(kw));
}
function _getCurrentPub() {
  const loc = (_charData?.kingdom || _charData?.location || "").toLowerCase();
  return Object.values(PUB_LOCATIONS).find(p => loc.includes(p.label.toLowerCase())) || null;
}

// ── Barkeep dialogue lines ─────────────────────────────────────
const BARKEEP_LINES = [
  "Feeling lucky tonight, traveller?",
  "Last night's winner walked out with 42,000 coins. Could be you.",
  "Care for a roll? The dice don't lie.",
  "Sit down, friend. Your fortune awaits at the table.",
  "I've seen warriors tremble at a roll of the dice.",
  "The pot's getting heavy. Someone's going home rich.",
];

// ── Game table definitions ─────────────────────────────────────
const PUB_GAMES = [
  {
    id:   "tavern-dice",
    icon: "🎲",
    name: "Tavern Dice",
    desc: "Pick a number on a D20. Closest to the roll wins the pot.",
    tags: [{ text:"Luck", cls:"pub-tag-type" }, { text:"2–8 Players", cls:"pub-tag-players" }],
    live: true,
  },
  {
    id:   "house-mode",
    icon: "🏠",
    name: "Against the House",
    desc: "Roll a D6 against Barkeep Rowan. Win 5× your bet or lose it all.",
    tags: [{ text:"Solo", cls:"pub-tag-type" }, { text:"1 Player", cls:"pub-tag-players" }],
    live: true,
  },
  {
    id:   "highest-roll",
    icon: "⚔️",
    name: "Highest Roll",
    desc: "Everyone rolls a D20. Highest number takes the whole pot.",
    tags: [{ text:"Luck", cls:"pub-tag-type" }, { text:"2–10 Players", cls:"pub-tag-players" }],
    live: true,
  },
  {
    id:   "devils-hand",
    icon: "🃏",
    name: "Devil's Hand",
    desc: "5 cards laid on the table. Match the most to win. Bet, raise, or fold — 5 rounds of pure nerve.",
    tags: [{ text:"Strategy", cls:"pub-tag-type" }, { text:"3–4 Players", cls:"pub-tag-players" }],
    live: true,
  },
];

// ── Init ───────────────────────────────────────────────────────
export function initPubSystem(uid, charData) {
  _uid      = uid;
  _charData = charData;
}
export function updatePubCharData(charData) {
  _charData = charData;
}
window.initPubSystem     = initPubSystem;
window.updatePubCharData = updatePubCharData;

window._openPubPanel = function() {
  if (typeof window.switchPanel === 'function') window.switchPanel('pub');
  else document.querySelector('[data-panel="pub"]')?.click();
};

// ── Render pub panel ───────────────────────────────────────────
window.renderPubPanel = function() {
  _uid      = _uid      || window._uid;
  _charData = _charData || window._charData;

  const panel = document.getElementById('panel-pub');
  if (!panel) return;

  // ── Dead player restriction ───────────────────────────────────────────────
  // Dead players cannot travel, enter the pub, or use location chat.
  // They can only chat in General Chat and access the trade panel.
  if (_charData?.isDead) {
    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;gap:16px;text-align:center;">
        <div style="font-size:3rem">💀</div>
        <div style="color:var(--gold);font-family:var(--font-mono);font-size:1.1rem;letter-spacing:0.1em;text-transform:uppercase;">You Are Dead</div>
        <div style="color:var(--text-dim);font-size:0.9rem;max-width:320px;line-height:1.6;">
          The pub doors are barred to the deceased. You cannot travel, gamble, or speak in location chat until you are resurrected.<br><br>
          You may still chat in <strong style="color:var(--gold)">General Chat</strong> and trade with other players.
        </div>
      </div>`;
    return;
  }

  if (!_isAtPub()) { _renderPubGate(panel); return; }

  const pub = _getCurrentPub();
  _renderPubMain(panel, pub);
};

// ── Gate view ─────────────────────────────────────────────────
function _renderPubGate(panel) {
  // Dead players are shown the death overlay in renderPubPanel before reaching here,
  // but guard again in case _renderPubGate is ever called directly.
  if ((_charData || window._charData)?.isDead) {
    renderPubPanel(); // re-route through the dead overlay
    return;
  }
  const cards = Object.values(PUB_LOCATIONS).map(p => {
    const atCapital   = _isAtCapitalOf(p);
    const inContinent = _isInContinentOf(p);
    let statusHtml, actionHtml;
    if (atCapital) {
      statusHtml = `<div class="pub-gate-status ready">✓ You are in ${p.location}</div>`;
      actionHtml = `<button class="pub-gate-action-btn" onclick="window._pubTravelTo('${p.travelId}','${p.continent}')">ENTER PUB — 10 💰 · 30s</button>`;
    } else if (inContinent) {
      statusHtml = `<div class="pub-gate-status near">📍 You are in the ${p.continent}</div>`;
      actionHtml = `
        <button class="pub-gate-action-btn" onclick="window.openTravelModal?.('${p.capitalDest}','${p.continent}',20,60)">
          TRAVEL TO ${p.location.toUpperCase()} — 20 💰 · 1 min
        </button>`;
    } else {
      statusHtml = `<div class="pub-gate-status far">🌍 ${p.continent}</div>`;
      actionHtml = `<div class="pub-gate-hint">Travel to the ${p.continent} first, then find ${p.location}.</div>
        <button class="pub-gate-action-btn secondary" onclick="window.openTravelModal?.('${p.capitalDest}','${p.continent}',${p.capitalCost},${p.capitalTime})">
          TRAVEL THERE — ${p.capitalCost} 💰 · 1 min
        </button>`;
    }
    return `
      <div class="pub-gate-loc-card${atCapital ? ' pub-gate-loc-ready' : ''}">
        <div class="pub-gate-loc-top">
          <div class="loc-name">${p.label}</div>
          <div class="loc-cont">${p.continent} · ${p.location}</div>
        </div>
        ${statusHtml}
        ${actionHtml}
      </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="pub-gate">
      <div class="pub-gate-icon">🍺</div>
      <div class="pub-gate-title">THE GOLDEN FLAGON</div>
      <div class="pub-gate-desc">The pub is only open to those who've made the journey. Find your nearest tavern in a capital city.</div>
      <div class="pub-gate-locations">${cards}</div>
    </div>`;
}

window._pubTravelTo = function(travelId, continent) {
  if ((_charData || window._charData)?.isDead) {
    window.showToast?.('☠️ Dead players cannot travel. Resurrect first.', 'error');
    return;
  }
  if (typeof window.openTravelModal === 'function') {
    window.openTravelModal(travelId, continent, 10, 30);
  } else if (typeof window._startTravel === 'function') {
    window._startTravel({ dest: travelId, continent, cost: 10, seconds: 30 });
    if (typeof window.switchPanel === 'function') window.switchPanel('map');
  } else {
    window.showToast?.('Open the World Map to travel.', '');
  }
};

// Opens the capital map view from the pub gate panel (used when player is in continent but not at capital)
window._viewCapitalFromPub = function(continentId) {
  if (typeof window.switchPanel === 'function') window.switchPanel('map');
  setTimeout(() => {
    window._renderCapital?.(continentId);
  }, 120);
};

// ── Pub Manual ────────────────────────────────────────────────
function _buildPubManualHtml() {
  return `
  <div class="pub-manual" id="pub-manual">
    <div class="pub-manual-header" onclick="window._togglePubManual()">
      <div class="pub-manual-header-left">
        <span class="pub-manual-icon">📖</span>
        <span class="pub-manual-title">RULES OF THE HOUSE</span>
        <span class="pub-manual-sub">How to Play All 4 Games</span>
      </div>
      <div class="pub-manual-chevron" id="pub-manual-chevron">▼</div>
    </div>

    <div class="pub-manual-body" id="pub-manual-body">

      <!-- ── TAVERN DICE ── -->
      <div class="pub-manual-game">
        <div class="pub-manual-game-header">
          <div class="pub-manual-game-icon">🎲</div>
          <div>
            <div class="pub-manual-game-name">Tavern Dice</div>
            <div class="pub-manual-game-meta">Luck · 2–8 Players · D20</div>
          </div>
          <div class="pub-manual-game-tags">
            <span class="pub-manual-badge luck">Luck</span>
            <span class="pub-manual-badge multi">Multiplayer</span>
          </div>
        </div>

        <div class="pub-manual-cols">
          <div class="pub-manual-rules">
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">1</span>
              <span>Each player <strong>picks a unique number</strong> from 1–20 on the grid. No two players can share a number.</span>
            </div>
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">2</span>
              <span>Place your <strong>bet</strong> (any amount). All bets go into the pot.</span>
            </div>
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">3</span>
              <span>The host rolls the D20. <strong>Closest number wins the entire pot.</strong> Ties are broken by whoever is numerically closer; if equal distance, the lower number wins.</span>
            </div>
            <div class="pub-manual-example">
              <span class="pub-manual-example-label">Example</span>
              Roll lands on <strong>14</strong>. Alice picked 13, Bob picked 16.
              Alice wins — she's only 1 away, Bob is 2 away.
            </div>
          </div>
          <div class="pub-manual-diagram">
            <!-- D20 grid diagram with animated dice -->
            <svg class="pub-manual-svg" viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
              <!-- Number grid sample -->
              <g opacity="0.7">
                ${[...Array(10)].map((_,i) => `
                  <rect x="${10 + (i%5)*36}" y="${i<5?10:50}" width="30" height="26" rx="5"
                    fill="${i===3?'rgba(201,168,76,0.22)':i===7?'rgba(91,159,224,0.18)':'rgba(255,255,255,0.04)'}"
                    stroke="${i===3?'rgba(201,168,76,0.6)':i===7?'rgba(91,159,224,0.5)':'rgba(255,255,255,0.1)'}" stroke-width="1"/>
                  <text x="${25 + (i%5)*36}" y="${i<5?28:68}" text-anchor="middle"
                    fill="${i===3?'#c9a84c':i===7?'#5b9fe0':'rgba(255,255,255,0.35)'}"
                    font-size="11" font-family="monospace">${[3,7,11,14,18,2,6,9,16,20][i]}</text>
                `).join('')}
              </g>
              <!-- Labels -->
              <text x="26" y="100" fill="rgba(201,168,76,0.8)" font-size="7" font-family="monospace" letter-spacing="0.05em">YOUR PICK</text>
              <text x="98" y="100" fill="rgba(91,159,224,0.8)" font-size="7" font-family="monospace" letter-spacing="0.05em">RIVAL'S PICK</text>
              <!-- Dice -->
              <rect x="70" y="108" width="60" height="44" rx="10"
                fill="rgba(26,18,8,0.9)" stroke="rgba(201,168,76,0.5)" stroke-width="1.5"/>
              <text x="100" y="138" text-anchor="middle" fill="#c9a84c" font-size="20" font-family="serif" class="pub-manual-dice-roll">14</text>
              <!-- Arrow from dice to winning number -->
              <line x1="100" y1="108" x2="39" y2="87" stroke="rgba(78,200,120,0.55)" stroke-width="1.2" stroke-dasharray="3,3"/>
              <circle cx="39" cy="84" r="3" fill="#4ec878" opacity="0.8"/>
              <text x="100" y="155" text-anchor="middle" fill="rgba(78,200,120,0.7)" font-size="7" font-family="monospace">CLOSEST WINS</text>
            </svg>
          </div>
        </div>
      </div>

      <!-- ── AGAINST THE HOUSE ── -->
      <div class="pub-manual-game">
        <div class="pub-manual-game-header">
          <div class="pub-manual-game-icon">🏠</div>
          <div>
            <div class="pub-manual-game-name">Against the House</div>
            <div class="pub-manual-game-meta">Solo · 1 Player · D6 · 5× Payout</div>
          </div>
          <div class="pub-manual-game-tags">
            <span class="pub-manual-badge solo">Solo</span>
            <span class="pub-manual-badge risk">High Risk</span>
          </div>
        </div>

        <div class="pub-manual-cols">
          <div class="pub-manual-rules">
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">1</span>
              <span>Pick a <strong>face on the D6</strong> (1 through 6).</span>
            </div>
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">2</span>
              <span>Set your <strong>wager</strong>. Barkeep Rowan rolls for the house.</span>
            </div>
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">3</span>
              <span>If the roll <strong>matches your pick</strong>, you win <strong>5× your wager</strong>. Miss, and you lose it all.</span>
            </div>
            <div class="pub-manual-example">
              <span class="pub-manual-example-label">Example</span>
              You pick <strong>4</strong>, wager <strong>200 💰</strong>. Roll lands on 4 → you win <strong>1,000 💰</strong>.
              Roll is 2 → you lose your 200 💰.
            </div>
            <div class="pub-manual-odds">
              <span class="pub-manual-odds-label">Odds</span>
              1 in 6 chance · 5× payout · House edge 1/6
            </div>
          </div>
          <div class="pub-manual-diagram">
            <svg class="pub-manual-svg" viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
              <!-- D6 faces -->
              ${[1,2,3,4,5,6].map((n,i) => {
                const x = 10 + (i%3)*62, y = i<3 ? 10 : 72;
                const picked = n===4;
                return `
                <rect x="${x}" y="${y}" width="50" height="50" rx="9"
                  fill="${picked?'rgba(201,168,76,0.18)':'rgba(255,255,255,0.03)'}"
                  stroke="${picked?'rgba(201,168,76,0.7)':'rgba(255,255,255,0.09)'}" stroke-width="${picked?1.5:1}"/>
                ${n===1?`<circle cx="${x+25}" cy="${y+25}" r="4" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/>`
                  :n===2?`<circle cx="${x+14}" cy="${y+14}" r="3.2" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+36}" r="3.2" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/>`
                  :n===3?`<circle cx="${x+14}" cy="${y+14}" r="3" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+25}" cy="${y+25}" r="3" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+36}" r="3" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/>`
                  :n===4?`<circle cx="${x+14}" cy="${y+14}" r="3" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+14}" r="3" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+14}" cy="${y+36}" r="3" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+36}" r="3" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/>`
                  :n===5?`<circle cx="${x+14}" cy="${y+14}" r="2.8" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+14}" r="2.8" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+25}" cy="${y+25}" r="2.8" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+14}" cy="${y+36}" r="2.8" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+36}" r="2.8" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/>`
                  :`<circle cx="${x+14}" cy="${y+12}" r="2.6" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+12}" r="2.6" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+14}" cy="${y+25}" r="2.6" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+25}" r="2.6" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+14}" cy="${y+38}" r="2.6" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/><circle cx="${x+36}" cy="${y+38}" r="2.6" fill="${picked?'#c9a84c':'rgba(255,255,255,0.3)'}"/>`
                }
                ${picked?`<text x="${x+25}" y="${y+58}" text-anchor="middle" fill="rgba(201,168,76,0.7)" font-size="6.5" font-family="monospace">YOUR PICK</text>`:''}
              `}).join('')}
              <!-- Payout label -->
              <text x="100" y="150" text-anchor="middle" fill="rgba(78,200,120,0.75)" font-size="8.5" font-family="monospace" letter-spacing="0.1em">MATCH = 5× PAYOUT</text>
            </svg>
          </div>
        </div>
      </div>

      <!-- ── HIGHEST ROLL ── -->
      <div class="pub-manual-game">
        <div class="pub-manual-game-header">
          <div class="pub-manual-game-icon">⚔️</div>
          <div>
            <div class="pub-manual-game-name">Highest Roll</div>
            <div class="pub-manual-game-meta">Luck · 2–10 Players · D20</div>
          </div>
          <div class="pub-manual-game-tags">
            <span class="pub-manual-badge luck">Luck</span>
            <span class="pub-manual-badge multi">Multiplayer</span>
          </div>
        </div>

        <div class="pub-manual-cols">
          <div class="pub-manual-rules">
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">1</span>
              <span>Everyone at the table <strong>places a bet</strong>. All bets pool into one pot.</span>
            </div>
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">2</span>
              <span>The host rolls. Every player rolls a D20 <strong>simultaneously</strong>.</span>
            </div>
            <div class="pub-manual-rule-step">
              <span class="pub-manual-step-num">3</span>
              <span><strong>Highest single roll wins the whole pot.</strong> Ties are resolved by re-roll between tied players.</span>
            </div>
            <div class="pub-manual-example">
              <span class="pub-manual-example-label">Example</span>
              4 players bet 250 each → pot is <strong>1,000 💰</strong>.
              Rolls: 17, <strong>19</strong>, 11, 14. The player who rolled 19 takes it all.
            </div>
          </div>
          <div class="pub-manual-diagram">
            <svg class="pub-manual-svg" viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
              <!-- 4 player dice results -->
              ${[
                {x:10,  y:20, val:17, win:false},
                {x:78,  y:20, val:19, win:true},
                {x:10,  y:90, val:11, win:false},
                {x:78,  y:90, val:14, win:false},
              ].map(d => `
                <rect x="${d.x}" y="${d.y}" width="58" height="58" rx="10"
                  fill="${d.win?'rgba(78,200,120,0.12)':'rgba(255,255,255,0.03)'}"
                  stroke="${d.win?'rgba(78,200,120,0.6)':'rgba(255,255,255,0.09)'}" stroke-width="${d.win?1.5:1}"/>
                <text x="${d.x+29}" y="${d.y+36}" text-anchor="middle"
                  fill="${d.win?'#4ec878':'rgba(255,255,255,0.4)'}"
                  font-size="22" font-family="serif">${d.val}</text>
                ${d.win?`<text x="${d.x+29}" y="${d.y+52}" text-anchor="middle" fill="#4ec878" font-size="7" font-family="monospace">WINNER</text>`:''}
              `).join('')}
              <!-- Pot -->
              <rect x="148" y="50" width="48" height="60" rx="8"
                fill="rgba(201,168,76,0.08)" stroke="rgba(201,168,76,0.3)" stroke-width="1"/>
              <text x="172" y="76" text-anchor="middle" fill="#c9a84c" font-size="13">💰</text>
              <text x="172" y="91" text-anchor="middle" fill="rgba(201,168,76,0.8)" font-size="8" font-family="monospace">POT</text>
              <text x="172" y="103" text-anchor="middle" fill="rgba(201,168,76,0.6)" font-size="7.5" font-family="monospace">1,000</text>
              <!-- Arrow from winner to pot -->
              <path d="M136 49 Q141 50 148 65" fill="none" stroke="rgba(78,200,120,0.5)" stroke-width="1.2" stroke-dasharray="3,2"/>
              <text x="100" y="155" text-anchor="middle" fill="rgba(255,255,255,0.25)" font-size="7" font-family="monospace">HIGHEST D20 ROLL TAKES ALL</text>
            </svg>
          </div>
        </div>
      </div>

      <!-- ── DEVIL'S HAND ── -->
      <div class="pub-manual-game pub-manual-game-devils">
        <div class="pub-manual-game-header">
          <div class="pub-manual-game-icon">🃏</div>
          <div>
            <div class="pub-manual-game-name">Devil's Hand</div>
            <div class="pub-manual-game-meta">Strategy · 3–4 Players · 5 Rounds</div>
          </div>
          <div class="pub-manual-game-tags">
            <span class="pub-manual-badge strategy">Strategy</span>
            <span class="pub-manual-badge multi">Multiplayer</span>
          </div>
        </div>

        <div class="pub-manual-rules pub-manual-rules-full">
          <div class="pub-manual-rule-step">
            <span class="pub-manual-step-num">1</span>
            <span><strong>Lobby:</strong> The host sets a <strong>base stake</strong> (e.g. 100 💰). Other players join and the stake is locked in for all.</span>
          </div>
          <div class="pub-manual-rule-step">
            <span class="pub-manual-step-num">2</span>
            <span><strong>Each Round (×5):</strong> The base stake is automatically deducted from every player and pooled. 5 cards are laid face-up on the table. Each player is secretly dealt 5 cards.</span>
          </div>
          <div class="pub-manual-rule-step">
            <span class="pub-manual-step-num">3</span>
            <span><strong>Betting:</strong> Players act in turn — <strong>Raise</strong> (pay another base stake, add it to the pot) or <strong>Fold</strong> (surrender — but get half your stake back).</span>
          </div>
          <div class="pub-manual-rule-step">
            <span class="pub-manual-step-num">4</span>
            <span><strong>Resolution:</strong> Cards are revealed. Whoever among the active players has the <strong>most cards matching the table's 5</strong> wins that round's pot.</span>
          </div>
          <div class="pub-manual-rule-step">
            <span class="pub-manual-step-num">5</span>
            <span><strong>Game Winner:</strong> After 5 rounds, the player who <strong>won the most rounds</strong> takes the entire accumulated pot.</span>
          </div>
        </div>

        <!-- Money flow visual -->
        <div class="pub-manual-money-flow">
          <div class="pub-manual-mf-title">💰 Money Flow</div>
          <div class="pub-manual-mf-grid">
            <div class="pub-manual-mf-cell">
              <div class="pub-manual-mf-icon">🚪</div>
              <div class="pub-manual-mf-label">Round Start</div>
              <div class="pub-manual-mf-desc">Everyone pays <strong>base stake</strong> → goes into Round Pot</div>
            </div>
            <div class="pub-manual-mf-arrow">→</div>
            <div class="pub-manual-mf-cell pub-manual-mf-raise">
              <div class="pub-manual-mf-icon">⬆</div>
              <div class="pub-manual-mf-label">Raise</div>
              <div class="pub-manual-mf-desc">Pay another <strong>base stake</strong> → added to pot. Shows confidence.</div>
            </div>
            <div class="pub-manual-mf-arrow">or</div>
            <div class="pub-manual-mf-cell pub-manual-mf-fold">
              <div class="pub-manual-mf-icon">✖</div>
              <div class="pub-manual-mf-label">Fold</div>
              <div class="pub-manual-mf-desc">Get back <strong>half your stake</strong>. Lose the other half to the pot.</div>
            </div>
            <div class="pub-manual-mf-arrow">→</div>
            <div class="pub-manual-mf-cell pub-manual-mf-win">
              <div class="pub-manual-mf-icon">🏆</div>
              <div class="pub-manual-mf-label">Round Winner</div>
              <div class="pub-manual-mf-desc">Most card matches wins that round's entire pot.</div>
            </div>
          </div>
          <div class="pub-manual-mf-note">
            ⚠ Tiebreaker: if two players tie on matches, the one who <strong>Raised</strong> wins. If both raised (or neither), the pot is <strong>split</strong>.
          </div>
        </div>

        <!-- Card matching diagram -->
        <div class="pub-manual-card-demo">
          <div class="pub-manual-cd-label">⚜ How Card Matching Works</div>
          <div class="pub-manual-cd-row">
            <div class="pub-manual-cd-group">
              <div class="pub-manual-cd-group-label">Table's Hand</div>
              <div class="pub-manual-cd-cards">
                ${['🗡','🔥','💀','🌙','⚡'].map((sym,i) => `
                  <div class="pub-manual-mini-card pub-manual-mini-table">${sym}</div>
                `).join('')}
              </div>
            </div>
          </div>
          <div class="pub-manual-cd-players">
            <div class="pub-manual-cd-player">
              <div class="pub-manual-cd-pname">Player A</div>
              <div class="pub-manual-cd-cards">
                ${['🗡','🌊','💀','🍄','🔥'].map((sym,i) => `
                  <div class="pub-manual-mini-card ${['🗡','🔥','💀','🌙','⚡'].includes(sym)?'pub-manual-mini-match':''}">${sym}</div>
                `).join('')}
              </div>
              <div class="pub-manual-cd-score pub-manual-cd-winner">3 matches 🏆</div>
            </div>
            <div class="pub-manual-cd-player">
              <div class="pub-manual-cd-pname">Player B</div>
              <div class="pub-manual-cd-cards">
                ${['🌊','🍄','🌙','🍎','💧'].map((sym,i) => `
                  <div class="pub-manual-mini-card ${['🗡','🔥','💀','🌙','⚡'].includes(sym)?'pub-manual-mini-match':''}">${sym}</div>
                `).join('')}
              </div>
              <div class="pub-manual-cd-score">1 match</div>
            </div>
          </div>
        </div>

        <div class="pub-manual-example">
          <span class="pub-manual-example-label">Full Example</span>
          3 players, base stake 100 💰. Round starts: 300 💰 in pot.
          Alice raises (+100 → pot is 400 💰). Bob raises (+100 → pot 500 💰). Carl folds (gets 50 💰 back, pot stays 500 💰).
          Reveal: Alice has 3 matches, Bob has 1. <strong>Alice wins 500 💰</strong> for this round.
          After 5 rounds, the player with the most round wins claims the <strong>total accumulated pot</strong>.
        </div>
      </div>

    </div><!-- /pub-manual-body -->
  </div>`;
}

window._togglePubManual = function() {
  const body    = document.getElementById('pub-manual-body');
  const chevron = document.getElementById('pub-manual-chevron');
  if (!body) return;
  const open = body.classList.toggle('pub-manual-open');
  if (chevron) chevron.textContent = open ? '▲' : '▼';
};

// ── Main pub view ─────────────────────────────────────────────
function _renderPubMain(panel, pub) {
  const quote = BARKEEP_LINES[Math.floor(Date.now() / 60000) % BARKEEP_LINES.length];

  panel.innerHTML = `
    <div id="pub-lobby" class="pub-lobby">
      <div class="pub-header-inner">
        <div class="pub-barkeep-portrait">🍻</div>
        <div class="pub-header-text">
          <h2>${pub.label}</h2>
          <div class="pub-tagline">A place for games, gold, and glory.</div>
        </div>
        <div class="pub-location-badge">
          <span class="pub-loc-name">${pub.location}</span>
          <span class="pub-loc-continent">${pub.continent}</span>
        </div>
      </div>

      <div class="pub-barkeep-dialogue">
        <div class="barkeep-face">🧔</div>
        <div class="pub-barkeep-quote">
          <strong>Barkeep Rowan</strong><br>
          "${quote}"
        </div>
      </div>

      ${_buildPubManualHtml()}

      <div class="pub-tables-grid" id="pub-tables-grid">
        ${PUB_GAMES.map(g => `
          <div class="pub-table-card${g.live ? '' : ' locked'}" onclick="${g.live ? `window._openPubGame('${g.id}')` : 'void(0)'}">
            <div class="pub-table-status${g.live ? '' : ' coming-soon'}">${g.live ? 'OPEN' : 'SOON'}</div>
            <div class="pub-table-icon">${g.icon}</div>
            <div class="pub-table-name">${g.name}</div>
            <div class="pub-table-desc">${g.desc}</div>
            <div class="pub-table-tags">
              ${g.tags.map(t => `<span class="pub-tag ${t.cls}">${t.text}</span>`).join('')}
            </div>
          </div>`).join('')}
      </div>

      <div class="pub-results-feed" id="pub-results-feed">
        <h4>Recent Results</h4>
        <div id="pub-results-list"><div class="pub-result-empty">No games played yet tonight.</div></div>
      </div>
    </div>

    <div id="pub-game-container"></div>`;

  _listenForRecentResults();
  _checkLiveGames();
}

function _listenForRecentResults() {
  if (_resultsUnsub) { _resultsUnsub(); _resultsUnsub = null; }
  const pubLocation = _getCurrentPub()?.location || 'unknown';
  const q = query(
    collection(db, 'pubGames'),
    where('status', '==', 'complete'),
    where('pubLocation', '==', pubLocation),
    orderBy('completedAt', 'desc'),
    limit(8)
  );
  _resultsUnsub = onSnapshot(q, snap => {
    const el = document.getElementById('pub-results-list');
    if (!el) return;
    if (snap.empty) { el.innerHTML = '<div class="pub-result-empty">No games played yet tonight.</div>'; return; }
    el.innerHTML = snap.docs.map(d => {
      const g = d.data();
      const timeAgo = g.completedAt?.toDate ? _timeAgo(g.completedAt.toDate()) : '';
      return `<div class="pub-result-row">
        <span>${_gameIcon(g.gameType)}</span>
        <span class="winner-name">${g.winnerName || '—'}</span>
        <span style="color:var(--text-dim);font-size:0.72rem">won</span>
        <span class="prize-amt">+${g.prize || 0} 💰</span>
        <span style="font-size:0.65rem;color:var(--ash);margin-left:4px">${timeAgo}</span>
      </div>`;
    }).join('');
  }, () => {});
}

function _gameIcon(type) {
  return { 'tavern-dice':'🎲', 'house-mode':'🏠', 'highest-roll':'⚔️', 'devils-hand':'🃏' }[type] || '🎲';
}
function _timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function _checkLiveGames() {
  if (_lobbyGamesUnsub) { _lobbyGamesUnsub(); _lobbyGamesUnsub = null; }
  const pub = _getCurrentPub();
  if (!pub) return;
  const q = query(
    collection(db, 'pubGames'),
    where('status', 'in', ['open', 'lobby']),
    where('pubLocation', '==', pub.location),
    limit(10)
  );
  _lobbyGamesUnsub = onSnapshot(q, snap => {
    document.querySelectorAll('.pub-table-status').forEach(el => {
      const card = el.closest('.pub-table-card');
      if (card && !card.classList.contains('locked')) {
        el.textContent = 'OPEN';
        el.classList.remove('active-game');
      }
    });
    snap.docs.forEach(d => {
      const g = d.data();
      const card = document.querySelector(`.pub-table-card[onclick*="${g.gameType}"] .pub-table-status`);
      if (card) { card.textContent = 'LIVE'; card.classList.add('active-game'); }
    });
  }, () => {});
}

window._openPubGame = function(gameId) {
  if ((_charData || window._charData)?.isDead) {
    window.showToast?.('☠️ Dead players cannot gamble. Resurrect first.', 'error');
    return;
  }
  const game = PUB_GAMES.find(g => g.id === gameId);
  if (!game || !game.live) { window.showToast?.('Coming soon!', ''); return; }

  document.getElementById('pub-lobby').style.display = 'none';
  const container = document.getElementById('pub-game-container');
  container.innerHTML = '';

  if (gameId === 'tavern-dice')   { _buildTavernDiceView(container);  _tdWatchOpenTable(); }
  else if (gameId === 'house-mode')    _buildHouseModeView(container);
  else if (gameId === 'highest-roll')  { _buildHighestRollView(container); _hrWatchOpenTable(); }
  else if (gameId === 'devils-hand')   { _buildDevilsHandView(container); _dhWatchLobby(); }
};

function _backToLobby() {
  if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
  if (_tdTableUnsub)    { _tdTableUnsub();    _tdTableUnsub    = null; }
  if (_hrTableUnsub)    { _hrTableUnsub();    _hrTableUnsub    = null; }
  if (_dhLobbyUnsub)    { _dhLobbyUnsub();    _dhLobbyUnsub    = null; }
  if (_tdCancelTimer)   { clearInterval(_tdCancelTimer); _tdCancelTimer = null; }
  if (_hrCancelTimer)   { clearInterval(_hrCancelTimer); _hrCancelTimer = null; }
  if (_dhCancelTimer)   { clearInterval(_dhCancelTimer); _dhCancelTimer = null; }
  _activeGameId = null;
  const container = document.getElementById('pub-game-container');
  if (container) container.innerHTML = '';
  const lobby = document.getElementById('pub-lobby');
  if (lobby) lobby.style.display = '';
  _checkLiveGames();
}
window._pubBackToLobby = _backToLobby;

// ═══════════════════════════════════════════════════════════════
//  GAME 1: TAVERN DICE — D20 number pick, multiplayer
// ═══════════════════════════════════════════════════════════════
const MAX_TAVERN_DICE_PLAYERS = 8;

function _buildTavernDiceView(container) {
  container.innerHTML = `
    <div class="pub-game-view active" id="game-tavern-dice">
      <button class="pub-game-back-btn" onclick="window._pubBackToLobby()">← Back to Lobby</button>
      <div class="pub-game-header">
        <h3>🎲 Tavern Dice</h3>
        <p>Pick a number. Whoever is closest to the D20 roll wins the pot.</p>
      </div>

      <div class="pub-dice-arena">
        <div class="pub-number-grid" id="td-number-grid">
          ${Array.from({length:20},(_,i)=>`
            <button class="pub-num-btn" data-n="${i+1}" onclick="window._tdPickNumber(${i+1})">${i+1}</button>`
          ).join('')}
        </div>

        <div class="pub-dice-wrap">
          <div class="pub-dice-face" id="td-dice-face">🎲</div>
          <div class="pub-dice-idle-hint" id="td-dice-hint">Waiting for roll...</div>
        </div>

        <div class="pub-bet-row">
          <span class="pub-bet-label">Your Bet</span>
          <div class="pub-bet-presets">
            ${[100,250,500,1000].map(v=>`<button class="pub-bet-preset" onclick="window._tdSetBet(${v})">${v}</button>`).join('')}
          </div>
          <input class="pub-bet-input" id="td-bet-input" type="number" min="1" placeholder="Custom" value="100"/>
        </div>

        <div class="pub-status-bar" id="td-status">Choose your number and bet to join a game.</div>

        <div class="pub-action-row">
          <button class="pub-btn-roll" id="td-create-btn" onclick="window._tdCreate()">🎲 Open Table</button>
          <button class="pub-btn-roll" id="td-join-btn" onclick="window._tdJoin()" style="display:none">🚪 Join Table</button>
          <button class="pub-btn-secondary" id="td-roll-btn" style="display:none" onclick="window._tdCallRoll()">Roll the Dice!</button>
          <button class="pub-btn-secondary" id="td-leave-btn" style="display:none" onclick="window._tdLeaveGame()">Leave Table</button>
        </div>
      </div>

      <div class="pub-game-side">
        <div class="pub-pot-card">
          <h4>💰 Total Pot</h4>
          <div class="pub-pot-amount" id="td-pot">0</div>
          <div class="pub-pot-sub" id="td-pot-sub">No active game</div>
        </div>
        <div class="pub-pot-card">
          <h4>🪑 Players at the Table</h4>
          <div class="pub-seats-list" id="td-seats">
            <div class="pub-seat-empty">Waiting for players...</div>
          </div>
        </div>
      </div>
    </div>`;
}

let _tdPickedNumber = null;

window._tdSetBet = function(v) {
  document.getElementById('td-bet-input').value = v;
  document.querySelectorAll('.pub-bet-preset').forEach(b => b.classList.toggle('active', +b.textContent === v));
};

window._tdPickNumber = function(n) {
  if (document.querySelector(`.pub-num-btn[data-n="${n}"]`)?.classList.contains('taken')) return;
  _tdPickedNumber = n;
  document.querySelectorAll('.pub-num-btn').forEach(b => b.classList.toggle('selected', +b.dataset.n === n));
};

function _tdLockBetToHost(amount) {
  const input = document.getElementById('td-bet-input');
  if (!input) return;
  input.value    = amount;
  input.disabled = true;
  input.title    = `Stake is fixed at ${amount} 💰 (set by the host)`;
  document.querySelectorAll('.pub-bet-preset').forEach(b => {
    const isMatch = +b.textContent === amount;
    b.classList.toggle('active',   isMatch);
    b.classList.toggle('disabled', !isMatch);
    b.disabled      = true;
    b._savedOnclick = b.onclick;
    b.onclick       = null;
    b.title         = isMatch ? `Table stake: ${amount} 💰` : `Stake is fixed at ${amount} 💰`;
  });
  const betRow = input.closest('.pub-bet-row');
  if (betRow && !betRow.querySelector('.pub-bet-locked-note')) {
    const note = document.createElement('div');
    note.className   = 'pub-bet-locked-note';
    note.style.cssText = 'font-size:0.75rem;color:var(--gold-dim);margin-top:4px;font-style:italic';
    note.textContent = `Stake fixed at ${amount} 💰 — set by the host`;
    betRow.appendChild(note);
  }
}

function _tdUnlockBet() {
  const input = document.getElementById('td-bet-input');
  if (!input) return;
  input.disabled = false;
  input.title    = '';
  document.querySelectorAll('.pub-bet-preset').forEach(b => {
    b.classList.remove('disabled');
    b.disabled = false;
    b.title    = '';
    if (b._savedOnclick !== undefined) {
      b.onclick       = b._savedOnclick;
      b._savedOnclick = undefined;
    }
  });
  document.querySelector('.pub-bet-locked-note')?.remove();
}

let _tdTableUnsub = null;
function _tdWatchOpenTable() {
  if (_tdTableUnsub) { _tdTableUnsub(); _tdTableUnsub = null; }
  const pub = _getCurrentPub();
  if (!pub) return;
   const q = query(
    collection(db,'pubGames'),
    where('gameType',    '==', 'tavern-dice'),
    where('status',      '==', 'open'),
    where('pubLocation', '==', pub.location),
    limit(1)
  );
   _tdTableUnsub = onSnapshot(q, snap => {
    const createBtn = document.getElementById('td-create-btn');
    const joinBtn   = document.getElementById('td-join-btn');
    if (!createBtn) return;
    const amSeated = snap.docs.some(d => d.data().players?.some(p => p.uid === (_uid || window._uid)));
    if (amSeated) return;
    if (!snap.empty) {
      const hostBet = snap.docs[0].data().tableStake || snap.docs[0].data().players?.[0]?.bet || 100;
      createBtn.disabled = true;
      createBtn.style.opacity = '0.4';
      createBtn.title = 'A table is already open — join it!';
      joinBtn.style.display = '';
      _tdLockBetToHost(hostBet);
    } else {
      createBtn.disabled = false;
      createBtn.style.opacity = '';
      createBtn.title = '';
      joinBtn.style.display = 'none';
      _tdUnlockBet();
    }
  }, () => {});
}

window._tdCreate = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }
  if (_tdPickedNumber === null) { window.showToast?.('Pick a number first!', ''); return; }
  const bet = parseInt(document.getElementById('td-bet-input').value) || 100;
  if (bet < 1) { window.showToast?.('Enter a valid bet.', ''); return; }

  const btn = document.getElementById('td-create-btn');
  btn.disabled = true;
  const statusEl = document.getElementById('td-status');
  if (statusEl) { statusEl.textContent = '⏳ Opening table...'; statusEl.className = 'pub-status-bar roll'; }
  _showTableLoadingOverlay('game-tavern-dice', 'Opening Table');

  const pub = _getCurrentPub();
  try {
    const result = await _fnCreateGame({
      gameType:    'tavern-dice',
      pick:        _tdPickedNumber,
      bet,
      pubLocation: pub?.location || 'unknown',
      playerName:  _charData.name || 'Unknown',
    });
    _activeGameId = result.data.gameId;
    const newGold = Math.max(0, (_charData.gold || 0) - bet);
    if (_charData)        _charData.gold = newGold;
    if (window._charData) window._charData.gold = newGold;
    document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    window.showToast?.(`Table opened! You picked ${_tdPickedNumber}. Waiting for others...`, 'success');
    _hideTableLoadingOverlay();
    _tdSubscribeGame(_activeGameId);
  } catch(e) {
    const msg = e?.message || e?.details || '';
    if (msg.includes('already open')) window.showToast?.('A table is already open — join it instead!', '');
    else if (msg.includes('enough gold')) window.showToast?.(msg, 'error');
    else { console.warn('[Pub] tdCreate error:', e); window.showToast?.('Failed to open table. Try again.', 'error'); }
    _hideTableLoadingOverlay();
    btn.disabled = false;
  }
};

window._tdJoin = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }
  if (_tdPickedNumber === null) { window.showToast?.('Pick a number first!', ''); return; }

  const btn = document.getElementById('td-join-btn');
  btn.disabled = true;
  const statusEl = document.getElementById('td-status');
  if (statusEl) { statusEl.textContent = '⏳ Joining table...'; statusEl.className = 'pub-status-bar roll'; }
  _showTableLoadingOverlay('game-tavern-dice', 'Joining Table');

  let gameId = null;
  const pub  = _getCurrentPub();
  const probe = await getDocs(query(
    collection(db,'pubGames'),
    where('gameType',   '==','tavern-dice'),
    where('status',     '==','open'),
    where('pubLocation','==', pub?.location || 'unknown'),
    limit(1)
  ));
  if (!probe.empty) gameId = probe.docs[0].id;
  if (!gameId) { window.showToast?.('No open table found.', ''); _hideTableLoadingOverlay(); btn.disabled = false; return; }

  const hostBet = probe.docs[0].data().tableStake || probe.docs[0].data().players?.[0]?.bet || 100;
  _tdLockBetToHost(hostBet);

  try {
    const result = await _fnJoinGame({ gameId, pick: _tdPickedNumber, playerName: _charData.name || 'Unknown' });
    _activeGameId = gameId;
    const bet     = result.data.bet;
    const newGold = Math.max(0, (_charData.gold || 0) - bet);
    if (_charData)        _charData.gold = newGold;
    if (window._charData) window._charData.gold = newGold;
    document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    window.showToast?.(`Joined! Stake: ${bet} 💰.`, 'success');
    _hideTableLoadingOverlay();
    _tdSubscribeGame(_activeGameId);
  } catch(e) {
    const msg = e?.message || e?.details || '';
    if (msg.includes('number is already taken')) window.showToast?.('That number is taken! Pick another.', 'error');
    else if (msg.includes('enough gold')) window.showToast?.(msg, 'error');
    else if (msg.includes('full')) window.showToast?.('Table is full!', '');
    else { console.warn('[Pub] tdJoin error:', e); window.showToast?.('Failed to join.', 'error'); }
    _hideTableLoadingOverlay();
    btn.disabled = false;
  }
};

function _tdSubscribeGame(gameId) {
  if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
  _activeGameUnsub = onSnapshot(doc(db,'pubGames',gameId), snap => {
    if (!snap.exists()) return;
    _tdRenderGameState(snap.data(), gameId);
  });
}

function _tdRenderGameState(game, gameId) {
  const potEl    = document.getElementById('td-pot');
  const potSub   = document.getElementById('td-pot-sub');
  const seatsEl  = document.getElementById('td-seats');
  const statusEl = document.getElementById('td-status');
  const joinBtn     = document.getElementById('td-join-btn');
  const createBtn   = document.getElementById('td-create-btn');
  const rollBtn     = document.getElementById('td-roll-btn');
  const leaveBtn    = document.getElementById('td-leave-btn');
  if (!potEl) return;

  const isHost    = game.hostUid === _uid;
  const amPlaying = game.players.some(p => p.uid === _uid);

  if (potEl) potEl.textContent = (game.pot || 0).toLocaleString();
  if (potSub) potSub.textContent = `${game.players.length} player${game.players.length !== 1 ? 's' : ''} at the table`;

  if (seatsEl) {
    seatsEl.innerHTML = game.players.map(p => `
      <div class="pub-seat${p.uid === _uid ? ' is-me' : ''}${game.winnerUid === p.uid ? ' winner' : ''}">
        <span class="pub-seat-name">${p.uid === _uid ? '⭐ You' : p.name}</span>
        <span class="pub-seat-pick">picked ${p.pick}</span>
        <span class="pub-seat-bet">${p.bet} 💰</span>
      </div>`).join('');
  }

  document.querySelectorAll('.pub-num-btn').forEach(b => {
    const taken = game.players.some(p => p.pick === +b.dataset.n && p.uid !== _uid);
    b.classList.toggle('taken', taken);
    b.classList.toggle('disabled', game.status !== 'open');
  });

  if (game.status === 'open') {
    if (amPlaying) {
      if (createBtn) createBtn.style.display = 'none';
      if (joinBtn)   joinBtn.style.display   = 'none';
    }
    if (rollBtn)  rollBtn.style.display  = (isHost && amPlaying && game.players.length >= 2) ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = amPlaying ? '' : 'none';
    if (statusEl) {
        const _createdMs = game.createdAt?.toMillis?.() || (game.createdAt?.seconds ? game.createdAt.seconds * 1000 : null);
      if (_tdCancelTimer) { clearInterval(_tdCancelTimer); _tdCancelTimer = null; }
      if (_createdMs && game.players.length === 1 && isHost) {
        _tdCancelTimer = _startCancelCountdown(statusEl, _createdMs, (secsLeft) => {
          const mm = Math.floor(secsLeft/60), ss = String(secsLeft%60).padStart(2,'0');
          const timerSuffix = secsLeft > 0 ? ` · Cancels in ${mm}:${ss}` : ' · Cancelling…';
          return `You're the host — roll when ready!${timerSuffix}`;
        });
      } else {
        statusEl.textContent = amPlaying
          ? (isHost ? `You're the host — roll when ready!` : `Waiting for the host to roll...`)
          : `${game.players.length} player${game.players.length !== 1 ? 's' : ''} seated. Join them!`;
      }
      statusEl.className = 'pub-status-bar';
    }
  }
  if (game.status === 'rolling') {
    if (joinBtn)   joinBtn.style.display   = 'none';
    if (rollBtn)   rollBtn.style.display   = 'none';
    if (leaveBtn)  leaveBtn.style.display  = 'none';
    _tdAnimateDice(null);
    if (statusEl) { statusEl.textContent = '🎲 Rolling...'; statusEl.className = 'pub-status-bar roll'; }
  }

  if (game.status === 'complete') {
    if (createBtn) createBtn.style.display = 'none';
    if (joinBtn)   joinBtn.style.display   = 'none';
    if (rollBtn)   rollBtn.style.display   = 'none';
    if (leaveBtn)  leaveBtn.style.display  = 'none';
    _tdAnimateDice(game.rollResult);

    document.querySelectorAll('.pub-num-btn').forEach(b => {
      b.classList.toggle('winner-highlight', +b.dataset.n === game.rollResult);
    });

    const didWin = game.winnerUid === _uid;
    if (statusEl) {
      statusEl.textContent = didWin
        ? `🎉 You won! The dice landed on ${game.rollResult}. +${game.prize} 💰`
        : `Result: ${game.rollResult}. ${game.winnerName} wins ${game.prize} 💰`;
      statusEl.className = `pub-status-bar ${didWin ? 'win' : 'loss'}`;
    }

    if (didWin && !_awardedGameIds.has(gameId)) {
      _awardedGameIds.add(gameId);
      _spawnCoinRain();
      window.logActivity?.('🎲', `<b>Pub Win!</b> Tavern Dice — Won <b>${game.prize}</b> 💰.`, '#4ec878');
      // Sync gold display after the server trigger writes the prize.
      // The settlePubGame Cloud Function needs ~1-2s to fire and write;
      // we wait 2.5s then pull the authoritative value from Firestore.
      setTimeout(async () => {
        try {
          await window.refreshCharData?.();
          const g = window._charData?.gold ?? 0;
          document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = g);
          document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = g);
        } catch(e) { console.warn('[Pub] post-win gold sync failed:', e); }
      }, 2500);
    }

    if (amPlaying) _pubDebugSettlement(gameId, game.winnerUid, game.prize, _uid);

    if (amPlaying) {
      const myBet = game.players.find(p => p.uid === _uid)?.bet || 0;
      setTimeout(() => _showResultOverlay(didWin, game.rollResult, game.winnerName, game.prize, didWin ? game.prize : myBet), 800);
    }

    setTimeout(() => {
      if (_tdCancelTimer) { clearInterval(_tdCancelTimer); _tdCancelTimer = null; }
      if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
      _activeGameId = null;
    }, 5000);
  }
}

window._tdCallRoll = async function() {
  if (!_activeGameId) return;
  const rollBtn = document.getElementById('td-roll-btn');
  if (rollBtn) rollBtn.disabled = true;
  _tdAnimateDice(null);
  const statusEl = document.getElementById('td-status');
  if (statusEl) { statusEl.textContent = '🎲 Rolling...'; statusEl.className = 'pub-status-bar roll'; }
  try {
    await _fnRollGame({ gameId: _activeGameId });
  } catch(e) {
    console.warn('[Pub] callRoll error:', e);
    window.showToast?.('Roll failed. Try again.', 'error');
    if (rollBtn) rollBtn.disabled = false;
  }
};

window._tdLeaveGame = async function() {
  if (!_activeGameId || !_uid) return;
  try {
    const snap = await getDoc(doc(db,'pubGames',_activeGameId));
    if (!snap.exists()) return;
    const game    = snap.data();
    // Guard: never refund if game already completed — bet was already settled by the trigger
    if (game.status === 'complete' || game.status === 'rolling') {
      window.showToast?.('Game already ended — no refund.', '');
      if (_tdCancelTimer) { clearInterval(_tdCancelTimer); _tdCancelTimer = null; }
      if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
      _activeGameId = null;
      _backToLobby();
      return;
    }
    const myEntry = game.players.find(p => p.uid === _uid);
    if (!myEntry) return;
    const newPlayers = game.players.filter(p => p.uid !== _uid);
    if (newPlayers.length === 0) {
      await deleteDoc(doc(db,'pubGames',_activeGameId));
    } else {
      await updateDoc(doc(db,'pubGames',_activeGameId), {
        players: newPlayers,
        pot:     (game.pot || 0) - (myEntry.bet || 0),
        hostUid: newPlayers[0].uid,
      });
    }
    await _awardGold(_uid, myEntry.bet || 0);
    window.showToast?.('Left the table. Bet refunded.', '');
    if (_tdCancelTimer) { clearInterval(_tdCancelTimer); _tdCancelTimer = null; }
    if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
    _activeGameId = null;
    _backToLobby();
  } catch(e) { window.showToast?.('Failed to leave.', 'error'); }
};

function _tdAnimateDice(result) {
  const face = document.getElementById('td-dice-face');
  if (!face) return;
  face.classList.remove('rolling','result-flash');
  void face.offsetWidth;
  if (result === null) {
    face.classList.add('rolling');
    face.textContent = '🎲';
  } else {
    face.textContent  = result;
    face.classList.add('result-flash');
  }
}

// ═══════════════════════════════════════════════════════════════
//  GAME 2: AGAINST THE HOUSE — D6 solo vs Barkeep Rowan
// ═══════════════════════════════════════════════════════════════
const HOUSE_MULTIPLIER = 5;

function _buildHouseModeView(container) {
  container.innerHTML = `
    <div class="pub-game-view active" id="game-house-mode">
      <button class="pub-game-back-btn" onclick="window._pubBackToLobby()">← Back to Lobby</button>
      <div class="pub-game-header">
        <h3>🏠 Against the House</h3>
        <p>Pick a face on the D6 and wager your coins. Barkeep Rowan rolls for the house. Win and take 5×!</p>
      </div>

      <div class="pub-house-setup">
        <div class="pub-house-vs">
          <div class="pub-house-player">
            <div class="pub-house-avatar">🧝</div>
            <span>${_charData?.name || 'You'}</span>
          </div>
          <div class="pub-house-vs-badge">VS</div>
          <div class="pub-house-barkeep">
            <div class="pub-house-avatar">🧔</div>
            <span>Barkeep Rowan</span>
          </div>
        </div>

        <div>
          <div style="font-family:var(--font-mono);font-size:0.6rem;letter-spacing:0.12em;color:var(--text-dim);text-align:center;margin-bottom:10px;text-transform:uppercase">Pick Your Face</div>
          <div class="pub-d6-grid" id="hm-d6-grid">
            ${[1,2,3,4,5,6].map(n => `
              <div class="pub-d6-btn" data-face="${n}" onclick="window._hmPickFace(${n})">
                <div class="pub-d6-dots">${Array(9).fill(0).map(()=>`<div class="pub-d6-dot"></div>`).join('')}</div>
              </div>`).join('')}
          </div>
        </div>

        <div class="pub-bet-row">
          <span class="pub-bet-label">Wager</span>
          <div class="pub-bet-presets">
            ${[50,100,250,500].map(v=>`<button class="pub-bet-preset" onclick="window._hmSetBet(${v})">${v}</button>`).join('')}
          </div>
          <input class="pub-bet-input" id="hm-bet-input" type="number" min="1" placeholder="Custom" value="100"/>
        </div>

        <div style="display:flex;gap:32px;align-items:center;justify-content:center">
          <div style="text-align:center">
            <div style="font-family:var(--font-mono);font-size:0.55rem;letter-spacing:0.12em;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px">Your Roll</div>
            <div class="pub-dice-wrap" style="width:100px;height:100px">
              <div class="pub-dice-face" id="hm-your-dice" style="width:90px;height:90px;font-size:2rem">?</div>
            </div>
          </div>
          <div style="text-align:center">
            <div style="font-family:var(--font-mono);font-size:0.55rem;letter-spacing:0.12em;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px">House Roll</div>
            <div class="pub-dice-wrap" style="width:100px;height:100px">
              <div class="pub-dice-face" id="hm-house-dice" style="width:90px;height:90px;font-size:2rem">?</div>
            </div>
          </div>
        </div>

        <div class="pub-status-bar" id="hm-status">Pick a face and wager to play.</div>

        <div class="pub-action-row">
          <button class="pub-btn-roll" id="hm-roll-btn" onclick="window._hmRoll()">🎲 Roll Against Rowan</button>
        </div>
      </div>
    </div>`;
}

let _hmPicked = null;

window._hmPickFace = function(n) {
  _hmPicked = n;
  document.querySelectorAll('.pub-d6-btn').forEach(b => b.classList.toggle('selected', +b.dataset.face === n));
};

window._hmSetBet = function(v) {
  document.getElementById('hm-bet-input').value = v;
  document.querySelectorAll('#game-house-mode .pub-bet-preset').forEach(b => b.classList.toggle('active', +b.textContent === v));
};

window._hmRoll = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }
  if (_hmPicked === null) { window.showToast?.('Pick a face first!', ''); return; }

  const bet = parseInt(document.getElementById('hm-bet-input').value) || 100;
  if (bet < 1) { window.showToast?.('Enter a valid bet.', ''); return; }
  if ((_charData.gold || 0) < bet) { window.showToast?.(`Not enough gold. You have ${_charData.gold||0}.`, 'error'); return; }

  const btn = document.getElementById('hm-roll-btn');
  btn.disabled = true;

  const yourDice  = document.getElementById('hm-your-dice');
  const houseDice = document.getElementById('hm-house-dice');
  const statusEl  = document.getElementById('hm-status');

  // Start animation immediately — no gold deducted yet
  [yourDice, houseDice].forEach(d => { d.textContent = '🎲'; d.classList.remove('rolling','result-flash'); void d.offsetWidth; d.classList.add('rolling'); });
  if (statusEl) { statusEl.textContent = '🎲 Rolling...'; statusEl.className = 'pub-status-bar roll'; }

  setTimeout(async () => {
    const playerRoll = Math.floor(Math.random() * 6) + 1;
    const houseRoll  = Math.floor(Math.random() * 6) + 1;
    const won        = playerRoll === _hmPicked;

    yourDice.classList.remove('rolling');  yourDice.textContent  = playerRoll; yourDice.classList.add('result-flash');
    houseDice.classList.remove('rolling'); houseDice.textContent = houseRoll;  houseDice.classList.add('result-flash');

    // FIXED: one atomic write — deduct bet, and if won add prize on top.
    // Previously: two separate calls (_deductGold then _awardGold) meant a
    // disconnect between them left the player with lost gold but no prize.
    const prize    = bet * HOUSE_MULTIPLIER;
    const netChange = won ? (prize - bet) : -bet;  // win: net +400 on 100 bet; lose: net -100
    try {
      await updateDoc(doc(db, 'characters', _uid), { gold: increment(netChange) });
      const newGold = (_charData?.gold || 0) + netChange;
      if (_charData)        _charData.gold = newGold;
      if (window._charData) window._charData.gold = newGold;
      document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
      document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    } catch(writeErr) {
      console.error('[HouseMode] Gold transaction failed:', writeErr);
      window.showToast?.('Transaction failed — gold not changed. Try again.', 'error');
      btn.disabled = false;
      return;
    }

    if (won) {
      if (statusEl) { statusEl.textContent = `🎉 You matched! Rowan pays out ${prize} 💰!`; statusEl.className = 'pub-status-bar win'; }
      _spawnCoinRain();
      _showResultOverlay(true, playerRoll, 'You', prize, prize);
      window.logActivity?.('🎲', `<b>Pub Win!</b> Against the House — Rolled <b>${playerRoll}</b>, won <b>${prize}</b> 💰.`, '#4ec878');
    } else {
      if (statusEl) { statusEl.textContent = `You picked ${_hmPicked}, rolled ${playerRoll}. Rowan keeps your ${bet} 💰.`; statusEl.className = 'pub-status-bar loss'; }
      _showResultOverlay(false, playerRoll, 'Rowan', bet, bet);
      window.logActivity?.('🎲', `<b>Pub Loss.</b> Against the House — Rolled <b>${playerRoll}</b>, lost <b>${bet}</b> 💰.`, '#e05555');
    }

    try {
      await addDoc(collection(db,'pubGames'), {
        gameType: 'house-mode', status: 'complete', hostUid: _uid,
        pubLocation: _getCurrentPub()?.location || 'unknown',
        players:  [{ uid: _uid, name: _charData.name || 'Unknown', pick: _hmPicked, bet }],
        pot: bet, rollResult: playerRoll,
        winnerUid:  won ? _uid : 'house',
        winnerName: won ? (_charData.name || 'Unknown') : 'Barkeep Rowan',
        prize:      won ? prize : 0,
        goldSettled: true,  // no trigger needed — already settled atomically above
        completedAt: serverTimestamp(), createdAt: serverTimestamp(),
      });
    } catch(logErr) {
      // Non-fatal — result already applied, just couldn't write to results feed
      console.warn('[HouseMode] Failed to log game result:', logErr);
    }
    btn.disabled = false;
  }, 1800);
};

// ═══════════════════════════════════════════════════════════════
//  GAME 3: HIGHEST ROLL — Everyone rolls D20, highest wins
// ═══════════════════════════════════════════════════════════════
function _buildHighestRollView(container) {
  container.innerHTML = `
    <div class="pub-game-view active" id="game-highest-roll">
      <button class="pub-game-back-btn" onclick="window._pubBackToLobby()">← Back to Lobby</button>
      <div class="pub-game-header">
        <h3>⚔️ Highest Roll</h3>
        <p>No guessing. Everyone rolls a D20 — the highest number takes the entire pot.</p>
      </div>

      <div class="pub-dice-arena">
        <div class="pub-dice-wrap">
          <div class="pub-dice-face" id="hr-dice-face">🎲</div>
          <div class="pub-dice-idle-hint" id="hr-dice-hint">Waiting for roll...</div>
        </div>

        <div class="pub-bet-row">
          <span class="pub-bet-label">Your Bet</span>
          <div class="pub-bet-presets">
            ${[100,250,500,1000].map(v=>`<button class="pub-bet-preset" onclick="window._hrSetBet(${v})">${v}</button>`).join('')}
          </div>
          <input class="pub-bet-input" id="hr-bet-input" type="number" min="1" placeholder="Custom" value="100"/>
        </div>

        <div class="pub-status-bar" id="hr-status">Set your bet and join the table.</div>

        <div class="pub-action-row">
          <button class="pub-btn-roll" id="hr-create-btn" onclick="window._hrCreate()">⚔️ Open Table</button>
          <button class="pub-btn-roll" id="hr-join-btn" onclick="window._hrJoin()" style="display:none">🚪 Join Table</button>
          <button class="pub-btn-secondary" id="hr-roll-btn" style="display:none" onclick="window._hrCallRoll()">Roll for Everyone!</button>
          <button class="pub-btn-secondary" id="hr-leave-btn" style="display:none" onclick="window._hrLeaveGame()">Leave Table</button>
        </div>
      </div>

      <div class="pub-game-side">
        <div class="pub-pot-card">
          <h4>💰 Total Pot</h4>
          <div class="pub-pot-amount" id="hr-pot">0</div>
          <div class="pub-pot-sub" id="hr-pot-sub">No active game</div>
        </div>
        <div class="pub-pot-card">
          <h4>🪑 Players</h4>
          <div class="pub-seats-list" id="hr-seats">
            <div class="pub-seat-empty">Waiting for players...</div>
          </div>
        </div>
      </div>
    </div>`;
}

window._hrSetBet = function(v) {
  document.getElementById('hr-bet-input').value = v;
  document.querySelectorAll('#game-highest-roll .pub-bet-preset').forEach(b => b.classList.toggle('active', +b.textContent === v));
};

function _hrLockBetToHost(amount) {
  const input = document.getElementById('hr-bet-input');
  if (!input) return;
  input.value    = amount;
  input.disabled = true;
  document.querySelectorAll('#game-highest-roll .pub-bet-preset').forEach(b => {
    const isMatch = +b.textContent === amount;
    b.classList.toggle('active', isMatch);
    b.classList.toggle('disabled', !isMatch);
    b.disabled      = true;
    b._savedOnclick = b.onclick;
    b.onclick       = null;
  });
  const betRow = input.closest('.pub-bet-row');
  if (betRow && !betRow.querySelector('.pub-bet-locked-note')) {
    const note = document.createElement('div');
    note.className   = 'pub-bet-locked-note';
    note.style.cssText = 'font-size:0.75rem;color:var(--gold-dim);margin-top:4px;font-style:italic';
    note.textContent = `Stake fixed at ${amount} 💰 — set by the host`;
    betRow.appendChild(note);
  }
}

function _hrUnlockBet() {
  const input = document.getElementById('hr-bet-input');
  if (!input) return;
  input.disabled = false;
  document.querySelectorAll('#game-highest-roll .pub-bet-preset').forEach(b => {
    b.classList.remove('disabled');
    b.disabled = false;
    if (b._savedOnclick !== undefined) { b.onclick = b._savedOnclick; b._savedOnclick = undefined; }
  });
  document.querySelector('#game-highest-roll .pub-bet-locked-note')?.remove();
}

let _hrTableUnsub = null;
function _hrWatchOpenTable() {
  if (_hrTableUnsub) { _hrTableUnsub(); _hrTableUnsub = null; }
  const pub = _getCurrentPub();
  if (!pub) return;
  const q = query(
    collection(db,'pubGames'),
    where('gameType',    '==', 'highest-roll'),
    where('status',      '==', 'open'),
    where('pubLocation', '==', pub.location),
    limit(1)
  );
  _hrTableUnsub = onSnapshot(q, snap => {
    const createBtn = document.getElementById('hr-create-btn');
    const joinBtn   = document.getElementById('hr-join-btn');
    if (!createBtn) return;
    const amSeated = snap.docs.some(d => d.data().players?.some(p => p.uid === (_uid || window._uid)));
    if (amSeated) return;
    if (!snap.empty) {
      const hostBet = snap.docs[0].data().tableStake || snap.docs[0].data().players?.[0]?.bet || 100;
      createBtn.disabled = true;
      createBtn.style.opacity = '0.4';
      joinBtn.style.display = '';
      _hrLockBetToHost(hostBet);
    } else {
      createBtn.disabled = false;
      createBtn.style.opacity = '';
      joinBtn.style.display = 'none';
      _hrUnlockBet();
    }
  }, () => {});
}

window._hrCreate = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }
  const bet = parseInt(document.getElementById('hr-bet-input').value) || 100;
  if (bet < 1) { window.showToast?.('Enter a valid bet.', ''); return; }

  const btn = document.getElementById('hr-create-btn');
  btn.disabled = true;
  const statusEl = document.getElementById('hr-status');
  if (statusEl) { statusEl.textContent = '⏳ Opening table...'; statusEl.className = 'pub-status-bar roll'; }
  _showTableLoadingOverlay('game-highest-roll', 'Opening Table');

  const pub = _getCurrentPub();
  try {
    const result = await _fnCreateGame({
      gameType:    'highest-roll',
      bet,
      pubLocation: pub?.location || 'unknown',
      playerName:  _charData.name || 'Unknown',
    });
    _activeGameId = result.data.gameId;
    const newGold = Math.max(0, (_charData.gold || 0) - bet);
    if (_charData)        _charData.gold = newGold;
    if (window._charData) window._charData.gold = newGold;
    document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    window.showToast?.('Table opened! Invite others and roll when ready.', 'success');
    _hideTableLoadingOverlay();
    _hrSubscribeGame(_activeGameId);
  } catch(e) {
    const msg = e?.message || e?.details || '';
    if (msg.includes('already open')) window.showToast?.('A table is already open — join it!', '');
    else if (msg.includes('enough gold')) window.showToast?.(msg, 'error');
    else { console.warn('[Pub] hrCreate error:', e); window.showToast?.('Failed to open table.', 'error'); }
    _hideTableLoadingOverlay();
    btn.disabled = false;
  }
};

window._hrJoin = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }

  const btn = document.getElementById('hr-join-btn');
  btn.disabled = true;
  const statusEl = document.getElementById('hr-status');
  if (statusEl) { statusEl.textContent = '⏳ Joining...'; statusEl.className = 'pub-status-bar roll'; }
  _showTableLoadingOverlay('game-highest-roll', 'Joining Table');

  const pub = _getCurrentPub();
  const probe = await getDocs(query(
    collection(db,'pubGames'),
    where('gameType',   '==','highest-roll'),
    where('status',     '==','open'),
    where('pubLocation','==', pub?.location || 'unknown'),
    limit(1)
  ));
  if (probe.empty) { window.showToast?.('No open table found.', ''); _hideTableLoadingOverlay(); btn.disabled = false; return; }
  const gameId  = probe.docs[0].id;
  const hostBet = probe.docs[0].data().tableStake || probe.docs[0].data().players?.[0]?.bet || 100;
  _hrLockBetToHost(hostBet);

  try {
    const result = await _fnJoinGame({ gameId, playerName: _charData.name || 'Unknown' });
    _activeGameId = gameId;
    const bet     = result.data.bet;
    const newGold = Math.max(0, (_charData.gold || 0) - bet);
    if (_charData)        _charData.gold = newGold;
    if (window._charData) window._charData.gold = newGold;
    document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    window.showToast?.(`Joined! Stake: ${bet} 💰.`, 'success');
    _hideTableLoadingOverlay();
    _hrSubscribeGame(_activeGameId);
  } catch(e) {
    const msg = e?.message || e?.details || '';
    if (msg.includes('enough gold')) window.showToast?.(msg, 'error');
    else if (msg.includes('full')) window.showToast?.('Table is full!', '');
    else { console.warn('[Pub] hrJoin error:', e); window.showToast?.('Failed to join.', 'error'); }
    _hideTableLoadingOverlay();
    btn.disabled = false;
  }
};

function _hrSubscribeGame(gameId) {
  if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
  _activeGameUnsub = onSnapshot(doc(db,'pubGames',gameId), snap => {
    if (!snap.exists()) return;
    _hrRenderGameState(snap.data(), gameId);
  });
}

function _hrRenderGameState(game, gameId) {
  const potEl    = document.getElementById('hr-pot');
  const potSub   = document.getElementById('hr-pot-sub');
  const seatsEl  = document.getElementById('hr-seats');
  const statusEl = document.getElementById('hr-status');
  const createBtn = document.getElementById('hr-create-btn');
  const joinBtn   = document.getElementById('hr-join-btn');
  const rollBtn   = document.getElementById('hr-roll-btn');
  const leaveBtn  = document.getElementById('hr-leave-btn');
  if (!potEl) return;

  const isHost    = game.hostUid === _uid;
  const amPlaying = game.players.some(p => p.uid === _uid);

  potEl.textContent = (game.pot || 0).toLocaleString();
  if (potSub) potSub.textContent = `${game.players.length} player${game.players.length !== 1 ? 's' : ''} at the table`;

  if (seatsEl) {
    seatsEl.innerHTML = game.players.map(p => `
      <div class="pub-seat${p.uid === _uid ? ' is-me' : ''}${game.winnerUid === p.uid ? ' winner' : ''}">
        <span class="pub-seat-name">${p.uid === _uid ? '⭐ You' : p.name}</span>
        ${game.status === 'complete' ? `<span class="pub-seat-pick">rolled ${p.roll ?? '?'}</span>` : ''}
        <span class="pub-seat-bet">${p.bet} 💰</span>
      </div>`).join('');
  }

  if (game.status === 'open') {
    if (amPlaying) { if (createBtn) createBtn.style.display='none'; if (joinBtn) joinBtn.style.display='none'; }
    if (rollBtn)  rollBtn.style.display  = (isHost && amPlaying && game.players.length >= 2) ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = amPlaying ? '' : 'none';
    if (statusEl) {
        const _createdMs = game.createdAt?.toMillis?.() || (game.createdAt?.seconds ? game.createdAt.seconds * 1000 : null);
      if (_hrCancelTimer) { clearInterval(_hrCancelTimer); _hrCancelTimer = null; }
      if (_createdMs && game.players.length === 1 && isHost) {
        _hrCancelTimer = _startCancelCountdown(statusEl, _createdMs, (secsLeft) => {
          const mm = Math.floor(secsLeft/60), ss = String(secsLeft%60).padStart(2,'0');
          const timerSuffix = secsLeft > 0 ? ` · Cancels in ${mm}:${ss}` : ' · Cancelling…';
          return `You're the host — roll when ready!${timerSuffix}`;
        });
      } else {
        statusEl.textContent = amPlaying
          ? (isHost ? `You're the host — roll when ready!` : `Waiting for the host to roll...`)
          : `${game.players.length} player${game.players.length !== 1 ? 's' : ''} seated. Join them!`;
      }
      statusEl.className = 'pub-status-bar';
    }
  }
  if (game.status === 'rolling') {
    [createBtn, joinBtn, rollBtn, leaveBtn].forEach(b => { if (b) b.style.display = 'none'; });
    const face = document.getElementById('hr-dice-face');
    if (face) { face.textContent = '🎲'; face.classList.remove('result-flash'); void face.offsetWidth; face.classList.add('rolling'); }
    if (statusEl) { statusEl.textContent = '🎲 Rolling...'; statusEl.className = 'pub-status-bar roll'; }
  }
  if (game.status === 'complete') {
    [createBtn, joinBtn, rollBtn, leaveBtn].forEach(b => { if (b) b.style.display = 'none'; });
    const face = document.getElementById('hr-dice-face');
    if (face) { face.classList.remove('rolling'); face.textContent = game.rollResult || '?'; face.classList.add('result-flash'); }

    const didWin = game.winnerUid === _uid;
    if (statusEl) {
      statusEl.textContent = didWin
        ? `🎉 You win! Highest roll wins ${game.prize} 💰`
        : `${game.winnerName} wins with ${game.rollResult}! Prize: ${game.prize} 💰`;
      statusEl.className = `pub-status-bar ${didWin ? 'win' : 'loss'}`;
    }
    if (didWin && !_awardedGameIds.has(gameId)) {
      _awardedGameIds.add(gameId);
      _spawnCoinRain();
      window.logActivity?.('⚔️', `<b>Pub Win!</b> Highest Roll — Won <b>${game.prize}</b> 💰.`, '#4ec878');
      // Sync gold display after the server trigger writes the prize.
      setTimeout(async () => {
        try {
          await window.refreshCharData?.();
          const g = window._charData?.gold ?? 0;
          document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = g);
          document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = g);
        } catch(e) { console.warn('[Pub] post-win gold sync failed:', e); }
      }, 2500);
    }
    if (amPlaying) _pubDebugSettlement(gameId, game.winnerUid, game.prize, _uid);
    if (amPlaying) {
      const myBet = game.players.find(p => p.uid === _uid)?.bet || 0;
      setTimeout(() => _showResultOverlay(didWin, game.rollResult, game.winnerName, game.prize, didWin ? game.prize : myBet), 800);
    }
    setTimeout(() => { if (_hrCancelTimer) { clearInterval(_hrCancelTimer); _hrCancelTimer = null; } if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; } _activeGameId = null; }, 5000);
  }
}

window._hrCallRoll = async function() {
  if (!_activeGameId) return;
  const rollBtn = document.getElementById('hr-roll-btn');
  if (rollBtn) rollBtn.disabled = true;
  try {
    await _fnRollGame({ gameId: _activeGameId });
  } catch(e) {
    console.warn('[Pub] hrCallRoll error:', e);
    window.showToast?.('Roll failed. Try again.', 'error');
    if (rollBtn) rollBtn.disabled = false;
  }
};

window._hrLeaveGame = async function() {
  if (!_activeGameId || !_uid) return;
  try {
    const snap = await getDoc(doc(db,'pubGames',_activeGameId));
    if (!snap.exists()) return;
    const game    = snap.data();
    // Guard: never refund if game already completed — bet was already settled by the trigger
    if (game.status === 'complete' || game.status === 'rolling') {
      window.showToast?.('Game already ended — no refund.', '');
      if (_hrCancelTimer) { clearInterval(_hrCancelTimer); _hrCancelTimer = null; }
      if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
      _activeGameId = null;
      _backToLobby();
      return;
    }
    const myEntry = game.players.find(p => p.uid === _uid);
    if (!myEntry) return;
    const newPlayers = game.players.filter(p => p.uid !== _uid);
    if (newPlayers.length === 0) {
      await deleteDoc(doc(db,'pubGames',_activeGameId));
    } else {
      await updateDoc(doc(db,'pubGames',_activeGameId), {
        players: newPlayers,
        pot:     (game.pot || 0) - (myEntry.bet || 0),
        hostUid: newPlayers[0].uid,
      });
    }
    await _awardGold(_uid, myEntry.bet || 0);
    window.showToast?.('Left the table. Bet refunded.', '');
    if (_hrCancelTimer) { clearInterval(_hrCancelTimer); _hrCancelTimer = null; }
    if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
    _activeGameId = null;
    _backToLobby();
  } catch(e) { window.showToast?.('Failed to leave.', 'error'); }
};

// ═══════════════════════════════════════════════════════════════
//  GAME 4: DEVIL'S HAND
//
//  Firestore schema (pubGames/{gameId}):
//  {
//    gameType:     'devils-hand',
//    status:       'lobby' | 'betting' | 'resolving' | 'round_end' | 'complete',
//    pubLocation:  string,
//    hostUid:      string,
//    baseStake:    number,          // per-round stake
//    round:        number,          // 1–5
//    tableCards:   string[5],       // card ids visible to all
//    hands:        { [uid]: string[] },  // 5 cards per player — server-assigned
//    players: [{
//      uid, name,
//      status: 'waiting'|'raised'|'folded',
//      totalBet: number,            // cumulative across all rounds
//    }],
//    turnOrder:    string[],        // uid[] in turn order
//    currentTurn:  number,          // index into turnOrder
//    roundPot:     number,          // current round's pot
//    totalPot:     number,          // all-rounds pot
//    notifications: string[],       // log lines
//    roundWinner:  string | null,   // uid or 'tie'
//    winnerUid:    string,          // game winner (most rounds won)
//    winnerName:   string,
//    prize:        number,
//    completedAt:  timestamp,
//    createdAt:    timestamp,
//  }
//
//  CARD DECK — 15 custom cards, 3 copies each = 45 cards total.
//  Matching: exact card id must match.
// ═══════════════════════════════════════════════════════════════

const DH_CARDS = [
  { id: 'baal',      name: 'Baal',     url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fbaal_card.jpg?alt=media&token=13f88c11-f00b-42f7-87df-206de6feb56e' },
  { id: 'death',     name: 'Death',    url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fdeath_card.jpg?alt=media&token=f79a86ff-d701-40b0-a4f9-5c405def4812' },
  { id: 'desire',    name: 'Desire',   url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fdesire_card.jpg?alt=media&token=ce32c0f0-929a-4ca7-831d-5a3bb742b440' },
  { id: 'despair',   name: 'Despair',  url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fdespair_card.jpg?alt=media&token=de089508-8b00-4104-ab85-8f0ea963c7a7' },
  { id: 'envy',      name: 'Envy',     url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fenvy_card.jpg?alt=media&token=3a667f44-1ed4-41b2-899c-ab4ed4fbe5f4' },
  { id: 'gluttony',  name: 'Gluttony', url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fgluttony_card.jpg?alt=media&token=bdc2735a-a325-4ad9-bde5-d8122501283c' },
  { id: 'greed',     name: 'Greed',    url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fgreed_card.jpg?alt=media&token=cc809613-43cf-41f7-b1eb-2ff54e347d4e' },
  { id: 'lust',      name: 'Lust',     url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Flust_card.jpg?alt=media&token=04969bc0-c57e-447f-b576-d529bc6c5649' },
  { id: 'pride',     name: 'Pride',    url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fpride_card.jpg?alt=media&token=b536f511-5382-472d-a193-597288b76972' },
  { id: 'sin',       name: 'Sin',      url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fsin_card.jpg?alt=media&token=072daf76-0939-4208-9782-8bcdf2470cbf' },
  { id: 'sloth',     name: 'Sloth',    url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fsloth_card.jpg?alt=media&token=96c099c3-017f-4bd7-a5d6-4983f7a4b123' },
  { id: 'vain',      name: 'Vain',     url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fvain_card.jpg?alt=media&token=8c8b4d30-ef50-417d-8f31-2ece15404b83' },
  { id: 'vas',       name: 'Vas',      url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fvas_card.jpg?alt=media&token=37b33541-0f07-456e-8d87-4c97c6705466' },
  { id: 'vile',      name: 'Vile',     url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fvile_card.jpg?alt=media&token=bdd55308-80ff-4d3f-bcde-b11f93f4227b' },
  { id: 'wrath',     name: 'Wrath',    url: 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/cards%2Fwrath_card.jpg?alt=media&token=5c3fc9d5-92a4-47ae-8d5c-08279e0766d0' },
];

// Build deck: 3 copies of each (45 cards total), ids like 'baal_0', 'baal_1', 'baal_2'
function _dhBuildDeck() {
  const deck = [];
  for (const card of DH_CARDS) {
    for (let i = 0; i < 3; i++) deck.push(`${card.id}_${i}`);
  }
  return deck;
}

// Shuffle array (Fisher-Yates)
function _dhShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Get base card id from instance id (e.g. 'baal_0' → 'baal')
function _dhBaseId(instanceId) {
  return instanceId.replace(/_\d+$/, '');
}

// Get card display info
function _dhCardInfo(instanceId) {
  const base = _dhBaseId(instanceId);
  return DH_CARDS.find(c => c.id === base) || { id: base, name: base, url: '' };
}

// Count how many of a player's cards match the table's hand (exact card base id)
function _dhCountMatches(playerHand, tableCards) {
  const tableIds = tableCards.map(c => _dhBaseId(c));
  return playerHand.filter(c => tableIds.includes(_dhBaseId(c))).length;
}

// Render a card element
function _dhCardHtml(instanceId, showFace = true, matchHighlight = false) {
  if (!instanceId) {
    return `<div class="dh-card-slot"></div>`;
  }
  const info = _dhCardInfo(instanceId);
  const matchCls = matchHighlight ? ' dh-card-match' : '';
  if (!showFace) {
    return `<div class="dh-card dh-card-back${matchCls}"><div class="dh-card-name">&nbsp;</div></div>`;
  }
  return `
    <div class="dh-card${matchCls}">
      <img src="${info.url}" alt="${info.name}" loading="lazy">
    </div>
    <div class="dh-card-name">${info.name}</div>`;
}

// ── Devil's Hand: lobby watcher ──────────────────────────────────
let _dhLobbyUnsub = null;

function _dhWatchLobby() {
  if (_dhCancelTimer)  { clearInterval(_dhCancelTimer); _dhCancelTimer = null; }
  if (_dhLobbyUnsub) { _dhLobbyUnsub(); _dhLobbyUnsub = null; }
  const pub = _getCurrentPub();
  if (!pub) return;
  const q = query(
    collection(db,'pubGames'),
    where('gameType',    '==', 'devils-hand'),
    where('status',      '==', 'lobby'),
    where('pubLocation', '==', pub.location),
    limit(1)
  );
  _dhLobbyUnsub = onSnapshot(q, snap => {
    const setupEl = document.getElementById('dh-setup');
    if (!setupEl) return;
    if (!snap.empty) {
      const gameId = snap.docs[0].id;
      const game   = snap.docs[0].data();
      const amIn   = game.players.some(p => p.uid === (_uid || window._uid));

      // Show join button + player list
      const joinBtn  = document.getElementById('dh-join-btn');
      const leaveBtn = document.getElementById('dh-leave-btn');
      if (joinBtn)  joinBtn.style.display  = amIn ? 'none' : '';
      if (leaveBtn) leaveBtn.style.display = amIn ? '' : 'none';

      const playerList = document.getElementById('dh-lobby-players');
      if (playerList) {
        playerList.innerHTML = game.players.map(p => `
          <div class="dh-lobby-player-row${p.uid === (_uid||window._uid) ? ' dh-lobby-me' : ''}">
            <div class="dh-lobby-ready-dot"></div>
            ${p.uid === (_uid||window._uid) ? '⭐ You' : p.name}
            <span style="margin-left:auto;font-family:var(--font-mono);font-size:0.6rem;color:var(--text-dim)">
              ${p.uid === game.hostUid ? 'HOST' : 'PLAYER'}
            </span>
          </div>`).join('');
      }

      const statusEl = document.getElementById('dh-lobby-status');
      if (statusEl) {
        const createdMs = game.createdAt?.toMillis?.() || game.createdAt?.seconds * 1000 || Date.now();
        if (_dhCancelTimer) { clearInterval(_dhCancelTimer); _dhCancelTimer = null; }
        const _dhPlayerCount = game.players.length;
        _dhCancelTimer = _startCancelCountdown(statusEl, createdMs, (secsLeft) => {
          const mm = Math.floor(secsLeft/60), ss = String(secsLeft%60).padStart(2,'0');
          const timerStr = secsLeft > 0 ? ` · Cancels in ${mm}:${ss}` : ' · Cancelling…';
          return `${_dhPlayerCount}/4 players ready. Need 3 minimum.${timerStr}`;
        });
        statusEl.className = 'pub-status-bar';
      }

      // Stake lock for joiners — mirror _tdLockBetToHost pattern
      const amHost = game.hostUid === (_uid || window._uid);
      if (!amHost) {
        _dhLockStakeToHost(game.baseStake);
      }

      // If I'm the host and enough players, show start button
      const startBtn = document.getElementById('dh-start-btn');
      if (startBtn) {
        const isHost = game.hostUid === (_uid || window._uid);
        startBtn.style.display = (isHost && game.players.length >= 3) ? '' : 'none';
      }

      // If I'm in the game and it started, subscribe
      if (amIn && _activeGameId !== gameId) {
        _activeGameId = gameId;
        _dhSubscribeGame(gameId);
      }
    } else {
      // No open lobby — show create UI, unlock stake
      const createBtn  = document.getElementById('dh-create-btn');
      const joinBtn    = document.getElementById('dh-join-btn');
      const leaveBtnNo = document.getElementById('dh-leave-btn');
      if (createBtn)  createBtn.style.display  = '';
      if (joinBtn)    joinBtn.style.display    = 'none';
      if (leaveBtnNo) leaveBtnNo.style.display = 'none';
      _dhUnlockStake();
      const playerList = document.getElementById('dh-lobby-players');
      if (playerList) playerList.innerHTML = '<div class="dh-lobby-player-row" style="justify-content:center;color:var(--text-dim);font-style:italic">No open table. Open one to start.</div>';
      const statusEl = document.getElementById('dh-lobby-status');
      if (statusEl) { statusEl.textContent = 'Open a table to begin. 3–4 players needed.'; statusEl.className = 'pub-status-bar'; }
    }
  }, () => {});
}

// ── Build Devil's Hand view ──────────────────────────────────────
function _buildDevilsHandView(container) {
  container.innerHTML = `
    <div class="pub-game-view active" id="game-devils-hand">
      <button class="pub-game-back-btn" onclick="window._pubBackToLobby()">← Back to Lobby</button>
      <div class="pub-game-header">
        <h3>🃏 Devil's Hand</h3>
        <p>5 sinful cards laid bare on the table. Match the most to claim the pot. 5 rounds of bluff, raise, and ruin.</p>
      </div>

      <!-- Setup / Lobby view -->
      <div id="dh-setup">
        <div class="dh-bet-setup">
          <div class="dh-bet-setup-title">⚔️ The Devil's Table</div>

          <div>
            <div class="dh-base-stake-label">Base Stake per Round</div>
            <div class="dh-bet-presets">
              ${[100,250,500,1000].map(v=>`
                <button class="pub-bet-preset" onclick="window._dhSetStake(${v})">${v}</button>`).join('')}
            </div>
            <input class="pub-bet-input" id="dh-stake-input" type="number" min="1" placeholder="Custom" value="100" style="margin-top:8px"/>
            <div style="font-size:0.72rem;color:var(--text-dim);font-style:italic;margin-top:6px;text-align:center">
              5 rounds × stake = minimum required. Winners earn from folds and raises each round.
            </div>
          </div>

          <div class="pub-status-bar" id="dh-lobby-status">Open a table to begin. 3–4 players needed.</div>

          <div id="dh-lobby-players" class="dh-lobby-players">
            <div class="dh-lobby-player-row" style="justify-content:center;color:var(--text-dim);font-style:italic">No open table. Open one to start.</div>
          </div>

          <div class="dh-action-row">
            <button class="dh-btn-primary" id="dh-create-btn" onclick="window._dhCreate()">🃏 Open Table</button>
            <button class="dh-btn-primary" id="dh-join-btn" onclick="window._dhJoin()" style="display:none">🚪 Join Table</button>
            <button class="dh-btn-primary" id="dh-start-btn" onclick="window._dhStartGame()" style="display:none">▶ Deal Cards!</button>
            <button class="pub-btn-secondary" id="dh-leave-btn" onclick="window._dhLeaveTable()" style="display:none">🚪 Leave Table</button>
          </div>
        </div>
      </div>

      <!-- Active game view (hidden until game starts) -->
      <div id="dh-game" style="display:none">
        <!-- Round tracker -->
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:8px">
          <span class="dh-round-label">Round</span>
          ${[1,2,3,4,5].map(i=>`<div class="dh-round-pip" id="dh-pip-${i}">${i}</div>`).join('')}
        </div>

        <!-- Info bar -->
        <div class="dh-info-bar">
          <div class="dh-info-cell">
            <div class="dh-info-cell-label">Round Pot</div>
            <div class="dh-info-cell-value" id="dh-round-pot">0 💰</div>
          </div>
          <div class="dh-info-cell">
            <div class="dh-info-cell-label">Total Pot</div>
            <div class="dh-info-cell-value" id="dh-total-pot">0 💰</div>
          </div>
          <div class="dh-info-cell">
            <div class="dh-info-cell-label">Your Matches</div>
            <div class="dh-info-cell-value" id="dh-my-matches">?</div>
          </div>
        </div>

        <!-- Notifications -->
        <div class="dh-notifications" id="dh-notifications">
          <div class="dh-notif-line">The cards are being shuffled…</div>
        </div>

        <!-- Table's Hand -->
        <div class="dh-table-section">
          <div class="dh-section-label">⚜ Table's Hand — Visible to All</div>
          <div class="dh-cards-row" id="dh-table-cards">
            ${Array(5).fill(0).map(()=>`<div class="dh-card-slot"></div>`).join('')}
          </div>
        </div>

        <!-- Players -->
        <div id="dh-players-grid" class="dh-players-grid"></div>

        <!-- Your hand -->
        <div class="dh-hand-section" id="dh-hand-section">
          <div class="dh-section-label">🤫 Your Hand — Only You Can See This</div>
          <div class="dh-cards-row" id="dh-my-hand">
            ${Array(5).fill(0).map(()=>`<div class="dh-card-slot"></div>`).join('')}
          </div>
        </div>

        <!-- Actions -->
        <div class="dh-action-row" id="dh-actions" style="margin-top:12px">
          <button class="dh-btn-fold"  id="dh-fold-btn"  onclick="window._dhFold()"  disabled>✂ Fold (keep half stake)</button>
          <button class="dh-btn-raise" id="dh-raise-btn" onclick="window._dhRaise()" disabled>⬆ Raise (add full stake)</button>
        </div>
        <div class="pub-status-bar" id="dh-game-status" style="margin-top:6px">Waiting…</div>
      </div>
    </div>`;
}

window._dhSetStake = function(v) {
  const input = document.getElementById('dh-stake-input');
  if (input && !input.disabled) input.value = v;
  document.querySelectorAll('#game-devils-hand .pub-bet-preset').forEach(b => b.classList.toggle('active', +b.textContent === v));
};


function _dhLockStakeToHost(amount) {
  const input = document.getElementById('dh-stake-input');
  if (!input) return;
  input.value    = amount;
  input.disabled = true;
  input.title    = 'Stake is fixed at ' + amount + ' (set by the host)';
  document.querySelectorAll('#game-devils-hand .pub-bet-preset').forEach(b => {
    const isMatch = +b.textContent === amount;
    b.classList.toggle('active',   isMatch);
    b.classList.toggle('disabled', !isMatch);
    b.disabled      = true;
    b._savedOnclick = b.onclick;
    b.onclick       = null;
    b.title         = isMatch ? ('Table stake: ' + amount) : ('Stake fixed at ' + amount);
  });
  const wrap = input.parentElement;
  if (wrap && !wrap.querySelector('.dh-stake-locked-note')) {
    const note = document.createElement('div');
    note.className   = 'dh-stake-locked-note';
    note.style.cssText = 'font-size:0.72rem;color:var(--gold-dim);margin-top:4px;font-style:italic;text-align:center';
    note.textContent = 'Stake fixed at ' + amount + ' \u{1F4B0} \u2014 set by the host';
    input.insertAdjacentElement('afterend', note);
  }
}

function _dhUnlockStake() {
  const input = document.getElementById('dh-stake-input');
  if (!input) return;
  input.disabled = false;
  input.title    = '';
  document.querySelectorAll('#game-devils-hand .pub-bet-preset').forEach(b => {
    b.classList.remove('disabled');
    b.disabled = false;
    b.title    = '';
    if (b._savedOnclick !== undefined) {
      b.onclick       = b._savedOnclick;
      b._savedOnclick = undefined;
    }
  });
  document.querySelector('.dh-stake-locked-note')?.remove();
}

// ── Create Devil's Hand table ─────────────────────────────────────
window._dhCreate = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }

  const baseStake = parseInt(document.getElementById('dh-stake-input')?.value) || 100;
  if (baseStake < 1) { window.showToast?.('Enter a valid stake.', ''); return; }

  const minGold = baseStake * 5;
  if ((_charData.gold || 0) < minGold) {
    window.showToast?.(`Need at least ${minGold} 💰 to cover 5 rounds.`, 'error');
    return;
  }

  const btn = document.getElementById('dh-create-btn');
  if (btn) btn.disabled = true;
  _showTableLoadingOverlay('game-devils-hand', 'Opening Table');

  const pub = _getCurrentPub();
  try {
    const result = await _fnCreateDevilsHand({
      baseStake,
      pubLocation: pub?.location || 'unknown',
      playerName:  _charData.name || 'Unknown',
    });
    _activeGameId = result.data.gameId;
    window.showToast?.('Table opened! Waiting for 2–3 more players.', 'success');
    _hideTableLoadingOverlay();
    _dhSubscribeGame(result.data.gameId);
  } catch(e) {
    const msg = e?.message || e?.details || '';
    if (msg.includes('already open') || msg.includes('already-exists')) {
      window.showToast?.('A table is already open — join it instead!', '');
    } else if (msg.includes('💰') || msg.includes('failed-precondition')) {
      window.showToast?.(msg, 'error');
    } else {
      console.warn('[DH] create error:', e);
      window.showToast?.('Failed to open table.', 'error');
    }
    _hideTableLoadingOverlay();
    if (btn) btn.disabled = false;
  }
};

// ── Leave Devil's Hand table (lobby only) ─────────────────────────
window._dhLeaveTable = async function() {
  if (!_activeGameId || !_uid) return;
  const btn = document.getElementById('dh-leave-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Leaving…'; }
  try {
    const snap = await getDoc(doc(db, 'pubGames', _activeGameId));
    if (!snap.exists()) {
      // Doc already gone — clean up locally
      if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
      _activeGameId = null;
      return;
    }
    const game = snap.data();
    if (game.status !== 'lobby') {
      window.showToast?.("Game has already started — you can't leave now.", '');
      if (btn) { btn.disabled = false; btn.textContent = '🚪 Leave Table'; }
      return;
    }
    const remaining = game.players.filter(p => p.uid !== _uid);
    if (remaining.length === 0) {
      // Last player — delete the whole doc
      await deleteDoc(doc(db, 'pubGames', _activeGameId));
    } else {
      // Transfer host if needed
      const newHostUid = game.hostUid === _uid ? remaining[0].uid : game.hostUid;
      await updateDoc(doc(db, 'pubGames', _activeGameId), {
        players:       remaining,
        hostUid:       newHostUid,
        notifications: [...(game.notifications || []), `${game.players.find(p => p.uid === _uid)?.name || 'A player'} left the table.`],
      });
    }
    window.showToast?.('Left the table.', '');
    if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
    _activeGameId = null;
  } catch(e) {
    console.warn('[DH] leave error:', e);
    window.showToast?.('Failed to leave. Try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🚪 Leave Table'; }
  }
};

// ── Join Devil's Hand table ────────────────────────────────────────
window._dhJoin = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }

  const btn = document.getElementById('dh-join-btn');
  if (btn) btn.disabled = true;
  _showTableLoadingOverlay('game-devils-hand', 'Joining Table');

  const pub = _getCurrentPub();
  try {
    const result = await _fnJoinDevilsHand({
      pubLocation: pub?.location || 'unknown',
      playerName:  _charData.name || 'Unknown',
    });
    _activeGameId = result.data.gameId;
    window.showToast?.('Joined the table!', 'success');
    _hideTableLoadingOverlay();
    _dhSubscribeGame(result.data.gameId);
  } catch(e) {
    const msg = e?.message || e?.details || '';
    if (msg.includes('not-found') || msg.includes('No open')) {
      window.showToast?.('No open table found.', '');
    } else if (msg.includes('full')) {
      window.showToast?.('Table is full! (4 players max)', '');
    } else if (msg.includes('already-exists') || msg.includes('Already seated')) {
      window.showToast?.('Already at the table!', '');
      // Re-subscribe in case they refreshed
      const pub2 = _getCurrentPub();
      const probe = await getDocs(query(
        collection(db,'pubGames'),
        where('gameType', '==', 'devils-hand'),
        where('status',   '==', 'lobby'),
        where('pubLocation', '==', pub2?.location || 'unknown'),
        limit(1)
      ));
      if (!probe.empty) { _activeGameId = probe.docs[0].id; _dhSubscribeGame(_activeGameId); }
    } else if (msg.includes('💰') || msg.includes('failed-precondition')) {
      window.showToast?.(msg, 'error');
    } else {
      console.warn('[DH] join error:', e);
      window.showToast?.('Failed to join.', 'error');
    }
    _hideTableLoadingOverlay();
    if (btn) btn.disabled = false;
  }
};

// ── Start the game (host only) ─────────────────────────────────────
window._dhStartGame = async function() {
  if (!_activeGameId || !_uid) return;

  const btn = document.getElementById('dh-start-btn');
  if (btn) btn.disabled = true;

  const snap = await getDoc(doc(db, 'pubGames', _activeGameId));
  if (!snap.exists()) return;
  const game = snap.data();

  if (game.hostUid !== _uid) { window.showToast?.('Only the host can start.', ''); return; }
  if (game.players.length < 3) { window.showToast?.('Need at least 3 players.', ''); if (btn) btn.disabled = false; return; }

  await _dhDealRound(game, _activeGameId, 1);
};

// ── Deal a new round ───────────────────────────────────────────────
async function _dhDealRound(game, gameId, roundNum) {
  const deck      = _dhShuffle(_dhBuildDeck());
  const tableCards = deck.splice(0, 5);
  const hands      = {};
  for (const p of game.players) {
    hands[p.uid] = deck.splice(0, 5);
  }

  // Deduct base stake from all players for this round
  const baseStake   = game.baseStake || 100;
  const roundPot    = baseStake * game.players.length;
  const totalPot    = (game.totalPot || 0) + roundPot;
  const turnOrder   = game.players.map(p => p.uid);
  const updatedPlayers = game.players.map(p => ({
    ...p,
    status:   'waiting',
    totalBet: (p.totalBet || 0) + baseStake,
  }));

  // Deduct from each player's gold
  for (const p of game.players) {
    await _deductGold_forUid(p.uid, baseStake);
  }

  await updateDoc(doc(db, 'pubGames', gameId), {
    status:        'betting',
    round:         roundNum,
    tableCards,
    hands,
    players:       updatedPlayers,
    turnOrder,
    participants:  turnOrder,   // flat uid[] — used by security rules instead of players.map()
    currentTurn:   0,
    roundPot,
    totalPot,
    notifications: [`📜 Round ${roundNum} begins. Base stake: ${baseStake} 💰 each.`, `👁 ${updatedPlayers[0].name}'s turn to act.`],
    roundWinner:   null,
  });
}

// Deduct gold for any player uid (only works for current user on client)
async function _deductGold_forUid(uid, amount) {
  const myUid = _uid || window._uid;
  if (uid !== myUid) return; // other players' gold is handled server-side or by each client
  await _deductGold(amount);
}

// ── Subscribe to game state ────────────────────────────────────────
function _dhSubscribeGame(gameId) {
  if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
  _activeGameUnsub = onSnapshot(doc(db, 'pubGames', gameId), snap => {
    if (!snap.exists()) return;
    _dhRenderGameState(snap.data(), gameId);
  });
}

// ── Render game state ──────────────────────────────────────────────
let _dhLastNotifCount = 0;

async function _dhRenderGameState(game, gameId) {
  const myUid = _uid || window._uid;

  // Switch from setup to game view once game starts
  if (['betting','resolving','round_end','complete'].includes(game.status)) {
    const setup = document.getElementById('dh-setup');
    const gameDiv = document.getElementById('dh-game');
    if (setup)   setup.style.display   = 'none';
    if (gameDiv) gameDiv.style.display = '';
    if (_dhCancelTimer)  { clearInterval(_dhCancelTimer); _dhCancelTimer = null; }
    if (_dhLobbyUnsub) { _dhLobbyUnsub(); _dhLobbyUnsub = null; }  }

  // Round pips
  for (let i = 1; i <= 5; i++) {
    const pip = document.getElementById(`dh-pip-${i}`);
    if (!pip) continue;
    pip.className = 'dh-round-pip';
    if (i < game.round) pip.classList.add('won');
    else if (i === game.round) pip.classList.add('active');
  }

  // Pots
  const roundPotEl = document.getElementById('dh-round-pot');
  const totalPotEl = document.getElementById('dh-total-pot');
  if (roundPotEl) roundPotEl.textContent = `${(game.roundPot || 0).toLocaleString()} 💰`;
  if (totalPotEl) totalPotEl.textContent = `${(game.totalPot || 0).toLocaleString()} 💰`;

  // Table cards
  const tableEl = document.getElementById('dh-table-cards');
  if (tableEl && game.tableCards?.length) {
    tableEl.innerHTML = game.tableCards.map(cid =>
      `<div style="display:flex;flex-direction:column;align-items:center">${_dhCardHtml(cid, true, false)}</div>`
    ).join('');
  }

  // My hand
  const myHand = game.hands?.[myUid] || [];
  const tableBaseIds = (game.tableCards || []).map(c => _dhBaseId(c));
  const myMatchCount = myHand.filter(c => tableBaseIds.includes(_dhBaseId(c))).length;

  const myHandEl = document.getElementById('dh-my-hand');
  if (myHandEl && myHand.length) {
    myHandEl.innerHTML = myHand.map(cid => {
      const isMatch = tableBaseIds.includes(_dhBaseId(cid));
      return `<div style="display:flex;flex-direction:column;align-items:center">${_dhCardHtml(cid, true, isMatch)}</div>`;
    }).join('');
  }

  // My matches display
  const myMatchEl = document.getElementById('dh-my-matches');
  if (myMatchEl) myMatchEl.textContent = game.status === 'lobby' ? '?' : String(myMatchCount);

  // Players grid
  const playersEl = document.getElementById('dh-players-grid');
  if (playersEl) {
    const currentTurnUid = game.turnOrder?.[game.currentTurn] || null;
    playersEl.innerHTML = game.players.map(p => {
      const isMe       = p.uid === myUid;
      const isActive   = game.status === 'betting' && p.uid === currentTurnUid;
      const isFolded   = p.status === 'folded';
      const isWinner   = game.status === 'round_end' && p.uid === game.roundWinner;
      const isGameWinner = game.status === 'complete' && p.uid === game.winnerUid;

      let cls = 'dh-player-slot';
      if (isMe)          cls += ' dh-player-me';
      if (isFolded)      cls += ' dh-player-folded';
      if (isActive)      cls += ' dh-player-active-turn';
      if (isWinner || isGameWinner) cls += ' dh-player-winner';

      let statusLabel = '';
      if (isGameWinner) statusLabel = `<span class="dh-player-status-badge dh-status-winner">🏆 WINNER</span>`;
      else if (isWinner) statusLabel = `<span class="dh-player-status-badge dh-status-winner">✓ Round Win</span>`;
      else if (isFolded)  statusLabel = `<span class="dh-player-status-badge dh-status-folded">Folded</span>`;
      else if (p.status === 'raised') statusLabel = `<span class="dh-player-status-badge dh-status-raised">Raised</span>`;
      else if (isActive)  statusLabel = `<span class="dh-player-status-badge dh-status-your-turn">Their Turn</span>`;
      else statusLabel = `<span class="dh-player-status-badge dh-status-waiting">Waiting</span>`;

      // Show match count + revealed hand only on round_end/complete
      let matchInfo = '';
      if (['round_end','complete'].includes(game.status) && game.hands?.[p.uid]) {
        const pMatches = _dhCountMatches(game.hands[p.uid], game.tableCards || []);
        matchInfo = `<div class="dh-player-match-count">${pMatches} match${pMatches !== 1 ? 'es' : ''}</div>`;
        // Show their cards
        const cardRow = game.hands[p.uid].map(cid => {
          const im = tableBaseIds.includes(_dhBaseId(cid));
          return `<div style="display:inline-flex;flex-direction:column;align-items:center;margin-right:4px">
            <div class="dh-card${im ? ' dh-card-match' : ''}" style="width:40px;height:56px">
              <img src="${_dhCardInfo(cid).url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:6px">
            </div>
          </div>`;
        }).join('');
        matchInfo += `<div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:6px">${cardRow}</div>`;
      }

      return `
        <div class="${cls}">
          <div class="dh-player-name">${isMe ? '⭐ You' : p.name}</div>
          ${statusLabel}
          <div class="dh-player-bet-info">Total staked: ${(p.totalBet || 0).toLocaleString()} 💰 | Rounds won: ${p.roundsWon || 0}</div>
          ${matchInfo}
        </div>`;
    }).join('');
  }

  // Notifications
  const notifEl = document.getElementById('dh-notifications');
  if (notifEl && game.notifications) {
    if (game.notifications.length !== _dhLastNotifCount) {
      _dhLastNotifCount = game.notifications.length;
      notifEl.innerHTML = game.notifications.slice(-8).map((n,i) =>
        `<div class="dh-notif-line${i === game.notifications.slice(-8).length - 1 ? ' dh-notif-highlight' : ''}">${n}</div>`
      ).join('');
      notifEl.scrollTop = notifEl.scrollHeight;
    }
  }

  // Action buttons
  const foldBtn  = document.getElementById('dh-fold-btn');
  const raiseBtn = document.getElementById('dh-raise-btn');
  const statusEl = document.getElementById('dh-game-status');
  const isMyTurn = game.status === 'betting' && game.turnOrder?.[game.currentTurn] === myUid;
  const myEntry  = game.players.find(p => p.uid === myUid);
  const alreadyActed = myEntry?.status === 'raised' || myEntry?.status === 'folded';

  if (foldBtn)  foldBtn.disabled  = !isMyTurn || alreadyActed;
  if (raiseBtn) raiseBtn.disabled = !isMyTurn || alreadyActed;

  if (statusEl) {
    if (game.status === 'betting') {
      if (isMyTurn && !alreadyActed) {
        statusEl.textContent = `⚡ Your turn — Fold (lose half stake) or Raise (add ${(game.baseStake||100).toLocaleString()} 💰)`;
        statusEl.className = 'pub-status-bar roll';
      } else if (alreadyActed) {
        statusEl.textContent = `You've acted. Waiting for other players...`;
        statusEl.className = 'pub-status-bar';
      } else {
        const currentName = game.players.find(p => p.uid === game.turnOrder?.[game.currentTurn])?.name || '?';
        statusEl.textContent = `Waiting for ${currentName} to act...`;
        statusEl.className = 'pub-status-bar';
      }
    } else if (game.status === 'round_end') {
      const winner = game.players.find(p => p.uid === game.roundWinner);
      if (game.roundWinner === 'tie') {
        statusEl.textContent = `🤝 Tie! Pot split between tied players.`;
      } else {
        statusEl.textContent = `🏆 ${winner?.name || 'Someone'} wins this round!`;
      }
      statusEl.className = 'pub-status-bar win';
    } else if (game.status === 'complete') {
      const won = game.winnerUid === myUid;
      statusEl.textContent = won
        ? `🎉 YOU WIN THE GAME! +${game.prize} 💰`
        : `${game.winnerName} wins the game with ${game.prize} 💰!`;
      statusEl.className = `pub-status-bar ${won ? 'win' : 'loss'}`;
    }
  }

  // Handle resolving — host is the single authority that calls _dhResolveRound.
  // This avoids permission errors where a non-host player tries to write
  // 'round_end' while Firestore still sees the old status ('betting') as resource.data.
  if (game.status === 'resolving' && game.hostUid === myUid && !_dhResolvingRound) {
    _dhResolvingRound = true;
    _dhResolveRound(gameId).finally(() => { _dhResolvingRound = false; });
  }

  // Handle round_end — auto-advance after 4s (host only)
  if (game.status === 'round_end' && game.hostUid === myUid && !_dhAdvancingRound) {
    _dhAdvancingRound = true;
    setTimeout(async () => {
      _dhAdvancingRound = false;
      const latestSnap = await getDoc(doc(db, 'pubGames', gameId));
      if (!latestSnap.exists() || latestSnap.data().status !== 'round_end') return;
      const latestGame = latestSnap.data();
      if (latestGame.round < 5) {
        await _dhDealRound(latestGame, gameId, latestGame.round + 1);
      } else {
        await _dhFinishGame(latestGame, gameId);
      }
    }, 4000);
  }

  // Handle round_end: each player awards their own gold from roundPayouts.
  // This avoids the host writing to other players' character docs.
  if (game.status === 'round_end') {
    const roundKey = gameId + '_r' + game.round;
    const myPayout = game.roundPayouts?.[myUid] || 0;
    if (myPayout > 0 && !_awardedGameIds.has(roundKey)) {
      _awardedGameIds.add(roundKey);
      await _awardGold(myUid, myPayout);
    }
  }

  // Handle complete
  if (game.status === 'complete') {
    const won = game.winnerUid === myUid;
    if (won && !_awardedGameIds.has(gameId)) {
      _awardedGameIds.add(gameId);
      await _awardGold(myUid, game.prize); // winner awards themselves
      _spawnCoinRain();
      window.logActivity?.('🃏', `<b>Pub Win!</b> Devil's Hand — Won <b>${game.prize}</b> 💰.`, '#4ec878');
      // Sync gold display from Firestore so the displayed balance is authoritative
      setTimeout(async () => {
        try {
          await window.refreshCharData?.();
          const g = window._charData?.gold ?? 0;
          document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = g);
          document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = g);
        } catch(e) { console.warn('[Pub] DH post-win gold sync failed:', e); }
      }, 2500);
      // Clear any debt the winner had from loans during this game
      const charDebt = (_charData?.debtGold || window._charData?.debtGold || 0);
      if (charDebt > 0) {
        try {
          await updateDoc(doc(db, 'characters', myUid), { debtGold: 0, debtSource: null });
          if (_charData) _charData.debtGold = 0;
          if (window._charData) window._charData.debtGold = 0;
          window.showToast?.('🎉 Debt cleared by your winnings!', 'success');
        } catch(e) { console.warn('[DH] debt clear failed:', e); }
      }
    }
    if (game.players.some(p => p.uid === myUid)) {
      setTimeout(() => {
        const myBet = game.players.find(p => p.uid === myUid)?.totalBet || 0;
        _showResultOverlay(won, null, game.winnerName, game.prize, won ? game.prize : myBet);
      }, 1200);
    }
    setTimeout(() => { if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; } _activeGameId = null; }, 6000);
  }
}

let _dhAdvancingRound = false;
let _dhResolvingRound = false;

// ── Player action: Fold ────────────────────────────────────────────
window._dhFold = async function() {
  if (!_activeGameId || !_uid) return;
  const btn = document.getElementById('dh-fold-btn');
  if (btn) btn.disabled = true;

  const snap = await getDoc(doc(db, 'pubGames', _activeGameId));
  if (!snap.exists()) return;
  const game = snap.data();

  if (game.turnOrder?.[game.currentTurn] !== _uid) { window.showToast?.("Not your turn!", ''); return; }

  const myEntry   = game.players.find(p => p.uid === _uid);
  const halfStake = Math.floor((game.baseStake || 100) / 2);

  // Refund half stake to folding player
  await _awardGold(_uid, halfStake);

  const updatedPlayers = game.players.map(p =>
    p.uid === _uid ? { ...p, status: 'folded', totalBet: (p.totalBet || 0) } : p
  );

  // Remove fold amount from round pot (they lose half, so the pot gets the other half)
  const newRoundPot = (game.roundPot || 0); // pot stays; fold means you lose half stake = half stays in pot

  const notif = `${myEntry?.name || 'Player'} folds. Keeps ${halfStake} 💰.`;
  const nextTurn = _dhNextActiveTurn(game, game.currentTurn);

  const updates = {
    players:       updatedPlayers,
    roundPot:      newRoundPot,
    currentTurn:   nextTurn,
    notifications: [...(game.notifications || []), notif],
  };

  // Check if round should resolve
  const activePlayers = updatedPlayers.filter(p => p.status !== 'folded');
  const allActed      = updatedPlayers.every(p => p.status === 'folded' || p.status === 'raised');

  if (activePlayers.length <= 1 || allActed) {
    updates.status = 'resolving';
  } else {
    // Add next player turn notification
    const nextName = game.players[nextTurn]?.name || game.players.find(p => p.uid === game.turnOrder?.[nextTurn])?.name;
    if (nextName) updates.notifications = [...updates.notifications, `👁 ${nextName}'s turn to act.`];
  }

  try {
    await updateDoc(doc(db, 'pubGames', _activeGameId), updates);
    // Resolution is triggered by the host's onSnapshot (see _dhRenderGameState).
    // Do NOT call _dhResolveRound here — the acting player may not be the host,
    // and calling updateDoc from a non-host client while status is still 'betting'
    // in Firestore causes a security rule rejection.
  } catch(e) {
    console.warn('[DH] fold error:', e);
    window.showToast?.('Action failed. Try again.', 'error');
    if (btn) btn.disabled = false;
    const raiseBtn = document.getElementById('dh-raise-btn');
    if (raiseBtn) raiseBtn.disabled = false;
  }
};

// ── Player action: Raise ───────────────────────────────────────────
window._dhRaise = async function() {
  if (!_activeGameId || !_uid) return;
  const btn = document.getElementById('dh-raise-btn');
  if (btn) btn.disabled = true;

  const snap = await getDoc(doc(db, 'pubGames', _activeGameId));
  if (!snap.exists()) return;
  const game = snap.data();

  if (game.turnOrder?.[game.currentTurn] !== _uid) { window.showToast?.("Not your turn!", ''); return; }

  const raiseAmount = game.baseStake || 100;
  const currentGold = (_charData?.gold || window._charData?.gold || 0);
  const willLoan = currentGold < raiseAmount;
  if (willLoan) {
    const shortfall = raiseAmount - currentGold;
    const confirmed = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center';
      overlay.innerHTML = `
        <div style="background:var(--card-bg,#1a1a2e);border:1px solid var(--border,#333);border-radius:12px;padding:24px;max-width:320px;width:90%;text-align:center">
          <div style="font-size:1.5rem;margin-bottom:8px">💸</div>
          <div style="font-weight:700;margin-bottom:8px;color:var(--gold,#c9a84c)">Raise on Loan?</div>
          <div style="font-size:0.9rem;color:var(--text-dim,#aaa);margin-bottom:16px">
            You're short <b>${shortfall} 💰</b>.<br>
            Raising will put you <b style="color:#e05555">−${shortfall} in debt</b>.<br>
            You owe the house — pay it back or face consequences.
          </div>
          <div style="display:flex;gap:12px;justify-content:center">
            <button id="_dh_loan_no"  style="padding:8px 20px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:var(--text,#eee);cursor:pointer">Cancel</button>
            <button id="_dh_loan_yes" style="padding:8px 20px;border-radius:8px;border:none;background:#c9a84c;color:#000;font-weight:700;cursor:pointer">Raise Anyway</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#_dh_loan_yes').onclick = () => { document.body.removeChild(overlay); resolve(true); };
      overlay.querySelector('#_dh_loan_no').onclick  = () => { document.body.removeChild(overlay); resolve(false); };
    });
    if (!confirmed) {
      if (btn) btn.disabled = false;
      const foldBtn = document.getElementById('dh-fold-btn');
      if (foldBtn) foldBtn.disabled = false;
      return;
    }
    // Record the debt on the character doc
    const existingDebt = (_charData?.debtGold || window._charData?.debtGold || 0);
    const newDebt = existingDebt + shortfall;
    try {
      await updateDoc(doc(db, 'characters', _uid), { debtGold: newDebt, debtSource: "Devil's Hand" });
      if (_charData) _charData.debtGold = newDebt;
      if (window._charData) window._charData.debtGold = newDebt;
    } catch(e) { console.warn('[DH] debt record failed:', e); }
    window.showToast?.(`📜 Loan granted — you're ${shortfall} 💰 in debt. Gamble wisely.`, 'warning');
  }

  await _deductGold(raiseAmount);

  const myEntry = game.players.find(p => p.uid === _uid);
  const updatedPlayers = game.players.map(p =>
    p.uid === _uid ? { ...p, status: 'raised', totalBet: (p.totalBet || 0) + raiseAmount } : p
  );

  const notif = `${myEntry?.name || 'Player'} raises! +${raiseAmount} 💰${willLoan ? ' (loan)' : ''}`;
  const newRoundPot = (game.roundPot || 0) + raiseAmount;
  const newTotalPot = (game.totalPot || 0) + raiseAmount;
  const nextTurn    = _dhNextActiveTurn(game, game.currentTurn);

  const updates = {
    players:       updatedPlayers,
    roundPot:      newRoundPot,
    totalPot:      newTotalPot,
    currentTurn:   nextTurn,
    notifications: [...(game.notifications || []), notif],
  };

  const allActed = updatedPlayers.every(p => p.status === 'folded' || p.status === 'raised');
  const activePlayers = updatedPlayers.filter(p => p.status !== 'folded');

  if (activePlayers.length <= 1 || allActed) {
    updates.status = 'resolving';
  } else {
    const nextName = game.players.find(p => p.uid === game.turnOrder?.[nextTurn])?.name;
    if (nextName) updates.notifications = [...updates.notifications, `👁 ${nextName}'s turn to act.`];
  }

  try {
    await updateDoc(doc(db, 'pubGames', _activeGameId), updates);
    // Resolution is triggered by the host's onSnapshot (see _dhRenderGameState).
    // Do NOT call _dhResolveRound here — see fold action comment for explanation.
  } catch(e) {
    console.warn('[DH] raise error:', e);
    window.showToast?.('Action failed. Try again.', 'error');
    // Refund the raise since the write failed
    await _awardGold(_uid, raiseAmount);
    if (btn) btn.disabled = false;
    const foldBtn = document.getElementById('dh-fold-btn');
    if (foldBtn) foldBtn.disabled = false;
  }
};

// Get next active (non-folded) turn index
function _dhNextActiveTurn(game, currentTurn) {
  const n = game.turnOrder.length;
  for (let i = 1; i <= n; i++) {
    const idx = (currentTurn + i) % n;
    const uid = game.turnOrder[idx];
    const p   = game.players.find(pl => pl.uid === uid);
    if (p && p.status !== 'folded') return idx;
  }
  return (currentTurn + 1) % n;
}

// ── Resolve round ──────────────────────────────────────────────────
async function _dhResolveRound(gameId) {
  const snap = await getDoc(doc(db, 'pubGames', gameId));
  if (!snap.exists()) return;
  const game = snap.data();

  const tableCards    = game.tableCards || [];
  const activePlayers = game.players.filter(p => p.status !== 'folded');

  // Count matches for each active player
  const scored = activePlayers.map(p => ({
    uid:     p.uid,
    name:    p.name,
    matches: _dhCountMatches(game.hands?.[p.uid] || [], tableCards),
  }));

  const maxMatches = Math.max(...scored.map(s => s.matches));
  const winners    = scored.filter(s => s.matches === maxMatches);

  let roundWinner  = null;
  let roundPrize   = game.roundPot || 0;
  let notifs       = [...(game.notifications || [])];
  const updatedPlayers = [...game.players];

  // roundPayouts: { uid: goldAmount } written to Firestore so each player's
  // own client awards themselves. Host must never write to others' character docs.
  const roundPayouts = {};

  notifs.push(`\u{1F0CF} Cards revealed!`);
  scored.forEach(s => notifs.push(`  ${s.name}: ${s.matches} match${s.matches !== 1 ? 'es' : ''}`));

  if (winners.length === 1) {
    roundWinner = winners[0].uid;
    roundPayouts[roundWinner] = roundPrize;
    notifs.push(`\u{1F3C6} ${winners[0].name} wins the round with ${maxMatches} match${maxMatches !== 1 ? 'es' : ''}! +${roundPrize} \u{1F4B0}`);
    const idx = updatedPlayers.findIndex(p => p.uid === roundWinner);
    if (idx >= 0) updatedPlayers[idx] = { ...updatedPlayers[idx], roundsWon: (updatedPlayers[idx].roundsWon || 0) + 1 };
  } else {
    // Tie - raisers beat folders; if still tied, split pot
    const raisers    = winners.filter(w => game.players.find(p => p.uid === w.uid)?.status === 'raised');
    const tiebreaker = raisers.length === 1 ? raisers : winners;
    if (tiebreaker.length === 1) {
      roundWinner = tiebreaker[0].uid;
      roundPayouts[roundWinner] = roundPrize;
      notifs.push(`\u2694 Tiebreaker! ${tiebreaker[0].name} wins (raised). +${roundPrize} \u{1F4B0}`);
      const idx = updatedPlayers.findIndex(p => p.uid === roundWinner);
      if (idx >= 0) updatedPlayers[idx] = { ...updatedPlayers[idx], roundsWon: (updatedPlayers[idx].roundsWon || 0) + 1 };
    } else {
      // True tie - split
      roundWinner = 'tie';
      const share = Math.floor(roundPrize / tiebreaker.length);
      for (const w of tiebreaker) {
        roundPayouts[w.uid] = share;
        const idx = updatedPlayers.findIndex(p => p.uid === w.uid);
        if (idx >= 0) updatedPlayers[idx] = { ...updatedPlayers[idx], roundsWon: (updatedPlayers[idx].roundsWon || 0) + 1 };
      }
      notifs.push(`\u{1F91D} Tie! Pot split (${share} \u{1F4B0} each) among: ${tiebreaker.map(w=>w.name).join(', ')}`);
    }
  }

  // No _awardGold calls here - payouts stored in doc, each client pays themselves.
  await updateDoc(doc(db, 'pubGames', gameId), {
    status:        'round_end',
    roundWinner,
    roundPayouts,
    players:       updatedPlayers,
    notifications: notifs,
  });
}

// ── Finish game (after 5 rounds) ───────────────────────────────────
async function _dhFinishGame(game, gameId) {
  // Winner = player with most rounds won
  const sorted = [...game.players].sort((a, b) => (b.roundsWon || 0) - (a.roundsWon || 0));
  const topWins = sorted[0].roundsWon || 0;
  const topPlayers = sorted.filter(p => (p.roundsWon || 0) === topWins);

  const winner = topPlayers[0]; // if still tied, first alphabetically wins
  const prize  = game.totalPot || 0;

  // No _awardGold here - winner pays themselves when they see status='complete'.
  // winnerUid + prize are stored in the doc for each client to read.

  await updateDoc(doc(db, 'pubGames', gameId), {
    status:      'complete',
    winnerUid:   winner.uid,
    winnerName:  winner.name,
    prize,
    notifications: [...(game.notifications || []),
      `🏆 ${winner.name} wins DEVIL'S HAND with ${topWins} round${topWins !== 1 ? 's' : ''} won!`,
      `💰 Total prize: ${prize.toLocaleString()} 💰`,
    ],
    completedAt: serverTimestamp(),
    goldSettled: true,
  });

  // Log to results feed
  try {
    await addDoc(collection(db, 'pubGames'), {
      gameType:    'devils-hand',
      status:      'complete',
      pubLocation: game.pubLocation || 'unknown',
      hostUid:     game.hostUid,
      winnerUid:   winner.uid,
      winnerName:  winner.name,
      prize,
      pot:         prize,
      players:     game.players,
      completedAt: serverTimestamp(),
      createdAt:   serverTimestamp(),
      goldSettled: true,
    });
  } catch(_) {}
}

// ═══════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  TABLE LOADING OVERLAY
//  Shows an animated overlay while opening/joining any game.
//  Call _showTableLoadingOverlay(containerId, message) on click,
//  then _hideTableLoadingOverlay() once the async call resolves.
// ═══════════════════════════════════════════════════════════════
const _LOADING_SUBS = [
  'Shuffling the deck...',
  'Lighting the candles...',
  'Bribing Barkeep Rowan...',
  'Polishing the dice...',
  'Calling the spirits...',
  'Counting the gold...',
  'Setting the table...',
];

function _showTableLoadingOverlay(containerId, title) {
  _hideTableLoadingOverlay(); // clear any stale one
  const container = document.getElementById(containerId);
  if (!container) return;
  // Make sure container is position:relative so the overlay sits inside it
  container.style.position = 'relative';
  const sub = _LOADING_SUBS[Math.floor(Math.random() * _LOADING_SUBS.length)];
  const el  = document.createElement('div');
  el.id          = 'pub-loading-overlay';
  el.className   = 'pub-loading-overlay';
  el.innerHTML   = `
    <div class="pub-loading-cards">
      <div class="pub-loading-card">🃏</div>
      <div class="pub-loading-card">🎲</div>
      <div class="pub-loading-card">💰</div>
      <div class="pub-loading-card">🎲</div>
      <div class="pub-loading-card">🃏</div>
    </div>
    <div class="pub-loading-title">${title}</div>
    <div class="pub-loading-dots">
      <span></span><span></span><span></span>
    </div>
    <div class="pub-loading-sub">${sub}</div>`;
  container.appendChild(el);
}

function _hideTableLoadingOverlay() {
  document.getElementById('pub-loading-overlay')?.remove();
}

function _showResultOverlay(won, roll, winnerName, prize, myPrize) {
  document.getElementById('pub-result-overlay')?.remove();
  const el = document.createElement('div');
  el.id        = 'pub-result-overlay';
  el.className = 'pub-result-overlay';
  el.innerHTML = `
    <div class="pub-result-box">
      <div class="pub-result-emoji">${won ? '🎉' : '💸'}</div>
      <div class="pub-result-title">${won ? 'YOU WIN!' : 'BETTER LUCK NEXT TIME'}</div>
      <div class="pub-result-desc">
        ${won
          ? (roll !== null ? `The dice landed on <strong>${roll}</strong>. You take the pot!` : `You take the pot!`)
          : `<strong>${winnerName}</strong> wins${roll !== null ? ` with ${roll}` : ''}!`}
      </div>
      <div class="pub-result-coins ${won ? '' : 'loss-coins'}">
        ${won ? `+${myPrize} 💰` : `-${myPrize} 💰`}
      </div>
      <button class="pub-btn-roll" onclick="document.getElementById('pub-result-overlay').remove()">Close</button>
    </div>`;
  document.body.appendChild(el);
  el.onclick = (e) => { if (e.target === el) el.remove(); };
}

function _spawnCoinRain() {
  for (let i = 0; i < 18; i++) {
    setTimeout(() => {
      const coin = document.createElement('div');
      coin.className = 'pub-coin-particle';
      coin.textContent = '💰';
      coin.style.left = `${20 + Math.random() * 60}vw`;
      coin.style.top  = `${10 + Math.random() * 30}vh`;
      coin.style.animationDelay = `${Math.random() * 0.4}s`;
      document.body.appendChild(coin);
      setTimeout(() => coin.remove(), 1400);
    }, i * 60);
  }
}

// ── Gold helpers ───────────────────────────────────────────────
async function _deductGold(amount) {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || amount <= 0) return;
  try {
    await updateDoc(doc(db, 'characters', _uid), { gold: increment(-amount) });
    const newGold = (_charData?.gold || 0) - amount;
    if (_charData)        { _charData.gold = newGold; }
    if (window._charData) { window._charData.gold = newGold; }
    document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
  } catch(e) { console.warn('[Pub] _deductGold error:', e); }
}

async function _awardGold(uid, amount) {
  if (!uid || amount <= 0) return;
  try {
    await updateDoc(doc(db, 'characters', uid), { gold: increment(amount) });
    if (uid === (_uid || window._uid)) {
      const newGold = ((_charData || window._charData)?.gold || 0) + amount;
      if (_charData)        { _charData.gold = newGold; }
      if (window._charData) { window._charData.gold = newGold; }
      document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
      document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    }
  } catch(e) { console.warn('[Pub] _awardGold error:', e); }
}

// ═══════════════════════════════════════════════════════════════
//  SETTLEMENT DEBUG
// ═══════════════════════════════════════════════════════════════
const _debuggedGameIds = new Set();

async function _pubDebugSettlement(gameId, expectedWinnerUid, pot, myUid) {
  if (_debuggedGameIds.has(gameId)) return;
  _debuggedGameIds.add(gameId);

  const label = `[PubDebug][${gameId.slice(0,8)}]`;
  console.group(`${label} Settlement check — pot: ${pot}g, winner: ${expectedWinnerUid.slice(0,8)}`);
  console.log(`${label} status=complete seen by client at`, new Date().toISOString());

  let goldBefore = null;
  try {
    const snap = await getDoc(doc(db, 'characters', expectedWinnerUid));
    goldBefore = snap.data()?.gold ?? null;
    console.log(`${label} Winner gold RIGHT NOW: ${goldBefore}`);
  } catch(e) { console.warn(`${label} Could not read winner gold:`, e.message); }

  setTimeout(async () => {
    try {
      const [gameSnap, charSnap] = await Promise.all([
        getDoc(doc(db, 'pubGames', gameId)),
        getDoc(doc(db, 'characters', expectedWinnerUid)),
      ]);
      const settled   = gameSnap.data()?.goldSettled;
      const goldAfter = charSnap.data()?.gold ?? null;
      const gained    = goldBefore !== null && goldAfter !== null ? goldAfter - goldBefore : '?';
      console.log(`goldSettled: ${settled}, Winner gold: ${goldBefore} → ${goldAfter} (Δ ${gained >= 0 ? '+':''}${gained})`);
      if (settled && gained === pot) console.log(`%c✅ SETTLEMENT OK`, 'color:green;font-weight:bold');
      else if (!settled) console.warn(`⏳ Trigger hasn't fired yet`);
      console.groupEnd();
    } catch(e) { console.warn(`${label} 3s check error:`, e.message); }
  }, 3000);
}

// ── Map pin support ────────────────────────────────────────────
window._pubLocationAction = function(locationId) {
  const locLower = (locationId || '').toLowerCase();
  const isAtPub  = Object.values(PUB_LOCATIONS).some(p => locLower.includes(p.location.toLowerCase()));
  return isAtPub ? { label: '🍺 Enter the Pub', onclick: 'window._openPubPanel()' } : null;
};

window.PUB_LOCATIONS = PUB_LOCATIONS;