// ═══════════════════════════════════════════════════
//  FORGE OF LEGENDS — LAYERED MAP SYSTEM  v4
// ═══════════════════════════════════════════════════

const MAP_IMAGES = {
  world:               "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fworld-map%2Fworld-map.jpg?alt=media&token=07a9110a-8dee-43ba-a83f-509602552dcc",
  frostspire:          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrostspire.jpeg?alt=media&token=02a9f440-6dc2-4d30-b6dd-3393c156e6ca",
  frostspire_capital:  "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrostpire-capital.jpeg?alt=media&token=ac9bbbac-90b6-4f61-9935-7f50007926dd",
  whitecrest:          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fwhitecrest_village.jpeg?alt=media&token=8dd42296-a946-481d-b26f-f4cac2b7d66c",
  icerun:              "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ficerun_hamlet.jpeg?alt=media&token=dfd74d98-9363-4514-a2cf-d4e10d1aaeb7",
  paleglow:            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fpaleglow_town.jpeg?alt=media&token=083ffc0b-2bfa-4708-92f4-ea1cac3f2390",
  mistveil:            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fmistveil_town.jpeg?alt=media&token=3fd261ca-b5d2-4096-8b0c-9c0f53e2c228",
  frost_wildlands:     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost-wildlands.png?alt=media&token=fcbb7a22-7269-4e3d-a94c-ee4467a9bb6d",
  solmere:             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsolmere.jpeg?alt=media&token=d651b87b-c394-4aa7-8177-c533daa67da2",
  solmere_capital:     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsolmere-capital.jpeg?alt=media&token=2d5cd553-bb6e-48cb-a8ea-3a584581d049",
  sunpetal:            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsunpetal_village.jpeg?alt=media&token=da53581d-271c-4879-a40f-460c19a8879e",
  basil:               "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fbasil_village.jpeg?alt=media&token=aaa9091c-6f79-4ddf-8136-2300dd7db9e8",
  riverend:            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Friverend_town.jpeg?alt=media&token=27721626-45d4-4b92-b089-24ae514b57f3",
  verdance:            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdance_town.jpeg?alt=media&token=06f44360-80c6-422f-8877-74aec213608f",
  verdantis_wildlands: "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis-wildlands.jpg?alt=media&token=0cf70f7b-9b0d-4daf-b514-8d9d530888fa",
  vorthak:             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fvorthak.jpg?alt=media&token=18fe4e4f-9c29-49ba-a5ba-fb40a3d7450d",
  vorthak_glass_hell:      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fglass-hell.jpg?alt=media&token=0e81de0c-af56-49c7-9e2b-dcb9d9c8fa78",
  vorthak_shattered_heavens:"https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fshattered-heavens.jpg?alt=media&token=22ef88f0-9ccf-4e11-ad8d-f573f15ea85e",
  vorthak_dark_woodlands:  "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fdark-woodlands.jpg?alt=media&token=d408a676-ec9f-40a7-8dd0-08899c88a04a",
  vorthak_corrupted_hallows:"https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fcorrupted-hallows.jpg?alt=media&token=90859bb8-c4d6-44f1-ad54-f085f85b9fc5",
  vorthak_otherworld:      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fvorthak%2Fotherworld.jpg?alt=media&token=9c5bfee7-ab52-44be-acca-806572eac528",
  nyx_abyss:           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fnyx-abyss%2Fnyx-abyss.jpeg?alt=media&token=f53427ea-4393-48e1-93d7-c83f7823dd8a",
};

Object.values(MAP_IMAGES).forEach(url=>{ const i=new Image(); i.src=url; });

const RANK_ORDER_MAP = ["Wanderer","Follower","Disciple","Master","Exalted","Crown","Supreme","Legend","Myth","Eternal"];

// ── World pins (calibrated) ──
const WORLD_PINS = [
  { id:"frostveil", label:"Frostveil",   x:51.2, y:19.1, type:"capital",  travelCost:100, travelTime:60   },
  { id:"verdantis", label:"Verdantis",   x:28.6, y:54.7, type:"capital",  travelCost:100, travelTime:60   },
  { id:"vorthak",   label:"Vorthak",     x:75.5, y:51.3, type:"danger",   travelCost:100, travelTime:60   },
  { id:"nyx_abyss", label:"Nyx Abyss",  x:57.4, y:78.2, type:"endgame",  travelCost:100, travelTime:60   },
];

// ── Player location anchor per pin (offset dot position) ──
const WORLD_PLAYER_PINS = [
  { id:"frostveil", x:51.1, y:26.9 },
  { id:"verdantis", x:31.2, y:59.6 },
  { id:"vorthak",   x:74.2, y:48.9 },
  { id:"nyx_abyss", x:53.9, y:80.9 },
];

