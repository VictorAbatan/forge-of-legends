// ═══════════════════════════════════════
//  FORGE OF LEGENDS — Character Creation
//  js/character.js
// ═══════════════════════════════════════

import { auth, db } from "../firebase/firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast, hideLoading } from "./auth.js";

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  uid: null, step: 1,
  name: "", sex: "", age: "", bio: "",
  race: "", charClass: "", deity: "", kingdom: ""
};

// ── Race passive attributes (doc: Race section) ───────────────────────────────
// These are stored as strings — actual % effects applied server-side in combat
const RACE_DATA = {
  Human:     { icon: "🧑", attribute: "+10% EXP from battles" },
  Elf:       { icon: "🧝", attribute: "Magical skills cost less mana" },
  Orc:       { icon: "🪖", attribute: "+10% melee damage" },
  Dwarf:     { icon: "⛏️", attribute: "+10% stat from gear" },
  Fairy:     { icon: "🧚", attribute: "+10% luck" },
  Undead:    { icon: "💀", attribute: "+10% melee resistance" },
  Dragonborn:{ icon: "🐉", attribute: "+10% magic resistance" },
};

// ── Class data (doc: Classes section) ─────────────────────────────────────────
const CLASS_DATA = {
  Warrior:  { icon: "⚔️",  role: "Melee Damage",  primaryStat: "str" },
  Guardian: { icon: "🛡️", role: "Tank / Defense", primaryStat: "def" },
  Arcanist: { icon: "🔮",  role: "Magic Damage",  primaryStat: "int" },
  Hunter:   { icon: "🏹",  role: "Ranged Damage", primaryStat: "dex" },
  Assassin: { icon: "🗡️", role: "Stealth",        primaryStat: "dex" },
  Cleric:   { icon: "✨",  role: "Support",        primaryStat: "int" },
  Summoner: { icon: "🌀",  role: "Hybrid Magic",  primaryStat: "int" },
};

// ── Deity data (doc: Deities section) ────────────────────────────────────────
const DEITY_DATA = {
  "Sah'run":  {
    icon: "🔥",
    title: "God of Flames",
    authorities: "Flames, Luminance, Hellfire",
    blessing: "Flame of Forge",
    blessingDesc: "3% chance enemies drop forge materials on defeat",
    worshipMaterials: ["Volcanic roots", "Devil-Spring water", "Ash of Elder trees"],
    advancementIngredients: ["Heart of the Red Phoenix", "Gem of Luminance"],
  },
  "Alistor": {
    icon: "🌑",
    title: "God of Darkness",
    authorities: "Darkness, Slumber, Secrets",
    blessing: "Veil-step",
    blessingDesc: "3% reduced chance of getting robbed/attacked while exploring",
    worshipMaterials: ["Ephemeral Footprints", "Oil-stained Feathers", "Whispering Purple Sands"],
    advancementIngredients: ["The Void-Eye", "Orb of Silence"],
  },
  "Elionidas": {
    icon: "🪙",
    title: "God of Abundance",
    authorities: "Fate, Blessings, Riches",
    blessing: "Fortune's Drift",
    blessingDesc: "3% chance of finding precious loot while exploring",
    worshipMaterials: ["Golden Wheat Sheaves", "Miracle Coins", "Ancient Mint Seeds"],
    advancementIngredients: ["Crown of Fortune", "Tears of The Endless Goldfish"],
  },
  "Mah'run": {
    icon: "⭐",
    title: "Goddess of Stars",
    authorities: "Stars, Cosmos, Guidance",
    blessing: "Astral Sight",
    blessingDesc: "+3% chance of encountering rare events and special locations",
    worshipMaterials: ["Starlight Dust", "Moon Petals", "Crystallized Night Dews"],
    advancementIngredients: ["Core of a Fallen Star", "Fruit of World Tree"],
  },
  "Freyja": {
    icon: "💗",
    title: "Goddess of Love",
    authorities: "Love, Souls, Desire",
    blessing: "Heart's Favour",
    blessingDesc: "+3% chance of receiving gifts from NPCs",
    worshipMaterials: ["Crimson Toad Moss", "Branch of Soul Tree", "Bloom Petals"],
    advancementIngredients: ["Divine Heart Essence", "Forgotten Desire Seed"],
  },
  "Arion": {
    icon: "⚖️",
    title: "God of Justice",
    authorities: "Justice, Balance, Retribution",
    blessing: "Balanced Scales",
    blessingDesc: "Balances the ratio of good and bad encounters during exploration",
    worshipMaterials: ["Broken Shackles", "Iron Oaths", "Verdict Quill"],
    advancementIngredients: ["Scales of Equilibrium", "Adonai Sword"],
  },
  "Veil": {
    icon: "📖",
    title: "God of Knowledge",
    authorities: "Knowledge, Memory, Secrets",
    blessing: "Seeker's Mind",
    blessingDesc: "+3% EXP gained from all activities",
    worshipMaterials: ["Ancient Scroll Fragments", "White Mystic Woods", "Truths"],
    advancementIngredients: ["Ink of Time", "Eye of All-knowing"],
  },
};

