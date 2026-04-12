// ═══════════════════════════════════════════════════
//  CHAT DUEL SYSTEM — duel.js  (rewritten)
//  Duels happen live in chat. Everyone watches.
// ═══════════════════════════════════════════════════

import { db, auth } from "../firebase/firebase.js";
import {
  doc, getDoc, getDocFromServer, updateDoc, addDoc, collection,
  query, where, onSnapshot, serverTimestamp, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Module state ───────────────────────────────────
let _uid            = null;
let _charData       = null;
let _chatTab        = null;
let _chatLocationId = null;

// Active onSnapshot unsubs keyed by duelId
const _duelUnsubs = {};

// ── Always-fresh uid/charData resolvers ───────────
function _getUid() {
  return _uid || auth?.currentUser?.uid || window._uid || null;
}
function _getCharData() {
  return _charData || window._charData || null;
}

// ── Stances ────────────────────────────────────────
// Each stance modifies how a player's turn resolves.
// Active stance is stored on the duel doc per-participant.
function _getActiveStance(charData) {
  const idx = window._activeStanceIdx || 0;
  return charData.stances?.[idx] || null;
}

// ── Skill resolution ───────────────────────────────
function _findSkillDef(charClass, skillName) {
  const tree = window.SKILL_TREES?.[charClass];
  if (!tree) return null;
  for (const tier of ['basic', 'intermediate', 'advanced']) {
    const skill = tree[tier]?.find(s => s.name === skillName);
    if (skill) {
      const manaMatch = skill.desc.match(/(\d+)\s*Mana/);
      const manaCost = manaMatch ? parseInt(manaMatch[1]) : 0;
      return { ...skill, manaCost };
    }
  }
  return null;
}

// ── Init ───────────────────────────────────────────
export function initDuelSystem(uid, charData) {
  _uid      = uid;
  _charData = charData;
  _listenForIncomingChallenges();
}

export function updateDuelCharData(charData) {
  _charData = charData;
}

// ── Public: update routing context ────────────────
export function updateDuelContext(tab, locationId) {
  _chatTab        = tab        || 'rp';
  _chatLocationId = locationId || '';
}

// ── Public: read current routing context ──────────
export function getDuelContext() {
  return { tab: _chatTab || 'rp', locationId: _chatLocationId || '' };
}

// ── Initiate a duel ────────────────────────────────
export async function initiateChatDuel(targetUid, targetName, chatTab, chatLocationId) {
  const uid = _getUid();
  const charData = _getCharData();
  if (!uid || !charData) throw new Error('Not logged in.');
  _uid = uid; _charData = charData;

  const me = _buildCombatant(charData, uid);
  const stance = _getActiveStance(charData);

  let targetData = _buildFallbackCombatant(targetUid, targetName);
  try {
    const snap = await getDoc(doc(db, 'characters', targetUid));
    if (snap.exists()) targetData = _buildCombatant(snap.data(), targetUid);
  } catch (e) { console.warn('[Duel] Could not fetch target data:', e); }

  const tab   = chatTab        || _chatTab        || 'rp';
  const locId = chatLocationId || _chatLocationId || '';

  if (!locId && tab !== 'general') {
    throw new Error('Cannot start duel — chat location unknown. Open the chat first.');
  }

  const duelRef = await addDoc(collection(db, 'chatDuels'), {
    challengerId:        uid,
    challengerName:      me.name,
    challengerData:      me,
    challengerHp:        me.hp,
    challengerMana:      me.mana,
    challengerStance:    stance?.name || 'No Stance',
    challengerSkills:    stance?.skills || [],
    targetId:            targetUid,
    targetName,
    targetData,
    targetHp:            targetData.hp,
    targetMana:          targetData.mana,
    targetStance:        'No Stance',
    targetSkills:        [],
    participants:        [uid, targetUid],
    chatTab:             tab,
    chatLocationId:      locId,
    currentTurnUid:      uid,
    round:               1,
    status:              'pending',
    log:                 [],
    createdAt:           serverTimestamp(),
  });

  const snapshot = {
    challengerId:       uid,
    challengerName:     me.name,
    challengerData:     me,
    challengerHp:       me.hp,
    challengerMana:     me.mana,
    challengerMaxHp:    me.maxHp,
    challengerMaxMana:  me.maxMana,
    challengerStance:   stance?.name || 'No Stance',
    challengerRank:     me.rank,
    challengerLevel:    me.level,
    challengerAvatar:   me.avatarUrl,
    targetId:           targetUid,
    targetName,
    targetData,
    targetHp:           targetData.hp,
    targetMana:         targetData.mana,
    targetMaxHp:        targetData.maxHp,
    targetMaxMana:      targetData.maxMana,
    targetStance:       'No Stance',
    targetRank:         targetData.rank,
    targetLevel:        targetData.level,
    targetAvatar:       targetData.avatarUrl,
    status:             'pending',
    round:              1,
    currentTurnUid:     uid,
    chatTab:            tab,
    chatLocationId:     locId,
  };

  const cardRef = await _postDuelCard(duelRef.id, tab, locId, me.name, targetName, snapshot);
  if (cardRef) {
    await updateDoc(duelRef, { messageId: cardRef.id });
  }

  try {
    await addDoc(collection(db, 'notifications'), {
      uid:       targetUid,
      type:      'duel-challenge',
      title:     '⚔️ Duel Challenge!',
      message:   `${me.name} challenges you to a duel in chat!`,
      duelId:    duelRef.id,
      read:      false,
      createdAt: serverTimestamp(),
      fromUid:   uid,
      fromName:  me.name,
    });
  } catch (e) { console.warn('[Duel] Notification failed:', e); }

  window.showToast?.(`⚔️ Challenge sent to ${targetName}! Check the chat.`, '');
}

// ── Accept ─────────────────────────────────────────
export async function acceptDuelChallenge(duelId) {
  const uid = _getUid();
  const charData = _getCharData();
  if (!uid || !charData) { window.showToast?.('Not logged in — cannot accept duel.', 'error'); return; }
  _uid = uid; _charData = charData;

  const duelRef = doc(db, 'chatDuels', duelId);
  const snap    = await getDoc(duelRef);
  if (!snap.exists()) { window.showToast?.('Duel not found.', 'error'); return; }
  const duel = snap.data();

  if (duel.targetId !== uid)     { window.showToast?.('This duel is not for you.', 'error'); return; }
  if (duel.status !== 'pending') { window.showToast?.('Duel already handled.', 'error');     return; }

  const me    = _buildCombatant(charData, uid);
  const myStance = _getActiveStance(charData);
  const tab   = duel.chatTab        || _chatTab        || 'rp';
  const locId = duel.chatLocationId || _chatLocationId || '';

  const newSnapshot = {
    ...duel,
    chatTab:        tab,
    chatLocationId: locId,
    status:         'active',
    targetData:     me,
    targetHp:       me.hp,
    targetMana:     me.mana,
    targetMaxHp:    me.maxHp,
    targetMaxMana:  me.maxMana,
    targetStance:   myStance?.name || 'No Stance',
    targetSkills:   myStance?.skills || [],
    targetRank:     me.rank,
    targetLevel:    me.level,
    targetAvatar:   me.avatarUrl,
    round:          1,
    currentTurnUid: duel.challengerId,
    log:            [],
  };

  await updateDoc(duelRef, {
    status:         'active',
    targetData:     me,
    targetHp:       me.hp,
    targetMana:     me.mana,
    targetStance:   myStance?.name || 'No Stance',
    targetSkills:   myStance?.skills || [],
    chatTab:        tab,
    chatLocationId: locId,
    acceptedAt:     serverTimestamp(),
    log:            [],
  });

  // Update the initial pending card to show it's now active
  const writes = [];
  if (duel.messageId) {
    writes.push(_patchDuelCard(duel.messageId, tab, locId, newSnapshot,
      `⚔️ ${duel.challengerName} VS ${me.name} — THE DUEL HAS BEGUN!`));
  } else {
    writes.push(_postDuelCard(duelId, tab, locId,
      duel.challengerName, me.name, newSnapshot).then(cardRef => {
        if (cardRef) updateDoc(duelRef, { messageId: cardRef.id });
      }));
  }

  // Post system alert in chat
  writes.push(_postEventBubble(tab, locId, duelId,
    `⚔️ <b>${duel.challengerName}</b> vs <b>${me.name}</b> — the duel has begun! <b>${duel.challengerName}</b> takes the first move.`,
    '🔔'));

  // Post the opening snapshot card
  writes.push(_postDuelSnapshot(duelId, tab, locId, newSnapshot));

  await Promise.all(writes);

  window.showToast?.('⚔️ Duel accepted! May the best warrior win!', '');
}

// ── Decline ────────────────────────────────────────

// ── Take a turn ────────────────────────────────────
export async function doDuelTurn(duelId, action, extraArg) {
  const uid = _getUid();
  if (!uid) {
    window.showToast?.('⚠️ Not logged in — cannot take turn. Please refresh.', 'error');
    return;
  }
  _uid = uid;

  const duelRef = doc(db, 'chatDuels', duelId);
  let snap;
  try {
    // Force server read — bypasses Firestore local cache so currentTurnUid
    // is always the real committed value, not a stale cached version.
    snap = await getDocFromServer(duelRef);
  } catch (e) {
    window.showToast?.(`❌ Could not read duel: ${e.message}`, 'error');
    return;
  }
  if (!snap.exists()) { window.showToast?.('Duel not found.', 'error'); return; }
  const duel = snap.data();

  if (duel.status !== 'active')    { window.showToast?.('Duel is not active.', 'error'); return; }
  if (duel.currentTurnUid !== uid) { window.showToast?.("⏳ It's not your turn!", 'error'); return; }

  const isChallenger = duel.challengerId === uid;
  const me  = isChallenger ? duel.challengerData : duel.targetData;
  const opp = isChallenger ? duel.targetData     : duel.challengerData;

  let myHp    = isChallenger ? duel.challengerHp    : duel.targetHp;
  let oppHp   = isChallenger ? duel.targetHp        : duel.challengerHp;
  let myMana  = isChallenger ? duel.challengerMana  : duel.targetMana;

  let dmg      = 0;
  let eventIcon = '⚔️';
  let eventText = '';

  // ── Resolve action ──────────────────────────────
  if (action === 'melee') {
    dmg = _calcDamage(me, opp);
    oppHp = Math.max(0, oppHp - dmg);
    eventIcon = '⚔️';
    eventText = `<b>${me.name}</b> strikes <b>${opp.name}</b> for <span class="duel-dmg">${dmg}</span> damage!`;

  } else if (action === 'defend') {
    const hRegen = Math.round(me.maxHp * 0.10);
    const mRegen = Math.round((me.maxMana || 50) * 0.20);
    myHp   = Math.min(me.maxHp,         myHp   + hRegen);
    myMana = Math.min(me.maxMana || 50, myMana + mRegen);
    eventIcon = '🛡️';
    eventText = `<b>${me.name}</b> takes a defensive stance — recovered <span class="duel-heal">+${hRegen} HP</span>, <span style="color:#6ab0f5">+${mRegen} MP</span>!`;

  } else if (action === 'skill') {
    const SKILL_DATA = window.SKILL_DATA || {};
    const sk = SKILL_DATA[extraArg];
    if (!sk) {
      window.showToast?.(`Skill "${extraArg}" not found.`, 'error');
      return;
    }
    const cost = sk.mana ?? 0;
    if (myMana < cost) {
      window.showToast?.(`Not enough MP! Need ${cost}, have ${myMana}.`, 'error');
      return;
    }
    myMana = Math.max(0, myMana - cost);

    if (sk.type === 'damage') {
      dmg = Math.max(1, Math.round(_calcDamage(me, opp) * (sk.mult || 1.0)));
      oppHp = Math.max(0, oppHp - dmg);
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> for <span class="duel-dmg">${dmg}</span> damage!`;
    } else if (sk.type === 'heal' || sk.type === 'hot') {
      const healed = Math.round(me.maxHp * (sk.healPct || sk.hotPct || 0.12));
      myHp = Math.min(me.maxHp, myHp + healed);
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> — healed <span class="duel-heal">+${healed} HP</span>!`;
    } else if (sk.type === 'buff') {
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> — power surges!`;
    } else if (sk.type === 'dot') {
      dmg = Math.max(1, Math.round(_calcDamage(me, opp) * (sk.dotPct || 0.15)));
      oppHp = Math.max(0, oppHp - dmg);
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> — dealing <span class="duel-dmg">${dmg}</span> damage!`;
    } else if (sk.type === 'shield') {
      const shielded = Math.round(me.maxHp * (sk.shieldPct || 0.15));
      myHp = Math.min(me.maxHp, myHp + shielded);
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> — shielded for <span class="duel-heal">+${shielded} HP</span>!`;
    } else if (sk.type === 'stun') {
      dmg = Math.max(1, Math.round(_calcDamage(me, opp) * (sk.mult || 1.0)));
      oppHp = Math.max(0, oppHp - dmg);
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> — stunning for <span class="duel-dmg">${dmg}</span> damage!`;
    } else if (sk.type === 'multihit') {
      const hits = sk.hits || 2;
      for (let h = 0; h < hits; h++) {
        const hDmg = Math.max(1, Math.round(_calcDamage(me, opp) * (sk.multPerHit || 0.6)));
        dmg += hDmg;
      }
      oppHp = Math.max(0, oppHp - dmg);
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> — ${sk.hits} hits for <span class="duel-dmg">${dmg}</span> total damage!`;
    } else if (sk.type === 'sacrificial') {
      const selfCost = Math.round(me.maxHp * (sk.selfHpCost || 0.15));
      myHp = Math.max(1, myHp - selfCost);
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> — sacrifices <span class="duel-dmg">${selfCost} HP</span> for power!`;
    } else {
      // Fallback: treat as a damage move
      dmg = Math.max(1, Math.round(_calcDamage(me, opp) * (sk.mult || 1.0)));
      oppHp = Math.max(0, oppHp - dmg);
      eventText = `<b>${me.name}</b> uses <b>${extraArg}</b> for <span class="duel-dmg">${dmg}</span> damage!`;
    }
    eventIcon = '✨';
  }

  const nextUid  = isChallenger ? duel.targetId    : duel.challengerId;
  const nextName = isChallenger ? duel.targetName  : duel.challengerName;
  const newRound = isChallenger ? duel.round       : duel.round + 1;

  const isDuelOver = oppHp <= 0;

  const updates = {
    round:          newRound,
    currentTurnUid: isDuelOver ? null : nextUid,
    [isChallenger ? 'challengerHp'   : 'targetHp']:    myHp,
    [isChallenger ? 'challengerMana' : 'targetMana']:  myMana,
    [isChallenger ? 'targetHp'       : 'challengerHp']: oppHp,
    ...(isDuelOver ? { status: 'complete', winnerId: uid, winnerName: me.name, loserName: opp.name } : {}),
  };

  try {
    await updateDoc(duelRef, updates);
  } catch (e) {
    window.showToast?.(`❌ Firestore write failed: ${e.code} — ${e.message}`, 'error');
    console.error('[Duel] updateDoc failed:', e);
    return;
  }

  const tab   = duel.chatTab        || _chatTab        || 'rp';
  const locId = duel.chatLocationId || _chatLocationId || '';

  // Post order: event bubbles first, THEN snapshot card so the card
  // always appears BELOW the action alerts in chat.
  // 1. Post the action event bubble
  await _postEventBubble(tab, locId, duelId, eventText, eventIcon);

  if (isDuelOver) {
    await _postEventBubble(tab, locId, duelId,
      `💀 <b>${opp.name}</b> has fallen! 🏆 <b>${me.name}</b> wins the duel!`, '🏆');
  } else {
    // "next turn" bell notification
    await _postEventBubble(tab, locId, duelId,
      `🔔 Round ${newRound} — <b>${nextName}</b>'s turn!`, '🔔');
  }

  // 2. Post updated snapshot card (always lands after the alerts)
  const postSnap = {
    challengerId:       duel.challengerId,
    challengerName:     duel.challengerName,
    challengerHp:       updates.challengerHp ?? duel.challengerHp,
    challengerMana:     updates.challengerMana ?? duel.challengerMana,
    challengerMaxHp:    duel.challengerData?.maxHp ?? 100,
    challengerMaxMana:  duel.challengerData?.maxMana ?? 50,
    challengerStance:   duel.challengerStance,
    challengerSkills:   duel.challengerSkills  || [],
    challengerRank:     duel.challengerData?.rank,
    challengerLevel:    duel.challengerData?.level,
    challengerAvatar:   duel.challengerData?.avatarUrl,
    targetId:           duel.targetId,
    targetName:         duel.targetName,
    targetHp:           updates.targetHp ?? duel.targetHp,
    targetMana:         updates.targetMana ?? duel.targetMana,
    targetMaxHp:        duel.targetData?.maxHp ?? 100,
    targetMaxMana:      duel.targetData?.maxMana ?? 50,
    targetStance:       duel.targetStance,
    targetSkills:       duel.targetSkills      || [],
    targetRank:         duel.targetData?.rank,
    targetLevel:        duel.targetData?.level,
    targetAvatar:       duel.targetData?.avatarUrl,
    status:             updates.status ?? duel.status,
    round:              updates.round ?? duel.round,
    currentTurnUid:     updates.currentTurnUid ?? duel.currentTurnUid,
    winnerId:           updates.winnerId   ?? duel.winnerId   ?? null,
    winnerName:         updates.winnerName ?? duel.winnerName ?? null,
    loserName:          updates.loserName  ?? duel.loserName  ?? null,
    forfeit:            updates.forfeit    ?? duel.forfeit    ?? false,
    chatTab:            tab,
    chatLocationId:     locId,
  };
  await _postDuelSnapshot(duelId, tab, locId, postSnap);
}

// ── Forfeit ────────────────────────────────────────
export async function forfeitChatDuel(duelId) {
  const uid = _getUid();
  if (!uid) { window.showToast?.('Not logged in.', 'error'); return; }
  _uid = uid;

  const duelRef = doc(db, 'chatDuels', duelId);
  const snap    = await getDoc(duelRef);
  if (!snap.exists()) return;
  const duel = snap.data();

  const isParticipant = duel.challengerId === uid || duel.targetId === uid;
  const isDeity       = window._charData?.isDeity;
  if (!isParticipant && !isDeity) {
    window.showToast?.('Only a duelist or deity can forfeit this duel.', 'error');
    return;
  }

  const forfeitName = uid === duel.challengerId ? duel.challengerName : duel.targetName;
  const winnerName  = uid === duel.challengerId ? duel.targetName     : duel.challengerName;
  const winnerId    = uid === duel.challengerId ? duel.targetId       : duel.challengerId;

  const tab   = duel.chatTab        || _chatTab        || 'rp';
  const locId = duel.chatLocationId || _chatLocationId || '';

  const forfeitUpdates = { status: 'complete', winnerId, winnerName, loserName: forfeitName, forfeit: true };
  await updateDoc(duelRef, forfeitUpdates);

  const writes = [];
  writes.push(_postEventBubble(tab, locId, duelId,
    `🏳️ <b>${forfeitName}</b> forfeits! <b>${winnerName}</b> wins the duel!`, '🏳️'));

  const forfeitSnap = {
    challengerId: duel.challengerId, challengerName: duel.challengerName,
    challengerHp: duel.challengerHp, challengerMana: duel.challengerMana, challengerMaxHp: duel.challengerData?.maxHp ?? 100, challengerMaxMana: duel.challengerData?.maxMana ?? 50, challengerStance: duel.challengerStance, challengerRank: duel.challengerData?.rank, challengerLevel: duel.challengerData?.level, challengerAvatar: duel.challengerData?.avatarUrl,
    targetId: duel.targetId, targetName: duel.targetName,
    targetHp: duel.targetHp, targetMana: duel.targetMana, targetMaxHp: duel.targetData?.maxHp ?? 100, targetMaxMana: duel.targetData?.maxMana ?? 50, targetStance: duel.targetStance, targetRank: duel.targetData?.rank, targetLevel: duel.targetData?.level, targetAvatar: duel.targetData?.avatarUrl,
    status: 'complete', winnerId, winnerName, loserName: forfeitName, forfeit: true,
    round: duel.round, currentTurnUid: null, chatTab: tab, chatLocationId: locId
  };
  writes.push(_postDuelSnapshot(duelId, tab, locId, forfeitSnap));

  if (duel.messageId) {
    writes.push(_patchDuelCard(duel.messageId, tab, locId, forfeitSnap,
      `🏳️ ${forfeitName} forfeits! ${winnerName} wins the duel!`));
  }

  await Promise.all(writes);

  window.showToast?.('Duel forfeited.', '');
}

// ── Admin: wipe ALL duel data — docs + chat messages ─
// Clears chatDuels collection AND all isDuelCard/isDuelEvent messages
// from every active chat collection. Deity only.
export async function clearAllDuelData() {
  if (!window._charData?.isDeity) {
    window.showToast?.('Only a Deity can wipe duel data.', 'error');
    return;
  }

  const BATCH_SIZE = 400;
  let totalDels = 0;

  async function _batchDelete(docs) {
    let batch = writeBatch(db), n = 0;
    for (const d of docs) {
      batch.delete(d.ref); n++;
      if (n % BATCH_SIZE === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    if (n % BATCH_SIZE !== 0) await batch.commit();
    totalDels += n;
  }

  // 1. Delete all chatDuels docs
  const duelsSnap = await getDocs(collection(db, 'chatDuels'));
  if (!duelsSnap.empty) await _batchDelete(duelsSnap.docs);

  // 2. Delete duel messages from general-chat
  const genSnap = await getDocs(
    query(collection(db, 'general-chat', 'global', 'messages'),
      where('uid', '==', 'system'))
  );
  const genDuelMsgs = genSnap.docs.filter(d => d.data().isDuelCard || d.data().isDuelEvent);
  if (genDuelMsgs.length) await _batchDelete(genDuelMsgs);

  // 3. Delete duel messages from all location chat rooms
  // We can't query all /chats/* subcollections directly, but we can query
  // by collectionGroup if rules allow — otherwise scan known locationIds
  try {
    const { collectionGroup } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const cgSnap = await getDocs(
      query(collectionGroup(db, 'messages'), where('uid', '==', 'system'))
    );
    const cgDuelMsgs = cgSnap.docs.filter(d => d.data().isDuelCard || d.data().isDuelEvent);
    if (cgDuelMsgs.length) await _batchDelete(cgDuelMsgs);
  } catch(e) {
    console.warn('[Duel] collectionGroup query not available, skipping location chats:', e.message);
  }

  window.showToast?.(`🗑️ Wiped ${totalDels} duel record(s) from Firestore.`, '');

  // Also clear from DOM immediately
  document.querySelectorAll('.duel-card-wrapper, .chat-msg.duel-event-msg').forEach(el => el.remove());
}

// ── Admin: clear ALL chatDuels (deity only) ────────
export async function clearAllChatDuels() {
  if (!window._charData?.isDeity) {
    window.showToast?.('Only a Deity can clear all duels.', 'error');
    return;
  }
  const snap = await getDocs(collection(db, 'chatDuels'));
  if (snap.empty) { window.showToast?.('No duels to clear.', ''); return; }

  const BATCH_SIZE = 400;
  let batch = writeBatch(db);
  let count = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    count++;
    if (count % BATCH_SIZE === 0) { await batch.commit(); batch = writeBatch(db); }
  }
  if (count % BATCH_SIZE !== 0) await batch.commit();

  window.showToast?.(`🗑️ Cleared ${count} duel(s).`, '');
}

// ── Mount a live duel card (initial pending card only) ─
export function mountDuelCard(duelId, containerEl, fallbackSnapshot) {
  _duelUnsubs[duelId]?.();
  delete _duelUnsubs[duelId];

  if (!containerEl) return;

  if (fallbackSnapshot) renderDuelCard(fallbackSnapshot, duelId, containerEl);

  const unsub = onSnapshot(
    doc(db, 'chatDuels', duelId),
    (snap) => {
      if (!snap.exists()) return;
      if (document.body.contains(containerEl)) {
        // Cache live state so openDuelStancePicker can read skills/mana without a Firestore round-trip
        if (!window._duelStates) window._duelStates = {};
        window._duelStates[duelId] = snap.data();
        renderDuelCard(snap.data(), duelId, containerEl);
      } else {
        unsub();
        delete _duelUnsubs[duelId];
      }
    },
    (err) => {
      console.warn('[Duel] Live listener error:', err.code, duelId);
      if (fallbackSnapshot && document.body.contains(containerEl)) {
        renderDuelCard(fallbackSnapshot, duelId, containerEl);
      }
      unsub();
      delete _duelUnsubs[duelId];
    }
  );
  _duelUnsubs[duelId] = unsub;
}

// ── Render the duel card HTML ──────────────────────
export function renderDuelCard(duel, duelId, el) {
  if (!el || !duel) return;

  const myUid = _getUid();

  const isPending  = duel.status === 'pending';
  const isActive   = duel.status === 'active';
  const isComplete = duel.status === 'complete';
  const isDeclined = duel.status === 'declined';

  const isMyTurn     = isActive && duel.currentTurnUid === myUid;
  const amTarget     = duel.targetId     === myUid;
  const amChallenger = duel.challengerId === myUid;

  const chHpPct = _pct(duel.challengerHp,   duel.challengerMaxHp || duel.challengerData?.maxHp);
  const tgHpPct = _pct(duel.targetHp,       duel.targetMaxHp || duel.targetData?.maxHp);
  const chMpPct = _pct(duel.challengerMana, duel.challengerMaxMana || duel.challengerData?.maxMana);
  const tgMpPct = _pct(duel.targetMana,     duel.targetMaxMana || duel.targetData?.maxMana);

  const chAv    = _avHtml(duel.challengerAvatar || duel.challengerData?.avatarUrl, 52);
  const tgAv    = _avHtml(duel.targetAvatar || duel.targetData?.avatarUrl,     52);
  const hpColor = p => p > 50 ? '#4caf8a' : p > 25 ? '#e0a83c' : '#e05555';

  const chStanceKey = duel.challengerStance || 'No Stance';
  const tgStanceKey = duel.targetStance     || 'No Stance';

  // ── Status band ───────────────────────────────
  let statusBand = '';
  if (isPending && amTarget) {
    statusBand = `
      <div class="duel-band duel-band-pending">
        ⚔️ <b>${duel.challengerName}</b> challenges you to a duel!
        <div class="duel-band-btns">
          <button class="duel-btn duel-btn-accept"  onclick="window.acceptChatDuel('${duelId}')">ACCEPT</button>
          <button class="duel-btn duel-btn-decline" onclick="window.declineChatDuel('${duelId}')">DECLINE</button>
        </div>
      </div>`;
  } else if (isPending) {
    statusBand = `<div class="duel-band duel-band-waiting">⏳ Waiting for <b>${duel.targetName}</b> to accept...</div>`;
  } else if (isMyTurn) {
    statusBand = `<div class="duel-band duel-band-your-turn">⚡ YOUR TURN — Choose your move!</div>`;
  } else if (isActive) {
    const turnName = duel.currentTurnUid === duel.challengerId ? duel.challengerName : duel.targetName;
    statusBand = `<div class="duel-band duel-band-watching">👁 ${turnName} is making their move...</div>`;
  } else if (isComplete) {
    const badge = duel.forfeit
      ? `🏳️ ${duel.loserName} forfeited! ${duel.winnerName} wins!`
      : `🏆 ${duel.winnerName} wins! ${duel.loserName} is defeated!`;
    statusBand = `<div class="duel-band duel-band-complete">${badge}</div>`;
  } else if (isDeclined) {
    statusBand = `<div class="duel-band duel-band-declined">❌ Duel was declined.</div>`;
  }

  // ── Action panel ──────────────────────────────
  let actionPanel = '';
  if (isMyTurn) {
    const mySkills = amChallenger ? (duel.challengerSkills || []) : (duel.targetSkills || []);
    const myStanceName = amChallenger ? (duel.challengerStance || '') : (duel.targetStance || '');
    const hasStance = mySkills.length > 0;
    const stanceBtn = hasStance
      ? `<button class="duel-act-btn duel-act-skill" onclick="window.openDuelStancePicker('${duelId}')">
          <span>⚔️</span><span>Stance${myStanceName && myStanceName !== 'No Stance' ? ': ' + myStanceName : ''}</span>
        </button>`
      : `<button class="duel-act-btn duel-act-skill" style="opacity:0.4;cursor:not-allowed" title="No stance set — go to Skills to create one">
          <span>⚔️</span><span>No Stance</span>
        </button>`;
    actionPanel = `
      <div class="duel-action-panel">
        <button class="duel-act-btn duel-act-melee" onclick="window.duelTurn('${duelId}','melee')">
          <span>⚔️</span><span>Strike</span>
        </button>
        <button class="duel-act-btn duel-act-defend" onclick="window.duelTurn('${duelId}','defend')">
          <span>🛡️</span><span>Defend</span>
        </button>
        ${stanceBtn}
      </div>`;
  }

  const canForfeit = isActive && (amTarget || amChallenger || window._charData?.isDeity);
  const forfeitBtn = canForfeit
    ? `<div class="duel-forfeit-row"><button class="duel-forfeit-btn" onclick="window.forfeitChatDuel('${duelId}')">🏳️ Forfeit</button></div>`
    : '';

  el.innerHTML = `
<div class="duel-card ${duel.status || 'pending'}">
  <div class="duel-card-header">
    <div class="duel-header-label"><span class="duel-crossed-swords">⚔</span> DUEL</div>
    <div class="duel-round-pill">Round ${duel.round || 1}</div>
    <div class="duel-location-tag">${duel.chatTab === 'general' ? '🌍 General' : `📍 ${duel.chatLocationId || 'Arena'}`}</div>
  </div>

  <div class="duel-arena">
    <div class="duel-fighter ${duel.currentTurnUid === duel.challengerId && isActive ? 'fighter-active' : ''} ${isComplete && duel.winnerId === duel.challengerId ? 'fighter-winner' : ''} ${isComplete && duel.winnerId !== duel.challengerId && isComplete ? 'fighter-loser' : ''}">
      <div class="duel-fighter-av">${chAv}</div>
      <div class="duel-fighter-name">${duel.challengerName}</div>
      <div class="duel-fighter-rank">${duel.challengerRank || duel.challengerData?.rank || '—'} Lv.${duel.challengerLevel || duel.challengerData?.level || 1}</div>
      <div class="duel-stance-tag">${chStanceKey}</div>
      <div class="duel-hp-row">
        <span class="duel-hp-label">HP</span>
        <div class="duel-hp-track"><div class="duel-hp-fill" style="width:${chHpPct}%;background:${hpColor(chHpPct)}"></div></div>
        <span class="duel-hp-num">${duel.challengerHp ?? '?'}<span class="duel-hp-max">/${(duel.challengerMaxHp || duel.challengerData?.maxHp) ?? '?'}</span></span>
      </div>
      <div class="duel-mp-row">
        <span class="duel-hp-label" style="color:#6ab0f5">MP</span>
        <div class="duel-hp-track"><div class="duel-hp-fill" style="width:${chMpPct}%;background:#6ab0f5"></div></div>
        <span class="duel-hp-num" style="color:#6ab0f5">${duel.challengerMana ?? '?'}<span class="duel-hp-max">/${(duel.challengerMaxMana || duel.challengerData?.maxMana) ?? '?'}</span></span>
      </div>
      ${isComplete && duel.winnerId === duel.challengerId ? '<div class="duel-winner-badge">🏆 WINNER</div>' : ''}
    </div>

    <div class="duel-vs-col">
      <div class="duel-vs-divider-line"></div>
      <div class="duel-vs-badge">VS</div>
      <div class="duel-vs-divider-line"></div>
    </div>

    <div class="duel-fighter ${duel.currentTurnUid === duel.targetId && isActive ? 'fighter-active' : ''} ${isComplete && duel.winnerId === duel.targetId ? 'fighter-winner' : ''} ${isComplete && duel.winnerId !== duel.targetId && isComplete ? 'fighter-loser' : ''}">
      <div class="duel-fighter-av">${tgAv}</div>
      <div class="duel-fighter-name">${duel.targetName}</div>
      <div class="duel-fighter-rank">${isPending ? 'Awaiting...' : ((duel.targetRank || duel.targetData?.rank || '—') + ' Lv.' + (duel.targetLevel || duel.targetData?.level || 1))}</div>
      <div class="duel-stance-tag">${tgStanceKey}</div>
      <div class="duel-hp-row">
        <span class="duel-hp-label">HP</span>
        <div class="duel-hp-track"><div class="duel-hp-fill" style="width:${tgHpPct}%;background:${hpColor(tgHpPct)}"></div></div>
        <span class="duel-hp-num">${duel.targetHp ?? '?'}<span class="duel-hp-max">/${(duel.targetMaxHp || duel.targetData?.maxHp) ?? '?'}</span></span>
      </div>
      <div class="duel-mp-row">
        <span class="duel-hp-label" style="color:#6ab0f5">MP</span>
        <div class="duel-hp-track"><div class="duel-hp-fill" style="width:${tgMpPct}%;background:#6ab0f5"></div></div>
        <span class="duel-hp-num" style="color:#6ab0f5">${duel.targetMana ?? '?'}<span class="duel-hp-max">/${(duel.targetMaxMana || duel.targetData?.maxMana) ?? '?'}</span></span>
      </div>
      ${isComplete && duel.winnerId === duel.targetId ? '<div class="duel-winner-badge">🏆 WINNER</div>' : ''}
    </div>
  </div>

  ${statusBand}
  ${actionPanel}
  ${forfeitBtn}
</div>`;
}

// ── Stance skill picker overlay ───────────────────
// Shows skills from the player's active duel stance so they can pick one.
export function openDuelStancePicker(duelId) {
  // Get skills stored on the duel doc for this player
  // We read them from the live Firestore snap via mountDuelCard,
  // but they're also available via the last rendered snapshot in the DOM.
  const wrapper = document.querySelector(`[data-duel-id="${duelId}"]`);
  const uid = _getUid();

  // Pull skills from the global duel state — cheapest path
  // doDuelTurn already has them; we re-read from window state set by mountDuelCard
  const duelState = window._duelStates?.[duelId];
  const isChallenger = duelState?.challengerId === uid;
  const mySkills = duelState
    ? (isChallenger ? duelState.challengerSkills : duelState.targetSkills) || []
    : [];
  const myMana = duelState
    ? (isChallenger ? duelState.challengerMana : duelState.targetMana) ?? 0
    : 0;
  const stanceName = duelState
    ? (isChallenger ? duelState.challengerStance : duelState.targetStance) || 'Stance'
    : 'Stance';

  let ov = document.getElementById('duel-skill-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id        = 'duel-skill-overlay';
    ov.className = 'duel-skill-overlay';
    document.body.appendChild(ov);
  }

  const SKILL_DATA = window.SKILL_DATA || {};

  const html = mySkills.length
    ? mySkills.map(skillName => {
        const sk  = SKILL_DATA[skillName] || {};
        const cost = sk.mana ?? 0;
        const ok  = myMana >= cost;
        return `
          <div class="duel-skill-item ${ok ? '' : 'duel-skill-locked'}"
            ${ok ? `onclick="window.duelTurn('${duelId}','skill','${skillName}');window.closeDuelSkillPicker()"` : ''}>
            <div class="duel-skill-name">${skillName}</div>
            <div class="duel-skill-meta">
              <span style="color:${ok ? '#6ab0f5' : '#e05555'}">${cost} MP</span>
              <span>${sk.type || ''}</span>
            </div>
          </div>`;
      }).join('')
    : '<div class="duel-skill-empty">No skills in this stance.</div>';

  ov.innerHTML = `
    <div class="duel-skill-panel">
      <div class="duel-skill-header">
        <span>⚔️ ${stanceName}</span>
        <button class="duel-skill-close" onclick="window.closeDuelSkillPicker()">✕</button>
      </div>
      <div class="duel-skill-list">${html}</div>
    </div>`;
  ov.style.display = 'flex';
}

// ── Listen for incoming challenges (toast) ─────────
function _listenForIncomingChallenges() {
  const uid = _getUid();
  if (!uid) return;
  onSnapshot(
    query(collection(db, 'chatDuels'), where('targetId', '==', uid), where('status', '==', 'pending')),
    (snap) => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'added') _showChallengeToast(ch.doc.id, ch.doc.data().challengerName);
      });
    }
  );
}

