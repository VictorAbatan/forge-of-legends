// ═══════════════════════════════════════════════════════════════
//  FORGE OF LEGENDS — Cloud Functions
//  functions/index.js
// ═══════════════════════════════════════════════════════════════

// ── IMPORTS (only once, at the very top) ──
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule }         = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { initializeApp }      = require("firebase-admin/app");

initializeApp();
const db = getFirestore();

// ═══════════════════════════════════════════════════════════════
//  STATIC DATA (mirrors docs)
// ═══════════════════════════════════════════════════════════════

const RANK_ORDER = [
  "Wanderer","Follower","Disciple","Master",
  "Exalted","Crown","Supreme","Legend","Myth","Eternal"
];

const RANK_MULTIPLIERS = [1,2,3,4,5,7,9,11,13,15];

const RANK_BASE_EXP = [100,150,225,340,500,750,1100,1600,2300,3200];
const EXP_MULTIPLIER = 1.10;

const MONSTER_STATS = {
  E: { hp:[80,120],    atk:[8,12],    def:[5,10],    dex:[5,10]    },
  D: { hp:[150,220],   atk:[15,22],   def:[10,18],   dex:[10,18]   },
  C: { hp:[300,450],   atk:[30,45],   def:[20,35],   dex:[20,35]   },
  B: { hp:[600,900],   atk:[60,85],   def:[40,65],   dex:[40,65]   },
  A: { hp:[1200,1800], atk:[110,160], def:[80,120],  dex:[80,120]  },
  S: { hp:[2500,4000], atk:[200,300], def:[150,220], dex:[150,220] },
};

const MONSTER_EXP = { E:20, D:50, C:120, B:300, A:700, S:1500 };

const MONSTER_DROPS = {
  E: { coins:[20,30],   resources:[{rarity:"common",chance:0.30}],                                                               potions:[{type:"minor_hp",chance:0.10}],    runestone:{grade:"E",chance:0.05} },
  D: { coins:[40,60],   resources:[{rarity:"common",chance:0.50},{rarity:"uncommon",chance:0.30}],                               potions:[{type:"minor_hp",chance:0.30}],    runestone:{grade:"D",chance:0.05} },
  C: { coins:[80,120],  resources:[{rarity:"common",chance:1.0},{rarity:"uncommon",chance:0.50},{rarity:"rare",chance:0.10}],    potions:[{type:"standard_hp",chance:0.10}], runestone:{grade:"C",chance:0.05} },
  B: { coins:[180,260], resources:[{rarity:"uncommon",chance:1.0},{rarity:"rare",chance:0.50},{rarity:"legendary",chance:0.05}], potions:[{type:"standard_hp",chance:0.30}], runestone:{grade:"B",chance:0.05} },
  A: { coins:[400,550], resources:[{rarity:"rare",chance:1.0},{rarity:"legendary",chance:0.30}],                                 potions:[{type:"greater_hp",chance:0.10}],  runestone:{grade:"A",chance:0.05} },
  S: { coins:[900,1200],resources:[{rarity:"legendary",chance:0.50},{rarity:"mythic",chance:0.10}],                              potions:[{type:"greater_hp",chance:0.30}],  runestone:{grade:"S",chance:0.05} },
};

const RESOURCE_POOLS = {
  common:    ["Iron","Copper","Tin","Blueberry","Apple","Trout","Carp","Mint Leaves","Basil Sprigs","Raw Meat","Tough Hide","Bone Fragments"],
  uncommon:  ["Silver","Bronze","Obsidian","Golden Pear","Moon Grape","Silverfin","Glowfish","Silverleaf","Goldroot","Leather","Fangs"],
  rare:      ["Gold","Mythril","Spirit Plum","Frost Apple","Shadow Fish","Flame Fish","Spirit-Herb","Jade-Vine","Spirit-Venison","Shadow-Hide"],
  legendary: ["Titanium","Adamantium","Celestial Fig","Dragonfruit","Celestial-Whale","Black-Unagi","Phoenix-Bloom","Middlemist-Red","Cyclops-Eye","Dragon Scales"],
  mythic:    ["Aetherium","Eden's Tear","Cosmic Leviathan","Void Orchid","Titan Heart"],
};

const ENCHANT_REQS = {
  E: [{stones:2,coins:100},{stones:4,coins:200},{stones:6,coins:300},{stones:8,coins:400},{stones:10,coins:500}],
  D: [{stones:2,coins:200},{stones:4,coins:300},{stones:6,coins:400},{stones:8,coins:500},{stones:10,coins:600}],
  C: [{stones:2,coins:300},{stones:4,coins:400},{stones:6,coins:500},{stones:8,coins:600},{stones:10,coins:700}],
  B: [{stones:4,coins:500},{stones:6,coins:700},{stones:8,coins:900},{stones:10,coins:1000},{stones:12,coins:1300}],
  A: [{stones:4,coins:600},{stones:6,coins:900},{stones:8,coins:1000},{stones:10,coins:1300},{stones:12,coins:1500}],
  S: [{stones:6,coins:700},{stones:8,coins:1000},{stones:10,coins:1500},{stones:12,coins:2500},{stones:15,coins:4000}],
};

const ENCHANT_SUCCESS_RATES = {
  E:[1.0,0.95,0.85,0.75,0.65],
  D:[1.0,0.95,0.85,0.75,0.65],
  C:[1.0,0.95,0.85,0.75,0.65],
  B:[1.0,0.85,0.70,0.55,0.40],
  A:[1.0,0.85,0.70,0.55,0.40],
  S:[0.70,0.50,0.30,0.10,0.03],
};

const GUILD_RANKS = ["Leader","Officer","Member"];

const CORS_ORIGINS = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://inkcraftrp.web.app",
  "https://inkcraftrp.firebaseapp.com",
];

const CALL_OPTS = { cors: CORS_ORIGINS, region: "europe-west1", invoker: "public" };

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getCharacter(uid) {
  const snap = await db.collection("characters").doc(uid).get();
  if (!snap.exists) throw new HttpsError("not-found", "Character not found.");
  return { id: snap.id, ...snap.data() };
}

function getRankIdx(rank) {
  return Math.max(0, RANK_ORDER.indexOf(rank));
}

function generateMonster(grade, rankIdx) {
  const base  = MONSTER_STATS[grade];
  const multi = RANK_MULTIPLIERS[rankIdx] || 1;
  const names = {
    E: ["Blue-mane Wolf","Five-Fanged Bear","Groundhog Turtle","Twin-faced Serpent","Vicious Gremlin","Rampage Bull"],
    D: ["Flame Spirit","Water Wraith","Stone Golem","Ice Ifrit","Lightning Shroud","Mist Phantom"],
    C: ["Skeletal Beast","Condemned Knight","Revenant Bishop","Ghoul Blatherer","Cursed Fiend","Penitent Priest"],
    B: ["Dark Sphinx","Blue Phoenix","Fallen Cyclops","Cerberus","Blood Kraken"],
    A: ["Profane Priest","Devil Centurion","Demonic Herald","Corrupted Sage","Abomination"],
    S: ["Abyssal Eater","Void Lurker","Chaoswalker","Oblivion Eye","Godless Thing"],
  };
  return {
    grade,
    name:  pick(names[grade] || ["Unknown"]),
    hp:    rand(base.hp[0],  base.hp[1])  * multi,
    maxHp: rand(base.hp[0],  base.hp[1])  * multi,
    atk:   rand(base.atk[0], base.atk[1]) * multi,
    def:   rand(base.def[0], base.def[1]) * multi,
    dex:   rand(base.dex[0], base.dex[1]) * multi,
  };
}

function rollDrops(grade) {
  const table   = MONSTER_DROPS[grade];
  const gold    = rand(table.coins[0], table.coins[1]);
  const rewards = { gold, items: [] };

  table.resources.forEach(r => {
    if (Math.random() < r.chance) {
      const pool = RESOURCE_POOLS[r.rarity] || RESOURCE_POOLS.common;
      rewards.items.push({ name: pick(pool), icon:"📦", type:"material", rarity: r.rarity, qty:1 });
    }
  });

  if (table.potions && Math.random() < table.potions[0].chance) {
    rewards.items.push({ name:"Minor HP Potion", icon:"🧪", type:"consumable", qty:1 });
  }

  if (table.runestone && Math.random() < table.runestone.chance) {
    rewards.items.push({ name:`${table.runestone.grade}-grade Runestone`, icon:"💎", type:"material", qty:1 });
  }

  return rewards;
}

