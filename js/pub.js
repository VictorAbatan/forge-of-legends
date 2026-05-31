// ═══════════════════════════════════════════════════════════════
//  THE GOLDEN FLAGON — Pub / Tavern System  (pub.js)
//
//  Games:
//    1. Tavern Dice (D20 number-pick, multiplayer) — LIVE
//    2. Against the House (D6, solo vs Barkeep)    — LIVE
//    3. Highest Roll (D20, multiplayer)             — LIVE
//    4. King's Roll (bracket tournament)            — SKELETON
//    5. Card Clash                                  — SKELETON
//    6. Arm Wrestling                               — SKELETON
//    7. Drinking Contest                            — SKELETON
//    8. Storytelling Competition                    — SKELETON
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
const _fnCreateGame  = httpsCallable(_functions, "createPubGame");
const _fnJoinGame    = httpsCallable(_functions, "joinPubGame");
const _fnRollGame    = httpsCallable(_functions, "rollPubGame");

// ── Module state ───────────────────────────────────────────────
let _uid      = null;
let _charData = null;
let _activeGameUnsub = null;
let _activeGameId    = null;
let _resultsUnsub    = null;
let _lobbyGamesUnsub = null; // real-time LIVE badge listener
let _awardedGameIds  = new Set(); // prevents double-awarding on re-render

// ── Location constants ─────────────────────────────────────────
// Pub exists in each continent's capital city.
const PUB_LOCATIONS = {
  northern: {
    location:    "Frostspire",
    travelId:    "The Frosty Flagon — Frostspire",
    label:       "The Frosty Flagon",
    continent:   "Northern Continent",
    continentId: "frostveil",           // matches CONTINENTS key in map.js
    capitalDest: "Frostspire — Gladys Kingdom",
    capitalCost: 100, capitalTime: 300, // intercontinental travel
  },
  western: {
    location:    "Solmere",
    travelId:    "The Sunken Cask — Solmere",
    label:       "The Sunken Cask",
    continent:   "Western Continent",
    continentId: "verdantis",
    capitalDest: "Solmere — Elaria Kingdom",
    capitalCost: 100, capitalTime: 300,
  },
};

// ── Location helpers ───────────────────────────────────────────
function _isAtPub() {
  const loc = (_charData?.kingdom || _charData?.location || "").toLowerCase();
  return Object.values(PUB_LOCATIONS).some(p => loc.includes(p.label.toLowerCase()));
}
function _isAtCapitalOf(p) {
  const loc = (_charData?.kingdom || _charData?.location || "").toLowerCase();
  return loc.includes(p.location.toLowerCase()) && !loc.includes(p.label.toLowerCase());
}
function _isInContinentOf(p) {
  // Use the stored continent string first — most reliable
  const stored = (_charData?.continent || _charData?.travelContinent || "").toLowerCase();
  if (stored && p.continent.toLowerCase().split(" ")[0]) {
    // e.g. "western continent" includes "western"
    if (stored.includes(p.continent.toLowerCase().split(" ")[0])) return true;
  }
  // Fallback: check location keywords (covers old/edge-case accounts)
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

// ── Barkeep dialogue lines (rotates) ──────────────────────────
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
    id:       "tavern-dice",
    icon:     "🎲",
    name:     "Tavern Dice",
    desc:     "Pick a number on a D20. Closest to the roll wins the pot.",
    tags:     [{ text:"Luck",       cls:"pub-tag-type" }, { text:"2–8 Players", cls:"pub-tag-players" }],
    live:     true,
  },
  {
    id:       "house-mode",
    icon:     "🏠",
    name:     "Against the House",
    desc:     "Roll a D6 against Barkeep Rowan. Win 5× your bet or lose it all.",
    tags:     [{ text:"Solo",       cls:"pub-tag-type" }, { text:"1 Player",    cls:"pub-tag-players" }],
    live:     true,
  },
  {
    id:       "highest-roll",
    icon:     "⚔️",
    name:     "Highest Roll",
    desc:     "Everyone rolls a D20. Highest number takes the whole pot.",
    tags:     [{ text:"Luck",       cls:"pub-tag-type" }, { text:"2–10 Players", cls:"pub-tag-players" }],
    live:     true,
  },
  {
    id:       "kings-roll",
    icon:     "👑",
    name:     "King's Roll",
    desc:     "A bracket tournament. Fight through rounds — last roller standing wins all.",
    tags:     [{ text:"Tournament", cls:"pub-tag-type" }, { text:"4–8 Players",  cls:"pub-tag-players" }, { text:"Coming Soon", cls:"pub-tag-coming" }],
    live:     false,
  },
  {
    id:       "card-clash",
    icon:     "🃏",
    name:     "Card Clash",
    desc:     "Draw 3 cards. Highest total wins. Special cards have effects.",
    tags:     [{ text:"Strategy",   cls:"pub-tag-type" }, { text:"2–6 Players",  cls:"pub-tag-players" }, { text:"Coming Soon", cls:"pub-tag-coming" }],
    live:     false,
  },
  {
    id:       "arm-wrestling",
    icon:     "💪",
    name:     "Arm Wrestling",
    desc:     "STR-based combat. Push, Hold, or Burst. Your build matters.",
    tags:     [{ text:"Strength",   cls:"pub-tag-type" }, { text:"2 Players",    cls:"pub-tag-players" }, { text:"Coming Soon", cls:"pub-tag-coming" }],
    live:     false,
  },
  {
    id:       "drinking-contest",
    icon:     "🍺",
    name:     "Drinking Contest",
    desc:     "Last player standing wins. Each round tests your HP. Buffs and debuffs await.",
    tags:     [{ text:"CON / HP",   cls:"pub-tag-type" }, { text:"2–8 Players",  cls:"pub-tag-players" }, { text:"Coming Soon", cls:"pub-tag-coming" }],
    live:     false,
  },
  {
    id:       "storytelling",
    icon:     "📖",
    name:     "Storytelling Competition",
    desc:     "Tell a tale, sing a song, spin a joke. The crowd decides the winner.",
    tags:     [{ text:"Social",     cls:"pub-tag-type" }, { text:"Any Players",  cls:"pub-tag-players" }, { text:"Coming Soon", cls:"pub-tag-coming" }],
    live:     false,
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
window.initPubSystem      = initPubSystem;
window.updatePubCharData  = updatePubCharData;

// ── Open pub panel ─────────────────────────────────────────────
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

  // Gate: must be at a pub location (travelled inside the pub)
  if (!_isAtPub()) {
    _renderPubGate(panel);
    return;
  }

  const pub = _getCurrentPub();
  _renderPubMain(panel, pub);
};

