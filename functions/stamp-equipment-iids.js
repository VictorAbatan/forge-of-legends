// ═══════════════════════════════════════════════════════
//  ONE-TIME MIGRATION: stamp-equipment-iids.js  (FIXED)
//  Run with: node functions/stamp-equipment-iids.js
//
//  FIX: The old version checked item.type === "weapon"/"armor"
//  but inventory items don't have a type field — equipment is
//  identified by name keywords, matching the dashboard's
//  getItemType() logic. This version does the same thing.
//
//  Safe to run multiple times — skips items that already have iid.
// ═══════════════════════════════════════════════════════

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore }        = require("firebase-admin/firestore");
const serviceAccount          = require("./serviceAccountKey.json");

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function makeIid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Mirrors the ITEM_TYPES.equipment keyword list in dashboard.js exactly
const EQUIPMENT_KEYWORDS = [
  "Sword","Dagger","Bow","Vest","Plate","Armor","Shield","Staff","Robe",
  "Axe","Spear","Blade","Wand","Mace","Knife","Rod","Cloak","Cuirass",
  "Chainmail","Fortress","Mantle","Shroud","Tunic","Greatsword","Cleaver",
  "Warplate","Warbreaker","Longbow","Spellknife","Spellhammer",
];

function isEquipment(item) {
  // Match by name keywords (same as dashboard getItemType)
  if (EQUIPMENT_KEYWORDS.some(k => item.name && item.name.includes(k))) return true;
  // Also accept explicit type fields in case some items do have them
  if (item.type === "weapon" || item.type === "armor" || item.type === "equipment") return true;
  return false;
}

async function stampIids() {
  const snap = await db.collection("characters").get();
  let totalChars = 0, totalStamped = 0, totalSplit = 0;

  for (const docSnap of snap.docs) {
    const charName = docSnap.data().name || docSnap.id;
    const inv = docSnap.data().inventory || [];
    let dirty = false;

    const newInv = [];
    for (const item of inv) {
      if (isEquipment(item)) {
        if (item.qty && item.qty > 1) {
          // Stacked equipment — split into individual entries each with a unique iid
          for (let i = 0; i < item.qty; i++) {
            newInv.push({ ...item, qty: 1, iid: makeIid() });
          }
          console.log(`  [${charName}] Split "${item.name}" qty:${item.qty} → ${item.qty} individual entries`);
          totalSplit  += item.qty;
          totalStamped += item.qty;
          dirty = true;
        } else if (!item.iid) {
          // Single equipment with no iid — stamp one
          newInv.push({ ...item, qty: 1, iid: makeIid() });
          console.log(`  [${charName}] Stamped iid on "${item.name}"`);
          totalStamped++;
          dirty = true;
        } else {
          // Already has iid — leave untouched
          newInv.push(item);
        }
      } else {
        newInv.push(item);
      }
    }

    if (dirty) {
      await db.collection("characters").doc(docSnap.id).update({ inventory: newInv });
      totalChars++;
      console.log(`  ✅ Updated ${charName}`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Characters updated : ${totalChars}`);
  console.log(`  Items stamped/split: ${totalStamped} (${totalSplit} were stack-splits)`);
}

stampIids().catch(console.error);