// ── Kingdom data (doc: World Map section) ─────────────────────────────────────
const KINGDOM_DATA = {
  "Frostspire — Gladys Kingdom": {
    continent: "Northern Continent",
    region: "Frostveil",
    zone: "Safe Zone",
  },
  "Solmere — Elaria Kingdom": {
    continent: "Western Continent",
    region: "Verdantis",
    zone: "Safe Zone",
  },
};

// ── Base stats (doc: Character Template) ──────────────────────────────────────
// Base = 10 each. Welcome bonus = 20 points for allocation (stored separately)
// Stats: STR, INT, DEF, DEX (doc confirmed — no MAG/SPD/LCK as separate stats)
const BASE_STATS = { str: 10, int: 10, def: 10, dex: 10 };
const WELCOME_STAT_POINTS = 20;

// ── Init ──────────────────────────────────────────────────────────────────────
export function initCharacterCreation() {
  onAuthStateChanged(auth, (user) => {
    if (!user) { window.location.href = "auth.html"; return; }
    state.uid = user.uid;
    hideLoading();
  });

  // Step navigation buttons
  document.getElementById("btn-next-1")?.addEventListener("click", () => nextStep(1));
  document.getElementById("btn-next-2")?.addEventListener("click", () => nextStep(2));
  document.getElementById("btn-next-3")?.addEventListener("click", () => nextStep(3));
  document.getElementById("btn-next-4")?.addEventListener("click", () => nextStep(4));
  document.getElementById("btn-back-2")?.addEventListener("click", () => prevStep(2));
  document.getElementById("btn-back-3")?.addEventListener("click", () => prevStep(3));
  document.getElementById("btn-back-4")?.addEventListener("click", () => prevStep(4));
  document.getElementById("btn-back-5")?.addEventListener("click", () => prevStep(5));
  document.getElementById("btn-create")?.addEventListener("click", createCharacter);

  // Selectable cards
  document.querySelectorAll(".race-card").forEach(c =>
    c.addEventListener("click", () => { selectCard(".race-card", c); state.race = c.dataset.race; })
  );
  document.querySelectorAll(".class-card").forEach(c =>
    c.addEventListener("click", () => { selectCard(".class-card", c); state.charClass = c.dataset.class; })
  );
  document.querySelectorAll(".deity-card").forEach(c =>
    c.addEventListener("click", () => { selectCard(".deity-card", c); state.deity = c.dataset.deity; })
  );
  document.querySelectorAll(".location-card").forEach(c =>
    c.addEventListener("click", () => { selectCard(".location-card", c); state.kingdom = c.dataset.location; })
  );
}

// ── Card selection helper ─────────────────────────────────────────────────────
function selectCard(selector, el) {
  document.querySelectorAll(selector).forEach(c => c.classList.remove("selected"));
  el.classList.add("selected");
}

