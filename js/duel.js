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
let _isDeity        = false;   // set once at init; never cleared by charData swaps
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
  if (charData?.isDeity) _isDeity = true;  // latch: once a deity, always a deity for this session
  _listenForIncomingChallenges();
  // If this is a deity, also watch for challenges addressed to any NPC uid
  // (npc_xxx format) so the deity can auto-respond on behalf of the NPC.
  if (charData?.isDeity) {
    _listenForNpcChallenges();
  }
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
// ── NPC location helper ────────────────────────────
// General chat NPCs live under npcs/global/list; location NPCs under npcs/{locId}/list.
// Returns the correct Firestore location segment for any chat context.
function _npcLocId(chatTab, chatLocationId) {
  if (chatTab === 'general' || (!chatLocationId && !chatTab)) return 'global';
  return chatLocationId || '';
}

// Unified NPC cache lookup — checks both deity location cache and general-chat cache.
function _findNpcInCache(npcId) {
  const locationCache = window._deityNpcs       || [];
  const generalCache  = window._dchatGeneralNpcs || [];
  return locationCache.find(n => n.id === npcId) || generalCache.find(n => n.id === npcId) || null;
}

export async function initiateChatDuel(targetUid, targetName, chatTab, chatLocationId) {
  const uid = _getUid();
  const charData = _getCharData();
  if (!uid || !charData) throw new Error('Not logged in.');
  _uid = uid; _charData = charData;

  const me = _buildCombatant(charData, uid);
  const stance = _getActiveStance(charData);

  let targetData = _buildFallbackCombatant(targetUid, targetName);
  let targetStanceForDuel = 'No Stance';
  let targetSkillsForDuel = [];
  if (targetUid.startsWith('npc_')) {
    // Try unified cache first (covers both location & general-chat NPCs),
    // then fall back to Firestore — works for general chat (locId='global') too.
    const npcId    = targetUid.replace('npc_', '');
    let   npcData  = _findNpcInCache(npcId);
    if (!npcData) {
      try {
        const fetchLocId = _npcLocId(chatTab, chatLocationId || _chatLocationId || '');
        const npcSnap = await getDoc(doc(db, 'npcs', fetchLocId, 'list', npcId));
        if (npcSnap.exists()) npcData = { id: npcId, ...npcSnap.data() };
      } catch (e) { console.warn('[Duel] Could not fetch NPC from Firestore:', e); }
    }
    if (npcData) {
      targetData = _buildCombatant(npcData, targetUid);
      if (npcData.stances?.length) {
        const s = npcData.stances[0];
        targetStanceForDuel = s.name || 'No Stance';
        targetSkillsForDuel = s.skills || [];
      } else if (npcData.skills?.length) {
        targetSkillsForDuel = npcData.skills.slice(0, 3);
        targetStanceForDuel = npcData.name ? `${npcData.name}'s Style` : 'Combat Stance';
      }
    }
  } else {
    try {
      const snap = await getDoc(doc(db, 'characters', targetUid));
      if (snap.exists()) targetData = _buildCombatant(snap.data(), targetUid);
    } catch (e) { console.warn('[Duel] Could not fetch target data:', e); }
  }

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
    targetName:          targetData.name || targetName,
    targetData,
    targetHp:            targetData.hp,
    targetMana:          targetData.mana,
    targetMaxHp:         targetData.maxHp,
    targetMaxMana:       targetData.maxMana,
    targetStance:        targetStanceForDuel,
    targetSkills:        targetSkillsForDuel,
    targetRank:          targetData.rank  || '',
    targetLevel:         targetData.level || 1,
    targetAvatar:        targetData.avatarUrl || '',
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
    targetName:         targetData.name || targetName,
    targetData,
    targetHp:           targetData.hp,
    targetMana:         targetData.mana,
    targetMaxHp:        targetData.maxHp,
    targetMaxMana:      targetData.maxMana,
    targetStance:       targetStanceForDuel,
    targetSkills:       targetSkillsForDuel,
    targetRank:         targetData.rank  || '',
    targetLevel:        targetData.level || 1,
    targetAvatar:       targetData.avatarUrl || '',
    status:             'pending',
    round:              1,
    currentTurnUid:     uid,
    chatTab:            tab,
    chatLocationId:     locId,
  };

  const cardRef = await _postDuelCard(duelRef.id, tab, locId, me.name, targetName, snapshot);
  // Fire card message + notification + messageId update concurrently
  const postWrites = [];
  if (cardRef) postWrites.push(updateDoc(duelRef, { messageId: cardRef.id }));
  // Skip notification for NPC targets — they don't have a real inbox
  if (!targetUid.startsWith('npc_')) {
    postWrites.push(addDoc(collection(db, 'notifications'), {
      uid:       targetUid,
      type:      'duel-challenge',
      title:     '⚔️ Duel Challenge!',
      message:   `${me.name} challenges you to a duel in chat!`,
      duelId:    duelRef.id,
      read:      false,
      createdAt: serverTimestamp(),
      fromUid:   uid,
      fromName:  me.name,
    }).catch(e => console.warn('[Duel] Notification failed:', e)));
  }
  await Promise.all(postWrites);

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