function mergeInventory(inventory, newItems) {
  const inv = [...inventory];
  newItems.forEach(newItem => {
    const existing = inv.find(i => i.name === newItem.name);
    if (existing) existing.qty += newItem.qty;
    else inv.push({ ...newItem });
  });
  return inv;
}

function getPrimaryStat(charClass, stats) {
  const map = { Warrior:"str", Guardian:"def", Arcanist:"int", Hunter:"dex", Assassin:"dex", Cleric:"int", Summoner:"int" };
  return stats[map[charClass] || "str"] || 10;
}

function calcSkillDamage(skillName, stats, currentMana, charClass) {
  const SKILLS = {
    "Cleave":           { dmgPct:1.05, stat:"str", mana:0  },
    "Battle Cry":       { dmgPct:0,    stat:"str", mana:10, effect:"STR +20%" },
    "Crushing Blow":    { dmgPct:1.10, stat:"str", mana:0  },
    "War Stomp":        { dmgPct:0,    stat:"str", mana:0,  effect:"Enemy stunned for 1 turn" },
    "Bleeding Edge":    { dmgPct:0.15, stat:"str", mana:20, effect:"Bleed: +15% STR/turn for 3 turns" },
    "Titan Breaker":    { dmgPct:1.70, stat:"str", mana:50 },
    "Berserker's Oath": { dmgPct:0,    stat:"str", mana:40, effect:"STR +60%, DEX +20%, costs 25% HP" },
    "War God's Fury":   { dmgPct:0,    stat:"str", mana:50, effect:"STR +80%" },
    "Arcane Bolt":      { dmgPct:1.05, stat:"int", mana:5  },
    "Mana Pulse":       { dmgPct:1.00, stat:"int", mana:0  },
    "Astral Lance":     { dmgPct:1.40, stat:"int", mana:25 },
    "Meteorfall":       { dmgPct:1.80, stat:"int", mana:50 },
    "Pierce":           { dmgPct:1.05, stat:"dex", mana:0  },
    "Vital Shot":       { dmgPct:1.35, stat:"dex", mana:0  },
    "Slayer":           { dmgPct:1.70, stat:"dex", mana:0  },
    "Backstab":         { dmgPct:1.20, stat:"dex", mana:0  },
    "Thunder Strike":   { dmgPct:1.35, stat:"dex", mana:0  },
    "Healing Light":    { dmgPct:0,    stat:"int", mana:10, effect:"Restores 15% HP" },
    "Sacred Spark":     { dmgPct:1.05, stat:"int", mana:5  },
    "Lashing":          { dmgPct:1.05, stat:"int", mana:5  },
  };

  const skill = SKILLS[skillName];
  if (!skill) return { error: `Unknown skill: ${skillName}` };
  if (currentMana < skill.mana) return { error: `Not enough mana. Need ${skill.mana}.` };

  const statVal = stats[skill.stat] || 10;
  const damage  = Math.round(statVal * skill.dmgPct);
  return { damage, manaCost: skill.mana, effect: skill.effect || null };
}

function processExp(currentXp, currentXpMax, currentLevel, currentRank, expGain) {
  let xp        = currentXp + expGain;
  let level     = currentLevel;
  let xpMax     = currentXpMax;
  let leveledUp = false;

  while (xp >= xpMax && level < 100) {
    xp -= xpMax;
    level++;
    leveledUp = true;
    xpMax = Math.round(xpMax * EXP_MULTIPLIER);
  }
  if (level >= 100) { level = 100; xp = Math.min(xp, xpMax); }

  return { newXp: xp, newLevel: level, newRank: currentRank, leveledUp, xpMax };
}

