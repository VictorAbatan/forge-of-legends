// Simple duel stun flow simulator
const events = [];
const updatesLog = [];
function _postEventBubble(tab, locId, duelId, richText, icon){
  events.push({richText, icon});
  return Promise.resolve();
}
function updateDoc(ref, updates){
  updatesLog.push(updates);
  return Promise.resolve();
}

async function simulate() {
  const duel = { id: 'testduel', currentTurnUid: 'attacker', round: 1, challengerId: 'attacker', challengerName: 'Attacker', targetId: 'defender', challengerName2: 'Attacker' };
  let challengerHp = 100, targetHp = 100;
  let challengerState = {}, targetState = {};

  // Attacker uses stun skill
  const meDisplayName = 'Attacker';
  const oppDisplayName = 'Defender';
  // applyDamage (simplified)
  const dmg = 10;
  targetHp = Math.max(0, targetHp - dmg);
  // apply stun and announce immediately
  targetState.stunned = true;
  targetState.stunAnnounced = true;
  await _postEventBubble(null, null, duel.id, `💫 <b>${oppDisplayName}</b> is stunned and will lose their next turn!`, '💫');
  // update doc to reflect damage and state; attacker retains initiative (currentTurnUid unchanged)
  await updateDoc(duel.id, { round: duel.round, currentTurnUid: duel.currentTurnUid, challengerHp, targetHp, challengerState, targetState });
  // action bubble then next turn bell
  await _postEventBubble(null, null, duel.id, `<b>${meDisplayName}</b> uses STUN for ${dmg} damage and stuns!`, '⚔️');
  await _postEventBubble(null, null, duel.id, `🔔 Round ${duel.round} — <b>${meDisplayName}</b>'s turn!`, '🔔');

  // Attacker attacks again (retains initiative) - simple melee
  const dmg2 = 12;
  targetHp = Math.max(0, targetHp - dmg2);
  await updateDoc(duel.id, { challengerHp, targetHp, challengerState, targetState });
  await _postEventBubble(null, null, duel.id, `<b>${meDisplayName}</b> strikes again for ${dmg2}!`, '⚔️');
  await _postEventBubble(null, null, duel.id, `🔔 Round ${duel.round} — <b>${meDisplayName}</b>'s turn!`, '🔔');

  // Now Defender attempts to act; doDuelTurn stun branch behavior
  // My state is defender's state
  let myState = targetState;
  const hadAnnounced = !!myState.stunAnnounced;
  // consume stun
  myState = { ...myState, stunned: false, stunAnnounced: false };
  const stunNextUid = 'attacker';
  const stunNextName = 'Attacker';
  const stunRound = duel.round + 1;
  await updateDoc(duel.id, { round: stunRound, currentTurnUid: stunNextUid, targetState: myState });
  if (!hadAnnounced) {
    await _postEventBubble(null, null, duel.id, `💫 <b>Defender</b> is stunned and loses their turn!`, '💫');
  }
  await _postEventBubble(null, null, duel.id, `🔔 Round ${stunRound} — <b>${stunNextName}</b>'s turn!`, '🔔');

  console.log('--- Event Log ---');
  events.forEach((e, i) => console.log(`${i+1}. ${e.icon} ${e.richText}`));
  console.log('\n--- Updates Log ---');
  updatesLog.forEach((u, i) => console.log(`${i+1}. ${JSON.stringify(u)}`));
}

simulate().catch(e => console.error(e));
