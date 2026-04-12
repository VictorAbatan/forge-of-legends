// Firestore migration script: Canonicalize all item/material names in character inventories
// Usage: node migrate_canonical_items.js

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Map of old names to canonical names (expand as needed)
const NAME_MAP = {
  'Bone': 'Bone Fragments',
  'Apples': 'Apple',
  'Blueberries': 'Blueberry',
  'Melons': 'Melon',
  'Wild Berries': 'Wild Berry',
  'Moon Grapes': 'Moon Grape',
  'Golden Pears': 'Golden Pear',
  'Celestial Whale': 'Celestial-Whale',
  'Black Unagi': 'Black-Unagi',
  'Phoenix Bloom': 'Phoenix-Bloom',
  'Middlemist': 'Middlemist-Red',
  'Cyclops Eye': 'Cyclops-Eye',
  'Dragonfruit': 'Dragon Fruit',
  // Add more mappings as needed
};

async function migrate() {
  const chars = await db.collection('characters').get();
  let updated = 0;
  for (const doc of chars.docs) {
    const data = doc.data();
    let changed = false;
    if (Array.isArray(data.inventory)) {
      const newInv = data.inventory.map(item => {
        if (NAME_MAP[item.name]) {
          changed = true;
          return { ...item, name: NAME_MAP[item.name] };
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