const CONTINENTS = {
  frostveil: {
    name:"Frostveil", label:"Northern Continent · Capital: Frostspire",
    capital:"Frostspire — Gladys Kingdom", capitalId:"frostspire",
    capitalImage:"frostspire_capital",
    capitalPin: { x:53.5, y:57.2 },
    image:"frostspire", wildlandsId:"frost_wildlands",
    pubPin: { x:26.0, y:52.0 },
    travelCost:100, travelTime:60,
    settlements:[
      { id:"whitecrest", label:"Whitecrest Village", image:"whitecrest", desc:"A quiet snow-dusted village at the foot of the Frostveil mountains. NPCs trade in furs and common goods.", travelCost:20, travelTime:30, x:31.6, y:14.8, px:43.9, py:42.8 },
      { id:"icerun",     label:"Icerun Hamlet",      image:"icerun",     desc:"A small hamlet carved into glacial cliffs, known for its hardy miners and close-knit community.",           travelCost:20, travelTime:30, x:80.7, y:20.6, px:54.4, py:58.6 },
      { id:"paleglow",   label:"Paleglow Town",      image:"paleglow",   desc:"Named for the pale aurora lighting its skies. A mid-sized town with active herbalist trade.",               travelCost:30, travelTime:30, x:20.7, y:77.3, px:51.0, py:62.9 },
      { id:"mistveil",   label:"Mistveil Town",      image:"mistveil",   desc:"Perpetually shrouded in mist from the wilderness beyond. A base for anglers and foragers.",                 travelCost:30, travelTime:30, x:80.8, y:76.6, px:42.9, py:54.0 },
    ],
    wildlandsPin: { x:7.3, y:33.3 },
    capitalPlayerPin: { x:53.7, y:82.1 },
    explore:[
      // Resource zones
      { id:"wisteria",       label:"Wisteria Forest",      type:"resource", prof:"Forager / Herbalist / Hunter", travelCost:0, travelTime:10, x:19.8, y:29.4, px:19.8, py:29.4 },
      { id:"silver_lake",    label:"Silver Lake",          type:"resource", prof:"Angler",                       travelCost:0, travelTime:10, x:31.1, y:44.2, px:31.1, py:44.2 },
      { id:"hobbit_cave",    label:"Hobbit Cave",          type:"resource", prof:"Miner",                        travelCost:0, travelTime:10, x:16.9, y:80.3, px:16.9, py:80.3 },
      { id:"arctic_willow",  label:"Arctic Willow Grove",  type:"resource", prof:"Forager / Herbalist",          travelCost:0, travelTime:10, x:10.7, y:57.4, px:10.7, py:57.4 },
      { id:"dream_river",    label:"Dream River",          type:"resource", prof:"Angler",                       travelCost:0, travelTime:10, x:46.4, y:83.3, px:46.4, py:83.3 },
      { id:"suldan_mine",    label:"Suldan Mine",          type:"resource", prof:"Miner",                        travelCost:0, travelTime:10, x:55.8, y:56.2, px:55.8, py:56.2 },
      // Deity zones
      { id:"shrine_secrets", label:"Shrine of Secrets",    type:"deity",    deity:"God of Knowledge (Veil) — 10% worship materials",      travelCost:0, travelTime:10, x:52.3, y:20.6, px:52.3, py:20.6 },
      { id:"aurora_basin",   label:"Aurora Basin",         type:"deity",    deity:"Goddess of Stars (Mah'run) — 10% worship materials",   travelCost:0, travelTime:10, x:79.0, y:34.1, px:79.0, py:34.1 },
      { id:"forgotten_est",  label:"Forgotten Estuary",    type:"deity",    deity:"God of Darkness (Alistor) — 10% worship materials",    travelCost:0, travelTime:10, x:80.2, y:73.4, px:80.2, py:73.4 },
    ],
  },

  verdantis: {
    name:"Verdantis", label:"Western Continent · Capital: Solmere",
    capital:"Solmere — Elaria Kingdom", capitalId:"solmere",
    capitalImage:"solmere_capital",
    capitalPin: { x:52.0, y:46.5 },
    image:"solmere", wildlandsId:"verdantis_wildlands",
    pubPin: { x:25.0, y:55.0 },
    travelCost:100, travelTime:60,
    settlements:[
      { id:"sunpetal", label:"Sunpetal Village", image:"sunpetal", desc:"A sun-drenched village famous for sunpetals and its lively flower market.",                      travelCost:20, travelTime:30, x:15.5, y:24.4, px:46.4, py:43.6 },
      { id:"basil",    label:"Basil Village",    image:"basil",    desc:"A small herbalist village nestled at the forest edge. Fresh herbs fill the air year round.",     travelCost:20, travelTime:30, x:17.0, y:74.7, px:47.7, py:49.8 },
      { id:"riverend", label:"Riverend Town",    image:"riverend", desc:"Perched where the Golden River meets the valley plain. A busy fishing and trade town.",          travelCost:30, travelTime:30, x:70.1, y:19.1, px:49.6, py:33.1 },
      { id:"verdance", label:"Verdance Town",    image:"verdance", desc:"Lush and overgrown. Exists in harmony with the forest. Hunters and foragers base here.",         travelCost:30, travelTime:30, x:78.9, y:70.5, px:47.7, py:49.8 },
    ],
    wildlandsPin: { x:93.9, y:55.5 },
    capitalPlayerPin: { x:52.5, y:22.1 },
    explore:[
      // Resource zones
      { id:"asahi",              label:"Asahi Valley",          type:"resource", prof:"Forager / Herbalist / Hunter", travelCost:0, travelTime:10, x:68.5, y:74.8, px:68.5, py:74.8 },
      { id:"moss_stream",        label:"Moss Stream",           type:"resource", prof:"Angler",                       travelCost:0, travelTime:10, x:54.0, y:57.0, px:54.0, py:57.0 },
      { id:"argent_grotto",      label:"Argent Grotto",         type:"resource", prof:"Miner",                        travelCost:0, travelTime:10, x:74.8, y:44.2, px:74.8, py:44.2 },
      { id:"summer_willow_west", label:"Summer Willow Grove",   type:"resource", prof:"Forager / Herbalist",           travelCost:0, travelTime:10, x:54.2, y:30.6, px:54.2, py:30.6 },
      { id:"golden_river",       label:"Golden River",          type:"resource", prof:"Angler",                       travelCost:0, travelTime:10, x:83.7, y:61.7, px:83.7, py:61.7 },
      { id:"shiny_cavern",       label:"Shiny Cavern",          type:"resource", prof:"Miner",                        travelCost:0, travelTime:10, x:85.2, y:82.2, px:85.2, py:82.2 },
      // Deity zones
      { id:"purgatory",          label:"Purgatory of Light",    type:"deity",    deity:"God of Flames (Sah'run) — 10% worship materials",      travelCost:0, travelTime:10, x:68.1, y:22.5, px:68.1, py:22.5 },
      { id:"temple_verdict",     label:"Temple of Verdict",     type:"deity",    deity:"God of Justice (Arion) — 10% worship materials",       travelCost:0, travelTime:10, x:38.1, y:18.7, px:38.1, py:18.7 },
      { id:"heart_garden",       label:"Heart Garden",          type:"deity",    deity:"Goddess of Love (Freyja) — 10% worship materials",     travelCost:0, travelTime:10, x:29.9, y:78.5, px:29.9, py:78.5 },
      { id:"valley_over",        label:"Valley of Overflowing", type:"deity",    deity:"God of Abundance (Elionidas) — 10% worship materials", travelCost:0, travelTime:10, x:48.8, y:83.1, px:48.8, py:83.1 },
    ],
  },

  vorthak: {
    name:"Vorthak", label:"Eastern Continent · Vorthak",
    capital:null, capitalId:null,
    image:"vorthak", wildlandsId:"vorthak",
    travelCost:100, travelTime:60,
    settlements:[], wildlandsPin:null, capitalPlayerPin:null,
    // Vorthak has 5 sub-regions rendered as separate wildland-style views.
    // explore[] lists the sub-region entry pins on the Vorthak overview map.
    // Each sub-region has its own zones array rendered when entered.
    subRegions:[
      {
        id:"glass_hell", label:"Glass Hell", image:"vorthak_glass_hell",
        x:27.9, y:33.7,
        zones:[
          { id:"lake_of_reflections",  label:"Lake of Reflections", type:"monster", grade:"E",   monsters:"Prism Spider, Glass Critter, Glass Centipede",    travelCost:0, travelTime:10, x:54.1, y:55.8, px:54.1, py:55.8 },
          { id:"crystal_cave",         label:"Crystal Cave",        type:"monster", grade:"E",   monsters:"Diamond Golem, Luster Bat, Shiny Crustacean",     travelCost:0, travelTime:10, x:57.1, y:84.1, px:57.1, py:84.1 },
          { id:"rainbow_valley",       label:"Rainbow Valley",      type:"monster", grade:"D",   monsters:"Radiant Ifrit, Dazzling Fairy, Sparkling Elf",    travelCost:0, travelTime:10, x:81.5, y:62.5, px:81.5, py:62.5 },
          { id:"shimmering_peak",      label:"Shimmering Peak",     type:"monster", grade:"D",   monsters:"Red Spirit, Blue Spirit, Purple Spirit",          travelCost:0, travelTime:10, x:50.3, y:14.5, px:50.3, py:14.5 },
          { id:"mirror_sky",           label:"Mirror Sky",          type:"monster", grade:"D",   monsters:"White Raven, Mirror-eyed Owl, Cloud Lurker",      travelCost:0, travelTime:10, x:88.0, y:12.2, px:88.0, py:12.2 },
        ],
      },
      {
        id:"shattered_heavens", label:"Shattered Heavens", image:"vorthak_shattered_heavens",
        x:73.9, y:19.9,
        zones:[
          { id:"tempest_crown",   label:"Tempest Crown",    type:"monster", grade:"D",   monsters:"Lightning Shroud, Mist Phantom, Hurricane Wraith",  travelCost:0, travelTime:10, x:26.1, y:28.5, px:26.1, py:28.5 },
          { id:"frostfall_exp",   label:"Frostfall Expanse",type:"monster", grade:"D",   monsters:"Ice Ifrit, Vicious Snowman, Crow Frostling",        travelCost:0, travelTime:10, x:82.0, y:27.6, px:82.0, py:27.6 },
          { id:"ember_horizon",   label:"Ember Horizon",    type:"monster", grade:"C",   monsters:"Flame Spirit, Burning Bush, Lava Golem",            travelCost:0, travelTime:10, x:13.3, y:75.4, px:13.3, py:75.4 },
          { id:"veilwater_basin", label:"Veilwater Basin",  type:"monster", grade:"C",   monsters:"Water Wraith, Water Serpent, Liquid Phantom",       travelCost:0, travelTime:10, x:37.4, y:48.7, px:37.4, py:48.7 },
          { id:"titan_divide",    label:"Titan Divide",     type:"monster", grade:"C",   monsters:"Stone Golem, Moldy Giant, Clayface",                travelCost:0, travelTime:10, x:89.9, y:71.4, px:89.9, py:71.4 },
        ],
      },
      {
        id:"dark_woodlands", label:"Dark Woodlands", image:"vorthak_dark_woodlands",
        x:39.6, y:54.3,
        zones:[
          { id:"crimson_fang",    label:"Crimson Fang",     type:"monster", grade:"81-100", monsters:"Red-mane Wolf, Blue-mane Wolf, Alpha Beast Wolf",  travelCost:0, travelTime:10, x:30.2, y:28.2, px:30.2, py:28.2 },
          { id:"root_grove",      label:"Root Grove",       type:"monster", grade:"61-80", monsters:"Five-Fanged Bear, Rampage Bull, Blood-faced Yak",  travelCost:0, travelTime:10, x:80.1, y:27.8, px:80.1, py:27.8 },
          { id:"serpent_mire",    label:"Serpent Mire",     type:"monster", grade:"21-40", monsters:"Twin-faced Serpent, Razor-back Komodo, Giant-poison Toad", travelCost:0, travelTime:10, x:54.0, y:51.3, px:54.0, py:51.3 },
          { id:"burrowdeep",      label:"Burrowdeep Basin", type:"monster", grade:"41-60", monsters:"Groundhog Turtle, Possessed Hedgehog, Bloodlusted Warthog", travelCost:0, travelTime:10, x:73.6, y:80.1, px:73.6, py:80.1 },
          { id:"gremlin_hollows", label:"Gremlin Hollows",  type:"monster", grade:"1-20", monsters:"Vicious Gremlin, Scavenger, Vile Goblin",          travelCost:0, travelTime:10, x:19.1, y:75.3, px:19.1, py:75.3 },
        ],
      },
      {
        id:"corrupted_hallows", label:"Corrupted Hallows", image:"vorthak_corrupted_hallows",
        x:72.9, y:45.2,
        zones:[
          { id:"defiled_sanctum",      label:"Defiled Sanctum",       type:"monster", grade:"C",   monsters:"Penitent Priest, Cursed Fiend, Forsaken Follower",      travelCost:0, travelTime:10, x:20.2, y:46.1, px:20.2, py:46.1 },
          { id:"dark_cathedral",       label:"Dark Cathedral",        type:"monster", grade:"C",   monsters:"Revenant Bishop, Profane Priest, Profane Presbyter",   travelCost:0, travelTime:10, x:51.1, y:54.7, px:51.1, py:54.7 },
          { id:"gravemarch_fields",    label:"Gravemarch Fields",     type:"monster", grade:"B",   monsters:"Skeletal Beast, Vile Thieving Vulture, Pallbearer",     travelCost:0, travelTime:10, x:51.3, y:85.4, px:51.3, py:85.4 },
          { id:"fallen_bastion",       label:"Fallen Bastion",        type:"monster", grade:"B",   monsters:"Condemned Knight, Nightmare Horse, Profane Jester",     travelCost:0, travelTime:10, x:84.0, y:52.5, px:84.0, py:52.5 },
          { id:"whispering_necropolis",label:"Whispering Necropolis", type:"monster", grade:"B",   monsters:"Ghoul Blatherer, Condemned Siren, Weeping Apparition",  travelCost:0, travelTime:10, x:67.6, y:19.6, px:67.6, py:19.6 },
        ],
      },
      {
        id:"otherworld", label:"Otherworld", image:"vorthak_otherworld",
        x:62.9, y:75.1,
        zones:[
          { id:"blighted_world",  label:"Blighted World",  type:"monster", grade:"A",   monsters:"Abomination, Corrupted Sage, Fallen Cyclops",                travelCost:0, travelTime:10, x:23.9, y:24.8, px:23.9, py:24.8 },
          { id:"infernal_reach",  label:"Infernal Reach",  type:"monster", grade:"A",   monsters:"Devil Centurion, Demonic Herald, Cerberus",                  travelCost:0, travelTime:10, x:19.8, y:61.4, px:19.8, py:61.4 },
          { id:"sphinx_dominion", label:"Sphinx Dominion", type:"monster", grade:"A",   monsters:"Dark Sphinx, Desolate Matriarch, Bestial Sandworm",          travelCost:0, travelTime:10, x:39.9, y:80.3, px:39.9, py:80.3 },
          { id:"ashwing_aerie",   label:"Ashwing Aerie",   type:"monster", grade:"A",   monsters:"Blue Phoenix, Glowing Griffin, Nebulous Phoenix",            travelCost:0, travelTime:10, x:82.2, y:21.1, px:82.2, py:21.1 },
          { id:"leviathan_depths",label:"Leviathan Depths",type:"monster", grade:"A",   monsters:"Blood Kraken, Lightning Eel, Colossal Black Serpent",         travelCost:0, travelTime:10, x:78.2, y:63.6, px:78.2, py:63.6 },
        ],
      },
    ],
    // explore[] is auto-derived from subRegions for the overview — populated below
    explore:[],
  },

  nyx_abyss: {
    name:"Nyx Abyss", label:"Southern Continent · Nyx Abyss",
    capital:null, capitalId:null,
    image:"nyx_abyss", wildlandsId:"nyx_abyss",
    travelCost:100, travelTime:60,
    settlements:[], wildlandsPin:null, capitalPlayerPin:null,
    explore:[
      { id:"void_chasm",     label:"Void Chasm",     type:"monster", grade:"S", monsters:"Void Lurker, Oblivion Eye",  travelCost:0, travelTime:10, x:60.0, y:3.8,  px:55.2, py:9.8  },
      { id:"abyssal_depths", label:"Abyssal Depths",  type:"monster", grade:"S", monsters:"Abyssal Eater, Chaoswalker", travelCost:0, travelTime:10, x:23.0, y:49.2, px:18.3, py:49.2 },
      { id:"fallen_heaven",  label:"Fallen Heaven",   type:"monster", grade:"S", monsters:"Godless Thing",              travelCost:0, travelTime:10, x:61.7, y:35.7, px:56.2, py:37.4 },
    ],
  },
};

// Populate vorthak.explore from subRegions for sidebar lists and zone resolution
CONTINENTS.vorthak.explore = CONTINENTS.vorthak.subRegions.flatMap(sr => sr.zones);

// ── State ──
let _mapLayer="world", _mapBreadcrumbs=[];
let _zoom=1, _panX=0, _panY=0, _isPanning=false, _lastPan={x:0,y:0};

const _c  = () => document.getElementById("layered-map-container");
const _ft = s => s>=3600?Math.floor(s/3600)+"h "+Math.floor((s%3600)/60)+"m":s>=60?Math.floor(s/60)+"m"+(s%60?" "+s%60+"s":""):s+"s";

function _rankIdx()   { return RANK_ORDER_MAP.indexOf(window._charData?.rank||"Wanderer"); }
function _canEnter(cid) { return true; } // No rank restrictions on any continent

