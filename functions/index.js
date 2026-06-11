// ═══════════════════════════════════════════════════════════════
//  FORGE OF LEGENDS — Cloud Functions
//  functions/index.js
// ═══════════════════════════════════════════════════════════════

// ── IMPORTS (only once, at the very top) ──
const { onCall, HttpsError }        = require("firebase-functions/v2/https");
const { onSchedule }                = require("firebase-functions/v2/scheduler");
const { onDocumentUpdated }         = require("firebase-functions/v2/firestore");
const { getFirestore, FieldValue }  = require("firebase-admin/firestore");
const { initializeApp }             = require("firebase-admin/app");

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

// ── Profession-specific resource pools ──────────────────────────────────────
// Monster drop loot is filtered to the character's profession so a Hunter
// never receives mining ores and a Miner never receives hunting materials.
// Falls back to the global RESOURCE_POOLS if profession is unknown.
const PROFESSION_RESOURCE_POOLS = {
  Miner:    {
    common:    ["Iron","Copper","Tin","Limestone","Coal"],
    uncommon:  ["Silver","Bronze","Obsidian","Marble","Quartz"],
    rare:      ["Gold","Mythril","Palladium"],
    legendary: ["Titanium","Adamantium"],
    mythic:    ["Aetherium"],
  },
  Forager:  {
    common:    ["Blueberries","Apples","Garlic","Mushroom","Melons"],
    uncommon:  ["Golden Pears","Moon Grapes","Sunfruit","Crystal Berries","Bitter Root"],
    rare:      ["Spirit Plum","Frost Apples","Ember Fruit"],
    legendary: ["Celestial Fig","Dragonfruit"],
    mythic:    ["Eden's Tear"],
  },
  Angler:   {
    common:    ["Trout","Carp","Catfish","Sardine","Pufferfish"],
    uncommon:  ["Silverfin","Glowfish","Spotted Eel","Coral Snapper","Red Minnow"],
    rare:      ["Shadow Fish","Flame Fish","Ying Koi"],
    legendary: ["Celestial-Whale","Black-Unagi"],
    mythic:    ["Cosmic Leviathan"],
  },
  Herbalist:{
    common:    ["Mint Leaves","Basil Sprigs","Wild Herbs","Soft Bark","Wood"],
    uncommon:  ["Silverleaf","Goldroot","Nightshade","Glowleaf","Lotus"],
    rare:      ["Spirit-Herb","Jade-Vine","Ghost Root"],
    legendary: ["Phoenix-Bloom","Middlemist-Red"],
    mythic:    ["Void Orchid"],
  },
  Hunter:   {
    common:    ["Raw Meat","Tough Hide","Bone Fragments","Feathers","Animal Fat"],
    uncommon:  ["Leather","Fangs","Fur","Horns","Claws"],
    rare:      ["Spirit-Venison","Shadow-Hide","Drake Meat"],
    legendary: ["Dragon Scales","Cyclops-Eye"],
    mythic:    ["Titan Heart"],
  },
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
  "https://victorabatan.github.io",
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

// Safe read-modify-write for inventory (and any other char fields).
// Retries automatically on contention. Use instead of getCharacter + .update()
// whenever the write includes inventory to prevent race-condition clobbers.
async function withCharTransaction(uid, fn) {
  const charRef = db.collection("characters").doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(charRef);
    if (!snap.exists) throw new HttpsError("not-found", "Character not found.");
    const char = { id: snap.id, ...snap.data() };
    const updates = await fn(char, tx);
    if (updates && Object.keys(updates).length > 0) {
      tx.update(charRef, updates);
    }
    return updates;
  });
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