function getCraftingRecipes() {
  // Full recipe list mirroring the frontend CANONICAL_* recipe objects.
  // Keyed by npc type — the craftItem function looks up by npc + recipeName.
  // Equipment uses grade sub-keys but the cloud function flattens them into
  // a single blacksmith list for lookup.
  const EQUIP = {
    E: [
      { name:"Rusted Greatsword", type:"weapon", cost:220, requires:[{name:"Iron",qty:5},{name:"Tough Hide",qty:2}] },
      { name:"Crude Bow",         type:"weapon", cost:210, requires:[{name:"Iron",qty:4},{name:"Leather",qty:1}] },
      { name:"Iron Dagger",       type:"weapon", cost:200, requires:[{name:"Iron",qty:4},{name:"Bone Fragments",qty:1}] },
      { name:"Apprentice Wand",   type:"weapon", cost:230, requires:[{name:"Quartz",qty:3},{name:"Animal Fat",qty:2}] },
      { name:"Shortblade",        type:"weapon", cost:210, requires:[{name:"Iron",qty:5}] },
      { name:"Bone Mace",         type:"weapon", cost:215, requires:[{name:"Bone Fragments",qty:4},{name:"Iron",qty:1}] },
      { name:"Hunter Knife",      type:"weapon", cost:210, requires:[{name:"Iron",qty:3},{name:"Fur",qty:1}] },
      { name:"Quartz Rod",        type:"weapon", cost:240, requires:[{name:"Quartz",qty:4},{name:"Limestone",qty:2}] },
      { name:"Tin Blade",         type:"weapon", cost:200, requires:[{name:"Tin",qty:4}] },
      { name:"Feather Knife",     type:"weapon", cost:215, requires:[{name:"Iron",qty:3},{name:"Feathers",qty:2}] },
      { name:"Leather Vest",      type:"armor",  cost:200, requires:[{name:"Leather",qty:4}] },
      { name:"Iron Plate",        type:"armor",  cost:230, requires:[{name:"Iron",qty:5}] },
      { name:"Bone Armor",        type:"armor",  cost:210, requires:[{name:"Bone Fragments",qty:4}] },
      { name:"Fur Coat",          type:"armor",  cost:190, requires:[{name:"Fur",qty:3}] },
      { name:"Hide Armor",        type:"armor",  cost:205, requires:[{name:"Tough Hide",qty:4}] },
      { name:"Feather Cloak",     type:"armor",  cost:190, requires:[{name:"Feathers",qty:3}] },
      { name:"Tin Armor",         type:"armor",  cost:215, requires:[{name:"Tin",qty:4}] },
      { name:"Copper Plate",      type:"armor",  cost:210, requires:[{name:"Copper",qty:4}] },
      { name:"Marble Guard",      type:"armor",  cost:230, requires:[{name:"Marble",qty:3}] },
      { name:"Obsidian Layer",    type:"armor",  cost:240, requires:[{name:"Obsidian",qty:3}] },
    ],
    D: [
      { name:"Obsidian Greatsword", type:"weapon", cost:460, requires:[{name:"Obsidian",qty:5},{name:"Coal",qty:2}] },
      { name:"Silver Wand",         type:"weapon", cost:440, requires:[{name:"Silver",qty:4},{name:"Tough Hide",qty:2}] },
      { name:"Longbow",             type:"weapon", cost:430, requires:[{name:"Leather",qty:5},{name:"Iron",qty:2}] },
      { name:"Twin Daggers",        type:"weapon", cost:435, requires:[{name:"Fangs",qty:5},{name:"Copper",qty:2}] },
      { name:"Warhammer",           type:"weapon", cost:470, requires:[{name:"Bronze",qty:6},{name:"Bone Fragments",qty:2}] },
      { name:"Arc Rod",             type:"weapon", cost:450, requires:[{name:"Quartz",qty:4},{name:"Feathers",qty:3}] },
      { name:"Bronze Blade",        type:"weapon", cost:430, requires:[{name:"Bronze",qty:3},{name:"Leather",qty:2}] },
      { name:"Hunter Bow",          type:"weapon", cost:425, requires:[{name:"Fur",qty:4},{name:"Tin",qty:2}] },
      { name:"Spiked Mace",         type:"weapon", cost:445, requires:[{name:"Marble",qty:5},{name:"Bone Fragments",qty:2}] },
      { name:"Mystic Knife",        type:"weapon", cost:455, requires:[{name:"Claws",qty:3},{name:"Horns",qty:2}] },
      { name:"Steel Armor",         type:"armor",  cost:460, requires:[{name:"Iron",qty:6},{name:"Silver",qty:2}] },
      { name:"Reinforced Leather",  type:"armor",  cost:420, requires:[{name:"Leather",qty:4},{name:"Coal",qty:1}] },
      { name:"Silver Guard",        type:"armor",  cost:450, requires:[{name:"Silver",qty:5},{name:"Animal Fat",qty:1}] },
      { name:"Bone Plate",          type:"armor",  cost:470, requires:[{name:"Bone Fragments",qty:5},{name:"Marble",qty:2}] },
      { name:"Fur Armor",           type:"armor",  cost:410, requires:[{name:"Fur",qty:3},{name:"Limestone",qty:2}] },
      { name:"Horned Armor",        type:"armor",  cost:475, requires:[{name:"Horns",qty:5},{name:"Tin",qty:2}] },
      { name:"Scale Vest",          type:"armor",  cost:445, requires:[{name:"Tough Hide",qty:4},{name:"Silver",qty:2}] },
      { name:"Bronze Armor",        type:"armor",  cost:460, requires:[{name:"Bronze",qty:4},{name:"Copper",qty:2}] },
      { name:"Obsidian Plate",      type:"armor",  cost:480, requires:[{name:"Obsidian",qty:4},{name:"Claws",qty:3}] },
      { name:"Marble Armor",        type:"armor",  cost:440, requires:[{name:"Marble",qty:4},{name:"Bone Fragments",qty:2}] },
    ],
    C: [
      { name:"Silver Greatsword", type:"weapon", cost:820,  requires:[{name:"Silver",qty:7},{name:"Spirit Venison",qty:2}] },
      { name:"Arcane Staff",      type:"weapon", cost:880,  requires:[{name:"Quartz",qty:8},{name:"Shadow Hide",qty:3}] },
      { name:"Composite Bow",     type:"weapon", cost:840,  requires:[{name:"Leather",qty:7},{name:"Gold",qty:3}] },
      { name:"Assassin Daggers",  type:"weapon", cost:860,  requires:[{name:"Fangs",qty:7},{name:"Palladium",qty:2}] },
      { name:"Mystic Blade",      type:"weapon", cost:830,  requires:[{name:"Marble",qty:6},{name:"Spirit Venison",qty:2}] },
      { name:"Warhammer",         type:"weapon", cost:920,  requires:[{name:"Obsidian",qty:8},{name:"Mythril",qty:3}] },
      { name:"Spellknife",        type:"weapon", cost:870,  requires:[{name:"Quartz",qty:7},{name:"Shadow Hide",qty:2}] },
      { name:"Dagon Bow",         type:"weapon", cost:850,  requires:[{name:"Silver",qty:7},{name:"Drake Meat",qty:3}] },
      { name:"Bronze Cleaver",    type:"weapon", cost:810,  requires:[{name:"Bronze",qty:8},{name:"Claws",qty:3}] },
      { name:"Dark Rod",          type:"weapon", cost:890,  requires:[{name:"Obsidian",qty:6},{name:"Mythril",qty:4}] },
      { name:"Steel Plate",       type:"armor",  cost:860,  requires:[{name:"Iron",qty:8},{name:"Mythril",qty:3}] },
      { name:"Shadow Armor",      type:"armor",  cost:840,  requires:[{name:"Shadow Hide",qty:6},{name:"Obsidian",qty:4}] },
      { name:"Mythril Guard",     type:"armor",  cost:900,  requires:[{name:"Mythril",qty:7},{name:"Silver",qty:3}] },
      { name:"Drake Mail",        type:"armor",  cost:880,  requires:[{name:"Drake Meat",qty:5},{name:"Bronze",qty:4}] },
      { name:"Crystal Vest",      type:"armor",  cost:820,  requires:[{name:"Quartz",qty:6},{name:"Silver",qty:4}] },
      { name:"Palladium Plate",   type:"armor",  cost:920,  requires:[{name:"Palladium",qty:7},{name:"Marble",qty:3}] },
      { name:"Ironwood Armor",    type:"armor",  cost:810,  requires:[{name:"Spirit Venison",qty:4},{name:"Iron",qty:6}] },
      { name:"Fang Armor",        type:"armor",  cost:850,  requires:[{name:"Fangs",qty:6},{name:"Leather",qty:5}] },
      { name:"Bone Sovereign",    type:"armor",  cost:870,  requires:[{name:"Bone Fragments",qty:8},{name:"Palladium",qty:3}] },
      { name:"Void Shroud",       type:"armor",  cost:940,  requires:[{name:"Shadow Hide",qty:7},{name:"Mythril",qty:4}] },
    ],
    B: [
      { name:"Goldstrike Blade",   type:"weapon", cost:1800, requires:[{name:"Gold",qty:10},{name:"Mythril",qty:5}] },
      { name:"Titan Bow",          type:"weapon", cost:1750, requires:[{name:"Titanium",qty:8},{name:"Dragon Scales",qty:3}] },
      { name:"Void Scepter",       type:"weapon", cost:1900, requires:[{name:"Adamantium",qty:9},{name:"Cyclops Eye",qty:4}] },
      { name:"Phantom Blade",      type:"weapon", cost:1850, requires:[{name:"Shadow Hide",qty:8},{name:"Mythril",qty:6}] },
      { name:"Runic Hammer",       type:"weapon", cost:1950, requires:[{name:"Titanium",qty:10},{name:"Gold",qty:5}] },
      { name:"Celestial Staff",    type:"weapon", cost:1800, requires:[{name:"Mythril",qty:9},{name:"Spirit Venison",qty:4}] },
      { name:"Soul Reaver",        type:"weapon", cost:1850, requires:[{name:"Adamantium",qty:8},{name:"Shadow Hide",qty:5}] },
      { name:"Dragon Fang",        type:"weapon", cost:1900, requires:[{name:"Dragon Scales",qty:7},{name:"Drake Meat",qty:5}] },
      { name:"Storm Lance",        type:"weapon", cost:1750, requires:[{name:"Titanium",qty:9},{name:"Cyclops Eye",qty:3}] },
      { name:"Abyss Dagger",       type:"weapon", cost:1850, requires:[{name:"Adamantium",qty:7},{name:"Shadow Hide",qty:6}] },
      { name:"Titan Plate",        type:"armor",  cost:1900, requires:[{name:"Titanium",qty:10},{name:"Gold",qty:5}] },
      { name:"Dragon Scale Armor", type:"armor",  cost:2000, requires:[{name:"Dragon Scales",qty:9},{name:"Mythril",qty:5}] },
      { name:"Void Armor",         type:"armor",  cost:1950, requires:[{name:"Adamantium",qty:10},{name:"Cyclops Eye",qty:4}] },
      { name:"Phantom Mail",       type:"armor",  cost:1850, requires:[{name:"Shadow Hide",qty:9},{name:"Mythril",qty:5}] },
      { name:"Runic Guard",        type:"armor",  cost:1900, requires:[{name:"Titanium",qty:8},{name:"Gold",qty:6}] },
      { name:"Celestial Robe",     type:"armor",  cost:1800, requires:[{name:"Mythril",qty:10},{name:"Spirit Venison",qty:4}] },
      { name:"Soul Ward",          type:"armor",  cost:1850, requires:[{name:"Adamantium",qty:9},{name:"Dragon Scales",qty:3}] },
      { name:"Storm Shell",        type:"armor",  cost:1750, requires:[{name:"Titanium",qty:9},{name:"Cyclops Eye",qty:4}] },
      { name:"Abyss Coat",         type:"armor",  cost:1900, requires:[{name:"Adamantium",qty:8},{name:"Shadow Hide",qty:6}] },
      { name:"Dragon Fang Mail",   type:"armor",  cost:1950, requires:[{name:"Dragon Scales",qty:8},{name:"Drake Meat",qty:5}] },
    ],
    A: [
      { name:"Sovereign Blade",   type:"weapon", cost:3800, requires:[{name:"Adamantium",qty:15},{name:"Aetherium",qty:1},{name:"Dragon Scales",qty:8}] },
      { name:"Eclipse Bow",       type:"weapon", cost:3700, requires:[{name:"Titanium",qty:18},{name:"Cyclops Eye",qty:7}] },
      { name:"Void Wand",         type:"weapon", cost:3900, requires:[{name:"Aetherium",qty:1},{name:"Mythril",qty:14},{name:"Shadow Hide",qty:7}] },
      { name:"Dusk Blade",        type:"weapon", cost:3750, requires:[{name:"Adamantium",qty:16},{name:"Shadow Hide",qty:8}] },
      { name:"Titan Maul",        type:"weapon", cost:4000, requires:[{name:"Titanium",qty:20},{name:"Dragon Scales",qty:6}] },
      { name:"Astral Lance",      type:"weapon", cost:3850, requires:[{name:"Aetherium",qty:1},{name:"Mythril",qty:15},{name:"Cyclops Eye",qty:5}] },
      { name:"Death Reaper",      type:"weapon", cost:3900, requires:[{name:"Adamantium",qty:14},{name:"Spirit Venison",qty:8}] },
      { name:"Leviathan Rod",     type:"weapon", cost:3800, requires:[{name:"Titanium",qty:17},{name:"Drake Meat",qty:7}] },
      { name:"Chaos Edge",        type:"weapon", cost:3950, requires:[{name:"Aetherium",qty:1},{name:"Adamantium",qty:13},{name:"Shadow Hide",qty:6}] },
      { name:"Celestial Bow",     type:"weapon", cost:3700, requires:[{name:"Mythril",qty:16},{name:"Cyclops Eye",qty:6}] },
      { name:"Sovereign Plate",   type:"armor",  cost:4000, requires:[{name:"Titanium",qty:20},{name:"Aetherium",qty:1},{name:"Dragon Scales",qty:7}] },
      { name:"Eclipse Mail",      type:"armor",  cost:3800, requires:[{name:"Adamantium",qty:16},{name:"Cyclops Eye",qty:6}] },
      { name:"Void Armor",        type:"armor",  cost:3900, requires:[{name:"Aetherium",qty:1},{name:"Shadow Hide",qty:10},{name:"Mythril",qty:8}] },
      { name:"Dusk Guard",        type:"armor",  cost:3750, requires:[{name:"Adamantium",qty:15},{name:"Shadow Hide",qty:7}] },
      { name:"Titan Shell",       type:"armor",  cost:4100, requires:[{name:"Titanium",qty:22},{name:"Dragon Scales",qty:8}] },
      { name:"Astral Robe",       type:"armor",  cost:3850, requires:[{name:"Aetherium",qty:1},{name:"Mythril",qty:14},{name:"Drake Meat",qty:6}] },
      { name:"Death Ward",        type:"armor",  cost:3950, requires:[{name:"Adamantium",qty:17},{name:"Spirit Venison",qty:7}] },
      { name:"Leviathan Shell",   type:"armor",  cost:3800, requires:[{name:"Titanium",qty:18},{name:"Cyclops Eye",qty:5}] },
      { name:"Chaos Armor",       type:"armor",  cost:3900, requires:[{name:"Aetherium",qty:1},{name:"Adamantium",qty:14},{name:"Dragon Scales",qty:6}] },
      { name:"Celestial Plate",   type:"armor",  cost:3700, requires:[{name:"Mythril",qty:15},{name:"Spirit Venison",qty:8}] },
    ],
    S: [
      { name:"Abjuration", type:"weapon", cost:10500, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Titanium",qty:20},{name:"Palladium",qty:50}] },
      { name:"Genesis",    type:"weapon", cost:10400, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Adamantium",qty:20},{name:"Spirit Venison",qty:50}] },
      { name:"Longinus",   type:"weapon", cost:10300, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Cyclops Eye",qty:20},{name:"Gold",qty:50}] },
      { name:"Jingu Bang", type:"weapon", cost:10600, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Dragon Scales",qty:20},{name:"Mythril",qty:50}] },
      { name:"Ragnarok",   type:"weapon", cost:10400, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Titanium",qty:20},{name:"Shadow Hide",qty:50}] },
      { name:"Godslayer",  type:"weapon", cost:10500, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Adamantium",qty:20},{name:"Spirit Venison",qty:50}] },
      { name:"Durandal",   type:"weapon", cost:10300, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Dragon Scales",qty:20},{name:"Drake Meat",qty:50}] },
      { name:"Excalibur",  type:"weapon", cost:10600, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Dragon Scales",qty:20},{name:"Gold",qty:50}] },
      { name:"Bane",       type:"weapon", cost:10350, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Cyclops Eye",qty:20},{name:"Shadow Hide",qty:50}] },
      { name:"Judgment",   type:"weapon", cost:10450, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Titanium",qty:20},{name:"Mythril",qty:50}] },
      { name:"Saturn",     type:"armor",  cost:10600, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Dragon Scales",qty:20},{name:"Gold",qty:50}] },
      { name:"Unshadowed", type:"armor",  cost:10300, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Cyclops Eye",qty:20},{name:"Spirit Venison",qty:50}] },
      { name:"Null",       type:"armor",  cost:10400, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Titanium",qty:20},{name:"Shadow Hide",qty:50}] },
      { name:"Dominion",   type:"armor",  cost:10700, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Adamantium",qty:20},{name:"Palladium",qty:50}] },
      { name:"Godshroud",  type:"armor",  cost:10500, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Dragon Scales",qty:20},{name:"Gold",qty:50}] },
      { name:"Oblivion",   type:"armor",  cost:10450, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Cyclops Eye",qty:20},{name:"Shadow Hide",qty:50}] },
      { name:"Gungnir",    type:"armor",  cost:10550, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Titanium",qty:20},{name:"Mythril",qty:50}] },
      { name:"Imperium",   type:"armor",  cost:10650, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Dragon Scales",qty:20},{name:"Gold",qty:50}] },
      { name:"Worldshell", type:"armor",  cost:10400, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Adamantium",qty:20},{name:"Spirit Venison",qty:50}] },
      { name:"Eternity",   type:"armor",  cost:10500, requires:[{name:"Aetherium",qty:10},{name:"Titan Heart",qty:10},{name:"Cyclops Eye",qty:20},{name:"Drake Meat",qty:50}] },
    ],
  };

  // Flatten all equipment grades into a single blacksmith list
  const blacksmith = Object.values(EQUIP).flat();

  const alchemist = [
    { name:"Minor HP Potion",       type:"consumable", cost:50,  requires:[{name:"Mint Leaves",qty:2},{name:"Soft Bark",qty:1}] },
    { name:"Standard HP Potion",    type:"consumable", cost:125, requires:[{name:"Silverleaf",qty:2},{name:"Goldroot",qty:1}] },
    { name:"Greater HP Potion",     type:"consumable", cost:250, requires:[{name:"Spirit Herb",qty:2},{name:"Jade Vine",qty:1}] },
    { name:"Minor Mana Potion",     type:"consumable", cost:50,  requires:[{name:"Wild Herbs",qty:2},{name:"Lotus",qty:1}] },
    { name:"Standard Mana Potion",  type:"consumable", cost:125, requires:[{name:"Goldroot",qty:2},{name:"Lotus",qty:2}] },
    { name:"Greater Mana Potion",   type:"consumable", cost:250, requires:[{name:"Spirit Herb",qty:2},{name:"Ghost Root",qty:1}] },
    { name:"Minor Luck Potion",     type:"consumable", cost:50,  requires:[{name:"Basil Sprigs",qty:2},{name:"Mushroom",qty:1}] },
    { name:"Standard Luck Potion",  type:"consumable", cost:125, requires:[{name:"Nightshade",qty:2},{name:"Glowleaf",qty:1}] },
    { name:"Greater Luck Potion",   type:"consumable", cost:250, requires:[{name:"Spirit Herb",qty:2},{name:"Jade Vine",qty:1}] },
    { name:"Minor EXP Potion",      type:"consumable", cost:50,  requires:[{name:"Wild Herbs",qty:2},{name:"Lotus",qty:1}] },
    { name:"Standard EXP Potion",   type:"consumable", cost:125, requires:[{name:"Goldroot",qty:2},{name:"Lotus",qty:2}] },
    { name:"Greater EXP Potion",    type:"consumable", cost:250, requires:[{name:"Spirit Herb",qty:2},{name:"Ghost Root",qty:1}] },
  ];

  const cook = [
    { name:"Grilled Meat Skewer",    type:"consumable", cost:30,  requires:[{name:"Meat",qty:1},{name:"Garlic",qty:1},{name:"Apples",qty:1}] },
    { name:"Spiced Steak",           type:"consumable", cost:60,  requires:[{name:"Meat",qty:2},{name:"Golden Pears",qty:1},{name:"Bitter Root",qty:1}] },
    { name:"Hunter's Feast",         type:"consumable", cost:140, requires:[{name:"Spirit Plum",qty:1},{name:"Shadow Fish",qty:1},{name:"Meat",qty:3}] },
    { name:"Dragonfire Roast",       type:"consumable", cost:350, requires:[{name:"Dragonfruit",qty:1},{name:"Black Unagi",qty:1},{name:"Raw Meat",qty:2}] },
    { name:"Eden Banquet",           type:"consumable", cost:900, requires:[{name:"Eden's Tear",qty:1},{name:"Cosmic Leviathan",qty:1},{name:"Ying Koi",qty:1},{name:"Moon Grapes",qty:1}] },
    { name:"Herb Fish Soup",         type:"consumable", cost:30,  requires:[{name:"Trout",qty:1},{name:"Mushroom",qty:1},{name:"Melons",qty:1}] },
    { name:"Glow Stew",              type:"consumable", cost:60,  requires:[{name:"Glowfish",qty:2},{name:"Moon Grapes",qty:1}] },
    { name:"Mystic Broth",           type:"consumable", cost:140, requires:[{name:"Shadowfish",qty:1},{name:"Spirit Plum",qty:2}] },
    { name:"Celestial Sashimi",      type:"consumable", cost:350, requires:[{name:"Celestial Whale",qty:3},{name:"Celestial Fig",qty:1},{name:"Red Minnow",qty:1}] },
    { name:"Cosmic Infusion",        type:"consumable", cost:900, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Spotted Eel",qty:1},{name:"Sunfruit",qty:1}] },
    { name:"Roasted Carp",           type:"consumable", cost:30,  requires:[{name:"Carp",qty:1},{name:"Garlic",qty:1},{name:"Apples",qty:1}] },
    { name:"Ironbody Stew",          type:"consumable", cost:60,  requires:[{name:"Silverfin",qty:2},{name:"Bitter Root",qty:1}] },
    { name:"Frosthide Meal",         type:"consumable", cost:140, requires:[{name:"Ying Koi",qty:3},{name:"Frost Apples",qty:1}] },
    { name:"Titan Shell Dish",       type:"consumable", cost:350, requires:[{name:"Black Unagi",qty:2},{name:"Dragonfruit",qty:1},{name:"Coral Snapper",qty:1}] },
    { name:"Eternal Fortress Feast", type:"consumable", cost:900, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Flamefish",qty:1},{name:"Glowfish",qty:1}] },
    { name:"Fried Sardine",          type:"consumable", cost:30,  requires:[{name:"Sardine",qty:1},{name:"Blueberries",qty:1},{name:"Melons",qty:1}] },
    { name:"Crystal Splash Meal",    type:"consumable", cost:60,  requires:[{name:"Red Minnow",qty:2},{name:"Crystal Berries",qty:1},{name:"Sunfruit",qty:1}] },
    { name:"Assassin's Dish",        type:"consumable", cost:140, requires:[{name:"Flamefish",qty:3},{name:"Ember Fruit",qty:1}] },
    { name:"Phantom Platter",        type:"consumable", cost:350, requires:[{name:"Black Unagi",qty:1},{name:"Celestial Fig",qty:2},{name:"Golden Pears",qty:1}] },
    { name:"Divine Speed Feast",     type:"consumable", cost:900, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Ember Fruit",qty:1},{name:"Silverfin",qty:1}] },
  ];

  return { blacksmith, alchemist, cook, enchanter: [] };
}

async function requireDeity(uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists || userSnap.data().role !== "deity") {
    throw new HttpsError("permission-denied", "Only Deity accounts can perform this action.");
  }
}

// ═══════════════════════════════════════════════════════════════
//  SCHEDULED CLEANUP: Activity Events (weekly)
// ═══════════════════════════════════════════════════════════════

exports.cleanupOldActivityEvents = onSchedule({
  schedule:  "every sunday 03:00",
  timeZone:  "Europe/London",
  region:    "europe-west1",
}, async () => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const snap   = await db.collection("activityEvents").where("timestamp", "<", new Date(cutoff)).get();
  const batch  = db.batch();
  snap.forEach(d => batch.delete(d.ref));
  if (!snap.empty) await batch.commit();
  console.log(`Deleted ${snap.size} old activity events.`);
  return { deleted: snap.size };
});

// ═══════════════════════════════════════════════════════════════
//  COMBAT FUNCTIONS
// ═══════════════════════════════════════════════════════════════

exports.startBattle = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { grade } = request.data;
  if (!grade || !MONSTER_STATS[grade]) throw new HttpsError("invalid-argument", "Invalid monster grade.");

  const char    = await getCharacter(uid);
  const rankIdx = getRankIdx(char.rank);
  const monster = generateMonster(grade, rankIdx);

  await db.collection("battles").doc(uid).set({
    uid,
    monster,
    playerHp:   char.hp   || 100,
    playerMana: char.mana  || 50,
    turn:       1,
    status:     "active",
    log:        [`⚔️ You encountered a ${monster.name}! (Grade ${grade})`],
    startedAt:  FieldValue.serverTimestamp(),
  });

  return { monster, playerHp: char.hp, playerMana: char.mana };
});

exports.battleTurn = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { action, skillName } = request.data;

  const [battleSnap, charSnap] = await Promise.all([
    db.collection("battles").doc(uid).get(),
    db.collection("characters").doc(uid).get(),
  ]);

  if (!battleSnap.exists) throw new HttpsError("not-found", "No active battle.");
  const battle = battleSnap.data();
  const char   = charSnap.data();

  if (battle.status !== "active") throw new HttpsError("failed-precondition", "Battle is not active.");

  let { monster, playerHp, playerMana, turn, log } = battle;
  const stats = char.stats || { str:10, int:10, def:10, dex:10 };

  if (action === "run") {
    const runCost = 10;
    const newGold = Math.max(0, (char.gold || 0) - runCost);
    await Promise.all([
      db.collection("battles").doc(uid).update({ status: "fled" }),
      db.collection("characters").doc(uid).update({ gold: newGold }),
    ]);
    return { status: "fled", message: `You fled! Lost ${runCost} coins.`, gold: newGold };
  }

  let playerDmg = 0;
  let manaCost  = 0;

  if (action === "melee") {
    const primaryStat = getPrimaryStat(char.charClass, stats);
    playerDmg = Math.max(1, primaryStat - Math.floor(monster.def * 0.5));
    log.push(`⚔️ You attack with melee for ${playerDmg} damage.`);
  } else if (action === "skill" && skillName) {
    const skillResult = calcSkillDamage(skillName, stats, playerMana, char.charClass);
    if (skillResult.error) throw new HttpsError("failed-precondition", skillResult.error);
    playerDmg  = Math.max(1, skillResult.damage - Math.floor(monster.def * 0.3));
    manaCost   = skillResult.manaCost;
    playerMana = Math.max(0, playerMana - manaCost);
    log.push(`✨ You use ${skillName} for ${playerDmg} damage! (${manaCost} mana used)`);
    if (skillResult.effect) log.push(`💫 ${skillResult.effect}`);
  }

  monster.hp = Math.max(0, monster.hp - playerDmg);

  if (monster.hp <= 0) {
    const drops   = rollDrops(monster.grade);
    const expGain = MONSTER_EXP[monster.grade] || 20;
    const inv     = mergeInventory(char.inventory || [], drops.items);
    const newGold = (char.gold || 0) + drops.gold;
    const { newXp, newLevel, newRank, leveledUp, xpMax } = processExp(
      char.xp||0, char.xpMax||100, char.level||1, char.rank||"Wanderer", expGain
    );
    const updates = { hp:playerHp, mana:playerMana, gold:newGold, inventory:inv, xp:newXp, xpMax, level:newLevel, rank:newRank };
    if (leveledUp) {
      updates.statPoints = (char.statPoints||0) + 3;
      updates.hpMax      = (char.hpMax||100) + 10;
      updates.manaMax    = (char.manaMax||50) + 5;
      updates.hp         = updates.hpMax;
      updates.mana       = updates.manaMax;
    }
    await Promise.all([
      db.collection("battles").doc(uid).update({ status:"victory", monster }),
      db.collection("characters").doc(uid).update(updates),
    ]);
    log.push(`💀 ${monster.name} defeated!`);
    log.push(`💰 Gained ${drops.gold} gold!`);
    log.push(`⭐ Gained ${expGain} EXP!`);
    if (drops.items.length) log.push(`🎁 Dropped: ${drops.items.map(i=>i.name).join(", ")}`);
    if (leveledUp) log.push(`🎉 LEVEL UP! Now Level ${newLevel} ${newRank}!`);
    return { status:"victory", log, drops, expGain, leveledUp, newLevel, newRank, updates };
  }

  const monsterDmg = Math.max(1, monster.atk - Math.floor((stats.def||10) * 0.5));
  playerHp = Math.max(0, playerHp - monsterDmg);
  log.push(`👹 ${monster.name} attacks for ${monsterDmg} damage!`);

  if (playerHp <= 0) {
    const halfInv     = (char.inventory||[]).slice(0, Math.floor((char.inventory||[]).length / 2));
    const resurrectAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Promise.all([
      db.collection("battles").doc(uid).update({ status:"defeat" }),
      db.collection("characters").doc(uid).update({ hp:0, mana:playerMana, inventory:halfInv, resurrectAt, isDead:true }),
    ]);
    log.push(`💀 You have been defeated! Resurrect in 24 hours.`);
    log.push(`⚠️ Half your inventory was lost.`);
    return { status:"defeat", log, resurrectAt: resurrectAt.toISOString() };
  }

  await db.collection("battles").doc(uid).update({ monster, playerHp, playerMana, turn: turn+1, log });
  return { status:"ongoing", log, monster, playerHp, playerMana, turn: turn+1 };
});

exports.autoBattle = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { grade, turns } = request.data;
  const maxTurns = Math.min(turns || 10, 20);

  const char     = await getCharacter(uid);
  const rankIdx  = getRankIdx(char.rank);
  const monster  = generateMonster(grade, rankIdx);
  const stats    = char.stats || { str:10, int:10, def:10, dex:10 };
  let playerHp   = char.hp   || 100;
  let playerMana = char.mana  || 50;
  let monsterHp  = monster.hp;
  const log      = [`⚔️ Auto-battle started vs ${monster.name}!`];
  let turnCount  = 0;
  let status     = "ongoing";

  while (turnCount < maxTurns && monsterHp > 0 && playerHp > 0) {
    const primaryStat = getPrimaryStat(char.charClass, stats);
    const playerDmg   = Math.max(1, primaryStat - Math.floor(monster.def * 0.5));
    monsterHp = Math.max(0, monsterHp - playerDmg);
    log.push(`⚔️ Turn ${turnCount+1}: You deal ${playerDmg} damage. Monster HP: ${monsterHp}`);
    if (monsterHp <= 0) { status = "victory"; break; }
    const monsterDmg = Math.max(1, monster.atk - Math.floor((stats.def||10) * 0.5));
    playerHp = Math.max(0, playerHp - monsterDmg);
    log.push(`👹 Monster deals ${monsterDmg} damage. Your HP: ${playerHp}`);
    if (playerHp <= 0) { status = "defeat"; break; }
    turnCount++;
  }

  const updates = { hp: playerHp, mana: playerMana };

  if (status === "victory") {
    const drops   = rollDrops(grade);
    const expGain = MONSTER_EXP[grade] || 20;
    const inv     = mergeInventory(char.inventory||[], drops.items);
    const { newXp, newLevel, newRank, leveledUp, xpMax } = processExp(char.xp||0, char.xpMax||100, char.level||1, char.rank||"Wanderer", expGain);
    updates.gold      = (char.gold||0) + drops.gold;
    updates.inventory = inv;
    updates.xp        = newXp;
    updates.xpMax     = xpMax;
    updates.level     = newLevel;
    updates.rank      = newRank;
    if (leveledUp) {
      updates.statPoints = (char.statPoints||0) + 3;
      updates.hpMax      = (char.hpMax||100) + 10;
      updates.manaMax    = (char.manaMax||50) + 5;
    }
    log.push(`💀 ${monster.name} defeated!`);
    log.push(`💰 +${drops.gold} gold · ⭐ +${expGain} EXP`);
    if (leveledUp) log.push(`🎉 LEVEL UP! Level ${newLevel}!`);
    await db.collection("characters").doc(uid).update(updates);
    return { status:"victory", log, updates, drops, expGain, leveledUp };
  } else if (status === "defeat") {
    const halfInv     = (char.inventory||[]).slice(0, Math.floor((char.inventory||[]).length/2));
    const resurrectAt = new Date(Date.now() + 24*60*60*1000);
    updates.hp          = 0;
    updates.inventory   = halfInv;
    updates.resurrectAt = resurrectAt;
    updates.isDead      = true;
    log.push("💀 You were defeated in auto-battle!");
    await db.collection("characters").doc(uid).update(updates);
    return { status:"defeat", log, resurrectAt: resurrectAt.toISOString() };
  } else {
    await db.collection("characters").doc(uid).update(updates);
    return { status:"ongoing", log, playerHp, playerMana };
  }
});

exports.resurrect = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const char = await getCharacter(uid);
  if (!char.isDead) throw new HttpsError("failed-precondition", "You are not dead.");

  const resurrectAt = char.resurrectAt?.toDate?.() || new Date(char.resurrectAt);
  if (resurrectAt > new Date()) {
    const remaining = Math.ceil((resurrectAt - Date.now()) / 60000);
    throw new HttpsError("failed-precondition", `Cannot resurrect yet. ${remaining} minutes remaining.`);
  }

  await db.collection("characters").doc(uid).update({
    isDead:      false,
    resurrectAt: null,
    hp:          Math.floor((char.hpMax||100) * 0.5),
    mana:        Math.floor((char.manaMax||50) * 0.5),
  });

  return { success: true, message: "You have been resurrected at 50% HP." };
});

// ═══════════════════════════════════════════════════════════════
//  CRAFTING
// ═══════════════════════════════════════════════════════════════

exports.craftItem = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { recipeName, npc } = request.data;
  const RECIPES = getCraftingRecipes();

  // Primary lookup: exact npc key + case-insensitive name match
  const normalised = recipeName?.trim().toLowerCase();
  let recipe = RECIPES[npc]?.find(r => r.name.toLowerCase() === normalised);

  // Fallback: search every NPC list so a wrong npc value never blocks a valid recipe
  if (!recipe) {
    for (const list of Object.values(RECIPES)) {
      recipe = list.find(r => r.name.toLowerCase() === normalised);
      if (recipe) break;
    }
  }

  if (!recipe) throw new HttpsError("not-found", `Recipe not found: ${recipeName}`);

  const char = await getCharacter(uid);
  const inv  = [...(char.inventory||[])];

  for (const req of recipe.requires) {
    const owned = inv.find(i => i.name === req.name);
    if (!owned || owned.qty < req.qty)
      throw new HttpsError("failed-precondition", `Missing materials: need ${req.qty}x ${req.name}, have ${owned?.qty||0}`);
  }
  if ((char.gold||0) < (recipe.cost||0))
    throw new HttpsError("failed-precondition", `Not enough gold. Need ${recipe.cost}, have ${char.gold||0}`);

  for (const req of recipe.requires) {
    const item = inv.find(i => i.name === req.name);
    item.qty -= req.qty;
    if (item.qty <= 0) inv.splice(inv.indexOf(item), 1);
  }

  const typeIcons = { weapon:"⚔️", armor:"🛡️", consumable:"🧪" };
  const crafted = { name: recipe.name, icon: recipe.icon || typeIcons[recipe.type] || "📦", type: recipe.type, qty: 1 };
  const merged  = mergeInventory(inv, [crafted]);

  await db.collection("characters").doc(uid).update({
    inventory: merged,
    gold:      (char.gold||0) - (recipe.cost||0),
  });

  return { success: true, item: crafted, message: `${recipe.name} crafted successfully!` };
});

// ═══════════════════════════════════════════════════════════════
//  ENCHANTMENT
// ═══════════════════════════════════════════════════════════════

exports.enchantItem = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { itemName, itemGrade, currentEnchantLevel } = request.data;
  if (currentEnchantLevel >= 5) throw new HttpsError("failed-precondition", "Item is already at maximum enchant level (+5).");

  const reqs  = ENCHANT_REQS[itemGrade]?.[currentEnchantLevel];
  const rates = ENCHANT_SUCCESS_RATES[itemGrade];
  if (!reqs || !rates) throw new HttpsError("invalid-argument", "Invalid item grade.");

  const successRate   = rates[currentEnchantLevel];
  const runestoneName = `${itemGrade}-grade Runestone`;

  const char = await getCharacter(uid);
  const inv  = [...(char.inventory||[])];

  const runeItem = inv.find(i => i.name === runestoneName);
  if (!runeItem || runeItem.qty < reqs.stones)
    throw new HttpsError("failed-precondition", `Need ${reqs.stones}x ${runestoneName}. Have ${runeItem?.qty||0}.`);
  if ((char.gold||0) < reqs.coins)
    throw new HttpsError("failed-precondition", `Need ${reqs.coins} gold. Have ${char.gold||0}.`);

  const targetItem = inv.find(i => i.name === itemName);
  if (!targetItem) throw new HttpsError("not-found", `${itemName} not in inventory.`);

  runeItem.qty -= reqs.stones;
  if (runeItem.qty <= 0) inv.splice(inv.indexOf(runeItem), 1);
  const newGold = (char.gold||0) - reqs.coins;

  const success = Math.random() < successRate;
  let message, newEnchantLevel = currentEnchantLevel;

  if (success) {
    newEnchantLevel = currentEnchantLevel + 1;
    targetItem.enchantLevel = newEnchantLevel;
    targetItem.name = itemName.replace(/\s*\+\d+$/, "") + ` +${newEnchantLevel}`;
    if (["A","S"].includes(itemGrade) && (newEnchantLevel === 3 || newEnchantLevel === 5)) {
      targetItem.bonusEffect = newEnchantLevel === 3 ? "Minor Effect Unlocked" : "Major Effect Unlocked";
    }
    message = `✨ Enchantment succeeded! ${targetItem.name}`;
  } else {
    message = `💔 Enchantment failed. ${reqs.stones}x ${runestoneName} and ${reqs.coins} gold were consumed.`;
  }

  await db.collection("characters").doc(uid).update({ inventory: inv, gold: newGold });
  return { success, message, newEnchantLevel, successRate: Math.round(successRate * 100), item: targetItem };
});

// ═══════════════════════════════════════════════════════════════
//  RANK ASCENSION
// ═══════════════════════════════════════════════════════════════

exports.ascendRank = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const char    = await getCharacter(uid);
  const rankIdx = getRankIdx(char.rank);

  if (rankIdx >= RANK_ORDER.length - 1) throw new HttpsError("failed-precondition", "Already at maximum rank.");
  if ((char.level||1) < 100) throw new HttpsError("failed-precondition", `Must reach Level 100 before ascending. Currently Level ${char.level||1}.`);

  const INGREDIENTS = {
    "Sah'run":   ["Heart of the Red Phoenix","Gem of Luminance"],
    "Alistor":   ["The Void-Eye","Orb of Silence"],
    "Elionidas": ["Crown of Fortune","Tears of The Endless Goldfish"],
    "Mah'run":   ["Core of a Fallen Star","Fruit of World Tree"],
    "Freyja":    ["Divine Heart Essence","Forgotten Desire Seed"],
    "Arion":     ["Scales of Equilibrium","Adonai Sword"],
    "Veil":      ["Ink of Time","Eye of All-knowing"],
  };

  const required = INGREDIENTS[char.deity];
  if (!required) throw new HttpsError("failed-precondition", "Unknown deity.");

  const qtyNeeded = Math.pow(2, rankIdx);
  const inv = [...(char.inventory||[])];

  for (const ing of required) {
    const owned = inv.find(i => i.name === ing);
    if (!owned || owned.qty < qtyNeeded)
      throw new HttpsError("failed-precondition", `Need ${qtyNeeded}x ${ing}. Have ${owned?.qty||0}.`);
  }
  for (const ing of required) {
    const item = inv.find(i => i.name === ing);
    item.qty -= qtyNeeded;
    if (item.qty <= 0) inv.splice(inv.indexOf(item), 1);
  }

  const newRank    = RANK_ORDER[rankIdx + 1];
  const newHpMax   = (char.hpMax||100)  + 150;
  const newManaMax = (char.manaMax||50) + 75;
  const newBaseXp  = RANK_BASE_EXP[rankIdx + 1] || 150;

  await db.collection("characters").doc(uid).update({
    rank: newRank, level:1, xp:0, xpMax:newBaseXp,
    hpMax:newHpMax, hp:newHpMax, manaMax:newManaMax, mana:newManaMax,
    statPoints:(char.statPoints||0)+25, inventory:inv,
  });

  return { success:true, newRank, message:`🎉 You have ascended to ${newRank}!`, newHpMax, newManaMax };
});

// ═══════════════════════════════════════════════════════════════
//  GUILD SYSTEM
// ═══════════════════════════════════════════════════════════════

exports.createGuild = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { name, description, avatarUrl } = request.data;
  if (!name || name.length < 3 || name.length > 30)
    throw new HttpsError("invalid-argument", "Guild name must be 3-30 characters.");

  const GUILD_COST = 500;
  const char = await getCharacter(uid);

  if ((char.gold||0) < GUILD_COST) throw new HttpsError("failed-precondition", `Creating a guild costs ${GUILD_COST} gold. You have ${char.gold||0}.`);
  if (char.guildId) throw new HttpsError("failed-precondition", "You are already in a guild.");

  const existing = await db.collection("guilds").where("name","==",name).get();
  if (!existing.empty) throw new HttpsError("already-exists", "Guild name already taken.");

  const guildRef = db.collection("guilds").doc();

  await Promise.all([
    guildRef.set({
      name, description:description||"", avatarUrl:avatarUrl||"",
      leaderId:uid, members:[{uid, name:char.name, rank:"Leader", joinedAt:new Date()}],
      memberCount:1, createdAt:FieldValue.serverTimestamp(), missions:[], gold:0,
    }),
    db.collection("characters").doc(uid).update({
      guildId:guildRef.id, guildName:name, guildRank:"Leader",
      gold:(char.gold||0)-GUILD_COST,
    }),
  ]);

  return { success:true, guildId:guildRef.id, name, message:`Guild "${name}" created!` };
});

exports.joinGuild = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { guildId } = request.data;
  const char = await getCharacter(uid);
  if (char.guildId) throw new HttpsError("failed-precondition", "Already in a guild. Leave first.");

  const guildSnap = await db.collection("guilds").doc(guildId).get();
  if (!guildSnap.exists) throw new HttpsError("not-found", "Guild not found.");
  const guild = guildSnap.data();

  await Promise.all([
    db.collection("guilds").doc(guildId).update({
      members:     FieldValue.arrayUnion({ uid, name:char.name, rank:"Member", joinedAt:new Date() }),
      memberCount: FieldValue.increment(1),
    }),
    db.collection("characters").doc(uid).update({ guildId, guildName:guild.name, guildRank:"Member" }),
  ]);

  return { success:true, guildName:guild.name, message:`Joined "${guild.name}"!` };
});

exports.leaveGuild = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const char = await getCharacter(uid);
  if (!char.guildId) throw new HttpsError("failed-precondition", "Not in a guild.");

  const guildSnap = await db.collection("guilds").doc(char.guildId).get();
  if (!guildSnap.exists) throw new HttpsError("not-found", "Guild not found.");

  const guild   = guildSnap.data();
  const members = (guild.members||[]).filter(m => m.uid !== uid);

  if (guild.leaderId === uid && members.length > 0)
    throw new HttpsError("failed-precondition", "Transfer leadership before leaving.");

  const ops = [
    db.collection("characters").doc(uid).update({ guildId:null, guildName:null, guildRank:null }),
  ];
  if (members.length === 0) {
    ops.push(db.collection("guilds").doc(char.guildId).delete());
  } else {
    ops.push(db.collection("guilds").doc(char.guildId).update({ members, memberCount:members.length }));
  }

  await Promise.all(ops);
  return { success:true, message:"You left the guild." };
});

