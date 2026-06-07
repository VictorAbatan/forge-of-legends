import { auth, db, storage } from "../firebase/firebase.js";
import {
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, limit, limitToLast,
  onSnapshot, serverTimestamp, getDocs, increment, runTransaction,
  arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { logoutUser, showToast, hideLoading } from "./auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// ═══════════════════════════════════════════════════
//  INVENTORY WRITE QUEUE  (prevents race conditions)
//  _invWrite(uid, mutatorFn, extraFields?)
//
//  The ONLY correct way to touch a character's inventory.
//  Callers pass a MUTATOR — a function (inv) => void  — that describes
//  WHAT to change, not a pre-built snapshot.  _invWrite opens a Firestore
//  transaction, reads the current server doc, hands the live inventory
//  array to the mutator, then writes the result back.
//
//  This eliminates every stale-snapshot race:
//    • Two concurrent calls both read the real server state, apply their
//      own delta, and write.  Firebase retries whichever one conflicts.
//    • Nothing is ever silently overwritten by a stale local copy.
//
//  Gold / other scalar fields that need atomic change should be passed as
//  FieldValue.increment() values in `extra` — never as raw arithmetic on
//  _charData.gold.
//
//  After the transaction completes, _charData is refreshed from the
//  server so all subsequent reads in the same session are consistent.
//
//  Usage:
//    await _invWrite(_uid, inv => {
//      const ex = inv.find(i => i.name === 'Iron');
//      if (ex) ex.qty += 3; else inv.push({ name:'Iron', qty:3, type:'material' });
//    });
//
//    await _invWrite(_uid, inv => {
//      const idx = inv.findIndex(i => i.name === itemName);
//      if (idx !== -1) inv.splice(idx, 1);
//    }, { gold: increment(-500) });
// ═══════════════════════════════════════════════════
let _invWriteQueue = Promise.resolve();

async function _invWrite(uid, mutatorFn, extra = {}) {
  _invWriteQueue = _invWriteQueue.then(async () => {
    try {
      const charRef = doc(db, 'characters', uid);
      await runTransaction(db, async tx => {
        const snap = await tx.get(charRef);
        if (!snap.exists()) throw new Error('[_invWrite] Character doc not found');
        // Work on a deep copy of the server's live inventory
        const inv = (snap.data().inventory || []).map(i => ({ ...i }));
        // Let the caller describe their mutation against the fresh data
        mutatorFn(inv);
        // Remove zero-qty items that the mutator may have left behind
        const cleaned = inv.filter(i => (i.qty ?? 1) > 0);
        tx.update(charRef, { inventory: cleaned, ...extra });
      });
      // Keep _charData consistent with what was just written
      await refreshCharData();
    } catch (e) {
      console.warn('[_invWrite] transaction failed:', e);
      // Last-resort fallback: apply the mutation locally and write directly.
      // This is imperfect but better than silently losing the change.
      try {
        const fallbackInv = ((_charData?.inventory) || []).map(i => ({ ...i }));
        mutatorFn(fallbackInv);
        const cleaned = fallbackInv.filter(i => (i.qty ?? 1) > 0);
        await updateDoc(doc(db, 'characters', uid), { inventory: cleaned, ...extra });
        if (_charData) _charData.inventory = cleaned;
      } catch (e2) {
        console.error('[_invWrite] fallback also failed:', e2);
      }
    }
  }).catch(e => console.warn('[_invWrite] queue error:', e));
  return _invWriteQueue;
}
window._invWrite = _invWrite;

// ═══════════════════════════════════════════════════
//  WORLD DEVELOPMENT EVENTS (PLAYER VIEW)
// ═══════════════════════════════════════════════════
function loadWorldDevelopmentEventsForPlayers() {
  if (!_uid) return; // wait for authenticated user
  const listEl = document.getElementById('world-development-list');
  if (!listEl) return;
  const q = query(collection(db, 'worldEvents'), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(2));
  onSnapshot(q, snap => {
    if (snap.empty) {
      listEl.innerHTML = '<p style="color:var(--text-dim);font-style:italic;font-size:0.85rem">No world developments yet.</p>';
      return;
    }
    listEl.innerHTML = Array.from(snap.docs).map((d, idx) => {
      const e = d.data();
      const createdAt = e.createdAt?.toDate?.() || (d.data().createdAt instanceof Date ? d.data().createdAt : null);
      // Render description with paragraph breaks
      const descHtml = (e.description||"").split(/\n+/).map(p => p ? `<p style='margin:0 0 8px 0'>${p}</p>` : '').join('');
      return `<div class="event-card" style="margin-bottom:18px;padding-bottom:10px;border-bottom:1px solid var(--border)">\n        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">\n          <span class="event-card-title" style="font-weight:700;letter-spacing:0.04em;font-size:1.08em;color:var(--gold);text-transform:uppercase;">${e.title||"Untitled"}</span>\n          <span style=\"margin-left:auto;font-size:0.85em;color:var(--ash-light)\">${createdAt ? createdAt.toLocaleString() : ''}</span>\n        </div>\n        <div class="event-card-desc" style="font-size:0.98em;color:var(--text-dim);margin-bottom:4px;">${descHtml}</div>\n        <div class="event-card-meta" style="font-size:0.85em;color:var(--ash);display:flex;gap:18px;flex-wrap:wrap;">\n          <span>By <span style=\"color:var(--gold-dim)\">${e.createdBy||"—"}</span></span>\n          <span>${e.location ? `📍 ${e.location}` : ''}</span>\n        </div>\n      </div>`;
    }).join('');
    // Add button to open full World Development panel
    listEl.innerHTML += `<div style='text-align:center;margin-top:10px'><button class='btn-secondary' style='font-size:0.8em;width:auto' onclick='switchPanel("worlddev")'>View All World Developments</button></div>`;
  });
}

// Check for active PvP match on dashboard load and restore if found
async function checkActivePvpMatch() {
  if (!_uid || !_charData) return;
  const q = query(
    collection(db, 'pvpChallenges'),
    where('status', '==', 'active'),
    where('participants', 'array-contains', _uid)
  );
  try {
    const snap = await getDocs(q);
    if (!snap.empty) {
      const pvpDocId = snap.docs[0].id;
      const match = { ...snap.docs[0].data(), matchId: pvpDocId };
      window._myPvpMatchId = pvpDocId;
      _pvpAmChallenger = (match.challengerId === _uid);
      _enterPvpArena(match);
      // Listen for updates to the match
      if (_pvpMatchUnsub) _pvpMatchUnsub();
      _pvpMatchUnsub = onSnapshot(doc(db, 'pvpChallenges', pvpDocId), snap => {
        if (!snap.exists()) return;
        const m = snap.data();
        if (m.status === 'active')   _refreshPvpArena(m);
        if (m.status === 'complete') _onPvpComplete(m);
      });
    }
  } catch (e) {
    console.warn('Failed to check active PvP match:', e);
  }
}

// Show Boss Raid Arena (basic UI for solo test)
window.showBossRaidArena = function(state) {
  // Reuse the battle arena for now
  document.getElementById('battle-zone-select').style.display = 'none';
  document.getElementById('boss-raid-ui').style.display = 'none';
  document.getElementById('battle-arena').style.display = 'block';
  // Show boss info
  set('monster-name', state.boss.name);
  set('monster-grade', `Boss`);
  updateBattleBars(state.boss.hp, state.boss.maxHp, state.party[state.leaderIdx].hp, state.party[state.leaderIdx].hpMax, 0, 0);
  set('battle-player-name', state.party[state.leaderIdx].name);
  set('battle-player-rank', `${state.party[state.leaderIdx].rank||'Wanderer'} Lv.${_displayLevel(state.party[state.leaderIdx].level||1)}`);
  // Hide mana bar for now
  document.getElementById('player-mp-fill').style.width = '0%';
  set('player-mp-text', '—');
  // Log
  const logEl = document.getElementById('battle-log');
  if (logEl) {
    logEl.innerHTML = '';
    state.log.forEach(l => {
      const el = document.createElement('div');
      el.className = 'battle-log-entry';
      el.textContent = l;
      logEl.appendChild(el);
    });
    logEl.scrollTop = logEl.scrollHeight;
  }
  // Enable action buttons
  document.getElementById('btn-melee').onclick = function() { window.bossRaidTurn('melee'); };
  document.getElementById('btn-skill').onclick = function() {
    if (typeof window.openRaidSkillMenu === 'function') {
      window.openRaidSkillMenu();
    } else {
      window.openBattleSkillMenu?.();
    }
  };
  document.getElementById('btn-run').onclick = function() { window.showToast('Cannot run from a boss raid!', 'error'); };
}
// Boss Raid Turn Logic (basic solo test)
window.bossRaidTurn = function(action) {
  if (!_bossRaidState || _bossRaidState.status !== 'active') return;
  const state = _bossRaidState;
  const leader = state.party[state.leaderIdx];
  let log = [];
  if (action === 'melee') {
    // Player attacks boss
    const dmg = Math.max(1, (leader.str || 10) - Math.floor(state.boss.def * 0.5));
    state.boss.hp = Math.max(0, state.boss.hp - dmg);
    log.push(`⚔️ ${leader.name} attacks for ${dmg} damage.`);
  }
  // Boss defeated?
  if (state.boss.hp <= 0) {
    state.status = 'victory';
    log.push(`🏆 Boss defeated!`);
    state.log.push(...log);
    window.showToast('Boss defeated!', 'success');
    window.showBossRaidArena(state);
    return;
  }
  // Boss attacks leader
  const bossDmg = Math.max(1, state.boss.atk - Math.floor((leader.def || 10) * 0.3));
  leader.hp = Math.max(0, leader.hp - bossDmg);
  log.push(`👹 Boss attacks for ${bossDmg}. ${leader.name}'s HP: ${leader.hp}`);
  // Leader defeated?
  if (leader.hp <= 0) {
    log.push(`💀 ${leader.name} was defeated!`);
    // Next party member (if any)
    if (state.leaderIdx < state.party.length - 1) {
      state.leaderIdx++;
      log.push(`➡️ Next up: ${state.party[state.leaderIdx].name}`);
    } else {
      state.status = 'defeat';
      log.push('All party members defeated!');
      window.showToast('Boss raid failed!', 'error');
    }
  }
  state.log.push(...log);
  window.showBossRaidArena(state);
};
// ═══════════════════════════════════════════════════
// ── Boss Definitions ──
let BOSS_LIST = [
  {
    id: 'frost_wyrm',
    name: 'Frost Wyrm',
    desc: 'An ancient ice dragon that freezes the battlefield.',
    abilities: [
      { name: 'Frost Breath', type: 'aoe' },
      { name: 'Ice Armor',    type: 'shield' },
      { name: 'Tail Swipe',   type: 'aoe' },
    ],
    base: { hp: 1200, atk: 80, def: 40 }
  },
  {
    id: 'abyssal_presbyter',
    name: 'Abyssal Presbyter',
    desc: 'A void priest who manipulates shadows and drains life.',
    abilities: [
      { name: 'Shadow Drain',      type: 'drain' },
      { name: 'Dark Pulse',        type: 'aoe' },
      { name: 'Curse of Weakness', type: 'weaken' },
    ],
    base: { hp: 1000, atk: 70, def: 35 }
  },
  {
    id: 'rampage_bull',
    name: 'Rampage Bull',
    desc: 'A colossal beast that tramples everything in its path.',
    abilities: [
      { name: 'Stampede',  type: 'aoe' },
      { name: 'Enrage',    type: 'enrage' },
      { name: 'Earthquake', type: 'aoe' },
    ],
    base: { hp: 1400, atk: 90, def: 30 }
  },
  {
    id: 'void_lurker',
    name: 'Void Lurker',
    desc: 'A horror from the abyss, warping reality.',
    abilities: [
      { name: 'Void Rift',    type: 'aoe' },
      { name: 'Abyssal Gaze', type: 'instakill' },
      { name: 'Reality Tear', type: 'drain' },
    ],
    base: { hp: 1100, atk: 85, def: 45 }
  },
  {
    id: 'revenant_bishop',
    name: 'Revenant Bishop',
    desc: 'An undead bishop who commands spirits and curses.',
    abilities: [
      { name: 'Spirit Swarm',    type: 'aoe' },
      { name: 'Unholy Blessing', type: 'heal' },
      { name: 'Doom Curse',      type: 'weaken' },
    ],
    base: { hp: 1050, atk: 75, def: 38 }
  }
];

// Helper: get player rank index
function getRankIdx(rank) {
  return RANK_ORDER.indexOf(rank || 'Wanderer');
}

// ── Load deity-created bosses from Firestore and merge into BOSS_LIST ──────
// Active Firestore bosses override hardcoded ones with the same id, and
// new ones are appended. Inactive bosses are removed from the list.
async function loadFirestoreBosses() {
  try {
    const snap = await getDocs(collection(db, "bosses"));
    if (snap.empty) return; // keep hardcoded list intact
    snap.forEach(d => {
      const b = d.data();
      if (!b.name) return;
      // Skip bosses explicitly deactivated; missing field = active by default
      if (b.active === false) return;
      const bossId = b.id || d.id;
      const existing = BOSS_LIST.findIndex(x => x.id === bossId);
      const entry = {
        id:        bossId,
        name:      b.name,
        icon:      b.icon || "👹",
        imageUrl:  b.imageUrl || "",
        desc:      b.desc || "",
        // Support both structured [{ name, type }] and legacy string arrays
        abilities: Array.isArray(b.abilities) ? b.abilities : [],
        base:      b.base || { hp: 1000, atk: 70, def: 35 },
      };
      if (existing >= 0) BOSS_LIST[existing] = entry;
      else               BOSS_LIST.push(entry);
    });
  } catch(e) {
    console.warn("[Bosses] Firestore load failed, using hardcoded list:", e.message);
  }
}



// Helper: check if player can solo boss
function canSoloBoss(char) {
  return getRankIdx(char.rank) >= 1 && (char.gold || 0) >= 20000;
}

// Helper: check if party is valid
function isValidParty(party) {
  return Array.isArray(party) && party.length >= 3;
}



let _party = null; // { id, leader, members: [{uid, name, avatar}], code }
let _partyPicFile = null; // persists across re-renders so preview survives Firestore snapshots
let _partyId = null;
let _partyUnsub = null;

// Party profile picture (URL)
let _partyProfilePic = null;

window.setPartyProfilePic = async function(url) {
  if (!_partyId || !_party || _party.leader !== _charData.uid) return window.showToast('Only leader can set party picture.');
  await updateDoc(doc(db, 'parties', _partyId), { profilePic: url });
  window.showToast('Party picture updated!', 'success');
};

function generatePartyCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── Party / Raid loading overlay ─────────────────────
const _PARTY_LOAD = {
  create:  { icon:'🛡️', msg:'Creating Party...',    sub:'Setting up your banner in the realm' },
  join:    { icon:'🤝', msg:'Joining Party...',      sub:'Crossing the realm to find your allies' },
  enter:   { icon:'🚪', msg:'Entering Party...',     sub:'Locating your party' },
  solo:    { icon:'💀', msg:'Entering Solo Raid...',  sub:'Preparing the battlefield' },
  raid:    { icon:'⚔️', msg:'Starting Raid...',      sub:'Summoning the boss' },
  party:   { icon:'⏳', msg:'Loading Party...',      sub:'Fetching party data from the realm' },
};
function _showPartyLoader(type) {
  const ui = document.getElementById('boss-raid-ui');
  if (!ui) return;
  const { icon, msg, sub } = _PARTY_LOAD[type] || _PARTY_LOAD.party;
  ui.style.display = 'block';
  ui.innerHTML = `
    <div class="party-loading-overlay">
      <div class="party-loading-icon">${icon}</div>
      <div class="party-loading-spinner"></div>
      <div class="party-loading-msg">${msg}</div>
      <div class="party-loading-sub">${sub}</div>
    </div>`;
}

window.createParty = async function() {
  if (_partyId) return window.showToast('Already in a party.', 'error');
  _showPartyLoader('create');
  try {
    const code = generatePartyCode();
    const partyDoc = doc(collection(db, 'parties'));
    const partyData = {
      id: partyDoc.id, code,
      leader: _uid,
      createdAt: serverTimestamp(),
      members: [{ uid: _uid, name: _charData.name, avatar: _charData.avatarUrl, rank: _charData.rank || 'Wanderer', level: _charData.level || 1 }],
      raid: null
    };
    await updateDoc(doc(db, 'characters', _uid), { gold: increment(-5000) }); // FIXED: use increment to avoid concurrent-write clobber
    _charData.gold = Math.max(0, (_charData.gold || 0) - 5000);
    await setDoc(partyDoc, partyData);
    _partyId = partyDoc.id;
    _party = partyData;
    subscribeParty(_partyId);
    window.showToast('Party created! Share code: ' + code, 'success');
    window._raidState = 'party';
    window.showBossSelect();
  } catch(e) {
    window.showToast('Failed to create party. Try again.', 'error');
    window._raidState = 'init'; window.showBossSelect();
  }
};

window.joinParty = async function(code) {
  if (_partyId) return window.showToast('Already in a party.', 'error');
  _showPartyLoader('join');
  try {
    const q = collection(db, 'parties');
    let found = null;
    const snap = await getDocs(q);
    snap.forEach(docSnap => { const d = docSnap.data(); if (d.code === code) found = d; });
    if (!found) { window.showToast('Party not found.', 'error'); window._raidState = 'init'; window.showBossSelect(); return; }
    await updateDoc(doc(db, 'parties', found.id), {
      members: arrayUnion({ uid: _uid, name: _charData.name, avatar: _charData.avatarUrl, rank: _charData.rank || 'Wanderer', level: _charData.level || 1 })
    });
    _partyId = found.id;
    subscribeParty(_partyId);
    window.showToast('Joined party!', 'success');
    window._raidState = 'party'; window.showBossSelect();
  } catch(e) {
    window.showToast('Failed to join party. Try again.', 'error');
    window._raidState = 'init'; window.showBossSelect();
  }
};

window.enterParty = async function() {
  if (_partyId && _party) { window._raidState = 'party'; window.showBossSelect(); window.showToast('Entered party.', 'info'); return; }
  _showPartyLoader('enter');
  try {
    const snap = await getDocs(collection(db, 'parties'));
    let found = null;
    snap.forEach(docSnap => { const d = docSnap.data(); if (d.members && d.members.some(m => m.uid === _uid)) found = d; });
    if (!found) { window.showToast('Not in a party.', 'error'); window._raidState = 'init'; window.showBossSelect(); return; }
    _partyId = found.id;
    subscribeParty(_partyId);
    window._raidState = 'party'; window.showBossSelect();
    window.showToast('Entered party.', 'info');
  } catch(e) {
    window.showToast('Failed to enter party. Try again.', 'error');
    window._raidState = 'init'; window.showBossSelect();
  }
};

window.leaveParty = async function() {
  if (!_partyId || !_party) return;

  const isLeader = _party.leader === _charData.uid;
  const otherMembers = (_party.members || []).filter(m => m.uid !== _charData.uid);

  // If leader and there are other members, show transfer picker first
  if (isLeader && otherMembers.length > 0) {
    const chosen = await _pickNewLeader(otherMembers);
    if (chosen === null) return; // cancelled

    const partyDoc = doc(db, 'parties', _partyId);
    const selfMember = (_party.members || []).find(m => m.uid === _charData.uid) || { uid: _charData.uid, name: _charData.name, avatar: _charData.avatarUrl, rank: _charData.rank || 'Wanderer', level: _charData.level || 1 };
    await updateDoc(partyDoc, {
      leader: chosen.uid,
      members: arrayRemove(selfMember),
    });
    _partyId = null; _party = null;
    if (_partyUnsub) _partyUnsub();
    window.showToast(`Left party. ${chosen.name} is the new leader.`, 'info');
    window.renderPartyUI();
    return;
  }

  // Non-leader, or leader leaving an empty party — simple confirm
  const confirmed = await inkConfirm('Leave the party?');
  if (!confirmed) return;

  const partyDoc = doc(db, 'parties', _partyId);
  const selfMember = (_party.members || []).find(m => m.uid === _charData.uid) || { uid: _charData.uid, name: _charData.name, avatar: _charData.avatarUrl, rank: _charData.rank || 'Wanderer', level: _charData.level || 1 };
  await updateDoc(partyDoc, {
    members: arrayRemove(selfMember),
  });
  _partyId = null; _party = null;
  if (_partyUnsub) _partyUnsub();
  window.showToast('Left party.', 'info');
  window.renderPartyUI();
};

// Shows a modal letting the leader pick who inherits leadership
function _pickNewLeader(members) {
  return new Promise((resolve) => {
    document.getElementById('_pick-leader-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '_pick-leader-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const memberBtns = members.map(m => {
      const av = m.avatar?.startsWith('http')
        ? `<img src="${m.avatar}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1.5px solid var(--border);flex-shrink:0;">`
        : `<span style="font-size:1.4rem;">${m.avatar || '👤'}</span>`;
      return `<button class="_pick-leader-btn" data-uid="${m.uid}" data-name="${m.name}"
        style="display:flex;align-items:center;gap:12px;width:100%;padding:10px 14px;background:rgba(255,255,255,0.04);border:1.5px solid var(--border);border-radius:10px;cursor:pointer;color:var(--text);font-size:0.95rem;transition:background 0.15s;text-align:left;">
        ${av}
        <span>${m.name}</span>
      </button>`;
    }).join('');

    overlay.innerHTML = `
      <div style="background:var(--ink2);border:1.5px solid var(--border);border-radius:18px;padding:30px 28px;max-width:360px;width:90%;box-shadow:0 8px 40px #0008;">
        <div style="font-family:var(--font-display);font-size:0.8rem;letter-spacing:0.12em;color:var(--gold);margin-bottom:6px;">LEAVING PARTY</div>
        <div style="font-size:1rem;color:var(--text);margin-bottom:18px;line-height:1.5;">You are the leader. Choose who takes over before you leave:</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">${memberBtns}</div>
        <button id="_pick-leader-cancel" style="width:100%;padding:9px;background:transparent;border:1px solid var(--border);border-radius:8px;color:var(--text-dim);cursor:pointer;font-size:0.85rem;">Cancel</button>
      </div>`;

    document.body.appendChild(overlay);

    overlay.querySelectorAll('._pick-leader-btn').forEach(btn => {
      btn.onmouseenter = () => btn.style.background = 'rgba(201,168,76,0.08)';
      btn.onmouseleave = () => btn.style.background = 'rgba(255,255,255,0.04)';
      btn.onclick = () => {
        overlay.remove();
        resolve({ uid: btn.dataset.uid, name: btn.dataset.name });
      };
    });

    document.getElementById('_pick-leader-cancel').onclick = () => { overlay.remove(); resolve(null); };
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
  });
}


window.deleteParty = async function() {
  if (!_partyId || !_party || _party.leader !== _charData.uid) return window.showToast('Only leader can delete.');
  await deleteDoc(doc(db, 'parties', _partyId));
  _partyId = null; _party = null;
  if (_partyUnsub) _partyUnsub();
  window.showToast('Party deleted.', 'info');
  window.renderPartyUI();
};

window.kickMember = async function(uid) {
  if (!_partyId || !_party || _party.leader !== _charData.uid) return window.showToast('Only leader can kick.');
  const partyDoc = doc(db, 'parties', _partyId);
  const member = _party.members.find(m => m.uid === uid);
  if (!member) return;
  await updateDoc(partyDoc, {
    members: arrayRemove(member)
  });
  window.showToast('Member kicked.', 'info');
};

function subscribeParty(partyId) {
  if (_partyUnsub) _partyUnsub();
  _partyUnsub = onSnapshot(doc(db, 'parties', partyId), (snap) => {
    if (!snap.exists()) {
      _partyId = null; _party = null;
      window.renderPartyUI();
      return;
    }
    // Fix: always include id and correct structure
    _party = { ...snap.data(), id: snap.id };
    window.renderPartyUI();
    // If raid is active, pull members into the fight page
    if (_party.raid && _party.raid.active && _party.raid.bossId) {
      // If this member just exited a raid (clicked Back to Raids), suppress the
      // immediate re-trigger that Firestore fires before the leader clears raid.active.
      if (_suppressRaidAutoLaunch) {
        _suppressRaidAutoLaunch = false; // consume the flag
        return;
      }

      const onBossPanel = (typeof _battleMode !== 'undefined' && _battleMode === 'boss');

      // ── Mid-raid sync: state already exists ──────────────────────────────────
      // Never re-init (would wipe live state). Just sync and show the arena.
      if (_party.raid.state) {
        const alreadyOnBattlePanel = !!document.getElementById('panel-battle')?.classList.contains('active');
        if (!onBossPanel && !alreadyOnBattlePanel) {
          // Auto-switch to boss panel so late/elsewhere member sees the live battle
          window.showToast('⚔️ A raid is in progress — pulling you in!', 'info');
          if (typeof switchPanel === 'function') switchPanel('battle');
          setTimeout(() => {
            _battleMode = 'boss';
            if (typeof window.updateBattleModeUI === 'function') window.updateBattleModeUI('boss');
          }, 200);
          return;
        }
        if (!onBossPanel && alreadyOnBattlePanel) {
          // On battle panel but mode not flagged yet — just set mode, don't redirect
          _battleMode = 'boss';
          if (typeof window.updateBattleModeUI === 'function') window.updateBattleModeUI('boss');
          return;
        }
        // Already on boss panel — sync and show arena (do NOT call switchPanel here;
        // calling it while already in the battle panel resets the UI and ejects everyone).
        _bossRaidState = _party.raid.state;
        if (_bossRaidState && Array.isArray(_bossRaidState.party) && typeof _uid !== 'undefined') {
          _bossRaidState.myIdx = _bossRaidState.party.findIndex(p => p.uid === _uid);
        }
        // If the arena isn't visible yet (member was on party screen), show it now
        const _arenaEl = document.getElementById('boss-raid-arena');
        const _raidUiEl = document.getElementById('boss-raid-ui');
        if (_arenaEl && _arenaEl.style.display === 'none') {
          if (_raidUiEl) _raidUiEl.style.display = 'none';
          _arenaEl.style.display = 'block';
          // Populate boss display fields from synced state
          const _bs = _bossRaidState.boss;
          const _bnEl = document.getElementById('raid-boss-arena-name');
          if (_bnEl) _bnEl.textContent = _bs.name || '—';
          const _baEl = document.getElementById('raid-boss-abilities-hint');
          if (_baEl) _baEl.textContent = 'Abilities: ' + (_bs.abilities || []).map(a => typeof a === 'object' ? (a.name || '—') : String(a)).join(' · ');
          const _bavEl = document.getElementById('raid-boss-emoji-avatar');
          if (_bavEl) {
            _bavEl.innerHTML = _bs.imageUrl
              ? `<img src="${_bs.imageUrl}" alt="${_bs.name}" style="width:72px;height:72px;border-radius:12px;object-fit:cover;border:2px solid var(--gold);box-shadow:0 0 12px rgba(212,175,55,0.35)"/>`
              : `<span style="font-size:3.2rem">${_bs.icon || '👹'}</span>`;
          }
          // Clear previous log and seed with synced entries
          const _rlogEl = document.getElementById('raid-log');
          if (_rlogEl) {
            _rlogEl.innerHTML = (_bossRaidState.log || []).slice(-20).map(l => `<div class="battle-log-entry">${l}</div>`).join('');
            _rlogEl.scrollTop = _rlogEl.scrollHeight;
          }
        }
        _refreshRaidUI();
        return;
      }

      // ── Fresh raid start: no state written yet ───────────────────────────────
      // Auto-switch members who are elsewhere so they also get the stance modal.
      if (!onBossPanel) {
        window.showToast('⚔️ Raid starting — your party needs you!', 'info');
        // Reset guard so the next snapshot (which may carry state) is not blocked.
        _raidLaunchInProgress = false;
        if (typeof switchPanel === 'function') switchPanel('battle');
        setTimeout(() => {
          _battleMode = 'boss';
          if (typeof window.updateBattleModeUI === 'function') window.updateBattleModeUI('boss');
        }, 200);
        return;
      }

      // Already on boss panel, no state yet — launch stance → startBossRaid.
      // Guard against Firestore firing multiple snapshots before state is written.
      if (_raidLaunchInProgress) return;
      _raidLaunchInProgress = true;

      const boss = BOSS_LIST.find(b => b.id === _party.raid.bossId);
      if (boss && Array.isArray(_party.members) && _party.members.length > 0) {
        const memberUids = _party.members.map(m => m.uid);
        console.debug('[RAID DEBUG] Fetching party member UIDs:', memberUids);
        Promise.all(memberUids.map(uid => getDoc(doc(db, 'characters', uid)).then(snap => {
          if (!snap.exists()) {
            console.warn('[RAID DEBUG] No character doc for UID:', uid);
            return null;
          }
          return { uid, ...snap.data() };
        })))
          .then(fullMembers => {
            console.debug('[RAID DEBUG] Full member data fetched:', fullMembers);
            const validMembers = fullMembers.filter(Boolean);
            window.startBossRaid(validMembers, boss);
          })
          .catch(err => {
            console.error('[RAID DEBUG] Member fetch failed, resetting guard:', err);
            _raidLaunchInProgress = false;
          });
      } else {
        // Nothing to launch — release guard so a retry snapshot can proceed
        _raidLaunchInProgress = false;
      }
    }
  });
}

window.renderPartyUI = function() {
  const ui = document.getElementById('party-ui');
  if (!ui) return;
  if (!_partyId && !_party) { ui.innerHTML = ''; return; }
  if (_partyId && !_party) {
    ui.innerHTML = `<div class="party-loading-inline"><div class="party-loading-spinner"></div><div class="party-loading-msg" style="font-size:0.9rem">Loading party...</div></div>`;
    return;
  }

  const isLeader = _party.leader === _uid;
  const partyName = (_party.name || 'Unnamed Party').replace(/&/g,'&amp;').replace(/</g,'&lt;');

  // ── Header ─────────────────────────────────────────
  let html = `<div class="party-header">`;

  // Banner / profile pic
  html += `<div class="party-banner">`;
  if (_party.profilePic) {
    html += `<img src="${_party.profilePic}" class="party-banner-img" alt="Party banner">`;
  } else {
    html += `<div class="party-banner-placeholder">⚔️</div>`;
  }
  html += `</div>`;

  // Party name + code
  html += `<div class="party-identity">
    <div class="party-name">${partyName}</div>
    <div class="party-code-row">
      <span class="party-code-label">Party Code</span>
      <span class="party-code">${_party.code}</span>
      <button class="party-copy-btn" onclick="navigator.clipboard.writeText('${_party.code}');window.showToast('Code copied!','success')">Copy</button>
    </div>
  </div>`;
  html += `</div>`; // end party-header

  // ── Leader controls ────────────────────────────────
  if (isLeader) {
    html += `<div class="party-leader-controls">
      <div class="party-control-row">
        <input id="party-name-input" type="text" maxlength="32" placeholder="Party name..." 
          value="${_party.name ? _party.name.replace(/&/g,'&amp;').replace(/</g,'&lt;') : ''}" 
          class="field-input party-name-input">
        <button class="btn-secondary party-ctrl-btn" id="btn-set-party-name">Set Name</button>
      </div>
      <div class="party-control-row">
        <input type="file" id="party-pic-file" accept="image/*" style="display:none">
        <label for="party-pic-file" class="btn-secondary party-ctrl-btn" style="cursor:pointer">Upload Picture</label>
        <span id="party-pic-filename" style="font-size:0.75rem;color:var(--text-dim);font-style:italic;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px"></span>
        <button class="btn-secondary party-ctrl-btn" id="btn-set-party-pic">Set Picture</button>
        <img id="party-pic-preview" src="" style="display:none;width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid var(--gold);flex-shrink:0">
      </div>
    </div>`;
  }

  // ── Members grid ───────────────────────────────────
  html += `<div class="party-section-label">Party Members (${_party.members.length})</div>`;
  html += `<div class="party-members-grid">`;
  _party.members.forEach(m => {
    const isThisLeader = m.uid === _party.leader;
    html += `<div class="party-member-card ${isThisLeader ? 'party-member-leader' : ''}">
      <img src="${m.avatar||''}" class="party-member-avatar" onerror="this.src=''">
      <div class="party-member-info">
        <div class="party-member-name">${m.name}${isThisLeader ? ' <span class="party-leader-badge">Leader</span>' : ''}</div>
        <div class="party-member-rank">${m.rank||'Wanderer'} · Lv.${_displayLevel(m.level||1)}</div>
      </div>
      ${isLeader && m.uid !== _uid ? `<button class="party-kick-btn" onclick="window.kickMember('${m.uid}')">Kick</button>` : ''}
    </div>`;
  });
  html += `</div>`;

  // ── Danger zone ────────────────────────────────────
  html += `<div class="party-actions">`;
  if (isLeader) {
    html += `<button class="btn-secondary party-danger-btn" onclick="window.deleteParty()">🗑️ Delete Party</button>`;
  }
  html += `<button class="btn-secondary party-leave-btn" onclick="window.leaveParty()">🚪 Leave Party</button>`;
  html += `</div>`;

  ui.innerHTML = html;
  // Party name and picture upload logic
  if (_party.leader === _charData.uid) {
    // Party name logic
    const nameInput = document.getElementById('party-name-input');
    const setNameBtn = document.getElementById('btn-set-party-name');
    if (nameInput && setNameBtn) {
      setNameBtn.onclick = async function() {
        const newName = nameInput.value.trim();
        if (!newName) return window.showToast('Party name cannot be empty.', 'error');
        if (newName.length > 32) return window.showToast('Party name too long.', 'error');
        try {
          await updateDoc(doc(db, 'parties', _partyId), { name: newName });
          window.showToast('Party name updated!', 'success');
        } catch (e) {
          window.showToast('Failed to update party name.', 'error');
        }
      };
    }
    // Party picture upload logic
    const fileInput = document.getElementById('party-pic-file');
    const setBtn = document.getElementById('btn-set-party-pic');
    const fileNameSpan = document.getElementById('party-pic-filename');
    const previewImg = document.getElementById('party-pic-preview');
    let selectedFile = null;
    // Restore any previously selected file across re-renders
    if (_partyPicFile && previewImg && fileNameSpan) {
      const reader = new FileReader();
      reader.onload = ev => { previewImg.src = ev.target.result; previewImg.style.display = 'inline-block'; };
      reader.readAsDataURL(_partyPicFile);
      fileNameSpan.textContent = _partyPicFile.name;
    }
    if (fileInput && setBtn) {
      fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files[0]) {
          _partyPicFile = fileInput.files[0];
          selectedFile = _partyPicFile;
          if (fileNameSpan) fileNameSpan.textContent = _partyPicFile.name;
          const reader = new FileReader();
          reader.onload = ev => {
            if (previewImg) { previewImg.src = ev.target.result; previewImg.style.display = 'inline-block'; }
          };
          reader.readAsDataURL(_partyPicFile);
        } else {
          _partyPicFile = null;
          selectedFile = null;
          if (fileNameSpan) fileNameSpan.textContent = '';
          if (previewImg) { previewImg.src = ''; previewImg.style.display = 'none'; }
        }
      });
      setBtn.onclick = async function() {
        if (!_partyPicFile) return window.showToast('Please select an image file.', 'error');
        const orig = setBtn.textContent;
        setBtn.disabled = true; setBtn.textContent = 'Uploading...';
        try {
          const { ref: storageRef, uploadBytes, getDownloadURL } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js");
          const filePath = `party-pics/${_partyId}_${Date.now()}_${_partyPicFile.name}`;
          const fileRef = storageRef(storage, filePath);
          window.showToast('Uploading image...', 'info');
          await uploadBytes(fileRef, _partyPicFile);
          const url = await getDownloadURL(fileRef);
          await window.setPartyProfilePic(url);
          _partyPicFile = null;
          selectedFile = null;
          window.showToast('Party picture updated!', 'success');
          window.renderPartyUI();
        } catch (e) {
          console.error('[PartyPicUpload] Upload failed:', e);
          window.showToast('Upload failed.', 'error');
        } finally {
          setBtn.disabled = false; setBtn.textContent = orig;
        }
      };
    }
  }

  // Re-render Start Raid button on every Firestore snapshot
  const _raidSlot = document.getElementById('party-start-raid-slot');
  if (_raidSlot) {
    const _iAmLeader = _party && (_party.leader === _uid || _party.leader === _charData?.uid);
    _raidSlot.innerHTML = _iAmLeader
      ? `<div class="party-start-raid-wrap" style="display:flex;flex-direction:column;gap:10px;align-items:stretch">
           <button class="btn-secondary" style="font-size:0.85rem;width:100%" onclick="window._openPartyArrangeModal()">🔀 Arrange Member Order</button>
           <button class="btn-primary party-start-raid-btn" onclick="window._raidState='choose-boss';window.showBossSelect()">⚔️ Choose Boss & Start Raid</button>
         </div>`
      : '';
  }
};

// ── Party Member Arrangement Modal ───────────────────────────────────────────
// Leader drags/reorders members before starting — sets the turn order in the raid.
window._openPartyArrangeModal = function() {
  if (!_party || !_party.members) return;
  document.getElementById('_party-arrange-modal')?.remove();

  // Start from saved memberOrder if exists, else use current member array
  const savedOrder = _party.memberOrder || _party.members.map(m => m.uid);
  // Build sorted member array based on saved order
  let ordered = savedOrder.map(uid => _party.members.find(m => m.uid === uid)).filter(Boolean);
  // Append any members not yet in savedOrder (e.g. just joined)
  _party.members.forEach(m => { if (!ordered.find(o => o.uid === m.uid)) ordered.push(m); });

  const overlay = document.createElement('div');
  overlay.id = '_party-arrange-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:10000;display:flex;align-items:center;justify-content:center;';

  function buildList() {
    return ordered.map((m, i) => {
      const isLeader = m.uid === _party.leader;
      const av = m.avatar?.startsWith('http')
        ? `<img src="${m.avatar}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:1.5px solid var(--border);flex-shrink:0;">`
        : `<span style="font-size:1.3rem">${m.avatar || '⚔️'}</span>`;
      return `<div class="_arrange-row" data-uid="${m.uid}"
        style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(255,255,255,0.04);
        border:1.5px solid var(--border);border-radius:10px;cursor:grab;user-select:none;
        ${isLeader ? 'border-color:var(--gold);' : ''}">
        <span style="font-size:1.1rem;color:var(--ash);min-width:20px;text-align:center">${i + 1}</span>
        ${av}
        <div style="flex:1">
          <div style="font-size:0.9rem;font-weight:600;color:var(--text)">${m.name}${isLeader ? ' <span style="font-size:0.65rem;color:var(--gold);font-weight:700;letter-spacing:0.08em">LEADER</span>' : ''}</div>
          <div style="font-size:0.72rem;color:var(--ash)">${m.rank || 'Wanderer'} · Lv.${_displayLevel(m.level || 1)}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px">
          <button onclick="window._arrangeMoveUp(${i})" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:5px;padding:2px 8px;cursor:pointer;color:var(--text-dim);font-size:0.8rem" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button onclick="window._arrangeMoveDown(${i})" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:5px;padding:2px 8px;cursor:pointer;color:var(--text-dim);font-size:0.8rem" ${i === ordered.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
      </div>`;
    }).join('');
  }

  overlay.innerHTML = `
    <div style="background:var(--ink2);border:1.5px solid var(--border);border-radius:18px;padding:28px 24px;max-width:400px;width:92%;box-shadow:0 8px 40px #0008;">
      <div style="font-family:var(--font-display);font-size:0.78rem;letter-spacing:0.12em;color:var(--gold);margin-bottom:4px;">ARRANGE PARTY ORDER</div>
      <div style="font-size:0.82rem;color:var(--text-dim);margin-bottom:16px;line-height:1.5;">Position 1 acts first in the raid. Use ▲ ▼ to reorder.</div>
      <div id="_arrange-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">${buildList()}</div>
      <div style="display:flex;gap:10px;">
        <button id="_arrange-confirm" class="btn-primary" style="flex:1">✅ Confirm Order</button>
        <button class="btn-secondary" style="flex:1" onclick="document.getElementById('_party-arrange-modal').remove()">Cancel</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  window._arrangeMoveUp = function(idx) {
    if (idx <= 0) return;
    [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
    document.getElementById('_arrange-list').innerHTML = buildList();
  };
  window._arrangeMoveDown = function(idx) {
    if (idx >= ordered.length - 1) return;
    [ordered[idx], ordered[idx + 1]] = [ordered[idx + 1], ordered[idx]];
    document.getElementById('_arrange-list').innerHTML = buildList();
  };

  document.getElementById('_arrange-confirm').onclick = async function() {
    this.disabled = true; this.textContent = 'Saving...';
    try {
      const newOrder = ordered.map(m => m.uid);
      await updateDoc(doc(db, 'parties', _partyId), { memberOrder: newOrder });
      window.showToast('Party order saved!', 'success');
      overlay.remove();
    } catch(e) {
      this.disabled = false; this.textContent = '✅ Confirm Order';
      window.showToast('Failed to save order. Try again.', 'error');
    }
  };
};

window.showJoinPartyModal = function() {
  // Remove any existing modal
  document.getElementById('party-join-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'party-join-modal';
  modal.style = 'position:fixed;z-index:10000;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--ink2);border-radius:14px;box-shadow:0 4px 32px #0008;max-width:370px;width:95vw;padding:32px 24px 24px 24px;display:flex;flex-direction:column;align-items:center;">
      <h3 style="margin-bottom:18px;color:var(--gold)">Join a Party</h3>
      <input id="party-code-input" type="text" maxlength="8" placeholder="Enter party code" style="padding:10px 16px;font-size:1.1em;border-radius:8px;border:2px solid var(--gold);background:var(--ink1);color:var(--gold);font-weight:600;width:180px;text-align:center;letter-spacing:2px;outline:none;box-shadow:0 1px 4px #0002;margin-bottom:16px;" autofocus>
      <div id="party-join-error" style="color:#e05555;font-size:0.95em;margin-bottom:10px;min-height:22px"></div>
      <div style="display:flex;gap:18px;justify-content:center;width:100%">
        <button class="btn-primary" id="btn-party-code-next" style="padding:8px 22px;font-size:1.05em;">Next</button>
        <button class="btn-secondary" id="btn-party-code-cancel" style="padding:8px 22px;font-size:1.05em;">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('party-code-input').focus();
  document.getElementById('btn-party-code-cancel').onclick = () => modal.remove();
  document.getElementById('btn-party-code-next').onclick = async () => {
    const code = document.getElementById('party-code-input').value.trim().toUpperCase();
    const errorDiv = document.getElementById('party-join-error');
    if (!code) { errorDiv.textContent = 'Enter a party code.'; return; }
    // Fetch party by code
    errorDiv.textContent = 'Searching...';
    const q = collection(db, 'parties');
    let found = null;
    const snap = await getDocs(q);
    snap.forEach(docSnap => {
      const d = docSnap.data();
      if (d.code === code) found = d;
    });
    if (!found) { errorDiv.textContent = 'Party not found.'; return; }
    // Show preview
    let leaderName = 'Unknown';
    if (found.members && found.leader) {
      const leader = found.members.find(m => m.uid === found.leader);
      if (leader) leaderName = leader.name;
    }
    modal.querySelector('div').innerHTML = `
      <h3 style="margin-bottom:18px;color:var(--gold)">Join Party?</h3>
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:18px;">
        ${found.profilePic ? `<img src="${found.profilePic}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--gold);margin-bottom:8px;">` : ''}
        <div style="font-size:1.15em;font-weight:700;color:var(--gold)">${found.name ? found.name.replace(/</g,'&lt;').replace(/>/g,'&gt;') : '(No Name)'}</div>
        <div style="font-size:1em;color:var(--ash);margin-bottom:2px;">Leader: <span style="color:var(--gold)">${leaderName}</span></div>
        <div style="font-size:0.98em;color:var(--ash);margin-bottom:2px;">Code: <span style="font-family:monospace;letter-spacing:2px;">${found.code}</span></div>
      </div>
      <div id="party-join-error" style="color:#e05555;font-size:0.95em;margin-bottom:10px;min-height:22px"></div>
      <div style="display:flex;gap:18px;justify-content:center;width:100%">
        <button class="btn-primary" id="btn-party-code-join" style="padding:8px 22px;font-size:1.05em;">Join</button>
        <button class="btn-secondary" id="btn-party-code-cancel" style="padding:8px 22px;font-size:1.05em;">Cancel</button>
      </div>
    `;
    document.getElementById('btn-party-code-cancel').onclick = () => modal.remove();
    document.getElementById('btn-party-code-join').onclick = async () => {
      // Actually join
      try {
        console.debug('[JOIN DEBUG] Attempting to join party:', found);
        console.debug('[JOIN DEBUG] Current user:', _charData);
        if (_partyId) {
          document.getElementById('party-join-error').textContent = 'Already in a party.';
          console.warn('[JOIN DEBUG] Already in a party:', _partyId);
          return;
        }
        const partyDoc = doc(db, 'parties', found.id);
        await updateDoc(partyDoc, {
          members: arrayUnion({ uid: _charData.uid, name: _charData.name, avatar: _charData.avatarUrl, rank: _charData.rank || 'Wanderer', level: _charData.level || 1 })
        });
        _partyId = found.id;
        subscribeParty(_partyId);
        modal.remove();
        window.showToast('Joined party!', 'success');
        window._raidState = 'party';
        // Do NOT call showBossSelect here; let subscribeParty's Firestore snapshot update trigger UI rendering with up-to-date _party
      } catch(e) {
        document.getElementById('party-join-error').textContent = 'Failed to join party.';
        console.error('[JOIN DEBUG] Failed to join party:', e);
        if (e && e.message) {
          document.getElementById('party-join-error').textContent += ' ' + e.message;
        }
      }
    };
  };
  document.getElementById('party-code-input').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('btn-party-code-next').click(); };
};

window.goSolo = function() {
  _partyId = null; _party = null;
  if (_partyUnsub) _partyUnsub();
  _showPartyLoader('solo');
  setTimeout(() => { window._raidState = 'solo-boss'; window.showBossSelect(); window.showToast('Solo mode selected.', 'info'); }, 900);
};

// Show boss selection UI (with party info)
window.showBossSelect = function() {
  const ui = document.getElementById('boss-raid-ui');
  if (!ui) return;

  if (!window._raidState || window._raidState === 'init') {
    ui.innerHTML = `
      <div class="raid-setup-card">
        <div class="raid-setup-title">⚔️ Boss Raid</div>
        <p class="raid-setup-desc">Gather your party and face a mighty boss. Higher stakes, greater glory.</p>
        <div class="raid-setup-options">
          <button class="raid-option-btn raid-option-primary" onclick="window.createParty().then(()=>{window._raidState='party';window.showBossSelect();})">
            <span class="raid-option-icon">🛡️</span>
            <span class="raid-option-label">Create a Party</span>
            <span class="raid-option-sub">You become leader · 5,000 gold</span>
          </button>
          <button class="raid-option-btn" onclick="window.showJoinPartyModal()">
            <span class="raid-option-icon">🤝</span>
            <span class="raid-option-label">Join Party</span>
            <span class="raid-option-sub">Enter a party code</span>
          </button>
          <button class="raid-option-btn" onclick="window.enterParty()">
            <span class="raid-option-icon">🚪</span>
            <span class="raid-option-label">Enter My Party</span>
            <span class="raid-option-sub">Rejoin existing party</span>
          </button>
          <button class="raid-option-btn" onclick="window.goSolo()">
            <span class="raid-option-icon">💀</span>
            <span class="raid-option-label">Go Solo</span>
            <span class="raid-option-sub">Follower+ · 20,000 gold</span>
          </button>
        </div>
      </div>`;
    ui.style.display = 'block';
    return;
  }

  if (window._raidState === 'party' || window._raidState === 'join' || window._raidState === 'enter') {
    ui.innerHTML = `
      <div class="party-page">
        <div class="party-page-back">
          <button class="btn-secondary party-back-btn" onclick="window._raidState='init';window.showBossSelect()">← Back</button>
        </div>
        <div id="party-ui"></div>
        <div id="party-start-raid-slot"></div>
      </div>`;
    window.renderPartyUI();
    ui.style.display = 'block';
    return;
  }

  if (window._raidState === 'choose-boss' || window._raidState === 'solo-boss') {
    let html = `<div class="raid-setup-card">
      <button class="btn-secondary" style="align-self:flex-start;margin-bottom:16px;width:auto;padding:6px 16px" onclick="window._raidState='party';window.showBossSelect()">← Back</button>
      <div class="raid-setup-title">Choose a Boss</div>
      <div class="boss-select-grid">`;
    BOSS_LIST.forEach(boss => {
      const isLeader = _party?.leader === _uid;
      const bossImgHtml = boss.imageUrl
        ? `<img class="boss-img" src="${boss.imageUrl}" alt="${boss.name}" loading="lazy"/>`
        : `<div class="boss-select-emoji">${boss.icon || "👹"}</div>`;
      const abilityNames = boss.abilities.map(a => typeof a === 'object' ? (a.name || '—') : String(a));
      html += `<div class="boss-select-card">
        ${bossImgHtml}
        <div class="boss-select-body">
          <div class="boss-select-name">${boss.name}</div>
          <div class="boss-select-desc">${boss.desc}</div>
          <div class="boss-select-abilities"><b>Abilities:</b><ul>${abilityNames.map(a=>`<li>${a}</li>`).join('')}</ul></div>
        </div>
        <div class="boss-select-footer">
          <button class="btn-primary" style="width:100%" onclick="${isLeader ? `window.tryStartBossRaid('${boss.id}')` : ''}" ${!isLeader ? 'disabled' : ''}>⚔️ Fight</button>
        </div>
      </div>`;
    });
    html += `</div>
      <p style="margin-top:18px;font-size:0.85rem;color:var(--text-dim);text-align:center">Party required: 3+ players · Solo requires Follower+ rank and 20,000 gold</p>
    </div>`;
    ui.innerHTML = html;
    ui.style.display = 'block';
    return;
  }
};

// Try to start boss raid (enforce requirements)
window.tryStartBossRaid = function(bossId) {
  console.log('[FIGHT BUTTON] tryStartBossRaid called');
  const boss = BOSS_LIST.find(b => b.id === bossId);
  console.debug('[FIGHT BUTTON DEBUG] Clicked Fight:', { bossId, boss, _party, _partyId });
  if (!boss) return window.showToast('Boss not found', 'error');
  const char = window._charData;
  let party = (_party && Array.isArray(_party.members)) ? _party.members : [char];
  // Only leader can start the raid
  if (_party && _party.leader !== _uid) {
    return window.showToast('Only the party leader can start the raid.', 'error');
  }
  if (isValidParty(party)) {
    // Instead of starting the raid locally, update Firestore so all members are pulled in
    _showPartyLoader('raid');
    updateDoc(doc(db, 'parties', _partyId), {
      raid: {
        active: true,
        bossId: boss.id,
        startedAt: Date.now()
      }
    })
    .then(() => {
      console.debug('[FIGHT BUTTON DEBUG] Firestore raid update success');
    })
    .catch(e => {
      console.error('[FIGHT BUTTON DEBUG] Firestore raid update error:', e);
    });
    // The Firestore snapshot in subscribeParty will trigger startBossRaid for all members
    return;
  }
  if (canSoloBoss(char)) {
    _showPartyLoader('raid');
    updateDoc(doc(db, "characters", _uid), { gold: (char.gold || 0) - 20000 }).then(() => {
      char.gold -= 20000;
      window.showToast('20,000 gold paid for solo raid.', 'info');
      setTimeout(() => window.startBossRaid([char], boss), 800);
    }).catch(() => { window.showToast('Failed to deduct gold. Try again.', 'error'); window.showBossSelect(); });
    return;
  }
  if (getRankIdx(char.rank) < 1) { window.showToast('Solo boss raids require Follower rank or higher.', 'error'); return; }
  if ((char.gold || 0) < 20000) { window.showToast('Not enough gold for solo boss raid (20,000 required).', 'error'); return; }
  window.showToast('You need a party of 5+ or meet solo requirements.', 'error');
};
//  EQUIPMENT STAT BONUSES
// ═══════════════════════════════════════════════════
const EQUIP_WEAPON_STATS = {
  // E-GRADE
  "Rusted Greatsword":{str:7}, "Crude Bow":{dex:6}, "Iron Dagger":{dex:5}, "Apprentice Wand":{int:8},
  "Shortblade":{str:6}, "Bone Mace":{str:7}, "Hunter Knife":{dex:6}, "Quartz Rod":{int:9},
  "Tin Blade":{str:5}, "Feather Knife":{dex:6},
  // D-GRADE
  "Obsidian Greatsword":{str:14,dex:5}, "Silver Wand":{int:12,dex:6}, "Longbow":{dex:13,str:5},
  "Twin Daggers":{dex:11,str:6}, "Warhammer":{str:15,def:4}, "Arc Rod":{int:14,str:5},
  "Bronze Blade":{str:13,dex:6}, "Hunter Bow":{dex:12,int:5}, "Spiked Mace":{str:14,dex:5},
  "Mystic Knife":{dex:13,int:6},
  // C-GRADE
  "Silver Greatsword":{str:25,dex:8}, "Arcane Staff":{int:28,dex:10}, "Composite Bow":{dex:26,str:9},
  "Assassin Daggers":{dex:27,int:8}, "Mystic Blade":{str:24,int:11}, "Spellknife":{dex:23,int:12},
  "Dagon Bow":{dex:25,str:9}, "Bronze Cleaver":{str:28,dex:7}, "Dark Rod":{int:29,str:6}, "War Maul":{str:30,dex:5},
  // B-GRADE
  "Myth-Blade":{str:48,dex:15}, "High-Scepter":{int:50,str:14}, "Draconic Bow":{dex:47,str:16},
  "Shadow-Strike":{dex:46,int:18}, "Warbreaker":{str:52,dex:10}, "Mystic Jian":{str:45,int:20},
  "Phantom Longbow":{dex:48,int:14}, "Spellhammer":{str:51,int:12}, "Venom Daggers":{dex:47,str:16},
  "Ancient Wand":{int:53,dex:10},
  // A-GRADE
  "Eragon-blade":{str:70,dex:20}, "Void-Steel":{str:75,def:15}, "Star Lance":{int:78,dex:18},
  "Crack":{dex:68,int:22}, "Divine Fall":{str:72,int:20}, "Nether-Bow":{dex:69,str:19},
  "Holy Relic":{int:77,str:16}, "Realm Cleaver":{str:74,dex:18}, "BeastFang":{dex:71,str:20},
  "Scion":{str:73,int:17},
  // S-GRADE
  "Abjuration":{str:100,dex:40,int:30}, "Genesis":{int:100,str:35,dex:35}, "Longinus":{dex:100,str:40,int:25},
  "Jingu Bang":{dex:100,int:45,str:20}, "Ragnarok":{str:100,dex:30,int:30}, "Godslayer":{int:100,str:30,dex:30},
  "Durandal":{str:100,dex:35,int:20}, "Excalibur":{str:100,int:25,dex:35}, "Bane":{dex:100,int:35,str:25},
  "Judgment":{int:100,str:30,dex:30},
};
const EQUIP_ARMOR_STATS = {
  // E-GRADE
  "Leather Vest":{def:6}, "Iron Plate":{def:8}, "Bone Armor":{def:7}, "Fur Coat":{def:5},
  "Hide Armor":{def:6}, "Feather Cloak":{def:5}, "Tin Armor":{def:7}, "Copper Plate":{def:6},
  "Marble Guard":{def:8}, "Obsidian Layer":{def:9},
  // D-GRADE
  "Steel Armor":{def:15,hp:7}, "Reinforced Leather":{def:13,hp:6}, "Silver Guard":{def:14,hp:7},
  "Bone Plate":{def:16,hp:8}, "Fur Armor":{def:12,hp:6}, "Horned Armor":{def:17,hp:9},
  "Scale Vest":{def:15,hp:7}, "Bronze Armor":{def:16,hp:8}, "Obsidian Plate":{def:18,hp:9},
  "Marble Armor":{def:14,hp:6},
  // C-GRADE
  "Shining Armor":{def:30,hp:15}, "Bronze Cuirass":{def:32,hp:18}, "Jagged Chainmail":{def:28,hp:14},
  "Bone Fortress":{def:31,hp:16}, "Obsidian Vest":{def:33,hp:17}, "Reptilian Scale":{def:29,hp:14},
  "Shadow Cloak":{def:27,hp:13}, "Golden Cape":{def:26,hp:12}, "Warlord Hide":{def:30,hp:15},
  "Arcane Shell":{def:34,hp:19},
  // B-GRADE
  "Void-Spell Armor":{def:50,hp:30}, "Golden Scales":{def:48,hp:25}, "Night Cloak":{def:45,hp:28},
  "Spirit-Ward":{def:52,hp:35}, "Paladin's Mantle":{def:44,hp:24}, "Draconic Robe":{def:49,hp:27},
  "Titanic Hide":{def:54,hp:39}, "Golden Warplate":{def:53,hp:36}, "Mythic Cuirass":{def:46,hp:26},
  "Quintessence Mantle":{def:51,hp:33},
  // A-GRADE
  "Heart Hide":{def:75,hp:55}, "Destroyer Mantle":{def:79,hp:59}, "Chaos-garb":{def:68,hp:47},
  "Devastator Armor":{def:66,hp:45}, "Tectonic-Mail":{def:72,hp:50}, "Elemental Shroud":{def:74,hp:52},
  "Colossal Veil":{def:78,hp:58}, "Realm-Bound Tunic":{def:70,hp:49}, "Serpentine-Robe":{def:65,hp:44},
  "Vasto-Shell":{def:76,hp:54},
  // S-GRADE
  "Saturn":{def:100,hp:80}, "Unshadowed":{def:100,hp:70}, "Null":{def:100,hp:78},
  "Dominion":{def:100,hp:80}, "Godshroud":{def:100,hp:68}, "Oblivion":{def:100,hp:75},
  "Gungnir":{def:100,hp:76}, "Imperium":{def:100,hp:79}, "Worldshell":{def:100,hp:74},
  "Eternity":{def:100,hp:77},
};

function getRaceEquipBonus(race) {
  // Spec: Dwarf +10% gear stats, Titan (ascended Dwarf) +20%
  if (!race) return 0;
  const r = race.toLowerCase();
  if (r.includes('titan'))  return 0.20;  // Dwarf ascension
  if (r.includes('dwarf'))  return 0.10;
  return 0;
}

function _getRaceExpMult(race) {
  // Spec: Human +10% EXP, Sage (ascended Human) +20%
  if (!race) return 1;
  const r = race.toLowerCase();
  if (r.includes('sage'))  return 1.20;
  if (r.includes('human')) return 1.10;
  return 1;
}

function _getCompanionExpMult(companion) {
  // Spec: Whispling +10% EXP gain
  if (!companion) return 1;
  return companion.toLowerCase() === 'whispling' ? 1.10 : 1;
}

function _getLuckMult(charData) {
  // Returns luck multiplier from active luck potion buff
  const buff = charData?.luckBuff;
  if (!buff || !buff.expiry || Date.now() > buff.expiry) return 1;
  return 1 + (buff.pct / 100);
}

function _getExpBuffMult(charData) {
  // Returns EXP gain multiplier from active EXP potion buff
  const buff = charData?.expBuff;
  if (!buff || !buff.expiry || Date.now() > buff.expiry) return 1;
  return 1 + (buff.pct / 100);
}
// ═══════════════════════════════════════════════════
//  EQUIPMENT NAME LISTS (for accurate filtering)
// ═══════════════════════════════════════════════════
const ALL_WEAPON_NAMES = [
  // E-GRADE
  "Rusted Greatsword","Crude Bow","Iron Dagger","Apprentice Wand","Shortblade","Bone Mace","Hunter Knife","Quartz Rod","Tin Blade","Feather Knife",
  // D-GRADE
  "Obsidian Greatsword","Silver Wand","Longbow","Twin Daggers","Warhammer","Arc Rod","Bronze Blade","Hunter Bow","Spiked Mace","Mystic Knife",
  // C-GRADE
  "Silver Greatsword","Arcane Staff","Composite Bow","Assassin Daggers","Mystic Blade","War Maul","Spellknife","Dagon Bow","Bronze Cleaver","Dark Rod",
  // B-GRADE
  "Myth-Blade","High-Scepter","Draconic Bow","Shadow-Strike","Warbreaker","Mystic Jian","Phantom Longbow","Spellhammer","Venom Daggers","Ancient Wand",
  // A-GRADE
  "Eragon-blade","Void-Steel","Star Lance","Crack","Divine Fall","Nether-Bow","Holy Relic","Realm Cleaver","BeastFang","Scion",
  // S-GRADE
  "Abjuration","Genesis","Longinus","Jingu Bang","Ragnarok","Godslayer","Durandal","Excalibur","Bane","Judgment"
];
const ALL_ARMOR_NAMES = [
  // E-GRADE
  "Leather Vest","Iron Plate","Bone Armor","Fur Coat","Hide Armor","Feather Cloak","Tin Armor","Copper Plate","Marble Guard","Obsidian Layer",
  // D-GRADE
  "Steel Armor","Reinforced Leather","Silver Guard","Bone Plate","Fur Armor","Horned Armor","Scale Vest","Bronze Armor","Obsidian Plate","Marble Armor",
  // C-GRADE
  "Shining Armor","Bronze Cuirass","Jagged Chainmail","Bone Fortress","Obsidian Vest","Reptilian Scale","Shadow Cloak","Golden Cape","Warlord Hide","Arcane Shell",
  // B-GRADE
  "Void-Spell Armor","Golden Scales","Night Cloak","Spirit-Ward","Paladin's Mantle","Draconic Robe","Titanic Hide","Golden Warplate","Mythic Cuirass","Quintessence Mantle",
  // A-GRADE
  "Heart Hide","Destroyer Mantle","Chaos-garb","Devastator Armor","Tectonic-Mail","Elemental Shroud","Colossal Veil","Realm-Bound Tunic","Serpentine-Robe","Vasto-Shell",
  // S-GRADE
  "Saturn","Unshadowed","Null","Dominion","Godshroud","Oblivion","Gungnir","Imperium","Worldshell","Eternity"
];

// ═══════════════════════════════════════════════════
//  SHARED GRADE RESOLVER
//  _resolveEquipGrade(name) → 'E'|'D'|'C'|'B'|'A'|'S'
//
//  Priority order:
//    1. CANONICAL_EQUIP_RECIPES (authoritative, covers crafted + reward items)
//    2. ALL_WEAPON_NAMES / ALL_ARMOR_NAMES positional lookup (10 items per tier)
//    3. Falls back to 'E' (never returns 'D' as a silent default)
//
//  Use this everywhere item.grade may be missing — deity bestowals,
//  quest rewards, drop loot, trades — so the market bracket is always correct.
// ═══════════════════════════════════════════════════
window._resolveEquipGrade = function(name) {
  if (!name) return 'E';
  const baseName = name.replace(/\s*\+\d+$/, '');

  // 1. CANONICAL_EQUIP_RECIPES is the gold source — covers every craftable item
  //    AND all S-grade weapons/armors (which are also in there with cost 2800000)
  if (window.CANONICAL_EQUIP_RECIPES) {
    for (const [g, items] of Object.entries(window.CANONICAL_EQUIP_RECIPES)) {
      if (items.find(i => i.name === baseName)) return g;
    }
  }

  // 2. Positional lookup via ALL_WEAPON_NAMES / ALL_ARMOR_NAMES
  //    Each grade band is exactly 10 items, grades E→D→C→B→A→S
  const GRADE_ORDER = ['E','D','C','B','A','S'];
  const wIdx = ALL_WEAPON_NAMES.indexOf(baseName);
  if (wIdx !== -1) return GRADE_ORDER[Math.floor(wIdx / 10)] || 'E';
  const aIdx = ALL_ARMOR_NAMES.indexOf(baseName);
  if (aIdx !== -1) return GRADE_ORDER[Math.floor(aIdx / 10)] || 'E';

  return 'E';
};

// ═══════════════════════════════════════════════════
//  EQUIP MODAL LOGIC
// ═══════════════════════════════════════════════════


// ── Equipment panel renderer ──────────────────────────────────────────────────
// Renders each equipped slot as its own card: icon, name, grade badge,
// enchant badge, base stats + enchant bonus.
// Cross-references window._allInvItems by base name to find enchantLevel/grade.
function _renderEquipPanel(charData) {
  const panel = document.getElementById('equip-panel');
  if (!panel) return;

  const inv = window._allInvItems || [];
  const gradeColour = { E:'#888', D:'#5dbe85', C:'#5b9fe0', B:'#c9a84c', A:'#e07060', S:'#b88fe0' };

  function resolveGrade(baseName) {
    const fromInv = inv.find(i => (i.name || '').replace(/\s*\+\d+$/, '') === baseName);
    if (fromInv?.grade) return fromInv.grade;
    if (window.ITEMS) {
      const found = window.ITEMS.find(i => i.name === baseName);
      if (found?.grade) return found.grade;
    }
    return 'E';
  }

  function makeSlotCard(slotLabel, slotType, itemName) {
    const isEmpty  = !itemName;
    const baseName = itemName ? itemName.replace(/\s*\+\d+$/, '') : '';

    // Find best enchanted match from inventory
    let enchantLevel = 0, invGrade = '';
    if (baseName) {
      const matches = inv
        .filter(i => (i.name || '').replace(/\s*\+\d+$/, '') === baseName)
        .sort((a, b) => (b.enchantLevel || 0) - (a.enchantLevel || 0));
      if (matches.length) { enchantLevel = matches[0].enchantLevel || 0; invGrade = matches[0].grade || ''; }
    }

    const grade    = invGrade || (baseName ? resolveGrade(baseName) : 'E');
    const gradeCol = gradeColour[grade] || '#888';
    const statsMap = slotType === 'weapon' ? EQUIP_WEAPON_STATS : EQUIP_ARMOR_STATS;
    const rawStats = baseName ? (statsMap[baseName] || {}) : {};
    const enchBonus = enchantLevel > 0 ? enchantLevel : 0;
    const statParts = Object.entries(rawStats).map(([k, v]) => {
      const label = k.toUpperCase();
      return enchBonus > 0
        ? `+${v}<span class="equip-item-enchant-bonus">+${enchBonus}</span> ${label}`
        : `+${v} ${label}`;
    });
    const statsHtml = statParts.length
      ? statParts.join(' &thinsp;·&thinsp; ')
      : (isEmpty ? '' : '<span style="color:var(--text-dim);font-style:italic">—</span>');

    const icon = baseName ? getItemIcon(baseName) : '—';
    const gradeBadge   = !isEmpty ? `<span class="equip-item-grade" style="color:${gradeCol};border-color:${gradeCol}33;background:${gradeCol}11">${grade}</span>` : '';
    const enchantBadge = enchantLevel > 0 ? `<span class="equip-item-enchant">✨ +${enchantLevel}</span>` : '';
    const displayName  = isEmpty
      ? `<span class="equip-item-name equip-item-none">— None —</span>`
      : `<span class="equip-item-name">${baseName}</span>`;

    return `
      <div class="equip-item-card${isEmpty ? ' equip-item-empty' : ''}">
        <div class="equip-item-slot-label">${slotLabel}</div>
        <div class="equip-item-row">
          <span class="equip-item-icon">${icon}</span>
          <div class="equip-item-info">
            <div class="equip-item-nameline">${displayName}${gradeBadge}${enchantBadge}</div>
            ${statsHtml ? `<div class="equip-item-stats">${statsHtml}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
            <button class="equip-item-change-btn" onclick="openEquipModal('${slotType}')">Change</button>
            ${!isEmpty ? `<button class="equip-item-unequip-btn" onclick="unequipSlot('${slotType}')">Remove</button>` : ''}
          </div>
        </div>
      </div>`;
  }

  panel.innerHTML =
    makeSlotCard('WEAPON', 'weapon', charData.equipment?.weapon || '') +
    makeSlotCard('ARMOR',  'armor',  charData.equipment?.armor  || '');
}

window.openEquipModal = function(type) {
  const modal = document.getElementById('equip-modal');
  const list  = document.getElementById('equip-modal-list');
  const title = document.getElementById('equip-modal-title');
  const btn   = document.getElementById('btn-equip-confirm');
  const error = document.getElementById('equip-modal-error');
  let selected = null;
  error.textContent = '';
  btn.disabled = true;
  btn.onclick  = null;

  // Use getItemType (keyword-based, works on enchanted names like "Iron Dagger +2")
  // then cross-check the correct slot via ALL_WEAPON_NAMES / ALL_ARMOR_NAMES on base name.
  const inv = window._allInvItems || [];
  const nameList     = type === 'weapon' ? ALL_WEAPON_NAMES : ALL_ARMOR_NAMES;
  const currentEquipFull = (window._charData?.equipment?.[type] || '').trim();
  // Filter valid slot items, exclude the exact currently equipped item only
  const rawFiltered = inv.filter(i => {
    if (getItemType(i.name) !== 'equipment') return false;
    const base = (i.name || '').replace(/\s*\+\d+$/, '').trim();
    if (!nameList.includes(base)) return false;
    if (currentEquipFull && i.name === currentEquipFull) return false;
    return true;
  });
  // Deduplicate — one entry per base name, keeping the highest enchant level
  const _seenBases = new Map();
  rawFiltered.forEach(i => {
    const base = (i.name || '').replace(/\s*\+\d+$/, '').trim();
    const lvl  = i.enchantLevel || parseInt((i.name || '').match(/\+(\d+)$/)?.[1] || '0');
    const prev = _seenBases.get(base);
    const prevLvl = prev ? (prev.enchantLevel || parseInt((prev.name || '').match(/\+(\d+)$/)?.[1] || '0')) : -1;
    if (!prev || lvl > prevLvl) _seenBases.set(base, i);
  });
  const filtered = Array.from(_seenBases.values());

  title.textContent = type === 'weapon' ? 'Equip Weapon' : 'Equip Armor';

  if (filtered.length === 0) {
    list.innerHTML = `<div class="equip-modal-empty">No ${type === 'weapon' ? 'weapons' : 'armor'} in inventory.</div>`;
    btn.disabled = true;
    modal.style.display = 'flex';
    return;
  }

  list.innerHTML = filtered.map((item, idx) => {
    const baseName = (item.name || '').replace(/\s*\+\d+$/, '');
    // enchantLevel may be a dedicated field OR baked into the name as "+N"
    const nameMatch  = (item.name || '').match(/\+(\d+)$/);
    const enchantLevel = item.enchantLevel || (nameMatch ? parseInt(nameMatch[1]) : 0);
    const enchantBadge = enchantLevel > 0
      ? `<span class="equip-modal-enchant-badge">✨ +${enchantLevel}</span>`
      : '';
    const gradeColor = { E:'#8a8a8a', D:'#4fc870', C:'#5b9fe0', B:'#c9a84c', A:'#b07fff', S:'#ff6b6b' }[item.grade] || 'var(--text-dim)';
    const gradeBadge = item.grade
      ? `<span class="equip-modal-grade-badge" style="color:${gradeColor};border-color:${gradeColor}44">${item.grade}</span>`
      : '';
    const qty = (item.qty && item.qty > 1) ? `<span class="equip-modal-qty">×${item.qty}</span>` : '';
    return `<div class="equip-modal-item" data-idx="${idx}" tabindex="0">
      <span class="equip-modal-icon">${getItemIcon(baseName)}</span>
      <span class="equip-modal-name">${baseName}${gradeBadge}${enchantBadge}</span>
      ${qty}
    </div>`;
  }).join('');

  // Selection logic
  Array.from(list.children).forEach((el, idx) => {
    el.onclick    = () => select(idx);
    el.onkeydown  = (e) => { if (e.key === 'Enter' || e.key === ' ') select(idx); };
  });
  function select(idx) {
    selected = filtered[idx];
    Array.from(list.children).forEach((el, i) => {
      el.classList.toggle('equip-modal-item-selected', i === idx);
    });
    btn.disabled = false;
  }

  btn.onclick = async () => {
    if (!selected) return;
    btn.disabled = true;
    error.textContent = '';
    try {
      const charRef   = doc(db, "characters", _uid);
      const field     = type === 'weapon' ? 'equipment.weapon' : 'equipment.armor';
      // Always store the base name — enchant level lives on the inventory item, not the equipment slot
      const storeName = (selected.name || '').replace(/\s*\+\d+$/, '').trim();

      // Capture stat snapshot BEFORE equipping
      const c         = window._charData || {};
      const oldEquip  = c.equipment?.[type] || '';
      const statsMap  = type === 'weapon' ? EQUIP_WEAPON_STATS : EQUIP_ARMOR_STATS;
      const oldBase   = oldEquip.replace(/\s*\+\d+$/, '').trim();
      const newBase   = storeName.replace(/\s*\+\d+$/, '').trim();
      const oldStats  = oldBase ? (statsMap[oldBase] || {}) : {};
      const newStats  = statsMap[newBase] || {};
      const racePct   = getRaceEquipBonus(c.race);
      const diff      = {};
      const allKeys   = new Set([...Object.keys(oldStats), ...Object.keys(newStats)]);
      allKeys.forEach(k => {
        const before = Math.round((oldStats[k] || 0) * (1 + racePct));
        const after  = Math.round((newStats[k] || 0) * (1 + racePct));
        if (after - before !== 0) diff[k] = after - before;
      });

      await updateDoc(charRef, { [field]: storeName });
      if (window._charData) {
        if (!window._charData.equipment) window._charData.equipment = {};
        window._charData.equipment[type] = storeName;
      }
      _renderEquipPanel(window._charData || {});
      populateDashboard(window._charData);   // ← refresh character panel stats
      closeEquipModal();

      // Show stat-boost overlay — always show full new stats + net change vs old gear
      const nameMatch   = (selected.name || '').match(/\+(\d+)$/);
      const lvl         = selected.enchantLevel || (nameMatch ? parseInt(nameMatch[1]) : 0);
      const displayName = lvl ? `${storeName} +${lvl}` : storeName;
      const overlay     = document.getElementById('equip-boost-overlay');
      const statLabels  = { str:'STR', int:'INT', def:'DEF', dex:'DEX', hp:'HP' };
      if (overlay) {
        document.getElementById('equip-boost-title').textContent =
          type === 'weapon' ? '⚔️ Weapon Equipped!' : '🛡️ Armor Equipped!';
        document.getElementById('equip-boost-name').textContent = displayName;
        // Show each stat with its full value and the net change vs previous gear
        const statEntries = Object.entries(newStats);
        if (statEntries.length > 0) {
          document.getElementById('equip-boost-stats').innerHTML = statEntries
            .map(([k, v]) => {
              const boosted  = Math.round(v * (1 + racePct));
              const deltaVal = diff[k] || boosted; // if no old gear, full value is the gain
              const cls      = k === 'hp' ? 'stat-hp' : k === 'def' ? 'stat-def' : '';
              const sign     = deltaVal > 0 ? '+' : '';
              const deltaHtml = `<span class="equip-boost-delta">(${sign}${deltaVal})</span>`;
              return `<span class="equip-boost-stat ${cls}">+${boosted} ${statLabels[k] || k.toUpperCase()} ${deltaHtml}</span>`;
            }).join('');
        } else {
          document.getElementById('equip-boost-stats').innerHTML =
            '<span style="color:var(--text-dim);font-size:0.8rem">No stat data found.</span>';
        }
        overlay.style.display = 'flex';
      } else {
        showToast(`${displayName} equipped!`, 'success');
      }
    } catch(e) {
      error.textContent = 'Failed to equip. Try again.';
      btn.disabled = false;
    }
  };

  modal.style.display = 'flex';
  setTimeout(() => list.querySelector('.equip-modal-item')?.focus(), 80);
};

window.closeEquipModal = function() {
  const m = document.getElementById('equip-modal');
  if (m) m.style.display = 'none';
};

window.unequipSlot = async function(type) {
  try {
    const field = type === 'weapon' ? 'equipment.weapon' : 'equipment.armor';
    await updateDoc(doc(db, 'characters', _uid), { [field]: '' });
    if (window._charData) {
      if (!window._charData.equipment) window._charData.equipment = {};
      window._charData.equipment[type] = '';
    }
    _renderEquipPanel(window._charData || {});
    populateDashboard(window._charData);
    showToast(type === 'weapon' ? 'Weapon unequipped.' : 'Armor unequipped.', 'info');
  } catch(e) {
    showToast('Failed to unequip. Try again.', 'error');
  }
};
// ═══════════════════════════════════════════════════
//  FORGE OF LEGENDS — Dashboard Logic  (Phase A + B)
//  js/dashboard.js
// ═══════════════════════════════════════════════════

// Render Quests Panel: Only Daily and Story Quests
window.renderQuestsPanel = function() {
  // Daily Quests
  const dailyList = document.getElementById('daily-quest-list');
  if (dailyList) {
    // Assume daily quests are static in HTML for now
  }
  // Story Quests
  const storyList = document.getElementById('story-quests-list');
  if (storyList) {
    storyList.innerHTML = '';
    const storyQuests = (_charData?.storyQuests || []);
    if (storyQuests.length === 0) {
      storyList.innerHTML = '<div class="story-quest-empty">No story quests yet.</div>';
    } else {
      storyQuests.forEach(q => {
        const el = document.createElement('div');
        el.className = 'story-quest-item';
        el.innerHTML = `<div class="story-quest-title">${q.title}</div><div class="story-quest-desc">${q.desc||''}</div><div class="story-quest-reward">${q.reward||''}</div>`;
        storyList.appendChild(el);
      });
    }
  }
};

// Render Faction Quests in Faction Panel
let _factionQuestsUnsub = null;
let _factionQuestSubUnsub = null;
let _lastFactionListener = null;
window.renderFactionQuestsPanel = function(force) {
  const factionList = document.getElementById('faction-quests-list');
  if (!factionList) return;
  factionList.innerHTML = '';
  const playerFaction = _charData?.faction || _charData?.factionName || null;
  if (!playerFaction) {
    const card = document.createElement('div');
    card.className = 'faction-quest-item faction-quest-empty';
    card.style.border = '1px solid var(--border)';
    card.style.background = 'var(--ink2)';
    card.style.padding = '18px 20px';
    card.style.margin = '10px 0';
    card.style.borderRadius = '12px';
    card.style.textAlign = 'center';
    card.textContent = 'Join a faction to see available faction quests.';
    factionList.appendChild(card);
    // Unsubscribe listeners if not in a faction
    if (_factionQuestsUnsub) { _factionQuestsUnsub(); _factionQuestsUnsub = null; }
    if (_factionQuestSubUnsub) { _factionQuestSubUnsub(); _factionQuestSubUnsub = null; }
    _lastFactionListener = null;
    window._knownFactionQuestIds = null; // reset so next subscription seeds correctly
    return;
  }
  // Only re-setup listeners if faction changed or forced
  if (_lastFactionListener !== playerFaction || force) {
    if (_factionQuestsUnsub) { _factionQuestsUnsub(); _factionQuestsUnsub = null; }
    if (_factionQuestSubUnsub) { _factionQuestSubUnsub(); _factionQuestSubUnsub = null; }
    _lastFactionListener = playerFaction;
    window._knownFactionQuestIds = null; // reset so re-subscription seeds correctly
    // Show loader
    const loader = document.createElement('div');
    loader.className = 'faction-quest-loader';
    loader.innerHTML = `<span class=\"gold-spinner\"></span><span style=\"font-size:1.08em;color:var(--gold-dim);vertical-align:middle\">Loading faction quests...</span>`;
    factionList.appendChild(loader);
    // Listen for faction quests
    const q = query(collection(db, 'factionMissions'), where('faction', '==', playerFaction), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(20));
    _factionQuestsUnsub = onSnapshot(q, snap => {
      window._lastFactionQuestSnap = snap; // store for title lookups in submit modal
      // Seed known-IDs on very first fire (even if empty) so subsequent additions notify correctly
      if (window._knownFactionQuestIds === null) {
        window._knownFactionQuestIds = new Set(snap.docs.map(d => d.id));
      }
      if (loader.parentNode) loader.remove();
      Array.from(factionList.children).forEach((el, idx) => { if (idx > 0) el.remove(); });
      if (snap.empty) {
        const card = document.createElement('div');
        card.className = 'faction-quest-item faction-quest-empty';
        card.style.border = '1px solid var(--border)';
        card.style.background = 'var(--ink2)';
        card.style.padding = '18px 20px';
        card.style.margin = '10px 0';
        card.style.borderRadius = '12px';
        card.style.textAlign = 'center';
        card.textContent = 'No faction quests currently available.';
        factionList.appendChild(card);
        // Unsubscribe submission listener if no quests
        if (_factionQuestSubUnsub) { _factionQuestSubUnsub(); _factionQuestSubUnsub = null; }
        return;
      }
      // Setup submission status listener for these quests
      const questIds = snap.docs.map(docSnap => docSnap.id);

      // Notify player about newly posted faction quests
      // _knownFactionQuestIds is already seeded above, so any 'added' change not in the set is genuinely new
      if (_uid) {
        snap.docChanges().forEach(change => {
          if (change.type !== 'added') return;
          const id = change.doc.id;
          if (window._knownFactionQuestIds.has(id)) return;
          window._knownFactionQuestIds.add(id);
          const d = change.doc.data();
          if (d.status !== 'active') return;
          const rewardParts = [];
          if (d.reward?.gold) rewardParts.push('\uD83E\uDE99 ' + d.reward.gold + ' gold');
          if (d.reward?.exp)  rewardParts.push('\u2728 ' + d.reward.exp + ' EXP');
          const rewardStr = rewardParts.length ? ' — Reward: ' + rewardParts.join(' · ') : '';
          addDoc(collection(db, 'notifications'), {
            uid: _uid,
            message: '\uD83D\uDEE1\uFE0F <b>New Faction Quest:</b> <b>' + d.title + '</b> has been posted for your faction!' + rewardStr,
            read: false,
            type: 'quest-new-faction',
            timestamp: serverTimestamp(),
          }).catch(e => console.warn('Faction quest notification failed:', e));
        });
      }


      if (_factionQuestSubUnsub) { _factionQuestSubUnsub(); _factionQuestSubUnsub = null; }
      if (questIds.length) {
        const fqQuery = query(collection(db, 'factionQuestSubmissions'), where('uid', '==', _uid), where('questId', 'in', questIds));
        _factionQuestSubUnsub = onSnapshot(fqQuery, subSnap => {
          window._factionQuestSubmissions = {};
          if (!window._factionQuestDone) window._factionQuestDone = {};
          subSnap.forEach(d => {
            const data = d.data();
            window._factionQuestSubmissions[data.questId] = data.status;
            // Guard uses BOTH:
            // 1. data.rewarded — persisted on the submission doc; survives reloads
            // 2. _factionQuestDone[questId] — in-memory flag for same-session double-fire
            if (data.status === 'approved' && !data.rewarded && !window._factionQuestDone[data.questId]) {
              const quest = snap.docs.find(doc => doc.id === data.questId)?.data();
              if (quest) {
                // Await the flag write — only apply reward if it succeeds.
                // If it fails (network/rules), we skip this cycle; the next
                // listener fire will retry cleanly with no duplicate risk.
                updateDoc(d.ref, { rewarded: true })
                  .then(() => {
                    window._factionQuestDone[data.questId] = true;
                    // Deliver ALL reward items, not just the first
                    if (quest.reward?.items?.length > 1) {
                      _applyRewardMulti(quest.reward?.exp||0, quest.reward?.gold||0, quest.reward.items);
                    } else {
                      _applyReward(quest.reward?.exp||0, quest.reward?.gold||0, (quest.reward?.items?.[0]||null));
                    }
                    window.showToast(`✅ Faction Quest complete: ${quest.title}! +${quest.reward?.gold||0} gold · +${quest.reward?.exp||0} EXP`, "success");
                  })
                  .catch(e => console.warn('[Quest] Could not mark rewarded, skipping reward this cycle:', e));
              }
            }
          });
          // Only update DOM, do not re-call renderFactionQuestsPanel
          renderFactionQuestItems(snap, factionList);
        });
      } else {
        if (_factionQuestSubUnsub) { _factionQuestSubUnsub(); _factionQuestSubUnsub = null; }
        window._factionQuestSubmissions = {};
        renderFactionQuestItems(snap, factionList);
      }
      // Initial render removed — handled inside submission listener to avoid duplicates
    });
  } else {
    // If listeners already set, just update DOM with latest data
    // (Assume window._factionQuestSubmissions is up to date)
    if (_factionQuestsUnsub) {
      // Use last snap if available (not stored, so force re-render)
      // For now, just force reload
      window.renderFactionQuestsPanel(true);
    }
  }
};

// Dismissed faction quest submission IDs (approved/rejected cards player has cleared)
if (!window._dismissedFactionQuests) {
  try {
    const _fqSaved = JSON.parse(localStorage.getItem('dismissedFactionQuests') || '[]');
    window._dismissedFactionQuests = new Set(_fqSaved);
  } catch(e) { window._dismissedFactionQuests = new Set(); }
}

window._dismissFactionQuest = function(questId) {
  window._dismissedFactionQuests.add(questId);
  try { localStorage.setItem('dismissedFactionQuests', JSON.stringify([...window._dismissedFactionQuests])); } catch(e) {}
  // Re-render by firing the items wrap update directly from last snap data
  const wrap = document.querySelector('#faction-quests-list .fq-items-wrap');
  if (wrap) {
    const card = document.getElementById('fq-card-' + questId);
    if (card) card.remove();
  }
};

function renderFactionQuestItems(snap, factionList) {
  // Use a dedicated inner wrapper so we can wipe it completely — no fragile index logic
  let itemsWrap = factionList.querySelector('.fq-items-wrap');
  if (!itemsWrap) {
    itemsWrap = document.createElement('div');
    itemsWrap.className = 'fq-items-wrap';
    factionList.appendChild(itemsWrap);
  }
  itemsWrap.innerHTML = ''; // full clear — no duplicates possible

  if (snap.empty) {
    itemsWrap.innerHTML = `<div class="faction-quest-item faction-quest-empty" style="border:1px solid var(--border);background:var(--ink2);padding:18px 20px;margin:10px 0;border-radius:12px;text-align:center">No faction quests currently available.</div>`;
    return;
  }

  const _fqNow = Date.now();
  snap.forEach(docSnap => {
    // Skip cards the player has dismissed
    if (window._dismissedFactionQuests?.has(docSnap.id)) return;
    const q = docSnap.data();
    // ── Expiry check ──────────────────────────────────────────────────────────
    const fqExpiresAt  = q.expiresAt?.toDate?.() || null;
    const fqIsExpired  = fqExpiresAt && fqExpiresAt.getTime() < _fqNow;
    const fqIsClosed   = q.status === 'closed' || fqIsExpired;
    if (fqIsClosed) return; // hide expired/closed quests from the player list entirely
    // ─────────────────────────────────────────────────────────────────────────
    let rewardStr = '';
    if (q.reward) {
      const parts = [];
      if (q.reward.gold) parts.push(`🪙 ${q.reward.gold} gold`);
      if (q.reward.exp)  parts.push(`✨ ${q.reward.exp} exp`);
      if (Array.isArray(q.reward.items) && q.reward.items.length) {
        parts.push(q.reward.items.map(i => `${i.qty}x ${i.name}`).join(", "));
      }
      rewardStr = parts.length ? parts.join(' · ') : '—';
    } else if (typeof q.reward === 'string') {
      rewardStr = q.reward;
    } else {
      rewardStr = '—';
    }
    let descHtml = '';
    if (q.description) {
      descHtml = q.description.split(/\n+/).map(p => p ? `<p>${p}</p>` : '').join('');
    }
    const el = document.createElement('div');
    el.className = 'faction-quest-item';
    el.id = 'fq-card-' + docSnap.id;
    const subStatus    = window._factionQuestSubmissions?.[docSnap.id];
    const completionType = q.completionType || 'open';
    const completedBy    = q.completedBy || [];
    const alreadyDoneByMe = completedBy.some(c => c.uid === _uid);
    const lockedOut      = completionType === 'one_time' && completedBy.length > 0 && !alreadyDoneByMe;
    const _dismissBtn = `<button class="sq-delete-btn" title="Dismiss" style="margin-left:8px" onclick="window._dismissFactionQuest('${docSnap.id}')">✕ Dismiss</button>`;
    let submitHtml = '';
    if (lockedOut) {
      submitHtml = `<div class="sq-closed-note">🔒 This quest has already been claimed by another player.</div>`;
    } else if (subStatus === 'pending') {
      submitHtml = `<div class="sq-pending-note">⏳ Submitted, awaiting review…</div>`;
    } else if (subStatus === 'approved') {
      submitHtml = `<div class="sq-approved-note" style="display:flex;align-items:center;justify-content:space-between;gap:8px"><span>✅ Approved!</span>${_dismissBtn}</div>`;
    } else if (subStatus === 'rejected') {
      submitHtml = `<div class="sq-rejected-note" style="display:flex;align-items:center;justify-content:space-between;gap:8px"><span>✕ Rejected. <a href="#" onclick="window._submitFactionQuestForReview('${docSnap.id}',event)">Resubmit?</a></span>${_dismissBtn}</div>`;
    } else {
      submitHtml = `<button class="sq-submit-btn" onclick="window._submitFactionQuestForReview('${docSnap.id}',event)">📜 Submit</button>`;
    }
    const fqCtypeBadge = q.completionType === 'one_time'
      ? `<span class="sq-badge" style="background:rgba(160,60,60,0.2);color:#e09090;font-size:0.68rem;padding:2px 7px;border-radius:4px;margin-left:6px">🔒 One-time</span>`
      : '';
    let fqExpiryHtml = '';
    if (fqExpiresAt) {
      fqExpiryHtml = `<span class="sq-expiry" style="font-size:0.72rem;font-family:var(--font-mono);color:var(--text-dim);display:block;margin-top:4px">⏱ Expires ${fqExpiresAt.toLocaleString()}</span>`;
    }
    el.innerHTML = `<div class="faction-quest-title"><span class="faction-quest-bullet"></span>${q.title}${fqCtypeBadge}</div><div class="faction-quest-desc">${descHtml}</div><div class="faction-quest-reward">${rewardStr}</div>${fqExpiryHtml}<div class="faction-quest-submit-row">${submitHtml}</div>`;
    itemsWrap.appendChild(el);
  });
}
// Faction Quest Submission Modal & Logic
window._submitFactionQuestForReview = async function(questId, evt) {
  if (evt) evt.preventDefault?.();
  if (!_uid || !_charData) return;
  // ── Dead player restriction ───────────────────────────────────────────────
  if (_charData.isDead) {
    window.showToast("☠️ You are dead. You cannot submit quests.", "error"); return;
  }
  // Look up title from the stored faction quest snapshot
  const _fqDoc = window._lastFactionQuestSnap?.docs?.find(d => d.id === questId);
  const questTitle = _fqDoc?.data()?.title || 'Faction Quest';
  const existing = window._factionQuestSubmissions?.[questId];
  if (existing === 'pending')   return window.showToast('Already submitted — awaiting approval.', 'info');
  if (existing === 'approved')  return window.showToast('Already approved!', 'info');

  document.getElementById('fq-submit-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'fq-submit-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
  modal.innerHTML = `
    <div style="background:var(--ink2);border-radius:14px;border:1px solid var(--border);max-width:480px;width:100%;padding:24px;box-shadow:0 8px 40px #0008;max-height:90vh;overflow-y:auto">
      <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--gold-dim);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Submit for Review</div>
      <div style="font-weight:700;font-size:1.05rem;color:var(--gold);margin-bottom:16px">${questTitle}</div>

      <div style="margin-bottom:12px">
        <label style="font-size:0.78rem;font-family:var(--font-mono);color:var(--text-dim);letter-spacing:0.05em;display:block;margin-bottom:5px">📍 WHERE did you complete this?</label>
        <input id="fq-proof-location" type="text" placeholder="e.g. Whitecrest Village" maxlength="80"
          style="width:100%;box-sizing:border-box;background:var(--ink3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-light);font-size:0.9rem;outline:none">
      </div>

      <div style="margin-bottom:12px">
        <label style="font-size:0.78rem;font-family:var(--font-mono);color:var(--text-dim);letter-spacing:0.05em;display:block;margin-bottom:5px">⚔️ WHAT did you do? (be specific)</label>
        <textarea id="fq-proof-what" rows="3" maxlength="400" placeholder="e.g. Traveled to Whitecrest at dusk, fought 4 Blood Wolves near the shrine..."
          style="width:100%;box-sizing:border-box;background:var(--ink3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-light);font-size:0.9rem;outline:none;resize:vertical;font-family:inherit"></textarea>
      </div>

      <div style="margin-bottom:16px">
        <label style="font-size:0.78rem;font-family:var(--font-mono);color:var(--text-dim);letter-spacing:0.05em;display:block;margin-bottom:5px">👥 WITNESSES (optional, other player names)</label>
        <input id="fq-proof-witnesses" type="text" placeholder="e.g. PlayerA, PlayerB" maxlength="120"
          style="width:100%;box-sizing:border-box;background:var(--ink3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-light);font-size:0.9rem;outline:none">
      </div>

      <div id="fq-submit-error" style="color:#c08080;font-size:0.82rem;margin-bottom:10px;display:none"></div>
      <div style="display:flex;gap:10px">
        <button id="fq-submit-confirm" class="sq-submit-btn" style="margin-top:0;flex:1">📜 Submit</button>
        <button onclick="document.getElementById('fq-submit-modal').remove()"
          style="flex:0 0 auto;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-dim);font-family:var(--font-mono);font-size:0.8rem;padding:8px 16px;cursor:pointer">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  document.getElementById('fq-submit-confirm').onclick = async () => {
    const location = document.getElementById('fq-proof-location').value.trim();
    const what     = document.getElementById('fq-proof-what').value.trim();
    const witnesses = document.getElementById('fq-proof-witnesses').value.trim();
    const errEl    = document.getElementById('fq-submit-error');

    if (!location) { errEl.textContent = 'Please fill in where you completed this.'; errEl.style.display='block'; return; }
    if (!what)     { errEl.textContent = 'Please describe what you did.'; errEl.style.display='block'; return; }
    errEl.style.display = 'none';

    const btn = document.getElementById('fq-submit-confirm');
    btn.disabled = true; btn.textContent = 'Submitting…';

    try {
      // Fetch last 20 activity events for auto-snapshot
      let activitySnapshot = [];
      try {
        const actSnap = await getDocs(query(
          collection(db, 'activity', _uid, 'events'),
          orderBy('timestamp', 'desc'),
          limit(20)
        ));
        actSnap.forEach(d => {
          const ev = d.data();
          const ts = ev.timestamp?.toDate?.()?.toLocaleString() || '';
          const msg = (ev.message || '').replace(/<[^>]+>/g, '');
          activitySnapshot.push(`${ev.icon || ''} ${msg} — ${ts}`);
        });
      } catch(e) { console.warn('Could not fetch activity snapshot:', e); }

      const proof = { location, what, witnesses: witnesses || null };

      // ── One-time race-condition guard ─────────────────────────────────────
      // Before writing, check if ANY other player already has a pending or
      // approved submission for this quest. If so, the slot is already taken.
      const _fqDoc = window._lastFactionQuestSnap?.docs?.find(d => d.id === questId);
      // Guard: quest may have expired while the modal was open
      const _fqExpAt = _fqDoc?.data()?.expiresAt?.toDate?.() || null;
      if (_fqExpAt && _fqExpAt.getTime() < Date.now()) {
        btn.disabled = false; btn.textContent = '📜 Submit';
        errEl.textContent = '⏱ This quest has already expired.';
        errEl.style.display = 'block';
        return;
      }
      if (_fqDoc?.data()?.completionType === 'one_time') {
        const rivalSnap = await getDocs(query(
          collection(db, 'factionQuestSubmissions'),
          where('questId', '==', questId),
          where('status', 'in', ['pending', 'approved'])
        ));
        const rivalTaken = rivalSnap.docs.some(d => d.data().uid !== _uid);
        if (rivalTaken) {
          btn.disabled = false; btn.textContent = '📜 Submit';
          errEl.textContent = '🔒 This quest was just claimed by another player.';
          errEl.style.display = 'block';
          // Refresh local render so the card locks immediately
          if (_fqDoc) {
            const liveSnap = await getDocs(query(collection(db, 'factionMissions'), where('__name__', '==', questId)));
            if (!liveSnap.empty) {
              const liveData = liveSnap.docs[0].data();
              if (!liveData.completedBy?.length) {
                await updateDoc(doc(db, 'factionMissions', questId), {
                  completedBy: arrayUnion({ uid: rivalSnap.docs.find(d => d.data().uid !== _uid).data().uid, playerName: '?', completedAt: new Date() })
                }).catch(() => {});
              }
            }
          }
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      const existingQ = query(
        collection(db, 'factionQuestSubmissions'),
        where('uid', '==', _uid),
        where('questId', '==', questId)
      );
      const existingSnap = await getDocs(existingQ);
      if (!existingSnap.empty) {
        await updateDoc(doc(db, 'factionQuestSubmissions', existingSnap.docs[0].id), {
          status: 'pending',
          submittedAt: serverTimestamp(),
          proof,
          activitySnapshot,
        });
      } else {
        await addDoc(collection(db, 'factionQuestSubmissions'), {
          questId,
          questTitle,
          uid: _uid,
          playerName: _charData.name || '?',
          playerRank:  _charData.rank  || 'Wanderer',
          submittedAt: serverTimestamp(),
          status: 'pending',
          proof,
          activitySnapshot,
        });
      }
      window._factionQuestSubmissions[questId] = 'pending';
      modal.remove();
      window.showToast('📜 Submission sent — awaiting deity review.', 'success');
      logActivity('📜', `<b>Faction Quest Submitted:</b> <b>${questTitle}</b> sent for deity review.`, '#c9a84c');
    } catch(e) {
      console.error('Faction quest submission failed:', e);
      btn.disabled = false; btn.textContent = '📜 Submit';
      errEl.textContent = 'Failed to submit. Try again.'; errEl.style.display='block';
    }
  };
};

// Toggle Faction Quests Dropdown
window.toggleFactionQuestsDropdown = function() {
  const section = document.getElementById('faction-quests-list');
  const arrow = document.getElementById('faction-quests-toggle-arrow');
  if (!section) return;
  // Always re-render the quests when toggling open
  if (section.style.display === 'none' || section.style.display === '') {
    window.renderFactionQuestsPanel();
    section.style.display = 'block';
    if (arrow) arrow.textContent = '▲';
  } else {
    section.style.display = 'none';
    if (arrow) arrow.textContent = '▼';
  }
};

// Call these on dashboard load and after quest updates
window.updateQuestPanels = function() {
  window.renderQuestsPanel();
  window.renderFactionQuestsPanel();
};

// Call updateQuestPanels() after _charData is loaded/updated


// ═══════════════════════════════════════════════════
//  STATIC DATA
// ═══════════════════════════════════════════════════

const DEITY_ART = {
  "Sah'run":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Fsah'run.jpeg?alt=media&token=a9ba07ac-26ad-405e-a773-3959a9dd5d9c",
  "Alistor":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Falistor.jpeg?alt=media&token=00925b01-6a3f-4844-a833-99aabd61ca45",
  "Elionidas": "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Felionidas.jpeg?alt=media&token=3076c6f2-1e25-4664-8a50-668c834b62f8",
  "Mah'run":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Fmah'run.jpeg?alt=media&token=7169560d-b36d-4009-9344-4703d5dca35b",
  "Freyja":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Ffreyja.jpeg?alt=media&token=434371f1-7d82-4d87-b7bb-4545fe37b5e6",
  "Arion":     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Farion.jpeg?alt=media&token=1fe0f371-aed9-4666-a02b-06cb10800af3",
  "Veil":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Fveil.jpeg?alt=media&token=e7fcf690-c559-4337-9012-dff063db7742",
};

const DEITY_INGREDIENTS = {
  "Sah'run":   ["Heart of the Red Phoenix", "Gem of Luminance"],
  "Alistor":   ["The Void-Eye", "Orb of Silence"],
  "Elionidas": ["Crown of Fortune", "Tears of The Endless Goldfish"],
  "Mah'run":   ["Core of a Fallen Star", "Fruit of World Tree"],
  "Freyja":    ["Divine Heart Essence", "Forgotten Desire Seed"],
  "Arion":     ["Scales of Equilibrium", "Adonai Sword"],
  "Veil":      ["Ink of Time", "Eye of All-knowing"],
};

// Profession EXP thresholds per level (doc: Profession section)
// Profession XP needed per level (index = current level, value = XP to reach next)
// Lv0→1:3000 | Lv1→2:6000 | Lv2→3:12000 | Lv3→4:24000 | Lv4→5:48000
// Lv5→6:96000 | Lv6→7:192000 | Lv7→8:384000 | Lv8→9:768000 | Lv9→10:1536000
const PROF_EXP_TABLE = [3000,6000,12000,24000,48000,96000,192000,384000,768000,1536000];

// Weekly Profession Quota Table (by level)
const PROF_QUOTA_TABLE = [
  {common:40, uncommon:10, rare:0,  legendary:0,   mythic:0   },
  {common:50, uncommon:12, rare:3,  legendary:0,   mythic:0   },
  {common:60, uncommon:15, rare:5,  legendary:0,   mythic:0   },
  {common:70, uncommon:18, rare:6,  legendary:1,   mythic:0   },
  {common:80, uncommon:20, rare:8,  legendary:2,   mythic:0   },
  {common:90, uncommon:24, rare:10, legendary:3,   mythic:0   },
  {common:100, uncommon:28, rare:12, legendary:4,   mythic:0   },
  {common:110, uncommon:30, rare:18, legendary:5,   mythic:1   },
  {common:120, uncommon:32, rare:20, legendary:8,   mythic:3   },
  {common:130, uncommon:35, rare:24, legendary:10,  mythic:5   },
  {common:140, uncommon:40, rare:28, legendary:12,  mythic:6   },
];

// Track quota progress in Firestore: { quotaProgress: { week: <ISO>, submitted: {common:0,...}, completed: false, penalty: false, bonus: false } }

function getCurrentQuotaWeek() {
  // Returns a stable Monday-anchored ISO week string, e.g. "2026-W23".
  // Uses the standard ISO 8601 algorithm: the week containing Thursday is
  // always week 1, and weeks start on Monday. This is stable across timezones
  // and never shifts by ±1 the way the old Math.ceil formula did.
  const now = new Date();
  // Shift so Monday=0 … Sunday=6
  const dayOfWeek = (now.getDay() + 6) % 7;
  // Find the Thursday of this week (ISO weeks are identified by their Thursday)
  const thursday = new Date(now);
  thursday.setDate(now.getDate() - dayOfWeek + 3);
  // Jan 4 is always in week 1
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const firstMonday   = new Date(firstThursday);
  firstMonday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7));
  const weekNum = Math.round((thursday - firstMonday) / 604800000) + 1;
  return `${thursday.getFullYear()}-W${String(weekNum).padStart(2,'0')}`;
}

function getPlayerQuotaProgress() {
  return _charData?.quotaProgress || { week: getCurrentQuotaWeek(), submitted: {common:0,uncommon:0,rare:0,legendary:0,mythic:0}, completed: false, penalty: false, bonus: false };
}

function renderProfessionQuota() {
  const prof = _charData?.profession;
  const level = _charData?.professionLvl || 0;
  const quota = PROF_QUOTA_TABLE[level] || PROF_QUOTA_TABLE[0];
  const progress = getPlayerQuotaProgress();
  const submitted = progress.submitted || {common:0,uncommon:0,rare:0,legendary:0,mythic:0};
  // Build quota table
  let html = `<table class="quota-table"><tr><th>Rarity</th><th>Required</th><th>Submitted</th></tr>`;
  ["common","uncommon","rare","legendary","mythic"].forEach(rarity => {
    if (quota[rarity] > 0) {
      html += `<tr><td style="text-transform:capitalize">${rarity}</td><td>${quota[rarity]}</td><td>${submitted[rarity]||0}</td></tr>`;
    }
  });
  html += `</table>`;
  document.getElementById("quota-table").innerHTML = html;

  // Add/Update countdown timer for weekly reset
  let timerEl = document.getElementById("quota-timer");
  if (!timerEl) {
    timerEl = document.createElement("div");
    timerEl.id = "quota-timer";
    timerEl.style.fontSize = "0.85rem";
    timerEl.style.color = "var(--gold-dim)";
    timerEl.style.marginBottom = "8px";
    const quotaSection = document.getElementById("quota-table");
    if (quotaSection && quotaSection.parentNode) {
      quotaSection.parentNode.insertBefore(timerEl, quotaSection.nextSibling);
    }
  }
  // Calculate time left until next Monday 00:00 UTC
  function getNextMondayUTC() {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = (8 - day) % 7 || 7; // days until next Monday
    const nextMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
    return nextMonday;
  }
  function updateQuotaTimer() {
    const now = new Date();
    const nextMonday = getNextMondayUTC();
    let ms = nextMonday - now;
    if (ms < 0) ms = 0;
    const days = Math.floor(ms / (1000*60*60*24));
    const hours = Math.floor((ms % (1000*60*60*24)) / (1000*60*60));
    const mins = Math.floor((ms % (1000*60*60)) / (1000*60));
    const secs = Math.floor((ms % (1000*60)) / 1000);
    let str = "";
    if (days > 0) str += `${days}d `;
    str += `${hours}h ${mins}m ${secs}s`;
    timerEl.textContent = `⏳ Time left until weekly reset: ${str}`;
  }
  if (window._quotaTimerInterval) clearInterval(window._quotaTimerInterval);
  updateQuotaTimer();
  window._quotaTimerInterval = setInterval(updateQuotaTimer, 1000);
  // Progress message
  let msg = progress.completed ? "✅ Quota met for this week!" : "Submit required materials before the week ends.";
  document.getElementById("quota-progress-msg").textContent = msg;
  document.getElementById("quota-penalty-msg").style.display = progress.penalty ? "block" : "none";
  document.getElementById("quota-penalty-msg").textContent = progress.penalty ? "Penalty applied: -20% profession EXP progress lost." : "";
  document.getElementById("quota-bonus-msg").style.display = progress.bonus ? "block" : "none";
  document.getElementById("quota-bonus-msg").textContent = progress.bonus ? "Bonus: +10% luck for professions this week!" : "";
}

window.renderProfessionQuota = renderProfessionQuota;

// Call this after gathering, submitting, or on dashboard load
function updateQuotaProgress(submit=false) {
  console.log('[DEBUG] updateQuotaProgress called. submit:', submit, 'Stack:', new Error().stack);
  // Only allow submit if not completed
  const progress = getPlayerQuotaProgress();
  if (submit && !progress.completed) {
    const level = _charData?.professionLvl || 0;
    const quota = PROF_QUOTA_TABLE[level] || PROF_QUOTA_TABLE[0];
    const inv = [...(_charData?.inventory||[])];
    const rarityMap = {
      common:    ["Iron","Copper","Tin","Limestone","Coal","Blueberries","Apples","Garlic","Mushroom","Melons","Trout","Carp","Catfish","Sardine","Pufferfish","Mint Leaves","Basil Sprigs","Wild Herbs","Soft Bark","Wood","Raw Meat","Tough Hide","Bone Fragments","Feathers","Animal Fat"],
      uncommon:  ["Silver","Bronze","Obsidian","Marble","Quartz","Golden Pears","Moon Grapes","Sunfruit","Crystal Berries","Bitter Root","Silverfin","Glowfish","Spotted Eel","Coral Snapper","Red Minnow","Silverleaf","Goldroot","Nightshade","Glowleaf","Lotus","Leather","Fangs","Fur","Horns","Claws"],
      rare:      ["Gold","Mythril","Palladium","Spirit Plum","Frost Apples","Ember Fruit","Shadowfish","Flamefish","Ying Koi","Spirit Herb","Jade Vine","Ghost Root","Spirit Venison","Shadow Hide","Drake Meat"],
      legendary: ["Titanium","Adamantium","Celestial Fig","Dragonfruit","Celestial Whale","Black Unagi","Phoenix Bloom","Middlemist","Cyclops Eye","Dragon Scales"],
      mythic:    ["Aetherium","Eden\u2019s Tear","Cosmic Leviathan","Void Orchid","Titan Heart"]
    };
    // Quota auto-listing prices — midpoints of the resource market bracket ranges
    // Common 50-100 → 75 | Uncommon 250-300 → 275 | Rare 1400-1500 → 1450
    // Legendary 4000-5000 → 4500 | Mythic 13000-15000 → 14000
    const RARITY_PRICE = { common: 75, uncommon: 275, rare: 1450, legendary: 4500, mythic: 14000 };

    // Build rarity counts
    let canSubmit = true;
    const rarityStats = {};
    ["common","uncommon","rare","legendary","mythic"].forEach(rarity => {
      const needed = quota[rarity] - (progress.submitted[rarity]||0);
      if (needed > 0) {
        let count = 0;
        rarityMap[rarity].forEach(mat => {
          const item = inv.find(i => i.name === mat);
          if (item) count += item.qty || 1;
        });
        rarityStats[rarity] = { needed, count };
        if (count < needed) canSubmit = false;
      }
    });

    // Open quota modal
    const modal      = document.getElementById("quota-modal");
    const modalBody  = document.getElementById("quota-modal-body");
    const modalActs  = document.getElementById("quota-modal-actions");
    const modalTitle = document.getElementById("quota-modal-title");

    if (!canSubmit) {
      // NOT ENOUGH: show breakdown table
      modalTitle.textContent = "NOT ENOUGH MATERIALS";
      modalTitle.style.color = "#e05555";
      let html = `<p style="font-size:0.82rem;color:var(--text-dim);margin-bottom:14px;font-style:italic">You are missing the following materials to complete your weekly quota:</p>
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
          <tr style="font-family:var(--font-mono);font-size:0.7rem;color:var(--gold);letter-spacing:0.1em">
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">RARITY</th>
            <th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border)">HAVE</th>
            <th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border)">NEED</th>
            <th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border)">SHORT</th>
          </tr>`;
      ["common","uncommon","rare","legendary","mythic"].forEach(rarity => {
        if (!rarityStats[rarity]) return;
        const have  = rarityStats[rarity].count;
        const need  = rarityStats[rarity].needed;
        const short = need - have;
        const ok    = short <= 0;
        html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
          <td style="padding:8px;text-transform:capitalize;color:var(--text)">${rarity}</td>
          <td style="padding:8px;text-align:center;color:${ok ? "#70c090" : "#e05555"};font-weight:600">${have}</td>
          <td style="padding:8px;text-align:center;color:var(--text-dim)">${need}</td>
          <td style="padding:8px;text-align:center;color:${ok ? "#70c090" : "#e88"};">${ok ? "\u2713" : "-" + short}</td>
        </tr>`;
      });
      html += `</table>`;
      modalBody.innerHTML = html;
      modalActs.innerHTML = `<button class="btn-secondary" onclick="document.getElementById('quota-modal').style.display='none'">CLOSE</button>`;
      modal.style.display = "flex";
      return;
    }

    // ENOUGH: preview items to be taken and listed
    modalTitle.textContent = "SUBMIT MATERIALS";
    modalTitle.style.color = "var(--gold)";

    const toList = [];
    const tempInv = inv.map(i => ({ ...i }));
    ["common","uncommon","rare","legendary","mythic"].forEach(rarity => {
      if (!rarityStats[rarity]) return;
      let needed = rarityStats[rarity].needed;
      rarityMap[rarity].forEach(mat => {
        const idx = tempInv.findIndex(i => i.name === mat && needed > 0);
        if (idx !== -1) {
          const take = Math.min(tempInv[idx].qty, needed);
          toList.push({ name: mat, qty: take, rarity, price: RARITY_PRICE[rarity] });
          tempInv[idx].qty -= take;
          needed -= take;
        }
      });
    });

    let html = `<p style="font-size:0.82rem;color:var(--text-dim);margin-bottom:14px;font-style:italic">
        You have enough materials. These will be removed from your inventory and <span style="color:var(--gold)">automatically listed on the Player Market</span>:
      </p>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;margin-bottom:4px">`;
    toList.forEach(item => {
      html += `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--ink3);border-radius:6px;padding:7px 12px">
        <span style="color:var(--text);font-size:0.87rem">${getItemIcon(item.name)} ${item.name} <span style="color:var(--text-dim);font-size:0.75rem">(\xd7${item.qty})</span></span>
        <span style="color:var(--gold);font-size:0.78rem;font-family:var(--font-mono)">${item.price}🪙 ea</span>
      </div>`;
    });
    html += `</div><p style="font-size:0.75rem;color:var(--text-dim);margin-top:10px;font-style:italic">Prices are set automatically based on rarity.</p>`;
    modalBody.innerHTML = html;
    modalActs.innerHTML = `
      <button class="btn-primary" id="btn-confirm-quota-submit">CONFIRM &amp; SUBMIT</button>
      <button class="btn-secondary" onclick="document.getElementById('quota-modal').style.display='none'">CANCEL</button>`;
    modal.style.display = "flex";

    document.getElementById("btn-confirm-quota-submit").onclick = async () => {
      const btn = document.getElementById("btn-confirm-quota-submit");
      btn.disabled = true; btn.textContent = "SUBMITTING...";

      // Remove from real inventory — pass a mutator so _invWrite reads
      // the server's live inventory before deducting, preventing phantom removals
      // if anything else touched the inventory since the page loaded.
      const rarityStatsSnapshot = rarityStats;
      const rarityMapSnapshot   = rarityMap;

      progress.completed = true; progress.bonus = true; progress.penalty = false;

      try {
        await _invWrite(_uid, inv => {
          ["common","uncommon","rare","legendary","mythic"].forEach(rarity => {
            if (!rarityStatsSnapshot[rarity]) return;
            let needed = rarityStatsSnapshot[rarity].needed;
            rarityMapSnapshot[rarity].forEach(mat => {
              const idx = inv.findIndex(i => i.name === mat && needed > 0);
              if (idx !== -1) {
                const take = Math.min(inv[idx].qty, needed);
                inv[idx].qty -= take; needed -= take;
                if (inv[idx].qty <= 0) inv.splice(idx, 1);
              }
            });
          });
        }, { quotaProgress: progress, professionLuckBonus: true });
       _charData.quotaProgress       = progress;
_charData.professionLuckBonus = true;
window.renderInventory(_charData.inventory);
        renderProfessionQuota();

        // Auto-list each item on the market
        await Promise.all(toList.map(item => addDoc(collection(db, "marketListings"), {
          sellerUid:    _uid,
          sellerName:   _charData.name,
          itemName:     item.name,
          itemIcon:     getItemIcon(item.name),
          itemType:     getItemType(item.name),
          qty:          item.qty,
          pricePerUnit: item.price,
          totalPrice:   item.price * item.qty,
          listedAt:     serverTimestamp(),
        })));
        if (typeof loadPlayerListings === "function") loadPlayerListings();

        // Success state
        modalTitle.textContent = "QUOTA SUBMITTED!";
        modalTitle.style.color = "#70c090";
        modalBody.innerHTML = `
          <div style="text-align:center;padding:16px 0">
            <div style="font-size:2.5rem;margin-bottom:12px">\u2705</div>
            <p style="color:var(--text);margin-bottom:6px">Materials submitted and listed on the market.</p>
            <p style="color:#70c090;font-size:0.85rem">+10% luck bonus active for this week!</p>
          </div>`;
        modalActs.innerHTML = `<button class="btn-primary" onclick="document.getElementById('quota-modal').style.display='none'">DONE</button>`;

      } catch(err) {
        console.error(err);
        btn.disabled = false; btn.textContent = "CONFIRM & SUBMIT";
        window.showToast("Submission failed. Try again.", "error");
      }
    };
    return;
  }
  // On load, just render
  renderProfessionQuota();
}

window.submitProfessionQuota = function() {
  updateQuotaProgress(true);
};

// Weekly reset logic (should be called on login or weekly cron)
function checkAndResetWeeklyQuota() {
  const progress = getPlayerQuotaProgress();
  const currentWeek = getCurrentQuotaWeek();
  if (progress.week !== currentWeek) {
    // If not completed, apply penalty
    if (!progress.completed) {
      // Penalty: -20% EXP progress (doc rule — no level loss)
      let newExp = Math.floor((_charData.professionXp||0)*0.8);
      updateDoc(doc(db, "characters", _uid), {
        professionXp: newExp,
        "quotaProgress": { week: currentWeek, submitted: {common:0,uncommon:0,rare:0,legendary:0,mythic:0}, completed: false, penalty: true, bonus: false }
      }).then(()=>{
        _charData.professionXp = newExp;
        _charData.quotaProgress = { week: currentWeek, submitted: {common:0,uncommon:0,rare:0,legendary:0,mythic:0}, completed: false, penalty: true, bonus: false };
        renderProfessionQuota();
        window.showToast("Missed quota last week: -20% profession EXP.","error");
      });
    } else {
      // Reset for new week
      updateDoc(doc(db, "characters", _uid), {
        "quotaProgress": { week: currentWeek, submitted: {common:0,uncommon:0,rare:0,legendary:0,mythic:0}, completed: false, penalty: false, bonus: false },
        professionLuckBonus: false
      }).then(()=>{
        _charData.quotaProgress = { week: currentWeek, submitted: {common:0,uncommon:0,rare:0,legendary:0,mythic:0}, completed: false, penalty: false, bonus: false };
        _charData.professionLuckBonus = false;
        renderProfessionQuota();
      });
    }
  }
}

// Call on dashboard load
document.addEventListener("DOMContentLoaded", ()=>{
  setTimeout(()=>{
    checkAndResetWeeklyQuota();
    renderProfessionQuota();
  }, 1200);
});

// Resource find rates per profession level (doc: Material Find Percentage)
const FIND_RATES = [
  { common:80, uncommon:20, rare:0,  legendary:0,   mythic:0   }, // Lv0
  { common:75, uncommon:20, rare:5,  legendary:0,   mythic:0   }, // Lv1
  { common:70, uncommon:22, rare:8,  legendary:0,   mythic:0   }, // Lv2
  { common:65, uncommon:25, rare:9,  legendary:1,   mythic:0   }, // Lv3
  { common:60, uncommon:27, rare:11, legendary:2,   mythic:0   }, // Lv4
  { common:55, uncommon:30, rare:12, legendary:3,   mythic:0   }, // Lv5
  { common:50, uncommon:32, rare:14, legendary:4,   mythic:0   }, // Lv6
  { common:40, uncommon:30, rare:25, legendary:5,   mythic:0.1 }, // Lv7
  { common:37, uncommon:30, rare:20, legendary:12,  mythic:1   }, // Lv8
  { common:35, uncommon:25, rare:23, legendary:14,  mythic:3   }, // Lv9
  { common:20, uncommon:25, rare:30, legendary:20,  mythic:5   }, // Lv10
];

// Find count per level (doc: Profession EXP Bar)
const FIND_COUNT = [
  "1 resource at a time",                              // Lv0
  "1 resource at a time",                              // Lv1
  "5% chance of 2 resources",                          // Lv2
  "10% chance of 2 resources",                         // Lv3
  "30% chance of 2 resources",                         // Lv4
  "50% chance of 2 resources",                         // Lv5
  "100% chance of 2 resources, 3% chance of 3",        // Lv6
  "100% chance of 2 resources, 5% chance of 3",        // Lv7
  "100% chance of 2 resources, 10% chance of 3",       // Lv8
  "100% chance of 2 resources, 30% chance of 3",       // Lv9
  "100% chance of 2 resources, 30% chance of 3",       // Lv10
];

const PROFESSION_DESCS = {
  Miner:     "Explore caves and underground networks to excavate precious ores and runestones.",
  Forager:   "Forest exploration to acquire all sorts of fruits and wild finds.",
  Angler:    "Cast your line and reel in aquatic resources from rivers, lakes and seas.",
  Herbalist: "Gather special roots, branches and herbs used in potions and rituals.",
  Hunter:    "Hunt animals for their meat, bones, hides and other valuable drops.",
};

const CLASS_ICONS  = { Warrior:"⚔️",Guardian:"🛡️",Arcanist:"🔮",Hunter:"🏹",Assassin:"🗡️",Cleric:"✨",Summoner:"🌀" };
const DEITY_ICONS  = { "Sah'run":"🔥","Alistor":"🌑","Elionidas":"🪙","Mah'run":"⭐","Freyja":"💗","Arion":"⚖️","Veil":"📖" };

// ═══════════════════════════════════════════════════
//  FAITH / WORSHIP SYSTEM
// ═══════════════════════════════════════════════════

// Worship materials required per sacrifice (1 of each)
const DEITY_WORSHIP_MATS = {
  "Sah'run":   ["Volcanic Roots","Devil-Spring Water","Ash of Elder Trees"],
  "Alistor":   ["Ephemeral Footprints","Oil-stained Feathers","Whispering Purple Sands"],
  "Elionidas": ["Golden Wheat Sheaves","Miracle Coins","Ancient Mint Seeds"],
  "Mah'run":   ["Starlight Dust","Moon Petals","Crystallized Night Dews"],
  "Freyja":    ["Crimson Toad Moss","Branch of Soul Tree","Bloom Petals"],
  "Arion":     ["Broken Shackles","Iron Oaths","Verdict Quill"],
  "Veil":      ["Ancient Scroll Fragments","White Mystic Woods","Truths"],
};

// Which shrine belongs to which deity
const DEITY_SHRINE_MAP = {
  "shrine of secrets":     "Veil",
  "shrine_of_secrets":     "Veil",
  "aurora basin":          "Mah'run",
  "aurora_basin":          "Mah'run",
  "forgotten estuary":     "Alistor",
  "forgotten_estuary":     "Alistor",
  "purgatory of light":    "Sah'run",
  "purgatory_of_light":    "Sah'run",
  "temple of verdict":     "Arion",
  "temple_of_verdict":     "Arion",
  "heart garden":          "Freyja",
  "heart_garden":          "Freyja",
  "valley of overflowing": "Elionidas",
  "valley_of_overflowing": "Elionidas",
};

// Faith Mantles — each Mantle has 3 Choirs
// Choir thresholds: Faithless C1=5, C2=10, C3=15
// Each Mantle's C1 = previous Mantle's C3 × 2, then +5 per subsequent Choir
// Blessing multiplier scales per Mantle (base) and fractionally per Choir
const FAITH_MANTLES = [
  { mantle: 0, label: "Faithless",   mult: 1.0, choirs: [5,   10,  15]  },
  { mantle: 1, label: "Initiate",    mult: 1.5, choirs: [30,  35,  40]  },
  { mantle: 2, label: "Devotee",     mult: 2.0, choirs: [80,  85,  90]  },
  { mantle: 3, label: "Acolyte",     mult: 3.0, choirs: [180, 185, 190] },
  { mantle: 4, label: "Zealot",      mult: 4.0, choirs: [380, 385, 390] },
  { mantle: 5, label: "Chosen",      mult: 5.0, choirs: [780, 785, 790] },
  { mantle: 6, label: "High Priest", mult: 6.0, choirs: [1580,1585,1590]},
];

// Returns current mantle + choir data for a player
// choir: 0 = not yet reached C1 of this mantle, 1/2/3 = reached that choir
function _getFaithTier(faithLevel) {
  // Find which mantle we're in
  let mantleIdx = 0;
  for (let i = FAITH_MANTLES.length - 1; i >= 0; i--) {
    if (faithLevel >= FAITH_MANTLES[i].choirs[0]) { mantleIdx = i; break; }
    if (i === 0 && faithLevel >= 0) { mantleIdx = 0; break; }
  }
  // Edge: still in the pre-C1 phase of Faithless (faith 0-4)
  if (faithLevel < FAITH_MANTLES[0].choirs[0]) mantleIdx = 0;

  const current = FAITH_MANTLES[mantleIdx];

  // Determine choir within this mantle (0 = between mantles / pre-C1)
  let choir = 0;
  for (let c = 2; c >= 0; c--) {
    if (faithLevel >= current.choirs[c]) { choir = c + 1; break; }
  }

  // Progress bar: toward next choir threshold or next mantle's C1
  const nextMantleData = mantleIdx < FAITH_MANTLES.length - 1 ? FAITH_MANTLES[mantleIdx + 1] : null;
  let nextThreshold = null;
  if (choir < 3) {
    nextThreshold = current.choirs[choir]; // next choir in same mantle
  } else if (nextMantleData) {
    nextThreshold = nextMantleData.choirs[0]; // first choir of next mantle
  }

  const prevThreshold = choir > 0 ? current.choirs[choir - 1] : (mantleIdx > 0 ? FAITH_MANTLES[mantleIdx - 1].choirs[2] : 0);
  const progress = nextThreshold
    ? Math.round(((faithLevel - prevThreshold) / (nextThreshold - prevThreshold)) * 100)
    : 100;

  // Effective multiplier: base mantle mult + small bonus per choir achieved
  const choirBonus = choir * (0.1);
  const effectiveMult = current.mult + choirBonus;

  // Build a next-step label for the UI
  let nextLabel = null;
  if (choir < 3) {
    nextLabel = { label: `${current.label} — Choir ${choir + 1}`, minFaith: current.choirs[choir] };
  } else if (nextMantleData) {
    nextLabel = { label: `${nextMantleData.label} — Choir 1`, minFaith: nextMantleData.choirs[0] };
  }

  return {
    current: { ...current, tier: current.mantle, choir, effectiveMult },
    next: nextLabel,
    progress,
  };
}

// Returns the effective blessing description with faith multiplier applied
function _getBlessingDesc(deity, faithLevel) {
  const basePct = 3;
  const { current } = _getFaithTier(faithLevel);
  const effectivePct = Math.round(basePct * current.effectiveMult);
  const descs = {
    "Sah'run":   `${effectivePct}% chance enemies drop forge materials on defeat`,
    "Alistor":   `${effectivePct}% reduced chance of getting robbed/attacked while exploring`,
    "Elionidas": `${effectivePct}% chance of finding precious loot while exploring`,
    "Mah'run":   `+${effectivePct}% chance of encountering rare events and special locations`,
    "Freyja":    `+${effectivePct}% chance of receiving gifts from NPCs`,
    "Arion":     `Balances good/bad encounters (${effectivePct}% correction strength)`,
    "Veil":      `+${effectivePct}% EXP gained from all activities`,
  };
  return descs[deity] || `+${effectivePct}% blessing effect`;
}

// Returns the effective blessing % for a deity at current faith level
function _getFaithBlessingPct(charData) {
  const faith = charData?.faithLevel || 0;
  const { current } = _getFaithTier(faith);
  return (3 * current.effectiveMult) / 100; // e.g. Devotee C2 = (3×2.2)/100 = 6.6%
}

// ═══════════════════════════════════════════════════
//  SHRINE / DEITY TEMPLE PANEL SYSTEM
//  "Visit Temple" on the map now opens panel-shrine
//  instead of a floating modal.
// ═══════════════════════════════════════════════════

const DEITY_BLESSING_NAMES = {
  "Sah'run":   "Flame of Forge",
  "Alistor":   "Veil-step",
  "Elionidas": "Fortune's Drift",
  "Mah'run":   "Astral Sight",
  "Freyja":    "Heart's Favour",
  "Arion":     "Balanced Scales",
  "Veil":      "Seeker's Mind",
};

const DEITY_LORE = {
  "Sah'run":   { title:"God of Flames",     desc:"Sah'run is the lord of flames and embodiment of scorch, also known as The Demon of Fire.", authorities:"Flames, Luminance, Hellfire" },
  "Alistor":   { title:"God of Darkness",   desc:"Alistor is the God of darkness, shadows and rest, also known as the Final Slumber.",       authorities:"Darkness, Slumber, Secrets" },
  "Elionidas": { title:"God of Abundance",  desc:"Elionidas is the God of wealth, good luck and opportunities, also known as The Fortunal.", authorities:"Fate, Blessings, Riches" },
  "Mah'run":   { title:"Goddess of Stars",  desc:"Mah'run is the Goddess of the night sky and eternal stars, also known as the Astral Mother.", authorities:"Stars, Cosmos, Guidance" },
  "Freyja":    { title:"Goddess of Love",   desc:"Freyja is the Goddess of affection, passion and bonds, also known as the Heart Mother.",    authorities:"Love, Souls, Desire" },
  "Arion":     { title:"God of Justice",    desc:"Arion is the God of law, balance and fairness, also known as the Divine Arbiter.",           authorities:"Justice, Balance, Retribution" },
  "Veil":      { title:"God of Knowledge",  desc:"Veil is the God of wisdom, memory and hidden truths, also known as The Hand of Secret.",    authorities:"Knowledge, Memory, Secrets" },
};

/** Navigate to the shrine panel and populate it based on current location. */
window._openTemplePanel = function() {
  // Use the global switchPanel function to navigate
  if (typeof window.switchPanel === 'function') {
    window.switchPanel('shrine');
  } else {
    // Fallback: trigger nav click
    document.querySelector('[data-panel="shrine"]')?.click();
  }
  _renderShrinePanel();
};

/** Full render of the shrine panel — called on nav switch too. */
function _renderShrinePanel() {
  const c = _charData;
  if (!c) return;

  const loc = (c.kingdom || c.location || "").toLowerCase().replace(/_/g, " ");
  const shrineName = Object.keys(DEITY_SHRINE_MAP).find(k => loc.includes(k));
  const shrineDeity = shrineName ? DEITY_SHRINE_MAP[shrineName] : null;
  const isAtShrine  = !!shrineDeity;
  const isOwnShrine = shrineDeity === c.deity;

  // Resolve which deity this shrine belongs to for lore/icon
  const activeDeity = isOwnShrine ? c.deity : shrineDeity;
  const deityIcon   = DEITY_ICONS[activeDeity] || DEITY_ICONS[c.deity] || "⛩️";
  const lore        = DEITY_LORE[activeDeity]  || DEITY_LORE[c.deity] || {};

  // Panel header
  const titleEl = document.getElementById('shrine-panel-title');
  const subEl   = document.getElementById('shrine-panel-subtitle');
  if (titleEl) titleEl.textContent = isAtShrine ? `${deityIcon} Temple of ${activeDeity}` : '🛕 Deity Shrine';
  if (subEl)   subEl.textContent   = isAtShrine ? (lore.title || '') : 'Travel to a deity shrine on the World Map.';

  // Show / hide state blocks
  const notAt   = document.getElementById('shrine-not-at-shrine');
  const wrongEl = document.getElementById('shrine-wrong-shrine');
  const ownEl   = document.getElementById('shrine-own-shrine');
  if (notAt)   notAt.style.display   = (!isAtShrine)  ? 'block' : 'none';
  if (wrongEl) wrongEl.style.display = (isAtShrine && !isOwnShrine) ? 'block' : 'none';
  if (ownEl)   ownEl.style.display   = (isAtShrine && isOwnShrine)  ? 'block' : 'none';

  // ── Wrong shrine state ──
  if (isAtShrine && !isOwnShrine) {
    const iconEl = document.getElementById('shrine-wrong-icon');
    const msgEl  = document.getElementById('shrine-wrong-msg');
    if (iconEl) iconEl.textContent = deityIcon;
    if (msgEl)  msgEl.textContent  = `You must be at ${c.deity}'s shrine to sacrifice. This is ${shrineDeity}'s shrine.`;
    // Reset explore log
    const exploreLog = document.getElementById('shrine-explore-log');
    if (exploreLog) { exploreLog.style.display = 'none'; exploreLog.innerHTML = ''; }
    return;
  }

  if (!isOwnShrine) return; // not at any shrine — done

  // ── Own shrine state ──
  const faithLevel  = c.faithLevel || 0;
  const { current: tier, next, progress } = _getFaithTier(faithLevel);
  const blessingDesc = _getBlessingDesc(c.deity, faithLevel);

  // Faith bar
  const faithNumEl = document.getElementById('shrine-faith-level');
  const faithBarEl = document.getElementById('shrine-faith-bar');
  const tierNumEl  = document.getElementById('shrine-tier-num');
  const tierLblEl  = document.getElementById('shrine-tier-label');
  const nextTierEl = document.getElementById('shrine-next-tier');
  const choirNumEl = document.getElementById('shrine-choir-num');
  if (faithNumEl) faithNumEl.textContent = faithLevel;
  if (faithBarEl) faithBarEl.style.width = progress + '%';
  if (tierNumEl)  tierNumEl.textContent  = tier.mantle;
  if (tierLblEl)  tierLblEl.textContent  = tier.label;
  if (choirNumEl) choirNumEl.textContent = tier.choir > 0 ? `Choir ${tier.choir}` : '—';
  if (nextTierEl) nextTierEl.textContent = next
    ? `Next: ${next.label} at Faith ${next.minFaith}`
    : 'Max Mantle Reached ✦';

  // Blessing
  const blessNameEl = document.getElementById('shrine-blessing-name');
  const blessDescEl = document.getElementById('shrine-blessing-desc');
  const blessMultEl = document.getElementById('shrine-blessing-mult');
  const blessTierEl = document.getElementById('shrine-blessing-tier');
  if (blessNameEl) blessNameEl.textContent = c.blessing || '—';
  if (blessDescEl) blessDescEl.textContent = blessingDesc;
  if (blessMultEl) blessMultEl.textContent = tier.effectiveMult.toFixed(1) + '×';
  if (blessTierEl) blessTierEl.textContent = `${tier.label} — Choir ${tier.choir}`;

  // Lore
  const loreDescEl = document.getElementById('shrine-lore-desc');
  const loreAuthEl = document.getElementById('shrine-lore-authorities');
  if (loreDescEl) loreDescEl.textContent = lore.desc || '—';
  if (loreAuthEl) loreAuthEl.textContent = lore.authorities || '—';

  // Worship materials preview chips
  const matsPreview = document.getElementById('shrine-worship-mats-preview');
  const mats = DEITY_WORSHIP_MATS[c.deity] || [];
  const inv  = c.inventory || [];
  if (matsPreview) {
    matsPreview.innerHTML = mats.map(mat => {
      const owned = inv.find(i => i.name === mat);
      const qty   = owned?.qty || 0;
      return `<span style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.2);
        border-radius:20px;padding:3px 10px;font-size:0.72rem;color:${qty>0?'var(--gold-dim)':'var(--ash)'}">
        ${mat} <b style="color:${qty>0?'var(--gold)':'#555'}">×${qty}</b></span>`;
    }).join('');
  }

  // Sacrifice materials list
  const matListEl = document.getElementById('shrine-mat-list');
  const sacBtn    = document.getElementById('shrine-sacrifice-btn');
  const matStatus = mats.map(mat => {
    const owned = inv.find(i => i.name === mat);
    return { name: mat, qty: owned?.qty || 0, hasOne: (owned?.qty || 0) >= 1 };
  });
  const canSacrifice = matStatus.every(m => m.hasOne);
  if (matListEl) {
    matListEl.innerHTML = matStatus.map(m => `
      <div style="display:flex;align-items:center;gap:8px;font-size:0.82rem">
        <span style="color:${m.hasOne ? '#4fc870' : '#e05555'};font-size:1rem">${m.hasOne ? '✓' : '✗'}</span>
        <span style="color:${m.hasOne ? 'var(--text)' : 'var(--text-dim)'};flex:1">${m.name}</span>
        <span style="color:#888;font-size:0.75rem">×${m.qty} owned</span>
      </div>`).join('');
  }
  if (sacBtn) {
    sacBtn.disabled = !canSacrifice;
    sacBtn.style.opacity = canSacrifice ? '1' : '0.5';
  }

  // Reset explore log on re-render
  const exploreLog = document.getElementById('shrine-explore-log');
  if (exploreLog) { exploreLog.style.display = 'none'; exploreLog.innerHTML = ''; }
  const sacResult = document.getElementById('shrine-sacrifice-result');
  if (sacResult) sacResult.textContent = '';
}

/** Explore the shrine grounds — 10% base chance to find a worship material. */
window._doShrineExplore = async function() {
  const c = _charData;
  if (!c) return;
  if (c.isDead) { window.showToast('☠️ You are dead. You cannot explore.', 'error'); return; }

  const loc        = (c.kingdom || c.location || "").toLowerCase().replace(/_/g, " ");
  const shrineName = Object.keys(DEITY_SHRINE_MAP).find(k => loc.includes(k));
  const shrineDeity = shrineName ? DEITY_SHRINE_MAP[shrineName] : null;
  if (!shrineDeity) { window.showToast('Travel to a deity shrine first.', 'error'); return; }

  // The worship mats we can find are for whichever shrine we're at
  const mats = DEITY_WORSHIP_MATS[shrineDeity] || [];
  if (!mats.length) return;

  // Disable both explore buttons while working
  const btnOwn   = document.getElementById('shrine-explore-btn');
  const btnWrong = document.getElementById('shrine-explore-wrong-btn');
  const logEl    = document.getElementById('shrine-explore-log');
  if (btnOwn)   { btnOwn.disabled   = true; btnOwn.textContent   = '🔍 Exploring...'; }
  if (btnWrong) { btnWrong.disabled = true; btnWrong.textContent = '🔍 Exploring...'; }
  if (logEl)    { logEl.style.display = 'block'; logEl.innerHTML = '<span style="color:var(--ash);font-style:italic">Searching the grounds...</span>'; }

  await new Promise(r => setTimeout(r, 1800)); // 1.8s feel of exploring

  // 10% base chance, Mah'run blessing boosts special location finds
  const mahrunBonus = (c.deity === "Mah'run") ? _getFaithBlessingPct(c) : 0;
  const chance = 0.10 + mahrunBonus;
  const found  = Math.random() < chance;

  let logMsg = '';
  if (found) {
    const mat = mats[Math.floor(Math.random() * mats.length)];
    try {
      await _invWrite(_uid, inv => {
        const ex = inv.find(i => i.name === mat);
        if (ex) ex.qty += 1; else inv.push({ name: mat, qty: 1, type: 'material' });
      });
      window._allInvItems = _charData.inventory;
      window._refreshInvDisplay?.();
      logActivity('⚗️', `<b>Temple Explore:</b> Found <b>${mat}</b> at <b>${shrineDeity}'s shrine</b>.`, '#c9a84c');
      await _incrementQuest('gather', 1);
      logMsg = `<span style="color:#4fc870">✨ You found <b>${mat}</b>!</span>`;
      window.showToast(`✨ Found: ${mat}`, 'success');
      // Re-render panel to update mat counts
      _renderShrinePanel();
    } catch(e) { console.warn('[Shrine] Inventory write failed:', e); }
  } else {
    logMsg = `<span style="color:var(--ash)">🌑 You searched carefully... but found nothing this time.</span>`;
    window.showToast('🌑 Nothing found this time. Keep exploring!', 'info');
  }

  if (logEl) logEl.innerHTML = logMsg;
  if (btnOwn)   { btnOwn.disabled   = false; btnOwn.textContent   = '🔍 EXPLORE TEMPLE'; }
  if (btnWrong) { btnWrong.disabled = false; btnWrong.textContent = '🔍 EXPLORE GROUNDS'; }
};

/** Perform the sacrifice — same logic as before, now updates the panel in-place. */
window._doShrineSacrifice = async function() {
  const sacBtn   = document.getElementById('shrine-sacrifice-btn');
  const resultEl = document.getElementById('shrine-sacrifice-result');
  if (!sacBtn || sacBtn.disabled) return;

  const c    = _charData;
  const mats = DEITY_WORSHIP_MATS[c.deity] || [];
  const inv  = [...(c.inventory || [])];

  // Double-check all materials present
  for (const mat of mats) {
    const owned = inv.find(i => i.name === mat);
    if (!owned || owned.qty < 1) {
      if (resultEl) { resultEl.style.color = '#e05555'; resultEl.textContent = `Missing: ${mat}`; }
      return;
    }
  }

  sacBtn.disabled = true;
  sacBtn.textContent = '🙏 Offering...';

  const matsToConsume = mats; // captured before async
  const newFaith = (c.faithLevel || 0) + 1;
  const { current: newTier } = _getFaithTier(newFaith);
  const prevState = _getFaithTier(c.faithLevel || 0).current;
  const tieredUp = newTier.mantle > prevState.mantle;
  const choiredUp = !tieredUp && newTier.choir > prevState.choir;

  try {
    await _invWrite(_uid, inv => {
      // Consume 1 of each required material from the live server inventory
      for (const mat of matsToConsume) {
        const item = inv.find(i => i.name === mat);
        if (item) {
          item.qty -= 1;
          if (item.qty <= 0) inv.splice(inv.indexOf(item), 1);
        }
      }
    }, { faithLevel: newFaith });
    window._allInvItems = _charData.inventory;
    window._refreshInvDisplay?.();
    set('s-faith', newFaith);

    if (resultEl) {
      resultEl.style.color = '#4fc870';
      if (tieredUp) {
        resultEl.textContent = `🎉 Faith ${newFaith}! Ascended to ${newTier.label} — Choir ${newTier.choir}!`;
      } else if (choiredUp) {
        resultEl.textContent = `✨ Faith ${newFaith}! ${newTier.label} — Choir ${newTier.choir} reached!`;
      } else {
        resultEl.textContent = `🙏 Sacrifice accepted. Faith: ${newFaith}`;
      }
    }
    const eventLabel = tieredUp
      ? ` — Ascended to <b>${newTier.label}</b> (Choir ${newTier.choir})!`
      : choiredUp
        ? ` — <b>${newTier.label} Choir ${newTier.choir}</b> reached!`
        : '';
    logActivity('🙏', `<b>Sacrifice Offered</b> at <b>${c.deity}'s shrine</b>. Faith: <b>${newFaith}</b>${eventLabel}.`, '#c9a84c');
    if (tieredUp) window.showToast(`🎉 Mantle Ascension! You are now ${newTier.label}!`, 'success');
    else if (choiredUp) window.showToast(`✨ ${newTier.label} — Choir ${newTier.choir}!`, 'success');

    // ── Notify the deity if this was a Mantle ascension or Choir advancement ──
    if ((tieredUp || choiredUp) && c.deity) {
      try {
        // Look up deity UID by matching the deity name against both
        // the character's `name` field and `charClass` field for resilience
        const [deityByName, deityByClass] = await Promise.all([
          getDocs(query(collection(db, 'characters'), where('isDeity', '==', true), where('name',      '==', c.deity))),
          getDocs(query(collection(db, 'characters'), where('isDeity', '==', true), where('charClass', '==', c.deity))),
        ]);
        const deityDoc = (!deityByName.empty ? deityByName : deityByClass).docs[0];
        if (deityDoc) {
          const deityUid = deityDoc.id;
          const notifType = tieredUp ? 'mantle_ascension' : 'choir_advancement';
          const notifMsg  = tieredUp
            ? `⬆️ ${c.name || 'A worshipper'} ascended to ${newTier.label} (Choir ${newTier.choir})! Faith: ${newFaith}`
            : `✨ ${c.name || 'A worshipper'} reached ${newTier.label} — Choir ${newTier.choir}. Faith: ${newFaith}`;
          await addDoc(collection(db, 'deityNotifications'), {
            deityUid,
            type:        'faith_increase',
            subtype:     notifType,
            playerUid:   _uid,
            playerName:  c.name   || 'Unknown',
            playerClass: c.charClass || '—',
            mantle:      newTier.label,
            choir:       newTier.choir,
            faithLevel:  newFaith,
            message:     notifMsg,
            read:        false,
            createdAt:   serverTimestamp(),
          });
        }
      } catch (notifErr) {
        console.warn('[FaithNotif] Could not send deity notification:', notifErr);
      }
    }

    sacBtn.textContent = '🙏 OFFER SACRIFICE';
    // Re-render the panel so faith bar + mat list refresh
    setTimeout(_renderShrinePanel, 400);

  } catch(e) {
    console.error(e);
    if (resultEl) { resultEl.style.color = '#e05555'; resultEl.textContent = 'Sacrifice failed. Try again.'; }
    sacBtn.disabled = false;
    sacBtn.textContent = '🙏 OFFER SACRIFICE';
  }
};

// Keep _doSacrifice as an alias so any existing callers still work
window._doSacrifice = window._doShrineSacrifice;
const RANK_ORDER   = ["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"];

const SKILL_TREES = {
  Warrior:{basic:[{name:"Cleave",type:"Melee Damage",desc:"105% STR damage"},{name:"Battle Cry",type:"Empowerment",desc:"+20% STR. 10 Mana"},{name:"Crushing Blow",type:"Heavy Damage",desc:"110% STR, ignores 10% DEF"}],intermediate:[{name:"War Stomp",type:"Stun",desc:"Stuns 1 turn"},{name:"Bleeding Edge",type:"Cont. Damage",desc:"+15% STR/turn×3. 20 Mana"},{name:"Iron Momentum",type:"Empowerment",desc:"+30% STR. 20 Mana"},{name:"Blood Gamble",type:"Sacrificial",desc:"−15% HP → +50% STR. 25 Mana"}],advanced:[{name:"Titan Breaker",type:"Heavy Damage",desc:"170% STR, ignores 50% DEF. 50 Mana"},{name:"Berserker's Oath",type:"Sacrificial",desc:"−25% HP → +60% STR +20% DEX. 40 Mana"},{name:"War God's Fury",type:"Empowerment",desc:"+80% STR. 50 Mana"}]},
  Guardian:{basic:[{name:"Shield Bash",type:"Stun",desc:"Stuns 1 turn"},{name:"Fortify",type:"Empowerment",desc:"+20% DEF. 10 Mana"},{name:"Iron Guard",type:"Empowerment",desc:"−15% damage next turn"}],intermediate:[{name:"Stone Skin",type:"Empowerment",desc:"+40% DEF. 25 Mana"},{name:"Reinforced Core",type:"Rejuvenation",desc:"+10% HP/turn×3. 20 Mana"},{name:"Taunting Roar",type:"Control",desc:"Locks enemy skills 1 round. 20 Mana"},{name:"Pain Conversion",type:"Sacrificial",desc:"−20% HP → +50% DEF. 25 Mana"}],advanced:[{name:"Aegis of Eternity",type:"Empowerment",desc:"+50% HP. 40 Mana"},{name:"Colossus Form",type:"Empowerment",desc:"+60% DEF +30% HP. 50 Mana"},{name:"Unbreakable Will",type:"Cleanse",desc:"Remove debuffs + 1 turn immunity. 50 Mana"}]},
  Arcanist:{basic:[{name:"Arcane Bolt",type:"Magic Damage",desc:"105% INT. 5 Mana"},{name:"Mana Pulse",type:"Magic Damage",desc:"100% INT. Free"},{name:"Robust Mind",type:"Empowerment",desc:"+20% INT. 10 Mana"}],intermediate:[{name:"Astral Lance",type:"Heavy Magic",desc:"140% INT. 25 Mana"},{name:"Mind Burn",type:"Cont. Damage",desc:"15%/turn×3. 20 Mana"},{name:"Echo-strike",type:"Multi-hit",desc:"Next skill hits twice. 25 Mana"},{name:"Rune Sacrifice",type:"Sacrificial",desc:"−20% HP → +50% INT. 20 Mana"}],advanced:[{name:"Meteorfall",type:"Mighty Magic",desc:"180% INT. 50 Mana"},{name:"Arcane Shower",type:"Empowerment",desc:"+80% INT. 50 Mana"},{name:"Hex",type:"Debuff",desc:"−5% HP/turn×5. 50 Mana"}]},
  Hunter:{basic:[{name:"Pierce",type:"Melee Damage",desc:"105% DEX"},{name:"Hunter's Poison",type:"Debuff",desc:"+10% damage/turn×3. 10 Mana"},{name:"Quick Shot",type:"Utility",desc:"Act first next turn"}],intermediate:[{name:"Split Arrow",type:"Cont. Damage",desc:"+15%/turn×3. 20 Mana"},{name:"Ensnare",type:"Stun",desc:"Immobilize 1 turn"},{name:"Falcon Sight",type:"Empowerment",desc:"+30% DEX. 20 Mana"},{name:"Vital Shot",type:"Heavy Damage",desc:"135% DEX"}],advanced:[{name:"Slayer",type:"Mighty Damage",desc:"170% DEX"},{name:"Predator's Instinct",type:"Empowerment",desc:"+60% DEX. 40 Mana"},{name:"Executioner",type:"Mighty Damage",desc:"200% if target <40% HP. 50 Mana"}]},
  Assassin:{basic:[{name:"Backstab",type:"Heavy Damage",desc:"120% DEX first hit / 110% after"},{name:"Scorching Blade",type:"Debuff",desc:"Burn +15%/turn. 10 Mana"},{name:"Shadow Step",type:"Utility",desc:"Act first next turn. 5 Mana"}],intermediate:[{name:"Thunder Strike",type:"Heavy Damage",desc:"135% DEX"},{name:"Venom Surge",type:"Debuff",desc:"Poison +15%/turn×3. 20 Mana"},{name:"Trickster",type:"Cleanse",desc:"Remove all debuffs. 20 Mana"},{name:"Blood Pact",type:"Sacrificial",desc:"−15% HP → +50% DEX. 25 Mana"}],advanced:[{name:"Death Mark",type:"Mighty Magic",desc:"+60% damage on target. 40 Mana"},{name:"Phantom Assault",type:"Multi-hit",desc:"3×65% damage. 50 Mana"},{name:"Predator",type:"Heavy Damage",desc:"200% vs debuffed enemies. 50 Mana"}]},
  Cleric:{basic:[{name:"Healing Light",type:"Rejuvenation",desc:"+15% HP. 10 Mana"},{name:"Sacred Spark",type:"Damage",desc:"105% INT. 5 Mana"},{name:"Neptune's Embrace",type:"Empowerment",desc:"Allies +20% stats. 15 Mana"}],intermediate:[{name:"Divine Barrier",type:"Shield",desc:"Blocks 80% damage 1 turn. 25 Mana"},{name:"Purify",type:"Cleanse",desc:"Remove all debuffs. 25 Mana"},{name:"Radiant Pulse",type:"Rejuvenation",desc:"+10% HP/turn. 20 Mana"},{name:"Life Exchange",type:"Sacrificial",desc:"−15% HP → allies +20% stats. 20 Mana"}],advanced:[{name:"Sanctuary",type:"Rejuvenation",desc:"+50% total HP. 40 Mana"},{name:"Divine Ascension",type:"Empowerment",desc:"Team +60% all stats. 50 Mana"},{name:"Lazarus",type:"Revive",desc:"Revive ally 50% HP. 50 Mana"}]},
  Summoner:{basic:[{name:"Lashing",type:"Magic Damage",desc:"105% INT. 5 Mana"},{name:"Soul Bind",type:"Stun",desc:"Restrain 1 turn. 10 Mana"},{name:"Essence Sap",type:"Debuff",desc:"10%/turn×4. 10 Mana"}],intermediate:[{name:"Beastmaster",type:"Summon",desc:"Gargoyles 40% INT/turn (max 3). 25 Mana"},{name:"Beast Empowerment",type:"Empowerment",desc:"Summons +30% damage. 25 Mana"},{name:"Usurper",type:"Debuff+Buff",desc:"Steal 5% HP/turn. 25 Mana"},{name:"Offering",type:"Sacrificial",desc:"Lose 1 summon → +20% HP. 20 Mana"}],advanced:[{name:"Leviathan",type:"Summon",desc:"120% INT/turn once. 50 Mana"},{name:"Abyssal-touch",type:"Debuff",desc:"Enemy DEF −40%. 50 Mana"},{name:"Profane Lord",type:"Mighty Magic",desc:"Destroy summons → 200% INT. 50 Mana"}]},
};

// ═══════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════
let _uid      = null;
let _charData = null;
let _chatUnsub = null;
let _travelInterval = null;

// ═══════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════

// ── Load public story quests from Firestore ──
// Dismissed quest IDs for this player (completed/closed cards they've cleared from view)
if (!window._dismissedStoryQuests) {
  // Persist dismissed IDs in localStorage so they survive page refresh
  try {
    const _saved = JSON.parse(localStorage.getItem('dismissedStoryQuests') || '[]');
    window._dismissedStoryQuests = new Set(_saved);
  } catch(e) { window._dismissedStoryQuests = new Set(); }
}

let _storyQuestsUnsub = null;
// IDs seen on first snapshot — used to skip notifying for pre-existing quests
if (!window._knownStoryQuestIds) window._knownStoryQuestIds = null;

function loadPublicStoryQuests() {
  if (_storyQuestsUnsub) { _storyQuestsUnsub(); _storyQuestsUnsub = null; window._knownStoryQuestIds = null; }
  // Return a Promise that resolves after the FIRST snapshot so callers that
  // await this are guaranteed STORY_QUESTS is populated before continuing.
  return new Promise((resolve, reject) => {
  let _resolved = false;
  try {
    const q = query(
      collection(db, "storyQuests"),
      where("assignedTo", "==", null),
      orderBy("createdAt", "desc"),
      limit(100)
    );
    _storyQuestsUnsub = onSnapshot(q, snap => {
      const now = Date.now();
      const isInitialLoad = window._knownStoryQuestIds === null;

      // On first snapshot, seed the known-IDs set — no notifications for existing quests
      if (isInitialLoad) {
        window._knownStoryQuestIds = new Set(snap.docs.map(d => d.id));
      }

      STORY_QUESTS.length = 0;
      snap.forEach(docSnap => {
        const d = docSnap.data();
        const expiresAt = d.expiresAt?.toDate?.() || null;
        const isExpired = expiresAt && expiresAt.getTime() < now;
        const firestoreStatus = d.status || "active";
        const effectiveStatus = (firestoreStatus === "closed" || isExpired) ? "closed" : "active";
        // One-time quest: if completedBy has any entry AND completionType is one_time,
        // treat as closed for players who haven't completed it themselves
        const completionType = d.completionType || 'open';
        const completedBy    = d.completedBy || [];
        const alreadyDoneByMe = completedBy.some(c => c.uid === _uid);
        const lockedOut = completionType === 'one_time' && completedBy.length > 0 && !alreadyDoneByMe;
        const oneTimeEffectiveStatus = lockedOut ? 'closed' : effectiveStatus;

        STORY_QUESTS.push({
          id: docSnap.id,
          title: d.title,
          desc: d.description || d.desc || "",
          type: d.objectives ? "objectives" : "generic",
          objectives: d.objectives || [],
          reward: {
            xp: d.reward?.exp || d.reward?.xp || 0,
            gold: d.reward?.gold || 0,
            item: (d.reward?.items && d.reward.items.length > 0) ? d.reward.items[0] : null
          },
          unlockRank: d.unlockRank || "Wanderer",
          target: d.target || 1,
          expiresAt,
          status: oneTimeEffectiveStatus,
          completionType,
          lockedOut,
        });
      });

      // Notify player about newly posted story quests (skip on initial page load)
      if (!isInitialLoad && _uid) {
        snap.docChanges().forEach(change => {
          if (change.type !== 'added') return;
          const id = change.doc.id;
          if (window._knownStoryQuestIds.has(id)) return;
          window._knownStoryQuestIds.add(id);
          const d = change.doc.data();
          // Skip if already closed or expired
          const exAt = d.expiresAt?.toDate?.() || null;
          if (d.status === 'closed' || (exAt && exAt.getTime() < now)) return;
          const rewardParts = [];
          if (d.reward?.gold) rewardParts.push('\uD83E\uDE99 ' + d.reward.gold + ' gold');
          if (d.reward?.exp)  rewardParts.push('\u2728 ' + d.reward.exp + ' EXP');
          const rewardStr = rewardParts.length ? ' — Reward: ' + rewardParts.join(' · ') : '';
          addDoc(collection(db, 'notifications'), {
            uid: _uid,
            message: '\uD83D\uDCDC <b>New Story Quest:</b> <b>' + d.title + '</b> has been posted by a deity!' + rewardStr,
            read: false,
            type: 'quest-new-story',
            timestamp: serverTimestamp(),
          }).catch(e => console.warn('Story quest notification failed:', e));
        });
      }

      _renderStoryQuests();
      // Resolve on first snapshot so awaiting callers can proceed
      if (!_resolved) { _resolved = true; resolve(); }
    }, e => { console.error("Failed to load story quests:", e); if (!_resolved) { _resolved = true; reject(e); } });
  } catch (e) {
    console.error("Failed to load story quests:", e);
    if (!_resolved) { _resolved = true; reject(e); }
  }
  }); // end Promise
}

// ── Calculate XP threshold for a given level ──
// Base EXP per rank (index 0=Wanderer … 9=Eternal), multiplier ×1.10 per level within rank.
const RANK_BASE_EXP = [100, 150, 225, 340, 500, 750, 1100, 1600, 2300, 3200];
const RANK_EXP_MULT = 1.10;
function _calcXpMax(rankIdx, level) {
  const levelWithinRank = ((level - 1) % 100) + 1;
  const base = RANK_BASE_EXP[Math.min(rankIdx, 9)];
  return Math.round(base * Math.pow(RANK_EXP_MULT, Math.max(0, levelWithinRank - 1)));
}
// Fix: Restore missing function header for _migrateAccountStats
async function _migrateAccountStats(c) {
  const RANK_ORDER_M = ["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"];
  const level    = c.level    || 1;
  const rank     = c.rank     || "Wanderer";
  const rankIdx  = Math.max(0, RANK_ORDER_M.indexOf(rank));

  // Correct hpMax: 100 base + 10 per level-within-rank + 150 per rank ascension
  const levelWithinRankM = ((level - 1) % 100) + 1;
  const correctHpMax   = 100 + (levelWithinRankM * 10) + (rankIdx * 150);
  // Correct manaMax: 50 base + 5 per level-within-rank + 75 per rank ascension
  const correctManaMax = 50  + (levelWithinRankM * 5)  + (rankIdx * 75);
  // Correct statPoints: total earned = 20 (welcome) + 3*levelWithinRank + 25*rankIdx
  // We only patch if hpMax or manaMax is clearly wrong (< expected base)

  const updates = {};
  let needsPatch = false;

  if ((c.hpMax || 100) < correctHpMax) {
    updates.hpMax = correctHpMax;
    // Also clamp current HP to new max if needed
    updates.hp = Math.min(c.hp ?? correctHpMax, correctHpMax);
    needsPatch = true;
  }
  if ((c.manaMax || 50) < correctManaMax) {
    updates.manaMax = correctManaMax;
    updates.mana = Math.min(c.mana ?? correctManaMax, correctManaMax);
    needsPatch = true;
  }
  // Fix xpMax — recalculate from rank base and level
  const correctXpMax = _calcXpMax(rankIdx, level);
  if (Math.abs((c.xpMax || 100) - correctXpMax) > 5) { // tolerance for rounding
    updates.xpMax = correctXpMax;
    // Make sure current xp doesn't exceed new xpMax
    if ((c.xp || 0) >= correctXpMax) updates.xp = correctXpMax - 1;
    needsPatch = true;
  }
  // Fix statPoints: if account has fewer than minimum earned, top it up
  const minPoints = 20 + (levelWithinRankM * 3) + (rankIdx * 25);
  // We only add if current is suspiciously low (< 0 or less than level*3 alone)
  // Don't override if they've been legitimately spent (statPoints could be 0)
  // — just ensure hpMax/manaMax/xpMax are right, leave spent points alone

  if (needsPatch && _uid) {
    try {
      await updateDoc(doc(db, "characters", _uid), updates);
      Object.assign(c, updates);
      console.log("[Migration] Account stats patched:", updates);
    } catch(e) { console.warn("[Migration] patch failed:", e); }
  }
  return c;
}
export function initDashboard() {
  console.log('[DEBUG] initDashboard called');
  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "auth.html"; return; }
    _uid = user.uid;
    // Guard: if this user is a deity, they don't belong on the player dashboard
    try {
      const _userRoleSnap = await getDoc(doc(db, "users", user.uid));
      if (_userRoleSnap.exists() && _userRoleSnap.data().role === "deity") {
        window.location.href = "deity-dashboard.html"; return;
      }
    } catch(_) { /* non-critical, continue */ }
    window.loadNotifications();
    window.loadDivineVisions();
    try {
      const snap = await getDoc(doc(db, "characters", user.uid));
      if (!snap.exists()) { window.location.href = "create-character.html"; return; }
      _charData = snap.data();
      _charData.uid = user.uid; // ensure uid is always available on charData
      // Patch old accounts silently on load
      _charData = await _migrateAccountStats(_charData);
      // Clean up any mistyped inventory items (e.g. equipment stored as material)
      const _cleanedInv = await _stampMissingIids(_charData.inventory || []);
      _charData.inventory = _cleanedInv;
      // Set baseline for faith watcher
      _prevFaithLevel = _charData.faithLevel ?? 0;
      window.startBestowWatcher();
      window.startFaithWatcher();
      populateDashboard(_charData);
      _initPassiveRegen(); // begin offline catch-up + live regen interval

      // Show Deity View button if user has deity role
      try {
        const userSnap = await getDoc(doc(db, 'users', user.uid));
        if (userSnap.exists() && userSnap.data().role === 'deity') {
          const deityBtn = document.getElementById('btn-deity-view');
          if (deityBtn) deityBtn.style.display = '';
        }
      } catch(_) { /* non-critical, silently skip */ }

      await loadPublicStoryQuests();
      loadQuestProgress();
      window._loadQuestSubmissions();
      loadWorldDevelopmentEventsForPlayers();
      checkTravelStatus();
      renderActivityFeed();
      loadFirestoreBosses();
      window.initPubSystem?.(_uid, _charData);
      hideLoading();
    } catch (err) {
      console.error(err);
      window.showToast("Failed to load character.", "error");
      hideLoading();
    }
  });

  // Leave World — sign out first so index.html doesn't auto-redirect back
  window._leaveWorld = async function() {
    try {
      await signOut(auth);
    } catch(e) {
      console.warn("Sign out error:", e);
    }
    window.location.href = "../index.html";
  };

  // Expose functions needed by HTML
  window.saveStats           = saveStats;
  window._chatInit           = initChat;
  window._startTravel        = startTravel;
  window._saveAvatar         = saveAvatar;
  window._buyItem            = buyItem;
  window._sellItem           = sellItem;
  console.log('[DEBUG] window._sellItem set:', typeof window._sellItem);
  window._loadPlayerListings = loadPlayerListings;
  window._confirmProfession  = confirmProfession;
  window._saveQuestProgress  = _saveAllQuestProgress;
}

// ═══════════════════════════════════════════════════
//  POPULATE
// ═══════════════════════════════════════════════════
function populateDashboard(c) {
  window._charData = c;
  // Clamp hp/mana in charData on load — fixes any over-limit values from DB
  const _hpClamped   = Math.min(c.hp   ?? 100, c.hpMax   ?? 100);
  const _manaClamped = Math.min(c.mana ?? 50,  c.manaMax ?? 50);
  if (_hpClamped !== (c.hp ?? 100) || _manaClamped !== (c.mana ?? 50)) {
    c.hp = _hpClamped; c.mana = _manaClamped;
    // Persist correction to Firestore silently
    if (_uid) updateDoc(doc(db, 'characters', _uid), { hp: _hpClamped, mana: _manaClamped }).catch(()=>{});
  }
  // Compute equipment HP bonus early so all HP-max displays are correct
  const _earlyEquipHpBonus = (() => {
    let hp = 0;
    if (c.equipment?.armor) {
      const aBase = c.equipment.armor.replace(/\s*\+\d+$/, '').trim();
      hp = EQUIP_ARMOR_STATS[aBase]?.hp || 0;
    }
    const racePct = getRaceEquipBonus(c.race);
    return Math.round(hp * (1 + racePct));
  })();
  const _effectiveHpMax = (c.hpMax ?? 100) + _earlyEquipHpBonus;
  const classIcon = CLASS_ICONS[c.charClass] || "⚔️";
  const deityIcon = DEITY_ICONS[c.deity]     || "✨";
  const xpPct     = Math.min(100, Math.round(((c.xp||0)/(c.xpMax||100))*100));

  // Avatar
  renderAvatar(c.avatarUrl || classIcon);

  // Sidebar
  set("sb-name",  c.name);
  set("sb-meta",  `${c.rank||"Wanderer"} · Level ${_displayLevel(c.level||1)}`);
  set("sb-xp",    `${c.xp||0} / ${c.xpMax||100}`);
  css("sb-xpfill","width", xpPct+"%");
  set("mobile-header-char", c.name);

  // Overview
  set("panel-welcome",  `Welcome to the Forge, ${c.name}.`);
  set("stat-rank",      c.rank    || "Wanderer");
  set("stat-level",     `Level ${_displayLevel(c.level||1)}`);
  set("stat-gold",      c.gold    ?? 500);
  set("stat-hp",        c.hp      ?? 100);
  set("stat-hp-max",   `/ ${_effectiveHpMax}`);
  set("stat-mana",      c.mana    ?? 50);
  set("stat-mana-max", `/ ${c.manaMax ?? 50}`);
  const overviewLocRaw = (c.kingdom || c.location || "—").split("—")[0].trim();
  const overviewContRaw = c.continent || c.travelContinent || _resolveContinentFromLocation(c) || "";
  set("stat-loc",       overviewLocRaw ? overviewLocRaw.toUpperCase() : "—");
  set("stat-continent", overviewContRaw ? overviewContRaw.toUpperCase() : "");
  set("stat-points",    c.statPoints ?? 20);

  // Character profile
  set("prof-name",         c.name);
  set("prof-name-display", c.name);
  set("prof-title",        (c.titles||[])[0] || "");
  set("prof-rank-badge",   `Rank: ${c.rank||"Wanderer"}`);
  set("prof-race",         c.race       || "—");
  set("prof-race-attr",    c.raceAttr   || "—");
  const buffDesc = _getActiveFoodDesc(c);
  const buffEl = document.getElementById('prof-active-buffs');
  if (buffEl) buffEl.textContent = buffDesc || 'None';
  set("prof-class",        `${classIcon} ${c.charClass||"—"}`);
  set("prof-class-role",   c.classRole  || "—");
  set("prof-deity",        `${deityIcon} ${c.deity||"—"}`);
  set("prof-deity-title",  c.deityTitle || "—");
  // Show deity art in character sheet if available
  const deityArtUrl = DEITY_ART[c.deity];
  const deityArtEl = document.getElementById("prof-deity-art");
  if (deityArtEl && deityArtUrl) {
    deityArtEl.className = 'deity-art';
    deityArtEl.innerHTML = `<img src="${deityArtUrl}" alt="${c.deity}" />`;
    deityArtEl.style.display = "flex";
  }
  set("prof-blessing",     c.blessing   || "—");
  set("prof-blessing-desc",c.blessingDesc||"—");
  // Show kingdom and continent together, just like in Overview
  const kingdom = c.kingdom || c.location || "—";
  const continent = c.continent || c.travelContinent || _resolveContinentFromLocation(c) || "—";
  set("prof-kingdom", `${kingdom}${continent ? ' — ' + continent : ''}`);
  set("prof-continent", continent);
  set("prof-profession",   c.profession || "None yet");
  set("prof-faction",      c.faction    || "None yet");
  // Always refresh companion EXP/level UI using new PET GROWTH curve
  const rankOrder = ["Wanderer","Follower","Disciple","Ascendant","Exalted","Mythic"];
  const hasUnlocked = (rankOrder.indexOf(c.rank) >= 1) || c.isDeity;
  if (c.companion && typeof c.companion === 'object' && c.companion.name) {
    const COMPANION_EXP_TABLE = [0, 1000, 1800, 3000, 4200, 5700, 7000, 9600, 12000, 15000];
    let compLevel = c.companionLevel || 1;
    let compExp = c.companionExp || 0;
    let compXpMax = COMPANION_EXP_TABLE[compLevel-1] || 1000;
    while (compLevel < 10 && compExp >= compXpMax) {
      compExp -= compXpMax;
      compLevel++;
      compXpMax = COMPANION_EXP_TABLE[compLevel-1] || compXpMax;
    }
    set("prof-companion", `${c.companion.name} (Lv.${compLevel} — ${compExp}/${compXpMax} EXP)`);
  } else if (hasUnlocked) {
    set("prof-companion", "None yet");
  } else {
    set("prof-companion", "Unlocks at Follower rank");
  }
  set("prof-sex",          c.sex        || "—");
  set("prof-age",          c.age        || "—");
  set("prof-bio",          c.bio        || "No history written yet.");

  set("s-hp",    `${c.hp??100} / ${_effectiveHpMax}`);
  set("s-mana",  `${c.mana??50} / ${c.manaMax??50}`);
  set("s-gold",  c.gold  ?? 100);
  set("s-xp",    `${c.xp??0} / ${c.xpMax??100}`);
  set("s-faith", c.faithLevel ?? 0);
  set("s-rep",   c.reputation ?? 0);
  // Inventory must be set BEFORE _renderEquipPanel so enchant/grade lookups work
  window._allInvItems = c.inventory || [];
  _renderEquipPanel(c);

  // Stat allocation + equipment bonuses
  const stats = c.stats || { str:10, int:10, def:10, dex:10 };
  const pts   = c.statPoints ?? 20;
  // Equipment bonuses
  let equipBonus = { str:0, int:0, def:0, dex:0, hp:0 };
  if (c.equipment?.weapon) {
    const wBase = c.equipment.weapon.replace(/\s*\+\d+$/, '').trim();
    const w = EQUIP_WEAPON_STATS[wBase];
    if (w) {
      // Find enchant level from inventory item
      const wEnchant = (window._allInvItems || []).find(i => (i.name||'').replace(/\s*\+\d+$/,'').trim() === wBase)?.enchantLevel || 0;
      for (const k in w) equipBonus[k] = (equipBonus[k]||0) + w[k] + (w[k] ? wEnchant : 0);
    }
  }
  if (c.equipment?.armor) {
    const aBase = c.equipment.armor.replace(/\s*\+\d+$/, '').trim();
    const a = EQUIP_ARMOR_STATS[aBase];
    if (a) {
      const aEnchant = (window._allInvItems || []).find(i => (i.name||'').replace(/\s*\+\d+$/,'').trim() === aBase)?.enchantLevel || 0;
      for (const k in a) equipBonus[k] = (equipBonus[k]||0) + a[k] + (a[k] ? aEnchant : 0);
    }
  }
  // Race bonus
  const raceBonusPct = getRaceEquipBonus(c.race);
  for (const k in equipBonus) equipBonus[k] = Math.round(equipBonus[k] * (1 + raceBonusPct));
  // Total stats
  const totalStats = {
    str:   (stats.str??10) + (equipBonus.str||0),
    int:   (stats.int??10) + (equipBonus.int||0),
    def:   (stats.def??10) + (equipBonus.def||0),
    dex:   (stats.dex??10) + (equipBonus.dex||0),
    // Armor HP bonus boosts max HP display, not current HP
    hpMax: _effectiveHpMax
  };
  window._baseStats    = { ...stats };
  window._pendingStats = { ...stats };
  window._statPoints   = pts;
  // Show base stat + gear bonus inline: "142 +14 STR" style
  function _setStatWithBonus(elId, baseVal, bonusVal) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (bonusVal > 0) {
      el.innerHTML = `${baseVal} <span class="stat-equip-bonus">+${bonusVal}</span>`;
    } else {
      el.textContent = baseVal;
    }
  }
  _setStatWithBonus("a-str", (stats.str??10), equipBonus.str||0);
  _setStatWithBonus("a-int", (stats.int??10), equipBonus.int||0);
  _setStatWithBonus("a-def", (stats.def??10), equipBonus.def||0);
  _setStatWithBonus("a-dex", (stats.dex??10), equipBonus.dex||0);
  set("s-points", pts);
  const hint = document.getElementById("alloc-hint");
  if (hint) hint.style.display = pts > 0 ? "block" : "none";

  // Skills
  buildSkillTree(c.charClass, c.rank||"Wanderer");
  set("skills-subtitle", `${classIcon} ${c.charClass||""} skill tree — 2 skills unlock per rank ascension`);

  // Inventory
  window.renderInventory(window._allInvItems);
  buildDeityIngredients(c.deity);

  // Profession
  if (c.profession) showActiveProfession(c);
  else { const el = document.getElementById("profession-pick-section"); if (el) el.style.display = "block"; }

  // Chat location
  set("chat-loc-name", c.kingdom || c.location || "Unknown");
  const icon = c.continent?.includes("Northern") ? "❄️" : c.continent?.includes("Western") ? "🌿" : "📍";
  set("chat-loc-icon", icon);
}

// ═══════════════════════════════════════════════════
//  AVATAR
// ═══════════════════════════════════════════════════
function renderAvatar(avatarVal) {
  // avatarVal is either an emoji string or a URL
  const isUrl   = avatarVal?.startsWith("http");
  const sbEl    = document.getElementById("sb-avatar");
  const profEl  = document.getElementById("prof-avatar-img");

  const content = isUrl
    ? `<img src="${avatarVal}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
    : `<span style="font-size:1.3rem">${avatarVal}</span>`;

  if (sbEl)   sbEl.innerHTML   = content;
  if (profEl) profEl.innerHTML = content;
}

async function saveAvatar(selectedPreset, uploadedFile) {
  const btn = document.getElementById("btn-save-avatar");
  if (!selectedPreset && !uploadedFile) {
    window.showToast("Select a preset or upload an image.", "error"); return;
  }
  btn.disabled = true; btn.textContent = "SAVING...";

  try {
    let avatarVal = selectedPreset;

    if (uploadedFile) {
      // Upload to Firebase Storage
      const ext  = uploadedFile.name.split('.').pop() || 'jpg';
      const path = `avatars/${_uid}.${ext}`;
      const ref  = storageRef(storage, path);
      await uploadBytes(ref, uploadedFile);
      avatarVal  = await getDownloadURL(ref);
    }

    await updateDoc(doc(db, "characters", _uid), { avatarUrl: avatarVal });
    if (_charData) _charData.avatarUrl = avatarVal;
    window._charData = _charData;
    renderAvatar(avatarVal);
    document.getElementById("avatar-modal").style.display = "none";
    window.showToast("Avatar updated!", "success");
  } catch(err) {
    console.error(err);
    window.showToast("Failed to save avatar. Try again.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "SAVE AVATAR";
  }
}

// ═══════════════════════════════════════════════════
//  STAT ALLOCATION
// ═══════════════════════════════════════════════════
async function saveStats() {
  if (!_uid) return;
  const btn = document.getElementById("btn-save-stats");
  btn.disabled = true; btn.textContent = "SAVING...";
  try {
    await updateDoc(doc(db, "characters", _uid), {
      stats:      window._pendingStats,
      statPoints: window._statPoints,
    });
    window._baseStats = { ...window._pendingStats };
    btn.style.display = "none";
    btn.disabled = false; btn.textContent = "SAVE STAT ALLOCATION";
    window.showToast("Stats saved!", "success");
    set("stat-points", window._statPoints);
    const hint = document.getElementById("alloc-hint");
    if (hint) hint.style.display = window._statPoints > 0 ? "block" : "none";
  } catch(err) {
    console.error(err);
    window.showToast("Failed to save. Try again.", "error");
    btn.disabled = false; btn.textContent = "SAVE STAT ALLOCATION";
  }
}

// ═══════════════════════════════════════════════════
//  SKILL TREE
// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
//  STANCE SELECTION MODAL — intercepts all battle starts
// ═══════════════════════════════════════════════════

const STANCE_MODE_LABELS = {
  farming: 'FARMING',
  auto:    'AUTO-BATTLE',
  boss:    'BOSS RAID',
  pvp:     'PVP',
};
const STANCE_MODE_HINTS = {
  farming: 'Tip: For farming, 1–2 burst damage skills is enough.',
  auto:    'Tip: For auto-battle, reliable low-mana skills work best.',
  boss:    'Tip: For raids, consider your role — tanking, damage, or support.',
  pvp:     'Tip: For PvP, mix damage, heals, and stuns for control.',
};

let _stanceModalCallback = null;
let _stanceModalSelected = null; // idx

// Show the modal. mode = 'farming' | 'auto' | 'boss' | 'pvp'
// onConfirm(selectedIdx) is called when player locks in a stance
window._showStanceModal = function(mode, onConfirm) {
  const modal    = document.getElementById('stance-select-modal');
  const modeTag  = document.getElementById('stance-select-mode-tag');
  const subtitle = document.getElementById('stance-select-subtitle');
  const emptyEl  = document.getElementById('stance-select-empty');
  const listEl   = document.getElementById('stance-select-list');
  if (!modal) return onConfirm(window._activeStanceIdx); // fallback if modal missing

  const stances = _getStances();
  const hasAny  = stances.some(s => s?.name);

  modeTag.textContent  = STANCE_MODE_LABELS[mode] || mode.toUpperCase();
  subtitle.textContent = STANCE_MODE_HINTS[mode]  || 'Select a skill set before entering battle.';

  _stanceModalCallback = onConfirm;
  // Pre-select whatever was active before; if none, default to first available
  _stanceModalSelected = window._activeStanceIdx;
  if (_stanceModalSelected === null) {
    const firstIdx = stances.findIndex(s => s?.name);
    if (firstIdx >= 0) _stanceModalSelected = firstIdx;
  }

  if (!hasAny) {
    emptyEl.style.display = 'block';
    listEl.innerHTML = '';
  } else {
    emptyEl.style.display = 'none';
    _renderStanceSelectList(stances);
  }

  modal.style.display = 'flex';
};

function _renderStanceSelectList(stances) {
  const listEl = document.getElementById('stance-select-list');
  if (!listEl) return;

  listEl.innerHTML = stances.map((s, i) => {
    if (!s?.name) return '';
    const isActive = _stanceModalSelected === i;
    const chips = (s.skills || []).map(sk =>
      `<span class="stance-select-skill-chip">${sk}</span>`
    ).join('');
    return `<div class="stance-select-card${isActive ? ' stance-select-card--active' : ''}"
                 onclick="window._stanceModalSelect(${i})">
      <div class="stance-select-card-num">${i+1}</div>
      <div class="stance-select-card-body">
        <div class="stance-select-card-name">${s.name}</div>
        <div class="stance-select-skills">${chips || '<span style="color:var(--text-dim);font-size:0.7rem;font-style:italic">No skills added</span>'}</div>
      </div>
      <div class="stance-select-card-check">${isActive ? '✓' : ''}</div>
    </div>`;
  }).join('');

  // Add confirm button
  listEl.innerHTML += `<button class="stance-select-confirm-btn"
    id="stance-select-confirm"
    ${_stanceModalSelected === null ? 'disabled' : ''}
    onclick="window._stanceModalConfirm()">
    ENTER BATTLE
  </button>`;
}

window._stanceModalSelect = function(idx) {
  _stanceModalSelected = idx;
  // Update active state on cards
  document.querySelectorAll('.stance-select-card').forEach((el, i) => {
    const isActive = i === idx;
    el.classList.toggle('stance-select-card--active', isActive);
    const check = el.querySelector('.stance-select-card-check');
    if (check) check.textContent = isActive ? '✓' : '';
  });
  const confirmBtn = document.getElementById('stance-select-confirm');
  if (confirmBtn) confirmBtn.disabled = false;
};

window._stanceModalConfirm = function() {
  // Recover if _stanceModalSelected is null despite button being enabled
  if (_stanceModalSelected === null) {
    const stances = _getStances();
    const firstIdx = stances.findIndex(s => s?.name);
    if (firstIdx < 0) return; // truly no stances
    _stanceModalSelected = firstIdx;
  }
  // Persist the selection as the active stance
  window._activeStanceIdx = _stanceModalSelected;
  console.log('[BATTLE] _stanceModalConfirm: selected stance index =', _stanceModalSelected);
  renderStancesGrid?.();
  renderBattleStancePicker?.();
  // Save callback BEFORE _closeStanceModal() nulls it
  const cb = _stanceModalCallback;
  window._closeStanceModal();
  console.log('[BATTLE] Calling stance modal callback');
  if (cb) cb(_stanceModalSelected);
};

window._closeStanceModal = function() {
  const modal = document.getElementById('stance-select-modal');
  if (modal) {
    modal.style.display = 'none';
    console.log('[BATTLE] Stance modal closed');
  }
  _stanceModalCallback = null;
};

window._stanceModalGoToSkills = function() {
  window._closeStanceModal();
  if (typeof switchPanel === 'function') switchPanel('skills');
};

// ── Battle entry point intercepts are installed after all real functions are defined.
// ── See: _installStanceInterceptors() called at the bottom of the file.

// ═══════════════════════════════════════════════════
//  STANCES SYSTEM
// ═══════════════════════════════════════════════════

window._activeStanceIdx = null;   // 0 | 1 | 2 | null
let _editingStanceIdx   = null;   // which slot is being edited

// Return player's stances array (always 3 slots)
function _getStances() {
  const raw = _charData?.stances || [];
  const out = [null, null, null];
  for (let i = 0; i < 3; i++) out[i] = raw[i] || null;
  return out;
}

// Persist stances to Firestore
async function _saveStances(stances) {
  if (!_uid) return;
  try {
    await updateDoc(doc(db, 'characters', _uid), { stances });
    if (_charData) _charData.stances = stances;
  } catch(e) { console.warn('Failed to save stances:', e); }
}

// Get all unlocked skills for the player's class, in tier order
function _getUnlockedSkillPool() {
  const RANK_ORDER_S = ["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"];
  const rankIdx = RANK_ORDER_S.indexOf(_charData?.rank || "Wanderer");
  const tree = SKILL_TREES[_charData?.charClass] || {};
  return [
    { tierLabel: "BASIC",        tier: 0, skills: tree.basic        || [] },
    { tierLabel: "INTERMEDIATE", tier: 1, skills: tree.intermediate || [] },
    { tierLabel: "ADVANCED",     tier: 2, skills: tree.advanced     || [] },
  ].map(t => ({ ...t, unlocked: rankIdx >= t.tier }));
}

// Render the 3 stance cards
function renderStancesGrid() {
  const grid = document.getElementById('stances-grid');
  if (!grid) return;
  const stances = _getStances();
  const activeIdx = window._activeStanceIdx;

  grid.innerHTML = stances.map((s, i) => {
    if (!s || !s.name) {
      return `<div class="stance-card stance-card--empty" onclick="openStanceEditor(${i})">
        <div class="stance-empty-plus">＋</div>
        <div class="stance-empty-label">EMPTY STANCE ${i+1}</div>
        <div class="stance-empty-label" style="font-size:0.5rem;margin-top:2px;opacity:0.6">Tap to configure</div>
      </div>`;
    }
    const isActive = activeIdx === i;
    const skillTags = (s.skills || []).map(sk =>
      `<span class="stance-skill-tag">${sk}</span>`
    ).join('');
    return `<div class="stance-card ${isActive ? 'stance-card--active' : ''}">
      <div class="stance-card-index">STANCE ${i+1}</div>
      <div class="stance-card-name">${s.name}</div>
      <div class="stance-skill-tags">${skillTags || '<span style="color:var(--text-dim);font-size:0.7rem;font-style:italic">No skills selected</span>'}</div>
      <div class="stance-card-actions">
        <button class="stance-btn-activate" onclick="setActiveStance(${i})">${isActive ? '✓ ACTIVE' : 'ACTIVATE'}</button>
        <button class="stance-btn-edit" onclick="openStanceEditor(${i})">EDIT</button>
      </div>
    </div>`;
  }).join('');

  // Show/hide active bar
  const bar = document.getElementById('stance-active-bar');
  const nameEl = document.getElementById('stance-active-name');
  if (bar && nameEl) {
    if (activeIdx !== null && stances[activeIdx]?.name) {
      bar.style.display = 'flex';
      nameEl.textContent = stances[activeIdx].name;
    } else {
      bar.style.display = 'none';
    }
  }
}

// Open editor for a specific stance slot
window.openStanceEditor = function(idx) {
  _editingStanceIdx = idx;
  const stances = _getStances();
  const s = stances[idx] || { name: '', skills: [] };

  const overlay = document.getElementById('stance-editor-overlay');
  const titleEl = document.getElementById('stance-editor-title');
  const nameInput = document.getElementById('stance-name-input');
  const poolEl = document.getElementById('stance-skill-pool');
  const errEl = document.getElementById('stance-editor-error');

  if (!overlay || !poolEl) return;
  titleEl.textContent = `EDIT STANCE ${idx + 1}`;
  nameInput.value = s.name || '';
  if (errEl) errEl.textContent = '';

  // Build skill pool
  const tiers = _getUnlockedSkillPool();
  const selected = new Set(s.skills || []);

  poolEl.innerHTML = tiers.map(t => {
    const tierSkillsHtml = t.skills.map(sk => {
      const data = SKILL_DATA[sk.name] || {};
      const isSelected = selected.has(sk.name);
      const isLocked = !t.unlocked;
      const manaLabel = data.mana > 0 ? `${data.mana} MP` : 'Free';
      const safeSkillName = sk.name.replace(/'/g, "\\'");
      return `<div class="stance-pool-skill${isSelected ? ' selected' : ''}${isLocked ? ' locked-skill' : ''}"
                   data-skill="${sk.name.replace(/"/g, '&quot;')}"
                   onclick="${isLocked ? '' : `stanceToggleSkill(this,'${safeSkillName}')`}">
        <div class="stance-pool-skill-check">${isSelected ? '✓' : ''}</div>
        <div class="stance-pool-skill-info">
          <div class="stance-pool-skill-name">${sk.name}</div>
          <div class="stance-pool-skill-meta">${manaLabel} · ${sk.desc || sk.type}</div>
        </div>
        <span class="stance-pool-skill-type">${sk.type}</span>
        ${isLocked ? '<span style="font-size:0.6rem;color:var(--text-dim)">🔒</span>' : ''}
      </div>`;
    }).join('');
    return `<div class="stance-pool-tier-label">${t.tierLabel}${!t.unlocked ? ' — LOCKED' : ''}</div>${tierSkillsHtml}`;
  }).join('');

  overlay.style.display = 'flex';
};

// Toggle a skill in the editor
window.stanceToggleSkill = function(el, skillName) {
  const pool = document.getElementById('stance-skill-pool');
  const selected = pool.querySelectorAll('.stance-pool-skill.selected');
  const isSelected = el.classList.contains('selected');
  if (!isSelected && selected.length >= 4) {
    const errEl = document.getElementById('stance-editor-error');
    if (errEl) { errEl.textContent = 'Maximum 4 skills per stance.'; setTimeout(() => errEl.textContent = '', 2000); }
    return;
  }
  el.classList.toggle('selected', !isSelected);
  const check = el.querySelector('.stance-pool-skill-check');
  if (check) check.textContent = isSelected ? '' : '✓';
};

// Save stance from editor
window.saveStanceEdit = async function() {
  const nameInput = document.getElementById('stance-name-input');
  const pool = document.getElementById('stance-skill-pool');
  const errEl = document.getElementById('stance-editor-error');
  const name = nameInput?.value.trim();
  if (!name) { if (errEl) errEl.textContent = 'Please give your stance a name.'; return; }

  const selectedEls = pool.querySelectorAll('.stance-pool-skill.selected');
  const skills = Array.from(selectedEls).map(el => el.dataset.skill);

  const stances = _getStances();
  stances[_editingStanceIdx] = { name, skills };
  await _saveStances(stances);

  // If this was the active stance, keep it active
  closeStanceEditor();
  renderStancesGrid();
  renderBattleStancePicker();
  window.showToast?.(`Stance "${name}" saved!`, 'success');
};

window.closeStanceEditor = function() {
  const overlay = document.getElementById('stance-editor-overlay');
  if (overlay) overlay.style.display = 'none';
  _editingStanceIdx = null;
};

// Set/toggle active stance
window.setActiveStance = function(idx) {
  const stances = _getStances();
  if (!stances[idx]?.name) { openStanceEditor(idx); return; }
  window._activeStanceIdx = (window._activeStanceIdx === idx) ? null : idx;
  renderStancesGrid();
  renderBattleStancePicker();
};

window.clearActiveStance = function() {
  window._activeStanceIdx = null;
  renderStancesGrid();
  renderBattleStancePicker();
};

// Render stance picker in the battle panel
function renderBattleStancePicker() {
  const picker = document.getElementById('battle-stance-picker');
  const btnsEl = document.getElementById('battle-stance-btns');
  const hintEl = document.getElementById('battle-stance-active-hint');
  if (!picker || !btnsEl) return;

  const stances = _getStances();
  const hasAny  = stances.some(s => s?.name);
  if (!hasAny) { picker.style.display = 'none'; return; }

  picker.style.display = 'block';
  const activeIdx = window._activeStanceIdx;

  btnsEl.innerHTML = stances.map((s, i) => {
    if (!s?.name) return '';
    const isActive = activeIdx === i;
    return `<button class="battle-stance-option${isActive ? ' battle-stance-selected' : ''}"
                    onclick="window.setActiveStance(${i})">${s.name}</button>`;
  }).join('') +
  `<button class="battle-stance-option battle-stance-none${activeIdx === null ? ' battle-stance-selected' : ''}"
           onclick="window.clearActiveStance()">All Skills</button>`;

  if (hintEl) {
    if (activeIdx !== null && stances[activeIdx]?.name) {
      const sk = stances[activeIdx].skills || [];
      hintEl.textContent = sk.length
        ? `${stances[activeIdx].name}: ${sk.join(' · ')}`
        : `${stances[activeIdx].name}: No skills selected`;
    } else {
      hintEl.textContent = 'Using all available skills.';
    }
  }
}

// Get the effective skill list for battle (respects active stance)
function _getActiveBattleSkills() {
  const activeIdx = window._activeStanceIdx;
  const stances   = _getStances();
  if (activeIdx !== null && stances[activeIdx]?.skills?.length) {
    return stances[activeIdx].skills
      .map(n => ({ name: n, ...(SKILL_DATA[n] || {}) }))
      .filter(s => s.type);
  }
  // No stance — use full class list (rank-gated)
  const RANK_ORDER_S = ["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"];
  const rankIdx = RANK_ORDER_S.indexOf(_charData?.rank || "Wanderer");
  const unlockedCount = Math.max(2, rankIdx * 2 + 2);
  return (BATTLE_SKILLS[_charData?.charClass] || [])
    .slice(0, unlockedCount)
    .map(n => ({ name: n, ...(SKILL_DATA[n] || {}) }))
    .filter(s => s.type);
}
window._getActiveBattleSkills = _getActiveBattleSkills;

function buildSkillTree(charClass, rank) {
  const container = document.getElementById("skill-tree-container");
  if (!container) return;
  const tree = SKILL_TREES[charClass];
  if (!tree) { container.innerHTML = `<p style="color:var(--text-dim);font-style:italic">No skill tree for class: ${charClass}</p>`; return; }

  const rankIdx = RANK_ORDER.indexOf(rank);
  const sections = [
    { key:"basic",        label:"Basic Skills",        unlock:"Wanderer", idx:0 },
    { key:"intermediate", label:"Intermediate Skills", unlock:"Follower", idx:1 },
    { key:"advanced",     label:"Advanced Skills",     unlock:"Disciple", idx:2 },
  ];

  container.innerHTML = sections.map(sec => {
    const unlocked = rankIdx >= sec.idx;
    return `
      <div class="skill-section ${unlocked?'':'skill-section-locked'}">
        <div class="skill-section-header">
          <span class="skill-section-title">${sec.label}</span>
          <span class="skill-unlock-rank ${unlocked?'unlocked':'locked'}">${unlocked?'✓ Unlocked':'🔒 Requires '+sec.unlock+' rank'}</span>
        </div>
        <div class="skill-grid">
          ${(tree[sec.key]||[]).map((s,i)=>`
            <div class="skill-card ${unlocked?'skill-available':'skill-locked'}">
              <div class="skill-card-header">
                <span class="skill-name">${s.name}</span>
                <span class="skill-type-badge">${s.type}</span>
              </div>
              <div class="skill-desc">${s.desc}</div>
              ${unlocked?`<div class="skill-slot">Slot ${i+1}</div>`:''}
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');

  // Render stances and battle picker after tree is built
  renderStancesGrid();
  renderBattleStancePicker();
}

// ═══════════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════════

const ITEM_ICONS = {
  // ── POTIONS ──────────────────────────────────────────────
  "Minor HP Potion":          "🫧", "Standard HP Potion":       "🧴", "Greater HP Potion":        "❤️‍🔥",
  "Minor Mana Potion":        "💠", "Standard Mana Potion":     "🔹", "Greater Mana Potion":      "🌀",
  "Minor Luck Potion":        "🍀", "Standard Luck Potion":     "☘️", "Greater Luck Potion":      "🌠",
  "Minor EXP Potion":         "✨", "Standard EXP Potion":      "⭐", "Greater EXP Potion":       "🌟",
  "Health Potion":            "🫧", "Mana Potion":              "💠",
  "Class Reset Potion":       "⚗️", "Race Rebirth Potion":      "🌀", "Divine Shift Potion":      "🔮",
  "Stat Reset Potion":        "🔄", "Companion Change Potion":  "🐾", "Resurrection Potion":      "💀",

  // ── FOOD — STRENGTH ──────────────────────────────────────
  "Grilled Meat Skewer":      "🍢", "Spiced Steak":             "🥩", "Hunter's Feast":           "🍖",
  "Dragonfire Roast":         "🔥", "Eden Banquet":             "🌺",

  // ── FOOD — INTELLIGENCE ──────────────────────────────────
  "Herb Fish Soup":           "🍵", "Glow Stew":                "🌙", "Mystic Broth":             "🫕",
  "Celestial Sashimi":        "🍣", "Cosmic Infusion":          "🌌",

  // ── FOOD — DEFENSE ───────────────────────────────────────
  "Roasted Carp":             "🐟", "Ironbody Stew":            "🍲", "Frosthide Meal":           "❄️",
  "Titan Shell Dish":         "🐚", "Eternal Fortress Feast":   "🏰",

  // ── FOOD — DEXTERITY ─────────────────────────────────────
  "Fried Sardine":            "🐠", "Crystal Splash Meal":      "💧", "Assassin's Dish":          "🌶️",
  "Phantom Platter":          "👁️", "Divine Speed Feast":       "⚡",

  // ── MINER RESOURCES ──────────────────────────────────────
  "Iron":                     "⬛", "Coal":                     "🪨", "Copper":                   "🟤",
  "Tin":                      "🪙", "Limestone":                "🟫", "Silver":                   "⬜",
  "Bronze":                   "🟠", "Gold":                     "🟡", "Mythril":                  "💜",
  "Palladium":                "🔵", "Obsidian":                 "🖤", "Marble":                   "🏛️",
  "Quartz":                   "💎", "Titanium":                 "🔩", "Adamantium":               "⚙️",
  "Aetherium":                "🌌",
  "Runestone Fragment":       "🔷", "Starstone":                "⭐", "Darkore":                  "🌑",
  "Ancient Ore":              "🏺", "Core Fragment":            "🔮",
  "Primordial Stone":         "🌋",

  // ── FORAGER RESOURCES ────────────────────────────────────
  "Apples":                   "🍎", "Blueberries":              "🫐", "Melons":                   "🍈",
  "Golden Pears":             "🍐", "Moon Grapes":              "🍇", "Sunfruit":                 "🌞",
  "Crystal Berries":          "💎", "Bitter Root":              "🌱", "Spirit Plum":              "🟣",
  "Frost Apples":             "❄️", "Ember Fruit":              "🔥", "Celestial Fig":            "🍇",
  "Dragonfruit":              "🐉", "Eden's Tear":              "💧",
  "Garlic":                   "🧄",
  "Silverleaf":               "🍃", "Basil Sprigs":             "🌿", "Goldroot":                 "🌾",
  "Lotus":                    "🌸",
  "Nightshade":               "🌑", "Glowleaf":                 "💚", "Spirit Herb":              "🌿",
  "Jade Vine":                "🪴", "Ghost Root":               "👻", "Void Orchid":              "🟣",

  // ── HERBALIST RESOURCES ──────────────────────────────────
  "Mint Leaves":              "🌿", "Soft Bark":                "🪵", "Wild Herbs":               "🌱",
  "Mushroom":                 "🍄",
  "Healing Fern":             "☘️", "Glow Moss":                "💚", "Dream Lily":               "🌷",
  "Ancient Herb":             "🌿", "Spirit Root":              "🥕", "Veilbloom":                "🪷",
  "Orb of Silence":           "🔮", "Eye of All-knowing":       "👁️",
  "Tears of The Endless Goldfish": "💧",

  // ── ANGLER RESOURCES ─────────────────────────────────────
  "Trout":                    "🐟", "Carp":                     "🐠", "Catfish":                  "🐡",
  "Sardine":                  "🐡", "Pufferfish":               "🐡",
  "Silverfin":                "⬜", "Glowfish":                 "💚", "Spotted Eel":              "🐍",
  "Coral Snapper":            "🪸", "Red Minnow":               "🔴",
  "Shadowfish":               "🖤", "Flamefish":                "🔥", "Ying Koi":                 "🟡",
  "Celestial Whale":          "🐳", "Black Unagi":              "🖤", "Cosmic Leviathan":         "🌌",

  // ── HUNTER RESOURCES ─────────────────────────────────────
  "Raw Meat":                 "🥩", "Bone Fragments":           "🦴", "Tough Hide":               "🟤",
  "Leather":                  "🟫", "Feathers":                 "🪶", "Animal Fat":               "🫙",
  "Fangs":                    "🦷", "Fur":                      "🦊", "Horns":                    "🦌",
  "Claws":                    "🐾", "Spirit Venison":           "✨", "Shadow Hide":              "🖤",
  "Drake Meat":               "🐉", "Titan Heart":              "❤️‍🔥",
  "Quality Pelt":             "🦊", "Wolf Fang":                "🐺", "Bear Claw":                "🐻",
  "Beast Core":               "💠", "Phantom Feather":          "🪶", "Blood Crystal":            "🔴",
  "Divine Bull Essence":      "🐂", "Heart of the Red Phoenix": "🔥",
  "Forgotten Desire Seed":    "🌑",

  // ── DEITY / SPECIAL MATERIALS ────────────────────────────
  "Scales of Equilibrium":    "⚖️", "The Void-Eye":             "👁️", "Gem of Luminance":         "💎",
  "Crimson Toad Moss":        "🔴", "Branch of Soul Tree":      "🌲", "Bloom Petals":             "🌸",
  "Moon Petals":              "🌕",
  "Ancient Scroll Fragments": "📜", "White Mystic Woods":       "🌳", "Truths":                   "📖",
  "Crystallized Night Dews":  "🔵",
  "Oil-stained Feathers":     "🪶", "Ephemeral Footprints":     "👣", "Devil-Spring Water":       "🌊",
  "Iron Oaths":               "⛓️", "Broken Shackles":          "🔗", "Verdict Quill":            "🖊️",
  "Volcanic Roots":           "🌋", "Ash of Elder Trees":       "🌫️",

  // ── LOOT DROP MATERIALS ───────────────────────────────────
  "Wood":                     "🪵", "Herb":                     "🌿", "Silk Thread":              "🧵",
  "Magic Crystal":            "💎", "Ancient Rune":             "🔷", "Fire Essence":             "🔥",
  "Water Essence":            "💧", "Wind Essence":             "🌬️", "Earth Essence":            "🌍",
  "Dragon Scales":            "🐉", "Cyclops Eye":              "👁️", "Phoenix Bloom":            "🌺",
  "Titanium":                 "🔩", "Adamantium":               "⚙️", "Celestial Fig":            "🍇",
  "Middlemist":               "🌸", "Void Crystal":             "🟣",

  // ── RUNESTONES ───────────────────────────────────────────
  "E-grade Runestone":        "🔸", "D-grade Runestone":        "🔶",
  "C-grade Runestone":        "🟠", "B-grade Runestone":        "🔴",
  "A-grade Runestone":        "🟣", "S-grade Runestone":        "⬛",

  // ── WEAPONS (by type hint) ───────────────────────────────
  "Rusted Greatsword":        "⚔️", "Crude Bow":                "🏹", "Iron Dagger":              "🗡️",
  "Apprentice Wand":          "🪄", "Shortblade":               "🗡️", "Bone Mace":                "🪓",
  "Hunter Knife":             "🔪", "Quartz Rod":               "🔮", "Tin Blade":                "⚔️",
  "Feather Knife":            "🔪",
  "Obsidian Greatsword":      "⚔️", "Silver Wand":              "🪄", "Longbow":                  "🏹",
  "Twin Daggers":             "🗡️", "Warhammer":                "🔨", "Arc Rod":                  "🔮",
  "Bronze Blade":             "⚔️", "Hunter Bow":               "🏹", "Spiked Mace":              "🪓",
  "Mystic Knife":             "🔪",
  "Silver Greatsword":        "⚔️", "Arcane Staff":             "🪄", "Composite Bow":            "🏹",
  "Assassin Daggers":         "🗡️", "Mystic Blade":             "⚔️", "Spellknife":               "🔪",
  "Dagon Bow":                "🏹", "Bronze Cleaver":           "🪓", "Dark Rod":                 "🔮", "War Maul":                 "🔨",
  "Myth-Blade":               "⚔️", "High-Scepter":             "🪄", "Draconic Bow":             "🏹",
  "Shadow-Strike":            "🗡️", "Warbreaker":               "🔨", "Mystic Jian":              "⚔️",
  "Phantom Longbow":          "🏹", "Spellhammer":              "🔨", "Venom Daggers":            "🗡️",
  "Ancient Wand":             "🪄",
  "Eragon-blade":             "⚔️", "Void-Steel":               "⚔️", "Star Lance":               "✨",
  "Crack":                    "💥", "Divine Fall":              "⚡", "Nether-Bow":               "🏹",
  "Holy Relic":               "🔱", "Realm Cleaver":            "⚔️", "BeastFang":                "🦷",
  "Scion":                    "🌿",
  "Abjuration":               "🔮", "Genesis":                  "🌟", "Longinus":                 "⚔️",
  "Jingu Bang":               "🪄", "Ragnarok":                 "⚡", "Godslayer":                "💀",
  "Durandal":                 "⚔️", "Excalibur":                "✨", "Bane":                     "☠️",
  "Judgment":                 "⚖️",

  // ── ARMOR (E-GRADE) ───────────────────────────────────────
  "Leather Vest":             "🥋", "Iron Plate":               "⛓️", "Bone Armor":               "🦴",
  "Fur Coat":                 "🧥", "Hide Armor":               "🟤", "Feather Cloak":            "🪶",
  "Tin Armor":                "⬜", "Copper Plate":             "🟠", "Marble Guard":             "🏛️",
  "Obsidian Layer":           "🖤",

  // ── ARMOR (D-GRADE) ───────────────────────────────────────
  "Steel Armor":              "🔷", "Reinforced Leather":       "🟤", "Silver Guard":             "⬜",
  "Bone Plate":               "🦷", "Fur Armor":                "🦊", "Horned Armor":             "🦌",
  "Scale Vest":               "🐍", "Bronze Armor":             "🟫", "Obsidian Plate":           "🌑",
  "Marble Armor":             "🏛️",

  // ── ARMOR (C-GRADE) ───────────────────────────────────────
  "Shining Armor":            "✨", "Bronze Cuirass":           "🟡", "Jagged Chainmail":         "⛓️",
  "Bone Fortress":            "🏚️", "Obsidian Vest":            "🖤", "Reptilian Scale":          "🦎",
  "Shadow Cloak":             "🌑", "Golden Cape":              "🟡", "Warlord Hide":             "🐗",
  "Arcane Shell":             "🔮",

  // ── ARMOR (B-GRADE) ───────────────────────────────────────
  "Void-Spell Armor":         "🟣", "Golden Scales":            "🐉", "Night Cloak":              "🌌",
  "Spirit-Ward":              "👻", "Paladin's Mantle":         "🔱", "Draconic Robe":            "🔴",
  "Titanic Hide":             "🪨", "Golden Warplate":          "🏆", "Mythic Cuirass":           "💫",
  "Quintessence Mantle":      "🌀",

  // ── ARMOR (A-GRADE) ───────────────────────────────────────
  "Heart Hide":               "❤️", "Destroyer Mantle":         "💥", "Chaos-garb":               "🌪️",
  "Devastator Armor":         "⚔️", "Tectonic-Mail":            "🌋", "Elemental Shroud":         "🌊",
  "Colossal Veil":            "🌫️", "Realm-Bound Tunic":        "🌐", "Serpentine-Robe":          "🐍",
  "Vasto-Shell":              "🐚",

  // ── ARMOR (S-GRADE) ───────────────────────────────────────
  "Saturn":                   "🪐", "Unshadowed":               "☀️", "Null":                     "⬛",
  "Dominion":                 "👑", "Godshroud":                "✨", "Oblivion":                 "🕳️",
  "Gungnir":                  "⚡", "Imperium":                 "🔱", "Worldshell":               "🌍",
  "Eternity":                 "∞",
};

const ITEM_TYPES = {
  consumable: ["Potion","Elixir","Food","Soup","Skewer","Herb Fish","Grilled","Roasted","Fried"],
  equipment:  ["Sword","Dagger","Bow","Vest","Plate","Armor","Shield","Staff","Robe","Axe","Spear","Blade","Wand","Mace","Knife","Rod","Bow","Cloak","Cuirass","Chainmail","Fortress","Mantle","Shroud","Tunic","Greatsword","Cleaver","Warplate","Warbreaker","Longbow","Spellknife","Spellhammer"],
  material:   ["Ore","Crystal","Rune","Wood","Herb","Bone","Thread","Essence","Dust","Shard","Leaf","Bark","Sprigs","Root","Bloom","Petal","Scale","Fang","Hide","Meat","Pelt","Claw","Horn","Fat","Feather","Stone","Fragment","Moss","Seed"],
  quest:      [
    // Generic catch patterns
    "Heart of","Gem of","Void-Eye","Orb of","Crown of","Tears of","Core of","Fruit of","Forgotten",
    "Scales of","Eye of","Divine Heart","Adonai","Ink of","Branch of","Ancient Scroll",
    // Exact deity ingredient names
    "Scales of Equilibrium","The Void-Eye","Gem of Luminance",
    "Crimson Toad Moss","Branch of Soul Tree","Bloom Petals","Moon Petals",
    "Ancient Scroll Fragments","White Mystic Woods","Truths","Crystallized Night Dews",
    "Oil-stained Feathers","Ephemeral Footprints","Devil-Spring Water",
    "Iron Oaths","Broken Shackles","Verdict Quill","Volcanic Roots","Ash of Elder Trees",
    "Ephemeral Footprints","Whispering Purple Sands",
    // Ascension ingredients
    "Ink of Time","Forgotten Desire Seed","Divine Bull Essence","Heart of the Red Phoenix",
    "Leviathan Scale","Sea Dragon Fin","Abyssal Pearl",
    "Orb of Silence","Eye of All-knowing","Tears of The Endless Goldfish",
    "Void Crystal","Ancient Rune","Ancient Root","Spirit Root","Blood Crystal","Beast Core",
  ],
};

function getItemType(name) {
  // Equipment: check exact name lists first (strips enchant suffix like "+2")
  // This prevents S/A-grade items with unique names (Abjuration, Null, Saturn etc.)
  // from falling through to "material" via keyword mismatch.
  const baseName = (name || '').replace(/\s*\+\d+$/, '').trim();
  if (ALL_WEAPON_NAMES.includes(baseName) || ALL_ARMOR_NAMES.includes(baseName)) return 'equipment';
  // Everything else: keyword scan (consumables, quest items, materials)
  for (const [type, keywords] of Object.entries(ITEM_TYPES)) {
    if (type === 'equipment') continue; // already handled above
    if (keywords.some(k => name.includes(k))) return type;
  }
  return "material"; // default
}

function getItemIcon(name) {
  if (ITEM_ICONS[name]) return ITEM_ICONS[name];
  const n = name.toLowerCase();
  // Potions & consumables
  if (n.includes('hp potion') || n.includes('health potion')) return '🫧';
  if (n.includes('mana potion'))  return '💠';
  if (n.includes('potion'))       return '⚗️';
  if (n.includes('elixir'))       return '🔮';
  // Food
  if (n.includes('steak') || n.includes('roast') || n.includes('meat')) return '🥩';
  if (n.includes('soup') || n.includes('stew') || n.includes('broth')) return '🍲';
  if (n.includes('fish') || n.includes('carp') || n.includes('sardine') || n.includes('tuna')) return '🐟';
  if (n.includes('feast') || n.includes('banquet') || n.includes('platter')) return '🍽️';
  // Runestones
  if (n.includes('runestone')) return '🔷';
  // Resources by keyword
  if (n.includes('ore') || n.includes('iron') || n.includes('copper') || n.includes('stone')) return '🪨';
  if (n.includes('wood') || n.includes('bark') || n.includes('root')) return '🪵';
  if (n.includes('herb') || n.includes('leaf') || n.includes('leaves') || n.includes('moss') || n.includes('fern')) return '🌿';
  if (n.includes('crystal') || n.includes('gem') || n.includes('quartz')) return '💎';
  if (n.includes('rune') || n.includes('shard') || n.includes('fragment')) return '🔷';
  if (n.includes('essence') || n.includes('dust') || n.includes('bloom') || n.includes('petal')) return '✨';
  if (n.includes('scale') || n.includes('hide') || n.includes('pelt') || n.includes('leather')) return '🟤';
  if (n.includes('bone') || n.includes('fang') || n.includes('claw')) return '🦴';
  if (n.includes('feather')) return '🪶';
  if (n.includes('seed') || n.includes('fruit') || n.includes('berry') || n.includes('flower')) return '🌱';
  if (n.includes('pearl') || n.includes('fin') || n.includes('eel')) return '🌊';
  if (n.includes('core') || n.includes('heart') || n.includes('eye') || n.includes('orb')) return '🔮';
  if (n.includes('scroll') || n.includes('relic') || n.includes('quill')) return '📜';
  if (n.includes('gold') || n.includes('silver') || n.includes('titanium') || n.includes('adamantium')) return '🟡';
  // Equipment
  if (n.includes('sword') || n.includes('blade') || n.includes('cleaver') || n.includes('jian')) return '⚔️';
  if (n.includes('dagger') || n.includes('knife') || n.includes('strike')) return '🗡️';
  if (n.includes('bow') || n.includes('longbow')) return '🏹';
  if (n.includes('wand') || n.includes('staff') || n.includes('rod') || n.includes('scepter')) return '🪄';
  if (n.includes('hammer') || n.includes('mace')) return '🔨';
  if (n.includes('armor') || n.includes('plate') || n.includes('mail') || n.includes('cuirass')) return '🧥';
  if (n.includes('robe') || n.includes('cloak') || n.includes('mantle') || n.includes('tunic') || n.includes('vest')) return '🧥';
  // Type-based fallback
  const type = getItemType(name);
  if (type === 'equipment')  return '⚔️';
  if (type === 'consumable') return '🧪';
  if (type === 'quest')      return '📜';
  return '📦';
}

window.renderInventory = function(items) {
  const grid = document.getElementById("inventory-grid");
  if (!grid) return;

  if (!items || items.length === 0) {
    const activeTab = window._activeInvTab || "all";
    if (activeTab === "ingredient") {
      // Deity Ingredients tab — no items means none granted yet; the tracker below handles display
      grid.innerHTML = '';
      return;
    }
    const emptyMessages = {
      consumable: "No consumables yet. Craft or buy potions and food from the market.",
      material:   "No materials yet. Gather resources or defeat monsters to collect them.",
      equipment:  "No equipment yet. Craft weapons and armor or buy from a vendor.",
      all:        "Your inventory is empty. Defeat monsters, gather resources, or buy from the market.",
    };
    const msg = emptyMessages[activeTab] || emptyMessages.all;
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-dim);font-style:italic;font-size:0.88rem">${msg}</div>`;
    return;
  }

  // Expand equipment items into individual cards (one per unit so each can be enchanted separately)
  const expandedItems = [];
  items.forEach(item => {
    const type = getItemType(item.name);
    if (type === 'equipment') {
      const qty = item.qty ?? 1;
      for (let i = 0; i < qty; i++) expandedItems.push({...item, qty: 1});
    } else {
      expandedItems.push(item);
    }
  });

  grid.innerHTML = expandedItems.map((item, idx) => {
    const type = getItemType(item.name);
    const isConsumable = type === "consumable";
    const isFood = ["Soup","Skewer","Carp","Sardine","Meat","Food","Herb Fish","Grilled","Roasted","Fried"].some(k => item.name.includes(k));
    const isEquipment = type === 'equipment';
    // Strip any +N suffix baked into the name by the Cloud Function, then show a single enchant badge
    const baseName = item.name.replace(/\s*\+\d+$/, '');
    const enchantMatch = (item.name || '').match(/\+(\d+)$/);
    const enchantLevel = item.enchantLevel || (enchantMatch ? parseInt(enchantMatch[1]) : 0);
    const enchantSuffix = (isEquipment && enchantLevel) ? ` <span style="color:var(--gold);font-size:0.7rem">+${enchantLevel}</span>` : '';
    const safeBase = baseName.replace(/'/g, "\\'");
    return `
    <div class="inv-item" data-type="${type}">
      <div class="inv-item-icon">${getItemIcon(baseName)}</div>
      <div class="inv-item-name">${baseName}${enchantSuffix}</div>
      ${!isEquipment ? `<div class="inv-item-qty">x${item.qty ?? 1}</div>` : ''}
      ${isConsumable ? `<button class="vendor-buy-btn" style="margin-top:6px;font-size:0.6rem;padding:3px 8px" onclick="useItem('${safeBase}','${isFood?'food':'potion'}')">USE</button>` : ''}
      ${isEquipment ? `<button class="vendor-buy-btn" style="margin-top:6px;font-size:0.6rem;padding:3px 8px;background:rgba(91,159,224,0.12);color:#5b9fe0;border-color:#5b9fe044" onclick="window.openItemStatModal('${safeBase}',${enchantLevel})">VIEW</button>` : ''}
      ${type === 'material' ? `<button class="vendor-buy-btn" style="margin-top:6px;font-size:0.6rem;padding:3px 8px;background:rgba(201,168,76,0.1)" onclick="previewSellMaterial('${safeBase}')">SELL</button>` : ''}
    </div>`;
  }).join('');
};


// Show gold preview before selling
window.previewSellMaterial = function(itemName) {
  const SELL_RATES = { mythic:10000, legendary:500, rare:150, uncommon:40, common:10 };
  const MYTHIC    = ["Aetherium","Eden’s Tear","Cosmic Leviathan","Void Orchid","Titan Heart"];
  const LEGENDARY = ["Titanium","Adamantium","Celestial Fig","Dragonfruit","Celestial Whale","Black Unagi","Phoenix Bloom","Middlemist","Cyclops Eye","Dragon Scales"];
  const RARE      = ["Gold","Mythril","Palladium","Spirit Plum","Frost Apples","Ember Fruit","Shadowfish","Flamefish","Ying Koi","Spirit Herb","Jade Vine","Ghost Root","Spirit Venison","Shadow Hide","Drake Meat"];
  const UNCOMMON  = ["Silver","Bronze","Marble","Obsidian","Quartz","Golden Pears","Moon Grapes","Sunfruit","Crystal Berries","Bitter Root","Silverfin","Glowfish","Spotted Eel","Coral Snapper","Red Minnow","Silverleaf","Goldroot","Nightshade","Glowleaf","Lotus","Leather","Fangs","Fur","Horns","Claws"];
  const tier = MYTHIC.includes(itemName) ? "mythic"
             : LEGENDARY.includes(itemName) ? "legendary"
             : RARE.includes(itemName) ? "rare"
             : UNCOMMON.includes(itemName) ? "uncommon" : "common";
  const goldVal = SELL_RATES[tier];
  const tierColour = { mythic:"#d070e0", legendary:"#c9a84c", rare:"#5b9fe0", uncommon:"#70c090", common:"#aaa" }[tier];
  inkConfirm(
    `Sell <strong style="color:var(--gold)">${itemName}</strong> for <strong style="color:${tierColour}">${goldVal} 🪙</strong>?`
  ).then(confirmed => { if (confirmed) window.convertMaterialToGold(itemName); });
};


// Convert one material to gold (base rate: rarity-based)
window.convertMaterialToGold = async function(itemName) {
  // Quick pre-check against local state so we can bail early
  const localItem = (_charData?.inventory || []).find(i => i.name === itemName);
  if (!localItem || localItem.qty < 1) return;
  // Gold value by rough rarity tier
  const SELL_RATES = {
    mythic:10000, legendary:500, rare:150, uncommon:40, common:10
  };
  const MYTHIC    = ['Aetherium','‘Eden’s Tear','Cosmic Leviathan','Void Orchid','Titan Heart'];
  const LEGENDARY = ['Titanium','Adamantium','Celestial Fig','Dragonfruit','Celestial Whale','Black Unagi','Phoenix Bloom','Middlemist','Cyclops Eye','Dragon Scales'];
  const RARE      = ['Gold','Mythril','Palladium','Spirit Plum','Frost Apples','Ember Fruit','Shadowfish','Flamefish','Ying Koi','Spirit Herb','Jade Vine','Ghost Root','Spirit Venison','Shadow Hide','Drake Meat'];
  const UNCOMMON  = ['Silver','Bronze','Marble','Obsidian','Quartz','Golden Pears','Moon Grapes','Sunfruit','Crystal Berries','Bitter Root','Silverfin','Glowfish','Spotted Eel','Coral Snapper','Red Minnow','Silverleaf','Goldroot','Nightshade','Glowleaf','Lotus','Leather','Fangs','Fur','Horns','Claws'];
  const tier = MYTHIC.includes(itemName) ? 'mythic'
             : LEGENDARY.includes(itemName) ? 'legendary'
             : RARE.includes(itemName) ? 'rare'
             : UNCOMMON.includes(itemName) ? 'uncommon' : 'common';
  const goldVal = SELL_RATES[tier];
  // Mutator removes from live server inventory; increment() adds gold atomically
  await _invWrite(_uid, inv => {
    const item = inv.find(i => i.name === itemName);
    if (!item || item.qty < 1) throw new Error('[sell] ' + itemName + ' not in server inventory');
    if (item.qty > 1) item.qty--; else inv.splice(inv.indexOf(item), 1);
  }, { gold: increment(goldVal) });
  window._allInvItems = _charData.inventory;
  _syncAllDisplays(_charData);
  window._refreshInvDisplay();
  window.showToast('Sold ' + itemName + ' for ' + goldVal + ' gold!', 'success');
  logActivity('💱', '<b>Converted</b> ' + itemName + ' → <b>' + goldVal + '🪙</b>.', '#c9a84c');
};

window._activeInvTab = "all"; // track active tab globally

window.filterInv = function(btn, type) {
  document.querySelectorAll(".inv-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  window._activeInvTab = type;
  const all = window._allInvItems || [];
  const filtered = type === "all" ? all : all.filter(item => getItemType(item.name) === type);
  window.renderInventory(filtered);
};

// Re-render inventory respecting whatever tab is currently active
window._refreshInvDisplay = function() {
  const all = window._allInvItems || [];
  const type = window._activeInvTab || "all";
  // Exclude currently-equipped items from inventory display (they show in the equip panel)
  const equippedWeapon = (window._charData?.equipment?.weapon || '').replace(/\s*\+\d+$/, '').trim().toLowerCase();
  const equippedArmor  = (window._charData?.equipment?.armor  || '').replace(/\s*\+\d+$/, '').trim().toLowerCase();
  // Only hide ONE instance of each equipped item — if a player owns 2x Abjuration but
  // has one equipped, the second should still appear in inventory.
  let _weaponHidden = false;
  let _armorHidden  = false;
  const withoutEquipped = all.filter(item => {
    const base = (item.name || '').replace(/\s*\+\d+$/, '').trim().toLowerCase();
    if (!_weaponHidden && equippedWeapon && base === equippedWeapon && getItemType(item.name) === 'equipment') {
      _weaponHidden = true;
      return false;
    }
    if (!_armorHidden && equippedArmor && base === equippedArmor && getItemType(item.name) === 'equipment') {
      _armorHidden = true;
      return false;
    }
    return true;
  });
  const filtered = type === "all" ? withoutEquipped : withoutEquipped.filter(item => getItemType(item.name) === type);
  window.renderInventory(filtered);
  // Keep trade.js in sync — it holds its own charData reference which goes stale after
  // any inventory/equip/craft/market change. Push the current snapshot every time the
  // display refreshes so the item picker always shows the live inventory.
  if (window._charData && window.updateTradeCharData) {
    // Pass a charData snapshot with the FILTERED inventory (equipped items excluded)
    // so trade shows the same items as inventory — not the raw Firestore array.
    window.updateTradeCharData({ ...window._charData, inventory: withoutEquipped });
  }
};

window.useItem = async function(itemName, kind) {
  const inv = [...(_charData?.inventory||[])];
  const idx = inv.findIndex(i => i.name === itemName);
  if (idx === -1) return;

  const updates = {};
  let toastMsg = '';

  if (itemName.includes('HP Potion') || itemName.includes('Health Potion')) {
    // Spec: Minor=+20% HP, Standard=+40% HP, Greater=+70% HP
    const pct     = itemName.includes('Minor') ? 0.20 : itemName.includes('Greater') ? 0.70 : 0.40;
    // Use effective max HP (base + armor equipment bonus) so potions heal to the correct cap
    const equipHpBonus = (() => {
      let hp = 0;
      if (_charData.equipment?.armor) {
        const aBase = (_charData.equipment.armor || '').replace(/\s*\+\d+$/, '').trim();
        hp = (typeof EQUIP_ARMOR_STATS !== 'undefined' && EQUIP_ARMOR_STATS[aBase]?.hp) || 0;
      }
      return Math.round(hp * (1 + (typeof getRaceEquipBonus === 'function' ? getRaceEquipBonus(_charData.race) : 0)));
    })();
    const maxHp   = (_charData.hpMax || 100) + equipHpBonus;
    const curHp   = _charData.hp    || 0;
    const heal    = Math.round(maxHp * pct);
    const applied = Math.min(heal, maxHp - curHp);
    updates.hp = Math.min(maxHp, curHp + applied);
    toastMsg = `Used ${itemName} — restored ${applied} HP (+${Math.round(pct*100)}% of max)`;
  } else if (itemName.includes('Mana Potion')) {
    // Spec: Minor=+20% Mana, Standard=+40% Mana, Greater=+70% Mana
    const pct      = itemName.includes('Minor') ? 0.20 : itemName.includes('Greater') ? 0.70 : 0.40;
    const maxMana  = _charData.manaMax || 50;
    const curMana  = _charData.mana    || 0;
    const restore  = Math.round(maxMana * pct);
    const applied  = Math.min(restore, maxMana - curMana);
    updates.mana = Math.min(maxMana, curMana + applied);
    toastMsg = `Used ${itemName} — restored ${applied} Mana (+${Math.round(pct*100)}% of max)`;
  } else if (itemName.includes('EXP Potion') || itemName.includes('Insight')) {
    // Docs: +5/15/20% EXP gain buff, lasts 3 hours, once per day, cannot stack
    const pct = itemName.includes('Minor') ? 5 : itemName.includes('Greater') ? 20 : 15;
    const now = Date.now();
    const existing = _charData.expBuff;
    // Block if already active
    if (existing?.expiry > now) {
      const minsLeft = Math.ceil((existing.expiry - now) / 60000);
      window.showToast(`EXP buff already active — ${minsLeft}m remaining.`, 'info');
      return;
    }
    // Block if already used today
    const todayStr = new Date().toDateString();
    if (existing?.usedDate === todayStr) {
      window.showToast('EXP Potion already used today. Resets at midnight.', 'info');
      return;
    }
    const expiry = now + 3 * 60 * 60 * 1000;
    updates.expBuff = { pct, expiry, usedDate: todayStr };
    toastMsg = `Used ${itemName} — +${pct}% EXP gain active for 3 hours!`;
  } else if (itemName.includes('Luck Potion')) {
    // Docs: +5/15/30% Luck buff, lasts 3 hours, once per day, cannot stack
    const pct = itemName.includes('Minor') ? 5 : itemName.includes('Greater') ? 30 : 15;
    const now = Date.now();
    const existing = _charData.luckBuff;
    // Block if already active
    if (existing?.expiry > now) {
      const minsLeft = Math.ceil((existing.expiry - now) / 60000);
      window.showToast(`Luck buff already active — ${minsLeft}m remaining.`, 'info');
      return;
    }
    // Block if already used today
    const todayStr = new Date().toDateString();
    if (existing?.usedDate === todayStr) {
      window.showToast('Luck Potion already used today. Resets at midnight.', 'info');
      return;
    }
    const expiry = now + 3 * 60 * 60 * 1000;
    updates.luckBuff = { pct, expiry, usedDate: todayStr };
    toastMsg = `Used ${itemName} — +${pct}% Luck active for 3 hours!`;
  } else if (kind === 'food') {
    // Food buffs per spec: stat% for timed duration, 1 active per stat at a time
    // Derive stat and % from item name patterns
    const FOOD_STATS = {
      // STR foods
      'Grilled Meat Skewer':    { stat:'str', pct:0.05, dur:10 },
      'Spiced Steak':           { stat:'str', pct:0.10, dur:15 },
      "Hunter's Feast":         { stat:'str', pct:0.15, dur:20 },
      'Dragonfire Roast':       { stat:'str', pct:0.20, dur:30 },
      'Eden Banquet':           { stat:'str', pct:0.25, dur:40 },
      // INT foods
      'Herb Fish Soup':         { stat:'int', pct:0.05, dur:10 },
      'Glow Stew':              { stat:'int', pct:0.10, dur:15 },
      'Mystic Broth':           { stat:'int', pct:0.15, dur:20 },
      'Celestial Sashimi':      { stat:'int', pct:0.20, dur:30 },
      'Cosmic Infusion':        { stat:'int', pct:0.25, dur:40 },
      // DEF foods
      'Roasted Carp':           { stat:'def', pct:0.05, dur:10 },
      'Ironbody Stew':          { stat:'def', pct:0.10, dur:15 },
      'Frosthide Meal':         { stat:'def', pct:0.15, dur:20 },
      'Titan Shell Dish':       { stat:'def', pct:0.20, dur:30 },
      'Eternal Fortress Feast': { stat:'def', pct:0.25, dur:40 },
      // DEX foods
      'Fried Sardine':          { stat:'dex', pct:0.05, dur:10 },
      'Crystal Splash Meal':    { stat:'dex', pct:0.10, dur:15 },
      "Assassin's Dish":        { stat:'dex', pct:0.15, dur:20 },
      'Phantom Platter':        { stat:'dex', pct:0.20, dur:30 },
      'Divine Speed Feast':     { stat:'dex', pct:0.25, dur:40 },
    };
    const foodDef = FOOD_STATS[itemName];
    if (foodDef) {
      const { stat, pct, dur } = foodDef;
      const expiry = Date.now() + dur * 60 * 1000;
      const activeFoods = { ...(_charData.activeFoods || {}) };
      activeFoods[stat] = { itemName, pct, expiry }; // overwrites same-stat buff
      updates.activeFoods = activeFoods;
      toastMsg = `Consumed ${itemName} — +${Math.round(pct*100)}% ${stat.toUpperCase()} for ${dur} mins!`;
    } else {
      toastMsg = `Consumed ${itemName}`;
    }
  } else if (itemName === 'Resurrection Potion') {
    // Can only use while dead
    if (!_charData?.isDead) {
      window.showToast('You are not dead. Save this for when you need it.', 'info');
      return;
    }
    const confirmed = await inkConfirm('Use your <b>Resurrection Potion</b>?<br><span style="font-size:0.85rem;color:var(--ash)">You will be instantly revived at full HP and Mana.</span>');
    if (!confirmed) return;
    // Consume the item first
    if (inv[idx].qty > 1) inv[idx].qty--; else inv.splice(idx, 1);
    await updateDoc(doc(db, 'characters', _uid), {
      isDead: false,
      hp: _charData.hpMax || 100,
      mana: _charData.manaMax || 50,
      resurrectAt: null,
      inventory: inv
    });
    Object.assign(_charData, { isDead: false, hp: _charData.hpMax || 100, mana: _charData.manaMax || 50, resurrectAt: null, inventory: inv });
    window._allInvItems = inv;
    await refreshCharData();
    const banner   = document.getElementById('battle-dead-banner');
    const zoneArea = document.getElementById('battle-zone-select');
    if (banner)   banner.style.display   = 'none';
    if (zoneArea) zoneArea.style.display = 'block';
    updateZoneLocks();
    _syncAllDisplays(_charData);
    window._refreshInvDisplay();
    window.showToast('💀➡️✨ Resurrection Potion used — you have returned!', 'success');
    logActivity('💀', `Used a <b>Resurrection Potion</b> and returned from death.`, '#c9a84c');
    return;

  } else if (itemName === 'Class Reset Potion') {
    const confirmed = await inkConfirm('Use <b>Class Reset Potion</b>?<br><span style="font-size:0.85rem;color:var(--ash)">Your class, skills, and stances will be cleared. Stat points earned are kept.</span>');
    if (!confirmed) return;
    if (inv[idx].qty > 1) inv[idx].qty--; else inv.splice(idx, 1);
    await updateDoc(doc(db, 'characters', _uid), { charClass: null, classRole: null, skills: [], stances: [], inventory: inv });
    Object.assign(_charData, { charClass: null, classRole: null, skills: [], stances: [], inventory: inv });
    window._allInvItems = inv;
    await refreshCharData(); _syncAllDisplays(_charData); window._refreshInvDisplay();
    logActivity('⚗️', 'Used a <b>Class Reset Potion</b>. Class cleared — choosing again.', '#c9a84c');
    openClassPickerModal();
    return;

  } else if (itemName === 'Stat Reset Potion') {
    const confirmed = await inkConfirm('Use <b>Stat Reset Potion</b>?<br><span style="font-size:0.85rem;color:var(--ash)">All stats reset to 10. Your earned stat points are refunded for redistribution.</span>');
    if (!confirmed) return;
    if (inv[idx].qty > 1) inv[idx].qty--; else inv.splice(idx, 1);
    const baseStats = { str:10, int:10, def:10, dex:10 };
    // Stat points formula: 20 (welcome bonus) + 3 per level-up + 25 per rank ascension
    const WELCOME_BONUS = 20;
    const RANK_ORDER = ['Wanderer','Follower','Disciple','Master','Exalted','Crown','Supreme','Legend','Myth','Eternal'];
    const rankIdx      = Math.max(0, RANK_ORDER.indexOf(_charData.rank || 'Wanderer'));
    const earnedPoints = WELCOME_BONUS
      + Math.max(0, ((_charData.level || 1) - 1) * 3)
      + rankIdx * 25;
    await updateDoc(doc(db, 'characters', _uid), { stats: baseStats, statPoints: earnedPoints, inventory: inv });
    Object.assign(_charData, { stats: baseStats, statPoints: earnedPoints, inventory: inv });
    window._allInvItems = inv;
    await refreshCharData(); _syncAllDisplays(_charData); window._refreshInvDisplay();
    window.showToast(`🔄 Stat Reset! ${earnedPoints} stat points refunded.`, 'success');
    logActivity('🔄', `Used a <b>Stat Reset Potion</b>. Stats reset to base, ${earnedPoints} points refunded.`, '#c9a84c');
    if (typeof switchPanel === 'function') switchPanel('character');
    return;


  } else if (itemName === 'Race Rebirth Potion') {
    const confirmed = await inkConfirm('Use <b>Race Rebirth Potion</b>?<br><span style="font-size:0.85rem;color:var(--ash)">Your race and racial attribute will be cleared. Choose a new race.</span>');
    if (!confirmed) return;
    if (inv[idx].qty > 1) inv[idx].qty--; else inv.splice(idx, 1);
    await updateDoc(doc(db, 'characters', _uid), { race: null, raceAttr: null, inventory: inv });
    Object.assign(_charData, { race: null, raceAttr: null, inventory: inv });
    window._allInvItems = inv;
    await refreshCharData(); _syncAllDisplays(_charData); window._refreshInvDisplay();
    logActivity('🌀', 'Used a <b>Race Rebirth Potion</b>. Race cleared — choosing again.', '#c9a84c');
    openRacePickerModal();
    return;

  } else if (itemName === 'Divine Shift Potion') {
    const confirmed = await inkConfirm('Use <b>Divine Shift Potion</b>?<br><span style="font-size:0.85rem;color:var(--ash)">Your deity will be cleared and Faith Level reset to 0. Choose a new deity.</span>');
    if (!confirmed) return;
    if (inv[idx].qty > 1) inv[idx].qty--; else inv.splice(idx, 1);
    await updateDoc(doc(db, 'characters', _uid), { deity: null, deityTitle: null, faithLevel: 0, blessing: null, blessingDesc: null, inventory: inv });
    Object.assign(_charData, { deity: null, deityTitle: null, faithLevel: 0, blessing: null, blessingDesc: null, inventory: inv });
    window._allInvItems = inv;
    await refreshCharData(); _syncAllDisplays(_charData); window._refreshInvDisplay();
    logActivity('🔮', 'Used a <b>Divine Shift Potion</b>. Deity cleared, Faith reset to 0.', '#c9a84c');
    openDeityPickerModal();
    return;

  } else {
    // Unknown item type — just consume with no extra effect
  }

  // Consume 1 of the item and save for all branches that set updates/toastMsg
  if (toastMsg) {
    if (inv[idx].qty > 1) inv[idx].qty--;
    else inv.splice(idx, 1);
    updates.inventory = inv;

    await updateDoc(doc(db, 'characters', _uid), updates);
    Object.assign(_charData, updates);
    window._allInvItems = inv;

    // Sync every display immediately
    _syncAllDisplays(_charData);
    window._refreshInvDisplay(); // re-render keeping the active tab filter

    window.showToast(toastMsg, 'success');
    await _incrementQuest(kind, 1);
    logActivity('🧪', `Used <b>${itemName}</b>.`, '#888');
    // Re-render potion strip if battle is active
    if (document.getElementById('battle-arena')?.style.display !== 'none') _renderBattlePotionStrip();
  }
};

// ═══════════════════════════════════════════════════
//  DEITY INGREDIENTS
// ═══════════════════════════════════════════════════
function buildDeityIngredients(deity) {
  const container = document.getElementById("deity-ingredients");
  if (!container) return;
  const ings = DEITY_INGREDIENTS[deity];
  if (!ings) { container.innerHTML = `<p style="font-size:0.85rem;color:var(--text-dim);font-style:italic">No deity selected.</p>`; return; }

  // Qty required = 2^rankIndex (Wanderer=1x, Follower=2x, Disciple=4x, Master=8x, ...)
  const rankIdx  = RANK_ORDER.indexOf(_charData?.rank || 'Wanderer');
  const required = Math.pow(2, rankIdx);
  const level    = _charData?.level || 1;
  const rank     = _charData?.rank  || 'Wanderer';

  // Ascension is available when at the last level of current rank AND xp bar is full (xp >= xpMax)
  const levelWithinRank = ((level - 1) % 100) + 1;
  const atMaxLevel      = levelWithinRank === 100 && (_charData?.xp ?? 0) >= (_charData?.xpMax ?? 1);
  const allIngsMet      = ings.every(ing => ((_charData?.inventory||[]).find(i => i.name === ing)?.qty ?? 0) >= required);
  const canAscend       = atMaxLevel && allIngsMet && RANK_ORDER.indexOf(rank) < RANK_ORDER.length - 1;
  const isMaxRank       = RANK_ORDER.indexOf(rank) >= RANK_ORDER.length - 1;
  const nextRank        = isMaxRank ? null : RANK_ORDER[RANK_ORDER.indexOf(rank) + 1];

  const ascendBtnHtml = isMaxRank
    ? `<p style="font-size:0.8rem;color:var(--gold);font-style:italic;margin-top:14px;text-align:center">✦ You have reached the pinnacle — Eternal rank.</p>`
    : canAscend
      ? `<button id="ascend-btn" class="btn-primary" style="margin-top:16px" onclick="window.doRankAscension()">⬆ ASCEND TO ${nextRank.toUpperCase()}</button>`
      : `<div style="margin-top:14px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius);font-size:0.78rem;color:var(--text-dim);font-style:italic">
          ${!atMaxLevel
            ? `Reach Level 100 and fill the EXP bar to unlock ascension. (Currently Level ${levelWithinRank}${levelWithinRank === 100 ? ' — EXP bar not yet full' : ' — ' + (100 - levelWithinRank) + ' level' + (100 - levelWithinRank === 1 ? '' : 's') + ' away'})`
            : `Collect all required ingredients to ascend.`
          }
        </div>`;

  container.innerHTML = `
    <p style="font-size:0.82rem;color:var(--text-dim);font-style:italic;margin-bottom:8px">
      Required to ascend under <strong style="color:var(--gold)">${deity}</strong>.
      Cannot be farmed — granted by your Deity upon story quest completion.
    </p>
    <p style="font-family:var(--font-mono);font-size:0.65rem;color:var(--ash);margin-bottom:12px;letter-spacing:0.04em">
      NEXT ASCENSION REQUIRES: <strong style="color:var(--gold-dim)">${required}×</strong> of each ingredient
      <span style="color:var(--ash);font-size:0.6rem">(doubles each rank)</span>
    </p>
    <div class="ingredient-list">${ings.map(ing => {
      const owned = (_charData?.inventory||[]).find(i => i.name === ing)?.qty ?? 0;
      const met   = owned >= required;
      const color = met ? '#7ec87e' : owned > 0 ? 'var(--gold)' : 'var(--text-dim)';
      const icon  = met ? '✅' : '✦';
      return `
      <div class="ingredient-item">
        <span class="ingredient-icon">${icon}</span>
        <span class="ingredient-name">${ing}</span>
        <span class="ingredient-qty" style="color:${color}">${owned} / ${required}</span>
      </div>`;
    }).join('')}
    </div>
    ${ascendBtnHtml}`;
}

// ═══════════════════════════════════════════════════
//  RANK ASCENSION
// ═══════════════════════════════════════════════════
window.doRankAscension = async function() {
  const deity    = _charData?.deity;
  const ings     = DEITY_INGREDIENTS[deity];
  const rank     = _charData?.rank  || 'Wanderer';
  const level    = _charData?.level || 1;
  const rankIdx  = RANK_ORDER.indexOf(rank);
  const required = Math.pow(2, rankIdx);

  if (!ings) { window.showToast('No deity assigned.', 'error'); return; }
  if (RANK_ORDER.indexOf(rank) >= RANK_ORDER.length - 1) { window.showToast('Already at maximum rank.', 'error'); return; }

  const levelWithinRank = ((level - 1) % 100) + 1;
  const xp    = _charData?.xp    ?? 0;
  const xpMax = _charData?.xpMax ?? 1;
  if (levelWithinRank !== 100 || xp < xpMax) {
    window.showToast(`Reach Level 100 and fill your EXP bar before ascending.`, 'error'); return;
  }

  const inv = _charData.inventory || [];
  for (const ing of ings) {
    const owned = inv.find(i => i.name === ing)?.qty ?? 0;
    if (owned < required) {
      window.showToast(`Not enough ${ing}. Need ${required}×, have ${owned}×.`, 'error'); return;
    }
  }
  const confirmed = await inkConfirm(
    `Ascend from ${rank} to ${RANK_ORDER[rankIdx + 1]}?

This will consume:
${ings.map(i => `  • ${required}× ${i}`).join("\n")}

You will gain:
  • +150 Max HP
  • +75 Max Mana
  • +25 Stat Points
  • 2 new skills unlocked`
  );
  if (!confirmed) return;

  const btn = document.getElementById('ascend-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Ascending...'; }

  try {
    // Consume ingredients
    for (const ing of ings) {
      const idx = inv.findIndex(i => i.name === ing);
      if (idx !== -1) {
        inv[idx].qty -= required;
        if (inv[idx].qty <= 0) inv.splice(idx, 1);
      }
    }

    const newRank      = RANK_ORDER[rankIdx + 1];
    const newRankIdx   = rankIdx + 1;
    // Level resets to 1 within the new rank (absolute level = newRankIdx * 100 + 1)
    const newAbsLevel  = newRankIdx * 100 + 1;
    const newXpMax     = _calcXpMax(newRankIdx, newAbsLevel);
    const newHpMax     = (_charData.hpMax  || 100) + 150;
    const newManaMax   = (_charData.manaMax || 50) + 75;
    const newStatPts   = (_charData.statPoints || 0) + 25;

    // Carry overflow XP into the new rank (xp was clamped to xpMax at the cap, so
    // anything stored beyond xpMax is the overflow that happens at the moment of ascension)
    const xpCarry = Math.max(0, (_charData.xp || 0) - (_charData.xpMax || 1) + 1);
    // Cap carry so it can't instantly level up in the new rank
    const startXp = Math.min(xpCarry, newXpMax - 1);

    await updateDoc(doc(db, 'characters', _uid), {
      rank:       newRank,
      level:      newAbsLevel,
      xp:         startXp,
      xpMax:      newXpMax,
      hpMax:      newHpMax,
      manaMax:    newManaMax,
      statPoints: newStatPts,
      inventory:  inv,
    });

    // Update local cache
    _charData.rank       = newRank;
    _charData.level      = newAbsLevel;
    _charData.xp         = startXp;
    _charData.xpMax      = newXpMax;
    _charData.hpMax      = newHpMax;
    _charData.manaMax    = newManaMax;
    _charData.statPoints = newStatPts;
    _charData.inventory  = inv;

    // Refresh UI
    buildDeityIngredients(deity);
    if (typeof renderCharacterPanel === 'function') renderCharacterPanel(_charData);
    if (typeof refreshStatDisplay   === 'function') refreshStatDisplay(_charData);
    if (typeof buildSkillTree       === 'function') buildSkillTree(_charData.charClass, _charData);

    logActivity('⬆️', `<b>Rank Ascension:</b> Advanced to <b>${newRank}</b>! Level reset to 1. +150 HP, +75 Mana, +25 Stat Points.`, '#c9a84c');
    window.showToast(`✦ You have ascended to ${newRank}!`, 'success');
  } catch(e) {
    console.error('[doRankAscension]', e);
    window.showToast('Ascension failed. Try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = `⬆ ASCEND TO ${RANK_ORDER[rankIdx + 1].toUpperCase()}`; }
  }
};

// ═══════════════════════════════════════════════════
//  PROFESSION
// ═══════════════════════════════════════════════════
async function confirmProfession(prof) {
  if (!prof) { window.showToast("Select a profession first.", "error"); return; }
  const btn = document.getElementById("btn-choose-profession");
  btn.disabled = true; btn.textContent = "SAVING...";
  try {
    await updateDoc(doc(db, "characters", _uid), {
      profession:   prof,
      professionXp: 0,
      professionLvl:0,
    });
    if (_charData) { _charData.profession = prof; _charData.professionXp = 0; _charData.professionLvl = 0; }
    set("prof-profession", prof);
    showActiveProfession(_charData);
    window.showToast(`${prof} profession chosen!`, "success");
    logActivity('💼', `<b>Profession Chosen:</b> ${prof}.`, '#a09080');
  } catch(err) {
    console.error(err);
    window.showToast("Failed to save. Try again.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "CONFIRM PROFESSION";
  }
}

function showActiveProfession(c) {
  document.getElementById("profession-pick-section").style.display = "none";
  document.getElementById("profession-active-section").style.display = "block";

  const lvl  = c.professionLvl || 0;
  const xp   = c.professionXp  || 0;
  const maxXp = (lvl < 10) ? (PROF_EXP_TABLE[lvl] || 3000) : 0;
  const pct  = Math.min(100, Math.round((xp / maxXp) * 100));
  const rates = FIND_RATES[Math.min(lvl, FIND_RATES.length-1)];

  set("active-prof-name",  `${c.profession}`);
  set("active-prof-desc",  PROFESSION_DESCS[c.profession] || "");
  set("active-prof-level", `Level ${lvl}`);
  set("prof-exp-current",  xp);
  set("prof-exp-max",      `/ ${maxXp} EXP`);
  css("prof-exp-fill","width", pct+"%");
  set("prof-find-count",   FIND_COUNT[Math.min(lvl, FIND_COUNT.length-1)]);

  ["common","uncommon","rare","legendary","mythic"].forEach(r => {
    const val = rates[r] || 0;
    css("rate-"+r, "width", val+"%");
    set("pct-"+r, val+"%");
  });
}

// ═══════════════════════════════════════════════════
//  TRAVEL SYSTEM
// ═══════════════════════════════════════════════════
async function startTravel({ dest, continent, cost, seconds }) {
  const errEl = document.getElementById("travel-error");
  errEl.textContent = "";
  const travelCost = Number(cost) || 0;
  const travelSeconds = Number(seconds) || 0;

  // Check gold
  const gold = _charData?.gold ?? 0;
  if (gold < travelCost) { errEl.textContent = `Not enough gold. You have ${gold} coins.`; return; }

  // Check not already traveling
  if (_charData?.travelingUntil?.toDate && _charData.travelingUntil.toDate() > new Date()) {
    errEl.textContent = "You're already traveling."; return;
  }

  // Same location check
  if ((_charData?.kingdom || _charData?.location) === dest) {
    errEl.textContent = "You're already there."; return;
  }

  const btn = document.getElementById("btn-confirm-travel");
  if (btn) { btn.disabled = true; btn.textContent = "DEPARTING..."; }

  try {
    const arrivalTime = new Date(Date.now() + travelSeconds * 1000);
    const travelUpdate = { travelingUntil: arrivalTime, travelDest: dest, travelContinent: continent };
    if (travelCost > 0) travelUpdate.gold = gold - travelCost;
    await updateDoc(doc(db, "characters", _uid), travelUpdate);
    if (_charData) {
      if (travelCost > 0) _charData.gold = gold - travelCost;
      _charData.travelingUntil = { toDate: () => arrivalTime };
      _charData.travelDest = dest;
      _charData.travelContinent = continent;
    }
    const newGold = travelCost > 0 ? gold - travelCost : gold;
    set("stat-gold", newGold);
    set("s-gold",    newGold);
    document.getElementById("travel-modal").style.display = "none";
    startTravelCountdown(arrivalTime, dest);
    window.showToast(`Traveling to ${dest}...`, "");
    logActivity('🚶', `<b>Departed</b> for <b>${dest}</b>${travelCost > 0 ? ` · -${travelCost}💰` : ''}.`, '#5b9fe0');
  } catch(err) {
    console.error(err);
    errEl.textContent = "Failed to travel. Try again.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "DEPART"; }
  }
}

function startTravelCountdown(arrivalDate, dest) {
  const statusEl = document.getElementById("travel-status");
  const timerEl  = document.getElementById("travel-timer-display");
  const progEl   = document.getElementById("travel-progress-fill");
  const destEl   = document.getElementById("travel-dest-name");

  statusEl.classList.add("active");
  if (destEl) destEl.textContent = dest;

  const totalMs = arrivalDate - Date.now();

  clearInterval(_travelInterval);
  _travelInterval = setInterval(async () => {
    const remaining = arrivalDate - Date.now();
    if (remaining <= 0) {
      clearInterval(_travelInterval);
      statusEl.classList.remove("active");
      // Arrival — update location
      try {
        await updateDoc(doc(db, "characters", _uid), {
          location:   _charData.travelDest,
          kingdom:    _charData.travelDest,
          continent:  _charData.travelContinent,
          travelingUntil: null,
          travelDest: null,
        });
        if (_charData) {
          _charData.location  = _charData.travelDest;
          _charData.kingdom   = _charData.travelDest;
          _charData.continent = _charData.travelContinent;
        }
        const shortLoc = _charData.travelDest?.split('—')[0]?.trim() || _charData.travelDest;
        _syncAllDisplays(_charData);
        set("chat-loc-name",  _charData.travelDest);
        window.showToast(`Arrived at ${_charData.travelDest}!`, "success");
        const _tShort = _charData.travelDest?.split('—')[0]?.trim() || _charData.travelDest;
        logActivity('🗺️', `<b>Arrived at ${_tShort}.</b> You completed your journey.`, '#5b9fe0');
        if (Math.random() < 0.30) _rollExploringEvent();
        // Quest tracking
        await _incrementQuest("location", _charData.travelDest);
        // Auto-switch map to new location
        window._onTravelArrival?.(_charData.travelDest);
        // Switch chat to new location
        if (_chatUnsub) { _chatUnsub(); _chatUnsub = null; }
        if (_presenceUnsub) { _presenceUnsub(); _presenceUnsub = null; }
        set("chat-loc-name", _charData.travelDest);
        initChat();
      } catch(e) { console.error(e); }
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    const mins = Math.floor(secs / 60);
    timerEl.textContent = mins > 0 ? `${mins}m ${secs%60}s` : `${secs}s`;
    if (progEl) progEl.style.width = Math.min(100,(1 - remaining/totalMs)*100) + "%";
  }, 1000);
}

function checkTravelStatus() {
  if (!_charData?.travelingUntil) return;
  const arrival = _charData.travelingUntil?.toDate?.() || new Date(_charData.travelingUntil);
  if (arrival > new Date()) {
    startTravelCountdown(arrival, _charData.travelDest || "destination");
  }
}

// ═══════════════════════════════════════════════════
//  RP CHAT
// ═══════════════════════════════════════════════════
let _chatTab      = "rp";    // "rp" | "general"
// Expose current chat tab for external access (e.g. duel initiation in dashboard.html)
window._getActiveChatTab = () => _chatTab;
// Expose sendChat for chat send button/textarea
window._sendChat = sendChat;
let _presenceUnsub = null;

// ── Chat background images keyed by locationId slug ──────────────────────────
const CHAT_LOCATION_BG = {
  // Pub locations — use the capital city map images
  "the-frosty-flagon":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrostpire-capital.jpeg?alt=media&token=ac9bbbac-90b6-4f61-9935-7f50007926dd",
  "the-sunken-cask":     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsolmere-capital.jpeg?alt=media&token=2d5cd553-bb6e-48cb-a8ea-3a584581d049",
  // Northern Continent — safe zones
  "frostspire":          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrostspire.jpeg?alt=media&token=02a9f440-6dc2-4d30-b6dd-3393c156e6ca",
  "whitecrest":          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fwhitecrest_village.jpeg?alt=media&token=8dd42296-a946-481d-b26f-f4cac2b7d66c",
  "whitecrest-village":  "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fwhitecrest_village.jpeg?alt=media&token=8dd42296-a946-481d-b26f-f4cac2b7d66c",
  "icerun":              "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ficerun_hamlet.jpeg?alt=media&token=dfd74d98-9363-4514-a2cf-d4e10d1aaeb7",
  "icerun-hamlet":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ficerun_hamlet.jpeg?alt=media&token=dfd74d98-9363-4514-a2cf-d4e10d1aaeb7",
  "paleglow":            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fpaleglow_town.jpeg?alt=media&token=083ffc0b-2bfa-4708-92f4-ea1cac3f2390",
  "paleglow-town":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fpaleglow_town.jpeg?alt=media&token=083ffc0b-2bfa-4708-92f4-ea1cac3f2390",
  "mistveil":            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fmistveil_town.jpeg?alt=media&token=3fd261ca-b5d2-4096-8b0c-9c0f53e2c228",
  "mistveil-town":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fmistveil_town.jpeg?alt=media&token=3fd261ca-b5d2-4096-8b0c-9c0f53e2c228",
  // Northern Continent — explore zones (monster/resource/deity all use wildlands)
  "frostfang":           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "sheen-lake":          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "misty-hollow":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "dark-cathedral":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "wisteria":            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "silver-lake":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "hobbit-cave":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "arctic-willow":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "dream-river":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "suldan-mine":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "shrine-of-secrets":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "aurora-basin":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "forgotten-estuary":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  "frost-wildlands":     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  // Western Continent — safe zones
  "solmere":             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsolmere.jpeg?alt=media&token=d651b87b-c394-4aa7-8177-c533daa67da2",
  "sunpetal":            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsunpetal_village.jpeg?alt=media&token=da53581d-271c-4879-a40f-460c19a8879e",
  "sunpetal-village":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsunpetal_village.jpeg?alt=media&token=da53581d-271c-4879-a40f-460c19a8879e",
  "basil":               "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fbasil_village.jpeg?alt=media&token=aaa9091c-6f79-4ddf-8136-2300dd7db9e8",
  "basil-village":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fbasil_village.jpeg?alt=media&token=aaa9091c-6f79-4ddf-8136-2300dd7db9e8",
  "riverend":            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Friverend_town.jpeg?alt=media&token=27721626-45d4-4b92-b089-24ae514b57f3",
  "riverend-town":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Friverend_town.jpeg?alt=media&token=27721626-45d4-4b92-b089-24ae514b57f3",
  "verdance":            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdance_town.jpeg?alt=media&token=06f44360-80c6-422f-8877-74aec213608f",
  "verdance-town":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdance_town.jpeg?alt=media&token=06f44360-80c6-422f-8877-74aec213608f",
  // Western Continent — explore zones (all use wildlands)
  "whispering-forest":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "golden-plains":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "element-valley":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "asahi-valley":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "moss-stream":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "argent-grotto":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "golden-river":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "shiny-cavern":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "purgatory-of-light":  "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "temple-of-verdict":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "heart-garden":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "valley-of-overflowing":"https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  "verdantis-wildlands":  "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  // Vorthak — Glass Hell sub-region
  "lake-of-reflections":  "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fglass-hell.jpg?alt=media&token=0e81de0c-af56-49c7-9e2b-dcb9d9c8fa78",
  "crystal-cave":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fglass-hell.jpg?alt=media&token=0e81de0c-af56-49c7-9e2b-dcb9d9c8fa78",
  "rainbow-valley":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fglass-hell.jpg?alt=media&token=0e81de0c-af56-49c7-9e2b-dcb9d9c8fa78",
  "shimmering-peak":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fglass-hell.jpg?alt=media&token=0e81de0c-af56-49c7-9e2b-dcb9d9c8fa78",
  "mirror-sky":           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fglass-hell.jpg?alt=media&token=0e81de0c-af56-49c7-9e2b-dcb9d9c8fa78",
  // Vorthak — Shattered Heavens sub-region
  "tempest-crown":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fshattered-heavens.jpg?alt=media&token=22ef88f0-9ccf-4e11-ad8d-f573f15ea85e",
  "frostfall-exp":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fshattered-heavens.jpg?alt=media&token=22ef88f0-9ccf-4e11-ad8d-f573f15ea85e",
  "frostfall-expanse":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fshattered-heavens.jpg?alt=media&token=22ef88f0-9ccf-4e11-ad8d-f573f15ea85e",
  "ember-horizon":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fshattered-heavens.jpg?alt=media&token=22ef88f0-9ccf-4e11-ad8d-f573f15ea85e",
  "veilwater-basin":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fshattered-heavens.jpg?alt=media&token=22ef88f0-9ccf-4e11-ad8d-f573f15ea85e",
  "titan-divide":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fshattered-heavens.jpg?alt=media&token=22ef88f0-9ccf-4e11-ad8d-f573f15ea85e",
  // Vorthak — Dark Woodlands sub-region
  "crimson-fang":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fdark-woodlands.jpg?alt=media&token=d408a676-ec9f-40a7-8dd0-08899c88a04a",
  "root-grove":           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fdark-woodlands.jpg?alt=media&token=d408a676-ec9f-40a7-8dd0-08899c88a04a",
  "serpent-mire":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fdark-woodlands.jpg?alt=media&token=d408a676-ec9f-40a7-8dd0-08899c88a04a",
  "burrowdeep":           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fdark-woodlands.jpg?alt=media&token=d408a676-ec9f-40a7-8dd0-08899c88a04a",
  "burrowdeep-basin":     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fdark-woodlands.jpg?alt=media&token=d408a676-ec9f-40a7-8dd0-08899c88a04a",
  "gremlin-hollows":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fdark-woodlands.jpg?alt=media&token=d408a676-ec9f-40a7-8dd0-08899c88a04a",
  // Vorthak — Corrupted Hallows sub-region
  "defiled-sanctum":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fcorrupted-hallows.jpg?alt=media&token=90859bb8-c4d6-44f1-ad54-f085f85b9fc5",
  "dark-cathedral":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fcorrupted-hallows.jpg?alt=media&token=90859bb8-c4d6-44f1-ad54-f085f85b9fc5",
  "gravemarch-fields":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fcorrupted-hallows.jpg?alt=media&token=90859bb8-c4d6-44f1-ad54-f085f85b9fc5",
  "fallen-bastion":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fcorrupted-hallows.jpg?alt=media&token=90859bb8-c4d6-44f1-ad54-f085f85b9fc5",
  "whispering-necropolis":"https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fcorrupted-hallows.jpg?alt=media&token=90859bb8-c4d6-44f1-ad54-f085f85b9fc5",
  // Vorthak — Otherworld sub-region
  "blighted-world":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fotherworld.jpg?alt=media&token=9c5bfee7-ab52-44be-acca-806572eac528",
  "infernal-reach":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fotherworld.jpg?alt=media&token=9c5bfee7-ab52-44be-acca-806572eac528",
  "sphinx-dominion":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fotherworld.jpg?alt=media&token=9c5bfee7-ab52-44be-acca-806572eac528",
  "ashwing-aerie":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fotherworld.jpg?alt=media&token=9c5bfee7-ab52-44be-acca-806572eac528",
  "leviathan-depths":     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fotherworld.jpg?alt=media&token=9c5bfee7-ab52-44be-acca-806572eac528",
  // Nyx Abyss
  "void-chasm":           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fnyx-abyss%2Fnyx-abyss.jpeg?alt=media&token=f53427ea-4393-48e1-93d7-c83f7823dd8a",
  "abyssal-depths":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fnyx-abyss%2Fnyx-abyss.jpeg?alt=media&token=f53427ea-4393-48e1-93d7-c83f7823dd8a",
  "fallen-heaven":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fnyx-abyss%2Fnyx-abyss.jpeg?alt=media&token=f53427ea-4393-48e1-93d7-c83f7823dd8a",
};

const GENERAL_CHAT_BG = "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/general%20chat.jpg?alt=media&token=692fa815-c40f-4b8a-8b16-1017ab8af4ea";

function _applyChatBg(locationId, tab) {
  const win = document.querySelector(".chat-window");
  if (!win) return;
  let url = null;
  if (tab === "general") {
    url = GENERAL_CHAT_BG;
  } else if (tab === "rp" || tab == null) {
    url = CHAT_LOCATION_BG[locationId] || null;
  }
  if (url) {
    win.style.backgroundImage    = `url('${url}')`;
    win.style.backgroundSize     = "cover";
    win.style.backgroundPosition = "center";
    win.style.backgroundRepeat   = "no-repeat";
  } else {
    win.style.backgroundImage = "";
  }
}

async function initChat() {
  const location   = _charData?.kingdom || _charData?.location || "unknown";
  // Strip em-dash suffix (e.g. 'Mistveil Town — Western Safe Zone' -> 'Mistveil Town')
  // so the presence slug matches what the deity dropdown generates
  const locationId = location.split('\u2014')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, "-");

  // ── Dead player restriction: force general tab on init ───────────────────
  if (_charData?.isDead) {
    _chatTab = "general";
  }

  // Pre-register duel context immediately so getDuelContext() is never stale
  // even if a player opens the duel popup before startChatListener fires.
  if (window.updateDuelContext) window.updateDuelContext(_chatTab || 'rp', locationId);

  // Write presence so others can see us
  await writePresence(locationId);

  // Listen to active players in location (or general if starting there)
  if (_chatTab === "general") {
    await writePresence("general");
    _listenGeneralPresence();
  } else {
    listenPresence(locationId);
  }

  // Listen to NPCs in this location
  listenLocationNpcs(locationId);

  // Render sidebar tab toggle (Players / NPCs)
  renderNpcSidebarToggle();

  // Add NPC Manager button for Deities
  if (_charData?.isDeity && !document.getElementById("deity-npc-mgr-btn")) {
    const btn = document.createElement("button");
    btn.id = "deity-npc-mgr-btn";
    btn.className = "npc-mgr-btn";
    btn.textContent = "🧙 Manage NPCs";
    btn.onclick = () => window.openNpcManagerPanel();
    const locBar = document.querySelector(".chat-location-bar");
    if (locBar) locBar.appendChild(btn);
  }

  // Start chat for current tab
  startChatListener(locationId, _chatTab);

  // Apply location background on load (RP tab only)
  _applyChatBg(locationId, _chatTab);

  // Tab switching
  window._switchChatTab = (tab) => {
    // ── Dead player restriction: force general chat only ─────────────────
    if (_charData?.isDead && tab === "rp") {
      window.showToast("☠️ You are dead. Only General Chat is available.", "error");
      tab = "general"; // redirect to general
    }
    _chatTab = tab;
    if (_chatUnsub) { _chatUnsub(); _chatUnsub = null; }
    // Wipe container so the new listener does a clean first-load render
    const _chatContainer = document.getElementById("chat-messages");
    if (_chatContainer) _chatContainer.innerHTML = "";
    startChatListener(locationId, tab);

    // Apply / clear location background based on tab
    _applyChatBg(locationId, tab);

    // Show location bar only on RP tab
    const locBar = document.querySelector(".chat-location-bar");
    if (locBar) locBar.style.display = tab === "general" ? "none" : "";

    // ── Dead player: show dead notice banner on input area ────────────────
    const deadNotice = document.getElementById("dead-chat-notice");
    if (_charData?.isDead) {
      const inputArea = document.querySelector(".chat-input-row") || document.querySelector(".chat-input-wrap");
      if (inputArea && !deadNotice) {
        const notice = document.createElement("div");
        notice.id = "dead-chat-notice";
        notice.style.cssText = "padding:8px 12px;background:rgba(180,30,30,0.18);border:1px solid #b43030;border-radius:8px;color:#e08080;font-size:0.82rem;text-align:center;margin-bottom:6px;";
        notice.innerHTML = "☠️ <b>You are dead.</b> You may only speak in General Chat.";
        inputArea.parentNode.insertBefore(notice, inputArea);
      }
    } else if (deadNotice) {
      deadNotice.remove();
    }

    // On General tab, listen to players currently in General chat
    if (tab === "general") {
      writePresence("general");
      _listenGeneralPresence();
      _loadGeneralNpcsForSidebar();
    } else {
      // Re-listen to local presence
      if (_presenceUnsub) { _presenceUnsub(); _presenceUnsub = null; }
      startPresenceListener(locationId);
    }
  };
}

async function writePresence(locationId) {
  if (!_uid || !_charData) return;
  try {
    const presRef = doc(db, "presence", locationId, "players", _uid);
    await setDoc(presRef, {
      uid:       _uid,
      name:      _charData.name,
      rank:      _charData.rank || "Wanderer",
      level:     _charData.level || 1,
      avatarUrl: _charData.avatarUrl || "",
      location:  locationId,
      lastSeen:  serverTimestamp(),
    }, { merge: true });
  } catch(e) { console.error("Presence write:", e); }
}

function startPresenceListener(locationId) { return listenPresence(locationId); }
function listenPresence(locationId) {
  if (_presenceUnsub) _presenceUnsub();
  const presCol = collection(db, "presence", locationId, "players");
  // Active = seen in last 5 minutes
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const q = query(presCol, where("lastSeen", ">=", fiveMinAgo));

  _presenceUnsub = onSnapshot(q, snap => {
    const listEl   = document.getElementById("chat-players-list");
    const onlineEl = document.getElementById("chat-online");
    if (!listEl) return;

    const players = snap.docs.map(d => d.data()).filter(p => p.uid !== _uid);
    const total   = players.length + 1; // include self
    onlineEl.textContent = `● ${total} online`;

    listEl.innerHTML = players.map(p => {
      const av = p.avatarUrl?.startsWith("http")
        ? `<img src="${p.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
        : `<span style="font-size:0.9rem">${p.avatarUrl || "⚔️"}</span>`;
      return `<div class="chat-player-chip" onclick="openPlayerPopup('${p.uid}','${(p.name||"").replace(/'/g,"\\'")}',this)" title="${p.name} · ${p.rank} Lv.${_displayLevel(p.level||1)}">
        <div class="chat-player-avatar">${av}</div>
        <span class="chat-player-name">${p.name}</span>
      </div>`;
    }).join("") || `<span style="color:var(--ash);font-size:0.72rem;font-style:italic">No other players here yet</span>`;
  }, () => {});
}

async function _loadAllPlayers() {
  const listEl  = document.getElementById("chat-players-list");
  if (!listEl) return;

  // Stop location presence listener while on General
  if (_presenceUnsub) { _presenceUnsub(); _presenceUnsub = null; }

  try {
    const snap = await getDocs(collection(db, "characters"));
    // Exclude deities, keep all players including self
    const all = snap.docs.map(d => d.data()).filter(p => !p.isDeity);
    const total = all.length;

    const onlineEl = document.getElementById("chat-online");
    if (onlineEl) onlineEl.textContent = `● ${total} online`;

    listEl.innerHTML = all.map(p => {
      const isMe = p.uid === _uid;
      const av = p.avatarUrl?.startsWith("http")
        ? `<img src="${p.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
        : `<span style="font-size:0.9rem">${p.avatarUrl || "⚔️"}</span>`;
      const loc = (p.kingdom || p.location || "").split("—")[0].trim();
      const label = isMe ? `${p.name} (You)` : p.name;
      return `<div class="chat-player-chip${isMe ? " is-self" : ""}" ${isMe ? "" : `onclick="openPlayerPopup('${p.uid}','${(p.name||"").replace(/'/g,"\\'")}',this)"`} title="${label} · ${loc}">
        <div class="chat-player-avatar">${av}</div>
        <span class="chat-player-name">${label}</span>
      </div>`;
    }).join("") || `<span style="color:var(--ash);font-size:0.72rem;font-style:italic">No players found</span>`;
  } catch(e) {
    console.error("_loadAllPlayers:", e);
  }
}

// ── Listen to players currently in General chat (presence-based) ───────────
function _listenGeneralPresence() {
  const listEl = document.getElementById("chat-players-list");
  if (!listEl) return;

  // Stop any existing location presence listener
  if (_presenceUnsub) { _presenceUnsub(); _presenceUnsub = null; }

  const presCol = collection(db, "presence", "general", "players");
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const q = query(presCol, where("lastSeen", ">=", fiveMinAgo));

  _presenceUnsub = onSnapshot(q, snap => {
    const onlineEl = document.getElementById("chat-online");
    const players  = snap.docs.map(d => d.data()).filter(p => p.uid !== _uid && !p.isDeity);
    const total    = players.length + 1; // include self
    if (onlineEl) onlineEl.textContent = `● ${total} online`;

    // Self chip first
    const selfChip = (() => {
      const av = _charData?.avatarUrl?.startsWith("http")
        ? `<img src="${_charData.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
        : `<span style="font-size:0.9rem">${_charData?.avatarUrl || "⚔️"}</span>`;
      return `<div class="chat-player-chip is-self" title="${_charData?.name} (You)">
        <div class="chat-player-avatar">${av}</div>
        <span class="chat-player-name">${_charData?.name || "You"} (You)</span>
      </div>`;
    })();

    const otherChips = players.map(p => {
      const av = p.avatarUrl?.startsWith("http")
        ? `<img src="${p.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
        : `<span style="font-size:0.9rem">${p.avatarUrl || "⚔️"}</span>`;
      return `<div class="chat-player-chip" onclick="openPlayerPopup('${p.uid}','${(p.name||"").replace(/'/g,"\\'")}',this)" title="${p.name} · ${p.rank||""} Lv.${_displayLevel(p.level||1)}">
        <div class="chat-player-avatar">${av}</div>
        <span class="chat-player-name">${p.name}</span>
      </div>`;
    }).join("");

    listEl.innerHTML = selfChip + (otherChips || `<span style="color:var(--ash);font-size:0.72rem;font-style:italic">No other players in General Chat</span>`);
  }, () => {});
}


async function _loadGeneralNpcsForSidebar() {
  _generalNpcs = [];
  try {
    const snap = await getDocs(collection(db, "npcs", "global", "list"));
    _generalNpcs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) { console.warn("[_loadGeneralNpcsForSidebar]", e); }

  // Rebuild NPC sidebar with general NPCs — do NOT overwrite _locationNpcs
  renderNpcSidebarToggle();
  if (_npcSidebarTab === "npcs") renderNpcList();
}

function startChatListener(locationId, tab) {
  // Track context for chat duels and trades
  if (window.updateDuelContext)  window.updateDuelContext(tab, locationId);
  if (window.updateTradeContext) window.updateTradeContext(tab, locationId);

  const msgsRef = tab === "general"
    ? collection(db, "general-chat", "global", "messages")   // one global room
    : collection(db, "chats", locationId, "messages");        // location-specific
  // Both tabs use server-side orderBy — Firestore auto-indexes single fields,
  // no composite index needed.
  const q = query(msgsRef, orderBy("timestamp", "asc"), limitToLast(150));

  // ── Helper: build a single message element ──────────────────────
  function _buildMsgEl(d) {
    const msg    = d.data();
    const docId  = d.id;
    const isMe   = msg.uid === _uid;
    const time   = msg.timestamp?.toDate?.() ? formatTime(msg.timestamp.toDate()) : "";
    const colPath = tab === "general"
      ? `general-chat/global/messages`
      : `chats/${locationId}/messages`;

    // ── DUEL CARD ────────────────────────────────────────────────
    // Every duel card message carries a frozen duelSnapshot embedded
    // in the Firestore document. We ALWAYS prefer rendering from that
    // snapshot — no live Firestore re-fetch needed.
    // isLiveDuelCard=true cards ALSO mount a Firestore listener so
    // active participants see live HP/action updates.
    if (msg.isDuelCard && msg.duelId) {
      const el = document.createElement('div');
      el.className = 'duel-card-wrapper';
      el.dataset.duelId = msg.duelId;
      el.dataset.msgId  = docId;

      // Defer mounting so the element is in the DOM before listeners fire
      requestAnimationFrame(() => {
        const snapshot = msg.duelSnapshot;
        if (msg.isLiveDuelCard) {
          // Check if viewer is a participant. If _uid isn't resolved yet,
          // default to mountDuelCard (live listener) so we never accidentally
          // treat a participant as a spectator and lock them out.
          const isParticipant = !snapshot || !_uid || (
            snapshot.challengerId === _uid || snapshot.targetId === _uid
          );
          if (isParticipant) {
            // Participants (or unknown uid): live listener — renderDuelCard inside
            // will correctly evaluate isMyTurn using the real uid each time it fires.
            window.mountDuelCard?.(msg.duelId, el, snapshot || null);
          } else {
            // Confirmed spectator: render snapshot statically (read-only, no listener)
            window.renderDuelCard?.(snapshot, msg.duelId, el, /*isStaticSnapshot=*/true);
          }
        } else if (snapshot) {
          // Static snapshot card (historical turn records) — always read-only
          window.renderDuelCard?.(snapshot, msg.duelId, el, /*isStaticSnapshot=*/true);
        } else {
          window.mountDuelCard?.(msg.duelId, el, null);
        }
      });
      return el;
    }

    // ── TRADE CARD ───────────────────────────────────────────────
    if (msg.isTradeCard && msg.tradeId) {
      const el = document.createElement('div');
      el.className = 'trade-card-wrapper';
      el.dataset.tradeId = msg.tradeId;
      el.dataset.msgId   = docId;
      // Always live-mount so spectators and traders see real-time updates
      requestAnimationFrame(() => {
        window.mountTradeCard?.(msg.tradeId, el, msg.tradeSnapshot || null);
      });
      return el;
    }

    // ── DUEL EVENT bubble ────────────────────────────────────────
    if (msg.isDuelEvent && msg.duelId) {
      const el = document.createElement('div');
      el.className = 'chat-msg duel-event-msg';
      el.dataset.msgId = docId;
      // Prefer richText (HTML) for display; fall back to plain text field
      const displayText = msg.richText || msg.text || '';
      const eventIcon   = msg.duelEventIcon || '⚔️';
      el.innerHTML = `
        <div class="duel-event-bubble">
          <span class="duel-event-icon">${eventIcon}</span>
          <span class="duel-event-text">${displayText}</span>
          <span class="duel-event-time">${time}</span>
        </div>`;
      return el;
    }

    // ── WORLD EVENT (Unexpected / Logical Development) ──────────
    if (msg.isWorldEvent && msg.uid === 'system') {
      const el = document.createElement('div');
      const isUnexpected = msg.eventType === 'unexpected';
      el.className = `chat-msg world-event-msg world-event-${msg.eventType || 'unexpected'}`;
      el.dataset.msgId = docId;
      el.innerHTML = `
        <div class="world-event-bubble">
          <div class="world-event-header">
            <span class="world-event-icon">${isUnexpected ? '⚡' : '📖'}</span>
            <span class="world-event-label">[${msg.eventLabel || (isUnexpected ? 'UNEXPECTED DEVELOPMENT' : 'LOGICAL DEVELOPMENT')}]</span>
            <span class="world-event-time">${time}</span>
          </div>
          <div class="world-event-text">${formatChatText(msg.text || '')}</div>
        </div>`;
      return el;
    }

    // ── SYSTEM message ───────────────────────────────────────────
    if (msg.isSystem && msg.uid === 'system') {
      const el = document.createElement('div');
      el.className = 'chat-msg system-duel-msg';
      el.dataset.msgId = docId;
      el.innerHTML = `<div class="chat-msg-body"><div class="system-duel-text">${msg.text || ''}</div></div>`;
      return el;
    }

    // ── Regular chat message ─────────────────────────────────────
    const avatarUrl = isMe ? (_charData?.avatarUrl || msg.avatarUrl || "") : (msg.avatarUrl || "");
    const avatarContent = avatarUrl?.startsWith("http")
      ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
      : `<span style="font-size:1rem">${avatarUrl || "⚔️"}</span>`;

    const el = document.createElement("div");
    el.className = `chat-msg${isMe ? " own" : ""}`;
    el.dataset.id    = docId;
    el.dataset.msgId = docId;

    if (isMe) {
      const replyQuoteHTML = msg.replyTo ? `
        <div class="chat-msg-reply-quote" onclick="window._jumpToMsg?.('${msg.replyTo.id}')">
          <div class="chat-msg-reply-quote-bar"></div>
          <div class="chat-msg-reply-quote-body">
            <div class="chat-msg-reply-quote-name">${escapeHtml(msg.replyTo.charName||'')}</div>
            <div class="chat-msg-reply-quote-text">${escapeHtml(msg.replyTo.text||'')}</div>
          </div>
        </div>` : '';
      el.innerHTML = `
        <div class="chat-msg-avatar own-avatar">${avatarContent}</div>
        <div class="chat-msg-body">
          <div class="chat-msg-header own-header">
            ${msg.title && !["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"].includes(msg.title) ? `<span class="chat-msg-title">${msg.title}</span>` : ""}
            <span class="chat-msg-rank">${msg.rank||_charData?.rank||"Wanderer"} · Lv.${_displayLevel(msg.level||_charData?.level||1)}</span>
            <span class="chat-msg-name own-name">${msg.charName||_charData?.name||"You"}</span>
          </div>
          ${replyQuoteHTML}
          <div class="chat-msg-text own-text" data-docid="${docId}">${formatChatText(msg.text||"")}</div>
          <div class="chat-msg-actions">
            <button class="chat-action-btn" title="Edit" onclick="startEditMsg('${docId}','${colPath}',this)">✏️</button>
            <button class="chat-action-btn" title="Delete" onclick="deleteMsg('${docId}','${colPath}')">🗑️</button>
          </div>
          <div class="chat-msg-time own-time">${time}</div>
        </div>`;

      const msgBody = el.querySelector(".chat-msg-body");
      let _hideTimer = null;
      msgBody.addEventListener("mouseenter", () => { clearTimeout(_hideTimer); msgBody.classList.add("msg-hovered"); });
      msgBody.addEventListener("mouseleave", () => { _hideTimer = setTimeout(() => msgBody.classList.remove("msg-hovered"), 1500); });
      const textBubble = el.querySelector(".own-text");
      textBubble.addEventListener("touchstart", (e) => {
        e.stopPropagation();
        const isOpen = msgBody.classList.contains("msg-hovered");
        document.querySelectorAll(".chat-msg-body.msg-hovered").forEach(b => b.classList.remove("msg-hovered"));
        if (!isOpen) msgBody.classList.add("msg-hovered");
      }, { passive: true });

    } else if (msg.isNpc) {
      el.classList.add("npc-msg");
      const npcReplyQuoteHTML = msg.replyTo ? `
        <div class="chat-msg-reply-quote" onclick="window._jumpToMsg?.('${msg.replyTo.id}')">
          <div class="chat-msg-reply-quote-bar"></div>
          <div class="chat-msg-reply-quote-body">
            <div class="chat-msg-reply-quote-name">${escapeHtml(msg.replyTo.charName||'')}</div>
            <div class="chat-msg-reply-quote-text">${escapeHtml(msg.replyTo.text||'')}</div>
          </div>
        </div>` : '';
      el.innerHTML = `
        <div class="chat-msg-avatar npc-avatar" onclick="openPlayerPopup('npc_${msg.npcId||'npc'}','${(msg.charName||"NPC").replace(/'/g,"\\'")}',this)" style="cursor:pointer" title="${msg.charName}">${avatarContent}</div>
        <div class="chat-msg-body">
          <div class="chat-msg-header">
            <span class="chat-msg-name npc-name" onclick="openPlayerPopup('npc_${msg.npcId||'npc'}','${(msg.charName||"NPC").replace(/'/g,"\\'")}',this)" style="cursor:pointer">🧙 ${msg.charName||"NPC"}</span>
            ${msg.title && !["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"].includes(msg.title) ? `<span class="chat-msg-title npc-role">${msg.title}</span>` : ""}
            <span class="chat-msg-rank" style="color:var(--gold-dim);font-size:0.7rem">${msg.rank||"NPC"} · Lv.${_displayLevel(msg.level||1)}</span>
            ${msg.isAutoReply ? `<span style="font-size:0.65rem;color:var(--ash);font-style:italic">auto</span>` : ""}
            <span class="chat-msg-time">${time}</span>
          </div>
          ${tab === "general" ? `<div class="chat-msg-location">📍 ${msg.location||""}</div>` : ""}
          ${npcReplyQuoteHTML}
          <div class="chat-msg-text npc-bubble">${formatChatText(msg.text||"")}</div>
          <button class="reply-btn" onclick="window._startReply('${docId}','${escapeHtml(msg.charName||'')}','${escapeHtml(msg.text||'').replace(/'/g,"\\'")}')">↩ Reply</button>
        </div>`;
    } else {
      const replyQuoteHTML = msg.replyTo ? `
        <div class="chat-msg-reply-quote" onclick="window._jumpToMsg?.('${msg.replyTo.id}')">
          <div class="chat-msg-reply-quote-bar"></div>
          <div class="chat-msg-reply-quote-body">
            <div class="chat-msg-reply-quote-name">${escapeHtml(msg.replyTo.charName||'')}</div>
            <div class="chat-msg-reply-quote-text">${escapeHtml(msg.replyTo.text||'')}</div>
          </div>
        </div>` : '';
      el.innerHTML = `
        <div class="chat-msg-avatar" onclick="openPlayerPopup('${msg.uid}','${(msg.charName||"").replace(/'/g,"\\'")}',this)" style="cursor:pointer" title="${msg.charName}">${avatarContent}</div>
        <div class="chat-msg-body">
          <div class="chat-msg-header">
            <span class="chat-msg-name" onclick="openPlayerPopup('${msg.uid}','${(msg.charName||"").replace(/'/g,"\\'")}',this)" style="cursor:pointer">${msg.charName||"Unknown"}</span>
            ${msg.title && !["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"].includes(msg.title) ? `<span class="chat-msg-title">${msg.title}</span>` : ""}
            <span class="chat-msg-rank">${msg.rank||"Wanderer"} · Lv.${_displayLevel(msg.level||1)}</span>
            <span class="chat-msg-time">${time}</span>
          </div>
          ${tab === "general" ? `<div class="chat-msg-location">📍 ${msg.location||""}</div>` : ""}
          ${replyQuoteHTML}
          <div class="chat-msg-text">${formatChatText(msg.text||"")}</div>
          <button class="reply-btn" onclick="window._startReply('${docId}','${escapeHtml(msg.charName||'')}','${escapeHtml(msg.text||'').replace(/'/g,"\\'")}')">↩ Reply</button>
        </div>`;
    }
    return el;
  }

  let _isFirstLoad = true;

  _chatUnsub = onSnapshot(q, (snap) => {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    // ── FIRST LOAD: full render ──────────────────────────────────
    // Build the entire list from scratch once, then switch to incremental.
    if (_isFirstLoad) {
      _isFirstLoad = false;
      if (snap.empty) {
        container.innerHTML = tab === "rp"
          ? `<div class="chat-empty"><span>✦</span><span>The world awaits your words...</span></div>`
          : `<div class="chat-empty"><span>💬</span><span>No general chat yet. Say hello!</span></div>`;
        return;
      }
      container.innerHTML = "";
      const docs = [];
      snap.forEach(d => docs.push(d));
      docs.forEach(d => {
        const el = _buildMsgEl(d);
        if (el) container.appendChild(el);
      });
      container.scrollTop = container.scrollHeight;

      // Touch: close action menus when tapping outside (attach once)
      container.addEventListener("touchstart", (e) => {
        if (!e.target.closest(".own-text") && !e.target.closest(".chat-msg-actions")) {
          document.querySelectorAll(".chat-msg-body.msg-hovered").forEach(b => b.classList.remove("msg-hovered"));
        }
      }, { passive: true });
      return;
    }

    // ── INCREMENTAL: only process changes ───────────────────────
    // This is the critical fix for duel cards: new messages are APPENDED
    // to the live DOM, not re-created — so mountDuelCard's el reference
    // stays valid and the Firestore listener inside it writes to the right node.
    let didAppend = false;
    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        // Skip if already rendered (guard against duplicate onSnapshot fires)
        if (container.querySelector(`[data-msg-id="${change.doc.id}"]`)) return;
        // Remove empty-state placeholder if present
        const empty = container.querySelector('.chat-empty');
        if (empty) empty.remove();
        const el = _buildMsgEl(change.doc);
        if (el) { container.appendChild(el); didAppend = true; }
      } else if (change.type === 'modified') {
        const existing = container.querySelector(`[data-msg-id="${change.doc.id}"]`);
        if (existing) {
          // Duel cards: patch the snapshot in-place so the live Firestore listener
          // inside mountDuelCard is NOT destroyed (replaceChild would kill it).
          if (existing.classList.contains('duel-card-wrapper')) {
            const msg = change.doc.data();
            // Live duel cards are managed by the mountDuelCard Firestore listener —
            // do NOT re-render them here or we'll clobber the live listener's work.
            // Only re-render static snapshot cards (isLiveDuelCard=false).
            if (!msg.isLiveDuelCard) {
              const snapshot = msg.duelSnapshot;
              if (snapshot) {
                window.renderDuelCard?.(snapshot, msg.duelId, existing, /*isStaticSnapshot=*/true);
              }
            }
          } else {
            // Regular messages: safe to replace
            const updated = _buildMsgEl(change.doc);
            if (updated) container.replaceChild(updated, existing);
          }
        }
      } else if (change.type === 'removed') {
        const existing = container.querySelector(`[data-msg-id="${change.doc.id}"]`);
        if (existing) existing.remove();
      }
    });
    if (didAppend) container.scrollTop = container.scrollHeight;
  }, (err) => {
    console.error("[Chat] onSnapshot error — tab:", tab, "err:", err);
    window.showToast?.("Chat failed to load. Please refresh.", "error");
  });
}

let _isSending = false; // debounce guard — prevent double-send on fast taps
async function sendChat() {
  if (_isSending) return;
  const input = document.getElementById("chat-input");
  const text  = input?.value.trim();
  if (!text) return;
  if (!_charData) {
    window.showToast?.("Still loading your character — please try again.", "error");
    return;
  }
  _isSending = true;

  const location   = _charData.kingdom || _charData.location || "unknown";
  const locationId = location.split('\u2014')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, "-");
  const tab        = window._getActiveChatTab?.() || "rp";

  // ── Dead player restriction: can only speak in general chat ──────────────
  if (_charData.isDead && tab !== "general") {
    window.showToast("☠️ You are dead. You can only speak in General Chat.", "error");
    return;
  }
  const msgsRef    = tab === "general"
    ? collection(db, "general-chat", "global", "messages")
    : collection(db, "chats", locationId, "messages");

  // Build message payload — attach replyTo if set
  const payload = {
    uid: _uid,
    charName: _charData.name,
    avatarUrl: _charData.avatarUrl || "",
    rank: _charData.rank || "Wanderer",
    level: _charData.level || 1,
    location: location,
    text: text,
    timestamp: serverTimestamp(),
  };
  if (window._replyTo) {
    payload.replyTo = window._replyTo;
  }

  // Clear input immediately so it feels instant (restore only on failure)
  const savedText = text;
  if (input) input.value = "";
  window._cancelReply?.();
  try {
    await addDoc(msgsRef, payload);
  } catch(e) {
    console.error("[sendChat] Failed to send message:", e);
    window.showToast?.("Failed to send message. Please try again.", "error");
    if (input) input.value = savedText; // restore on failure
    _isSending = false;
    return;
  }
  _isSending = false;

  // Mention detection and notification (for player mentions only)
  if (text.includes("@")) {
    // Find all @Name patterns (allow @Name, @Name Last, etc.)
    const mentionRegex = /@([A-Za-z0-9_\- ]{2,32})/g;
    let match;
    const mentionedNames = new Set();
    while ((match = mentionRegex.exec(text))) {
      mentionedNames.add(match[1].trim());
    }
    // Load all player names and UIDs (excluding self)
    try {
      const snap = await getDocs(collection(db, "characters"));
      const nameToUid = {};
      snap.forEach(d => {
        const data = d.data();
        if (data.uid && data.name && data.uid !== _uid) {
          nameToUid[data.name.trim()] = data.uid;
        }
      });
      // For each mentioned name, increment their mentions count
      for (const name of mentionedNames) {
        const uid = nameToUid[name];
        if (uid) {
          const mentionRef = doc(db, "mentions", uid);
          await setDoc(mentionRef, { count: increment(1), lastUpdated: serverTimestamp() }, { merge: true });
        }
      }
    } catch (e) {
      console.warn("[Mentions] Failed to process mentions:", e);
    }
    // Trigger NPC auto-response if message @tags an NPC (RP tab only)
    if (tab === "rp") checkNpcAutoResponse(text, locationId);
  }
}

// ── Reply helpers ─────────────────────────────────────────────────────────────

// Called when player clicks "↩ Reply" on a message
window._startReply = function(msgId, charName, text) {
  window._replyTo = { id: msgId, charName: charName, text: text };
  const bar = document.getElementById('replying-to');
  if (!bar) return;
  bar.style.display = 'flex';
  bar.innerHTML = `
    <div class="replying-to-accent"></div>
    <div class="replying-to-content">
      <div class="replying-to-name">${escapeHtml(charName)}</div>
      <div class="replying-to-text">${escapeHtml(text)}</div>
    </div>
    <button class="cancel-reply" onclick="window._cancelReply()" title="Cancel reply">✕</button>`;
  document.getElementById('chat-input')?.focus();
};

// Called when player cancels or after send
window._cancelReply = function() {
  window._replyTo = null;
  const bar = document.getElementById('replying-to');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
};

// Scroll to a specific message by Firestore doc id
window._jumpToMsg = function(msgId) {
  const el = document.querySelector(`[data-id="${msgId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.transition = 'background 0.3s';
  el.style.background = 'rgba(37,211,102,0.15)';
  setTimeout(() => { el.style.background = ''; }, 1200);
};


// ═══════════════════════════════════════════════════
//  NPC SYSTEM
// ═══════════════════════════════════════════════════

// Firestore structure:
//   npcs/{locationId}/list/{npcId}  → { name, avatar, description, autoResponses:[{trigger, reply}], locationId }
//   NPC chat messages use isNpc:true, npcId, charName=npcName, uid="npc_{npcId}"

let _npcUnsub = null;
let _locationNpcs = [];   // NPCs in current location
let _npcSidebarTab = "players"; // "players" | "npcs"

// ── Render the NPC sidebar tab toggle ──────────────
function renderNpcSidebarToggle() {
  const toggleWrap = document.getElementById("chat-sidebar-toggle");
  if (!toggleWrap) return;
  toggleWrap.innerHTML = `
    <button class="sidebar-tab-btn ${_npcSidebarTab === "players" ? "active" : ""}"
      onclick="window._switchSidebarTab('players')">All Players</button>
    <button class="sidebar-tab-btn ${_npcSidebarTab === "npcs" ? "active" : ""}"
      onclick="window._switchSidebarTab('npcs')">All NPCs</button>`;
}

window._switchSidebarTab = function(tab) {
  _npcSidebarTab = tab;
  renderNpcSidebarToggle();
  if (tab === "npcs") renderNpcList();
  else {
    // Restore player list visibility
    const listEl = document.getElementById("chat-players-list");
    const npcListEl = document.getElementById("chat-npcs-list");
    if (listEl) listEl.style.display = "";
    if (npcListEl) npcListEl.style.display = "none";
  }
};

// ── Listen to NPCs in current location ─────────────
function listenLocationNpcs(locationId) {
  if (_npcUnsub) { _npcUnsub(); _npcUnsub = null; }
  const npcCol = collection(db, "npcs", locationId, "list");
  _npcUnsub = onSnapshot(npcCol, snap => {
    _locationNpcs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (_npcSidebarTab === "npcs") renderNpcList();
  }, () => {});
}

// ── Render NPC chips in sidebar ─────────────────────
function renderNpcList() {
  const listEl    = document.getElementById("chat-players-list");
  const npcListEl = document.getElementById("chat-npcs-list");
  if (!npcListEl) return;

  if (listEl) listEl.style.display = "none";
  npcListEl.style.display = "";

  // General tab shows general NPCs; RP tab shows location NPCs only
  const npcsToShow = _chatTab === "general" ? _generalNpcs : _locationNpcs;

  if (!npcsToShow.length) {
    npcListEl.innerHTML = `<span style="color:var(--ash);font-size:0.72rem;font-style:italic">${_chatTab === "general" ? "No general NPCs" : "No NPCs in this location"}</span>`;
    return;
  }

  const isDeity = _charData?.isDeity;

  npcListEl.innerHTML = npcsToShow.map(npc => {
    const av = npc.avatar?.startsWith("http")
      ? `<img src="${npc.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
      : `<span style="font-size:1rem">${npc.avatar || "🧙"}</span>`;

    // Deity gets an extra "speak as NPC" button that stops propagation
    const deityBtn = isDeity
      ? `<button class="npc-speak-btn" title="Speak as ${npc.name}"
           onclick="event.stopPropagation();window.openNpcSpeakModal('${npc.id}','${(npc.name||"").replace(/'/g,"\\'")}')">🗣️</button>`
      : "";

    // Whole chip opens the same Speak/Trade/Duel popup as players.
    // uid "npc_<id>" is passed so playerAction('speak') tags @NpcName.
    return `<div class="chat-player-chip npc-chip"
        title="${npc.description || npc.name}"
        onclick="openPlayerPopup('npc_${npc.id}','${(npc.name||"").replace(/'/g,"\\'")}',this)">
      <div class="chat-player-avatar">${av}</div>
      <span class="chat-player-name">${npc.name}</span>
      ${deityBtn}
    </div>`;
  }).join("");
}

// ── Tag NPC into chat input ─────────────────────────
window.tagNpcInChat = function(npcName) {
  const input = document.getElementById("chat-input");
  if (!input) return;
  const cur = input.value;
  input.value = cur ? cur + ` @${npcName} ` : `@${npcName} `;
  input.focus();
};

// ── Deity: speak as NPC modal ───────────────────────
window.openNpcSpeakModal = function(npcId, npcName) {
  document.getElementById("npc-speak-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "npc-speak-modal";
  modal.className = "ink-confirm-overlay";
  modal.innerHTML = `
    <div class="ink-confirm-box" style="min-width:320px;max-width:420px">
      <div style="font-weight:700;font-size:1rem;margin-bottom:8px;color:var(--gold)">🗣️ Speak as <em>${npcName}</em></div>
      <textarea id="npc-speak-text" placeholder="Type what ${npcName} says..." rows="4"
        style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px;font-size:0.9rem;resize:vertical"></textarea>
      <div class="ink-confirm-btns" style="margin-top:10px">
        <button class="ink-confirm-cancel" onclick="document.getElementById('npc-speak-modal').remove()">Cancel</button>
        <button class="ink-confirm-ok" onclick="window.sendNpcMessage('${npcId}','${npcName.replace(/'/g,"\\'")}')">Send</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  setTimeout(() => document.getElementById("npc-speak-text")?.focus(), 50);
};

// ── Send a message AS an NPC (Deity only) ──────────
window.sendNpcMessage = async function(npcId, npcName) {
  if (!_charData?.isDeity) return;
  const textEl = document.getElementById("npc-speak-text");
  const text   = textEl?.value.trim();
  if (!text) return;

  const location   = _charData.kingdom || _charData.location || "unknown";
  const locationId = location.split('\u2014')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, "-");
  const npc        = _locationNpcs.find(n => n.id === npcId) || {};

  // Write presence for this NPC so auto-responses are suppressed while deity is active
  try {
    const presRef = doc(db, "presence", locationId, "players", `npc_${npcId}`);
    await setDoc(presRef, {
      uid:       `npc_${npcId}`,
      name:      npcName,
      rank:      "NPC",
      level:     0,
      title:     npc.description || "",
      avatarUrl: npc.avatar || "🧙",
      location:  location,
      lastSeen:  serverTimestamp(),
    }, { merge: true });
  } catch(e) { console.error("NPC presence write:", e); }

  try {
    const msgsRef = collection(db, "chats", locationId, "messages");
    await addDoc(msgsRef, {
      uid:        `npc_${npcId}`,
      charName:   npcName,
      avatarUrl:  npc.avatar || "🧙",
      rank:       "NPC",
      level:      0,
      title:      npc.description || "",
      location:   location,
      text:       text,
      isNpc:      true,
      npcId:      npcId,
      timestamp:  serverTimestamp(),
    });
  } catch(e) {
    console.error("sendNpcMessage:", e);
    window.showToast("Failed to send message.", "error");
  } finally {
    document.getElementById("npc-speak-modal")?.remove();
  }
};

// ── Auto-response: check if message @tags an NPC ───
async function checkNpcAutoResponse(text, locationId) {
  if (!_locationNpcs.length) return;

  // Helper to check if a UID is present in the location (seen in last 5 min)
  async function isUidPresent(uid) {
    const presCol = collection(db, "presence", locationId, "players");
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const q = query(presCol, where("lastSeen", ">=", fiveMinAgo), where("uid", "==", uid));
    const snap = await getDocs(q);
    return !snap.empty;
  }

  for (const npc of _locationNpcs) {
    // Check if message tags this NPC
    const tagged = new RegExp(`@${npc.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text);
    if (!tagged) continue;

    // Check if a deity or NPC is present (skip auto-response if so)
    // 1. Check for NPC presence (if implemented)
    const npcUid = `npc_${npc.id}`;
    if (await isUidPresent(npcUid)) continue;

    // 2. Check for deity presence (if NPC has a controlling deity)
    if (npc.deityUid && await isUidPresent(npc.deityUid)) continue;

    // 3. Optionally: check for any isDeity user with matching name (legacy support)
    // (Skip for now unless needed)

    const responses = npc.autoResponses || [];
    if (!responses.length) continue;

    // Find matching trigger (keyword/phrase)
    let matched = responses.find(r =>
      r.trigger && text.toLowerCase().includes(r.trigger.toLowerCase())
    );
    // If no keyword match, pick a random default (trigger blank)
    if (!matched) {
      const defaults = responses.filter(r => !r.trigger);
      if (defaults.length) {
        matched = defaults[Math.floor(Math.random() * defaults.length)];
      }
    }
    if (!matched) continue;

    // Small delay so player message appears first
    await new Promise(r => setTimeout(r, 900));

    const msgsRef = collection(db, "chats", locationId, "messages");
    await addDoc(msgsRef, {
      uid:        `npc_${npc.id}`,
      charName:   npc.name,
      avatarUrl:  npc.avatar || "🧙",
      rank:       "NPC",
      level:      0,
      title:      npc.description || "",
      location:   locationId,
      text:       matched.reply,
      isNpc:      true,
      npcId:      npc.id,
      isAutoReply: true,
      timestamp:  serverTimestamp(),
    });
    break; // only one NPC responds per message
  }
}

// ── Deity NPC Management Panel ──────────────────────
window.openNpcManagerPanel = function() {
  if (!_charData?.isDeity) return;
  const location   = _charData.kingdom || _charData.location || "unknown";
  const locationId = location.split('\u2014')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, "-");

  document.getElementById("npc-manager-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "npc-manager-modal";
  modal.className = "ink-confirm-overlay";

  const npcRows = _locationNpcs.map(npc => `
    <div class="npc-manager-row" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:1.3rem">${npc.avatar?.startsWith("http") ? `<img src="${npc.avatar}" style="width:28px;height:28px;border-radius:50%;object-fit:cover"/>` : (npc.avatar||"🧙")}</span>
      <span style="flex:1;font-weight:600;color:var(--text)">${npc.name}</span>
      <button class="chat-action-btn" title="Edit NPC" onclick="window.openNpcEditForm('${npc.id}','${locationId}')">✏️</button>
      <button class="chat-action-btn" title="Delete NPC" onclick="window.deleteNpc('${npc.id}','${locationId}')">🗑️</button>
    </div>`).join("") || `<p style="color:var(--ash);font-size:0.82rem;font-style:italic">No NPCs yet in this location.</p>`;

  modal.innerHTML = `
    <div class="ink-confirm-box" style="min-width:340px;max-width:480px;max-height:80vh;overflow-y:auto">
      <div style="font-weight:700;font-size:1rem;margin-bottom:10px;color:var(--gold)">🧙 NPC Manager — ${location}</div>
      <div id="npc-manager-list">${npcRows}</div>
      <button class="ink-confirm-ok" style="margin-top:12px;width:100%" onclick="window.openNpcEditForm(null,'${locationId}')">+ Add New NPC</button>
      <button class="ink-confirm-cancel" style="margin-top:6px;width:100%" onclick="document.getElementById('npc-manager-modal').remove()">Close</button>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
};

window.openNpcEditForm = function(npcId, locationId) {
  document.getElementById("npc-manager-modal")?.remove();
  const existing = npcId ? (_locationNpcs.find(n => n.id === npcId) || {}) : {};
  const isEdit   = !!npcId;

  // Build auto-response rows
  const autoRows = (existing.autoResponses || []).map((r, i) => npcAutoRow(i, r.trigger, r.reply)).join("") || npcAutoRow(0, "", "");

  const modal = document.createElement("div");
  modal.id = "npc-manager-modal";
  modal.className = "ink-confirm-overlay";
  modal.innerHTML = `
    <div class="ink-confirm-box" style="min-width:340px;max-width:500px;max-height:85vh;overflow-y:auto">
      <div style="font-weight:700;font-size:1rem;margin-bottom:10px;color:var(--gold)">${isEdit ? "✏️ Edit" : "➕ New"} NPC</div>
      <label style="font-size:0.8rem;color:var(--ash)">Name</label>
      <input id="npc-form-name" value="${existing.name||""}" placeholder="NPC Name"
        style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px;margin-bottom:8px;font-size:0.9rem"/>
      <label style="font-size:0.8rem;color:var(--ash)">Avatar (emoji or image URL)</label>
      <input id="npc-form-avatar" value="${existing.avatar||""}" placeholder="🧙 or https://..."
        style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px;margin-bottom:8px;font-size:0.9rem"/>
      <label style="font-size:0.8rem;color:var(--ash)">Description / Role</label>
      <input id="npc-form-desc" value="${existing.description||""}" placeholder="e.g. Blacksmith, Quest Giver"
        style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px;margin-bottom:12px;font-size:0.9rem"/>

      <div style="font-weight:600;font-size:0.85rem;color:var(--gold);margin-bottom:6px">⚡ Auto-Responses</div>
      <div style="font-size:0.75rem;color:var(--ash);margin-bottom:8px">When a player @tags this NPC and their message contains the trigger word, the NPC auto-replies. Leave trigger blank for a default fallback reply.</div>
      <div id="npc-auto-rows">${autoRows}</div>
      <button onclick="window.addNpcAutoRow()" style="font-size:0.78rem;background:none;border:1px dashed var(--border);color:var(--ash);border-radius:6px;padding:4px 10px;cursor:pointer;margin-bottom:12px">+ Add Response</button>

      <div class="ink-confirm-btns">
        <button class="ink-confirm-cancel" onclick="window.openNpcManagerPanel()">Back</button>
        <button class="ink-confirm-ok" onclick="window.saveNpc('${npcId||""}','${locationId}')">${isEdit ? "Save" : "Create"}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
};

function npcAutoRow(i, trigger, reply) {
  return `<div class="npc-auto-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:flex-start">
    <input class="npc-trigger" placeholder="Trigger keyword" value="${(trigger||"").replace(/"/g,"&quot;")}"
      style="flex:1;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px;font-size:0.8rem"/>
    <input class="npc-reply" placeholder="NPC reply..." value="${(reply||"").replace(/"/g,"&quot;")}"
      style="flex:2;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px;font-size:0.8rem"/>
    <button onclick="this.closest('.npc-auto-row').remove()" style="background:none;border:none;color:var(--ash);cursor:pointer;font-size:1rem;padding:0 4px">✕</button>
  </div>`;
}

window.addNpcAutoRow = function() {
  const container = document.getElementById("npc-auto-rows");
  if (!container) return;
  const div = document.createElement("div");
  div.innerHTML = npcAutoRow(Date.now(), "", "");
  container.appendChild(div.firstElementChild);
};

window.saveNpc = async function(npcId, locationId) {
  const name   = document.getElementById("npc-form-name")?.value.trim();
  const avatar = document.getElementById("npc-form-avatar")?.value.trim();
  const desc   = document.getElementById("npc-form-desc")?.value.trim();
  if (!name) { window.showToast("NPC needs a name!", "error"); return; }

  const autoResponses = [];
  document.querySelectorAll(".npc-auto-row").forEach(row => {
    const trigger = row.querySelector(".npc-trigger")?.value.trim();
    const reply   = row.querySelector(".npc-reply")?.value.trim();
    if (reply) autoResponses.push({ trigger: trigger || "", reply });
  });

  const data = { name, avatar: avatar || "🧙", description: desc || "", autoResponses, locationId, updatedAt: serverTimestamp() };

  try {
    if (npcId) {
      await setDoc(doc(db, "npcs", locationId, "list", npcId), data, { merge: true });
      window.showToast(`${name} updated!`, "success");
    } else {
      await addDoc(collection(db, "npcs", locationId, "list"), data);
      window.showToast(`${name} created!`, "success");
    }
    document.getElementById("npc-manager-modal")?.remove();
  } catch(e) {
    console.error("saveNpc:", e);
    window.showToast("Failed to save NPC.", "error");
    document.getElementById("npc-manager-modal")?.remove();
  }
};

window.deleteNpc = async function(npcId, locationId) {
  const confirmed = await inkConfirm("Delete this NPC?");
  if (!confirmed) return;
  try {
    await deleteDoc(doc(db, "npcs", locationId, "list", npcId));
    window.showToast("NPC deleted.", "success");
    window.openNpcManagerPanel();
  } catch(e) {
    window.showToast("Failed to delete NPC.", "error");
  }
};

async function deleteMsg(docId, colPath) {
  const confirmed = await inkConfirm("Delete this message?");
  if (!confirmed) return;
  try {
    await deleteDoc(doc(db, colPath, docId));
  } catch(err) {
    console.error(err);
    window.showToast("Failed to delete message.", "error");
  }
}
window.deleteMsg = deleteMsg;


function inkConfirm(message) {
  // Remove any existing confirm modal
  document.getElementById("ink-confirm-modal")?.remove();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "ink-confirm-modal";
    overlay.className = "ink-confirm-overlay";
    overlay.innerHTML = `
      <div class="ink-confirm-box">
        <p class="ink-confirm-msg">${message}</p>
        <div class="ink-confirm-btns">
          <button class="ink-confirm-cancel">Cancel</button>
          <button class="ink-confirm-ok">Confirm</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    overlay.querySelector(".ink-confirm-cancel").onclick = () => {
      overlay.remove();
      resolve(false);
    };
    overlay.querySelector(".ink-confirm-ok").onclick = () => {
      overlay.remove();
      resolve(true);
    };
    // Click backdrop to cancel
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}
window.inkConfirm = inkConfirm;

// ═══════════════════════════════════════════════════
//  POTION PICKER MODALS
//  Shown after Class Reset / Race Rebirth / Divine Shift
// ═══════════════════════════════════════════════════

function _inkPickerOverlay(title, bodyHtml) {
  document.getElementById('ink-picker-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ink-picker-modal';
  overlay.className = 'ink-confirm-overlay';
  overlay.style.cssText = 'z-index:9999;overflow-y:auto;';
  overlay.innerHTML = `
    <div class="ink-confirm-box" style="max-width:560px;width:94%;max-height:88vh;overflow-y:auto;padding:28px 24px;">
      <div style="font-family:var(--ff-display);font-size:1.1rem;letter-spacing:0.1em;color:var(--gold);margin-bottom:20px;text-align:center;text-transform:uppercase;">${title}</div>
      ${bodyHtml}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

async function openClassPickerModal() {
  return new Promise(resolve => {
    const overlay = _inkPickerOverlay('Choose Your Class', `
      <div style="font-size:0.82rem;color:var(--ash);margin-bottom:16px;text-align:center;font-style:italic;">Your old class has been cleared. Select a new one to begin.</div>
      <div id="ink-picker-cards">${_buildClassCards()}</div>
      <div style="display:flex;gap:10px;margin-top:18px;justify-content:center;">
        <button class="btn-ghost" style="font-size:0.7rem;" onclick="document.getElementById('ink-picker-modal').remove();">✕ CANCEL</button>
        <button class="btn-primary" style="max-width:200px;" onclick="window._inkPickerConfirmClass()">CONFIRM CLASS</button>
      </div>`);

    window._inkPickerSel = null;
    window._inkPickerConfirmClass = async function() {
      const cls = window._inkPickerSel;
      if (!cls) { window.showToast('Please select a class first.', 'error'); return; }
      const roleMap = { Warrior:'Damage Dealer', Guardian:'Tank', Arcanist:'Damage Dealer', Hunter:'Damage Dealer', Assassin:'Damage Dealer', Cleric:'Support/Healer', Summoner:'Summoner' };
      try {
        await updateDoc(doc(db, 'characters', _uid), { charClass: cls, classRole: roleMap[cls] || cls });
        Object.assign(_charData, { charClass: cls, classRole: roleMap[cls] || cls });
        overlay.remove();
        await refreshCharData(); _syncAllDisplays(_charData);
        window.showToast(`⚔️ Class set to ${cls}!`, 'success');
        logActivity('⚔️', `Chose <b>${cls}</b> as their new class.`, '#c9a84c');
        resolve(cls);
      } catch(err) {
        window.showToast('Failed to save class. Try again.', 'error');
      }
    };
  });
}
window.openClassPickerModal = openClassPickerModal;

const RACE_LIST = [
  { name:'Human',       icon:'👤', attr:'EXP Bonus',          desc:'+10% experience gained from all sources.' },
  { name:'Orc',         icon:'💪', attr:'Strength Bonus',     desc:'+10% melee/STR-based damage in combat.' },
  { name:'Undead',      icon:'💀', attr:'Defense Bonus',      desc:'+10% DEF — natural melee resistance.' },
  { name:'Dragonborn',  icon:'🐉', attr:'Magic Resistance',   desc:'+10% resistance to magic damage.' },
  { name:'Fairy',       icon:'🧚', attr:'Luck Bonus',         desc:'+10% luck — better drop rates from monsters.' },
  { name:'Dwarf',       icon:'⛏️', attr:'Gear Bonus',         desc:'+10% bonus stats from equipped gear.' },
  { name:'Lich',        icon:'🔮', attr:'Battle Revival',     desc:'Once per battle, survive a fatal blow at 50% HP.' },
];

async function openRacePickerModal() {
  return new Promise(resolve => {
    const overlay = _inkPickerOverlay('Choose Your Race', `
      <div style="font-size:0.82rem;color:var(--ash);margin-bottom:16px;text-align:center;font-style:italic;">Your old race has been cleared. Select a new one to begin.</div>
      <div id="ink-picker-cards">${_buildRaceCards()}</div>
      <div style="display:flex;gap:10px;margin-top:18px;justify-content:center;">
        <button class="btn-ghost" style="font-size:0.7rem;" onclick="document.getElementById('ink-picker-modal').remove();">✕ CANCEL</button>
        <button class="btn-primary" style="max-width:200px;" onclick="window._inkPickerConfirmRace()">CONFIRM RACE</button>
      </div>`);

    window._inkPickerSel = null;
    window._inkPickerConfirmRace = async function() {
      const raceName = window._inkPickerSel;
      if (!raceName) { window.showToast('Please select a race first.', 'error'); return; }
      const raceData = RACE_LIST.find(r => r.name === raceName);
      const raceAttr = raceData?.attr || '';
      try {
        await updateDoc(doc(db, 'characters', _uid), { race: raceName, raceAttr });
        Object.assign(_charData, { race: raceName, raceAttr });
        overlay.remove();
        await refreshCharData(); _syncAllDisplays(_charData);
        window.showToast(`🌀 Race set to ${raceName}!`, 'success');
        logActivity('🌀', `Chose <b>${raceName}</b> as their new race.`, '#c9a84c');
        resolve(raceName);
      } catch(err) {
        window.showToast('Failed to save race. Try again.', 'error');
      }
    };
  });
}
window.openRacePickerModal = openRacePickerModal;

async function openDeityPickerModal() {
  return new Promise(resolve => {
    const overlay = _inkPickerOverlay('Choose Your Deity', `
      <div style="font-size:0.82rem;color:var(--ash);margin-bottom:16px;text-align:center;font-style:italic;">Your old deity has been cleared. Pledge your faith to a new one.</div>
      <div id="ink-picker-cards">${_buildDeityCards()}</div>
      <div style="display:flex;gap:10px;margin-top:18px;justify-content:center;">
        <button class="btn-ghost" style="font-size:0.7rem;" onclick="document.getElementById('ink-picker-modal').remove();">✕ CANCEL</button>
        <button class="btn-primary" style="max-width:200px;" onclick="window._inkPickerConfirmDeity()">CONFIRM DEITY</button>
      </div>`);

    window._inkPickerSel = null;
    window._inkPickerConfirmDeity = async function() {
      const deityName = window._inkPickerSel;
      if (!deityName) { window.showToast('Please select a deity first.', 'error'); return; }
      const deityTitle = DEITY_LORE[deityName]?.title || '';
      try {
        const newBlessing     = DEITY_BLESSING_NAMES[deityName] || deityName;
        const newBlessingDesc = _getBlessingDesc(deityName, _charData.faithLevel || 0);
        await updateDoc(doc(db, 'characters', _uid), { deity: deityName, deityTitle, blessing: newBlessing, blessingDesc: newBlessingDesc });
        Object.assign(_charData, { deity: deityName, deityTitle, blessing: newBlessing, blessingDesc: newBlessingDesc });
        overlay.remove();
        await refreshCharData(); _syncAllDisplays(_charData);
        window.showToast(`🔮 Deity set to ${deityName}!`, 'success');
        logActivity('🔮', `Pledged faith to <b>${deityName}</b> as their new deity.`, '#c9a84c');
        resolve(deityName);
      } catch(err) {
        window.showToast('Failed to save deity. Try again.', 'error');
      }
    };
  });
}
window.openDeityPickerModal = openDeityPickerModal;

function startEditMsg(docId, colPath, btn) {
  const body      = btn.closest(".chat-msg-body");
  const textEl    = body.querySelector(".own-text");
  const actionsEl = body.querySelector(".chat-msg-actions");
  const rawText   = textEl.innerText;

  textEl.style.display    = "none";
  actionsEl.style.display = "none";

  const wrapper = document.createElement("div");
  wrapper.className = "chat-edit-wrapper";
  wrapper.innerHTML = `
    <textarea class="chat-edit-input">${rawText}</textarea>
    <div class="chat-edit-btns">
      <button class="chat-edit-save">Save</button>
      <button class="chat-edit-cancel">Cancel</button>
    </div>`;
  body.insertBefore(wrapper, textEl);

  const ta = wrapper.querySelector("textarea");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  wrapper.querySelector(".chat-edit-cancel").onclick = () => {
    wrapper.remove();
    textEl.style.display    = "";
    actionsEl.style.display = "";
  };

  wrapper.querySelector(".chat-edit-save").onclick = async () => {
    const newText = ta.value.trim();
    if (!newText) return;
    try {
      await updateDoc(doc(db, colPath, docId), { text: newText, edited: true });
      wrapper.remove();
      textEl.style.display    = "";
      actionsEl.style.display = "";
    } catch(err) {
      console.error(err);
      window.showToast("Failed to edit message.", "error");
    }
  };
}
window.startEditMsg = startEditMsg;


// ═══════════════════════════════════════════════════
//  MARKETPLACE
// ═══════════════════════════════════════════════════
async function buyItem({ name, icon, price, type, qty = 1 }) {
  // Guard: derive type from name if caller didn't supply it
  if (!type) type = getItemType(name);
  const errEl = document.getElementById("buy-error");
  errEl.textContent = "";
  const gold = _charData?.gold ?? 0;
  const totalPrice = price * qty;
  if (gold < totalPrice) { errEl.textContent = `Not enough gold. You have ${gold} coins.`; return; }

  const btn = document.getElementById("btn-confirm-buy");
  btn.disabled = true; btn.textContent = "BUYING...";

  try {
    const inv = [...((_charData?.inventory)||[])];
    const isEquip = getItemType(name) === 'equipment';
    const existing = inv.find(i => i.name === name);
    if (existing && !isEquip) existing.qty += qty;
    else {
      // Equipment always gets a unique iid so enchantment works immediately
      const newItem = { name, icon, type, qty: 1 };
      if (isEquip) newItem.iid = Math.random().toString(36).slice(2,10) + Date.now().toString(36);
      if (!isEquip && qty > 1) newItem.qty = qty;
      inv.push(newItem);
    }

    await updateDoc(doc(db, "characters", _uid), {
      gold:      gold - totalPrice,
      inventory: inv,
    });
    if (_charData) { _charData.gold = gold - totalPrice; _charData.inventory = inv; }

    window._allInvItems = inv;
    _syncAllDisplays(_charData);
    window._refreshInvDisplay();
    document.getElementById("buy-modal").style.display = "none";
    window.showToast(`Purchased ${qty}x ${name}!`, "success");
    const npcMsgEl = document.getElementById("npc-market-success-msg");
    if (npcMsgEl) {
      npcMsgEl.textContent = `Successfully bought ${qty}x ${name}!`;
      npcMsgEl.style.display = "block";
      setTimeout(() => npcMsgEl.style.display = "none", 5000);
    }
    logActivity('🛍️', `<b>Purchased</b> ${qty}x ${name} from the NPC shop for ${totalPrice}💰.`, '#a09080');
  } catch(err) {
    console.error(err);
    errEl.textContent = "Purchase failed. Try again.";
  } finally {
    btn.disabled = false; btn.textContent = "BUY";
  }
}

// ── Item stat preview modal ───────────────────────────────────────────────────
window.openItemStatModal = function(name, enchantLevel) {
  enchantLevel = parseInt(enchantLevel) || 0;
  // Strip any +N suffix baked into the name by the Cloud Function before stat lookup
  const baseName = name.replace(/\s*\+\d+$/, '');
  const weaponStats = EQUIP_WEAPON_STATS[baseName];
  const armorStats  = EQUIP_ARMOR_STATS[baseName];
  const isEquip = weaponStats || armorStats;
  const stats   = weaponStats || armorStats;

  // Try to find the item in crafting recipes for full data (grade, requires)
  let grade = '', recipeData = null;
  for (const [g, items] of Object.entries(window.CANONICAL_EQUIP_RECIPES || {})) {
    const found = items.find(i => i.name === baseName);
    if (found) { grade = g; recipeData = found; break; }
  }

  // Try potion data
  let potionData = null;
  for (const items of Object.values(window.CANONICAL_POTION_RECIPES || {})) {
    const found = items.find(i => i.name === baseName);
    if (found) { potionData = found; break; }
  }

  // Try food data
  let foodData = null;
  for (const items of Object.values(window.CANONICAL_FOOD_RECIPES || {})) {
    const found = items.find(i => i.name === baseName);
    if (found) { foodData = found; break; }
  }

  const icon = recipeData?.icon || potionData?.icon || foodData?.icon || getItemIcon(baseName);

  // Build stat lines for equipment
  const STAT_LABELS = { str:'Strength', int:'Intelligence', def:'Defense', dex:'Dexterity', hp:'HP Bonus' };
  const GRADE_COLOURS = { E:'#aaa', D:'#70c090', C:'#5b9fe0', B:'#c9a84c', A:'#b86fde', S:'#e05555' };
  let bodyHtml = '';

  if (isEquip && stats) {
    // Enchant bonus: +1 to all stats per enchant level
    const enchantBonus = enchantLevel > 0 ? enchantLevel : 0;
    const statLines = Object.entries(stats)
      .map(([k, v]) => {
        const total = v + enchantBonus;
        const bonusHtml = enchantBonus > 0
          ? ` <span style="color:var(--gold);font-size:0.75em">(${v} + <span style="color:#c9a84c">+${enchantBonus}</span> = ${total})</span>`
          : '';
        return `<div class="istat-row"><span class="istat-label">${STAT_LABELS[k]||k.toUpperCase()}</span><span class="istat-val">+${total}${bonusHtml}</span></div>`;
      }).join('');
    const gradeLabel = grade
      ? `<span style="font-family:var(--font-mono);font-size:0.6rem;padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.05);color:${GRADE_COLOURS[grade]||'#aaa'};border:1px solid ${GRADE_COLOURS[grade]||'#aaa'}">GRADE ${grade}</span>`
      : '';
    const typeLabel = `<span style="font-family:var(--font-mono);font-size:0.6rem;color:var(--ash);text-transform:uppercase">${weaponStats?'Weapon':'Armor'}</span>`;
    const enchantBadge = enchantLevel > 0
      ? `<span style="font-family:var(--font-mono);font-size:0.6rem;padding:2px 8px;border-radius:4px;background:rgba(201,168,76,0.12);color:#c9a84c;border:1px solid rgba(201,168,76,0.3)">✨ +${enchantLevel} Enchanted</span>`
      : `<span style="font-family:var(--font-mono);font-size:0.6rem;color:var(--ash)">Unenchanted</span>`;
    const enchantNote = enchantLevel >= 5
      ? `<div style="font-size:0.7rem;color:#c9a84c;margin-top:10px;font-style:italic">✨ Max enchantment reached (+5).</div>`
      : `<div style="font-size:0.7rem;color:var(--ash);margin-top:10px;font-style:italic">✨ Can be enchanted up to +5 for additional stat bonuses.</div>`;
    bodyHtml = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        ${typeLabel} ${gradeLabel} ${enchantBadge}
      </div>
      <div class="istat-grid">${statLines}</div>
      ${enchantNote}`;
  } else if (potionData) {
    const usageRule = baseName.includes('Luck') || baseName.includes('EXP') || baseName.includes('Insight')
      ? `<div style="font-size:0.7rem;color:#c9a84c;margin-top:8px;padding:6px 10px;background:rgba(201,168,76,0.08);border-radius:6px;border:1px solid rgba(201,168,76,0.2)">⚠️ Max 3 uses/day · Non-stackable · Each use lasts 1 hour</div>`
      : '';
    bodyHtml = `
      <div class="istat-effect">${potionData.effect}</div>
      ${usageRule}`;
  } else if (foodData) {
    bodyHtml = `
      <div class="istat-effect">${foodData.effect}</div>
      <div style="font-size:0.7rem;color:var(--ash);margin-top:6px">Grade: ${foodData.grade||'—'}</div>`;
  } else {
    bodyHtml = `<div style="color:var(--ash);font-size:0.85rem;font-style:italic">No stat data available for this item.</div>`;
  }

  const modal = document.getElementById('item-stat-modal');
  document.getElementById('istat-icon').textContent  = icon;
  document.getElementById('istat-name').textContent  = baseName;
  document.getElementById('istat-body').innerHTML    = bodyHtml;
  modal.style.display = 'flex';
};
window.closeItemStatModal = function() {
  document.getElementById('item-stat-modal').style.display = 'none';
};

// Returns { minP, maxP, blocked } for a given inventory item — used by the sell modal UI
// to show the price range hint before the player enters an amount.
window._getListingBracket = function(item) {
  // ─────────────────────────────────────────────────────────────────────────
  // Market listing rules — only three item classes may be listed:
  //   1. Resources / raw materials   (by rarity)
  //   2. Unenchanted equipment        (by grade E–S)
  //   3. Cooked food                  (by recipe grade)
  //
  // Potions, quest/ascension items, and enchanted or merged equipment
  // are permanently blocked.  Returns { blocked, reason } or { minP, maxP }.
  // ─────────────────────────────────────────────────────────────────────────
  if (!item) return null;
  const n        = item.name.toLowerCase();
  const itemType = getItemType(item.name);

  // ── Blocked: quest / ascension items ─────────────────────────────────────
  if (itemType === 'quest') {
    return { blocked: true, reason: 'Quest and advancement materials cannot be listed on the market.' };
  }

  // ── Blocked: potions and elixirs ─────────────────────────────────────────
  const POTION_NAMES = [
    "Minor HP Potion","Standard HP Potion","Greater HP Potion",
    "Minor Mana Potion","Standard Mana Potion","Greater Mana Potion",
    "Minor Luck Potion","Standard Luck Potion","Greater Luck Potion",
    "Minor EXP Potion","Standard EXP Potion","Greater EXP Potion",
    "Stat Reset Potion","Class Reset Potion","Resurrection Potion",
    "Companion Change Potion","Race Rebirth Potion","Divine Shift Potion",
  ];
  if (itemType === 'consumable' && (
    POTION_NAMES.includes(item.name) || ["potion","elixir"].some(x => n.includes(x))
  )) {
    return { blocked: true, reason: 'Potions cannot be listed on the market.' };
  }

  // ── Blocked: enchanted or merged equipment ───────────────────────────────
  if (itemType === 'equipment') {
    const enchLvl = item.enchantLevel || (parseInt((item.name || '').match(/\+(\d+)$/)?.[1]) || 0);
    if (enchLvl > 0) {
      return { blocked: true, reason: 'Enchanted or merged equipment cannot be listed. Only base (unenchanted) gear may be sold.' };
    }
  }

  // ── Price brackets ────────────────────────────────────────────────────────
  // Raw resources / gathered materials — tiered by rarity
  const RESOURCE_BRACKETS = {
    Common:    [50,    100],
    Uncommon:  [250,   300],
    Rare:      [1400,  1500],
    Legendary: [4000,  5000],
    Mythic:    [13000, 15000],
  };
  // Cooked food — tiered by recipe grade
  const FOOD_BRACKETS = {
    Common:    [1560,  1600],
    Uncommon:  [3380,  3500],
    Rare:      [11960, 13000],
    Legendary: [37180, 40000],
    Mythic:    [74390, 80000],
  };
  // Equipment — tiered by item grade (unenchanted only, enforced above)
  // Prices derived from: Crafting Fee + Max Material Cost + 30% profit + range rounding
  const EQUIP_BRACKETS = {
    E: [4550,    5000],
    D: [20410,   23000],
    C: [110760,  120000],
    B: [1347450, 1500000],
    A: [4173000, 5000000],
    S: [8645000, 10000000],
  };

  let minP, maxP;

  if (itemType === 'equipment') {
    const g = item.grade || window._resolveEquipGrade(item.name);
    [minP, maxP] = EQUIP_BRACKETS[g] || EQUIP_BRACKETS['E'];

  } else if (itemType === 'consumable') {
    // Non-potion consumable → cooked food; resolve grade from recipe registry
    let foodGrade = 'Common';
    if (window.CANONICAL_FOOD_RECIPES) {
      for (const recipes of Object.values(window.CANONICAL_FOOD_RECIPES)) {
        const found = recipes.find(r => r.name === item.name);
        if (found?.grade) { foodGrade = found.grade; break; }
      }
    }
    [minP, maxP] = FOOD_BRACKETS[foodGrade] || FOOD_BRACKETS['Common'];

  } else {
    // Raw material / resource — detect rarity from stored field or item name
    let rarity = item.rarity || 'Common';
    if (!item.rarity) {
      if      (["aetherium","titan heart","eden's tear","cosmic leviathan","void orchid"].some(x => n.includes(x))) rarity = 'Mythic';
      else if (["adamantium","titanium","dragon scales","cyclops eye","phoenix feather","celestial","dragonfruit","black unagi"].some(x => n.includes(x))) rarity = 'Legendary';
      else if (["gold ","palladium","mythril","shadow hide","spirit venison","drake meat","shadowfish","flamefish","ying koi","spirit herb","jade vine","ghost root","frost apples","ember fruit","spirit plum"].some(x => n.includes(x))) rarity = 'Rare';
      else if (["silver","bronze","obsidian","marble","quartz","tough hide","fangs","fur","horns","claws","leather","silverfin","glowfish","spotted eel","coral snapper","red minnow","silverleaf","goldroot","nightshade","glowleaf","lotus","golden pears","moon grapes","sunfruit","crystal berries","bitter root"].some(x => n.includes(x))) rarity = 'Uncommon';
    }
    [minP, maxP] = RESOURCE_BRACKETS[rarity] || RESOURCE_BRACKETS['Common'];
  }

  return { minP, maxP, blocked: false };
};

async function sellItem() {
  console.log('[DEBUG] sellItem called');
  const errEl = document.getElementById("sell-error");
  const selEl = document.getElementById("sell-item-select");
  const qtyEl = document.getElementById("sell-qty");
  const priceEl = document.getElementById("sell-price");
  const btn = document.querySelector('#sell-modal .btn-primary[onclick="confirmSell()"]');
  errEl.textContent = "";

  const idx   = parseInt(selEl.value);
  const qty   = parseInt(qtyEl.value);
  const price = parseInt(priceEl.value);
  const item  = window._allInvItems[idx];

  if (!item)      { errEl.textContent = "Select an item.";               return; }
  if (!qty||qty<1){ errEl.textContent = "Enter a valid quantity.";        return; }
  if (!price||price<1){ errEl.textContent = "Enter a valid price.";       return; }
  if (qty > item.qty){ errEl.textContent = "Not enough of that item.";    return; }

  // ── Listing type restriction + price bracket (delegate to _getListingBracket) ──
  // Only resources, unenchanted equipment, and cooked food may be listed.
  const bracket = window._getListingBracket(item);
  if (!bracket) { errEl.textContent = "Unable to determine listing price for this item."; return; }
  if (bracket.blocked) { errEl.textContent = bracket.reason || "This item cannot be listed on the market."; return; }
  const { minP, maxP } = bracket;
  if (price < minP || (maxP !== Infinity && price > maxP)) {
    const rangeLabel = maxP === Infinity
      ? `at least ${minP.toLocaleString()} coins`
      : `between ${minP.toLocaleString()} and ${maxP.toLocaleString()} coins`;
    errEl.textContent = `Price for this item must be ${rangeLabel}.`;
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "LISTING...";
  }
  try {
    await addDoc(collection(db, "marketListings"), {
      sellerUid:   _uid,
      sellerName:  _charData.name,
      itemName:    item.name,
      itemIcon:    getItemIcon(item.name),
      itemType:    item.type || "material",
      qty,
      pricePerUnit: price,
      totalPrice:   price * qty,
      listedAt:    serverTimestamp(),
    });

    // Deduct listed qty from player inventory — mutator reads live server inv
    // so a concurrent gather or reward can't cause a phantom restoration
    const listedItemName = item.name;
    const listedQty = qty;
    await _invWrite(_uid, inv => {
      const invIdx = inv.findIndex(i => i.name === listedItemName);
      if (invIdx !== -1) {
        inv[invIdx].qty -= listedQty;
        if (inv[invIdx].qty <= 0) inv.splice(invIdx, 1);
      }
    });
    window._allInvItems = _charData.inventory;
    window._refreshInvDisplay?.();

    window.showToast(`${item.name} listed for ${price} coins each.`, "success");
    logActivity('🏪', `<b>Listed on Market:</b> ${item.name} × ${qty} @ ${price}💰 each.`, '#c9a84c');
    await _incrementQuest("listing", 1);
    document.getElementById("sell-modal").style.display = "none";
    loadPlayerListings();
  } catch(err) {
    console.error(err);
    errEl.textContent = "Failed to list item. Try again.";
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "LIST FOR SALE";
    }
  }
}


// Ensure this is defined before any calls
window.renderPlayerMarketListings = function() {
  const container = document.getElementById("player-listings");
  if (!container) return;
  const search = (document.getElementById("market-search-input")?.value || "").toLowerCase();
  let listings = window._allMarketListings || [];
  if (search) {
    listings = listings.filter(l => l.itemName.toLowerCase().includes(search));
  }
  if (!listings.length) {
    container.innerHTML = `<div class="listing-empty">No items found.</div>`;
    return;
  }
  container.innerHTML = "";
  let displayedAny = false;
  listings.forEach(l => {
    if (l.qty <= 0) return;
    displayedAny = true;
    const el = document.createElement("div");
    el.className = "listing-card";
    const hasStatView = (l.itemType === 'weapon' || l.itemType === 'armor' || l.itemType === 'consumable' || l.itemType === 'equipment');
    const viewBtn = hasStatView
      ? `<button class="vendor-buy-btn" style="margin-bottom:4px;width:100%" onclick="openItemStatModal('${l.itemName.replace(/'/g,"\\'")}')">VIEW STATS</button>`
      : '';
    const buyBtn = l.sellerUid !== _uid
      ? `<button class="vendor-buy-btn" style="width:100%" onclick="window._buyListing('${l.id}','${l.itemName}','${l.itemIcon}',${l.pricePerUnit},'${l.itemType}',${l.qty})">BUY</button>`
      : `<button class="vendor-buy-btn" style="opacity:0.5;cursor:not-allowed;width:100%">Your listing</button>`;
    el.innerHTML = `
      <div class="listing-item-icon">${l.itemIcon && l.itemIcon !== '📦' ? l.itemIcon : getItemIcon(l.itemName)}</div>
      <div class="listing-item-name">${l.itemName}</div>
      <div class="listing-item-qty">Qty: ${l.qty}</div>
      <div class="listing-price">${l.pricePerUnit} 🪙 <span class="listing-price-sub">per unit</span></div>
      <div class="listing-seller">by ${l.sellerName}</div>
      <div style="margin-top:8px">${viewBtn}${buyBtn}</div>`;
    container.appendChild(el);
  });
  if (!displayedAny) {
    container.innerHTML = `<div class="listing-empty">No items found.</div>`;
  }
};

window.filterPlayerMarketListings = function() {
  window.renderPlayerMarketListings();
};

async function loadPlayerListings() {
  const container = document.getElementById("player-listings");
  if (!container) return;
  // Hide old alert if it exists (for backward compatibility)
  const oldAlert = document.getElementById("market-success-msg");
  if (oldAlert) oldAlert.style.display = "none";
  container.innerHTML = `<div class="listing-empty">Loading listings...</div>`;

  try {
    const q    = query(collection(db, "marketListings"), orderBy("listedAt","desc"), limit(100));
    const snap = await getDocs(q);

    window._allMarketListings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    window.renderPlayerMarketListings();
  } catch(err) {
    console.error(err);
    container.innerHTML = `<div class="listing-empty">Failed to load listings.</div>`;
  }
}

window._buyListing = async (listingId, name, icon, price, type, maxQty) => {
  openBuyModal(name, icon, price, type, maxQty);
  window._buyItem = async (target) => {
    const errEl = document.getElementById("buy-error");
    errEl.textContent = "";
    const gold = _charData?.gold ?? 0;
    const qty = target.qty || 1;
    const totalPrice = target.price * qty;

    if (gold < totalPrice) { errEl.textContent = `Not enough gold. You have ${gold} coins.`; return; }
    if (!listingId) { errEl.textContent = "Invalid listing. Please refresh the market."; return; }

    const btn = document.getElementById("btn-confirm-buy");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "BUYING...";
    }

    try {
      // Call the secure Cloud Function
      const fnBuyListing = httpsCallable(functions, "buyListing");
      const result = await fnBuyListing({ listingId, qty });

      // Locally update gold and inventory from the latest server state
      if (_charData) { _charData.gold = gold - totalPrice; }
      await refreshCharData();
      window._allInvItems = _charData?.inventory || [];
      _syncAllDisplays(_charData);
      window._refreshInvDisplay?.();
      document.getElementById("buy-modal").style.display = "none";

      window.showToast(`Purchased ${qty}x ${target.name}!`, "success");
      logActivity('🛍️', `<b>Bought</b> ${qty}x ${target.name} from the Player Market for ${totalPrice}💰.`, '#a09080');
      const playerMsgEl = document.getElementById("player-market-success-msg");
      if (playerMsgEl) {
        playerMsgEl.textContent = `Successfully bought ${qty}x ${target.name}!`;
        playerMsgEl.style.display = "block";
        setTimeout(() => playerMsgEl.style.display = "none", 5000);
      }
      // Refresh market so the purchased listing updates
      loadPlayerListings();
    } catch(e) {
      console.error("[_buyListing] Cloud Function error:", e);
      // Surface the actual error message from the Cloud Function
      const msg = e?.details?.message || e?.message || String(e);
      errEl.textContent = `Purchase failed: ${msg}`;
      // Also reload market in case listing is stale (e.g. already sold)
      loadPlayerListings();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "BUY";
      }
    }
  };
};


// ═══════════════════════════════════════════════════
//  QUEST SYSTEM (Daily + Story)
//  (Faction Quests handled in Faction panel; World Dev quests removed)
// ═══════════════════════════════════════════════════

// ── Daily quest config ──
const DAILY_QUESTS = {
  hunter:   { target: 20, label: "Hunter's Routine",  reward: { xp:10,  gold:50,  item:{ name:"Iron",        qty:1 } } },
  gatherer: { target: 20, label: "Gatherer's Duty",   reward: { xp:10,  gold:50,  item:{ name:"Minor HP Potion", qty:1 } } },
  market:   { target: 5,  label: "Market Hustle",     reward: { xp:10,  gold:60,  item:{ name:"Herb Fish Soup",  qty:1 } } },
  potions:  { target: 2,  label: "Prepared Mind",     reward: { xp:10,  gold:50,  item:{ name:"Iron",        qty:1 } } },
  food:     { target: 2,  label: "Gusto",             reward: { xp:10,  gold:50,  item:{ name:"Minor HP Potion", qty:1 } } },
  explorer: { target: 3,  label: "Explorer's Path",   reward: { xp:20,  gold:80,  item:{ name:"Iron",        qty:2 } } },
  elite:    { target: 1,  label: "Elite Challenge",   reward: { xp:20,  gold:100, item:{ name:"Magic Crystal",   qty:2 } } },
};
const DAILY_BONUS = { gold: 200 };

// ── Story quest config ──
const STORY_QUESTS = [];

// ── In-memory state ──
window._questProgress   = {};
window._completedQuests = new Set();
window._bonusClaimed    = false;
window._storyProgress   = {};
if (!window._storyQuestDone) window._storyQuestDone = {}; // in-memory session guard — never persisted

// ── Helpers ──
function _getDailyProgress(id) {
  const p = window._questProgress[id];
  if (id === "explorer") return p instanceof Set ? p.size : 0;
  return p || 0;
}

function _renderQuestProgress() {
  Object.keys(DAILY_QUESTS).forEach(id => {
    const q    = DAILY_QUESTS[id];
    const prog = _getDailyProgress(id);
    const done = window._completedQuests.has(id);
    const item = document.querySelector(`[data-quest="${id}"]`);
    if (!item) return;
    let label = item.querySelector(".dq-progress");
    if (!label) {
      label = document.createElement("div");
      label.className = "dq-progress";
      item.querySelector(".dq-info").appendChild(label);
    }
    label.textContent = done ? "✓ Complete" : `${prog} / ${q.target}`;
    label.style.color = done ? "var(--gold)" : "var(--text-dim)";
    if (done) item.classList.add("completed");
  });
}

// Track active tab: 'active' | 'completed' | 'closed'
if (!window._sqActiveTab) window._sqActiveTab = 'active';

function _renderStoryQuests() {
  const container = document.getElementById('story-quests-list');
  if (!container) return;
  // Preserve which quest bodies are currently open so a re-render doesn't slam them shut
  const _openIds = new Set();
  container.querySelectorAll('.sq-item').forEach(el => {
    const body = el.querySelector('.sq-body');
    if (body && body.style.display !== 'none') _openIds.add(el.dataset.questId);
  });
  container.innerHTML = '';

  if (!STORY_QUESTS.length) {
    container.innerHTML = '<div class="story-quest-empty">No story quests yet.</div>';
    return;
  }

  const now = Date.now();

  // Classify each quest into its bucket
  const buckets = { active: [], completed: [], closed: [] };
  STORY_QUESTS.forEach(q => {
    const sp   = window._storyProgress[q.id] || { count: 0, done: false, locations: new Set() };
    const done = sp.done;
    // Re-check expiry live (timer may have run out since load)
    const isExpired = q.expiresAt && q.expiresAt.getTime() < now;
    const isClosed  = q.status === 'closed' || isExpired;
    if (done) {
      buckets.completed.push(q);
    } else if (isClosed) {
      buckets.closed.push(q);
    } else {
      buckets.active.push(q);
    }
  });

  // ── Tab bar ──────────────────────────────────────────
  const counts = {
    active:    buckets.active.length,
    completed: buckets.completed.length,
    closed:    buckets.closed.length,
  };
  const tabBar = document.createElement('div');
  tabBar.className = 'sq-tab-bar';
  ['active','completed','closed'].forEach(tab => {
    const btn = document.createElement('button');
    btn.className = `sq-tab${window._sqActiveTab === tab ? ' sq-tab--on' : ''}`;
    btn.dataset.tab = tab;
    btn.innerHTML = `${tab.charAt(0).toUpperCase()+tab.slice(1)} <span class="sq-tab-count">${counts[tab]}</span>`;
    btn.onclick = () => { window._sqActiveTab = tab; _renderStoryQuests(); };
    tabBar.appendChild(btn);
  });
  container.appendChild(tabBar);

  // ── Quest list for current tab ───────────────────────
  const list = buckets[window._sqActiveTab];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'story-quest-empty';
    const labels = { active: 'No active story quests.', completed: 'No completed quests yet.', closed: 'No closed quests.' };
    empty.textContent = labels[window._sqActiveTab];
    container.appendChild(empty);
    return;
  }

  list.forEach(q => {
    const sp      = window._storyProgress[q.id] || { count: 0, done: false, locations: new Set() };
    const prog    = q.type === "locations" ? (sp.locations instanceof Set ? sp.locations.size : sp.count) : sp.count;
    const done    = sp.done;
    const isExpired = q.expiresAt && q.expiresAt.getTime() < now;
    const isClosed  = q.status === 'closed' || isExpired;
    const pct     = Math.min(100, Math.round((prog / q.target) * 100));
    const isDismissed = window._dismissedStoryQuests.has(q.id);
    if (isDismissed) return; // player deleted it from their view

    // Build expiry label
    let expiryHtml = '';
    if (q.expiresAt) {
      if (isClosed) {
        expiryHtml = `<span class="sq-expiry sq-expiry--expired">⏱ Expired ${q.expiresAt.toLocaleString()}</span>`;
      } else {
        expiryHtml = `<span class="sq-expiry">⏱ Expires ${q.expiresAt.toLocaleString()}</span>`;
      }
    }

    const descHtml = (q.desc||"").split(/\n+/).map(p => p ? `<p style='margin:0 0 8px 0'>${p}</p>` : '').join('');

    // Delete button — only for completed and closed tabs
    const canDelete = done || isClosed;
    const deleteBtn = canDelete
      ? `<button class="sq-delete-btn" title="Dismiss from your view" onclick="event.stopPropagation();window._dismissStoryQuest('${q.id}')">✕ Dismiss</button>`
      : '';

    // Status badge
    let badge = '';
    if (done)           badge = `<span class="sq-badge sq-badge--completed">✓ Completed</span>`;
    else if (q.lockedOut) badge = `<span class="sq-badge sq-badge--closed">🔒 Claimed</span>`;
    else if (isClosed)    badge = `<span class="sq-badge sq-badge--closed">✕ Closed</span>`;
    else                  badge = `<span class="sq-badge sq-badge--active">● Active</span>`;

    const el = document.createElement('div');
    el.className = `story-quest-item sq-item${done ? ' sq-item--completed' : isClosed ? ' sq-item--closed' : ''}`;
    el.dataset.questId = q.id;

    el.innerHTML = `
      <div class="sq-header" onclick="window._toggleSqItem(this)">
        <div class="sq-header-left">
          ${badge}
          <span class="sq-title">${q.title}</span>
        </div>
        <div class="sq-header-right">
          ${deleteBtn}
          <span class="sq-chevron">▾</span>
        </div>
      </div>
      <div class="sq-body" style="display:none">
        <div class="dq-desc">${descHtml}</div>
        ${q.objectives && q.objectives.length ? `
        <ul class="sq-objectives">
          ${q.objectives.map(obj => `<li class="sq-objective-item">📌 ${obj}</li>`).join('')}
        </ul>` : ''}
        ${expiryHtml}
        ${q.lockedOut ? `<div class="sq-closed-note">🔒 This quest has already been claimed by another player.</div>` : !isClosed ? (() => {
          const sub = window._questSubmissions?.[q.id];
          if (done) {
            return `<div class="dq-progress" style="color:var(--gold)">✓ Complete — Reward claimed</div>`;
          } else if (sub === 'approved') {
            return `<div class="dq-progress" style="color:var(--gold)">✓ Approved by deity</div>`;
          } else if (sub === 'pending') {
            return `<div class="sq-pending-note">⏳ Awaiting deity approval…</div>`;
          } else if (sub === 'rejected') {
            return `<div class="sq-rejected-note">✕ Submission rejected — check your notifications for details.</div>
                    <button class="sq-submit-btn" onclick="event.stopPropagation();window._submitQuestForReview('${q.id}','${q.title.replace(/'/g,"\\'").replace(/"/g,'&quot;')}')">↩ Resubmit</button>`;
          } else {
            return `<button class="sq-submit-btn" onclick="event.stopPropagation();window._submitQuestForReview('${q.id}','${q.title.replace(/'/g,"\\'").replace(/"/g,'&quot;')}')">📜 Submit for Review</button>`;
          }
        })() : `<div class="sq-closed-note">This quest has closed. Tasks completed before closing are not rewarded.</div>`}
        <div class="dq-reward">↳ +${q.reward.xp} EXP · +${q.reward.gold} Coins${q.reward.item ? ` · ${q.reward.item.qty}× ${q.reward.item.name}` : ''}</div>
      </div>`;
    // Restore open state if this card was open before the re-render
    if (_openIds.has(q.id)) {
      const body = el.querySelector('.sq-body');
      const chevron = el.querySelector('.sq-chevron');
      if (body) body.style.display = 'block';
      if (chevron) chevron.textContent = '▴';
    }
    container.appendChild(el);
  });
}

// Toggle story quest accordion item
window._toggleSqItem = function(headerEl) {
  const body = headerEl.closest('.sq-item')?.querySelector('.sq-body');
  const chevron = headerEl.querySelector('.sq-chevron');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.textContent = isOpen ? '▾' : '▴';
};

// Dismiss a completed/closed quest from the player's view
window._dismissStoryQuest = function(questId) {
  window._dismissedStoryQuests.add(questId);
  try { localStorage.setItem('dismissedStoryQuests', JSON.stringify([...window._dismissedStoryQuests])); } catch(e) {}
  _renderStoryQuests();
};

// ── Quest submission state: questId → 'pending' | 'approved' | 'rejected' ──
if (!window._questSubmissions) window._questSubmissions = {};
let _questSubUnsub = null; // unsubscribe handle — prevents stacked listeners

window._loadQuestSubmissions = async function() {
  if (!_uid) return;
  // Tear down any existing listener before registering a new one
  if (_questSubUnsub) { _questSubUnsub(); _questSubUnsub = null; }
  try {
    const q = query(collection(db, 'questSubmissions'), where('uid', '==', _uid));
    // Initial load
    const snap = await getDocs(q);
    window._questSubmissions = {};
    snap.forEach(d => {
      const data = d.data();
      window._questSubmissions[data.questId] = data.status;
    });
    _renderStoryQuests();
    // Live listener for status changes (approval/rejection by deity)
    _questSubUnsub = onSnapshot(q, snap => {
      window._questSubmissions = {};
      snap.forEach(d => {
        const data = d.data();
        window._questSubmissions[data.questId] = data.status;
        // Guard uses BOTH:
        // Guard uses BOTH:
        // 1. data.rewarded — persisted on the submission doc; survives reloads
        // 2. _storyQuestDone[questId] — in-memory flag for same-session double-fire
        //    (intentionally NOT persisted — data.rewarded handles reload safety)
        if (data.status === 'approved' && !data.rewarded && !window._storyQuestDone[data.questId]) {
          const quest = STORY_QUESTS.find(sq => sq.id === data.questId);
          if (quest) {
            // Await the flag write — only apply reward if it succeeds.
            // If it fails (network/rules), we skip this cycle; the next
            // listener fire will retry cleanly with no duplicate risk.
            updateDoc(d.ref, { rewarded: true })
              .then(() => {
                window._storyQuestDone[data.questId] = true;
                _completeStoryQuest(quest);
              })
              .catch(e => console.warn('[Quest] Could not mark rewarded, skipping reward this cycle:', e));
          }
        }
      });
      _renderStoryQuests();
    });
  } catch(e) { console.error('Failed to load quest submissions:', e); }
};

window._submitQuestForReview = async function(questId, questTitle) {
  if (!_uid || !_charData) return;
  // ── Dead player restriction ───────────────────────────────────────────────
  if (_charData.isDead) {
    window.showToast("☠️ You are dead. You cannot submit quests.", "error"); return;
  }
  const existing = window._questSubmissions[questId];
  if (existing === 'pending')   return window.showToast('Already submitted — awaiting approval.', 'info');
  if (existing === 'approved')  return window.showToast('Already approved!', 'info');

  // Show structured submission modal
  document.getElementById('sq-submit-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'sq-submit-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
  modal.innerHTML = `
    <div style="background:var(--ink2);border-radius:14px;border:1px solid var(--border);max-width:480px;width:100%;padding:24px;box-shadow:0 8px 40px #0008;max-height:90vh;overflow-y:auto">
      <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--gold-dim);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Submit for Review</div>
      <div style="font-weight:700;font-size:1.05rem;color:var(--gold);margin-bottom:16px">${questTitle}</div>

      <div style="margin-bottom:12px">
        <label style="font-size:0.78rem;font-family:var(--font-mono);color:var(--text-dim);letter-spacing:0.05em;display:block;margin-bottom:5px">📍 WHERE did you complete this?</label>
        <input id="sq-proof-location" type="text" placeholder="e.g. Whitecrest Village" maxlength="80"
          style="width:100%;box-sizing:border-box;background:var(--ink3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-light);font-size:0.9rem;outline:none">
      </div>

      <div style="margin-bottom:12px">
        <label style="font-size:0.78rem;font-family:var(--font-mono);color:var(--text-dim);letter-spacing:0.05em;display:block;margin-bottom:5px">⚔️ WHAT did you do? (be specific)</label>
        <textarea id="sq-proof-what" rows="3" maxlength="400" placeholder="e.g. Traveled to Whitecrest at dusk, fought 4 Blood Wolves near the shrine..."
          style="width:100%;box-sizing:border-box;background:var(--ink3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-light);font-size:0.9rem;outline:none;resize:vertical;font-family:inherit"></textarea>
      </div>

      <div style="margin-bottom:16px">
        <label style="font-size:0.78rem;font-family:var(--font-mono);color:var(--text-dim);letter-spacing:0.05em;display:block;margin-bottom:5px">👥 WITNESSES (optional, other player names)</label>
        <input id="sq-proof-witnesses" type="text" placeholder="e.g. PlayerA, PlayerB" maxlength="120"
          style="width:100%;box-sizing:border-box;background:var(--ink3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-light);font-size:0.9rem;outline:none">
      </div>

      <div id="sq-submit-error" style="color:#c08080;font-size:0.82rem;margin-bottom:10px;display:none"></div>
      <div style="display:flex;gap:10px">
        <button id="sq-submit-confirm" class="sq-submit-btn" style="margin-top:0;flex:1">📜 Submit</button>
        <button onclick="document.getElementById('sq-submit-modal').remove()"
          style="flex:0 0 auto;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-dim);font-family:var(--font-mono);font-size:0.8rem;padding:8px 16px;cursor:pointer">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  document.getElementById('sq-submit-confirm').onclick = async () => {
    const location = document.getElementById('sq-proof-location').value.trim();
    const what     = document.getElementById('sq-proof-what').value.trim();
    const witnesses = document.getElementById('sq-proof-witnesses').value.trim();
    const errEl    = document.getElementById('sq-submit-error');

    if (!location) { errEl.textContent = 'Please fill in where you completed this.'; errEl.style.display='block'; return; }
    if (!what)     { errEl.textContent = 'Please describe what you did.'; errEl.style.display='block'; return; }
    errEl.style.display = 'none';

    const btn = document.getElementById('sq-submit-confirm');
    btn.disabled = true; btn.textContent = 'Submitting…';

    try {
      // Fetch last 20 activity events for auto-snapshot
      let activitySnapshot = [];
      try {
        const actSnap = await getDocs(query(
          collection(db, 'activity', _uid, 'events'),
          orderBy('timestamp', 'desc'),
          limit(20)
        ));
        actSnap.forEach(d => {
          const ev = d.data();
          const ts = ev.timestamp?.toDate?.()?.toLocaleString() || '';
          // Strip HTML tags for clean text
          const msg = (ev.message || '').replace(/<[^>]+>/g, '');
          activitySnapshot.push(`${ev.icon || ''} ${msg} — ${ts}`);
        });
      } catch(e) { console.warn('Could not fetch activity snapshot:', e); }

      const proof = { location, what, witnesses: witnesses || null };

      // ── One-time race-condition guard ─────────────────────────────────────
      // Before writing, check if ANY other player already has a pending or
      // approved submission for this quest. If so, the slot is already taken.
      const _sqLocal = STORY_QUESTS.find(q => q.id === questId);
      if (_sqLocal?.completionType === 'one_time') {
        const rivalSnap = await getDocs(query(
          collection(db, 'questSubmissions'),
          where('questId', '==', questId),
          where('status', 'in', ['pending', 'approved'])
        ));
        const rivalTaken = rivalSnap.docs.some(d => d.data().uid !== _uid);
        if (rivalTaken) {
          btn.disabled = false; btn.textContent = '📜 Submit';
          errEl.textContent = '🔒 This quest was just claimed by another player.';
          errEl.style.display = 'block';
          // Mark lockedOut in the local STORY_QUESTS entry so the card closes on next render
          _sqLocal.lockedOut = true;
          _sqLocal.status = 'closed';
          _renderStoryQuests();
          modal.remove();
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      const existingQ = query(
        collection(db, 'questSubmissions'),
        where('uid', '==', _uid),
        where('questId', '==', questId)
      );
      const existingSnap = await getDocs(existingQ);
      if (!existingSnap.empty) {
        await updateDoc(doc(db, 'questSubmissions', existingSnap.docs[0].id), {
          status: 'pending',
          submittedAt: serverTimestamp(),
          proof,
          activitySnapshot,
        });
      } else {
        await addDoc(collection(db, 'questSubmissions'), {
          questId,
          questTitle,
          uid: _uid,
          playerName: _charData.name || '?',
          playerRank:  _charData.rank  || 'Wanderer',
          submittedAt: serverTimestamp(),
          status: 'pending',
          proof,
          activitySnapshot,
        });
      }
      window._questSubmissions[questId] = 'pending';
      modal.remove();
      _renderStoryQuests();
      window.showToast('📜 Submission sent — awaiting deity review.', 'success');
      logActivity('📜', `<b>Quest Submitted:</b> <b>${questTitle}</b> sent for deity review.`, '#c9a84c');
    } catch(e) {
      console.error('Quest submission failed:', e);
      btn.disabled = false; btn.textContent = '📜 Submit';
      errEl.textContent = 'Failed to submit. Try again.'; errEl.style.display='block';
    }
  };
};

// ── Progress incrementor ──
async function _incrementQuest(type, value = 1) {
  if (!_uid) return;
  if (_charData?.isDead) return; // ── Dead player restriction ──
  if (type === "kill")    { window._questProgress.hunter = (_questProgress.hunter||0) + value; await _checkDailyCompletion("hunter"); }
  if (type === "eliteKill") { window._questProgress.elite = (_questProgress.elite||0) + value; await _checkDailyCompletion("elite"); }
  if (type === "gather")  { window._questProgress.gatherer = (_questProgress.gatherer||0) + value; await _checkDailyCompletion("gatherer"); }
  if (type === "listing") { window._questProgress.market = (_questProgress.market||0) + value; await _checkDailyCompletion("market"); }
  if (type === "potion")  { window._questProgress.potions = (_questProgress.potions||0) + value; await _checkDailyCompletion("potions"); }
  if (type === "food")    { window._questProgress.food = (_questProgress.food||0) + value; await _checkDailyCompletion("food"); }
  if (type === "location") {
    if (!(_questProgress.explorer instanceof Set)) _questProgress.explorer = new Set();
    _questProgress.explorer.add(value);
    await _checkDailyCompletion("explorer");
  }
  for (const q of STORY_QUESTS) {
    const sp = window._storyProgress[q.id] || { count:0, done:false, locations: new Set() };
    if (sp.done) continue;
    let progressed = false;
    if (q.type === "kills"      && type === "kill")      { sp.count += value; progressed = true; }
    if (q.type === "eliteKills" && type === "eliteKill") { sp.count += value; progressed = true; }
    if (q.type === "gathers"    && type === "gather")    { sp.count += value; progressed = true; }
    if (q.type === "listings"   && type === "listing")   { sp.count += value; progressed = true; }
    if (q.type === "locations"  && type === "location")  {
      if (!sp.locations) sp.locations = new Set();
      sp.locations.add(value); sp.count = sp.locations.size; progressed = true;
    }
    if (progressed) {
      window._storyProgress[q.id] = sp;
      if (sp.count >= q.target) await _completeStoryQuest(q);
    }
  }
  _renderQuestProgress();
  _renderStoryQuests();
  await _saveAllQuestProgress();
}

async function _checkDailyCompletion(id) {
  if (window._completedQuests.has(id)) return;
  const q    = DAILY_QUESTS[id];
  const prog = _getDailyProgress(id);
  if (prog < q.target) return;
  window._completedQuests.add(id);
  await _applyReward(q.reward.xp, q.reward.gold, q.reward.item);
  window.showToast(`✅ Quest complete: ${q.label}! +${q.reward.gold} gold · +${q.reward.xp} EXP`, "success");
  logActivity('📋', `<b>Daily Quest Complete:</b> ${q.label}. +${q.reward.gold}💰 +${q.reward.xp} EXP`, '#70c090');
  if (window._completedQuests.size === 7 && !window._bonusClaimed) {
    window._bonusClaimed = true;
    await _applyReward(0, DAILY_BONUS.gold, null);
    window.showToast("🎉 All daily quests complete! +200 bonus gold!", "success");
    logActivity('🏆', '<b>All Daily Quests Complete!</b> +200 bonus gold claimed.', '#c9a84c');
  }
  document.getElementById("quest-bonus-bar")?.classList.toggle("achieved", window._completedQuests.size === 7);
  document.getElementById("quest-completed-all")?.classList.toggle("show",  window._completedQuests.size === 7);
}

async function _completeStoryQuest(q) {
  if (!window._storyProgress[q.id]) window._storyProgress[q.id] = { count: 0, done: false, locations: new Set() };
  // done is tracked separately in _storyQuestDone (set by the caller after rewarded:true is written)
  // and is intentionally NOT persisted — data.rewarded on the submission doc is the reload-safe guard
  await _applyReward(q.reward.xp, q.reward.gold, q.reward.item);
  // Log completion in Firestore for deity log
  try {
    await updateDoc(doc(db, "storyQuests", q.id), {
      completedBy: arrayUnion({
        uid: _uid,
        playerName: _charData?.name || "?",
        completedAt: new Date()
      })
    });
  } catch (e) {
    console.warn("[QuestLog] Failed to update story quest completion log:", e);
  }
  window.showToast(`📖 Story Quest complete: ${q.title}! +${q.reward.gold} gold · +${q.reward.xp} EXP`, "success");
  logActivity('📖', `<b>Story Quest Complete:</b> ${q.title}. +${q.reward.gold}💰 +${q.reward.xp} EXP`, '#c9a84c');
}

// Patch: Faction quest completion log
window.logFactionQuestCompletion = async function(questId) {
  try {
    await updateDoc(doc(db, "factionMissions", questId), {
      completedBy: arrayUnion({
        uid: _uid,
        playerName: _charData?.name || "?",
        completedAt: new Date()
      })
    });
  } catch (e) {
    console.warn("[QuestLog] Failed to update faction quest completion log:", e);
  }
}

async function _applyReward(xp, gold, item) {
  // FIXED: Was a raw updateDoc reading from stale _charData — raced with any
  // concurrent write (auto-battle, bestow, trade) and silently dropped changes.
  // Now uses a transaction so inventory and gold are always merged from the
  // server-side doc, never from a potentially-stale local snapshot.
  if (!_charData || !_uid) return;
  let leveledUp = false, newLevel, newRank;
  const charRef = doc(db, 'characters', _uid);
  await runTransaction(db, async tx => {
    const snap = await tx.get(charRef);
    if (!snap.exists()) throw new Error('Character not found');
    const fresh = snap.data();
    const inv = [...(fresh.inventory || [])];
    if (item) {
      const ex = inv.find(i => i.name === item.name);
      const _isEquip = getItemType(item.name) === 'equipment';
      if (ex && !_isEquip) { ex.qty += (item.qty || 1); }
      else { const _ni = {...item}; if (_isEquip) _ni.iid = Math.random().toString(36).slice(2,10)+Date.now().toString(36); inv.push(_ni); }
    }
    const res = _processExp(fresh.xp||0, fresh.xpMax||100, fresh.level||1, fresh.rank||'Wanderer', xp, fresh.charClass);
    leveledUp = res.leveledUp; newLevel = res.newLevel; newRank = res.newRank;
    const updates = {
      // Use increment() for gold so two concurrent +gold rewards both land
      gold: increment(gold),
      inventory: inv,
      xp: res.newXp, xpMax: res.newXpMax, level: res.newLevel, rank: res.newRank,
    };
    if (res.leveledUp) {
      updates.statPoints = increment(3);
      updates.hpMax  = (fresh.hpMax  || 100) + 10;
      updates.manaMax = (fresh.manaMax || 50)  + 5;
    }
    tx.update(charRef, updates);
  });
  // Refresh local cache from server so subsequent reads are consistent
  await refreshCharData();
  window._allInvItems = _charData.inventory || [];
  _syncAllDisplays(_charData);
  if (leveledUp) {
    window.showToast(`🎉 LEVEL UP! Now Level ${newLevel}!`, 'success');
    logActivity('⬆️', `<b>Level Up!</b> You reached <b>Level ${newLevel}</b>.`, '#e8d070');
    if (newRank !== (_charData.rank || 'Wanderer')) {
      logActivity('👑', `<b>Rank Ascension!</b> You are now <b>${newRank}</b>.`, '#c9a84c');
    }
  }
}

// Multi-item reward variant — delivers every item in the items array
async function _applyRewardMulti(xp, gold, items) {
  // FIXED: Same race-condition fix as _applyReward — use a transaction and
  // increment() for gold instead of a stale read-modify-write.
  if (!_charData || !_uid) return;
  let leveledUp = false, newLevel, newRank;
  const charRef = doc(db, 'characters', _uid);
  await runTransaction(db, async tx => {
    const snap = await tx.get(charRef);
    if (!snap.exists()) throw new Error('Character not found');
    const fresh = snap.data();
    const inv = [...(fresh.inventory || [])];
    for (const item of (items || [])) {
      if (!item || !item.name) continue;
      const ex = inv.find(i => i.name === item.name);
      const _isEquip = getItemType(item.name) === 'equipment';
      if (ex && !_isEquip) { ex.qty += (item.qty || 1); }
      else { const _ni = {...item}; if (_isEquip) _ni.iid = Math.random().toString(36).slice(2,10)+Date.now().toString(36); inv.push(_ni); }
    }
    const res = _processExp(fresh.xp||0, fresh.xpMax||100, fresh.level||1, fresh.rank||'Wanderer', xp, fresh.charClass);
    leveledUp = res.leveledUp; newLevel = res.newLevel; newRank = res.newRank;
    const updates = {
      gold: increment(gold),
      inventory: inv,
      xp: res.newXp, xpMax: res.newXpMax, level: res.newLevel, rank: res.newRank,
    };
    if (res.leveledUp) {
      updates.statPoints = increment(3);
      updates.hpMax  = (fresh.hpMax  || 100) + 10;
      updates.manaMax = (fresh.manaMax || 50)  + 5;
    }
    tx.update(charRef, updates);
  });
  await refreshCharData();
  window._allInvItems = _charData.inventory || [];
  _syncAllDisplays(_charData);
  if (leveledUp) {
    window.showToast(`🎉 LEVEL UP! Now Level ${newLevel}!`, 'success');
    logActivity('⬆️', `<b>Level Up!</b> You reached <b>Level ${newLevel}</b>.`, '#e8d070');
  }
}

async function loadQuestProgress() {
  try {
    const snap  = await getDoc(doc(db,"dailyQuests",_uid));
    const today = new Date().toDateString();
    if (!snap.exists() || snap.data().date !== today) {
      window._questProgress   = { explorer: new Set() };
      window._completedQuests = new Set();
      window._bonusClaimed    = false;
      if (snap.exists() && snap.data().storyProgress) _restoreStoryProgress(snap.data().storyProgress);
      else STORY_QUESTS.forEach(q => { window._storyProgress[q.id] = { count:0, done:false, locations:new Set() }; });
      await setDoc(doc(db,"dailyQuests",_uid),{ date:today, completed:[], progress:{}, bonusClaimed:false, storyProgress: snap.exists()?(snap.data().storyProgress||{}):{} });
      _renderQuestProgress(); _renderStoryQuests(); return;
    }
    const data = snap.data();
    const prog = data.progress || {};
    window._questProgress = {
      hunter:prog.hunter||0, gatherer:prog.gatherer||0, market:prog.market||0,
      potions:prog.potions||0, food:prog.food||0, explorer:new Set(prog.explorer||[]), elite:prog.elite||0,
    };
    window._bonusClaimed = data.bonusClaimed || false;
    (data.completed||[]).forEach(id => window._completedQuests.add(id));
    _restoreStoryProgress(data.storyProgress||{});
    const all = window._completedQuests.size === 7;
    document.getElementById("quest-bonus-bar")?.classList.toggle("achieved", all);
    document.getElementById("quest-completed-all")?.classList.toggle("show", all);
    _renderQuestProgress(); _renderStoryQuests();
  } catch(err) { console.error("Quest load error:", err); }
}

function _restoreStoryProgress(saved) {
  window._storyProgress = {};
  STORY_QUESTS.forEach(q => {
    const s = saved[q.id] || {};
    window._storyProgress[q.id] = { count:s.count||0, done:false, locations:new Set(s.locations||[]) }; // done always starts false — _storyQuestDone handles session guard
  });
}

async function _saveAllQuestProgress() {
  try {
    const prog = {
      hunter:_questProgress.hunter||0, gatherer:_questProgress.gatherer||0, market:_questProgress.market||0,
      potions:_questProgress.potions||0, food:_questProgress.food||0,
      explorer:[...(_questProgress.explorer instanceof Set?_questProgress.explorer:[])], elite:_questProgress.elite||0,
    };
    const storyProgress = {};
    STORY_QUESTS.forEach(q => {
      const sp = window._storyProgress[q.id]||{};
      storyProgress[q.id] = { count:sp.count||0, locations:[...(sp.locations instanceof Set?sp.locations:[])] }; // done intentionally not persisted
    });
    await setDoc(doc(db,"dailyQuests",_uid),{ date:new Date().toDateString(), completed:[...window._completedQuests], bonusClaimed:window._bonusClaimed, progress:prog, storyProgress },{ merge:true });
  } catch(err) { console.error("Quest save error:", err); }
}


// ═══════════════════════════════════════════════════
//  PROFESSION GATHER SYSTEM
// ═══════════════════════════════════════════════════

const PROF_RESOURCES = {
  Miner:     {
    common:    ["Iron","Copper","Tin","Limestone","Coal"],
    uncommon:  ["Silver","Bronze","Obsidian","Marble","Quartz"],
    rare:      ["Gold","Mythril","Palladium"],
    legendary: ["Titanium","Adamantium"],
    mythic:    ["Aetherium"],
  },
  Forager:   {
    common:    ["Blueberries","Apples","Garlic","Mushroom","Melons"],
    uncommon:  ["Golden Pears","Moon Grapes","Sunfruit","Crystal Berries","Bitter Root"],
    rare:      ["Spirit Plum","Frost Apples","Ember Fruit"],
    legendary: ["Celestial Fig","Dragonfruit"],
    mythic:    ["Eden's Tear"],
  },
  Herbalist: {
    common:    ["Mint Leaves","Basil Sprigs","Wild Herbs","Soft Bark","Wood"],
    uncommon:  ["Silverleaf","Goldroot","Nightshade","Glowleaf","Lotus"],
    rare:      ["Spirit Herb","Jade Vine","Ghost Root"],
    legendary: ["Phoenix Bloom","Middlemist"],
    mythic:    ["Void Orchid"],
  },
  Angler:    {
    common:    ["Trout","Carp","Catfish","Sardine","Pufferfish"],
    uncommon:  ["Silverfin","Glowfish","Spotted Eel","Coral Snapper","Red Minnow"],
    rare:      ["Shadowfish","Flamefish","Ying Koi"],
    legendary: ["Celestial Whale","Black Unagi"],
    mythic:    ["Cosmic Leviathan"],
  },
  Hunter:    {
    common:    ["Raw Meat","Tough Hide","Bone Fragments","Feathers","Animal Fat"],
    uncommon:  ["Leather","Fangs","Fur","Horns","Claws"],
    rare:      ["Spirit Venison","Shadow Hide","Drake Meat"],
    legendary: ["Cyclops Eye","Dragon Scales"],
    mythic:    ["Titan Heart"],
  },
};

const PROF_VERBS = {
  Miner: "mining", Forager: "foraging", Herbalist: "gathering herbs",
  Angler: "fishing", Hunter: "hunting",
};

const PROF_ACTION = {
  Miner: "⛏️ MINE", Forager: "🌿 FORAGE", Herbalist: "🌱 GATHER",
  Angler: "🎣 FISH", Hunter: "🏹 HUNT",
};

// Update the gather button label based on profession
function updateGatherBtn(profession) {
  const btn = document.getElementById("btn-gather");
  if (btn) btn.textContent = PROF_ACTION[profession] || "⛏️ GATHER";
}

window._doGather = async function() {
  // ── Dead player restriction ───────────────────────────────────────────────
  if (_charData?.isDead) {
    window.showToast("☠️ You are dead. You cannot gather resources.", "error"); return;
  }
  if (!_charData?.profession) {
    window.showToast("Choose a profession first.", "error"); return;
  }
  const prof = _charData.profession;
  const resources = PROF_RESOURCES[prof];
  if (!resources) return;

  // ── Location check: must be at a resource or deity zone ──────────────────
  const loc = (_charData.kingdom||_charData.location||"").toLowerCase();

  const PROF_ZONES = {
    Miner:     ["hobbit_cave","suldan_mine","argent_grotto","shiny_cavern","hobbit cave","suldan mine","argent grotto","shiny cavern"],
    Angler:    ["silver_lake","dream_river","moss_stream","golden_river","silver lake","dream river","moss stream","golden river"],
    Forager:   ["wisteria","arctic_willow","arctic_willow_west","asahi","wisteria forest","arctic willow","asahi valley"],
    Herbalist: ["wisteria","arctic_willow","arctic_willow_west","asahi","wisteria forest","arctic willow","asahi valley"],
    Hunter:    ["wisteria","asahi","wisteria forest","asahi valley"],
  };
  const validZones = PROF_ZONES[prof] || [];
  const isAtResourceZone = validZones.some(z => loc.includes(z));

  if (!isAtResourceZone) {
    window.showToast(`Travel to a ${prof} resource zone on the World Map before gathering.`, "error");
    return;
  }

  const btn    = document.getElementById("btn-gather");
  const logEl  = document.getElementById("gather-log");
  if (!btn||!logEl) return;

  btn.disabled = true;
  btn.textContent = "Working...";
  logEl.style.display = "block";
  logEl.innerHTML = `<div class="gather-log-entry working">🔄 You are ${PROF_VERBS[prof]}...</div>`;

  // Simulate 2 second gather
  await new Promise(r => setTimeout(r, 2000));

  try {
    const lvl   = _charData.professionLvl || 0;
    // Use the canonical FIND_RATES table defined in the spec constants above
    const rates = FIND_RATES[Math.min(lvl, 10)];

    let found = null;
    const logLines = [];

    // Normal gather — always returns a profession item
    const _luckM = _getLuckMult(_charData);
    const _raceR2 = (_charData?.race || '').toLowerCase();
    const _raceLk2 = (_raceR2.includes('fairy') || _raceR2.includes('spirit')) ? 1.10 : 1;
    const _trackit = (_charData?.companion?.name || '').toLowerCase() === 'trackit' ? 1.10 : 1;
    const _totalLuck = _luckM * _raceLk2 * _trackit;
    // Bias the roll: higher luck shifts roll toward 0 (rare end)
    const _rawRoll = Math.random() * 100;
    const roll = Math.max(0, _rawRoll / _totalLuck);
    let cumulative = 0;
    let rarity = "common";
    for (const [r, pct] of Object.entries(rates)) {
      cumulative += pct;
      if (roll < cumulative) { rarity = r; break; }
    }
    const pool = resources[rarity] || resources.common;
    found = pool[Math.floor(Math.random()*pool.length)];

    const rarityColors = { common:"#aaa", uncommon:"#70c090", rare:"#5b9fe0", legendary:"#c9a84c", mythic:"#d070e0" };
    const col = rarityColors[rarity]||"#aaa";

    // Chance of finding 2+ items based on level (matches Profession EXP Bar spec)
    // Lv0-1: 0%, Lv2: 5%, Lv3: 10%, Lv4: 30%, Lv5: 50%, Lv6-10: 100%
    let count = 1;
    const doubleChance = [0,0,5,10,30,50,100,100,100,100,100][Math.min(lvl,10)];
    // Triple only possible at Lv6+: 3%, 5%, 10%, 30%, 30%
    const tripleChance = [0,0,0,0,0,0,3,5,10,30,30][Math.min(lvl,10)];
    if (Math.random()*100 < tripleChance) count = 3;
    else if (Math.random()*100 < doubleChance) count = 2;

    logLines.push(`<div class="gather-log-entry success">✅ You found <strong style="color:${col}">x${count} ${found}</strong>! <span style="font-size:10px;color:${col};text-transform:uppercase;">(${rarity})</span></div>`);

    // Add to inventory — mutator works on live server data
    const foundItem = found;
    const foundCount = count;
    const isEquip = getItemType(found) === 'equipment';
    // Pre-generate iid for equipment outside the mutator (random, idempotent)
    const newIid = isEquip ? (Math.random().toString(36).slice(2,10)+Date.now().toString(36)) : null;
    // Optimistic local update so HUD refreshes immediately
    const invLocal = [...(_charData.inventory||[])];
    const exLocal = invLocal.find(i=>i.name===foundItem);
    if (exLocal && !isEquip) { exLocal.qty += foundCount; }
    else { const _ni={name:foundItem,qty:foundCount,type:isEquip?'equipment':getItemType(foundItem)}; if(isEquip) _ni.iid=newIid; invLocal.push(_ni); }
    _charData.inventory = invLocal;
    window._allInvItems = invLocal;
    window._refreshInvDisplay();

    // Profession XP per resource rarity (spec: Common 10, Uncommon 25, Rare 60, Legendary 150, Mythic 500)
    // Multiply by count — finding 3x items gives 3x XP
    const xpGain = { common:10, uncommon:25, rare:60, legendary:150, mythic:500 }[rarity]||10;
    // Veil blessing: +X% EXP from all activities including gathering
    const _veilGatherBonus = _charData?.deity === 'Veil' ? (1 + _getFaithBlessingPct(_charData)) : 1;
    const xpGainFinal = Math.round(xpGain * count * _veilGatherBonus);
    let newProfXp  = (_charData.professionXp||0) + xpGainFinal;
    let newProfLvl = lvl;
    let leveledProf = false;
    // Use a while loop so overflow XP carries forward and multi-level gains are handled
    while (newProfLvl < 10) {
      const xpNeeded = PROF_EXP_TABLE[newProfLvl]; // index = current level, 0-9
      if (xpNeeded == null) break; // safety: beyond table
      if (newProfXp >= xpNeeded) {
        newProfXp -= xpNeeded; // subtract threshold so XP resets cleanly
        newProfLvl++;
        leveledProf = true;
      } else {
        break;
      }
    }
    // Cap XP at 0 if somehow at max level
    if (newProfLvl >= 10) newProfXp = 0;

    // ── OPTIMISTIC UI UPDATE ──
    // Patch _charData and render the XP bar immediately so the player sees
    // feedback right away. A guard flag tells _syncAllDisplays to skip the
    // profession bar while the Firestore write is in-flight, preventing the
    // "jump → revert → jump" flicker. Once _invWrite resolves, the flag clears
    // and the next refreshCharData re-renders from confirmed server data.
    _charData.professionXp  = newProfXp;
    _charData.professionLvl = newProfLvl;
    window._gatherWritePending = true;
    showActiveProfession(_charData);

      // ── PET GROWTH SYSTEM ──
      // Updated Companion EXP/level curve
      // Applies to ALL professions
      const COMPANION_EXP_TABLE = [0, 1000, 1800, 3000, 4200, 5700, 7000, 9600, 12000, 15000];
      let companionExpGain = { common:10, uncommon:25, rare:60, legendary:150, mythic:500 }[rarity]||10;
      let companionLevel = _charData.companionLevel || 1;
      let companionExp   = _charData.companionExp   || 0;
      let companionXpMax = COMPANION_EXP_TABLE[companionLevel-1] || 1000;
      let companionLeveledUp = false;
      // Award companion EXP for any profession gather
      if (_charData.companion) {
        console.log('[PET GROWTH DEBUG] Before:', {companion: _charData.companion, companionLevel, companionExp, companionExpGain, count, rarity});
        companionExp += companionExpGain * count;
        // Level up companion if enough EXP
        while (companionLevel < 10 && companionExp >= companionXpMax) {
          companionExp -= companionXpMax;
          companionLevel++;
          companionXpMax = COMPANION_EXP_TABLE[companionLevel-1] || companionXpMax;
          companionLeveledUp = true;
        }
        console.log('[PET GROWTH DEBUG] After:', {companion: _charData.companion, companionLevel, companionExp, companionExpGain, count, rarity});
      } else {
        console.warn('[PET GROWTH DEBUG] No companion assigned to character.');
      }

      // Save all updates — mutator adds gathered item to live server inventory
      const updates = {
        professionXp: newProfXp,
        professionLvl: newProfLvl
      };
      if (_charData.companion) {
        updates.companionExp = companionExp;
        updates.companionLevel = companionLevel;
      }
      await _invWrite(_uid, inv => {
        const ex = inv.find(i => i.name === foundItem);
        if (ex && !isEquip) { ex.qty += foundCount; }
        else { const _ni={name:foundItem,qty:foundCount,type:isEquip?'equipment':getItemType(foundItem)}; if(isEquip) _ni.iid=newIid; inv.push(_ni); }
      }, updates);
      // Write confirmed — clear the guard so future refreshCharData calls
      // can freely re-render the profession bar from server data
      window._gatherWritePending = false;
      // _invWrite calls refreshCharData() — inventory display syncs from server
      window._allInvItems = _charData.inventory;
      window._refreshInvDisplay();
      // Force companion UI refresh after EXP update
      if (_charData.companion) {
        const COMPANION_EXP_TABLE = [0, 1000, 1800, 3000, 4200, 5700, 7000, 9600, 12000, 15000];
        const compLevel = _charData.companionLevel || 1;
        const compExp = _charData.companionExp || 0;
        const compXpMax = COMPANION_EXP_TABLE[compLevel-1] || 1000;
        const el = document.getElementById("prof-companion");
        if (el) el.textContent = `${_charData.companion} (Lv.${compLevel} — ${compExp}/${compXpMax} EXP)`;
      }
      if (leveledProf) {
        logLines.push(`<div class="gather-log-entry success">🎉 Profession leveled up to Level ${newProfLvl}!</div>`);
        window.showToast(`Profession level up! Now Level ${newProfLvl}!`, "success");
        logActivity('💪', `<b>Profession Level Up!</b> ${_charData.profession} is now <b>Level ${newProfLvl}</b>.`, '#5b9fe0');
      }
      // Companion level up notification
      if (companionLeveledUp) {
        logLines.push(`<div class="gather-log-entry success">🐾 <b>Your companion leveled up!</b> Now Level ${companionLevel}!</div>`);
        window.showToast(`🐾 Companion leveled up! Now Level ${companionLevel}!`, "success");
        logActivity('🐾', `<b>Companion Level Up!</b> Now Level ${companionLevel}.`, '#70c090');
      }

      // Quest tracking
      await _incrementQuest("gather", count);
      logActivity(
        {Miner:'⛏️',Forager:'🌿',Herbalist:'🌱',Angler:'🎣',Hunter:'🏹'}[prof]||'🔍',
        `<b>${prof} Gathering</b> at <b>${_charData?.kingdom || _charData?.location || 'unknown location'}</b> · Found <b>${count}x ${found}</b> <span style="color:#aaa;font-size:0.85em">(${rarity})</span>.`,
        '#a09080'
      );
      if (Math.random() < 0.30) _rollGatherEvent(prof);

      logEl.innerHTML = logLines.join("");
    } catch(err) {
    console.error(err);
    logEl.innerHTML = `<div class="gather-log-entry empty">❌ Gather failed. Try again.</div>`;
  }

  // Restore label immediately so button doesn't stay on "Working..." while the
  // cooldown ticks. Button remains disabled for 3s to prevent spam.
  btn.textContent = PROF_ACTION[prof]||"⛏️ GATHER";
  setTimeout(() => {
    btn.disabled = false;
  }, 3000);
};

// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
//  NAME & BIO CHANGE
// ═══════════════════════════════════════════════════
window.toggleNameEdit = function() {
  const row  = document.getElementById("name-edit-row");
  const input = document.getElementById("new-name-input");
  const hint  = document.getElementById("name-change-hint");
  const showing = row.style.display !== "none";
  row.style.display = showing ? "none" : "block";
  if (!showing) {
    input.value = _charData?.name || "";
    input.focus();
    // Dynamic hint
    const hasChangedBefore = !!_charData?.lastNameChange;
    if (hint) {
      hint.textContent = hasChangedBefore
        ? "Costs 100 gold · 30-day cooldown applies"
        : "First change is free · 100 gold thereafter · 30-day cooldown";
    }
  }
  document.getElementById("name-change-error").textContent = "";
};

window.saveNameChange = async function() {
  const input    = document.getElementById("new-name-input");
  const errEl    = document.getElementById("name-change-error");
  const newName  = input?.value.trim();
  errEl.textContent = "";

  if (!newName)              { errEl.textContent = "Name cannot be empty.";          return; }
  if (newName.length < 2)    { errEl.textContent = "Name must be at least 2 characters."; return; }
  if (newName.length > 30)   { errEl.textContent = "Name cannot exceed 30 characters.";  return; }
  if (newName === _charData?.name) { window.toggleNameEdit(); return; } // no change

  const now            = Date.now();
  const lastChange     = _charData?.lastNameChange || 0;
  const cooldownMs     = 30 * 24 * 60 * 60 * 1000; // 30 days
  const hasChangedBefore = !!_charData?.lastNameChange;

  // Cooldown check
  if (hasChangedBefore && (now - lastChange) < cooldownMs) {
    const daysLeft = Math.ceil((cooldownMs - (now - lastChange)) / (24 * 60 * 60 * 1000));
    errEl.textContent = `Cooldown active — ${daysLeft} day(s) remaining.`;
    return;
  }

  // Gold check (first change free)
  const cost = hasChangedBefore ? 100 : 0;
  if ((_charData?.gold ?? 0) < cost) {
    errEl.textContent = `Not enough gold. You need 100 coins.`;
    return;
  }

  const btn = document.querySelector("#name-edit-row .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "SAVING..."; }

  try {
    const updates = { name: newName, lastNameChange: now };
    if (cost > 0) updates.gold = increment(-cost); // FIXED: use increment to avoid concurrent-write clobber
    await updateDoc(doc(db, "characters", _uid), updates);

    // Update local state
    _charData.name = newName;
    if (cost > 0) _charData.gold = Math.max(0, (_charData.gold || 0) - cost);
    _charData.lastNameChange = now;

    // Refresh displays
    _syncAllDisplays(_charData);
    window.toggleNameEdit();
    window.showToast(`Name changed to "${newName}"!`, "success");
  } catch(e) {
    console.error("[saveNameChange]", e);
    errEl.textContent = "Failed to save name. Try again.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "SAVE"; }
  }
};

window.openEquipModal = function(type) {
  const modal = document.getElementById('equip-modal');
  const list = document.getElementById('equip-modal-list');
  const title = document.getElementById('equip-modal-title');
  const btn = document.getElementById('btn-equip-confirm');
  const error = document.getElementById('equip-modal-error');
  let selected = null;
  error.textContent = '';
  btn.disabled = true;
  btn.onclick = null;

  // Filter inventory for correct type using explicit name lists
  const inv = window._allInvItems || [];
  // Strip +N suffix before matching so enchanted items (e.g. "Iron Dagger +2") are included
  // Also exclude whatever is already equipped in this slot
  const currentEquip = (window._charData?.equipment?.[type] || '').replace(/\s*\+\d+$/, '').trim();
  let rawFiltered = inv.filter(i => {
    const base = (i.name || '').replace(/\s*\+\d+$/, '').trim();
    if (type === 'weapon') {
      if (!(i.type === 'weapon' || i.type === 'equipment') || !ALL_WEAPON_NAMES.includes(base)) return false;
    } else {
      if (!(i.type === 'armor' || i.type === 'equipment') || !ALL_ARMOR_NAMES.includes(base)) return false;
    }
    // Exclude the currently equipped item
    if (currentEquip && base === currentEquip) return false;
    return true;
  });
  // Deduplicate — one entry per base name, keeping the highest enchant level
  const _seenBases = new Map();
  rawFiltered.forEach(i => {
    const base = (i.name || '').replace(/\s*\+\d+$/, '').trim();
    const lvl  = i.enchantLevel || parseInt((i.name || '').match(/\+(\d+)$/)?.[1] || '0');
    const prev = _seenBases.get(base);
    const prevLvl = prev ? (prev.enchantLevel || parseInt((prev.name || '').match(/\+(\d+)$/)?.[1] || '0')) : -1;
    if (!prev || lvl > prevLvl) _seenBases.set(base, i);
  });
  // Sort: by enchant level desc (enchanted first), then alphabetically
  let filtered = Array.from(_seenBases.values()).sort((a, b) => {
    const ea = a.enchantLevel || 0, eb = b.enchantLevel || 0;
    if (eb !== ea) return eb - ea;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Modal title
  title.textContent = type === 'weapon' ? 'Equip Weapon' : 'Equip Armor';

  // List items
  if (filtered.length === 0) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:0.95rem;padding:18px 0;text-align:center">No ${type === 'weapon' ? 'weapons' : 'armor'} available in inventory.</div>`;
    btn.disabled = true;
    return modal.style.display = 'block';
  }
  list.innerHTML = filtered.map((item, idx) => {
    const baseName     = (item.name || '').replace(/\s*\+\d+$/, '');
    const enchantLevel = item.enchantLevel || 0;
    const enchantBadge = enchantLevel > 0
      ? `<span style="font-family:var(--font-mono);font-size:0.58rem;padding:1px 6px;border-radius:5px;background:rgba(201,168,76,0.12);border:1px solid rgba(201,168,76,0.3);color:var(--gold);margin-left:4px">✨ +${enchantLevel}</span>`
      : '';
    const gradeBadge = item.grade
      ? `<span style="font-family:var(--font-mono);font-size:0.55rem;padding:1px 5px;border-radius:5px;margin-left:4px;background:rgba(128,128,128,0.1);color:var(--text-dim)">${item.grade}</span>`
      : '';
    return `<div class="equip-modal-item" data-idx="${idx}" tabindex="0" style="display:flex;align-items:center;gap:10px;padding:10px 8px;cursor:pointer;border-radius:8px;border:1px solid transparent;margin-bottom:6px;transition:background 0.15s">
      <span style="font-size:1.2rem;width:2.2em;text-align:center;flex-shrink:0">${getItemIcon(baseName)}</span>
      <span style="flex:1;font-size:0.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${baseName}${gradeBadge}${enchantBadge}</span>
    </div>`;
  }).join('');

  // Selection logic
  Array.from(list.children).forEach((el, idx) => {
    el.onclick = () => select(idx);
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') select(idx); };
  });
  function select(idx) {
    selected = filtered[idx];
    Array.from(list.children).forEach((el, i) => {
      el.style.background = i === idx ? 'rgba(201,168,76,0.08)' : '';
      el.style.borderColor = i === idx ? 'var(--gold-dim)' : 'transparent';
    });
    btn.disabled = false;
  }

  btn.onclick = async () => {
    if (!selected) return;
    btn.disabled = true;
    error.textContent = '';
    try {
      const charRef = doc(db, "characters", _uid);
      const field = type === 'weapon' ? 'equipment.weapon' : 'equipment.armor';
      // Always store the base name — enchant level lives on the inventory item
      const storeName = (selected.name || '').replace(/\s*\+\d+$/, '').trim();
      await updateDoc(charRef, { [field]: storeName });
      if (window._charData) {
        if (!window._charData.equipment) window._charData.equipment = {};
        window._charData.equipment[type] = storeName;
      }
      _renderEquipPanel(window._charData || {});
      populateDashboard(window._charData);
      closeEquipModal();
      const enchantLevel = selected.enchantLevel || 0;
      const displayName = enchantLevel ? `${storeName} +${enchantLevel}` : storeName;
      showToast(`${displayName} equipped!`, 'success');
    } catch(e) {
      error.textContent = 'Failed to equip. Try again.';
      btn.disabled = false;
    }
  };

  modal.style.display = 'block';
  // Trap focus for accessibility
  setTimeout(() => { list.children[0]?.focus(); }, 100);
};

window.toggleBioEdit = function() {
  const row   = document.getElementById("bio-edit-row");
  const input = document.getElementById("new-bio-input");
  if (!row) return;
  const showing = row.style.display !== "none";
  row.style.display = showing ? "none" : "block";
  if (!showing) { input.value = _charData?.bio || ""; input.focus(); }
};


window.saveBioChange = async function() {
  const input  = document.getElementById("new-bio-input");
  const newBio = input.value.trim();
  try {
    await updateDoc(doc(db, "characters", _uid), { bio: newBio });
    if (_charData) _charData.bio = newBio;
    set("prof-bio", newBio || "No history written yet.");
    document.getElementById("bio-edit-row").style.display = "none";
    window.showToast("Bio updated!", "success");
  } catch(err) {
    console.error(err);
    window.showToast("Failed to update bio.", "error");
  }
};


function set(id, val)    { const e = document.getElementById(id); if (e) { e.textContent = val; } else { console.warn('[SET] Element not found:', id); } }
function css(id, p, v)   { const e = document.getElementById(id); if (e) { e.style[p] = v; } else { console.warn('[CSS] Element not found:', id); } }
function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }
function formatChatText(str) {
  return escapeHtml(str)
    .replace(/\n/g, '<br>')
    .replace(/@([A-Za-z0-9_][A-Za-z0-9_\- ]{1,31})(?=[^A-Za-z0-9_\- ]|$)/g,
      '<span class="chat-mention">@$1</span>');
}
function formatTime(date) {
  const h = date.getHours(), m = date.getMinutes();
  return `${h%12||12}:${String(m).padStart(2,"0")} ${h<12?"AM":"PM"}`;
}

// ═══════════════════════════════════════════════════
//  CLOUD FUNCTIONS CALLER
// ═══════════════════════════════════════════════════
// Custom stepper logic for sell modal
window.stepInput = function(id, delta) {
  const input = document.getElementById(id);
  if (!input) return;
  let val = parseInt(input.value, 10) || 0;
  val += delta;
  if (input.min !== undefined && val < parseInt(input.min, 10)) val = parseInt(input.min, 10);
  input.value = val;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
// ═══════════════════════════════════════════════════
//  NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════

window._notifications = [];
window._unreadCount = 0;

// Real-time notifications for current user
let notificationsUnsub = null;
window.loadNotifications = function() {
  if (notificationsUnsub) notificationsUnsub(); // Unsubscribe previous listener
  if (!_uid) return;
  const q = query(
    collection(db, "notifications"),
    where("uid", "==", _uid),
    orderBy("timestamp", "desc")
  );
  notificationsUnsub = onSnapshot(q, (snap) => {
    window._notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    window._unreadCount = window._notifications.filter(n => !n.read).length;
    window.updateNotificationBadge();
    // Always update notifications panel if open
    if (document.getElementById("notifications-modal")?.style.display === "flex") {
      window.renderNotificationsList();
    }
  });
};

// Update the notification badge in the header
window.updateNotificationBadge = function() {
  window._updateCombinedBadge();
};

// Show notifications modal/panel
window._activeNotifTab = 'notifications';
window.showNotifications = function() {
  let modal = document.getElementById("notifications-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "notifications-modal";
    modal.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:flex-start;justify-content:flex-end";
    modal.innerHTML = `
      <div id="notifications-panel" class="notif-panel">
        <div class="notif-panel-header">
          <div class="notif-tabs">
            <button class="notif-tab active" id="ntab-notifications" onclick="window._switchNotifTab('notifications')">
              🔔 Notifications
              <span class="notif-tab-badge" id="ntab-badge-notifications"></span>
            </button>
            <button class="notif-tab" id="ntab-visions" onclick="window._switchNotifTab('visions')">
              ✨ Divine Visions
              <span class="notif-tab-badge" id="ntab-badge-visions"></span>
            </button>
          </div>
          <button onclick="window.dismissNotificationsModal()" class="notif-close-btn">✕</button>
        </div>
        <div id="notifications-list"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) window.dismissNotificationsModal(); });
  }
  window.renderNotificationsList();
  modal.style.display = "flex";
};

window._switchNotifTab = function(tab) {
  window._activeNotifTab = tab;
  document.querySelectorAll('.notif-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`ntab-${tab}`)?.classList.add('active');
  window.renderNotificationsList();
};

window.dismissNotificationsModal = function() {
  const modal = document.getElementById("notifications-modal");
  if (modal) modal.style.display = "none";
};

window.renderNotificationsList = function() {
  const list = document.getElementById("notifications-list");
  if (!list) return;

  // Update tab badges
  const notifUnread  = (window._notifications  || []).filter(n => !n.read).length;
  const visionUnread = (window._divineVisions   || []).filter(v => !v.read).length;
  const nb = document.getElementById('ntab-badge-notifications');
  const vb = document.getElementById('ntab-badge-visions');
  if (nb) { nb.textContent = notifUnread  || ''; nb.style.display = notifUnread  ? 'inline-flex' : 'none'; }
  if (vb) { vb.textContent = visionUnread || ''; vb.style.display = visionUnread ? 'inline-flex' : 'none'; }

  if (window._activeNotifTab === 'visions') {
    // ── Divine Visions tab ──
    const visions = window._divineVisions || [];
    if (!visions.length) {
      list.innerHTML = `<div class="notif-empty">No divine visions yet.<br><span style="font-size:0.8rem;opacity:0.6">Your deity will speak when the time comes.</span></div>`;
      return;
    }
    list.innerHTML = visions.map(v => {
      const ts = v.sentAt?.toDate ? v.sentAt.toDate().toLocaleString() : '';
      const typeColor = {
        knowledge: '#5b9fe0',
        warning:   '#e07d3c',
        blessing:  '#c9a84c',
        prank:     '#5dbe85',
      }[v.type] || '#c9a84c';
      return `<div class="notif-item ${v.read ? '' : 'notif-item-unread'}">
        <div class="vision-deity-row">
          <span class="vision-type-pill" style="background:${typeColor}22;color:${typeColor};border-color:${typeColor}44">${v.type || 'vision'}</span>
          <span class=\"vision-deity-name\">${v.deityName || v.from || 'Unknown Deity'}</span>
        </div>
        <div class="notif-message vision-message">${v.message || ''}</div>
        <div class="notif-time">${ts}</div>
        <div class="notif-actions">
          ${!v.read ? `<button class="notif-btn notif-btn-read" onclick="window.markVisionRead('${v.id}')">Mark read</button>` : ''}
          <button class="notif-btn notif-btn-delete" onclick="window.deleteVision('${v.id}')">Delete</button>
        </div>
      </div>`;
    }).join('');
    return;
  }

  // ── Regular notifications tab ──
  const notifs = window._notifications || [];
  if (!notifs.length) {
    list.innerHTML = `<div class="notif-empty">No notifications yet.</div>`;
    return;
  }
  list.innerHTML = notifs.map(n => {
    const ts = n.timestamp?.toDate ? n.timestamp.toDate().toLocaleString() : '';
    return `<div class="notif-item ${n.read ? '' : 'notif-item-unread'}">
      <div class="notif-message">${n.message}</div>
      <div class="notif-time">${ts}</div>
      <div class="notif-actions">
        ${!n.read ? `<button class="notif-btn notif-btn-read" onclick="window.markNotificationRead('${n.id}')">Mark read</button>` : ''}
        <button class="notif-btn notif-btn-delete" onclick="window.deleteNotification('${n.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
};

window.markNotificationRead = async function(id) {
  try {
    await updateDoc(doc(db, "notifications", id), { read: true });
    window.loadNotifications();
  } catch(e) { window.showToast("Failed to mark as read.", "error"); }
};

window.deleteNotification = async function(id) {
  try {
    await deleteDoc(doc(db, "notifications", id));
    window.loadNotifications();
  } catch(e) { window.showToast("Failed to delete notification.", "error"); }
};

// (Removed: notifications now load after auth)

// ═══════════════════════════════════════════════════
//  DIVINE VISIONS — inbox from deity messages
// ═══════════════════════════════════════════════════
window._divineVisions    = [];
window._visionUnreadCount = 0;
let _divineVisionsUnsub  = null;

window.loadDivineVisions = function() {
  if (_divineVisionsUnsub) _divineVisionsUnsub();
  if (!_uid) return;
  const q = query(
    collection(db, 'divineVisions', _uid, 'messages'),
    orderBy('sentAt', 'desc')
  );
  _divineVisionsUnsub = onSnapshot(q, (snap) => {
    window._divineVisions     = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    window._visionUnreadCount = window._divineVisions.filter(v => !v.read).length;
    window._updateCombinedBadge();
    // Show toast for brand-new visions
    snap.docChanges().forEach(change => {
      if (change.type === 'added' && !change.doc.data().read) {
        const v = change.doc.data();
        window.showToast(`✨ Divine Vision from ${v.deityName || 'your deity'}`, 'success');
      }
    });
    // Re-render if panel is open
    if (document.getElementById('notifications-modal')?.style.display === 'flex') {
      window.renderNotificationsList();
    }
  });
};

// Combined badge = regular notifications + unread visions
window._updateCombinedBadge = function() {
  const total = (window._unreadCount || 0) + (window._visionUnreadCount || 0);
  [
    document.getElementById('notification-badge'),
    document.getElementById('notification-badge-mobile'),
  ].forEach(b => {
    if (!b) return;
    b.textContent   = total;
    b.style.display = total > 0 ? 'inline-block' : 'none';
  });
};

window.markVisionRead = async function(id) {
  try {
    await updateDoc(doc(db, 'divineVisions', _uid, 'messages', id), { read: true });
  } catch(e) {
    console.error('markVisionRead error:', e.code, e.message);
    if (e.code === 'permission-denied') {
      window.showToast('Permission denied — email may need to be verified.', 'error');
    } else {
      window.showToast('Failed to mark vision as read.', 'error');
    }
  }
};

window.deleteVision = async function(id) {
  try {
    await deleteDoc(doc(db, 'divineVisions', _uid, 'messages', id));
  } catch(e) {
    console.error('deleteVision error:', e.code, e.message);
    if (e.code === 'permission-denied') {
      window.showToast('Permission denied — email may need to be verified.', 'error');
    } else {
      window.showToast('Failed to delete vision.', 'error');
    }
  }
};

// ═══════════════════════════════════════════════════
//  BESTOW WATCHER — detect deity-granted gold/items
// ═══════════════════════════════════════════════════
let _bestowUnsub   = null;

window.startBestowWatcher = function() {
  if (_bestowUnsub) _bestowUnsub();
  if (!_uid) return;
  let _prevBestowId = null;
  _bestowUnsub = onSnapshot(doc(db, 'characters', _uid), (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    const bestowId = data.lastBestowId ?? null;
    // On first snapshot just record baseline — never fire
    if (_prevBestowId === null) {
      _prevBestowId = bestowId;
      return;
    }
    // Only fire when the deity writes a new lastBestowId (set by bestowResources Cloud Function)
    if (bestowId && bestowId !== _prevBestowId) {
      _prevBestowId = bestowId;
      const gold       = data.lastBestowGold  ?? 0;
      const itemsAdded = data.lastBestowItems ?? 0;
      const parts = [];
      if (gold > 0)       parts.push(`+${gold.toLocaleString()}💰`);
      if (itemsAdded > 0) parts.push(`+${itemsAdded} item${itemsAdded > 1 ? 's' : ''}`);
      const msg = parts.length ? parts.join(', ') : 'resources';
      window.showToast(`✨ Divine Bestowment: ${msg}`, 'success');
      logActivity('✨', `<b>Divine Bestowment:</b> ${msg} granted by your deity.`, '#c9a84c');
      // FIXED: Was Object.assign(_charData, data) — a full replacement with the
      // Firestore snapshot. If the player is mid-battle, the auto-battle loop
      // holds a reference to the OLD _charData object; the next kill write would
      // send back the pre-bestow inventory and gold, erasing the bestowment.
      // Instead, only update the fields the bestow actually changed so the
      // battle loop's accumulated local state is preserved.
      if (!_autoBattleRunning) {
        // Safe to do a full sync when not in battle — but ONLY when a real
        // bestow changed. We're already inside the `bestowId !== _prevBestowId`
        // guard above so this is correct; note that other gather/XP writes to
        // the character doc fire this listener too, but they don't change
        // lastBestowId so they never reach this branch.
        Object.assign(_charData, data);
      } else {
        // Mid-battle: only patch the bestow-specific fields to avoid clobbering
        // inventory/gold changes the battle loop has accumulated but not yet flushed.
        // The battle loop will pick up the real server values on its next await.
        if ('lastBestowGold'  in data) _charData.lastBestowGold  = data.lastBestowGold;
        if ('lastBestowItems' in data) _charData.lastBestowItems = data.lastBestowItems;
        if ('lastBestowId'    in data) _charData.lastBestowId    = data.lastBestowId;
        if ('faithLevel'      in data) _charData.faithLevel      = data.faithLevel;
        if ('blessing'        in data) _charData.blessing        = data.blessing;
        // Inventory and gold are intentionally NOT merged here; the battle loop
        // has unsaved deltas. The next kill write uses increment() for gold,
        // so the bestow gold (written server-side by the Cloud Function) is safe.
      }
      _syncAllDisplays(_charData);
      window.renderInventory(_charData.inventory || []);
    }
  });
};

// ═══════════════════════════════════════════════════
//  FAITH LIVE WATCHER — real-time faith level updates
// ═══════════════════════════════════════════════════
let _faithWatcherUnsub = null;
let _prevFaithLevel    = null;

window.startFaithWatcher = function() {
  if (_faithWatcherUnsub) _faithWatcherUnsub();
  if (!_uid) return;
  _faithWatcherUnsub = onSnapshot(doc(db, 'characters', _uid), (snap) => {
    if (!snap.exists()) return;
    const faith = snap.data().faithLevel ?? 0;
    if (_prevFaithLevel === null) { _prevFaithLevel = faith; return; }
    if (faith !== _prevFaithLevel) {
      const diff = faith - _prevFaithLevel;
      set('s-faith', faith);
      if (diff > 0) {
        window.showToast(`🙏 Faith increased to ${faith}`, 'success');
        logActivity('🙏', `<b>Faith Level</b> rose to <b>${faith}</b>.`, '#c9a84c');
      } else {
        window.showToast(`⚠️ Faith decreased to ${faith}`, 'warning');
      }
      _prevFaithLevel = faith;
      if (_charData) _charData.faithLevel = faith;
    }
  });
};

// ═══════════════════════════════════════════════════
//  FACTIONS PANEL RENDERING
// ═══════════════════════════════════════════════════
async function renderFactionsPanel() {
  const container = document.getElementById("faction-list-section");
  if (!container) return;
  if (!FACTIONS || FACTIONS.length === 0) {
    container.innerHTML = `<div class="faction-empty">No factions found.</div>`;
    return;
  }
  // Load live leader data from Firestore
  let leaderMap = {};
  try {
    const snap = await getDocs(collection(db, "factionLeaders"));
    snap.forEach(d => {
      const data = d.data();
      if (data.faction) leaderMap[data.faction] = { name: data.leaderName || "???", image: data.leaderImage || null };
    });
  } catch(e) { /* non-fatal */ }

  const playerFaction = _charData?.faction || null;
  const playerGold = _charData?.gold || 0;

  if (playerFaction) {
    const f = FACTIONS.find(fac => fac.name === playerFaction);
    renderFactionImmersiveView(f, leaderMap[playerFaction] || null);
    return;
  }

  // Browse view — all faction cards
  container.innerHTML = `
    <div class="faction-browse-grid">
      ${FACTIONS.map((faction, idx) => {
        const leader = leaderMap[faction.name];
        const canJoin = playerGold >= 500;
        return `
        <div class="faction-browse-card" style="--faction-color:${faction.color}">
          <div class="fbc-banner">
            <img class="fbc-logo" src="${faction.logo}" alt="${faction.name}"/>
            <div class="fbc-banner-text">
              <div class="fbc-name">${faction.name}</div>
              <div class="fbc-motto">&ldquo;${faction.motto}&rdquo;</div>
              <div class="fbc-alignment">${faction.alignment}</div>
            </div>
          </div>
          <div class="fbc-body">
            <p class="fbc-desc">${faction.description}</p>
            <div class="fbc-activities">
              <span class="fbc-label">Activities</span>
              <span class="fbc-value">${faction.activities.join(' &middot; ')}</span>
            </div>
            <div class="fbc-leader-row">
              ${leader?.image
                ? `<img class="fbc-leader-avatar" src="${leader.image}" alt="${leader.name}"/>`
                : `<div class="fbc-leader-avatar fbc-leader-avatar--placeholder">👑</div>`}
              <div>
                <div class="fbc-label">Faction Leader</div>
                <div class="fbc-leader-name">${leader?.name || "???"}</div>
              </div>
            </div>
          </div>
          <div class="fbc-footer">
            <button class="fbc-join-btn ${canJoin ? '' : 'fbc-join-btn--disabled'}"
              onclick="window.joinFaction('${faction.name}',${idx})"
              ${canJoin ? '' : 'disabled'}>
              ${canJoin ? 'Join &mdash; 500 gold' : 'Not enough gold'}
            </button>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}
// Render immersive view for the joined faction (members, leader, chat)
function renderFactionImmersiveView(faction, leaderData) {
  const container = document.getElementById("faction-list-section");
  if (!container) return;
  const leaderName  = leaderData?.name  || "???";
  const leaderImage = leaderData?.image || null;
  container.innerHTML = `
    <div class="faction-immersive-view">

      <!-- Header bar -->
      <div class="fiv-header" style="--faction-color:${faction.color}">
        <img class="fiv-logo" src="${faction.logo}" alt="${faction.name}"/>
        <div class="fiv-header-text">
          <div class="fiv-name">${faction.name}</div>
          <div class="fiv-motto">&ldquo;${faction.motto}&rdquo;</div>
          <div class="fiv-alignment">${faction.alignment}</div>
        </div>
        <button class="faction-leave-btn faction-leave-btn--header" onclick="window._confirmLeaveFaction('${faction.name}')">Leave Faction</button>
      </div>

      <!-- Two-column: info + leader -->
      <div class="fiv-meta">
        <div class="fiv-meta-left">
          <p class="fiv-desc">${faction.description}</p>
          <div class="fiv-activities">
            <span class="fiv-label">Activities</span>
            <span class="fiv-value">${faction.activities.join(' &middot; ')}</span>
          </div>
        </div>
        <div class="fiv-leader-card">
          <div class="fiv-leader-title">FACTION LEADER</div>
          ${leaderImage
            ? `<img class="fiv-leader-avatar" src="${leaderImage}" alt="${leaderName}"/>`
            : `<div class="fiv-leader-avatar fiv-leader-avatar--placeholder">👑</div>`}
          <div class="fiv-leader-name">${leaderName}</div>
        </div>
      </div>

      <!-- Members -->
      <div id="faction-members-section" class="fiv-section"></div>

      <!-- Chat -->
      <div id="faction-chat-section" class="fiv-section"></div>

    </div>
  `;
  loadFactionMembers(faction.name, leaderName);
  loadFactionChat(faction.name, leaderName);
}

// Custom modal for editing chat message
window.showEditChatModal = function(oldText, onSave) {
  let modal = document.getElementById('chat-edit-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'chat-edit-modal';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.background = 'rgba(0,0,0,0.7)';
    modal.style.zIndex = '9999';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.innerHTML = `
      <div style="background:#23242a;padding:32px 28px 24px 28px;border-radius:14px;min-width:260px;max-width:90vw;text-align:center;box-shadow:0 8px 48px #000b">
        <div style="font-size:1.1rem;color:var(--gold);font-weight:700;margin-bottom:12px">Edit your message</div>
        <input id="chat-edit-input" type="text" style="width:90%;padding:10px 12px;border-radius:7px;border:1px solid #444;background:#181a1f;color:#fff;font-size:1rem;margin-bottom:18px;outline:none"/>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button id="chat-edit-save" style="padding:8px 22px;border-radius:8px;background:var(--gold);color:#222;font-weight:700;border:none;cursor:pointer">Save</button>
          <button id="chat-edit-cancel" style="padding:8px 22px;border-radius:8px;background:#444;color:#fff;font-weight:700;border:none;cursor:pointer">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  const input = document.getElementById('chat-edit-input');
  input.value = oldText;
  input.focus();
  document.getElementById('chat-edit-save').onclick = () => {
    onSave(input.value);
    modal.style.display = 'none';
  };
  document.getElementById('chat-edit-cancel').onclick = () => {
    modal.style.display = 'none';
  };
};

// Custom modal for deleting chat message
window.showDeleteChatModal = function(onConfirm) {
  let modal = document.getElementById('chat-delete-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'chat-delete-modal';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.background = 'rgba(0,0,0,0.7)';
    modal.style.zIndex = '9999';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.innerHTML = `
      <div style="background:#23242a;padding:32px 28px 24px 28px;border-radius:14px;min-width:260px;max-width:90vw;text-align:center;box-shadow:0 8px 48px #000b">
        <div style="font-size:1.1rem;color:var(--gold);font-weight:700;margin-bottom:18px">Delete this message?</div>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button id="chat-delete-yes" style="padding:8px 22px;border-radius:8px;background:var(--gold);color:#222;font-weight:700;border:none;cursor:pointer">Delete</button>
          <button id="chat-delete-no" style="padding:8px 22px;border-radius:8px;background:#444;color:#fff;font-weight:700;border:none;cursor:pointer">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  document.getElementById('chat-delete-yes').onclick = () => {
    onConfirm(true);
    modal.style.display = 'none';
  };
  document.getElementById('chat-delete-no').onclick = () => {
    onConfirm(false);
    modal.style.display = 'none';
  };
};

// Animate join: fade out others, scale up chosen, then show immersive view
window.joinFaction = async function(factionName, idx) {
  if (!_charData) return;
  if (_charData.faction) { window.showToast("Already in a faction.", "error"); return; }
  if ((_charData.gold||0) < 500) { window.showToast("Not enough gold to join.", "error"); return; }
  const cards = document.querySelectorAll('.faction-card');
  const container = document.getElementById("faction-list-section");
  // Animate: fade out all except chosen, scale up chosen to fill
  cards.forEach((card, i) => {
    if (i !== idx) {
      card.style.transition = 'opacity 0.5s, transform 0.7s';
      card.style.opacity = 0;
      card.style.transform = 'scale(0.95) translateY(32px)';
    } else {
      card.style.zIndex = 10;
      card.style.transition = 'all 0.7s cubic-bezier(.22,1.2,.36,1)';
      card.style.position = 'absolute';
      card.style.left = container.offsetLeft + 'px';
      card.style.top = container.offsetTop + 'px';
      card.style.width = container.offsetWidth + 'px';
      card.style.height = container.offsetHeight + 'px';
      setTimeout(()=>{
        card.style.transform = 'scale(1.04) translateY(0)';
        card.style.boxShadow = '0 8px 48px #000b';
      }, 80);
    }
  });
  // Wait for animation, then join and crossfade
  setTimeout(async () => {
    try {
      await updateDoc(doc(db, "characters", _uid), { faction: factionName, gold: increment(-500) }); // FIXED: use increment
      _charData.faction = factionName;
      _charData.gold = Math.max(0, (_charData.gold||0) - 500);
      window.showToast(`Joined ${factionName}!`, "success");
      // Crossfade: fade out all, then show immersive view
      container.style.transition = 'opacity 0.5s';
      container.style.opacity = 0;
      setTimeout(() => {
        renderFactionsPanel();
        container.style.opacity = 1;
      }, 350);
      set("prof-faction", factionName);
      set("stat-gold", _charData.gold);
      set("s-gold", _charData.gold);
    } catch(e) {
      window.showToast("Failed to join faction.", "error");
    }
  }, 700);
}

// Load and display faction members with profile actions
async function loadFactionMembers(factionName, leaderName) {
  const section = document.getElementById('faction-members-section');
  if (!section) return;
  section.innerHTML = '<div style="color:var(--text-dim);font-style:italic">Loading members...</div>';
  try {
    const q = query(collection(db, "characters"), where("faction", "==", factionName));
    const snap = await getDocs(q);
    const members = [];
    snap.forEach(doc => {
      const d = doc.data();
      members.push({ name: d.name, rank: d.rank, level: d.level, avatarUrl: d.avatarUrl, uid: doc.id });
    });
    if (members.length === 0) {
      section.innerHTML = '<div style="color:var(--text-dim);font-style:italic">No members yet.</div>';
      return;
    }
    const collapsed = section.dataset.collapsed === 'true';
    section.innerHTML = `
      <div class="fac-members-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;padding:4px 0 10px;">
        <div style="font-size:1.1rem;font-weight:600;color:var(--gold)">Members <span style="font-size:0.8rem;color:var(--text-dim);font-weight:400">(${members.length})</span></div>
        <span class="fac-members-chevron" style="font-size:0.75rem;color:var(--gold-dim);transition:transform 0.2s;transform:rotate(${collapsed?'-90deg':'0deg'})">${collapsed?'▶':'▼'}</span>
      </div>
      <div class="fac-members-body" style="display:${collapsed?'none':'flex'};flex-wrap:wrap;gap:18px;">
        ${members.map(m => `
          <div class="faction-member-card" data-uid="${m.uid}" style="display:flex;align-items:center;gap:10px;background:rgba(60,60,60,0.5);border-radius:8px;padding:8px 14px;min-width:160px;cursor:pointer;">
            <div class="faction-member-avatar" style="width:36px;height:36px;border-radius:50%;overflow:hidden;background:#222;border:1.5px solid var(--gold-dim);display:flex;align-items:center;justify-content:center;">
              ${m.avatarUrl ? `<img src="${m.avatarUrl}" style="width:100%;height:100%;object-fit:cover;"/>` : `<span style="font-size:1.2rem">👤</span>`}
            </div>
            <div>
              <div style="font-weight:600;color:var(--gold)">${m.name}</div>
              <div style="font-size:0.9rem;color:var(--text-dim)">${m.rank || ''} · Lv${m.level || 1}</div>
            </div>
          </div>
        `).join('')}
      </div>`;
    // Toggle collapse
    section.querySelector('.fac-members-header').addEventListener('click', () => {
      const body = section.querySelector('.fac-members-body');
      const chevron = section.querySelector('.fac-members-chevron');
      const isNowCollapsed = body.style.display !== 'none';
      body.style.display = isNowCollapsed ? 'none' : 'flex';
      chevron.style.transform = isNowCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
      section.dataset.collapsed = isNowCollapsed ? 'true' : 'false';
    });
    // Add click event for member actions
    setTimeout(() => {
      document.querySelectorAll('.faction-member-card').forEach(card => {
        card.addEventListener('click', (e) => {
          const uid = card.getAttribute('data-uid');
          const member = members.find(m => m.uid === uid);
          showMemberActionsModal(member, leaderName);
        });
      });
    }, 100);
  } catch(e) {
    section.innerHTML = '<div style="color:var(--red-bright);font-style:italic">Failed to load members.</div>';
  }
}

// Load and display faction chat (edit/delete, live avatar updates)
function loadFactionChat(factionName, leaderName) {
  const section = document.getElementById('faction-chat-section');
  if (!section) return;
  section.innerHTML = `
    <div style="font-size:1.1rem;font-weight:600;margin-bottom:8px;color:var(--gold)">Faction Chat</div>
    <div id="faction-chat-messages" style="height:220px;max-height:220px;overflow-y:auto;background:rgba(30,30,30,0.7);border-radius:8px;padding:10px 12px 8px 12px;margin-bottom:8px;font-size:0.98rem"></div>
    <form id="faction-chat-form" style="display:flex;gap:8px;align-items:center;">
      <input id="faction-chat-input" type="text" maxlength="200" placeholder="Message your faction..." style="flex:1;padding:7px 12px;border-radius:6px;border:1px solid #444;background:#222;color:#fff;font-size:1rem;outline:none"/>
      <button type="submit" style="padding:7px 18px;border-radius:6px;background:var(--gold);color:#222;font-weight:700;border:none;cursor:pointer">Send</button>
    </form>
  `;
  const chatRef = collection(db, "faction_chats");
  const q = query(chatRef, where("faction", "==", factionName), orderBy("timestamp", "asc"), limit(50));
  onSnapshot(q, (snap) => {
    const msgDiv = document.getElementById('faction-chat-messages');
    if (!msgDiv) return;
    msgDiv.innerHTML = '';
    snap.forEach(docSnap => {
      const d = docSnap.data();
      const isMine = d.uid === _uid;
      const avatar = d.avatarUrl
        ? `<img src="${d.avatarUrl}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;"/>`
        : `<span style="font-size:1.1rem;flex-shrink:0;">👤</span>`;
      // Outer row: just handles layout direction, NOT the click target
      msgDiv.innerHTML += `
        <div class="faction-chat-msg" data-id="${docSnap.id}" data-mine="${isMine}"
          style="margin-bottom:4px;display:flex;flex-direction:column;align-items:${isMine ? 'flex-end' : 'flex-start'};">
          <div class="chat-bubble-row" style="display:flex;align-items:flex-end;gap:8px;flex-direction:${isMine ? 'row-reverse' : 'row'};">
            ${avatar}
            <div class="chat-bubble" style="max-width:70%;background:${isMine ? 'rgba(201,168,76,0.10)' : 'rgba(30,30,30,0.75)'};padding:8px 14px;border-radius:10px;box-shadow:0 1px 4px #0002;color:#fff;text-align:left;cursor:${isMine ? 'pointer' : 'default'};">
              <b style="color:var(--gold)">${d.sender}</b>: <span style="color:#fff">${d.text}</span>
            </div>
          </div>
          <div class="chat-actions" style="display:none;margin-top:4px;gap:6px;"></div>
        </div>
      `;
    });
    msgDiv.scrollTop = msgDiv.scrollHeight;

    // Click fires ONLY on the bubble, not the whole row
    document.querySelectorAll('.faction-chat-msg').forEach(msgEl => {
      if (msgEl.getAttribute('data-mine') !== 'true') return;
      const bubble = msgEl.querySelector('.chat-bubble');
      const actions = msgEl.querySelector('.chat-actions');
      bubble.addEventListener('click', function(e) {
        e.stopPropagation();
        // Toggle: if already open, close it
        const isOpen = actions.style.display === 'flex';
        // Hide all other open action bars first
        document.querySelectorAll('.chat-actions').forEach(a => {
          a.style.display = 'none';
          a.innerHTML = '';
        });
        if (isOpen) return;
        // Build and show action buttons below this bubble
        actions.innerHTML = `
          <button class="chat-edit-btn" style="display:flex;align-items:center;gap:4px;padding:4px 12px;border-radius:6px;background:rgba(201,168,76,0.12);border:1px solid var(--gold-dim);color:var(--gold);font-size:0.82rem;cursor:pointer;">✏️ Edit</button>
          <button class="chat-delete-btn" style="display:flex;align-items:center;gap:4px;padding:4px 12px;border-radius:6px;background:rgba(180,50,50,0.12);border:1px solid #a13b3b;color:#e66;font-size:0.82rem;cursor:pointer;">🗑️ Delete</button>
        `;
        actions.style.display = 'flex';
        // Edit handler
        actions.querySelector('.chat-edit-btn').onclick = async (ev) => {
          ev.stopPropagation();
          const id = msgEl.getAttribute('data-id');
          const textEl = msgEl.querySelector('span');
          const oldText = textEl.textContent;
          window.showEditChatModal(oldText, async (newText) => {
            if (newText && newText !== oldText) {
              await updateDoc(doc(chatRef, id), { text: newText });
            }
            actions.style.display = 'none';
            actions.innerHTML = '';
          });
        };
        // Delete handler
        actions.querySelector('.chat-delete-btn').onclick = async (ev) => {
          ev.stopPropagation();
          const id = msgEl.getAttribute('data-id');
          window.showDeleteChatModal(async (confirmed) => {
            if (confirmed) {
              await deleteDoc(doc(chatRef, id));
            }
            actions.style.display = 'none';
            actions.innerHTML = '';
          });
        };
      });
    });

    // Hide actions when clicking anywhere outside a bubble
    document.addEventListener('click', function hideActions(e) {
      if (!e.target.closest('.chat-bubble')) {
        document.querySelectorAll('.chat-actions').forEach(a => {
          a.style.display = 'none';
          a.innerHTML = '';
        });
        document.removeEventListener('click', hideActions);
      }
    });
  });
  // Send message
  const form = document.getElementById('faction-chat-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById('faction-chat-input');
    const text = input.value.trim();
    if (!text) return;
    await addDoc(chatRef, {
      faction: factionName,
      sender: _charData?.name || 'Unknown',
      uid: _uid,
      avatarUrl: _charData?.avatarUrl || '',
      text,
      timestamp: serverTimestamp(),
    });
    input.value = '';
  };
}
// Show member actions modal ([Speak], [Trade], [Duel])
function showMemberActionsModal(member, leaderName) {
  // Don't show for self
  if (member.uid === _uid) return;
  let modal = document.getElementById('member-actions-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'member-actions-modal';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.background = 'rgba(0,0,0,0.65)';
    modal.style.zIndex = '9999';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.innerHTML = `
      <div style="background:#222;padding:32px 28px 24px 28px;border-radius:16px;max-width:420px;width:100%;box-shadow:0 8px 48px #000b;text-align:center">
        <div style="font-size:1.2rem;color:var(--gold);font-weight:700;margin-bottom:12px">${member.name}</div>
        <div style="margin-bottom:18px"><img src="${member.avatarUrl || ''}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;background:#222;border:2px solid var(--gold-dim)"/></div>
        <button class="member-action-btn" id="member-speak-btn" style="margin:6px 0 12px 0;padding:10px 24px;border-radius:8px;background:var(--gold);color:#222;font-weight:700;border:none;cursor:pointer;width:100%">Speak</button><br/>
        <button class="member-action-btn" id="member-trade-btn" style="margin-bottom:12px;padding:10px 24px;border-radius:8px;background:var(--gold);color:#222;font-weight:700;border:none;cursor:pointer;width:100%">Trade</button><br/>
        <button class="member-action-btn" id="member-duel-btn" style="margin-bottom:12px;padding:10px 24px;border-radius:8px;background:var(--gold);color:#222;font-weight:700;border:none;cursor:pointer;width:100%">Duel</button><br/>
        ${leaderName && _charData?.name === leaderName ? `<button class="member-action-btn" style="margin-bottom:12px;padding:10px 24px;border-radius:8px;background:#a13b3b;color:#fff;font-weight:700;border:none;cursor:pointer;width:100%" onclick="assignLeaveTask('${member.uid}')">Assign Leave Task</button><br/>` : ''}
        <button style="margin-top:10px;padding:8px 22px;border-radius:8px;background:#444;color:#fff;font-weight:700;border:none;cursor:pointer" onclick="document.getElementById('member-actions-modal').remove()">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    // Add Duel button handler with confirmation
    setTimeout(() => {
      const duelBtn = document.getElementById('member-duel-btn');
      if (duelBtn) {
        duelBtn.onclick = async () => {
          if (confirm(`Challenge ${member.name} to a PvP duel?`)) {
            try {
              await window.initiatePvpChallenge(member.uid, member.name);
              document.getElementById('member-actions-modal')?.remove();
            } catch (e) {
              window.showToast('Failed to initiate PvP challenge.', 'error');
            }
          }
        };
      }
    }, 0);
  }
  modal.style.display = 'flex';
}

// Initiate a PvP challenge (creates or navigates to a PvP match)
function initiatePvpChallenge(targetUid, targetName) {
  if (!_uid || !_charData) throw new Error('Not logged in.');
  return (async () => {
    try {
      const myData = {
        uid:       _uid,
        name:      _charData.name,
        avatarUrl: _charData.avatarUrl || '',
        charClass: _charData.charClass || 'Warrior',
        rank:      _charData.rank      || 'Wanderer',
        level:     _charData.level     || 1,
        hp:        _charData.hp        ?? _charData.hpMax   ?? 100,
        maxHp:     _charData.hpMax     ?? _charData.hp      ?? 100,
        mana:      _charData.mana      ?? _charData.manaMax ?? 50,
        maxMana:   _charData.manaMax   ?? _charData.mana    ?? 50,
        atk:       _charData.atk       ?? 10,
        def:       _charData.def       ?? 5,
        spd:       _charData.spd       ?? 5,
      };
      const matchRef = await addDoc(collection(db, 'pvpChallenges'), {
        challengerId:    _uid,
        challengerData:  myData,
        challengerHp:    myData.hp,
        challengerMana:  myData.mana,
        targetId:        targetUid,
        targetData: {
          uid:      targetUid,
          name:     targetName,
          avatarUrl: '',
        },
        participants:    [_uid, targetUid],
        currentTurnUid:  _uid,
        status:          'active',
        log:             [`⚔️ ${_charData.name} challenged ${targetName} to a duel!`],
        createdAt:       serverTimestamp()
      });
      window._myPvpMatchId = matchRef.id;
      _pvpAmChallenger = true;
      // Navigate to Battle panel → PvP mode, then enter arena
      if (typeof window.switchPanel === 'function') window.switchPanel('battle');
      // PVP mode removed from battle panel; duel is initiated via chat
      const match = (await getDoc(matchRef)).data();
      _enterPvpArena({ ...match, matchId: matchRef.id });
    } catch (e) {
      throw e;
    }
  })();
}
window.initiatePvpChallenge = initiatePvpChallenge;

// Assign leave task (leader only)
window.assignLeaveTask = async function(memberUid) {
  const task = prompt('Enter the leave task for this member:');
  if (!task) return;
  // Store under user's document for now
  await updateDoc(doc(db, 'characters', memberUid), {
    factionLeaveInfo: { task: task, taskCompleted: false, assignedBy: _charData.name, assignedAt: Date.now() }
  });
  alert('Leave task assigned!');
  document.getElementById('member-actions-modal')?.remove();
};

// Leave a faction
window._confirmLeaveFaction = function(factionName) {
  // Remove any existing modal first
  document.getElementById('faction-leave-confirm-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'faction-leave-confirm-modal';
  modal.className = 'ink-confirm-overlay';
  modal.innerHTML = `
    <div class="ink-confirm-box">
      <div class="ink-confirm-title">Leave Faction?</div>
      <div class="ink-confirm-msg">Are you sure you want to leave <b>${factionName}</b>? This costs <b>2,000 gold</b> and applies a 7-day cooldown before you can join another faction.</div>
      <div class="ink-confirm-btns">
        <button class="ink-confirm-cancel" onclick="document.getElementById('faction-leave-confirm-modal').remove()">Cancel</button>
        <button class="ink-confirm-ok danger-btn" onclick="document.getElementById('faction-leave-confirm-modal').remove(); window.leaveFaction('${factionName}')">Leave</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

window.leaveFaction = async function(factionName) {
  if (!_charData) return;
  if (_charData.faction !== factionName) { window.showToast("Not in this faction.", "error"); return; }
  if ((_charData.gold||0) < 2000) { window.showToast("Not enough gold to leave (2,000 required).", "error"); return; }
  // All checks passed, allow leave
  try {
    const now = Date.now();
    await updateDoc(doc(db, "characters", _uid), {
      faction: null,
      gold: increment(-2000), // FIXED: use increment to avoid concurrent-write clobber
      factionLeaveInfo: { cooldownUntil: now + 7*24*60*60*1000, taskCompleted: false }
    });
    _charData.faction = null;
    _charData.gold = Math.max(0, (_charData.gold||0) - 2000);
    _charData.factionLeaveInfo = { cooldownUntil: now + 7*24*60*60*1000, taskCompleted: false };
    window.showToast(`Left ${factionName}.`, "success");
    renderFactionsPanel();
    set("prof-faction", "None yet");
    set("stat-gold", _charData.gold);
    set("s-gold", _charData.gold);
  } catch(e) {
    window.showToast("Failed to leave faction.", "error");
  }
}

// Show modal for leader task (stub, UI to be improved)
function showLeaderTaskModal(factionName) {
  let modal = document.getElementById('faction-leave-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'faction-leave-modal';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.background = 'rgba(0,0,0,0.75)';
    modal.style.zIndex = '9999';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.innerHTML = `
      <div style="background:#222;padding:36px 32px 28px 32px;border-radius:18px;max-width:420px;width:100%;box-shadow:0 8px 48px #000b;text-align:center">
        <div style="font-size:1.3rem;color:var(--gold);font-weight:700;margin-bottom:12px">Leader's Task</div>
        <div id="leader-task-desc" style="color:#fff;font-size:1.08rem;margin-bottom:18px">You must complete a special mission assigned by your faction leader before you can leave.<br><br><b>Task:</b> Defeat 3 elite monsters in the wild within 48 hours.</div>
        <div id="leader-task-timer" style="color:var(--gold-dim);margin-bottom:18px">Time left: <span id="leader-task-time">48:00:00</span></div>
        <button id="leader-task-close" style="margin-top:10px;padding:10px 24px;border-radius:8px;background:var(--gold);color:#222;font-weight:700;border:none;cursor:pointer">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('leader-task-close').onclick = () => { modal.remove(); };
  }
  modal.style.display = 'flex';
}

// Show factions when the Faction panel is activated
function initFactionsPanel() {
  // If using a panel switching system, hook into it:
  if (window.switchPanel) {
    const origSwitchPanel = window.switchPanel;
    window.switchPanel = function(panel) {
      origSwitchPanel(panel);
      if (typeof window._onPanelSwitch === 'function') {
        window._onPanelSwitch(panel);
      }
      if (panel === "faction") renderFactionsPanel();
    };
  } else {
    // Fallback: render on DOMContentLoaded if panel is visible
    document.addEventListener("DOMContentLoaded", () => {
      const panel = document.getElementById("panel-faction");
      if (panel && panel.classList.contains("active")) renderFactionsPanel();
    });
  }
}
initFactionsPanel();
// =====================
// STATIC FACTION DATA
// =====================
const FACTIONS = [
  {
    name: "The Veil of Dusk",
    logo: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/faction-images%2Fthe-veil-of-dusk.png?alt=media&token=4262617a-f324-4c69-b2c2-b7a154d54b15",
    alignment: "Good/Neutral",
    motto: "Not all justice is seen.",
    activities: ["Assassination contracts", "Espionage missions", "Information brokering"],
    description: "Operate from the shadows to eliminate threats, influence power, and maintain a hidden balance.",
    leader: "???",
    color: "#3a3a4c"
  },
  {
    name: "The Aethel Archive",
    logo: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/faction-images%2Fthe-aethel-archive.png?alt=media&token=e05c2879-8bca-4438-9a34-8139cfb66a97",
    alignment: "Good/Neutral",
    motto: "Knowledge is the only true power.",
    activities: ["Research missions", "Artifact recovery", "Deciphering ancient ruins"],
    description: "Preserve, study, and expand all knowledge — especially forbidden or ancient truths.",
    leader: "???",
    color: "#4c7a9c"
  },
  {
    name: "The Iron Covenant",
    logo: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/faction-images%2Fthe-iron-convenant.png?alt=media&token=2b1edd6a-81cf-4b68-bebe-ea6c12ea4bfa",
    alignment: "Good/Neutral",
    motto: "Only the strong shape the world.",
    activities: ["Combat trials", "Monster hunting contracts", "Territory defense"],
    description: "Promote strength, discipline, and honor through combat and conquest.",
    leader: "???",
    color: "#6b7a8f"
  },
  {
    name: "The Green Pact",
    logo: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/faction-images%2Fthe-green-pact.png?alt=media&token=83a0ea55-986d-4a88-afda-c99adfffb120",
    alignment: "Good/Neutral",
    motto: "All things must remain in balance.",
    activities: ["Protect forests and wildlife", "Restore corrupted lands", "Gather rare natural resources"],
    description: "Protect nature and maintain balance between civilization and the wild.",
    leader: "???",
    color: "#3b8d4c"
  },
  {
    name: "The Gold Syndicate",
    logo: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/faction-images%2Fthe-gold-syndicate.png?alt=media&token=1bd52cbb-2b21-4d92-bdb1-35f2bb45895c",
    alignment: "Good/Neutral",
    motto: "Gold rules where swords fail.",
    activities: ["Trade deals", "Market manipulation", "Resource monopolies"],
    description: "Control the flow of wealth, trade, and economic power across the world.",
    leader: "???",
    color: "#c9a84c"
  },
  {
    name: "The Obsidian Order",
    logo: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/faction-images%2Fthe-obsidian-order.png?alt=media&token=13aab483-23f7-40a2-b622-4d0daa60bd61",
    alignment: "Evil/Secretive",
    motto: "Power has no morality — only users.",
    activities: ["Dark rituals", "Corruption studies", "Research on abominable creatures"],
    description: "Harness forbidden powers, including corrupted and eldritch forces, to transcend mortal limits.",
    leader: "???",
    color: "#4c2c4c"
  },
  {
    name: "The Crimson Hand",
    logo: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/faction-images%2Fthe-crimson-hand.png?alt=media&token=22a45baf-7f1e-406f-a88a-75090a2e4b2b",
    alignment: "Evil/Secretive",
    motto: "Mercy is weakness.",
    activities: ["Raids on settlements", "Hunting powerful players or targets", "Collecting 'trophies' from kills"],
    description: "Power through violence, domination, and fear. They believe the world belongs to those strong enough to take it.",
    leader: "???",
    color: "#a13b3b"
  }
];
// ═══════════════════════════════════════════════════
//  GUILD PROFILE PICTURE UPLOAD
// ═══════════════════════════════════════════════════
let _guildAvatarFile = null;
document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("guild-avatar-input");
  const preview = document.getElementById("guild-avatar-preview");
  if (input) {
    input.addEventListener("change", (e) => {
      const file = e.target.files[0];
      _guildAvatarFile = file || null;
      if (file) {
        const reader = new FileReader();
        reader.onload = function(ev) {
          preview.innerHTML = `<img src='${ev.target.result}' style='max-width:60px;max-height:60px;border-radius:50%;object-fit:cover;border:2px solid #ccc'/>`;
        };
        reader.readAsDataURL(file);
      } else {
        preview.innerHTML = "";
      }
    });
  }
});

const functions = getFunctions(getApp(), "europe-west1");

// startBattle, battleTurn, autoBattle run client-side (no CORS issues)
const fnResurrect        = httpsCallable(functions, "resurrect");
const fnCraftItem        = httpsCallable(functions, "craftItem");
const fnEnchantItem      = httpsCallable(functions, "enchantItem");

const fnSendVision       = httpsCallable(functions, "sendDivineVision");
const fnBestowResources  = httpsCallable(functions, "bestowResources");
const fnCreateWorldEvent = httpsCallable(functions, "createWorldEvent");
 
// ═══════════════════════════════════════════════════
//  BATTLE SYSTEM
// ═══════════════════════════════════════════════════
 
// ── Client-side battle engine (mirrors Cloud Functions) ──
// Zone-specific monster pools
const ZONE_MONSTER_POOLS = {
  // ── Vorthak: Glass Hell ──────────────────────────────────────────────
  'Lake of Reflections':  ['Prism Spider','Glass Critter','Glass Centipede'],
  'Crystal Cave':         ['Diamond Golem','Luster Bat','Shiny Crustacean'],
  'Rainbow Valley':       ['Radiant Ifrit','Dazzling Fairy','Sparkling Elf'],
  'Shimmering Peak':      ['Red Spirit','Blue Spirit','Purple Spirit'],
  'Mirror Sky':           ['White Raven','Mirror-eyed Owl','Cloud Lurker'],
  // ── Vorthak: Shattered Heavens ───────────────────────────────────────
  'Tempest Crown':        ['Lightning Shroud','Mist Phantom','Hurricane Wraith'],
  'Frostfall Expanse':    ['Ice Ifrit','Vicious Snowman','Crow Frostling'],
  'Ember Horizon':        ['Flame Spirit','Burning Bush','Lava Golem'],
  'Veilwater Basin':      ['Water Wraith','Water Serpent','Liquid Phantom'],
  'Titan Divide':         ['Stone Golem','Moldy Giant','Clayface'],
  // ── Vorthak: Dark Woodlands ──────────────────────────────────────────
  'Crimson Fang':         ['Red-mane Wolf','Blue-mane Wolf','Alpha Beast Wolf'],
  'Root Grove':           ['Five-Fanged Bear','Rampage Bull','Blood-faced Yak'],
  'Serpent Mire':         ['Twin-faced Serpent','Razor-back Komodo','Giant-poison Toad'],
  'Burrowdeep Basin':     ['Groundhog Turtle','Possessed Hedgehog','Bloodlusted Warthog'],
  'Gremlin Hollows':      ['Vicious Gremlin','Scavenger','Vile Goblin'],
  // ── Vorthak: Corrupted Hallows ───────────────────────────────────────
  'Defiled Sanctum':      ['Penitent Priest','Cursed Fiend','Forsaken Follower'],
  'Dark Cathedral':       ['Revenant Bishop','Profane Priest','Profane Presbyter'],
  'Gravemarch Fields':    ['Skeletal Beast','Vile Thieving Vulture','Pallbearer'],
  'Fallen Bastion':       ['Condemned Knight','Nightmare Horse','Profane Jester'],
  'Whispering Necropolis':['Ghoul Blatherer','Condemned Siren','Weeping Apparition'],
  // ── Vorthak: Otherworld ──────────────────────────────────────────────
  'Blighted World':       ['Abomination','Corrupted Sage','Fallen Cyclops'],
  'Infernal Reach':       ['Devil Centurion','Demonic Herald','Cerberus'],
  'Sphinx Dominion':      ['Dark Sphinx','Desolate Matriarch','Bestial Sandworm'],
  'Ashwing Aerie':        ['Blue Phoenix','Glowing Griffin','Nebulous Phoenix'],
  'Leviathan Depths':     ['Blood Kraken','Lightning Eel','Colossal Black Serpent'],
  // ── Nyx Abyss: Fallen Heaven ─────────────────────────────────────────
  'Fractured Firmament':  ['Godless Thing','Dark Angel','Origin of Catastrophe'],
  'Maw of Eternity':      ['Great Devourer','Gastric Juices','Gourmet Devil'],
  'Veil of Madness':      ['Chaoswalker','Chaoshunter','Earl of Abolition'],
  'The Watching Expanse': ['Oblivion Eye','Pyramid Eye','Eye of Jujularim'],
  'Descent of the Nameless':['VoidSpawn','Faithless','Disciple of Silence'],
  // ── Nyx Abyss: Underworld ─────────────────────────────────────────────
  'Gravefall Descent':    ['Abyss Crawler','Filthy Monarch','Ferryman'],
  'Weeping Caverns':      ['Doom Leech','Scourge Wraith','Ancient Bane'],
  'Kingdom of Chains':    ['Shackled Sage','Chainbound Hound','Prisoner of Time'],
  'The Hollow Deep':      ['Eyeless: The Abomination','Pale Emperor','Keeper of Secrets'],
  'Throne of the Depths': ['King Yama','Anubis','Mictlantecuhtli'],
  // ── Nyx Abyss: Land of Sin ────────────────────────────────────────────
  'Throne of Pride':      ['Pride','Prejudice','Wrath'],
  'Hallow of Greed':      ['Greed','Avarice','Envy'],
  'Crimson Feast':        ['Gluttony','Insatiable Maw','Tail-Devourer'],
  'Veil of Desire':       ['Lust','Desire','Demoness'],
  'The Forsaken Graves':  ['Sloth','Despair','Sorrow'],
  // ── Nyx Abyss: Cosmos ─────────────────────────────────────────────────
  'Bleeding Constellations':['Star Phantom','The Unwinged Seraph','The Weeping Dust'],
  'The Watching Worlds':  ['The Watcher','Dark Planet','High-dimensional Seer'],
  'Nebula of Whispers':   ['The Whispering Gas','Cosmic Mist','The Hanging Lights'],
  'Eclipse Throne':       ['Fade to Black','Unfathomable Wall','Shadowed Sun'],
  'The Endless Maw':      ['Void Thing','The Twilight Horizon','The Singularity'],
  // ── Nyx Abyss: The Withering Tree ─────────────────────────────────────
  'Root of Malevolence':  ['Malevolence','Maleficence','Malediction'],
  'Grove of Horror':      ['Horror','Dread','Bane'],
  'Canopy of Despair':    ['Despair','Sorrow','Undoing'],
  'Crown of Madness':     ['Madness','Delusion','Paranoia'],
  'Heartwood Abyss':      ['Oblivion','Nihility','Entropy'],
};
// Max monsters per zone before 10-min respawn
const ZONE_POOL_SIZE = { E:80, D:60, C:40, B:25, A:15, S:10 };

const MONSTER_TEMPLATES = {
  E: ['Prism Spider','Glass Critter','Glass Centipede','Red-mane Wolf','Blue-mane Wolf','Alpha Beast Wolf','Five-Fanged Bear','Rampage Bull','Blood-faced Yak','Groundhog Turtle','Possessed Hedgehog','Bloodlusted Warthog'],
  D: ['Diamond Golem','Luster Bat','Shiny Crustacean','Radiant Ifrit','Dazzling Fairy','Sparkling Elf','Red Spirit','Blue Spirit','Purple Spirit','White Raven','Mirror-eyed Owl','Cloud Lurker','Lightning Shroud','Mist Phantom','Hurricane Wraith','Ice Ifrit','Vicious Snowman','Crow Frostling','Twin-faced Serpent','Razor-back Komodo','Giant-poison Toad','Vicious Gremlin','Scavenger','Vile Goblin'],
  C: ['Flame Spirit','Burning Bush','Lava Golem','Water Wraith','Water Serpent','Liquid Phantom','Stone Golem','Moldy Giant','Clayface','Penitent Priest','Cursed Fiend','Forsaken Follower','Revenant Bishop','Profane Priest','Profane Presbyter'],
  B: ['Skeletal Beast','Vile Thieving Vulture','Pallbearer','Condemned Knight','Nightmare Horse','Profane Jester','Ghoul Blatherer','Condemned Siren','Weeping Apparition'],
  A: ['Abomination','Corrupted Sage','Fallen Cyclops','Devil Centurion','Demonic Herald','Cerberus','Dark Sphinx','Desolate Matriarch','Bestial Sandworm','Blue Phoenix','Glowing Griffin','Nebulous Phoenix','Blood Kraken','Lightning Eel','Colossal Black Serpent'],
  S: [
    // Fallen Heaven
    'Godless Thing','Dark Angel','Origin of Catastrophe','Great Devourer','Gastric Juices','Gourmet Devil',
    'Chaoswalker','Chaoshunter','Earl of Abolition','Oblivion Eye','Pyramid Eye','Eye of Jujularim',
    'VoidSpawn','Faithless','Disciple of Silence',
    // Underworld
    'Abyss Crawler','Filthy Monarch','Ferryman','Doom Leech','Scourge Wraith','Ancient Bane',
    'Shackled Sage','Chainbound Hound','Prisoner of Time',
    'Eyeless: The Abomination','Pale Emperor','Keeper of Secrets',
    'King Yama','Anubis','Mictlantecuhtli',
    // Land of Sin
    'Pride','Prejudice','Wrath','Greed','Avarice','Envy',
    'Gluttony','Insatiable Maw','Tail-Devourer','Lust','Desire','Demoness',
    'Sloth','Despair','Sorrow',
    // Cosmos
    'Star Phantom','The Unwinged Seraph','The Weeping Dust',
    'The Watcher','Dark Planet','High-dimensional Seer',
    'The Whispering Gas','Cosmic Mist','The Hanging Lights',
    'Fade to Black','Unfathomable Wall','Shadowed Sun',
    'Void Thing','The Twilight Horizon','The Singularity',
    // The Withering Tree
    'Malevolence','Maleficence','Malediction','Horror','Dread','Bane',
    'Undoing','Madness','Delusion','Paranoia','Oblivion','Nihility','Entropy',
  ],
};

// ── Monster image map — name → Firebase Storage URL ──────────────────────────
const MONSTER_IMAGES = {
  // ── Corrupted Hallows ────────────────────────────────────────────────────
  'Condemned Knight':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fcondemned%20knight.jpeg?alt=media&token=e69657aa-7489-4005-9c4a-2efb22b4e568',
  'Condemned Siren':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fcondemned-siren.jpg?alt=media&token=3a172852-cdaf-4f39-817f-5695dc9165f7',
  'Cursed Fiend':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fcursed%20fiend.jpeg?alt=media&token=e0ffaaf9-2c7e-4af0-a911-0e8b9c07ff4c',
  'Forsaken Follower':   'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fforsaken-follower.jpg?alt=media&token=69cb0133-15f6-4e70-8170-cf5f56cb9dfc',
  'Ghoul Blatherer':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fghoul%20blatherer.jpeg?alt=media&token=1e8065cc-ab45-40df-a1db-5e657616069c',
  'Nightmare Horse':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fnightmare-horse.jpg?alt=media&token=94c1bcc4-91be-4b61-9252-d1fbbc1cc7dd',
  'Pallbearer':          'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fpallbearer.jpg?alt=media&token=33c66f7c-bd74-4cc6-b87f-aef8c782054a',
  'Penitent Priest':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fpenitent%20priest.jpeg?alt=media&token=ea158b6c-041d-4081-89ef-2d5476b55b9e',
  'Profane Priest':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fprofane%20priest.jpeg?alt=media&token=02dd949a-36f0-419e-bac4-b970dd3b1e9a',
  'Profane Jester':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fprofane-jester.jpg?alt=media&token=340d734b-bf43-48d0-aa60-c1b06192c2d5',
  'Profane Presbyter':   'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fprofane-presbyter.jpg?alt=media&token=76191f03-58a1-4d89-9331-341c23507034',
  'Revenant Bishop':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Frevenant%20bishop.jpeg?alt=media&token=c30e5b5f-f420-421f-98d6-3e5873c51146',
  'Skeletal Beast':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fskeletal%20beast.jpeg?alt=media&token=30e9c7b5-ff5a-48d5-9bd5-1ee7b0347b33',
  'Vile Thieving Vulture':'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fvile-thieving-vulture.jpg?alt=media&token=0cbd5db1-531a-434a-bc0e-b33832ac0ed6',
  'Weeping Apparition':  'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fcorrupted-hallows-creatures%2Fweeping-apparition.jpg?alt=media&token=4a31592b-dc02-45fa-8a16-72df51a6714b',
  // ── Dark Woodlands ──────────────────────────────────────────────────────
  'Alpha Beast Wolf':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Falpha-beastwolf.jpg?alt=media&token=5a859dda-2153-445a-b335-97f764b9c218',
  'Bloodlusted Warthog': 'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fbloddlusted-warthog.jpg?alt=media&token=f2f6eaf9-dff9-4749-bb66-f4adee049cd1',
  'Blood-faced Yak':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fblood-faced-yak.jpg?alt=media&token=358d1cee-60c8-4c9d-b408-fd0c5759caf0',
  'Blue-mane Wolf':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fblue-mane%20wolf.jpeg?alt=media&token=af7b7f36-ea69-48fd-9b93-5f6bf429b1e9',
  'Five-Fanged Bear':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Ffive-fanged%20bear.jpeg?alt=media&token=d5cb507c-2214-4f14-9511-3ca5030758dc',
  'Giant-poison Toad':   'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fgiant-poison-toad.jpg?alt=media&token=4c799f4f-4311-4245-8d61-1e93816eab22',
  'Groundhog Turtle':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fgroundhog%20turtle.jpeg?alt=media&token=aa4e9570-c5a8-4650-828d-1fba75081b36',
  'Possessed Hedgehog':  'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fpossessed-hedgehog.jpg?alt=media&token=803adf58-0b6a-4c3c-942b-3b5f6a5102a7',
  'Rampage Bull':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Frampage%20bull.jpeg?alt=media&token=d95a6f7c-47f0-49de-981e-92dd2fbd1e8f',
  'Razor-back Komodo':   'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Frazorback-komodo.jpg?alt=media&token=f3c692f7-481a-45b6-9b34-f6ed8a45a595',
  'Red-mane Wolf':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fred-mane%20wolf.jpeg?alt=media&token=b857d7e1-068c-422b-8cd9-6d9fac77ce23',
  'Scavenger':           'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fscavenger.png?alt=media&token=40a43362-491c-467f-9c9a-9fd377addc2a',
  'Twin-faced Serpent':  'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Ftwin-faced%20serpent.png?alt=media&token=322db6bf-8078-432d-83e3-6126c0c053c0',
  'Vicious Gremlin':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fvicious%20gremlin.jpeg?alt=media&token=9739515f-45dc-42fb-af23-ab350f11e710',
  'Vile Goblin':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fdark-woodlands-creatures%2Fvile-goblin.jpg?alt=media&token=283aa016-6e97-408d-85a4-5eb0d8cca8bb',
  // ── Glass Hell ──────────────────────────────────────────────────────────
  'Blue Spirit':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fblue-spirit.jpg?alt=media&token=5807fa96-2c02-419d-a9ee-bd59424122c3',
  'Cloud Lurker':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fcloud-lurker.jpg?alt=media&token=d585ca58-4a0a-47db-84b0-6b55462afdc6',
  'Dazzling Fairy':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fdazzling-fairy.jpg?alt=media&token=a33a5baa-91a9-45ce-a22c-7b368ca4d700',
  'Diamond Golem':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fdiamond-golem.jpg?alt=media&token=5d60e9df-9eab-449a-be8f-971b7959aeb3',
  'Glass Centipede':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fglass-centipede.jpg?alt=media&token=a049da83-18a5-4657-9328-a267d1b2e9ec',
  'Glass Critter':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fglass-critter.jpg?alt=media&token=94856717-fc7c-4524-8765-ebf124603761',
  'Luster Bat':          'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fluster-bat.jpg?alt=media&token=5f986b94-21d8-476e-b006-38e203ec7af8',
  'Mirror-eyed Owl':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fmirror-eyed-owl.jpg?alt=media&token=767dbf6d-4c73-4ac9-ab96-34f49df791eb',
  'Prism Spider':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fprism-spider.jpg?alt=media&token=920ae827-2392-4be1-b485-86455072c27a',
  'Purple Spirit':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fpurple-spirit.jpg?alt=media&token=1b715f2d-a21b-4759-9c4c-8591e7af6d77',
  'Radiant Ifrit':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fradiant-ifrit.jpg?alt=media&token=6801b49b-092c-48f8-9234-8ac605648864',
  'Red Spirit':          'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fred-spirit.jpg?alt=media&token=a1f157b7-c75e-4a09-8b8a-7f61fd886163',
  'Shiny Crustacean':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fshiny-crustacean.jpg?alt=media&token=f0be7306-6829-45ca-adbb-422ecc755442',
  'Sparkling Elf':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fsparkling-elf.jpg?alt=media&token=b379df01-33cc-4106-a628-620c9de53359',
  'White Raven':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fglass-hell-creatures%2Fwhite-raven.jpg?alt=media&token=05955376-8b62-4f9d-8c0b-35913bf1227d',
  // ── Otherworld ──────────────────────────────────────────────────────────
  'Abomination':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fabomination.jpeg?alt=media&token=0a95dc1d-17a4-4d6c-b50b-cc2d10aabfb6',
  'Bestial Sandworm':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fbestial-sandworm.jpg?alt=media&token=51deb040-3e9c-4dbc-a79c-96cb852d091f',
  'Blood Kraken':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fblood%20kraken.jpeg?alt=media&token=f7a4c54d-ebed-4100-af2c-775aa8e372c9',
  'Blue Phoenix':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fblue%20phoenix.jpeg?alt=media&token=40562c98-7a2c-4827-8c96-c19d5570026c',
  'Cerberus':            'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fcerberus.jpeg?alt=media&token=97fe4b19-649e-43a3-b012-50c6537c2886',
  'Colossal Black Serpent':'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fcolossal-black-serpent.jpg?alt=media&token=6fd4c4b9-3963-4667-8ebe-70bef62d6d9c',
  'Corrupted Sage':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fcorrupted-sage.jpg?alt=media&token=bb785c47-f760-4b6f-8a8c-f8d7812f4938',
  'Dark Sphinx':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fdark%20sphinx.jpeg?alt=media&token=3fd6be99-2331-4a7c-8038-ea46fc75d9ea',
  'Demonic Herald':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fdemonic%20herald.jpeg?alt=media&token=132d57b1-6f35-4d03-8c42-ab20f7887a17',
  'Desolate Matriarch':  'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fdesolate-matriarch.jpg?alt=media&token=e23fec3c-2be1-4e13-95f8-be20507045a5',
  'Devil Centurion':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fdevil%20centurion.jpeg?alt=media&token=76e96ee5-ccb2-4376-a12e-20683108c026',
  'Fallen Cyclops':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Ffallen-cyclops.jpeg?alt=media&token=3db2adcc-db11-4452-929e-b598918a33e4',
  'Glowing Griffin':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fglowing-griffin.jpg?alt=media&token=432f99dc-33d3-48c1-8f1e-5fbb7eec5459',
  'Lightning Eel':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Flightning-eel.jpg?alt=media&token=a40c5b0d-6a97-4f8a-80b9-8c170228c91e',
  'Nebulous Phoenix':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fotherworld-creatures%2Fnebulous-phoenix.jpg?alt=media&token=69dd532d-a1e4-4d1f-8326-e85f612a4456',
  // ── Shattered Heavens ───────────────────────────────────────────────────
  'Burning Bush':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fburning-bush.jpg?alt=media&token=81ca0367-1a1b-4bd9-9a0e-455b06e5f11e',
  'Clayface':            'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fclayface.jpg?alt=media&token=c2b6683a-a392-4e6c-bfd7-60a84b32fc6f',
  'Crow Frostling':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fcrow-frostling.jpg?alt=media&token=ca5624cf-834c-400f-b4cf-acd15e80f61c',
  'Flame Spirit':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fflame%20spirit.jpeg?alt=media&token=218cb415-be43-4698-be07-3efb1fe0d48b',
  'Hurricane Wraith':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fhurricane-wraith.jpg?alt=media&token=6054b7b4-4ad2-4fe1-b826-ad5e7db052e7',
  'Ice Ifrit':           'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fice%20ifrit.jpeg?alt=media&token=06952258-894e-4036-81f2-dbdc75df2356',
  'Lava Golem':          'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Flava-golem.jpg?alt=media&token=5f12d447-4123-4491-a22a-38e8626ec51e',
  'Lightning Shroud':    'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Flightning%20shroud.jpeg?alt=media&token=fda29d1c-62db-431d-8485-e95967e3c8b6',
  'Liquid Phantom':      'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fliquid-phantom.jpg?alt=media&token=296a3bf4-fc20-4309-bf43-9902009a2f25',
  'Mist Phantom':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fmist%20phantom.jpeg?alt=media&token=15235a64-ac3e-4d5a-beb3-ca400d8211a5',
  'Moldy Giant':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fmoldy-giant.jpg?alt=media&token=0ccc4c38-36d1-4b55-9b7c-74921b8d059d',
  'Stone Golem':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fstone%20golem.jpeg?alt=media&token=713c3b3a-dfed-4d3b-a1b8-159c17dd136b',
  'Vicious Snowman':     'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fvicious-snowman.jpg?alt=media&token=d111c106-62e2-431f-8bcf-97535f3a8a49',
  'Water Wraith':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fwater%20wraith.jpeg?alt=media&token=5e425fba-e8dc-4299-8de5-3351677be966',
  'Water Serpent':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fshattered-heavens-creatures%2Fwater-serpent.jpg?alt=media&token=8f56def5-8499-48f9-8141-0a2823f72b90',
  // ── Nyx Abyss (no new images provided yet — keeping existing) ───────────
  'Abyssal Eater':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fabyssal%20eater.jpeg?alt=media&token=bba6e91d-540f-44b6-9927-f4c3817f98ba',
  'Void Lurker':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fvoid%20lurker.jpeg?alt=media&token=4fa02db1-94a3-4a95-8f22-3bc4ad48fa71',
  'Chaoswalker':         'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fchaoswalker.png?alt=media&token=94ef72a8-a1a5-4bf2-9bca-2ee08b12b885',
  'Oblivion Eye':        'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Foblivion%20eye.png?alt=media&token=a69ff4b0-f5c1-4595-b4a6-5cdbafd2ad45',
  'Godless Thing':       'https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/monster-images%2Fgodless%20thing.png?alt=media&token=8b80879a-e247-4101-85ca-dea948f4d63a',
};
// ── Render monster avatar: image if available, grade emoji fallback ──────────
function _renderMonsterAvatar(elId, monster) {
  const el = document.getElementById(elId);
  if (!el) {
    console.warn('[AVATAR] Element not found:', elId);
    return;
  }
  console.log('[AVATAR] Rendering monster avatar for:', elId, 'monster:', monster.name);
  if (monster.img) {
    el.innerHTML = `<img src="${monster.img}" alt="${monster.name}"
      style="width:100%;height:100%;object-fit:cover;border-radius:inherit"/>`;
  } else {
    // Large containers (battle banner & encounter popup) get big emoji; small ones get smaller
    const isLarge = el.offsetHeight >= 180 || el.style.height === '220px' || elId === 'monster-avatar-emoji' || elId === 'encounter-monster-emoji';
    const sz = isLarge ? '4rem' : '2.2rem';
    el.innerHTML = `<span style="font-size:${sz}">${gradeEmoji[monster.grade] || '👹'}</span>`;
  }
  console.log('[AVATAR] Monster avatar rendered');
}

// Base stat ranges per grade (spec-accurate)
// ── Level-band base stats per spec (Vorthak monster scaling) ──────────────────
// Dark Woodlands (levels 1–100)
const LEVEL_BAND_STATS = {
  '1-20':   { hp:[80,100],     atk:[10,12],   def:[10,12],   dex:[5,8],    exp:20,  gold:[18,22]  },
  '21-40':  { hp:[280,300],    atk:[40,45],   def:[40,45],   dex:[30,35],  exp:40,  gold:[28,32]  },
  '41-60':  { hp:[480,500],    atk:[70,75],   def:[70,75],   dex:[40,55],  exp:60,  gold:[38,42]  },
  '61-80':  { hp:[680,700],    atk:[90,95],   def:[90,95],   dex:[60,65],  exp:80,  gold:[48,52]  },
  '81-100': { hp:[880,900],    atk:[110,115], def:[110,115], dex:[70,75],  exp:100, gold:[48,52]  },
  // Shattered Heavens (levels 101–200)
  '101-120':{ hp:[1250,1300],  atk:[130,135], def:[130,135], dex:[100,110],exp:110, gold:[100,130]},
  '121-140':{ hp:[1450,1500],  atk:[150,155], def:[150,155], dex:[110,120],exp:120, gold:[100,130]},
  '141-160':{ hp:[1650,1700],  atk:[180,185], def:[180,185], dex:[120,130],exp:130, gold:[100,130]},
  '161-180':{ hp:[1850,1900],  atk:[200,205], def:[200,205], dex:[130,140],exp:140, gold:[100,130]},
  '181-200':{ hp:[2050,2100],  atk:[220,225], def:[220,225], dex:[140,150],exp:150, gold:[100,130]},
  // Glass Hell (levels 201–300)
  '201-220':{ hp:[2400,2450],  atk:[255,260], def:[255,260], dex:[200,210],exp:160, gold:[150,200]},
  '221-240':{ hp:[2600,2650],  atk:[275,280], def:[275,280], dex:[210,220],exp:170, gold:[150,200]},
  '241-260':{ hp:[2800,2850],  atk:[295,300], def:[295,300], dex:[220,230],exp:180, gold:[150,200]},
  '261-280':{ hp:[3000,3050],  atk:[315,320], def:[315,320], dex:[230,240],exp:190, gold:[150,200]},
  '281-300':{ hp:[3200,3250],  atk:[335,340], def:[335,340], dex:[240,250],exp:200, gold:[150,200]},
  // Corrupted Hallows (levels 301–400)
  '301-320':{ hp:[3550,3600],  atk:[370,380], def:[370,380], dex:[300,310],exp:210, gold:[200,280]},
  '321-340':{ hp:[3750,3800],  atk:[390,400], def:[390,400], dex:[310,320],exp:220, gold:[200,280]},
  '341-360':{ hp:[3950,4000],  atk:[410,420], def:[410,420], dex:[320,330],exp:230, gold:[200,280]},
  '361-380':{ hp:[4150,4200],  atk:[430,440], def:[430,440], dex:[330,340],exp:240, gold:[200,280]},
  '381-400':{ hp:[4350,4400],  atk:[450,460], def:[450,460], dex:[340,350],exp:250, gold:[200,280]},
  // Otherworld (levels 401–500)
  '401-420':{ hp:[4700,4750],  atk:[490,495], def:[490,495], dex:[400,410],exp:300, gold:[400,550]},
  '421-440':{ hp:[4900,4950],  atk:[510,515], def:[510,515], dex:[410,420],exp:320, gold:[400,550]},
  '441-460':{ hp:[5100,5150],  atk:[530,535], def:[530,535], dex:[420,430],exp:340, gold:[400,550]},
  '461-480':{ hp:[5300,5350],  atk:[550,555], def:[550,555], dex:[430,440],exp:360, gold:[400,550]},
  '481-500':{ hp:[5500,5550],  atk:[570,575], def:[570,575], dex:[440,450],exp:380, gold:[400,550]},
};

// Zone → level band mapping (Vorthak — Eastern Continent)
const ZONE_LEVEL_BAND = {
  // Dark Woodlands
  'Gremlin Hollows':      '1-20',
  'Serpent Mire':         '21-40',
  'Burrowdeep Basin':     '41-60',
  'Root Grove':           '61-80',
  'Crimson Fang':         '81-100',
  // Shattered Heavens
  'Titan Divide':         '101-120',
  'Veilwater Basin':      '121-140',
  'Frostfall Expanse':    '141-160',
  'Ember Horizon':        '161-180',
  'Tempest Crown':        '181-200',
  // Glass Hell
  'Lake of Reflections':  '201-220',
  'Crystal Cave':         '221-240',
  'Mirror Sky':           '241-260',
  'Rainbow Valley':       '261-280',
  'Shimmering Peak':      '281-300',
  // Corrupted Hallows
  'Gravemarch Fields':    '301-320',
  'Whispering Necropolis':'321-340',
  'Defiled Sanctum':      '341-360',
  'Dark Cathedral':       '361-380',
  'Fallen Bastion':       '381-400',
  // Otherworld
  'Blighted World':       '401-420',
  'Leviathan Depths':     '421-440',
  'Ashwing Aerie':        '441-460',
  'Sphinx Dominion':      '461-480',
  'Infernal Reach':       '481-500',
};

// Zone → minimum player level required to unlock
const ZONE_LEVEL_REQ = {
  'Gremlin Hollows':       1,
  'Serpent Mire':         21,
  'Burrowdeep Basin':     41,
  'Root Grove':           61,
  'Crimson Fang':         81,
  // All other Vorthak regions start at 101+ — locked until reaching those levels
  'Titan Divide':        101,
  'Veilwater Basin':     121,
  'Frostfall Expanse':   141,
  'Ember Horizon':       161,
  'Tempest Crown':       181,
  'Lake of Reflections': 201,
  'Crystal Cave':        221,
  'Mirror Sky':          241,
  'Rainbow Valley':      261,
  'Shimmering Peak':     281,
  'Gravemarch Fields':   301,
  'Whispering Necropolis':321,
  'Defiled Sanctum':     341,
  'Dark Cathedral':      361,
  'Fallen Bastion':      381,
  'Blighted World':      401,
  'Leviathan Depths':    421,
  'Ashwing Aerie':       441,
  'Sphinx Dominion':     461,
  'Infernal Reach':      481,
};

// Legacy grade-keyed stats kept for Nyx Abyss and other non-Vorthak zones
const MONSTER_BASE_STATS = {
  E: { hp:[80,100],     atk:[10,12],   def:[10,12],   dex:[5,8]    },
  D: { hp:[280,300],    atk:[40,45],   def:[40,45],   dex:[30,35]  },
  C: { hp:[1250,1300],  atk:[130,135], def:[130,135], dex:[100,110]},
  B: { hp:[3550,3600],  atk:[370,380], def:[370,380], dex:[300,310]},
  A: { hp:[4700,4750],  atk:[490,495], def:[490,495], dex:[400,410]},
  S: { hp:[5500,5550],  atk:[570,575], def:[570,575], dex:[440,450]},
};
// Rank multipliers (Wanderer=1 … Eternal=15)
const RANK_MULT = [1,2,3,4,5,7,9,11,13,15];
const RANK_ORDER_MULT = ['Wanderer','Follower','Disciple','Master','Exalted','Crown','Supreme','Legend','Myth','Eternal'];
function _getRankMult(rank) {
  const i = RANK_ORDER_MULT.indexOf(rank);
  return RANK_MULT[i >= 0 ? i : 0];
}

const MONSTER_EXP_LOCAL  = { E:20, D:50, C:120, B:300, A:700, S:1500 };
const MONSTER_GOLD_LOCAL = { E:[18,22], D:[28,32], C:[100,130], B:[200,280], A:[400,550], S:[900,1200] };
 
function _randInt(min, max) { return Math.floor(Math.random()*(max-min+1))+min; }
 
function _generateMonster(grade, zoneName) {
  // Pick from zone-specific pool if available, else fall back to grade pool
  const names = (zoneName && ZONE_MONSTER_POOLS[zoneName]) || MONSTER_TEMPLATES[grade] || MONSTER_TEMPLATES.E;
  const name  = names[_randInt(0, names.length - 1)];

  // Use level-band stats for known Vorthak zones; fall back to legacy grade stats for other zones
  const band  = zoneName && ZONE_LEVEL_BAND[zoneName];
  const b     = (band && LEVEL_BAND_STATS[band]) || MONSTER_BASE_STATS[grade] || MONSTER_BASE_STATS.E;

  const hp    = _randInt(b.hp[0],  b.hp[1]);
  const atk   = _randInt(b.atk[0], b.atk[1]);
  const def   = _randInt(b.def[0], b.def[1]);
  const dex   = _randInt(b.dex[0], b.dex[1]);
  const img   = MONSTER_IMAGES[name] || null;
  const levelBand = band || null;
  return { name, grade, levelBand, zoneName: zoneName||null, hp, maxHp: hp, atk, def, dex, img };
}
 
function _getPrimaryStat(charClass, stats) {
  const map = { Warrior:'str', Guardian:'def', Arcanist:'int', Hunter:'dex', Assassin:'dex', Cleric:'int', Summoner:'int' };
  return stats[map[charClass]||'str'] || 10;
}
 
// ── Loot tables — match spec drop chances ─────────────────────────────────────
// Each grade defines independent drop slots. Each slot has:
//   chance  - probability this slot triggers (modified by luck)
//   pool    - array of { name, weight } items; one is picked via weighted random
// Gold is handled separately via MONSTER_GOLD_LOCAL.
// _rollDrops() rolls each slot independently then picks one item from that
// slot's pool — so "30% chance for any common resource" means exactly one
// common at 30%, not multiple simultaneous rolls.

// ---- Resource pools (shared across grades) ----
const COMMON_RESOURCE_POOL = [
  { name:'Iron',            weight:16 }, { name:'Wood',      weight:16 },
  { name:'Leather',         weight:16 }, { name:'Bone Fragments', weight:14 },
  { name:'Fur',             weight:12 }, { name:'Feathers',  weight:12 },
  { name:'Tin',             weight:8  }, { name:'Copper',    weight:6  },
];
const UNCOMMON_RESOURCE_POOL = [
  { name:'Silver',  weight:20 }, { name:'Bronze',  weight:18 },
  { name:'Quartz',  weight:18 }, { name:'Marble',  weight:16 },
  { name:'Obsidian',weight:14 }, { name:'Coal',    weight:14 },
];
const RARE_RESOURCE_POOL = [
  { name:'Dragon Scales', weight:25 }, { name:'Cyclops Eye', weight:25 },
  { name:'Phoenix Bloom', weight:20 }, { name:'Shadow Hide', weight:15 },
  { name:'Drake Meat',    weight:15 },
];
const LEGENDARY_RESOURCE_POOL = [
  { name:'Titanium',   weight:30 }, { name:'Adamantium', weight:28 },
  { name:'Mythril',    weight:22 }, { name:'Palladium',  weight:20 },
];
const MYTHIC_RESOURCE_POOL = [
  { name:'Aetherium',   weight:35 }, { name:'Titan Heart', weight:30 },
  { name:'Void Orchid', weight:20 }, { name:'Middlemist',  weight:15 },
];
const MINOR_POTION_POOL = [
  { name:'Minor HP Potion',   weight:40 },
  { name:'Minor Mana Potion', weight:35 },
  { name:'Minor Luck Potion', weight:25 },
];
const STANDARD_POTION_POOL = [
  { name:'Standard HP Potion',   weight:40 },
  { name:'Standard Mana Potion', weight:35 },
  { name:'Standard Luck Potion', weight:25 },
];
const GREATER_POTION_POOL = [
  { name:'Greater HP Potion',   weight:40 },
  { name:'Greater Mana Potion', weight:35 },
  { name:'Greater Luck Potion', weight:25 },
];

// ---- Loot table: Dark Woodlands — by level zone (no grade labels) ----
// Non-Dark-Woodlands zones still use the grade-keyed tables below
const ZONE_LOOT_TABLES = {
  // Gremlin Hollows — levels 1-20
  // 100% for 20 coins, 5% chance for any common resource
  'Gremlin Hollows': {
    gold: [20, 20],
    slots: [
      { chance:0.05, pool: COMMON_RESOURCE_POOL },
    ],
  },
  // Serpent Mire — levels 21-40
  // 100% for 30 coins, 10% common resource, 3% uncommon resource, 3% E-grade Runestone
  'Serpent Mire': {
    gold: [30, 30],
    slots: [
      { chance:0.10, pool: COMMON_RESOURCE_POOL   },
      { chance:0.03, pool: UNCOMMON_RESOURCE_POOL },
    ],
    bonus: { name:'E-grade Runestone', chance:0.03 },
  },
  // Burrowdeep Basin — levels 41-60
  // 100% for 40 coins, 30% common resource, 5% uncommon resource, 5% E-grade Runestone
  'Burrowdeep Basin': {
    gold: [40, 40],
    slots: [
      { chance:0.30, pool: COMMON_RESOURCE_POOL   },
      { chance:0.05, pool: UNCOMMON_RESOURCE_POOL },
    ],
    bonus: { name:'E-grade Runestone', chance:0.05 },
  },
  // Root Grove — levels 61-80
  // 100% for 50 coins, 50% common, 10% uncommon, 10% E-grade Runestone, 3% D-grade Runestone
  'Root Grove': {
    gold: [50, 50],
    slots: [
      { chance:0.50, pool: COMMON_RESOURCE_POOL   },
      { chance:0.10, pool: UNCOMMON_RESOURCE_POOL },
    ],
    bonus:     { name:'E-grade Runestone', chance:0.10 },
    rareBonus: { name:'D-grade Runestone', chance:0.03 },
  },
  // Crimson Fang — levels 81-100
  // 100% for 50 coins, 50% common, 30% uncommon, 30% E-grade Runestone, 5% D-grade Runestone
  'Crimson Fang': {
    gold: [50, 50],
    slots: [
      { chance:0.50, pool: COMMON_RESOURCE_POOL   },
      { chance:0.30, pool: UNCOMMON_RESOURCE_POOL },
    ],
    bonus:     { name:'E-grade Runestone', chance:0.30 },
    rareBonus: { name:'D-grade Runestone', chance:0.05 },
  },
};

// ---- Loot table: each grade is an array of independent drop slots ----
const LOOT_TABLES = {
  E: {
    slots: [
      { chance:0.30, pool: COMMON_RESOURCE_POOL },  // 30% any common resource
      { chance:0.10, pool: MINOR_POTION_POOL    },  // 10% any minor potion
    ],
  },
  D: {
    slots: [
      { chance:0.50, pool: COMMON_RESOURCE_POOL   },  // 50% any common resource
      { chance:0.30, pool: UNCOMMON_RESOURCE_POOL },  // 30% any uncommon resource
      { chance:0.30, pool: MINOR_POTION_POOL      },  // 30% any minor potion
    ],
  },
  C: {
    slots: [
      { chance:1.00, pool: COMMON_RESOURCE_POOL   },  // 100% any common resource
      { chance:0.50, pool: UNCOMMON_RESOURCE_POOL },  // 50% any uncommon resource
      { chance:0.10, pool: RARE_RESOURCE_POOL     },  // 10% any rare resource
      { chance:0.10, pool: STANDARD_POTION_POOL   },  // 10% any standard potion
    ],
  },
  B: {
    slots: [
      { chance:1.00, pool: UNCOMMON_RESOURCE_POOL  },  // 100% any uncommon resource
      { chance:0.50, pool: RARE_RESOURCE_POOL      },  // 50% any rare resource
      { chance:0.05, pool: LEGENDARY_RESOURCE_POOL },  // 5% any legendary resource
      { chance:0.30, pool: STANDARD_POTION_POOL    },  // 30% any standard potion
    ],
  },
  A: {
    slots: [
      { chance:1.00, pool: RARE_RESOURCE_POOL      },  // 100% any rare resource
      { chance:0.30, pool: LEGENDARY_RESOURCE_POOL },  // 30% any legendary resource
      { chance:0.10, pool: GREATER_POTION_POOL     },  // 10% any greater potion
    ],
  },
  S: {
    slots: [
      { chance:0.50, pool: LEGENDARY_RESOURCE_POOL },  // 50% any legendary resource
      { chance:0.10, pool: MYTHIC_RESOURCE_POOL    },  // 10% any mythic resource
      { chance:0.30, pool: GREATER_POTION_POOL     },  // 30% any greater potion
    ],
  },
};

function _rollWeightedItem(pool) {
  const total = pool.reduce((s, i) => s + i.weight, 0);
  let roll = Math.random() * total;
  for (const item of pool) {
    roll -= item.weight;
    if (roll <= 0) return item.name;
  }
  return pool[0].name;
}

function _rollDrops(grade, zoneName) {
  // Use zone-specific loot table if available (e.g. Dark Woodlands zones)
  const zoneTable = zoneName && ZONE_LOOT_TABLES[zoneName];
  let goldRange, tableSlots, bonusDrop, rareBonusDrop;

  if (zoneTable) {
    goldRange     = zoneTable.gold || [18, 22];
    tableSlots    = zoneTable.slots || [];
    bonusDrop     = zoneTable.bonus     || null;
    rareBonusDrop = zoneTable.rareBonus || null;
  } else {
    const band = zoneName && ZONE_LEVEL_BAND[zoneName];
    goldRange  = (band && LEVEL_BAND_STATS[band]?.gold) || MONSTER_GOLD_LOCAL[grade] || [20,30];
    tableSlots = (LOOT_TABLES[grade] || LOOT_TABLES.E).slots || [];
    bonusDrop  = null;
    rareBonusDrop = null;
  }

  // Spriglet companion: +5% gold drop
  const spriglet = (_charData?.companion?.name || '').toLowerCase() === 'spriglet' ? 1.05 : 1;
  const gold = Math.round(_randInt(goldRange[0], goldRange[1]) * spriglet);

  // Luck potion multiplier boosts item drop chances
  const luckMult = _getLuckMult(_charData);
  // Fairy/Spirit race: +10% luck
  const raceR = (_charData?.race || '').toLowerCase();
  const raceLuck = (raceR.includes('fairy') || raceR.includes('spirit')) ? 1.10 : 1;
  const totalLuck = luckMult * raceLuck;

  const table = LOOT_TABLES[grade] || LOOT_TABLES.E;
  const items = [];

  // Roll each drop slot independently; pick one item from that slot's pool
  for (const slot of tableSlots) {
    const adjustedChance = Math.min(1, slot.chance * totalLuck);
    if (Math.random() < adjustedChance) {
      const name = _rollWeightedItem(slot.pool);
      // Avoid exact duplicates across slots
      if (!items.find(i => i.name === name)) {
        items.push({ name, qty: 1, type: getItemType(name) });
      }
    }
  }

  // Zone-level bonus drop (e.g. Runestone Fragment for Dark Woodlands)
  if (bonusDrop && Math.random() < Math.min(0.50, bonusDrop.chance * totalLuck)) {
    items.push({ name: bonusDrop.name, qty: 1, type: getItemType(bonusDrop.name) });
  }
  if (rareBonusDrop && Math.random() < Math.min(0.30, rareBonusDrop.chance * totalLuck)) {
    items.push({ name: rareBonusDrop.name, qty: 1, type: getItemType(rareBonusDrop.name) });
  }


  // Sah'run blessing: X% chance to also drop a random forge material
  if (_charData?.deity === "Sah'run") {
    const sahPct = _getFaithBlessingPct(_charData);
    if (Math.random() < sahPct) {
      const forgeMats = ['Iron','Copper','Tin','Silver','Bronze','Gold','Mythril','Titanium','Adamantium'];
      const mat = forgeMats[Math.floor(Math.random() * forgeMats.length)];
      items.push({ name: mat, qty: 1, type: 'material' });
    }
  }

  // Elionidas blessing: X% chance to find bonus precious loot
  if (_charData?.deity === 'Elionidas') {
    const elionPct = _getFaithBlessingPct(_charData);
    if (Math.random() < elionPct) {
      const preciousPool = ['Ancient Rune','Magic Crystal','Dragon Scales','Cyclops Eye','Phoenix Bloom','Adamantium','Titanium'];
      const bonus = preciousPool[Math.floor(Math.random() * preciousPool.length)];
      items.push({ name: bonus, qty: 1, type: getItemType(bonus) });
    }
  }

  return { gold, items };
}
 
// ── Returns the display level (1-100 within current rank) ──
function _displayLevel(level) {
  return ((level - 1) % 100) + 1;
}

function _processExp(xp, xpMax, level, rank, gain, charClass) {
  const RANK_ORDER_L = ["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"];
  const rankIdx = Math.max(0, RANK_ORDER_L.indexOf(rank));
  let newXp = xp + gain, newLevel = level, newRank = rank, newXpMax = xpMax, leveledUp = false;

  // Each rank spans exactly 100 levels. The level cap for the current rank is rankIdx*100 + 100.
  // Players must ascend manually (via doRankAscension) — XP gain NEVER auto-promotes rank.
  const rankLevelCap = (rankIdx + 1) * 100;

  let xpOverflow = 0;
  while (newXp >= newXpMax) {
    // Hard stop at the rank's level cap — don't level up past it until the player ascends.
    // Clamp to xpMax (full bar shown) and store the overflow for after ascension.
    if (newLevel >= rankLevelCap) {
      xpOverflow = newXp - newXpMax; // carry remainder; ascension will consume it
      newXp = newXpMax;              // show bar as full (xp === xpMax = ascension ready)
      break;
    }
    newXp -= newXpMax; newLevel++; leveledUp = true;
    // Recalculate xpMax for the new level within the same rank (rank never changes here)
    newXpMax = _calcXpMax(rankIdx, newLevel);
  }
  return { newXp, newLevel, newRank, newXpMax, leveledUp, xpOverflow };
}
 
async function _clientStartBattle(grade, zoneName=null, existingMonster=null) {
  const char = _charData;
  const monster = existingMonster || _generateMonster(grade, zoneName);
  const state = {
    grade, monster,
    playerHp:   char.hp   ?? char.hpMax   ?? 100,
    playerMana: char.mana ?? char.manaMax ?? 50,
    turn: 1, status: "active",
  };
  // Save to Firestore so battleTurn can pick it up
  await setDoc(doc(db, "battles", auth.currentUser.uid), {
    ...state, uid: auth.currentUser.uid,
    log: [`⚔️ You encountered a ${monster.name}! ${monster.levelBand ? '(Lv.' + monster.levelBand + ')' : '(Grade ' + grade + ')'}`],
    startedAt: serverTimestamp ? serverTimestamp() : new Date(),
  });
  return { monster, playerHp: state.playerHp, playerMana: state.playerMana };
}
 
// ── Resolve full effective combat stats for farming/auto-battle ─────────────
// Mirrors _buildFighter but returns only the stats object (str/int/def/dex).
// Applies: equipment bonuses + Dwarf/Titan gear bonus + food buffs + race bonuses + companion bonuses.
function _resolveCombatStats(c) {
  const base  = c.stats || { str:10, int:10, def:10, dex:10 };
  const bonus = _calcEquipBonus(c);   // equipment + Dwarf race gear bonus

  let str = (base.str ?? 10) + (bonus.str || 0);
  let int_ = (base.int ?? 10) + (bonus.int || 0);
  let def  = (base.def ?? 10) + (bonus.def || 0);
  let dex  = (base.dex ?? 10) + (bonus.dex || 0);

  // Active food buffs (timed)
  const now = Date.now();
  const foods = c.activeFoods || {};
  if (foods.str && foods.str.expiry > now) str  = Math.round(str  * (1 + foods.str.pct));
  if (foods.int && foods.int.expiry > now) int_ = Math.round(int_ * (1 + foods.int.pct));
  if (foods.def && foods.def.expiry > now) def  = Math.round(def  * (1 + foods.def.pct));
  if (foods.dex && foods.dex.expiry > now) dex  = Math.round(dex  * (1 + foods.dex.pct));

  // Race bonuses
  const race = (c.race || '').toLowerCase();
  if (race.includes('orc') || race.includes('warlord'))  str  = Math.round(str  * 1.10);
  if (race.includes('undead') || race.includes('lich'))  def  = Math.round(def  * 1.10);

  // Companion bonuses
  const comp = (c.companion?.name || '').toLowerCase();
  if (comp === 'emberling') str  = Math.round(str  * 1.10);
  if (comp === 'pebblin')   def  += 10;
  if (comp === 'zappit')    dex  = Math.round(dex  * 1.10);
  if (comp === 'trackit')   dex  = Math.round(dex  * 1.06);
  if (comp === 'whispling') int_ = Math.round(int_ * 1.10);

  return { str, int: int_, def, dex };
}

async function _clientBattleTurn(action, skillName) {
  const uid  = auth.currentUser.uid;
  const bSnap = await getDoc(doc(db, "battles", uid));
  if (!bSnap.exists()) throw new Error("No active battle.");
  const b = bSnap.data();
  if (b.status !== "active") {
    // Stale battle doc — reset it so the player can start fresh
    await setDoc(doc(db, "battles", uid), { status: "idle" });
    throw new Error("No active battle. Please fight again.");
  }

  const char   = _charData;
  // ── Resolve full effective stats (equipment + race + food + companion) ──
  const stats  = _resolveCombatStats(char);
  const log    = [];
  let { playerHp, playerMana, monster } = b;
  const playerHpMax = char.hpMax || 100;

  // ── Flee ──
  if (action === 'flee') {
    const fleeCost = 10;
    const newGold  = Math.max(0, (char.gold || 0) - fleeCost);
    await updateDoc(doc(db, "characters", uid), {
      gold: newGold,
      hp: playerHp,
      mana: playerMana,
    });
    if (char) {
      char.gold = newGold;
      char.hp   = playerHp;
      char.mana = playerMana;
    }
    await updateDoc(doc(db, "battles", uid), { status:"fled" });
    // Sync gold display
    set('stat-gold', newGold);
    set('s-gold', newGold);
    return { status:"fled", message:`You fled! Lost ${fleeCost} gold.` };
  }

  // ── Tick DoT on MONSTER (player-applied debuffs like Bleeding Edge, Poison, etc.) ──
  if (b.dotActive && b.dotTurns > 0) {
    const dotDmg = Math.round((monster.maxHp || monster.hp) * b.dotPct);
    monster.hp = Math.max(0, monster.hp - dotDmg);
    const newTurns = b.dotTurns - 1;
    let dotLogLine = `🩸 ${b.dotLabel||"Bleed"}: ${dotDmg} damage to monster! (${newTurns} turns left)`;
    // Usurper lifesteal: heals player for the same amount
    if (b.dotLifesteal) {
      const healed = Math.min(dotDmg, playerHpMax - playerHp);
      playerHp = Math.min(playerHpMax, playerHp + healed);
      dotLogLine += ` 💚 Lifestealed ${healed} HP!`;
    }
    log.push(dotLogLine);
    await updateDoc(doc(db, "battles", uid), {
      dotActive: newTurns > 0, dotTurns: newTurns, monster
    });
    // If monster dies from DoT, handle victory
    if (monster.hp <= 0) {
      const drops  = _rollDrops(b.grade, b.zoneName || monster?.zoneName);
      const _veilExpBonus = _charData?.deity === 'Veil' ? (1 + _getFaithBlessingPct(_charData)) : 1;
      const expGain = Math.round(((b.zoneName||monster?.zoneName ? LEVEL_BAND_STATS[ZONE_LEVEL_BAND[b.zoneName||monster?.zoneName]]?.exp : null) || MONSTER_EXP_LOCAL[b.grade] || 10) * _getRaceExpMult(_charData?.race) * _getCompanionExpMult(_charData?.companion?.name) * _veilExpBonus * _getExpBuffMult(_charData));
      const inv = [...(char.inventory||[])];
      drops.items.forEach(item => {
        const ex = inv.find(i => i.name === item.name);
        const _isEquip = getItemType(item.name) === 'equipment';
        if (ex && !_isEquip) { ex.qty += item.qty; }
        else { const _ni = {...item}; if (_isEquip) _ni.iid = Math.random().toString(36).slice(2,10)+Date.now().toString(36); inv.push(_ni); }
      });
      const gold = (char.gold||0) + drops.gold;
      const { newXp, newLevel, newRank, newXpMax, leveledUp } = _processExp(char.xp||0, char.xpMax||100, char.level||1, char.rank||'Wanderer', expGain, char.charClass);
      Object.assign(_charData, { gold, inventory: inv, xp: newXp, level: newLevel, rank: newRank, xpMax: newXpMax, hp: playerHp, mana: playerMana });
      await updateDoc(doc(db, "characters", uid), { gold, inventory: inv, xp: newXp, level: newLevel, rank: newRank, xpMax: newXpMax, hp: playerHp, mana: playerMana });
      await updateDoc(doc(db, "battles", uid), { status:"victory" });
      const updates = {};
      log.push(`💀 ${monster.name} defeated by ${b.dotLabel||"DoT"}! +${expGain} EXP, +${drops.gold} gold`);
      return { status:"victory", log, updates, drops, expGain, leveledUp, newLevel, newRank };
    }
  }

  // ── Tick HoT ──
  if (b.hotActive && b.hotTurns > 0) {
    const hotHeal = Math.round(playerHpMax * b.hotPct);
    playerHp = Math.min(playerHpMax, playerHp + hotHeal);
    const newTurns = b.hotTurns - 1;
    log.push(`💚 Regeneration: +${hotHeal} HP! (${newTurns} turns left)`);
    await updateDoc(doc(db, "battles", uid), {
      hotActive: newTurns > 0, hotTurns: newTurns
    });
  }

  // ── Player action ──
  let battleUpdates = {};


  if (action === 'melee') {
    const primary    = _getPrimaryStat(char.charClass, stats);
    // defBreak (Abyssal-touch) reduces monster DEF by defBreakAmt before applying
    const defBreakFactor = b.defBreak ? (1 - (b.defBreakAmt || 0)) : 1;
    // Diminishing-returns mitigation: def never fully blocks (matches duel.js formula)
    const rawEffDef = Math.floor(monster.def * defBreakFactor);
    const defRatioM = rawEffDef / (rawEffDef + 50);
    let dmg = Math.max(1, Math.round(primary * (1 - defRatioM)));
    if (b.defBreak) { battleUpdates.defBreak = false; battleUpdates.defBreakAmt = 0; }  // consume defBreak after 1 hit
    // Death Mark
    if (b.deathMark) { dmg = Math.round(dmg * (1 + (b.deathMarkBonus || 0.60))); battleUpdates.deathMark = false; log.push(`☠️ Death Mark triggered!`); }
    monster.hp = Math.max(0, monster.hp - dmg);
    log.push(`⚔️ You attack for ${dmg} damage.`);
    // --- Instant monster HP bar update ---
    if (typeof updateBattleBars === 'function') {
      updateBattleBars(
        monster.hp, monster.maxHp || _currentBattle?.monster?.maxHp || monster.hp,
        playerHp,   char.hpMax||100,
        playerMana, char.manaMax||50
      );
    }

  } else if (action === 'skill' && skillName) {
    const sk = SKILL_DATA[skillName];
    if (!sk) { log.push(`❓ Unknown skill.`); }
    else {
      // Mana check
      if (sk.mana > playerMana) {
        return { status:"ongoing", log:[`🔵 Not enough mana for ${skillName}! (need ${sk.mana}, have ${playerMana})`], playerHp, playerMana, monster };
      }
      playerMana = Math.max(0, playerMana - sk.mana);
      const result = _applySkill(skillName, playerHp, playerMana, playerHpMax, monster, stats, b);
      playerHp   = result.playerHp;
      playerMana = result.playerMana;
      monster.hp = result.monsterHp;
      Object.assign(battleUpdates, result.updates);
      result.log.forEach(l => log.push(l));
      // --- Instant monster HP bar update after skill ---
      if (typeof updateBattleBars === 'function') {
        updateBattleBars(
          monster.hp, monster.maxHp || _currentBattle?.monster?.maxHp || monster.hp,
          playerHp,   char.hpMax||100,
          playerMana, char.manaMax||50
        );
      }
    }
  }

  log.push(`👹 Monster HP: ${monster.hp} / ${monster.maxHp}`);
  const activeState = { ...b, ...battleUpdates };

  // ── Summon tick ──
  if (activeState.summonActive && activeState.summonTurns > 0) {
    const intWithBuff = Math.round((stats.int || 10) * (1 + (activeState.buff_int || 0)));
    const sumDmg   = Math.round(intWithBuff * (activeState.summonDmgPct || 0.40));
    monster.hp     = Math.max(0, monster.hp - sumDmg);
    const newTurns = activeState.leviathanSummoned ? activeState.summonTurns : activeState.summonTurns - 1;
    battleUpdates.summonActive = newTurns > 0;
    battleUpdates.summonTurns  = newTurns;
    const label = activeState.leviathanSummoned ? 'Leviathan' : 'Summon';
    log.push(`🐉 ${label} attacks for ${sumDmg}!${!activeState.leviathanSummoned ? ` (${newTurns} turns left)` : ''}`);
  }

  // ── Victory ──
  if (monster.hp <= 0) {
    const drops  = _rollDrops(b.grade, b.zoneName || monster?.zoneName);
    const _veilExpBonus = _charData?.deity === 'Veil' ? (1 + _getFaithBlessingPct(_charData)) : 1;
        const expGain = Math.round(((b.zoneName||monster?.zoneName ? LEVEL_BAND_STATS[ZONE_LEVEL_BAND[b.zoneName||monster?.zoneName]]?.exp : null) || MONSTER_EXP_LOCAL[b.grade] || 10) * _getRaceExpMult(_charData?.race) * _getCompanionExpMult(_charData?.companion?.name) * _veilExpBonus * _getExpBuffMult(_charData));
    const inv = [...(char.inventory||[])];
    drops.items.forEach(item => {
      const ex = inv.find(i => i.name === item.name);
      const _isEquip = getItemType(item.name) === 'equipment';
      if (ex && !_isEquip) { ex.qty += item.qty; }
      else { const _ni = {...item}; if (_isEquip) _ni.iid = Math.random().toString(36).slice(2,10)+Date.now().toString(36); inv.push(_ni); }
    });
    const { newXp, newLevel, newRank, newXpMax, leveledUp } = _processExp(
      char.xp||0, char.xpMax||100, char.level||1, char.rank||"Wanderer", expGain, char.charClass
    );
    const updates = {
      hp: playerHp, mana: playerMana,
      gold: (char.gold||0) + drops.gold,
      inventory: inv, xp:newXp, xpMax:newXpMax,
      level: newLevel, rank:newRank,
    };
    if (leveledUp) {
      updates.statPoints = (char.statPoints||0)+3;
      updates.hpMax      = (char.hpMax||100)+10;
      updates.manaMax    = (char.manaMax||50)+5;
    }
    // Award companion EXP for battle victory
    let companionExpMsg = '';
    if (char.companion) {
      const COMPANION_EXP_TABLE = [0, 1000, 1800, 3000, 4200, 5700, 7000, 9600, 12000, 15000];
      let companionLevel = char.companionLevel || 1;
      let companionExp   = char.companionExp   || 0;
      let companionXpMax = COMPANION_EXP_TABLE[companionLevel-1] || 1000;
      let companionLeveledUp = false;
      // Award based on monster grade
      const compExpGain = { E:10, D:25, C:60, B:150, A:400, S:1000 }[b.grade] || 10;
      companionExp += compExpGain;
      while (companionLevel < 10 && companionExp >= companionXpMax) {
        companionExp -= companionXpMax;
        companionLevel++;
        companionXpMax = COMPANION_EXP_TABLE[companionLevel-1] || companionXpMax;
        companionLeveledUp = true;
      }
      updates.companionExp = companionExp;
      updates.companionLevel = companionLevel;
      companionExpMsg = `🐾 Companion gained ${compExpGain} EXP!`;
      if (companionLeveledUp) companionExpMsg += ` 🆙 Companion leveled up to Lv.${companionLevel}!`;
      log.push(companionExpMsg);
    }
    log.push(`💀 ${monster.name} defeated!`);
    log.push(`💰 +${drops.gold} gold · ⭐ +${expGain} EXP`);
    if (leveledUp) log.push(`🎉 LEVEL UP! ${newRank} Level ${_displayLevel(newLevel)}!`);
    await updateDoc(doc(db, "characters", uid), updates);
    // Sync in-memory charData so HP bar updates immediately without full refresh
    Object.assign(_charData, updates);
    window._allInvItems = updates.inventory || _charData.inventory;
    await updateDoc(doc(db, "battles", uid), { status:"victory" });
    const isElite = ["B","A","S"].includes(b.grade);
    await _incrementQuest("kill", 1);
    if (isElite) await _incrementQuest("eliteKill", 1);
    // Track zone kill count for pool system
    const _manualZone = window._currentBattleZone || null;
    if (_manualZone) await window._recordZoneKill(_manualZone, b.grade);
    logActivity('⚔️', `<b>Defeated ${monster.name}</b>${isElite ? ' <span style="color:#e8d070">[Elite]</span>' : ''} · +${drops.gold}💰 +${expGain} EXP`, isElite ? '#e8d070' : '#e05555');
    return { status:"victory", log, updates, drops, expGain, leveledUp, newLevel, newRank };
  }

  // ── Monster turn (skip if stunned; skill-locked means it can only melee) ──
  const isStunned     = activeState.monsterStunned;
  const isSkillLocked = activeState.monsterSkillLocked;
  if (isStunned) {
    log.push(`💫 Monster is stunned — skips their turn!`);
    battleUpdates.monsterStunned = false;
  } else {
    const _monDefMit = Math.min(Math.floor((stats.def||10) * 0.3), Math.floor(monster.atk * 0.75));
    const buffDefFactor = activeState.buff_def ? (1 + activeState.buff_def) : 1;
    let monDmg = Math.max(Math.ceil(monster.atk * 0.25), Math.round((monster.atk - _monDefMit) / buffDefFactor));
    if (isSkillLocked) {
      monDmg = Math.max(1, Math.round(monDmg * 0.50));
      battleUpdates.monsterSkillLocked = false;
      log.push(`🔇 Monster's skills are locked — basic attack only!`);
    }
    if (activeState.shieldPct) {
      const blocked = Math.round(monDmg * activeState.shieldPct);
      monDmg = Math.max(0, monDmg - blocked);
      battleUpdates.shieldPct = 0;
      log.push(`🛡️ Shield absorbed ${blocked} damage!`);
    }
    // Dragonborn/Elder Dragon: 10%/20% magic resistance (applied as flat damage reduction)
    const _race = (char.race || '').toLowerCase();
    if (_race.includes('elder dragon')) monDmg = Math.round(monDmg * 0.80);
    else if (_race.includes('dragonborn')) monDmg = Math.round(monDmg * 0.90);
    playerHp = Math.max(0, playerHp - monDmg);
    log.push(`👹 Monster attacks for ${monDmg}. Your HP: ${playerHp}`);
  }

  // ── Defeat ──
  if (playerHp <= 0) {
    // FIXED: Was a raw updateDoc with `char.inventory` (stale snapshot).
    // If a reward write was queued (e.g. from the killing blow), it could fire
    // after this and restore the full inventory, bypassing the death penalty.
    // Now we run a transaction that reads the CURRENT server inventory and
    // halves it atomically, so no interleaved write can sneak between.
    const resurrectAt = new Date(Date.now() + 5*60*60*1000);
    let halfInv;
    const charRef = doc(db, 'characters', uid);
    await runTransaction(db, async tx => {
      const snap = await tx.get(charRef);
      const freshInv = snap.exists() ? (snap.data().inventory || []) : (char.inventory || []);
      halfInv = freshInv.map(item => ({ ...item, qty: Math.max(1, Math.floor((item.qty ?? 1) / 2)) }));
      tx.update(charRef, { hp: 0, inventory: halfInv, resurrectAt, isDead: true });
    });
    Object.assign(_charData, { hp:0, inventory:halfInv, resurrectAt, isDead:true });
    window._allInvItems = halfInv;
    await updateDoc(doc(db, "battles", uid), { status:"defeat" });
    log.push("💀 You were defeated!");
    return { status:"defeat", log, resurrectAt: resurrectAt.toISOString() };
  }

  // ── Ongoing — save state ──
  await updateDoc(doc(db, "battles", uid), {
    playerHp, playerMana, monster,
    turn: (b.turn||1)+1,
    ...battleUpdates,
  });
  return { status:"ongoing", log, playerHp, playerMana, monster };
}
 
async function _clientAutoBattle(grade, maxTurns=15, zoneName=null) {
  const uid  = auth.currentUser.uid;
  const char = _charData;
  const stats = _resolveCombatStats(char);
  const primary = _getPrimaryStat(char.charClass, stats);
  const monster = _generateMonster(grade, zoneName);
  const log = [`⚔️ Auto-battle started vs ${monster.name}!`];
  let playerHp   = char.hp   ?? char.hpMax   ?? 100;
  let playerMana = char.mana ?? char.manaMax ?? 50;
  const playerHpMax = char.hpMax || 100;
  let monHp = monster.hp;
  let status = "ongoing", turn = 0;

  // Skills available to this class
  const classSkills = (BATTLE_SKILLS[char.charClass] || [])
    .map(n => ({ name: n, ...(SKILL_DATA[n] || {}) }))
    .filter(s => s.type); // only known skills
  let skillIdx = 0;
  let battleState = {}; // tracks buffs/DoT/debuffs across turns

  while (turn < maxTurns && monHp > 0 && playerHp > 0) {
    // ── Tick DoT on monster ──
    if (battleState.dotActive && battleState.dotTurns > 0) {
      const dotDmg = Math.round((monster.maxHp || monster.hp) * (battleState.dotPct || 0.10));
      monHp = Math.max(0, monHp - dotDmg);
      battleState.dotTurns--;
      if (battleState.dotTurns <= 0) battleState.dotActive = false;
      if (battleState.dotLifesteal) playerHp = Math.min(playerHpMax, playerHp + dotDmg);
      log.push(`🩸 ${battleState.dotLabel||'Poison'}: ${dotDmg} dmg to monster!`);
      if (monHp <= 0) { status = 'victory'; break; }
    }

    // Pick action: try next affordable skill, else melee
    let dmg = 0;
    let usedSkill = null;

    // Find next affordable skill (rotate through list, allow all types)
    for (let i = 0; i < classSkills.length; i++) {
      const sk = classSkills[(skillIdx + i) % classSkills.length];
      if ((sk.mana || 0) <= playerMana) {
        usedSkill = sk;
        skillIdx  = (skillIdx + i + 1) % classSkills.length;
        break;
      }
    }

    if (usedSkill) {
      // Use the real skill engine for effect
      const result = _applySkill(usedSkill.name, playerHp, playerMana, playerHpMax, monster, stats, battleState);
      playerHp   = result.playerHp;
      playerMana = result.playerMana;
      monHp      = result.monsterHp;
      Object.assign(battleState, result.updates);
      const dmgLabel = result.playerDmg > 0 ? `${result.playerDmg} dmg` : 'applied';
      log.push(`✨ Turn ${turn+1}: ${usedSkill.name} — ${dmgLabel}. MP: ${playerMana}`);
    } else {
      // Diminishing-returns mitigation (same as manual fight)
      const _abDefRatio = (monster.def||1) / ((monster.def||1) + 50);
      dmg = Math.max(1, Math.round(primary * (1 - _abDefRatio)));
      monHp = Math.max(0, monHp - dmg);
      log.push(`⚔️ Turn ${turn+1}: Melee — ${dmg} dmg.`);
    }

    if (monHp <= 0) { status="victory"; break; }

    const _mit2 = Math.min(Math.floor((stats.def||10) * 0.3), Math.floor(monster.atk * 0.75));
    const mdmg = Math.max(Math.ceil(monster.atk * 0.25), monster.atk - _mit2);
    playerHp = Math.max(0, playerHp - mdmg);
    log.push(`👹 Monster: ${mdmg} dmg. HP: ${playerHp}`);
    if (playerHp <= 0) { status="defeat"; break; }
    turn++;
  }

  const updates = { hp: playerHp, mana: playerMana };
  if (status === "victory") {
    const drops   = _rollDrops(grade, zoneName);
    const _veilExpBonus2 = _charData?.deity === 'Veil' ? (1 + _getFaithBlessingPct(_charData)) : 1;
    const expGain = Math.round(((zoneName ? LEVEL_BAND_STATS[ZONE_LEVEL_BAND[zoneName]]?.exp : null) || MONSTER_EXP_LOCAL[grade] || 10) * _getRaceExpMult(_charData?.race) * _getCompanionExpMult(_charData?.companion?.name) * _veilExpBonus2 * _getExpBuffMult(_charData));
    const inv = [...(char.inventory||[])];
    drops.items.forEach(item => {
      const ex = inv.find(i => i.name === item.name);
      const _isEquip = getItemType(item.name) === 'equipment';
      if (ex && !_isEquip) { ex.qty += item.qty; }
      else { const _ni = {...item}; if (_isEquip) _ni.iid = Math.random().toString(36).slice(2,10)+Date.now().toString(36); inv.push(_ni); }
    });
    const { newXp, newLevel, newRank, newXpMax, leveledUp } = _processExp(
      char.xp||0, char.xpMax||100, char.level||1, char.rank||"Wanderer", expGain, char.charClass
    );
    Object.assign(updates, { gold:(char.gold||0)+drops.gold, inventory:inv, xp:newXp, xpMax:newXpMax, level:newLevel, rank:newRank });
    if (leveledUp) { updates.statPoints=(char.statPoints||0)+3; updates.hpMax=(char.hpMax||100)+10; updates.manaMax=(char.manaMax||50)+5; }
    // Award companion EXP for auto-battle victory
    let companionExpMsg = '';
    if (char.companion) {
      const COMPANION_EXP_TABLE = [0, 1000, 1800, 3000, 4200, 5700, 7000, 9600, 12000, 15000];
      let companionLevel = char.companionLevel || 1;
      let companionExp   = char.companionExp   || 0;
      let companionXpMax = COMPANION_EXP_TABLE[companionLevel-1] || 1000;
      let companionLeveledUp = false;
      // Award based on monster grade
      const compExpGain = { E:10, D:25, C:60, B:150, A:400, S:1000 }[grade] || 10;
      companionExp += compExpGain;
      while (companionLevel < 10 && companionExp >= companionXpMax) {
        companionExp -= companionXpMax;
        companionLevel++;
        companionXpMax = COMPANION_EXP_TABLE[companionLevel-1] || companionXpMax;
        companionLeveledUp = true;
      }
      updates.companionExp = companionExp;
      updates.companionLevel = companionLevel;
      companionExpMsg = `🐾 Companion gained ${compExpGain} EXP!`;
      if (companionLeveledUp) companionExpMsg += ` 🆙 Companion leveled up to Lv.${companionLevel}!`;
      log.push(companionExpMsg);
    }
    log.push(`💀 ${monster.name} defeated!`);
    log.push(`💰 +${drops.gold} gold · ⭐ +${expGain} EXP`);
    if (leveledUp) log.push(`🎉 LEVEL UP! ${newRank} Level ${_displayLevel(newLevel)}!`);
    await updateDoc(doc(db, "characters", uid), updates);
    const isElite = ["B","A","S"].includes(grade);
    await _incrementQuest("kill", 1);
    if (isElite) await _incrementQuest("eliteKill", 1);
    // Track zone kill count for pool system
    if (zoneName) await window._recordZoneKill(zoneName, grade);
    logActivity('⚔️', `<b>Defeated ${monster.name}</b>${isElite ? ' <span style="color:#e8d070">[Elite]</span>' : ''} · +${drops.gold}💰 +${expGain} EXP`, isElite ? '#e8d070' : '#e05555');
    return { status:"victory", log, updates, drops, expGain, leveledUp, newLevel, newRank };
  } else if (status === "defeat") {
    const halfInv = (char.inventory||[]).map(item => ({ ...item, qty: Math.max(1, Math.floor((item.qty ?? 1) / 2)) }));
    const resurrectAt = new Date(Date.now() + 5*60*60*1000);
    Object.assign(updates, { hp:0, inventory:halfInv, resurrectAt, isDead:true });
    log.push("💀 You were defeated in auto-battle!");
    await updateDoc(doc(db, "characters", uid), updates);
    return { status:"defeat", log, resurrectAt: resurrectAt.toISOString() };
  } else {
    await updateDoc(doc(db, "characters", uid), updates);
    return { status:"ongoing", log, playerHp, playerMana };
  }
}
 
// ═══════════════════════════════════════════════════
//  SKILL ENGINE
// ═══════════════════════════════════════════════════

// Full skill data: mana costs + effect descriptors
const SKILL_DATA = {
  // ── Warrior ──
  "Cleave":            { mana:0,  type:"damage",      mult:1.05, stat:"str" },
  "Battle Cry":        { mana:10, type:"buff",         stat:"str",  buffMult:0.20 },
  "Crushing Blow":     { mana:0,  type:"damage",      mult:1.10, stat:"str", defPen:0.10 },
  "War Stomp":         { mana:0,  type:"stun",         mult:1.00, stat:"str" },
  "Bleeding Edge":     { mana:20, type:"dot",          dotPct:0.15, dotTurns:3, dotLabel:"Bleed", stat:"str" },
  "Iron Momentum":     { mana:20, type:"buff",         stat:"str",  buffMult:0.30 },
  "Blood Gamble":      { mana:25, type:"sacrificial",  selfHpCost:0.15, buffStat:"str", buffMult:0.50 },
  "Titan Breaker":     { mana:50, type:"damage",      mult:1.70, stat:"str", defPen:0.50 },
  "Berserker's Oath":  { mana:40, type:"sacrificial",  selfHpCost:0.25, buffStat:"str", buffMult:0.60, buffStat2:"dex", buffMult2:0.20 },
  "War God's Fury":    { mana:50, type:"buff",         stat:"str",  buffMult:0.80 },
  // ── Guardian ──
  "Shield Bash":       { mana:0,  type:"stun",         mult:1.00, stat:"def" },
  "Fortify":           { mana:10, type:"buff",         stat:"def",  buffMult:0.20 },
  "Iron Guard":        { mana:0,  type:"shield",       shieldPct:0.15 },
  "Stone Skin":        { mana:25, type:"buff",         stat:"def",  buffMult:0.40 },
  "Reinforced Core":   { mana:20, type:"hot",          hotPct:0.10, hotTurns:3 },
  "Taunting Roar":     { mana:20, type:"skillock" },
  "Pain Conversion":   { mana:25, type:"sacrificial",  selfHpCost:0.20, buffStat:"def", buffMult:0.50 },
  "Aegis of Eternity": { mana:40, type:"hpbuff",       hpMult:0.50 },
  "Colossus Form":     { mana:50, type:"buff",         stat:"def",  buffMult:0.60, hpBonus:0.30 },
  "Unbreakable Will":  { mana:50, type:"cleanse" },
  // ── Arcanist ──
  "Arcane Bolt":       { mana:5,  type:"damage",      mult:1.05, stat:"int" },
  "Mana Pulse":        { mana:0,  type:"damage",      mult:1.00, stat:"int" },
  "Robust Mind":       { mana:10, type:"buff",         stat:"int",  buffMult:0.20 },
  "Astral Lance":      { mana:25, type:"damage",      mult:1.40, stat:"int" },
  "Mind Burn":         { mana:20, type:"dot",          dotPct:0.15, dotTurns:3, dotLabel:"Mind Burn", stat:"int" },
  "Echo-strike":       { mana:25, type:"echo" },
  "Rune Sacrifice":    { mana:20, type:"sacrificial",  selfHpCost:0.20, buffStat:"int", buffMult:0.50 },
  "Meteorfall":        { mana:50, type:"damage",      mult:1.80, stat:"int" },
  "Arcane Shower":     { mana:50, type:"buff",         stat:"int",  buffMult:0.80 },
  "Hex":               { mana:50, type:"dot",          dotPct:0.05, dotTurns:5, dotLabel:"Hex Curse", stat:"int" },
  // ── Hunter ──
  "Pierce":            { mana:0,  type:"damage",      mult:1.05, stat:"dex" },
  "Hunter's Poison":   { mana:10, type:"dot",          dotPct:0.10, dotTurns:3, dotLabel:"Poison", stat:"dex" },
  "Quick Shot":        { mana:0,  type:"priority" },
  "Split Arrow":       { mana:20, type:"dot",          dotPct:0.15, dotTurns:3, dotLabel:"Bleeding", stat:"dex" },
  "Ensnare":           { mana:0,  type:"stun",         mult:0.80, stat:"dex" },
  "Falcon Sight":      { mana:20, type:"buff",         stat:"dex",  buffMult:0.30 },
  "Vital Shot":        { mana:0,  type:"damage",      mult:1.35, stat:"dex" },
  "Slayer":            { mana:0,  type:"damage",      mult:1.70, stat:"dex" },
  "Predator's Instinct":{ mana:40, type:"buff",        stat:"dex",  buffMult:0.60 },
  "Executioner":       { mana:50, type:"execute",     mult:2.00, stat:"dex", threshold:0.40 },
  // ── Assassin ──
  "Backstab":          { mana:0,  type:"backstab",    mult:1.20, multAfter:1.10, stat:"dex" },
  "Scorching Blade":   { mana:10, type:"dot",          dotPct:0.15, dotTurns:3, dotLabel:"Burn", stat:"dex" },
  "Shadow Step":       { mana:5,  type:"priority" },
  "Thunder Strike":    { mana:0,  type:"damage",      mult:1.35, stat:"dex" },
  "Venom Surge":       { mana:20, type:"dot",          dotPct:0.15, dotTurns:3, dotLabel:"Poison", stat:"dex" },
  "Trickster":         { mana:20, type:"cleanse" },
  "Blood Pact":        { mana:25, type:"sacrificial",  selfHpCost:0.15, buffStat:"dex", buffMult:0.50 },
  "Death Mark":        { mana:40, type:"debuff",       debuffType:"deathmark", dmgBonus:0.60 },
  "Phantom Assault":   { mana:50, type:"multihit",    hits:3,  multPerHit:0.65, stat:"dex" },
  "Predator":          { mana:50, type:"condDamage",  mult:2.00, stat:"dex", condDebuff:true },
  // ── Cleric ──
  "Healing Light":     { mana:10, type:"heal",         healPct:0.15 },
  "Sacred Spark":      { mana:5,  type:"damage",      mult:1.05, stat:"int" },
  "Neptune's Embrace": { mana:15, type:"buff",         stat:"all",  buffMult:0.20 },
  "Divine Barrier":    { mana:25, type:"shield",       shieldPct:0.80 },
  "Purify":            { mana:25, type:"cleanse" },
  "Radiant Pulse":     { mana:20, type:"hot",          hotPct:0.10, hotTurns:3 },
  "Life Exchange":     { mana:20, type:"sacrificial",  selfHpCost:0.15, buffStat:"all", buffMult:0.20 },
  "Sanctuary":         { mana:40, type:"hpbuff",       hpMult:0.50 },
  "Divine Ascension":  { mana:50, type:"buff",         stat:"all",  buffMult:0.60 },
  "Lazarus":           { mana:50, type:"heal",         healPct:0.50 },
  // ── Summoner ──
  "Lashing":           { mana:5,  type:"damage",      mult:1.05, stat:"int" },
  "Soul Bind":         { mana:10, type:"stun",         mult:1.00, stat:"int" },
  "Essence Sap":       { mana:10, type:"dot",          dotPct:0.10, dotTurns:4, dotLabel:"Essence Drain", stat:"int" },
  "Beastmaster":       { mana:25, type:"summon",       summonDmgPct:0.40, summonTurns:3 },
  "Beast Empowerment": { mana:25, type:"summonbuff",   summonBuffMult:0.30 },
  "Usurper":           { mana:25, type:"dot",          dotPct:0.05, dotTurns:4, dotLabel:"Life Sap", lifesteal:true, stat:"int" },
  "Offering":          { mana:20, type:"offering",     healPct:0.20 },  // sacrifices one summon for HP
  "Leviathan":         { mana:50, type:"summon",       summonDmgPct:1.20, stat:"int", unique:true },
  "Abyssal-touch":     { mana:50, type:"debuff",       debuffType:"defbreak", defReduce:0.40 },
  "Profane Lord":      { mana:50, type:"profanelord", mult:2.00, stat:"int" },
};

// Skills per class for in-battle menu (keep for menu building)
const BATTLE_SKILLS = {
  Warrior:  ["Cleave","Battle Cry","Crushing Blow","War Stomp","Bleeding Edge","Iron Momentum","Blood Gamble","Titan Breaker","Berserker's Oath","War God's Fury"],
  Guardian: ["Shield Bash","Fortify","Iron Guard","Stone Skin","Reinforced Core","Taunting Roar","Pain Conversion","Aegis of Eternity","Colossus Form","Unbreakable Will"],
  Arcanist: ["Arcane Bolt","Mana Pulse","Robust Mind","Astral Lance","Mind Burn","Echo-strike","Rune Sacrifice","Meteorfall","Arcane Shower","Hex"],
  Hunter:   ["Pierce","Hunter's Poison","Quick Shot","Split Arrow","Ensnare","Falcon Sight","Vital Shot","Slayer","Predator's Instinct","Executioner"],
  Assassin: ["Backstab","Scorching Blade","Shadow Step","Thunder Strike","Venom Surge","Trickster","Blood Pact","Death Mark","Phantom Assault","Predator"],
  Cleric:   ["Healing Light","Sacred Spark","Neptune's Embrace","Divine Barrier","Purify","Radiant Pulse","Life Exchange","Sanctuary","Divine Ascension","Lazarus"],
  Summoner: ["Lashing","Soul Bind","Essence Sap","Beastmaster","Beast Empowerment","Usurper","Offering","Leviathan","Abyssal-touch","Profane Lord"],
};
window.SKILL_DATA    = SKILL_DATA;
window.BATTLE_SKILLS = BATTLE_SKILLS;
window.SKILL_TREES   = SKILL_TREES;
window.ITEM_ICONS    = ITEM_ICONS;  // expose for trade.js icon resolution
window.getItemIcon   = getItemIcon; // expose helper too

// Resolve a skill use — returns { playerDmg, playerHp, log, updates:{} }
function _applySkill(skillName, playerHp, playerMana, playerHpMax, monster, stats, b) {
  const sk   = SKILL_DATA[skillName];
  if (!sk) return { playerDmg:0, playerHp, playerMana, log:[`❓ Unknown skill: ${skillName}`], monsterHp: monster.hp, updates:{} };

  const log     = [];
  const updates = {};   // carries buff/debuff/dot state to persist in battle doc
  let   monHp   = monster.hp;
  let   dmg     = 0;

  // Helper: get stat value with active buffs
  const getStat = (s) => {
    const base = stats[s] || 10;
    const buffKey = `buff_${s}`;
    return Math.round(base * (1 + (b[buffKey] || 0)));
  };

  // defBreak factor: Abyssal-touch reduces monster DEF by defBreakAmt
  const defBreakFactor = b.defBreak ? (1 - (b.defBreakAmt || 0)) : 1;

  const primaryVal = getStat(sk.stat || "str");

  switch (sk.type) {
    case "damage":
    case "backstab": {
      const isBackstab = sk.type === "backstab";
      const isFirst    = !b.backstabUsed;
      const mult       = isBackstab ? (isFirst ? sk.mult : sk.multAfter) : sk.mult;
      const defPen     = sk.defPen || 0;
      const rawEffDefDP = Math.floor(monster.def * defBreakFactor * (1 - defPen));
    const _dpDefRatio = rawEffDefDP / (rawEffDefDP + 50);
    const effectiveDef = Math.round(primaryVal * _dpDefRatio);
      dmg = Math.max(1, Math.round(primaryVal * mult) - effectiveDef);
      if (b.defBreak) updates.defBreak = false;  // consume after use
      // Echo-strike doubles the hit
      if (b.echoActive) { dmg *= 2; updates.echoActive = false; log.push(`🔁 Echo-strike doubles the hit!`); }
      // Death Mark bonus
      if (b.deathMark) { dmg = Math.round(dmg * (1 + (b.deathMarkBonus || 0.60))); updates.deathMark = false; log.push(`☠️ Death Mark triggered!`); }
      monHp = Math.max(0, monHp - dmg);
      log.push(`⚔️ ${skillName}: ${dmg} damage!`);
      if (isBackstab) updates.backstabUsed = true;
      break;
    }
    case "execute": {
      const hpPct = monster.hp / (monster.maxHp || monster.hp);
      const mult  = hpPct <= sk.threshold ? sk.mult : 1.05;
      // Diminishing-returns mitigation for skill damage (prevents 1-damage at high rank)
    const rawEffDefS = Math.floor(monster.def * defBreakFactor);
    const _skillDefRatio = rawEffDefS / (rawEffDefS + 50);
    const effectiveDef = Math.round(primaryVal * _skillDefRatio);
      dmg = Math.max(1, Math.round(primaryVal * mult) - effectiveDef);
      monHp = Math.max(0, monHp - dmg);
      log.push(hpPct <= sk.threshold
        ? `⚡ ${skillName}: EXECUTE — ${dmg} damage!`
        : `⚔️ ${skillName}: ${dmg} damage.`);
      break;
    }
    case "multihit": {
      let total = 0;
      for (let i = 0; i < sk.hits; i++) {
        const h = Math.max(1, Math.round(primaryVal * sk.multPerHit * (1 - (monster.def * defBreakFactor) / ((monster.def * defBreakFactor) + 50))));
        total += h; monHp = Math.max(0, monHp - h);
      }
      dmg = total;
      log.push(`💥 ${skillName}: ${sk.hits} hits for ${dmg} total!`);
      break;
    }
    case "condDamage": {
      const hasDebuff = b.dotActive || b.deathMark || b.defBreak;
      const mult      = hasDebuff ? sk.mult : 1.05;
      // Diminishing-returns mitigation for skill damage (prevents 1-damage at high rank)
    const rawEffDefS = Math.floor(monster.def * defBreakFactor);
    const _skillDefRatio = rawEffDefS / (rawEffDefS + 50);
    const effectiveDef = Math.round(primaryVal * _skillDefRatio);
      dmg = Math.max(1, Math.round(primaryVal * mult) - effectiveDef);
      monHp = Math.max(0, monHp - dmg);
      log.push(`🗡️ ${skillName}: ${dmg} damage${hasDebuff ? " (bonus vs debuffed!)" : ""}`);
      break;
    }
    case "dot": {
      const label = sk.dotLabel || "Bleed";
      updates.dotActive  = true;
      updates.dotPct     = sk.dotPct;
      updates.dotTurns   = sk.dotTurns;
      updates.dotLabel   = label;
      updates.dotLifesteal = sk.lifesteal || false;
      log.push(`🩸 ${skillName}: ${label} applied — ${Math.round(sk.dotPct*100)}% damage/turn × ${sk.dotTurns} turns!`);
      break;
    }
    case "hot": {
      updates.hotActive = true;
      updates.hotPct    = sk.hotPct;
      updates.hotTurns  = sk.hotTurns;
      log.push(`💚 ${skillName}: Regen active — ${Math.round(sk.hotPct*100)}% HP/turn × ${sk.hotTurns} turns!`);
      break;
    }
    case "heal": {
      const _glimmerMult = (_charData?.companion?.name || '').toLowerCase() === 'glimmer' ? 1.15 : 1;
      const healed = Math.round(playerHpMax * sk.healPct * _glimmerMult);
      playerHp = Math.min(playerHpMax, playerHp + healed);
      log.push(`💚 ${skillName}: Restored ${healed} HP!`);
      break;
    }
    case "hpbuff": {
      const gained = Math.round(playerHpMax * sk.hpMult);
      playerHp = Math.min(playerHpMax + gained, playerHp + gained);
      log.push(`💛 ${skillName}: HP surged by ${gained}!`);
      break;
    }
    case "shield": {
      updates.shieldPct = sk.shieldPct;
      log.push(`🛡️ ${skillName}: Shield absorbs ${Math.round(sk.shieldPct*100)}% of next hit!`);
      break;
    }
    case "buff": {
      const BUFF_CAP = 1.60;
      if (sk.stat === 'all') {
        // Buff all stats (Divine Ascension, Neptune's Embrace)
        let allCapped = true;
        for (const s of ['str','int','def','dex']) {
          const bk = `buff_${s}`;
          if ((b[bk] || 0) < BUFF_CAP) allCapped = false;
          updates[bk] = Math.min(BUFF_CAP, (b[bk] || 0) + sk.buffMult);
        }
        if (allCapped) {
          log.push(`⬆️ ${skillName}: Buff cap reached (160% max)!`);
        } else {
          if (sk.hpBonus) { playerHp = Math.min(playerHpMax, playerHp + Math.round(playerHpMax * sk.hpBonus)); }
          log.push(`⬆️ ${skillName}: ALL STATS +${Math.round(sk.buffMult*100)}%!`);
        }
      } else {
        const bKey = `buff_${sk.stat}`;
        if ((b[bKey] || 0) >= BUFF_CAP) {
          log.push(`⬆️ ${skillName}: Buff cap reached (160% max)!`);
        } else {
          updates[bKey] = Math.min(BUFF_CAP, (b[bKey] || 0) + sk.buffMult);
          if (sk.hpBonus) { playerHp = Math.min(playerHpMax, playerHp + Math.round(playerHpMax * sk.hpBonus)); }
          log.push(`⬆️ ${skillName}: +${Math.round(sk.buffMult*100)}% ${sk.stat.toUpperCase()}! (Total: ${Math.round(updates[bKey]*100)}%)`);
        }
      }
      break;
    }
    case "sacrificial": {
      const BUFF_CAP_S = 1.60;
      if (sk.buffStat === 'all') {
        // Life Exchange — sacrifice HP to buff all stats
        let allCapped = ['str','int','def','dex'].every(s => (b[`buff_${s}`] || 0) >= BUFF_CAP_S);
        if (allCapped) {
          log.push(`🩸 ${skillName}: Buff cap reached — skill has no effect!`);
          break;
        }
        const cost = Math.round(playerHpMax * sk.selfHpCost);
        playerHp = Math.max(1, playerHp - cost);
        for (const s of ['str','int','def','dex']) {
          const bk = `buff_${s}`;
          updates[bk] = Math.min(BUFF_CAP_S, (b[bk] || 0) + sk.buffMult);
        }
        log.push(`🩸 ${skillName}: Sacrificed ${cost} HP → ALL STATS +${Math.round(sk.buffMult*100)}%!`);
      } else {
        const bKey = `buff_${sk.buffStat}`;
        if ((b[bKey] || 0) >= BUFF_CAP_S) {
          log.push(`🩸 ${skillName}: Buff cap reached — skill has no effect!`);
          break;
        }
        const cost = Math.round(playerHpMax * sk.selfHpCost);
        playerHp = Math.max(1, playerHp - cost);
        updates[bKey] = Math.min(BUFF_CAP_S, (b[bKey] || 0) + sk.buffMult);
        if (sk.buffStat2) {
          const bKey2 = `buff_${sk.buffStat2}`;
          updates[bKey2] = Math.min(BUFF_CAP_S, (b[bKey2] || 0) + (sk.buffMult2 || 0));
        }
        log.push(`🩸 ${skillName}: Sacrificed ${cost} HP → +${Math.round(sk.buffMult*100)}% ${sk.buffStat.toUpperCase()}! (Total: ${Math.round(updates[bKey]*100)}%)`);
      }
      break;
    }
    case "stun": {
      // Diminishing-returns mitigation for skill damage (prevents 1-damage at high rank)
    const rawEffDefS = Math.floor(monster.def * defBreakFactor);
    const _skillDefRatio = rawEffDefS / (rawEffDefS + 50);
    const effectiveDef = Math.round(primaryVal * _skillDefRatio);
      dmg = Math.max(1, Math.round(primaryVal * (sk.mult || 1.00)) - effectiveDef);
      monHp = Math.max(0, monHp - dmg);
      updates.monsterStunned = true;
      log.push(`💫 ${skillName}: ${dmg} damage! Monster is stunned and will skip next turn!`);
      break;
    }
    case "skillock": {
      updates.monsterSkillLocked = true;
      log.push(`🔇 ${skillName}: Monster's special locked for 1 turn!`);
      break;
    }
    case "cleanse": {
      // Remove all active player debuffs and refresh status
      updates.dotActive       = false;
      updates.dotTurns        = 0;
      updates.dotLabel        = null;
      updates.dotPct          = 0;
      updates.dotLifesteal    = false;
      updates.deathMark       = false;
      updates.deathMarkBonus  = 0;
      log.push(`✨ ${skillName}: All debuffs cleared!`);
      break;
    }
    case "echo": {
      updates.echoActive = true;
      log.push(`🔁 ${skillName}: Next skill will hit twice!`);
      break;
    }
    case "debuff": {
      if (sk.debuffType === "deathmark") {
        updates.deathMark = true;
        updates.deathMarkBonus = sk.dmgBonus;
        log.push(`☠️ ${skillName}: Death Mark placed — next hit deals +${Math.round(sk.dmgBonus*100)}% damage!`);
      } else if (sk.debuffType === "defbreak") {
        updates.defBreak = true;
        updates.defBreakAmt = sk.defReduce;
        log.push(`💢 ${skillName}: Monster DEF reduced by ${Math.round(sk.defReduce*100)}%!`);
      }
      break;
    }
    case "summon": {
      // Leviathan can only be summoned once per battle
      if (sk.unique && b.leviathanSummoned) {
        log.push(`🐉 ${skillName}: Already summoned — can only call once per battle!`);
        break;
      }
      const intVal = getStat('int');
      // Apply Beast Empowerment summon buff if active
      const summonBuff = b.summonBuff || 0;
      const effectiveDmgPct = sk.summonDmgPct * (1 + summonBuff);
      dmg = Math.round(intVal * effectiveDmgPct);
      monHp = Math.max(0, monHp - dmg);
      updates.summonActive = true;
      updates.summonDmgPct = effectiveDmgPct;
      if (sk.unique) {
        updates.summonTurns = 999;  // Leviathan persists indefinitely (1 per battle)
        updates.leviathanSummoned = true;
        log.push(`🐉 ${skillName}: Leviathan rises! Deals ${dmg} damage and will attack every turn!`);
      } else {
        updates.summonTurns = sk.summonTurns;
        log.push(`🐉 ${skillName}: Summon deals ${dmg} damage! Active for ${sk.summonTurns} turns.`);
      }
      break;
    }
    case "offering": {
      // Offering — sacrifice one active summon to gain HP
      if (!b.summonActive || b.summonTurns <= 0) {
        log.push(`🐉 Offering: No active summons to sacrifice!`);
        break;
      }
      const _glimmerM = (_charData?.companion?.name || '').toLowerCase() === 'glimmer' ? 1.15 : 1;
      const healed = Math.round(playerHpMax * sk.healPct * _glimmerM);
      playerHp = Math.min(playerHpMax, playerHp + healed);
      // Reduce summon count by 1 (Leviathan cannot be sacrificed)
      if (!b.leviathanSummoned) {
        const newTurns = Math.max(0, b.summonTurns - 1);
        updates.summonTurns = newTurns;
        updates.summonActive = newTurns > 0;
      }
      log.push(`🩸 Offering: Sacrificed a summon → +${healed} HP restored!`);
      break;
    }
    case "profanelord": {
      // Profane Lord — destroy ALL active summons (including Leviathan) → 200% INT damage
      if (!b.summonActive && !b.leviathanSummoned) {
        log.push(`🌑 Profane Lord: No summons to sacrifice — cast fails!`);
        break;
      }
      updates.summonActive        = false;
      updates.summonTurns         = 0;
      updates.leviathanSummoned   = false;
      // Diminishing-returns mitigation for skill damage (prevents 1-damage at high rank)
    const rawEffDefS = Math.floor(monster.def * defBreakFactor);
    const _skillDefRatio = rawEffDefS / (rawEffDefS + 50);
    const effectiveDef = Math.round(primaryVal * _skillDefRatio);
      dmg = Math.max(1, Math.round(primaryVal * sk.mult) - effectiveDef);
      if (b.echoActive) { dmg *= 2; updates.echoActive = false; log.push(`🔁 Echo-strike doubles the hit!`); }
      monHp = Math.max(0, monHp - dmg);
      log.push(`🌑 Profane Lord: All summons destroyed → ${dmg} damage!`);
      break;
    }
    case "summonbuff": {
      // Beast Empowerment — boosts summon damage
      const prevBuff = b.summonBuff || 0;
      updates.summonBuff = prevBuff + sk.summonBuffMult;
      // Also boost active summon dmgPct immediately if summons are out
      if (b.summonActive) {
        updates.summonDmgPct = (b.summonDmgPct || 0) * (1 + sk.summonBuffMult);
      }
      log.push(`🐉 ${skillName}: Summon damage boosted by +${Math.round(sk.summonBuffMult*100)}%!`);
      break;
    }
    default: {
      // Diminishing-returns mitigation for skill damage (prevents 1-damage at high rank)
    const rawEffDefS = Math.floor(monster.def * defBreakFactor);
    const _skillDefRatio = rawEffDefS / (rawEffDefS + 50);
    const effectiveDef = Math.round(primaryVal * _skillDefRatio);
      dmg = Math.max(1, Math.round(primaryVal * 1.05) - effectiveDef);
      monHp = Math.max(0, monHp - dmg);
      log.push(`⚔️ ${skillName}: ${dmg} damage.`);
    }
  }

  return { playerDmg: dmg, playerHp, playerMana, monsterHp: monHp, log, updates };
}
 
let _currentBattle = null;
 
// ── Encounter popup: shown before battle starts ──
window._showEncounterPopup = function(grade, zoneName) {
  window._pendingEncounterZone = zoneName || window._selectedZoneName || null;
  const monster   = _generateMonster(grade, window._pendingEncounterZone);
  const gradeColor = { E:"#7cba6a", D:"#6ab0f5", C:"#c9a84c", B:"#e07d3c", A:"#c05555", S:"#9b59b6" };
  const el = document.getElementById('encounter-popup');
  if (!el) return;
  _renderMonsterAvatar('encounter-monster-emoji', monster);
  document.getElementById('encounter-monster-name').textContent  = monster.name;
  document.getElementById('encounter-monster-grade').textContent = monster.levelBand ? `Lv. ${monster.levelBand}` : `Grade ${grade}`;
  document.getElementById('encounter-monster-grade').style.color = gradeColor[grade] || "#c9a84c";
  document.getElementById('encounter-monster-hp').textContent    = `HP: ${monster.hp}`;
  // Store monster for immediate use if player chooses Fight
  window._pendingEncounterMonster = monster;
  window._pendingEncounterGrade   = grade;
  // Ensure _selectedGrade is always set for popup buttons
  if (typeof window._selectedGrade !== 'undefined') {
    window._selectedGrade = grade;
  }
  el.style.display = 'flex';
};

window._closeEncounterPopup = function() {
  const el = document.getElementById('encounter-popup');
  if (el) el.style.display = 'none';
  window._pendingEncounterMonster = null;
  window._pendingEncounterGrade   = null;
};

window._showBattleLoading = function(mode) {
  const popup   = document.getElementById('encounter-popup');
  const info    = document.getElementById('encounter-monster-info');
  const loading = document.getElementById('encounter-loading');
  if (!popup || !info || !loading) return;
  const isAuto = mode === 'auto';
  document.getElementById('encounter-loading-emoji').textContent = isAuto ? '🔄' : '⚔️';
  document.getElementById('encounter-loading-title').textContent = isAuto ? 'AUTO-BATTLE STARTING...' : 'ENTERING BATTLEGROUND...';
  const subs = isAuto
    ? ['Calculating optimal strategy...', 'Summoning your fighter...', 'Reading the enemy...']
    : ['Sharpening your blade...', 'The monster stirs...', 'Preparing the arena...'];
  document.getElementById('encounter-loading-sub').textContent = subs[Math.floor(Math.random() * subs.length)];
  info.style.display    = 'none';
  loading.style.display = 'flex';
  popup.style.display   = 'flex';
  let pct = 0;
  window._battleLoadingInterval = setInterval(() => {
    pct = Math.min(90, pct + Math.random() * 12 + 4);
    const bar = document.getElementById('encounter-loading-bar');
    if (bar) bar.style.width = pct + '%';
  }, 150);
};

window._hideBattleLoading = function() {
  return new Promise((resolve) => {
    clearInterval(window._battleLoadingInterval);
    const bar = document.getElementById('encounter-loading-bar');
    if (bar) bar.style.width = '100%';
    setTimeout(() => {
      const popup   = document.getElementById('encounter-popup');
      const info    = document.getElementById('encounter-monster-info');
      const loading = document.getElementById('encounter-loading');
      if (popup)   popup.style.display   = 'none';
      if (info)    info.style.display    = 'block';
      if (loading) loading.style.display = 'none';
      if (bar)     bar.style.width       = '0%';
      resolve();
    }, 250);
  });
};

window._startBattle = async function(grade, isAuto, zoneName) {
  const zone = zoneName || window._selectedZoneName || null;
  if (!isAuto) {
    window._showEncounterPopup(grade, zone);
    return;
  }
  // Route auto to the live loop
  window._startAutoBattle(grade, zone);
};

// ── Direct entry from zone-select AUTO-BATTLE button ──
window._startAutoBattle = async function(grade, zoneName) {
  
  const zone = zoneName || window._selectedZoneName || null;
  const exhausted = await window._checkZonePool(zone, grade);
  if (exhausted) { window._showPoolExhausted(zone, grade); return; }
  window._currentBattleGrade = grade;
  window._currentBattleZone  = zone;
  _launchAutoBattleLoop(grade, zone);
};

// ── Live auto-battle loop — one monster at a time, real-time bars ──
let _autoBattleRunning   = false;
let _autoBattleForceMelee = false;
let _autoBattlePotionPending = false; // set true when a potion is used mid-battle

window._toggleAutoBattleMelee = function() {
  _autoBattleForceMelee = !_autoBattleForceMelee;
  const btn = document.getElementById("auto-melee-toggle");
  if (btn) {
    btn.textContent = "⚔ MELEE ONLY: " + (_autoBattleForceMelee ? "ON" : "OFF");
    btn.style.borderColor = _autoBattleForceMelee ? "var(--gold)" : "";
    btn.style.color       = _autoBattleForceMelee ? "var(--gold)" : "";
  }
};

function _launchAutoBattleLoop(grade, zoneName) {
  _autoBattleRunning = true;

  const char          = _charData;
  const poolSize      = ZONE_POOL_SIZE[grade] || 40;
  const stats         = _resolveCombatStats(char);
  const primary       = _getPrimaryStat(char.charClass, stats);
  const classSkills   = _getActiveBattleSkills();

  let killCount    = 0; // tracks kills THIS session only (for in-memory pool guard)
  let skillIdx     = 0;
  let playerHp     = char.hp    ?? char.hpMax   ?? 100;
  let playerMana   = char.mana  ?? char.manaMax ?? 50;
  const playerHpMax   = char.hpMax   || 100;
  const playerManaMax = char.manaMax || 50;

  // Read existing kill count so HUD reflects real state (e.g. resuming after manual fights)
  const existingKills = _getZoneKills(zoneName).count || 0;
  // Remaining capacity this session = how many more can be killed before pool exhausts
  const sessionCap = Math.max(0, poolSize - existingKills);

  // Switch to battle arena, show auto HUD, hide manual actions
  console.log('[BATTLE] Auto-battle: setting arena to display=block');
  document.getElementById('battle-zone-select').style.display   = 'none';
  document.getElementById('zone-pool-exhausted').style.display  = 'none';
  document.getElementById('battle-result').style.display        = 'none';
  document.getElementById('battle-arena').style.display         = 'block';
  document.getElementById('battle-actions').style.display       = 'none';
  document.getElementById('auto-battle-bar').style.display      = 'none';
  document.getElementById('auto-battle-hud').style.display      = 'block';
  // Scroll to top so arena is visible on mobile
  const _mcAuto = document.querySelector('.main-content');
  if (_mcAuto) _mcAuto.scrollTop = 0;
  console.log('[BATTLE] Auto-battle arena setup complete');

  // Seed HUD pool counter with real existing count
  const poolSizeEl = document.getElementById('auto-pool-size');
  if (poolSizeEl) poolSizeEl.textContent = poolSize;
  document.getElementById('auto-kill-count').textContent = existingKills;
  const initPct = Math.min(100, Math.round((existingKills / poolSize) * 100));
  document.getElementById('auto-pool-fill').style.width = initPct + '%';

  // Player identity
  set('battle-player-name', char.name || '—');
  set('battle-player-rank', `${char.rank||'Wanderer'} Lv.${_displayLevel(char.level||1)}`);
  const playerAvatarEl = document.getElementById('player-battle-avatar');
  if (playerAvatarEl && char) {
    const av = char.avatarUrl;
    playerAvatarEl.innerHTML = av?.startsWith('http')
      ? `<img src="${av}" style="width:60px;height:60px;border-radius:50%;border:2px solid var(--gold-dim);object-fit:cover;"/>`
      : `<span style="font-size:2.2rem">${av || '⚔️'}</span>`;
  }
  updateBattleBars(0, 1, playerHp, playerHpMax, playerMana, playerManaMax);
  _renderBattlePotionStrip(); // show potions at battle start

  const logEl = document.getElementById('battle-log');
  if (logEl) logEl.innerHTML = '';
  addBattleLog(`🔄 Auto-battle started in <b>${zoneName}</b> — ${poolSize} monsters await!`);

  async function fightOneMonster() {
    if (!_autoBattleRunning) return;
    // Also guard against lingering calls when player HP already hit 0
    if (playerHp <= 0) { _autoBattleRunning = false; return; }

    // killCount is in-memory this session; sessionCap is how many remain before pool exhausts
    if (killCount >= sessionCap) {
      _autoBattleRunning = false;
      await _stopAutoBattleCleanup(playerHp, playerMana);
      window._showPoolExhausted(zoneName, grade);
      return;
    }

    const monster    = _generateMonster(grade, zoneName);
    let   monHp      = monster.hp;

    set('monster-name',  monster.name);
    set('monster-grade', monster.levelBand ? `Lv. ${monster.levelBand}` : `Grade ${monster.grade}`);
    _renderMonsterAvatar('monster-avatar-emoji', monster);
    addBattleLog(`👹 ${monster.name} appears! (${monHp} HP)`);

    // ── Per-monster battle state (buffs, DoT, stun, etc.) ──
    let battleState = {};  // tracks buffs/debuffs across turns for this monster

    // Combat loop for this monster
    while (monHp > 0 && playerHp > 0 && _autoBattleRunning) {
      // Pull potion heal from _charData only when a potion was actually just used
      if (_autoBattlePotionPending) {
        playerHp   = Math.max(playerHp,   _charData?.hp   ?? playerHp);
        playerMana = Math.max(playerMana, _charData?.mana ?? playerMana);
        _autoBattlePotionPending = false;
      }
      // No mana regen during combat — skills have real cost.
      // Out-of-battle passive regen (_regenTick) handles mana recovery.

      // ── Tick DoT on monster ──
      if (battleState.dotActive && battleState.dotTurns > 0) {
        const dotDmg = Math.round((monster.maxHp || monster.hp) * battleState.dotPct);
        monHp = Math.max(0, monHp - dotDmg);
        battleState.dotTurns--;
        if (battleState.dotTurns <= 0) battleState.dotActive = false;
        if (battleState.dotLifesteal) playerHp = Math.min(playerHpMax, playerHp + dotDmg);
        addBattleLog(`🩸 ${battleState.dotLabel||'Bleed'}: ${dotDmg} dmg to monster!`);
        if (monHp <= 0) break;
      }

      // ── Tick summon on monster ──
      if (battleState.summonActive && battleState.summonTurns > 0) {
        const intBuff = Math.round((stats.int || 10) * (1 + (battleState.buff_int || 0)));
        const sumDmg = Math.round(intBuff * (battleState.summonDmgPct || 0.40));
        monHp = Math.max(0, monHp - sumDmg);
        if (!battleState.leviathanSummoned) battleState.summonTurns--;
        if (battleState.summonTurns <= 0) battleState.summonActive = false;
        addBattleLog(`🐉 Summon: ${sumDmg} dmg!`);
        if (monHp <= 0) break;
      }

      // ── Tick HoT on player ──
      if (battleState.hotActive && battleState.hotTurns > 0) {
        const hotHeal = Math.round(playerHpMax * battleState.hotPct);
        playerHp = Math.min(playerHpMax, playerHp + hotHeal);
        battleState.hotTurns--;
        if (battleState.hotTurns <= 0) battleState.hotActive = false;
      }

      // Pick next affordable skill, fall back to melee
      let usedSkill = null;
      if (!_autoBattleForceMelee) {
        for (let i = 0; i < classSkills.length; i++) {
          const sk = classSkills[(skillIdx + i) % classSkills.length];
          if ((sk.mana || 0) <= playerMana) {
            usedSkill = sk;
            skillIdx  = (skillIdx + i + 1) % classSkills.length;
            break;
          }
        }
      }

      const skillNameLabel = usedSkill ? usedSkill.name : 'Melee Strike';
      const skillEl = document.getElementById('auto-current-skill');
      if (skillEl) skillEl.textContent = skillNameLabel;

      let dmg = 0;
      if (usedSkill) {
        // Deduct mana cost before applying skill (mirrors manual battle path)
        playerMana = Math.max(0, playerMana - (usedSkill.mana || 0));
        // Clone monster with correct hp for _applySkill
        const monsterSnap = { ...monster, hp: monHp };
        const result = _applySkill(usedSkill.name, playerHp, playerMana, playerHpMax, monsterSnap, stats, battleState);
        dmg        = result.playerDmg;
        playerHp   = result.playerHp;
        // _applySkill doesn't re-deduct mana; keep our already-deducted value
        // (result.playerMana is passed-through unchanged inside _applySkill)
        monHp      = result.monsterHp;
        // Merge skill updates into battleState
        Object.assign(battleState, result.updates);
      } else {
        // Melee — apply defBreak if active
        const defBreakFact = battleState.defBreak ? (1 - (battleState.defBreakAmt || 0)) : 1;
        const effectiveDef = Math.floor(monster.def * defBreakFact * 0.5);
        dmg = Math.max(1, primary - effectiveDef);
        if (battleState.defBreak) { battleState.defBreak = false; battleState.defBreakAmt = 0; }
        // Death Mark
        if (battleState.deathMark) { dmg = Math.round(dmg * (1 + (battleState.deathMarkBonus || 0.60))); battleState.deathMark = false; }
        monHp = Math.max(0, monHp - dmg);
      }

      // Monster counter-attack (skip if stunned or skip-on-killed)
      if (monHp > 0) {
        if (battleState.monsterStunned) {
          battleState.monsterStunned = false;
          addBattleLog(`💫 Monster stunned — skips attack!`);
        } else {
          const _mit3 = Math.min(Math.floor((stats.def||10) * 0.3), Math.floor(monster.atk * 0.75));
          const buffDefFact = battleState.buff_def ? (1 + battleState.buff_def) : 1;
          let mdmg = Math.max(Math.ceil(monster.atk * 0.25), Math.round((monster.atk - _mit3) / buffDefFact));
          if (battleState.monsterSkillLocked) { mdmg = Math.max(1, Math.round(mdmg * 0.50)); battleState.monsterSkillLocked = false; }
          if (battleState.shieldPct) { const blocked = Math.round(mdmg * battleState.shieldPct); mdmg = Math.max(0, mdmg - blocked); battleState.shieldPct = 0; }
          const _raceAB = (char.race || '').toLowerCase();
          if (_raceAB.includes('elder dragon')) mdmg = Math.round(mdmg * 0.80);
          else if (_raceAB.includes('dragonborn')) mdmg = Math.round(mdmg * 0.90);
          playerHp = Math.max(0, playerHp - mdmg);
        }
      }

      updateBattleBars(monHp, monster.hp, playerHp, playerHpMax, playerMana, playerManaMax);
      // Keep live values accessible so _useBattlePotion can sync _charData before healing
      window._autoBattleLiveHp   = playerHp;
      window._autoBattleLiveMana = playerMana;
      await new Promise(r => setTimeout(r, 420));
    }

    if (!_autoBattleRunning) return;

    // ── Player defeated ──
    if (playerHp <= 0) {
      // Set flag FIRST before any awaits — prevents recursive fightOneMonster() slipping through
      _autoBattleRunning = false;
      addBattleLog('💀 You were defeated during auto-battle!');
      // Capture uid before async state changes
      const defeatedUid = _uid;
      const resurrectAt = new Date(Date.now() + 5*60*60*1000);
      const charRef = doc(db, 'characters', defeatedUid);
      await runTransaction(db, async tx => {
        const snap = await tx.get(charRef);
        const freshInv = snap.exists() ? (snap.data().inventory || []) : (char.inventory || []);
        const halfInv = freshInv.map(item => ({ ...item, qty: Math.max(1, Math.floor((item.qty ?? 1) / 2)) }));
        tx.update(charRef, { hp: 0, inventory: halfInv, resurrectAt, isDead: true });
      });
      // Write activity directly — bypass logActivity() to avoid any global state issues post-death
      try {
        await addDoc(collection(db, 'activity', defeatedUid, 'events'), {
          icon: '💀',
          message: '<b>Defeated in auto-battle.</b> Inventory halved. Resurrection available in 5 hours.',
          color: '#e05555',
          timestamp: serverTimestamp(),
        });
        _pushActivityUI('💀', '<b>Defeated in auto-battle.</b> Inventory halved. Resurrection available in 5 hours.', '#e05555', new Date());
      } catch(e) { console.warn('[Death] Failed to log activity:', e); }
      await refreshCharData();
      window._autoBattleLiveHp   = undefined;
      window._autoBattleLiveMana = undefined;
      document.getElementById('auto-battle-hud').style.display = 'none';
      showBattleResult({ status:'defeat', log:['💀 You were defeated during auto-battle!'] });
      return;
    }

    // ── Monster defeated — award rewards ──
    killCount++;
    const drops   = _rollDrops(grade, zoneName);
    const _veilExpBonus2 = _charData?.deity === 'Veil' ? (1 + _getFaithBlessingPct(_charData)) : 1;
    const expGain = Math.round(((zoneName ? LEVEL_BAND_STATS[ZONE_LEVEL_BAND[zoneName]]?.exp : null) || MONSTER_EXP_LOCAL[grade] || 10) * _getRaceExpMult(_charData?.race) * _getCompanionExpMult(_charData?.companion?.name) * _veilExpBonus2 * _getExpBuffMult(_charData));
    const inv = [...(char.inventory||[])];
    drops.items.forEach(item => {
      const ex = inv.find(i => i.name === item.name);
      const _isEquip = getItemType(item.name) === 'equipment';
      if (ex && !_isEquip) { ex.qty += item.qty; }
      else { const _ni = {...item}; if (_isEquip) _ni.iid = Math.random().toString(36).slice(2,10)+Date.now().toString(36); inv.push(_ni); }
    });
    char.gold      = (_charData.gold||0) + drops.gold;  // keep char in sync for HUD
    char.inventory = inv;
    const { newXp, newLevel, newRank, newXpMax, leveledUp } = _processExp(
      char.xp||0, char.xpMax||100, char.level||1, char.rank||'Wanderer', expGain, char.charClass
    );
    char.xp = newXp; char.xpMax = newXpMax; char.level = newLevel; char.rank = newRank;
    if (leveledUp) {
      char.statPoints = (char.statPoints||0) + 3;
      char.hpMax      = (char.hpMax||100) + 10;
      char.manaMax    = (char.manaMax||50) + 5;
      addBattleLog(`🎉 LEVEL UP! Now Level ${newLevel} ${newRank}!`);
      window.showToast(`🎉 LEVEL UP! Now Level ${newLevel} ${newRank}!`, 'success');
    }
    addBattleLog(`✅ ${monster.name} defeated! +${drops.gold}💰 +${expGain} EXP`);

    // Update HUD kill counter — show total kills in zone (existing + this session)
    const totalKills = existingKills + killCount;
    document.getElementById('auto-kill-count').textContent = totalKills;
    const pct = Math.min(100, Math.round((totalKills / poolSize) * 100));
    document.getElementById('auto-pool-fill').style.width = pct + '%';

    // Persist kill + incremental rewards to Firestore
    // FIXED: Use increment() for gold/xp so this write merges with any concurrent
    // change (bestow, trade, etc.) rather than overwriting it with a stale value.
    // Inventory is written directly because it's already built on top of _charData
    // which was refreshed at battle start; for long sessions this is still safer
    // because at least gold/xp won't stomp concurrent changes.
    const isElite = ['B','A','S'].includes(grade);
    await window._recordZoneKill(zoneName, grade);
    await _incrementQuest('kill', 1);
    if (isElite) await _incrementQuest('eliteKill', 1);
    await updateDoc(doc(db, 'characters', _uid), {
      gold: increment(drops.gold),
      inventory: char.inventory,
      xp: increment(expGain), xpMax: char.xpMax, level: char.level, rank: char.rank,
      hp: playerHp, mana: playerMana,
      ...(leveledUp ? { statPoints: increment(3), hpMax: char.hpMax, manaMax: char.manaMax } : {})
    });
    // Keep local _charData in sync so subsequent reads in this session are accurate
    Object.assign(_charData, { gold: char.gold, inventory: char.inventory,
      xp: char.xp, xpMax: char.xpMax, level: char.level, rank: char.rank,
      hp: playerHp, mana: playerMana,
      ...(leveledUp ? { statPoints: char.statPoints, hpMax: char.hpMax, manaMax: char.manaMax } : {}) });
    logActivity('⚔️', `<b>Auto: Defeated ${monster.name}</b>${isElite?' <span style="color:#e8d070">[Elite]</span>':''} · +${drops.gold}💰 +${expGain} EXP`, isElite ? '#e8d070' : '#e05555');

    // Small pause between monsters, then continue
    await new Promise(r => setTimeout(r, 600));
    fightOneMonster();
  }

  fightOneMonster();
}

window._stopAutoBattle = function() {
  
  if (!_autoBattleRunning) return;
  _autoBattleRunning = false;
  _autoBattleForceMelee = false;
  const meleeBtn = document.getElementById("auto-melee-toggle");
  if (meleeBtn) { meleeBtn.textContent = "⚔ MELEE ONLY: OFF"; meleeBtn.style.borderColor = ""; meleeBtn.style.color = ""; }
  const hp   = _charData?.hp   ?? 0;
  const mana = _charData?.mana ?? 0;
  _stopAutoBattleCleanup(hp, mana);
};

// ── Save HP when player navigates away mid-battle ────────────────────────────
// Without this, closing the tab or switching pages while auto-battle or a manual
// fight is running leaves HP at full because the normal save only fires on
// explicit stop/victory/defeat.  visibilitychange fires reliably on mobile too.
(function _registerBattleExitSave() {
  function _flushHp() {
    try {
      const uid = window._uid || _uid;
      if (!uid) return;
      // Auto-battle: live HP is tracked in _autoBattleLiveHp
      const abHp   = window._autoBattleLiveHp;
      const abMana = window._autoBattleLiveMana;
      if (_autoBattleRunning && abHp !== undefined) {
        // Use sendBeacon for reliability during page unload
        const payload = JSON.stringify({ hp: abHp, mana: abMana ?? (_charData?.mana ?? 0) });
        // Can't await here — best-effort via sendBeacon to a no-op endpoint isn't possible
        // with Firestore SDK during unload. Instead we mark _charData and rely on the
        // next session's refreshCharData to pick up the doc written by _stopAutoBattleCleanup.
        // The real fix is: stop the loop cleanly and write synchronously.
        _autoBattleRunning = false;
        if (uid && window.db) {
          import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")
            .then(({ doc, updateDoc }) => updateDoc(doc(window.db, 'characters', uid), { hp: abHp, mana: abMana ?? (_charData?.mana ?? 0) }))
            .catch(() => {});
        }
      } else if (!_autoBattleRunning && window._charData) {
        // Manual fight: save current HP from the battle doc (which has live playerHp)
        // _charData.hp is only updated on victory/defeat, so read from battles doc instead.
        const arena = document.getElementById('battle-arena');
        if (arena && arena.style.display !== 'none') {
          if (uid && window.db) {
            import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")
              .then(async ({ doc, getDoc, updateDoc }) => {
                try {
                  const bSnap = await getDoc(doc(window.db, 'battles', uid));
                  if (bSnap.exists() && bSnap.data().status === 'active') {
                    const { playerHp, playerMana } = bSnap.data();
                    if (playerHp !== undefined) {
                      await updateDoc(doc(window.db, 'characters', uid), {
                        hp: playerHp, mana: playerMana ?? (window._charData?.mana ?? 0)
                      });
                    }
                  }
                } catch(e2) { /* best-effort */ }
              }).catch(() => {});
          }
        }
      }
    } catch(e) { /* best-effort */ }
  }

  // visibilitychange fires when the tab is hidden (switch tab, phone lock, app switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flushHp();
  });
  // pagehide fires on navigation away / back-forward cache
  window.addEventListener('pagehide', _flushHp);
  // beforeunload as final fallback (some browsers block async ops here)
  window.addEventListener('beforeunload', _flushHp);
})();

async function _stopAutoBattleCleanup(playerHp, playerMana) {
  window._autoBattleLiveHp   = undefined;
  window._autoBattleLiveMana = undefined;
  document.getElementById('auto-battle-hud').style.display    = 'none';
  document.getElementById('auto-battle-bar').style.display    = 'none';
  document.getElementById('battle-arena').style.display       = 'none';
  document.getElementById('battle-zone-select').style.display = 'block';
  updateZoneLocks();
  try {
    if (_uid) await updateDoc(doc(db, 'characters', _uid), { hp: playerHp, mana: playerMana });
  } catch(e) { console.warn('Auto-battle stop save failed:', e); }
  await refreshCharData();
  _syncAllDisplays(_charData);
  logActivity('🛑', `Auto-battle stopped · ${playerHp} HP remaining`, '#aaa');
}

// Called by popup Fight button
window._confirmFight = async function() {
  const grade   = window._pendingEncounterGrade || window._currentBattleGrade;
  const zone    = window._pendingEncounterZone  || window._selectedZoneName || null;
  const monster = window._pendingEncounterMonster;
  console.log('[BATTLE] _confirmFight called, showing stance modal');
  window._closeEncounterPopup();
  if (!grade) return;
  // Show stance selection before starting manual fight
  window._showStanceModal('farming', async () => {
    console.log('[BATTLE] Stance confirmed, starting battle');
    const btn = document.getElementById('btn-start-battle');
    try {
      // Check pool for manual fight too — inside try so any Firestore error surfaces
      const exhausted = await window._checkZonePool(zone, grade);
      if (exhausted) { window._showPoolExhausted(zone, grade); return; }
      window._showBattleLoading('fight');
      if (btn) { btn.disabled = true; btn.textContent = '⚔️ LOADING...'; }
      window._currentBattleGrade = grade;
      window._currentBattleZone  = zone;
      console.log('[BATTLE] Calling _clientStartBattle');
      const result = { data: await _clientStartBattle(grade, zone, monster) };
      const d = result.data;
      _currentBattle = { grade, ...d };
      console.log('[BATTLE] Battle data received, waiting to hide loading');
      await window._hideBattleLoading();
      console.log('[BATTLE] Battle loading hidden, calling showBattleArena');
      showBattleArena(d.monster, d.playerHp, d.playerMana);
      console.log('[BATTLE] showBattleArena completed');
      // refreshCharData() removed here — it was re-triggering panel state resets
      // (checkDeathState / _onPanelSwitch side-effects) right after the arena opened.
      // Character data is already current from login; full refresh happens on victory/defeat.
    } catch(err) {
      await window._hideBattleLoading?.();
      console.error('[BATTLE] _confirmFight failed:', err);
      window.showToast(err.message || 'Battle failed. Try again.', 'error');
      // Restore zone-select so panel is never blank after an error
      const zs = document.getElementById('battle-zone-select');
      const ba = document.getElementById('battle-arena');
      if (zs && (!ba || ba.style.display === 'none')) zs.style.display = 'block';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚔️ FIGHT'; }
    }
  });
};

// _confirmAutoBattle kept for legacy callers — routes to new loop
window._confirmAutoBattle = async function() {
  const grade = window._pendingEncounterGrade || window._currentBattleGrade;
  const zone  = window._pendingEncounterZone  || window._selectedZoneName || null;
  window._closeEncounterPopup();
  if (!grade) return;
  window._startAutoBattle(grade, zone);
};
 
function showBattleArena(monster, playerHp, playerMana) {
  try {
    console.log('[BATTLE] showBattleArena called, monster:', monster?.name);
    const panelBattle = document.getElementById('panel-battle');
    if (panelBattle) {
      console.log('[BATTLE] panel-battle element found, has active class:', panelBattle.classList.contains('active'));
    } else {
      console.error('[BATTLE] panel-battle element NOT found!');
    }
    // Defensively hide every competing panel so nothing can blank or overlap the arena
    const _sel = (id) => document.getElementById(id);
    if (_sel('battle-zone-select'))  _sel('battle-zone-select').style.display  = 'none';
    if (_sel('battle-result'))       _sel('battle-result').style.display       = 'none';
    if (_sel('auto-battle-bar'))     _sel('auto-battle-bar').style.display     = 'none';
    if (_sel('auto-battle-hud'))     _sel('auto-battle-hud').style.display     = 'none';
    if (_sel('boss-raid-ui'))        _sel('boss-raid-ui').style.display        = 'none';
    if (_sel('boss-raid-arena'))     _sel('boss-raid-arena').style.display     = 'none';
    if (_sel('zone-pool-exhausted')) _sel('zone-pool-exhausted').style.display = 'none';
    if (_sel('battle-dead-banner'))  _sel('battle-dead-banner').style.display  = 'none';
    const arenaEl = _sel('battle-arena');
    if (arenaEl) {
      console.log('[BATTLE] Arena element found, current style.cssText:', arenaEl.style.cssText);
      arenaEl.style.display = 'block';
      console.log('[BATTLE] Set display=block, new style.cssText:', arenaEl.style.cssText);
      // Intercept any subsequent display changes to detect what's hiding it
      const originalDescriptor = Object.getOwnPropertyDescriptor(arenaEl.style, 'display');
      Object.defineProperty(arenaEl.style, 'display', {
        get() { return arenaEl.style.cssText.match(/display:\s*([^;]+)/)?.[1] || 'block'; },
        set(value) {
          console.log('[BATTLE] ⚠️ battle-arena display changing to:', value, 'stack:', new Error().stack.split('\n').slice(1, 4).join(' | '));
          arenaEl.style.cssText = arenaEl.style.cssText.replace(/display:\s*[^;]+;?/, '') + '; display: ' + value + ';';
        }
      });
      console.log('[BATTLE] battle-arena display set to block and monitoring for changes');
    } else {
      console.error('[BATTLE] battle-arena element not found!');
    }
    if (_sel('battle-actions'))      _sel('battle-actions').style.display      = 'flex';
    _battleMode = 'farming'; // lock mode so no async listener can flip it mid-fight
    // Scroll main-content to top so the arena is visible on mobile
    // (the panel may have been scrolled down while browsing zone cards)
    const _mc = document.querySelector('.main-content');
    if (_mc) _mc.scrollTop = 0;
    
    // Monitor for anything hiding the battle panel
    if (panelBattle && !window._battlePanelObserver) {
      window._battlePanelObserver = new MutationObserver((mutations) => {
        mutations.forEach(m => {
          if (m.type === 'attributes') {
            if (m.attributeName === 'style') {
              console.log('[BATTLE] 🔍 panel-battle style changed to:', panelBattle.getAttribute('style'));
            }
            if (m.attributeName === 'class') {
              console.log('[BATTLE] 🔍 panel-battle class changed to:', panelBattle.className, 'has active?', panelBattle.classList.contains('active'));
              if (!panelBattle.classList.contains('active')) {
                console.error('[BATTLE] ❌ CRITICAL: panel-battle lost active class!');
                new Error('[BATTLE] panel-battle lost active class').stack.split('\n').forEach(line => console.error(line));
              }
            }
          }
        });
      });
      window._battlePanelObserver.observe(panelBattle, { attributes: true, attributeFilter: ['style', 'class'] });
      console.log('[BATTLE] Monitoring panel-battle for changes');
    }
    
    _renderBattlePotionStrip();

    // Log parent container status too
    setTimeout(() => {
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        const computed = window.getComputedStyle(mainContent);
        console.log('[BATTLE] 200ms - main-content:', {
          display: computed.display,
          height: computed.height,
          overflow: computed.overflow,
          offsetHeight: mainContent.offsetHeight,
          offsetWidth: mainContent.offsetWidth
        });
      }
      
      const computedArena = window.getComputedStyle(arenaEl);
      const computedPanel = window.getComputedStyle(panelBattle);
      console.log('[BATTLE] 200ms later - arena display:', computedArena.display, 'arena visibility:', computedArena.visibility);
      console.log('[BATTLE] 200ms later - panel display:', computedPanel.display, 'panel visibility:', computedPanel.visibility);
      console.log('[BATTLE] 200ms later - arena offsetHeight:', arenaEl.offsetHeight, 'offsetWidth:', arenaEl.offsetWidth);
      console.log('[BATTLE] 200ms later - arena computed height:', computedArena.height, 'width:', computedArena.width);
      
      // Check all children visibility
      const monsterNameEl = document.getElementById('monster-name');
      if (monsterNameEl) {
        const computed = window.getComputedStyle(monsterNameEl);
        console.log('[BATTLE] 200ms later - monster-name element:', {
          display: computed.display,
          visibility: computed.visibility,
          offsetHeight: monsterNameEl.offsetHeight,
          offsetWidth: monsterNameEl.offsetWidth,
          textContent: monsterNameEl.textContent
        });
      }
    }, 200);

    // Re-enable battle action buttons for new battle
    const btns = document.querySelectorAll('.battle-action-btn');
    btns.forEach(b => b.disabled = false);

    console.log('[BATTLE] Populating arena with monster data:', monster);
    set('monster-name',  monster.name);
    set('monster-grade', monster.levelBand ? `Lv. ${monster.levelBand}` : `Grade ${monster.grade}`);
    console.log('[BATTLE] Monster name/grade set');
    updateBattleBars(monster.hp, monster.maxHp, playerHp, _charData?.hpMax||100, playerMana, _charData?.manaMax||50);
    console.log('[BATTLE] Battle bars updated');

    set('battle-player-name', _charData?.name || '—');
    set('battle-player-rank', `${_charData?.rank||'Wanderer'} Lv.${_displayLevel(_charData?.level||1)}`);
    console.log('[BATTLE] Player name/rank set');

    // Monster emoji by grade
    _renderMonsterAvatar('monster-avatar-emoji', monster);
    console.log('[BATTLE] Monster avatar rendered');

    // Player avatar
    const playerAvatarEl = document.getElementById('player-battle-avatar');
    if (playerAvatarEl && _charData) {
      const av = _charData.avatarUrl;
      playerAvatarEl.innerHTML = av?.startsWith('http')
        ? `<img src="${av}" style="width:60px;height:60px;border-radius:50%;border:2px solid var(--gold-dim);object-fit:cover;"/>`
        : `<span style="font-size:2.2rem">${av || '⚔️'}</span>`;
    }

  // Populate skill menu — gated by rank tier + mana affordability, respects active stance
  function renderSkillMenu() {
    try {
      const RANK_ORDER_BATTLE = ["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"];
      const playerRankIdx = Math.max(0, RANK_ORDER_BATTLE.indexOf(_charData?.rank || "Wanderer"));
      if (playerRankIdx === 0 && _charData?.rank && !RANK_ORDER_BATTLE.includes(_charData.rank)) {
        console.warn('[BATTLE] Player rank not found in RANK_ORDER_BATTLE:', _charData.rank);
      }
      const tree = SKILL_TREES[_charData?.charClass] || {};
      // Build ordered list with tier info
      const tieredSkills = [
        ...(tree.basic        || []).map(s => ({ name: s.name, tier: 0, tierLabel: "Basic" })),
        ...(tree.intermediate || []).map(s => ({ name: s.name, tier: 1, tierLabel: "Intermediate" })),
        ...(tree.advanced     || []).map(s => ({ name: s.name, tier: 2, tierLabel: "Advanced" })),
      ];

      // Filter to active stance if one is set
      const activeIdx = window._activeStanceIdx;
      const stances   = _getStances();
      const stanceSkills = (activeIdx !== null && stances[activeIdx]?.skills?.length)
        ? new Set(stances[activeIdx].skills) : null;

      const menuList = document.getElementById('skill-menu-list');
      if (menuList) {
        // Show stance badge if a stance is active
        const stanceBadge = stanceSkills
          ? `<div class="skill-menu-stance-badge">⚔ ${stances[activeIdx].name}</div>`
          : '';

        const filteredSkills = stanceSkills
          ? tieredSkills.filter(s => stanceSkills.has(s.name))
          : tieredSkills;

        menuList.innerHTML = stanceBadge + filteredSkills.map(({ name: s, tier, tierLabel }) => {
          const sk         = SKILL_DATA[s] || {};
          const cost       = sk.mana || 0;
          const rankUnlocked = playerRankIdx >= tier;
          const canAfford  = playerMana >= cost;
          const usable     = rankUnlocked && canAfford;
          const manaLabel  = cost === 0
            ? `<span style="color:#4caf8a;font-size:0.68rem">Free</span>`
            : `<span style="color:${canAfford?'#6ab0f5':'#e05555'};font-size:0.68rem">${cost} MP</span>`;
          const lockLabel  = !rankUnlocked
            ? `<span style="color:#888;font-size:0.65rem">🔒 ${tierLabel}</span>`
            : '';
          return `
            <div class="skill-menu-item${usable ? '' : ' skill-locked-mana'}"
                 data-skill="${s}" data-usable="${usable}"
               style="opacity:${usable?'1':'0.4'};cursor:${usable?'pointer':'not-allowed'}">
            <span class="skill-menu-item-name">${s}</span>
            <span style="display:flex;gap:6px;align-items:center">${manaLabel}${lockLabel}</span>
          </div>`;
      }).join('') || '<div style="color:var(--text-dim);font-style:italic;padding:12px;font-size:0.82rem">No skills in this stance. Edit it in the Skills panel.</div>';

      // Wire tappable skill items via addEventListener (safe — avoids broken inline onclick)
      menuList.querySelectorAll('.skill-menu-item[data-usable="true"]').forEach(el => {
        el.addEventListener('click', () => {
          window._battleTurn('skill', el.dataset.skill);
          window.closeBattleSkillMenu?.();
        });
      });
    }
    } catch(skillMenuErr) {
      console.warn('[BATTLE] renderSkillMenu error:', skillMenuErr);
      const menuList = document.getElementById('skill-menu-list');
      if (menuList) {
        menuList.innerHTML = '<div style="color:var(--text-dim);font-style:italic;padding:12px;font-size:0.82rem">⚠️ Error loading skills. Please report this.</div>';
      }
    }
  }
  renderSkillMenu();
  // Expose for updates after each turn
  window._renderSkillMenu = renderSkillMenu;

  // ── Open / close helpers for the manual battle skill panel ──
  // Works whether the HTML uses id="skill-menu-wrap" or a parent div around skill-menu-list.
  function _getSkillMenuContainer() {
    // Try explicit wrapper first, then fall back to parent of the list
    return document.getElementById('skill-menu-wrap')
        || document.getElementById('skill-menu-list')?.parentElement
        || null;
  }
  window.openBattleSkillMenu = function() {
    const actionsEl = document.getElementById('battle-actions');
    if (actionsEl) actionsEl.style.display = 'none';
    const wrap = _getSkillMenuContainer();
    if (!wrap) return;
    wrap.style.display = 'block';
    renderSkillMenu(); // refresh mana/rank state each open
  };
  window.closeBattleSkillMenu = function() {
    const actionsEl = document.getElementById('battle-actions');
    if (actionsEl) actionsEl.style.display = 'flex';
    const wrap = _getSkillMenuContainer();
    if (wrap) wrap.style.display = 'none';
  };

  // ── Wire the SKILL button in the battle arena ──
  const skillActionBtn = document.getElementById('btn-skill');
  if (skillActionBtn) {
    // Remove old listener by replacing element clone trick, then re-add
    const newSkillBtn = skillActionBtn.cloneNode(true);
    // CRITICAL: remove HTML onclick so it does not fire openSkillMenu() alongside the new listener
    newSkillBtn.removeAttribute('onclick');
    skillActionBtn.parentNode?.replaceChild(newSkillBtn, skillActionBtn);
    newSkillBtn.addEventListener('click', () => {
      const wrap = _getSkillMenuContainer();
      if (!wrap) return;
      const isOpen = wrap.style.display === 'block';
      if (isOpen) {
        window.closeBattleSkillMenu();
      } else {
        window.openBattleSkillMenu();
      }
    });
  }

  addBattleLog(`⚔️ You encountered a ${monster.name}! ${monster.levelBand ? '(Lv.' + monster.levelBand + ')' : '(Grade ' + monster.grade + ')'}`);
  } catch(err) {
    console.error('[BATTLE] showBattleArena error:', err);
    window.showToast('Battle display error: ' + (err.message || 'Unknown'), 'error');
    // Restore zone-select so panel is never blank
    const zs = document.getElementById('battle-zone-select');
    if (zs) zs.style.display = 'block';
  }
}
 
window._battleTurn = async function(action, skillName) {
  const btns = document.querySelectorAll('.battle-action-btn');
  btns.forEach(b => b.disabled = true);

  try {
    const result = { data: await _clientBattleTurn(action, skillName || null) };
    const d = result.data;

    // Update log
    if (d.log) d.log.forEach(l => addBattleLog(l));

    if (d.status === 'ongoing') {
      updateBattleBars(
        d.monster.hp, d.monster.maxHp || _currentBattle?.monster?.maxHp || d.monster.hp,
        d.playerHp,   _charData?.hpMax||100,
        d.playerMana, _charData?.manaMax||50
      );
      btns.forEach(b => b.disabled = false);
      // Update skill menu for new mana/buffs
      if (window._renderSkillMenu) window._renderSkillMenu();

    } else if (d.status === 'fled') {
      window.showToast('🐔 YOU CAN NEVER BE STRONG — You fled! (-10 gold)', 'error');
      await refreshCharData();
      // Return to zone select
      document.getElementById('battle-arena').style.display       = 'none';
      document.getElementById('battle-result').style.display      = 'none';
      document.getElementById('battle-zone-select').style.display = 'block';

    } else {
      // victory or defeat
      await refreshCharData();
      showBattleResult(d);
    }

  } catch(err) {
    console.error(err);
    window.showToast(err.message || 'Turn failed.', 'error');
    btns.forEach(b => b.disabled = false);
  }
};

function showBattleResult(d) {
  _currentBattle = null; // unblock passive regen now that the fight is over
  document.getElementById('battle-arena').style.display  = 'none';
  const resultEl = document.getElementById('battle-result');
  if (resultEl) {
    resultEl.style.display = 'block';
    resultEl.style.visibility = 'visible';
    resultEl.style.opacity = '1';
    setTimeout(() => resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }
  document.getElementById('auto-battle-bar').style.display = 'none';

  const isVictory = d.status === 'victory';
  set('battle-result-icon',  isVictory ? '🏆' : '💀');
  set('battle-result-title', isVictory ? 'VICTORY!' : 'DEFEATED');

  const logEl = document.getElementById('battle-result-log');
  if (logEl && d.log) {
    logEl.innerHTML = d.log.map(l => `<div class="battle-result-log-line">${l}</div>`).join('');
  }

  if (d.status === 'defeat') {
    window.showToast('You were defeated. Resurrect in 5 hours.', 'error');
    checkDeathState();
  }
  // Activity log
  window._logBattleResult?.(d);

  // Sync all displays after battle
  if (d.updates) {
    Object.assign(_charData, d.updates);
    window._charData = _charData;
    if (d.leveledUp) {
      window.showToast(`🎉 LEVEL UP! Now Level ${d.newLevel} ${d.newRank}!`, 'success');
    }
  }
  // Always sync HP/mana/gold/xp from latest charData
  if (_charData) {
    _syncAllDisplays(_charData);
  }
}
 
// ── Battle quick-use potion strip ───────────────────────────────────────────
function _renderBattlePotionStrip() {
  const strip = document.getElementById('battle-potion-strip');
  if (!strip || !_charData) return;
  const inv = _charData.inventory || [];

  // Collect HP and Mana potions from inventory
  const hpPotions   = inv.filter(i => i.name && (i.name.includes('HP Potion') || i.name.includes('Health Potion')));
  const manaPotions = inv.filter(i => i.name && i.name.includes('Mana Potion'));
  const allPotions  = [...hpPotions, ...manaPotions];

  if (!allPotions.length) {
    strip.innerHTML = `<span style="font-size:0.72rem;color:var(--ash);font-style:italic">No potions in inventory</span>`;
    return;
  }

  strip.innerHTML = allPotions.map(item => {
    const isHp   = item.name.includes('HP Potion') || item.name.includes('Health Potion');
    const icon   = isHp ? '🫧' : '💠';
    const col    = isHp ? '#e05555' : '#5b9fe0';
    const pct    = item.name.includes('Minor') ? '20%' : item.name.includes('Greater') ? '70%' : '40%';
    return `<button class="battle-potion-btn" title="${item.name} — restores ${pct} ${isHp?'HP':'Mana'} (×${item.qty||1})"
      onclick="window._useBattlePotion('${item.name.replace(/'/g,"\'")}','${isHp?'hp':'mana'}')"
      style="border-color:${col}44;color:${col}">
      ${icon}
      <span class="bp-name">${item.name.replace(' Potion','').replace(' Health','')}</span>
      <span class="bp-qty">×${item.qty||1}</span>
    </button>`;
  }).join('');
}

// Use a potion from the battle strip — calls existing useItem then re-renders strip + battle bars
window._useBattlePotion = async function(itemName, kind) {
  // Sync the live battle HP/Mana into _charData before useItem reads it.
  // In auto-battle: _autoBattleLiveHp is kept up-to-date by the battle loop.
  // In manual Fight: the live values live in the Firestore battles doc — read them now.
  if (_charData) {
    if (window._autoBattleLiveHp !== undefined) {
      _charData.hp   = window._autoBattleLiveHp;
    } else {
      // Manual Fight mode — read current HP/Mana from the battles doc
      try {
        const uid = auth.currentUser?.uid;
        if (uid) {
          const bSnap = await getDoc(doc(db, 'battles', uid));
          if (bSnap.exists()) {
            const bData = bSnap.data();
            if (bData.playerHp   !== undefined) _charData.hp   = bData.playerHp;
            if (bData.playerMana !== undefined) _charData.mana = bData.playerMana;
          }
        }
      } catch(_) {}
    }
    if (window._autoBattleLiveMana !== undefined) _charData.mana = window._autoBattleLiveMana;
  }

  await window.useItem(itemName, 'potion');
  _autoBattlePotionPending = true; // signal the auto-battle loop to pick up the healed values

  const curHp   = _charData?.hp   ?? 0;
  const curMana = _charData?.mana ?? 0;
  const hpMax   = _charData?.hpMax   || 100;
  const manaMax = _charData?.manaMax || 50;

  // CRITICAL: write healed values into the battles doc so _clientBattleTurn
  // reads the correct HP/Mana on the next manual turn (it reads from Firestore, not _charData).
  try {
    const uid = auth.currentUser?.uid;
    if (uid) {
      await updateDoc(doc(db, 'battles', uid), { playerHp: curHp, playerMana: curMana });
    }
  } catch(_) {}

  // Also keep the live variables in sync for auto-battle
  window._autoBattleLiveHp   = curHp;
  window._autoBattleLiveMana = curMana;

  _renderBattlePotionStrip();
  // Update the battle bars visually
  const monHpEl  = document.getElementById('monster-hp-text');
  const monHpStr = monHpEl?.textContent || '0 / 100';
  const [monCur, monMax] = monHpStr.split('/').map(s => parseInt(s.trim()) || 0);
  updateBattleBars(monCur, monMax || 1, curHp, hpMax, curMana, manaMax);
};

function updateBattleBars(monHp, monMax, plHp, plMax, plMana, plManaMax) {
  console.log('[BARS] updateBattleBars called with:', { monHp, monMax, plHp, plMax, plMana, plManaMax });
  const monPct  = Math.max(0, Math.round((monHp  / monMax)    * 100));
  const plPct   = Math.max(0, Math.round((plHp   / plMax)     * 100));
  const manaPct = Math.max(0, Math.round((plMana / plManaMax) * 100));
  css('monster-hp-fill', 'width', monPct  + '%');
  css('player-hp-fill',  'width', plPct   + '%');
  css('player-mp-fill',  'width', manaPct + '%');
  set('monster-hp-text', `${monHp} / ${monMax}`);
  set('player-hp-text',  `${plHp} / ${plMax}`);
  set('player-mp-text',  `${plMana} / ${plManaMax}`);
  console.log('[BARS] Battle bars updated');
}
 
function addBattleLog(msg) {
  const log = document.getElementById('battle-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'battle-log-entry';
  el.textContent = msg;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}
 
window._resurrect = async function() {
  const btn = document.getElementById('btn-resurrect');
  if (btn) { btn.disabled = true; btn.textContent = 'RESURRECTING...'; }

  try {
    const result = await fnResurrect({});
    window.showToast(result.data.message, 'success');
    await refreshCharData();
    document.getElementById('battle-dead-banner').style.display = 'none';
  } catch(err) {
    window.showToast(err.message || 'Cannot resurrect yet.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'RESURRECT'; }
  }
};

// ── Admin/Beta bypass: instantly revive a dead player (console use: adminRevivePlayer()) ──
window.adminRevivePlayer = async function(targetUid) {
  const uid = targetUid || _uid;
  if (!uid) { window.showToast('No UID available.', 'error'); return; }
  try {
    const charRef = doc(db, 'characters', uid);
    const snap = await getDoc(charRef);
    if (!snap.exists()) { window.showToast('Character not found.', 'error'); return; }
    const data = snap.data();
    if (!data.isDead) { window.showToast('Player is not dead.', 'info'); return; }
    await updateDoc(charRef, {
      isDead: false,
      hp: data.hpMax || 100,
      mana: data.manaMax || 50,
      resurrectAt: null
    });
    if (uid === _uid) {
      await refreshCharData();
      const banner = document.getElementById('battle-dead-banner');
      const zoneArea = document.getElementById('battle-zone-select');
      if (banner)   banner.style.display   = 'none';
      if (zoneArea) zoneArea.style.display = 'block';
      updateZoneLocks();
    }
    window.showToast(`✅ Admin revive applied${targetUid ? ' for ' + uid : ''}.`, 'success');
    console.log(`[ADMIN] Revived character: ${uid}`);
  } catch(err) {
    window.showToast('Admin revive failed: ' + err.message, 'error');
    console.error('[ADMIN] Revive error:', err);
  }
};
 
// Minimum rank index required per grade
const GRADE_RANK_REQ = { E:0, D:0, C:1, B:2, A:3, S:5 };
 
function updateZoneLocks() {
  if (!_charData) return;
  const playerLevel = _charData.level || 1;
  const location    = (_charData.location || "").toLowerCase().trim();

  // A card only unlocks when the player is physically present in that exact monster zone
  // AND meets the minimum player level for that zone.
  document.querySelectorAll(".zone-card[data-grade]").forEach(card => {
    const zoneName   = (card.dataset.zone || "").toLowerCase().trim();
    const zoneReq    = ZONE_LEVEL_REQ[card.dataset.zone] ?? 1;
    const levelLock  = playerLevel < zoneReq;
    const zoneLock   = location !== zoneName;
    const locked     = levelLock || zoneLock;

    card.classList.toggle("zone-locked", locked);
    const descEl = card.querySelector(".zone-desc");
    if (!descEl) return;
    if (locked) {
      if (!descEl.dataset.origText) descEl.dataset.origText = descEl.textContent;
      if (zoneLock && levelLock) {
        descEl.textContent = `🔒 Reach Lv.${zoneReq} & travel here`;
      } else if (levelLock) {
        descEl.textContent = `🔒 Requires Lv.${zoneReq}`;
      } else {
        descEl.textContent = `🗺️ Travel here first`;
      }
    } else if (descEl.dataset.origText) {
      descEl.textContent = descEl.dataset.origText;
    }
  });
}
 

// ═══════════════════════════════════════════════════
//  FARMING — ZONE POOL SYSTEM
// ═══════════════════════════════════════════════════

const ZONE_RESPAWN_MS = 10 * 60 * 1000; // 10 minutes
let _poolRespawnInterval = null;

// Read kill count for a zone from local _charData cache
function _getZoneKills(zoneName) {
  return _charData?.zoneKills?.[zoneName] || { count: 0, resetAt: 0 };
}

// Record a kill and persist to Firestore
window._recordZoneKill = async function(zoneName, grade) {
  if (!_charData || !_uid) return;
  const poolSize = ZONE_POOL_SIZE[grade] || 40;
  const kills    = _getZoneKills(zoneName);
  const now      = Date.now();

  // If already past resetAt, reset count first
  const resetAt  = kills.resetAt || 0;
  let   count    = (now >= resetAt && resetAt > 0) ? 0 : (kills.count || 0);

  count++;
  const newResetAt = count >= poolSize ? now + ZONE_RESPAWN_MS : resetAt;

  if (!_charData.zoneKills) _charData.zoneKills = {};
  _charData.zoneKills[zoneName] = { count, resetAt: newResetAt };

  try {
    await updateDoc(doc(db, 'characters', _uid), {
      [`zoneKills.${zoneName.replace(/\s+/g,'_')}`]: { count, resetAt: newResetAt }
    });
  } catch(e) { console.warn('Zone kill save failed:', e); }

  // Refresh pool status chip
  window._updateZonePoolStatus?.(zoneName);
};

// Returns true if the pool is exhausted (respawn timer running) — blocks entry
window._checkZonePool = async function(zoneName, grade) {
  if (!zoneName) return false;
  const poolSize = ZONE_POOL_SIZE[grade] || 40;
  // Always fetch fresh from Firestore so cooldown state is authoritative
  try {
    const snap = await getDoc(doc(db, 'characters', _uid));
    const data = snap.data();
    const key  = zoneName.replace(/\s+/g,'_');
    const zk   = data?.zoneKills?.[key] || { count: 0, resetAt: 0 };
    if (_charData) {
      if (!_charData.zoneKills) _charData.zoneKills = {};
      _charData.zoneKills[zoneName] = { count: zk.count||0, resetAt: zk.resetAt||0 };
    }
  } catch(e) { /* use cached */ }

  const kills   = _getZoneKills(zoneName);
  const now     = Date.now();
  const resetAt = kills.resetAt || 0;

  // Cooldown timer expired — pool has respawned, reset local cache
  if (resetAt > 0 && now >= resetAt) {
    if (_charData?.zoneKills?.[zoneName]) {
      _charData.zoneKills[zoneName] = { count: 0, resetAt: 0 };
    }
    return false;
  }

  // Cooldown timer still running — block regardless of count
  if (resetAt > 0 && now < resetAt) return true;

  // No timer running: block only if count has reached pool size
  return kills.count >= poolSize;
};

// Show the pool chip under the FIGHT/AUTO-BATTLE buttons
window._updateZonePoolStatus = function(zoneName) {
  const el = document.getElementById('zone-pool-status');
  if (!el || !zoneName) return;
  const card = document.querySelector(`.zone-card[data-zone="${zoneName}"]`);
  if (!card) { el.style.display = 'none'; return; }
  const grade    = card.dataset.grade;
  const poolSize = ZONE_POOL_SIZE[grade] || 40;
  const kills    = _getZoneKills(zoneName);
  const now      = Date.now();
  const resetAt  = kills.resetAt || 0;
  const count    = kills.count   || 0;

  el.style.display = 'block';

  // Cooldown is active: pool exhausted and timer hasn't expired
  if (resetAt > 0 && now < resetAt) {
    const msLeft  = resetAt - now;
    const m = Math.floor(msLeft / 60000);
    const s = Math.floor((msLeft % 60000) / 1000);
    el.textContent = `⏳ Cooldown: ${m}m ${s}s — ${count}/${poolSize} slain`;
    el.style.color = '#e07060';
    return;
  }

  // Pool has reset or not yet started
  if (resetAt > 0 && now >= resetAt) {
    el.textContent = `✅ Respawned — 0/${poolSize} slain`;
    el.style.color = 'var(--gold-dim)';
    return;
  }

  // Normal: show kills / total
  el.style.color = 'var(--gold-dim)';
  el.textContent = count >= poolSize
    ? `⚠️ Pool exhausted — respawn pending`
    : `👹 ${count} / ${poolSize} slain in ${zoneName}`;
};

// Show the exhausted banner with live countdown timer
window._showPoolExhausted = function(zoneName, grade) {
  document.getElementById('battle-zone-select').style.display = 'block';
  const banner = document.getElementById('zone-pool-exhausted');
  if (!banner) return;
  banner.style.display = 'block';
  const nameEl = document.getElementById('pool-exhausted-zone-name');
  if (nameEl) nameEl.textContent = zoneName || 'this zone';

  clearInterval(_poolRespawnInterval);
  const kills = _getZoneKills(zoneName);
  const resetAt = kills.resetAt || (Date.now() + ZONE_RESPAWN_MS);

  function tick() {
    const remaining = resetAt - Date.now();
    const timerEl = document.getElementById('pool-respawn-timer');
    if (!timerEl) return;
    if (remaining <= 0) {
      clearInterval(_poolRespawnInterval);
      timerEl.textContent = 'RESPAWNED!';
      timerEl.style.color = '#70c090';
      if (_charData?.zoneKills?.[zoneName]) {
        _charData.zoneKills[zoneName] = { count: 0, resetAt: 0 };
      }
      // Re-enable fight button after respawn
      const btn = document.getElementById('btn-start-battle');
      if (btn) btn.disabled = false;
      return;
    }
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${m}:${s.toString().padStart(2,'0')}`;
  }
  tick();
  _poolRespawnInterval = setInterval(tick, 1000);
};

// Pool exhausted choice handler
window._poolExhaustedChoice = function(choice) {
  const banner = document.getElementById('zone-pool-exhausted');
  clearInterval(_poolRespawnInterval);
  if (choice === 'wait') {
    // Just stay — timer keeps running
  } else if (choice === 'change') {
    if (banner) banner.style.display = 'none';
    // Deselect current card and scroll to zone grid
    document.querySelectorAll('.zone-card.selected').forEach(c => c.classList.remove('selected'));
    const btn = document.getElementById('btn-start-battle');
    if (btn) btn.disabled = true;
    document.getElementById('battle-zone-select')?.scrollIntoView({ behavior: 'smooth' });
  } else if (choice === 'stop') {
    if (banner) banner.style.display = 'none';
    document.querySelectorAll('.zone-card.selected').forEach(c => c.classList.remove('selected'));
    const btn = document.getElementById('btn-start-battle');
    if (btn) btn.disabled = true;
  }
};

// Zone → region name map (for auto-opening the right dropdown)
const ZONE_REGION_MAP = {
  // Dark Woodlands
  'Gremlin Hollows': 'Dark Woodlands', 'Serpent Mire': 'Dark Woodlands',
  'Burrowdeep Basin': 'Dark Woodlands', 'Root Grove': 'Dark Woodlands',
  'Crimson Fang': 'Dark Woodlands',
  // Shattered Heavens
  'Titan Divide': 'Shattered Heavens', 'Veilwater Basin': 'Shattered Heavens',
  'Frostfall Expanse': 'Shattered Heavens', 'Ember Horizon': 'Shattered Heavens',
  'Tempest Crown': 'Shattered Heavens',
  // Glass Hell
  'Lake of Reflections': 'Glass Hell', 'Crystal Cave': 'Glass Hell',
  'Mirror Sky': 'Glass Hell', 'Rainbow Valley': 'Glass Hell',
  'Shimmering Peak': 'Glass Hell',
  // Corrupted Hallows
  'Gravemarch Fields': 'Corrupted Hallows', 'Whispering Necropolis': 'Corrupted Hallows',
  'Defiled Sanctum': 'Corrupted Hallows', 'Dark Cathedral': 'Corrupted Hallows',
  'Fallen Bastion': 'Corrupted Hallows',
  // Otherworld
  'Blighted World': 'Otherworld', 'Leviathan Depths': 'Otherworld',
  'Ashwing Aerie': 'Otherworld', 'Sphinx Dominion': 'Otherworld',
  'Infernal Reach': 'Otherworld',
  // Nyx Abyss — Fallen Heaven
  'Fractured Firmament': 'Fallen Heaven', 'Maw of Eternity': 'Fallen Heaven',
  'Veil of Madness': 'Fallen Heaven', 'The Watching Expanse': 'Fallen Heaven',
  'Descent of the Nameless': 'Fallen Heaven',
  // Nyx Abyss — Underworld
  'Gravefall Descent': 'Underworld', 'Weeping Caverns': 'Underworld',
  'Kingdom of Chains': 'Underworld', 'The Hollow Deep': 'Underworld',
  'Throne of the Depths': 'Underworld',
  // Nyx Abyss — Land of Sin
  'Throne of Pride': 'Land of Sin', 'Hallow of Greed': 'Land of Sin',
  'Crimson Feast': 'Land of Sin', 'Veil of Desire': 'Land of Sin',
  'The Forsaken Graves': 'Land of Sin',
  // Nyx Abyss — Cosmos
  'Bleeding Constellations': 'Cosmos', 'The Watching Worlds': 'Cosmos',
  'Nebula of Whispers': 'Cosmos', 'Eclipse Throne': 'Cosmos',
  'The Endless Maw': 'Cosmos',
  // Nyx Abyss — The Withering Tree
  'Root of Malevolence': 'The Withering Tree', 'Grove of Horror': 'The Withering Tree',
  'Canopy of Despair': 'The Withering Tree', 'Crown of Madness': 'The Withering Tree',
  'Heartwood Abyss': 'The Withering Tree',
};

// Toggle a region open/closed manually
window.toggleZoneRegion = function(btn) {
  const region = btn.closest('.zone-region');
  if (!region) return;
  const body = region.querySelector('.zone-region-body');
  const arrow = region.querySelector('.zone-region-arrow');
  const isCollapsed = region.classList.toggle('collapsed');
  if (body) body.style.display = isCollapsed ? 'none' : 'block';
  if (arrow) arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
};

// Open the region containing the given zone name; collapse all others
function _openRegionForZone(zoneName) {
  const targetRegion = ZONE_REGION_MAP[zoneName];
  if (!targetRegion) return;
  document.querySelectorAll('.zone-region').forEach(r => {
    const isTarget = r.dataset.region === targetRegion;
    const body = r.querySelector('.zone-region-body');
    const arrow = r.querySelector('.zone-region-arrow');
    r.classList.toggle('collapsed', !isTarget);
    if (body) body.style.display = isTarget ? 'block' : 'none';
    if (arrow) arrow.style.transform = isTarget ? '' : 'rotate(-90deg)';
  });
}

// Called when battle panel opens — refresh zone locks and hint
window._refreshFarmingZones = function() {
  updateZoneLocks();
  const loc = _charData?.kingdom || _charData?.location || '';
  const hint = document.getElementById('farming-location-hint');
  if (hint) {
    const short = loc.split('—')[0].trim() || '—';
    hint.textContent = `📍 LOCATION: ${short.toUpperCase()}`;
  }
  // Hide exhausted banner on fresh open
  const banner = document.getElementById('zone-pool-exhausted');
  if (banner) banner.style.display = 'none';

  // Auto-open the region matching the player's current location
  const locLower = loc.toLowerCase().trim();
  const matchedZone = Object.keys(ZONE_REGION_MAP).find(z => z.toLowerCase() === locLower);
  if (matchedZone) {
    _openRegionForZone(matchedZone);
  } else {
    // Not in any known zone — collapse all, leave user to open manually
    document.querySelectorAll('.zone-region').forEach(r => {
      r.classList.add('collapsed');
      const body = r.querySelector('.zone-region-body');
      const arrow = r.querySelector('.zone-region-arrow');
      if (body) body.style.display = 'none';
      if (arrow) arrow.style.transform = 'rotate(-90deg)';
    });
  }
};

// Auto-select a zone card by name (used by map "Fight Here" button)
window._autoSelectZoneByName = function(zoneName) {
  const card = document.querySelector(`.zone-card[data-zone="${zoneName}"]`);
  if (!card || card.classList.contains('zone-locked')) return;
  // Open the region containing this zone first
  _openRegionForZone(zoneName);
  const grade = card.dataset.grade;
  document.querySelectorAll('.zone-card:not(.zone-locked)').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
  window._selectedZoneName = zoneName;
  const btn = document.getElementById('btn-start-battle');
  if (btn) btn.disabled = false;
  window._updateZonePoolStatus?.(zoneName);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function checkDeathState() {
  const banner     = document.getElementById('battle-dead-banner');
  const zoneArea   = document.getElementById('battle-zone-select');
  const arena      = document.getElementById('battle-arena');
  const result     = document.getElementById('battle-result');
  const bossRaidUI = document.getElementById('boss-raid-ui');
  const bossArena  = document.getElementById('boss-raid-arena');
  const autoBatBar = document.getElementById('auto-battle-bar');

  if (_charData?.isDead) {
    if (banner)     banner.style.display     = 'flex';
    if (zoneArea)   zoneArea.style.display   = 'none';
    if (arena)      arena.style.display      = 'none';
    if (result)     result.style.display     = 'none';
    if (bossRaidUI) bossRaidUI.style.display = 'none';
    if (bossArena)  bossArena.style.display  = 'none';
    if (autoBatBar) autoBatBar.style.display = 'none';

    // Show resurrection potion button only if player has one
    const resPotionWrap = document.getElementById('btn-use-res-potion-wrap');
    if (resPotionWrap) {
      const hasPotion = (_charData?.inventory || []).some(i => i.name === 'Resurrection Potion' && (i.qty ?? 1) > 0);
      resPotionWrap.style.display = hasPotion ? 'block' : 'none';
    }

    const resurrectAt = _charData.resurrectAt?.toDate?.() || new Date(_charData.resurrectAt);
    if (resurrectAt) {
      const interval = setInterval(() => {
        const remaining = resurrectAt - Date.now();
        if (remaining <= 0) {
          clearInterval(interval);
          set('battle-dead-timer', 'You can now resurrect!');
          return;
        }
        const h = Math.floor(remaining / 3600000);
        const m = Math.floor((remaining % 3600000) / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        set('battle-dead-timer', `${h}h ${m}m ${s}s remaining`);
      }, 1000);
    }
  } else {
    if (banner) banner.style.display = 'none';
    // Only show zone-select if no other battle UI is currently active.
    // Prevents checkDeathState (called on every panel switch) from clobbering
    // battle-arena / boss-raid-arena / result screen mid-fight.
    const arenaVisible   = arena      && arena.style.display      !== 'none';
    const resultVisible  = result     && result.style.display     !== 'none';
    const bossVisible    = bossRaidUI && bossRaidUI.style.display !== 'none';
    const bossArenaVis   = bossArena  && bossArena.style.display  !== 'none';
    const autoBarVisible = autoBatBar && autoBatBar.style.display !== 'none';
    // Also guard on JS-level battle flags — prevents checkDeathState from restoring
    // zone-select during the brief window between _showBattleLoading and showBattleArena
    // where arena.style.display is still 'none' but a fight is already committed.
    const battleFlagActive = !!window._currentBattle || !!window._autoBattleRunning;
    const noBattleActive = !arenaVisible && !resultVisible && !bossVisible && !bossArenaVis && !autoBarVisible && !battleFlagActive;
    console.log('[BATTLE] checkDeathState: arenaVisible=', arenaVisible, 'battleFlagActive=', battleFlagActive, 'noBattleActive=', noBattleActive);
    if (zoneArea && noBattleActive) zoneArea.style.display = 'block';
    updateZoneLocks();
  }
}

// ═══════════════════════════════════════════════════
//  MULTI-MODE BATTLE SYSTEM EXTENSION
// ═══════════════════════════════════════════════════

// Battle modes: 'farming', 'boss', 'pvp'
let _battleMode = 'farming';
window.setBattleMode = function(mode) {
  _battleMode = mode;
  // Update UI as needed (implement UI selector in HTML)
  if (typeof updateBattleModeUI === 'function') updateBattleModeUI(mode);
};

// UI update for battle mode selector
window.updateBattleModeUI = function(mode) {
  const farmingBtn = document.getElementById('btn-mode-farming');
  const bossBtn    = document.getElementById('btn-mode-boss');
  if (!farmingBtn || !bossBtn) return;
  farmingBtn.classList.remove('btn-active');
  bossBtn.classList.remove('btn-active');
  switch (mode) {
    case 'farming': farmingBtn.classList.add('btn-active'); break;
    case 'boss':    bossBtn.classList.add('btn-active');    break;
  }
  // Update subtitle
  const subtitle = document.getElementById('battle-subtitle');
  if (subtitle) {
    if (mode === 'farming') subtitle.textContent = 'Choose a monster zone and fight for EXP, gold and resources';
    else if (mode === 'boss') subtitle.textContent = 'Team up and challenge a powerful boss!';
  }

  // Show/hide UI sections for each mode
  const zoneSelect = document.getElementById('battle-zone-select');
  const bossRaidUI = document.getElementById('boss-raid-ui');
  // Don't restore zone-select if a fight is already in progress
  const _arenaEl = document.getElementById('battle-arena');
  const _arenaActive = (_arenaEl && _arenaEl.style.display !== 'none') || !!window._currentBattle || !!window._autoBattleRunning;
  if (zoneSelect && !_arenaActive) zoneSelect.style.display = (mode === 'farming') ? 'block' : 'none';
  if (bossRaidUI) {
    bossRaidUI.style.display = (mode === 'boss') ? 'block' : 'none';
    if (mode === 'boss') {
      window.showBossSelect();
      // If a raid is already active in Firestore, pull this member in now
      if (_party && _party.raid && _party.raid.active && _party.raid.bossId) {
        if (_party.raid.state) {
          // Mid-raid: sync state directly — never re-init startBossRaid here
          _bossRaidState = _party.raid.state;
          if (_bossRaidState && Array.isArray(_bossRaidState.party) && typeof _uid !== 'undefined') {
            _bossRaidState.myIdx = _bossRaidState.party.findIndex(p => p.uid === _uid);
          }
          // Show arena, hide the boss-raid-ui (party/boss-select screens live inside it)
          const arenaEl = document.getElementById('boss-raid-arena');
          if (arenaEl) arenaEl.style.display = 'block';
          const bossRaidUiEl = document.getElementById('boss-raid-ui');
          if (bossRaidUiEl) bossRaidUiEl.style.display = 'none';
          // Populate boss display fields
          const _bs2 = _bossRaidState.boss;
          const _bnEl2 = document.getElementById('raid-boss-arena-name');
          if (_bnEl2) _bnEl2.textContent = _bs2.name || '—';
          const _baEl2 = document.getElementById('raid-boss-abilities-hint');
          if (_baEl2) _baEl2.textContent = 'Abilities: ' + (_bs2.abilities || []).map(a => typeof a === 'object' ? (a.name || '—') : String(a)).join(' · ');
          const _bavEl2 = document.getElementById('raid-boss-emoji-avatar');
          if (_bavEl2) {
            _bavEl2.innerHTML = _bs2.imageUrl
              ? `<img src="${_bs2.imageUrl}" alt="${_bs2.name}" style="width:72px;height:72px;border-radius:12px;object-fit:cover;border:2px solid var(--gold);box-shadow:0 0 12px rgba(212,175,55,0.35)"/>`
              : `<span style="font-size:3.2rem">${_bs2.icon || '👹'}</span>`;
          }
          // Seed log with synced entries
          const _rlogEl2 = document.getElementById('raid-log');
          if (_rlogEl2) {
            _rlogEl2.innerHTML = (_bossRaidState.log || []).slice(-20).map(l => `<div class="battle-log-entry">${l}</div>`).join('');
            _rlogEl2.scrollTop = _rlogEl2.scrollHeight;
          }
          _refreshRaidUI();
        } else {
          // Raid just started, no state yet: trigger full join flow (stance → startBossRaid).
          // Guard against double-fire from panel switch + Firestore snapshot both running.
          if (!_raidLaunchInProgress) {
            _raidLaunchInProgress = true;
            const boss = BOSS_LIST.find(b => b.id === _party.raid.bossId);
            if (boss && Array.isArray(_party.members) && _party.members.length > 0) {
              Promise.all(_party.members.map(m => getDoc(doc(db, 'characters', m.uid)).then(s => s.exists() ? { uid: m.uid, ...s.data() } : null)))
                .then(members => window.startBossRaid(members.filter(Boolean), boss))
                .catch(err => {
                  console.error('[RAID DEBUG] updateBattleModeUI member fetch failed:', err);
                  _raidLaunchInProgress = false;
                });
            } else {
              _raidLaunchInProgress = false;
            }
          }
        }
      }
    }
  }
};

// Auto-highlight default mode on load
document.addEventListener('DOMContentLoaded', function() {
  if (document.getElementById('panel-battle')) {
    window.updateBattleModeUI(_battleMode);
    // Show boss select UI if boss mode is selected
    if (_battleMode === 'boss') window.showBossSelect();
  }

  // Init chat duel system — always runs regardless of which panels exist.
  // Polls until _uid + _charData are ready (auth may not be settled at DOMContentLoaded).
  const _duelInitPoller = setInterval(() => {
    if (_uid && _charData) {
      clearInterval(_duelInitPoller);
      if (document.getElementById('panel-battle')) checkActivePvpMatch();
      if (window.initDuelSystem)  window.initDuelSystem(_uid, _charData);
      if (window.initTradeSystem) window.initTradeSystem(_uid, _charData);
    }
  }, 200);
});

// Example: call setBattleMode('boss') or setBattleMode('pvp') to switch

// Boss Raid State
let _bossRaidParty = [];
let _bossRaidLeaderIdx = 0;
let _bossRaidBoss = null;
let _bossRaidState = null;
let _suppressRaidAutoLaunch = false; // member-side guard: ignore snapshot re-trigger after leaving raid
let _raidLaunchInProgress = false;  // dedup guard: prevent double-init when Firestore fires multiple snapshots

// PVP State
let _pvpPlayers = [];
let _pvpTurnIdx = 0;
let _pvpState = null;

// ═══════════════════════════════════════════════════
//  BOSS RAID — ARENA + TURN LOGIC
// ═══════════════════════════════════════════════════

function _calcEquipBonus(c) {
  let bonus = { str:0, int:0, def:0, dex:0, hp:0 };
  // Always use the raw Firestore inventory (c.inventory) for enchant lookup — NOT the filtered
  // display array (_allInvItems excludes equipped items, so enchant level would read as 0).
  const rawInv = c.inventory || window._allInvItems || [];
  if (c.equipment?.weapon) {
    const wBase = c.equipment.weapon.replace(/\s*\+\d+$/, '').trim();
    const w = EQUIP_WEAPON_STATS[wBase];
    if (w) {
      const wItem = rawInv.find(i => (i.name||'').replace(/\s*\+\d+$/,'').trim() === wBase);
      const wEnchant = wItem?.enchantLevel || parseInt((wItem?.name||'').match(/\+(\d+)$/)?.[1] || '0');
      // Enchant adds +1 per level only to stats the weapon/armor actually contributes (consistent with duel.js)
      for (const k in w) bonus[k] = (bonus[k]||0) + w[k] + (w[k] ? wEnchant : 0);
    }
  }
  if (c.equipment?.armor) {
    const aBase = c.equipment.armor.replace(/\s*\+\d+$/, '').trim();
    const a = EQUIP_ARMOR_STATS[aBase];
    if (a) {
      const aItem = rawInv.find(i => (i.name||'').replace(/\s*\+\d+$/,'').trim() === aBase);
      const aEnchant = aItem?.enchantLevel || parseInt((aItem?.name||'').match(/\+(\d+)$/)?.[1] || '0');
      for (const k in a) bonus[k] = (bonus[k]||0) + a[k] + (a[k] ? aEnchant : 0);
    }
  }
  const racePct = getRaceEquipBonus(c.race);
  for (const k in bonus) bonus[k] = Math.round(bonus[k] * (1 + racePct));
  return bonus;
}

function _buildFighter(c) {
  const stats = c.stats || { str:10, int:10, def:10, dex:10 };
  const bonus = _calcEquipBonus(c);

  // ── Base stats + equipment ──────────────────────────────────────────
  let str = (stats.str??10) + (bonus.str||0);
  let int_ = (stats.int??10) + (bonus.int||0);
  let def = (stats.def??10) + (bonus.def||0);
  let dex = (stats.dex??10) + (bonus.dex||0);
  let maxHp  = c.hpMax  ?? 100;
  let maxMana = c.manaMax ?? 50;

  // ── Active food buffs (timed, stored on charData.activeFoods) ──────
  const now = Date.now();
  const foods = c.activeFoods || {};
  if (foods.str && foods.str.expiry > now) str  = Math.round(str  * (1 + foods.str.pct));
  if (foods.int && foods.int.expiry > now) int_ = Math.round(int_ * (1 + foods.int.pct));
  if (foods.def && foods.def.expiry > now) def  = Math.round(def  * (1 + foods.def.pct));
  if (foods.dex && foods.dex.expiry > now) dex  = Math.round(dex  * (1 + foods.dex.pct));

  // ── Race bonuses (spec) ─────────────────────────────────────────────
  // Human: +10% EXP (applied at EXP award time, not here)
  // Orc: +10% melee damage (applied in damage calc via companion/race flag)
  // Undead: +10% melee resistance → effective DEF boost
  // Dragonborn: +10% magic resistance → tracked separately
  const race = (c.race || '').toLowerCase();
  if (race.includes('orc') || race.includes('warlord'))     str  = Math.round(str  * 1.10);
  if (race.includes('undead') || race.includes('lich'))     def  = Math.round(def  * 1.10);
  if (race.includes('fairy') || race.includes('spirit'))    { /* luck applied in drop rolls */ }

  // ── Companion bonuses (spec) ────────────────────────────────────────
  const comp = (c.companion?.name || '').toLowerCase();
  if (comp === 'emberling') str  = Math.round(str  * 1.10);   // +10% STR
  if (comp === 'pebblin')   def  += 10;                        // +10 flat DEF
  if (comp === 'zappit')    dex  = Math.round(dex  * 1.10);   // +10% DEX (Trackit +6% DEX)
  if (comp === 'trackit')   dex  = Math.round(dex  * 1.06);
  if (comp === 'bubbloon')  maxMana = Math.round(maxMana * 1.10); // +10% mana pool
  if (comp === 'glimmer')   { /* +15% healing received — applied in heal skills */ }
  if (comp === 'whispling') int_ = Math.round(int_ * 1.10);   // +10% INT during skills

  return {
    uid:       c.uid || c.id || '?',
    name:      c.name || 'Unknown',
    rank:      c.rank || 'Wanderer',
    level:     c.level || 1,
    charClass: c.charClass || 'Warrior',
    avatarUrl: c.avatarUrl || c.avatar || '',
    race:      c.race || '',
    companion: c.companion?.name || '',
    hp:        c.hp   ?? maxHp,
    maxHp,
    mana:      c.mana ?? maxMana,
    maxMana,
    str, int: int_, def, dex,
    status: 'alive',
  };
}

// ── Boss mechanic engine — keyed by type, not name ──
// Flavour (name) is free text written by the deity. Mechanics run on `type`.
const BOSS_MECHANIC_FNS = {
  aoe: (state, abilityName) => {
    const baseDmg = Math.round(state.boss.atk * 0.65);
    state.party.forEach(p => {
      if (p.status === 'alive') {
        const r = (p.race || '').toLowerCase();
        const resist = r.includes('elder dragon') ? 0.20 : r.includes('dragonborn') ? 0.10 : 0;
        const dmg = Math.round(baseDmg * (1 - resist));
        p.hp = Math.max(0, p.hp - dmg);
      }
    });
    return `🌊 ${abilityName}! All party members take ${dmg} damage!`;
  },
  drain: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive');
    if (!t) return '';
    const dmg = Math.round(state.boss.atk * 0.9);
    t.hp = Math.max(0, t.hp - dmg);
    state.boss.hp = Math.min(state.boss.maxHp, state.boss.hp + Math.round(dmg * 0.5));
    return `🩸 ${abilityName} — drains ${dmg} HP from ${t.name}! Boss heals for ${Math.round(dmg*0.5)}.`;
  },
  freeze: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive' && !p._frozen);
    if (!t) {
      // All alive members already frozen — fallback to basic attack
      return _bossBasicAttack(state, abilityName);
    }
    t._frozen = 1;
    return `❄️ ${abilityName} — ${t.name} is frozen and will skip their next turn!`;
  },
  weaken: (state, abilityName) => {
    state.party.forEach(p => { if (p.status === 'alive') p._weakened = 2; });
    return `💀 ${abilityName} — party attack reduced for 2 turns!`;
  },
  enrage: (state, abilityName) => {
    state.boss.atk = Math.round(state.boss.atk * 1.3);
    return `😡 ${abilityName}! ${state.boss.name} enrages — attack boosted by 30%!`;
  },
  shield: (state, abilityName) => {
    state.boss._shield = 2;
    return `🛡️ ${abilityName}! ${state.boss.name} raises a shield — 50% damage reduction for 2 turns!`;
  },
  instakill: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive');
    if (t && Math.random() < 0.15) {
      t.hp = 0;
      t.status = 'defeated';
      return `💀 ${abilityName}! ${t.name} is instantly slain by ${state.boss.name}!`;
    }
    return `💀 ${abilityName} — the killing gaze misses its mark...`;
  },
  heal: (state, abilityName) => {
    const healAmt = Math.round(state.boss.maxHp * 0.08);
    state.boss.hp = Math.min(state.boss.maxHp, state.boss.hp + healAmt);
    return `✨ ${abilityName}! ${state.boss.name} recovers ${healAmt} HP!`;
  },
  // ── Teleport: bypasses defense entirely, true damage to front target ──
  teleport: (state, abilityName) => {
    let target = state.party[state.leaderIdx];
    if (!target || target.status === 'defeated') target = state.party.find(p => p.status === 'alive');
    if (!target) return '';
    const dmg = Math.round(state.boss.atk * 1.1); // true dmg — no def reduction
    target.hp = Math.max(0, target.hp - dmg);
    if (target.hp <= 0) { target.status = 'defeated'; _advanceLeader(state); }
    return `🌀 ${abilityName}! ${state.boss.name} blinks behind ${target.name} — ${dmg} true damage, defense ignored!`;
  },

  // ── Summon: 2–4 phantom strikes hit random alive members ──
  summon: (state, abilityName) => {
    const alive = state.party.filter(p => p.status === 'alive');
    if (!alive.length) return '';
    const waves = _randInt(2, 4);
    let log = [];
    for (let i = 0; i < waves; i++) {
      const t = alive[_randInt(0, alive.length - 1)];
      const dmg = Math.round(state.boss.atk * 0.35);
      t.hp = Math.max(0, t.hp - dmg);
      log.push(`${t.name} −${dmg}`);
    }
    return `👾 ${abilityName}! ${waves} minions strike — ${log.join(', ')}!`;
  },

  // ── Curse: marks a random player; if they act next turn, curse detonates for big damage ──
  curse: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive' && !p._cursed);
    if (!t) return _bossBasicAttack(state, abilityName);
    t._cursed = Math.round(state.boss.atk * 1.4); // stores the detonation damage
    return `🔮 ${abilityName}! ${t.name} is cursed — acting while cursed will detonate it!`;
  },

  // ── Reflect: boss mirrors a share of next incoming damage back at attacker for 1 turn ──
  reflect: (state, abilityName) => {
    state.boss._reflect = 1;
    return `🪞 ${abilityName}! ${state.boss.name} mirrors the next attack — 40% of damage will be reflected!`;
  },

  // ── Berserk: triggers a massive guaranteed strike when boss HP < 30%, otherwise pressures ──
  berserk: (state, abilityName) => {
    const hpRatio = state.boss.hp / state.boss.maxHp;
    if (hpRatio <= 0.30) {
      // Full berserk mode — hits entire party hard
      const dmg = Math.round(state.boss.atk * 0.9);
      state.party.forEach(p => { if (p.status === 'alive') p.hp = Math.max(0, p.hp - dmg); });
      return `💢 ${abilityName}! ${state.boss.name} goes full berserk — ALL take ${dmg} damage!`;
    }
    // Above threshold: still dangerous but only a pressure hit
    const t = state.party.find(p => p.status === 'alive');
    if (!t) return '';
    const dmg = Math.round(state.boss.atk * 0.85);
    t.hp = Math.max(0, t.hp - dmg);
    if (t.hp <= 0) { t.status = 'defeated'; _advanceLeader(state); }
    return `💢 ${abilityName}! ${state.boss.name} rages — ${t.name} takes ${dmg} damage! (Full berserk triggers at ≤30% HP)`;
  },

  // ── Silence: blocks target's skill use next turn (clears mana to 0) ──
  silence: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive' && !p._silenced);
    if (!t) return _bossBasicAttack(state, abilityName);
    t._silenced = 1;
    return `🔇 ${abilityName}! ${t.name} is silenced — no skills next turn!`;
  },

  // ── Execute: guaranteed kill on any party member already below 20% HP ──
  execute: (state, abilityName) => {
    const lowHp = state.party.find(p => p.status === 'alive' && p.hp / p.maxHp <= 0.20);
    if (lowHp) {
      lowHp.hp = 0;
      lowHp.status = 'defeated';
      _advanceLeader(state);
      return `☠️ ${abilityName}! ${state.boss.name} executes ${lowHp.name} — they were below 20% HP!`;
    }
    // No valid target — does a strong single hit instead
    return _bossBasicAttack(state, abilityName) + ' (No target below 20% HP to execute.)';
  },

  // ── Blind: target's next attack has 60% chance to miss entirely ──
  blind: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive' && !p._blinded);
    if (!t) return _bossBasicAttack(state, abilityName);
    t._blinded = 1;
    return `👁️ ${abilityName}! ${t.name} is blinded — next attack has 60% chance to miss!`;
  },

  // ── Leech: hits entire party for moderate damage, boss heals for the total dealt ──
  leech: (state, abilityName) => {
    const dmg = Math.round(state.boss.atk * 0.45);
    let totalDrained = 0;
    state.party.forEach(p => {
      if (p.status === 'alive') {
        const actual = Math.min(p.hp, dmg);
        p.hp = Math.max(0, p.hp - dmg);
        totalDrained += actual;
      }
    });
    state.boss.hp = Math.min(state.boss.maxHp, state.boss.hp + totalDrained);
    return `🦠 ${abilityName}! Life leeched from all — party loses ${dmg} each, boss regains ${totalDrained} HP!`;
  },

  basic: (state, abilityName) => _bossBasicAttack(state, abilityName),

  // ── Wormhole: true AoE — ignores ALL defense, hits every living member ──
  wormhole: (state, abilityName) => {
    const dmg = Math.round(state.boss.atk * 0.80); // true dmg — no def reduction
    let hits = [];
    state.party.forEach(p => {
      if (p.status === 'alive') {
        p.hp = Math.max(0, p.hp - dmg);
        if (p.hp <= 0) { p.status = 'defeated'; }
        hits.push(`${p.name} −${dmg}`);
      }
    });
    _checkPartyDefeated(state);
    return `🌀 ${abilityName}! Reality tears open — ${hits.join(', ')}! (Defense ignored)`;
  },

  // ── Time Warp: boss immediately takes an extra basic attack this round ──
  timewarp: (state, abilityName) => {
    const first = _bossBasicAttack(state, abilityName);
    // Second strike — slightly weaker follow-up
    const second = _bossBasicAttack(state, `${abilityName} (echo)`);
    return `⏳ ${abilityName}! Time fractures — the boss strikes twice! ${first} | ${second}`;
  },

  // ── Petrify: target is locked for 2 turns (stronger than freeze) ──
  petrify: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive' && !p._petrified && !p._frozen);
    if (!t) return _bossBasicAttack(state, abilityName);
    t._petrified = 2; // handled same as _frozen in doRaidTurn but lasts 2 turns
    t._frozen = 2;    // reuse existing frozen check; value > 1 means multi-turn
    return `🗿 ${abilityName}! ${t.name} is turned to stone — cannot act for 2 turns!`;
  },

  // ── Shatter: permanently halves the target's DEF for the rest of the fight ──
  shatter: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive' && !(p._shattered));
    if (!t) return _bossBasicAttack(state, abilityName);
    t.def = Math.max(1, Math.floor((t.def || 10) * 0.5));
    t._shattered = true;
    const dmg = Math.round(state.boss.atk * 0.6);
    t.hp = Math.max(0, t.hp - dmg);
    if (t.hp <= 0) { t.status = 'defeated'; _advanceLeader(state); }
    return `💥 ${abilityName}! ${t.name}'s armor shatters — DEF halved permanently! Also takes ${dmg} damage!`;
  },

  // ── Doom Mark: target must defeat the boss within 3 turns or they die ──
  doommark: (state, abilityName) => {
    const t = state.party.find(p => p.status === 'alive' && !p._doomMarked);
    if (!t) return _bossBasicAttack(state, abilityName);
    t._doomMarked = 3; // countdown turns
    // Tick doom marks every boss turn in doRaidTurn (checked via _tickDoomMarks)
    return `💀 ${abilityName}! ${t.name} is marked for death — they will fall in 3 turns if the boss lives!`;
  },
};

function _bossUseAbility(state) {
  if (state.boss._stunned) {
    state.boss._stunned = false;
    return `💫 ${state.boss.name} is stunned — skips their turn!`;
  }
  const abilities = state.boss.abilities || [];
  if (!abilities.length) return _bossBasicAttack(state);

  // Pick a random ability from boss list
  const ability = abilities[_randInt(0, abilities.length - 1)];

  // Support both structured { name, type } and legacy plain strings
  let abilityName, mechType;
  if (typeof ability === 'object' && ability !== null) {
    abilityName = ability.name || 'Unknown Strike';
    mechType    = ability.type || 'basic';
  } else {
    // Legacy: plain string — treat as basic attack
    abilityName = String(ability).split(' (')[0];
    mechType    = 'basic';
  }

  const fn = BOSS_MECHANIC_FNS[mechType] || BOSS_MECHANIC_FNS.basic;
  const msg = fn(state, abilityName);
  _checkPartyDefeated(state);
  return msg;
}

function _bossBasicAttack(state, abilityName) {
  if (state.boss._stunned) {
    state.boss._stunned = false;
    return `💫 ${state.boss.name} is stunned — skips their turn!`;
  }
  // Target: front-line alive member (leaderIdx first, then next alive)
  let target = state.party[state.leaderIdx];
  if (!target || target.status === 'defeated') {
    target = state.party.find(p => p.status === 'alive');
  }
  if (!target) return '';
  const def = target.def || 5;
  let dmg = Math.max(1, state.boss.atk - Math.floor(def * 0.4) + _randInt(-3, 3));
  // Shield mechanic (replaces legacy _iceArmor — same effect, generic name)
  if (state.boss._shield > 0) { dmg = Math.round(dmg * 0.5); state.boss._shield--; }
  else if (state.boss._iceArmor > 0) { dmg = Math.round(dmg * 0.5); state.boss._iceArmor--; } // legacy compat
  target.hp = Math.max(0, target.hp - dmg);
  const label = abilityName || state.boss.name;
  if (target.hp <= 0) {
    target.status = 'defeated';
    _advanceLeader(state);
    return `⚔️ ${label} strikes ${target.name} for ${dmg}! ${target.name} has fallen!`;
  }
  return `⚔️ ${label} attacks ${target.name} for ${dmg} damage.`;
}

function _advanceLeader(state) {
  // Called when the current turn-holder dies mid-turn.
  // Advance currentTurnIdx to the next alive member so the raid never stalls.
  const len = state.party.length;
  for (let i = 1; i <= len; i++) {
    const next = (state.currentTurnIdx + i) % len;
    if (state.party[next]?.status === 'alive') {
      state.currentTurnIdx = next;
      return;
    }
  }
  // No alive members left — _checkPartyDefeated will handle wipe
}

function _checkPartyDefeated(state) {
  state.party.forEach(p => { if (p.hp <= 0) p.status = 'defeated'; });
}

// ── DOOM tick ──
function _tickDoom(state) {
  if (state.boss._doom > 0) {
    state.boss._doom--;
    if (state.boss._doom === 0) {
      const dmg = Math.round(state.boss.maxHp * 0.25);
      state.party.forEach(p => { if (p.status==='alive') p.hp = Math.max(0, p.hp - dmg); });
      _checkPartyDefeated(state);
      return `💥 DOOM triggers! All party members take ${dmg} damage!`;
    }
    return `⏳ Doom in ${state.boss._doom} turn${state.boss._doom===1?'':'s'}...`;
  }
  return null;
}

window.startBossRaid = function(party, bossTemplate) {
  
  _battleMode = 'boss';
  _bossRaidBoss = bossTemplate || BOSS_LIST[0];

  // Apply leader-set member order if saved on the party document
  let orderedParty = party;
  if (_party?.memberOrder && Array.isArray(_party.memberOrder) && _party.memberOrder.length > 0) {
    const orderMap = {};
    _party.memberOrder.forEach((uid, i) => { orderMap[uid] = i; });
    orderedParty = [...party].sort((a, b) => {
      const ai = orderMap[a.uid] ?? 999;
      const bi = orderMap[b.uid] ?? 999;
      return ai - bi;
    });
  }

  // Build fighter objects from party members
  _bossRaidParty = orderedParty.map(p => _buildFighter(p));
  _bossRaidLeaderIdx = 0;

  _bossRaidState = {
    boss: {
      ..._bossRaidBoss.base,
      name: _bossRaidBoss.name,
      id: _bossRaidBoss.id,
      imageUrl: _bossRaidBoss.imageUrl || '',
      icon: _bossRaidBoss.icon || '👹',
      // Keep abilities as structured array; _bossUseAbility reads .type
      abilities: _bossRaidBoss.abilities || [],
      maxHp: _bossRaidBoss.base.hp,
      _iceArmor: 0, _doom: 0, _shield: 0, _reflect: 0, _berserked: false,
    },
    party: _bossRaidParty,
    leaderIdx: 0,
    myIdx: _bossRaidParty.findIndex(p => p.uid === _uid) ?? 0,
    log: [`🛡️ Raid starts! ${_bossRaidParty.map(p=>p.name).join(', ')} vs ${_bossRaidBoss.name}!`],
    status: 'active',
    turn: 1,
    currentTurnIdx: 0, // index into party array whose turn it is
  };

  _showBossRaidArena();
};

function _showBossRaidArena() {
  const s = _bossRaidState;
  if (!s) return;

  // Switch to arena view
  document.getElementById('boss-raid-ui').style.display  = 'none';
  document.getElementById('raid-result').style.display   = 'none'; // clear any previous raid result
  document.getElementById('raid-turn-actions').style.display = 'none';
  document.getElementById('raid-waiting-msg').style.display  = 'none';
  const logEl = document.getElementById('raid-log');
  if (logEl) logEl.innerHTML = '';
  const arenaEl = document.getElementById('boss-raid-arena');
  arenaEl.style.display = 'block';

  // Boss display
  document.getElementById('raid-boss-arena-name').textContent = s.boss.name;
  const abilityNames = (s.boss.abilities || []).map(a => typeof a === 'object' && a !== null ? (a.name || '—') : String(a));
  document.getElementById('raid-boss-abilities-hint').textContent = `Abilities: ${abilityNames.join(' · ')}`;

  // Boss avatar — use deity-uploaded image if available, else icon/emoji
  const bossAvatarEl = document.getElementById('raid-boss-emoji-avatar');
  if (bossAvatarEl) {
    if (s.boss.imageUrl) {
      bossAvatarEl.innerHTML = `<img src="${s.boss.imageUrl}" alt="${s.boss.name}" style="width:72px;height:72px;border-radius:12px;object-fit:cover;border:2px solid var(--gold);box-shadow:0 0 12px rgba(212,175,55,0.35)"/>`;
    } else {
      bossAvatarEl.innerHTML = `<span style="font-size:3.2rem">${s.boss.icon || '👹'}</span>`;
    }
  }

  _refreshRaidUI();
}

function _refreshRaidUI() {
  const s = _bossRaidState;
  if (!s) return;

  // Boss HP bar
  const bossHpPct = Math.max(0, (s.boss.hp / s.boss.maxHp) * 100);
  document.getElementById('raid-boss-hp-text').textContent = `${s.boss.hp} / ${s.boss.maxHp}`;
  document.getElementById('raid-boss-hp-fill').style.width = bossHpPct + '%';

  // Party rows
  const rowsEl = document.getElementById('raid-party-rows');
  if (rowsEl) {
    rowsEl.innerHTML = s.party.map((p, i) => {
      const hpPct = Math.max(0, (p.hp / p.maxHp) * 100);
      const isDead = p.status === 'defeated';
      const isTurn = i === s.currentTurnIdx && s.status === 'active';
      const av = p.avatarUrl?.startsWith('http')
        ? `<img src="${p.avatarUrl}" style="width:28px;height:28px;border-radius:50%;object-fit:cover"/>`
        : `<span style="font-size:1rem">${p.avatarUrl||'⚔️'}</span>`;
      const manaPct = Math.max(0, ((p.mana ?? p.manaMax ?? 50) / (p.manaMax || 50)) * 100);
      const manaVal  = p.mana ?? p.manaMax ?? 50;
      return `<div class="raid-combat-member${isDead?' raid-member-dead':''}${isTurn?' raid-member-turn':''}">
        <div class="raid-combat-avatar">${av}</div>
        <div style="flex:1">
          <div style="font-size:0.78rem;color:var(--text)">${p.name}${i===0?' 👑':''}${isDead?' 💀':''}</div>
          <div class="battle-bar" style="height:5px;margin-top:3px"><div class="battle-bar-fill hp-fill" style="width:${hpPct}%"></div></div>
          <div class="battle-bar" style="height:4px;margin-top:2px;background:rgba(91,159,224,0.12)"><div class="battle-bar-fill" style="width:${manaPct}%;background:#5b9fe0;transition:width 0.4s"></div></div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
          <span style="font-family:var(--font-mono);font-size:0.58rem;color:${isDead?'var(--ash)':'#5dbe85'}">${isDead?'OUT':`${p.hp}/${p.maxHp}`}</span>
          ${!isDead?`<span style="font-family:var(--font-mono);font-size:0.52rem;color:#5b9fe0">${manaVal}MP</span>`:''}
        </div>
      </div>`;
    }).join('');
  }

  // Log
  const logEl = document.getElementById('raid-log');
  if (logEl) {
    logEl.innerHTML = s.log.slice(-20).map(l => `<div class="battle-log-entry">${l}</div>`).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  // My turn?
  const myIdx = s.myIdx ?? s.party.findIndex(p => p.uid === _uid);
  const isMyTurn = s.currentTurnIdx === myIdx && s.status === 'active';
  const iAmAlive = s.party[myIdx]?.status !== 'defeated';

  document.getElementById('raid-turn-actions').style.display = (isMyTurn && iAmAlive) ? 'flex' : 'none';
  document.getElementById('raid-waiting-msg').style.display  = (!isMyTurn && iAmAlive && s.status === 'active') ? 'block' : 'none';

  // Force-end button — leader only, always visible during active raid
  let forceEndBtn = document.getElementById('raid-force-end-btn');
  if (!forceEndBtn) {
    forceEndBtn = document.createElement('button');
    forceEndBtn.id = 'raid-force-end-btn';
    forceEndBtn.className = 'btn-secondary';
    forceEndBtn.style.cssText = 'margin-top:12px;font-size:0.78rem;opacity:0.7;width:auto;padding:6px 14px;color:var(--ash-light)';
    forceEndBtn.textContent = '⛔ Force End Raid';
    forceEndBtn.onclick = function() {
      if (confirm('Force-end this raid for all party members?')) window.forceEndRaid();
    };
    const waitingEl = document.getElementById('raid-waiting-msg');
    if (waitingEl && waitingEl.parentNode) waitingEl.parentNode.insertBefore(forceEndBtn, waitingEl.nextSibling);
  }
  if (_party && _party.leader === _uid) {
    forceEndBtn.style.display = 'inline-block';
  } else {
    forceEndBtn.style.display = 'none';
  }

  // Result
  if (s.status !== 'active') {
    _showRaidResult();
  }
}

window.doRaidTurn = function(action, skillName) {
  const s = _bossRaidState;
  if (!s || s.status !== 'active') return;

  const myIdx = s.myIdx ?? s.party.findIndex(p => p.uid === _uid);
  if (s.currentTurnIdx !== myIdx) return;

  const me = s.party[myIdx];
  if (!me || me.status === 'defeated') return;

  const primary = _getPrimaryStat(me.charClass, me);
  let playerDmg = 0;

  if (action === 'melee') {
    const def = Math.floor((s.boss.def || 10) * 0.4);
    playerDmg = Math.max(1, primary - def + _randInt(-2, 3));
    if (me._weakened) { playerDmg = Math.round(playerDmg * 0.7); me._weakened--; }
    if (me._stunned)  { me._stunned = 0; s.log.push(`😵 ${me.name} was stunned and couldn't act!`); }
    else if (me._frozen)   { me._frozen = 0; s.log.push(`❄️ ${me.name} is frozen and skips their turn!`); }
    else if (me._silenced) { me._silenced = 0; /* silenced only blocks skills, melee still fires */ s.log.push(`🔇 ${me.name} is silenced but swings anyway!`);
      // Curse detonation — acting while cursed
      if (me._cursed) { const cDmg = me._cursed; me._cursed = 0; me.hp = Math.max(0, me.hp - cDmg); if (me.hp <= 0) me.status = 'defeated'; s.log.push(`🔮 Curse detonates on ${me.name} for ${cDmg} damage!`); }
      // Blind check
      if (me._blinded && Math.random() < 0.60) { me._blinded = 0; s.log.push(`👁️ ${me.name} is blinded — attack misses!`); }
      else { me._blinded = 0; s.boss.hp = Math.max(0, s.boss.hp - playerDmg); s.log.push(`⚔️ ${me.name} strikes ${s.boss.name} for ${playerDmg} damage!`);
        // Nibblit: 5% lifesteal on hit
        if ((me.companion || '').toLowerCase() === 'nibblit' && Math.random() < 0.05) {
          const steal = Math.max(1, Math.round(playerDmg * 0.05));
          me.hp = Math.min(me.maxHp, me.hp + steal);
          s.log.push(`🩸 Nibblit siphons ${steal} HP for ${me.name}!`);
        } if (s.boss._reflect > 0) { const rDmg = Math.round(playerDmg * 0.4); me.hp = Math.max(0, me.hp - rDmg); if (me.hp <= 0) me.status = 'defeated'; s.boss._reflect = 0; s.log.push(`🪞 Reflected! ${me.name} takes ${rDmg} reflected damage!`); } }
    }
    else {
      // Curse detonation — acting while cursed
      if (me._cursed) { const cDmg = me._cursed; me._cursed = 0; me.hp = Math.max(0, me.hp - cDmg); if (me.hp <= 0) me.status = 'defeated'; s.log.push(`🔮 Curse detonates on ${me.name} for ${cDmg} damage!`); }
      // Blind check
      if (me._blinded && Math.random() < 0.60) { me._blinded = 0; s.log.push(`👁️ ${me.name} is blinded — attack misses!`); }
      else {
        me._blinded = 0;
        s.boss.hp = Math.max(0, s.boss.hp - playerDmg);
        s.log.push(`⚔️ ${me.name} strikes ${s.boss.name} for ${playerDmg} damage!`);
        // Reflect check
        if (s.boss._reflect > 0) {
          const rDmg = Math.round(playerDmg * 0.4);
          me.hp = Math.max(0, me.hp - rDmg);
          if (me.hp <= 0) me.status = 'defeated';
          s.boss._reflect = 0;
          s.log.push(`🪞 Reflected! ${me.name} takes ${rDmg} damage back!`);
        }
      }
    }
  } else if (action === 'skill' && skillName) {
    const sk = SKILL_DATA[skillName];
    if (sk && me.mana >= (sk.mana || 0)) {
      me.mana = Math.max(0, me.mana - sk.mana);
      if (me._stunned)  { me._stunned = 0; s.log.push(`😵 ${me.name} was stunned!`); }
      else if (me._frozen)   { me._frozen = 0; s.log.push(`❄️ ${me.name} is frozen and skips their turn!`); }
      else if (me._silenced) { me._silenced = 0; s.log.push(`🔇 ${me.name} is silenced — can't use skills this turn!`); }
      else {
        // Curse detonation — acting while cursed
        if (me._cursed) { const cDmg = me._cursed; me._cursed = 0; me.hp = Math.max(0, me.hp - cDmg); if (me.hp <= 0) me.status = 'defeated'; s.log.push(`🔮 Curse detonates on ${me.name} for ${cDmg} damage!`); }
        if (sk.type === 'damage') {
          const stat = me[sk.stat] || primary;
          playerDmg = Math.max(1, Math.round(stat * (sk.mult||1)) - Math.floor((s.boss.def||10)*0.3));
          if (me._weakened) { playerDmg = Math.round(playerDmg * 0.7); me._weakened--; }
          s.boss.hp = Math.max(0, s.boss.hp - playerDmg);
          s.log.push(`✨ ${me.name} uses ${skillName} for ${playerDmg} damage!`);
          // Reflect check on skill damage too
          if (s.boss._reflect > 0) {
            const rDmg = Math.round(playerDmg * 0.4);
            me.hp = Math.max(0, me.hp - rDmg);
            if (me.hp <= 0) me.status = 'defeated';
            s.boss._reflect = 0;
            s.log.push(`🪞 Reflected! ${me.name} takes ${rDmg} damage back!`);
          }
        } else if (sk.type === 'dot') {
          s.boss._dotActive  = true;
          s.boss._dotPct     = sk.dotPct  || 0.10;
          s.boss._dotTurns   = sk.dotTurns || 3;
          s.boss._dotLabel   = sk.dotLabel || 'Poison';
          s.boss._dotLifesteal = sk.lifesteal || false;
          s.boss._dotHealer  = me.uid || me.name; // track who applied it (for lifesteal)
          const dotAppliedLabel = `${Math.round((sk.dotPct||0.10)*100)}%×${sk.dotTurns||3} turns`;
          s.log.push(`🩸 ${me.name} uses ${skillName} — ${s.boss._dotLabel} applied! (${dotAppliedLabel})`);
        } else if (sk.type === 'stun') {
          const stat = me[sk.stat] || primary;
          playerDmg = Math.max(1, Math.round(stat * (sk.mult||1)) - Math.floor((s.boss.def||10)*0.3));
          s.boss.hp = Math.max(0, s.boss.hp - playerDmg);
          s.boss._stunned = true;
          s.log.push(`💫 ${me.name} uses ${skillName} for ${playerDmg} damage! ${s.boss.name} is stunned — will skip next attack!`);
        } else if (sk.type === 'heal' || sk.type === 'hot') {
          const _healPct = sk.healPct || 0.15;
          const _glimmerRaid = (me.companion || '').toLowerCase() === 'glimmer' ? 1.15 : 1;
          const healAmt = Math.round(me.maxHp * _healPct * _glimmerRaid);
          me.hp = Math.min(me.maxHp, me.hp + healAmt);
          s.log.push(`💚 ${me.name} uses ${skillName} — heals ${healAmt} HP!`);
        } else if (sk.type === 'buff') {
          s.log.push(`✨ ${me.name} uses ${skillName}! (${sk.stat?.toUpperCase()} boosted)`);
        } else {
          playerDmg = Math.max(1, primary - Math.floor((s.boss.def||10)*0.3));
          s.boss.hp = Math.max(0, s.boss.hp - playerDmg);
          s.log.push(`✨ ${me.name} uses ${skillName} for ${playerDmg} damage!`);
        }
      }
    } else {
      s.log.push(`❌ Not enough mana for ${skillName}!`);
    }
  }

  // Check boss death
  if (s.boss.hp <= 0) {
    s.status = 'victory';
    s.log.push(`🏆 ${s.boss.name} has been slain!`);
    _refreshRaidUI();
    // Sync state to Firestore
    updateDoc(doc(db, 'parties', _partyId), { 'raid.state': s });
    return;
  }

  // Advance to next alive party member
  let next = (s.currentTurnIdx + 1) % s.party.length;
  let attempts = 0;
  while (s.party[next]?.status === 'defeated' && attempts < s.party.length) {
    next = (next + 1) % s.party.length;
    attempts++;
  }

  // All party members defeated — wipe (safety net; _checkPartyDefeated should catch this)
  if (attempts >= s.party.length) {
    s.status = 'defeat';
    s.log.push(`💀 Your party has been wiped by ${s.boss.name}...`);
    _refreshRaidUI();
    updateDoc(doc(db, 'parties', _partyId), { 'raid.state': s });
    return;
  }

  // Boss acts once per full round — track via a round counter rather than index wrap
  // A new round starts whenever next <= currentTurnIdx (we've looped past the last alive slot)
  const roundComplete = next <= s.currentTurnIdx || attempts > 0 && next < s.currentTurnIdx + attempts;
  if (roundComplete) {
    // Boss turn
    const doomMsg = _tickDoom(s);
    if (doomMsg) s.log.push(doomMsg);

    // Tick Doom Marks — countdown; execute player when it hits 0
    s.party.forEach(p => {
      if (p.status === 'alive' && p._doomMarked > 0) {
        p._doomMarked--;
        if (p._doomMarked === 0) {
          p.hp = 0;
          p.status = 'defeated';
          _advanceLeader(s);
          s.log.push(`💀 The Doom Mark claims ${p.name}! They have fallen!`);
        } else {
          s.log.push(`☠️ Doom Mark on ${p.name} — ${p._doomMarked} turn${p._doomMarked === 1 ? '' : 's'} remaining!`);
        }
      }
    });

    // Passive berserk threshold — fires once when boss drops below 30% HP
    if (!s.boss._berserked && s.boss.hp / s.boss.maxHp <= 0.30 && s.boss.hp > 0) {
      s.boss._berserked = true;
      s.boss.atk = Math.round(s.boss.atk * 2);
      s.log.push(`💢 ${s.boss.name} crosses the threshold — BERSERK! Attack permanently doubled!`);
    }

    // ── Tick DoT on boss ──
    if (s.boss._dotActive && s.boss._dotTurns > 0) {
      const dotDmg = Math.round(s.boss.maxHp * (s.boss._dotPct || 0.10));
      s.boss.hp = Math.max(0, s.boss.hp - dotDmg);
      s.boss._dotTurns--;
      if (s.boss._dotTurns <= 0) s.boss._dotActive = false;
      const turnsLeft = s.boss._dotTurns;
      s.log.push(`🩸 ${s.boss._dotLabel||'Poison'}: ${dotDmg} dmg to ${s.boss.name}!${turnsLeft > 0 ? ` (${turnsLeft} turn${turnsLeft===1?'':'s'} left)` : ' (expired)'}`);
      if (s.boss.hp <= 0) {
        s.status = 'victory';
        s.log.push(`🏆 ${s.boss.name} has been slain!`);
        _refreshRaidUI();
        updateDoc(doc(db, 'parties', _partyId), { 'raid.state': s });
        return;
      }
    }

    // Boss uses ability every 3 turns, otherwise basic attack
    const bossMsg = (s.turn % 3 === 0) ? _bossUseAbility(s) : _bossBasicAttack(s);
    if (bossMsg) s.log.push(bossMsg);
    s.turn++;

    _checkPartyDefeated(s);

    // Lich race: one resurrection per battle at 50% HP
    s.party.forEach(p => {
      if (p.status === 'defeated' && !p._lichUsed && (p.race||'').toLowerCase().includes('lich')) {
        p.hp = Math.round(p.maxHp * 0.50);
        p.status = 'alive';
        p._lichUsed = true;
        s.log.push(`💀 ${p.name} invokes Lich Resurrection — returned at 50% HP!`);
      }
    });

    // Check wipe
    if (s.party.every(p => p.status === 'defeated')) {
      s.status = 'defeat';
      s.log.push(`💀 Your party has been wiped by ${s.boss.name}...`);
      _refreshRaidUI();
      // Sync state to Firestore
      updateDoc(doc(db, 'parties', _partyId), { 'raid.state': s });
      return;
    }

    // After boss acts, re-find next alive member starting from next
    // (boss attack may have killed whoever 'next' pointed at)
    let safeNext = next;
    let safeAttempts = 0;
    while (s.party[safeNext]?.status === 'defeated' && safeAttempts < s.party.length) {
      safeNext = (safeNext + 1) % s.party.length;
      safeAttempts++;
    }
    next = safeNext;
  }

  s.currentTurnIdx = next;
  _refreshRaidUI();
  // Sync state to Firestore
  updateDoc(doc(db, 'parties', _partyId), { 'raid.state': s });
};

window.openRaidSkillMenu = function() {
  const menu = document.getElementById('raid-skill-menu');
  const list = document.getElementById('raid-skill-list');
  if (!menu || !list) return;
  // Pass live mana from raid party member so affordability reflects actual spent mana
  const _raidMyIdx = _bossRaidState?.myIdx ?? _bossRaidState?.party?.findIndex(p => p.uid === _uid) ?? 0;
  const _raidMe = _bossRaidState?.party?.[_raidMyIdx];
  _fillSkillMenu(list, (s) => { window.doRaidTurn('skill', s); window.closeRaidSkillMenu(); }, _raidMe?.mana);
  menu.style.display = 'block';
};
window.closeRaidSkillMenu = function() {
  const m = document.getElementById('raid-skill-menu');
  if (m) m.style.display = 'none';
};

function _showRaidResult() {
  const s = _bossRaidState;
  // Close skill menu and action buttons
  document.getElementById('raid-skill-menu').style.display  = 'none';
  document.getElementById('raid-turn-actions').style.display = 'none';
  document.getElementById('raid-waiting-msg').style.display  = 'none';
  // Show result as fixed centered overlay (needs flex for centering)
  const resultEl = document.getElementById('raid-result');
  resultEl.style.display = 'flex';

  const isWin = s.status === 'victory';
  document.getElementById('raid-result-icon').textContent  = isWin ? '🏆' : '💀';
  document.getElementById('raid-result-title').textContent = isWin ? 'RAID COMPLETE!' : 'PARTY WIPED';

  const logEl = document.getElementById('raid-result-log');
  if (isWin) {
    const boss = BOSS_LIST.find(b => b.id === s.boss.id) || {};
    const goldEach = _randInt(200, 500);
    const expEach  = _randInt(300, 600);
    logEl.innerHTML = [
      `🏆 ${s.boss.name} defeated!`,
      `💰 Each party member earns ${goldEach} gold`,
      `✨ Each party member earns ${expEach} EXP`,
    ].map(l => `<div class="battle-result-log-line">${l}</div>`).join('');
    // Award current player
    if (_charData) {
      const { newXp, newLevel, newRank, newXpMax, leveledUp } = _processExp(
        _charData.xp||0, _charData.xpMax||100, _charData.level||1, _charData.rank||'Wanderer', expEach, _charData.charClass
      );
      updateDoc(doc(db, 'characters', _uid), { gold: increment(goldEach), xp:newXp, level:newLevel, rank:newRank, xpMax:newXpMax }) // FIXED: use increment
        .then(() => {
          _charData.gold = (_charData.gold||0)+goldEach;
          set('stat-gold', _charData.gold); set('s-gold', _charData.gold);
          if (leveledUp) window.showToast(`🎉 Level Up! ${newRank} Lv.${_displayLevel(newLevel)}`, 'success');
        }).catch(()=>{});
    }
  } else {
    logEl.innerHTML = `<div class="battle-result-log-line">No rewards. No death penalty — prepare better next time.</div>`;
  }
}

window.resetBossRaid = function() {
  _bossRaidState = null;
  _raidLaunchInProgress = false; // allow a new raid to launch cleanly
  // Robustly hide all raid-related UI
  const arena = document.getElementById('boss-raid-arena');
  if (arena) arena.style.display = 'none';
  const raidResult = document.getElementById('raid-result');
  if (raidResult) raidResult.style.display = 'none';
  const raidLog = document.getElementById('raid-log');
  if (raidLog) raidLog.innerHTML = '<div class="battle-log-entry">🔥 Raid begins...</div>';
  window._raidState = 'init';

  // Always re-enable and re-bind the Back to Raids button in case of stale UI
  const backBtn = document.querySelector('#raid-result button.btn-primary');
  if (backBtn) {
    backBtn.disabled = false;
    backBtn.onclick = function() { window.resetBossRaid(); };
  }

  // Clear raid from Firestore (leader only — one write covers everyone).
  // Members set a suppress flag so the snapshot re-trigger is ignored for one cycle.
  if (_partyId && _party) {
    if (_party.leader === _uid) {
      // Leader clears Firestore for everyone
      updateDoc(doc(db, 'parties', _partyId), { raid: null }).catch(() => {});
    } else {
      // Member: Firestore still shows raid.active=true until the leader clears it.
      // Suppress the next snapshot re-trigger so we don't get bounced back in.
      _suppressRaidAutoLaunch = true;
    }
  }

  window.showBossSelect();
};

// ── Force-end a stuck raid (any member can call; leader clears Firestore for all) ──
window.forceEndRaid = async function() {
  if (!_partyId) {
    window.showToast('No active party found.', 'error');
    return;
  }
  const isLeader = _party && _party.leader === _uid;
  // Reset local state for everyone
  _bossRaidState = null;
  _raidLaunchInProgress = false;
  _suppressRaidAutoLaunch = false;
  const arena = document.getElementById('boss-raid-arena');
  if (arena) arena.style.display = 'none';
  const raidResult = document.getElementById('raid-result');
  if (raidResult) raidResult.style.display = 'none';
  const raidLog = document.getElementById('raid-log');
  if (raidLog) raidLog.innerHTML = '<div class="battle-log-entry">🔥 Raid begins...</div>';
  window._raidState = 'init';

  if (isLeader) {
    try {
      await updateDoc(doc(db, 'parties', _partyId), { raid: null });
      window.showToast('Raid ended and cleared for all members.', 'success');
    } catch (e) {
      window.showToast('Failed to clear raid from server: ' + e.message, 'error');
    }
  } else {
    // Non-leader: suppress re-trigger and return to party screen
    _suppressRaidAutoLaunch = true;
    window.showToast('Exited raid. Ask the leader to end it for everyone.', 'info');
  }
  window.showBossSelect();
};


// ═══════════════════════════════════════════════════
//  PVP SYSTEM — FULL IMPLEMENTATION
// ═══════════════════════════════════════════════════

let _pvpMatchUnsub    = null;
let _pvpChalUnsub     = null;
let _pvpCurrentMatch  = null;
let _pvpAmChallenger  = false;

// Called when player switches to PVP mode
window.initPvpMode = function() {
  if (_charData) {
    document.getElementById('pvp-my-name').textContent = _charData.name || '—';
    document.getElementById('pvp-my-rank').textContent = `${_charData.rank||'Wanderer'} Lv.${_displayLevel(_charData.level||1)}`;
    const av = _charData.avatarUrl;
    document.getElementById('pvp-my-avatar').innerHTML = av?.startsWith('http')
      ? `<img src="${av}" style="width:40px;height:40px;border-radius:50%;object-fit:cover"/>`
      : `<span style="font-size:1.6rem">${av||'⚔️'}</span>`;
  }
  _loadPvpPlayers();
  _listenForChallenges();
  _showPvpView('hub');
};

async function _loadPvpPlayers() {
  const listEl = document.getElementById('pvp-player-list');
  if (!listEl) return;
  try {
    const snap = await getDocs(collection(db, 'characters'));
    const others = snap.docs.map(d => d.data()).filter(p => p.uid !== _uid && !p.isDeity && !p.isDead);
    if (!others.length) {
      listEl.innerHTML = `<div style="color:var(--text-dim);font-style:italic;font-size:0.85rem;padding:10px">No other players available right now.</div>`;
      return;
    }
    listEl.innerHTML = others.map(p => {
      const av = p.avatarUrl?.startsWith('http')
        ? `<img src="${p.avatarUrl}" style="width:34px;height:34px;border-radius:50%;object-fit:cover"/>`
        : `<span style="font-size:1.3rem">${p.avatarUrl||'⚔️'}</span>`;
      return `<div class="pvp-player-row">
        <div class="pvp-player-avatar">${av}</div>
        <div style="flex:1">
          <div style="font-size:0.86rem;color:var(--text)">${p.name||'Unknown'}</div>
          <div style="font-family:var(--font-mono);font-size:0.6rem;color:var(--text-dim)">${p.rank||'Wanderer'} Lv.${_displayLevel(p.level||1)} · ${p.charClass||'—'}</div>
        </div>
        <div style="font-family:var(--font-mono);font-size:0.6rem;color:#5dbe85;margin-right:8px">HP ${p.hp??p.hpMax??100}</div>
        <button class="btn-secondary" style="font-size:0.7rem;padding:5px 10px" onclick="window.challengePlayer('${p.uid}','${(p.name||'').replace(/'/g,"\'")}')">CHALLENGE</button>
      </div>`;
    }).join('');
  } catch(e) { console.error('PVP player list:', e); }
}

function _listenForChallenges() {
  if (_pvpChalUnsub) { _pvpChalUnsub(); _pvpChalUnsub = null; }
  const q = query(collection(db, 'pvpChallenges'), where('targetId','==',_uid), where('status','==','pending'));
  _pvpChalUnsub = onSnapshot(q, snap => {
    if (snap.empty) { document.getElementById('pvp-incoming').style.display = 'none'; return; }
    const ch = snap.docs[0].data();
    window._pendingChallenge = ch;
    document.getElementById('pvp-incoming').style.display = 'block';
    document.getElementById('pvp-challenger-info').textContent = `⚔️ ${ch.challengerName} wants to fight you!`;
    document.getElementById('pvp-challenge-wager-label').textContent = ch.wager > 0
      ? `💰 Wager: ${ch.wager} gold (winner takes all)`
      : 'Casual spar — no wager';
  });
}

// Add participants array to PvP challenge doc for easier querying
window.challengePlayer = async function(targetUid, targetName) {
  const wager = parseInt(document.getElementById('pvp-wager')?.value||'0')||0;
  if (wager > (_charData?.gold||0)) return window.showToast("Not enough gold for that wager", 'error');

  const matchId = `${_uid}_vs_${targetUid}_${Date.now()}`;
  const myData  = _buildFighter(_charData);

  // Debug logging for permission troubleshooting
  console.log("AUTH UID:", _uid);
  console.log("PvP Challenge DATA:", {
    matchId,
    challengerId: _uid,
    challengerName: _charData.name,
    targetId: targetUid,
    targetName,
    wager,
    status: 'pending',
    challengerData: myData,
    targetData: null,
    createdAt: serverTimestamp ? serverTimestamp() : new Date(),
  });


  await setDoc(doc(db, 'pvpChallenges', matchId), {
    matchId, challengerId:_uid, challengerName:_charData.name,
    targetId:targetUid, targetName, wager,
    status:'pending', challengerData:myData, targetData:null,
    createdAt: serverTimestamp ? serverTimestamp() : new Date(),
    participants: [_uid, targetUid],
  });

  // Send notification to challenged player
  try {
    await addDoc(collection(db, 'notifications'), {
      uid: targetUid,
      message: `⚔️ ${_charData.name} challenged you to a PvP duel!`,
      read: false,
      type: 'pvp-challenge',
      timestamp: serverTimestamp ? serverTimestamp() : new Date(),
      fromUid: _uid,
      fromName: _charData.name,
      matchId: matchId
    });
  } catch (e) {
    console.warn('Failed to send PvP notification:', e);
  }

  window._myPvpMatchId = matchId;
  window.showToast(`Challenge sent to ${targetName}! Waiting...`, 'info');

  // Listen for response
  _pvpMatchUnsub = onSnapshot(doc(db, 'pvpChallenges', matchId), snap => {
    if (!snap.exists()) return;
    const m = snap.data();
    if (m.status === 'declined') { window.showToast(`${targetName} declined.`, 'error'); _pvpMatchUnsub?.(); return; }
    if (m.status === 'active')   { _pvpAmChallenger = true; _enterPvpArena(m); }
    if (m.status === 'complete') { _onPvpComplete(m); }
  });
};

window.acceptPvpChallenge = async function() {
  const ch = window._pendingChallenge;
  if (!ch) return;
  if ((ch.wager||0) > (_charData?.gold||0)) return window.showToast("Not enough gold to match wager", 'error');

  const myData = _buildFighter(_charData);

  await updateDoc(doc(db, 'pvpChallenges', ch.matchId), {
    status:'active', targetData:myData,
    currentTurnUid: ch.challengerId,
    challengerHp: ch.challengerData.hp, challengerMana: ch.challengerData.mana,
    targetHp: myData.hp, targetMana: myData.mana,
    log: [`⚔️ ${ch.challengerName} vs ${_charData.name} — FIGHT!`],
  });

  // Notify challenger that their challenge was accepted
  try {
    await addDoc(collection(db, 'notifications'), {
      uid: ch.challengerId,
      message: `✅ ${_charData.name} accepted your PvP challenge!`,
      read: false,
      type: 'pvp-challenge-accepted',
      timestamp: serverTimestamp ? serverTimestamp() : new Date(),
      fromUid: _uid,
      fromName: _charData.name,
      matchId: ch.matchId
    });
  } catch (e) {
    console.warn('Failed to notify challenger (accepted):', e);
  }

  window._myPvpMatchId = ch.matchId;
  _pvpAmChallenger = false;
  document.getElementById('pvp-incoming').style.display = 'none';

  _pvpMatchUnsub = onSnapshot(doc(db, 'pvpChallenges', ch.matchId), snap => {
    if (!snap.exists()) return;
    const m = snap.data();
    if (m.status === 'active')   _enterPvpArena(m);
    if (m.status === 'complete') _onPvpComplete(m);
  });
};

window.declinePvpChallenge = async function() {
  const ch = window._pendingChallenge;
  if (!ch) {
    // _pendingChallenge lost (e.g. page refresh) — hide panel and bail
    document.getElementById('pvp-incoming').style.display = 'none';
    return;
  }
  try {
    await updateDoc(doc(db, 'pvpChallenges', ch.matchId), { status:'declined' });
  } catch(e) { console.warn('PVP decline write:', e); }
  try {
    await addDoc(collection(db, 'notifications'), {
      uid: ch.challengerId,
      message: `❌ ${_charData.name} declined your PvP challenge.`,
      read: false,
      type: 'pvp-challenge-declined',
      timestamp: serverTimestamp ? serverTimestamp() : new Date(),
      fromUid: _uid,
      fromName: _charData.name,
      matchId: ch.matchId
    });
  } catch (e) { console.warn('PVP decline notif:', e); }
  document.getElementById('pvp-incoming').style.display = 'none';
  window._pendingChallenge = null;
};

function _enterPvpArena(match) {
  _pvpCurrentMatch = match;
  _showPvpView('arena');
  _refreshPvpArena(match);
}

function _refreshPvpArena(match) {
  const isChallenger = match.challengerId === _uid;
  const me  = isChallenger ? match.challengerData : match.targetData;
  const opp = isChallenger ? match.targetData     : match.challengerData;
  if (!me || !opp) return;

  const myHp   = isChallenger ? (match.challengerHp  ?? me.hp)  : (match.targetHp    ?? me.hp);
  const oppHp  = isChallenger ? (match.targetHp      ?? opp.hp) : (match.challengerHp ?? opp.hp);
  const myMana = isChallenger ? (match.challengerMana ?? me.mana): (match.targetMana   ?? me.mana);

  // Opponent
  const oppAv = opp.avatarUrl?.startsWith('http')
    ? `<img src="${opp.avatarUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>`
    : `<span style="font-size:1.8rem">${opp.avatarUrl||'⚔️'}</span>`;
  document.getElementById('pvp-opp-avatar').innerHTML  = oppAv;
  document.getElementById('pvp-opp-name').textContent  = opp.name;
  document.getElementById('pvp-opp-rank').textContent  = `${opp.rank} Lv.${_displayLevel(opp.level||1)}`;
  document.getElementById('pvp-opp-hp-text').textContent = `${oppHp}/${opp.maxHp}`;
  document.getElementById('pvp-opp-hp-fill').style.width = `${Math.max(0,(oppHp/opp.maxHp)*100)}%`;

  // Me
  const myAv = me.avatarUrl?.startsWith('http')
    ? `<img src="${me.avatarUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>`
    : `<span style="font-size:1.8rem">${me.avatarUrl||'🧑'}</span>`;
  document.getElementById('pvp-me-avatar').innerHTML  = myAv;
  document.getElementById('pvp-me-name').textContent  = me.name;
  document.getElementById('pvp-me-rank').textContent  = `${me.rank} Lv.${_displayLevel(me.level||1)}`;
  document.getElementById('pvp-me-hp-text').textContent = `${myHp}/${me.maxHp}`;
  document.getElementById('pvp-me-hp-fill').style.width = `${Math.max(0,(myHp/me.maxHp)*100)}%`;
  document.getElementById('pvp-me-mp-text').textContent = `${myMana}/${me.maxMana}`;
  document.getElementById('pvp-me-mp-fill').style.width = `${Math.max(0,(myMana/me.maxMana)*100)}%`;

  // Log
  const logEl = document.getElementById('pvp-log');
  if (logEl && match.log) {
    logEl.innerHTML = match.log.slice(-20).map(l => `<div class="battle-log-entry">${l}</div>`).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Turn state
  const isMyTurn = match.currentTurnUid === _uid;
  document.getElementById('pvp-turn-actions').style.display = isMyTurn ? 'flex' : 'none';
  document.getElementById('pvp-waiting-msg').style.display  = isMyTurn ? 'none' : 'block';
}

// ── PvP skill processor — full skill parity with farming battle ──
function _getPrimaryStatKey(charClass) {
  const map = { Warrior:'str', Guardian:'def', Arcanist:'int', Cleric:'int',
                Hunter:'dex', Assassin:'dex', Summoner:'int' };
  return map[charClass] || 'str';
}

function _applyPvpSkill(skillName, me, opp, myHp, oppHp, myMana, myState, oppState) {
  const sk = SKILL_DATA[skillName];
  if (!sk) return { myHp, oppHp, myMana, log:[`❓ Unknown skill: ${skillName}`], myStateUpd:{}, oppStateUpd:{} };

  const log = [], myStateUpd = {}, oppStateUpd = {};
  const BUFF_CAP = 1.60;

  const getStat = (s) => {
    const base = me[s] || 10;
    return Math.round(base * (1 + Math.min(myState[`buff_${s}`] || 0, BUFF_CAP)));
  };

  const primary    = getStat(sk.stat || _getPrimaryStatKey(me.charClass));
  const effOppDef  = Math.max(0, Math.floor((opp.def||5) * 0.5 * (oppState.defBreak ? (1-(oppState.defBreakAmt||0.40)) : 1)));

  const dealDmg = (raw) => {
    let d = Math.max(1, raw);
    if ((oppState.shield||0) > 0) {
      const abs = Math.min(oppState.shield, d);
      oppStateUpd.shield = oppState.shield - abs;
      d -= abs;
      if (abs > 0) log.push(`🛡️ ${opp.name}'s shield absorbed ${abs}!`);
    }
    return Math.max(0, d);
  };

  let dmg = 0;

  switch (sk.type) {
    case 'damage':
    case 'backstab': {
      dmg = dealDmg(Math.round(primary*(sk.mult||1)) - effOppDef);
      log.push(`✨ ${me.name} uses ${skillName} for ${dmg} damage!`);
      break;
    }
    case 'stun': {
      dmg = dealDmg(Math.round(primary*(sk.mult||1.0)) - effOppDef);
      oppStateUpd.stunned = true;
      log.push(`💫 ${me.name} uses ${skillName} — ${dmg} dmg + STUNS ${opp.name} next turn!`);
      break;
    }
    case 'dot': {
      oppStateUpd.dotActive = true;
      oppStateUpd.dotPct = sk.dotPct||0.10;
      oppStateUpd.dotTurns = sk.dotTurns||3;
      oppStateUpd.dotLifesteal = sk.lifesteal||false;
      log.push(`🩸 ${me.name} afflicts ${opp.name} with ${sk.dotLabel||'Bleed'} (${Math.round((sk.dotPct||0.10)*100)}%×${sk.dotTurns||3} turns)!`);
      break;
    }
    case 'heal': {
      const h = Math.round(me.maxHp*(sk.healPct||0.15));
      myHp = Math.min(me.maxHp, myHp+h);
      log.push(`💚 ${me.name} uses ${skillName} — heals ${h} HP!`);
      break;
    }
    case 'hot': {
      myStateUpd.hotActive = true;
      myStateUpd.hotPct = sk.hotPct||0.10;
      myStateUpd.hotTurns = sk.hotTurns||3;
      log.push(`💚 ${me.name} uses ${skillName} — regen ${Math.round((sk.hotPct||0.10)*100)}%×${sk.hotTurns||3} turns!`);
      break;
    }
    case 'buff': {
      if (sk.stat === 'all') {
        ['str','int','def','dex'].forEach(s => {
          const bk = `buff_${s}`;
          myStateUpd[bk] = Math.min((myState[bk]||0)+(sk.buffMult||0.20), BUFF_CAP);
        });
        log.push(`⬆️ ${me.name} uses ${skillName} — ALL STATS +${Math.round((sk.buffMult||0.20)*100)}%!`);
      } else {
        const bKey = `buff_${sk.stat}`;
        myStateUpd[bKey] = Math.min((myState[bKey]||0)+(sk.buffMult||0.20), BUFF_CAP);
        log.push(`⬆️ ${me.name} uses ${skillName} — ${sk.stat.toUpperCase()} +${Math.round((sk.buffMult||0.20)*100)}%!`);
      }
      break;
    }
    case 'sacrificial': {
      const cost = Math.round(me.maxHp*(sk.selfHpCost||0.15));
      myHp = Math.max(1, myHp-cost);
      if (sk.buffStat === 'all') {
        ['str','int','def','dex'].forEach(s => {
          const bk = `buff_${s}`;
          myStateUpd[bk] = Math.min((myState[bk]||0)+(sk.buffMult||0.20), BUFF_CAP);
        });
        log.push(`💉 ${me.name} uses ${skillName} — paid ${cost} HP for ALL STATS +${Math.round((sk.buffMult||0.20)*100)}%!`);
      } else {
        const bKey = `buff_${sk.buffStat}`;
        myStateUpd[bKey] = Math.min((myState[bKey]||0)+(sk.buffMult||0.50), BUFF_CAP);
        if (sk.buffStat2) myStateUpd[`buff_${sk.buffStat2}`] = Math.min((myState[`buff_${sk.buffStat2}`]||0)+(sk.buffMult2||0.20), BUFF_CAP);
        log.push(`💉 ${me.name} uses ${skillName} — paid ${cost} HP, ${sk.buffStat.toUpperCase()} +${Math.round((sk.buffMult||0.50)*100)}%!`);
      }
      break;
    }
    case 'shield': {
      const sh = Math.round(me.maxHp*(sk.shieldPct||0.15));
      myStateUpd.shield = (myState.shield||0)+sh;
      log.push(`🛡️ ${me.name} uses ${skillName} — absorbs up to ${sh} damage!`);
      break;
    }
    case 'hpbuff': {
      const bonus = Math.round(me.maxHp*(sk.hpMult||0.50));
      myHp = Math.min(me.maxHp+bonus, myHp+bonus);
      myStateUpd.hpBuffBonus = (myState.hpBuffBonus||0)+bonus;
      log.push(`❤️ ${me.name} uses ${skillName} — max HP +${bonus}!`);
      break;
    }
    case 'cleanse': {
      myStateUpd.dotActive = false; myStateUpd.deathMark = false;
      myStateUpd.defBreak = false;  myStateUpd.stunned = false;
      log.push(`✨ ${me.name} cleanses all debuffs!`);
      break;
    }
    case 'debuff': {
      if (sk.debuffType === 'deathmark') {
        oppStateUpd.deathMark = true;
        oppStateUpd.deathMarkBonus = sk.dmgBonus||0.60;
        log.push(`☠️ ${me.name} marks ${opp.name} for death — next hit +${Math.round((sk.dmgBonus||0.60)*100)}% dmg!`);
      } else if (sk.debuffType === 'defbreak') {
        oppStateUpd.defBreak = true;
        oppStateUpd.defBreakAmt = sk.defReduce||0.40;
        log.push(`💢 ${me.name} shatters ${opp.name}'s DEF by ${Math.round((sk.defReduce||0.40)*100)}%!`);
      }
      break;
    }
    case 'multihit': {
      let total = 0;
      for (let i = 0; i < (sk.hits||3); i++)
        total += Math.max(1, Math.round(primary*(sk.multPerHit||0.65)) - effOppDef);
      dmg = dealDmg(total);
      log.push(`⚡ ${me.name} uses ${skillName} — ${sk.hits||3} hits for ${dmg} total!`);
      break;
    }
    case 'execute': {
      if (oppHp <= opp.maxHp*(sk.threshold||0.40)) {
        dmg = dealDmg(oppHp+1);
        log.push(`💀 ${me.name} EXECUTES ${opp.name}!`);
      } else {
        dmg = dealDmg(Math.round(primary*(sk.mult||2.0)) - effOppDef);
        log.push(`⚔️ ${me.name} uses ${skillName} for ${dmg} dmg (target above threshold)!`);
      }
      break;
    }
    case 'condDamage': {
      const hasDebuff = oppState.dotActive||oppState.deathMark||oppState.defBreak;
      dmg = dealDmg(Math.round(primary*(sk.mult||2.0)*(hasDebuff?1.30:1.0)) - effOppDef);
      log.push(`${hasDebuff?'💥':'⚔️'} ${me.name} uses ${skillName} for ${dmg} dmg${hasDebuff?' (debuff bonus!)':''}!`);
      break;
    }
    case 'echo': {
      const base = myState.lastDmg || Math.round(primary*1.0);
      dmg = dealDmg(Math.max(1, base - effOppDef));
      log.push(`🔁 ${me.name} echoes last hit for ${dmg} damage!`);
      break;
    }
    case 'priority': {
      dmg = dealDmg(Math.round(primary*1.0) - effOppDef);
      log.push(`⚡ ${me.name} uses ${skillName} — quick attack for ${dmg} damage!`);
      break;
    }
    case 'skillock': {
      oppStateUpd.skillLocked = true;
      log.push(`📢 ${me.name} uses ${skillName} — ${opp.name}'s skills locked next turn!`);
      break;
    }
    default: {
      dmg = dealDmg(Math.round(primary*(sk.mult||1.0)) - effOppDef);
      log.push(`✨ ${me.name} uses ${skillName} for ${dmg} damage!`);
    }
  }

  // Death mark bonus
  if (dmg > 0 && oppState.deathMark) {
    dmg = Math.round(dmg*(1+(oppState.deathMarkBonus||0.60)));
    oppStateUpd.deathMark = false;
    log.push(`☠️ Death Mark detonates — bonus damage!`);
  }

  if (dmg > 0) myStateUpd.lastDmg = dmg;
  oppHp = Math.max(0, oppHp - dmg);
  myMana = Math.max(0, myMana - (sk.mana||0));

  return { myHp, oppHp, myMana, log, myStateUpd, oppStateUpd };
}

window.doPvpTurn = async function(action, skillName) {
  const matchId = window._myPvpMatchId;
  if (!matchId) return;
  const snap = await getDoc(doc(db, 'pvpChallenges', matchId));
  if (!snap.exists()) return;
  const match = snap.data();
  if (match.currentTurnUid !== _uid || match.status !== 'active') return;

  const isChallenger = match.challengerId === _uid;
  const me  = isChallenger ? match.challengerData : match.targetData;
  const opp = isChallenger ? match.targetData     : match.challengerData;
  const myKey  = isChallenger ? 'challenger' : 'target';
  const oppKey = isChallenger ? 'target' : 'challenger';

  let myHp   = match[`${myKey}Hp`]   ?? me.hp;
  let oppHp  = match[`${oppKey}Hp`]  ?? opp.hp;
  let myMana = match[`${myKey}Mana`] ?? me.mana;
  let myState  = match[`${myKey}State`]  || {};
  let oppState = match[`${oppKey}State`] || {};

  const log = [...(match.log||[])];

  // ── Tick DoT on ME (applied by opponent) ──
  if (myState.dotActive && myState.dotTurns > 0) {
    const dotDmg = Math.round((me.maxHp) * (myState.dotPct||0.10));
    myHp = Math.max(0, myHp - dotDmg);
    const turnsLeft = myState.dotTurns - 1;
    myState = { ...myState, dotTurns: turnsLeft, dotActive: turnsLeft > 0 };
    log.push(`🩸 ${me.name} takes ${dotDmg} DoT damage! (${turnsLeft} turns left)`);
    if (myState.dotLifesteal) {
      oppHp = Math.min(opp.maxHp, oppHp + dotDmg);
      log.push(`🧛 ${opp.name} leeches ${dotDmg} HP!`);
    }
  }

  // ── Tick HoT on ME ──
  if (myState.hotActive && myState.hotTurns > 0) {
    const hotHeal = Math.round(me.maxHp * (myState.hotPct||0.10));
    myHp = Math.min(me.maxHp, myHp + hotHeal);
    const hTurnsLeft = myState.hotTurns - 1;
    myState = { ...myState, hotTurns: hTurnsLeft, hotActive: hTurnsLeft > 0 };
    log.push(`💚 ${me.name} regenerates ${hotHeal} HP!`);
  }

  // ── Stunned — lose turn ──
  if (myState.stunned) {
    log.push(`💫 ${me.name} is stunned and loses their turn!`);
    myState = { ...myState, stunned: false };
    await updateDoc(doc(db, 'pvpChallenges', matchId), {
      log, currentTurnUid: isChallenger ? match.targetId : match.challengerId,
      [`${myKey}Hp`]: myHp, [`${myKey}Mana`]: myMana,
      [`${oppKey}Hp`]: oppHp,
      [`${myKey}State`]: myState, [`${oppKey}State`]: oppState,
    });
    return;
  }

  let myStateUpd = {}, oppStateUpd = {};

  if (action === 'melee') {
    const buffedPrim = Math.round(_getPrimaryStat(me.charClass, me) * (1 + Math.min(myState[`buff_${_getPrimaryStatKey(me.charClass)}`]||0, 1.60)));
    const effDef = Math.max(0, Math.floor((opp.def||5)*0.5*(oppState.defBreak?(1-(oppState.defBreakAmt||0.40)):1)));
    let dmg = Math.max(1, buffedPrim - effDef + _randInt(-2,3));
    if ((oppState.shield||0) > 0) {
      const abs = Math.min(oppState.shield, dmg);
      oppStateUpd.shield = oppState.shield - abs; dmg -= abs;
      if (abs > 0) log.push(`🛡️ ${opp.name}'s shield absorbed ${abs}!`);
    }
    if (oppState.deathMark) {
      dmg = Math.round(dmg*(1+(oppState.deathMarkBonus||0.60)));
      oppStateUpd.deathMark = false;
      log.push(`☠️ Death Mark detonates!`);
    }
    oppHp = Math.max(0, oppHp - dmg);
    myStateUpd.lastDmg = dmg;
    log.push(`⚔️ ${me.name} strikes ${opp.name} for ${dmg} damage!`);

  } else if (action === 'skill' && skillName) {
    const sk = SKILL_DATA[skillName];
    if (!sk) {
      log.push(`❓ Unknown skill: ${skillName}`);
    } else if (myMana < (sk.mana||0)) {
      log.push(`❌ Not enough mana for ${skillName}!`);
    } else if (oppState.skillLocked && (sk.mana||0) > 0) {
      log.push(`📢 ${me.name}'s skills are locked this turn!`);
    } else {
      const res = _applyPvpSkill(skillName, me, opp, myHp, oppHp, myMana, myState, oppState);
      myHp = res.myHp; oppHp = res.oppHp; myMana = res.myMana;
      log.push(...res.log);
      myStateUpd  = { ...myStateUpd,  ...res.myStateUpd };
      oppStateUpd = { ...oppStateUpd, ...res.oppStateUpd };
    }
  }

  // Merge & clear consumed states
  myState  = { ...myState,  ...myStateUpd };
  oppState = { ...oppState, ...oppStateUpd };
  if (!oppStateUpd.skillLocked) delete oppState.skillLocked; // consumed after 1 turn

  // If opponent was just stunned, skip their turn — keep turn with current player
  const justStunned = oppStateUpd.stunned === true;
  if (justStunned) {
    oppState = { ...oppState, stunned: false };
    log.push(`💫 ${opp.name} is stunned and loses their turn!`);
  }

  const nextTurnUid = justStunned ? _uid : (isChallenger ? match.targetId : match.challengerId);
  const updates = {
    log, currentTurnUid: nextTurnUid,
    [`${myKey}Hp`]: myHp, [`${myKey}Mana`]: myMana,
    [`${oppKey}Hp`]: oppHp,
    [`${myKey}State`]: myState, [`${oppKey}State`]: oppState,
  };

  if (oppHp <= 0) {
    const wager = match.wager||0;
    updates.status   = 'complete';
    updates.winnerId = _uid;
    updates.resultLog = [
      `🏆 ${me.name} wins!`,
      wager > 0 ? `💰 ${me.name} earns ${wager} gold from ${opp.name}` : 'Casual spar — no gold exchanged.',
    ];
    if (wager > 0) {
      try {
        const myRef  = doc(db, 'characters', _uid);
        const oppRef = doc(db, 'characters', opp.uid);
        await runTransaction(db, async tx => {
          tx.update(myRef,  { gold: increment(+wager) });
          tx.update(oppRef, { gold: increment(-wager) });
        });
        _charData.gold = (_charData.gold||0) + wager;
        set('stat-gold', _charData.gold); set('s-gold', _charData.gold);
      } catch(e) { console.warn('PVP wager:', e); }
    }
  }

  await updateDoc(doc(db, 'pvpChallenges', matchId), updates);
};

window.openPvpSkillMenu = function() {
  const menu = document.getElementById('pvp-skill-menu');
  const list = document.getElementById('pvp-skill-list');
  if (!menu || !list) return;
  _fillSkillMenu(list, (s) => { window.doPvpTurn('skill', s); window.closePvpSkillMenu(); });
  menu.style.display = 'block';
};
window.closePvpSkillMenu = function() {
  const m = document.getElementById('pvp-skill-menu');
  if (m) m.style.display = 'none';
};

function _onPvpComplete(match) {
  if (_pvpMatchUnsub) { _pvpMatchUnsub(); _pvpMatchUnsub = null; }
  _showPvpView('result');
  const iWon = match.winnerId === _uid;
  document.getElementById('pvp-result-icon').textContent  = iWon ? '🏆' : '💀';
  document.getElementById('pvp-result-title').textContent = iWon ? 'VICTORY!' : 'DEFEATED';
  const detail = match.wager > 0
    ? (iWon ? `You gained ${match.wager} gold!` : `You lost ${match.wager} gold.`)
    : 'No wager — bragging rights only.';
  document.getElementById('pvp-result-detail').textContent = detail;
  // Log to activity feed
  const opponentName = match.participants?.find(p => p !== _uid) || 'an opponent';
  if (iWon) {
    logActivity('🏆', `<b>PVP Victory!</b> Defeated <b>${match.challengerName && match.targetName ? (match.challengerId === _uid ? match.targetName : match.challengerName) : 'an opponent'}</b>${match.wager > 0 ? ` · +${match.wager}💰` : ''}.`, '#e8d070');
  } else {
    logActivity('💀', `<b>PVP Defeat.</b> Lost to <b>${match.challengerName && match.targetName ? (match.challengerId === _uid ? match.targetName : match.challengerName) : 'an opponent'}</b>${match.wager > 0 ? ` · -${match.wager}💰` : ''}.`, '#e05555');
  }
}

window.resetPvp = function() {
  if (_pvpMatchUnsub) { _pvpMatchUnsub(); _pvpMatchUnsub = null; }
  window._myPvpMatchId = null;
  _pvpCurrentMatch = null;
  document.getElementById('pvp-log').innerHTML = '<div class="battle-log-entry">🏆 PVP match begins...</div>';
  _showPvpView('hub');
  _loadPvpPlayers();
};

function _showPvpView(view) {
  ['hub','arena','result'].forEach(v => {
    const el = document.getElementById(`pvp-${v}`);
    if (el) el.style.display = v === view ? 'block' : 'none';
  });
}

// ── Shared skill menu builder ──
function _fillSkillMenu(listEl, onSelect, liveMana) {
  if (!_charData) return;
  const RANK_ORDER_B = ["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"];
  const rankIdx = RANK_ORDER_B.indexOf(_charData.rank || "Wanderer");
  const unlockedCount = Math.max(2, rankIdx * 2 + 2);
  // liveMana: passed by boss raid / PvP for real-time affordability; falls back to charData snapshot
  const myMana = liveMana ?? _charData.mana ?? _charData.manaMax ?? 50;

  // Use active stance if set, otherwise full class list
  const activeIdx = window._activeStanceIdx;
  const stances   = _getStances();
  let classSkills;
  let stanceName = null;
  if (activeIdx !== null && stances[activeIdx]?.skills?.length) {
    classSkills = stances[activeIdx].skills.filter(n => SKILL_DATA[n]);
    stanceName  = stances[activeIdx].name;
  } else {
    classSkills = (BATTLE_SKILLS[_charData.charClass] || []).slice(0, unlockedCount);
  }

  const badge = stanceName
    ? `<div class="skill-menu-stance-badge">⚔ ${stanceName}</div>`
    : '';

  listEl.innerHTML = badge + (classSkills.map(s => {
    const sk = SKILL_DATA[s] || {};
    const usable = (sk.mana || 0) <= myMana;
    return `<div class="skill-menu-item" data-skill="${s}" data-usable="${usable}"
      style="opacity:${usable?1:0.45};cursor:${usable?'pointer':'not-allowed'}">
      <div class="skill-menu-item-name">${s}</div>
      <div style="font-family:var(--font-mono);font-size:0.58rem;color:var(--text-dim)">${sk.mana||0} MP · ${sk.type||'—'}</div>
    </div>`;
  }).join('') || '<div style="color:var(--text-dim);font-style:italic;font-size:0.8rem;padding:10px">No skills in this stance.</div>');

  listEl.querySelectorAll('.skill-menu-item[data-usable="true"]').forEach(el => {
    el.addEventListener('click', () => onSelect(el.dataset.skill));
  });
}

// ── Wire PVP mode init to setBattleMode ──
const _origUpdateBattleModeUI = window.updateBattleModeUI;
window.updateBattleModeUI = function(mode) {
  _origUpdateBattleModeUI?.(mode);
};
 

// ═══════════════════════════════════════════════════
//  CRAFTING UI
// ═══════════════════════════════════════════════════

// Canonical recipe lists (parsed from Forge Of Legends.txt)
window.CANONICAL_EQUIP_RECIPES = {
  E: [
    // Weapons
    { name:"Rusted Greatsword", icon:"⚔️",  type:"weapon", cost:2200,  stats:{str:7},       requires:[{name:"Iron",qty:10},{name:"Tough Hide",qty:4}] },
    { name:"Crude Bow",         icon:"🏹",  type:"weapon", cost:2100,  stats:{dex:6},       requires:[{name:"Iron",qty:8},{name:"Leather",qty:2}] },
    { name:"Iron Dagger",       icon:"🗡️",  type:"weapon", cost:2000,  stats:{dex:5},       requires:[{name:"Iron",qty:8},{name:"Bone Fragments",qty:2}] },
    { name:"Apprentice Wand",   icon:"🪄",  type:"weapon", cost:2300,  stats:{int:8},       requires:[{name:"Quartz",qty:6},{name:"Animal Fat",qty:4}] },
    { name:"Shortblade",        icon:"🗡️",  type:"weapon", cost:2100,  stats:{str:6},       requires:[{name:"Iron",qty:10}] },
    { name:"Bone Mace",         icon:"🔨",  type:"weapon", cost:2150,  stats:{str:7},       requires:[{name:"Bone Fragments",qty:8},{name:"Iron",qty:2}] },
    { name:"Hunter Knife",      icon:"🗡️",  type:"weapon", cost:2100,  stats:{dex:6},       requires:[{name:"Iron",qty:6},{name:"Fur",qty:4}] },
    { name:"Quartz Rod",        icon:"🪄",  type:"weapon", cost:2400,  stats:{int:9},       requires:[{name:"Quartz",qty:8},{name:"Limestone",qty:4}] },
    { name:"Tin Blade",         icon:"🗡️",  type:"weapon", cost:2000,  stats:{str:5},       requires:[{name:"Tin",qty:10}] },
    { name:"Feather Knife",     icon:"🗡️",  type:"weapon", cost:2150,  stats:{dex:6},       requires:[{name:"Iron",qty:6},{name:"Feathers",qty:4}] },
    // Armor
    { name:"Leather Vest",      icon:"🥋",  type:"armor",  cost:2000,  stats:{def:6},       requires:[{name:"Leather",qty:10}] },
    { name:"Iron Plate",        icon:"⛓️",  type:"armor",  cost:2300,  stats:{def:8},       requires:[{name:"Iron",qty:10}] },
    { name:"Bone Armor",        icon:"🦴",  type:"armor",  cost:2100,  stats:{def:7},       requires:[{name:"Bone Fragments",qty:10}] },
    { name:"Fur Coat",          icon:"🦊",  type:"armor",  cost:1900,  stats:{def:5},       requires:[{name:"Fur",qty:9}] },
    { name:"Hide Armor",        icon:"🥋",  type:"armor",  cost:2050,  stats:{def:6},       requires:[{name:"Tough Hide",qty:10}] },
    { name:"Feather Cloak",     icon:"🪶",  type:"armor",  cost:1900,  stats:{def:5},       requires:[{name:"Feathers",qty:9}] },
    { name:"Tin Armor",         icon:"🪨",  type:"armor",  cost:2150,  stats:{def:7},       requires:[{name:"Tin",qty:10}] },
    { name:"Copper Plate",      icon:"🟠",  type:"armor",  cost:2100,  stats:{def:6},       requires:[{name:"Copper",qty:10}] },
    { name:"Marble Guard",      icon:"🏛️",  type:"armor",  cost:2300,  stats:{def:8},       requires:[{name:"Marble",qty:12}] },
    { name:"Obsidian Layer",    icon:"🖤",  type:"armor",  cost:2400,  stats:{def:9},       requires:[{name:"Obsidian",qty:15}] },
  ],
  D: [
    // Weapons
    { name:"Obsidian Greatsword", icon:"⚔️", type:"weapon", cost:8600, stats:{str:14,dex:5},  requires:[{name:"Obsidian",qty:20},{name:"Coal",qty:10}] },
    { name:"Silver Wand",         icon:"🪄", type:"weapon", cost:8400, stats:{int:12,dex:6},  requires:[{name:"Silver",qty:20},{name:"Tough Hide",qty:8}] },
    { name:"Longbow",             icon:"🏹", type:"weapon", cost:8300, stats:{dex:13,str:5},  requires:[{name:"Leather",qty:20},{name:"Iron",qty:8}] },
    { name:"Twin Daggers",        icon:"🗡️", type:"weapon", cost:8350, stats:{dex:11,str:6},  requires:[{name:"Fangs",qty:20},{name:"Copper",qty:8}] },
    { name:"Warhammer",           icon:"🔨", type:"weapon", cost:8700, stats:{str:15,def:4},  requires:[{name:"Bronze",qty:25},{name:"Bone Fragments",qty:10}] },
    { name:"Arc Rod",             icon:"🪄", type:"weapon", cost:8500, stats:{int:14,str:5},  requires:[{name:"Quartz",qty:20},{name:"Feathers",qty:12}] },
    { name:"Bronze Blade",        icon:"🗡️", type:"weapon", cost:8300, stats:{str:13,dex:6},  requires:[{name:"Bronze",qty:15},{name:"Leather",qty:10}] },
    { name:"Hunter Bow",          icon:"🏹", type:"weapon", cost:8250, stats:{dex:12,int:5},  requires:[{name:"Fur",qty:15},{name:"Tin",qty:10}] },
    { name:"Spiked Mace",         icon:"🔨", type:"weapon", cost:8450, stats:{str:14,dex:5},  requires:[{name:"Marble",qty:20},{name:"Bone Fragments",qty:10}] },
    { name:"Mystic Knife",        icon:"🗡️", type:"weapon", cost:8550, stats:{dex:13,int:6},  requires:[{name:"Claws",qty:15},{name:"Horns",qty:10}] },
    // Armor
    { name:"Steel Armor",         icon:"🔷", type:"armor",  cost:8600, stats:{def:15,hp:7},   requires:[{name:"Iron",qty:20},{name:"Silver",qty:10}] },
    { name:"Reinforced Leather",  icon:"🥋", type:"armor",  cost:8200, stats:{def:13,hp:6},   requires:[{name:"Leather",qty:14},{name:"Coal",qty:8}] },
    { name:"Silver Guard",        icon:"⬜", type:"armor",  cost:8500, stats:{def:14,hp:7},   requires:[{name:"Silver",qty:20},{name:"Animal Fat",qty:10}] },
    { name:"Bone Plate",          icon:"🦴", type:"armor",  cost:8700, stats:{def:16,hp:8},   requires:[{name:"Bone Fragments",qty:25},{name:"Marble",qty:10}] },
    { name:"Fur Armor",           icon:"🦊", type:"armor",  cost:8100, stats:{def:12,hp:6},   requires:[{name:"Fur",qty:10},{name:"Limestone",qty:10}] },
    { name:"Horned Armor",        icon:"🦄", type:"armor",  cost:8750, stats:{def:17,hp:9},   requires:[{name:"Horns",qty:28},{name:"Tin",qty:15}] },
    { name:"Scale Vest",          icon:"🥋", type:"armor",  cost:8450, stats:{def:15,hp:7},   requires:[{name:"Tough Hide",qty:15},{name:"Silver",qty:10}] },
    { name:"Bronze Armor",        icon:"🟫", type:"armor",  cost:8600, stats:{def:16,hp:8},   requires:[{name:"Bronze",qty:20},{name:"Copper",qty:15}] },
    { name:"Obsidian Plate",      icon:"🌑", type:"armor",  cost:8800, stats:{def:18,hp:9},   requires:[{name:"Obsidian",qty:30},{name:"Claws",qty:10}] },
    { name:"Marble Armor",        icon:"🏛️", type:"armor",  cost:8400, stats:{def:14,hp:6},   requires:[{name:"Marble",qty:20},{name:"Bone Fragments",qty:10}] },
  ],
  C: [
    // Weapons
    { name:"Silver Greatsword", icon:"⚔️", type:"weapon", cost:32800,  stats:{str:25,dex:8},   requires:[{name:"Silver",qty:56},{name:"Spirit Venison",qty:16}] },
    { name:"Arcane Staff",      icon:"🪄", type:"weapon", cost:35200,  stats:{int:28,dex:10},  requires:[{name:"Quartz",qty:64},{name:"Shadow Hide",qty:24}] },
    { name:"Composite Bow",     icon:"🏹", type:"weapon", cost:33600,  stats:{dex:26,str:9},   requires:[{name:"Leather",qty:56},{name:"Gold",qty:24}] },
    { name:"Assassin Daggers",  icon:"🗡️", type:"weapon", cost:34400,  stats:{dex:27,int:8},   requires:[{name:"Fangs",qty:55},{name:"Palladium",qty:16}] },
    { name:"Mystic Blade",      icon:"🗡️", type:"weapon", cost:33200,  stats:{str:24,int:11},  requires:[{name:"Marble",qty:48},{name:"Spirit Venison",qty:16}] },
    { name:"War Maul",          icon:"🔨", type:"weapon", cost:36800,  stats:{str:30,dex:5},   requires:[{name:"Obsidian",qty:64},{name:"Mythril",qty:24}] },
    { name:"Spellknife",        icon:"🗡️", type:"weapon", cost:34800,  stats:{dex:23,int:12},  requires:[{name:"Quartz",qty:56},{name:"Shadow Hide",qty:16}] },
    { name:"Dagon Bow",         icon:"🏹", type:"weapon", cost:34000,  stats:{dex:25,str:9},   requires:[{name:"Silver",qty:56},{name:"Drake Meat",qty:24}] },
    { name:"Bronze Cleaver",    icon:"⚔️", type:"weapon", cost:33600,  stats:{str:28,dex:7},   requires:[{name:"Bronze",qty:40},{name:"Palladium",qty:24}] },
    { name:"Dark Rod",          icon:"🪄", type:"weapon", cost:38000,  stats:{int:29,str:6},   requires:[{name:"Quartz",qty:56},{name:"Obsidian",qty:40}] },
    // Armor
    { name:"Shining Armor",     icon:"✨", type:"armor",  cost:36000,  stats:{def:30,hp:15},  requires:[{name:"Silver",qty:64},{name:"Spirit Venison",qty:40}] },
    { name:"Bronze Cuirass",    icon:"🟡", type:"armor",  cost:37200,  stats:{def:32,hp:18},  requires:[{name:"Bronze",qty:72},{name:"Gold",qty:50}] },
    { name:"Jagged Chainmail",  icon:"🥋", type:"armor",  cost:35200,  stats:{def:28,hp:14},  requires:[{name:"Claws",qty:56},{name:"Palladium",qty:24}] },
    { name:"Bone Fortress",     icon:"🦴", type:"armor",  cost:37600,  stats:{def:31,hp:16},  requires:[{name:"Horns",qty:72},{name:"Mythril",qty:40}] },
    { name:"Obsidian Vest",     icon:"🖤", type:"armor",  cost:38400,  stats:{def:33,hp:17},  requires:[{name:"Obsidian",qty:80},{name:"Shadow Hide",qty:40}] },
    { name:"Reptilian Scale",   icon:"🥋", type:"armor",  cost:35600,  stats:{def:29,hp:14},  requires:[{name:"Marble",qty:56},{name:"Drake Meat",qty:32}] },
    { name:"Shadow Cloak",      icon:"🥋", type:"armor",  cost:34400,  stats:{def:27,hp:13},  requires:[{name:"Fur",qty:48},{name:"Shadow Hide",qty:24}] },
    { name:"Golden Cape",       icon:"🥋", type:"armor",  cost:33600,  stats:{def:26,hp:12},  requires:[{name:"Leather",qty:48},{name:"Gold",qty:16}] },
    { name:"Warlord Hide",      icon:"🐗", type:"armor",  cost:36400,  stats:{def:30,hp:15},  requires:[{name:"Horns",qty:64},{name:"Palladium",qty:40}] },
    { name:"Arcane Shell",      icon:"🔮", type:"armor",  cost:39200,  stats:{def:34,hp:19},  requires:[{name:"Obsidian",qty:80},{name:"Spirit Venison",qty:48}] },
  ],
  B: [
    // Weapons
    { name:"Myth-Blade",       icon:"⚔️", type:"weapon", cost:163000, stats:{str:48,dex:15},  requires:[{name:"Mythril",qty:150},{name:"Adamantium",qty:50}] },
    { name:"High-Scepter",     icon:"🪄", type:"weapon", cost:163500, stats:{int:50,str:14},  requires:[{name:"Spirit Venison",qty:170},{name:"Adamantium",qty:50}] },
    { name:"Draconic Bow",     icon:"🏹", type:"weapon", cost:160000, stats:{dex:47,str:16},  requires:[{name:"Drake Meat",qty:150},{name:"Dragon Scales",qty:40}] },
    { name:"Shadow-Strike",    icon:"🗡️", type:"weapon", cost:163200, stats:{dex:46,int:18},  requires:[{name:"Shadow Hide",qty:140},{name:"Titanium",qty:50}] },
    { name:"Warbreaker",       icon:"🔨", type:"weapon", cost:166000, stats:{str:52,dex:10},  requires:[{name:"Palladium",qty:190},{name:"Titanium",qty:60}] },
    { name:"Mystic Jian",      icon:"🗡️", type:"weapon", cost:163400, stats:{str:45,int:20},  requires:[{name:"Spirit Venison",qty:140},{name:"Dragon Scales",qty:50}] },
    { name:"Phantom Longbow",  icon:"🏹", type:"weapon", cost:163100, stats:{dex:48,int:14},  requires:[{name:"Gold",qty:160},{name:"Cyclops Eye",qty:30}] },
    { name:"Spellhammer",      icon:"🔨", type:"weapon", cost:163600, stats:{str:51,int:12},  requires:[{name:"Shadow Hide",qty:180},{name:"Cyclops Eye",qty:30}] },
    { name:"Venom Daggers",    icon:"🗡️", type:"weapon", cost:163300, stats:{dex:47,str:16},  requires:[{name:"Palladium",qty:150},{name:"Adamantium",qty:40}] },
    { name:"Ancient Wand",     icon:"🪄", type:"weapon", cost:166200, stats:{int:53,dex:10},  requires:[{name:"Mythril",qty:200},{name:"Cyclops Eye",qty:40}] },
    // Armor
    { name:"Void-Spell Armor",    icon:"🟣", type:"armor",  cost:166000, stats:{def:50,hp:30},  requires:[{name:"Shadow Hide",qty:170},{name:"Titanium",qty:100}] },
    { name:"Golden Scales",       icon:"🐉", type:"armor",  cost:163000, stats:{def:48,hp:25},  requires:[{name:"Gold",qty:150},{name:"Dragon Scales",qty:70}] },
    { name:"Night Cloak",         icon:"🥋", type:"armor",  cost:163500, stats:{def:45,hp:28},  requires:[{name:"Shadow Hide",qty:140},{name:"Cyclops Eye",qty:90}] },
    { name:"Spirit-Ward",         icon:"👻", type:"armor",  cost:166500, stats:{def:52,hp:35},  requires:[{name:"Spirit Venison",qty:180},{name:"Adamantium",qty:120}] },
    { name:"Paladin's Mantle",    icon:"🥋", type:"armor",  cost:160800, stats:{def:44,hp:24},  requires:[{name:"Palladium",qty:100},{name:"Dragon Scales",qty:60}] },
    { name:"Draconic Robe",       icon:"🥋", type:"armor",  cost:163200, stats:{def:49,hp:27},  requires:[{name:"Drake Meat",qty:150},{name:"Dragon Scales",qty:70}] },
    { name:"Titanic Hide",        icon:"🪨", type:"armor",  cost:169500, stats:{def:54,hp:39},  requires:[{name:"Palladium",qty:200},{name:"Titanium",qty:150}] },
    { name:"Golden Warplate",     icon:"🏆", type:"armor",  cost:166800, stats:{def:53,hp:36},  requires:[{name:"Gold",qty:200},{name:"Adamantium",qty:120}] },
    { name:"Mythic Cuirass",      icon:"💫", type:"armor",  cost:163400, stats:{def:46,hp:26},  requires:[{name:"Mythril",qty:140},{name:"Cyclops Eye",qty:70}] },
    { name:"Quintessence Mantle", icon:"🌀", type:"armor",  cost:169000, stats:{def:51,hp:33},  requires:[{name:"Spirit Venison",qty:200},{name:"Shadow Hide",qty:150}] },
  ],
  A: [
    // Weapons
    { name:"Eragon-blade",  icon:"⚔️", type:"weapon", cost:684000, stats:{str:70,dex:20},  requires:[{name:"Dragon Scales",qty:360},{name:"Adamantium",qty:144},{name:"Palladium",qty:120}] },
    { name:"Void-Steel",    icon:"⚔️", type:"weapon", cost:682000, stats:{str:75,def:15},  requires:[{name:"Cyclops Eye",qty:396},{name:"Titanium",qty:120},{name:"Shadow Hide",qty:108}] },
    { name:"Star Lance",    icon:"🪄", type:"weapon", cost:688000, stats:{int:78,dex:18},  requires:[{name:"Dragon Scales",qty:420},{name:"Aetherium",qty:12}] },
    { name:"Crack",         icon:"🗡️", type:"weapon", cost:682500, stats:{dex:68,int:22},  requires:[{name:"Adamantium",qty:324},{name:"Titanium",qty:144},{name:"Mythril",qty:168}] },
    { name:"Divine Fall",   icon:"⚔️", type:"weapon", cost:684500, stats:{str:72,int:20},  requires:[{name:"Cyclops Eye",qty:372},{name:"Dragon Scales",qty:144},{name:"Gold",qty:120}] },
    { name:"Nether-Bow",    icon:"🏹", type:"weapon", cost:682000, stats:{dex:69,str:19},  requires:[{name:"Adamantium",qty:324},{name:"Titanium",qty:120},{name:"Shadow Hide",qty:108}] },
    { name:"Holy Relic",    icon:"🪄", type:"weapon", cost:690000, stats:{int:77,str:16},  requires:[{name:"Dragon Scales",qty:360},{name:"Titan Heart",qty:12},{name:"Aetherium",qty:12}] },
    { name:"Realm Cleaver", icon:"⚔️", type:"weapon", cost:686500, stats:{str:74,dex:18},  requires:[{name:"Titanium",qty:384},{name:"Titan Heart",qty:12},{name:"Mythril",qty:144}] },
    { name:"BeastFang",     icon:"🗡️", type:"weapon", cost:684000, stats:{dex:71,str:20},  requires:[{name:"Dragon Scales",qty:360},{name:"Adamantium",qty:120},{name:"Drake Meat",qty:84}] },
    { name:"Scion",         icon:"⚔️", type:"weapon", cost:686000, stats:{str:73,int:17},  requires:[{name:"Cyclops Eye",qty:372},{name:"Aetherium",qty:12},{name:"Spirit Venison",qty:120}] },
    // Armor
    { name:"Heart Hide",        icon:"❤️", type:"armor",  cost:686000, stats:{def:75,hp:55},  requires:[{name:"Adamantium",qty:396},{name:"Titan Heart",qty:24}] },
    { name:"Destroyer Mantle",  icon:"🥋", type:"armor",  cost:690000, stats:{def:79,hp:59},  requires:[{name:"Titanium",qty:432},{name:"Aetherium",qty:24},{name:"Gold",qty:84}] },
    { name:"Chaos-garb",        icon:"🥋", type:"armor",  cost:682500, stats:{def:68,hp:47},  requires:[{name:"Cyclops Eye",qty:312},{name:"Dragon Scales",qty:120},{name:"Shadow Hide",qty:108}] },
    { name:"Devastator Armor",  icon:"⚔️", type:"armor",  cost:680000, stats:{def:66,hp:45},  requires:[{name:"Adamantium",qty:288},{name:"Cyclops Eye",qty:120},{name:"Drake Meat",qty:108}] },
    { name:"Tectonic-Mail",     icon:"🌋", type:"armor",  cost:684500, stats:{def:72,hp:50},  requires:[{name:"Titanium",qty:360},{name:"Aetherium",qty:12}] },
    { name:"Elemental Shroud",  icon:"🥋", type:"armor",  cost:686500, stats:{def:74,hp:52},  requires:[{name:"Cyclops Eye",qty:384},{name:"Aetherium",qty:12},{name:"Mythril",qty:204}] },
    { name:"Colossal Veil",     icon:"🌫️", type:"armor",  cost:688500, stats:{def:78,hp:58},  requires:[{name:"Titanium",qty:420},{name:"Dragon Scales",qty:156},{name:"Shadow Hide",qty:132}] },
    { name:"Realm-Bound Tunic", icon:"🌐", type:"armor",  cost:684000, stats:{def:70,hp:49},  requires:[{name:"Dragon Scales",qty:360},{name:"Cyclops Eye",qty:144},{name:"Spirit Venison",qty:120}] },
    { name:"Serpentine-Robe",   icon:"🥋", type:"armor",  cost:680500, stats:{def:65,hp:44},  requires:[{name:"Adamantium",qty:300},{name:"Cyclops Eye",qty:120},{name:"Drake Meat",qty:108}] },
    { name:"Vasto-Shell",       icon:"🐚", type:"armor",  cost:688000, stats:{def:76,hp:54},  requires:[{name:"Titanium",qty:240},{name:"Titan Heart",qty:12},{name:"Aetherium",qty:12}] },
  ],
  S: [
    // Weapons
    { name:"Abjuration", icon:"🔱", type:"weapon", cost:2800000, stats:{str:100,dex:40,int:30}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Palladium",qty:7000}] },
    { name:"Genesis",    icon:"🪄", type:"weapon", cost:2800000, stats:{int:100,str:35,dex:35}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Adamantium",qty:280},{name:"Spirit Venison",qty:700}] },
    { name:"Longinus",   icon:"🏹", type:"weapon", cost:2800000, stats:{dex:100,str:40,int:25}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Gold",qty:700}] },
    { name:"Jingu Bang", icon:"🔨", type:"weapon", cost:2800000, stats:{dex:100,int:45,str:20}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Mythril",qty:700}] },
    { name:"Ragnarok",   icon:"⚔️", type:"weapon", cost:2800000, stats:{str:100,dex:30,int:30}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Shadow Hide",qty:700}] },
    { name:"Godslayer",  icon:"⚔️", type:"weapon", cost:2800000, stats:{int:100,str:30,dex:30}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Adamantium",qty:280},{name:"Spirit Venison",qty:700}] },
    { name:"Durandal",   icon:"⚔️", type:"weapon", cost:2800000, stats:{str:100,dex:35,int:20}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Drake Meat",qty:700}] },
    { name:"Excalibur",  icon:"⚔️", type:"weapon", cost:2800000, stats:{str:100,int:25,dex:35}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Gold",qty:700}] },
    { name:"Bane",       icon:"🗡️", type:"weapon", cost:2800000, stats:{dex:100,int:35,str:25}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Shadow Hide",qty:700}] },
    { name:"Judgment",   icon:"🪄", type:"weapon", cost:2800000, stats:{int:100,str:30,dex:30}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Mythril",qty:700}] },
    // Armor
    { name:"Saturn",      icon:"🪐", type:"armor",  cost:2800000, stats:{def:100,hp:80}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Gold",qty:700}] },
    { name:"Unshadowed",  icon:"☀️", type:"armor",  cost:2800000, stats:{def:100,hp:70}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Spirit Venison",qty:700}] },
    { name:"Null",        icon:"⬛", type:"armor",  cost:2800000, stats:{def:100,hp:78}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Shadow Hide",qty:700}] },
    { name:"Dominion",    icon:"👑", type:"armor",  cost:2800000, stats:{def:100,hp:80}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Adamantium",qty:280},{name:"Palladium",qty:700}] },
    { name:"Godshroud",   icon:"✨", type:"armor",  cost:2800000, stats:{def:100,hp:68}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Gold",qty:700}] },
    { name:"Oblivion",    icon:"🕳️", type:"armor",  cost:2800000, stats:{def:100,hp:75}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Shadow Hide",qty:700}] },
    { name:"Gungnir",     icon:"⚡", type:"armor",  cost:2800000, stats:{def:100,hp:76}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Mythril",qty:700}] },
    { name:"Imperium",    icon:"🔱", type:"armor",  cost:2800000, stats:{def:100,hp:79}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Gold",qty:700}] },
    { name:"Worldshell",  icon:"🌍", type:"armor",  cost:2800000, stats:{def:100,hp:74}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Adamantium",qty:280},{name:"Spirit Venison",qty:700}] },
    { name:"Eternity",    icon:"♾️", type:"armor",  cost:2800000, stats:{def:100,hp:77}, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Drake Meat",qty:700}] },
  ],
};
// Canonical food recipes with correct category names and all foods
window.CANONICAL_FOOD_RECIPES = {
  "STRENGTH FOODS": [
    { name:"Grilled Meat Skewer", icon:"🍢", grade:"Common",    effect:"+5% STR (10 mins)",  cost:300,   requires:[{name:"Raw Meat",qty:5},{name:"Garlic",qty:2},{name:"Apples",qty:2}] },
    { name:"Spiced Steak",        icon:"🥩", grade:"Uncommon",  effect:"+10% STR (15 mins)", cost:900,   requires:[{name:"Raw Meat",qty:5},{name:"Golden Pears",qty:2},{name:"Bitter Root",qty:2}] },
    { name:"Hunter's Feast",      icon:"🍖", grade:"Rare",      effect:"+15% STR (20 mins)", cost:2700,  requires:[{name:"Raw Meat",qty:5},{name:"Spirit Plum",qty:2},{name:"Shadowfish",qty:2}] },
    { name:"Dragonfire Roast",    icon:"🔥", grade:"Legendary", effect:"+20% STR (30 mins)", cost:8100,  requires:[{name:"Raw Meat",qty:5},{name:"Dragonfruit",qty:2},{name:"Black Unagi",qty:2}] },
    { name:"Eden Banquet",        icon:"🌺", grade:"Mythic",    effect:"+25% STR (40 mins)", cost:24300, requires:[{name:"Eden's Tear",qty:1},{name:"Cosmic Leviathan",qty:1},{name:"Red Minnow",qty:5},{name:"Crystal Berries",qty:5}] },
  ],
  "INTELLIGENCE FOODS": [
    { name:"Herb Fish Soup",     icon:"🍵", grade:"Common",    effect:"+5% INT (10 mins)",  cost:300,   requires:[{name:"Trout",qty:5},{name:"Garlic",qty:2},{name:"Melons",qty:2}] },
    { name:"Glow Stew",         icon:"🌙", grade:"Uncommon",  effect:"+10% INT (15 mins)", cost:900,   requires:[{name:"Pufferfish",qty:5},{name:"Glowfish",qty:2},{name:"Moon Grapes",qty:2}] },
    { name:"Mystic Broth",      icon:"🫕", grade:"Rare",      effect:"+15% INT (20 mins)", cost:2700,  requires:[{name:"Catfish",qty:5},{name:"Shadowfish",qty:2},{name:"Spirit Plum",qty:2}] },
    { name:"Celestial Sashimi", icon:"🍣", grade:"Legendary", effect:"+20% INT (30 mins)", cost:8100,  requires:[{name:"Mushroom",qty:5},{name:"Celestial Whale",qty:2},{name:"Celestial Fig",qty:2}] },
    { name:"Cosmic Infusion",   icon:"🌌", grade:"Mythic",    effect:"+25% INT (40 mins)", cost:24300, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Spotted Eel",qty:5},{name:"Sunfruit",qty:5}] },
  ],
  "DEFENSE FOODS": [
    { name:"Roasted Carp",           icon:"🐟", grade:"Common",    effect:"+5% DEF (10 mins)",  cost:300,   requires:[{name:"Carp",qty:5},{name:"Apples",qty:2},{name:"Mushrooms",qty:2}] },
    { name:"Ironbody Stew",          icon:"🍲", grade:"Uncommon",  effect:"+10% DEF (15 mins)", cost:900,   requires:[{name:"Bone Fragments",qty:5},{name:"Silverfin",qty:2},{name:"Coral Snapper",qty:2}] },
    { name:"Frosthide Meal",         icon:"❄️", grade:"Rare",      effect:"+15% DEF (20 mins)", cost:2700,  requires:[{name:"Tough Hide",qty:5},{name:"Ying Koi",qty:2},{name:"Frost Apples",qty:2}] },
    { name:"Titan Shell Dish",       icon:"🐚", grade:"Legendary", effect:"+20% DEF (30 mins)", cost:8100,  requires:[{name:"Blueberries",qty:5},{name:"Black Unagi",qty:2},{name:"Dragonfruit",qty:2}] },
    { name:"Eternal Fortress Feast", icon:"🏰", grade:"Mythic",    effect:"+25% DEF (40 mins)", cost:24300, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Silverfin",qty:5},{name:"Moongrapes",qty:5}] },
  ],
  "DEXTERITY FOODS": [
    { name:"Fried Sardine",       icon:"🐠", grade:"Common",    effect:"+5% DEX (10 mins)",  cost:300,   requires:[{name:"Sardine",qty:5},{name:"Blueberries",qty:2},{name:"Melons",qty:2}] },
    { name:"Crystal Splash Meal", icon:"💧", grade:"Uncommon",  effect:"+10% DEX (15 mins)", cost:900,   requires:[{name:"Melon",qty:5},{name:"Crystal Berries",qty:2},{name:"Sunfruit",qty:2}] },
    { name:"Assassin's Dish",     icon:"🍲", grade:"Rare",      effect:"+15% DEX (20 mins)", cost:2700,  requires:[{name:"Garlic",qty:5},{name:"Flamefish",qty:2},{name:"Ember Fruit",qty:2}] },
    { name:"Phantom Platter",     icon:"👁️", grade:"Legendary", effect:"+20% DEX (30 mins)", cost:8100,  requires:[{name:"Feathers",qty:5},{name:"Black Unagi",qty:2},{name:"Celestial Fig",qty:2}] },
    { name:"Divine Speed Feast",  icon:"⚡", grade:"Mythic",    effect:"+25% DEX (40 mins)", cost:24300, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Golden Pears",qty:5},{name:"Coral Snapper",qty:5}] },
  ],
};
// Canonical potion recipes with correct category names and details
window.CANONICAL_POTION_RECIPES = {
  HP: [
    { name:"Minor HP Potion",    icon:"🫧",       type:"HP", effect:"+20% HP instantly", cost:100,  requires:[{name:"Mint Leaves",qty:2},{name:"Wood",qty:2},{name:"Silverleaf",qty:2}] },
    { name:"Standard HP Potion", icon:"🧴",       type:"HP", effect:"+40% HP instantly", cost:500,  requires:[{name:"Goldroot",qty:2},{name:"Spirit Herb",qty:2}] },
    { name:"Greater HP Potion",  icon:"❤️‍🔥", type:"HP", effect:"+70% HP instantly", cost:1000, requires:[{name:"Phoenix Bloom",qty:2},{name:"Void Orchid",qty:2}] },
  ],
  Mana: [
    { name:"Minor Mana Potion",    icon:"💠", type:"Mana", effect:"+20% Mana instantly", cost:100,  requires:[{name:"Wild Herbs",qty:2},{name:"Wood",qty:2},{name:"Lotus",qty:2}] },
    { name:"Standard Mana Potion", icon:"🔹", type:"Mana", effect:"+40% Mana instantly", cost:500,  requires:[{name:"Glowleaf",qty:2},{name:"Ghost Root",qty:2}] },
    { name:"Greater Mana Potion",  icon:"🌀", type:"Mana", effect:"+70% Mana instantly", cost:1000, requires:[{name:"Middlemist",qty:2},{name:"Void Orchid",qty:2}] },
  ],
  Luck: [
    { name:"Minor Luck Potion",    icon:"🍀", type:"Luck", effect:"+5% Luck (1h, 3/day)",  cost:100,  requires:[{name:"Basil Sprigs",qty:2},{name:"Wood",qty:2},{name:"Nightshade",qty:2}] },
    { name:"Standard Luck Potion", icon:"☘️", type:"Luck", effect:"+15% Luck (1h, 3/day)", cost:500,  requires:[{name:"Goldroot",qty:2},{name:"Jade Vine",qty:2}] },
    { name:"Greater Luck Potion",  icon:"🌠", type:"Luck", effect:"+30% Luck (1h, 3/day)", cost:1000, requires:[{name:"Middlemist",qty:1},{name:"Phoenix Bloom",qty:1},{name:"Void Orchid",qty:1}] },
  ],
  Insight: [
    { name:"Minor EXP Potion",    icon:"✨", type:"Insight", effect:"+5% EXP gain (1h, 3/day)",  cost:100,  requires:[{name:"Soft Bark",qty:2},{name:"Wood",qty:2},{name:"Glowleaf",qty:2}] },
    { name:"Standard EXP Potion", icon:"⭐", type:"Insight", effect:"+15% EXP gain (1h, 3/day)", cost:500,  requires:[{name:"Nightshade",qty:2},{name:"Lotus",qty:2}] },
    { name:"Greater EXP Potion",  icon:"🌟", type:"Insight", effect:"+20 EXP gain (1h, 3/day)",  cost:1000, requires:[{name:"Silverleaf",qty:1},{name:"Middlemist",qty:1},{name:"Phoenix Bloom",qty:1},{name:"Void Orchid",qty:1}] },
  ],
  Other: [
    { name:"Stat Reset Potion",       icon:"🔄", effect:"Allows players to reset their stat points, for new redistribution across all attributes.", cost:2000 },
    { name:"Class Reset Potion",      icon:"⚗️", effect:"Allows players to reset class, and thus, skilltree. Keeps stat points that have been gathered prior.", cost:5000 },
    { name:"Companion Change Potion", icon:"🐾", effect:"Allows players to select a new companion. This resets the companion's level.", cost:6000 },
    { name:"Race Rebirth Potion",     icon:"🌀", effect:"Allows players to change their race.", cost:10000 },
    { name:"Divine Shift Potion",     icon:"✨", effect:"Allows players to change their Deity. However, this results in a reset of “Faith level” too.", cost:20000 },
    { name:"Resurrection Potion",     icon:"💀", effect:"Revive from death — restores HP & Mana to full. Can be used from the death screen.", cost:20000 },
  ],
};

// Accordion and tab logic for new crafting UI
window.toggleAccordion = function(headerBtn) {
  const item = headerBtn.closest('.accordion-item');
  const panel = item.querySelector('.accordion-panel');
  const arrow = headerBtn.querySelector('.accordion-arrow');
  const isOpen = panel.style.display === 'block';
  // Close all panels
  document.querySelectorAll('.accordion-panel').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.accordion-arrow').forEach(a => a.textContent = '▼');
  // Open this one if not already open
  if (!isOpen) {
    panel.style.display = 'block';
    if (arrow) arrow.textContent = '▲';
  }
};

// Equipment grade tab logic
window.switchEquipmentGradeTab = function(btn, grade) {
  document.querySelectorAll('#equipment-grade-tabs .subtab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderEquipmentRecipes(grade);
};

// Food type tab logic
window.switchFoodTypeTab = function(btn, type) {
  document.querySelectorAll('#food-type-tabs .subtab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderFoodRecipes(type);
};

// Potion type tab logic
window.switchPotionTypeTab = function(btn, type) {
  document.querySelectorAll('#potion-type-tabs .subtab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderPotionRecipes(type);
};

// Renderers for each section
function renderEquipmentRecipes(grade) {
  const grid = document.getElementById('recipes-equipment');
  if (!grid) return;
  const recipes = (window.CANONICAL_EQUIP_RECIPES && window.CANONICAL_EQUIP_RECIPES[grade]) ? window.CANONICAL_EQUIP_RECIPES[grade] : [];
  const STAT_LABELS = { str:'STR', int:'INT', def:'DEF', dex:'DEX', hp:'HP' };
  grid.innerHTML = recipes.map(r => {
    const reqs = r.requires.map(req => `${req.qty}x ${req.name}`).join(', ');
    const statsHtml = r.stats
      ? `<div class="recipe-stats">${Object.entries(r.stats).map(([k,v]) => `<span class="recipe-stat-badge">+${v} ${STAT_LABELS[k]||k.toUpperCase()}</span>`).join('')}</div>`
      : '';
    return `<div class="recipe-card">
      <div class="recipe-icon">${r.icon||getItemIcon(r.name)}</div>
      <div class="recipe-name">${r.name}</div>
      <div class="recipe-type">${r.type}</div>
      ${statsHtml}
      <div class="recipe-requires">${reqs}</div>
      <div class="recipe-cost">${r.cost} 🪙</div>
      <div style="display:flex;gap:6px">
        <button class="btn-primary recipe-craft-btn" onclick="doCraft('blacksmith','${r.name}')">CRAFT</button>
        <button class="btn-secondary recipe-craft-btn" style="background:transparent" onclick="openItemStatModal('${r.name}')">VIEW</button>
      </div>
    </div>`;
  }).join('');
}

function renderFoodRecipes(type) {
  const grid = document.getElementById('recipes-food');
  if (!grid) return;
  const recipes = (window.CANONICAL_FOOD_RECIPES && window.CANONICAL_FOOD_RECIPES[type]) ? window.CANONICAL_FOOD_RECIPES[type] : [];
  grid.innerHTML = recipes.map(r => {
    const reqs = r.requires ? r.requires.map(req => `${req.qty}x ${req.name}`).join(', ') : '';
    const effectHtml = r.effect ? `<div class="recipe-effect">${r.effect}</div>` : '';
    const gradeHtml  = r.grade  ? `<div class="recipe-type">${r.grade}</div>` : '';
    return `<div class="recipe-card">
      <div class="recipe-icon">${r.icon||getItemIcon(r.name)}</div>
      <div class="recipe-name">${r.name}</div>
      ${gradeHtml}
      ${effectHtml}
      <div class="recipe-requires">${reqs}</div>
      <div class="recipe-cost">${r.cost} 🪙</div>
      <button class="btn-primary recipe-craft-btn" onclick="doCraft('cook','${r.name}')">CRAFT</button>
    </div>`;
  }).join('');
}

function renderPotionRecipes(type) {
  const grid = document.getElementById('recipes-potion');
  if (!grid) return;
  const recipes = (window.CANONICAL_POTION_RECIPES && window.CANONICAL_POTION_RECIPES[type]) ? window.CANONICAL_POTION_RECIPES[type] : [];
  grid.innerHTML = recipes.map(r => {
    const isLuckOrExp = (type === 'Luck' || type === 'Insight');
    const stackBadge  = isLuckOrExp
      ? `<div class="recipe-stack-note">⚠️ Max 3/day · 1 hour · Non-stackable</div>`
      : '';
    if (type === 'Other') {
      return `<div class="recipe-card">
        <div class="recipe-icon">${r.icon||getItemIcon(r.name)}</div>
        <div class="recipe-name">${r.name}</div>
        <div class="recipe-effect">${r.effect}</div>
        <div class="recipe-cost">${r.cost} 🪙</div>
        <button class="btn-primary recipe-craft-btn" onclick="doCraft('alchemist','${r.name}')">CRAFT</button>
      </div>`;
    }
    const reqs = r.requires ? r.requires.map(req => `${req.qty}x ${req.name}`).join(', ') : '';
    return `<div class="recipe-card">
      <div class="recipe-icon">${r.icon||getItemIcon(r.name)}</div>
      <div class="recipe-name">${r.name}</div>
      <div class="recipe-type">${r.type}</div>
      <div class="recipe-effect">${r.effect}</div>
      ${stackBadge}
      <div class="recipe-requires">${reqs}</div>
      <div class="recipe-cost">${r.cost} 🪙</div>
      <button class="btn-primary recipe-craft-btn" onclick="doCraft('alchemist','${r.name}')">CRAFT</button>
    </div>`;
  }).join('');
}

// Initialize the new crafting UI
function initCrafting() {
  // All accordion panels start closed by default
  document.querySelectorAll('.accordion-panel').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.accordion-arrow').forEach(a => a.textContent = '▼');
  // Render default tabs
  renderEquipmentRecipes('E');
  renderFoodRecipes('STRENGTH FOODS');
  renderPotionRecipes('HP');
  if (window._loadEnchanter) window._loadEnchanter();
}

window.doCraft = async function(npc, recipeName) {
  // "Other" potions cost gold only — no Cloud Function needed
  const otherPotions = window.CANONICAL_POTION_RECIPES?.Other || [];
  const otherRecipe  = otherPotions.find(r => r.name === recipeName);

  if (otherRecipe) {
    const cost = otherRecipe.cost || 0;
    const gold = window._charData?.gold || 0;
    if (gold < cost) {
      window.showToast(`Not enough gold. Need ${cost} coins.`, 'error');
      return;
    }
    showCraftingModal(recipeName);
    try {
      // Use runTransaction to prevent race conditions (concurrent writes clobbering inventory)
      const charRef = doc(db, 'characters', auth.currentUser.uid);
      await runTransaction(db, async tx => {
        const snap = await tx.get(charRef);
        if (!snap.exists()) throw new Error('Character not found');
        const data = snap.data();
        if ((data.gold || 0) < cost) throw new Error('Not enough gold');
        const inv = [...(data.inventory || [])];
        const existing = inv.find(i => i.name === recipeName);
        const _cIsEquip = getItemType(recipeName) === 'equipment';
        if (existing && !_cIsEquip) { existing.qty += 1; }
        else { const _ni = { name: recipeName, qty: 1, type: _cIsEquip ? 'equipment' : 'consumable' }; if (_cIsEquip) _ni.iid = Math.random().toString(36).slice(2,10)+Date.now().toString(36); inv.push(_ni); }
        tx.update(charRef, { gold: (data.gold || 0) - cost, inventory: inv });
      });
      showCraftingResult(`${recipeName} purchased and added to inventory!`);
      logActivity('🧪', `<b>Purchased:</b> ${recipeName} for ${cost} coins.`, '#a09080');
      await refreshCharData();
      setTimeout(hideCraftingModal, 1700);
    } catch (err) {
      showCraftingResult(`❌ Purchase failed. Please try again.`);
      setTimeout(hideCraftingModal, 2000);
    }
    return;
  }

  // All other recipes — call Cloud Function
  showCraftingModal(recipeName);
  try {
    const result = await fnCraftItem({ npc, recipeName });
    showCraftingResult(`${recipeName} crafted successfully, warped to inventory`);
    logActivity('🔨', `<b>Crafted:</b> ${recipeName} at ${npc}.`, '#a09080');
    await refreshCharData();
    // Stamp iid on crafted equipment (Cloud Function writes to Firestore directly)
    if (getItemType(recipeName)==='equipment') await _stampMissingIids(window._allInvItems||[]);
    setTimeout(hideCraftingModal, 1700);
  } catch(err) {
    const raw = err.message || '';
    let msg;
    if (raw.includes('Missing materials')) {
      // "Missing materials: need 4x Tin, have 0" → friendly version
      const match = raw.match(/need (\d+)x ([^,]+), have (\d+)/);
      if (match) {
        msg = `⚒️ Not enough materials!<br><small>You need <b>${match[1]}x ${match[2]}</b> but only have <b>${match[3]}</b>.</small>`;
      } else {
        msg = `⚒️ You're missing some required materials.`;
      }
    } else if (raw.includes('Not enough gold')) {
      const match = raw.match(/Need (\d+), have (\d+)/);
      msg = match
        ? `💰 Not enough gold!<br><small>This recipe costs <b>${match[1]} coins</b> but you only have <b>${match[2]}</b>.</small>`
        : `💰 Not enough gold to craft this item.`;
    } else if (raw.includes('Recipe not found')) {
      msg = `📜 Recipe unavailable. Try again or contact support.`;
    } else {
      msg = `❌ Crafting failed. Please try again.`;
    }
    showCraftingResult(msg);
    setTimeout(hideCraftingModal, 2800);
  }
};

const ENCHANT_RATES = {
  E:[1.00,0.90,0.80,0.70,0.60], D:[0.80,0.70,0.60,0.50,0.40],
  C:[0.60,0.50,0.40,0.30,0.20], B:[0.40,0.30,0.20,0.10,0.05],
  A:[0.05,0.05,0.05,0.05,0.05], S:[0.03,0.03,0.03,0.03,0.03],
};
const ENCHANT_REQS = {
  E:[{s:2,c:1000},{s:4,c:2000},{s:6,c:3000},{s:8,c:4000},{s:10,c:5000}],
  D:[{s:2,c:6000},{s:4,c:7000},{s:6,c:8000},{s:8,c:9000},{s:10,c:10000}],
  C:[{s:2,c:11000},{s:4,c:12000},{s:6,c:13000},{s:8,c:14000},{s:10,c:15000}],
  B:[{s:4,c:16000},{s:6,c:17000},{s:8,c:18000},{s:10,c:19000},{s:12,c:20000}],
  A:[{s:4,c:21000},{s:6,c:22000},{s:8,c:23000},{s:10,c:24000},{s:12,c:25000}],
  S:[{s:6,c:26000},{s:8,c:27000},{s:10,c:28000},{s:12,c:29000},{s:15,c:30000}],
};
// ── Crafting Modal Animation & Result Utility Functions ──
window.showCraftingModal = function(recipeName) {
  const modal = document.getElementById('crafting-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const hammer = modal.querySelector('.hammer');
  const spark  = modal.querySelector('.spark');
  const result = modal.querySelector('.crafting-result-message');
  if (hammer) { hammer.classList.remove('animate'); void hammer.offsetWidth; hammer.classList.add('animate'); }
  if (spark)  { spark.classList.remove('animate');  void spark.offsetWidth;  spark.classList.add('animate');  }
  if (result) { result.style.display = 'none'; result.innerHTML = ''; }
};

window.showCraftingResult = function(msg) {
  const modal = document.getElementById('crafting-modal');
  if (!modal) return;
  const result = modal.querySelector('.crafting-result-message');
  if (result) {
    result.innerHTML = msg;
    result.style.display = 'block';
  }
};

window.hideCraftingModal = function() {
  const modal = document.getElementById('crafting-modal');
  if (!modal) return;
  modal.querySelector('.hammer')?.classList.remove('animate');
  modal.querySelector('.spark')?.classList.remove('animate');
  modal.style.display = 'none';
};

// ── Client-side iid stamper ───────────────────────────────────────────────────
// Stamps missing iids directly onto Firestore inventory items for any account
// that missed the one-time migration script. Safe to run multiple times.
async function _stampMissingIids(inventory) {
  function _makeIid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  if (!_uid) return inventory;
  let dirty = false;
  const expanded = [];
  inventory.forEach(item => {
    const correctType = getItemType(item.name); // 'equipment', 'material', 'consumable', 'quest'
    const isEquip     = correctType === 'equipment';

    // ── Fix wrong type field baked into the DB document ──────────────────
    // Determines the correct storage type: equipment → 'weapon' or 'armor',
    // everything else → use getItemType result.
    let storageType = item.type;
    if (isEquip) {
      const base = (item.name || '').replace(/\s*\+\d+$/, '').trim();
      const correctStorage = ALL_ARMOR_NAMES.includes(base) ? 'armor'
                           : ALL_WEAPON_NAMES.includes(base) ? 'weapon'
                           : 'equipment';
      if (!storageType || (item.type !== correctStorage && item.type !== 'weapon' && item.type !== 'armor')) {
        storageType = correctStorage;
        dirty = true;
      }
    } else {
      if (!storageType) {
        // Item has no type at all — derive it from name
        storageType = correctType;
        dirty = true;
      } else if (item.type !== correctType && item.type === 'material' && correctType !== 'material') {
        // Non-equipment item wrongly stored as material
        storageType = correctType;
        dirty = true;
      }
    }

    if (!isEquip) { expanded.push({ ...item, type: storageType }); return; }

    const qty = item.qty ?? 1;
    if (qty > 1) {
      // Legacy stacked equipment — split into individual iid'd entries
      for (let i = 0; i < qty; i++) {
        expanded.push({ ...item, qty: 1, iid: _makeIid(), type: storageType });
      }
      dirty = true;
    } else if (!item.iid) {
      expanded.push({ ...item, qty: 1, iid: _makeIid(), type: storageType });
      dirty = true;
    } else {
      expanded.push({ ...item, type: storageType });
    }
  });
  if (dirty) {
    try {
      await updateDoc(doc(db, 'characters', _uid), { inventory: expanded });
      // Sync local cache so the inventory grid also reflects the cleaned items
      if (window._charData) window._charData.inventory = expanded;
      if (window._allInvItems) window._allInvItems = expanded;
      console.log('[STAMP] Fixed inventory types/iids for', _uid);
    } catch(e) {
      console.warn('[STAMP] Could not fix inventory:', e);
    }
  }
  return expanded;
}

window._loadEnchanter = async function() {
  const sel = document.getElementById('enchant-item-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading...</option>';
  sel.disabled = true;

  // Auto-stamp any legacy equipment missing iids before building the dropdown
  const rawInv = (window._allInvItems || []);
  const stamped = await _stampMissingIids(rawInv);
  // Reflect stamped inventory back into global cache
  if (window._allInvItems) window._allInvItems = stamped;

  sel.innerHTML = '<option value="">Choose from inventory...</option>';
  sel.disabled = false;

  // Expand equipment items so each piece gets its own dropdown slot
  const rawEquip = stamped.filter(i => getItemType(i.name) === 'equipment');
  const equipItems = [];
  rawEquip.forEach(item => {
    const qty = item.qty ?? 1;
    if (qty > 1) {
      // Shouldn't happen after stamping, but handle gracefully
      for (let i = 0; i < qty; i++) equipItems.push({ ...item, qty: 1, _slotIndex: i });
    } else {
      equipItems.push(item);
    }
  });

  equipItems.forEach((item, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    const baseName = item.name.replace(/\s*\+\d+$/, '');
    opt.textContent = `${baseName} (${item.enchantLevel ? '+'+item.enchantLevel : 'unenchanted'})`;
    sel.appendChild(opt);
  });

  sel.onchange = function() {
    const item  = equipItems[parseInt(sel.value)];
    const infoEl = document.getElementById('enchant-info');
    const btn    = document.getElementById('btn-enchant');
    const errEl  = document.getElementById('enchant-error');
    if (!item) { infoEl.style.display='none'; btn.disabled=true; return; }

    // All items are guaranteed iid'd after _stampMissingIids above.
    // Guard just in case something slipped through.
    if (!item.iid) {
      infoEl.style.display = 'none';
      btn.disabled = true;
      errEl.textContent = 'Could not assign an ID to this item. Please refresh and try again.';
      return;
    }
    errEl.textContent = '';

    const grade = item.grade || 'E';
    const lvl   = item.enchantLevel || 0;
    if (lvl >= 5) {
      infoEl.style.display = 'block';
      set('enchant-current-level', '+5 (MAX)');
      set('enchant-success-rate',  '—');
      set('enchant-stones-needed', '—');
      set('enchant-gold-cost',     '—');
      btn.disabled = true;
      return;
    }
    const req  = ENCHANT_REQS[grade]?.[lvl];
    const rate = ENCHANT_RATES[grade]?.[lvl];
    set('enchant-current-level',  '+' + lvl);
    set('enchant-success-rate',   Math.round((rate||0)*100) + '%');
    set('enchant-stones-needed',  `${req?.s||'?'}x ${grade}-grade Runestone`);
    set('enchant-gold-cost',      `${req?.c||'?'} coins`);
    infoEl.style.display = 'block';
    btn.disabled = false;
    btn.dataset.iid        = item.iid;
    btn.dataset.itemName   = item.name.replace(/\s*\+\d+$/, '');
    btn.dataset.itemGrade  = grade;
    btn.dataset.enchantLvl = lvl;
  };
};

window._doEnchant = async function() {
  const btn = document.getElementById('btn-enchant');
  const errEl = document.getElementById('enchant-error');
  errEl.textContent = '';
  btn.disabled = true; btn.textContent = 'ENCHANTING...';

  try {
    const result = await fnEnchantItem({
      iid:                btn.dataset.iid,
      itemName:           btn.dataset.itemName,
      itemGrade:          btn.dataset.itemGrade,
      currentEnchantLevel: parseInt(btn.dataset.enchantLvl),
    });
    const d = result.data;
    window.showToast(d.message, d.success ? 'success' : 'error');
    if (d.success) logActivity('✨', `<b>Enchantment Succeeded!</b> ${btn.dataset.itemName} upgraded to +${parseInt(btn.dataset.enchantLvl)+1}.`, '#b88fe0');
    else logActivity('💥', `<b>Enchantment Failed.</b> ${btn.dataset.itemName} resisted the attempt.`, '#e05555');
    await refreshCharData();
    window._loadEnchanter();
  } catch(err) {
    errEl.textContent = err.message || 'Enchantment failed.';
  } finally {
    btn.disabled = false; btn.textContent = '✨ ENCHANT';
  }
};



// ═══════════════════════════════════════════════════
//  REFRESH CHARACTER DATA
// ═══════════════════════════════════════════════════
// ── Single source of truth: sync every stat display from a charData object ──
function _resolveContinentFromLocation(c) {
  const rawLoc = (c.kingdom || c.location || '').toLowerCase().split('—')[0].trim();
  if (!rawLoc) return '';

  const fuzzyMatches = [
    { continent: 'Northern Continent', keys: ['frostspire','whitecrest','icerun','paleglow','mistveil','frostfang','sheen lake','misty hollow','dark cathedral','wisteria','silver lake','hobbit cave','arctic willow','dream river','suldan mine','shrine of secrets','aurora basin','forgotten estuary'] },
    { continent: 'Western Continent',  keys: ['solmere','sunpetal','basil','riverend','verdance','whispering forest','golden plains','element valley','defiled sanctum','asahi valley','moss stream','argent grotto','golden river','shiny cavern','purgatory of light','temple of verdict','heart garden','valley of overflowing'] },
    { continent: 'Eastern Continent',  keys: [
      'vorthak',
      'lake of reflections','crystal cave','rainbow valley','shimmering peak','mirror sky',
      'tempest crown','frostfall expanse','ember horizon','veilwater basin','titan divide',
      'crimson fang','root grove','serpent mire','burrowdeep basin','gremlin hollows',
      'defiled sanctum','dark cathedral','gravemarch fields','fallen bastion','whispering necropolis',
      'blighted world','infernal reach','sphinx dominion','ashwing aerie','leviathan depths',
    ] },
    { continent: 'Southern Continent', keys: [
      'nyx abyss',
      'fractured firmament','maw of eternity','veil of madness','the watching expanse','descent of the nameless',
      'gravefall descent','weeping caverns','kingdom of chains','the hollow deep','throne of the depths',
      'throne of pride','hallow of greed','crimson feast','veil of desire','the forsaken graves',
      'bleeding constellations','the watching worlds','nebula of whispers','eclipse throne','the endless maw',
      'root of malevolence','grove of horror','canopy of despair','crown of madness','heartwood abyss',
    ] },
  ];

  for (const p of fuzzyMatches) {
    if (p.keys.some(k => rawLoc.includes(k))) return p.continent;
  }

  // Backward-compatible if map module exposes CONTINENTS globally
  if (window.CONTINENTS) {
    for (const contKey of Object.keys(window.CONTINENTS)) {
      const contObj = window.CONTINENTS[contKey];
      if (!contObj) continue;
      const continentLabel = contObj.label?.split('·')[0]?.trim() || contObj.name;
      if (contObj.capitalId && rawLoc.includes(contObj.capitalId)) return continentLabel;
      if (contObj.settlements?.some(s => rawLoc.includes((s.id||'').toLowerCase()) || rawLoc.includes((s.label||'').toLowerCase()))) return continentLabel;
      if (contObj.explore?.some(e => rawLoc === (e.id||'').toLowerCase() || rawLoc === (e.label||'').toLowerCase())) return continentLabel;
    }
  }

  return '';
}

function _getActiveFoodDesc(c) {
  if (!c?.activeFoods) return '';
  const now = Date.now();
  const lines = [];
  const statLabel = { str:'STR', int:'INT', def:'DEF', dex:'DEX' };
  for (const [stat, buff] of Object.entries(c.activeFoods)) {
    if (buff.expiry > now) {
      const minsLeft = Math.ceil((buff.expiry - now) / 60000);
      lines.push(`+${Math.round(buff.pct*100)}% ${statLabel[stat]||stat} (${minsLeft}m left)`);
    }
  }
  const luck = c.luckBuff;
  if (luck?.expiry > now) {
    const minsLeft = Math.ceil((luck.expiry - now) / 60000);
    lines.push(`+${luck.pct}% Luck (${minsLeft}m left)`);
  }
  const exp = c.expBuff;
  if (exp?.expiry > now) {
    const minsLeft = Math.ceil((exp.expiry - now) / 60000);
    lines.push(`+${exp.pct}% EXP gain (${minsLeft}m left)`);
  }
  return lines.join(' · ');
}

function _syncAllDisplays(c) {
  if (!c) return;
  const hpMax   = c.hpMax   ?? 100;
  const manaMax = c.manaMax ?? 50;
  // During auto-battle, the battle loop tracks live HP/mana separately from
  // _charData (which reflects the last Firestore write, not the current tick).
  // Using the stale _charData values here causes the stat bar to flicker back
  // and forth between the Firestore value and the live battle value every tick.
  // Always prefer the live battle values while a fight is in progress.
  const liveHp   = (_autoBattleRunning && window._autoBattleLiveHp   !== undefined) ? window._autoBattleLiveHp   : null;
  const liveMana = (_autoBattleRunning && window._autoBattleLiveMana !== undefined) ? window._autoBattleLiveMana : null;
  // Always clamp — can never display more than the max
  const hp      = Math.min(liveHp   ?? c.hp   ?? 100, hpMax);
  const mana    = Math.min(liveMana ?? c.mana ?? 50,  manaMax);
  const gold    = c.gold ?? 0;
  const xp      = c.xp   ?? 0;
  const xpMax   = c.xpMax ?? 100;
  const level   = c.level  ?? 1;
  const rank    = c.rank   || 'Wanderer';
  const locRaw  = (c.kingdom || c.location || '—').split('—')[0].trim();
  const contRaw = c.continent || c.travelContinent || _resolveContinentFromLocation(c) || '';
  const loc     = locRaw ? locRaw.toUpperCase() : '—';
  const cont    = contRaw ? contRaw.toUpperCase() : '';
  // Overview cards
  set('stat-gold',      gold);
  set('market-gold-display', gold); // Market panel gold display
  set('stat-hp',        hp);
  set('stat-mana',      mana);
  const _dispLvl = _displayLevel(level);
  set('stat-level',     `Level ${_dispLvl}`);
  set('stat-rank',      rank);
  set('stat-loc',       loc);
  set('stat-continent', cont);
  set('stat-points',    c.statPoints ?? 0);
  // Overview card max labels (dynamic)
  set('stat-hp-max',   `/ ${hpMax}`);
  set('stat-mana-max', `/ ${manaMax}`);
  // Character panel
  set('s-hp',    `${hp} / ${hpMax}`);
  set('s-mana',  `${mana} / ${manaMax}`);
  set('s-gold',  gold);
  set('s-xp',    `${xp} / ${xpMax}`);
  set('s-level', `Level ${_dispLvl}`);
  set('s-rank',  rank);
  set('s-loc',   loc);
  // Sidebar XP bar
  set('sb-xp',   `${xp} / ${xpMax}`);
  css('sb-xpfill', 'width', Math.min(100, Math.round((xp / xpMax) * 100)) + '%');
  set('sb-name', c.charName || c.name || '');
  set('sb-meta', `${rank} · Level ${_dispLvl}`);
  // Keep profession XP bar in sync whenever character data refreshes from server.
  // Skip if a gather write is still in-flight — the optimistic render already
  // showed the correct value and we don't want Firestore's pre-commit snapshot
  // to revert it before the write is confirmed.
  if (c.profession && !window._gatherWritePending) showActiveProfession(c);
}

async function refreshCharData() {
  if (!_uid) return;
  try {
    const snap = await getDoc(doc(db, 'characters', _uid));
    if (snap.exists()) {
      _charData        = snap.data();
      window._charData = _charData;
      window._allInvItems = _charData.inventory || [];
      _syncAllDisplays(_charData);
      window.renderInventory(window._allInvItems);
      updateZoneLocks();
      window.updatePubCharData?.(_charData);
      // If companion panel is active, re-render it
      const companionPanel = document.getElementById('panel-companion');
      if (companionPanel && companionPanel.classList.contains('active')) {
        window.renderCompanionPanel?.();
      }
    }
  } catch(e) { console.error(e); }
}

// ═══════════════════════════════════════════════════
//  PASSIVE HP / MANA REGEN  (timestamp-based + client interval)
//  Rules:
//   • +10 HP per minute, +5 Mana per minute, capped at hpMax / manaMax
//   • No regen while dead, or while an auto-battle is running
//   • On login: calculate minutes elapsed since lastActive, apply bulk catch-up
//   • While online: client interval ticks every 60 s for the same rates
//   • lastActive is written to Firestore every tick and on login
// ═══════════════════════════════════════════════════
const _REGEN_HP_PER_MIN   = 10;
const _REGEN_MANA_PER_MIN =  5;
let   _regenInterval      = null; // single interval handle — never stack

/** Apply regen for `minutes` elapsed, return updated { hp, mana } (clamped to max). */
function _calcPassiveRegen(hp, mana, hpMax, manaMax, minutes) {
  if (minutes <= 0) return { hp, mana };
  const newHp   = Math.min(hpMax,   hp   + Math.floor(_REGEN_HP_PER_MIN   * minutes));
  const newMana = Math.min(manaMax, mana + Math.floor(_REGEN_MANA_PER_MIN * minutes));
  return { hp: newHp, mana: newMana };
}

/** Returns true when regen should be blocked. */
function _regenBlocked() {
  return !!(_charData?.isDead) || !!_autoBattleRunning || !!_currentBattle;
}

/**
 * Called once on login (after _charData is loaded).
 * Calculates offline catch-up from lastActive, writes back to Firestore,
 * then starts the live interval.
 */
async function _initPassiveRegen() {
  if (!_uid || !_charData) return;

  // Cleanup any stale interval from a previous session (hot-reload guard)
  if (_regenInterval) { clearInterval(_regenInterval); _regenInterval = null; }

  if (!_regenBlocked()) {
    const now          = Date.now();
    const lastActive   = _charData.lastActive ?? now; // ms epoch stored in Firestore
    const elapsedMs    = Math.max(0, now - lastActive);
    const elapsedMins  = elapsedMs / 60000;

    if (elapsedMins >= 1) {
      const hpMax   = _charData.hpMax   ?? 100;
      const manaMax = _charData.manaMax ?? 50;
      const { hp: newHp, mana: newMana } = _calcPassiveRegen(
        _charData.hp   ?? hpMax,
        _charData.mana ?? manaMax,
        hpMax, manaMax,
        elapsedMins
      );
      const regenHp   = newHp   - (_charData.hp   ?? hpMax);
      const regenMana = newMana - (_charData.mana ?? manaMax);

      if (regenHp > 0 || regenMana > 0) {
        _charData.hp   = newHp;
        _charData.mana = newMana;
        window._charData = _charData;
        _syncAllDisplays(_charData);
        try {
          await updateDoc(doc(db, 'characters', _uid), {
            hp: newHp, mana: newMana, lastActive: now
          });
        } catch(e) { console.warn('[Regen] Catch-up write failed:', e); }
        const mins = Math.floor(elapsedMins);
        window.showToast(
          `💤 Rested for ${mins} min — +${regenHp} HP, +${regenMana} Mana`,
          'success'
        );
      } else {
        // Still update lastActive even if already at max
        try {
          await updateDoc(doc(db, 'characters', _uid), { lastActive: now });
        } catch(e) {}
      }
    } else {
      // Less than a minute — just stamp lastActive
      try {
        await updateDoc(doc(db, 'characters', _uid), { lastActive: now });
      } catch(e) {}
    }
  }

  // Start live tick — fires every 60 s while online
  _regenInterval = setInterval(_regenTick, 60000);
}

/** One live regen tick (+10 HP, +5 Mana). Writes to Firestore and updates UI. */
async function _regenTick() {
  if (!_uid || !_charData) return;
  if (_regenBlocked()) return; // skip ticks during battle or while dead
  const hpMax   = _charData.hpMax   ?? 100;
  const manaMax = _charData.manaMax ?? 50;
  const curHp   = _charData.hp      ?? hpMax;
  const curMana = _charData.mana    ?? manaMax;

  // Nothing to do if already full
  if (curHp >= hpMax && curMana >= manaMax) {
    // Still stamp lastActive so offline catch-up stays accurate
    try { await updateDoc(doc(db, 'characters', _uid), { lastActive: Date.now() }); } catch(e) {}
    return;
  }

  const newHp   = Math.min(hpMax,   curHp   + _REGEN_HP_PER_MIN);
  const newMana = Math.min(manaMax, curMana + _REGEN_MANA_PER_MIN);
  _charData.hp   = newHp;
  _charData.mana = newMana;
  window._charData = _charData;
  _syncAllDisplays(_charData);
  try {
    await updateDoc(doc(db, 'characters', _uid), {
      hp: newHp, mana: newMana, lastActive: Date.now()
    });
  } catch(e) { console.warn('[Regen] Tick write failed:', e); }
}

/** Inject passive regen rates into the character panel vitals card. */
function _renderRegenInCrafting() {
  const el = document.getElementById('char-regen-info');
  if (!el) return;
  el.innerHTML = `
    <tr style="border-top:1px solid var(--border)">
      <td style="padding-top:8px;color:var(--gold);font-family:var(--font-mono);font-size:0.6rem;letter-spacing:0.06em">PASSIVE REGEN</td>
      <td style="padding-top:8px">
        <span style="color:#e05555">❤️ +${_REGEN_HP_PER_MIN} HP</span>
        <span style="color:var(--ash);margin:0 4px">/</span>
        <span style="color:#5b9fe0">💠 +${_REGEN_MANA_PER_MIN} Mana</span>
        <span style="color:var(--ash);font-size:0.7rem;margin-left:4px">per min</span>
      </td>
    </tr>
    <tr>
      <td></td>
      <td style="font-size:0.68rem;color:var(--ash);font-style:italic;padding-bottom:2px">Paused during battle</td>
    </tr>`;
}

// Hook into panel switching for guild and crafting init
const _origSwitchPanel = window.switchPanel;
// We can't reassign here since it's in a different script block
// Instead expose init hooks
window._onPanelSwitch = function(name) {
  if (name === 'battle')    { checkDeathState(); updateZoneLocks(); }
  if (name === 'crafting')  initCrafting();
  if (name === 'guild')     initGuild();
  if (name === 'shrine')    _renderShrinePanel();
  if (name === 'character') {
    _renderRegenInCrafting(); // renders regen into vitals card
    _checkPotionResetPending();
  }
  if (name === 'market')    _syncAllDisplays(_charData);
  if (name === 'map')      { window._initLayeredMap?.(); }
  if (name === 'activity') renderActivityFeed();
  if (name === 'companion') window.renderCompanionPanel?.();
  if (name === 'worlddev') renderWorldDevPanel();
  if (name === 'pub') {
    window.updatePubCharData?.(_charData);
    window.renderPubPanel?.();
  }
  // Apply highlights when player opens RP Chat; clean up when they leave
  if (name === 'chat' || name === 'rp' || name === 'rpchat') {
    setTimeout(window._observeChatMentions, 200);
  } else {
    window._onLeaveChatPanel?.();
  }
};

// ── Potion Reset Pending Check ───────────────────────────────────────────────
// If a player used a Class/Race/Divine Shift potion before the picker UI existed,
// their slot is null in Firestore. Detect this on character panel open and show
// the picker immediately — no need to buy/use another potion.
function _checkPotionResetPending() {
  if (!_charData) return;

  // Only show one picker at a time; priority: class → race → deity
  if (!_charData.charClass) {
    setTimeout(() => {
      document.getElementById('ink-picker-modal')?.remove();
      // Show a brief notice banner above the picker
      const overlay = _inkPickerOverlay(
        'Choose Your Class',
        `<div style="background:rgba(201,168,76,0.10);border:1px solid var(--gold-dim);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:0.82rem;color:var(--gold-dim);text-align:center;">
          ⚗️ Your class was previously reset. Pick a new one below — no potion needed.
        </div>
        <div id="ink-picker-cards">${_buildClassCards()}</div>
        <div style="display:flex;gap:10px;margin-top:18px;justify-content:center;">
          <button class="btn-primary" style="max-width:200px;" onclick="window._inkPickerConfirmClass()">CONFIRM CLASS</button>
        </div>`
      );
      window._inkPickerSel = null;
      window._inkPickerConfirmClass = async function() {
        const cls = window._inkPickerSel;
        if (!cls) { window.showToast('Please select a class first.', 'error'); return; }
        const roleMap = { Warrior:'Damage Dealer', Guardian:'Tank', Arcanist:'Damage Dealer', Hunter:'Damage Dealer', Assassin:'Damage Dealer', Cleric:'Support/Healer', Summoner:'Summoner' };
        try {
          await updateDoc(doc(db, 'characters', _uid), { charClass: cls, classRole: roleMap[cls] || cls });
          Object.assign(_charData, { charClass: cls, classRole: roleMap[cls] || cls });
          overlay.remove();
          await refreshCharData(); _syncAllDisplays(_charData);
          window.showToast(`⚔️ Class set to ${cls}!`, 'success');
          logActivity('⚔️', `Chose <b>${cls}</b> as their new class.`, '#c9a84c');
        } catch(err) { window.showToast('Failed to save class. Try again.', 'error'); }
      };
    }, 300);
    return; // don't stack multiple pickers
  }

  if (!_charData.race) {
    setTimeout(() => {
      document.getElementById('ink-picker-modal')?.remove();
      const overlay = _inkPickerOverlay(
        'Choose Your Race',
        `<div style="background:rgba(201,168,76,0.10);border:1px solid var(--gold-dim);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:0.82rem;color:var(--gold-dim);text-align:center;">
          🌀 Your race was previously reset. Pick a new one below — no potion needed.
        </div>
        <div id="ink-picker-cards">${_buildRaceCards()}</div>
        <div style="display:flex;gap:10px;margin-top:18px;justify-content:center;">
          <button class="btn-primary" style="max-width:200px;" onclick="window._inkPickerConfirmRace()">CONFIRM RACE</button>
        </div>`
      );
      window._inkPickerSel = null;
      window._inkPickerConfirmRace = async function() {
        const raceName = window._inkPickerSel;
        if (!raceName) { window.showToast('Please select a race first.', 'error'); return; }
        const raceData = RACE_LIST.find(r => r.name === raceName);
        const raceAttr = raceData?.attr || '';
        try {
          await updateDoc(doc(db, 'characters', _uid), { race: raceName, raceAttr });
          Object.assign(_charData, { race: raceName, raceAttr });
          overlay.remove();
          await refreshCharData(); _syncAllDisplays(_charData);
          window.showToast(`🌀 Race set to ${raceName}!`, 'success');
          logActivity('🌀', `Chose <b>${raceName}</b> as their new race.`, '#c9a84c');
        } catch(err) { window.showToast('Failed to save race. Try again.', 'error'); }
      };
    }, 300);
    return;
  }

  if (!_charData.deity) {
    setTimeout(() => {
      document.getElementById('ink-picker-modal')?.remove();
      const overlay = _inkPickerOverlay(
        'Choose Your Deity',
        `<div style="background:rgba(201,168,76,0.10);border:1px solid var(--gold-dim);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:0.82rem;color:var(--gold-dim);text-align:center;">
          🔮 Your deity was previously reset. Pledge your faith below — no potion needed.
        </div>
        <div id="ink-picker-cards">${_buildDeityCards()}</div>
        <div style="display:flex;gap:10px;margin-top:18px;justify-content:center;">
          <button class="btn-primary" style="max-width:200px;" onclick="window._inkPickerConfirmDeity()">CONFIRM DEITY</button>
        </div>`
      );
      window._inkPickerSel = null;
      window._inkPickerConfirmDeity = async function() {
        const deityName = window._inkPickerSel;
        if (!deityName) { window.showToast('Please select a deity first.', 'error'); return; }
        const deityTitle = DEITY_LORE[deityName]?.title || '';
        try {
          await updateDoc(doc(db, 'characters', _uid), { deity: deityName, deityTitle });
          Object.assign(_charData, { deity: deityName, deityTitle });
          overlay.remove();
          await refreshCharData(); _syncAllDisplays(_charData);
          window.showToast(`🔮 Deity set to ${deityName}!`, 'success');
          logActivity('🔮', `Pledged faith to <b>${deityName}</b> as their new deity.`, '#c9a84c');
        } catch(err) { window.showToast('Failed to save deity. Try again.', 'error'); }
      };
    }, 300);
  }
}

// Card HTML builders shared by both potion-use and pending-check flows
function _buildClassCards() {
  const classes = [
    { name:'Warrior',  icon:'⚔️', role:'Damage Dealer', desc:'Melee powerhouse. Relies on STR and high raw damage output.' },
    { name:'Guardian', icon:'🛡️', role:'Tank',           desc:'Defensive anchor. Excels at absorbing damage with high DEF.' },
    { name:'Arcanist', icon:'🔮', role:'Damage Dealer',  desc:'Pure magic attacker. Scales off INT for devastating spells.' },
    { name:'Hunter',   icon:'🏹', role:'Damage Dealer',  desc:'Ranged precision fighter. DEX-based with poison and debuffs.' },
    { name:'Assassin', icon:'🗡️', role:'Damage Dealer',  desc:'Burst damage specialist. First strikes hit hardest.' },
    { name:'Cleric',   icon:'✨', role:'Support/Healer', desc:'Team healer and buffer. Keeps allies alive and empowered.' },
    { name:'Summoner', icon:'🌀', role:'Summoner',       desc:'Commands summoned creatures. INT-based with debuff utility.' },
  ];
  return classes.map(c => `
    <div class="ink-picker-card" data-class="${c.name}" onclick="document.querySelectorAll('.ink-picker-card').forEach(el=>el.classList.remove('ink-picker-selected'));this.classList.add('ink-picker-selected');window._inkPickerSel='${c.name}';"
      style="cursor:pointer;border:1.5px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;display:flex;align-items:flex-start;gap:12px;transition:border-color .2s,background .2s;background:var(--ink3);">
      <div style="font-size:1.6rem;line-height:1;min-width:32px;text-align:center;">${c.icon}</div>
      <div>
        <div style="font-family:var(--ff-display);font-size:0.95rem;color:var(--gold);letter-spacing:0.06em;">${c.name}</div>
        <div style="font-size:0.72rem;color:var(--ash);margin-bottom:3px;font-family:var(--font-mono);letter-spacing:0.04em;">${c.role}</div>
        <div style="font-size:0.82rem;color:var(--text-dim);font-style:italic;">${c.desc}</div>
      </div>
    </div>`).join('');
}

function _buildRaceCards() {
  return RACE_LIST.map(r => `
    <div class="ink-picker-card" data-race="${r.name}" onclick="document.querySelectorAll('.ink-picker-card').forEach(el=>el.classList.remove('ink-picker-selected'));this.classList.add('ink-picker-selected');window._inkPickerSel='${r.name}';"
      style="cursor:pointer;border:1.5px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;display:flex;align-items:flex-start;gap:12px;transition:border-color .2s,background .2s;background:var(--ink3);">
      <div style="font-size:1.6rem;line-height:1;min-width:32px;text-align:center;">${r.icon}</div>
      <div>
        <div style="font-family:var(--ff-display);font-size:0.95rem;color:var(--gold);letter-spacing:0.06em;">${r.name}</div>
        <div style="font-size:0.72rem;color:var(--ash);margin-bottom:3px;font-family:var(--font-mono);letter-spacing:0.04em;">${r.attr}</div>
        <div style="font-size:0.82rem;color:var(--text-dim);font-style:italic;">${r.desc}</div>
      </div>
    </div>`).join('');
}

function _buildDeityCards() {
  return Object.entries(DEITY_LORE).map(([name, lore]) => {
    const icon = DEITY_ICONS[name] || '⛩️';
    return `
    <div class="ink-picker-card" data-deity="${name}" onclick="document.querySelectorAll('.ink-picker-card').forEach(el=>el.classList.remove('ink-picker-selected'));this.classList.add('ink-picker-selected');window._inkPickerSel='${name}';"
      style="cursor:pointer;border:1.5px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;display:flex;align-items:flex-start;gap:12px;transition:border-color .2s,background .2s;background:var(--ink3);">
      <div style="font-size:1.6rem;line-height:1;min-width:32px;text-align:center;">${icon}</div>
      <div>
        <div style="font-family:var(--ff-display);font-size:0.95rem;color:var(--gold);letter-spacing:0.06em;">${name}</div>
        <div style="font-size:0.72rem;color:var(--ash);margin-bottom:3px;font-family:var(--font-mono);letter-spacing:0.04em;">${lore.title} · ${lore.authorities}</div>
        <div style="font-size:0.82rem;color:var(--text-dim);font-style:italic;">${lore.desc}</div>
      </div>
    </div>`;
  }).join('');
}

// Render World Development panel (latest 5 events, auto-delete oldest if >5)
function renderWorldDevPanel() {
  const listEl = document.getElementById('worlddev-panel-list');
  if (!listEl) return;
  const q = query(collection(db, 'worldEvents'), where('status', '==', 'active'), orderBy('createdAt', 'desc'));
  onSnapshot(q, async snap => {
    if (snap.empty) {
      listEl.innerHTML = '<p style="color:var(--text-dim);font-style:italic;font-size:0.95rem">No world developments yet.</p>';
      return;
    }
    // Backend now handles archiving if more than 5 events. No client-side update needed.
    const docs = snap.docs.slice(0, 5);
    listEl.innerHTML = docs.map(d => {
      const e = d.data();
      const createdAt = e.createdAt?.toDate?.() || null;
      const descHtml = (e.description || '').split(/\n+/).map(p => p ? `<p style='margin:0 0 8px 0'>${p}</p>` : '').join('');
      return `<div class="event-card" style="margin-bottom:18px;padding-bottom:10px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
          <span style="font-weight:700;letter-spacing:0.04em;font-size:1.05em;color:var(--gold);text-transform:uppercase;">${e.title || 'Untitled'}</span>
          <span style="margin-left:auto;font-size:0.82em;color:var(--ash-light)">${createdAt ? createdAt.toLocaleString() : ''}</span>
        </div>
        <div style="font-size:0.95em;color:var(--text-dim);margin-bottom:4px;">${descHtml}</div>
        <div style="font-size:0.82em;color:var(--ash);display:flex;gap:16px;flex-wrap:wrap;">
          <span>By <span style="color:var(--gold-dim)">${e.createdBy || '—'}</span></span>
          ${e.location ? `<span>📍 ${e.location}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  });
}

// ── Companion roster ─────────────────────────────────────────────────────────
const _ALL_COMPANIONS = [
  { name: "Bubbloon",  icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Fbubbloon.jpg?alt=media&token=b9e56702-2037-47b6-8ec8-6dcca63026a1",  type: "Aquatic",   bonus: "+12% HP regen after each fight" },
  { name: "Duskit",    icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Fduskit.jpg?alt=media&token=59da7b4e-5969-4292-a002-4569586d4d99",    type: "Shadow",    bonus: "+5% chance to inflict Poison on hit" },
  { name: "Emberling", icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Femberling.jpg?alt=media&token=81df87ae-e95d-44bf-8599-78e16dfd0058", type: "Flame",     bonus: "+8% ATK bonus on melee strikes" },
  { name: "Glimmer",   icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Fglimmer.jpg?alt=media&token=b7ce2ceb-6520-4e35-847b-eff27e16d0e7",   type: "Fae",       bonus: "+10% mana regeneration per turn" },
  { name: "Nibblit",   icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Fnibblit.jpg?alt=media&token=47cd0def-ef58-4153-9f96-8b17dd1a88e7",   type: "Beast",     bonus: "+8% EXP gain from all sources" },
  { name: "Pebblin",   icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Fpebblin.jpg?alt=media&token=bbe2e024-f50e-4db1-9636-b006278321c0",   type: "Earth",     bonus: "+10 flat DEF in battle" },
  { name: "Spriglet",  icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Fspriglet.jpg?alt=media&token=96419618-7b63-4e5d-98aa-881738885d67",  type: "Nature",    bonus: "+5% gold drop from monsters" },
  { name: "Trackit",   icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Ftrackit.jpg?alt=media&token=fa089337-1884-4a16-8f79-234ff211c007",   type: "Scout",     bonus: "+6% DEX in battle" },
  { name: "Whispling", icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Fwhispling.jpg?alt=media&token=932ab710-7eaa-4c5e-a2f6-e27d6867a618", type: "Wind",      bonus: "+10% INT during skill use" },
  { name: "Zappit",    icon: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/companion-images%2Fzappit.jpg?alt=media&token=b39c8ca0-e5b7-4e0f-9280-61ecc66668fc",    type: "Electric",  bonus: "Revive once per day at 30% HP" },
];
window._ALL_COMPANIONS = _ALL_COMPANIONS;

window.renderCompanionPanel = function() {
  const container = document.getElementById('companion-panel-container') || document.getElementById('companion-grid');
  if (!container || !_charData) return;
  const c = _charData;
  const rankOrder = ['Wanderer','Follower','Disciple','Ascendant','Exalted','Mythic'];
  const hasUnlocked = (rankOrder.indexOf(c.rank) >= 1) || !!c.isDeity;
  const active = c.companion?.name || null;

  let activeCardHtml = '';
  if (active) {
    const COMPANION_EXP_TABLE = [0, 1000, 1800, 3000, 4200, 5700, 7000, 9600, 12000, 15000];
    let compLevel = c.companionLevel || 1;
    let compExp   = c.companionExp   || 0;
    let compXpMax = COMPANION_EXP_TABLE[compLevel - 1] || 1000;
    while (compLevel < 10 && compExp >= compXpMax) { compExp -= compXpMax; compLevel++; compXpMax = COMPANION_EXP_TABLE[compLevel-1] || compXpMax; }
    const expPct = Math.min(100, Math.round((compExp / compXpMax) * 100));
    const comp   = _ALL_COMPANIONS.find(x => x.name === active) || {};
    activeCardHtml = `<div style="background:rgba(30,30,30,0.9);border:1.5px solid var(--gold-dim);border-radius:16px;padding:22px 28px;max-width:420px;margin:0 auto 28px auto;text-align:center;">
      <div style="font-size:0.7rem;letter-spacing:2px;color:var(--ash);text-transform:uppercase;margin-bottom:6px;">Active Companion</div>
      <div style="margin-bottom:6px;"><img src="${comp.icon || ''}" alt="${active}" style="width:80px;height:80px;object-fit:cover;border-radius:50%;border:2px solid var(--gold-dim);"></div>
      <div style="font-size:1.2rem;font-weight:700;color:var(--gold);">${active}</div>
      <div style="font-size:0.82rem;color:var(--text-dim);margin-bottom:10px;">${comp.type || ''} · Level ${compLevel}</div>
      <div style="background:var(--ink3);border-radius:6px;height:7px;overflow:hidden;max-width:240px;margin:0 auto 4px auto;">
        <div style="height:100%;width:${expPct}%;background:var(--gold-dim);border-radius:6px;transition:width 0.4s;"></div>
      </div>
      <div style="font-size:0.78rem;color:var(--ash-light);margin-bottom:10px;">EXP: ${compExp} / ${compXpMax}</div>
      <div style="font-size:0.92rem;color:var(--gold);">${comp.bonus || ''}</div>
    </div>`;
  }

  const lockBanner = !hasUnlocked
    ? `<div style="background:rgba(180,140,40,0.12);border:1px solid var(--gold-dim);border-radius:10px;padding:12px 18px;text-align:center;margin-bottom:20px;font-size:0.88rem;color:var(--gold);">
        🔒 Companions unlock at <b>Follower</b> rank.
      </div>`
    : '';

  const inv = c.inventory || [];
  const hasChangePotion = inv.some(i => i.name === 'Companion Change Potion' && i.qty > 0);

  const gridItems = _ALL_COMPANIONS.map(comp => {
    const isActive    = comp.name === active;
    const border      = isActive ? '2px solid var(--gold)' : '1.5px solid rgba(255,255,255,0.07)';
    const bg          = isActive ? 'rgba(201,168,76,0.12)' : 'rgba(30,30,30,0.7)';
    const activeBadge = isActive ? `<div style="font-size:0.7rem;letter-spacing:1px;color:var(--gold);text-transform:uppercase;margin-bottom:6px;">✦ Active</div>` : '';
    let btnHtml;
    if (isActive) {
      btnHtml = `<div style="font-size:0.8rem;color:var(--gold);margin-top:10px;">Your companion</div>`;
    } else if (!hasUnlocked) {
      btnHtml = `<div style="font-size:0.78rem;color:var(--ash);margin-top:10px;">🔒 Locked</div>`;
    } else if (active && !hasChangePotion) {
      btnHtml = `<div style="font-size:0.72rem;color:var(--ash);margin-top:10px;line-height:1.4;">🧪 Requires<br>Companion Change Potion</div>`;
    } else {
      const label = active ? '🔄 Switch' : 'Choose';
      btnHtml = `<button class="btn-primary" style="margin-top:10px;padding:7px 18px;font-size:0.8rem;" onclick="window.chooseCompanion(${_ALL_COMPANIONS.indexOf(comp)})">${label}</button>`;
    }
    return `<div style="background:${bg};border:${border};border-radius:14px;padding:22px 14px;text-align:center;transition:border 0.2s;opacity:${hasUnlocked || isActive ? '1' : '0.65'};">
      ${activeBadge}
      <div style="margin-bottom:10px;"><img src="${comp.icon}" alt="${comp.name}" style="width:120px;height:120px;object-fit:cover;border-radius:12px;border:1.5px solid rgba(255,255,255,0.1);"></div>
      <div style="font-weight:700;font-size:1rem;color:var(--gold);margin-bottom:3px;">${comp.name}</div>
      <div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:5px;">${comp.type}</div>
      <div style="font-size:0.82rem;color:var(--ash-light);">${comp.bonus}</div>
      ${btnHtml}
    </div>`;
  }).join('');

  container.innerHTML = `
    ${activeCardHtml}
    ${lockBanner}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px;padding:4px 0 28px 0;">
      ${gridItems}
    </div>`;
};

window.chooseCompanion = async function(index) {
  if (!window._charData || !_uid) return;
  const comp = _ALL_COMPANIONS[index];
  if (!comp) return;
  const { name, icon, bonus } = comp;
  const rankOrder   = ["Wanderer","Follower","Disciple","Ascendant","Exalted","Mythic"];
  const hasUnlocked = rankOrder.indexOf(window._charData.rank) >= 1 || !!window._charData.isDeity;
  if (!hasUnlocked) { window.showToast('Companions unlock at Follower rank.', 'error'); return; }

  // If player already has a companion, require a Companion Change Potion
  const currentCompanion = window._charData.companion?.name;
  if (currentCompanion && currentCompanion !== name) {
    const inv = window._charData.inventory || [];
    const potionEntry = inv.find(i => i.name === 'Companion Change Potion');
    if (!potionEntry || potionEntry.qty < 1) {
      window.showToast('You need a Companion Change Potion to switch companions.', 'error');
      return;
    }
  }

  const isSwitch = currentCompanion && currentCompanion !== name;
  const confirmMsg = isSwitch
    ? `Switch companion to <b>${name}</b>? This will consume 1 Companion Change Potion and reset their level.<br><img src="${icon}" style="width:80px;height:80px;object-fit:cover;border-radius:50%;border:2px solid var(--gold-dim);margin:10px 0;"><br><span style="font-size:0.85rem;color:var(--ash)">Bonus: ${bonus}</span>`
    : `Choose <b>${name}</b> as your companion?<br><img src="${icon}" style="width:80px;height:80px;object-fit:cover;border-radius:50%;border:2px solid var(--gold-dim);margin:10px 0;"><br><span style="font-size:0.85rem;color:var(--ash)">Bonus: ${bonus}</span>`;

  const confirmed = await inkConfirm(confirmMsg);
  if (!confirmed) return;

  const companionData = { name, icon, bonus, level: 1, exp: 0, expMax: 1000 };
  const charUpdates = { companion: companionData, companionLevel: 1, companionExp: 0 };

  // Consume the potion if switching
  if (isSwitch) {
    const inv = [...(window._charData.inventory || [])];
    const potIdx = inv.findIndex(i => i.name === 'Companion Change Potion');
    if (potIdx !== -1) {
      inv[potIdx].qty -= 1;
      if (inv[potIdx].qty <= 0) inv.splice(potIdx, 1);
      charUpdates.inventory = inv;
      window._charData.inventory = inv;
    }
  }
  try {
    await updateDoc(doc(db, 'characters', _uid), charUpdates);
    window._charData.companion = companionData;
    window._charData.companionLevel = 1;
    window._charData.companionExp = 0;
    window.renderCompanionPanel();
    const switchMsg = isSwitch ? ' (Companion Change Potion consumed)' : '';
    window.showToast(`${name} is now your companion!${switchMsg}`, 'success');
    logActivity('🐾', `<b>Companion ${isSwitch ? 'Switched' : 'Chosen'}!</b> ${name} joined your journey.`, '#c9a84c');
  } catch(e) {
    console.error(e);
    window.showToast('Failed to save companion.', 'error');
  }
};

// Render one entry into the feed DOM
function _pushActivityUI(icon, message, color, date) {
  const feedEl = document.getElementById('activity-feed-list');
  if (!feedEl) return;
  // Remove placeholder
  feedEl.querySelector('.activity-placeholder')?.remove();

  const time  = date ? date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
  const entry = document.createElement('div');
  entry.className = 'activity-entry';
  entry.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04);animation:fadeIn 0.3s ease;';
  entry.innerHTML = `
    <div style="font-size:1.2rem;flex-shrink:0;margin-top:1px;">${icon}</div>
    <div style="flex:1;">
      <div style="font-size:0.85rem;color:${color||'#a09080'};line-height:1.5;">${message}</div>
      <div style="font-family:var(--font-mono);font-size:0.55rem;color:#444;margin-top:3px;">${time}</div>
    </div>`;
  feedEl.append(entry);

  // Keep max 50 entries in DOM
  const all = feedEl.querySelectorAll('.activity-entry');
  if (all.length > 50) all[all.length - 1].remove();
}

// Global function to log an activity event to Firestore and update the UI feed
async function logActivity(icon, message, color = '#a09080') {
  try {
    if (!_uid) return;
    const event = {
      icon,
      message,
      color,
      timestamp: serverTimestamp(),
    };
    // Add to Firestore
    await addDoc(collection(db, 'activity', _uid, 'events'), event);
    // Optionally, push to UI immediately (optimistic update)
    _pushActivityUI(icon, message, color, new Date());
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
}

// Load last 30 events from Firestore and set up live listener
let _activityUnsub = null;
function renderActivityFeed() {
  if (!_uid) return;
  const feedEl = document.getElementById('activity-feed-list');
  if (!feedEl) return;

  feedEl.innerHTML = '<div class="activity-placeholder" style="color:#444;font-size:12px;font-style:italic;padding:8px;">Loading…</div>';

  if (_activityUnsub) { _activityUnsub(); _activityUnsub = null; }

  // Cleanup is now handled server-side by a scheduled Cloud Function.

  const q = query(
    collection(db, 'activity', _uid, 'events'),
    orderBy('timestamp', 'desc'),
    limit(50)
  );

  _activityUnsub = onSnapshot(q, snap => {
    feedEl.innerHTML = '';
    if (snap.empty) {
      feedEl.innerHTML = '<div class="activity-placeholder" style="color:#444;font-size:12px;font-style:italic;padding:8px;">No activity yet. Start exploring!</div>';
      return;
    }
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    snap.docs.forEach(d => {
      const ev = d.data();
      const ts = ev.timestamp?.toDate?.() || new Date();
      if (now - ts.getTime() <= sevenDays) {
        _pushActivityUI(ev.icon, ev.message, ev.color, ts);
      }
    });
  });
}

// ── Random world events ──────────────────────────────────────────
// These fire probabilistically during key actions.

const _RANDOM_EVENTS = {
  exploring: [
    { weight:20, fn: async () => {
        const pct = Math.floor(Math.random()*11)+5; // 5-15%
        const lost = Math.floor((_charData.gold||0) * pct/100);
        if (lost > 0) {
          await updateDoc(doc(db,'characters',_uid), { gold: increment(-lost) }); // FIXED: use increment
          _charData.gold = Math.max(0, (_charData.gold||0) - lost);
          set('stat-gold', _charData.gold); set('s-gold', _charData.gold);
          window.showToast(`You've been robbed! Lost ${lost} coins.`, 'error');
          logActivity('💰', `<b>You've Been Robbed!</b> A shadow slipped past you and made off with <b>${lost} coins</b>.`, '#e05555');
        }
      }
    },
    { weight:20, fn: async () => {
        const gifts = ['Minor HP Potion','Minor Mana Potion','Minor Luck Potion'];
        const goldAmt  = Math.floor(Math.random()*31)+10; // 10-40
        const giftItem  = gifts[Math.floor(Math.random()*gifts.length)];
        await _invWrite(_uid, inv => {
          const ex = inv.find(i=>i.name===giftItem);
          if (ex) ex.qty++; else inv.push({name:giftItem,qty:1,type:getItemType(giftItem)});
        }, { gold: increment(goldAmt) });
        window._allInvItems = _charData.inventory; window._refreshInvDisplay();
        window.showToast(`A Kind Stranger gifted you ${goldAmt} coins and a ${giftItem}!`, 'success');
        logActivity('🤝', `<b>A Kind Stranger</b> crossed your path and left you <b>${goldAmt} coins</b> and a <b>${giftItem}</b>.`, '#70c090');
      }
    },
    { weight:15, fn: async () => {
        const gold = Math.floor(Math.random()*81)+20; // 20-100
        await updateDoc(doc(db,'characters',_uid), { gold: increment(gold) });
        _charData.gold = (_charData.gold||0)+gold;
        set('stat-gold',_charData.gold); set('s-gold',_charData.gold);
        window.showToast(`Hidden Loot! Found ${gold} coins!`, 'success');
        logActivity('📦', `<b>Hidden Loot!</b> You stumbled upon a concealed stash containing <b>${gold} coins</b>.`, '#c9a84c');
      }
    },
    { weight:10, fn: async () => {
        window.showToast('You encountered a Lost Traveler. Your bond with a local NPC grows.', 'info');
        logActivity('🧭', `<b>Lost Traveler</b> — You helped a wandering stranger find their way. Your reputation in the region improves.`, '#5b9fe0');
      }
    },
    { weight:35, fn: null }, // nothing — most common outcome
  ],

  gather: {
    Miner:    { weight:25, fn: async (resources, rarity) => {
        const bonus = Math.floor(Math.random()*2)+1;
        const pool  = ['Iron','Copper','Silver','Obsidian','Coal'];
        const item  = pool[Math.floor(Math.random()*pool.length)];
        await _invWrite(_uid, inv => {
          const ex = inv.find(i=>i.name===item);
          if (ex) ex.qty+=bonus; else inv.push({name:item,qty:bonus,type:'material'});
        });
        window._allInvItems=_charData.inventory; window._refreshInvDisplay();
        window.showToast(`Rich Vein Found! +${bonus} ${item}`, 'success');
        logActivity('⛏️', `<b>Rich Vein Found!</b> Your pick struck an exposed vein — bonus <b>x${bonus} ${item}</b> extracted.`, '#c9a84c');
      }
    },
    Angler:   { weight:25, fn: async () => {
        const fish  = ['Trout','Carp','Goldfish','Silverfin'];
        const item  = fish[Math.floor(Math.random()*fish.length)];
        await _invWrite(_uid, inv => {
          const ex = inv.find(i=>i.name===item);
          if (ex) ex.qty+=2; else inv.push({name:item,qty:2,type:'material'});
        });
        window._allInvItems=_charData.inventory; window._refreshInvDisplay();
        window.showToast(`Golden Catch! Reeled in a rare ${item}!`, 'success');
        logActivity('🎣', `<b>Golden Catch!</b> Your line pulled taut — a rare <b>${item}</b> surfaced from the deep.`, '#e8d070');
      }
    },
    Forager:  { weight:25, fn: async () => {
        const items = ['Apple','Blueberry','Moon Grape','Silverleaf'];
        const item  = items[Math.floor(Math.random()*items.length)];
        await _invWrite(_uid, inv => {
          const ex = inv.find(i=>i.name===item);
          if (ex) ex.qty+=3; else inv.push({name:item,qty:3,type:'material'});
        });
        window._allInvItems=_charData.inventory; window._refreshInvDisplay();
        window.showToast(`Bloom Surge! Triple ${item} found!`, 'success');
        logActivity('🌸', `<b>Bloom Surge!</b> The area burst with growth — you collected triple <b>${item}</b>.`, '#70c090');
      }
    },
    Herbalist:{ weight:25, fn: async () => {
        const items = ['Mint Leaves','Wild Herbs','Silverleaf','Glow Moss'];
        const item  = items[Math.floor(Math.random()*items.length)];
        await _invWrite(_uid, inv => {
          const ex = inv.find(i=>i.name===item);
          if (ex) ex.qty+=2; else inv.push({name:item,qty:2,type:'material'});
        });
        window._allInvItems=_charData.inventory; window._refreshInvDisplay();
        window.showToast(`Rare Herb Patch! Bonus ${item} gathered.`, 'success');
        logActivity('🌿', `<b>Rare Patch!</b> You spotted a hidden cluster — bonus <b>x2 ${item}</b> gathered.`, '#70c090');
      }
    },
    Hunter:   { weight:25, fn: async () => {
        logActivity('🐾', `<b>Alpha Beast Appeared!</b> A powerful creature emerged — fight it in the Battle panel for enhanced rewards.`, '#e05555');
      }
    },
  },
};

function _rollExploringEvent() {
  const events = _RANDOM_EVENTS.exploring.map((ev, i) => {
    // Alistor blessing: reduce robbery (index 0) weight by faith %
    if (i === 0 && _charData?.deity === 'Alistor') {
      const reduction = _getFaithBlessingPct(_charData); // e.g. 0.06 at tier 2
      return { ...ev, weight: Math.max(1, Math.round(ev.weight * (1 - reduction))) };
    }
    // Arion blessing: balance — reduce bad (robbery) AND boost good events equally
    if (i === 0 && _charData?.deity === 'Arion') {
      const bal = _getFaithBlessingPct(_charData) * 0.5;
      return { ...ev, weight: Math.max(1, Math.round(ev.weight * (1 - bal))) };
    }
    if ((i === 1 || i === 2) && _charData?.deity === 'Arion') {
      const bal = _getFaithBlessingPct(_charData) * 0.5;
      return { ...ev, weight: Math.round(ev.weight * (1 + bal)) };
    }
    // Mah'run blessing: boost rare events (Hidden Loot index 2, Lost Traveler index 3)
    if ((i === 2 || i === 3) && _charData?.deity === "Mah'run") {
      const boost = _getFaithBlessingPct(_charData);
      return { ...ev, weight: Math.round(ev.weight * (1 + boost)) };
    }
    // Freyja blessing: boost Kind Stranger event (index 1 — NPC gifts)
    if (i === 1 && _charData?.deity === 'Freyja') {
      const boost = _getFaithBlessingPct(_charData);
      return { ...ev, weight: Math.round(ev.weight * (1 + boost)) };
    }
    return ev;
  });
  const total = events.reduce((s,e)=>s+e.weight, 0);
  let roll    = Math.random() * total;
  for (const ev of events) {
    roll -= ev.weight;
    if (roll <= 0) { ev.fn?.(); return; }
  }
}

function _rollGatherEvent(profession) {
  const ev = _RANDOM_EVENTS.gather[profession];
  if (ev && typeof ev.fn === 'function') {
    ev.fn();
  }
}

// Expose logActivity for use from battle handler
window._logActivity = logActivity;
window._activityRollExplore = _rollExploringEvent;

// ═══════════════════════════════════════════════════
//  MENTION SYSTEM — nav badge + in-chat highlights + jump button
// ═══════════════════════════════════════════════════
// LOGIC:
//  • Nav badge shows unread mention count from Firestore while player is OUTSIDE chat.
//  • Opening chat does NOT instantly clear the badge.
//  • An IntersectionObserver watches each tagged message; when it scrolls into view,
//    its inline "@" badge is removed, the local nav count decrements, and once all
//    pending mentions are viewed the Firestore count is zeroed.
//  • New mentions that arrive while the chat is open are observed immediately.

// ── Internal state ──────────────────────────────────────────────────────────
let _mentionUnsub          = null;   // Firestore real-time listener unsub
let _mentionViewObserver   = null;   // IntersectionObserver for view-tracking
let _pendingMentionCount   = 0;      // local mirror of unseen mention count
let _mentionInChatOpen     = false;  // is the RP Chat panel currently open?

// ── 1. NAV BADGE HELPERS ─────────────────────────────────────────────────────
function _setNavBadge(count) {
  const badge = document.getElementById('nav-mention-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// Write count=0 to Firestore once all mentions have been seen
async function _clearMentionCountFirestore() {
  if (!_uid) return;
  try {
    await setDoc(doc(db, 'mentions', _uid), { count: 0, lastUpdated: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.warn('[Mentions] Failed to clear count:', e);
  }
}

// Called when a single mention message is scrolled into view
function _onMentionViewed(msgEl) {
  if (msgEl.dataset.mentionSeen === '1') return;
  msgEl.dataset.mentionSeen = '1';

  // Persist this message as seen so it stays dismissed after leaving/re-entering chat
  const msgId = msgEl.dataset.id;
  if (msgId && _uid) {
    try {
      const key = `_seenMentions_${_uid}`;
      const seen = JSON.parse(localStorage.getItem(key) || '{}');
      seen[msgId] = 1;
      // Trim to last 300 entries to avoid unbounded growth
      const keys = Object.keys(seen);
      if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete seen[k]);
      localStorage.setItem(key, JSON.stringify(seen));
    } catch (_e) {}
  }

  // Remove the inline "@" badge from this message
  msgEl.querySelectorAll('.mention-inline-badge').forEach(b => {
    b.style.transition = 'opacity 0.3s';
    b.style.opacity = '0';
    setTimeout(() => b.remove(), 320);
  });

  // Decrement local pending count and update nav badge
  _pendingMentionCount = Math.max(0, _pendingMentionCount - 1);
  _setNavBadge(_pendingMentionCount);

  // If all cleared, write 0 to Firestore
  if (_pendingMentionCount === 0) {
    _clearMentionCountFirestore();
  }
}

// ── 2. REAL-TIME BADGE LISTENER ───────────────────────────────────────────────
// While chat is CLOSED this drives the nav badge directly from Firestore.
// While chat is OPEN the local _pendingMentionCount drives the badge instead.
function _listenMentionBadge() {
  if (!_uid) return;
  if (_mentionUnsub) _mentionUnsub();
  _mentionUnsub = onSnapshot(doc(db, 'mentions', _uid), (snap) => {
    const count = snap.exists() ? (snap.data()?.count || 0) : 0;
    if (!_mentionInChatOpen) {
      // Chat closed — drive badge from Firestore directly
      _pendingMentionCount = count;
      _setNavBadge(count);
    } else {
      // Chat open — only sync upward (new mentions arriving while chat is open)
      if (count > _pendingMentionCount) {
        _pendingMentionCount = count;
        _setNavBadge(count);
      }
    }
  });
}

// ── 3. IN-CHAT HIGHLIGHT — marks messages that @mention the current player ───
function _applyMentionHighlights() {
  if (!_uid || !_charData?.name) return;
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const myName = (_charData.name || '').toLowerCase();

  // Load persisted seen message IDs for this user
  let seenIds = {};
  try {
    seenIds = JSON.parse(localStorage.getItem(`_seenMentions_${_uid}`) || '{}');
  } catch (_e) {}

  container.querySelectorAll('.chat-msg:not([data-mention-checked])').forEach(el => {
    el.setAttribute('data-mention-checked', '1');

    // If this message was already seen in a previous session, mark it and skip
    const msgId = el.dataset.id;
    if (msgId && seenIds[msgId]) {
      el.dataset.mentionSeen = '1';
      return;
    }

    const textEl = el.querySelector('.chat-msg-text');
    if (!textEl) return;
    if (!new RegExp(`@${myName}`, 'i').test(textEl.textContent || '')) return;
    if (el.classList.contains('own')) return; // skip own messages

    el.classList.add('is-mentioned');
    el.dataset.mentionEl = '1';

    // Add inline "@" badge next to the mention span
    textEl.querySelectorAll('.chat-mention').forEach(span => {
      if (span.textContent.replace('@', '').trim().toLowerCase() === myName) {
        const alreadyHasBadge = span.nextSibling && span.nextSibling.classList?.contains('mention-inline-badge');
        if (!alreadyHasBadge) {
          const b = document.createElement('span');
          b.className = 'mention-inline-badge';
          b.textContent = '@';
          span.insertAdjacentElement('afterend', b);
        }
      }
    });

    // Observe this element so we know when it comes into view
    _mentionViewObserver?.observe(el);
  });

  _updateMentionJumpBtn(container);
}

// ── 4. INTERSECTION OBSERVER — dismisses badge when message enters viewport ──
function _setupMentionViewObserver() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  if (_mentionViewObserver) _mentionViewObserver.disconnect();

  _mentionViewObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        _onMentionViewed(entry.target);
        _mentionViewObserver.unobserve(entry.target); // stop watching once seen
        _updateMentionJumpBtn(container);
      }
    });
  }, {
    root: container,
    threshold: 0.5  // 50% of the message must be visible
  });

  // Attach to all already-marked mention messages
  container.querySelectorAll('[data-mention-el="1"]:not([data-mention-seen="1"])').forEach(el => {
    _mentionViewObserver.observe(el);
  });
}

// ── 5. JUMP BUTTON — shows count of unread mentions above scroll pos ─────────
function _updateMentionJumpBtn(container) {
  const btn    = document.getElementById('mention-jump-btn');
  const cntEl  = document.getElementById('mention-jump-badge');
  if (!btn || !container) return;

  // Only count unseen mentions above the current scroll
  const allMentions = Array.from(
    container.querySelectorAll('[data-mention-el="1"]:not([data-mention-seen="1"])')
  );
  if (allMentions.length === 0) { btn.style.display = 'none'; return; }

  const containerRect = container.getBoundingClientRect();
  const above = allMentions.filter(el => {
    const r = el.getBoundingClientRect();
    return r.bottom < containerRect.top + 40;
  });

  if (above.length > 0) {
    btn.style.display = 'flex';
    cntEl.textContent = above.length;
    cntEl.style.display = 'flex';
  } else {
    btn.style.display = 'none';
  }
}

function _setupMentionJumpBtn() {
  const btn = document.getElementById('mention-jump-btn');
  const container = document.getElementById('chat-messages');
  if (!btn || !container) return;

  container.addEventListener('scroll', () => _updateMentionJumpBtn(container), { passive: true });

  btn.onclick = function() {
    const allMentions = Array.from(
      container.querySelectorAll('[data-mention-el="1"]:not([data-mention-seen="1"])')
    );
    const containerRect = container.getBoundingClientRect();
    const above = allMentions.filter(el => {
      const r = el.getBoundingClientRect();
      return r.bottom < containerRect.top + 40;
    });
    if (above.length === 0) { btn.style.display = 'none'; return; }
    const target = above[above.length - 1];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.style.transition = 'background 0.3s';
    target.style.background = 'rgba(37,211,102,0.18)';
    setTimeout(() => { target.style.background = ''; }, 1200);
  };
}

// ── 6. MAIN ENTRY — called when RP Chat panel opens ──────────────────────────
window._observeChatMentions = function() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  _mentionInChatOpen = true;

  _applyMentionHighlights();

  // Recalculate true unseen count now that localStorage-seen messages are marked.
  // This corrects a stale Firestore count from a previous session where the player
  // left before all mentions were scrolled into view.
  const trulyUnseen = container.querySelectorAll(
    '[data-mention-el="1"]:not([data-mention-seen="1"])'
  ).length;
  _pendingMentionCount = trulyUnseen;
  _setNavBadge(trulyUnseen);
  if (trulyUnseen === 0) _clearMentionCountFirestore();

  _setupMentionViewObserver();
  _setupMentionJumpBtn();

  // MutationObserver: re-apply highlights as new messages arrive
  if (window._mentionHighlightObserver) window._mentionHighlightObserver.disconnect();
  window._mentionHighlightObserver = new MutationObserver(() => {
    _applyMentionHighlights();
    // Re-attach IntersectionObserver to any newly-added mention elements
    container.querySelectorAll('[data-mention-el="1"]:not([data-mention-seen="1"])').forEach(el => {
      _mentionViewObserver?.observe(el);
    });
  });
  window._mentionHighlightObserver.observe(container, { childList: true });
};

// Called when the player leaves the RP Chat panel
window._onLeaveChatPanel = function() {
  _mentionInChatOpen = false;
  if (_mentionViewObserver) { _mentionViewObserver.disconnect(); _mentionViewObserver = null; }
  if (window._mentionHighlightObserver) { window._mentionHighlightObserver.disconnect(); }
};

// ── 7. HOOK INTO initChat (first load) ───────────────────────────────────────
const _origChatInit = window._chatInit;
window._chatInit = async function() {
  await _origChatInit?.();
  setTimeout(window._observeChatMentions, 400);
  // NOTE: do NOT call _clearMentionCount here — badge clears per-view now
};

// ── 8. BOOT — start badge listener once auth resolves ────────────────────────
(function() {
  if (typeof _uid !== 'undefined' && _uid) { _listenMentionBadge(); return; }
  let tries = 0;
  const poll = setInterval(() => {
    if (typeof _uid !== 'undefined' && _uid) { clearInterval(poll); _listenMentionBadge(); }
    if (++tries > 60) clearInterval(poll);
  }, 500);
})();
// ═══════════════════════════════════════════════════
//  STANCE INTERCEPTORS — installed after all real battle functions are defined
// ═══════════════════════════════════════════════════
(function _installStanceInterceptors() {

  // 1. Manual FIGHT button (zone select) → goes straight to encounter popup.
  //    Stance is chosen inline inside the encounter popup — no modal needed here.
  // (no wrap needed for _startBattle non-auto)

  // 2. AUTO-BATTLE button → show stance modal, then launch loop
  const _origStartAutoBattle = window._startAutoBattle;
  window._startAutoBattle = async function(grade, zoneName) {
    window._showStanceModal('auto', () => {
      _origStartAutoBattle?.(grade, zoneName);
    });
  };

  // 3. Boss Raid FIGHT → show stance modal, then start raid
  const _origStartBossRaid = window.startBossRaid;
  window.startBossRaid = function(party, bossTemplate) {
    window._showStanceModal('boss', () => {
      _origStartBossRaid?.(party, bossTemplate);
    });
  };

})();

// ── Encounter popup inline stance picker helpers ──────────────────────────────
window._encounterShowStance = function() {
  const stances = window._getStances ? window._getStances() : [];
  // Pre-select active stance or first available
  let sel = window._activeStanceIdx;
  if (sel === null || sel === undefined) {
    const fi = stances.findIndex(s => s?.name);
    sel = fi >= 0 ? fi : null;
  }
  window._encounterStanceSel = sel;

  const listEl = document.getElementById('encounter-stance-list');
  if (listEl) {
    const hasAny = stances.some(s => s?.name);
    if (!hasAny) {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem;font-style:italic;padding:8px 0">No stances set up yet.<br><a href="#" onclick="window._closeEncounterPopup();switchPanel(\"skills\")" style="color:var(--gold)">Go set up stances →</a></div>';
    } else {
      listEl.innerHTML = stances.map((s, i) => {
        if (!s?.name) return '';
        const isActive = sel === i;
        const chips = (s.skills || []).map(sk =>
          `<span style="background:rgba(255,255,255,0.07);border-radius:4px;padding:2px 7px;font-size:0.68rem;color:var(--ash-light)">${sk}</span>`
        ).join(' ');
        return `<div onclick="window._encounterSelectStance(${i})" id="enc-stance-card-${i}"
          style="cursor:pointer;padding:10px 12px;border-radius:10px;border:1.5px solid ${isActive ? 'var(--gold)' : 'var(--border)'};
          background:${isActive ? 'rgba(201,168,76,0.10)' : 'rgba(255,255,255,0.03)'};text-align:left;transition:border 0.15s">
          <div style="font-size:0.82rem;font-weight:700;color:${isActive ? 'var(--gold)' : 'var(--text)'};margin-bottom:4px">${s.name}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">${chips || '<span style="color:var(--text-dim);font-size:0.68rem;font-style:italic">No skills</span>'}</div>
        </div>`;
      }).join('');
    }
  }

  const enterBtn = document.getElementById('encounter-enter-battle-btn');
  if (enterBtn) enterBtn.disabled = (sel === null);

  document.getElementById('encounter-action-btns').style.display = 'none';
  document.getElementById('encounter-stance-picker').style.display = 'block';
};

window._encounterSelectStance = function(idx) {
  window._encounterStanceSel = idx;
  // Update card highlights
  document.querySelectorAll('[id^="enc-stance-card-"]').forEach((el, i) => {
    el.style.border = i === idx ? '1.5px solid var(--gold)' : '1.5px solid var(--border)';
    el.style.background = i === idx ? 'rgba(201,168,76,0.10)' : 'rgba(255,255,255,0.03)';
    const nameEl = el.querySelector('div');
    if (nameEl) nameEl.style.color = i === idx ? 'var(--gold)' : 'var(--text)';
  });
  const enterBtn = document.getElementById('encounter-enter-battle-btn');
  if (enterBtn) enterBtn.disabled = false;
};

window._encounterBackToFight = function() {
  document.getElementById('encounter-stance-picker').style.display = 'none';
  document.getElementById('encounter-action-btns').style.display = 'flex';
};

window._encounterConfirmFight = async function() {
  const idx = window._encounterStanceSel;
  if (idx === null || idx === undefined) return;
  window._activeStanceIdx = idx;
  window.renderStancesGrid?.();
  window.renderBattleStancePicker?.();
  // Hide stance picker, show loading, then start fight
  document.getElementById('encounter-stance-picker').style.display = 'none';
  await window._confirmFight?.();
};

// ═══════════════════════════════════════════════════
//  VIEW PLAYER PROFILE
// ═══════════════════════════════════════════════════
const _PROFILE_CLASS_ICONS = { Warrior:'⚔️', Guardian:'🛡️', Arcanist:'🔮', Hunter:'🏹', Assassin:'🗡️', Cleric:'✨', Summoner:'🌀' };
const _PROFILE_ACH_META = {
  'first-death':      { icon:'🪦', label:'First Blood',      desc:'First player to fall in battle'        },
  'first-monster-kill':{ icon:'⚔️', label:'Monster Slayer',  desc:'First to slay a high-class monster'    },
  'first-ascension':  { icon:'⬆️', label:'First Ascension',  desc:'First player to rank up'               },
  'first-level5':     { icon:'🌟', label:'Early Riser',       desc:'First player to reach Level 5'         },
};

window.viewPlayerProfile = async function(uid) {
  const modal   = document.getElementById('player-profile-modal');
  const loading = document.getElementById('pprofile-loading');
  if (!modal) return;

  // Reset and show modal immediately
  document.getElementById('pprofile-name').textContent    = '—';
  document.getElementById('pprofile-rank').textContent    = '';
  document.getElementById('pprofile-rank-val').textContent= '—';
  document.getElementById('pprofile-level').textContent   = '—';
  document.getElementById('pprofile-faction').textContent = '—';
  document.getElementById('pprofile-bio').textContent     = '';
  document.getElementById('pprofile-race-tag').textContent= '';
  document.getElementById('pprofile-class-tag').textContent= '';
  document.getElementById('pprofile-avatar').innerHTML    = '';
  document.getElementById('pprofile-banner').style.backgroundImage = '';
  document.getElementById('pprofile-achievements').style.display = 'none';
  if (loading) loading.style.display = 'block';
  modal.style.display = 'flex';

  try {
    const snap = await getDoc(doc(db, 'characters', uid));
    if (!snap.exists()) {
      document.getElementById('pprofile-name').textContent = 'Character not found.';
      if (loading) loading.style.display = 'none';
      return;
    }
    const c = snap.data();
    const classIcon = _PROFILE_CLASS_ICONS[c.charClass] || '⚔️';

    // Avatar
    const avatarEl = document.getElementById('pprofile-avatar');
    if (c.avatarUrl && c.avatarUrl.startsWith('http')) {
      avatarEl.innerHTML = `<img src="${c.avatarUrl}" alt="${c.name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
      avatarEl.textContent = classIcon;
    }

    // Banner — reuse avatar as blurred bg if available
    const bannerEl = document.getElementById('pprofile-banner');
    if (c.avatarUrl && c.avatarUrl.startsWith('http')) {
      bannerEl.style.backgroundImage = `url('${c.avatarUrl}')`;
    } else {
      bannerEl.style.backgroundImage = '';
    }

    // Core fields
    document.getElementById('pprofile-name').textContent     = c.name || '—';
    document.getElementById('pprofile-rank').textContent     = c.rank || 'Wanderer';
    document.getElementById('pprofile-rank-val').textContent = c.rank || 'Wanderer';
    document.getElementById('pprofile-level').textContent    = `${_displayLevel(c.level || 1)}`;
    document.getElementById('pprofile-faction').textContent  = c.faction || 'None';
    document.getElementById('pprofile-bio').textContent      = c.bio || 'No history written yet.';
    document.getElementById('pprofile-race-tag').textContent = c.race ? `🧬 ${c.race}` : '';
    document.getElementById('pprofile-class-tag').textContent= c.charClass ? `${classIcon} ${c.charClass}` : '';

    // Achievements
    const achs = Array.isArray(c.achievements) ? c.achievements : [];
    const achSection = document.getElementById('pprofile-achievements');
    const achList    = document.getElementById('pprofile-ach-list');
    if (achs.length > 0) {
      achList.innerHTML = achs.map(id => {
        const m = _PROFILE_ACH_META[id];
        if (!m) return '';
        return `<div class="pprofile-ach-badge" title="${m.desc}"><span class="pprofile-ach-icon">${m.icon}</span><span class="pprofile-ach-name">${m.label}</span></div>`;
      }).filter(Boolean).join('');
      if (achList.innerHTML.trim()) achSection.style.display = 'block';
    }

    if (loading) loading.style.display = 'none';
  } catch (err) {
    console.error('[Profile] Failed to load:', err);
    document.getElementById('pprofile-name').textContent = 'Failed to load profile.';
    if (loading) loading.style.display = 'none';
  }
};
// ═══════════════════════════════════════════════════
//  INVENTORY GRADE MIGRATION
//  window.patchAllInventoryGrades()
//
//  One-time admin utility. Scans every document in the 'characters'
//  collection and backfills the `grade` field on any equipment item
//  that is missing it (deity bestowals, quest rewards, old drops, etc.)
//
//  Also backfills `type:'equipment'` if that is missing on known gear.
//
//  Safe to re-run — items that already have a grade are skipped.
//
//  Call from the browser console (admin account only):
//    await window.patchAllInventoryGrades()
//
//  Returns a summary: { checked, patched, itemsFixed, errors }
// ═══════════════════════════════════════════════════
window.patchAllInventoryGrades = async function() {
  console.log('[GradePatch] Starting inventory grade migration…');
  const summary = { checked: 0, patched: 0, itemsFixed: 0, errors: 0 };

  let allDocs;
  try {
    const snap = await getDocs(collection(db, 'characters'));
    allDocs = snap.docs;
  } catch (e) {
    console.error('[GradePatch] Could not fetch characters collection:', e);
    return summary;
  }

  for (const charDoc of allDocs) {
    summary.checked++;
    const data = charDoc.data();
    const inv  = Array.isArray(data.inventory) ? data.inventory.map(i => ({ ...i })) : [];
    let changed = false;

    for (const item of inv) {
      const baseName = (item.name || '').replace(/\s*\+\d+$/, '');
      if (!baseName) continue;

      // Only process equipment items (or items that look like equipment)
      const looksLikeEquip =
        item.type === 'equipment' ||
        item.type === 'weapon'    ||
        item.type === 'armor'     ||
        ALL_WEAPON_NAMES.includes(baseName) ||
        ALL_ARMOR_NAMES.includes(baseName);

      if (!looksLikeEquip) continue;

      // Fix type if it's wrong
      if (item.type !== 'equipment') {
        item.type = 'equipment';
        changed = true;
        summary.itemsFixed++;
      }

      // Backfill missing grade
      if (!item.grade) {
        const resolved = window._resolveEquipGrade(baseName);
        if (resolved) {
          item.grade = resolved;
          changed = true;
          summary.itemsFixed++;
          console.log(`[GradePatch] ${charDoc.id} — ${item.name}: grade set to ${resolved}`);
        }
      }
    }

    if (changed) {
      try {
        await updateDoc(doc(db, 'characters', charDoc.id), { inventory: inv });
        summary.patched++;
        console.log(`[GradePatch] ✅ Patched ${charDoc.id} (${data.name || 'unnamed'})`);
      } catch (e) {
        summary.errors++;
        console.error(`[GradePatch] ❌ Failed to update ${charDoc.id}:`, e);
      }
    }
  }

  console.log('[GradePatch] Migration complete:', summary);
  window.showToast?.(`✅ Grade patch done — ${summary.patched} accounts updated, ${summary.itemsFixed} items fixed`, 'success');
  return summary;
};