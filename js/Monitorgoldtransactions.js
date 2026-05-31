// ═══════════════════════════════════════════════════════════════
//  GOLD TRANSACTION MONITOR
//  Attach to your Firebase app to detect double-deductions,
//  race conditions, and wager settlement anomalies in real time.
//
//  Usage: import and call initGoldMonitor(db, uid) after auth.
// ═══════════════════════════════════════════════════════════════

import {
  doc, onSnapshot, collection, query, where, orderBy, limit, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Config ─────────────────────────────────────────────────────
const MONITOR_CONFIG = {
  logToConsole:   true,   // always log to console
  showOverlay:    true,   // show floating HUD in browser
  warnThreshold:  500,    // flag any single gold change > this as suspicious
  trackLastN:     20,     // keep the last N gold events in memory
};

// ── In-memory log ──────────────────────────────────────────────
const _goldLog = [];   // { ts, uid, from, to, delta, source, suspicious }
let   _overlay  = null;
let   _prevGold = null;  // last known gold value for current user

// ── Public init ────────────────────────────────────────────────
export function initGoldMonitor(db, uid) {
  if (!db || !uid) { console.warn('[GoldMonitor] db and uid required'); return; }
  _attachCharacterListener(db, uid);
  _attachPvpListener(db, uid);
  _attachPubListener(db, uid);
  if (MONITOR_CONFIG.showOverlay) _createOverlay();
  console.info('[GoldMonitor] Monitoring started for uid:', uid);
}

// ── Character doc listener — catches every gold change ─────────
function _attachCharacterListener(db, uid) {
  onSnapshot(doc(db, 'characters', uid), snap => {
    if (!snap.exists()) return;
    const gold = snap.data().gold ?? 0;

    if (_prevGold === null) {
      _prevGold = gold;
      _logEvent({ uid, from: gold, to: gold, delta: 0, source: 'init', suspicious: false });
      return;
    }

    const delta      = gold - _prevGold;
    const suspicious = Math.abs(delta) > MONITOR_CONFIG.warnThreshold;
    _logEvent({ uid, from: _prevGold, to: gold, delta, source: 'character-doc', suspicious });

    if (suspicious) {
      console.warn(
        `[GoldMonitor] ⚠️  LARGE GOLD CHANGE: ${_prevGold} → ${gold} (Δ${delta > 0 ? '+' : ''}${delta})`
      );
    }

    _prevGold = gold;
  });
}

// ── PvP listener — watch for settlement after complete ─────────
function _attachPvpListener(db, uid) {
  const q = query(
    collection(db, 'pvpChallenges'),
    where('participants', 'array-contains', uid),
    orderBy('completedAt', 'desc'),
    limit(5)
  );

  onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      const match = change.doc.data();
      if (match.status !== 'complete') return;

      const wager   = match.wager || 0;
      const iWon    = match.winnerId === uid;
      const matchId = change.doc.id;

      if (wager === 0) return; // no gold at stake, skip

      // Check: was this match already settled in our log?
      const alreadyLogged = _goldLog.some(e => e.matchId === matchId);
      if (alreadyLogged) return;

      const expected = iWon ? +wager : -wager;
      _logEvent({
        uid,
        from:      null,
        to:        null,
        delta:     expected,
        source:    `pvp-complete (${matchId})`,
        suspicious: false,
        matchId,
        note: `Expected ${iWon ? '+' : ''}${expected} gold from PvP wager`,
      });

      // ── Double-settlement guard ──────────────────────────────
      // The bug: doPvpTurn reads gold then writes gold (not atomic).
      // Flag if goldSettled is not present — means client-side code
      // is doing the write instead of a Cloud Function.
      if (match.goldSettled === undefined || match.goldSettled === null) {
        console.error(
          '[GoldMonitor] 🚨 PVP SETTLEMENT RISK: match', matchId,
          'completed without a goldSettled flag.',
          'Gold is being written client-side — race condition possible.',
          '\n  Winner:', match.winnerId,
          '\n  Wager:',  wager,
          '\n  Fix: use runTransaction or move settlement to a Cloud Function.'
        );
        _logEvent({
          uid,
          from:      null,
          to:        null,
          delta:     0,
          source:    `pvp-settlement-warning (${matchId})`,
          suspicious: true,
          note:      'No goldSettled flag — client-side gold write detected',
        });
      }
    });
  });
}

// ── Pub game listener — watch for pot settlement ───────────────
function _attachPubListener(db, uid) {
  const q = query(
    collection(db, 'pubGames'),
    where('status', '==', 'complete'),
    orderBy('completedAt', 'desc'),
    limit(5)
  );

  onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const game   = change.doc.data();
      const gameId = change.doc.id;

      const amPlayer = (game.players || []).some(p => p.uid === uid);
      if (!amPlayer) return;

      const alreadyLogged = _goldLog.some(e => e.gameId === gameId);
      if (alreadyLogged) return;

      const iWon  = game.winnerUid === uid;
      const myBet = (game.players.find(p => p.uid === uid) || {}).bet || 0;
      const expected = iWon ? (game.prize - myBet) : -myBet;  // net change

      _logEvent({
        uid,
        from:      null,
        to:        null,
        delta:     expected,
        source:    `pub-${game.gameType} (${gameId})`,
        suspicious: false,
        gameId,
        note: `${iWon ? 'Won' : 'Lost'} pub game — expected net Δ ${expected > 0 ? '+' : ''}${expected}`,
      });

      // Same atomic-write check for pub games
      if (game.goldSettled === undefined || game.goldSettled === null) {
        console.warn(
          '[GoldMonitor] ⚠️  PUB SETTLEMENT: game', gameId,
          'completed without goldSettled flag.',
          'If settlePubGame Cloud Function is not triggered, gold may be written client-side.'
        );
      }
    });
  });
}