function _playerContinentId() {
  const loc=(window._charData?.kingdom||window._charData?.location||"").toLowerCase();
  // Check bare continent names first
  if (loc === "vorthak" || loc.startsWith("vorthak")) return "vorthak";
  if (loc === "nyx_abyss" || loc.startsWith("nyx_abyss") || loc.includes("nyx abyss")) return "nyx_abyss";
  // Check Vorthak sub-region zones
  for (const sr of CONTINENTS.vorthak.subRegions) {
    for (const z of sr.zones) {
      if (loc===z.id||loc===z.label.toLowerCase()||loc.includes(z.id)) return "vorthak";
    }
  }
  for (const [id,c] of Object.entries(CONTINENTS)) {
    if (c.capitalId&&loc.includes(c.capitalId)) return id;
    if (c.settlements.some(s=>loc.includes(s.id))) return id;
    for (const e of c.explore) if(loc===e.id||loc===e.label.toLowerCase()||loc.includes(e.id)) return id;
  }
  return null;
}
function _isAtLocation(id) {
  const loc=(window._charData?.kingdom||window._charData?.location||"").toLowerCase();
  return loc===id.toLowerCase()||loc.includes(id.toLowerCase());
}
function _isInContinent(cid) { return _playerContinentId()===cid; }
function _isAtCapital(cid)   { const c=CONTINENTS[cid]; return c?.capitalId?_isAtLocation(c.capitalId):false; }

function _gradeCol(g) {
  if(!g)return"#70c070";
  // Level-band strings (e.g. "1-20", "21-40" … "81-100")
  if(g.includes("-")&&!g.includes("S")&&!g.includes("A")&&!g.includes("B")&&!g.includes("C")) {
    const lvl=parseInt(g.split("-")[0]);
    if(lvl>=81) return"#c0a030"; // 81-100 gold-ish
    if(lvl>=61) return"#90b050"; // 61-80 green-yellow
    if(lvl>=41) return"#70c090"; // 41-60 teal
    if(lvl>=21) return"#70c070"; // 21-40 green
    return"#70c070"; // 1-20 base green
  }
  if(g.includes("S"))return"#d070e0";
  if(g.includes("A"))return"#e05555";
  if(g.includes("B"))return"#e08030";
  if(g.includes("C"))return"#d0b030";
  return"#70c070";
}
function _icon(t) { return t==="monster"?"⚔️":t==="resource"?"⛏️":"✦"; }
function _tagStyle(t) {
  return{safe:"background:rgba(80,200,120,0.2);border:0.5px solid rgba(80,200,120,0.5);color:#5cb87a",
         danger:"background:rgba(220,80,80,0.2);border:0.5px solid rgba(220,80,80,0.5);color:#e05555",
         endgame:"background:rgba(160,80,220,0.2);border:0.5px solid rgba(160,80,220,0.5);color:#b06de0"}[t]||"";
}