exports.promoteGuildMember = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { targetUid, newRank } = request.data;
  if (!GUILD_RANKS.includes(newRank)) throw new HttpsError("invalid-argument", "Invalid rank.");

  const char = await getCharacter(uid);
  if (!char.guildId) throw new HttpsError("failed-precondition", "Not in a guild.");
  if (char.guildRank !== "Leader" && char.guildRank !== "Officer")
    throw new HttpsError("permission-denied", "Only Leaders and Officers can promote members.");

  const guildSnap = await db.collection("guilds").doc(char.guildId).get();
  const guild     = guildSnap.data();
  const members   = (guild.members||[]).map(m => m.uid === targetUid ? { ...m, rank:newRank } : m);

  await Promise.all([
    db.collection("guilds").doc(char.guildId).update({ members }),
    db.collection("characters").doc(targetUid).update({ guildRank:newRank }),
  ]);

  return { success:true, message:`Member promoted to ${newRank}.` };
});

exports.createGuildMission = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { title, description, reward } = request.data;
  const char = await getCharacter(uid);
  if (!char.guildId) throw new HttpsError("failed-precondition", "Not in a guild.");
  if (char.guildRank !== "Leader" && char.guildRank !== "Officer")
    throw new HttpsError("permission-denied", "Only Leaders and Officers can create missions.");

  const mission = {
    id:          db.collection("_").doc().id,
    title, description, reward,
    createdBy:   char.name,
    createdAt:   new Date(),
    completedBy: null,
    status:      "active",
  };

  await db.collection("guilds").doc(char.guildId).update({ missions: FieldValue.arrayUnion(mission) });
  return { success:true, mission };
});

