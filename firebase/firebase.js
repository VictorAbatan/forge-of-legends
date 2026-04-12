// FORGE OF LEGENDS — Firebase Init
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage }    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCUmdWY9OfzQgOPv-4KgOlBfO76c0toxYQ",
  authDomain:        "inkcraftrp.firebaseapp.com",
  projectId:         "inkcraftrp",
  storageBucket:     "inkcraftrp.firebasestorage.app",
  messagingSenderId: "125564034696",
  appId:             "1:125564034696:web:0b09ed319024309ad2493d"
};

const app     = initializeApp(firebaseConfig);
const auth    = getAuth(app);
const db      = getFirestore(app);
const storage = getStorage(app);

export { app, auth, db, storage };