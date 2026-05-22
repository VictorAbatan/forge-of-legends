// ═══════════════════════════════════════════════════════
//  ONE-TIME REPAIR: fix-enchant-stacks.js
//  Run with: node fix-enchant-stacks.js
//  Fixes inventory stacks that had enchantLevel written onto
//  a bulk qty>1 entry by the old enchantItem Cloud Function bug.
// ═══════════════════════════════════════════════════════

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore }        = require("firebase-admin/firestore");

// ── Put your service account key path here ──
const serviceAccount = require("./serviceAccountKey.json");

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function repairEnchantStacks() {
  const snap = await db.collection("characters").get();
  let totalFixed = 0;

  for (const doc of snap.docs) {
    const char = doc.data();
    const inv  = char.inventory || [];
    let dirty  = false;

    const repairedInv = inv.map(item => {
      const qty          = item.qty ?? 1;
      const enchantLevel = item.enchantLevel || 0;
      const hasStaleTag  = enchantLevel > 0 && qty > 1;

      if (hasStaleTag) {
        // Strip the enchant data and clean the name back to base
        dirty = true;
        const cleanName = item.name.replace(/\s*\+\d+$/, "");
        console.log(`  [${doc.id}] ${item.name} (qty:${qty}) → stripped to "${cleanName}"`);
        const { enchantLevel: _drop, bonusEffect: _drop2, ...rest } = item;
        return { ...rest, name: cleanName };
      }
      return item;
    });

    if (dirty) {
      await db.collection("characters").doc(doc.id).update({ inventory: repairedInv });
      totalFixed++;
      console.log(`  ✅ Fixed character ${char.name || doc.id}`);
    }
  }

  console.log(`\nDone. Repaired ${totalFixed} character(s).`);
}

repairEnchantStacks().catch(console.error);