// ═══════════════════════════════════════════════════════════════
//  DEITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

exports.sendDivineVision = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");
  await requireDeity(uid);

  const { targetUid, message, type } = request.data;
  if (!targetUid || !message) throw new HttpsError("invalid-argument", "Missing targetUid or message.");

  const charSnap = await db.collection("characters").doc(uid).get();
  const charData = charSnap.data() || {};
  const deityName = (charData.name || charData.charClass || "").trim() || "Unknown Deity";

  await db.collection("divineVisions").doc(targetUid).collection("messages").add({
    message,
    type:      type || "knowledge",
    deityUid:  uid,
    deityName,
    from:      deityName,
    read:      false,
    sentAt:    FieldValue.serverTimestamp(),
  });

  return { success:true, message:"Divine vision sent." };
});

exports.bestowResources = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");
  await requireDeity(uid);

  const { targetUid, items, gold } = request.data;
  const targetChar = await getCharacter(targetUid);
  const inv        = mergeInventory(targetChar.inventory||[], items||[]);

  await db.collection("characters").doc(targetUid).update({
    inventory: inv,
    gold:      (targetChar.gold||0) + (gold||0),
  });
  return { success:true, message:`Resources bestowed upon ${targetChar.name}.` };
});

exports.createWorldEvent = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");
  await requireDeity(uid);

  const { title, description, type, duration, rewards } = request.data;
  const charSnap = await db.collection("characters").doc(uid).get();

  const eventRef = await db.collection("worldEvents").add({
    title, description,
    type:         type || "rp_plotline",
    createdBy:    charSnap.data()?.name || "A Deity",
    deityUid:     uid,
    status:       "active",
    participants: [],
    rewards:      rewards || [],
    expiresAt:    duration ? new Date(Date.now() + duration * 60 * 60 * 1000) : null,
    createdAt:    FieldValue.serverTimestamp(),
  });

  return { success:true, eventId:eventRef.id, message:`World event "${title}" created!` };
});