// ── Step navigation ───────────────────────────────────────────────────────────
function nextStep(from) {
  // Validate current step
  if (from === 1) {
    const name = document.getElementById("char-name")?.value.trim();
    const age  = document.getElementById("char-age")?.value.trim();
    if (!name)              { showToast("Give your character a name.", "error"); return; }
    if (!window._selectedSex) { showToast("Choose a sex.", "error"); return; }
    if (!age)               { showToast("Enter your character's age.", "error"); return; }
    state.name = name;
    state.sex  = window._selectedSex;
    state.age  = age;
    state.bio  = document.getElementById("char-bio")?.value.trim();
  }
  if (from === 2 && !state.race)       { showToast("Choose a race.", "error");   return; }
  if (from === 3 && !state.charClass)  { showToast("Choose a class.", "error");  return; }
  if (from === 4 && !state.deity)      { showToast("Choose a deity.", "error");  return; }

  // Mark current step done
  const dot  = document.getElementById(`dot-${from}`);
  const line = document.getElementById(`line-${from}`);
  document.getElementById(`step-${from}`)?.classList.remove("active");
  dot?.classList.remove("active");
  dot?.classList.add("done");
  line?.classList.add("done");

  // Activate next step
  const next = from + 1;
  document.getElementById(`step-${next}`)?.classList.add("active");
  document.getElementById(`dot-${next}`)?.classList.add("active");
  state.step = next;
}

function prevStep(from) {
  document.getElementById(`step-${from}`)?.classList.remove("active");
  document.getElementById(`dot-${from}`)?.classList.remove("active", "done");
  document.getElementById(`line-${from - 1}`)?.classList.remove("done");

  const prev = from - 1;
  document.getElementById(`step-${prev}`)?.classList.add("active");
  const prevDot = document.getElementById(`dot-${prev}`);
  prevDot?.classList.remove("done");
  prevDot?.classList.add("active");
  state.step = prev;
}

// ── Save character to Firestore ───────────────────────────────────────────────
async function createCharacter() {
  if (!state.kingdom) { showToast("Choose a starting kingdom.", "error"); return; }

  const btn = document.getElementById("btn-create");
  if (btn) { btn.disabled = true; btn.textContent = "FORGING LEGEND..."; }

  const deityInfo   = DEITY_DATA[state.deity]   || {};
  const classInfo   = CLASS_DATA[state.charClass] || {};
  const kingdomInfo = KINGDOM_DATA[state.kingdom] || {};

  // Base stats from doc: all 10, plus 20 unallocated welcome points
  const charDoc = {
    // Identity
    uid:       state.uid,
    name:      state.name,
    sex:       state.sex,
    age:       state.age,
    bio:       state.bio,

    // Choices
    race:      state.race,
    raceAttr:  RACE_DATA[state.race]?.attribute || "",
    charClass: state.charClass,
    classRole: classInfo.role || "",
    deity:     state.deity,
    deityTitle: deityInfo.title || "",
    blessing:  deityInfo.blessing || "",
    blessingDesc: deityInfo.blessingDesc || "",

    // Kingdom / location
    kingdom:   state.kingdom,
    continent: kingdomInfo.continent || "",
    region:    kingdomInfo.region || "",
    location:  state.kingdom, // current location = starting kingdom

    // Rank & level (doc: Ranks section — starts as Wanderer, level 1)
    rank:      "Wanderer",
    level:     1,
    xp:        0,
    xpMax:     100, // Level 1→2 base EXP per doc

    // Health & Mana (doc: base HP=100, base Mana=50)
    hp:        100,
    hpMax:     100,
    mana:      50,
    manaMax:   50,

    // Stats (doc: base=10 each, STR/INT/DEF/DEX)
    stats:     { ...BASE_STATS },
    statPoints: WELCOME_STAT_POINTS, // 20 unallocated welcome points

    // Economy
    gold: 100, // Starting gold

    // Progression
    titles:       ["Wanderer"],
    faithLevel:   0,
    reputation:   0,
    profession:   null, // chosen later
    professionXp: 0,
    party:        null,
    faction:      null,
    companion:    null,

    // Inventory starts empty
    inventory: [],

    // Equipment slots
    equipment: {
      weapon: null,
      armor:  null,
    },

    // Timestamps
    createdAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, "characters", state.uid), charDoc);
    window.location.href = "dashboard.html";
  } catch (err) {
    console.error(err);
    showToast("Failed to save character. Try again.", "error");
    if (btn) { btn.disabled = false; btn.textContent = "ENTER THE FORGE"; }
  }
}