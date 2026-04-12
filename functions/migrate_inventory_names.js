// Firestore migration script: Standardize inventory item names to canonical names
// Usage: node migrate_inventory_names.js

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // Download from Firebase Console

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Map of old names to canonical names (add all mappings as needed)
const NAME_MAP = {
  'Blueberries': 'Blueberry',
  'Apples': 'Apple',
  'Golden Pears': 'Golden Pear',
  'Moon Grapes': 'Moon Grape',
  'Frost Apples': 'Frost Apple',
  'Shadowfish': 'Shadow Fish',
  'Flamefish': 'Flame Fish',
  'Spirit Herb': 'Spirit-Herb',
  'Jade Vine': 'Jade-Vine',
  'Spirit Venison': 'Spirit-Venison',
  'Shadow Hide': 'Shadow-Hide',
  'Celestial Whale': 'Celestial-Whale',
  'Black Unagi': 'Black-Unagi',
  'Phoenix Bloom': 'Phoenix-Bloom',
  'Middlemist': 'Middlemist-Red',
  'Cyclops Eye': 'Cyclops-Eye',
  'Dragon Scales': 'Dragon-Scales',
  'Eden’s Tear': "Eden's Tear",
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