exports.updateFaithLevel = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");
  await requireDeity(uid);

  const { targetUid, amount } = request.data;
  const targetChar = await getCharacter(targetUid);
  const newFaith   = Math.max(0, (targetChar.faithLevel||0) + (amount||1));

  await db.collection("characters").doc(targetUid).update({ faithLevel: newFaith });
  return { success:true, newFaith, message:`Faith level updated to ${newFaith}.` };
});

// ═══════════════════════════════════════════════════════════════
//  DAILY QUEST REWARD CLAIM
// ═══════════════════════════════════════════════════════════════

exports.claimQuestReward = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { questKey } = request.data;
  const QUEST_REWARDS = {
    hunter:   { exp:10, gold:50,  items:[{ name:"Common Resource", icon:"📦", type:"material",  qty:1 }] },
    gatherer: { exp:10, gold:50,  items:[{ name:"Minor HP Potion",  icon:"🧪", type:"consumable", qty:1 }] },
    market:   { exp:10, gold:60,  items:[{ name:"Common Food",      icon:"🍖", type:"consumable", qty:1 }] },
    potions:  { exp:10, gold:50,  items:[{ name:"Common Resource",  icon:"📦", type:"material",   qty:1 }] },
    food:     { exp:10, gold:50,  items:[{ name:"Minor HP Potion",  icon:"🧪", type:"consumable", qty:1 }] },
    explorer: { exp:20, gold:80,  items:[{ name:"Common Resource",  icon:"📦", type:"material",   qty:2 }] },
    elite:    { exp:20, gold:100, items:[{ name:"Common Resource",  icon:"📦", type:"material",   qty:2 }] },
    bonus:    { exp:0,  gold:200, items:[] },
  };

  const reward = QUEST_REWARDS[questKey];
  if (!reward) throw new HttpsError("invalid-argument", "Invalid quest key.");

  const questSnap = await db.collection("dailyQuests").doc(uid).get();
  if (!questSnap.exists) throw new HttpsError("not-found", "Quest data not found.");

  const questData = questSnap.data();
  const today     = new Date().toDateString();
  if (questData.date !== today) throw new HttpsError("failed-precondition", "Quests have reset.");

  const claimed = questData.claimed || [];
  if (claimed.includes(questKey)) throw new HttpsError("already-exists", "Reward already claimed.");

  const char = await getCharacter(uid);
  const inv  = mergeInventory(char.inventory||[], reward.items);
  const { newXp, newLevel, newRank, leveledUp, xpMax } = processExp(
    char.xp||0, char.xpMax||100, char.level||1, char.rank||"Wanderer", reward.exp
  );

  await Promise.all([
    db.collection("characters").doc(uid).update({
      gold:(char.gold||0)+reward.gold, inventory:inv,
      xp:newXp, xpMax, level:newLevel, rank:newRank,
    }),
    db.collection("dailyQuests").doc(uid).update({ claimed: FieldValue.arrayUnion(questKey) }),
  ]);

  return { success:true, reward, newGold:(char.gold||0)+reward.gold, leveledUp, newLevel, newRank };
});