// ── Gate view ─────────────────────────────────────────────────
function _renderPubGate(panel) {
  const cards = Object.values(PUB_LOCATIONS).map(p => {
    const atCapital   = _isAtCapitalOf(p);
    const inContinent = _isInContinentOf(p);

    let statusHtml, actionHtml;

    if (atCapital) {
      // Best case — at the right capital, one short trip away
      statusHtml = `<div class="pub-gate-status ready">✓ You are in ${p.location}</div>`;
      actionHtml = `<button class="pub-gate-action-btn" onclick="window._pubTravelTo('${p.travelId}','${p.continent}')">
        ENTER PUB — 10 💰 · 1 min
      </button>`;
    } else if (inContinent) {
      // Same continent, not at capital yet
      statusHtml = `<div class="pub-gate-status near">📍 You are in the ${p.continent}</div>`;
      actionHtml = `<div class="pub-gate-hint">Travel to ${p.location} first, then visit the pub.</div>
        <button class="pub-gate-action-btn secondary" onclick="window.openTravelModal?.('${p.capitalDest}','${p.continent}',${p.capitalCost},${p.capitalTime})">
          GO TO ${p.location.toUpperCase()} — ${p.capitalCost} 💰 · 5m
        </button>`;
    } else {
      // Different continent entirely
      statusHtml = `<div class="pub-gate-status far">🌍 ${p.continent}</div>`;
      actionHtml = `<div class="pub-gate-hint">Travel to the ${p.continent} first, then find ${p.location}.</div>
        <button class="pub-gate-action-btn secondary" onclick="window.openTravelModal?.('${p.capitalDest}','${p.continent}',${p.capitalCost},${p.capitalTime})">
          TRAVEL THERE — ${p.capitalCost} 💰 · 5m
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
      <div class="pub-gate-desc">
        The pub is only open to those who've made the journey.
        Find your nearest tavern in a capital city.
      </div>
      <div class="pub-gate-locations">${cards}</div>
    </div>`;
}

// ── Travel shortcut (from map pin → openTravelModal) ─────────
window._pubTravelTo = function(travelId, continent) {
  if (typeof window.openTravelModal === 'function') {
    window.openTravelModal(travelId, continent, 10, 60);
  } else if (typeof window._startTravel === 'function') {
    window._startTravel({ dest: travelId, continent, cost: 10, seconds: 60 });
    if (typeof window.switchPanel === 'function') window.switchPanel('map');
  } else {
    window.showToast?.('Open the World Map to travel.', '');
  }
};

// ── Main pub view ─────────────────────────────────────────────
function _renderPubMain(panel, pub) {
  const quote = BARKEEP_LINES[Math.floor(Date.now() / 60000) % BARKEEP_LINES.length];

  panel.innerHTML = `
    <div id="pub-lobby" class="pub-lobby">
      <!-- Header -->
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

      <!-- Barkeep dialogue -->
      <div class="pub-barkeep-dialogue">
        <div class="barkeep-face">🧔</div>
        <div class="pub-barkeep-quote">
          <strong>Barkeep Rowan</strong><br>
          "${quote}"
        </div>
      </div>

      <!-- Game tables grid -->
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

      <!-- Recent results feed -->
      <div class="pub-results-feed" id="pub-results-feed">
        <h4>Recent Results</h4>
        <div id="pub-results-list"><div class="pub-result-empty">No games played yet tonight.</div></div>
      </div>
    </div>

    <!-- Game views — rendered on demand -->
    <div id="pub-game-container"></div>`;

  _listenForRecentResults();
  _checkLiveGames();
}

// ── Recent results listener ────────────────────────────────────
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
  return { 'tavern-dice':'🎲', 'house-mode':'🏠', 'highest-roll':'⚔️', 'kings-roll':'👑', 'card-clash':'🃏' }[type] || '🎲';
}
function _timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

// ── Watch active games in real-time (show/hide LIVE badge instantly) ──
function _checkLiveGames() {
  if (_lobbyGamesUnsub) { _lobbyGamesUnsub(); _lobbyGamesUnsub = null; }

  const pub = _getCurrentPub();
  if (!pub) return;

  // Match by pubLocation — uses existing index (status ASC, pubLocation ASC)
  const q = query(
    collection(db, 'pubGames'),
    where('status',      '==', 'open'),
    where('pubLocation', '==', pub.location),
    limit(10)
  );

  _lobbyGamesUnsub = onSnapshot(q, snap => {
    // Reset all badge states first
    document.querySelectorAll('.pub-table-status').forEach(el => {
      const card = el.closest('.pub-table-card');
      if (card && !card.classList.contains('locked')) {
        el.textContent = 'OPEN';
        el.classList.remove('active-game');
      }
    });
    // Stamp LIVE on each open game
    snap.docs.forEach(d => {
      const g = d.data();
      const card = document.querySelector(`.pub-table-card[onclick*="${g.gameType}"] .pub-table-status`);
      if (card) { card.textContent = 'LIVE'; card.classList.add('active-game'); }
    });
  }, () => {});
}

// ── Open a game ───────────────────────────────────────────────
window._openPubGame = function(gameId) {
  const game = PUB_GAMES.find(g => g.id === gameId);
  if (!game) return;

  if (!game.live) { window.showToast?.('Coming soon!', ''); return; }

  document.getElementById('pub-lobby').style.display = 'none';

  const container = document.getElementById('pub-game-container');
  container.innerHTML = '';

  if (gameId === 'tavern-dice')  { _buildTavernDiceView(container); _tdWatchOpenTable(); }
  else if (gameId === 'house-mode')   _buildHouseModeView(container);
  else if (gameId === 'highest-roll') { _buildHighestRollView(container); _hrWatchOpenTable(); }
  else                                _buildComingSoonView(container, game);
};

// ── Back to lobby ─────────────────────────────────────────────
function _backToLobby() {
  if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
  if (_tdTableUnsub)    { _tdTableUnsub();    _tdTableUnsub = null; }
  if (_hrTableUnsub)    { _hrTableUnsub();    _hrTableUnsub = null; }
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

      <!-- Number picker -->
      <div class="pub-dice-arena">
        <div class="pub-number-grid" id="td-number-grid">
          ${Array.from({length:20},(_,i)=>`
            <button class="pub-num-btn" data-n="${i+1}" onclick="window._tdPickNumber(${i+1})">${i+1}</button>`
          ).join('')}
        </div>

        <!-- Dice -->
        <div class="pub-dice-wrap">
          <div class="pub-dice-face" id="td-dice-face">🎲</div>
          <div class="pub-dice-idle-hint" id="td-dice-hint">Waiting for roll...</div>
        </div>

        <!-- Bet row -->
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

      <!-- Game info -->
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

// ── Bet locking helpers ──────────────────────────────────────────────────
// Called when a table is already open: forces the bet input and presets
// to the host's amount so joiners can't accidentally stake a different sum.
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
    b._savedOnclick = b.onclick;  // stash so unlock can restore it
    b.onclick       = null;       // kill click entirely while locked
    b.title         = isMatch
      ? `Table stake: ${amount} 💰`
      : `Stake is fixed at ${amount} 💰`;
  });
  // Show a note under the bet row if not already there
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

// ── Live table watcher — dims Create btn, shows Join btn in real-time ──
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
    if (!createBtn) return; // view not mounted
    const hasOpenTable = !snap.empty;
    const amSeated     = snap.docs.some(d => d.data().players?.some(p => p.uid === (_uid || window._uid)));
    if (amSeated) {
      // Already in a game — handled by _tdSubscribeGame; don't touch buttons here
      return;
    }
    if (hasOpenTable) {
      const hostBet = snap.docs[0].data().tableStake || snap.docs[0].data().players?.[0]?.bet || 100;
      createBtn.disabled = true;
      createBtn.style.opacity = '0.4';
      createBtn.title = 'A table is already open — join it!';
      joinBtn.style.display = '';
      // Lock the bet row to the host's stake amount
      _tdLockBetToHost(hostBet);
    } else {
      createBtn.disabled = false;
      createBtn.style.opacity = '';
      createBtn.title = '';
      joinBtn.style.display = 'none';
      // Restore free bet selection when no table is open
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
    // Reflect server deduction locally
    const newGold = Math.max(0, (_charData.gold || 0) - bet);
    if (_charData)        _charData.gold = newGold;
    if (window._charData) window._charData.gold = newGold;
    document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    window.showToast?.(`Table opened! You picked ${_tdPickedNumber}. Waiting for others...`, 'success');
    _tdSubscribeGame(_activeGameId);
  } catch(e) {
    const code = e?.code || '';
    const msg  = e?.message || e?.details || '';
    if (code === 'already-exists' || msg.includes('already open'))
      window.showToast?.('A table is already open — join it instead!', '');
    else if (msg.includes('enough gold'))
      window.showToast?.(msg, 'error');
    else { console.warn('[Pub] tdCreate error:', e); window.showToast?.('Failed to open table. Try again.', 'error'); }
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

  // Get the game id from the current watcher snapshot (fastest path)
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

  if (!gameId) {
    window.showToast?.('No open table found. Open one yourself!', '');
    btn.disabled = false;
    return;
  }

  // Enforce the host's bet — lock UI in case it wasn't already locked
  const hostBet = probe.docs[0].data().tableStake || probe.docs[0].data().players?.[0]?.bet || 100;
  _tdLockBetToHost(hostBet);

  try {
    const result = await _fnJoinGame({
      gameId,
      pick:       _tdPickedNumber,
      playerName: _charData.name || 'Unknown',
    });
    _activeGameId = gameId;
    const bet     = result.data.bet;
    // Reflect server deduction locally
    const newGold = Math.max(0, (_charData.gold || 0) - bet);
    if (_charData)        _charData.gold = newGold;
    if (window._charData) window._charData.gold = newGold;
    document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    window.showToast?.(`Joined the table! Stake: ${bet} 💰. You picked ${_tdPickedNumber}.`, 'success');
    _tdSubscribeGame(_activeGameId);
  } catch(e) {
    const code = e?.code || '';
    const msg  = e?.message || e?.details || '';
    if (code === 'already-exists' || msg.includes('Already seated'))
      window.showToast?.('Already seated!', '');
    else if (msg.includes('number is already taken'))
      window.showToast?.('That number is taken! Pick another.', 'error');
    else if (msg.includes('enough gold'))
      window.showToast?.(msg, 'error');
    else if (msg.includes('full'))
      window.showToast?.('Table is full!', '');
    else if (msg.includes('no longer open') || msg.includes('not-found'))
      window.showToast?.('Table closed — try opening a new one.', '');
    else { console.warn('[Pub] tdJoin error:', e); window.showToast?.('Failed to join. Try again.', 'error'); }
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

  // Seats
  if (seatsEl) {
    seatsEl.innerHTML = game.players.map(p => `
      <div class="pub-seat${p.uid === _uid ? ' is-me' : ''}${game.winnerUid === p.uid ? ' winner' : ''}">
        <span class="pub-seat-name">${p.uid === _uid ? '⭐ You' : p.name}</span>
        <span class="pub-seat-pick">picked ${p.pick}</span>
        <span class="pub-seat-bet">${p.bet} 💰</span>
      </div>`).join('');
  }

  // Mark taken numbers
  document.querySelectorAll('.pub-num-btn').forEach(b => {
    const taken = game.players.some(p => p.pick === +b.dataset.n && p.uid !== _uid);
    b.classList.toggle('taken', taken);
    b.classList.toggle('disabled', game.status !== 'open');
  });

  if (game.status === 'open') {
    // Once seated, hide both entry buttons; watcher handles them for non-seated players
    if (amPlaying) {
      if (createBtn) { createBtn.style.display = 'none'; }
      if (joinBtn)   { joinBtn.style.display   = 'none'; }
    }
    if (rollBtn)  rollBtn.style.display  = (isHost && amPlaying && game.players.length >= 2) ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = amPlaying ? '' : 'none';
    if (statusEl) statusEl.textContent   = amPlaying
      ? (isHost ? `You're the host — roll when ready!` : `Waiting for the host to roll...`)
      : `${game.players.length} player${game.players.length !== 1 ? 's' : ''} seated. Join them!`;
    if (statusEl) statusEl.className = 'pub-status-bar';
  }

  if (game.status === 'rolling') {
    if (createBtn) createBtn.style.display = 'none';
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

    // Highlight winning number
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

    if (didWin) {
      _spawnCoinRain();
      // Log activity once — gold awarded by settlePubGame cloud function
      if (!_awardedGameIds.has(gameId)) {
        _awardedGameIds.add(gameId);
        window.logActivity?.('🎲', `<b>Pub Win!</b> Tavern Dice — Won <b>${game.prize}</b> 💰.`, '#4ec878');
      }
    }

    // Verify cloud settlement landed (check console for results)
    if (amPlaying) _pubDebugSettlement(gameId, game.winnerUid, game.prize, _uid);

    // Show result overlay
    if (amPlaying) {
      const myBet = game.players.find(p => p.uid === _uid)?.bet || 0;
      setTimeout(() => _showResultOverlay(didWin, game.rollResult, game.winnerName, game.prize, didWin ? game.prize : myBet), 800);
    }

    // Clean up sub after 5s
    setTimeout(() => {
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

// Roll execution handled server-side by rollPubGame cloud function

window._tdLeaveGame = async function() {
  if (!_activeGameId || !_uid) return;
  try {
    const snap = await getDoc(doc(db,'pubGames',_activeGameId));
    if (!snap.exists()) return;
    const game    = snap.data();
    const myEntry = game.players.find(p => p.uid === _uid);
    if (!myEntry) return;

    const newPlayers = game.players.filter(p => p.uid !== _uid);
    if (newPlayers.length === 0) {
      await deleteDoc(doc(db,'pubGames',_activeGameId));
    } else {
      await updateDoc(doc(db,'pubGames',_activeGameId), {
        players: newPlayers,
        pot:     (game.pot || 0) - (myEntry.bet || 0),
        hostUid: newPlayers[0].uid, // pass host if you were it
      });
    }
    // Refund bet
    await _awardGold(_uid, myEntry.bet || 0);
    window.showToast?.('Left the table. Bet refunded.', '');
    if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
    _activeGameId = null;
    _backToLobby();
  } catch(e) { window.showToast?.('Failed to leave.', 'error'); }
};

function _tdAnimateDice(result) {
  const face = document.getElementById('td-dice-face');
  if (!face) return;
  face.classList.remove('rolling','result-flash');
  void face.offsetWidth; // reflow
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
const HOUSE_MULTIPLIER = 5; // win 5× your bet

function _buildHouseModeView(container) {
  container.innerHTML = `
    <div class="pub-game-view active" id="game-house-mode">
      <button class="pub-game-back-btn" onclick="window._pubBackToLobby()">← Back to Lobby</button>
      <div class="pub-game-header">
        <h3>🏠 Against the House</h3>
        <p>Pick a face on the D6 and wager your coins. Barkeep Rowan rolls for the house. Win and take 5×!</p>
      </div>

      <div class="pub-house-setup">
        <!-- VS header -->
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

        <!-- D6 face picker -->
        <div>
          <div style="font-family:var(--font-mono);font-size:0.6rem;letter-spacing:0.12em;color:var(--text-dim);text-align:center;margin-bottom:10px;text-transform:uppercase">Pick Your Face</div>
          <div class="pub-d6-grid" id="hm-d6-grid">
            ${[1,2,3,4,5,6].map(n => `
              <div class="pub-d6-btn" data-face="${n}" onclick="window._hmPickFace(${n})">
                <div class="pub-d6-dots">${Array(9).fill(0).map((_,i)=>`<div class="pub-d6-dot"></div>`).join('')}</div>
              </div>`).join('')}
          </div>
        </div>

        <!-- Bet -->
        <div class="pub-bet-row">
          <span class="pub-bet-label">Wager</span>
          <div class="pub-bet-presets">
            ${[50,100,250,500].map(v=>`<button class="pub-bet-preset" onclick="window._hmSetBet(${v})">${v}</button>`).join('')}
          </div>
          <input class="pub-bet-input" id="hm-bet-input" type="number" min="1" placeholder="Custom" value="100"/>
        </div>

        <!-- Dice display -->
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
  if (bet < 1)                     { window.showToast?.('Enter a valid bet.', ''); return; }
  if ((_charData.gold || 0) < bet) { window.showToast?.(`Not enough gold. You have ${_charData.gold||0}.`, 'error'); return; }

  const btn = document.getElementById('hm-roll-btn');
  btn.disabled = true;

  // Deduct bet immediately
  await _deductGold(bet);

  // Animate both dice
  const yourDice  = document.getElementById('hm-your-dice');
  const houseDice = document.getElementById('hm-house-dice');
  const statusEl  = document.getElementById('hm-status');

  [yourDice, houseDice].forEach(d => { d.textContent = '🎲'; d.classList.remove('rolling','result-flash'); void d.offsetWidth; d.classList.add('rolling'); });
  if (statusEl) { statusEl.textContent = '🎲 Rolling...'; statusEl.className = 'pub-status-bar roll'; }

  setTimeout(async () => {
    const playerRoll = Math.floor(Math.random() * 6) + 1;
    const houseRoll  = Math.floor(Math.random() * 6) + 1;
    const won        = playerRoll === _hmPicked; // exact match on D6 wins

    yourDice.classList.remove('rolling');  yourDice.textContent  = playerRoll; yourDice.classList.add('result-flash');
    houseDice.classList.remove('rolling'); houseDice.textContent = houseRoll;  houseDice.classList.add('result-flash');

    if (won) {
      const prize = bet * HOUSE_MULTIPLIER;
      await _awardGold(_uid, prize);
      if (statusEl) { statusEl.textContent = `🎉 You matched! Rowan pays out ${prize} 💰!`; statusEl.className = 'pub-status-bar win'; }
      _spawnCoinRain();
      _showResultOverlay(true, playerRoll, 'You', prize, prize);
      window.logActivity?.('🎲', `<b>Pub Win!</b> Against the House — Rolled <b>${playerRoll}</b>, won <b>${prize}</b> 💰.`, '#4ec878');
    } else {
      if (statusEl) { statusEl.textContent = `You picked ${_hmPicked}, rolled ${playerRoll}. Rowan keeps your ${bet} 💰.`; statusEl.className = 'pub-status-bar loss'; }
      _showResultOverlay(false, playerRoll, 'Rowan', bet, 0);
      window.logActivity?.('🎲', `<b>Pub Loss.</b> Against the House — Rolled <b>${playerRoll}</b>, lost <b>${bet}</b> 💰.`, '#e05555');
    }

    // Log to Firestore results
    try {
      await addDoc(collection(db,'pubGames'), {
        gameType:    'house-mode',
        status:      'complete',
        hostUid:     _uid,
        players:     [{ uid: _uid, name: _charData.name || 'Unknown', pick: _hmPicked, bet }],
        pot:         bet,
        rollResult:  playerRoll,
        winnerUid:   won ? _uid : 'house',
        winnerName:  won ? (_charData.name || 'Unknown') : 'Barkeep Rowan',
        prize:       won ? bet * HOUSE_MULTIPLIER : 0,
        completedAt: serverTimestamp(),
        createdAt:   serverTimestamp(),
      });
    } catch(_) {}

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

// ── Bet locking helpers for Highest Roll ─────────────────────────────────────
// Mirrors _tdLockBetToHost / _tdUnlockBet — locks the bet row to the
// host's stake so joiners can't accidentally enter a different amount.
function _hrLockBetToHost(amount) {
  const input = document.getElementById('hr-bet-input');
  if (!input) return;
  input.value    = amount;
  input.disabled = true;
  input.title    = `Stake is fixed at ${amount} 💰 (set by the host)`;
  document.querySelectorAll('#game-highest-roll .pub-bet-preset').forEach(b => {
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

function _hrUnlockBet() {
  const input = document.getElementById('hr-bet-input');
  if (!input) return;
  input.disabled = false;
  input.title    = '';
  document.querySelectorAll('#game-highest-roll .pub-bet-preset').forEach(b => {
    b.classList.remove('disabled');
    b.disabled = false;
    b.title    = '';
    if (b._savedOnclick !== undefined) {
      b.onclick       = b._savedOnclick;
      b._savedOnclick = undefined;
    }
  });
  document.querySelector('#game-highest-roll .pub-bet-locked-note')?.remove();
}

// ── Live table watcher for Highest Roll ──
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
      createBtn.title = 'A table is already open — join it!';
      joinBtn.style.display = '';
      _hrLockBetToHost(hostBet);
    } else {
      createBtn.disabled = false;
      createBtn.style.opacity = '';
      createBtn.title = '';
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
    _hrSubscribeGame(_activeGameId);
  } catch(e) {
    const code = e?.code || '';
    const msg  = e?.message || e?.details || '';
    if (code === 'already-exists' || msg.includes('already open'))
      window.showToast?.('A table is already open — join it instead!', '');
    else if (msg.includes('enough gold'))
      window.showToast?.(msg, 'error');
    else { console.warn('[Pub] hrCreate error:', e); window.showToast?.('Failed to open table. Try again.', 'error'); }
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
  if (statusEl) { statusEl.textContent = '⏳ Joining table...'; statusEl.className = 'pub-status-bar roll'; }

  const pub   = _getCurrentPub();
  const probe = await getDocs(query(
    collection(db,'pubGames'),
    where('gameType',   '==','highest-roll'),
    where('status',     '==','open'),
    where('pubLocation','==', pub?.location || 'unknown'),
    limit(1)
  ));
  if (probe.empty) {
    window.showToast?.('No open table found. Open one yourself!', '');
    btn.disabled = false;
    return;
  }
  const gameId  = probe.docs[0].id;
  // Enforce the host's bet — lock UI in case it wasn't already locked
  const hostBet = probe.docs[0].data().tableStake || probe.docs[0].data().players?.[0]?.bet || 100;
  _hrLockBetToHost(hostBet);

  try {
    const result = await _fnJoinGame({
      gameId,
      playerName: _charData.name || 'Unknown',
    });
    _activeGameId = gameId;
    const bet     = result.data.bet;
    const newGold = Math.max(0, (_charData.gold || 0) - bet);
    if (_charData)        _charData.gold = newGold;
    if (window._charData) window._charData.gold = newGold;
    document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    window.showToast?.(`Joined the table! Stake: ${bet} 💰.`, 'success');
    _hrSubscribeGame(_activeGameId);
  } catch(e) {
    const code = e?.code || '';
    const msg  = e?.message || e?.details || '';
    if (code === 'already-exists' || msg.includes('Already seated'))
      window.showToast?.('Already seated!', '');
    else if (msg.includes('enough gold'))
      window.showToast?.(msg, 'error');
    else if (msg.includes('full'))
      window.showToast?.('Table is full!', '');
    else if (msg.includes('no longer open') || msg.includes('not-found'))
      window.showToast?.('Table closed — try opening a new one.', '');
    else { console.warn('[Pub] hrJoin error:', e); window.showToast?.('Failed to join. Try again.', 'error'); }
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
  const joinBtn   = document.getElementById('hr-join-btn');
  const createBtn = document.getElementById('hr-create-btn');
  const rollBtn   = document.getElementById('hr-roll-btn');
  const leaveBtn  = document.getElementById('hr-leave-btn');
  if (!potEl) return;

  const isHost    = game.hostUid === _uid;
  const amPlaying = game.players.some(p => p.uid === _uid);

  if (potEl)  potEl.textContent  = (game.pot || 0).toLocaleString();
  if (potSub) potSub.textContent = `${game.players.length} player${game.players.length !== 1 ? 's' : ''} seated`;

  if (seatsEl) {
    seatsEl.innerHTML = game.players.map(p => `
      <div class="pub-seat${p.uid === _uid ? ' is-me' : ''}${game.winnerUid === p.uid ? ' winner' : ''}">
        <span class="pub-seat-name">${p.uid === _uid ? '⭐ You' : p.name}</span>
        ${p.roll !== null ? `<span class="pub-seat-pick">rolled ${p.roll}</span>` : ''}
        <span class="pub-seat-bet">${p.bet} 💰</span>
      </div>`).join('');
  }

  if (game.status === 'open') {
    if (amPlaying) {
      if (createBtn) createBtn.style.display = 'none';
      if (joinBtn)   joinBtn.style.display   = 'none';
    }
    if (rollBtn)  rollBtn.style.display  = (isHost && amPlaying && game.players.length >= 2) ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = amPlaying ? '' : 'none';
    if (statusEl) statusEl.textContent   = amPlaying
      ? (isHost ? 'You host — roll when everyone is seated!' : 'Waiting for host to roll...')
      : 'Table open. Join to compete!';
    if (statusEl) statusEl.className = 'pub-status-bar';
  }

  if (game.status === 'rolling') {
    if (createBtn) createBtn.style.display = 'none';
    if (joinBtn)   joinBtn.style.display   = 'none';
    if (rollBtn)   rollBtn.style.display   = 'none';
    if (leaveBtn)  leaveBtn.style.display  = 'none';
    const face = document.getElementById('hr-dice-face');
    if (face) { face.textContent = '🎲'; face.classList.remove('rolling','result-flash'); void face.offsetWidth; face.classList.add('rolling'); }
    if (statusEl) { statusEl.textContent = '🎲 Rolling for everyone...'; statusEl.className = 'pub-status-bar roll'; }
  }

  if (game.status === 'complete') {
    if (createBtn) createBtn.style.display = 'none';
    if (joinBtn)   joinBtn.style.display   = 'none';
    if (rollBtn)   rollBtn.style.display   = 'none';
    if (leaveBtn)  leaveBtn.style.display  = 'none';
    const face = document.getElementById('hr-dice-face');
    if (face) { face.classList.remove('rolling','result-flash'); face.textContent = game.rollResult; void face.offsetWidth; face.classList.add('result-flash'); }

    const didWin = game.winnerUid === _uid;
    if (statusEl) {
      statusEl.textContent = didWin
        ? `🎉 You rolled highest (${game.rollResult})! +${game.prize} 💰`
        : `${game.winnerName} rolled ${game.rollResult} and wins ${game.prize} 💰!`;
      statusEl.className = `pub-status-bar ${didWin ? 'win' : 'loss'}`;
    }
    if (didWin) {
      _spawnCoinRain();
      // Log activity once — gold awarded by settlePubGame cloud function
      if (!_awardedGameIds.has(gameId)) {
        _awardedGameIds.add(gameId);
        window.logActivity?.('🎲', `<b>Pub Win!</b> Highest Roll — Rolled <b>${game.rollResult}</b>, won <b>${game.prize}</b> 💰.`, '#4ec878');
      }
    }
    // Verify cloud settlement landed (check console for results)
    if (amPlaying) _pubDebugSettlement(gameId, game.winnerUid, game.prize, _uid);
    if (amPlaying) {
      const myBet = game.players.find(p => p.uid === _uid)?.bet || 0;
      setTimeout(() => _showResultOverlay(didWin, game.rollResult, game.winnerName, game.prize, didWin ? game.prize : myBet), 800);
    }
    setTimeout(() => { if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; } _activeGameId = null; }, 5000);
  }
}

window._hrCallRoll = async function() {
  if (!_activeGameId) return;
  const btn = document.getElementById('hr-roll-btn');
  if (btn) btn.disabled = true;

  const face = document.getElementById('hr-dice-face');
  if (face) { face.textContent = '🎲'; face.classList.remove('rolling','result-flash'); void face.offsetWidth; face.classList.add('rolling'); }
  const statusEl = document.getElementById('hr-status');
  if (statusEl) { statusEl.textContent = '🎲 Rolling for everyone...'; statusEl.className = 'pub-status-bar roll'; }

  try {
    await _fnRollGame({ gameId: _activeGameId });
  } catch(e) {
    console.warn('[Pub] hrCallRoll error:', e);
    window.showToast?.('Roll failed. Try again.', 'error');
    if (btn) btn.disabled = false;
  }
};

// Roll execution handled server-side by rollPubGame cloud function

window._hrLeaveGame = async function() {
  if (!_activeGameId || !_uid) return;
  try {
    const snap  = await getDoc(doc(db,'pubGames',_activeGameId));
    if (!snap.exists()) return;
    const game    = snap.data();
    const myEntry = game.players.find(p => p.uid === _uid);
    if (!myEntry) return;
    const newPlayers = game.players.filter(p => p.uid !== _uid);
    if (newPlayers.length === 0) { await deleteDoc(doc(db,'pubGames',_activeGameId)); }
    else { await updateDoc(doc(db,'pubGames',_activeGameId), { players: newPlayers, pot: (game.pot||0) - (myEntry.bet||0), hostUid: newPlayers[0].uid }); }
    await _awardGold(_uid, myEntry.bet || 0);
    window.showToast?.('Left the table. Bet refunded.', '');
    if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
    _activeGameId = null;
    _backToLobby();
  } catch(e) { window.showToast?.('Failed to leave.', 'error'); }
};

// ═══════════════════════════════════════════════════════════════
//  COMING SOON SKELETON VIEW
// ═══════════════════════════════════════════════════════════════
function _buildComingSoonView(container, game) {
  container.innerHTML = `
    <div class="pub-coming-soon-view active">
      <button class="pub-game-back-btn" onclick="window._pubBackToLobby()">← Back to Lobby</button>
      <div class="pub-cs-icon">${game.icon}</div>
      <div class="pub-cs-title">${game.name}</div>
      <div class="pub-cs-desc">${game.desc}</div>
      <div class="pub-cs-badge">Coming Soon</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  SETTLEMENT DEBUG
//  Called when a multiplayer game reaches 'complete'.
//  Guarded by _debuggedGameIds so it only runs ONCE per game —
//  the onSnapshot fires twice (once on complete, again when
//  goldSettled flips), and the second call would see Δ+0 and
//  falsely report a mismatch.
// ═══════════════════════════════════════════════════════════════
const _debuggedGameIds = new Set();

async function _pubDebugSettlement(gameId, expectedWinnerUid, pot, myUid) {
  if (_debuggedGameIds.has(gameId)) return; // already running for this game
  _debuggedGameIds.add(gameId);

  const label = `[PubDebug][${gameId.slice(0,8)}]`;
  console.group(`${label} Settlement check — pot: ${pot}g, winner: ${expectedWinnerUid.slice(0,8)}`);
  console.log(`${label} status=complete seen by client at`, new Date().toISOString());

  let goldBefore = null;
  try {
    const snap = await getDoc(doc(db, 'characters', expectedWinnerUid));
    goldBefore = snap.data()?.gold ?? null;
    console.log(`${label} Winner gold RIGHT NOW (pre-settlement): ${goldBefore}`);
  } catch(e) {
    console.warn(`${label} Could not read winner gold pre-settlement:`, e.message);
  }

  // 3s check — trigger should have fired by now
  setTimeout(async () => {
    try {
      const [gameSnap, charSnap] = await Promise.all([
        getDoc(doc(db, 'pubGames', gameId)),
        getDoc(doc(db, 'characters', expectedWinnerUid)),
      ]);
      const settled   = gameSnap.data()?.goldSettled;
      const goldAfter = charSnap.data()?.gold ?? null;
      const gained    = goldBefore !== null && goldAfter !== null ? goldAfter - goldBefore : '?';

      console.group(`${label} 3s check`);
      console.log(`goldSettled: ${settled}  →  ${settled ? '✅ trigger fired' : '❌ trigger NOT fired yet'}`);
      console.log(`Winner gold: ${goldBefore} → ${goldAfter}  (Δ ${gained >= 0 ? '+' : ''}${gained})`);
      if (settled && gained === pot) {
        console.log(`%c✅ SETTLEMENT OK — winner received full pot (${pot}g)`, 'color:green;font-weight:bold');
      } else if (settled && gained !== pot) {
        console.warn(`⚠️ Trigger fired but gold delta (${gained}) ≠ pot (${pot}). Possible race overwrite still present.`);
      } else {
        console.warn(`⏳ Trigger hasn't fired yet — will recheck at 8s`);
      }
      if (myUid && myUid !== expectedWinnerUid) {
        const mySnap = await getDoc(doc(db, 'characters', myUid));
        console.log(`My gold (loser): ${mySnap.data()?.gold}`);
      }
      console.groupEnd();
    } catch(e) { console.warn(`${label} 3s check error:`, e.message); }
  }, 3000);

  // 8s check — final verdict
  setTimeout(async () => {
    try {
      const [gameSnap, charSnap] = await Promise.all([
        getDoc(doc(db, 'pubGames', gameId)),
        getDoc(doc(db, 'characters', expectedWinnerUid)),
      ]);
      const settled   = gameSnap.data()?.goldSettled;
      const goldFinal = charSnap.data()?.gold ?? null;
      const gained    = goldBefore !== null && goldFinal !== null ? goldFinal - goldBefore : '?';

      console.group(`${label} 8s final check`);
      console.log(`goldSettled: ${settled}`);
      console.log(`Winner gold: ${goldBefore} → ${goldFinal}  (Δ ${gained >= 0 ? '+' : ''}${gained})`);
      if (!settled) {
        console.error(`%c❌ settlePubGame trigger NEVER fired. Check Firebase Functions are deployed and active.`, 'color:red;font-weight:bold');
      } else if (gained === pot) {
        console.log(`%c✅ CONFIRMED — full pot settled correctly`, 'color:green;font-weight:bold');
      } else {
        console.error(`%c❌ Gold mismatch after 8s: winner gained ${gained}g but pot was ${pot}g.`, 'color:red;font-weight:bold');
      }
      console.groupEnd();
    } catch(e) { console.warn(`${label} 8s check error:`, e.message); }

    console.groupEnd(); // close outer group
  }, 8000);
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
          ? `The dice landed on <strong>${roll}</strong>. You take the pot!`
          : `<strong>${winnerName}</strong> wins with ${roll}!`}
      </div>
      <div class="pub-result-coins ${won ? '' : 'loss-coins'}">
        ${won ? `+${myPrize} 💰` : `-${myPrize} 💰`}
      </div>
      <button class="pub-btn-roll" onclick="document.getElementById('pub-result-overlay').remove()">
        Close
      </button>
    </div>`;
  document.body.appendChild(el);
  el.onclick = (e) => { if (e.target === el) el.remove(); };
}

// ═══════════════════════════════════════════════════════════════
//  COIN RAIN (WIN ANIMATION)
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
//  FIRESTORE GOLD HELPERS
//  Each client can only write their own character doc.
// ═══════════════════════════════════════════════════════════════
async function _deductGold(amount) {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || amount <= 0) return;
  try {
    await updateDoc(doc(db, 'characters', _uid), { gold: increment(-amount) });
    const newGold = Math.max(0, (_charData?.gold || 0) - amount);
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
      const newGold = (_charData?.gold || 0) + amount;
      if (_charData)        { _charData.gold = newGold; }
      if (window._charData) { window._charData.gold = newGold; }
      document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = newGold);
      document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = newGold);
    }
  } catch(e) { console.warn('[Pub] _awardGold error:', e); }
}

// ── Map pin support ────────────────────────────────────────────
// Called by map.js when the pub location pin is clicked.
// Shows a "Enter Pub" action in the location toolkit.
window._pubLocationAction = function(locationId) {
  const locLower = (locationId || '').toLowerCase();
  const isAtPub  = Object.values(PUB_LOCATIONS).some(p => locLower.includes(p.location.toLowerCase()));
  return isAtPub ? {
    label:   '🍺 Enter the Pub',
    onclick: 'window._openPubPanel()',
  } : null;
};

// ── Expose PUB_LOCATIONS for map.js ──────────────────────────
window.PUB_LOCATIONS = PUB_LOCATIONS;