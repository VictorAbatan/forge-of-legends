// ═══════════════════════════════════════
//  INKCRAFT RP — Auth Helpers
//  js/auth.js
// ═══════════════════════════════════════

import { auth, db } from "../firebase/firebase.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Redirect if already logged in ──────────────────────────────────────────
export function redirectIfLoggedIn() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    const snap = await getDoc(doc(db, "characters", user.uid));
    window.location.href = snap.exists() ? "dashboard.html" : "create-character.html";
  });
}

// ── Require auth (redirect to login if not logged in) ───────────────────────
export function requireAuth(onUser) {
  onAuthStateChanged(auth, (user) => {
    if (!user) { window.location.href = "../html/login.html"; return; }
    if (onUser) onUser(user);
  });
}

// ── Login ───────────────────────────────────────────────────────────────────
export async function loginUser(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

// ── Register ────────────────────────────────────────────────────────────────
export async function registerUser(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

// ── Save user role to Firestore ──────────────────────────────────────────────
export async function saveUserRole(uid, email, role) {
  await setDoc(doc(db, "users", uid), {
    uid, email, role, createdAt: serverTimestamp()
  });
}

// ── Logout ───────────────────────────────────────────────────────────────────
export async function logoutUser() {
  await signOut(auth);
  window.location.href = "../html/login.html";
}

// ── Friendly Firebase errors ─────────────────────────────────────────────────
export function friendlyError(code) {
  const map = {
    "auth/email-already-in-use":   "That email is already registered.",
    "auth/invalid-email":          "Please enter a valid email address.",
    "auth/weak-password":          "Password must be at least 6 characters.",
    "auth/user-not-found":         "No account found with that email.",
    "auth/wrong-password":         "Incorrect password. Try again.",
    "auth/invalid-credential":     "Invalid email or password.",
    "auth/too-many-requests":      "Too many attempts. Please wait and try again.",
    "auth/network-request-failed": "Network error. Check your connection.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

// ── Toast helper ─────────────────────────────────────────────────────────────
let _toastTimer;
export function showToast(msg, type = "") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "toast show " + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ── Hide loading overlay ──────────────────────────────────────────────────────
export function hideLoading() {
  const el = document.getElementById("loading");
  if (!el) return;
  el.classList.add("hidden");
  setTimeout(() => el.remove(), 400);
}
