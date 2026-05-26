// ═══════════════════════════════════════════════════════
//  ONE-TIME REPAIR: fix-enchant-mismatch.js
//  Run with: node functions/fix-enchant-mismatch.js
//
//  Fixes items where enchantLevel is set but the name has
//  no +N suffix (or name has +N but enchantLevel is missing).
//  Trusts the NAME as the source of truth.
// ═══════════════════════════════════════════════════════

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore }        = require("firebase-admin/firestore");
const serviceAccount          = require("./serviceAccountKey.json");

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function fixMismatch() {
  const snap = await db.collection("characters").get();
  let totalFixed = 0;

  for (const doc of snap.docs) {
    const inv = doc.data().inventory || [];
    let dirty = false;

    const newInv = inv.map(item => {
      const nameMatch = item.name.match(/\s*\+(\d+)$/);
      const nameLevel = nameMatch ? parseInt(nameMatch[1]) : 0;
      const storedLevel = item.enchantLevel || 0;

      if (nameLevel !== storedLevel) {
        dirty = true;
        const fixed = { ...item, enchantLevel: nameLevel };
        if (nameLevel === 0) {
          delete fixed.enchantLevel;
          delete fixed.bonusEffect;
        }
        console.log(`  [${doc.id}] "${item.name}" enchantLevel:${storedLevel} → ${nameLevel}`);
        return fixed;
      }
      return item;
    });

    if (dirty) {
      await db.collection("characters").doc(doc.id).update({ inventory: newInv });
      totalFixed++;
      console.log(`  ✅ Fixed ${doc.data().name || doc.id}`);
    }
  }

  console.log(`\nDone. Fixed ${totalFixed} character(s).`);
}

fixMismatch().catch(console.error);