function _bcBar(label) {
  return `<div id="lmap-bcbar">${_mapBreadcrumbs.map((bc,i)=>`<span class="lmap-bc" data-idx="${i}">${bc.label}</span><span class="lmap-bc-sep">›</span>`).join("")}<span class="lmap-bc-current">${label}</span></div>`;
}
function _setupBC(c) {
  c.querySelectorAll(".lmap-bc").forEach(el=>el.addEventListener("click",()=>{
    const idx=parseInt(el.dataset.idx), bc=_mapBreadcrumbs[idx];
    _mapBreadcrumbs=_mapBreadcrumbs.slice(0,idx);
    if(bc.id==="world") renderWorldMap();
    else if(CONTINENTS[bc.id]) renderContinent(bc.id);
    else renderWorldMap();
  }));

  // Clean up any previous drag listeners before attaching new ones
  if (window._lmapBarMouseMove) window.removeEventListener("mousemove", window._lmapBarMouseMove);
  if (window._lmapBarMouseUp)   window.removeEventListener("mouseup",   window._lmapBarMouseUp);

  const bar = document.getElementById("lmap-bcbar");
  if (!bar) return;

  let _bdragging=false, _bdx=0, _bdy=0, _bx=12, _by=12;

  function startDrag(clientX, clientY) {
    _bdragging = true;
    _bdx = clientX; _bdy = clientY;
    const r  = bar.getBoundingClientRect();
    const pr = bar.offsetParent?.getBoundingClientRect() || { left:0, top:0 };
    _bx = r.left - pr.left;
    _by = r.top  - pr.top;
    bar.style.left = _bx + "px";
    bar.style.top  = _by + "px";
  }

  function moveDrag(clientX, clientY) {
    if (!_bdragging) return;
    _bx += clientX - _bdx;
    _by += clientY - _bdy;
    _bdx = clientX; _bdy = clientY;
    bar.style.left = _bx + "px";
    bar.style.top  = _by + "px";
  }

  function endDrag() { _bdragging = false; bar.style.cursor = "grab"; }

  bar.addEventListener("mousedown", e => {
    if (e.target.closest(".lmap-bc,.lmap-bc-sep,.lmap-bc-current")) return;
    bar.style.cursor = "grabbing";
    startDrag(e.clientX, e.clientY);
    e.preventDefault();
  });

  window._lmapBarMouseMove = e => moveDrag(e.clientX, e.clientY);
  window._lmapBarMouseUp   = endDrag;
  window.addEventListener("mousemove", window._lmapBarMouseMove);
  window.addEventListener("mouseup",   window._lmapBarMouseUp);

  bar.addEventListener("touchstart", e => {
    if (e.target.closest(".lmap-bc,.lmap-bc-sep,.lmap-bc-current")) return;
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  bar.addEventListener("touchmove", e => {
    e.stopPropagation();
    moveDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  bar.addEventListener("touchend", endDrag, { passive: true });
}

function _initZoomPan(container, wrap) {
  _zoom=1; _panX=0; _panY=0;

  // Clamp pan so you can't drag the image out of frame
  function _clamp() {
    const maxX = container.offsetWidth  * (_zoom - 1) / 2;
    const maxY = container.offsetHeight * (_zoom - 1) / 2;
    _panX = Math.max(-maxX, Math.min(maxX, _panX));
    _panY = Math.max(-maxY, Math.min(maxY, _panY));
  }
  const apply = () => {
    _clamp();
    wrap.style.transformOrigin = "center center";
    wrap.style.transform = `scale(${_zoom}) translate(${_panX/_zoom}px,${_panY/_zoom}px)`;
  };

  // ── Mouse: wheel to zoom, drag to pan ──
  container.addEventListener("wheel", e => {
    e.preventDefault();
    _zoom = Math.max(1, Math.min(4, _zoom + (e.deltaY < 0 ? 0.15 : -0.15)));
    if (_zoom === 1) { _panX = 0; _panY = 0; }
    apply();
  }, { passive: false });

  container.addEventListener("mousedown", e => {
    if (_zoom <= 1) return;
    e.preventDefault();
    _isPanning = true;
    _lastPan = { x: e.clientX - _panX, y: e.clientY - _panY };
    container.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", e => {
    if (!_isPanning) return;
    _panX = e.clientX - _lastPan.x;
    _panY = e.clientY - _lastPan.y;
    apply();
  });
  window.addEventListener("mouseup", () => { _isPanning = false; container.style.cursor = ""; });

  // ── Touch: pinch to zoom + single-finger drag to pan ──
  let _lastTouchDist = 0;
  let _lastTouchPos  = null;
  let _touchPanning  = false;

  container.addEventListener("touchstart", e => {
    if (e.touches.length === 2) {
      // Pinch start
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      _lastTouchDist = Math.hypot(dx, dy);
      _touchPanning = false;
    } else if (e.touches.length === 1 && _zoom > 1) {
      // Single-finger pan start (only when zoomed in)
      _touchPanning = true;
      _lastTouchPos = { x: e.touches[0].clientX - _panX, y: e.touches[0].clientY - _panY };
    }
  }, { passive: true });

  container.addEventListener("touchmove", e => {
    if (e.touches.length === 2) {
      // Pinch zoom
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const d  = Math.hypot(dx, dy);
      _zoom = Math.max(1, Math.min(4, _zoom * (d / _lastTouchDist)));
      _lastTouchDist = d;
      _touchPanning = false;
      apply();
    } else if (e.touches.length === 1 && _touchPanning && _lastTouchPos) {
      // Single-finger pan
      _panX = e.touches[0].clientX - _lastTouchPos.x;
      _panY = e.touches[0].clientY - _lastTouchPos.y;
      apply();
    }
  }, { passive: true });

  container.addEventListener("touchend", e => {
    if (e.touches.length < 2) _lastTouchDist = 0;
    if (e.touches.length === 0) { _touchPanning = false; _lastTouchPos = null; }
  }, { passive: true });
}

// ── Tooltip Portal ──────────────────────────────────
// Renders into a fixed-position div on <body> so it is NEVER
// clipped by overflow:hidden ancestors or the breadcrumb bar.
let _ttPortalEl  = null;
let _ttAnchorEl  = null;

function _getPortal() {
  if (!_ttPortalEl) {
    _ttPortalEl = document.createElement("div");
    _ttPortalEl.id = "lmap-tt-portal";
    document.body.appendChild(_ttPortalEl);
    document.addEventListener("click", e => {
      if (_ttAnchorEl && !_ttAnchorEl.contains(e.target) && !_ttPortalEl.contains(e.target)) {
        _closeTT();
      }
    });
  }
  return _ttPortalEl;
}

function _closeTT() {
  if (_ttPortalEl) { _ttPortalEl.innerHTML = ""; _ttPortalEl.classList.remove("visible"); }
  _ttAnchorEl = null;
}

function _openTT(el, e) {
  e?.stopPropagation();
  if (_ttAnchorEl === el) { _closeTT(); return; }
  _closeTT();
  _ttAnchorEl = el;

  const ttSource = el.querySelector(".lmap-wpin-tooltip");
  if (!ttSource) return;

  const portal = _getPortal();
  const card   = document.createElement("div");
  card.className = "lmap-tt-card";
  card.innerHTML = ttSource.innerHTML;
  portal.innerHTML = "";
  portal.appendChild(card);
  portal.classList.add("visible");

  // Re-attach button listeners inside the portal card
  card.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", e2 => {
      e2.stopPropagation();
      const action = btn.dataset.action;
      _closeTT();
      if (action === "enter") {
        const id = btn.dataset.id;
        _mapBreadcrumbs = [{id:"world", label:"World Map"}];
        renderContinent(id);
      } else if (action === "travel") {
        const d = btn.dataset;
        window.openTravelModal?.(d.dest, (d.label||d.cont||"").split("·")[0].trim(), parseInt(d.cost), parseInt(d.time));
      } else if (action === "view") {
        const cid = btn.dataset.cid || btn.dataset.continent;
        const sid = btn.dataset.id;
        if (cid && sid) { _mapBreadcrumbs.push({id:cid, label:CONTINENTS[cid]?.name||cid}); renderSettlement(sid, cid); }
      } else if (action === "view-capital") {
        const cid = btn.dataset.cid;
        if (cid) { _mapBreadcrumbs.push({id:cid, label:CONTINENTS[cid]?.name||cid}); renderCapital(cid); }
      } else if (action === "wildlands") {
        const cid = btn.dataset.cid || btn.dataset.id;
        _mapBreadcrumbs.push({id:cid, label:CONTINENTS[cid]?.name||cid});
        renderWildlands(cid);
      } else if (action === "gather") {
        window.switchPanel?.("profession");
        window.showToast?.("You are at a resource zone — gather away!", "success");
      } else if (action === "fight") {
        window.switchPanel?.("battle");
        window.setBattleMode?.("farming");
        setTimeout(() => window._autoSelectZoneByName?.(btn.dataset.zone), 80);
      } else if (action === "temple") {
        window._openTemplePanel?.();
      } else if (action === "travel-pub") {
        const d = btn.dataset;
        window.openTravelModal?.(d.dest, d.continent, 10, 60);
      } else if (action === "enter-pub") {
        window._openPubPanel?.();
      } else if (action === "enter-sr") {
        const srId = btn.dataset.id;
        _mapBreadcrumbs.push({ id: "vorthak", label: "Vorthak" });
        renderVorthakSubRegion(srId);
      }
    });
  });

  // Also handle travel buttons without data-action (wildlands zone travel btns)
  card.querySelectorAll(".lmap-wpin-travel-btn:not([data-action])").forEach(btn => {
    btn.addEventListener("click", e2 => {
      e2.stopPropagation();
      const d = btn.dataset;
      _closeTT();
      // Monster, resource and deity zones are always free — never charge the zone travelCost
      const zoneType = d.zoneType || "";
      const isFree = zoneType === "monster" || zoneType === "resource" || zoneType === "deity";
      window.openTravelModal?.(d.dest, (d.cont||"").split("·")[0].trim(), isFree ? 0 : parseInt(d.cost), parseInt(d.time));
    });
  });

  // Position: prefer ABOVE the pin, flip below if near top, always within viewport
  const pinRect = el.getBoundingClientRect();
  const margin  = 10;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cardW = Math.min(230, vw - margin * 2);

  // Horizontal: centre on pin, clamp within viewport
  let left = pinRect.left + pinRect.width / 2 - cardW / 2;
  left = Math.max(margin, Math.min(vw - cardW - margin, left));

  // Vertical: above by default, below if not enough room
  // Use estimated height first, correct after render
  const estH = 170;
  let top = pinRect.top - estH - 12;
  if (top < margin) top = pinRect.bottom + 10;

  card.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${cardW}px;`;

  // After DOM paint, correct with real dimensions
  requestAnimationFrame(() => {
    const r = card.getBoundingClientRect();
    // Horizontal clamp
    if (r.right > vw - margin)  card.style.left = (vw - r.width - margin) + "px";
    if (parseFloat(card.style.left) < margin) card.style.left = margin + "px";
    // Vertical: above preferred
    let t = pinRect.top - r.height - 12;
    if (t < margin) t = pinRect.bottom + 10;
    if (t + r.height > vh - margin) t = pinRect.top - r.height - 12;
    card.style.top = Math.max(margin, t) + "px";
  });
}

// ── Place world-space pins (handles contain layout) ──
function _placePins(container, img, pinsEl, pinDefs, renderFn) {
  function place() {
    pinsEl.innerHTML="";
    const cw=container.offsetWidth, ch=container.offsetHeight;
    const iw=img.naturalWidth||1400, ih=img.naturalHeight||800;
    const sc=Math.min(cw/iw,ch/ih);
    const rw=iw*sc, rh=ih*sc, ox=(cw-rw)/2, oy=(ch-rh)/2;
    pinDefs.forEach(p=>{ const el=renderFn(p, ox+(p.x/100)*rw, oy+(p.y/100)*rh); if(el) pinsEl.appendChild(el); });
  }
  if(img.complete&&img.naturalWidth) place(); else img.addEventListener("load",place);
  return place;
}

// ── Place image-space pins (cover layout — direct % on image) ──
function _placeCoverPins(imgEl, pinsEl, pinDefs, renderFn) {
  function place() {
    pinsEl.innerHTML="";
    const iw=imgEl.offsetWidth, ih=imgEl.offsetHeight;
    pinDefs.forEach(p=>{ const el=renderFn(p, (p.x/100)*iw, (p.y/100)*ih); if(el) pinsEl.appendChild(el); });
  }
  if(imgEl.complete&&imgEl.naturalWidth) place(); else imgEl.addEventListener("load",place);
  window.addEventListener("resize",place);
  return place;
}

// ═══════════════════════════════
//  LAYER 1 — WORLD MAP
// ═══════════════════════════════
function renderWorldMap() {
  _mapLayer="world"; _mapBreadcrumbs=[];
  const c=_c(); if(!c) return;
  c.innerHTML=`<div class="lmap-world-wrap" id="lmap-zoom-wrap" style="position:relative;width:100%;height:100%;">
    <img id="lmap-wimg" src="${MAP_IMAGES.world}" style="width:100%;height:100%;object-fit:contain;display:block;" draggable="false"/>
    <div id="lmap-wpins" style="position:absolute;inset:0;pointer-events:none;overflow:visible;"></div>
  </div>`;
  const wrap=document.getElementById("lmap-zoom-wrap");
  _initZoomPan(c, wrap);

  const img=document.getElementById("lmap-wimg");
  const pins=document.getElementById("lmap-wpins");

  function renderWorldPin(pin, px, py) {
    const cont=CONTINENTS[pin.id];
    const inCont=_isInContinent(pin.id);
    const locked=!_canEnter(pin.id);
    const atPin = _isAtLocation(pin.id);
    const col=pin.type==="capital"?(atPin?"#4fc870":"#e8d070"):pin.type==="danger"?"#e05555":"#d070e0";
    const pinGlow = pin.type==="capital"&&atPin
      ? "0 0 0 4px rgba(79,200,112,0.35),0 0 18px rgba(79,200,112,0.9)"
      : `0 0 0 3px ${col}44, 0 0 14px ${col}cc`;
    const pinAnim = pin.type==="capital"&&atPin ? "animation:lmap-pulse-player 1.8s infinite;" : "";

    // Player position for this continent
    const pp=WORLD_PLAYER_PINS.find(p=>p.id===pin.id);
    const playerPin=pp&&inCont?`<div style="position:absolute;left:${pp.x}%;top:${pp.y}%;transform:translate(-50%,-50%);pointer-events:none;z-index:15;">
      <div class="lmap-player-dot"></div>
    </div>`:""

    let ttBody;
    if(inCont) {
      ttBody=`<div class="lmap-wpin-tt-name">${pin.label}</div><div class="lmap-wpin-tt-sub">${cont.label}</div><div class="lmap-wpin-tt-here">✓ You are in this region</div>
        <button class="lmap-wpin-travel-btn" data-action="enter" data-id="${pin.id}">ENTER CONTINENT →</button>`;
    } else {
      ttBody=`<div class="lmap-wpin-tt-name">${pin.label}</div><div class="lmap-wpin-tt-sub">${cont.label}</div>
        <button class="lmap-wpin-travel-btn" data-action="travel" data-id="${pin.id}" data-cost="${pin.travelCost}" data-time="${pin.travelTime}" data-dest="${cont.capital||cont.name}">
          TRAVEL HERE — ${pin.travelCost}🪙 · ${_ft(pin.travelTime)}
        </button>`;
    }

    const el=document.createElement("div");
    el.className="lmap-wpin"; el.style.cssText=`position:absolute;left:${px}px;top:${py}px;transform:translate(-50%,-50%);z-index:10;pointer-events:all;overflow:visible;`;
    el.innerHTML=`<div class="lmap-wpin-dot" style="background:${col};box-shadow:${pinGlow};${pinAnim}"></div>
      <div class="lmap-wpin-label">${pin.label}</div>
      <div class="lmap-wpin-tooltip">${ttBody}</div>`;
    el.querySelector(".lmap-wpin-dot").addEventListener("click",e=>{ e.stopPropagation(); _openTT(el, e); });
    el.querySelector('[data-action="enter"]')?.addEventListener("click",e=>{ e.stopPropagation(); _closeTT(); _mapBreadcrumbs=[{id:"world",label:"World Map"}]; renderContinent(pin.id); });
    el.querySelector('[data-action="travel"]')?.addEventListener("click",e=>{ e.stopPropagation(); _closeTT(); const d=e.currentTarget.dataset; window.openTravelModal?.(d.dest,cont.label.split("·")[0].trim(),parseInt(d.cost),parseInt(d.time)); });
    return el;
  }

  // Also render player dot separately (world-space positioned)
  function place() {
    pins.innerHTML="";
    const cw=c.offsetWidth, ch=c.offsetHeight;
    const iw=img.naturalWidth||1400, ih=img.naturalHeight||800;
    const sc=Math.min(cw/iw,ch/ih);
    const rw=iw*sc, rh=ih*sc, ox=(cw-rw)/2, oy=(ch-rh)/2;
    const playerCid=_playerContinentId();

    WORLD_PINS.forEach(pin=>{
      const el=renderWorldPin(pin, ox+(pin.x/100)*rw, oy+(pin.y/100)*rh);
      if(el) pins.appendChild(el);
    });

    // Player dot
    if(playerCid) {
      const pp=WORLD_PLAYER_PINS.find(p=>p.id===playerCid);
      if(pp) {
        const px2=ox+(pp.x/100)*rw, py2=oy+(pp.y/100)*rh;
        const dot=document.createElement("div");
        dot.className="lmap-player-dot"; dot.style.cssText=`position:absolute;left:${px2}px;top:${py2}px;transform:translate(-50%,-50%);pointer-events:none;z-index:15;`;
        pins.appendChild(dot);
      }
    }
    pins.style.pointerEvents="none";
    pins.querySelectorAll(".lmap-wpin").forEach(el=>el.style.pointerEvents="all");
  }

  if(img.complete&&img.naturalWidth) place(); else img.addEventListener("load",place);
  c.addEventListener("click",_closeTT);
  window._mapResizeHandler&&window.removeEventListener("resize",window._mapResizeHandler);
  window._mapResizeHandler=()=>{ if(_mapLayer==="world") place(); };
  window.addEventListener("resize",window._mapResizeHandler);
}

// ═══════════════════════════════
//  LAYER 2 — CONTINENT VIEW
// ═══════════════════════════════
function renderContinent(cid) {
  // Vorthak has no capital — render its sub-region overview directly
  if (cid === "vorthak") { renderVorthakOverview(); return; }

  const cont=CONTINENTS[cid]; if(!cont) return;
  _mapLayer=cid;
  const c=_c(); if(!c) return;
  const here=_isInContinent(cid);
  const tagType=cont.capitalId?"safe":(cid==="nyx_abyss"?"endgame":"danger");
  const imgUrl=MAP_IMAGES[cont.image];

  c.innerHTML=`
    <div class="lmap-location-wrap">
      <div class="lmap-img-side" id="lmap-img-side">
        <div style="position:relative;width:100%;height:100%;overflow:visible;" id="lmap-zoom-wrap">
          <img src="${imgUrl}" class="lmap-location-img" id="lmap-loc-img" draggable="false"/><div class="lmap-img-overlay"></div>
          <div id="lmap-loc-pins" style="position:absolute;inset:0;pointer-events:none;z-index:10;overflow:visible;"></div>
          ${here?`<div class="lmap-here-badge">✓ You are in this region</div>`:""}
          ${_bcBar(cont.capital||cont.name)}
        </div>
      </div>
      <div class="lmap-sidebar">
        <div class="lmap-sidebar-header">
          <div class="lmap-sidebar-region">${cont.label}</div>
          <div class="lmap-sidebar-name">${cont.capital||cont.name}</div>
          <span class="lmap-tag" style="${_tagStyle(tagType)}">${cont.capitalId?"SAFE ZONE · Capital":"DANGER ZONE"}</span>
        </div>
        <div class="lmap-sidebar-lists" id="lmap-sidebar-lists">
          ${cont.settlements.length?`<div class="lmap-section-title">SETTLEMENTS</div>${cont.settlements.map(s=>`<div class="lmap-info-item"><span class="lmap-info-dot" style="background:#e8d070"></span><span class="lmap-info-name">🏘️ ${s.label}</span>${_isAtLocation(s.id)?`<span class="lmap-here-badge-small">HERE</span>`:""}</div>`).join("")}`:""}
          ${cont.explore.length?`<div class="lmap-section-title" style="margin-top:10px">EXPLORE ZONES</div>
            ${cont.explore.map(e=>`<div class="lmap-info-item">
              <span class="lmap-info-dot" style="background:${e.type==="monster"?_gradeCol(e.grade):e.type==="resource"?"#5b9fe0":"#c44dff"}"></span>
              <span class="lmap-info-name">${_icon(e.type)} ${e.label}</span>
              ${e.grade?`<span style="font-size:9px;color:${_gradeCol(e.grade)};margin-left:auto">${e.grade}</span>`:""}
            </div>`).join("")}`:""}
        </div>
        <div class="lmap-sidebar-footer">
          ${!here
            ? (() => {
                const sameContinent = _isInContinent(cid);
                const cost = sameContinent ? 20 : cont.travelCost;
                const time = sameContinent ? 60 : cont.travelTime;
                return `<button class="lmap-travel-btn" id="lmap-main-travel">TRAVEL HERE — ${cost}🪙 · ${_ft(time)}</button>`;
              })()
            : `<div class="lmap-here-text">✓ YOU ARE HERE</div>`}
        </div>
      </div>
    </div>`;

  _setupBC(c);
  _initZoomPan(document.getElementById("lmap-img-side"), document.getElementById("lmap-zoom-wrap"));
  c.querySelector("#lmap-main-travel")?.addEventListener("click",()=>{
    const sameContinent = _isInContinent(cid);
    const cost = sameContinent ? 20 : cont.travelCost;
    const time = sameContinent ? 60 : cont.travelTime;
    window.openTravelModal?.(cont.capital||cont.name,cont.label.split("·")[0].trim(),cost,time);
  });
  c.querySelector(".lmap-img-side")?.addEventListener("click",_closeTT);

  const imgEl=document.getElementById("lmap-loc-img");
  const pinsEl=document.getElementById("lmap-loc-pins");

  _placeCoverPins(imgEl, pinsEl, [
    // Capital city pin (opens capital map view)
    ...(cont.capitalPin&&cont.capitalImage?[{...cont.capitalPin, id:"capital_"+cid, label:cont.capital||cont.name, _type:"capital"}]:[]),
    // Settlement pins
    ...cont.settlements.map(s=>({...s, _type:"settlement"})),
    // Wildlands entry pin
    ...(cont.wildlandsPin?[{...cont.wildlandsPin, id:"wildlands_"+cid, label:"Explore Wildlands", _type:"wildlands"}]:[]),
    // Explore zone pins (on wildlands image — shown on capital as wildlands entry only)
  ], (p, px, py) => {
    const el=document.createElement("div");
    el.className="lmap-loc-pin"; el.style.cssText=`position:absolute;left:${px}px;top:${py}px;transform:translate(-50%,-50%);pointer-events:all;overflow:visible;`;

    if(p._type==="capital") {
      const atC=_isAtCapital(cid);
      const capDot=atC?'background:#4fc870;box-shadow:0 0 0 4px rgba(79,200,112,0.3),0 0 16px rgba(79,200,112,0.8);animation:lmap-pulse-player 1.8s infinite':'background:#c9a84c;box-shadow:0 0 0 3px rgba(201,168,76,0.3),0 0 14px rgba(201,168,76,0.7)';
      el.innerHTML=`<div class="lmap-loc-pin-dot" style="${capDot}"></div>
        <div class="lmap-loc-pin-label" style="color:${atC?'#4fc870':'#c9a84c'}">${cont.capital||cont.name}</div>
        <div class="lmap-wpin-tooltip">
          <div class="lmap-wpin-tt-name">🏰 ${cont.capital||cont.name}</div>
          <div style="font-size:10px;color:#aaa;margin:4px 0;">Capital city · Safe Zone</div>
          ${atC?`<div class="lmap-wpin-tt-here">✓ You are here</div>
            <button class="lmap-wpin-travel-btn" data-action="view-capital" data-cid="${cid}">VIEW CAPITAL →</button>`
            :`<button class="lmap-wpin-travel-btn" data-action="travel-capital" data-cid="${cid}" data-dest="${cont.capital||cont.name}" data-continent="${cont.label}">TRAVEL HERE — 20🪙 · 1 min</button>`}
        </div>`;
      el.querySelector(".lmap-loc-pin-dot").addEventListener("click",e=>{ e.stopPropagation(); _openTT(el, e); });
      el.querySelector('[data-action="view-capital"]')?.addEventListener("click",e=>{ e.stopPropagation(); _closeTT(); _mapBreadcrumbs.push({id:cid,label:cont.name}); renderCapital(cid); });
      el.querySelector('[data-action="travel-capital"]')?.addEventListener("click",e=>{ e.stopPropagation(); _closeTT(); const d=e.currentTarget.dataset; window.openTravelModal?.(d.dest, d.continent.split("·")[0].trim(), 20, 60); });
    } else if(p._type==="wildlands") {
      el.innerHTML=`<div class="lmap-explore-dot" style="background:#4fc870;border-color:#4fc87099;animation:lmap-pulse 2s infinite;"></div>
        <div class="lmap-loc-pin-label" style="color:#70c090">🌿 Explore</div>
        <div class="lmap-wpin-tooltip">
          <div class="lmap-wpin-tt-name">Explore the Wildlands</div>
          <div style="font-size:10px;color:#aaa;margin:4px 0;">Monster zones, resource zones and deity shrines</div>
          <button class="lmap-wpin-travel-btn" data-action="wildlands" data-cid="${cid}">ENTER WILDLANDS →</button>
        </div>`;
      el.querySelector(".lmap-explore-dot").addEventListener("click",e=>{ e.stopPropagation(); _openTT(el, e); });
      el.querySelector('[data-action="wildlands"]')?.addEventListener("click",e=>{ e.stopPropagation(); _closeTT(); _mapBreadcrumbs.push({id:cid,label:cont.name}); renderWildlands(cid); });
    } else if(p._type==="pub") {
      const atCap=_isAtCapital(cid);
      const pubDot=atCap
        ?'background:#c9784c;box-shadow:0 0 0 4px rgba(201,120,76,0.3),0 0 16px rgba(201,120,76,0.8);animation:lmap-pulse-player 1.8s infinite'
        :'background:#8b5030;box-shadow:0 0 0 3px rgba(139,80,48,0.3),0 0 10px rgba(201,120,76,0.4)';
      el.innerHTML=`<div class="lmap-loc-pin-dot" style="${pubDot};width:11px;height:11px;border-radius:50%;"></div>
        <div class="lmap-loc-pin-label" style="color:#c9784c">🍺 Pub</div>
        <div class="lmap-wpin-tooltip">
          <div class="lmap-wpin-tt-name">🍺 The Pub</div>
          <div style="font-size:10px;color:#aaa;margin:4px 0;">Games · Gambling · Glory</div>
          ${atCap
            ?`<div class="lmap-wpin-tt-here">✓ You are here — enter anytime</div>
               <button class="lmap-wpin-travel-btn" data-action="pub" style="background:rgba(201,120,76,0.15);border-color:rgba(201,120,76,0.5);color:#c9784c;margin-top:6px;">🍺 ENTER PUB →</button>`
            :`<div style="font-size:10px;color:#777;margin-top:4px;">Travel to the capital first.</div>`}
        </div>`;
      el.querySelector(".lmap-loc-pin-dot").addEventListener("click",e=>{ e.stopPropagation(); _openTT(el, e); });
      el.querySelector('[data-action="pub"]')?.addEventListener("click",e=>{ e.stopPropagation(); _closeTT(); window._openPubPanel?.(); });
    } else {
      // Settlement pin
      const atS=_isAtLocation(p.id);
      const canTravel=here;
      const settleDot = atS ? 'background:#4fc870;box-shadow:0 0 0 4px rgba(79,200,112,0.3),0 0 16px rgba(79,200,112,0.8);animation:lmap-pulse-player 1.8s infinite' : 'background:#e8d070;box-shadow:0 0 0 3px rgba(232,208,112,0.3),0 0 12px rgba(232,208,112,0.6)';
      el.innerHTML=`<div class="lmap-loc-pin-dot" style="${settleDot}"></div>
        <div class="lmap-loc-pin-label" style="color:${atS?'#4fc870':'#e8d070'}">${p.label}</div>
        <div class="lmap-wpin-tooltip">
          <div class="lmap-wpin-tt-name">${p.label}</div>
          <div style="font-size:10px;color:#888;margin:3px 0 6px;">${p.desc}</div>
          ${atS?`<div class="lmap-wpin-tt-here">✓ You are here</div>
            <button class="lmap-wpin-travel-btn" data-action="view" data-id="${p.id}" data-cid="${cid}">VIEW LOCATION →</button>`
            :canTravel?`<button class="lmap-wpin-travel-btn" data-action="travel" data-cost="${p.travelCost}" data-time="${p.travelTime}" data-dest="${p.label}">TRAVEL — ${p.travelCost}🪙 · ${_ft(p.travelTime)}</button>
              <button class="lmap-wpin-travel-btn" data-action="view" data-id="${p.id}" data-cid="${cid}" style="background:transparent;border-color:rgba(255,255,255,0.15);color:#aaa;margin-top:4px;">VIEW LOCATION →</button>`
            :`<div style="font-size:10px;color:#777;margin-top:4px;">Travel to the capital first.</div>`}
        </div>`;
      el.querySelector(".lmap-loc-pin-dot").addEventListener("click",e=>{ e.stopPropagation(); _openTT(el, e); });
      el.querySelector('[data-action="travel"]')?.addEventListener("click",e=>{ e.stopPropagation(); const d=e.currentTarget.dataset; window.openTravelModal?.(d.dest,cont.label.split("·")[0].trim(),parseInt(d.cost),parseInt(d.time)); });
      el.querySelector('[data-action="view"]')?.addEventListener("click",e=>{ e.stopPropagation(); _closeTT(); _mapBreadcrumbs.push({id:cid,label:cont.name}); renderSettlement(e.currentTarget.dataset.id,cid); });
    }
    return el;
  });

  // Capital player pin — only if player is at the capital itself (not a settlement)

}

// ═══════════════════════════════
//  LAYER 2b — WILDLANDS VIEW
// ═══════════════════════════════
function renderWildlands(cid) {
  const cont=CONTINENTS[cid]; if(!cont) return;
  _mapLayer="wildlands_"+cid;
  const c=_c(); if(!c) return;
  const imgUrl=MAP_IMAGES[cont.wildlandsId];

  c.innerHTML=`
    <div class="lmap-location-wrap">
      <div class="lmap-img-side" id="lmap-img-side">
        <div style="position:relative;width:100%;height:100%;overflow:visible;" id="lmap-zoom-wrap">
          <img src="${imgUrl}" class="lmap-location-img" id="lmap-loc-img" draggable="false"/><div class="lmap-img-overlay"></div>
          <div id="lmap-loc-pins" style="position:absolute;inset:0;pointer-events:none;z-index:10;overflow:visible;"></div>
          ${_bcBar("Wildlands")}
        </div>
      </div>
      <div class="lmap-sidebar">
        <div class="lmap-sidebar-header">
          <div class="lmap-sidebar-region">${cont.label}</div>
          <div class="lmap-sidebar-name">Wildlands</div>
          <span class="lmap-tag" style="background:rgba(220,80,80,0.2);border:0.5px solid rgba(220,80,80,0.5);color:#e05555;">EXPLORE ZONE</span>
        </div>
        <div class="lmap-sidebar-lists">
          <div class="lmap-section-title">MONSTER ZONES</div>
          ${cont.explore.filter(e=>e.type==="monster").map(e=>`<div class="lmap-info-item"><span class="lmap-info-dot" style="background:${_gradeCol(e.grade)}"></span><span class="lmap-info-name">⚔️ ${e.label}</span><span style="font-size:9px;color:${_gradeCol(e.grade)};margin-left:auto">${e.grade}</span></div>`).join("")}
          <div class="lmap-section-title" style="margin-top:10px">RESOURCE ZONES</div>
          ${cont.explore.filter(e=>e.type==="resource").map(e=>`<div class="lmap-info-item"><span class="lmap-info-dot" style="background:#5b9fe0"></span><span class="lmap-info-name">⛏️ ${e.label}</span><span style="font-size:9px;color:#70c090;margin-left:auto">${e.prof}</span></div>`).join("")}
          <div class="lmap-section-title" style="margin-top:10px">DEITY SHRINES</div>
          ${cont.explore.filter(e=>e.type==="deity").map(e=>`<div class="lmap-info-item"><span class="lmap-info-dot" style="background:#c44dff"></span><span class="lmap-info-name">✦ ${e.label}</span></div>`).join("")}
        </div>
        <div class="lmap-sidebar-footer"><div style="font-size:10px;color:#555;text-align:center;">Click a pin on the map to travel to a zone</div></div>
      </div>
    </div>`;

  _setupBC(c);
  _initZoomPan(document.getElementById("lmap-img-side"), document.getElementById("lmap-zoom-wrap"));
  c.querySelector(".lmap-img-side")?.addEventListener("click",_closeTT);

  const imgEl=document.getElementById("lmap-loc-img");
  const pinsEl=document.getElementById("lmap-loc-pins");

  _placeCoverPins(imgEl, pinsEl, cont.explore, (zone, px, py) => {
    // Pin colours: monster=red, resource=blue, deity=purple
    const dotCol=zone.type==="monster"?"#e03030":zone.type==="resource"?"#5b9fe0":"#c44dff";
    const atZone=_isAtLocation(zone.id)||_isAtLocation(zone.label);
    // Pulse: when player is here → bright arrival beacon; otherwise → type pulse
    let pulseAnim, dotStyle;
    if (atZone) {
      // Arrival beacon: bright pulsing halo, pin switches to vivid colour
      const arrivalCol = zone.type==="monster"?"#ff4444":zone.type==="resource"?"#60b8ff":"#dd55ff";
      dotStyle = `background:${arrivalCol};border-color:${arrivalCol};box-shadow:0 0 0 5px ${arrivalCol}55,0 0 22px ${arrivalCol}cc;`;
      pulseAnim = zone.type==="monster"?"lmap-pulse-arrival-red 1.2s infinite":zone.type==="resource"?"lmap-pulse-arrival-blue 1.2s infinite":"lmap-pulse-arrival-gold 1.2s infinite";
    } else {
      dotStyle = zone.type==="monster"
        ? `background:#e03030;border-color:#111;box-shadow:0 0 0 3px #11111188,0 0 10px #e0303099;`
        : zone.type==="resource"
        ? `background:#5b9fe0;border-color:#5b9fe0;box-shadow:0 0 0 3px rgba(91,159,224,0.3),0 0 10px rgba(91,159,224,0.6);`
        : `background:#c44dff;border-color:#c44dff;box-shadow:0 0 0 3px rgba(196,77,255,0.3),0 0 10px rgba(196,77,255,0.6);`;
      pulseAnim = "none";
    }
    const el=document.createElement("div");
    el.className="lmap-explore-pin"; el.style.cssText=`position:absolute;left:${px}px;top:${py}px;transform:translate(-50%,-50%);pointer-events:all;overflow:visible;`;

    let detail=zone.type==="monster"
      ?`<div style="font-size:10px;color:#aaa;margin:3px 0;">${zone.monsters}</div><span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(0,0,0,0.5);color:${_gradeCol(zone.grade)};">${zone.grade&&zone.grade.includes('-')&&!zone.grade.includes('S')&&!zone.grade.includes('A')&&!zone.grade.includes('B')&&!zone.grade.includes('C')?'Lv. '+zone.grade:'Grade '+zone.grade}</span>`
      :zone.type==="resource"?`<div style="font-size:10px;color:#70c090;margin:3px 0;">Professions: ${zone.prof}</div>`
      :`<div style="font-size:10px;color:#c44dff;margin:3px 0;">${zone.deity}</div>`;

    el.innerHTML=`<div class="lmap-explore-dot" style="${dotStyle}animation:${pulseAnim};"></div>
      <div class="lmap-loc-pin-label" style="color:${atZone?(zone.type==="monster"?"#ff4444":zone.type==="resource"?"#60b8ff":"#dd55ff"):dotCol}">${zone.label}</div>
      <div class="lmap-wpin-tooltip">
        <div class="lmap-wpin-tt-name">${_icon(zone.type)} ${zone.label}</div>
        ${detail}
        ${atZone
          ? `<div class="lmap-here-text" style="margin-top:8px;">📍 YOU ARE HERE</div>
             ${zone.type==="resource"
               ? `<button class="lmap-wpin-travel-btn" data-action="gather" style="margin-top:6px;background:rgba(91,159,224,0.15);border-color:rgba(91,159,224,0.5);color:#5b9fe0;">
                    ⛏️ GATHER HERE
                  </button>`
               : zone.type==="monster"
               ? `<button class="lmap-wpin-travel-btn" data-action="fight" data-zone="${zone.label}" style="margin-top:6px;background:rgba(224,112,96,0.15);border-color:rgba(224,112,96,0.5);color:#e07060;">
                    ⚔️ FIGHT HERE
                  </button>`
               : zone.type==="deity"
               ? `<button class="lmap-wpin-travel-btn" data-action="temple" style="margin-top:6px;background:rgba(196,77,255,0.15);border-color:rgba(196,77,255,0.5);color:#c44dff;">
                    🙏 VISIT TEMPLE
                  </button>`
               : ""}`
          : `<button class="lmap-wpin-travel-btn" data-cost="${zone.travelCost}" data-time="${zone.travelTime}" data-dest="${zone.label}" data-cont="${cont.label}" data-zone-type="${zone.type}" style="margin-top:8px;">
               TRAVEL HERE — ⏱ ${_ft(zone.travelTime)}${zone.type==="monster"||zone.type==="resource"||zone.type==="deity" ? " · Free" : ` · ${zone.travelCost}🪙`}
             </button>`
        }
      </div>`;

    el.querySelector(".lmap-explore-dot").addEventListener("click",e=>{ e.stopPropagation(); _openTT(el, e); });
    el.querySelector(".lmap-wpin-travel-btn[data-cost]")?.addEventListener("click",e=>{
      e.stopPropagation();
      const d=e.currentTarget.dataset;
      // Monster, resource and deity zones are free — no gold cost
      const isFree = zone.type==="monster"||zone.type==="resource"||zone.type==="deity";
      window.openTravelModal?.(d.dest,(d.cont||cont.label).split("·")[0].trim(), isFree ? 0 : parseInt(d.cost), parseInt(d.time));
    });
    el.querySelector('[data-action="gather"]')?.addEventListener("click",e=>{
      e.stopPropagation(); _closeTT();
      window.switchPanel?.("profession");
      window.showToast?.("You are at a resource zone — gather away!", "success");
    });
    el.querySelector('[data-action="fight"]')?.addEventListener("click",e=>{
      e.stopPropagation(); _closeTT();
      window.switchPanel?.("battle");
      window.setBattleMode?.("farming");
      setTimeout(()=>window._autoSelectZoneByName?.(zone.label), 80);
    });
    el.querySelector('[data-action="temple"]')?.addEventListener("click",e=>{
      e.stopPropagation(); _closeTT();
      window._openTemplePanel?.();
    });
    return el;
  });

}