function _showChallengeToast(duelId, challengerName) {
  document.getElementById('duel-challenge-toast')?.remove();
  const t = document.createElement('div');
  t.id        = 'duel-challenge-toast';
  t.className = 'duel-challenge-toast';
  t.innerHTML = `
    <div class="dct-glow"></div>
    <div class="dct-swords">⚔️</div>
    <div class="dct-body">
      <div class="dct-title">DUEL CHALLENGE!</div>
      <div class="dct-msg"><b>${challengerName}</b> wants to fight you!</div>
      <div class="dct-hint">Check the chat to respond</div>
      <div class="dct-btns">
        <button class="duel-btn duel-btn-accept"  onclick="window.acceptChatDuel('${duelId}')">⚔ FIGHT</button>
        <button class="duel-btn duel-btn-decline" onclick="window.declineChatDuel('${duelId}')">✕ DECLINE</button>
      </div>
    </div>
    <button class="dct-close" onclick="this.closest('.duel-challenge-toast').remove()">✕</button>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('visible')));
}

// ── Chat collection helper ─────────────────────────
function _msgRef(tab, locId) {
  if (tab === 'general') return collection(db, 'general-chat', 'global', 'messages');
  if (locId)             return collection(db, 'chats', locId, 'messages');
  console.warn('[Duel] _msgRef: no locId — message dropped. tab:', tab);
  return null;
}

// Post a NEW pending duel card message (initial challenge only)
async function _postDuelCard(duelId, tab, locId, challengerName, targetName, snapshot) {
  const ref = _msgRef(tab, locId);
  if (!ref) return null;
  return addDoc(ref, {
    uid:            'system',
    charName:       '⚔️ DUEL',
    isDuelCard:     true,
    isLiveDuelCard: true,
    duelId,
    duelSnapshot:   snapshot,
    challengerName,
    targetName,
    text:           `⚔️ ${challengerName} challenges ${targetName} to a duel!`,
    timestamp:      serverTimestamp(),
  });
}

// Patch the initial duel card (used for accept/decline only)
async function _patchDuelCard(messageId, tab, locId, snapshot, text = null) {
  if (!messageId) return;
  const ref = _msgRef(tab, locId);
  if (!ref) return;
  const updateData = {
    duelSnapshot:   snapshot,
    isLiveDuelCard: snapshot.status === 'active' || snapshot.status === 'pending',
    timestamp:      serverTimestamp(),
  };
  if (text !== null) updateData.text = text;
  try {
    await updateDoc(doc(ref, messageId), updateData);
  } catch (e) {
    console.error('[Duel] _patchDuelCard failed:', e.code, e.message);
  }
}

// Post an event/action alert bubble into chat
// richText contains HTML for rendering; plainText is HTML-stripped for the
// Firestore rule that validates text.size() <= 1000.
async function _postEventBubble(tab, locId, duelId, richText, icon) {
  if (icon === undefined) icon = '⚔️';
  const ref = _msgRef(tab, locId);
  if (!ref) return null;
  const plainText = richText.replace(/<[^>]*>/g, '').slice(0, 900);
  return addDoc(ref, {
    uid:           'system',
    charName:      '⚔️ DUEL',
    isDuelEvent:   true,
    duelId,
    text:          plainText,
    richText,
    duelEventIcon: icon,
    timestamp:     serverTimestamp(),
  });
}

// Post a static snapshot card (appears after each turn)
async function _postDuelSnapshot(duelId, tab, locId, snapshot) {
  const ref = _msgRef(tab, locId);
  if (!ref) return null;
  const label = '⚔️ ' + (snapshot.challengerName || '') + ' vs ' + (snapshot.targetName || '') + ' — Round ' + (snapshot.round || 1);
  return addDoc(ref, {
    uid:            'system',
    charName:       '⚔️ DUEL',
    isDuelCard:     true,
    isLiveDuelCard: false,
    duelId,
    duelSnapshot:   snapshot,
    challengerName: snapshot.challengerName,
    targetName:     snapshot.targetName,
    text:           label,
    timestamp:      serverTimestamp(),
  });
}

// ── Damage formula ─────────────────────────────────
// Stat-aware: a higher rank/level player has much higher primary stats and
// maxHp, so the gap between players scales naturally.
//
// Formula:
//   base   = attacker's primary stat (str/dex/int depending on class+stance)
//   scaled = base × (attacker level / defender level) clamped to 0.5–5.0
//   raw    = scaled × randFactor(0.85–1.15) × attacker.dmgMult
//   mitigated = raw × (1 - def_reduction)
//   def_reduction = (opp.def * oppStance.defMult) / ((opp.def * oppStance.defMult) + 25)
//   final = floor(max(1, mitigated))
//
// This means a Rank 9 Lv20 (str ~150) vs Rank 0 Lv1 (def ~5+):
//   scaled ≈ 150 × min(5, 20/1) = 150 × 5 = 750 (hits are massive)
//   Rank 0 maxHp ≈ 110 → instant KO ✓
// Two equal players (same rank/level) land balanced ~20–40% max HP hits.
function _calcDamage(me, opp, skillType = null) {
  const RANK_ORDER = ['Wanderer','Follower','Disciple','Master','Exalted','Crown','Supreme','Legend','Myth','Eternal'];

  // Determine attacker's primary stat
  let primary = _getPrimary(me);
  if (skillType && skillType.includes('Magic')) primary = me.int || 10;

  // Level scaling: attacker level / defender level, clamped 0.5–5.0
  const atkLevel = (RANK_ORDER.indexOf(me.rank || 'Wanderer') * 10) + (me.level || 1);
  const defLevel = (RANK_ORDER.indexOf(opp.rank || 'Wanderer') * 10) + (opp.rank === '?' ? 0.5 : (opp.level || 1));
  const levelRatio = Math.max(0.5, Math.min(5.0, atkLevel / Math.max(1, defLevel)));

  // Base damage
  const base = primary * levelRatio;

  // Random variance ±15%
  const variance = 0.85 + Math.random() * 0.30;

  // Crit check (simple 5%)
  const critRoll = Math.random();
  const critMult = critRoll < 0.05 ? 1.5 : 1.0;

  const rawDmg = base * variance * critMult;

  // Defender mitigation: diminishing returns so def never blocks 100%
  const effDef   = opp.def || 5;
  const defRatio = effDef / (effDef + 25);
  const mitigated = rawDmg * (1 - defRatio);

  return Math.max(1, Math.floor(mitigated));
}

// ── Build combatant objects ────────────────────────
function _buildCombatant(d, uid) {
  return {
    uid,
    name:      d.name,
    avatarUrl: d.avatarUrl  || '',
    charClass: d.charClass  || 'Warrior',
    rank:      d.rank       || 'Wanderer',
    level:     d.level      || 1,
    hp:        d.hp         ?? d.hpMax   ?? 100,
    maxHp:     d.hpMax      ?? d.hp      ?? 100,
    mana:      d.mana       ?? d.manaMax ?? 50,
    maxMana:   d.manaMax    ?? d.mana    ?? 50,
    str:       d.str  ?? 10,
    dex:       d.dex  ?? 8,
    int:       d.int  ?? 8,
    def:       d.def  ?? 5,
  };
}
function _buildFallbackCombatant(uid, name) {
  return { uid, name, avatarUrl: '', charClass: 'Warrior', rank: '?', level: 1,
           hp: 100, maxHp: 100, mana: 50, maxMana: 50, str: 10, dex: 8, int: 8, def: 5 };
}
function _getPrimary(me) {
  const cls = me.charClass || '';
  if (['Mage','Scholar','Arcanist','Cleric','Summoner'].includes(cls)) return me.int || 10;
  if (['Ranger','Rogue','Hunter','Assassin'].includes(cls)) return me.dex || 10;
  return me.str || 10;
}
function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function _pct(val, max)  { return max ? Math.max(0, Math.min(100, Math.round((val / max) * 100))) : 0; }
function _avHtml(url, sz) {
  if (url?.startsWith('http'))
    return `<img src="${url}" style="width:${sz}px;height:${sz}px;border-radius:50%;object-fit:cover"/>`;
  return `<span style="font-size:${Math.round(sz * 0.5)}px;line-height:${sz}px">${url || '⚔️'}</span>`;
}

// ── Global window bindings ─────────────────────────
window.initDuelSystem       = initDuelSystem;
window.updateDuelContext    = updateDuelContext;
window.getDuelContext       = getDuelContext;
window.initiateChatDuel     = initiateChatDuel;
window.acceptChatDuel       = async (id) => {
  document.getElementById('duel-challenge-toast')?.remove();
  await acceptDuelChallenge(id).catch(e => window.showToast?.(e.message, 'error'));
};
window.declineChatDuel      = async (id) => {
  document.getElementById('duel-challenge-toast')?.remove();
  await declineDuelChallenge(id).catch(e => window.showToast?.(e.message, 'error'));
};
window.duelTurn             = (id, a, s) => doDuelTurn(id, a, s).catch(e => window.showToast?.(e.message, 'error'));
window.forfeitChatDuel      = forfeitChatDuel;
window.clearAllChatDuels    = clearAllChatDuels;
window.clearAllDuelData     = clearAllDuelData;
window.mountDuelCard        = mountDuelCard;
window.renderDuelCard       = renderDuelCard;
window.openDuelStancePicker  = openDuelStancePicker;
window.closeDuelSkillPicker  = () => { const e = document.getElementById('duel-skill-overlay'); if (e) e.style.display = 'none'; };   