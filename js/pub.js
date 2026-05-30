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
  serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Module state ───────────────────────────────────────────────
let _uid      = null;
let _charData = null;
let _activeGameUnsub = null;
let _activeGameId    = null;
let _resultsUnsub    = null;

// ── Location constants ─────────────────────────────────────────
// Pub exists in each continent's capital city.
const PUB_LOCATIONS = {
  northern: { location: "Frostspire",          label: "The Frosty Flagon",    continent: "Northern Continent" },
  western:  { location: "Solmere",             label: "The Sunken Cask",      continent: "Western Continent"  },
};

// Helper: is the player currently at a pub location?
function _isAtPub() {
  const loc = (_charData?.kingdom || _charData?.location || "").toLowerCase();
  return Object.values(PUB_LOCATIONS).some(p => loc.includes(p.location.toLowerCase()));
}
function _getCurrentPub() {
  const loc = (_charData?.kingdom || _charData?.location || "").toLowerCase();
  return Object.values(PUB_LOCATIONS).find(p => loc.includes(p.location.toLowerCase())) || null;
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

  // Gate: must be at a pub location
  if (!_isAtPub()) {
    _renderPubGate(panel);
    return;
  }

  const pub = _getCurrentPub();
  _renderPubMain(panel, pub);
};

// ── Gate view ─────────────────────────────────────────────────
function _renderPubGate(panel) {
  panel.innerHTML = `
    <div class="pub-gate">
      <div class="pub-gate-icon">🍺</div>
      <div class="pub-gate-title">THE GOLDEN FLAGON</div>
      <div class="pub-gate-desc">
        The pub is only open to those who've made the journey.
        Travel to one of the capital cities to find your nearest tavern.
      </div>
      <div class="pub-gate-locations">
        ${Object.values(PUB_LOCATIONS).map(p => `
          <div class="pub-gate-loc-card" onclick="window._pubTravelTo('${p.location}','${p.continent}')">
            <div class="loc-name">${p.location}</div>
            <div class="loc-cont">${p.continent}</div>
            <div class="loc-cost">10 💰 · ~1 min</div>
          </div>`).join('')}
      </div>
    </div>`;
}