// ═══════════════════════════════════════════════════════════════
//  PLAYER MARKET — Buy Listing
// ═══════════════════════════════════════════════════════════════

exports.buyListing = onCall(CALL_OPTS, async (request) => {
  const buyerUid = request.auth?.uid;
  if (!buyerUid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { listingId, qty } = request.data;
  if (!listingId || !qty || qty < 1) throw new HttpsError("invalid-argument", "Invalid listing or quantity.");

  const listingRef = db.collection("marketListings").doc(listingId);
  const buyerRef   = db.collection("characters").doc(buyerUid);

  return await db.runTransaction(async (tx) => {
    const [listingSnap, buyerSnap] = await Promise.all([
      tx.get(listingRef),
      tx.get(buyerRef),
    ]);

    if (!listingSnap.exists) throw new HttpsError("not-found", "Listing no longer exists.");

    const listing = listingSnap.data();
    const buyer   = buyerSnap.data();

    if (listing.sellerUid === buyerUid) throw new HttpsError("failed-precondition", "Cannot buy your own listing.");
    if (listing.qty < qty) throw new HttpsError("failed-precondition", `Only ${listing.qty} left in stock.`);

    const totalPrice = listing.pricePerUnit * qty;
    if ((buyer.gold||0) < totalPrice) throw new HttpsError("failed-precondition", "Not enough gold.");

    const sellerRef = db.collection("characters").doc(listing.sellerUid);

    const buyerInv = [...(buyer.inventory||[])];
    const existing = buyerInv.find(i => i.name === listing.itemName);
    if (existing) {
      existing.qty += qty;
    } else {
      buyerInv.push({ name:listing.itemName, icon:listing.itemIcon||"📦", type:listing.itemType||"material", qty });
    }

    tx.update(buyerRef,   { gold: FieldValue.increment(-totalPrice), inventory: buyerInv });
    tx.update(sellerRef,  { gold: FieldValue.increment(totalPrice)  });
    tx.update(listingRef, { qty:  FieldValue.increment(-qty)         });

    tx.set(db.collection("notifications").doc(), {
      uid:       listing.sellerUid,
      type:      "sale",
      message:   `💰 ${buyer.name} bought ${qty}× ${listing.itemName} for ${totalPrice} coins!`,
      coins:     totalPrice,
      timestamp: FieldValue.serverTimestamp(),
      read:      false,
    });

    return { success:true, totalPrice, itemName:listing.itemName, qty };
  });
});

// ═══════════════════════════════════════════════════════════════
//  AUTO-ARCHIVE WORLD EVENTS (onCreate trigger)
// ═══════════════════════════════════════════════════════════════
exports.autoArchiveWorldEvents = require('./autoArchiveWorldEvents').autoArchiveWorldEvents;