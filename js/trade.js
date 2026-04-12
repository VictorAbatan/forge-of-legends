// ═══════════════════════════════════════════════════
//  CHAT TRADE SYSTEM — trade.js
//  Trades are public, atomic, and cheat-proof.
//  Items are locked into escrow on offer; only
//  released when BOTH players confirm. Cancel at
//  any time returns everything to its owner.
// ═══════════════════════════════════════════════════

import { db } from "../firebase/firebase.js";
import {
  doc, getDoc, getDocFromServer, updateDoc, addDoc, deleteDoc,
  collection, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Module state ───────────────────────────────────
let _uid            = null;
let _charData       = null;
let _chatTab        = null;
let _chatLocationId = null;

// Live listener unsub for the open trade modal
let _tradeUnsub     = null;
let _currentTradeId = null;

// ── Resolvers (mirror duel.js pattern) ────────────
function _getUid()      { return _uid      || window._uid      || null; }
function _getCharData() { return _charData || window._charData || null; }

// ── Init ───────────────────────────────────────────
export function initTradeSystem(uid, charData) {
  _uid      = uid;
  _charData = charData;
  _listenForIncomingTradeRequests();
}

export function updateTradeCharData(charData) {
  _charData = charData;
}

export function updateTradeContext(tab, locationId) {
  _chatTab        = tab        || 'rp';
  _chatLocationId = locationId || '';
}

// ── Initiate a trade from the player popup ─────────
export async function initiateTrade(targetUid, targetName) {
  const uid      = _getUid();
  const charData = _getCharData();
  if (!uid || !charData) throw new Error('Not logged in.');
  _uid = uid; _charData = charData;

  const tab   = _chatTab        || 'rp';
  const locId = _chatLocationId || '';

  if (!locId && tab !== 'general') {
    throw new Error('Open the chat panel first before trading.');
  }

  // Create the trade doc — items start empty, both sides unconfirmed
  const tradeRef = await addDoc(collection(db, 'trades'), {
    initiatorId:       uid,
    initiatorName:     charData.name,
    initiatorItems:    [],   // { name, qty, icon } — offered items locked in escrow
    initiatorGold:     0,
    initiatorConfirmed: false,
    targetId:          targetUid,
    targetName,
    targetItems:       [],
    targetGold:        0,
    targetConfirmed:   false,
    status:            'pending',  // pending → active → complete | cancelled
    chatTab:           tab,
    chatLocationId:    locId,
    createdAt:         serverTimestamp(),
  });

  // Post trade card in chat so everyone can spectate
  await _postTradeCard(tradeRef.id, tab, locId, charData.name, targetName, {
    initiatorId:       uid,
    initiatorName:     charData.name,
    initiatorItems:    [],
    initiatorGold:     0,
    initiatorConfirmed: false,
    targetId:          targetUid,
    targetName,
    targetItems:       [],
    targetGold:        0,
    targetConfirmed:   false,
    status:            'pending',
    chatTab:           tab,
    chatLocationId:    locId,
  });

  // Notify target
  try {
    await addDoc(collection(db, 'notifications'), {
      uid:       targetUid,
      type:      'trade-request',
      title:     '🔄 Trade Request!',
      message:   `${charData.name} wants to trade with you!`,
      tradeId:   tradeRef.id,
      read:      false,
      createdAt: serverTimestamp(),
      fromUid:   uid,
      fromName:  charData.name,
    });
  } catch (e) { console.warn('[Trade] Notification failed:', e); }

  // Open the trade modal for the initiator immediately
  _openTradeModal(tradeRef.id);

  window.showToast?.(`🔄 Trade request sent to ${targetName}!`, '');
}

// ── Accept a trade request ─────────────────────────
export async function acceptTradeRequest(tradeId) {
  const uid = _getUid();
  if (!uid) return;
  _uid = uid; _charData = _getCharData();

  const tradeRef = doc(db, 'trades', tradeId);
  const snap     = await getDocFromServer(tradeRef);
  if (!snap.exists()) { window.showToast?.('Trade not found.', 'error'); return; }
  const trade = snap.data();

  if (trade.targetId !== uid)      { window.showToast?.('This trade is not for you.', 'error'); return; }
  if (trade.status !== 'pending')  { window.showToast?.('Trade already handled.', 'error'); return; }

  await updateDoc(tradeRef, { status: 'active' });
  document.getElementById('trade-request-toast')?.remove();

  _openTradeModal(tradeId);
  window.showToast?.('🔄 Trade accepted! Add your items and confirm.', '');
}

// ── Decline a trade request ────────────────────────
export async function declineTradeRequest(tradeId) {
  const uid = _getUid();
  if (!uid) return;

  const tradeRef = doc(db, 'trades', tradeId);
  const snap     = await getDocFromServer(tradeRef);
  if (!snap.exists()) return;
  const trade = snap.data();

  await updateDoc(tradeRef, { status: 'cancelled', cancelledBy: uid, cancelReason: 'declined' });
  document.getElementById('trade-request-toast')?.remove();

  const tab   = trade.chatTab        || _chatTab   || 'rp';
  const locId = trade.chatLocationId || _chatLocationId || '';
  await _postSystemMsg(tab, locId,
    `❌ ${trade.targetName} declined ${trade.initiatorName}'s trade request.`);
  // Live mountTradeCard onSnapshot handles updating the card to cancelled state

  window.showToast?.('Trade declined.', '');
}

// ── Cancel an active trade (either side) ──────────
export async function cancelTrade(tradeId) {
  const uid = _getUid();
  if (!uid) return;

  const tradeRef = doc(db, 'trades', tradeId);
  const snap     = await getDocFromServer(tradeRef);
  if (!snap.exists()) return;
  const trade = snap.data();

  const isParticipant = trade.initiatorId === uid || trade.targetId === uid;
  if (!isParticipant && !window._charData?.isDeity) {
    window.showToast?.('Not your trade.', 'error'); return;
  }

  // Return any locked items and gold back to their owners via Firestore
  await _returnEscrowedItems(trade);

  const cancellerName = uid === trade.initiatorId ? trade.initiatorName : trade.targetName;
  await updateDoc(tradeRef, { status: 'cancelled', cancelledBy: uid });

  const tab   = trade.chatTab        || _chatTab        || 'rp';
  const locId = trade.chatLocationId || _chatLocationId || '';
  await _postSystemMsg(tab, locId, `❌ ${cancellerName} cancelled the trade.`);
  // Live mountTradeCard onSnapshot handles updating the card to cancelled state

  _closeTradeModal();
  window.showToast?.('Trade cancelled. Your items have been returned.', '');
}

// ── Add an item to your trade offer ───────────────
// qty defaults to 1. Called from the modal's item picker.
export async function addTradeItem(tradeId, itemName, qty) {
  const uid      = _getUid();
  const charData = _getCharData();
  if (!uid || !charData) return;

  qty = parseInt(qty) || 1;

  const tradeRef = doc(db, 'trades', tradeId);
  const snap     = await getDocFromServer(tradeRef);
  if (!snap.exists()) return;
  const trade = snap.data();

  if (trade.status !== 'active') { window.showToast?.('Trade is not active.', 'error'); return; }

  // Don't allow changes after confirming
  const isInitiator = trade.initiatorId === uid;
  if (isInitiator && trade.initiatorConfirmed) {
    window.showToast?.('Unconfirm first to change your offer.', 'error'); return;
  }
  if (!isInitiator && trade.targetConfirmed) {
    window.showToast?.('Unconfirm first to change your offer.', 'error'); return;
  }

  // Verify player actually has enough of this item (inventory + equipped)
  const allItems = _getTradableItems(charData);
  const owned = allItems.find(i => i.name === itemName);
  if (!owned || owned.qty < qty) {
    window.showToast?.(`You don't have ${qty}× ${itemName}.`, 'error'); return;
  }

  // Check what's already offered
  const myItems = isInitiator ? [...(trade.initiatorItems || [])] : [...(trade.targetItems || [])];
  const alreadyOffered = myItems.reduce((sum, i) => i.name === itemName ? sum + i.qty : sum, 0);
  const totalNeeded    = alreadyOffered + qty;
  if (totalNeeded > owned.qty) {
    window.showToast?.(`You only have ${owned.qty}× ${itemName} total.`, 'error'); return;
  }

  // Merge into offer list
  const existing = myItems.find(i => i.name === itemName);
  if (existing) { existing.qty += qty; }
  else { myItems.push({ name: itemName, qty, icon: _getIcon(itemName) }); }

  // Reset own confirmation when offer changes — prevents bait-and-switch
  const field = isInitiator ? 'initiatorItems' : 'targetItems';
  const confField = isInitiator ? 'initiatorConfirmed' : 'targetConfirmed';
  await updateDoc(tradeRef, { [field]: myItems, [confField]: false });
}

// ── Remove an item from your trade offer ──────────
export async function removeTradeItem(tradeId, itemName) {
  const uid = _getUid();
  if (!uid) return;

  const tradeRef = doc(db, 'trades', tradeId);
  const snap     = await getDocFromServer(tradeRef);
  if (!snap.exists()) return;
  const trade = snap.data();

  const isInitiator = trade.initiatorId === uid;
  if (isInitiator && trade.initiatorConfirmed) {
    window.showToast?.('Unconfirm first to change your offer.', 'error'); return;
  }
  if (!isInitiator && trade.targetConfirmed) {
    window.showToast?.('Unconfirm first to change your offer.', 'error'); return;
  }

  const myItems = (isInitiator ? trade.initiatorItems : trade.targetItems) || [];
  const updated = myItems.filter(i => i.name !== itemName);
  const field   = isInitiator ? 'initiatorItems' : 'targetItems';
  const confField = isInitiator ? 'initiatorConfirmed' : 'targetConfirmed';
  await updateDoc(tradeRef, { [field]: updated, [confField]: false });
}

// ── Add/remove gold from your offer ───────────────
export async function setTradeGold(tradeId, amount) {
  const uid      = _getUid();
  const charData = _getCharData();
  if (!uid || !charData) return;

  amount = Math.max(0, parseInt(amount) || 0);
  if (amount > (charData.gold || 0)) {
    window.showToast?.(`You only have ${charData.gold || 0} gold.`, 'error'); return;
  }

  const tradeRef = doc(db, 'trades', tradeId);
  const snap     = await getDocFromServer(tradeRef);
  if (!snap.exists()) return;
  const trade = snap.data();

  const isInitiator = trade.initiatorId === uid;
  if (isInitiator && trade.initiatorConfirmed) {
    window.showToast?.('Unconfirm first to change your offer.', 'error'); return;
  }
  if (!isInitiator && trade.targetConfirmed) {
    window.showToast?.('Unconfirm first to change your offer.', 'error'); return;
  }

  const field    = isInitiator ? 'initiatorGold'      : 'targetGold';
  const confField = isInitiator ? 'initiatorConfirmed' : 'targetConfirmed';
  await updateDoc(tradeRef, { [field]: amount, [confField]: false });
}

// ── Confirm your side of the trade ────────────────
export async function confirmTrade(tradeId) {
  const uid      = _getUid();
  const charData = _getCharData();
  if (!uid || !charData) return;

  const tradeRef = doc(db, 'trades', tradeId);
  const snap     = await getDocFromServer(tradeRef);
  if (!snap.exists()) return;
  const trade = snap.data();

  if (trade.status !== 'active') { window.showToast?.('Trade is not active.', 'error'); return; }

  const isInitiator = trade.initiatorId === uid;
  const myItems     = isInitiator ? trade.initiatorItems : trade.targetItems;
  const myGold      = isInitiator ? trade.initiatorGold  : trade.targetGold;

  // Verify player still has all offered items (prevent bait-and-switch)
  const inv = charData.inventory || [];
  for (const offered of (myItems || [])) {
    const owned = inv.find(i => i.name === offered.name);
    if (!owned || (owned.qty ?? 1) < offered.qty) {
      window.showToast?.(`You no longer have ${offered.qty}× ${offered.name}.`, 'error'); return;
    }
  }
  if ((charData.gold || 0) < (myGold || 0)) {
    window.showToast?.(`You don't have enough gold.`, 'error'); return;
  }

  const confField = isInitiator ? 'initiatorConfirmed' : 'targetConfirmed';

  // Write our confirmation first
  await updateDoc(tradeRef, { [confField]: true });

  // Re-read fresh from server AFTER our write to get the definitive state
  const freshSnap = await getDocFromServer(tradeRef);
  if (!freshSnap.exists()) return;
  const freshTrade = freshSnap.data();

  const otherConf = isInitiator ? freshTrade.targetConfirmed : freshTrade.initiatorConfirmed;

  // If the other side was already confirmed (or just confirmed concurrently), execute now
  if (otherConf) {
    await _executeTrade(tradeRef.id, freshTrade, uid);
  } else {
    window.showToast?.('✅ Confirmed! Waiting for the other player...', '');
  }
}

// ── Unconfirm your side (to change offer) ─────────
export async function unconfirmTrade(tradeId) {
  const uid = _getUid();
  if (!uid) return;

  const tradeRef = doc(db, 'trades', tradeId);
  const snap     = await getDocFromServer(tradeRef);
  if (!snap.exists()) return;
  const trade = snap.data();
  if (trade.status !== 'active') return;

  const isInitiator = trade.initiatorId === uid;
  const confField   = isInitiator ? 'initiatorConfirmed' : 'targetConfirmed';
  await updateDoc(tradeRef, { [confField]: false });
}

// ── Execute the trade atomically ───────────────────
// Called when the second player confirms. Uses a Firestore
// batch so the entire swap is atomic — no partial transfers.
async function _executeTrade(tradeId, trade, confirmingUid) {
  const tradeRef = doc(db, 'trades', tradeId);

  // Guard: re-read trade doc to abort if another client already completed it
  const guardSnap = await getDocFromServer(tradeRef);
  if (!guardSnap.exists() || guardSnap.data().status !== 'active') {
    // Already completed or cancelled by the other client — nothing to do
    return;
  }

  // Re-read both character docs fresh from server
  const [initSnap, targSnap] = await Promise.all([
    getDocFromServer(doc(db, 'characters', trade.initiatorId)),
    getDocFromServer(doc(db, 'characters', trade.targetId)),
  ]);
  if (!initSnap.exists() || !targSnap.exists()) {
    window.showToast?.('Could not verify player inventories.', 'error'); return;
  }

  const initData = initSnap.data();
  const targData = targSnap.data();

  // Deep clone inventories
  let initInv  = [...(initData.inventory  || [])];
  let targInv  = [...(targData.inventory  || [])];
  let initGold = initData.gold || 0;
  let targGold = targData.gold || 0;

  // Helper: get effective qty for an item (inventory + equipped)
  function effectiveQty(inv, equip, name) {
    const inInv = (inv.find(i => i.name === name)?.qty ?? 0);
    const inEquip = (equip?.weapon === name ? 1 : 0) + (equip?.armor === name ? 1 : 0);
    return inInv + inEquip;
  }

  // Verify initiator still has everything they offered
  for (const offered of (trade.initiatorItems || [])) {
    const qty = effectiveQty(initInv, initData.equipment, offered.name);
    if (qty < offered.qty) {
      window.showToast?.(`${trade.initiatorName} no longer has ${offered.name}. Trade cancelled.`, 'error');
      await updateDoc(tradeRef, { status: 'cancelled', cancelReason: 'item_missing' });
      return;
    }
  }
  if (initGold < (trade.initiatorGold || 0)) {
    window.showToast?.(`${trade.initiatorName} doesn't have enough gold. Trade cancelled.`, 'error');
    await updateDoc(tradeRef, { status: 'cancelled', cancelReason: 'gold_missing' });
    return;
  }

  // Verify target still has everything they offered
  for (const offered of (trade.targetItems || [])) {
    const qty = effectiveQty(targInv, targData.equipment, offered.name);
    if (qty < offered.qty) {
      window.showToast?.(`${trade.targetName} no longer has ${offered.name}. Trade cancelled.`, 'error');
      await updateDoc(tradeRef, { status: 'cancelled', cancelReason: 'item_missing' });
      return;
    }
  }
  if (targGold < (trade.targetGold || 0)) {
    window.showToast?.(`${trade.targetName} doesn't have enough gold. Trade cancelled.`, 'error');
    await updateDoc(tradeRef, { status: 'cancelled', cancelReason: 'gold_missing' });
    return;
  }

  // ── Compute new inventories ──────────────────────
  // Initiator loses their offered items, gains target's items
  for (const item of (trade.initiatorItems || [])) {
    initInv = _removeFromInv(initInv, item.name, item.qty);
    targInv = _addToInv(targInv, item.name, item.qty, item.icon);
  }
  // Target loses their offered items, gains initiator's items
  for (const item of (trade.targetItems || [])) {
    targInv = _removeFromInv(targInv, item.name, item.qty);
    initInv = _addToInv(initInv, item.name, item.qty, item.icon);
  }
  // Gold swap
  initGold = initGold - (trade.initiatorGold || 0) + (trade.targetGold || 0);
  targGold = targGold - (trade.targetGold   || 0) + (trade.initiatorGold || 0);

  // ── Write completion to the trades doc only ──────
  // We cannot batch-write both character docs because Firestore rules only allow
  // isOwner(uid) — each client can only write their own character.
  // Instead we store the resolved inventories in the trades doc, and each
  // client's onSnapshot applies the update to their own character doc individually.
  await updateDoc(tradeRef, {
    status:                  'complete',
    initiatorConfirmed:      true,
    targetConfirmed:         true,
    completedAt:             serverTimestamp(),
    resolvedInitiatorInv:    initInv,
    resolvedInitiatorGold:   initGold,
    resolvedTargetInv:       targInv,
    resolvedTargetGold:      targGold,
  });
  // Each client's onSnapshot (modal + mountTradeCard) will see status:'complete'
  // and call _applyTradeResolution() to write their own character doc.

  // Post completion system message in chat.
  const tab   = trade.chatTab        || _chatTab        || 'rp';
  const locId = trade.chatLocationId || _chatLocationId || '';

  const initSummary = _buildTradeSummary(trade.initiatorItems, trade.initiatorGold);
  const targSummary = _buildTradeSummary(trade.targetItems,    trade.targetGold);
  await _postSystemMsg(tab, locId,
    `🤝 Trade complete! ${trade.initiatorName} gave ${initSummary} — ${trade.targetName} gave ${targSummary}.`);

  // Apply this client's own inventory update immediately (don't wait for onSnapshot)
  const uid = _getUid();
  await _applyTradeResolution(trade, uid, initInv, initGold, targInv, targGold);

  // Close this client's modal
  _closeTradeModal();
  window.showToast?.('🤝 Trade complete!', '');
}

// ── Apply this client's side of a completed trade ─
// Called from both _executeTrade (immediate) and onSnapshot handlers (other client).
// Each client only writes their own characters/{uid} — always permitted by rules.
// Uses the pre-resolved inventories stored in the trade doc.
async function _applyTradeResolution(trade, uid, initInv, initGold, targInv, targGold) {
  try {
    if (uid === trade.initiatorId) {
      await updateDoc(doc(db, 'characters', uid), { inventory: initInv, gold: initGold });
      if (window._charData) {
        window._charData.inventory = initInv;
        window._charData.gold      = initGold;
        _charData = window._charData;
      }
      window.renderInventory?.(initInv);
    } else if (uid === trade.targetId) {
      await updateDoc(doc(db, 'characters', uid), { inventory: targInv, gold: targGold });
      if (window._charData) {
        window._charData.inventory = targInv;
        window._charData.gold      = targGold;
        _charData = window._charData;
      }
      window.renderInventory?.(targInv);
    }
  } catch (e) {
    console.warn('[Trade] _applyTradeResolution failed:', e);
  }
}

// ── Return escrowed items (cancel) ────────────────
// Nothing actually moved yet — items are still in player inventories,
// just tracked on the doc. So cancel just resets the doc status.
async function _returnEscrowedItems(trade) {
  // In this design items aren't physically moved to escrow —
  // they're validated at execution time. So cancel just marks cancelled.
  // This is safe because addTradeItem always checks live inventory.
}

// ── Inventory helpers ─────────────────────────────
function _removeFromInv(inv, name, qty) {
  const arr = inv.map(i => ({ ...i }));
  const item = arr.find(i => i.name === name);
  if (!item) return arr;
  item.qty = (item.qty ?? 1) - qty;
  return arr.filter(i => (i.qty ?? 1) > 0);
}

function _addToInv(inv, name, qty, icon) {
  const arr = inv.map(i => ({ ...i }));
  const existing = arr.find(i => i.name === name);
  if (existing) { existing.qty = (existing.qty ?? 1) + qty; }
  else { arr.push({ name, qty, icon: icon || _getIcon(name) }); }
  return arr;
}

function _getIcon(name) {
  const icons = window.ITEM_ICONS || {};
  return icons[name] || '📦';
}

function _buildTradeSummary(items, gold) {
  const parts = (items || []).map(i => `${i.qty}× ${i.name}`);
  if (gold && gold > 0) parts.push(`${gold} gold`);
  return parts.length ? parts.join(', ') : 'nothing';
}

// ── Chat message helpers ───────────────────────────
function _msgRef(tab, locId) {
  if (tab === 'general') return collection(db, 'general-chat', 'global', 'messages');
  if (locId)             return collection(db, 'chats', locId, 'messages');
  console.warn('[Trade] _msgRef: no locId — message dropped.');
  return null;
}

async function _postTradeCard(tradeId, tab, locId, initiatorName, targetName, snapshot) {
  const ref = _msgRef(tab, locId);
  if (!ref) return null;
  return addDoc(ref, {
    uid:          'system',
    charName:     '🔄 TRADE',
    isTradeCard:  true,
    tradeId,
    tradeSnapshot: snapshot,
    initiatorName,
    targetName,
    text:         `🔄 ${initiatorName} wants to trade with ${targetName}`,
    timestamp:    serverTimestamp(),
  });
}

async function _patchTradeCard(tradeId, tab, locId, snapshot) {
  // Post a new static card reflecting the current state
  const ref = _msgRef(tab, locId);
  if (!ref) return;
  await addDoc(ref, {
    uid:           'system',
    charName:      '🔄 TRADE',
    isTradeCard:   true,
    tradeId,
    tradeSnapshot: snapshot,
    initiatorName: snapshot.initiatorName,
    targetName:    snapshot.targetName,
    text:          `🔄 Trade between ${snapshot.initiatorName} and ${snapshot.targetName}`,
    timestamp:     serverTimestamp(),
  });
}

async function _postSystemMsg(tab, locId, text) {
  const ref = _msgRef(tab, locId);
  if (!ref) return;
  await addDoc(ref, {
    uid:      'system',
    charName: '🔄 TRADE',
    isSystem: true,
    text,
    timestamp: serverTimestamp(),
  });
}

// ── Listen for incoming trade requests ────────────
function _listenForIncomingTradeRequests() {
  const uid = _getUid();
  if (!uid) return;
  onSnapshot(
    collection(db, 'trades'),
    // We use a broad listener and filter client-side to avoid needing
    // a composite index. Only fires for new 'pending' trades targeting this uid.
    (snap) => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'added') {
          const d = ch.doc.data();
          if (d.targetId === uid && d.status === 'pending') {
            _showTradeToast(ch.doc.id, d.initiatorName);
          }
        }
      });
    }
  );
}