export async function declineDuelChallenge(duelId) {
  const uid      = _getUid();
  const charData = _getCharData();
  if (!uid) { window.showToast?.('Not logged in.', 'error'); return; }

  const duelRef = doc(db, 'chatDuels', duelId);
  const snap    = await getDoc(duelRef);
  if (!snap.exists()) { window.showToast?.('Duel not found.', 'error'); return; }
  const duel = snap.data();

  if (duel.status !== 'pending') { window.showToast?.('Duel already handled.', 'error'); return; }

  const tab   = duel.chatTab        || _chatTab        || 'rp';
  const locId = duel.chatLocationId || _chatLocationId || '';

  await updateDoc(duelRef, { status: 'declined' });

  await _postEventBubble(tab, locId, duelId,
    `❌ <b>${duel.targetName}</b> declined the duel challenge from <b>${duel.challengerName}</b>.`, '❌');

  if (duel.messageId) {
    await _patchDuelCard(duel.messageId, tab, locId,
      { ...duel, status: 'declined' }, `❌ ${duel.targetName} declined the duel.`);
  }

  if (!duel.challengerId?.startsWith('npc_')) {
    addDoc(collection(db, 'notifications'), {
      uid:       duel.challengerId,
      type:      'duel-challenge-declined',
      title:     '❌ Duel Declined',
      message:   `${duel.targetName} declined your duel challenge.`,
      duelId,   read: false,   createdAt: serverTimestamp(),
      fromUid:   uid,   fromName:  charData?.name || duel.targetName || '',
    }).catch(e => console.warn('[Duel] decline notif failed:', e));
  }

  window.showToast?.('Duel declined.', '');
  document.getElementById('duel-challenge-toast')?.remove();
}

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

  const isNpcTurn = duel.currentTurnUid?.startsWith('npc_');
  const amChallenger = duel.challengerId === uid;
  const amTarget     = duel.targetId     === uid;

  // Only deities can act on behalf of an NPC — players must wait
  const canActForNpc = isNpcTurn && _isDeity;

  if (!canActForNpc && duel.currentTurnUid !== uid) {
    window.showToast?.("⏳ It's not your turn!", 'error'); return;
  }

  // When acting on behalf of NPC, the NPC is the "me" (attacker), human is "opp"
  const actingAsNpc = isNpcTurn;
  const isChallenger = actingAsNpc ? (duel.targetId === duel.currentTurnUid ? false : true)
    : (duel.challengerId === uid);
  // For NPC turns: NPC is always targetId (npc_xxx), human is challengerId
  const me  = actingAsNpc ? duel.targetData     : (isChallenger ? duel.challengerData : duel.targetData);
  const opp = actingAsNpc ? duel.challengerData : (isChallenger ? duel.targetData     : duel.challengerData);

  let myHp    = actingAsNpc ? duel.targetHp      : (isChallenger ? duel.challengerHp    : duel.targetHp);
  let oppHp   = actingAsNpc ? duel.challengerHp  : (isChallenger ? duel.targetHp        : duel.challengerHp);
  let myMana  = actingAsNpc ? duel.targetMana    : (isChallenger ? duel.challengerMana  : duel.targetMana);

  // Per-player status state (stun, dot, buffs, shield)
  const myStateKey  = actingAsNpc ? 'targetState'     : (isChallenger ? 'challengerState' : 'targetState');
  const oppStateKey = actingAsNpc ? 'challengerState' : (isChallenger ? 'targetState'     : 'challengerState');
  let myState  = duel[myStateKey]  || {};
  let oppState = duel[oppStateKey] || {};
  let oppStateUpd = {};
  let myStateUpd  = {};

  // If I am stunned this turn, skip my action and pass the turn back
  if (myState.stunned) {
    myState = { ...myState, stunned: false };
    const stunNextUid  = actingAsNpc ? duel.challengerId   : (isChallenger ? duel.targetId    : duel.challengerId);
    const stunNextName = actingAsNpc ? duel.challengerName : (isChallenger ? duel.targetName  : duel.challengerName);
    // Always increment the round on a stun-skip — whoever is about to act next
    // is the same as a normal turn transition, so the round must advance.
    const stunRound = duel.round + 1;
    const _tab2   = duel.chatTab        || _chatTab        || 'rp';
    const _locId2 = duel.chatLocationId || _chatLocationId || '';
    await updateDoc(duelRef, { round: stunRound, currentTurnUid: stunNextUid, [myStateKey]: myState });
    await _postEventBubble(_tab2, _locId2, duelId,
      `💫 <b>${meDisplayName}</b> is stunned and loses their turn!`, '💫');
    await _postEventBubble(_tab2, _locId2, duelId,
      `🔔 Round ${stunRound} — <b>${stunNextName}</b>'s turn!`, '🔔');
    return;
  }

  // ── Tick DoT on ME (applied by opponent on a previous turn) ──
  // This fires before I act, so poison bites before I can respond.
  if (myState.dotActive && myState.dotTurns > 0) {
    const dotDmg    = Math.max(1, Math.round(me.maxHp * (myState.dotPct || 0.10)));
    myHp            = Math.max(0, myHp - dotDmg);
    const turnsLeft = myState.dotTurns - 1;
    myState         = { ...myState, dotTurns: turnsLeft, dotActive: turnsLeft > 0 };
    const oppDisplayForDot = actingAsNpc
      ? (duel.challengerName || opp?.name || 'opponent')
      : (opp?.name || (isChallenger ? duel.targetName : duel.challengerName) || 'opponent');
    // If opponent has lifesteal, heal them too
    if (myState.dotLifesteal) {
      oppHp = Math.min(opp?.maxHp || oppHp, oppHp + dotDmg);
    }
    await _postEventBubble(_tab2, _locId2, duelId,
      `🩸 <b>${meDisplayName || 'Fighter'}</b> takes <span class="duel-dmg">${dotDmg}</span> ${myState.dotLabel||'Poison'} damage! (${turnsLeft} turn${turnsLeft===1?'':'s'} left)`, '🩸');
    // Check if DoT killed me
    if (myHp <= 0) {
      const myHpKey2   = actingAsNpc ? 'targetHp'     : (isChallenger ? 'challengerHp'   : 'targetHp');
      const oppHpKey2  = actingAsNpc ? 'challengerHp' : (isChallenger ? 'targetHp'       : 'challengerHp');
      const winnerName2 = oppDisplayForDot;
      const loserName2  = meDisplayName || 'Fighter';
      await updateDoc(duelRef, {
        [myHpKey2]:   0,
        [oppHpKey2]:  oppHp,
        [myStateKey]: myState,
        status: 'complete', winnerId: actingAsNpc ? duel.challengerId : (isChallenger ? duel.targetId : duel.challengerId),
        winnerName: winnerName2, loserName: loserName2,
        currentTurnUid: null,
      });
      await _postEventBubble(_tab2, _locId2, duelId,
        `💀 <b>${loserName2}</b> has been slain by poison! <b>${winnerName2}</b> wins!`, '🏆');
      return;
    }
  }

  // Safe display names — fall back to duel doc names so Firestore IDs never leak.
  // When actingAsNpc: me=NPC(target), opp=player(challenger) — always use targetName/challengerName directly.
  const meDisplayName  = actingAsNpc
    ? (duel.targetName      || me.name  || 'Fighter')
    : (me.name  || (isChallenger ? duel.challengerName : duel.targetName)  || 'Fighter');
  const oppDisplayName = actingAsNpc
    ? (duel.challengerName  || opp.name || 'Fighter')
    : (opp.name || (isChallenger ? duel.targetName     : duel.challengerName) || 'Fighter');

  let dmg      = 0;
  let eventIcon = '⚔️';
  let eventText = '';

  // ── Resolve action ──────────────────────────────
  if (action === 'melee') {
    dmg = _calcDamage(me, opp);
    oppHp = Math.max(0, oppHp - dmg);
    eventIcon = '⚔️';
    eventText = `<b>${meDisplayName}</b> strikes <b>${oppDisplayName}</b> for <span class="duel-dmg">${dmg}</span> damage!`;

  } else if (action === 'defend') {
    const hRegen = Math.round(me.maxHp * 0.10);
    const mRegen = Math.round((me.maxMana || 50) * 0.20);
    myHp   = Math.min(me.maxHp,         myHp   + hRegen);
    myMana = Math.min(me.maxMana || 50, myMana + mRegen);
    eventIcon = '🛡️';
    eventText = `<b>${meDisplayName}</b> takes a defensive stance — recovered <span class="duel-heal">+${hRegen} HP</span>, <span style="color:#6ab0f5">+${mRegen} MP</span>!`;

  } else if (action === 'skill') {
    // Use module-level SKILL_DATA (always available); merge with window.SKILL_DATA
    // in case dashboard.js has added custom skills at runtime.
    const _skillRegistry = Object.assign({}, SKILL_DATA, window.SKILL_DATA || {});
    let sk = _skillRegistry[extraArg];
    if (!sk) {
      // Try to find it in the skill trees (covers timing/load-order edge cases)
      const treeDef = _findSkillDef(me.charClass, extraArg);
      if (treeDef) {
        const manaMatch = treeDef.desc?.match(/(\d+)\s*Mana/);
        sk = { mana: manaMatch ? parseInt(manaMatch[1]) : 0, type: 'damage', mult: 1.0 };
      }
    }
    // Final fallback — unknown skill, treat as basic damage so duel never freezes
    // Last resort for any unrecognised skill (custom/future skills):
    // treat as a plain damage move so the duel always continues.
    if (!sk) {
      sk = { mana: 0, type: 'damage', mult: 1.0 };
    }
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
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> for <span class="duel-dmg">${dmg}</span> damage!`;
    } else if (sk.type === 'heal' || sk.type === 'hot') {
      const healed = Math.round(me.maxHp * (sk.healPct || sk.hotPct || 0.12));
      myHp = Math.min(me.maxHp, myHp + healed);
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> — healed <span class="duel-heal">+${healed} HP</span>!`;
    } else if (sk.type === 'buff') {
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> — power surges!`;
    } else if (sk.type === 'dot') {
      oppStateUpd.dotActive    = true;
      oppStateUpd.dotPct       = sk.dotPct   || 0.10;
      oppStateUpd.dotTurns     = sk.dotTurns || 3;
      oppStateUpd.dotLabel     = sk.dotLabel || 'Poison';
      oppStateUpd.dotLifesteal = sk.lifesteal || false;
      const dotApplyLabel = `${Math.round((sk.dotPct||0.10)*100)}%×${sk.dotTurns||3} turns`;
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> — <span style="color:#c97fff">${oppStateUpd.dotLabel} applied!</span> (${dotApplyLabel})`;
    } else if (sk.type === 'shield') {
      const shielded = Math.round(me.maxHp * (sk.shieldPct || 0.15));
      myHp = Math.min(me.maxHp, myHp + shielded);
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> — shielded for <span class="duel-heal">+${shielded} HP</span>!`;
    } else if (sk.type === 'stun') {
      dmg = Math.max(1, Math.round(_calcDamage(me, opp) * (sk.mult || 1.0)));
      oppHp = Math.max(0, oppHp - dmg);
      oppStateUpd.stunned = true;
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> — <span class="duel-dmg">${dmg}</span> dmg + <b>${oppDisplayName} is STUNNED</b> and loses next turn!`;
    } else if (sk.type === 'multihit') {
      const hits = sk.hits || 2;
      for (let h = 0; h < hits; h++) {
        const hDmg = Math.max(1, Math.round(_calcDamage(me, opp) * (sk.multPerHit || 0.6)));
        dmg += hDmg;
      }
      oppHp = Math.max(0, oppHp - dmg);
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> — ${sk.hits} hits for <span class="duel-dmg">${dmg}</span> total damage!`;
    } else if (sk.type === 'sacrificial') {
      const selfCost = Math.round(me.maxHp * (sk.selfHpCost || 0.15));
      myHp = Math.max(1, myHp - selfCost);
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> — sacrifices <span class="duel-dmg">${selfCost} HP</span> for power!`;
    } else {
      // Fallback: treat as a damage move
      dmg = Math.max(1, Math.round(_calcDamage(me, opp) * (sk.mult || 1.0)));
      oppHp = Math.max(0, oppHp - dmg);
      eventText = `<b>${meDisplayName}</b> uses <b>${extraArg}</b> for <span class="duel-dmg">${dmg}</span> damage!`;
    }
    eventIcon = '✨';
  }

  // Merge state updates
  myState  = { ...myState,  ...myStateUpd };
  oppState = { ...oppState, ...oppStateUpd };

  const normalNextUid  = actingAsNpc ? duel.challengerId   : (isChallenger ? duel.targetId    : duel.challengerId);
  const normalNextName = actingAsNpc ? duel.challengerName : (isChallenger ? duel.targetName  : duel.challengerName);

  // Stun: opponent already has stunned=true in oppStateUpd — they lose their NEXT turn.
  // We do NOT keep the current player's turn; just pass normally so both sides advance fairly.
  const nextUid  = normalNextUid;
  const nextName = normalNextName;
  const newRound = actingAsNpc ? duel.round + 1 : (isChallenger ? duel.round : duel.round + 1);

  const isDuelOver = oppHp <= 0;

  // For NPC acting as target: myHp → targetHp, oppHp → challengerHp
  const myHpKey   = actingAsNpc ? 'targetHp'       : (isChallenger ? 'challengerHp'   : 'targetHp');
  const myManaKey = actingAsNpc ? 'targetMana'     : (isChallenger ? 'challengerMana' : 'targetMana');
  const oppHpKey  = actingAsNpc ? 'challengerHp'   : (isChallenger ? 'targetHp'       : 'challengerHp');

  const updates = {
    round:          newRound,
    currentTurnUid: isDuelOver ? null : nextUid,
    [myHpKey]:   myHp,
    [myManaKey]: myMana,
    [oppHpKey]:  oppHp,
    [myStateKey]:  myState,
    [oppStateKey]: oppState,
    ...(isDuelOver ? { status: 'complete', winnerId: actingAsNpc ? duel.targetId : uid, winnerName: meDisplayName, loserName: oppDisplayName } : {}),
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
      `💀 <b>${oppDisplayName}</b> has fallen! 🏆 <b>${meDisplayName}</b> wins the duel!`, '🏆');
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
  const isDeity       = _isDeity;
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
  if (!_isDeity) {
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
  if (!_isDeity) {
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

  const amTarget     = duel.targetId     === myUid;
  const amChallenger = duel.challengerId === myUid;
  const isNpcTurn    = isActive && duel.currentTurnUid?.startsWith('npc_');
  // It's "my turn" if it's literally my uid, OR it's an NPC's turn and I am a deity.
  // Players always wait when it's the NPC's turn — NPCs are deity-controlled.
  const isMyTurn     = isActive && (
    duel.currentTurnUid === myUid ||
    (isNpcTurn && _isDeity)
  );

  const chHpPct = _pct(duel.challengerHp,   duel.challengerMaxHp || duel.challengerData?.maxHp);
  const tgHpPct = _pct(duel.targetHp,       duel.targetMaxHp || duel.targetData?.maxHp);
  const chMpPct = _pct(duel.challengerMana, duel.challengerMaxMana || duel.challengerData?.maxMana);
  const tgMpPct = _pct(duel.targetMana,     duel.targetMaxMana || duel.targetData?.maxMana);

  const chAv    = _avHtml(duel.challengerAvatar || duel.challengerData?.avatarUrl || duel.challengerData?.avatar, 52);
  const tgAv    = _avHtml(duel.targetAvatar     || duel.targetData?.avatarUrl     || duel.targetData?.avatar,     52);
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
  } else if (isMyTurn && isNpcTurn) {
    statusBand = `<div class="duel-band duel-band-your-turn">⚡ Choose <b>${duel.targetName}</b>'s move!</div>`;
  } else if (isMyTurn) {
    statusBand = `<div class="duel-band duel-band-your-turn">⚡ YOUR TURN — Choose your move!</div>`;
  } else if (isActive) {
    const isNpcTurnNow = duel.currentTurnUid?.startsWith('npc_');
    const turnName = isNpcTurnNow
      ? duel.targetName                                                    // NPC's turn — deity controls
      : (duel.currentTurnUid === duel.challengerId ? duel.challengerName : duel.targetName);
    statusBand = isNpcTurnNow
      ? `<div class="duel-band duel-band-watching">⏳ Waiting for <b>${turnName}</b>'s move...</div>`
      : `<div class="duel-band duel-band-watching">👁 ${turnName} is making their move...</div>`;
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
    // When it's the NPC's turn, show the NPC's stance/skills (target side)
    const actingAsNpc = isNpcTurn;

    // Resolve skills: prefer the duel-doc arrays; fall back to charData.stances[0].skills
    let mySkills, myStanceName;
    if (actingAsNpc) {
      mySkills     = (duel.targetSkills?.length   ? duel.targetSkills   : duel.targetData?.stances?.[0]?.skills)   || [];
      myStanceName = duel.targetStance || duel.targetData?.stances?.[0]?.name || '';
    } else if (amChallenger) {
      mySkills     = (duel.challengerSkills?.length ? duel.challengerSkills : duel.challengerData?.stances?.[0]?.skills) || [];
      myStanceName = duel.challengerStance || duel.challengerData?.stances?.[0]?.name || '';
    } else {
      mySkills     = (duel.targetSkills?.length   ? duel.targetSkills   : duel.targetData?.stances?.[0]?.skills)   || [];
      myStanceName = duel.targetStance || duel.targetData?.stances?.[0]?.name || '';
    }
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

  const canForfeit = isActive && (amTarget || amChallenger || _isDeity);
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
  const wrapper = document.querySelector(`[data-duel-id="${duelId}"]`);
  const uid = _getUid();

  const duelState = window._duelStates?.[duelId];
  const isChallenger = duelState?.challengerId === uid;
  const isNpcTurn = duelState?.currentTurnUid?.startsWith('npc_');

  // When it's the NPC's turn, show NPC's (target) skills
  let mySkills, myMana, stanceName;
  if (isNpcTurn) {
    // Prefer flat targetSkills on duel doc; fall back to nested stances on targetData;
    // last resort: look up the NPC directly from _deityNpcs cache
    const npcId    = (duelState?.targetId || '').replace('npc_', '');
    const npcCache = _findNpcInCache(npcId);
    const stanceFromCache = npcCache?.stances?.[0];
    mySkills   = (duelState?.targetSkills?.length   ? duelState.targetSkills
                : duelState?.targetData?.stances?.[0]?.skills?.length ? duelState.targetData.stances[0].skills
                : stanceFromCache?.skills)
                || [];
    myMana     = duelState?.targetMana   ?? 0;
    stanceName = duelState?.targetStance || duelState?.targetData?.stances?.[0]?.name || stanceFromCache?.name || 'NPC Stance';

    // If we still have no skills (old duel doc, pre-fix), patch the duel doc live
    if (!mySkills.length && npcCache?.stances?.length) {
      const s = npcCache.stances[0];
      mySkills   = s.skills || [];
      stanceName = s.name   || 'NPC Stance';
      // Patch Firestore so future renders are correct too
      const duelRef = doc(db, 'chatDuels', duelId);
      updateDoc(duelRef, { targetSkills: mySkills, targetStance: stanceName,
        targetName: npcCache?.name || duelState?.targetName || '' })
        .catch(e => console.warn('[Duel] Could not patch targetSkills:', e));
      // Also update local state
      if (window._duelStates?.[duelId]) {
        window._duelStates[duelId].targetSkills = mySkills;
        window._duelStates[duelId].targetStance = stanceName;
      }
    }
  } else {
    const rawSkills = duelState ? (isChallenger ? duelState.challengerSkills : duelState.targetSkills) : null;
    const fallbackStance = duelState ? (isChallenger ? duelState.challengerData?.stances?.[0] : duelState.targetData?.stances?.[0]) : null;
    mySkills   = (rawSkills?.length ? rawSkills : fallbackStance?.skills) || [];
    myMana     = duelState ? (isChallenger ? duelState.challengerMana  : duelState.targetMana)  ?? 0  : 0;
    stanceName = duelState ? ((isChallenger ? duelState.challengerStance : duelState.targetStance) || fallbackStance?.name || 'Stance') : 'Stance';
  }

  let ov = document.getElementById('duel-skill-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id        = 'duel-skill-overlay';
    ov.className = 'duel-skill-overlay';
    document.body.appendChild(ov);
  }

  // Merge module-level + window SKILL_DATA so deity dashboard also sees mana costs
  const _skillRegistry = Object.assign({}, SKILL_DATA, window.SKILL_DATA || {});

  const html = mySkills.length
    ? mySkills.map(skillName => {
        const sk  = _skillRegistry[skillName] || {};
        const cost = sk.mana ?? 0;
        const ok  = myMana >= cost;
        const safeSkillName = skillName.replace(/'/g, "\\'");
        return `
          <div class="duel-skill-item ${ok ? '' : 'duel-skill-locked'}"
            ${ok ? `onclick="window.duelTurn('${duelId}','skill','${safeSkillName}');window.closeDuelSkillPicker()"` : ''}>
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

// ── Listen for challenges sent to any NPC (deity only) ─
let _npcChallengeUnsub = null;
function _listenForNpcChallenges() {
  if (_npcChallengeUnsub) { _npcChallengeUnsub(); _npcChallengeUnsub = null; }
  // Query for pending duels where targetId starts with "npc_" — we can't use
  // a prefix query directly, so we poll on 'pending' duels and filter client-side.
  _npcChallengeUnsub = onSnapshot(
    query(collection(db, 'chatDuels'), where('status', '==', 'pending')),
    (snap) => {
      snap.docChanges().forEach(ch => {
        if (ch.type !== 'added') return;
        const d = ch.doc.data();
        // Only care about NPC-targeted duels
        if (!d.targetId?.startsWith('npc_')) return;
        _showNpcChallengeToast(ch.doc.id, d.challengerName, d.targetName, d.targetId);
      });
    }
  );
}

function _showNpcChallengeToast(duelId, challengerName, npcName, npcId) {
  const toastId = `duel-npc-toast-${duelId}`;
  document.getElementById(toastId)?.remove();
  const t = document.createElement('div');
  t.id        = toastId;
  t.className = 'duel-challenge-toast';
  t.innerHTML = `
    <div class="dct-glow"></div>
    <div class="dct-swords">⚔️</div>
    <div class="dct-body">
      <div class="dct-title">NPC DUEL CHALLENGE!</div>
      <div class="dct-msg"><b>${challengerName}</b> challenges <b>${npcName}</b>!</div>
      <div class="dct-hint">Accept or decline on behalf of the NPC</div>
      <div class="dct-btns">
        <button class="duel-btn duel-btn-accept"  onclick="window.acceptNpcDuel('${duelId}','${npcId}')">⚔ FIGHT</button>
        <button class="duel-btn duel-btn-decline" onclick="window.declineChatDuel('${duelId}');document.getElementById('${toastId}')?.remove()">✕ DECLINE</button>
      </div>
    </div>
    <button class="dct-close" onclick="this.closest('.duel-challenge-toast').remove()">✕</button>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('visible')));
}

// ── Accept a duel challenge on behalf of an NPC ────
export async function acceptNpcDuelChallenge(duelId, npcUid) {
  const uid = _getUid();
  const charData = _getCharData();
  if (!uid || !charData?.isDeity) {
    window.showToast?.('Only a deity can accept on behalf of an NPC.', 'error'); return;
  }

  const duelRef = doc(db, 'chatDuels', duelId);
  const snap    = await getDoc(duelRef);
  if (!snap.exists()) { window.showToast?.('Duel not found.', 'error'); return; }
  const duel = snap.data();

  if (duel.status !== 'pending') { window.showToast?.('Duel already handled.', 'error'); return; }
  if (!duel.targetId?.startsWith('npc_')) { window.showToast?.('Target is not an NPC.', 'error'); return; }

  // Resolve the NPC's data — try local deity cache first, then Firestore
  const resolvedNpcId = (npcUid || duel.targetId).replace('npc_', '');
  let npcData = _findNpcInCache(resolvedNpcId);
  if (!npcData) {
    try {
      const fetchLocId2 = _npcLocId(duel.chatTab, duel.chatLocationId || _chatLocationId || '');
      const npcSnap2 = await getDoc(doc(db, 'npcs', fetchLocId2, 'list', resolvedNpcId));
      if (npcSnap2.exists()) npcData = { id: resolvedNpcId, ...npcSnap2.data() };
    } catch (e2) { console.warn('[Duel] acceptNpcDuelChallenge: could not fetch NPC', e2); }
  }
  npcData = npcData || {};

  // Build combatant from NPC doc fields
  const npcCombatant = _buildCombatant({
    ...npcData,
    hp:      npcData.hp      ?? npcData.hpMax   ?? 120,
    hpMax:   npcData.hpMax   ?? npcData.hp      ?? 120,
    mana:    npcData.mana    ?? npcData.manaMax  ?? 60,
    manaMax: npcData.manaMax ?? npcData.mana     ?? 60,
    str:     npcData.str     ?? 12,
    dex:     npcData.dex     ?? 10,
    int:     npcData.int     ?? 10,
    def:     npcData.def     ?? 6,
  }, duel.targetId);

  // Pick NPC stance — use first stance if available, else auto-build from skills
  let npcStanceName = 'No Stance';
  let npcSkills     = [];
  if (npcData.stances?.length) {
    const s = npcData.stances[0];
    npcStanceName = s.name || 'No Stance';
    npcSkills     = s.skills || [];
  } else if (npcData.skills?.length) {
    // Auto-build: use first 3 skills as a default stance
    npcSkills     = npcData.skills.slice(0, 3);
    npcStanceName = npcData.name ? `${npcData.name}'s Style` : 'Combat Stance';
  }

  const tab   = duel.chatTab        || _chatTab        || 'rp';
  const locId = duel.chatLocationId || _chatLocationId || '';

  const newSnapshot = {
    challengerId:       duel.challengerId      || '',
    challengerName:     duel.challengerName    || '',
    challengerData:     duel.challengerData    || {},
    challengerHp:       duel.challengerHp      ?? duel.challengerData?.hp    ?? 100,
    challengerMana:     duel.challengerMana    ?? duel.challengerData?.mana  ?? 50,
    challengerMaxHp:    duel.challengerMaxHp   ?? duel.challengerData?.maxHp ?? 100,
    challengerMaxMana:  duel.challengerMaxMana ?? duel.challengerData?.maxMana ?? 50,
    challengerStance:   duel.challengerStance  || 'No Stance',
    challengerSkills:   duel.challengerSkills  || [],
    challengerRank:     duel.challengerData?.rank  || 'Wanderer',
    challengerLevel:    duel.challengerData?.level || 1,
    challengerAvatar:   duel.challengerData?.avatarUrl || '',
    targetId:           duel.targetId          || '',
    targetName:         duel.targetName        || '',
    targetData:         npcCombatant,
    targetHp:           npcCombatant.hp,
    targetMana:         npcCombatant.mana,
    targetMaxHp:        npcCombatant.maxHp,
    targetMaxMana:      npcCombatant.maxMana,
    targetStance:       npcStanceName,
    targetSkills:       npcSkills,
    targetRank:         npcCombatant.rank,
    targetLevel:        npcCombatant.level,
    targetAvatar:       npcCombatant.avatarUrl,
    chatTab:            tab,
    chatLocationId:     locId,
    status:             'active',
    round:              1,
    currentTurnUid:     duel.challengerId || '',
    log:                [],
  };

  await updateDoc(duelRef, {
    status:         'active',
    targetData:     npcCombatant,
    targetHp:       npcCombatant.hp,
    targetMana:     npcCombatant.mana,
    targetMaxHp:    npcCombatant.maxHp,
    targetMaxMana:  npcCombatant.maxMana,
    targetStance:   npcStanceName,
    targetSkills:   npcSkills,
    targetRank:     npcCombatant.rank,
    targetLevel:    npcCombatant.level,
    targetAvatar:   npcCombatant.avatarUrl,
    targetName:     npcData.name || duel.targetName || '',
    chatTab:        tab,
    chatLocationId: locId,
    acceptedAt:     serverTimestamp(),
    log:            [],
  });

  const writes = [];
  if (duel.messageId) {
    writes.push(_patchDuelCard(duel.messageId, tab, locId, newSnapshot,
      `⚔️ ${duel.challengerName} VS ${duel.targetName} — THE DUEL HAS BEGUN!`));
  } else {
    writes.push(_postDuelCard(duelId, tab, locId,
      duel.challengerName, duel.targetName, newSnapshot).then(cardRef => {
        if (cardRef) updateDoc(duelRef, { messageId: cardRef.id });
      }));
  }
  writes.push(_postEventBubble(tab, locId, duelId,
    `⚔️ <b>${duel.challengerName}</b> vs <b>${duel.targetName}</b> — the duel has begun! <b>${duel.challengerName}</b> takes the first move.`,
    '🔔'));
  writes.push(_postDuelSnapshot(duelId, tab, locId, newSnapshot));
  await Promise.all(writes);

  window.showToast?.(`⚔️ ${duel.targetName} accepts the challenge!`, '');
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

// ── Equipment stat tables (mirrors dashboard.js — must stay in sync) ─────────
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

// ── Skill registry — canonical source of truth for mana costs and effects.
// Defined here (not just in dashboard.js) so duel.js works correctly on
// both the player dashboard AND the deity dashboard, where dashboard.js
// SKILL_DATA is never loaded.
const SKILL_DATA = {
  // ── Warrior ──
  "Cleave":            { mana:0,  type:"damage",      mult:1.05, stat:"str" },
  "Battle Cry":        { mana:10, type:"buff",         stat:"str",  buffMult:0.20 },
  "Crushing Blow":     { mana:0,  type:"damage",      mult:1.10, stat:"str", defPen:0.10 },
  "War Stomp":         { mana:0,  type:"stun",         mult:1.00, stat:"str" },
  "Bleeding Edge":     { mana:20, type:"dot",          dotPct:0.15, dotTurns:3, stat:"str" },
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
  "Mind Burn":         { mana:20, type:"dot",          dotPct:0.15, dotTurns:3, stat:"int" },
  "Echo-strike":       { mana:25, type:"echo" },
  "Rune Sacrifice":    { mana:20, type:"sacrificial",  selfHpCost:0.20, buffStat:"int", buffMult:0.50 },
  "Meteorfall":        { mana:50, type:"damage",      mult:1.80, stat:"int" },
  "Arcane Shower":     { mana:50, type:"buff",         stat:"int",  buffMult:0.80 },
  "Hex":               { mana:50, type:"dot",          dotPct:0.05, dotTurns:5, stat:"int" },
  // ── Hunter ──
  "Pierce":            { mana:0,  type:"damage",      mult:1.05, stat:"dex" },
  "Hunter's Poison":   { mana:10, type:"dot",          dotPct:0.10, dotTurns:3, stat:"dex" },
  "Quick Shot":        { mana:0,  type:"priority" },
  "Split Arrow":       { mana:20, type:"dot",          dotPct:0.15, dotTurns:3, stat:"dex" },
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
  "Neptune's Embrace": { mana:15, type:"buff",         stat:"int",  buffMult:0.20 },
  "Divine Barrier":    { mana:25, type:"shield",       shieldPct:0.80 },
  "Purify":            { mana:25, type:"cleanse" },
  "Radiant Pulse":     { mana:20, type:"hot",          hotPct:0.10, hotTurns:3 },
  "Life Exchange":     { mana:20, type:"sacrificial",  selfHpCost:0.15, buffStat:"all", buffMult:0.20 },
  "Sanctuary":         { mana:40, type:"hpbuff",       hpMult:0.50 },
  "Divine Ascension":  { mana:50, type:"buff",         stat:"int",  buffMult:0.60 },
  "Lazarus":           { mana:50, type:"heal",         healPct:0.50 },
  // ── Summoner ──
  "Lashing":           { mana:5,  type:"damage",      mult:1.05, stat:"int" },
  "Soul Bind":         { mana:10, type:"stun",         mult:1.00, stat:"int" },
  "Essence Sap":       { mana:10, type:"dot",          dotPct:0.10, dotTurns:4, stat:"int" },
  "Beastmaster":       { mana:25, type:"summon",       summonDmgPct:0.40, summonTurns:3 },
  "Beast Empowerment": { mana:25, type:"summonbuff",   summonBuffMult:0.30 },
  "Usurper":           { mana:25, type:"dot",          dotPct:0.05, dotTurns:4, lifesteal:true, stat:"int" },
  "Offering":          { mana:20, type:"heal",         healPct:0.20 },
  "Leviathan":         { mana:50, type:"summon",       summonDmgPct:1.20, stat:"int", unique:true },
  "Abyssal-touch":     { mana:50, type:"debuff",       debuffType:"defbreak", defReduce:0.40 },
  "Profane Lord":      { mana:50, type:"damage",      mult:2.00, stat:"int" },
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
};;

function _buildCombatant(d, uid) {
  // Firestore rejects undefined — every field must have a concrete fallback
  const resolvedName = d.name || d.charName || d.displayName || '';

  // Player character docs store stats under d.stats; NPC docs may store them flat.
  // Always prefer d.stats.<key> with fallback to flat d.<key>.
  const baseStats = d.stats || {};
  const baseStr = Number(baseStats.str ?? d.str ?? 10);
  const baseDex = Number(baseStats.dex ?? d.dex ?? 8);
  const baseInt = Number(baseStats.int ?? d.int ?? 8);
  const baseDef = Number(baseStats.def ?? d.def ?? 5);

  // Apply equipment bonuses from the character's equipped weapon/armor.
  // EQUIP_WEAPON_STATS and EQUIP_ARMOR_STATS are defined below in duel.js.
  let equipStr = 0, equipDex = 0, equipInt = 0, equipDef = 0;
  if (d.equipment?.weapon) {
    const wBase = d.equipment.weapon.replace(/\s*\+\d+$/, '').trim();
    const w = EQUIP_WEAPON_STATS[wBase];
    if (w) { equipStr += w.str||0; equipDex += w.dex||0; equipInt += w.int||0; equipDef += w.def||0; }
  }
  if (d.equipment?.armor) {
    const aBase = d.equipment.armor.replace(/\s*\+\d+$/, '').trim();
    const a = EQUIP_ARMOR_STATS[aBase];
    if (a) { equipStr += a.str||0; equipDex += a.dex||0; equipInt += a.int||0; equipDef += a.def||0; }
  }
  // Dwarf/Titan race bonus: +10%/+20% to gear stats
  const racePct = _getDuelRaceEquipBonus(d.race);
  if (racePct > 0) {
    equipStr = Math.round(equipStr * (1 + racePct));
    equipDex = Math.round(equipDex * (1 + racePct));
    equipInt = Math.round(equipInt * (1 + racePct));
    equipDef = Math.round(equipDef * (1 + racePct));
  }

  // Race stat bonuses (mirrors dashboard.js _resolveCombatStats)
  const race = (d.race || '').toLowerCase();
  let finalStr = baseStr + equipStr;
  let finalDex = baseDex + equipDex;
  let finalInt = baseInt + equipInt;
  let finalDef = baseDef + equipDef;
  if (race.includes('orc') || race.includes('warlord'))  finalStr = Math.round(finalStr * 1.10);
  if (race.includes('undead') || race.includes('lich'))  finalDef = Math.round(finalDef * 1.10);

  return {
    uid:       uid       || '',
    name:      resolvedName || 'Fighter',
    // NPCs store their image as `avatar`; player chars store it as `avatarUrl`
    avatarUrl: d.avatarUrl || d.avatar || '',
    charClass: d.charClass || 'Warrior',
    rank:      d.rank      || 'Wanderer',
    level:     Number(d.level)  || 1,
    hp:        Number(d.hp    ?? d.hpMax   ?? 100),
    maxHp:     Number(d.hpMax  ?? d.hp     ?? 100),
    mana:      Number(d.mana   ?? d.manaMax ?? 50),
    maxMana:   Number(d.manaMax ?? d.mana   ?? 50),
    str:       finalStr,
    dex:       finalDex,
    int:       finalInt,
    def:       finalDef,
    // Carry stances so acceptNpcDuelChallenge stance fallback works correctly
    stances:   d.stances || [],
  };
}

function _getDuelRaceEquipBonus(race) {
  if (!race) return 0;
  const r = race.toLowerCase();
  if (r.includes('titan')) return 0.20;
  if (r.includes('dwarf')) return 0.10;
  return 0;
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
window.acceptNpcDuel        = async (id, npcUid) => {
  const toastId = `duel-npc-toast-${id}`;
  document.getElementById(toastId)?.remove();
  await acceptNpcDuelChallenge(id, npcUid).catch(e => window.showToast?.(e.message, 'error'));
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
window.acceptNpcDuelChallenge = acceptNpcDuelChallenge;