// ── Travel shortcut ───────────────────────────────────────────
window._pubTravelTo = function(dest, continent) {
  if (typeof window._startTravel === 'function') {
    window._startTravel({ dest, continent, cost: 10, seconds: 60 });
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
  const q = query(
    collection(db, 'pubGames'),
    where('status', '==', 'complete'),
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

// ── Check active games (show LIVE badge) ──────────────────────
async function _checkLiveGames() {
  try {
    const q = query(collection(db, 'pubGames'), where('status', '==', 'open'), limit(10));
    const snap = await getDocs(q);
    snap.docs.forEach(d => {
      const g = d.data();
      const card = document.querySelector(`.pub-table-card[onclick*="${g.gameType}"] .pub-table-status`);
      if (card) { card.textContent = 'LIVE'; card.classList.add('active-game'); }
    });
  } catch(_) {}
}

// ── Open a game ───────────────────────────────────────────────
window._openPubGame = function(gameId) {
  const game = PUB_GAMES.find(g => g.id === gameId);
  if (!game) return;

  if (!game.live) { window.showToast?.('Coming soon!', ''); return; }

  document.getElementById('pub-lobby').style.display = 'none';

  const container = document.getElementById('pub-game-container');
  container.innerHTML = '';

  if (gameId === 'tavern-dice')  _buildTavernDiceView(container);
  else if (gameId === 'house-mode')   _buildHouseModeView(container);
  else if (gameId === 'highest-roll') _buildHighestRollView(container);
  else                                _buildComingSoonView(container, game);
};

// ── Back to lobby ─────────────────────────────────────────────
function _backToLobby() {
  if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; }
  _activeGameId = null;
  const container = document.getElementById('pub-game-container');
  if (container) container.innerHTML = '';
  const lobby = document.getElementById('pub-lobby');
  if (lobby) lobby.style.display = '';
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
          <button class="pub-btn-roll" id="td-join-btn" onclick="window._tdJoinOrCreate()">🎲 Join / Start Game</button>
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

window._tdJoinOrCreate = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }

  if (_tdPickedNumber === null) { window.showToast?.('Pick a number first!', ''); return; }

  const bet = parseInt(document.getElementById('td-bet-input').value) || 100;
  if (bet < 1)                     { window.showToast?.('Enter a valid bet.', ''); return; }
  if ((_charData.gold || 0) < bet) { window.showToast?.(`Not enough gold. You have ${_charData.gold||0}.`, 'error'); return; }

  const btn = document.getElementById('td-join-btn');
  btn.disabled = true;

  try {
    // Check for an open game to join
    const q = query(collection(db,'pubGames'), where('gameType','==','tavern-dice'), where('status','==','open'), limit(1));
    const snap = await getDocs(q);

    if (!snap.empty) {
      // Join existing game
      const gameDoc = snap.docs[0];
      const game    = gameDoc.data();
      const taken   = game.players.map(p => p.pick);
      if (taken.includes(_tdPickedNumber)) {
        window.showToast?.('That number is taken! Pick another.', 'error');
        btn.disabled = false;
        return;
      }
      if (game.players.length >= MAX_TAVERN_DICE_PLAYERS) {
        window.showToast?.('Table is full! Start a new game.', '');
        btn.disabled = false;
        return;
      }
      const newPlayer = { uid: _uid, name: _charData.name || 'Unknown', pick: _tdPickedNumber, bet };
      await updateDoc(doc(db,'pubGames',gameDoc.id), {
        players: [...game.players, newPlayer],
        pot: (game.pot || 0) + bet,
      });
      // Deduct gold
      await _deductGold(bet);
      _activeGameId = gameDoc.id;
      window.showToast?.(`Joined the table! You picked ${_tdPickedNumber}.`, 'success');
    } else {
      // Create new game
      const newGame = {
        gameType:    'tavern-dice',
        status:      'open',
        hostUid:     _uid,
        players:     [{ uid: _uid, name: _charData.name || 'Unknown', pick: _tdPickedNumber, bet }],
        pot:         bet,
        rollResult:  null,
        winnerUid:   null,
        winnerName:  null,
        prize:       0,
        createdAt:   serverTimestamp(),
        completedAt: null,
      };
      const ref = await addDoc(collection(db,'pubGames'), newGame);
      await _deductGold(bet);
      _activeGameId = ref.id;
      window.showToast?.(`Table opened! You picked ${_tdPickedNumber}. Share with friends!`, 'success');
    }

    _tdSubscribeGame(_activeGameId);
  } catch(e) {
    console.warn('[Pub] tdJoinOrCreate error:', e);
    window.showToast?.('Failed to join. Try again.', 'error');
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
  const joinBtn  = document.getElementById('td-join-btn');
  const rollBtn  = document.getElementById('td-roll-btn');
  const leaveBtn = document.getElementById('td-leave-btn');
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
    if (joinBtn)  joinBtn.style.display  = amPlaying ? 'none' : '';
    if (rollBtn)  rollBtn.style.display  = (isHost && amPlaying && game.players.length >= 2) ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = amPlaying ? '' : 'none';
    if (statusEl) statusEl.textContent   = amPlaying
      ? (isHost ? `You're the host — roll when ready!` : `Waiting for the host to roll...`)
      : `${game.players.length} player${game.players.length !== 1 ? 's' : ''} seated. Join them!`;
    if (statusEl) statusEl.className = 'pub-status-bar';
  }

  if (game.status === 'rolling') {
    if (joinBtn)  joinBtn.style.display  = 'none';
    if (rollBtn)  rollBtn.style.display  = 'none';
    if (leaveBtn) leaveBtn.style.display = 'none';
    _tdAnimateDice(null);
    if (statusEl) { statusEl.textContent = '🎲 Rolling...'; statusEl.className = 'pub-status-bar roll'; }
  }

  if (game.status === 'complete') {
    if (joinBtn)  joinBtn.style.display  = 'none';
    if (rollBtn)  rollBtn.style.display  = 'none';
    if (leaveBtn) leaveBtn.style.display = 'none';
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

    if (didWin) _spawnCoinRain();

    // Show result overlay
    if (amPlaying) {
      setTimeout(() => _showResultOverlay(didWin, game.rollResult, game.winnerName, game.prize, didWin ? game.prize : 0), 800);
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

  try {
    await updateDoc(doc(db,'pubGames',_activeGameId), { status: 'rolling' });
    // Small delay for animation, then compute result
    setTimeout(() => _tdExecuteRoll(_activeGameId), 1800);
  } catch(e) {
    console.warn('[Pub] callRoll error:', e);
    if (rollBtn) rollBtn.disabled = false;
  }
};

async function _tdExecuteRoll(gameId) {
  const snap = await getDocs(query(collection(db,'pubGames'), limit(1))); // force fresh read
  const gameSnap = await getDoc(doc(db,'pubGames',gameId));
  if (!gameSnap.exists()) return;
  const game = gameSnap.data();
  if (game.status !== 'rolling') return;

  const roll    = Math.floor(Math.random() * 20) + 1;
  const players = game.players;

  // Find winner: exact match first, then closest
  let winner = players.find(p => p.pick === roll);
  if (!winner) {
    let minDiff = Infinity;
    players.forEach(p => {
      const diff = Math.abs(p.pick - roll);
      if (diff < minDiff) { minDiff = diff; winner = p; }
    });
  }

  const prize = game.pot;

  await updateDoc(doc(db,'pubGames',gameId), {
    status:      'complete',
    rollResult:  roll,
    winnerUid:   winner.uid,
    winnerName:  winner.name,
    prize,
    completedAt: serverTimestamp(),
  });

  // Award coins to winner via Firestore
  await _awardGold(winner.uid, prize);
}

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
      logActivity?.('🎲', `<b>Pub Win!</b> Against the House — Rolled <b>${playerRoll}</b>, won <b>${prize}</b> 💰.`, '#4ec878');
    } else {
      if (statusEl) { statusEl.textContent = `You picked ${_hmPicked}, rolled ${playerRoll}. Rowan keeps your ${bet} 💰.`; statusEl.className = 'pub-status-bar loss'; }
      _showResultOverlay(false, playerRoll, 'Rowan', bet, 0);
      logActivity?.('🎲', `<b>Pub Loss.</b> Against the House — Rolled <b>${playerRoll}</b>, lost <b>${bet}</b> 💰.`, '#e05555');
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
          <button class="pub-btn-roll" id="hr-join-btn" onclick="window._hrJoinOrCreate()">⚔️ Join / Start Game</button>
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

window._hrJoinOrCreate = async function() {
  _uid      = _uid || window._uid;
  _charData = _charData || window._charData;
  if (!_uid || !_charData) { window.showToast?.('Not logged in.', 'error'); return; }

  const bet = parseInt(document.getElementById('hr-bet-input').value) || 100;
  if (bet < 1)                     { window.showToast?.('Enter a valid bet.', ''); return; }
  if ((_charData.gold || 0) < bet) { window.showToast?.(`Not enough gold.`, 'error'); return; }

  const btn = document.getElementById('hr-join-btn');
  btn.disabled = true;

  try {
    const q = query(collection(db,'pubGames'), where('gameType','==','highest-roll'), where('status','==','open'), limit(1));
    const snap = await getDocs(q);

    if (!snap.empty) {
      const gameDoc = snap.docs[0];
      const game    = gameDoc.data();
      if (game.players.some(p => p.uid === _uid)) { window.showToast?.('Already seated!', ''); btn.disabled = false; return; }
      await updateDoc(doc(db,'pubGames',gameDoc.id), {
        players: [...game.players, { uid: _uid, name: _charData.name || 'Unknown', bet, roll: null }],
        pot:     (game.pot || 0) + bet,
      });
      await _deductGold(bet);
      _activeGameId = gameDoc.id;
      window.showToast?.('Joined the table! Host will roll when ready.', 'success');
    } else {
      const ref = await addDoc(collection(db,'pubGames'), {
        gameType:    'highest-roll',
        status:      'open',
        hostUid:     _uid,
        players:     [{ uid: _uid, name: _charData.name || 'Unknown', bet, roll: null }],
        pot:         bet,
        rollResult:  null,
        winnerUid:   null,
        winnerName:  null,
        prize:       0,
        createdAt:   serverTimestamp(),
        completedAt: null,
      });
      await _deductGold(bet);
      _activeGameId = ref.id;
      window.showToast?.('Table opened! Invite others and roll when ready.', 'success');
    }
    _hrSubscribeGame(_activeGameId);
  } catch(e) {
    console.warn('[Pub] hrJoinOrCreate error:', e);
    window.showToast?.('Failed to join. Try again.', 'error');
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
  const joinBtn  = document.getElementById('hr-join-btn');
  const rollBtn  = document.getElementById('hr-roll-btn');
  const leaveBtn = document.getElementById('hr-leave-btn');
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
    if (joinBtn)  joinBtn.style.display  = amPlaying ? 'none' : '';
    if (rollBtn)  rollBtn.style.display  = (isHost && amPlaying && game.players.length >= 2) ? '' : 'none';
    if (leaveBtn) leaveBtn.style.display = amPlaying ? '' : 'none';
    if (statusEl) statusEl.textContent   = amPlaying
      ? (isHost ? 'You host — roll when everyone is seated!' : 'Waiting for host to roll...')
      : 'Table open. Join to compete!';
    if (statusEl) statusEl.className = 'pub-status-bar';
  }

  if (game.status === 'rolling') {
    if (joinBtn)  joinBtn.style.display  = 'none';
    if (rollBtn)  rollBtn.style.display  = 'none';
    if (leaveBtn) leaveBtn.style.display = 'none';
    const face = document.getElementById('hr-dice-face');
    if (face) { face.textContent = '🎲'; face.classList.remove('rolling','result-flash'); void face.offsetWidth; face.classList.add('rolling'); }
    if (statusEl) { statusEl.textContent = '🎲 Rolling for everyone...'; statusEl.className = 'pub-status-bar roll'; }
  }

  if (game.status === 'complete') {
    if (joinBtn)  joinBtn.style.display  = 'none';
    if (rollBtn)  rollBtn.style.display  = 'none';
    if (leaveBtn) leaveBtn.style.display = 'none';
    const face = document.getElementById('hr-dice-face');
    if (face) { face.classList.remove('rolling','result-flash'); face.textContent = game.rollResult; void face.offsetWidth; face.classList.add('result-flash'); }

    const didWin = game.winnerUid === _uid;
    if (statusEl) {
      statusEl.textContent = didWin
        ? `🎉 You rolled highest (${game.rollResult})! +${game.prize} 💰`
        : `${game.winnerName} rolled ${game.rollResult} and wins ${game.prize} 💰!`;
      statusEl.className = `pub-status-bar ${didWin ? 'win' : 'loss'}`;
    }
    if (didWin) _spawnCoinRain();
    if (amPlaying) setTimeout(() => _showResultOverlay(didWin, game.rollResult, game.winnerName, game.prize, didWin ? game.prize : 0), 800);
    setTimeout(() => { if (_activeGameUnsub) { _activeGameUnsub(); _activeGameUnsub = null; } _activeGameId = null; }, 5000);
  }
}

window._hrCallRoll = async function() {
  if (!_activeGameId) return;
  const btn = document.getElementById('hr-roll-btn');
  if (btn) btn.disabled = true;
  try {
    await updateDoc(doc(db,'pubGames',_activeGameId), { status: 'rolling' });
    setTimeout(() => _hrExecuteRoll(_activeGameId), 1800);
  } catch(e) { if (btn) btn.disabled = false; }
};

async function _hrExecuteRoll(gameId) {
  const snap = await getDoc(doc(db,'pubGames',gameId));
  if (!snap.exists()) return;
  const game = snap.data();
  if (game.status !== 'rolling') return;

  const rolls   = game.players.map(p => ({ ...p, roll: Math.floor(Math.random()*20)+1 }));
  const maxRoll = Math.max(...rolls.map(r => r.roll));
  // Tie-break: first in array if multiple share top roll
  const winner  = rolls.find(r => r.roll === maxRoll);

  await updateDoc(doc(db,'pubGames',gameId), {
    status:      'complete',
    players:     rolls,
    rollResult:  maxRoll,
    winnerUid:   winner.uid,
    winnerName:  winner.name,
    prize:       game.pot,
    completedAt: serverTimestamp(),
  });
  await _awardGold(winner.uid, game.pot);
}

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
//  RESULT OVERLAY
// ═══════════════════════════════════════════════════════════════
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
        ${won ? `+${myPrize} 💰` : `-${prize} 💰`}
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
  if (!_uid) return;
  try {
    const newGold = Math.max(0, (_charData?.gold || 0) - amount);
    await updateDoc(doc(db, 'characters', _uid), { gold: newGold });
    if (_charData)       { _charData.gold = newGold; }
    if (window._charData){ window._charData.gold = newGold; }
    // Update HUD
    document.getElementById('stat-gold')?.textContent !== undefined &&
      (document.getElementById('stat-gold').textContent = newGold);
    document.getElementById('s-gold')?.textContent !== undefined &&
      (document.getElementById('s-gold').textContent = newGold);
  } catch(e) { console.warn('[Pub] _deductGold error:', e); }
}

async function _awardGold(uid, amount) {
  if (!uid || amount <= 0) return;
  try {
    const charRef  = doc(db, 'characters', uid);
    const charSnap = await getDoc(charRef);
    if (!charSnap.exists()) return;
    const current = charSnap.data().gold || 0;
    await updateDoc(charRef, { gold: current + amount });
    // If winner is this client, update local state too
    if (uid === (_uid || window._uid)) {
      if (_charData)        { _charData.gold = current + amount; }
      if (window._charData) { window._charData.gold = current + amount; }
      document.getElementById('stat-gold') && (document.getElementById('stat-gold').textContent = current + amount);
      document.getElementById('s-gold')    && (document.getElementById('s-gold').textContent    = current + amount);
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