// ── Event logger ───────────────────────────────────────────────
function _logEvent(entry) {
  const event = { ts: new Date().toISOString(), ...entry };
  _goldLog.push(event);
  if (_goldLog.length > MONITOR_CONFIG.trackLastN) _goldLog.shift();

  if (MONITOR_CONFIG.logToConsole && entry.source !== 'init') {
    const style = entry.suspicious ? 'color:orange;font-weight:bold' : 'color:#4ec878';
    const delta = entry.delta !== null
      ? ` Δ${entry.delta > 0 ? '+' : ''}${entry.delta}`
      : '';
    console.log(
      `%c[GoldMonitor] ${entry.source}${delta}` +
      (entry.note ? ` — ${entry.note}` : ''),
      style
    );
  }

  _updateOverlay();
}

// ── Overlay HUD ────────────────────────────────────────────────
function _createOverlay() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.id = 'gold-monitor-overlay';
  Object.assign(_overlay.style, {
    position:      'fixed',
    bottom:        '12px',
    right:         '12px',
    width:         '280px',
    maxHeight:     '280px',
    overflowY:     'auto',
    background:    'rgba(10,10,14,0.92)',
    border:        '1px solid rgba(201,168,76,0.35)',
    borderRadius:  '10px',
    padding:       '10px 12px',
    fontFamily:    'monospace',
    fontSize:      '11px',
    color:         '#c9a84c',
    zIndex:        99999,
    pointerEvents: 'none',
    lineHeight:    '1.5',
  });
  _overlay.innerHTML = '<div style="font-weight:700;margin-bottom:6px;font-size:12px">💰 Gold Monitor</div><div id="gm-log">Waiting for events...</div>';
  document.body.appendChild(_overlay);
}

function _updateOverlay() {
  if (!_overlay) return;
  const logEl = document.getElementById('gm-log');
  if (!logEl) return;

  const recent = [..._goldLog].reverse().slice(0, 8);
  logEl.innerHTML = recent.map(e => {
    const delta = e.delta !== null ? (e.delta > 0 ? `+${e.delta}` : `${e.delta}`) : '—';
    const warn  = e.suspicious ? '⚠️ ' : '';
    const color = e.suspicious ? '#e8824a' : e.delta > 0 ? '#4ec878' : e.delta < 0 ? '#e05555' : '#888';
    return `<div style="color:${color};margin-bottom:3px">${warn}${e.source.split(' ')[0]} <b>${delta}</b>${e.note ? `<br><span style="color:#666;font-size:10px">${e.note}</span>` : ''}</div>`;
  }).join('');
}

// ── Expose for debugging in console ───────────────────────────
window._goldLog        = _goldLog;
window._goldMonitorDump = () => {
  console.table(_goldLog.map(e => ({
    time:       e.ts,
    source:     e.source,
    from:       e.from,
    to:         e.to,
    delta:      e.delta,
    suspicious: e.suspicious,
    note:       e.note || '',
  })));
};

// ══════════════════════════════════════════════════════════════════
//  ROOT CAUSE NOTES & RECOMMENDED FIXES (do not delete)
// ══════════════════════════════════════════════════════════════════
//
//  BUG 1 — PvP double-deduction (dashboard.js ~line 11094)
//  --------------------------------------------------------
//  Current code reads gold with getDoc(), then writes gold + wager.
//  The wager was already deducted on match entry, so:
//    - Winner ends up net -0  (correct, but only by accident)
//    - Loser ends up net -2×wager (double-charged)
//
//  The race condition: if the loser's gold changes between getDoc and
//  updateDoc (e.g. they earned gold from a kill), the write silently
//  uses stale data.
//
//  FIX — replace the gold settlement block (lines 11095–11105) with:
//
//    import { runTransaction, increment } from "firebase-firestore.js";
//    await runTransaction(db, async tx => {
//      // Atomic: winner gains wager, loser loses wager
//      tx.update(myRef,  { gold: increment(+wager) });
//      tx.update(oppRef, { gold: increment(-wager) });
//    });
//
//  OR: move all gold settlement to a Cloud Function triggered by
//  pvpChallenges.status == 'complete', and set goldSettled = true
//  once done (same pattern already used for pub games via settlePubGame).
//
//  BUG 2 — _awardGold in pub.js is also not atomic (line 1399)
//  ------------------------------------------------------------
//  Same read-then-write pattern. Replace with:
//
//    await updateDoc(charRef, { gold: increment(amount) });
//
//  increment() is already imported in pub.js (runTransaction is too).
// ══════════════════════════════════════════════════════════════════