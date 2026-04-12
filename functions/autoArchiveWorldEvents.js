const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { getFirestore } = require("firebase-admin/firestore");

const db = getFirestore();

exports.autoArchiveWorldEvents = onDocumentCreated(
  {
    document: "worldEvents/{eventId}",
    region: "europe-west1"
  },
  async (event) => {
    // Query for all active world events, ordered by createdAt descending
    const activeEventsSnap = await db.collection("worldEvents")
      .where("status", "==", "active")
      .orderBy("createdAt", "desc")
      .get();

    // If more than 5, archive the oldest
    if (activeEventsSnap.size > 5) {
      const docsToArchive = activeEventsSnap.docs.slice(5);
      const batch = db.batch();
      docsToArchive.forEach(docSnap => {
        batch.update(docSnap.ref, { status: "archived" });
      });
      await batch.commit();
    }
    return;
  }
);