// ═══════════════════════════════════════════════════
//  VORTHAK OVERVIEW — shows 5 sub-region pins
// ═══════════════════════════════════════════════════
function renderVorthakOverview() {
  const cont = CONTINENTS.vorthak;
  _mapLayer = "vorthak";
  const c = _c(); if (!c) return;
  const here = _isInContinent("vorthak");

  c.innerHTML = `
    <div class="lmap-location-wrap">
      <div class="lmap-img-side" id="lmap-img-side">
        <div style="position:relative;width:100%;height:100%;overflow:visible;" id="lmap-zoom-wrap">
          <img src="${MAP_IMAGES.vorthak}" class="lmap-location-img" id="lmap-loc-img" draggable="false"/>
          <div class="lmap-img-overlay"></div>
          <div id="lmap-loc-pins" style="position:absolute;inset:0;pointer-events:none;z-index:10;overflow:visible;"></div>
          ${here ? `<div class="lmap-here-badge">✓ You are in this region</div>` : ""}
          ${_bcBar("Vorthak")}
        </div>
      </div>
      <div class="lmap-sidebar">
        <div class="lmap-sidebar-header">
          <div class="lmap-sidebar-region">${cont.label}</div>
          <div class="lmap-sidebar-name">Vorthak</div>
          <span class="lmap-tag" style="${_tagStyle("danger")}">DANGER ZONE · Monster Continent</span>
        </div>
        <div class="lmap-sidebar-lists">
          <div class="lmap-section-title">SUB-REGIONS</div>
          ${cont.subRegions.map(sr => `
            <div class="lmap-info-item">
              <span class="lmap-info-dot" style="background:#e05555"></span>
              <span class="lmap-info-name">⚔️ ${sr.label}</span>
              <span style="font-size:9px;color:#aaa;margin-left:auto">${sr.zones.length} zones</span>
            </div>`).join("")}
        </div>
        <div class="lmap-sidebar-footer">
          ${!here
            ? `<button class="lmap-travel-btn" id="lmap-vorthak-travel">TRAVEL HERE — ${cont.travelCost}🪙 · ${_ft(cont.travelTime)}</button>`
            : `<div class="lmap-here-text">✓ YOU ARE HERE</div>`}
        </div>
      </div>
    </div>`;

  _setupBC(c);
  _initZoomPan(document.getElementById("lmap-img-side"), document.getElementById("lmap-zoom-wrap"));
  c.querySelector("#lmap-vorthak-travel")?.addEventListener("click", () =>
    window.openTravelModal?.("Vorthak", "Eastern Continent", cont.travelCost, cont.travelTime));
  c.querySelector(".lmap-img-side")?.addEventListener("click", _closeTT);

  const imgEl = document.getElementById("lmap-loc-img");
  const pinsEl = document.getElementById("lmap-loc-pins");

  _placeCoverPins(imgEl, pinsEl, cont.subRegions, (sr, px, py) => {
    const el = document.createElement("div");
    el.className = "lmap-loc-pin";
    el.style.cssText = `position:absolute;left:${px}px;top:${py}px;transform:translate(-50%,-50%);pointer-events:all;overflow:visible;`;
    const atSr = sr.zones.some(z => _isAtLocation(z.id) || _isAtLocation(z.label));
    const dotStyle = atSr
      ? "background:#ff4444;box-shadow:0 0 0 4px rgba(255,68,68,0.3),0 0 16px rgba(255,68,68,0.8);animation:lmap-pulse-arrival-red 1.2s infinite"
      : "background:#e03030;box-shadow:0 0 0 3px rgba(224,48,48,0.3),0 0 12px rgba(224,48,48,0.6)";
    el.innerHTML = `
      <div class="lmap-loc-pin-dot" style="${dotStyle}"></div>
      <div class="lmap-loc-pin-label" style="color:${atSr ? "#ff4444" : "#e05555"}">${sr.label}</div>
      <div class="lmap-wpin-tooltip">
        <div class="lmap-wpin-tt-name">⚔️ ${sr.label}</div>
        <div style="font-size:10px;color:#aaa;margin:4px 0;">${sr.zones.length} monster zones</div>
        <button class="lmap-wpin-travel-btn" data-action="enter-sr" data-id="${sr.id}">ENTER REGION →</button>
      </div>`;
    el.querySelector(".lmap-loc-pin-dot").addEventListener("click", e => { e.stopPropagation(); _openTT(el, e); });
    el.querySelector('[data-action="enter-sr"]')?.addEventListener("click", e => {
      e.stopPropagation(); _closeTT();
      _mapBreadcrumbs.push({ id: "vorthak", label: "Vorthak" });
      renderVorthakSubRegion(sr.id);
    });
    return el;
  });
}