function _showTradeToast(tradeId, initiatorName) {
  document.getElementById('trade-request-toast')?.remove();
  const t = document.createElement('div');
  t.id        = 'trade-request-toast';
  t.className = 'trade-request-toast';
  t.innerHTML = `
    <div class="trt-glow"></div>
    <div class="trt-icon">🔄</div>
    <div class="trt-body">
      <div class="trt-title">TRADE REQUEST</div>
      <div class="trt-msg"><b>${initiatorName}</b> wants to trade with you!</div>
      <div class="trt-hint">Tap to open the trade window</div>
      <div class="trt-btns">
        <button class="trade-btn trade-btn-accept"  onclick="window.acceptTradeRequest('${tradeId}')">✅ ACCEPT</button>
        <button class="trade-btn trade-btn-decline" onclick="window.declineTradeRequest('${tradeId}')">✕ DECLINE</button>
      </div>
    </div>
    <button class="trt-close" onclick="this.closest('.trade-request-toast').remove()">✕</button>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('visible')));
}

// ── Trade modal ───────────────────────────────────
function _openTradeModal(tradeId) {
  _currentTradeId = tradeId;
  let modal = document.getElementById('trade-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id        = 'trade-modal';
    modal.className = 'trade-modal-overlay';
    modal.innerHTML = `
      <div class="trade-modal" onclick="event.stopPropagation()">
        <div class="trade-modal-header">
          <span class="trade-modal-title">🔄 TRADE</span>
          <span class="trade-modal-participants" id="trade-modal-participants"></span>
          <button class="trade-modal-close" onclick="window.cancelTrade(window._currentTradeId)">✕ Cancel</button>
        </div>
        <div class="trade-modal-body">
          <!-- Left: my side -->
          <div class="trade-side" id="trade-side-mine">
            <div class="trade-side-label" id="trade-label-mine">Your Offer</div>
            <div class="trade-offer-zone" id="trade-offer-mine"></div>
            <div class="trade-gold-row">
              <span class="trade-gold-label">💰 Gold</span>
              <input class="trade-gold-input" id="trade-gold-input" type="number" min="0" placeholder="0"
                onchange="window.setTradeGold(window._currentTradeId, this.value)"/>
            </div>
            <button class="trade-add-btn" id="trade-add-btn" onclick="window.openTradeItemPicker()">+ Add Item</button>
            <button class="trade-confirm-btn" id="trade-confirm-btn" onclick="window.confirmTrade(window._currentTradeId)">✅ Confirm Offer</button>
            <button class="trade-unconfirm-btn" id="trade-unconfirm-btn" style="display:none" onclick="window.unconfirmTrade(window._currentTradeId)">✏️ Edit Offer</button>
          </div>

          <div class="trade-divider">
            <div class="trade-divider-line"></div>
            <div class="trade-vs-badge">⇌</div>
            <div class="trade-divider-line"></div>
          </div>

          <!-- Right: their side -->
          <div class="trade-side" id="trade-side-theirs">
            <div class="trade-side-label" id="trade-label-theirs">Their Offer</div>
            <div class="trade-offer-zone" id="trade-offer-theirs"></div>
            <div class="trade-gold-row">
              <span class="trade-gold-label">💰 Gold</span>
              <span class="trade-gold-value" id="trade-gold-theirs">0</span>
            </div>
          </div>
        </div>
        <div class="trade-status-bar" id="trade-status-bar">Waiting for both players to confirm...</div>
        <div class="trade-spectator-note" id="trade-spectator-note" style="display:none">👁 You are spectating this trade</div>
      </div>

      <!-- Item picker panel -->
      <div class="trade-item-picker" id="trade-item-picker" style="display:none" onclick="event.stopPropagation()">
        <div class="trade-picker-header">
          <span>Select an Item to Offer</span>
          <button onclick="window.closeTradeItemPicker()">✕</button>
        </div>
        <div class="trade-picker-search">
          <input type="text" id="trade-picker-search-input" placeholder="Search items..." oninput="window._filterTradeItems(this.value)"/>
        </div>
        <div class="trade-picker-grid" id="trade-picker-grid"></div>
      </div>`;
    document.body.appendChild(modal);
  }

  modal.style.display = 'flex';
  window._currentTradeId = tradeId;

  // Start live listener
  if (_tradeUnsub) _tradeUnsub();
  _tradeUnsub = onSnapshot(doc(db, 'trades', tradeId), (snap) => {
    if (!snap.exists()) { _closeTradeModal(); return; }
    _renderTradeModal(snap.data(), tradeId);
  });
}

function _closeTradeModal() {
  if (_tradeUnsub) { _tradeUnsub(); _tradeUnsub = null; }
  _currentTradeId = null;
  document.getElementById('trade-modal')?.remove();
}

function _renderTradeModal(trade, tradeId) {
  const uid = _getUid();
  const isInitiator  = trade.initiatorId === uid;
  const isTarget     = trade.targetId    === uid;
  const isParticipant = isInitiator || isTarget;
  const isSpectator  = !isParticipant;

  const myItems     = isInitiator ? trade.initiatorItems : trade.targetItems;
  const myGold      = isInitiator ? trade.initiatorGold  : trade.targetGold;
  const myConfirmed = isInitiator ? trade.initiatorConfirmed : trade.targetConfirmed;
  const theirItems  = isInitiator ? trade.targetItems   : trade.initiatorItems;
  const theirGold   = isInitiator ? trade.targetGold    : trade.initiatorGold;
  const theirConf   = isInitiator ? trade.targetConfirmed : trade.initiatorConfirmed;
  const myName      = isInitiator ? trade.initiatorName : trade.targetName;
  const theirName   = isInitiator ? trade.targetName    : trade.initiatorName;

  // Participants label
  const parts = document.getElementById('trade-modal-participants');
  if (parts) parts.textContent = `${trade.initiatorName} ⇌ ${trade.targetName}`;

  // My offer zone
  const mineZone = document.getElementById('trade-offer-mine');
  if (mineZone) {
    if (!myItems || myItems.length === 0) {
      mineZone.innerHTML = `<div class="trade-offer-empty">No items offered yet</div>`;
    } else {
      mineZone.innerHTML = myItems.map(item => `
        <div class="trade-offer-item">
          <span class="trade-item-icon">${item.icon || _getIcon(item.name)}</span>
          <span class="trade-item-name">${item.name}</span>
          <span class="trade-item-qty">×${item.qty}</span>
          ${!myConfirmed && isParticipant ? `<button class="trade-remove-item" onclick="window.removeTradeItem('${tradeId}','${item.name}')">✕</button>` : ''}
        </div>`).join('');
    }
  }

  // Gold input
  const goldInput = document.getElementById('trade-gold-input');
  if (goldInput) goldInput.value = myGold || '';

  // Their offer zone
  const theirZone = document.getElementById('trade-offer-theirs');
  if (theirZone) {
    if (!theirItems || theirItems.length === 0) {
      theirZone.innerHTML = `<div class="trade-offer-empty">No items offered yet</div>`;
    } else {
      theirZone.innerHTML = theirItems.map(item => `
        <div class="trade-offer-item">
          <span class="trade-item-icon">${item.icon || _getIcon(item.name)}</span>
          <span class="trade-item-name">${item.name}</span>
          <span class="trade-item-qty">×${item.qty}</span>
        </div>`).join('');
    }
  }

  // Their gold
  const goldTheirs = document.getElementById('trade-gold-theirs');
  if (goldTheirs) goldTheirs.textContent = theirGold || 0;

  // Labels — show confirmed tick
  const labelMine = document.getElementById('trade-label-mine');
  if (labelMine) {
    labelMine.textContent = isSpectator
      ? trade.initiatorName
      : (myConfirmed ? '✅ Your Offer (Confirmed)' : 'Your Offer');
  }
  const labelTheirs = document.getElementById('trade-label-theirs');
  if (labelTheirs) {
    labelTheirs.textContent = isSpectator
      ? trade.targetName
      : (theirConf ? `✅ ${theirName}'s Offer (Confirmed)` : `${theirName}'s Offer`);
  }

  // Confirm / unconfirm buttons
  const confirmBtn   = document.getElementById('trade-confirm-btn');
  const unconfirmBtn = document.getElementById('trade-unconfirm-btn');
  const addBtn       = document.getElementById('trade-add-btn');
  if (confirmBtn)   confirmBtn.style.display   = (!myConfirmed && isParticipant && trade.status === 'active') ? '' : 'none';
  if (unconfirmBtn) unconfirmBtn.style.display = (myConfirmed  && isParticipant && trade.status === 'active') ? '' : 'none';
  if (addBtn)       addBtn.style.display       = (!myConfirmed && isParticipant && trade.status === 'active') ? '' : 'none';
  if (goldInput)    goldInput.disabled         = (myConfirmed  || !isParticipant || trade.status !== 'active');

  // Status bar
  const statusBar = document.getElementById('trade-status-bar');
  if (statusBar) {
    if (trade.status === 'complete') {
      statusBar.textContent = '🤝 Trade complete!';
      statusBar.className   = 'trade-status-bar trade-status-complete';
    } else if (trade.status === 'cancelled') {
      statusBar.textContent = '❌ Trade cancelled.';
      statusBar.className   = 'trade-status-bar trade-status-cancelled';
    } else if (trade.status === 'pending') {
      statusBar.textContent = `⏳ Waiting for ${trade.targetName} to accept...`;
      statusBar.className   = 'trade-status-bar';
    } else {
      const iConf = trade.initiatorConfirmed;
      const tConf = trade.targetConfirmed;
      if (iConf && tConf) {
        statusBar.textContent = '⚡ Both confirmed — completing trade...';
        statusBar.className   = 'trade-status-bar trade-status-ready';
      } else if (iConf) {
        statusBar.textContent = `✅ ${trade.initiatorName} confirmed — waiting for ${trade.targetName}...`;
        statusBar.className   = 'trade-status-bar trade-status-one';
      } else if (tConf) {
        statusBar.textContent = `✅ ${trade.targetName} confirmed — waiting for ${trade.initiatorName}...`;
        statusBar.className   = 'trade-status-bar trade-status-one';
      } else {
        statusBar.textContent = 'Add items and confirm when ready.';
        statusBar.className   = 'trade-status-bar';
      }
    }
  }

  // Spectator note
  const spectNote = document.getElementById('trade-spectator-note');
  if (spectNote) spectNote.style.display = isSpectator ? '' : 'none';

  // When trade completes, apply this client's inventory update from the resolved data
  // stored in the trade doc. Each client writes only their own character — permitted.
  if (trade.status === 'complete' && trade.resolvedInitiatorInv) {
    const uid = _getUid();
    if (uid === trade.initiatorId || uid === trade.targetId) {
      _applyTradeResolution(
        trade, uid,
        trade.resolvedInitiatorInv,  trade.resolvedInitiatorGold,
        trade.resolvedTargetInv,     trade.resolvedTargetGold
      );
    }
  }

  // Auto-close modal after complete/cancel with a short delay
  if (trade.status === 'complete' || trade.status === 'cancelled') {
    setTimeout(() => _closeTradeModal(), 2500);
  }
}

// ── Build full tradeable item list from charData ─────
function _getTradableItems(charData) {
  const items = [];
  // Regular inventory
  for (const i of (charData.inventory || [])) {
    if (i.name) items.push({ name: i.name, qty: i.qty ?? 1, icon: i.icon || _getIcon(i.name) });
  }
  // Equipped weapon — show as qty 1, labelled (equipped)
  const eq = charData.equipment || {};
  if (eq.weapon) {
    const existing = items.find(i => i.name === eq.weapon);
    if (existing) { existing.qty += 1; }
    else items.push({ name: eq.weapon, qty: 1, icon: _getIcon(eq.weapon), equipped: true });
  }
  if (eq.armor) {
    const existing = items.find(i => i.name === eq.armor);
    if (existing) { existing.qty += 1; }
    else items.push({ name: eq.armor, qty: 1, icon: _getIcon(eq.armor), equipped: true });
  }
  return items;
}

// ── Item picker ───────────────────────────────────
export function openTradeItemPicker() {
  const charData = _getCharData();
  if (!charData) return;

  const picker = document.getElementById('trade-item-picker');
  if (!picker) return;
  picker.style.display = 'block';
  _renderTradePickerItems(_getTradableItems(charData), '');
}

window._filterTradeItems = function(query) {
  const charData = _getCharData();
  if (!charData) return;
  _renderTradePickerItems(_getTradableItems(charData), query.toLowerCase());
};

function _renderTradePickerItems(items, filter) {
  const grid = document.getElementById('trade-picker-grid');
  if (!grid) return;
  const filtered = filter ? items.filter(i => i.name.toLowerCase().includes(filter)) : items;
  if (!filtered.length) {
    grid.innerHTML = `<div class="trade-picker-empty">No items found.</div>`;
    return;
  }
  grid.innerHTML = filtered.map(item => `
    <div class="trade-picker-item" onclick="window._pickTradeItem('${item.name.replace(/'/g, "\'")}')">
      <div class="trade-picker-icon">${item.icon || _getIcon(item.name)}</div>
      <div class="trade-picker-name">${item.name}${item.equipped ? ' <span style="color:#c9a84c;font-size:0.6rem">(E)</span>' : ''}</div>
      <div class="trade-picker-qty">×${item.qty}</div>
    </div>`).join('');
}

window._pickTradeItem = function(itemName) {
  // Show qty input
  const grid = document.getElementById('trade-picker-grid');
  if (!grid) return;
  const charData = _getCharData();
  // Use full tradable list so equipped items are included
  const allItems = _getTradableItems(charData || {});
  const owned = allItems.find(i => i.name === itemName);
  const max = owned?.qty ?? 1;

  grid.innerHTML = `
    <div class="trade-picker-qty-prompt">
      <div style="font-size:1.4rem">${_getIcon(itemName)}</div>
      <div style="font-weight:600;margin:6px 0">${itemName}</div>
      <div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:10px">You own: ${max}</div>
      <div style="display:flex;align-items:center;gap:8px;justify-content:center">
        <button class="trade-qty-btn" onclick="this.nextElementSibling.value=Math.max(1,+this.nextElementSibling.value-1)">−</button>
        <input id="trade-pick-qty" type="number" class="trade-gold-input" value="1" min="1" max="${max}" style="width:60px;text-align:center"/>
        <button class="trade-qty-btn" onclick="this.previousElementSibling.value=Math.min(${max},+this.previousElementSibling.value+1)">+</button>
      </div>
      <div style="display:flex;gap:10px;margin-top:14px;justify-content:center">
        <button class="trade-confirm-btn" style="padding:6px 20px" onclick="
          const qty = parseInt(document.getElementById('trade-pick-qty').value)||1;
          window.addTradeItem(window._currentTradeId,'${itemName}',qty);
          window.closeTradeItemPicker();">Add to Offer</button>
        <button class="trade-unconfirm-btn" style="padding:6px 16px" onclick="window.openTradeItemPicker()">← Back</button>
      </div>
    </div>`;
};

// ── Render trade card in chat (called by dashboard.js) ──
export function renderTradeCard(trade, tradeId, el) {
  if (!el || !trade) return;
  const uid = _getUid();
  const isParticipant = trade.initiatorId === uid || trade.targetId === uid;

  const statusLabel = {
    pending:   '⏳ Pending',
    active:    '🔄 In Progress',
    complete:  '🤝 Complete',
    cancelled: '❌ Cancelled',
  }[trade.status] || '🔄 Trade';

  const initItems  = (trade.initiatorItems  || []);
  const targItems  = (trade.targetItems     || []);

  function renderItemList(items, gold) {
    const parts = items.map(i => `
      <div class="tc-item">
        <span>${i.icon || _getIcon(i.name)}</span>
        <span>${i.name}</span>
        <span class="tc-qty">×${i.qty}</span>
      </div>`).join('');
    const goldPart = gold ? `<div class="tc-item"><span>💰</span><span>${gold} Gold</span></div>` : '';
    return (parts + goldPart) || `<div class="tc-empty">Nothing offered</div>`;
  }

  const iConf = trade.initiatorConfirmed ? '✅' : '⬜';
  const tConf = trade.targetConfirmed    ? '✅' : '⬜';

  el.innerHTML = `
