// Firestore migration script: Replace all 'Iron Ore' with 'Iron' in character inventories
// Usage: node migrate_iron.js

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrate() {
  const chars = await db.collection('characters').get();
  let updated = 0;
  for (const doc of chars.docs) {
    const data = doc.data();
    let changed = false;
    if (Array.isArray(data.inventory)) {
      const newInv = data.inventory.map(item => {
        if (item.name === 'Iron Ore') {
          changed = true;
          return { ...item, name: 'Iron' };
        }
        return item;
      });
      if (changed) {
        await doc.ref.update({ inventory: newInv });
        updated++;
        console.log(`Updated inventory for character: ${doc.id}`);
      }
    }
  }
  console.log(`Migration complete. Updated ${updated} accounts.`);
}

migrate().catch(console.error);