// ═══════════════════════════════════════════════════
//  VORTHAK SUB-REGION — shows zone pins for one region
// ═══════════════════════════════════════════════════
function renderVorthakSubRegion(srId) {
  const cont = CONTINENTS.vorthak;
  const sr = cont.subRegions.find(r => r.id === srId);
  if (!sr) return;
  _mapLayer = "vorthak_sr_" + srId;
  const c = _c(); if (!c) return;

  c.innerHTML = `
    <div class="lmap-location-wrap">
      <div class="lmap-img-side" id="lmap-img-side">
        <div style="position:relative;width:100%;height:100%;overflow:visible;" id="lmap-zoom-wrap">
          <img src="${MAP_IMAGES["vorthak_" + srId] || MAP_IMAGES.vorthak}" class="lmap-location-img" id="lmap-loc-img" draggable="false"/>
          <div class="lmap-img-overlay"></div>
          <div id="lmap-loc-pins" style="position:absolute;inset:0;pointer-events:none;z-index:10;overflow:visible;"></div>
          ${_bcBar(sr.label)}
        </div>
      </div>
      <div class="lmap-sidebar">
        <div class="lmap-sidebar-header">
          <div class="lmap-sidebar-region">Eastern Continent · Vorthak</div>
          <div class="lmap-sidebar-name">${sr.label}</div>
          <span class="lmap-tag" style="${_tagStyle("danger")}">DANGER ZONE</span>
        </div>
        <div class="lmap-sidebar-lists">
          <div class="lmap-section-title">MONSTER ZONES</div>
          ${sr.zones.map(z => `
            <div class="lmap-info-item">
              <span class="lmap-info-dot" style="background:${_gradeCol(z.grade)}"></span>
              <span class="lmap-info-name">⚔️ ${z.label}</span>
              <span style="font-size:9px;color:${_gradeCol(z.grade)};margin-left:auto">${z.grade&&z.grade.includes('-')&&!z.grade.includes('S')&&!z.grade.includes('A')&&!z.grade.includes('B')&&!z.grade.includes('C')?'Lv. '+z.grade:z.grade}</span>
            </div>`).join("")}
        </div>
        <div class="lmap-sidebar-footer"><div style="font-size:10px;color:#555;text-align:center;">Click a pin on the map to travel to a zone</div></div>
      </div>
    </div>`;

  _setupBC(c);
  _initZoomPan(document.getElementById("lmap-img-side"), document.getElementById("lmap-zoom-wrap"));
  c.querySelector(".lmap-img-side")?.addEventListener("click", _closeTT);

  const imgEl = document.getElementById("lmap-loc-img");
  const pinsEl = document.getElementById("lmap-loc-pins");

  _placeCoverPins(imgEl, pinsEl, sr.zones, (zone, px, py) => {
    const dotCol = "#e03030";
    const atZone = _isAtLocation(zone.id) || _isAtLocation(zone.label);
    const dotStyle = atZone
      ? `background:#ff4444;border-color:#ff4444;box-shadow:0 0 0 5px rgba(255,68,68,0.35),0 0 22px rgba(255,68,68,0.8);`
      : `background:#e03030;border-color:#111;box-shadow:0 0 0 3px #11111188,0 0 10px #e0303099;`;
    const pulseAnim = atZone ? "lmap-pulse-arrival-red 1.2s infinite" : "none";

    const el = document.createElement("div");
    el.className = "lmap-explore-pin";
    el.style.cssText = `position:absolute;left:${px}px;top:${py}px;transform:translate(-50%,-50%);pointer-events:all;overflow:visible;`;

    el.innerHTML = `
      <div class="lmap-explore-dot" style="${dotStyle}animation:${pulseAnim};"></div>
      <div class="lmap-loc-pin-label" style="color:${atZone ? "#ff4444" : dotCol}">${zone.label}</div>
      <div class="lmap-wpin-tooltip">
        <div class="lmap-wpin-tt-name">⚔️ ${zone.label}</div>
        <div style="font-size:10px;color:#aaa;margin:3px 0;">${zone.monsters}</div>
        <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(0,0,0,0.5);color:${_gradeCol(zone.grade)};">${zone.grade&&zone.grade.includes('-')&&!zone.grade.includes('S')&&!zone.grade.includes('A')&&!zone.grade.includes('B')&&!zone.grade.includes('C')?'Lv. '+zone.grade:'Grade '+zone.grade}</span>
        ${atZone
          ? `<div class="lmap-here-text" style="margin-top:8px;">📍 YOU ARE HERE</div>
             <button class="lmap-wpin-travel-btn" data-action="fight" data-zone="${zone.label}" style="margin-top:6px;background:rgba(224,112,96,0.15);border-color:rgba(224,112,96,0.5);color:#e07060;">⚔️ FIGHT HERE</button>`
          : `<button class="lmap-wpin-travel-btn" data-cost="${zone.travelCost}" data-time="${zone.travelTime}" data-dest="${zone.label}" data-cont="Eastern Continent" style="margin-top:8px;">
               TRAVEL HERE — ⏱ ${_ft(zone.travelTime)} · Free
             </button>`}
      </div>`;

    el.querySelector(".lmap-explore-dot").addEventListener("click", e => { e.stopPropagation(); _openTT(el, e); });
    el.querySelector(".lmap-wpin-travel-btn[data-cost]")?.addEventListener("click", e => {
      e.stopPropagation();
      const d = e.currentTarget.dataset;
      window.openTravelModal?.(d.dest, "Eastern Continent", 0, parseInt(d.time));
    });
    el.querySelector('[data-action="fight"]')?.addEventListener("click", e => {
      e.stopPropagation(); _closeTT();
      window.switchPanel?.("battle");
      window.setBattleMode?.("farming");
      setTimeout(() => window._autoSelectZoneByName?.(zone.label), 80);
    });
    return el;
  });
}