// profession is optional — if provided (e.g. char.profession) drops are filtered
// to only include resources that belong to that profession. Falls back to the
// global pool so callers that don't pass profession still work correctly.
function rollDrops(grade, profession) {
  const table   = MONSTER_DROPS[grade];
  const gold    = rand(table.coins[0], table.coins[1]);
  const rewards = { gold, items: [] };

  // Choose the right pool: profession-specific if available, global otherwise
  const profPools = (profession && PROFESSION_RESOURCE_POOLS[profession]) || null;

  table.resources.forEach(r => {
    if (Math.random() < r.chance) {
      const pool = (profPools && profPools[r.rarity] && profPools[r.rarity].length > 0)
        ? profPools[r.rarity]
        : (RESOURCE_POOLS[r.rarity] || RESOURCE_POOLS.common);
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

function makeIid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function isEquipmentType(type) {
  return type === "weapon" || type === "armor";
}
function mergeInventory(inventory, newItems) {
  const inv = [...inventory];
  newItems.forEach(newItem => {
    if (isEquipmentType(newItem.type)) {
      // Each equipment piece is unique — never stack, always push with a fresh iid
      const qty = newItem.qty || 1;
      for (let i = 0; i < qty; i++) {
        inv.push({ ...newItem, qty: 1, iid: makeIid() });
      }
    } else {
      const existing = inv.find(i => i.name === newItem.name);
      if (existing) existing.qty += newItem.qty;
      else inv.push({ ...newItem });
    }
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
  // PRICES: synced from CANONICAL_EQUIP_RECIPES in dashboard.js (authoritative source).
  const EQUIP = {
    E: [
      { name:"Rusted Greatsword", type:"weapon", cost:2200,  requires:[{name:"Iron",qty:10},{name:"Tough Hide",qty:4}] },
      { name:"Crude Bow",         type:"weapon", cost:2100,  requires:[{name:"Iron",qty:8},{name:"Leather",qty:2}] },
      { name:"Iron Dagger",       type:"weapon", cost:2000,  requires:[{name:"Iron",qty:8},{name:"Bone Fragments",qty:2}] },
      { name:"Apprentice Wand",   type:"weapon", cost:2300,  requires:[{name:"Quartz",qty:6},{name:"Animal Fat",qty:4}] },
      { name:"Shortblade",        type:"weapon", cost:2100,  requires:[{name:"Iron",qty:10}] },
      { name:"Bone Mace",         type:"weapon", cost:2150,  requires:[{name:"Bone Fragments",qty:8},{name:"Iron",qty:2}] },
      { name:"Hunter Knife",      type:"weapon", cost:2100,  requires:[{name:"Iron",qty:6},{name:"Fur",qty:4}] },
      { name:"Quartz Rod",        type:"weapon", cost:2400,  requires:[{name:"Quartz",qty:8},{name:"Limestone",qty:4}] },
      { name:"Tin Blade",         type:"weapon", cost:2000,  requires:[{name:"Tin",qty:10}] },
      { name:"Feather Knife",     type:"weapon", cost:2150,  requires:[{name:"Iron",qty:6},{name:"Feathers",qty:4}] },
      { name:"Leather Vest",      type:"armor",  cost:2000,  requires:[{name:"Leather",qty:10}] },
      { name:"Iron Plate",        type:"armor",  cost:2300,  requires:[{name:"Iron",qty:10}] },
      { name:"Bone Armor",        type:"armor",  cost:2100,  requires:[{name:"Bone Fragments",qty:10}] },
      { name:"Fur Coat",          type:"armor",  cost:1900,  requires:[{name:"Fur",qty:9}] },
      { name:"Hide Armor",        type:"armor",  cost:2050,  requires:[{name:"Tough Hide",qty:10}] },
      { name:"Feather Cloak",     type:"armor",  cost:1900,  requires:[{name:"Feathers",qty:9}] },
      { name:"Tin Armor",         type:"armor",  cost:2150,  requires:[{name:"Tin",qty:10}] },
      { name:"Copper Plate",      type:"armor",  cost:2100,  requires:[{name:"Copper",qty:10}] },
      { name:"Marble Guard",      type:"armor",  cost:2300,  requires:[{name:"Marble",qty:12}] },
      { name:"Obsidian Layer",    type:"armor",  cost:2400,  requires:[{name:"Obsidian",qty:15}] },
    ],
    D: [
      { name:"Obsidian Greatsword", type:"weapon", cost:8600,  requires:[{name:"Obsidian",qty:20},{name:"Coal",qty:10}] },
      { name:"Silver Wand",         type:"weapon", cost:8400,  requires:[{name:"Silver",qty:20},{name:"Tough Hide",qty:8}] },
      { name:"Longbow",             type:"weapon", cost:8300,  requires:[{name:"Leather",qty:20},{name:"Iron",qty:8}] },
      { name:"Twin Daggers",        type:"weapon", cost:8350,  requires:[{name:"Fangs",qty:20},{name:"Copper",qty:8}] },
      { name:"Warhammer",           type:"weapon", cost:8700,  requires:[{name:"Bronze",qty:25},{name:"Bone Fragments",qty:10}] },
      { name:"Arc Rod",             type:"weapon", cost:8500,  requires:[{name:"Quartz",qty:20},{name:"Feathers",qty:12}] },
      { name:"Bronze Blade",        type:"weapon", cost:8300,  requires:[{name:"Bronze",qty:15},{name:"Leather",qty:10}] },
      { name:"Hunter Bow",          type:"weapon", cost:8250,  requires:[{name:"Fur",qty:15},{name:"Tin",qty:10}] },
      { name:"Spiked Mace",         type:"weapon", cost:8450,  requires:[{name:"Marble",qty:20},{name:"Bone Fragments",qty:10}] },
      { name:"Mystic Knife",        type:"weapon", cost:8550,  requires:[{name:"Claws",qty:15},{name:"Horns",qty:10}] },
      { name:"Steel Armor",         type:"armor",  cost:8600,  requires:[{name:"Iron",qty:20},{name:"Silver",qty:10}] },
      { name:"Reinforced Leather",  type:"armor",  cost:8200,  requires:[{name:"Leather",qty:14},{name:"Coal",qty:8}] },
      { name:"Silver Guard",        type:"armor",  cost:8500,  requires:[{name:"Silver",qty:20},{name:"Animal Fat",qty:10}] },
      { name:"Bone Plate",          type:"armor",  cost:8700,  requires:[{name:"Bone Fragments",qty:25},{name:"Marble",qty:10}] },
      { name:"Fur Armor",           type:"armor",  cost:8100,  requires:[{name:"Fur",qty:10},{name:"Limestone",qty:10}] },
      { name:"Horned Armor",        type:"armor",  cost:8750,  requires:[{name:"Horns",qty:28},{name:"Tin",qty:15}] },
      { name:"Scale Vest",          type:"armor",  cost:8450,  requires:[{name:"Tough Hide",qty:15},{name:"Silver",qty:10}] },
      { name:"Bronze Armor",        type:"armor",  cost:8600,  requires:[{name:"Bronze",qty:20},{name:"Copper",qty:15}] },
      { name:"Obsidian Plate",      type:"armor",  cost:8800,  requires:[{name:"Obsidian",qty:30},{name:"Claws",qty:10}] },
      { name:"Marble Armor",        type:"armor",  cost:8400,  requires:[{name:"Marble",qty:20},{name:"Bone Fragments",qty:10}] },
    ],
    C: [
      { name:"Silver Greatsword", type:"weapon", cost:32800,  requires:[{name:"Silver",qty:56},{name:"Spirit Venison",qty:16}] },
      { name:"Arcane Staff",      type:"weapon", cost:35200,  requires:[{name:"Quartz",qty:64},{name:"Shadow Hide",qty:24}] },
      { name:"Composite Bow",     type:"weapon", cost:33600,  requires:[{name:"Leather",qty:56},{name:"Gold",qty:24}] },
      { name:"Assassin Daggers",  type:"weapon", cost:34400,  requires:[{name:"Fangs",qty:55},{name:"Palladium",qty:16}] },
      { name:"Mystic Blade",      type:"weapon", cost:33200,  requires:[{name:"Marble",qty:48},{name:"Spirit Venison",qty:16}] },
      { name:"War Maul",          type:"weapon", cost:36800,  requires:[{name:"Obsidian",qty:64},{name:"Mythril",qty:24}] },
      { name:"Spellknife",        type:"weapon", cost:34800,  requires:[{name:"Quartz",qty:56},{name:"Shadow Hide",qty:16}] },
      { name:"Dagon Bow",         type:"weapon", cost:34000,  requires:[{name:"Silver",qty:56},{name:"Drake Meat",qty:24}] },
      { name:"Bronze Cleaver",    type:"weapon", cost:33600,  requires:[{name:"Bronze",qty:40},{name:"Palladium",qty:24}] },
      { name:"Dark Rod",          type:"weapon", cost:38000,  requires:[{name:"Quartz",qty:56},{name:"Obsidian",qty:40}] },
      { name:"Shining Armor",     type:"armor",  cost:36000,  requires:[{name:"Silver",qty:64},{name:"Spirit Venison",qty:40}] },
      { name:"Bronze Cuirass",    type:"armor",  cost:37200,  requires:[{name:"Bronze",qty:72},{name:"Gold",qty:50}] },
      { name:"Jagged Chainmail",  type:"armor",  cost:35200,  requires:[{name:"Claws",qty:56},{name:"Palladium",qty:24}] },
      { name:"Bone Fortress",     type:"armor",  cost:37600,  requires:[{name:"Horns",qty:72},{name:"Mythril",qty:40}] },
      { name:"Obsidian Vest",     type:"armor",  cost:38400,  requires:[{name:"Obsidian",qty:80},{name:"Shadow Hide",qty:40}] },
      { name:"Reptilian Scale",   type:"armor",  cost:35600,  requires:[{name:"Marble",qty:56},{name:"Drake Meat",qty:32}] },
      { name:"Shadow Cloak",      type:"armor",  cost:34400,  requires:[{name:"Fur",qty:48},{name:"Shadow Hide",qty:24}] },
      { name:"Golden Cape",       type:"armor",  cost:33600,  requires:[{name:"Leather",qty:48},{name:"Gold",qty:16}] },
      { name:"Warlord Hide",      type:"armor",  cost:36400,  requires:[{name:"Horns",qty:64},{name:"Palladium",qty:40}] },
      { name:"Arcane Shell",      type:"armor",  cost:39200,  requires:[{name:"Obsidian",qty:80},{name:"Spirit Venison",qty:48}] },
    ],
    B: [
      { name:"Myth-Blade",       type:"weapon", cost:163000, requires:[{name:"Mythril",qty:150},{name:"Adamantium",qty:50}] },
      { name:"High-Scepter",     type:"weapon", cost:163500, requires:[{name:"Spirit Venison",qty:170},{name:"Adamantium",qty:50}] },
      { name:"Draconic Bow",     type:"weapon", cost:160000, requires:[{name:"Drake Meat",qty:150},{name:"Dragon Scales",qty:40}] },
      { name:"Shadow-Strike",    type:"weapon", cost:163200, requires:[{name:"Shadow Hide",qty:140},{name:"Titanium",qty:50}] },
      { name:"Warbreaker",       type:"weapon", cost:166000, requires:[{name:"Palladium",qty:190},{name:"Titanium",qty:60}] },
      { name:"Mystic Jian",      type:"weapon", cost:163400, requires:[{name:"Spirit Venison",qty:140},{name:"Dragon Scales",qty:50}] },
      { name:"Phantom Longbow",  type:"weapon", cost:163100, requires:[{name:"Gold",qty:160},{name:"Cyclops Eye",qty:30}] },
      { name:"Spellhammer",      type:"weapon", cost:163600, requires:[{name:"Shadow Hide",qty:180},{name:"Cyclops Eye",qty:30}] },
      { name:"Venom Daggers",    type:"weapon", cost:163300, requires:[{name:"Palladium",qty:150},{name:"Adamantium",qty:40}] },
      { name:"Ancient Wand",     type:"weapon", cost:166200, requires:[{name:"Mythril",qty:200},{name:"Cyclops Eye",qty:40}] },
      { name:"Void-Spell Armor",    type:"armor",  cost:166000, requires:[{name:"Shadow Hide",qty:170},{name:"Titanium",qty:100}] },
      { name:"Golden Scales",       type:"armor",  cost:163000, requires:[{name:"Gold",qty:150},{name:"Dragon Scales",qty:70}] },
      { name:"Night Cloak",         type:"armor",  cost:163500, requires:[{name:"Shadow Hide",qty:140},{name:"Cyclops Eye",qty:90}] },
      { name:"Spirit-Ward",         type:"armor",  cost:166500, requires:[{name:"Spirit Venison",qty:180},{name:"Adamantium",qty:120}] },
      { name:"Paladin's Mantle",    type:"armor",  cost:160800, requires:[{name:"Palladium",qty:100},{name:"Dragon Scales",qty:60}] },
      { name:"Draconic Robe",       type:"armor",  cost:163200, requires:[{name:"Drake Meat",qty:150},{name:"Dragon Scales",qty:70}] },
      { name:"Titanic Hide",        type:"armor",  cost:169500, requires:[{name:"Palladium",qty:200},{name:"Titanium",qty:150}] },
      { name:"Golden Warplate",     type:"armor",  cost:166800, requires:[{name:"Gold",qty:200},{name:"Adamantium",qty:120}] },
      { name:"Mythic Cuirass",      type:"armor",  cost:163400, requires:[{name:"Mythril",qty:140},{name:"Cyclops Eye",qty:70}] },
      { name:"Quintessence Mantle", type:"armor",  cost:169000, requires:[{name:"Spirit Venison",qty:200},{name:"Shadow Hide",qty:150}] },
    ],
    A: [
      { name:"Eragon-blade",  type:"weapon", cost:684000, requires:[{name:"Dragon Scales",qty:360},{name:"Adamantium",qty:144},{name:"Palladium",qty:120}] },
      { name:"Void-Steel",    type:"weapon", cost:682000, requires:[{name:"Cyclops Eye",qty:396},{name:"Titanium",qty:120},{name:"Shadow Hide",qty:108}] },
      { name:"Star Lance",    type:"weapon", cost:688000, requires:[{name:"Dragon Scales",qty:420},{name:"Aetherium",qty:12}] },
      { name:"Crack",         type:"weapon", cost:682500, requires:[{name:"Adamantium",qty:324},{name:"Titanium",qty:144},{name:"Mythril",qty:168}] },
      { name:"Divine Fall",   type:"weapon", cost:684500, requires:[{name:"Cyclops Eye",qty:372},{name:"Dragon Scales",qty:144},{name:"Gold",qty:120}] },
      { name:"Nether-Bow",    type:"weapon", cost:682000, requires:[{name:"Adamantium",qty:324},{name:"Titanium",qty:120},{name:"Shadow Hide",qty:108}] },
      { name:"Holy Relic",    type:"weapon", cost:690000, requires:[{name:"Dragon Scales",qty:360},{name:"Titan Heart",qty:12},{name:"Aetherium",qty:12}] },
      { name:"Realm Cleaver", type:"weapon", cost:686500, requires:[{name:"Titanium",qty:384},{name:"Titan Heart",qty:12},{name:"Mythril",qty:144}] },
      { name:"BeastFang",     type:"weapon", cost:684000, requires:[{name:"Dragon Scales",qty:360},{name:"Adamantium",qty:120},{name:"Drake Meat",qty:84}] },
      { name:"Scion",         type:"weapon", cost:686000, requires:[{name:"Cyclops Eye",qty:372},{name:"Aetherium",qty:12},{name:"Spirit Venison",qty:120}] },
      { name:"Heart Hide",        type:"armor",  cost:686000, requires:[{name:"Adamantium",qty:396},{name:"Titan Heart",qty:24}] },
      { name:"Destroyer Mantle",  type:"armor",  cost:690000, requires:[{name:"Titanium",qty:432},{name:"Aetherium",qty:24},{name:"Gold",qty:84}] },
      { name:"Chaos-garb",        type:"armor",  cost:682500, requires:[{name:"Cyclops Eye",qty:312},{name:"Dragon Scales",qty:120},{name:"Shadow Hide",qty:108}] },
      { name:"Devastator Armor",  type:"armor",  cost:680000, requires:[{name:"Adamantium",qty:288},{name:"Cyclops Eye",qty:120},{name:"Drake Meat",qty:108}] },
      { name:"Tectonic-Mail",     type:"armor",  cost:684500, requires:[{name:"Titanium",qty:360},{name:"Aetherium",qty:12}] },
      { name:"Elemental Shroud",  type:"armor",  cost:686500, requires:[{name:"Cyclops Eye",qty:384},{name:"Aetherium",qty:12},{name:"Mythril",qty:204}] },
      { name:"Colossal Veil",     type:"armor",  cost:688500, requires:[{name:"Titanium",qty:420},{name:"Dragon Scales",qty:156},{name:"Shadow Hide",qty:132}] },
      { name:"Realm-Bound Tunic", type:"armor",  cost:684000, requires:[{name:"Dragon Scales",qty:360},{name:"Cyclops Eye",qty:144},{name:"Spirit Venison",qty:120}] },
      { name:"Serpentine-Robe",   type:"armor",  cost:680500, requires:[{name:"Adamantium",qty:300},{name:"Cyclops Eye",qty:120},{name:"Drake Meat",qty:108}] },
      { name:"Vasto-Shell",       type:"armor",  cost:688000, requires:[{name:"Titanium",qty:240},{name:"Titan Heart",qty:12},{name:"Aetherium",qty:12}] },
    ],
    S: [
      { name:"Abjuration", type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Palladium",qty:700}] },
      { name:"Genesis",    type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Adamantium",qty:280},{name:"Spirit Venison",qty:700}] },
      { name:"Longinus",   type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Gold",qty:700}] },
      { name:"Jingu Bang", type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Mythril",qty:700}] },
      { name:"Ragnarok",   type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Shadow Hide",qty:700}] },
      { name:"Godslayer",  type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Adamantium",qty:280},{name:"Spirit Venison",qty:700}] },
      { name:"Durandal",   type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Drake Meat",qty:700}] },
      { name:"Excalibur",  type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Gold",qty:700}] },
      { name:"Bane",       type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Shadow Hide",qty:700}] },
      { name:"Judgment",   type:"weapon", cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Mythril",qty:700}] },
      { name:"Saturn",     type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Gold",qty:700}] },
      { name:"Unshadowed", type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Spirit Venison",qty:700}] },
      { name:"Null",       type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Shadow Hide",qty:700}] },
      { name:"Dominion",   type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Adamantium",qty:280},{name:"Palladium",qty:700}] },
      { name:"Godshroud",  type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Gold",qty:700}] },
      { name:"Oblivion",   type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Shadow Hide",qty:700}] },
      { name:"Gungnir",    type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Titanium",qty:280},{name:"Mythril",qty:700}] },
      { name:"Imperium",   type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Dragon Scales",qty:280},{name:"Gold",qty:700}] },
      { name:"Worldshell", type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Adamantium",qty:280},{name:"Spirit Venison",qty:700}] },
      { name:"Eternity",   type:"armor",  cost:2800000, requires:[{name:"Aetherium",qty:140},{name:"Titan Heart",qty:140},{name:"Cyclops Eye",qty:280},{name:"Drake Meat",qty:700}] },
    ],
  };

  // Flatten all equipment grades into a single blacksmith list
  const blacksmith = Object.values(EQUIP).flat();

  const alchemist = [
    // ── HP Potions ───────────────────────────────────────────────────────────
    { name:"Minor HP Potion",       type:"consumable", cost:100,  requires:[{name:"Mint Leaves",qty:2},{name:"Wood",qty:2},{name:"Silverleaf",qty:2}] },
    { name:"Standard HP Potion",    type:"consumable", cost:500,  requires:[{name:"Goldroot",qty:2},{name:"Spirit Herb",qty:2}] },
    { name:"Greater HP Potion",     type:"consumable", cost:1000, requires:[{name:"Phoenix Bloom",qty:2},{name:"Void Orchid",qty:2}] },
    // ── Mana Potions ─────────────────────────────────────────────────────────
    { name:"Minor Mana Potion",     type:"consumable", cost:100,  requires:[{name:"Wild Herbs",qty:2},{name:"Wood",qty:2},{name:"Lotus",qty:2}] },
    { name:"Standard Mana Potion",  type:"consumable", cost:500,  requires:[{name:"Glowleaf",qty:2},{name:"Ghost Root",qty:2}] },
    { name:"Greater Mana Potion",   type:"consumable", cost:1000, requires:[{name:"Middlemist",qty:2},{name:"Void Orchid",qty:2}] },
    // ── Luck Potions ─────────────────────────────────────────────────────────
    { name:"Minor Luck Potion",     type:"consumable", cost:100,  requires:[{name:"Basil Sprigs",qty:2},{name:"Wood",qty:2},{name:"Nightshade",qty:2}] },
    { name:"Standard Luck Potion",  type:"consumable", cost:500,  requires:[{name:"Goldroot",qty:2},{name:"Jade Vine",qty:2}] },
    { name:"Greater Luck Potion",   type:"consumable", cost:1000, requires:[{name:"Middlemist",qty:1},{name:"Phoenix Bloom",qty:1},{name:"Void Orchid",qty:1}] },
    // ── EXP (Insight) Potions ────────────────────────────────────────────────
    { name:"Minor EXP Potion",      type:"consumable", cost:100,  requires:[{name:"Soft Bark",qty:2},{name:"Wood",qty:2},{name:"Glowleaf",qty:2}] },
    { name:"Standard EXP Potion",   type:"consumable", cost:500,  requires:[{name:"Nightshade",qty:2},{name:"Lotus",qty:2}] },
    { name:"Greater EXP Potion",    type:"consumable", cost:1000, requires:[{name:"Silverleaf",qty:1},{name:"Middlemist",qty:1},{name:"Phoenix Bloom",qty:1},{name:"Void Orchid",qty:1}] },
  ];

  const cook = [
    // ── Strength Foods ───────────────────────────────────────────────────────
    { name:"Grilled Meat Skewer",    type:"consumable", cost:300,   requires:[{name:"Raw Meat",qty:5},{name:"Garlic",qty:2},{name:"Apples",qty:2}] },
    { name:"Spiced Steak",           type:"consumable", cost:900,   requires:[{name:"Raw Meat",qty:5},{name:"Golden Pears",qty:2},{name:"Bitter Root",qty:2}] },
    { name:"Hunter's Feast",        type:"consumable", cost:2700,  requires:[{name:"Raw Meat",qty:5},{name:"Spirit Plum",qty:2},{name:"Shadowfish",qty:2}] },
    { name:"Dragonfire Roast",       type:"consumable", cost:8100,  requires:[{name:"Raw Meat",qty:5},{name:"Dragonfruit",qty:2},{name:"Black Unagi",qty:2}] },
    { name:"Eden Banquet",           type:"consumable", cost:24300, requires:[{name:"Eden's Tear",qty:1},{name:"Cosmic Leviathan",qty:1},{name:"Red Minnow",qty:5},{name:"Crystal Berries",qty:5}] },
    // ── Intelligence Foods ───────────────────────────────────────────────────
    { name:"Herb Fish Soup",         type:"consumable", cost:300,   requires:[{name:"Trout",qty:5},{name:"Garlic",qty:2},{name:"Melons",qty:2}] },
    { name:"Glow Stew",              type:"consumable", cost:900,   requires:[{name:"Pufferfish",qty:5},{name:"Glowfish",qty:2},{name:"Moon Grapes",qty:2}] },
    { name:"Mystic Broth",           type:"consumable", cost:2700,  requires:[{name:"Catfish",qty:5},{name:"Shadowfish",qty:2},{name:"Spirit Plum",qty:2}] },
    { name:"Celestial Sashimi",      type:"consumable", cost:8100,  requires:[{name:"Mushroom",qty:5},{name:"Celestial Whale",qty:2},{name:"Celestial Fig",qty:2}] },
    { name:"Cosmic Infusion",        type:"consumable", cost:24300, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Spotted Eel",qty:5},{name:"Sunfruit",qty:5}] },
    // ── Defense Foods ────────────────────────────────────────────────────────
    { name:"Roasted Carp",           type:"consumable", cost:300,   requires:[{name:"Carp",qty:5},{name:"Apples",qty:2},{name:"Mushroom",qty:2}] },
    { name:"Ironbody Stew",          type:"consumable", cost:900,   requires:[{name:"Bone Fragments",qty:5},{name:"Silverfin",qty:2},{name:"Coral Snapper",qty:2}] },
    { name:"Frosthide Meal",         type:"consumable", cost:2700,  requires:[{name:"Tough Hide",qty:5},{name:"Ying Koi",qty:2},{name:"Frost Apples",qty:2}] },
    { name:"Titan Shell Dish",       type:"consumable", cost:8100,  requires:[{name:"Blueberries",qty:5},{name:"Black Unagi",qty:2},{name:"Dragonfruit",qty:2}] },
    { name:"Eternal Fortress Feast", type:"consumable", cost:24300, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Silverfin",qty:5},{name:"Moon Grapes",qty:5}] },
    // ── Dexterity Foods ──────────────────────────────────────────────────────
    { name:"Fried Sardine",          type:"consumable", cost:300,   requires:[{name:"Sardine",qty:5},{name:"Blueberries",qty:2},{name:"Melons",qty:2}] },
    { name:"Crystal Splash Meal",    type:"consumable", cost:900,   requires:[{name:"Melon",qty:5},{name:"Crystal Berries",qty:2},{name:"Sunfruit",qty:2}] },
    { name:"Assassin's Dish",       type:"consumable", cost:2700,  requires:[{name:"Garlic",qty:5},{name:"Flamefish",qty:2},{name:"Ember Fruit",qty:2}] },
    { name:"Phantom Platter",        type:"consumable", cost:8100,  requires:[{name:"Feathers",qty:5},{name:"Black Unagi",qty:2},{name:"Celestial Fig",qty:2}] },
    { name:"Divine Speed Feast",     type:"consumable", cost:24300, requires:[{name:"Cosmic Leviathan",qty:1},{name:"Eden's Tear",qty:1},{name:"Golden Pears",qty:5},{name:"Coral Snapper",qty:5}] },
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

  // Read battle doc (no transaction needed — only this client writes it)
  const battleSnap = await db.collection("battles").doc(uid).get();
  if (!battleSnap.exists) throw new HttpsError("not-found", "No active battle.");
  const battle = battleSnap.data();
  if (battle.status !== "active") throw new HttpsError("failed-precondition", "Battle is not active.");

  // Read char for stats/class — used for damage calc only, NOT for gold/inventory.
  // Gold and inventory are always re-read inside the transaction below so concurrent
  // bestow/market/gather writes are never overwritten by a stale snapshot.
  const charSnap = await db.collection("characters").doc(uid).get();
  const char     = charSnap.data();

  let { monster, playerHp, playerMana, turn, log } = battle;
  const stats = char.stats || { str:10, int:10, def:10, dex:10 };

  if (action === "run") {
    // Use increment so a concurrent bestow gold write isn't overwritten
    const runCost = 10;
    await Promise.all([
      db.collection("battles").doc(uid).update({ status: "fled" }),
      db.collection("characters").doc(uid).update({ gold: FieldValue.increment(-runCost) }),
    ]);
    return { status: "fled", message: `You fled! Lost ${runCost} coins.`, gold: Math.max(0, (char.gold||0) - runCost) };
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
    const drops   = rollDrops(monster.grade, char.profession);
    const expGain = MONSTER_EXP[monster.grade] || 20;

    // ── Transactional character update ──────────────────────────────────────
    // Re-read gold and inventory fresh inside the transaction so concurrent writes
    // (bestow, market purchase, gather loot) are merged rather than overwritten.
    let updates;
    await withCharTransaction(uid, async (freshChar) => {
      const inv     = mergeInventory(freshChar.inventory || [], drops.items);
      const newGold = (freshChar.gold || 0) + drops.gold;
      const { newXp, newLevel, newRank, leveledUp, xpMax } = processExp(
        freshChar.xp||0, freshChar.xpMax||100, freshChar.level||1, freshChar.rank||"Wanderer", expGain
      );
      updates = { hp:playerHp, mana:playerMana, gold:newGold, inventory:inv, xp:newXp, xpMax, level:newLevel, rank:newRank };
      if (leveledUp) {
        updates.statPoints = (freshChar.statPoints||0) + 3;
        updates.hpMax      = (freshChar.hpMax||100) + 10;
        updates.manaMax    = (freshChar.manaMax||50) + 5;
        updates.hp         = updates.hpMax;
        updates.mana       = updates.manaMax;
      }
      return updates;
    });

    await db.collection("battles").doc(uid).update({ status:"victory", monster });
    const leveledUp = updates.hpMax !== undefined; // was set only on level-up
    log.push(`💀 ${monster.name} defeated!`);
    log.push(`💰 Gained ${drops.gold} gold!`);
    log.push(`⭐ Gained ${expGain} EXP!`);
    if (drops.items.length) log.push(`🎁 Dropped: ${drops.items.map(i=>i.name).join(", ")}`);
    if (leveledUp) log.push(`🎉 LEVEL UP! Now Level ${updates.level} ${updates.rank}!`);
    return { status:"victory", log, drops, expGain, leveledUp, newLevel:updates.level, newRank:updates.rank, updates };
  }

  const monsterDmg = Math.max(1, monster.atk - Math.floor((stats.def||10) * 0.5));
  playerHp = Math.max(0, playerHp - monsterDmg);
  log.push(`👹 ${monster.name} attacks for ${monsterDmg} damage!`);

  if (playerHp <= 0) {
    const resurrectAt = new Date(Date.now() + 5 * 60 * 60 * 1000);
    // ── Transactional death write ────────────────────────────────────────────
    // Re-read inventory inside a transaction so a concurrent bestow doesn't get
    // overwritten — the half-inventory penalty is applied to the CURRENT server
    // state, not the stale snapshot read at the top of this request.
    await withCharTransaction(uid, async (freshChar) => {
      const freshInv = freshChar.inventory || [];
      const halfInv  = freshInv.slice(0, Math.floor(freshInv.length / 2));
      return { hp:0, mana:playerMana, inventory:halfInv, resurrectAt, isDead:true };
    });
    await db.collection("battles").doc(uid).update({ status:"defeat" });
    log.push(`💀 You have been defeated! Resurrect in 5 hours.`);
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
    const drops   = rollDrops(grade, char.profession);
    const expGain = MONSTER_EXP[grade] || 20;
    log.push(`💀 ${monster.name} defeated!`);
    log.push(`💰 +${drops.gold} gold · ⭐ +${expGain} EXP`);

    // Use withCharTransaction so we read the LATEST xp/gold/inventory from
    // Firestore before writing. This prevents the race condition where a
    // concurrent gather or manual battle clobbers the XP that was earned here.
    let finalUpdates;
    await withCharTransaction(uid, async (freshChar) => {
      const inv = mergeInventory(freshChar.inventory||[], drops.items);
      const { newXp, newLevel, newRank, leveledUp, xpMax } = processExp(
        freshChar.xp||0, freshChar.xpMax||100, freshChar.level||1, freshChar.rank||"Wanderer", expGain
      );
      finalUpdates = {
        hp:        playerHp,
        mana:      playerMana,
        gold:      (freshChar.gold||0) + drops.gold,
        inventory: inv,
        xp:        newXp,
        xpMax,
        level:     newLevel,
        rank:      newRank,
      };
      if (leveledUp) {
        finalUpdates.statPoints = (freshChar.statPoints||0) + 3;
        finalUpdates.hpMax      = (freshChar.hpMax||100) + 10;
        finalUpdates.manaMax    = (freshChar.manaMax||50) + 5;
        log.push(`🎉 LEVEL UP! Level ${newLevel}!`);
      }
      return finalUpdates;
    });
    return { status:"victory", log, updates: finalUpdates, drops, expGain, leveledUp: finalUpdates?.statPoints !== undefined };
  } else if (status === "defeat") {
    const halfInv     = (char.inventory||[]).slice(0, Math.floor((char.inventory||[]).length/2));
    const resurrectAt = new Date(Date.now() + 5*60*60*1000);
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

  // Use a transaction so a simultaneous gather/battle victory can't clobber inventory
  let craftedItem;
  await withCharTransaction(uid, async (char) => {
    const inv = [...(char.inventory||[])];

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
    craftedItem = { name: recipe.name, icon: recipe.icon || typeIcons[recipe.type] || "📦", type: recipe.type, qty: 1 };
    if (isEquipmentType(recipe.type)) craftedItem.iid = makeIid();
    const merged = mergeInventory(inv, [craftedItem]);

    return { inventory: merged, gold: (char.gold||0) - (recipe.cost||0) };
  });

  return { success: true, item: craftedItem, message: `${craftedItem.name} crafted successfully!` };
});

// ═══════════════════════════════════════════════════════════════
//  ENCHANTMENT
// ═══════════════════════════════════════════════════════════════

exports.enchantItem = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { iid, itemName, itemGrade, currentEnchantLevel } = request.data;
  if (currentEnchantLevel >= 5) throw new HttpsError("failed-precondition", "Item is already at maximum enchant level (+5).");

  const reqs  = ENCHANT_REQS[itemGrade]?.[currentEnchantLevel];
  const rates = ENCHANT_SUCCESS_RATES[itemGrade];
  if (!reqs || !rates) throw new HttpsError("invalid-argument", "Invalid item grade.");

  const successRate   = rates[currentEnchantLevel];
  const runestoneName = `${itemGrade}-grade Runestone`;

  // Transaction prevents race condition where another op overwrites inventory mid-enchant
  let result;
  await withCharTransaction(uid, async (char) => {
    const inv = [...(char.inventory||[])];

    const runeItem = inv.find(i => i.name === runestoneName);
    if (!runeItem || runeItem.qty < reqs.stones)
      throw new HttpsError("failed-precondition", `Need ${reqs.stones}x ${runestoneName}. Have ${runeItem?.qty||0}.`);
    if ((char.gold||0) < reqs.coins)
      throw new HttpsError("failed-precondition", `Need ${reqs.coins} gold. Have ${char.gold||0}.`);

    const targetItem = inv.find(i => i.iid === iid);
    if (!targetItem) throw new HttpsError("not-found", `Item not found in inventory.`);

    runeItem.qty -= reqs.stones;
    if (runeItem.qty <= 0) inv.splice(inv.indexOf(runeItem), 1);
    const newGold = (char.gold||0) - reqs.coins;

    const success = Math.random() < successRate;
    let message, newEnchantLevel = currentEnchantLevel;

    if (success) {
      newEnchantLevel = currentEnchantLevel + 1;
      const baseName = itemName.replace(/\s*\+\d+$/, "");
      targetItem.enchantLevel = newEnchantLevel;
      targetItem.name = `${baseName} +${newEnchantLevel}`;
      if (["A","S"].includes(itemGrade) && (newEnchantLevel === 3 || newEnchantLevel === 5)) {
        targetItem.bonusEffect = newEnchantLevel === 3 ? "Minor Effect Unlocked" : "Major Effect Unlocked";
      }
      message = `✨ Enchantment succeeded! ${targetItem.name}`;
    } else {
      message = `💔 Enchantment failed. ${reqs.stones}x ${runestoneName} and ${reqs.coins} gold were consumed.`;
    }

    result = { success, message, newEnchantLevel, successRate: Math.round(successRate * 100), item: targetItem };
    return { inventory: inv, gold: newGold };
  });
  return result;
});

// ═══════════════════════════════════════════════════════════════
//  RANK ASCENSION
// ═══════════════════════════════════════════════════════════════

exports.ascendRank = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const INGREDIENTS = {
    "Sah'run":   ["Heart of the Red Phoenix","Gem of Luminance"],
    "Alistor":   ["The Void-Eye","Orb of Silence"],
    "Elionidas": ["Crown of Fortune","Tears of The Endless Goldfish"],
    "Mah'run":   ["Core of a Fallen Star","Fruit of World Tree"],
    "Freyja":    ["Divine Heart Essence","Forgotten Desire Seed"],
    "Arion":     ["Scales of Equilibrium","Adonai Sword"],
    "Veil":      ["Ink of Time","Eye of All-knowing"],
  };

  // FIXED: was getCharacter (plain read) + raw .update() — a concurrent bestow or battle-drop
  // arriving between those two calls would be silently overwritten because the whole inventory
  // array was written from a stale snapshot. Now uses withCharTransaction so the ingredient
  // check, consumption, and stat update are all atomic against the live Firestore data.
  let result;
  await withCharTransaction(uid, async (char) => {
    const rankIdx = getRankIdx(char.rank);

    if (rankIdx >= RANK_ORDER.length - 1) throw new HttpsError("failed-precondition", "Already at maximum rank.");
    if ((char.level||1) < 100) throw new HttpsError("failed-precondition", `Must reach Level 100 before ascending. Currently Level ${char.level||1}.`);

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

    result = { success:true, newRank, message:`🎉 You have ascended to ${newRank}!`, newHpMax, newManaMax };

    return {
      rank: newRank, level:1, xp:0, xpMax:newBaseXp,
      hpMax:newHpMax, hp:newHpMax, manaMax:newManaMax, mana:newManaMax,
      statPoints:(char.statPoints||0)+25, inventory:inv,
    };
  });

  return result;
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
  let targetName;
  const bestowId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  await withCharTransaction(targetUid, async (targetChar) => {
    targetName = targetChar.name;
    const inv = mergeInventory(targetChar.inventory||[], items||[]);
    const updates = {
      inventory:      inv,
      lastBestowId:   bestowId,
      lastBestowItems: (items||[]).reduce((s, i) => s + (i.qty||1), 0),
      lastBestowGold: gold || 0,
    };
    // Use increment so concurrent gold changes (battle loot, market) are never overwritten
    if (gold > 0) {
      updates.gold = FieldValue.increment(gold);
    }
    return updates;
  });
  // Write a bestow record so deities can review history per worshipper
  try {
    const deitySnap = await db.collection('characters').doc(uid).get();
    const deityName = deitySnap.data()?.name || 'A Deity';
    await db.collection('deityNotifications').add({
      type:       'bestow',
      deityUid:   uid,
      deityName,
      playerUid:  targetUid,
      playerName: targetName,
      items:      items || [],
      gold:       gold  || 0,
      read:       true,   // bestow records are informational — no badge needed
      createdAt:  FieldValue.serverTimestamp(),
    });
  } catch(notifErr) {
    console.warn('[bestowResources] Notification write failed:', notifErr.message);
  }

  return { success:true, message:`Resources bestowed upon ${targetName}.` };
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
  const oldFaith   = targetChar.faithLevel || 0;
  const newFaith   = Math.max(0, oldFaith + (amount || 1));

  await db.collection("characters").doc(targetUid).update({ faithLevel: newFaith });

  // Notify the deity if faith increased
  if (newFaith > oldFaith) {
    try {
      // ── Derive mantle + choir from faith level (mirrors FAITH_MANTLES in dashboard.js) ──
      const FAITH_MANTLES = [
        { mantle: 0, label: "Faithless",   choirs: [5,    10,   15]   },
        { mantle: 1, label: "Initiate",    choirs: [30,   35,   40]   },
        { mantle: 2, label: "Devotee",     choirs: [80,   85,   90]   },
        { mantle: 3, label: "Acolyte",     choirs: [180,  185,  190]  },
        { mantle: 4, label: "Zealot",      choirs: [380,  385,  390]  },
        { mantle: 5, label: "Chosen",      choirs: [780,  785,  790]  },
        { mantle: 6, label: "High Priest", choirs: [1580, 1585, 1590] },
      ];
      const _getFaithTier = (faith) => {
        let mantleIdx = 0;
        for (let i = FAITH_MANTLES.length - 1; i >= 0; i--) {
          if (faith >= FAITH_MANTLES[i].choirs[0]) { mantleIdx = i; break; }
          if (i === 0 && faith >= 0) { mantleIdx = 0; break; }
        }
        if (faith < FAITH_MANTLES[0].choirs[0]) mantleIdx = 0;
        const current = FAITH_MANTLES[mantleIdx];
        let choir = 0;
        for (let c = 2; c >= 0; c--) {
          if (faith >= current.choirs[c]) { choir = c + 1; break; }
        }
        return { label: current.label, mantleIdx, choir };
      };

      const oldTier = _getFaithTier(oldFaith);
      const newTier = _getFaithTier(newFaith);
      const mantleAscended = newTier.mantleIdx > oldTier.mantleIdx;

      await db.collection("deityNotifications").add({
        deityUid:   uid,
        type:       "faith_increase",
        subtype:    mantleAscended ? "mantle_ascension" : "choir_advancement",
        playerUid:  targetUid,
        playerName: targetChar.name || "Unknown",
        mantle:     newTier.label,
        choir:      newTier.choir,
        faithLevel: newFaith,
        oldFaith,
        newFaith,
        read:       false,
        createdAt:  require("firebase-admin/firestore").FieldValue.serverTimestamp(),
      });
    } catch(notifErr) {
      console.warn("[updateFaithLevel] Notification write failed:", notifErr.message);
    }
  }

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

  let claimResult;
  await withCharTransaction(uid, async (char) => {
    const inv = mergeInventory(char.inventory||[], reward.items);
    const { newXp, newLevel, newRank, leveledUp, xpMax } = processExp(
      char.xp||0, char.xpMax||100, char.level||1, char.rank||"Wanderer", reward.exp
    );
    claimResult = { success:true, reward, newGold:(char.gold||0)+reward.gold, leveledUp, newLevel, newRank };
    return { gold:(char.gold||0)+reward.gold, inventory:inv, xp:newXp, xpMax, level:newLevel, rank:newRank };
  });
  // Mark quest as claimed outside the char transaction (different collection, no race risk)
  await db.collection("dailyQuests").doc(uid).update({ claimed: FieldValue.arrayUnion(questKey) });
  return claimResult;
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
    const listingType = listing.itemType || "material";
    if (isEquipmentType(listingType)) {
      // Each equipment piece is unique — push qty individual entries each with their own iid
      for (let i = 0; i < qty; i++) {
        buyerInv.push({ name:listing.itemName, icon:listing.itemIcon||"📦", type:listingType, qty:1, iid:makeIid() });
      }
    } else {
      const existing = buyerInv.find(i => i.name === listing.itemName);
      if (existing) {
        existing.qty += qty;
      } else {
        buyerInv.push({ name:listing.itemName, icon:listing.itemIcon||"📦", type:listingType, qty });
      }
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
// ═══════════════════════════════════════════════════════════════
//  PUB GAMES — Server-side gold settlement
// ═══════════════════════════════════════════════════════════════

const PUB_REGION = "europe-west1";

// ── settlePubGame ─────────────────────────────────────────────
//  Firestore trigger: fires when a pubGames doc transitions to
//  status === 'complete'. Awards the full pot to the winner.
//  Runs as admin — bypasses all security rules.
exports.settlePubGame = onDocumentUpdated(
  { document: "pubGames/{gameId}", region: PUB_REGION },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    // Only act on the transition to 'complete', and only once
    if (before.status === "complete" || after.status !== "complete") return;

    // Devil's Hand settles gold round-by-round on the client; skip trigger
    if (after.gameType === "devils-hand") return;

    const { winnerUid, pot, goldSettled } = after;
    if (!winnerUid || !pot || goldSettled) return;

    await db.runTransaction(async (tx) => {
      const gameRef  = event.data.after.ref;
      const gameSnap = await tx.get(gameRef);
      // Guard against double-settlement
      if (gameSnap.data()?.goldSettled) return;

      const winnerRef = db.collection("characters").doc(winnerUid);
      tx.update(winnerRef, { gold: FieldValue.increment(pot) });
      tx.update(gameRef,   { goldSettled: true });
    });

    console.log("[PubGames] Settled " + event.params.gameId + ": awarded " + pot + " gold to " + winnerUid);
  }
);

// ── createPubGame ─────────────────────────────────────────────
//  Callable: host creates a table and their bet is deducted
//  atomically — no client-side gold write needed.
// ── cancelStalePubGames ──────────────────────────────────────
//  Runs every minute. Cancels any pub game table that has been
//  open/lobby for 3+ minutes with only the host seated (no one joined).
//  Regular games refund the host's original bet. DH lobby tables are
//  simply deleted (gold is deducted per-round at deal, not on create).
exports.cancelStalePubGames = onSchedule({
  schedule: "every 1 minutes",
  timeZone: "Europe/London",
  region:   "europe-west1",
}, async () => {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago

  const snap = await db.collection("pubGames")
    .where("status", "in", ["open", "lobby"])
    .where("createdAt", "<", cutoff)
    .get();

  if (snap.empty) return;

  // FIXED: previously used a batch delete + separate refund loop.
  // Race: the client-side cancel (pub.js) also runs a transaction that sets
  // status='cancelled' and then refunds. If both fire simultaneously, the
  // scheduled function's refund loop would still execute after the client
  // already refunded, resulting in a double gold award.
  // Fix: process each game in its own transaction that atomically checks the
  // current status before deleting and refunding — if the client already
  // claimed it (status='cancelled' or doc deleted), we skip the refund.
  let cancelled = 0;
  for (const docSnap of snap.docs) {
    const game = docSnap.data();
    // Only cancel solo tables (no one joined yet)
    if (!game.players || game.players.length !== 1) continue;

    const isRegularGame = game.gameType !== "devils-hand" && game.hostUid && game.tableStake > 0;

    try {
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(docSnap.ref);
        if (!freshSnap.exists) return; // already deleted by client cancel
        const freshStatus = freshSnap.data()?.status;
        // Only proceed if still open/lobby — client cancel sets 'cancelled' first
        if (freshStatus !== "open" && freshStatus !== "lobby") return;

        tx.delete(docSnap.ref);

        if (isRegularGame) {
          const charRef = db.collection("characters").doc(game.hostUid);
          tx.update(charRef, { gold: FieldValue.increment(game.tableStake) });
        }
      });
      cancelled++;
      if (isRegularGame) {
        console.log(`[cancelStalePubGames] Refunded ${game.tableStake} gold to ${game.hostUid}`);
      }
    } catch (e) {
      console.warn(`[cancelStalePubGames] Failed to cancel game ${docSnap.id}:`, e.message);
    }
  }

  console.log(`[cancelStalePubGames] Cancelled ${cancelled} stale table(s).`);
});

exports.createPubGame = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { gameType, pick: playerPick, bet, pubLocation, playerName } = request.data;
  if (!gameType || !bet || bet < 1 || !pubLocation)
    throw new HttpsError("invalid-argument", "Missing required fields.");

  const charRef = db.collection("characters").doc(uid);

  return await db.runTransaction(async (tx) => {
    const charSnap = await tx.get(charRef);
    if (!charSnap.exists) throw new HttpsError("not-found", "Character not found.");
    const char = charSnap.data();
    if ((char.gold || 0) < bet)
      throw new HttpsError("failed-precondition", "Not enough gold. You have " + (char.gold || 0) + ".");

    // Block if a table is already open at this pub for this game type
    const openSnap = await db.collection("pubGames")
      .where("gameType",    "==", gameType)
      .where("status",      "==", "open")
      .where("pubLocation", "==", pubLocation)
      .limit(1)
      .get();
    if (!openSnap.empty)
      throw new HttpsError("already-exists", "A table is already open — join it instead!");

    const gameRef    = db.collection("pubGames").doc();
    const playerEntry = gameType === "tavern-dice"
      ? { uid, name: playerName || char.name, pick: playerPick, bet }
      : { uid, name: playerName || char.name, bet, roll: null };

    tx.set(gameRef, {
      gameType,
      status:      "open",
      hostUid:     uid,
      pubLocation,
      tableStake:  bet,
      players:     [playerEntry],
      pot:         bet,
      rollResult:  null,
      winnerUid:   null,
      winnerName:  null,
      prize:       0,
      goldSettled: false,
      createdAt:   FieldValue.serverTimestamp(),
      completedAt: null,
    });
    tx.update(charRef, { gold: FieldValue.increment(-bet) });

    return { success: true, gameId: gameRef.id, tableStake: bet };
  });
});

// ── joinPubGame ───────────────────────────────────────────────
//  Callable: player joins an existing open table. Enforces the
//  table stake, deducts their gold, and adds them atomically.
exports.joinPubGame = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { gameId, pick: playerPick, playerName } = request.data;
  if (!gameId) throw new HttpsError("invalid-argument", "Missing gameId.");

  const gameRef = db.collection("pubGames").doc(gameId);
  const charRef = db.collection("characters").doc(uid);

  return await db.runTransaction(async (tx) => {
    const [gameSnap, charSnap] = await Promise.all([tx.get(gameRef), tx.get(charRef)]);

    if (!gameSnap.exists) throw new HttpsError("not-found", "Game not found.");
    if (!charSnap.exists) throw new HttpsError("not-found", "Character not found.");

    const game = gameSnap.data();
    const char = charSnap.data();

    if (game.status !== "open")
      throw new HttpsError("failed-precondition", "Table is no longer open.");

    const bet = game.tableStake || game.players?.[0]?.bet || 100;

    if ((char.gold || 0) < bet)
      throw new HttpsError("failed-precondition", "Not enough gold for this table's stake (" + bet + ").");
    if (game.players.some(p => p.uid === uid))
      throw new HttpsError("already-exists", "Already seated at this table.");
    if (game.gameType === "tavern-dice" && game.players.some(p => p.pick === playerPick))
      throw new HttpsError("failed-precondition", "That number is already taken.");
    if (game.players.length >= 10)
      throw new HttpsError("failed-precondition", "Table is full.");

    const playerEntry = game.gameType === "tavern-dice"
      ? { uid, name: playerName || char.name, pick: playerPick, bet }
      : { uid, name: playerName || char.name, bet, roll: null };

    tx.update(gameRef, {
      players: FieldValue.arrayUnion(playerEntry),
      pot:     FieldValue.increment(bet),
    });
    tx.update(charRef, { gold: FieldValue.increment(-bet) });

    return { success: true, gameId, bet, tableStake: bet };
  });
});

// ── rollPubGame ───────────────────────────────────────────────
//  Callable: host triggers the dice roll for tavern-dice or
//  highest-roll. Computes result server-side and writes ALL
//  outcome fields (winnerUid, winnerName, prize, goldSettled)
//  as admin — bypassing the client-write restriction on those
//  fields in Firestore rules.  Gold is then awarded by the
//  settlePubGame onDocumentUpdated trigger.
exports.rollPubGame = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { gameId } = request.data;
  if (!gameId) throw new HttpsError("invalid-argument", "Missing gameId.");

  const gameRef = db.collection("pubGames").doc(gameId);

  return await db.runTransaction(async (tx) => {
    const gameSnap = await tx.get(gameRef);
    if (!gameSnap.exists) throw new HttpsError("not-found", "Game not found.");

    const game = gameSnap.data();

    if (game.hostUid !== uid)
      throw new HttpsError("permission-denied", "Only the host can roll.");
    if (game.status !== "open")
      throw new HttpsError("failed-precondition", "Game is not in an open state.");
    if (!game.players || game.players.length < 2)
      throw new HttpsError("failed-precondition", "Need at least 2 players to roll.");

    // ── Transition to rolling ─────────────────────────────────
    // We skip the intermediate 'rolling' status here and go
    // straight to computing + writing 'complete' atomically.
    // The client already shows a rolling animation from the
    // status update written below.

    let rollResult, winner, players;

    if (game.gameType === "tavern-dice") {
      rollResult = Math.floor(Math.random() * 20) + 1;
      players    = game.players;
      // Exact match first, then closest
      winner = players.find(p => p.pick === rollResult);
      if (!winner) {
        let minDiff = Infinity;
        players.forEach(p => {
          const diff = Math.abs(p.pick - rollResult);
          if (diff < minDiff) { minDiff = diff; winner = p; }
        });
      }
    } else if (game.gameType === "highest-roll") {
      players    = game.players.map(p => ({ ...p, roll: Math.floor(Math.random() * 20) + 1 }));
      rollResult = Math.max(...players.map(p => p.roll));
      winner     = players.find(p => p.roll === rollResult);
    } else {
      throw new HttpsError("invalid-argument", "Unknown game type: " + game.gameType);
    }

    const prize = game.pot;

    const update = {
      status:      "complete",
      rollResult,
      winnerUid:   winner.uid,
      winnerName:  winner.name,
      prize,
      goldSettled: false,   // settlePubGame trigger will flip this and award gold
      completedAt: FieldValue.serverTimestamp(),
    };
    if (game.gameType === "highest-roll") {
      update.players = players;  // include individual roll results
    }

    tx.update(gameRef, update);
    return { success: true, rollResult, winnerUid: winner.uid, winnerName: winner.name, prize };
  });
});

// ── createDevilsHandGame ──────────────────────────────────────
//  Callable: host opens a Devil's Hand lobby. Validates gold
//  (must cover 5 rounds), creates the pubGames doc as admin,
//  and deducts nothing yet — gold is deducted per round at deal.
exports.createDevilsHandGame = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { baseStake, pubLocation, playerName } = request.data;
  if (!baseStake || baseStake < 1 || !pubLocation)
    throw new HttpsError("invalid-argument", "Missing required fields.");

  const charRef = db.collection("characters").doc(uid);

  return await db.runTransaction(async (tx) => {
    const charSnap = await tx.get(charRef);
    if (!charSnap.exists) throw new HttpsError("not-found", "Character not found.");
    const char = charSnap.data();

    const minGold = baseStake * 5;
    if ((char.gold || 0) < minGold)
      throw new HttpsError(
        "failed-precondition",
        `Need at least ${minGold} 💰 to cover 5 rounds. You have ${char.gold || 0}.`
      );

    // Block if a lobby is already open at this pub
    const openSnap = await db.collection("pubGames")
      .where("gameType",    "==", "devils-hand")
      .where("status",      "==", "lobby")
      .where("pubLocation", "==", pubLocation)
      .limit(1)
      .get();
    if (!openSnap.empty)
      throw new HttpsError("already-exists", "A Devil's Hand table is already open — join it instead!");

    const gameRef = db.collection("pubGames").doc();
    tx.set(gameRef, {
      gameType:      "devils-hand",
      status:        "lobby",
      pubLocation,
      hostUid:       uid,
      baseStake,
      round:         0,
      tableCards:    [],
      hands:         {},
      players:       [{ uid, name: playerName || char.name, status: "waiting", totalBet: 0, roundsWon: 0 }],
      turnOrder:     [],
      currentTurn:   0,
      roundPot:      0,
      totalPot:      0,
      notifications: ["Table opened. Waiting for players..."],
      roundWinner:   null,
      winnerUid:     null,
      winnerName:    null,
      prize:         0,
      goldSettled:   true,   // DH settles per-round client-side; block the trigger
      createdAt:     FieldValue.serverTimestamp(),
    });

    return { success: true, gameId: gameRef.id };
  });
});

// ── joinDevilsHandGame ────────────────────────────────────────
//  Callable: player joins an existing Devil's Hand lobby. Validates
//  gold (must cover 5 rounds) and adds them atomically.
exports.joinDevilsHandGame = onCall(CALL_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be logged in.");

  const { pubLocation, playerName } = request.data;
  if (!pubLocation) throw new HttpsError("invalid-argument", "Missing pubLocation.");

  const charRef = db.collection("characters").doc(uid);

  return await db.runTransaction(async (tx) => {
    const charSnap = await tx.get(charRef);
    if (!charSnap.exists) throw new HttpsError("not-found", "Character not found.");
    const char = charSnap.data();

    // Find the open lobby
    const lobbySnap = await db.collection("pubGames")
      .where("gameType",    "==", "devils-hand")
      .where("status",      "==", "lobby")
      .where("pubLocation", "==", pubLocation)
      .limit(1)
      .get();
    if (lobbySnap.empty)
      throw new HttpsError("not-found", "No open Devil's Hand table found.");

    const gameRef  = lobbySnap.docs[0].ref;
    const game     = lobbySnap.docs[0].data();
    const baseStake = game.baseStake || 100;
    const minGold   = baseStake * 5;

    if ((char.gold || 0) < minGold)
      throw new HttpsError(
        "failed-precondition",
        `Need at least ${minGold} 💰 to cover 5 rounds. You have ${char.gold || 0}.`
      );
    if (game.players.some(p => p.uid === uid))
      throw new HttpsError("already-exists", "Already seated at this table.");
    if (game.players.length >= 4)
      throw new HttpsError("failed-precondition", "Table is full. (4 players max)");

    const newPlayer = { uid, name: playerName || char.name, status: "waiting", totalBet: 0, roundsWon: 0 };

    tx.update(gameRef, {
      players:       FieldValue.arrayUnion(newPlayer),
      notifications: FieldValue.arrayUnion(`${playerName || char.name} joined the table!`),
    });

    return { success: true, gameId: lobbySnap.docs[0].id, baseStake };
  });
});

// ═══════════════════════════════════════════════════════════════
//  SCHEDULED: Expire overdue quests (story + faction) every 5 min
// ═══════════════════════════════════════════════════════════════

exports.expireQuests = onSchedule({
  schedule:  "every 5 minutes",
  timeZone:  "Europe/London",
  region:    "europe-west1",
}, async () => {
  const now   = new Date();
  const batch = db.batch();
  let   count = 0;

  // Story quests
  const sqSnap = await db.collection("storyQuests")
    .where("status",    "==", "active")
    .where("expiresAt", "<=", now)
    .get();
  sqSnap.forEach(d => { batch.update(d.ref, { status: "expired" }); count++; });

  // Faction missions
  const fqSnap = await db.collection("factionMissions")
    .where("status",    "==", "active")
    .where("expiresAt", "<=", now)
    .get();
  fqSnap.forEach(d => { batch.update(d.ref, { status: "expired" }); count++; });

  if (count > 0) await batch.commit();
  console.log(`[expireQuests] Expired ${count} quest(s).`);
});

exports.autoArchiveWorldEvents = require('./autoArchiveWorldEvents').autoArchiveWorldEvents;