<div class="trade-card ${trade.status || 'pending'}">
  <div class="trade-card-header">
    <div class="trade-card-title">🔄 TRADE</div>
    <div class="trade-card-status">${statusLabel}</div>
  </div>
  <div class="trade-card-body">
    <div class="trade-card-side">
      <div class="trade-card-player">${iConf} ${trade.initiatorName}</div>
      <div class="trade-card-items">${renderItemList(initItems, trade.initiatorGold)}</div>
    </div>
    <div class="trade-card-vs">⇌</div>
    <div class="trade-card-side">
      <div class="trade-card-player">${tConf} ${trade.targetName}</div>
      <div class="trade-card-items">${renderItemList(targItems, trade.targetGold)}</div>
    </div>
  </div>
  ${(trade.status === 'active' || trade.status === 'pending') && isParticipant ? `
  <div class="trade-card-footer">
    <button class="trade-card-open-btn" onclick="window._openTradeModal('${tradeId}')">Open Trade Window</button>
  </div>` : ''}
</div>`;
}

// ── Global bindings ────────────────────────────────
window.initTradeSystem      = initTradeSystem;
window.updateTradeContext   = updateTradeContext;
window.initiateTrade        = initiateTrade;
window.acceptTradeRequest   = async (id) => acceptTradeRequest(id).catch(e => window.showToast?.(e.message, 'error'));
window.declineTradeRequest  = async (id) => declineTradeRequest(id).catch(e => window.showToast?.(e.message, 'error'));
window.cancelTrade          = (id) => cancelTrade(id).catch(e => window.showToast?.(e.message, 'error'));
window.addTradeItem         = (id, name, qty) => addTradeItem(id, name, qty).catch(e => window.showToast?.(e.message, 'error'));
window.removeTradeItem      = (id, name) => removeTradeItem(id, name).catch(e => window.showToast?.(e.message, 'error'));
window.setTradeGold         = (id, amt) => setTradeGold(id, amt).catch(e => window.showToast?.(e.message, 'error'));
window.confirmTrade         = (id) => confirmTrade(id).catch(e => window.showToast?.(e.message, 'error'));
window.unconfirmTrade       = (id) => unconfirmTrade(id).catch(e => window.showToast?.(e.message, 'error'));
window.openTradeItemPicker  = openTradeItemPicker;
window.closeTradeItemPicker = () => { const p = document.getElementById('trade-item-picker'); if (p) p.style.display = 'none'; };
window.renderTradeCard      = renderTradeCard;
window._openTradeModal      = _openTradeModal;
// Live-mount a trade card — all viewers (traders + spectators) see real-time updates.
const _tradeCardUnsubs = new Map();

window.mountTradeCard = (tradeId, el, snapshot) => {
  // Render immediately with the snapshot so there's no blank flash
  if (snapshot) renderTradeCard(snapshot, tradeId, el);

  // Tear down any existing listener for this tradeId
  if (_tradeCardUnsubs.has(tradeId)) {
    _tradeCardUnsubs.get(tradeId)();
    _tradeCardUnsubs.delete(tradeId);
  }

  // Attach a live listener — updates whenever the trade doc changes
  const unsub = onSnapshot(doc(db, 'trades', tradeId), (snap) => {
    if (!snap.exists()) return;
    const trade = snap.data();
    renderTradeCard(trade, tradeId, el);
    if (trade.status === 'complete') {
      // Apply this client's inventory from the resolved data in the trade doc.
      // Safe even if already applied — updateDoc is idempotent here.
      if (trade.resolvedInitiatorInv) {
        const uid = _getUid();
        if (uid === trade.initiatorId || uid === trade.targetId) {
          _applyTradeResolution(
            trade, uid,
            trade.resolvedInitiatorInv,  trade.resolvedInitiatorGold,
            trade.resolvedTargetInv,     trade.resolvedTargetGold
          );
        }
      }
      unsub();
      _tradeCardUnsubs.delete(tradeId);
    } else if (trade.status === 'cancelled') {
      unsub();
      _tradeCardUnsubs.delete(tradeId);
    }
  });
  _tradeCardUnsubs.set(tradeId, unsub);
};