// ═══════════════════════════════
//  LAYER 3 — SETTLEMENT VIEW
// ═══════════════════════════════
// ═══════════════════════════════
//  LAYER 2c — CAPITAL VIEW
// ═══════════════════════════════
function renderCapital(cid) {
  const cont=CONTINENTS[cid]; if(!cont||!cont.capitalImage) return;
  _mapLayer="capital_"+cid;
  const c=_c(); if(!c) return;
  const here=_isAtCapital(cid);
  const imgUrl=MAP_IMAGES[cont.capitalImage];

  c.innerHTML=`
    <div class="lmap-location-wrap">
      <div class="lmap-img-side" id="lmap-img-side">
        <div style="position:relative;width:100%;height:100%;overflow:visible;" id="lmap-zoom-wrap">
          <img src="${imgUrl}" class="lmap-location-img" id="lmap-loc-img" draggable="false"/><div class="lmap-img-overlay"></div>
          ${here?`<div class="lmap-here-badge">✓ You are here</div>`:""}
          ${_bcBar(cont.capital||cont.name)}
        </div>
      </div>
      <div class="lmap-sidebar">
        <div class="lmap-sidebar-header">
          <div class="lmap-sidebar-region">${cont.label}</div>
          <div class="lmap-sidebar-name">${cont.capital||cont.name}</div>
          <span class="lmap-tag" style="${_tagStyle("safe")}">SAFE ZONE · Capital</span>
        </div>
        <div class="lmap-sidebar-lists">
          <div class="lmap-section-title">IN THIS LOCATION</div>
          <div class="lmap-info-item"><span class="lmap-info-dot" style="background:#5dbe85;"></span><span class="lmap-info-name">💬 RP Chat (capital chat available here)</span></div>
          <div class="lmap-info-item"><span class="lmap-info-dot" style="background:#5b9fe0;"></span><span class="lmap-info-name">🧑 NPCs — vendors, quest givers, guild masters</span></div>
          <div class="lmap-info-item"><span class="lmap-info-dot" style="background:#c9a84c;"></span><span class="lmap-info-name">🏪 Market — buy and sell with other players</span></div>
          <div class="lmap-info-item"><span class="lmap-info-dot" style="background:#c44dff;"></span><span class="lmap-info-name">✦ Shrine — worship your deity here</span></div>
          <div class="lmap-info-item"><span class="lmap-info-dot" style="background:#c9784c;"></span><span class="lmap-info-name">🍺 The Pub — games, gambling &amp; glory</span></div>
        </div>
        <div class="lmap-sidebar-footer">
          ${!here
            ? (() => {
                const sameContinent = _isInContinent(cid);
                const cost = sameContinent ? 20 : cont.travelCost;
                const time = sameContinent ? 60 : cont.travelTime;
                return `<button class="lmap-travel-btn" id="lmap-capital-travel">TRAVEL HERE — ${cost}🪙 · ${_ft(time)}</button>`;
              })()
            : `<div class="lmap-here-text">✓ YOU ARE HERE</div>`}
        </div>
      </div>
    </div>`;

  _setupBC(c);
  _initZoomPan(document.getElementById("lmap-img-side"), document.getElementById("lmap-zoom-wrap"));
  c.querySelector("#lmap-capital-travel")?.addEventListener("click",()=>{
    const sameContinent = _isInContinent(cid);
    const cost = sameContinent ? 20 : cont.travelCost;
    const time = sameContinent ? 60 : cont.travelTime;
    window.openTravelModal?.(cont.capital||cont.name,cont.label.split("·")[0].trim(),cost,time);
  });

  const _capImg    = document.getElementById("lmap-loc-img");
  const _capWrap   = document.getElementById("lmap-zoom-wrap");

  function _placeCapitalPins() {
    _capWrap.querySelectorAll(".lmap-capital-pins").forEach(el=>el.remove());
    const pinsEl = document.createElement("div");
    pinsEl.className = "lmap-capital-pins";
    pinsEl.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:10;overflow:visible;";
    _capWrap.appendChild(pinsEl);

    // Player dot
    if(here && cont.capitalPlayerPin) {
      const dot = document.createElement("div");
      dot.className = "lmap-player-dot";
      dot.style.cssText = `position:absolute;left:${cont.capitalPlayerPin.x}%;top:${cont.capitalPlayerPin.y}%;transform:translate(-50%,-50%);`;
      pinsEl.appendChild(dot);
    }

    // Pub pin
    if(cont.pubPin) {
      // Determine state
      const pubData     = window.PUB_LOCATIONS
        ? Object.values(window.PUB_LOCATIONS).find(p => p.location.toLowerCase() === cont.capitalId?.toLowerCase()) || null
        : null;
      const travelId    = pubData?.travelId  || `The Pub — ${cont.capital||cont.name}`;
      const pubContinent= pubData?.continent || cont.label.split("·")[0].trim();
      const atPub       = pubData
        ? (window._charData?.kingdom||window._charData?.location||"").toLowerCase().includes(pubData.label.toLowerCase())
        : false;
      const atCapital   = here; // here = _isAtCapital(cid)

      // Dot style
      const pubDot = atPub
        ? "background:#4fc870;box-shadow:0 0 0 4px rgba(79,200,112,0.3),0 0 16px rgba(79,200,112,0.8);animation:lmap-pulse-player 1.8s infinite"
        : atCapital
          ? "background:#c9784c;box-shadow:0 0 0 3px rgba(201,120,76,0.3),0 0 10px rgba(201,120,76,0.5)"
          : "background:#5a3a20;box-shadow:0 0 0 2px rgba(90,58,32,0.3),0 0 6px rgba(90,58,32,0.3);opacity:0.5";

      const tooltipBody = atPub
        ? `<div class="lmap-wpin-tt-here">✓ You are inside the pub</div>
           <button class="lmap-wpin-travel-btn" data-action="enter-pub" style="background:rgba(79,200,112,0.15);border-color:rgba(79,200,112,0.5);color:#4fc870;margin-top:6px;">🍺 ENTER PUB →</button>`
        : atCapital
          ? `<div style="font-size:10px;color:#aaa;margin-bottom:6px;">10 🪙 · 1 min to travel inside</div>
             <button class="lmap-wpin-travel-btn" data-action="travel-pub" data-dest="${travelId}" data-continent="${pubContinent}" style="background:rgba(201,120,76,0.15);border-color:rgba(201,120,76,0.5);color:#c9784c;">TRAVEL — 10🪙 · 1m</button>`
          : `<div style="font-size:10px;color:#777;margin-top:4px;">Travel to ${cont.capital||cont.name} first.</div>`;

      const pubEl = document.createElement("div");
      pubEl.className = "lmap-loc-pin";
      pubEl.style.cssText = `position:absolute;left:${cont.pubPin.x}%;top:${cont.pubPin.y}%;transform:translate(-50%,-50%);pointer-events:all;overflow:visible;`;
      pubEl.innerHTML =
        `<div class="lmap-loc-pin-dot" style="${pubDot};width:12px;height:12px;border-radius:50%;cursor:pointer;"></div>` +
        `<div class="lmap-loc-pin-label" style="color:${atPub?'#4fc870':'#c9784c'};pointer-events:none;">🍺 Pub</div>` +
        `<div class="lmap-wpin-tooltip">` +
          `<div class="lmap-wpin-tt-name">🍺 The Pub</div>` +
          tooltipBody +
        `</div>`;

      pubEl.querySelector(".lmap-loc-pin-dot").addEventListener("click", e=>{ e.stopPropagation(); _openTT(pubEl, e); });
      pubEl.querySelector('[data-action="enter-pub"]')?.addEventListener("click", e=>{ e.stopPropagation(); _closeTT(); window._openPubPanel?.(); });
      pubEl.querySelector('[data-action="travel-pub"]')?.addEventListener("click", e=>{
        e.stopPropagation(); _closeTT();
        const d = e.currentTarget.dataset;
        window.openTravelModal?.(d.dest, d.continent, 10, 60);
      });
      pinsEl.appendChild(pubEl);
    }
  }

  _capImg.complete ? _placeCapitalPins() : _capImg.addEventListener("load", _placeCapitalPins);
}

