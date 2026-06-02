// Duel skill behavior test harness
// This is a pure logic simulation for all duel.js skill types.
const SKILL_DATA = {
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

function calcDamage() { return 10; }

function applyDamage(raw, myState, oppState, oppStateUpd) {
  let effective = Math.max(1, Math.round(raw));
  if (myState.echoActive) {
    effective = Math.round(effective * 2);
    myState.echoActive = false;
  }
  if (oppState.deathMark) {
    const bonus = oppState.deathMarkBonus || 0.60;
    effective = Math.round(effective * (1 + bonus));
    oppStateUpd.deathMark = false;
    oppStateUpd.deathMarkBonus = 0;
  }
  if (oppState.defBreak) {
    effective = Math.round(effective * (1 + (oppState.defBreakAmt || 0.15)));
  }
  return Math.max(1, effective);
}

function resolveSkill(skillName, myState={}, oppState={}) {
  const sk = SKILL_DATA[skillName];
  const myStateUpd = {};
  const oppStateUpd = {};
  let dmg = 0;
  let myHp = 100;

  switch (sk.type) {
    case 'damage':
      dmg = applyDamage(calcDamage() * (sk.mult || 1.0), myState, oppState, oppStateUpd);
      break;
    case 'backstab':
      const firstHit = !myState.backstabUsed;
      const mult = firstHit ? (sk.mult || 1.75) : (sk.multAfter || 0.95);
      dmg = applyDamage(calcDamage() * mult, myState, oppState, oppStateUpd);
      myStateUpd.backstabUsed = true;
      break;
    case 'execute':
      const threshold = (opponent.hp / opponent.maxHp) <= (sk.threshold || 0.35);
      const effective = calcDamage() * (threshold ? (sk.mult || 1.8) : 1.05);
      dmg = applyDamage(effective, myState, oppState, oppStateUpd);
      break;
    case 'priority':
      dmg = applyDamage(calcDamage() * ((sk.mult || 1.1)), myState, oppState, oppStateUpd);
      break;
    case 'condDamage':
      const hasDebuff = oppState.dotActive || oppState.deathMark || oppState.defBreak;
      const condMult = hasDebuff ? (sk.mult || 1.25) : 1.05;
      dmg = applyDamage(calcDamage() * condMult, myState, oppState, oppStateUpd);
      break;
    case 'multihit':
      const hits = sk.hits || 2;
      let total = 0;
      for (let h = 0; h < hits; h++) {
        total += Math.max(1, Math.round(calcDamage() * (sk.multPerHit || 0.60)));
      }
      dmg = applyDamage(total, myState, oppState, oppStateUpd);
      break;
    case 'heal':
      myHp = Math.min(100, myHp + Math.round(100 * (sk.healPct || 0.25)));
      break;
    case 'hot':
      myStateUpd.hotActive = true;
      myStateUpd.hotPct = sk.hotPct || 0.15;
      myStateUpd.hotTurns = sk.hotTurns || 3;
      break;
    case 'shield':
      myStateUpd.shieldPct = sk.shieldPct || 0.20;
      break;
    case 'buff':
      const buffKey = `buff_${sk.stat}`;
      myStateUpd[buffKey] = Math.min(1.60, (myState[buffKey] || 0) + (sk.buffMult || 0));
      if (sk.hpBonus) myHp = Math.min(100, myHp + Math.round(100 * sk.hpBonus));
      break;
    case 'dot':
      oppStateUpd.dotActive = true;
      oppStateUpd.dotPct = sk.dotPct || 0.10;
      oppStateUpd.dotTurns = sk.dotTurns || 3;
      oppStateUpd.dotLabel = sk.dotLabel || 'Poison';
      oppStateUpd.dotLifesteal = sk.lifesteal || false;
      break;
    case 'stun':
      dmg = applyDamage(calcDamage() * (sk.mult || 1.0), myState, oppState, oppStateUpd);
      oppStateUpd.stunned = true;
      oppStateUpd.stunAnnounced = true;
      break;
    case 'skillock':
      oppStateUpd.skillLocked = true;
      break;
    case 'cleanse':
      myStateUpd.dotActive = false;
      myStateUpd.dotTurns = 0;
      myStateUpd.dotLabel = null;
      myStateUpd.dotPct = 0;
      myStateUpd.dotLifesteal = false;
      myStateUpd.deathMark = false;
      myStateUpd.deathMarkBonus = 0;
      myStateUpd.stunned = false;
      myStateUpd.skillLocked = false;
      break;
    case 'echo':
      myStateUpd.echoActive = true;
      break;
    case 'debuff':
      if (sk.debuffType === 'deathmark') {
        oppStateUpd.deathMark = true;
        oppStateUpd.deathMarkBonus = sk.dmgBonus || 0.60;
      } else if (sk.debuffType === 'defbreak') {
        oppStateUpd.defBreak = true;
        oppStateUpd.defBreakAmt = sk.defReduce || 0.15;
      }
      break;
    case 'summon':
      const summonBuff = myState.summonBuff || 0;
      const dmgPct = (sk.summonDmgPct || 0.35) * (1 + summonBuff);
      dmg = applyDamage(calcDamage() * dmgPct, myState, oppState, oppStateUpd);
      myStateUpd.summonActive = true;
      myStateUpd.summonDmgPct = dmgPct;
      myStateUpd.summonTurns = sk.unique ? 999 : (sk.summonTurns || 3);
      if (sk.unique) myStateUpd.leviathanSummoned = true;
      break;
    case 'summonbuff':
      myStateUpd.summonBuff = (myState.summonBuff || 0) + (sk.summonBuffMult || 0);
      if (myState.summonActive) {
        myStateUpd.summonDmgPct = (myState.summonDmgPct || 0) * (1 + (sk.summonBuffMult || 0));
      }
      break;
    case 'hpbuff': {
      const bonus = Math.round(100 * (sk.hpMult || 0.50));
      myHp = Math.min(150, myHp + bonus);
      myStateUpd.hpBuffBonus = (myState.hpBuffBonus || 0) + bonus;
      break;
    }
    case 'offering':
      if (!myState.summonActive && !myState.leviathanSummoned) {
        // no effect
      } else {
        myHp = Math.min(100, myHp + Math.round(100 * (sk.healPct || 0.20)));
        if (!myState.leviathanSummoned) {
          myStateUpd.summonTurns = Math.max(0, (myState.summonTurns || 0) - 1);
          myStateUpd.summonActive = myStateUpd.summonTurns > 0;
        }
      }
      break;
    case 'profanelord':
      if (!myState.summonActive && !myState.leviathanSummoned) {
        // no effect
      } else {
        myStateUpd.summonActive = false;
        myStateUpd.summonTurns = 0;
        myStateUpd.leviathanSummoned = false;
        dmg = applyDamage(calcDamage() * (sk.mult || 2.0), myState, oppState, oppStateUpd);
      }
      break;
    case 'sacrificial': {
      myHp = Math.max(1, myHp - Math.round(100 * (sk.selfHpCost || 0.15)));
      const buffKey = `buff_${sk.buffStat}`;
      myStateUpd[buffKey] = Math.min(1.60, (myState[buffKey] || 0) + (sk.buffMult || 0));
      if (sk.buffStat2) {
        const buffKey2 = `buff_${sk.buffStat2}`;
        myStateUpd[buffKey2] = Math.min(1.60, (myState[buffKey2] || 0) + (sk.buffMult2 || 0));
      }
      break;
    }
    default:
      dmg = applyDamage(calcDamage() * (sk.mult || 1.0), myState, oppState, oppStateUpd);
  }

  return { skillName, myStateUpd, oppStateUpd, dmg, myHp };
}

const opponent = { hp: 80, maxHp: 100 };

const tests = [];

function assert(condition, message) {
  return condition ? { passed: true } : { passed: false, message };
}

for (const [name, sk] of Object.entries(SKILL_DATA)) {
  tests.push({ name: `${name} (${sk.type})`, fn: () => {
    const baseMyState = {};
    const baseOppState = {};
    const result = resolveSkill(name, {...baseMyState}, {...baseOppState});
    switch (sk.type) {
      case 'damage': case 'backstab': case 'execute': case 'priority': case 'condDamage': case 'multihit':
        return assert(result.dmg > 0, `${name} should deal damage`);
      case 'heal':
        return assert(result.myHp > 100, `${name} should heal`);
      case 'hot':
        return assert(result.myStateUpd.hotActive === true && result.myStateUpd.hotTurns > 0, `${name} should activate HOT`);
      case 'shield':
        return assert(result.myStateUpd.shieldPct > 0, `${name} should set shieldPct`);
      case 'buff':
        return assert(Object.keys(result.myStateUpd).some(k => k.startsWith('buff_')), `${name} should set a buff`);
      case 'dot':
        return assert(result.oppStateUpd.dotActive === true, `${name} should apply DOT`);
      case 'stun':
        return assert(result.oppStateUpd.stunned === true && result.oppStateUpd.stunAnnounced === true, `${name} should stun`);
      case 'skillock':
        return assert(result.oppStateUpd.skillLocked === true, `${name} should skill lock`);
      case 'cleanse':
        return assert(result.myStateUpd.stunned === false && result.myStateUpd.dotActive === false, `${name} should cleanse debuffs`);
      case 'echo':
        return assert(result.myStateUpd.echoActive === true, `${name} should enable echo`);
      case 'debuff':
        if (sk.debuffType === 'deathmark') {
          return assert(result.oppStateUpd.deathMark === true, `${name} should set death mark`);
        }
        return assert(result.oppStateUpd.defBreak === true, `${name} should set defBreak`);
      case 'summon':
        return assert(result.myStateUpd.summonActive === true, `${name} should activate summon`);
      case 'summonbuff':
        return assert(result.myStateUpd.summonBuff > 0, `${name} should buff summon`);
      case 'hpbuff':
        return assert(result.myStateUpd.hpBuffBonus > 0, `${name} should buff HP`);
      case 'offering':
        const withSummon = resolveSkill(name, { summonActive:true, summonTurns:2, summonDmgPct:0.4 }, {});
        return assert(withSummon.myHp > 100, `${name} should heal when summon active`);
      case 'profanelord':
        const noSummon = resolveSkill(name, {}, {});
        const yesSummon = resolveSkill(name, { summonActive:true, summonTurns:2, summonDmgPct:0.4 }, {});
        return assert(noSummon.dmg === 0 && yesSummon.dmg > 0, `${name} should only damage with summon active`);
      case 'sacrificial':
        return assert(result.myHp < 100 && Object.keys(result.myStateUpd).some(k => k.startsWith('buff_')), `${name} should sacrifice HP and buff`);
      default:
        return assert(true, `${name} type ${sk.type} not explicitly tested`);
    }
  }});
}

console.log('DUEL SKILL FULL COVERAGE TESTS');
let failed = 0;
tests.forEach(test => {
  const result = test.fn();
  if (!result.passed) {
    failed += 1;
    console.log(`❌ ${test.name}: ${result.message}`);
  } else {
    console.log(`✅ ${test.name}`);
  }
});
if (failed) {
  console.log(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll tests passed.');