function renderSettlement(sid, cid) {
  const cont=CONTINENTS[cid];
  const loc=cont?.settlements.find(s=>s.id===sid);
  if(!loc||!cont) return;
  _mapLayer=sid;
  const c=_c(); if(!c) return;
  const here=_isAtLocation(sid);

  c.innerHTML=`
    <div class="lmap-location-wrap">
      <div class="lmap-img-side" id="lmap-img-side">
        <div style="position:relative;width:100%;height:100%;overflow:visible;" id="lmap-zoom-wrap">
          <img src="${MAP_IMAGES[loc.image]||MAP_IMAGES[cont.image]}" class="lmap-location-img" draggable="false"/><div class="lmap-img-overlay"></div>
          ${here?`<div class="lmap-here-badge">✓ You are here</div>`:""}
          ${_bcBar(loc.label)}
        </div>
      </div>
      <div class="lmap-sidebar">
        <div class="lmap-sidebar-header">
          <div class="lmap-sidebar-region">${cont.label}</div>
          <div class="lmap-sidebar-name">${loc.label}</div>
          <span class="lmap-tag" style="${_tagStyle("safe")}">SAFE ZONE · Settlement</span>
          <div class="lmap-sidebar-desc">${loc.desc}</div>
        </div>
        <div class="lmap-sidebar-lists">
          <div class="lmap-section-title">IN THIS LOCATION</div>
          <div class="lmap-info-item"><span class="lmap-info-dot" style="background:#5dbe85;"></span><span class="lmap-info-name">💬 RP Chat (location chat available here)</span></div>
          <div class="lmap-info-item"><span class="lmap-info-dot" style="background:#5b9fe0;"></span><span class="lmap-info-name">🧑 NPCs present — speak to build bonds</span></div>
        </div>
        <div class="lmap-sidebar-footer">
          ${!here?`<button class="lmap-travel-btn" id="lmap-sett-travel">TRAVEL HERE — ${loc.travelCost}🪙 · ${_ft(loc.travelTime)}</button>`:`<div class="lmap-here-text">✓ YOU ARE HERE</div>`}
        </div>
      </div>
    </div>`;

  _setupBC(c);
  _initZoomPan(document.getElementById("lmap-img-side"), document.getElementById("lmap-zoom-wrap"));
  c.querySelector("#lmap-sett-travel")?.addEventListener("click",()=>window.openTravelModal?.(loc.label,cont.label.split("·")[0].trim(),loc.travelCost,loc.travelTime));

  // Player pin
  if(here) {
    const imgEl=c.querySelector(".lmap-location-img");
    imgEl.addEventListener("load",()=>{
      const pinsEl=document.createElement("div");
      pinsEl.style.cssText="position:absolute;inset:0;pointer-events:none;z-index:10;";
      document.getElementById("lmap-zoom-wrap").appendChild(pinsEl);
      const dot=document.createElement("div");
      dot.className="lmap-player-dot"; dot.style.cssText=`position:absolute;left:${loc.px}%;top:${loc.py}%;transform:translate(-50%,-50%);`;
      pinsEl.appendChild(dot);
    });
  }
}

// ── Resolve destination name to continent + layer ──
function _resolveDestination(destName) {
  if (!destName) return null;
  const d = destName.toLowerCase();

  // Pub locations — resolve to their parent capital so the capital map re-renders
  if (window.PUB_LOCATIONS) {
    for (const p of Object.values(window.PUB_LOCATIONS)) {
      if (d.includes(p.label.toLowerCase())) {
        for (const [cid, cont] of Object.entries(CONTINENTS)) {
          if (cont.capitalId && p.location.toLowerCase().includes(cont.capitalId.toLowerCase())) {
            return { type:"capital", cid };
          }
        }
      }
    }
  }

  // Vorthak sub-region zones
  for (const sr of CONTINENTS.vorthak.subRegions) {
    for (const z of sr.zones) {
      if (d === z.id || d === z.label.toLowerCase() || d.includes(z.id)) {
        return { type:"vorthak_zone", srId: sr.id };
      }
    }
  }

  for (const [cid, cont] of Object.entries(CONTINENTS)) {
    // Capital
    if (cont.capitalId && (d.includes(cont.capitalId) || d === cont.capital?.toLowerCase())) return { type:"continent", cid };
    // Settlements
    for (const s of cont.settlements) {
      if (d === s.id || d === s.label.toLowerCase() || d.includes(s.id)) return { type:"settlement", cid, sid:s.id };
    }
    // Explore zones
    for (const e of cont.explore) {
      if (d === e.id || d === e.label.toLowerCase() || d.includes(e.id)) return { type:"wildlands", cid, zoneId:e.id };
    }
    // Continent name itself
    if (d.includes(cid) || d.includes(cont.name.toLowerCase())) return { type:"continent", cid };
  }
  return null;
}

// ── Public ──
export function initLayeredMap() {
  const loc = window._charData?.kingdom || window._charData?.location || "";
  const dest = _resolveDestination(loc);
  if (dest) {
    _mapBreadcrumbs = [{id:"world", label:"World Map"}];
    if (dest.type === "settlement") { _mapBreadcrumbs.push({id:dest.cid, label:CONTINENTS[dest.cid].name}); renderSettlement(dest.sid, dest.cid); }
    else if (dest.type === "wildlands") { _mapBreadcrumbs.push({id:dest.cid, label:CONTINENTS[dest.cid].name}); renderWildlands(dest.cid); }
    else if (dest.type === "capital") { _mapBreadcrumbs.push({id:dest.cid, label:CONTINENTS[dest.cid].name}); renderCapital(dest.cid); }
    else if (dest.type === "vorthak_zone") {
      _mapBreadcrumbs.push({id:"vorthak", label:"Vorthak"});
      renderVorthakSubRegion(dest.srId);
    }
    else renderContinent(dest.cid);
  } else {
    renderWorldMap();
  }
}

// Called automatically when travel completes
window._onTravelArrival = function(destName) {
  const dest = _resolveDestination(destName);
  if (!dest) { window._refreshMapPin?.(); return; }
  _mapBreadcrumbs = [{id:"world", label:"World Map"}];
  if (dest.type === "settlement") { _mapBreadcrumbs.push({id:dest.cid, label:CONTINENTS[dest.cid].name}); renderSettlement(dest.sid, dest.cid); }
  else if (dest.type === "wildlands") { _mapBreadcrumbs.push({id:dest.cid, label:CONTINENTS[dest.cid].name}); renderWildlands(dest.cid); }
  else if (dest.type === "capital") { _mapBreadcrumbs.push({id:dest.cid, label:CONTINENTS[dest.cid].name}); renderCapital(dest.cid); }
  else if (dest.type === "vorthak_zone") {
    _mapBreadcrumbs.push({id:"vorthak", label:"Vorthak"});
    renderVorthakSubRegion(dest.srId);
  }
  else renderContinent(dest.cid);
};

window._initLayeredMap  = initLayeredMap;
window._renderWorldMap  = renderWorldMap;
window._renderContinent = renderContinent;
window._renderCapital   = renderCapital;
window._renderWildlands = renderWildlands;
window._renderSettlement= renderSettlement;
window._renderVorthakOverview   = renderVorthakOverview;
window._renderVorthakSubRegion  = renderVorthakSubRegion;
window._refreshMapPin   = function() {
  if(_mapLayer==="world") renderWorldMap();
  else if(_mapLayer==="vorthak") renderVorthakOverview();
  else if(_mapLayer.startsWith("vorthak_sr_")) renderVorthakSubRegion(_mapLayer.replace("vorthak_sr_",""));
  else if(CONTINENTS[_mapLayer]) renderContinent(_mapLayer);
  else if(_mapLayer.startsWith("capital_")) renderCapital(_mapLayer.replace("capital_",""));
  else if(_mapLayer.startsWith("wildlands_")) renderWildlands(_mapLayer.replace("wildlands_",""));
  else renderWorldMap();
};