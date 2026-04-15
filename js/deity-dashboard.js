// Edit faction leader profile (name/image) for current deity
async function editFactionLeaderProfile() {
  const editForm = document.getElementById('faction-leader-edit-form');
  if (!editForm) return;
  const leaderId = editForm.dataset.leaderId;
  const name = document.getElementById('faction-leader-edit-name')?.value.trim();
  const fileInput = document.getElementById('faction-leader-edit-image-file');
  const errEl = document.getElementById('faction-leader-edit-error');
  if (errEl) errEl.textContent = '';
  if (!leaderId) { if (errEl) errEl.textContent = 'No leader profile found.'; return; }
  if (!name) { if (errEl) errEl.textContent = 'Enter a leader name.'; return; }
  // Get current doc ref
  const docRef = doc(db, 'factionLeaders', leaderId);
  let imageUrl = null;
  if (fileInput && fileInput.files && fileInput.files[0]) {
    // Upload new image using top-level storage imports
    try {
      const file = fileInput.files[0];
      const ext  = file.name.split('.').pop() || 'jpg';
      const path = `faction-leaders/${leaderId}.${ext}`;
      const fileRef = storageRef(storage, path);
      await uploadBytes(fileRef, file);
      imageUrl = await getDownloadURL(fileRef);
    } catch (e) {
      if (errEl) errEl.textContent = 'Image upload failed: ' + (e.message || 'Unknown error');
      return;
    }
  }
  // Update Firestore doc
  const updateData = { leaderName: name };
  if (imageUrl) updateData.leaderImage = imageUrl;
  try {
    await updateDoc(docRef, updateData);
  } catch (e) {
    if (errEl) errEl.textContent = 'Save failed: ' + (e.message || 'Unknown error');
    return;
  }
  document.getElementById('faction-leader-edit-modal')?.remove();
  window.showToast('Leader profile updated!', 'success');
  loadFactionLeaders();
}

window.editFactionLeaderProfile = editFactionLeaderProfile;

// Image preview for edit form
function setupFactionLeaderEditImagePreview() {
  const fileInput = document.getElementById('faction-leader-edit-image-file');
  const preview = document.getElementById('faction-leader-edit-image-preview');
  const filenameSpan = document.getElementById('faction-leader-edit-image-filename');
  if (fileInput && preview) {
    fileInput.addEventListener('change', function() {
      if (fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = function(ev) {
          preview.src = ev.target.result;
          preview.style.display = 'block';
        };
        reader.readAsDataURL(fileInput.files[0]);
        if (filenameSpan) filenameSpan.textContent = fileInput.files[0].name;
      } else {
        preview.src = '';
        preview.style.display = 'none';
        if (filenameSpan) filenameSpan.textContent = '';
      }
    });
  }
  // Accessibility: allow label to trigger file input on Enter/Space
  const fileLabel = document.getElementById('faction-leader-edit-image-label');
  if (fileLabel && fileInput) {
    fileLabel.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
  }
}

// Ensure preview logic is attached for edit form
setupFactionLeaderEditImagePreview();
document.addEventListener('DOMContentLoaded', setupFactionLeaderEditImagePreview);
// ═══════════════════════════════════════════════════
//  FACTION LEADER PROFILE LOGIC
// ═══════════════════════════════════════════════════

// Auto-load faction leaders when panel is shown
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('faction-leader-list')) {
    window.loadFactionLeaders();
  }
});
async function claimFactionLeaderProfile() {
  const faction = document.getElementById('faction-leader-select')?.value;
  const name = document.getElementById('faction-leader-name')?.value.trim();
  const fileInput = document.getElementById('faction-leader-image-file');
  const errEl = document.getElementById('faction-leader-error');
  if (errEl) errEl.textContent = '';
  if (!faction) { if (errEl) errEl.textContent = 'Select a faction.'; return; }
  if (!name) { if (errEl) errEl.textContent = 'Enter a leader name.'; return; }
  if (!fileInput || !fileInput.files || !fileInput.files[0]) { if (errEl) errEl.textContent = 'Upload a profile image.'; return; }
  // Check if faction is already claimed
  const q = query(collection(db, 'factionLeaders'), where('faction', '==', faction));
  const snap = await getDocs(q);
  if (!snap.empty) { if (errEl) errEl.textContent = 'This faction already has a leader.'; return; }
  // Upload image to Firebase Storage
  let imageUrl = '';
  try {
    const file = fileInput.files[0];
    const ext  = file.name.split('.').pop() || 'jpg';
    const path = `faction-leaders/${faction.replace(/\s+/g, '_')}_${_uid}.${ext}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file);
    imageUrl = await getDownloadURL(fileRef);
  } catch (e) {
    console.error('Image upload error:', e);
    if (errEl) errEl.textContent = 'Image upload failed: ' + (e.message || e.code || 'Unknown error');
    return;
  }
  // Save leader profile
  await addDoc(collection(db, 'factionLeaders'), {
    faction,
    deityUid: _uid,
    leaderName: name,
    leaderImage: imageUrl,
    createdAt: serverTimestamp(),
  });
  window.showToast('Faction leader profile created!', 'success');
  loadFactionLeaders();
}

// ── Image preview for faction leader upload ──────────
function setupFactionLeaderImagePreview() {
  const fileInput    = document.getElementById('faction-leader-image-file');
  const preview      = document.getElementById('faction-leader-image-preview');
  const filenameSpan = document.getElementById('faction-leader-image-filename');
  if (!fileInput || !preview) return;

  fileInput.addEventListener('change', function() {
    if (fileInput.files && fileInput.files[0]) {
      const reader = new FileReader();
      reader.onload = function(ev) {
        preview.src = ev.target.result;
        preview.style.display = 'block';
      };
      reader.readAsDataURL(fileInput.files[0]);
      if (filenameSpan) filenameSpan.textContent = fileInput.files[0].name;
    } else {
      preview.src = '';
      preview.style.display = 'none';
      if (filenameSpan) filenameSpan.textContent = '';
    }
  });

  // Accessibility: allow label to trigger file input on Enter/Space
  const fileLabel = document.getElementById('faction-leader-image-label');
  if (fileLabel) {
    fileLabel.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
  }
}

// Run on DOMContentLoaded and also when factions panel is opened
document.addEventListener('DOMContentLoaded', setupFactionLeaderImagePreview);

async function loadFactionLeaders() {
  const list = document.getElementById('faction-leader-list');
  if (!list) return;
  const snap = await getDocs(collection(db, 'factionLeaders'));
  const leaders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  window._lastLoadedFactionLeaders = leaders;
  // Find if current deity has a leader profile
  const myLeader = leaders.find(l => l.deityUid === _uid);
  // Toggle claim form
  const claimForm = document.getElementById('faction-leader-claim-form');
  if (claimForm) claimForm.style.display = myLeader ? 'none' : '';
  // Render leader cards
  list.innerHTML = leaders.length === 0
    ? '<p style="color:var(--text-dim);font-style:italic;font-size:0.85rem">No factions claimed yet.</p>'
    : leaders.map(l => {
      const isMine = l.deityUid === _uid;
      return `<div class="faction-leader-card">
        <img src="${l.leaderImage}" class="faction-leader-img" style="width:120px;height:120px;max-width:120px;max-height:120px;border-radius:50%;object-fit:cover;border:2px solid var(--gold)"/>
        <div class="faction-leader-info">
          <div class="faction-leader-name">${l.leaderName}</div>
          <div class="faction-leader-faction">${l.faction}</div>
          ${isMine ? '<button class="btn-primary" style="margin-top:10px;width:auto;padding:6px 18px;font-size:0.9em" onclick="window.showEditFactionLeaderModal()">Edit Profile</button>' : ''}
        </div>
      </div>`;
    }).join('');
  // Auto-fill faction in faction quest form
  const factionInput = document.getElementById('faction-quest-faction');
  if (factionInput) {
    factionInput.value    = myLeader ? myLeader.faction : '';
    factionInput.disabled = !myLeader;
  }
  // Inject fq-completion-type select if not already present
  if (!document.getElementById("fq-completion-type")) {
    const fqCompRow = document.createElement("div");
    fqCompRow.style.cssText = "margin-bottom:10px";
    fqCompRow.innerHTML = `
      <label style="font-size:0.78rem;font-family:var(--font-mono);color:var(--text-dim);letter-spacing:0.05em;display:block;margin-bottom:4px">Completion Type</label>
      <select id="fq-completion-type" style="width:100%;background:var(--ink3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text-light);font-size:0.85rem;font-family:var(--font-mono)">
        <option value="open">♻️ Open — any player may complete</option>
        <option value="one_time">🔒 One-time — first approval claims it</option>
      </select>`;
    // Insert before the error/submit row — after fq-reward-items textarea
    const fqItems = document.getElementById("fq-reward-items");
    if (fqItems) fqItems.closest("div")?.after(fqCompRow);
  }
  // Also load quests for this faction (submissions are awaited inside loadFactionMissions)
  loadFactionMissions();
}

window.showEditFactionLeaderModal = function() {
  const leaders  = window._lastLoadedFactionLeaders || [];
  const myLeader = leaders.find(l => l.deityUid === _uid);
  if (!myLeader) return;
  document.getElementById('faction-leader-edit-modal')?.remove();
  const modal = document.createElement('div');
  modal.id        = 'faction-leader-edit-modal';
  modal.className = 'deity-modal';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="deity-modal-box" style="max-width:420px">
      <div id="faction-leader-edit-form" data-leader-id="${myLeader.id}">
        <div class="card-title">EDIT FACTION LEADER PROFILE</div>
        <div class="field-group" style="margin-bottom:10px">
          <label class="field-label">Leader Name</label>
          <input class="field-input" type="text" id="faction-leader-edit-name" maxlength="40" placeholder="Leader name..." value="${myLeader.leaderName || ''}"/>
        </div>
        <div class="field-group" style="margin-bottom:10px">
          <label class="field-label" for="faction-leader-edit-image-file">Profile Image</label>
          <label for="faction-leader-edit-image-file" class="custom-file-label" id="faction-leader-edit-image-label" tabindex="0">Choose File</label>
          <input type="file" id="faction-leader-edit-image-file" accept="image/*" style="display:none"/>
          <span id="faction-leader-edit-image-filename" style="margin-left:12px;color:var(--text-dim);font-size:0.92em;"></span>
          <img id="faction-leader-edit-image-preview" src="${myLeader.leaderImage || ''}" style="${myLeader.leaderImage ? 'display:block;' : 'display:none;'}margin-top:8px;max-width:80px;max-height:80px;border-radius:50%;object-fit:cover;border:2px solid var(--gold)"/>
        </div>
        <div class="form-error" id="faction-leader-edit-error" style="margin-bottom:8px"></div>
        <div style="display:flex;gap:10px">
          <button class="btn-primary" onclick="window.editFactionLeaderProfile()">SAVE CHANGES</button>
          <button class="btn-secondary" onclick="document.getElementById('faction-leader-edit-modal').remove()">CANCEL</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setupFactionLeaderEditImagePreview();
};

window.claimFactionLeaderProfile = claimFactionLeaderProfile;
window.loadFactionLeaders = loadFactionLeaders;
// ── WorldDev Location Autocomplete ──
const WORLD_LOCATIONS = [
  "Gladys Kingdom (Frostspire)", "Whitecrest Village", "Icerun Hamlet", "Paleglow Town", "Mistveil Town",
  "Frostfang Valley", "Sheen Lake", "Misty Hollow", "Dark Cathedral", "Wisteria Forest", "Silver Lake", "Hobbit Cave",
  "Arctic Willow Grove", "Dream River", "Suldan Mine", "Shrine of Secrets", "Aurora Basin", "Forgotten Estuary",
  "Elaria Kingdom (Solmere)", "Sunpetal Village", "Basil Village", "Riverend Town", "Verdance Town",
  "Whispering Forest", "Golden Plains", "Element Valley", "Defiled Sanctum", "Asahi Valley", "Moss Stream",
  "Argent Grotto", "Golden River", "Shiny Cavern", "Purgatory of Light", "Temple of Verdict", "Heart Garden",
  "Valley of Overflowing", "Ashen Wastes", "Dark Sphinx", "Blue Phoenix", "Fallen Cyclops", "Infernal Reach",
  "Cerberus", "Blood Kraken", "Ruined Sanctum", "Profane Priest", "Corrupted Sage", "Demonic Herald",
  "Blighted World", "Abomination", "Devil Centurion", "Void Chasm", "Void Lurker", "Oblivion Eye",
  "Abyssal Depths", "Abyssal Eater", "Chaoswalker", "Fallen Heaven", "Godless Thing"
];


window.showLocationDropdown = function() {
  const input = document.getElementById('worlddev-location');
  const dropdown = document.getElementById('worlddev-location-dropdown');
  if (!input || !dropdown) return;
  const val = input.value.trim().toLowerCase();
  let filtered = WORLD_LOCATIONS.filter(loc => loc.toLowerCase().includes(val));
  if (!val) filtered = WORLD_LOCATIONS;
  if (filtered.length === 0) {
    dropdown.style.display = 'none';
    return;
  }
  dropdown.innerHTML = filtered.map(loc => `<div class='location-option' onmousedown='selectLocationOption(this, event)'>${loc}</div>`).join('');
  dropdown.style.display = 'block';
};

window.hideLocationDropdown = function() {
  setTimeout(() => {
    const dropdown = document.getElementById('worlddev-location-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }, 120); // Delay to allow click
};

window.selectLocationOption = function(el, evt) {
  if (evt) evt.preventDefault();
  const input = document.getElementById('worlddev-location');
  if (input && el) input.value = el.textContent;
  hideLocationDropdown();
};
// ═══════════════════════════════════════════════════

// ── ITEM/REWARD PICKER DATA ──
const ITEMS = [
  // ── WEAPONS ──────────────────────────────────────────────
  // E-Grade
  { name:"Rusted Greatsword",    icon:"⚔️",  type:"weapon", grade:"E", stats:"+7 STR" },
  { name:"Crude Bow",            icon:"🏹",  type:"weapon", grade:"E", stats:"+6 DEX" },
  { name:"Iron Dagger",          icon:"🗡️", type:"weapon", grade:"E", stats:"+5 DEX" },
  { name:"Apprentice Wand",      icon:"🪄",  type:"weapon", grade:"E", stats:"+8 INT" },
  { name:"Shortblade",           icon:"🗡️", type:"weapon", grade:"E", stats:"+6 STR" },
  { name:"Bone Mace",            icon:"🔨",  type:"weapon", grade:"E", stats:"+7 STR" },
  { name:"Hunter Knife",         icon:"🗡️", type:"weapon", grade:"E", stats:"+6 DEX" },
  { name:"Quartz Rod",           icon:"🪄",  type:"weapon", grade:"E", stats:"+9 INT" },
  { name:"Tin Blade",            icon:"⚔️",  type:"weapon", grade:"E", stats:"+5 STR" },
  { name:"Feather Knife",        icon:"🗡️", type:"weapon", grade:"E", stats:"+6 DEX" },
  // D-Grade
  { name:"Obsidian Greatsword",  icon:"⚔️",  type:"weapon", grade:"D", stats:"+14 STR, +5 DEX" },
  { name:"Silver Wand",          icon:"🪄",  type:"weapon", grade:"D", stats:"+12 INT, +6 DEX" },
  { name:"Longbow",              icon:"🏹",  type:"weapon", grade:"D", stats:"+13 DEX, +5 STR" },
  { name:"Twin Daggers",         icon:"🗡️", type:"weapon", grade:"D", stats:"+11 DEX, +6 STR" },
  { name:"Warhammer",            icon:"🔨",  type:"weapon", grade:"D", stats:"+15 STR, +4 DEF" },
  { name:"Arc Rod",              icon:"🪄",  type:"weapon", grade:"D", stats:"+14 INT, +5 STR" },
  { name:"Bronze Blade",         icon:"⚔️",  type:"weapon", grade:"D", stats:"+13 STR, +6 DEX" },
  { name:"Hunter Bow",           icon:"🏹",  type:"weapon", grade:"D", stats:"+12 DEX, +5 INT" },
  { name:"Spiked Mace",          icon:"🔨",  type:"weapon", grade:"D", stats:"+14 STR, +5 DEX" },
  { name:"Mystic Knife",         icon:"🗡️", type:"weapon", grade:"D", stats:"+13 DEX, +6 INT" },
  // C-Grade
  { name:"Silver Greatsword",    icon:"⚔️",  type:"weapon", grade:"C", stats:"+25 STR, +8 DEX" },
  { name:"Arcane Staff",         icon:"🪄",  type:"weapon", grade:"C", stats:"+28 INT, +10 DEX" },
  { name:"Composite Bow",        icon:"🏹",  type:"weapon", grade:"C", stats:"+26 DEX, +9 STR" },
  { name:"Assassin Daggers",     icon:"🗡️", type:"weapon", grade:"C", stats:"+27 DEX, +8 INT" },
  { name:"Mystic Blade",         icon:"⚔️",  type:"weapon", grade:"C", stats:"+24 STR, +11 INT" },
  { name:"C-Grade Warhammer",    icon:"🔨",  type:"weapon", grade:"C", stats:"+30 STR, +5 DEX" },
  { name:"Spellknife",           icon:"🗡️", type:"weapon", grade:"C", stats:"+23 DEX, +12 INT" },
  { name:"Dagon Bow",            icon:"🏹",  type:"weapon", grade:"C", stats:"+25 DEX, +9 STR" },
  { name:"Bronze Cleaver",       icon:"⚔️",  type:"weapon", grade:"C", stats:"+28 STR, +7 DEX" },
  { name:"Dark Rod",             icon:"🪄",  type:"weapon", grade:"C", stats:"+29 INT, +6 STR" },
  // B-Grade
  { name:"Myth-Blade",           icon:"⚔️",  type:"weapon", grade:"B", stats:"+48 STR, +15 DEX" },
  { name:"High-Scepter",         icon:"🪄",  type:"weapon", grade:"B", stats:"+50 INT, +14 STR" },
  { name:"Draconic Bow",         icon:"🏹",  type:"weapon", grade:"B", stats:"+47 DEX, +16 STR" },
  { name:"Shadow-Strike",        icon:"🗡️", type:"weapon", grade:"B", stats:"+46 DEX, +18 INT" },
  { name:"Warbreaker",           icon:"🔨",  type:"weapon", grade:"B", stats:"+52 STR, +10 DEX" },
  { name:"Mystic Jian",          icon:"⚔️",  type:"weapon", grade:"B", stats:"+45 STR, +20 INT" },
  { name:"Phantom Longbow",      icon:"🏹",  type:"weapon", grade:"B", stats:"+48 DEX, +14 INT" },
  { name:"Spellhammer",          icon:"🔨",  type:"weapon", grade:"B", stats:"+51 STR, +12 INT" },
  { name:"Venom Daggers",        icon:"🗡️", type:"weapon", grade:"B", stats:"+47 DEX, +16 STR" },
  { name:"Ancient Wand",         icon:"🪄",  type:"weapon", grade:"B", stats:"+53 INT, +10 DEX" },
  // A-Grade
  { name:"Eragon-blade",         icon:"⚔️",  type:"weapon", grade:"A", stats:"+70 STR, +20 DEX" },
  { name:"Void-Steel",           icon:"⚔️",  type:"weapon", grade:"A", stats:"+75 STR, +15 DEF" },
  { name:"Star Lance",           icon:"🪄",  type:"weapon", grade:"A", stats:"+78 INT, +18 DEX" },
  { name:"Crack",                icon:"🗡️", type:"weapon", grade:"A", stats:"+68 DEX, +22 INT" },
  { name:"Divine Fall",          icon:"⚔️",  type:"weapon", grade:"A", stats:"+72 STR, +20 INT" },
  { name:"Nether-Bow",           icon:"🏹",  type:"weapon", grade:"A", stats:"+69 DEX, +19 STR" },
  { name:"Holy Relic",           icon:"🪄",  type:"weapon", grade:"A", stats:"+77 INT, +16 STR" },
  { name:"Realm Cleaver",        icon:"⚔️",  type:"weapon", grade:"A", stats:"+74 STR, +18 DEX" },
  { name:"BeastFang",            icon:"🗡️", type:"weapon", grade:"A", stats:"+71 DEX, +20 STR" },
  { name:"Scion",                icon:"⚔️",  type:"weapon", grade:"A", stats:"+73 STR, +17 INT" },
  // S-Grade
  { name:"Abjuration",           icon:"✨",  type:"weapon", grade:"S", stats:"+100 STR, +40 DEX, +30 INT" },
  { name:"Genesis",              icon:"✨",  type:"weapon", grade:"S", stats:"+100 INT, +35 STR, +35 DEX" },
  { name:"Longinus",             icon:"✨",  type:"weapon", grade:"S", stats:"+100 DEX, +40 STR, +25 INT" },
  { name:"Jingu Bang",           icon:"✨",  type:"weapon", grade:"S", stats:"+100 DEX, +45 INT, +20 STR" },
  { name:"Ragnarok",             icon:"✨",  type:"weapon", grade:"S", stats:"+100 STR, +30 DEX, +30 INT" },
  { name:"Godslayer",            icon:"✨",  type:"weapon", grade:"S", stats:"+100 INT, +30 STR, +30 DEX" },
  { name:"Durandal",             icon:"✨",  type:"weapon", grade:"S", stats:"+100 STR, +35 DEX, +20 INT" },
  { name:"Excalibur",            icon:"✨",  type:"weapon", grade:"S", stats:"+100 STR, +25 INT, +35 DEX" },
  { name:"Bane",                 icon:"✨",  type:"weapon", grade:"S", stats:"+100 DEX, +35 INT, +25 STR" },
  { name:"Judgment",             icon:"✨",  type:"weapon", grade:"S", stats:"+100 INT, +30 STR, +30 DEX" },

  // ── ARMOR ───────────────────────────────────────────────
  // E-Grade
  { name:"Leather Vest",         icon:"🛡️", type:"armor", grade:"E", stats:"+6 DEF" },
  { name:"Iron Plate",           icon:"🛡️", type:"armor", grade:"E", stats:"+8 DEF" },
  { name:"Bone Armor",           icon:"🛡️", type:"armor", grade:"E", stats:"+7 DEF" },
  { name:"Fur Coat",             icon:"🧥",  type:"armor", grade:"E", stats:"+5 DEF" },
  { name:"Hide Armor",           icon:"🛡️", type:"armor", grade:"E", stats:"+6 DEF" },
  { name:"Feather Cloak",        icon:"🧥",  type:"armor", grade:"E", stats:"+5 DEF" },
  { name:"Tin Armor",            icon:"🛡️", type:"armor", grade:"E", stats:"+7 DEF" },
  { name:"Copper Plate",         icon:"🛡️", type:"armor", grade:"E", stats:"+6 DEF" },
  { name:"Marble Guard",         icon:"🛡️", type:"armor", grade:"E", stats:"+8 DEF" },
  { name:"Obsidian Layer",       icon:"🛡️", type:"armor", grade:"E", stats:"+9 DEF" },
  // D-Grade
  { name:"Steel Armor",          icon:"🛡️", type:"armor", grade:"D", stats:"+15 DEF, +7 HP" },
  { name:"Reinforced Leather",   icon:"🧥",  type:"armor", grade:"D", stats:"+13 DEF, +6 HP" },
  { name:"Silver Guard",         icon:"🛡️", type:"armor", grade:"D", stats:"+14 DEF, +7 HP" },
  { name:"Bone Plate",           icon:"🛡️", type:"armor", grade:"D", stats:"+16 DEF, +8 HP" },
  { name:"Fur Armor",            icon:"🧥",  type:"armor", grade:"D", stats:"+12 DEF, +6 HP" },
  { name:"Horned Armor",         icon:"🛡️", type:"armor", grade:"D", stats:"+17 DEF, +9 HP" },
  { name:"Scale Vest",           icon:"🛡️", type:"armor", grade:"D", stats:"+15 DEF, +7 HP" },
  { name:"Bronze Armor",         icon:"🛡️", type:"armor", grade:"D", stats:"+16 DEF, +8 HP" },
  { name:"Obsidian Plate",       icon:"🛡️", type:"armor", grade:"D", stats:"+18 DEF, +9 HP" },
  { name:"Marble Armor",         icon:"🛡️", type:"armor", grade:"D", stats:"+14 DEF, +6 HP" },
  // C-Grade
  { name:"Shining Armor",        icon:"🛡️", type:"armor", grade:"C", stats:"+30 DEF, +15 HP" },
  { name:"Bronze Cuirass",       icon:"🛡️", type:"armor", grade:"C", stats:"+32 DEF, +18 HP" },
  { name:"Jagged Chainmail",     icon:"🛡️", type:"armor", grade:"C", stats:"+28 DEF, +14 HP" },
  { name:"Bone Fortress",        icon:"🛡️", type:"armor", grade:"C", stats:"+31 DEF, +16 HP" },
  { name:"Obsidian Vest",        icon:"🛡️", type:"armor", grade:"C", stats:"+33 DEF, +17 HP" },
  { name:"Reptilian Scale",      icon:"🛡️", type:"armor", grade:"C", stats:"+29 DEF, +14 HP" },
  { name:"Shadow Cloak",         icon:"🧥",  type:"armor", grade:"C", stats:"+27 DEF, +13 HP" },
  { name:"Golden Cape",          icon:"🧥",  type:"armor", grade:"C", stats:"+26 DEF, +12 HP" },
  { name:"Warlord Hide",         icon:"🛡️", type:"armor", grade:"C", stats:"+30 DEF, +15 HP" },
  { name:"Arcane Shell",         icon:"🛡️", type:"armor", grade:"C", stats:"+34 DEF, +19 HP" },
  // B-Grade
  { name:"Void-Spell Armor",     icon:"🛡️", type:"armor", grade:"B", stats:"+50 DEF, +30 HP" },
  { name:"Golden Scales",        icon:"🛡️", type:"armor", grade:"B", stats:"+48 DEF, +25 HP" },
  { name:"Night Cloak",          icon:"🧥",  type:"armor", grade:"B", stats:"+45 DEF, +28 HP" },
  { name:"Spirit-Ward",          icon:"🛡️", type:"armor", grade:"B", stats:"+52 DEF, +35 HP" },
  { name:"Paladin's Mantle",     icon:"🧥",  type:"armor", grade:"B", stats:"+44 DEF, +24 HP" },
  { name:"Draconic Robe",        icon:"🧥",  type:"armor", grade:"B", stats:"+49 DEF, +27 HP" },
  { name:"Titanic Hide",         icon:"🛡️", type:"armor", grade:"B", stats:"+54 DEF, +39 HP" },
  { name:"Golden Warplate",      icon:"🛡️", type:"armor", grade:"B", stats:"+53 DEF, +36 HP" },
  { name:"Mythic Cuirass",       icon:"🛡️", type:"armor", grade:"B", stats:"+46 DEF, +26 HP" },
  { name:"Quintessence Mantle",  icon:"🧥",  type:"armor", grade:"B", stats:"+51 DEF, +33 HP" },
  // A-Grade
  { name:"Heart Hide",           icon:"🛡️", type:"armor", grade:"A", stats:"+75 DEF, +55 HP" },
  { name:"Destroyer Mantle",     icon:"🧥",  type:"armor", grade:"A", stats:"+79 DEF, +59 HP" },
  { name:"Chaos-garb",           icon:"🧥",  type:"armor", grade:"A", stats:"+68 DEF, +47 HP" },
  { name:"Devastator Armor",     icon:"🛡️", type:"armor", grade:"A", stats:"+66 DEF, +45 HP" },
  { name:"Tectonic-Mail",        icon:"🛡️", type:"armor", grade:"A", stats:"+72 DEF, +50 HP" },
  { name:"Elemental Shroud",     icon:"🧥",  type:"armor", grade:"A", stats:"+74 DEF, +52 HP" },
  { name:"Colossal Veil",        icon:"🧥",  type:"armor", grade:"A", stats:"+78 DEF, +58 HP" },
  { name:"Realm-Bound Tunic",    icon:"🧥",  type:"armor", grade:"A", stats:"+70 DEF, +49 HP" },
  { name:"Serpentine-Robe",      icon:"🧥",  type:"armor", grade:"A", stats:"+65 DEF, +44 HP" },
  { name:"Vasto-Shell",          icon:"🛡️", type:"armor", grade:"A", stats:"+76 DEF, +54 HP" },
  // S-Grade
  { name:"Saturn",               icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +80 HP" },
  { name:"Unshadowed",           icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +70 HP" },
  { name:"Null",                 icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +78 HP" },
  { name:"Dominion",             icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +80 HP" },
  { name:"Godshroud",            icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +68 HP" },
  { name:"Oblivion",             icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +75 HP" },
  { name:"Gungnir",              icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +76 HP" },
  { name:"Imperium",             icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +79 HP" },
  { name:"Worldshell",           icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +74 HP" },
  { name:"Eternity",             icon:"✨",  type:"armor", grade:"S", stats:"+100 DEF, +77 HP" },

  // ── POTIONS ─────────────────────────────────────────────
  { name:"Minor HP Potion",         icon:"🧪", type:"potion", stats:"+20% HP" },
  { name:"Standard HP Potion",      icon:"🧪", type:"potion", stats:"+40% HP" },
  { name:"Greater HP Potion",       icon:"🧪", type:"potion", stats:"+70% HP" },
  { name:"Minor Mana Potion",       icon:"💧", type:"potion", stats:"+20% Mana" },
  { name:"Standard Mana Potion",    icon:"💧", type:"potion", stats:"+40% Mana" },
  { name:"Greater Mana Potion",     icon:"💧", type:"potion", stats:"+70% Mana" },
  { name:"Minor Luck Potion",       icon:"🍀", type:"potion", stats:"+5% Luck" },
  { name:"Standard Luck Potion",    icon:"🍀", type:"potion", stats:"+15% Luck" },
  { name:"Greater Luck Potion",     icon:"🍀", type:"potion", stats:"+30% Luck" },
  { name:"Minor EXP Potion",        icon:"⚗️", type:"potion", stats:"+5% EXP" },
  { name:"Standard EXP Potion",     icon:"⚗️", type:"potion", stats:"+15% EXP" },
  { name:"Greater EXP Potion",      icon:"⚗️", type:"potion", stats:"+20% EXP" },
  { name:"Class Reset Potion",      icon:"🔮", type:"potion", stats:"Reset class" },
  { name:"Race Rebirth Potion",     icon:"🔮", type:"potion", stats:"Change race" },
  { name:"Divine Shift Potion",     icon:"🔮", type:"potion", stats:"Change deity" },
  { name:"Stat Reset Potion",       icon:"🔮", type:"potion", stats:"Reset stats" },
  { name:"Companion Change Potion", icon:"🔮", type:"potion", stats:"New companion" },

  // ── FOOD ────────────────────────────────────────────────
  { name:"Grilled Meat Skewer",    icon:"🍢", type:"food", stats:"+5% STR (10m)",  rarity:"Common" },
  { name:"Spiced Steak",           icon:"🥩", type:"food", stats:"+10% STR (15m)", rarity:"Uncommon" },
  { name:"Hunter's Feast",         icon:"🍖", type:"food", stats:"+15% STR (20m)", rarity:"Rare" },
  { name:"Dragonfire Roast",       icon:"🔥", type:"food", stats:"+20% STR (30m)", rarity:"Legendary" },
  { name:"Eden Banquet",           icon:"🌟", type:"food", stats:"+25% STR (40m)", rarity:"Mythic" },
  { name:"Herb Fish Soup",         icon:"🍲", type:"food", stats:"+5% INT (10m)",  rarity:"Common" },
  { name:"Glow Stew",              icon:"🍲", type:"food", stats:"+10% INT (15m)", rarity:"Uncommon" },
  { name:"Mystic Broth",           icon:"🍲", type:"food", stats:"+15% INT (20m)", rarity:"Rare" },
  { name:"Celestial Sashimi",      icon:"🍣", type:"food", stats:"+20% INT (30m)", rarity:"Legendary" },
  { name:"Cosmic Infusion",        icon:"🌌", type:"food", stats:"+25% INT (40m)", rarity:"Mythic" },
  { name:"Roasted Carp",           icon:"🐟", type:"food", stats:"+5% DEF (10m)",  rarity:"Common" },
  { name:"Ironbody Stew",          icon:"🍲", type:"food", stats:"+10% DEF (15m)", rarity:"Uncommon" },
  { name:"Frosthide Meal",         icon:"❄️", type:"food", stats:"+15% DEF (20m)", rarity:"Rare" },
  { name:"Titan Shell Dish",       icon:"🛡️",type:"food", stats:"+20% DEF (30m)", rarity:"Legendary" },
  { name:"Eternal Fortress Feast", icon:"🏰", type:"food", stats:"+25% DEF (40m)", rarity:"Mythic" },
  { name:"Fried Sardine",          icon:"🐟", type:"food", stats:"+5% DEX (10m)",  rarity:"Common" },
  { name:"Crystal Splash Meal",    icon:"💎", type:"food", stats:"+10% DEX (15m)", rarity:"Uncommon" },
  { name:"Assassin's Dish",        icon:"🍽️",type:"food", stats:"+15% DEX (20m)", rarity:"Rare" },
  { name:"Phantom Platter",        icon:"👻", type:"food", stats:"+20% DEX (30m)", rarity:"Legendary" },
  { name:"Divine Speed Feast",     icon:"⚡", type:"food", stats:"+25% DEX (40m)", rarity:"Mythic" },

  // ── MATERIALS ───────────────────────────────────────────
  // Common
  { name:"Iron",             icon:"⛏️", type:"material", rarity:"Common" },
  { name:"Tin",              icon:"⛏️", type:"material", rarity:"Common" },
  { name:"Copper",           icon:"⛏️", type:"material", rarity:"Common" },
  { name:"Limestone",        icon:"🪨",  type:"material", rarity:"Common" },
  { name:"Quartz",           icon:"💎",  type:"material", rarity:"Common" },
  { name:"Leather",          icon:"🟫",  type:"material", rarity:"Common" },
  { name:"Fur",              icon:"🟫",  type:"material", rarity:"Common" },
  { name:"Feathers",         icon:"🪶",  type:"material", rarity:"Common" },
  { name:"Bone Fragments",   icon:"🦴",  type:"material", rarity:"Common" },
  { name:"Animal Fat",       icon:"🫙",  type:"material", rarity:"Common" },
  { name:"Meat",             icon:"🥩",  type:"material", rarity:"Common" },
  // Uncommon
  { name:"Bronze",           icon:"🔶",  type:"material", rarity:"Uncommon" },
  { name:"Silver",           icon:"⚪",  type:"material", rarity:"Uncommon" },
  { name:"Obsidian",         icon:"⬛",  type:"material", rarity:"Uncommon" },
  { name:"Marble",           icon:"🪨",  type:"material", rarity:"Uncommon" },
  { name:"Coal",             icon:"⬛",  type:"material", rarity:"Uncommon" },
  { name:"Tough Hide",       icon:"🟫",  type:"material", rarity:"Uncommon" },
  { name:"Fangs",            icon:"🦷",  type:"material", rarity:"Uncommon" },
  { name:"Claws",            icon:"🦾",  type:"material", rarity:"Uncommon" },
  { name:"Horns",            icon:"🦌",  type:"material", rarity:"Uncommon" },
  // Rare
  { name:"Gold",             icon:"🟡",  type:"material", rarity:"Rare" },
  { name:"Palladium",        icon:"🔵",  type:"material", rarity:"Rare" },
  { name:"Mythril",          icon:"🔷",  type:"material", rarity:"Rare" },
  { name:"Shadow Hide",      icon:"🌑",  type:"material", rarity:"Rare" },
  { name:"Spirit Venison",   icon:"👻",  type:"material", rarity:"Rare" },
  { name:"Drake Meat",       icon:"🐉",  type:"material", rarity:"Rare" },
  // Legendary
  { name:"Adamantium",       icon:"💠",  type:"material", rarity:"Legendary" },
  { name:"Titanium",         icon:"⬜",  type:"material", rarity:"Legendary" },
  { name:"Dragon Scales",    icon:"🐲",  type:"material", rarity:"Legendary" },
  { name:"Cyclops Eye",      icon:"👁️", type:"material", rarity:"Legendary" },
  // Mythic
  { name:"Aetherium",        icon:"🌟",  type:"material", rarity:"Mythic" },
  { name:"Titan Heart",      icon:"❤️‍🔥", type:"material", rarity:"Mythic" },
  // Deity-specific
  { name:"Ephemeral Footprints",    icon:"✨", type:"material", rarity:"Deity" },
  { name:"Oil-stained Feathers",    icon:"✨", type:"material", rarity:"Deity" },
  { name:"Whispering Purple Sands", icon:"✨", type:"material", rarity:"Deity" },
  { name:"The Void-Eye",            icon:"💎", type:"material", rarity:"Deity" },
  { name:"Orb of Silence",          icon:"💎", type:"material", rarity:"Deity" },
  { name:"Magic Crystal",           icon:"💎", type:"material", rarity:"Deity" },
];

const ITEM_CATEGORIES = [
  { key: "weapon",   label: "⚔️ Weapons" },
  { key: "armor",    label: "🛡️ Armor" },
  { key: "potion",   label: "🧪 Potions" },
  { key: "food",     label: "🍖 Food" },
  { key: "material", label: "📦 Materials" },
];

const GRADE_COLORS = { E:"#aaa", D:"#7ec87e", C:"#5b9fe0", B:"#c97de0", A:"#e0a030", S:"#e05555" };
const RARITY_COLORS = { Common:"#aaa", Uncommon:"#7ec87e", Rare:"#5b9fe0", Legendary:"#e0a030", Mythic:"#e05555", Deity:"#c9a84c" };

function renderQuestRewardPicker() {
  const picker = document.getElementById("quest-reward-picker");
  if (!picker) return;

  let selected = [];
  let currentCat = "weapon";
  let searchQuery = "";

  picker.innerHTML = `
    <div class="reward-picker-tabs">
      ${ITEM_CATEGORIES.map(cat => `<button class="reward-picker-tab${cat.key === currentCat ? ' active' : ''}" data-cat="${cat.key}">${cat.label}</button>`).join("")}
    </div>
    <input type="text" id="reward-search" class="field-input" placeholder="🔍 Search items..." style="margin:8px 0;padding:6px 10px;font-size:0.82rem"/>
    <div class="reward-picker-list"></div>
    <div class="reward-picker-selected"></div>
  `;

  const listDiv    = picker.querySelector(".reward-picker-list");
  const selectedDiv = picker.querySelector(".reward-picker-selected");
  const searchInput = picker.querySelector("#reward-search");

  function getBadge(item) {
    if (item.grade) {
      const col = GRADE_COLORS[item.grade] || "#aaa";
      return `<span style="font-size:0.65rem;font-weight:700;padding:1px 5px;border-radius:3px;background:${col}22;color:${col};border:1px solid ${col}44;margin-left:4px">${item.grade}</span>`;
    }
    if (item.rarity) {
      const col = RARITY_COLORS[item.rarity] || "#aaa";
      return `<span style="font-size:0.65rem;font-weight:700;padding:1px 5px;border-radius:3px;background:${col}22;color:${col};border:1px solid ${col}44;margin-left:4px">${item.rarity}</span>`;
    }
    return "";
  }

  function syncHidden() {
    document.getElementById("quest-reward-items").value = selected.map(i => `${i.name}, ${i.qty}`).join("\n");
  }

  function updateSelectedDisplay() {
    if (!selected.length) {
      selectedDiv.innerHTML = `<div style="color:var(--text-dim);font-size:0.82rem;padding:6px 0;font-style:italic">No items selected yet.</div>`;
    } else {
      selectedDiv.innerHTML = `
        <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:6px;font-family:var(--ff-mono);letter-spacing:0.06em">SELECTED REWARDS</div>
        ${selected.map((item, idx) => `
          <div class="reward-selected-row">
            <span class="reward-selected-num">${idx + 1}</span>
            <span class="reward-selected-icon">${item.icon || "📦"}</span>
            <span class="reward-selected-name">${item.name}${getBadge(item)}</span>
            <input type="number" min="1" value="${item.qty}" data-name="${item.name}" class="reward-qty-input"/>
            <button data-name="${item.name}" class="reward-remove-btn">✕</button>
          </div>`).join("")}`;
    }
    syncHidden();
    // Listeners
    selectedDiv.querySelectorAll(".reward-qty-input").forEach(input => {
      input.addEventListener("input", () => {
        const val = Math.max(1, parseInt(input.value) || 1);
        input.value = val;
        const item = selected.find(i => i.name === input.dataset.name);
        if (item) { item.qty = val; syncHidden(); }
      });
    });
    selectedDiv.querySelectorAll(".reward-remove-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        selected = selected.filter(i => i.name !== btn.dataset.name);
        updateSelectedDisplay();
        showCategory(currentCat); // refresh list to un-check
      });
    });
  }

  function showCategory(catKey) {
    currentCat = catKey;
    const query = searchQuery.toLowerCase();
    let items = ITEMS.filter(i => i.type === catKey);
    if (query) items = items.filter(i => i.name.toLowerCase().includes(query));

    if (!items.length) {
      listDiv.innerHTML = `<div style="color:var(--text-dim);font-size:0.82rem;padding:8px;font-style:italic">No items found.</div>`;
      return;
    }
    listDiv.innerHTML = items.map(item => {
      const isSelected = !!selected.find(s => s.name === item.name);
      return `<button class="reward-item-btn${isSelected ? ' selected' : ''}" data-name="${item.name}">
        ${item.icon || "📦"} ${item.name}${getBadge(item)}
        ${item.stats ? `<span class="reward-item-stat">${item.stats}</span>` : ""}
        ${isSelected ? `<span class="reward-item-check">✓</span>` : ""}
      </button>`;
    }).join("");

    listDiv.querySelectorAll(".reward-item-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.name;
        if (selected.find(i => i.name === name)) return; // already selected
        const item = ITEMS.find(i => i.name === name);
        selected.push({ ...item, qty: 1 });
        updateSelectedDisplay();
        showCategory(currentCat);
      });
    });
  }

  // Search
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    // Search across all categories if query exists
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const items = ITEMS.filter(i => i.name.toLowerCase().includes(query));
      listDiv.innerHTML = items.length
        ? items.map(item => {
            const isSelected = !!selected.find(s => s.name === item.name);
            return `<button class="reward-item-btn${isSelected ? ' selected' : ''}" data-name="${item.name}">
              ${item.icon || "📦"} ${item.name}${getBadge(item)}
              ${item.stats ? `<span class="reward-item-stat">${item.stats}</span>` : ""}
              ${isSelected ? `<span class="reward-item-check">✓</span>` : ""}
            </button>`;
          }).join("")
        : `<div style="color:var(--text-dim);font-size:0.82rem;padding:8px;font-style:italic">No items found.</div>`;
      listDiv.querySelectorAll(".reward-item-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const name = btn.dataset.name;
          if (selected.find(i => i.name === name)) return;
          const item = ITEMS.find(i => i.name === name);
          selected.push({ ...item, qty: 1 });
          updateSelectedDisplay();
          searchInput.dispatchEvent(new Event("input"));
        });
      });
    } else {
      showCategory(currentCat);
    }
  });

  // Tab switching
  picker.querySelectorAll(".reward-picker-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      picker.querySelectorAll(".reward-picker-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      searchQuery = "";
      searchInput.value = "";
      showCategory(tab.dataset.cat);
    });
  });

  showCategory(currentCat);
  updateSelectedDisplay();
}
// Faction quest reward picker — same logic, separate picker/hidden element IDs
function renderFactionQuestRewardPicker() {
  const picker = document.getElementById("fq-reward-picker");
  if (!picker) return;

  let selected = [];
  let currentCat = "weapon";
  let searchQuery = "";

  picker.innerHTML = `
    <div class="reward-picker-tabs">
      ${ITEM_CATEGORIES.map(cat => `<button class="reward-picker-tab${cat.key === currentCat ? ' active' : ''}" data-cat="${cat.key}">${cat.label}</button>`).join("")}
    </div>
    <input type="text" id="fq-reward-search" class="field-input" placeholder="🔍 Search items..." style="margin:8px 0;padding:6px 10px;font-size:0.82rem"/>
    <div class="reward-picker-list"></div>
    <div class="reward-picker-selected"></div>
  `;

  const listDiv     = picker.querySelector(".reward-picker-list");
  const selectedDiv = picker.querySelector(".reward-picker-selected");
  const searchInput = picker.querySelector("#fq-reward-search");

  function getBadge(item) {
    if (item.grade)  { const col = GRADE_COLORS[item.grade]  || "#aaa"; return `<span style="font-size:0.65rem;font-weight:700;padding:1px 5px;border-radius:3px;background:${col}22;color:${col};border:1px solid ${col}44;margin-left:4px">${item.grade}</span>`; }
    if (item.rarity) { const col = RARITY_COLORS[item.rarity]|| "#aaa"; return `<span style="font-size:0.65rem;font-weight:700;padding:1px 5px;border-radius:3px;background:${col}22;color:${col};border:1px solid ${col}44;margin-left:4px">${item.rarity}</span>`; }
    return "";
  }

  function syncHidden() {
    document.getElementById("fq-reward-items").value = selected.map(i => `${i.name}, ${i.qty}`).join("\n");
  }

  function updateSelectedDisplay() {
    if (!selected.length) {
      selectedDiv.innerHTML = `<div style="color:var(--text-dim);font-size:0.82rem;padding:6px 0;font-style:italic">No items selected yet.</div>`;
    } else {
      selectedDiv.innerHTML = `
        <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:6px;font-family:var(--ff-mono);letter-spacing:0.06em">SELECTED REWARDS</div>
        ${selected.map((item, idx) => `
          <div class="reward-selected-row">
            <span class="reward-selected-num">${idx + 1}</span>
            <span class="reward-selected-icon">${item.icon || "📦"}</span>
            <span class="reward-selected-name">${item.name}${getBadge(item)}</span>
            <input type="number" min="1" value="${item.qty}" data-name="${item.name}" class="reward-qty-input"/>
            <button data-name="${item.name}" class="reward-remove-btn">✕</button>
          </div>`).join("")}`;
    }
    syncHidden();
    selectedDiv.querySelectorAll(".reward-qty-input").forEach(input => {
      input.addEventListener("input", () => {
        const val = Math.max(1, parseInt(input.value) || 1);
        input.value = val;
        const item = selected.find(i => i.name === input.dataset.name);
        if (item) { item.qty = val; syncHidden(); }
      });
    });
    selectedDiv.querySelectorAll(".reward-remove-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        selected = selected.filter(i => i.name !== btn.dataset.name);
        updateSelectedDisplay();
        showCategory(currentCat);
      });
    });
  }

  function showCategory(catKey) {
    currentCat = catKey;
    const query = searchQuery.toLowerCase();
    let items = ITEMS.filter(i => i.type === catKey);
    if (query) items = items.filter(i => i.name.toLowerCase().includes(query));
    if (!items.length) { listDiv.innerHTML = `<div style="color:var(--text-dim);font-size:0.82rem;padding:8px;font-style:italic">No items found.</div>`; return; }
    listDiv.innerHTML = items.map(item => {
      const isSelected = !!selected.find(s => s.name === item.name);
      return `<button class="reward-item-btn${isSelected ? ' selected' : ''}" data-name="${item.name}">
        ${item.icon || "📦"} ${item.name}${getBadge(item)}
        ${item.stats ? `<span class="reward-item-stat">${item.stats}</span>` : ""}
        ${isSelected ? `<span class="reward-item-check">✓</span>` : ""}
      </button>`;
    }).join("");
    listDiv.querySelectorAll(".reward-item-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.name;
        if (selected.find(i => i.name === name)) return;
        const item = ITEMS.find(i => i.name === name);
        selected.push({ ...item, qty: 1 });
        updateSelectedDisplay();
        showCategory(currentCat);
      });
    });
  }

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const filtItems = ITEMS.filter(i => i.name.toLowerCase().includes(q));
      listDiv.innerHTML = filtItems.length
        ? filtItems.map(item => {
            const isSel = !!selected.find(s => s.name === item.name);
            return `<button class="reward-item-btn${isSel ? ' selected' : ''}" data-name="${item.name}">
              ${item.icon||"📦"} ${item.name}${getBadge(item)}
              ${item.stats ? `<span class="reward-item-stat">${item.stats}</span>` : ""}
              ${isSel ? `<span class="reward-item-check">✓</span>` : ""}
            </button>`;
          }).join("")
        : `<div style="color:var(--text-dim);font-size:0.82rem;padding:8px;font-style:italic">No items found.</div>`;
      listDiv.querySelectorAll(".reward-item-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const name = btn.dataset.name;
          if (selected.find(i => i.name === name)) return;
          const item = ITEMS.find(i => i.name === name);
          selected.push({ ...item, qty: 1 });
          updateSelectedDisplay();
          searchInput.dispatchEvent(new Event("input"));
        });
      });
    } else { showCategory(currentCat); }
  });

  picker.querySelectorAll(".reward-picker-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      picker.querySelectorAll(".reward-picker-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      searchQuery = ""; searchInput.value = "";
      showCategory(tab.dataset.cat);
    });
  });

  showCategory(currentCat);
  updateSelectedDisplay();
}

// Bestow item picker — same pattern as quest reward pickers
function renderBestowItemPicker() {
  const picker = document.getElementById("bestow-item-picker");
  if (!picker) return;

  let selected = [];
  let currentCat = "weapon";
  let searchQuery = "";

  picker.innerHTML = `
    <div class="reward-picker-tabs">
      ${ITEM_CATEGORIES.map(cat => `<button class="reward-picker-tab${cat.key === currentCat ? ' active' : ''}" data-cat="${cat.key}">${cat.label}</button>`).join("")}
    </div>
    <input type="text" id="bestow-item-search" class="field-input" placeholder="🔍 Search items..." style="margin:8px 0;padding:6px 10px;font-size:0.82rem"/>
    <div class="reward-picker-list"></div>
    <div class="reward-picker-selected"></div>
  `;

  const listDiv     = picker.querySelector(".reward-picker-list");
  const selectedDiv = picker.querySelector(".reward-picker-selected");
  const searchInput = picker.querySelector("#bestow-item-search");

  function getBadge(item) {
    if (item.grade)  { const col = GRADE_COLORS[item.grade]   || "#aaa"; return `<span style="font-size:0.65rem;font-weight:700;padding:1px 5px;border-radius:3px;background:${col}22;color:${col};border:1px solid ${col}44;margin-left:4px">${item.grade}</span>`; }
    if (item.rarity) { const col = RARITY_COLORS[item.rarity] || "#aaa"; return `<span style="font-size:0.65rem;font-weight:700;padding:1px 5px;border-radius:3px;background:${col}22;color:${col};border:1px solid ${col}44;margin-left:4px">${item.rarity}</span>`; }
    return "";
  }

  function syncHidden() {
    document.getElementById("bestow-items").value = selected.map(i => `${i.name}, ${i.qty}`).join("\n");
  }

  function updateSelectedDisplay() {
    if (!selected.length) {
      selectedDiv.innerHTML = `<div style="color:var(--text-dim);font-size:0.82rem;padding:6px 0;font-style:italic">No items selected yet.</div>`;
    } else {
      selectedDiv.innerHTML = `
        <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:6px;font-family:var(--ff-mono);letter-spacing:0.06em">SELECTED ITEMS</div>
        ${selected.map((item, idx) => `
          <div class="reward-selected-row">
            <span class="reward-selected-num">${idx + 1}</span>
            <span class="reward-selected-icon">${item.icon || "📦"}</span>
            <span class="reward-selected-name">${item.name}${getBadge(item)}</span>
            <input type="number" min="1" value="${item.qty}" data-name="${item.name}" class="reward-qty-input"/>
            <button data-name="${item.name}" class="reward-remove-btn">✕</button>
          </div>`).join("")}`;
    }
    syncHidden();
    selectedDiv.querySelectorAll(".reward-qty-input").forEach(input => {
      input.addEventListener("input", () => {
        const val = Math.max(1, parseInt(input.value) || 1);
        input.value = val;
        const item = selected.find(i => i.name === input.dataset.name);
        if (item) { item.qty = val; syncHidden(); }
      });
    });
    selectedDiv.querySelectorAll(".reward-remove-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        selected = selected.filter(i => i.name !== btn.dataset.name);
        updateSelectedDisplay();
        showCategory(currentCat);
      });
    });
  }

  function showCategory(catKey) {
    currentCat = catKey;
    const query = searchQuery.toLowerCase();
    let items = ITEMS.filter(i => i.type === catKey);
    if (query) items = items.filter(i => i.name.toLowerCase().includes(query));
    if (!items.length) {
      listDiv.innerHTML = `<div style="color:var(--text-dim);font-size:0.82rem;padding:8px;font-style:italic">No items found.</div>`;
      return;
    }
    listDiv.innerHTML = items.map(item => {
      const isSelected = !!selected.find(s => s.name === item.name);
      return `<button class="reward-item-btn${isSelected ? ' selected' : ''}" data-name="${item.name}">
        ${item.icon || "📦"} ${item.name}${getBadge(item)}
        ${item.stats ? `<span class="reward-item-stat">${item.stats}</span>` : ""}
        ${isSelected ? `<span class="reward-item-check">✓</span>` : ""}
      </button>`;
    }).join("");
    listDiv.querySelectorAll(".reward-item-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.name;
        if (selected.find(i => i.name === name)) return;
        const item = ITEMS.find(i => i.name === name);
        selected.push({ ...item, qty: 1 });
        updateSelectedDisplay();
        showCategory(currentCat);
      });
    });
  }

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const items = ITEMS.filter(i => i.name.toLowerCase().includes(query));
      listDiv.innerHTML = items.length
        ? items.map(item => {
            const isSelected = !!selected.find(s => s.name === item.name);
            return `<button class="reward-item-btn${isSelected ? ' selected' : ''}" data-name="${item.name}">
              ${item.icon || "📦"} ${item.name}${getBadge(item)}
              ${item.stats ? `<span class="reward-item-stat">${item.stats}</span>` : ""}
              ${isSelected ? `<span class="reward-item-check">✓</span>` : ""}
            </button>`;
          }).join("")
        : `<div style="color:var(--text-dim);font-size:0.82rem;padding:8px;font-style:italic">No items found.</div>`;
      listDiv.querySelectorAll(".reward-item-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const name = btn.dataset.name;
          if (selected.find(i => i.name === name)) return;
          const item = ITEMS.find(i => i.name === name);
          selected.push({ ...item, qty: 1 });
          updateSelectedDisplay();
          searchInput.dispatchEvent(new Event("input"));
        });
      });
    } else {
      showCategory(currentCat);
    }
  });

  picker.querySelectorAll(".reward-picker-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      picker.querySelectorAll(".reward-picker-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      searchQuery = "";
      searchInput.value = "";
      showCategory(tab.dataset.cat);
    });
  });

  showCategory(currentCat);
  updateSelectedDisplay();
}

// Render picker when quest modal opens
const origOpenDeityModal = window.openDeityModal;
window.openDeityModal = function(id) {
  origOpenDeityModal?.(id);
  if (id === "quest-modal")  setTimeout(renderQuestRewardPicker, 0);
  if (id === "bestow-modal") setTimeout(renderBestowItemPicker, 0);
};
// Also render faction quest picker when factions panel becomes visible
document.addEventListener("DOMContentLoaded", () => {
  const origSwitch = window.switchDeityPanel;
  if (origSwitch) {
    window.switchDeityPanel = function(panel) {
      origSwitch(panel);
      if (panel === "factions") setTimeout(renderFactionQuestRewardPicker, 0);
    };
  }
  // Also init on load in case factions is the active panel
  setTimeout(renderFactionQuestRewardPicker, 300);
});

import { auth, db, storage } from "../firebase/firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, getDocs, setDoc, collection, query, where,
  orderBy, limit, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref as storageRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const functions = getFunctions(undefined, "europe-west1");
const fnSendVision       = httpsCallable(functions, "sendDivineVision");
const fnBestowResources  = httpsCallable(functions, "bestowResources");
const fnCreateWorldEvent = httpsCallable(functions, "createWorldEvent");
const fnUpdateFaith      = httpsCallable(functions, "updateFaithLevel");

const DEITY_ART = {
  "Sah'run":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Fsah'run.jpeg?alt=media&token=a9ba07ac-26ad-405e-a773-3959a9dd5d9c",
  "Alistor":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Falistor.jpeg?alt=media&token=00925b01-6a3f-4844-a833-99aabd61ca45",
  "Elionidas": "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Felionidas.jpeg?alt=media&token=3076c6f2-1e25-4664-8a50-668c834b62f8",
  "Mah'run":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Fmah'run.jpeg?alt=media&token=7169560d-b36d-4009-9344-4703d5dca35b",
  "Freyja":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Ffreyja.jpeg?alt=media&token=434371f1-7d82-4d87-b7bb-4545fe37b5e6",
  "Arion":     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Farion.jpeg?alt=media&token=1fe0f371-aed9-4666-a02b-06cb10800af3",
  "Veil":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/deity-images%2Fveil.jpeg?alt=media&token=e7fcf690-c559-4337-9012-dff063db7742",
};

const DEITY_DATA = {
  "Sah'run":   { icon:"🔥", title:"God of Flames" },
  "Alistor":   { icon:"🌑", title:"God of Darkness" },
  "Elionidas": { icon:"🪙", title:"God of Abundance" },
  "Mah'run":   { icon:"⭐", title:"Goddess of Stars" },
  "Freyja":    { icon:"💗", title:"Goddess of Love" },
  "Arion":     { icon:"⚖️", title:"God of Justice" },
  "Veil":      { icon:"📖", title:"God of Knowledge" },
};

let _uid = null, _deityChar = null, _worshippers = [], _visionsSent = 0;

// ═══════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════
export async function initDeityDashboard() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "auth.html"; return; }
    _uid = user.uid;

    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (!userSnap.exists() || userSnap.data().role !== "deity") {
      window.location.href = "auth.html"; return;
    }

    const charSnap = await getDoc(doc(db, "characters", user.uid));
    if (charSnap.exists()) {
      _deityChar = charSnap.data();
      populateDeityInfo(_deityChar);
    }

    await loadWorshippers();
    loadActiveEvents();
    // Load World Development events for the new panel
    loadWorldDevelopmentEvents();
    // Restrict World Development creation to Alistor and Elionidas
    const deityName = _deityChar?.charClass || _deityChar?.deity;
    const worldDevBtn = document.getElementById('create-world-development-btn');
    const worldDevMsg = document.getElementById('world-development-not-worthy');
    if (worldDevBtn && worldDevMsg) {
      if (deityName === 'Alistor' || deityName === 'Elionidas') {
        worldDevBtn.style.display = '';
        worldDevMsg.style.display = 'none';
      } else {
        worldDevBtn.style.display = 'none';
        worldDevMsg.style.display = '';
      }
    }
    hideLoading();
    // Wire up modal open/close for world development
    window.openDeityModal = window.openDeityModal || function(id) {
      window._populateWorshipperSelects?.();
      ["vision","bestow","faith"].forEach(t => window._resetModalRecipient?.(t));
      document.getElementById(id).style.display = 'flex';
    };
    window.closeModal = window.closeModal || function(id) {
      document.getElementById(id).style.display = 'none';
    };
    window.doCreateWorldDevelopment = doCreateWorldDevelopment;
  }); // <-- close onAuthStateChanged callback
}

// Create World Development event
async function doCreateWorldDevelopment() {
  const btn = document.getElementById('add-development-btn');
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Adding Development...'; }
  const title = document.getElementById('worlddev-title')?.value.trim();
  let desc = document.getElementById('worlddev-desc')?.value.trim();
  // Store description with line breaks as \n (for later rendering as paragraphs)
  if (desc) desc = desc.replace(/\r\n|\r|\n/g, '\n');
  const location = document.getElementById('worlddev-location')?.value.trim();
  const errEl = document.getElementById('worlddev-error');
  errEl.textContent = '';
  if (!title) { if (btn) { btn.disabled = false; btn.textContent = origText; } errEl.textContent = 'Enter a title.'; return; }
  if (!desc)  { if (btn) { btn.disabled = false; btn.textContent = origText; } errEl.textContent = 'Enter a description.'; return; }
  try {
    await addDoc(collection(db, 'worldEvents'), {
      title,
      description: desc,
      location: location || null,
      createdBy: _deityChar?.charClass || _deityChar?.deity || 'Deity',
      deityUid: _uid,
      status: 'active',
      createdAt: serverTimestamp(),
      participants: []
    });
    document.getElementById('worlddev-title').value = '';
    document.getElementById('worlddev-desc').value = '';
    document.getElementById('worlddev-location').value = '';
    window.closeModal('worlddev-modal');
    window.showToast('World Development added!', 'success');
    loadWorldDevelopmentEvents();
  } catch(e) {
    errEl.textContent = e.message || 'Failed to add development.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// Load World Development events for the panel
function loadWorldDevelopmentEvents() {
  const listEl = document.getElementById('world-development-list');
  if (!listEl) return;
  const q = query(collection(db, 'worldEvents'), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(20));
  onSnapshot(q, snap => {
    if (snap.empty) {
      listEl.innerHTML = '<p style="color:var(--text-dim);font-style:italic;font-size:0.95rem">No world developments yet.</p>';
      return;
    }
    listEl.innerHTML = Array.from(snap.docs).map(d => {
      const e = d.data();
      // Render description with paragraph breaks
      const descHtml = (e.description||"").split(/\n+/).map(p => p ? `<p style='margin:0 0 8px 0'>${p}</p>` : '').join('');
      return `<div class="event-card">
        <div class="event-card-header">
          <div class="event-card-title">${e.title}</div>
          <span class="event-type-badge">World Development</span>
        </div>
        <div class="event-card-desc">${descHtml}</div>
        <div class="event-card-meta">
          <span>By ${e.createdBy||"—"}</span>
          ${e.location ? `<span>📍 ${e.location}</span>` : ''}
        </div>
        <button class="deity-mini-btn danger" onclick="window._deleteWorldDevEvent('${d.id}')">Delete</button>
      </div>`;
    }).join('');
  // Delete World Development event
  window._deleteWorldDevEvent = async function(id) {
    if (!confirm('Delete this World Development event? This cannot be undone.')) return;
    try {
      await deleteDoc(doc(db, 'worldEvents', id));
      window.showToast('World Development event deleted.', 'success');
    } catch(e) {
      window.showToast('Failed to delete event.', 'error');
    }
  };
  });

}

window._leaveWorld = async function() {
  try { await signOut(auth); } catch(e) { console.warn(e); }
  window.location.href = "../index.html";
};

window._sendVision                = sendVision;
window._doBestow                  = doBestow;
// window._doCreateEvent removed (World Events deprecated)
window._doUpdateFaith             = doUpdateFaith;
window._doDropQuest               = doDropQuest;
window._filterDeityQuests         = filterDeityQuests;
window._filterWorshippers         = filterWorshippers;
window._postFactionMission        = postFactionMission;
window._populateWorshipperSelects = populateWorshipperSelects;
window._onDeityPanelSwitch        = onDeityPanelSwitch;
window._loadDeityNpcs             = loadDeityNpcs;
window._openDeityNpcForm          = openDeityNpcForm;
window._switchDeityChat           = switchDeityChat;
// window._sendDeityChat is assigned to sendDeityChatPatched below (handles both tabs)
window._resetModalRecipient       = _resetModalRecipient;

function hideLoading() {
  const el = document.getElementById("loading");
  el?.classList.add("hidden");
  setTimeout(() => el?.remove(), 400);
}

// ═══════════════════════════════════════════════════
//  DEITY INFO
// ═══════════════════════════════════════════════════
function populateDeityInfo(char) {
  const deityName = char.charClass || char.deity || "Deity";
  const info  = DEITY_DATA[deityName] || {};
  const title = info.title || "God";

  // Custom avatar takes priority, then deity art, then emoji fallback
  const displayImg = char.avatarUrl || DEITY_ART[deityName] || info.icon || "✨";

  renderDeityAvatar(displayImg);
  window._deityAvatarCurrent = displayImg;

  set("deity-name",         deityName.toUpperCase());
  set("deity-title-display",title);
  set("deity-mobile-name",  deityName);
  set("deity-welcome",      `${info.icon||"✨"} ${deityName} watches over the Forge.`);
  set("ov-deity-name",      `${info.icon||"✨"} ${deityName}`);
  set("ov-deity-title",     title);
  set("ov-visions-sent",    "0");
}

function renderDeityAvatar(val) {
  const sigil = document.getElementById("deity-sigil-icon");
  if (!sigil) return;
  const isUrl = val?.startsWith("http") || val?.startsWith("data:");
  sigil.innerHTML = isUrl
    ? `<img src="${val}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
    : `<span style="font-size:1.4rem">${val}</span>`;
}

// ── Avatar helper used for any avatar value (URL or emoji) ──
function avatarHTML(val, size = "100%") {
  const isUrl = val?.startsWith("http") || val?.startsWith("data:");
  return isUrl
    ? `<img src="${val}" style="width:${size};height:${size};object-fit:cover;border-radius:50%"/>`
    : `<span>${val || "⚔️"}</span>`;
}

// ═══════════════════════════════════════════════════
//  WORSHIPPERS
// ═══════════════════════════════════════════════════
async function loadWorshippers() {
  try {
    const deityName = _deityChar?.charClass || _deityChar?.deity;
    if (!deityName) return;

    const snap = await getDocs(
      query(collection(db, "characters"), where("deity", "==", deityName))
    );

    _worshippers = [];
    snap.forEach(d => {
      if (d.id !== _uid) _worshippers.push({ uid: d.id, ...d.data() });
    });

    set("worshipper-count",    _worshippers.length);
    set("ov-worshipper-count", _worshippers.length);
    renderWorshippers(_worshippers);
  } catch(err) { console.error("Worshipper load error:", err); }
}

function renderWorshippers(list) {
  const container = document.getElementById("worshipper-list");
  if (!container) return;

  if (!list.length) {
    container.innerHTML = `<p style="color:var(--text-dim);font-style:italic;font-size:0.85rem">No worshippers yet.</p>`;
    return;
  }

  container.innerHTML = list.map(w => `
    <div class="worshipper-card">
      <div class="worshipper-avatar">${avatarHTML(w.avatarUrl)}</div>
      <div class="worshipper-info">
        <div class="worshipper-name">${w.name}</div>
        <div class="worshipper-meta">${w.rank||"Wanderer"} · Lv.${w.level||1} · ${w.charClass||"—"}</div>
        <div class="worshipper-location">📍 ${(w.kingdom||w.location||"Unknown").split("—")[0].trim()}</div>
      </div>
      <div class="worshipper-stats">
        <div class="worshipper-stat"><span class="worshipper-stat-label">Faith</span><span class="worshipper-stat-value faith">${w.faithLevel||0}</span></div>
        <div class="worshipper-stat"><span class="worshipper-stat-label">Gold</span><span class="worshipper-stat-value">${w.gold||0}</span></div>
        <div class="worshipper-stat"><span class="worshipper-stat-label">HP</span><span class="worshipper-stat-value">${w.hp||100}/${w.hpMax||100}</span></div>
      </div>
      <div class="worshipper-actions">
        <button class="deity-mini-btn" onclick="window._quickFaith('${w.uid}','${(w.name||"").replace(/'/g,"\\'")}')">✨ Faith</button>
      </div>
    </div>`).join("");

  window._quickVision = (uid, name) => _openModalForWorshipper("vision", uid, name);
  window._quickBestow = (uid, name) => _openModalForWorshipper("bestow", uid, name);
  window._quickFaith  = (uid, name) => _openModalForWorshipper("faith",  uid, name);
}

// Show modal pre-filled for a specific worshipper (from card buttons)
function _openModalForWorshipper(type, uid, name) {
  const modalId   = `${type}-modal`;
  const selectId  = `${type}-target`;
  const displayId = `${type}-target-display`;

  const sel     = document.getElementById(selectId);
  const display = document.getElementById(displayId);

  // Store uid in a data attribute — survives populateWorshipperSelects rebuilding the options
  if (sel) {
    sel.dataset.preselect = uid;
    sel.style.display = "none";
  }
  if (display) {
    display.innerHTML = `<span class="modal-recipient-name">${name}</span>`;
    display.style.display = "flex";
  }
  document.getElementById(modalId).style.display = "flex";
}

// Reset recipient field back to dropdown (called when opening from overview/Quick Actions)
function _resetModalRecipient(type) {
  const sel     = document.getElementById(`${type}-target`);
  const display = document.getElementById(`${type}-target-display`);
  if (sel)     { sel.value = ""; sel.style.display = ""; delete sel.dataset.preselect; }
  if (display) { display.style.display = "none"; display.innerHTML = ""; }
}

function filterWorshippers(q) {
  renderWorshippers(_worshippers.filter(w => w.name?.toLowerCase().includes(q.toLowerCase())));
}

function populateWorshipperSelects() {
  ["vision-target","bestow-target","faith-target"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const preselect = sel.dataset.preselect || sel.value;
    sel.innerHTML = `<option value="">Select a worshipper...</option>` + _worshippers.map(w => `<option value="${w.uid}">${w.name}</option>`).join("");

    ["ov-events-list","events-list"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  });

  window._endEvent = async id => {
    try {
      await updateDoc(doc(db, "worldEvents", id), { status: "ended" });
      window.showToast("Event ended.", "success");
    } catch(e) { window.showToast("Failed to end event.", "error"); }
  };
}

// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
//  WORLD EVENTS
// ═══════════════════════════════════════════════════
function loadActiveEvents() {
  const q = query(collection(db, "worldEvents"), where("status","==","active"), orderBy("createdAt","desc"), limit(10));
  onSnapshot(q, snap => {
    set("ov-event-count", snap.size);
    const html = snap.empty
      ? `<p style="color:var(--text-dim);font-style:italic;font-size:0.85rem">No active events.</p>`
      : snap.docs.map(d => {
          const e = d.data();
          const exp = e.expiresAt?.toDate?.();
          return `
            <div class="event-card">
              <div class="event-card-header">
                <div class="event-card-title">${e.title}</div>
                <span class="event-type-badge">${(e.type||"event").replace("_"," ")}</span>
              </div>
              <div class="event-card-desc">${e.description||""}</div>
              <div class="event-card-meta">
                <span>By ${e.createdBy||"—"}</span>
                <span>${exp ? "Expires "+exp.toLocaleDateString() : "No expiry"}</span>
                <span>${e.participants?.length||0} participants</span>
              </div>
              <button class="deity-mini-btn danger" onclick="window._endEvent('${d.id}')">End Event</button>
            </div>`;
        }).join("");

    ["ov-events-list","events-list"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  });

  window._endEvent = async id => {
    try {
      await updateDoc(doc(db, "worldEvents", id), { status: "ended" });
      window.showToast("Event ended.", "success");
    } catch(e) { window.showToast("Failed to end event.", "error"); }
  };
}

//  PANEL SWITCH
// ═══════════════════════════════════════════════════
function onDeityPanelSwitch(name) {
  if (name === "worshippers") loadWorshippers();
  if (name === "visions")     loadVisionHistory();
  if (name === "factions")    loadFactionMissions();
  if (name === "quests")      loadDeityQuests();
  if (name === "npcs")        initDeityNpcPanel();
  if (name === "chat")        initDeityChat();
  if (name === "raids")       initDeityRaids();
}

// ═══════════════════════════════════════════════════
//  SEND VISION
// ═══════════════════════════════════════════════════
function _getTargetUid(type) {
  const sel = document.getElementById(`${type}-target`);
  if (!sel) return "";
  // If opened from worshipper card, uid is in dataset.preselect
  return sel.dataset.preselect || sel.value;
}

async function sendVision(visionType) {
  const targetUid = _getTargetUid("vision");
  const message   = document.getElementById("vision-message")?.value.trim();
  const errEl     = document.getElementById("vision-error");
  errEl.textContent = "";
  if (!targetUid) { errEl.textContent = "Select a worshipper."; return; }
  if (!message)   { errEl.textContent = "Write a message.";     return; }
  const btn = document.querySelector("#vision-modal .btn-primary");
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Sending Vision..."; }
  try {
    await fnSendVision({ targetUid, message, type: visionType });
    _visionsSent++;
    set("ov-visions-sent", _visionsSent);
    document.getElementById("vision-message").value = "";
    document.getElementById("vision-modal").style.display = "none";
    window.showToast("Divine vision sent!", "success");
    loadVisionHistory();
  } catch(err) {
    errEl.textContent = err.message || "Failed.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

async function loadVisionHistory() {
  const container = document.getElementById("vision-history");
  if (!container) return;
  container.innerHTML = `<p style="color:var(--text-dim);font-style:italic">Loading...</p>`;
  try {
    let all = [];
    for (const w of _worshippers.slice(0,10)) {
      const snap = await getDocs(
        query(collection(db,"divineVisions",w.uid,"messages"), orderBy("sentAt","desc"), limit(5))
      );
      snap.forEach(d => { const data = d.data(); if (!data.deityUid || data.deityUid === _uid) all.push({ ...data, recipientName: w.name }); });
    }
    all.sort((a,b) => (b.sentAt?.toMillis?.() || 0) - (a.sentAt?.toMillis?.() || 0));
    if (!all.length) { container.innerHTML = `<p style="color:var(--text-dim);font-style:italic">No visions sent yet.</p>`; return; }
    container.innerHTML = all.map(v => `
      <div class="vision-history-item">
        <div class="vision-history-header">
          <span class="vision-type-pill ${v.type||'knowledge'}">${v.type||"knowledge"}</span>
          <span class="vision-recipient">→ ${v.recipientName||"—"}</span>
          <span class="vision-time">${v.sentAt?.toDate?.()?.toLocaleDateString()||"—"}</span>
        </div>
        <div class="vision-message-text">${v.message||""}</div>
      </div>`).join("");
  } catch(e) { console.error('loadVisionHistory error:', e); container.innerHTML = `<p style="color:var(--text-dim)">Failed to load: ${e.message}</p>`; }
}

// ═══════════════════════════════════════════════════
//  BESTOW
// ═══════════════════════════════════════════════════
async function doBestow() {
  const targetUid = _getTargetUid("bestow");
  const gold      = parseInt(document.getElementById("bestow-gold")?.value) || 0;
  const itemsRaw  = document.getElementById("bestow-items")?.value.trim();
  const errEl     = document.getElementById("bestow-error");
  errEl.textContent = "";
  if (!targetUid) { errEl.textContent = "Select a worshipper."; return; }

  const items = [];
  if (itemsRaw) {
    for (const line of itemsRaw.split("\n")) {
      const p = line.split(",").map(x => x.trim());
      if (p.length >= 2 && p[0] && parseInt(p[1]) > 0) {
        items.push({ name: p[0], icon:"📦", type:"material", qty: parseInt(p[1]) });
      }
    }
  }
  if (gold === 0 && !items.length) { errEl.textContent = "Enter gold or items to bestow."; return; }

  const btn = document.querySelector("#bestow-modal .btn-primary");
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Bestowing..."; }
  try {
    await fnBestowResources({ targetUid, items, gold });
    const w = _worshippers.find(x => x.uid === targetUid);
    document.getElementById("bestow-modal").style.display = "none";
    document.getElementById("bestow-gold").value  = "0";
    document.getElementById("bestow-items").value = "";
    document.getElementById("bestow-item-picker").innerHTML = "";

    const logEl = document.getElementById("bestow-log");
    if (logEl) {
      const entry = document.createElement("div");
      entry.className = "bestow-log-entry";
      entry.innerHTML = `<span class="bestow-log-name">→ ${w?.name||"—"}</span><span class="bestow-log-detail">${gold>0?gold+" gold ":""}${items.map(i=>i.qty+"x "+i.name).join(", ")}</span><span class="bestow-log-time">${new Date().toLocaleTimeString()}</span>`;
      logEl.appendChild(entry);
    }

    window.showToast("Resources bestowed!", "success");
    loadWorshippers();
  } catch(err) {
    errEl.textContent = err.message || "Failed.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// ═══════════════════════════════════════════════════
//  CREATE EVENT
// ═══════════════════════════════════════════════════
// doCreateEvent and event-modal logic removed (World Events deprecated)

// ═══════════════════════════════════════════════════
//  UPDATE FAITH
// ═══════════════════════════════════════════════════
async function doUpdateFaith() {
  const targetUid = _getTargetUid("faith");
  const amount    = parseInt(document.getElementById("faith-amount")?.value) || 0;
  const errEl     = document.getElementById("faith-error");
  errEl.textContent = "";
  if (!targetUid) { errEl.textContent = "Select a worshipper.";    return; }
  if (!amount)    { errEl.textContent = "Enter a non-zero amount."; return; }
  const btn = document.querySelector("#faith-modal .btn-primary");
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Updating Faith..."; }
  try {
    const result = await fnUpdateFaith({ targetUid, amount });
    document.getElementById("faith-modal").style.display = "none";
    window.showToast(`Faith updated to ${result.data.newFaith}.`, "success");
    loadWorshippers();
  } catch(err) {
    errEl.textContent = err.message || "Failed.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// ═══════════════════════════════════════════════════
//  FACTION MISSIONS
// ═══════════════════════════════════════════════════

// Helper: get faction leader name for a given faction
async function _getFactionLeaderName(faction) {
  try {
    const q = query(collection(db, 'factionLeaders'), where('faction', '==', faction));
    const snap = await getDocs(q);
    if (!snap.empty) return snap.docs[0].data().leaderName || faction;
  } catch(e) { console.warn('_getFactionLeaderName:', e); }
  return faction; // fallback to faction name
}

// Helper: get all member UIDs of a faction
async function _getFactionMemberUids(faction) {
  try {
    const q = query(collection(db, 'characters'), where('faction', '==', faction));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.id);
  } catch(e) { console.warn('_getFactionMemberUids:', e); return []; }
}

async function postFactionMission() {
  const faction  = document.getElementById("faction-quest-faction")?.value;
  const title    = document.getElementById("fq-title")?.value.trim();
  const desc     = document.getElementById("fq-desc")?.value.trim();
  const gold     = parseInt(document.getElementById("fq-reward-gold")?.value) || 0;
  const exp      = parseInt(document.getElementById("fq-reward-exp")?.value) || 0;
  const itemsRaw       = document.getElementById("fq-reward-items")?.value.trim();
  const completionType = document.getElementById("fq-completion-type")?.value || "open";
  const errEl    = document.getElementById("faction-quest-error");
  const btn      = document.querySelector("button[onclick='doPostFactionQuest()']");
  const origText = btn?.textContent;
  errEl.textContent = "";
  if (!faction) { errEl.textContent = "No faction selected or claimed."; return; }
  if (!title)   { errEl.textContent = "Enter a title."; return; }
  // Parse items
  const rewardItems = [];
  if (itemsRaw) {
    for (const line of itemsRaw.split("\n")) {
      const p = line.split(",").map(x => x.trim());
      if (p[0] && parseInt(p[1]) > 0) rewardItems.push({ name: p[0], qty: parseInt(p[1]) });
    }
  }
  if (btn) { btn.disabled = true; btn.textContent = "Posting Quest..."; }
  try {
    const leaderName = await _getFactionLeaderName(faction);
    await addDoc(collection(db, "factionMissions"), {
      faction,
      title,
      description: desc,
      reward: { gold, exp, items: rewardItems },
      postedBy: leaderName,
      deityUid: _uid,
      status: "active",
      completionType,
      completedBy: [],
      createdAt: serverTimestamp(),
    });
    // Notify all faction members — appears to come from leader
    const memberUids = await _getFactionMemberUids(faction);
    await Promise.all(memberUids.map(uid => addDoc(collection(db, 'notifications'), {
      uid,
      from: leaderName,
      message: `📋 <b>New Faction Quest:</b> <b>${title}</b> has been posted by <b>${leaderName}</b>.${desc ? ` <em>${desc.slice(0,80)}${desc.length>80?"…":""}</em>` : ""}`,
      read: false,
      timestamp: serverTimestamp(),
    })));
    ["fq-title","fq-desc","fq-reward-gold","fq-reward-exp","fq-reward-items","fq-completion-type"].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = "";
    });
    window.showToast(`Quest posted to ${faction}!`, "success");
    loadFactionMissions();
  } catch(err) {
    errEl.textContent = err.message || "Failed.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// Alias so the HTML button onclick="doPostFactionQuest()" works
function doPostFactionQuest() { postFactionMission(); }
window.doPostFactionQuest = doPostFactionQuest;

// Toggle faction quest post form collapse
window.toggleFqPostForm = function() {
  const body  = document.getElementById("fq-post-body");
  const arrow = document.getElementById("fq-post-arrow");
  if (!body) return;
  const open = body.style.display !== "none";
  body.style.display = open ? "none" : "";
  if (arrow) arrow.textContent = open ? "▶" : "▼";
};

// ── Faction Quest Submissions — helpers (top-level, always available) ──

// Render submissions list for a single faction quest
window._renderFactionSubmissionsFor = function(q) {
  const subs = q._submissions || [];
  if (!subs.length) return `<div class="dq-sub-empty">No submissions yet.</div>`;
  return subs.map(s => {
    const ts = s.submittedAt?.toDate ? s.submittedAt.toDate().toLocaleString() : '—';
    const statusColor = { pending: '#c9a84c', approved: '#7ec87e', rejected: '#c08080' }[s.status] || '#888';
    const proof = s.proof || {};
    const actSnap = s.activitySnapshot || [];
    return `<div class="dq-sub-item" id="dqsubitem-fq-${s.id}">
      <div class="dq-sub-player">
        <span class="dq-sub-name">${s.playerName || '?'}</span>
        <span class="dq-sub-rank">${s.playerRank || ''}</span>
        <span class="dq-sub-status" style="color:${statusColor}">${s.status.toUpperCase()}</span>
      </div>
      <div class="dq-sub-time">Submitted: ${ts}</div>

      ${proof.location ? `<div class="dq-sub-proof-row">📍 <b>Where:</b> ${proof.location}</div>` : ''}
      ${proof.what     ? `<div class="dq-sub-proof-row">⚔️ <b>What:</b> ${proof.what}</div>` : ''}
      ${proof.witnesses ? `<div class="dq-sub-proof-row">👥 <b>Witnesses:</b> ${proof.witnesses}</div>` : ''}

      ${actSnap.length ? `
      <div class="dq-sub-activity-toggle" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
        📋 Activity Snapshot (${actSnap.length} events) ▾
      </div>
      <div class="dq-sub-activity-list" style="display:none">
        ${actSnap.map(e => `<div class="dq-sub-activity-item">${e}</div>`).join('')}
      </div>` : '<div class="dq-sub-proof-row" style="color:var(--text-dim);font-style:italic">No activity snapshot available.</div>'}

      ${s.status === 'pending' ? `
      <div class="dq-sub-actions">
        <button class="deity-mini-btn success" onclick="window._approveFactionSubmission('${s.id}','${q.id}')">✓ Approve</button>
        <button class="deity-mini-btn danger"  onclick="window._rejectFactionSubmission('${s.id}')">✕ Reject</button>
        <button class="deity-mini-btn punish"  onclick="window._openPunishModal('${s.uid||s.id}','${(s.playerName||'?').replace(/'/g,"\'")}')">⚖️ Punish</button>
      </div>` : `
      <div class="dq-sub-actions" style="margin-top:6px">
        <button class="deity-mini-btn punish" onclick="window._openPunishModal('${s.uid||s.id}','${(s.playerName||'?').replace(/'/g,"\'")}')">⚖️ Punish</button>
      </div>`}
    </div>`;
  }).join('');
};

// Toggle submissions panel open/close for faction quests
window._toggleFactionSubmissions = function(questId) {
  const list = document.getElementById(`dqsub-fq-${questId}`);
  const chev = document.getElementById(`dqchev-fq-${questId}`);
  if (!list) return;
  const isOpen = list.style.display !== 'none';
  list.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.textContent = isOpen ? '▾' : '▴';
};

// Approve a faction quest submission
window._approveFactionSubmission = async function(subId, questId) {
  try {
    const quest = window._deityFactionQuests.find(q => q.id === questId);
    if (!quest) return;
    const sub = quest._submissions?.find(s => s.id === subId);
    if (!sub) return;

    await updateDoc(doc(db, 'factionQuestSubmissions', subId), { status: 'approved' });

    // For one-time quests: stamp completedBy so other players get locked out
    if (quest.completionType === 'one_time') {
      try {
        await updateDoc(doc(db, 'factionMissions', quest.id), {
          completedBy: arrayUnion({
            uid: sub.uid,
            playerName: sub.playerName || '?',
            completedAt: new Date()
          })
        });
      } catch (e) {
        console.warn('Could not stamp completedBy on factionMission:', e);
      }
    }

    // Notify the player — from faction leader, not deity
    const leaderNameApprove = await _getFactionLeaderName(quest.faction || "");
    await addDoc(collection(db, 'notifications'), {
      uid: sub.uid,
      from: leaderNameApprove,
      message: `✅ <b>Faction Quest Approved:</b> Your submission for <b>${quest.title}</b> has been approved by <b>${leaderNameApprove}</b>! Your reward has been granted.`,
      read: false,
      timestamp: serverTimestamp(),
    });

    window.showToast(`✓ Approved ${sub.playerName}'s submission.`, 'success');
    loadFactionMissions();
  } catch(e) {
    console.error('Approve failed:', e);
    window.showToast('Failed to approve.', 'error');
  }
};

// Reject a faction quest submission
window._rejectFactionSubmission = async function(subId) {
  // Look up uid and title from cached data — avoids passing unsafe strings through HTML onclick
  let playerUid = '', questTitle = '';
  for (const q of (window._deityFactionQuests || [])) {
    const sub = (q._submissions || []).find(s => s.id === subId);
    if (sub) { playerUid = sub.uid; questTitle = q.title; break; }
  }
  showRejectModal(questTitle, async (reason) => {
    try {
      // Get faction from cached quest data
      const factionQuestForReject = (window._deityFactionQuests||[]).find(q => (q._submissions||[]).some(s => s.id === subId));
      const leaderNameReject = await _getFactionLeaderName(factionQuestForReject?.faction || "");
      await updateDoc(doc(db, 'factionQuestSubmissions', subId), { status: 'rejected' });
      await addDoc(collection(db, 'notifications'), {
        uid: playerUid,
        from: leaderNameReject,
        message: `✕ <b>Faction Quest Rejected:</b> Your submission for <b>${questTitle}</b> was not approved by <b>${leaderNameReject}</b>.${reason ? ` Reason: <em>${reason}</em>` : ''} You may resubmit once the objectives are met.`,
        read: false,
        timestamp: serverTimestamp(),
      });
      window.showToast('Submission rejected. Player notified.', 'info');
      loadFactionMissions();
    } catch(e) {
      console.error('Reject failed:', e);
      window.showToast('Failed to reject.', 'error');
    }
  });
};

// Load submissions for all active faction quests and attach to quest objects,
// then set up a live onSnapshot listener — mirrors _loadDeityQuestSubmissions exactly.
window._loadFactionQuestSubmissions = async function() {
  const quests = window._deityFactionQuests || [];
  if (!quests.length) { renderFactionMissions(); return; }
  const questIds = quests.map(q => q.id);
  // Firestore 'in' supports up to 30 values; chunk if needed
  const chunks = [];
  for (let i = 0; i < questIds.length; i += 30) chunks.push(questIds.slice(i, i + 30));
  const allSubs = [];
  for (const chunk of chunks) {
    const subSnap = await getDocs(query(collection(db, 'factionQuestSubmissions'), where('questId', 'in', chunk)));
    subSnap.forEach(d => allSubs.push({ id: d.id, ...d.data() }));
  }
  quests.forEach(q => {
    q._submissions = allSubs.filter(s => s.questId === q.id)
      .sort((a, b) => (b.submittedAt?.toMillis?.() || 0) - (a.submittedAt?.toMillis?.() || 0));
  });
  // Live listener for new submissions (first chunk of 30 max)
  if (window._factionSubUnsub) window._factionSubUnsub();
  const allQ = query(collection(db, 'factionQuestSubmissions'), where('questId', 'in', questIds.slice(0, 30)));
  window._factionSubUnsub = onSnapshot(allQ, snap => {
    const live = [];
    snap.forEach(d => live.push({ id: d.id, ...d.data() }));
    (window._deityFactionQuests || []).forEach(q => {
      q._submissions = live.filter(s => s.questId === q.id)
        .sort((a, b) => (b.submittedAt?.toMillis?.() || 0) - (a.submittedAt?.toMillis?.() || 0));
    });
    renderFactionMissions();
  });
  renderFactionMissions();
};

// Separated render function (called after submissions are loaded)
function renderFactionMissions() {
  const activeEl = document.getElementById("faction-quests-active");
  const doneEl   = document.getElementById("faction-quests-done");
  if (!activeEl && !doneEl) return;
  const all    = window._deityFactionQuests || [];
  const active = all.filter(m => m.status === "active");
  const done   = all.filter(m => m.status !== "active");

  function buildRewardTag(m) {
    if (!m.reward) return "—";
    const parts = [];
    if (m.reward.gold) parts.push(`🪙 ${m.reward.gold} gold`);
    if (m.reward.exp)  parts.push(`✨ ${m.reward.exp} exp`);
    if (Array.isArray(m.reward.items) && m.reward.items.length)
      parts.push(`🎁 ${m.reward.items.map(i => `${i.qty}x ${i.name}`).join(", ")}`);
    return parts.length ? parts.join(" · ") : "—";
  }

  function buildCard(m) {
    const descHtml  = (m.description||"").split(/\n+/).map(p => p ? `<p style="margin:0 0 6px 0">${p}</p>` : "").join("");
    const rewardStr = buildRewardTag(m);
    const isActive  = m.status === "active";
    const pendingCount = (m._submissions || []).filter(s => s.status === 'pending').length;
    const submissionsBadge = pendingCount > 0
      ? `<span class="dq-submissions-badge">${pendingCount} pending</span>`
      : '';
    const ctypeBadge = m.completionType === "one_time"
      ? `<span class="quest-type-badge" style="background:rgba(160,60,60,0.25);color:#e09090">🔒 One-time</span>`
      : `<span class="quest-type-badge" style="background:rgba(60,120,60,0.25);color:#90c090">♻️ Open</span>`;
    const submissionsPanel = isActive ? `
      <div class="dq-submissions-panel">
        <div class="dq-submissions-title" onclick="window._toggleFactionSubmissions('${m.id}')">
          👥 Player Submissions <span class="dq-sub-chevron" id="dqchev-fq-${m.id}">▾</span>
        </div>
        <div class="dq-submissions-list" id="dqsub-fq-${m.id}" style="display:none">
          ${window._renderFactionSubmissionsFor(m)}
        </div>
      </div>` : '';
    return `
    <div class="quest-card">
      <div class="quest-card-header">
        <span class="quest-type-badge">🛡️ Faction</span>
        ${ctypeBadge}
        <span class="quest-assigned-to">→ ${m.faction}</span>
        ${!isActive ? `<span class="quest-status-badge ${m.status}">${m.status}</span>` : ""}
        ${submissionsBadge}
      </div>
      <div class="quest-card-title">${m.title}</div>
      <div class="quest-card-desc">${descHtml}</div>
      <div class="quest-card-footer">
        <span class="quest-reward-tag">${rewardStr}</span>
        ${isActive ? `<button class="deity-mini-btn danger" onclick="window._endFactionQuest('${m.id}')">End Quest</button>` : ""}
      </div>
      ${submissionsPanel}
    </div>`;
  }

  if (activeEl) activeEl.innerHTML = active.length
    ? active.map(buildCard).join("")
    : `<p style="color:var(--text-dim);font-style:italic;font-size:0.85rem">No active quests.</p>`;

  if (doneEl) doneEl.innerHTML = done.length
    ? done.map(buildCard).join("")
    : `<p style="color:var(--text-dim);font-style:italic;font-size:0.85rem">None yet.</p>`;
}

// Load faction missions: fetch quests first, then await submissions, then render
async function loadFactionMissions() {
  try {
    const snap = await getDocs(
      query(collection(db,"factionMissions"), orderBy("createdAt","desc"), limit(100))
    );
    window._deityFactionQuests = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(m => m.deityUid === _uid);
    await window._loadFactionQuestSubmissions();
  } catch(e) { console.error(e); }
}

window._endFactionQuest = async function(id) {
  try {
    await updateDoc(doc(db, "factionMissions", id), { status: "ended" });
    window.showToast("Faction quest ended.", "success");
    loadFactionMissions();
  } catch(e) { window.showToast("Failed to end quest.", "error"); }
};

// ── Helper ────────────────────────────────────────────────────
function set(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }

// ═══════════════════════════════════════════════════
//  QUEST SYSTEM
// ═══════════════════════════════════════════════════
let _deityQuests = [];
let _questFilter = "all";

async function doDropQuest(questType) {
  const title     = document.getElementById("quest-title")?.value.trim();
  const desc      = document.getElementById("quest-desc")?.value.trim();
  const objRaw    = document.getElementById("quest-objectives")?.value.trim();
  const gold      = parseInt(document.getElementById("quest-reward-gold")?.value) || 0;
  const exp       = parseInt(document.getElementById("quest-reward-exp")?.value) || 0;
  const itemsRaw  = document.getElementById("quest-reward-items")?.value.trim();
  const targetUid = null; // story quests are always public
  const expiresIn = parseInt(document.getElementById("quest-expires")?.value) || null;
  const errEl     = document.getElementById("quest-error");
  const btn       = document.querySelector("#quest-modal .btn-primary");
  const origText  = btn?.textContent;
  errEl.textContent = "";

  if (!title) { errEl.textContent = "Enter a quest title."; return; }
  if (!desc)  { errEl.textContent = "Write the quest description."; return; }

  const objectives = objRaw ? objRaw.split("\n").map(s => s.trim()).filter(Boolean) : [];
  const rewardItems = [];
  if (itemsRaw) {
    for (const line of itemsRaw.split("\n")) {
      const p = line.split(",").map(x => x.trim());
      if (p[0] && parseInt(p[1]) > 0) rewardItems.push({ name: p[0], qty: parseInt(p[1]) });
    }
  }

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 3600000) : null;
  const deityName = _deityChar?.charClass || _deityChar?.deity || "Deity";
  const completionType = document.getElementById("quest-completion-type")?.value || "open";

  if (btn) { btn.disabled = true; btn.textContent = "Dropping Quest..."; }
  try {
    await addDoc(collection(db, "storyQuests"), {
      type:           questType,
      title,
      description:    desc,
      objectives,
      reward:         { gold, exp, items: rewardItems },
      assignedTo:     targetUid,
      deityUid:       _uid,
      deityName,
      status:         "active",
      completionType, // "open" | "one_time"
      completedBy:    [],
      expiresAt:      expiresAt || null,
      createdAt:      serverTimestamp(),
    });

    // Clear form
    ["quest-title","quest-desc","quest-objectives","quest-reward-gold",
     "quest-reward-exp","quest-reward-items","quest-expires"].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = "";
    });
    document.getElementById("quest-modal").style.display = "none";
    window.showToast(`Quest "${title}" dropped into the world!`, "success");
    loadDeityQuests();
  } catch(e) {
    errEl.textContent = e.message || "Failed to create quest.";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

window._setCompletionType = function(type) {
  document.getElementById("quest-completion-type").value = type;
  document.getElementById("ctype-open").classList.toggle("active", type === "open");
  document.getElementById("ctype-onetime").classList.toggle("active", type === "one_time");
};

async function loadDeityQuests() {
  try {
    const snap = await getDocs(
      query(collection(db, "storyQuests"), orderBy("createdAt","desc"), limit(100))
    );
    _deityQuests = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(q => q.deityUid === _uid);
    await window._loadDeityQuestSubmissions();
  } catch(e) { console.error("loadDeityQuests:", e); }
}

function filterDeityQuests(type) {
  _questFilter = type;
  renderDeityQuests();
}

function renderDeityQuests() {
  const filtered = _deityQuests.filter(q => q.type === "story");
  const active   = filtered.filter(q => q.status === "active");
  const done     = filtered.filter(q => q.status !== "active");

  const renderList = (list, container) => {
    const el = document.getElementById(container);
    if (!el) return;
    if (!list.length) { el.innerHTML = `<p style="color:var(--text-dim);font-style:italic;font-size:0.85rem">None.</p>`; return; }
    el.innerHTML = list.map(q => {
      const typeIcon = "📖";
      const completedCount = q.completedBy?.length || 0;
      const assignLabel = q.assignedTo
        ? (_worshippers.find(w => w.uid === q.assignedTo)?.name || "Specific Player")
        : "All Players";
      const descHtml = (q.description || "").split(/\n+/).map(p => p ? `<p style='margin:0 0 6px 0'>${p}</p>` : '').join('');
      const rewardItems = Array.isArray(q.reward?.items) && q.reward.items.length
        ? ` · 🎁 ${q.reward.items.map(i => `${i.qty}x ${i.name}`).join(", ")}`
        : "";
      const pendingCount = (q._submissions || []).filter(s => s.status === 'pending').length;
      const submissionsBadge = pendingCount > 0
        ? `<span class="dq-submissions-badge">${pendingCount} pending</span>`
        : '';
      const completionBadge = q.completionType === "one_time"
        ? `<span class="quest-onetime-badge">🔒 One-Time</span>`
        : `<span class="quest-onetime-badge open">🌍 Open</span>`;
      return `
      <div class="quest-card" id="qcard-${q.id}">
        <div class="quest-card-header">
          <span class="quest-type-badge">${typeIcon} Story</span>
          <span class="quest-assigned-to">→ ${assignLabel}</span>
          ${completionBadge}
          ${q.status !== "active" ? `<span class="quest-status-badge ${q.status}">${q.status}</span>` : ""}
          ${submissionsBadge}
        </div>
        <div class="quest-card-title">${q.title}</div>
        <div class="quest-card-desc">${descHtml}</div>
        ${q.objectives?.length ? `<div class="quest-objectives">${q.objectives.map(o=>`<div class="quest-obj">• ${o}</div>`).join("")}</div>` : ""}
        <div class="quest-card-footer">
          <span class="quest-reward-tag">🪙 ${q.reward?.gold||0} gold · ✨ ${q.reward?.exp||0} exp${rewardItems}</span>
          <span class="quest-completions">${completedCount} completion${completedCount!==1?"s": ""}</span>
          ${q.status === "active" ? `<button class="deity-mini-btn danger" onclick="window._endQuest('${q.id}')">End Quest</button>` : ""}
        </div>

        <!-- Submissions panel -->
        <div class="dq-submissions-panel">
          <div class="dq-submissions-title" onclick="window._toggleSubmissions('${q.id}')">
            👥 Player Submissions <span class="dq-sub-chevron" id="dqchev-${q.id}">▾</span>
          </div>
          <div class="dq-submissions-list" id="dqsub-${q.id}" style="display:none">
            ${window._renderSubmissionsFor(q)}
          </div>
        </div>
      </div>`;
    }).join("");
  };

  renderList(active, "deity-quests-active");
  renderList(done,   "deity-quests-done");
}

// Toggle submissions panel open/close
window._toggleSubmissions = function(questId) {
  const list = document.getElementById(`dqsub-${questId}`);
  const chev = document.getElementById(`dqchev-${questId}`);
  if (!list) return;
  const isOpen = list.style.display !== 'none';
  list.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.textContent = isOpen ? '▾' : '▴';
};

// Render submissions list for a single quest
window._renderSubmissionsFor = function(q) {
  const subs = q._submissions || [];
  if (!subs.length) return `<div class="dq-sub-empty">No submissions yet.</div>`;
  return subs.map(s => {
    const ts = s.submittedAt?.toDate ? s.submittedAt.toDate().toLocaleString() : '—';
    const statusColor = { pending: '#c9a84c', approved: '#7ec87e', rejected: '#c08080' }[s.status] || '#888';
    const proof = s.proof || {};
    const actSnap = s.activitySnapshot || [];
    return `<div class="dq-sub-item" id="dqsubitem-${s.id}">
      <div class="dq-sub-player">
        <span class="dq-sub-name">${s.playerName || '?'}</span>
        <span class="dq-sub-rank">${s.playerRank || ''}</span>
        <span class="dq-sub-status" style="color:${statusColor}">${s.status.toUpperCase()}</span>
      </div>
      <div class="dq-sub-time">Submitted: ${ts}</div>

      ${proof.location ? `<div class="dq-sub-proof-row">📍 <b>Where:</b> ${proof.location}</div>` : ''}
      ${proof.what     ? `<div class="dq-sub-proof-row">⚔️ <b>What:</b> ${proof.what}</div>` : ''}
      ${proof.witnesses ? `<div class="dq-sub-proof-row">👥 <b>Witnesses:</b> ${proof.witnesses}</div>` : ''}

      ${actSnap.length ? `
      <div class="dq-sub-activity-toggle" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
        📋 Activity Snapshot (${actSnap.length} events) ▾
      </div>
      <div class="dq-sub-activity-list" style="display:none">
        ${actSnap.map(e => `<div class="dq-sub-activity-item">${e}</div>`).join('')}
      </div>` : '<div class="dq-sub-proof-row" style="color:var(--text-dim);font-style:italic">No activity snapshot available.</div>'}

      ${s.status === 'pending' ? `
      <div class="dq-sub-actions">
        <button class="deity-mini-btn success" onclick="window._approveSubmission('${s.id}','${q.id}')">✓ Approve</button>
        <button class="deity-mini-btn danger"  onclick="window._rejectSubmission('${s.id}')">✕ Reject</button>
        <button class="deity-mini-btn punish"  onclick="window._openPunishModal('${s.uid||s.id}','${(s.playerName||'?').replace(/'/g,"\\'")}')">⚖️ Punish</button>
      </div>` : `
      <div class="dq-sub-actions" style="margin-top:6px">
        <button class="deity-mini-btn punish" onclick="window._openPunishModal('${s.uid||s.id}','${(s.playerName||'?').replace(/'/g,"\\'")}')">⚖️ Punish</button>
      </div>`}
    </div>`;
  }).join('');
};

// Load submissions for all deity quests and attach to quest objects
window._loadDeityQuestSubmissions = async function() {
  if (!_deityQuests.length) return;
  const questIds = _deityQuests.map(q => q.id);
  // Firestore 'in' query supports up to 30 values; chunk if needed
  const chunks = [];
  for (let i = 0; i < questIds.length; i += 30) chunks.push(questIds.slice(i, i + 30));
  const allSubs = [];
  for (const chunk of chunks) {
    const snap = await getDocs(query(collection(db, 'questSubmissions'), where('questId', 'in', chunk)));
    snap.forEach(d => allSubs.push({ id: d.id, ...d.data() }));
  }
  _deityQuests.forEach(q => {
    q._submissions = allSubs.filter(s => s.questId === q.id)
      .sort((a, b) => (b.submittedAt?.toMillis?.() || 0) - (a.submittedAt?.toMillis?.() || 0));
  });
  // Live listener for new submissions
  if (window._subUnsub) window._subUnsub();
  const allQ = query(collection(db, 'questSubmissions'), where('questId', 'in', questIds.slice(0, 30)));
  window._subUnsub = onSnapshot(allQ, snap => {
    const live = [];
    snap.forEach(d => live.push({ id: d.id, ...d.data() }));
    _deityQuests.forEach(q => {
      q._submissions = live.filter(s => s.questId === q.id)
        .sort((a, b) => (b.submittedAt?.toMillis?.() || 0) - (a.submittedAt?.toMillis?.() || 0));
    });
    renderDeityQuests();
  });
  renderDeityQuests();
};

// Approve a submission: update doc, grant reward, notify player
window._approveSubmission = async function(subId, questId) {
  try {
    const quest = _deityQuests.find(q => q.id === questId);
    if (!quest) return;
    const sub = quest._submissions?.find(s => s.id === subId);
    if (!sub) return;

    await updateDoc(doc(db, 'questSubmissions', subId), { status: 'approved' });

    // For one-time quests: stamp completedBy so other players get locked out
    if (quest.completionType === 'one_time') {
      try {
        await updateDoc(doc(db, 'storyQuests', questId), {
          completedBy: arrayUnion({
            uid: sub.uid,
            playerName: sub.playerName || '?',
            completedAt: new Date(),
          }),
        });
      } catch(e) {
        console.warn('Could not stamp completedBy on storyQuest:', e);
      }
    }

    // Notify the player
    await addDoc(collection(db, 'notifications'), {
      uid: sub.uid,
      message: `✅ <b>Quest Approved:</b> Your submission for <b>${quest.title}</b> has been approved by a deity! Your reward has been granted.`,
      read: false,
      timestamp: serverTimestamp(),
    });

    window.showToast(`✓ Approved ${sub.playerName}'s submission.`, 'success');
    loadDeityQuests();
  } catch(e) {
    console.error('Approve failed:', e);
    window.showToast('Failed to approve.', 'error');
  }
};

// Reject a submission: update doc, notify player with reason
// Styled reject modal — replaces browser prompt()
function showRejectModal(questTitle, onConfirm) {
  document.getElementById('reject-reason-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'reject-reason-modal';
  modal.className = 'deity-modal';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="deity-modal-box reject-modal-box">
      <div class="reject-modal-icon">✕</div>
      <div class="deity-modal-title" style="text-align:center;margin-bottom:4px">REJECT SUBMISSION</div>
      <div class="deity-modal-desc" style="text-align:center">Rejecting <b style="color:var(--gold)">${questTitle}</b><br/>This reason will be shown to the player.</div>
      <textarea id="reject-reason-input" class="field-input reject-reason-textarea" placeholder="Enter reason for rejection..." maxlength="300"></textarea>
      <div class="reject-char-count"><span id="reject-char-num">0</span>/300</div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn-primary danger-btn" id="reject-confirm-btn" style="flex:1">REJECT QUEST</button>
        <button class="btn-secondary" style="flex:1" onclick="document.getElementById('reject-reason-modal').remove()">CANCEL</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const textarea = modal.querySelector('#reject-reason-input');
  const charNum  = modal.querySelector('#reject-char-num');
  textarea.addEventListener('input', () => { charNum.textContent = textarea.value.length; });
  textarea.focus();
  modal.querySelector('#reject-confirm-btn').addEventListener('click', () => {
    onConfirm(textarea.value.trim() || null);
    modal.remove();
  });
  // Close on backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

window._rejectSubmission = async function(subId) {
  // Look up uid and title from cached data — avoids passing unsafe strings through HTML onclick
  let playerUid = '', questTitle = '';
  for (const q of (_deityQuests || [])) {
    const sub = (q._submissions || []).find(s => s.id === subId);
    if (sub) { playerUid = sub.uid; questTitle = q.title; break; }
  }
  showRejectModal(questTitle, async (reason) => {
    try {
      await updateDoc(doc(db, 'questSubmissions', subId), { status: 'rejected' });
      await addDoc(collection(db, 'notifications'), {
        uid: playerUid,
        message: `✕ <b>Quest Rejected:</b> Your submission for <b>${questTitle}</b> was not approved.${reason ? ` Reason: <em>${reason}</em>` : ''} You may resubmit once the objectives are met.`,
        read: false,
        timestamp: serverTimestamp(),
      });
      window.showToast('Submission rejected. Player notified.', 'info');
      loadDeityQuests();
    } catch(e) {
      console.error('Reject failed:', e);
      window.showToast('Failed to reject.', 'error');
    }
  });
};

window._endQuest = async id => {
  try {
    await updateDoc(doc(db, "storyQuests", id), { status: "ended" });
    window.showToast("Quest ended.", "success");
    loadDeityQuests();
  } catch(e) { window.showToast("Failed.", "error"); }
};
// ═══════════════════════════════════════════════════
//  PUNISH SYSTEM
// ═══════════════════════════════════════════════════
window._openPunishModal = async function(playerUid, playerName) {
  document.getElementById('punish-modal')?.remove();

  // Fetch player's current inventory and gold
  let currentInv = [], currentGold = 0;
  try {
    const charSnap = await getDoc(doc(db, 'characters', playerUid));
    if (charSnap.exists()) {
      const d = charSnap.data();
      currentInv  = d.inventory || [];
      currentGold = d.gold || 0;
    }
  } catch(e) { console.warn('Failed to fetch player data for punish:', e); }

  const modal = document.createElement('div');
  modal.id = 'punish-modal';
  modal.className = 'deity-modal';
  modal.style.display = 'flex';

  const invHtml = currentInv.length
    ? currentInv.map((item, i) => `
        <label class="punish-item-row">
          <input type="checkbox" class="punish-item-cb" data-idx="${i}" data-name="${(item.name||'').replace(/"/g,'&quot;')}" style="accent-color:var(--gold);width:15px;height:15px"/>
          <span class="punish-item-icon">${item.icon||'📦'}</span>
          <span class="punish-item-name">${item.name}</span>
          <span class="punish-item-qty" style="color:var(--gold-dim);margin-left:auto">×${item.qty||1}</span>
          <input type="number" min="1" max="${item.qty||1}" value="1" class="punish-item-qty-input" data-idx="${i}"
            style="width:48px;padding:2px 6px;background:var(--ink2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.8rem;margin-left:8px"/>
        </label>`).join('')
    : '<div style="color:var(--text-dim);font-style:italic;font-size:0.82rem">Player has no items.</div>';

  modal.innerHTML = `
    <div class="deity-modal-box" style="max-width:500px">
      <div class="deity-modal-title">⚖️ Punish — ${playerName}</div>
      <p class="deity-modal-desc" style="margin-bottom:14px">Strip gold or items from this player. They will receive a notification.</p>

      <div class="field-group" style="margin-bottom:12px">
        <label class="field-label">Strip Gold (current: ${currentGold})</label>
        <input class="field-input" type="number" id="punish-gold" min="0" max="${currentGold}" value="0" placeholder="0"/>
      </div>

      <div class="field-group" style="margin-bottom:12px">
        <label class="field-label">Strip Items</label>
        <div id="punish-inv-list" style="background:var(--ink2);border:1px solid var(--border);border-radius:8px;padding:10px;max-height:180px;overflow-y:auto">
          ${invHtml}
        </div>
      </div>

      <div class="field-group" style="margin-bottom:16px">
        <label class="field-label">Reason (shown to player)</label>
        <textarea class="field-input" id="punish-reason" rows="2" maxlength="300" placeholder="e.g. Divine punishment for betraying the quest..."></textarea>
      </div>

      <div class="form-error" id="punish-error" style="margin-bottom:8px"></div>
      <div style="display:flex;gap:10px">
        <button class="btn-primary danger-btn" onclick="window._executePunish('${playerUid}','${playerName.replace(/'/g,"\'")}')">⚖️ EXECUTE PUNISHMENT</button>
        <button class="btn-secondary" onclick="document.getElementById('punish-modal').remove()">CANCEL</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Store current inv on window for execute step
  window._punishCurrentInv = currentInv;
};

window._executePunish = async function(playerUid, playerName) {
  const errEl  = document.getElementById('punish-error');
  const gold   = parseInt(document.getElementById('punish-gold')?.value) || 0;
  const reason = document.getElementById('punish-reason')?.value.trim() || '';
  const btn    = document.querySelector('#punish-modal .btn-primary');

  // Collect checked items with qty
  const strippedItems = [];
  document.querySelectorAll('#punish-modal .punish-item-cb:checked').forEach(cb => {
    const idx     = parseInt(cb.dataset.idx);
    const qtyEl   = document.querySelector(`#punish-modal .punish-item-qty-input[data-idx="${idx}"]`);
    const qty     = Math.max(1, parseInt(qtyEl?.value) || 1);
    const srcItem = (window._punishCurrentInv || [])[idx];
    if (srcItem) strippedItems.push({ name: srcItem.name, icon: srcItem.icon || '📦', qty: Math.min(qty, srcItem.qty || 1) });
  });

  if (gold === 0 && !strippedItems.length) {
    errEl.textContent = 'Select gold or items to strip.'; return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Punishing...'; }
  try {
    const charRef  = doc(db, 'characters', playerUid);
    const charSnap = await getDoc(charRef);
    if (!charSnap.exists()) throw new Error('Player not found.');
    const charData = charSnap.data();

    // Build new inventory — reduce qty or remove item
    let newInv = [...(charData.inventory || [])];
    for (const strip of strippedItems) {
      const existing = newInv.find(i => i.name === strip.name);
      if (existing) {
        existing.qty -= strip.qty;
        if (existing.qty <= 0) newInv = newInv.filter(i => i.name !== strip.name);
      }
    }
    const newGold = Math.max(0, (charData.gold || 0) - gold);

    await updateDoc(charRef, { gold: newGold, inventory: newInv });

    // Notification to player
    const strippedDesc = [
      gold > 0 ? `${gold} gold` : '',
      strippedItems.map(i => `${i.qty}× ${i.name}`).join(', '),
    ].filter(Boolean).join(' and ');
    await addDoc(collection(db, 'notifications'), {
      uid:       playerUid,
      message:   `⚖️ <b>Divine Punishment:</b> The gods have stripped you of <b>${strippedDesc}</b>.${reason ? ` Reason: <em>${reason}</em>` : ''}`,
      read:      false,
      timestamp: serverTimestamp(),
    });

    document.getElementById('punish-modal')?.remove();
    window.showToast(`${playerName} has been punished.`, 'success');
  } catch(e) {
    console.error('Punish failed:', e);
    errEl.textContent = e.message || 'Failed to punish player.';
    if (btn) { btn.disabled = false; btn.textContent = '⚖️ EXECUTE PUNISHMENT'; }
  }
};

// ═══════════════════════════════════════════════════
//  WORLD EVENT (Unexpected / Logical Development)
// ═══════════════════════════════════════════════════
let _weType = 'unexpected';

window._setWeType = function(type) {
  _weType = type;
  document.getElementById('we-type-unexpected')?.classList.toggle('active', type === 'unexpected');
  document.getElementById('we-type-logical')?.classList.toggle('active', type === 'logical');
};

window._toggleWorldEventBar = function() {
  const bar = document.getElementById('dchat-world-event-bar');
  if (!bar) return;
  const isVisible = bar.style.display !== 'none';
  bar.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) document.getElementById('dchat-we-text')?.focus();
};

window._sendWorldEvent = async function() {
  const text   = document.getElementById('dchat-we-text')?.value.trim();
  if (!text) { window.showToast('Write a world event message first.', 'error'); return; }

  const tab    = _deityChatTab || 'location';
  const locId  = _deityChatLocation || '';

  const msgsRef = (tab === 'general')
    ? collection(db, 'general-chat', 'global', 'messages')
    : (locId ? collection(db, 'chats', locId, 'messages') : null);

  if (!msgsRef) { window.showToast('Select a location first.', 'error'); return; }

  const label = _weType === 'unexpected' ? 'UNEXPECTED DEVELOPMENT' : 'LOGICAL DEVELOPMENT';

  try {
    await addDoc(msgsRef, {
      uid:          'system',
      charName:     'The World',
      isWorldEvent: true,
      eventType:    _weType,
      eventLabel:   label,
      text,
      timestamp:    serverTimestamp(),
    });
    const input = document.getElementById('dchat-we-text');
    if (input) input.value = '';
    window._toggleWorldEventBar?.();
    window.showToast(`${label} sent to chat!`, 'success');
  } catch(e) {
    window.showToast('Failed to send world event: ' + (e.message || e), 'error');
  }
};


// ═══════════════════════════════════════════════════
//  NPC MANAGER (Deity)
// ═══════════════════════════════════════════════════

// ── World locations from the official world map ──────────────
// Safe zones = capitals + settlements (RP chat + NPCs live here)
// Resource zones = gathering spots
// Monster zones = combat areas
// Special locations = deity worship material spots

const LOCATIONS_BY_TYPE = {
  // ── NORTHERN CONTINENT — FROSTVEIL REGION ──────────────────
  northern_safe: [
    "Frostspire",             // Capital of Gladys Kingdom
    "Whitecrest Village",
    "Icerun Hamlet",
    "Paleglow Town",
    "Mistveil Town",
  ],
  northern_monster: [
    "Frostfang Valley",       // E-D: Blue-mane Wolves, Five-Fanged Bears
    "Sheen Lake",             // E-D: Groundhog Turtles, Twin-faced Serpents
    "Misty Hollow",           // E-D: Mist Phantom, Ice Ifrit, Water Wraith
    "Dark Cathedral",         // C: Condemned Knight, Revenant Bishop, Penitent Priest
  ],
  northern_resource: [
    "Wisteria Forest",        // Foraging, herbs, hunting
    "Silver Lake",            // Angling
    "Hobbit Cave",            // Mining
    "Arctic Willow Grove",    // Foraging, herbs, hunting
    "Dream River",            // Angling
    "Suldan Mine",            // Mining
  ],
  northern_special: [
    "Shrine of Secrets",      // God of Knowledge (Veil) — 10% deity mat
    "Aurora Basin",           // Goddess of Stars (Mah'run) — 10% deity mat
    "Forgotten Estuary",      // God of Darkness (Alistor) — 10% deity mat
  ],

  // ── WESTERN CONTINENT — VERDANTIS REGION ───────────────────
  western_safe: [
    "Solmere",                // Capital of Elaria Kingdom
    "Sunpetal Village",
    "Basil Village",
    "Riverend Town",
    "Verdance Town",
  ],
  western_monster: [
    "Whispering Forest",      // E-D: Red-mane Wolves, Vicious Gremlins
    "Golden Plains",          // E-D: Scavengers, Rampage Bulls
    "Element Valley",         // E-D: Lightning Shrouds, Rock Golems, Flame Spirits
    "Defiled Sanctum",        // C: Skeletal Beast, Ghoul Blatherer, Cursed Fiend
  ],
  western_resource: [
    "Asahi Valley",           // Foraging, herbs, hunting
    "Moss Stream",            // Angling
    "Argent Grotto",          // Mining
    "Golden River",           // Angling
    "Shiny Cavern",           // Mining
  ],
  western_special: [
    "Purgatory of Light",     // God of Flames (Sah'run) — 10% deity mat
    "Temple of Verdict",      // God of Justice (Arion) — 10% deity mat
    "Heart Garden",           // Goddess of Love (Freyja) — 10% deity mat
    "Valley of Overflowing",  // God of Abundance (Elionidas) — 10% deity mat
  ],

  // ── EASTERN CONTINENT — VORTHAK (Danger Zone) ──────────────
  eastern_monster: [
    "Ashen Wastes",           // A-B: Dark Sphinx, Blue Phoenix, Fallen Cyclops
    "Infernal Reach",         // A-B: Cerberus, Blood Kraken
    "Ruined Sanctum",         // A-B: Profane Priest, Corrupted Sage, Demonic Herald
    "Blighted World",         // A-B: Abomination, Devil Centurion
  ],

  // ── SOUTHERN CONTINENT — NYX ABYSS (Endgame) ───────────────
  southern_monster: [
    "Void Chasm",             // S: Void Lurker, Oblivion Eye
    "Abyssal Depths",         // S: Abyssal Eater, Chaoswalker
    "Fallen Heaven",          // S: Godless Thing
  ],
};

// Flat list of ALL locations (for dropdowns)
const KNOWN_LOCATIONS = [
  // Safe zones
  ...LOCATIONS_BY_TYPE.northern_safe,
  ...LOCATIONS_BY_TYPE.western_safe,
  // Resource zones
  ...LOCATIONS_BY_TYPE.northern_resource,
  ...LOCATIONS_BY_TYPE.western_resource,
  // Special / deity zones
  ...LOCATIONS_BY_TYPE.northern_special,
  ...LOCATIONS_BY_TYPE.western_special,
  // (NO monster zones, NO eastern/southern continents)
];

// Only safe zones host NPCs and RP chat boxes per world rules
const SAFE_ZONE_LOCATIONS = [
  ...LOCATIONS_BY_TYPE.northern_safe,
  ...LOCATIONS_BY_TYPE.western_safe,
];

let _deityNpcs = [];
let _currentNpcLocation = "";

function initDeityNpcPanel() {
  const locSel = document.getElementById("npc-location-filter");
  if (!locSel || locSel.options.length > 1) return;
  // Only allow safe, resource, and special locations
  const groups = [
    { label: "── Northern Safe Zones ──",         locs: LOCATIONS_BY_TYPE.northern_safe },
    { label: "── Western Safe Zones ──",           locs: LOCATIONS_BY_TYPE.western_safe },
    { label: "── Northern Resource Zones ──",      locs: LOCATIONS_BY_TYPE.northern_resource },
    { label: "── Western Resource Zones ──",       locs: LOCATIONS_BY_TYPE.western_resource },
    { label: "── Northern Special Locations ──",   locs: LOCATIONS_BY_TYPE.northern_special },
    { label: "── Western Special Locations ──",    locs: LOCATIONS_BY_TYPE.western_special },
  ];
  groups.forEach(({ label, locs }) => {
    const grp = document.createElement("optgroup");
    grp.label = label;
    locs.forEach(loc => {
      const o = document.createElement("option");
      o.value = loc.toLowerCase().replace(/[^a-z0-9]/g, "-");
      o.textContent = loc;
      grp.appendChild(o);
    });
    locSel.appendChild(grp);
  });
}

async function loadDeityNpcs(locationId) {
  if (!locationId) return;
  _currentNpcLocation = locationId;
  const listEl = document.getElementById("deity-npc-list");
  if (listEl) listEl.innerHTML = `<p style="color:var(--text-dim);font-style:italic">Loading NPCs...</p>`;

  try {
    const snap = await getDocs(collection(db, "npcs", locationId, "list"));
    _deityNpcs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDeityNpcs();
  } catch(e) {
    if (listEl) listEl.innerHTML = `<p style="color:var(--text-dim)">Failed to load NPCs.</p>`;
  }
}

function renderDeityNpcs() {
  const listEl = document.getElementById("deity-npc-list");
  if (!listEl) return;

  if (!_deityNpcs.length) {
    listEl.innerHTML = `
      <p style="color:var(--text-dim);font-style:italic;font-size:0.85rem;margin-bottom:12px">No NPCs in this location yet.</p>
      <button class="btn-primary" onclick="window._openDeityNpcForm(null)">+ Create First NPC</button>`;
    return;
  }

  listEl.innerHTML = `<div class="deity-npc-grid">${_deityNpcs.map(npc => {
    const av = npc.avatar?.startsWith("http")
      ? `<img src="${npc.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
      : `<span style="font-size:1.4rem">${npc.avatar||"🧙"}</span>`;
    const autoCount = npc.autoResponses?.length || 0;
    const invCount  = npc.inventory?.length || 0;
    const rankLvl   = npc.rank ? `${npc.rank} Lv.${npc.level||1}` : "";
    const classTag  = npc.charClass ? `${npc.charClass}` : "";
    const skillList = (npc.skills||[]).length ? (npc.skills||[]).join(", ") : "";
    return `
    <div class="deity-npc-card">
      <div class="deity-npc-avatar">${av}</div>
      <div class="deity-npc-info">
        <div class="deity-npc-name">${npc.name}</div>
        <div class="deity-npc-desc">${npc.description||"—"}</div>
        ${rankLvl  ? `<div class="deity-npc-meta npc-rank-badge">⚔️ ${rankLvl}${classTag ? ` · ${classTag}` : ""}</div>` : ""}
        ${skillList ? `<div class="deity-npc-meta" style="color:var(--gold-dim);font-size:0.7rem">🔮 ${skillList}</div>` : ""}
        <div class="deity-npc-meta">${autoCount} auto-response${autoCount!==1?"s":""}${invCount ? ` · 🎒 ${invCount} item${invCount!==1?"s":""}` : ""}</div>
      </div>
      <div class="deity-npc-actions">
        <button class="deity-mini-btn" onclick="window._openDeityNpcForm('${npc.id}')">✏️ Edit</button>
        <button class="deity-mini-btn" onclick="window._npcSpeakAs('${npc.id}','${(npc.name||"").replace(/'/g,"\\'")}')" >🗣️ Speak</button>
        <button class="deity-mini-btn" onclick="window._openNpcBestowModal('${npc.id}','${(npc.name||"").replace(/'/g,"\\'")}')" >🎒 Bestow</button>
        <button class="deity-mini-btn danger" onclick="window._deleteDeityNpc('${npc.id}')">🗑️</button>
      </div>
    </div>`;
  }).join("")}</div>`;

  // Speak as NPC from NPC manager panel
  window._npcSpeakAs = (npcId, npcName) => {
    // Switch to chat panel, pre-select this NPC
    switchDeityPanel("chat");
    setTimeout(() => {
      const sel = document.getElementById("deity-chat-as");
      if (sel) sel.value = `npc_${npcId}`;
    }, 300);
  };

  window._deleteDeityNpc = async id => {
    if (!_currentNpcLocation) return;
    try {
      await deleteDoc(doc(db, "npcs", _currentNpcLocation, "list", id));
      window.showToast("NPC deleted.", "success");
      loadDeityNpcs(_currentNpcLocation);
    } catch(e) { window.showToast("Failed to delete.", "error"); }
  };
}

// ── NPC Bestow Modal ─────────────────────────────────────────────────────────
window._openNpcBestowModal = function(npcId, npcName) {
  document.getElementById("npc-bestow-modal")?.remove();
  const npc = _deityNpcs.find(n => n.id === npcId) || {};
  const locationId = _currentNpcLocation;

  const modal = document.createElement("div");
  modal.id = "npc-bestow-modal";
  modal.className = "deity-modal";
  modal.style.display = "flex";

  // Build inventory display
  const currentInv = npc.inventory || [];
  const invHtml = currentInv.length
    ? currentInv.map((item, i) => `
        <div class="bestow-log-entry" style="display:flex;align-items:center;gap:8px">
          <span>${item.icon||"📦"}</span>
          <span style="flex:1">${item.name}</span>
          <span style="color:var(--gold-dim)">×${item.qty||1}</span>
          <button onclick="window._removeNpcItem('${npcId}','${locationId}',${i})"
            style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:0.85rem;padding:0 4px">✕</button>
        </div>`).join("")
    : `<div style="color:var(--text-dim);font-style:italic;font-size:0.82rem">No items yet.</div>`;

  modal.innerHTML = `
    <div class="deity-modal-box" style="max-width:480px">
      <div class="deity-modal-title">🎒 Bestow to ${npcName}</div>
      <div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:14px">Add items directly to this NPC's inventory. Players can trade with or receive items from this NPC.</div>

      <div style="font-family:var(--ff-mono);font-size:0.6rem;color:var(--gold);letter-spacing:0.1em;margin-bottom:8px">CURRENT INVENTORY</div>
      <div id="npc-bestow-inv-display" style="margin-bottom:16px;max-height:140px;overflow-y:auto;background:var(--ink2);border:1px solid var(--border);border-radius:8px;padding:10px">
        ${invHtml}
      </div>

      <div style="font-family:var(--ff-mono);font-size:0.6rem;color:var(--gold);letter-spacing:0.1em;margin-bottom:8px">ADD ITEMS</div>
      <div id="npc-bestow-item-picker"></div>
      <textarea id="npc-bestow-items" style="display:none"></textarea>

      <div class="form-error" id="npc-bestow-error" style="margin:8px 0"></div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn-primary" onclick="window._doNpcBestow('${npcId}','${locationId}')">💾 Save to Inventory</button>
        <button class="btn-secondary" onclick="document.getElementById('npc-bestow-modal').remove()">Cancel</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });

  // Render item picker into the modal
  const picker = modal.querySelector("#npc-bestow-item-picker");
  const hiddenTextarea = modal.querySelector("#npc-bestow-items");
  _renderNpcBestowPicker(picker, hiddenTextarea);
};

function _renderNpcBestowPicker(picker, hiddenTextarea) {
  // Uses ITEMS array (type: weapon/armor/potion/food/material)
  const CAT_MAP = [
    { key:"weapon",   label:"⚔️ Weapons"   },
    { key:"armor",    label:"🛡️ Armor"     },
    { key:"potion",   label:"🧪 Potions"   },
    { key:"food",     label:"🍖 Food"      },
    { key:"material", label:"📦 Materials" },
  ];

  let selected    = [];
  let currentCat  = "weapon";
  let searchQuery = "";

  picker.innerHTML = `
    <div class="reward-picker-tabs" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
      ${CAT_MAP.map(c=>`<button class="reward-picker-tab${c.key===currentCat?" active":""}" data-cat="${c.key}" style="touch-action:manipulation">${c.label}</button>`).join("")}
    </div>
    <input type="text" class="field-input npc-bestow-search-input"
      placeholder="🔍 Search items..." style="margin-bottom:8px;padding:6px 10px;font-size:0.82rem"/>
    <div class="reward-picker-list" style="max-height:200px;overflow-y:auto"></div>
    <div class="reward-picker-selected" style="margin-top:8px"></div>`;

  const listDiv     = picker.querySelector(".reward-picker-list");
  const selectedDiv = picker.querySelector(".reward-picker-selected");
  const searchInput = picker.querySelector(".npc-bestow-search-input");

  function syncHidden() {
    hiddenTextarea.value = selected.map(i=>`${i.name}, ${i.qty}`).join("\n");
  }

  function getBadge(item) {
    if (item.grade)  { const c = GRADE_COLORS[item.grade]   ||"#aaa"; return `<span style="font-size:0.6rem;padding:1px 5px;border-radius:3px;background:${c}22;color:${c};border:1px solid ${c}44;margin-left:4px">${item.grade}</span>`; }
    if (item.rarity) { const c = RARITY_COLORS[item.rarity] ||"#aaa"; return `<span style="font-size:0.6rem;padding:1px 5px;border-radius:3px;background:${c}22;color:${c};border:1px solid ${c}44;margin-left:4px">${item.rarity}</span>`; }
    return "";
  }

  function updateSelected() {
    if (!selected.length) {
      selectedDiv.innerHTML = `<div style="color:var(--text-dim);font-size:0.82rem;padding:4px 0;font-style:italic">No items selected yet.</div>`;
    } else {
      selectedDiv.innerHTML = `
        <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:6px;font-family:var(--ff-mono);letter-spacing:0.06em">SELECTED ITEMS</div>
        ${selected.map((item,idx)=>`
          <div class="reward-selected-row">
            <span class="reward-selected-num">${idx+1}</span>
            <span class="reward-selected-icon">${item.icon||"📦"}</span>
            <span class="reward-selected-name">${item.name}${getBadge(item)}</span>
            <input type="number" min="1" value="${item.qty}" data-name="${item.name}" class="reward-qty-input"/>
            <button data-name="${item.name}" class="reward-remove-btn" style="touch-action:manipulation">✕</button>
          </div>`).join("")}`;
    }
    syncHidden();
    selectedDiv.querySelectorAll(".reward-qty-input").forEach(inp => {
      inp.addEventListener("input", () => {
        const val  = Math.max(1, parseInt(inp.value)||1);
        inp.value  = val;
        const item = selected.find(i=>i.name===inp.dataset.name);
        if (item) { item.qty = val; syncHidden(); }
      });
    });
    selectedDiv.querySelectorAll(".reward-remove-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        selected = selected.filter(i=>i.name!==btn.dataset.name);
        updateSelected();
        showCat(currentCat);
      });
    });
  }

  function showCat(catKey) {
    currentCat = catKey;
    const q = (searchInput?.value||"").trim().toLowerCase();
    let items = ITEMS.filter(i => i.type === catKey);
    if (q) items = items.filter(i => i.name.toLowerCase().includes(q));
    listDiv.innerHTML = items.map(item => {
      const inSel = selected.find(s=>s.name===item.name);
      return `<div class="reward-picker-item${inSel?" selected":""}" data-name="${item.name}"
        style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;
        background:${inSel?"rgba(201,168,76,0.12)":"transparent"};margin-bottom:2px;touch-action:manipulation">
        <span style="font-size:1rem;width:1.6em;text-align:center">${item.icon||"📦"}</span>
        <span style="flex:1;font-size:0.85rem">${item.name}${getBadge(item)}</span>
        ${inSel?`<span style="color:var(--gold);font-size:0.75rem">×${inSel.qty} ✓</span>`:""}
      </div>`;
    }).join("") || `<div style="color:var(--text-dim);font-size:0.82rem;padding:8px">No items found.</div>`;

    listDiv.querySelectorAll(".reward-picker-item").forEach(el => {
      el.addEventListener("click", () => {
        const itemDef = ITEMS.find(i=>i.name===el.dataset.name);
        if (!itemDef) return;
        const ex = selected.find(s=>s.name===itemDef.name);
        if (ex) ex.qty++;
        else selected.push({...itemDef, qty:1});
        updateSelected();
        showCat(currentCat);
      });
    });

    picker.querySelectorAll(".reward-picker-tab").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.cat === catKey);
    });
  }

  picker.querySelectorAll(".reward-picker-tab").forEach(tab => {
    tab.addEventListener("click", () => showCat(tab.dataset.cat));
  });
  searchInput?.addEventListener("input", () => showCat(currentCat));

  showCat(currentCat);
  updateSelected();
}
window._doNpcBestow = async function(npcId, locationId) {
  const errEl = document.getElementById("npc-bestow-error");
  errEl.textContent = "";
  const itemsRaw = document.getElementById("npc-bestow-items")?.value.trim();
  if (!itemsRaw) { errEl.textContent = "Select at least one item."; return; }

  const newItems = [];
  for (const line of itemsRaw.split("\n")) {
    const p = line.split(",").map(x => x.trim());
    if (p[0] && parseInt(p[1]) > 0) {
      const def = ITEMS.find(i => i.name === p[0]);
      newItems.push({ name: p[0], icon: def?.icon || "📦", type: def?.category || "material", qty: parseInt(p[1]) });
    }
  }
  if (!newItems.length) { errEl.textContent = "No valid items selected."; return; }

  const btn = document.querySelector("#npc-bestow-modal .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Saving..."; }

  try {
    const npc = _deityNpcs.find(n => n.id === npcId) || {};
    const currentInv = [...(npc.inventory || [])];
    for (const item of newItems) {
      const existing = currentInv.find(i => i.name === item.name);
      if (existing) existing.qty += item.qty;
      else currentInv.push(item);
    }
    await updateDoc(doc(db, "npcs", locationId, "list", npcId), { inventory: currentInv });
    // Update local cache
    const cached = _deityNpcs.find(n => n.id === npcId);
    if (cached) cached.inventory = currentInv;

    document.getElementById("npc-bestow-modal")?.remove();
    window.showToast(`Items added to NPC inventory!`, "success");
    loadDeityNpcs(locationId);
  } catch(e) {
    errEl.textContent = e.message || "Failed to save inventory.";
    if (btn) { btn.disabled = false; btn.textContent = "💾 Save to Inventory"; }
  }
};

window._removeNpcItem = async function(npcId, locationId, itemIdx) {
  try {
    const npc = _deityNpcs.find(n => n.id === npcId);
    if (!npc) return;
    const inv = [...(npc.inventory || [])];
    inv.splice(itemIdx, 1);
    await updateDoc(doc(db, "npcs", locationId, "list", npcId), { inventory: inv });
    npc.inventory = inv;
    // Refresh the current inventory display inside the open modal
    const invDisplay = document.getElementById("npc-bestow-inv-display");
    if (invDisplay) {
      invDisplay.innerHTML = inv.length
        ? inv.map((item, i) => `
            <div class="bestow-log-entry" style="display:flex;align-items:center;gap:8px">
              <span>${item.icon||"📦"}</span>
              <span style="flex:1">${item.name}</span>
              <span style="color:var(--gold-dim)">×${item.qty||1}</span>
              <button onclick="window._removeNpcItem('${npcId}','${locationId}',${i})"
                style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:0.85rem;padding:0 4px">✕</button>
            </div>`).join("")
        : `<div style="color:var(--text-dim);font-style:italic;font-size:0.82rem">No items yet.</div>`;
    }
    window.showToast("Item removed.", "info");
  } catch(e) { window.showToast("Failed to remove item.", "error"); }
};


// ─────────────────────────────────────────────────────────────────────────────
//  NPC CLASS + SKILL TREE  (2 skills unlock per rank tier)
//  Tiers: Wanderer/Follower          = basic
//         Disciple/Master            = +intermediate
//         Exalted → Eternal          = +advanced
// ─────────────────────────────────────────────────────────────────────────────
const NPC_CLASSES = ["Warrior","Guardian","Arcanist","Hunter","Assassin","Cleric","Summoner"];

const NPC_SKILL_TREE = {
  Warrior:  {
    basic:        ["Cleave","Battle Cry","Crushing Blow"],
    intermediate: ["War Stomp","Bleeding Edge","Iron Momentum","Blood Gamble"],
    advanced:     ["Titan Breaker","Berserker's Oath","War God's Fury"],
  },
  Guardian: {
    basic:        ["Shield Bash","Fortify","Iron Guard"],
    intermediate: ["Stone Skin","Reinforced Core","Taunting Roar","Pain Conversion"],
    advanced:     ["Aegis of Eternity","Colossus Form","Unbreakable Will"],
  },
  Arcanist: {
    basic:        ["Arcane Bolt","Mana Pulse","Robust Mind"],
    intermediate: ["Astral Lance","Mind Burn","Echo-strike","Rune Sacrifice"],
    advanced:     ["Meteorfall","Arcane Shower","Hex"],
  },
  Hunter:   {
    basic:        ["Pierce","Hunter's Poison","Quick Shot"],
    intermediate: ["Split Arrow","Ensnare","Falcon Sight","Vital Shot"],
    advanced:     ["Slayer","Predator's Instinct","Executioner"],
  },
  Assassin: {
    basic:        ["Backstab","Scorching Blade","Shadow Step"],
    intermediate: ["Thunder Strike","Venom Surge","Trickster","Blood Pact"],
    advanced:     ["Death Mark","Phantom Assault","Predator"],
  },
  Cleric:   {
    basic:        ["Healing Light","Sacred Spark","Neptune's Embrace"],
    intermediate: ["Divine Barrier","Purify","Radiant Pulse","Life Exchange"],
    advanced:     ["Sanctuary","Divine Ascension","Lazarus"],
  },
  Summoner: {
    basic:        ["Lashing","Soul Bind","Essence Sap"],
    intermediate: ["Beastmaster","Beast Empowerment","Usurper","Offering"],
    advanced:     ["Leviathan","Abyssal-touch","Profane Lord"],
  },
};

const NPC_RANKS = [
  { value: "Wanderer",  label: "Wanderer  — A soul merely stepping into the world",  levels: "1–100"   },
  { value: "Follower",  label: "Follower  — A soul who admires a certain path",        levels: "101–200" },
  { value: "Disciple",  label: "Disciple  — Now walks a certain path",                 levels: "201–300" },
  { value: "Master",    label: "Master    — Is now a master of that path",             levels: "301–400" },
  { value: "Exalted",   label: "Exalted   — Praised as a lord of his path",           levels: "401–500" },
  { value: "Crown",     label: "Crown     — A leader",                                 levels: "501–600" },
  { value: "Supreme",   label: "Supreme   — An absolute monarch",                      levels: "601–700" },
  { value: "Legend",    label: "Legend    — A being spoken of in legends",             levels: "701–800" },
  { value: "Myth",      label: "Myth      — A true fable",                             levels: "801–900" },
  { value: "Eternal",   label: "Eternal   — An everlasting being",                     levels: "901–1000"},
];

const NPC_RANK_TIERS = {
  "Wanderer" : "basic",
  "Follower" : "basic",
  "Disciple" : "intermediate",
  "Master"   : "intermediate",
  "Exalted"  : "advanced",
  "Crown"    : "advanced",
  "Supreme"  : "advanced",
  "Legend"   : "advanced",
  "Myth"     : "advanced",
  "Eternal"  : "advanced",
};

// Returns all skills available up to and including the rank tier
function getNpcAvailableSkills(charClass, rank) {
  const tree = NPC_SKILL_TREE[charClass];
  if (!tree) return [];
  const tier = NPC_RANK_TIERS[rank] || "basic";
  const tiers = tier === "basic"        ? ["basic"]
              : tier === "intermediate" ? ["basic","intermediate"]
              : ["basic","intermediate","advanced"];
  return tiers.flatMap(t => tree[t] || []);
}

function openDeityNpcForm(npcId) {
  const existing = npcId ? (_deityNpcs.find(n => n.id === npcId) || {}) : {};
  const isEdit   = !!npcId;

  document.getElementById("deity-npc-form-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "deity-npc-form-modal";
  modal.className = "deity-modal";
  modal.style.display = "flex";

  // Location dropdown options (safe zones, resource, special only)
  let locationOptions = '<option value="global">🌍 Global (General Chat)</option>';
  const npcManagerLocations = [
    ...LOCATIONS_BY_TYPE.northern_safe,
    ...LOCATIONS_BY_TYPE.western_safe,
    ...LOCATIONS_BY_TYPE.northern_resource,
    ...LOCATIONS_BY_TYPE.western_resource,
    ...LOCATIONS_BY_TYPE.northern_special,
    ...LOCATIONS_BY_TYPE.western_special
  ];
  npcManagerLocations.forEach(loc => {
    const val = loc.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const selected = (existing.locationId || _currentNpcLocation) === val ? 'selected' : '';
    locationOptions += `<option value="${val}" ${selected}>${loc}</option>`;
  });

  // Example auto-responses (always include a default reply row)
  const EXAMPLE_AUTOS = [
    { trigger: "hello", reply: "Greetings, traveler!" },
    { trigger: "quest", reply: "I may have a task for you..." },
    { trigger: "help", reply: "How can I assist you on your journey?" },
    { trigger: "rumor", reply: "I've heard strange things near the old ruins." },
    { trigger: "shop", reply: "Take a look at my wares." },
    { trigger: "danger", reply: "Beware the woods at night." },
    { trigger: "deity", reply: "The gods watch over us all." },
    { trigger: "lost", reply: "You look lost. Need directions?" },
    { trigger: "reward", reply: "Complete my task and you'll be rewarded." },
    { trigger: "bye", reply: "Safe travels, friend." },
    { trigger: "", reply: "I'm not sure how to help, but I wish you luck!" }, // default reply row
  ];
  let autoRows = "";
  if (existing.autoResponses && existing.autoResponses.length) {
    autoRows = existing.autoResponses.map((r,i) => npcAutoRow(i, r.trigger, r.reply)).join("");
    // Ensure at least one default reply row exists
    if (!existing.autoResponses.some(r => !r.trigger)) {
      autoRows += npcAutoRow(Date.now(), "", "I'm not sure how to help, but I wish you luck!");
    }
  } else {
    autoRows = EXAMPLE_AUTOS.map((r,i) => npcAutoRow(i, r.trigger, r.reply)).join("");
  }

  modal.innerHTML = `
  <div class="deity-modal-box" style="max-width:520px">
    <div class="deity-modal-title">${isEdit?"✏️ Edit":"➕ New"} NPC</div>
    <div class="field-group" style="margin-bottom:10px">
      <label class="field-label">Location</label>
      <select class="field-input npc-select" id="dnpc-location">${locationOptions}</select>
    </div>
    <div class="field-group" style="margin-bottom:10px">
      <label class="field-label">Name</label>
      <input class="field-input" id="dnpc-name" value="${existing.name||""}" placeholder="NPC Name"/>
    </div>
    <div class="field-group" style="margin-bottom:10px">
      <label class="field-label">Avatar (emoji, image URL, or upload)</label>
      <input class="field-input" id="dnpc-avatar" value="${existing.avatar||""}" placeholder="🧙 or https://..." style="margin-bottom:6px"/>
      <label for="dnpc-avatar-file" class="custom-file-label" tabindex="0" style="display:inline-block;cursor:pointer;padding:6px 14px;background:linear-gradient(135deg,var(--gold-dim) 0%,var(--gold) 100%);color:var(--ink);font-family:var(--ff-display);font-size:0.85rem;letter-spacing:0.12em;font-weight:600;border-radius:var(--radius);border:none;transition:opacity 0.2s,transform 0.1s;outline:none;">Choose Image File</label>
      <input type="file" id="dnpc-avatar-file" accept="image/*" style="display:none"/>
      <span id="dnpc-avatar-filename" style="margin-left:12px;color:var(--text-dim);font-size:0.92em;"></span>
      <img id="dnpc-avatar-preview" src="" style="display:none;margin-top:8px;max-width:80px;max-height:80px;border-radius:50%;object-fit:cover;border:2px solid var(--gold)"/>
    </div>
    <div class="field-group" style="margin-bottom:10px">
      <label class="field-label">Description / Role</label>
      <input class="field-input" id="dnpc-desc" value="${existing.description||""}" placeholder="e.g. Blacksmith, Quest Giver"/>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:10px">
      <div class="field-group" style="flex:1;margin-bottom:0">
        <label class="field-label">Rank</label>
        <select class="field-input npc-select" id="dnpc-rank">
          <option value="">— None —</option>
          ${NPC_RANKS.map(r => `<option value="${r.value}" ${(existing.rank||"")===r.value?"selected":""}>${r.value} (${r.levels})</option>`).join("")}
        </select>
      </div>
      <div class="field-group" style="flex:1;margin-bottom:0">
        <label class="field-label">Level</label>
        <input class="field-input" id="dnpc-level" type="number" min="1" max="100" value="${existing.level||1}" placeholder="1"/>
      </div>
    </div>
    <div class="field-group" style="margin-bottom:10px">
      <label class="field-label">Class</label>
      <select class="field-input npc-select" id="dnpc-class" onchange="window._onDnpcClassOrRankChange()">
        <option value="">— None —</option>
        ${NPC_CLASSES.map(c=>`<option value="${c}" ${(existing.charClass||"")===c?"selected":""}>${c}</option>`).join("")}
      </select>
    </div>
    <div class="field-group" style="margin-bottom:10px">
      <label class="field-label">Skills
        <span style="color:var(--text-dim);font-size:0.75em"> — based on class &amp; rank</span>
      </label>
      <div id="dnpc-skill-picker" style="background:var(--ink2);border:1px solid var(--border);border-radius:8px;padding:10px;min-height:44px;max-height:200px;overflow-y:auto">
        <span style="color:var(--text-dim);font-size:0.8rem;font-style:italic">Select a class and rank above to see available skills.</span>
      </div>
    </div>
    <div style="font-family:var(--ff-mono);font-size:0.6rem;color:var(--gold);letter-spacing:0.1em;margin-bottom:6px">⚡ AUTO-RESPONSES</div>
    <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:8px">When a player @tags this NPC, matching trigger → auto-reply fires. Leave trigger blank for a default reply.</div>
    <div id="dnpc-auto-rows">${autoRows}</div>
    <button onclick="window._addDnpcRow()" style="font-size:0.75rem;background:none;border:1px dashed var(--border);color:var(--ash-light);border-radius:6px;padding:4px 12px;cursor:pointer;margin-bottom:14px">+ Add Response</button>
    <div class="form-error" id="dnpc-error" style="margin-bottom:8px"></div>
    <div style="display:flex;gap:10px">
      <button class="btn-primary"    onclick="window._saveDnpc('${npcId||""}')">💾 ${isEdit?"Save":"Create"}</button>
      <button class="btn-secondary"  onclick="document.getElementById('deity-npc-form-modal').remove()">Cancel</button>
    </div>
  </div>`;

  // Avatar file input logic
  const fileInput = modal.querySelector('#dnpc-avatar-file');
  const preview = modal.querySelector('#dnpc-avatar-preview');
  const filenameSpan = modal.querySelector('#dnpc-avatar-filename');
  fileInput?.addEventListener('change', function(e) {
    if (fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      filenameSpan.textContent = file.name;
      const reader = new FileReader();
      reader.onload = function(ev) {
        preview.src = ev.target.result;
        preview.style.display = 'block';
      };
      reader.readAsDataURL(file);
    } else {
      filenameSpan.textContent = '';
      preview.src = '';
      preview.style.display = 'none';
    }
  });
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });

  // ── Init custom selects on injected modal ────────────────────────────────
  if (typeof window.refreshCustomSelect === "function") {
    ["dnpc-location","dnpc-rank","dnpc-class"].forEach(id => {
      const el = document.getElementById(id);
      if (el) window.refreshCustomSelect(el);
    });
  }

  // ── Dynamic skill picker ───────────────────────────────────────────────────
  window._onDnpcClassOrRankChange = function() {
    const charClass = document.getElementById("dnpc-class")?.value;
    const rank      = document.getElementById("dnpc-rank")?.value;
    const picker    = document.getElementById("dnpc-skill-picker");
    if (!picker) return;
    if (!charClass) {
      picker.innerHTML = `<span style="color:var(--text-dim);font-size:0.8rem;font-style:italic">Select a class and rank above to see available skills.</span>`;
      return;
    }
    const available = getNpcAvailableSkills(charClass, rank);
    if (!available.length) {
      picker.innerHTML = `<span style="color:var(--text-dim);font-size:0.8rem;font-style:italic">No skills available yet.</span>`;
      return;
    }
    const prevChecked = Array.from(picker.querySelectorAll(".dnpc-skill-cb:checked")).map(cb => cb.value);
    const tierOf = skill => {
      const tree = NPC_SKILL_TREE[charClass] || {};
      return Object.entries(tree).find(([,list]) => list.includes(skill))?.[0] || "basic";
    };
    const tierColor = t => t === "advanced" ? "var(--gold)" : t === "intermediate" ? "#7ec87e" : "var(--ash-light)";
    picker.innerHTML = available.map(skill => {
      const tier    = tierOf(skill);
      const checked = (prevChecked.includes(skill) || (existing.skills||[]).includes(skill)) ? "checked" : "";
      return `<label style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer;user-select:none"
        onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background=''">
        <input type="checkbox" class="dnpc-skill-cb" value="${skill}" ${checked}
          style="width:15px;height:15px;accent-color:var(--gold);cursor:pointer;flex-shrink:0"/>
        <span style="font-size:0.85rem;flex:1">${skill}</span>
        <span style="font-size:0.62rem;color:${tierColor(tier)};text-transform:uppercase;letter-spacing:0.06em;font-family:var(--ff-mono)">${tier}</span>
      </label>`;
    }).join("");
  };

  // Hook rank dropdown to refresh skills
  document.getElementById("dnpc-rank")?.addEventListener("change", window._onDnpcClassOrRankChange);

  // Initialise picker if editing an existing NPC that has a class
  if (existing.charClass) {
    setTimeout(() => {
      window._onDnpcClassOrRankChange();
      // Re-apply saved skill selections after render
      setTimeout(() => {
        const saved = existing.skills || [];
        document.querySelectorAll("#dnpc-skill-picker .dnpc-skill-cb").forEach(cb => {
          cb.checked = saved.includes(cb.value);
        });
      }, 50);
    }, 0);
  }

  window._addDnpcRow = () => {
    const c = document.getElementById("dnpc-auto-rows");
    if (!c) return;
    const d = document.createElement("div");
    d.innerHTML = npcAutoRow(Date.now(),"","");
    c.appendChild(d.firstElementChild);
  };

  window._saveDnpc = async (npcId) => {
    const btn = document.querySelector("#deity-npc-form-modal .btn-primary");
    const btnOrig = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = npcId ? "Saving..." : "Creating..."; }
    const locSel = document.getElementById("dnpc-location");
    const locationId = locSel?.value || "global";
    if (!locationId) { window.showToast("Select a location first.", "error"); if (btn) { btn.disabled = false; btn.innerHTML = btnOrig; } return; }
    const name   = document.getElementById("dnpc-name")?.value.trim();
    let avatar = document.getElementById("dnpc-avatar")?.value.trim();
    const desc   = document.getElementById("dnpc-desc")?.value.trim();
    const errEl  = document.getElementById("dnpc-error");
    const fileInput = document.getElementById("dnpc-avatar-file");
    if (!name) { errEl.textContent = "NPC needs a name."; if (btn) { btn.disabled = false; btn.innerHTML = btnOrig; } return; }
    const autoResponses = [];
    document.querySelectorAll("#deity-npc-form-modal .dnpc-row").forEach(row => {
      const trigger = row.querySelector(".dnpc-trigger")?.value.trim();
      const reply   = row.querySelector(".dnpc-reply")?.value.trim();
      if (reply) autoResponses.push({ trigger: trigger||"", reply });
    });
    // If file selected, upload to Firebase Storage
    if (fileInput && fileInput.files && fileInput.files[0]) {
      try {
        const { ref: storageRef, uploadBytes, getDownloadURL } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js");
        const file = fileInput.files[0];
        const ext = file.name.split('.').pop() || 'jpg';
        const path = `npc-avatars/${locationId}_${Date.now()}_${file.name}`;
        const fileRef = storageRef(storage, path);
        await uploadBytes(fileRef, file);
        avatar = await getDownloadURL(fileRef);
      } catch(e) {
        errEl.textContent = 'Image upload failed: ' + (e.message || 'Unknown error');
        return;
      }
    }
    const rank      = document.getElementById("dnpc-rank")?.value || "";
    const level     = parseInt(document.getElementById("dnpc-level")?.value) || 1;
    const charClass = document.getElementById("dnpc-class")?.value || "";
    const skills    = Array.from(document.querySelectorAll("#dnpc-skill-picker .dnpc-skill-cb:checked")).map(cb => cb.value);
    const data = { name, avatar: avatar||"🧙", description: desc||"", autoResponses, locationId, updatedAt: serverTimestamp(),
      ...(rank      ? { rank, level } : {}),
      ...(charClass ? { charClass }   : {}),
      skills,
    };
    try {
      if (npcId) await setDoc(doc(db,"npcs",locationId,"list",npcId), data, { merge:true });
      else       await addDoc(collection(db,"npcs",locationId,"list"), data);
      document.getElementById("deity-npc-form-modal")?.remove();
      window.showToast(`${name} ${npcId?"updated":"created"}!`, "success");
      loadDeityNpcs(locationId);
    } catch(e) { errEl.textContent = e.message||"Failed."; if (btn) { btn.disabled = false; btn.innerHTML = btnOrig; } }
  };
}

function npcAutoRow(i, trigger, reply) {
  return `<div class="dnpc-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
    <input class="field-input dnpc-trigger" placeholder="Trigger keyword" value="${(trigger||"").replace(/"/g,"&quot;")}" style="flex:1;padding:5px 8px;font-size:0.8rem"/>
    <input class="field-input dnpc-reply"   placeholder="NPC reply..." value="${(reply||"").replace(/"/g,"&quot;")}" style="flex:2;padding:5px 8px;font-size:0.8rem"/>
    <button onclick="this.closest('.dnpc-row').remove()" style="background:none;border:none;color:var(--ash-light);cursor:pointer;font-size:1rem;padding:0 4px">✕</button>
  </div>`;
}

// ═══════════════════════════════════════════════════
//  RP CHAT (Deity)
// ═══════════════════════════════════════════════════
let _deityChatUnsub = null;
let _deityChatLocation = "";
let _deityLocationNpcs = [];

function initDeityChat() {
  const locSel = document.getElementById("deity-chat-location");
  if (!locSel || locSel.options.length > 1) return;

  const groups = [
    { label: "── Northern Safe Zones ──",         locs: LOCATIONS_BY_TYPE.northern_safe },
    { label: "── Western Safe Zones ──",           locs: LOCATIONS_BY_TYPE.western_safe },
    { label: "── Northern Resource Zones ──",      locs: LOCATIONS_BY_TYPE.northern_resource },
    { label: "── Western Resource Zones ──",       locs: LOCATIONS_BY_TYPE.western_resource },
    { label: "── Northern Special Locations ──",   locs: LOCATIONS_BY_TYPE.northern_special },
    { label: "── Western Special Locations ──",    locs: LOCATIONS_BY_TYPE.western_special },
  ];
  groups.forEach(({ label, locs }) => {
    const grp = document.createElement("optgroup");
    grp.label = label;
    locs.forEach(loc => {
      const o = document.createElement("option");
      o.value = loc.toLowerCase().replace(/[^a-z0-9]/g, "-");
      o.textContent = loc;
      grp.appendChild(o);
    });
    locSel.appendChild(grp);
  });
}

// ── Deity chat background images keyed by locationId slug ────────────────────
const DCHAT_LOCATION_BG = {
  // Northern Continent — safe zones
  "frostspire":           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrostspire.jpeg?alt=media&token=02a9f440-6dc2-4d30-b6dd-3393c156e6ca",
  "whitecrest":           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fwhitecrest_village.jpeg?alt=media&token=8dd42296-a946-481d-b26f-f4cac2b7d66c",
  "whitecrest-village":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fwhitecrest_village.jpeg?alt=media&token=8dd42296-a946-481d-b26f-f4cac2b7d66c",
  "icerun":               "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ficerun_hamlet.jpeg?alt=media&token=dfd74d98-9363-4514-a2cf-d4e10d1aaeb7",
  "icerun-hamlet":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ficerun_hamlet.jpeg?alt=media&token=dfd74d98-9363-4514-a2cf-d4e10d1aaeb7",
  "paleglow":             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fpaleglow_town.jpeg?alt=media&token=083ffc0b-2bfa-4708-92f4-ea1cac3f2390",
  "paleglow-town":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fpaleglow_town.jpeg?alt=media&token=083ffc0b-2bfa-4708-92f4-ea1cac3f2390",
  "mistveil":             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fmistveil_town.jpeg?alt=media&token=3fd261ca-b5d2-4096-8b0c-9c0f53e2c228",
  "mistveil-town":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Fmistveil_town.jpeg?alt=media&token=3fd261ca-b5d2-4096-8b0c-9c0f53e2c228",
  // Northern Continent — explore zones (all use wildlands)
  "frostfang":            "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "sheen-lake":           "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "misty-hollow":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "dark-cathedral":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "wisteria":             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "silver-lake":          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "hobbit-cave":          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "arctic-willow":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "dream-river":          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "suldan-mine":          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "shrine-of-secrets":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "aurora-basin":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "forgotten-estuary":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  "frost-wildlands":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Ffrostveil%2Ffrost_wildlands.jpeg?alt=media&token=6a811429-0b80-4be9-a10f-3a7b2f929420",
  // Western Continent — safe zones
  "solmere":              "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsolmere.jpeg?alt=media&token=d651b87b-c394-4aa7-8177-c533daa67da2",
  "sunpetal":             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsunpetal_village.jpeg?alt=media&token=da53581d-271c-4879-a40f-460c19a8879e",
  "sunpetal-village":     "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fsunpetal_village.jpeg?alt=media&token=da53581d-271c-4879-a40f-460c19a8879e",
  "basil":                "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fbasil_village.jpeg?alt=media&token=aaa9091c-6f79-4ddf-8136-2300dd7db9e8",
  "basil-village":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fbasil_village.jpeg?alt=media&token=aaa9091c-6f79-4ddf-8136-2300dd7db9e8",
  "riverend":             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Friverend_town.jpeg?alt=media&token=27721626-45d4-4b92-b089-24ae514b57f3",
  "riverend-town":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Friverend_town.jpeg?alt=media&token=27721626-45d4-4b92-b089-24ae514b57f3",
  "verdance":             "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdance_town.jpeg?alt=media&token=06f44360-80c6-422f-8877-74aec213608f",
  "verdance-town":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdance_town.jpeg?alt=media&token=06f44360-80c6-422f-8877-74aec213608f",
  // Western Continent — explore zones (all use wildlands)
  "whispering-forest":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "golden-plains":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "element-valley":       "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "defiled-sanctum":      "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "asahi-valley":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "moss-stream":          "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "argent-grotto":        "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "golden-river":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "shiny-cavern":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "purgatory-of-light":   "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "temple-of-verdict":    "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "heart-garden":         "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "valley-of-overflowing": "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
  "verdantis-wildlands":  "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/maps%2Fverdantis%2Fverdantis_wildlands.jpeg?alt=media&token=1897eed1-4719-4aeb-aed7-14be9434c38e",
};

function _applyDchatBg(locationId) {
  const win = document.querySelector(".dchat-window");
  if (!win) return;
  const url = DCHAT_LOCATION_BG[locationId];
  if (url) {
    win.style.backgroundImage    = `linear-gradient(rgba(10,10,14,0.70),rgba(10,10,14,0.70)),url('${url}')`;
    win.style.backgroundSize     = "cover";
    win.style.backgroundPosition = "center";
    win.style.backgroundRepeat   = "no-repeat";
  } else {
    win.style.backgroundImage = "";
  }
}

async function switchDeityChat(locationId) {
  if (!locationId) return;
  _deityChatLocation = locationId;

  // Clear any pending reply when changing location
  window._deityCancelReply?.();

  // Apply location background image
  _applyDchatBg(locationId);

  if (_deityChatUnsub) { _deityChatUnsub(); _deityChatUnsub = null; }
  if (window._dchatPresenceUnsub) { window._dchatPresenceUnsub(); window._dchatPresenceUnsub = null; }

  // Load NPCs for "speak as" dropdown
  const asSel = document.getElementById("deity-chat-as");
  if (asSel) {
    asSel.innerHTML = `<option value="self">Myself (${_deityChar?.name||"Deity"})</option>`;
    try {
      const npcSnap = await getDocs(collection(db, "npcs", locationId, "list"));
      _deityLocationNpcs = npcSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      _deityLocationNpcs.forEach(npc => {
        const o = document.createElement("option");
        o.value = `npc_${npc.id}`;
        o.textContent = `🧙 ${npc.name}`;
        asSel.appendChild(o);
      });
    } catch(e) { _deityLocationNpcs = []; }
  }

  // Live presence — who's currently in this location
  const bar  = document.getElementById("dchat-players-bar");
  const list = document.getElementById("dchat-players-list");
  if (bar && list) {
    window._dchatPresenceUnsub = onSnapshot(
      collection(db, "presence", locationId, "players"),
      snap => {
        // Filter stale docs in JS - no Firestore composite index needed
        const cutoff = Date.now() - 30 * 60 * 1000;
        const fresh = snap.docs.filter(d => {
          const ls = d.data().lastSeen;
          if (!ls) return true;
          const ms = ls.toMillis ? ls.toMillis() : new Date(ls).getTime();
          return ms >= cutoff;
        });
        if (!fresh.length) { bar.style.display = "none"; return; }
        bar.style.display = "flex";
        list.innerHTML = fresh.map(d => {
          const p = d.data();
          const av = p.avatarUrl?.startsWith("http")
            ? `<img src="${p.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
            : `<span style="font-size:0.9rem">${p.avatarUrl||"⚔️"}</span>`;
          const chipName = (p.name||'?').replace(/'/g,"\'");
          return `<div class="dchat-player-chip" onclick="window._openDchatPlayerPopup('${chipName}')" title="${p.name||"?"} · ${p.rank||"Wanderer"} Lv.${p.level||1}" style="cursor:pointer">
            <div class="dchat-player-av">${av}</div>
            <span class="dchat-player-name">${p.name||"?"}</span>
          </div>`;
        }).join("");
      }
    );
  }

  // Listen to chat messages
  const msgsRef = collection(db, "chats", locationId, "messages");
  const q = query(msgsRef, limit(60));
  const container = document.getElementById("deity-chat-messages");

  _deityChatUnsub = onSnapshot(q, { includeMetadataChanges: true }, snap => {
    if (!container) return;
    const docs = [];
    snap.forEach(d => docs.push(d));
    docs.sort((a, b) => {
      const ta = a.data().timestamp?.toMillis?.() ?? (a.metadata.hasPendingWrites ? Infinity : 0);
      const tb = b.data().timestamp?.toMillis?.() ?? (b.metadata.hasPendingWrites ? Infinity : 0);
      return ta - tb;
    });
    if (!docs.length) {
      container.innerHTML = `<div class="chat-empty"><span>✦</span><span>No messages in this location yet.</span></div>`;
      return;
    }
    container.innerHTML = "";
    docs.forEach(d => {
      const msg    = d.data();
      const docId  = d.id;
      const time   = msg.timestamp?.toDate?.() ? formatTime(msg.timestamp.toDate()) : "";
      const isNpc     = msg.isNpc;
      const isMyNpc   = isNpc && (msg.deityUid === _uid || _deityLocationNpcs.some(n => n.id === msg.npcId));
      const isMe      = msg.uid === _uid || isMyNpc;
      const av = msg.avatarUrl?.startsWith("http")
        ? `<img src="${msg.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
        : `<span style="font-size:1rem">${msg.avatarUrl||"⚔️"}</span>`;

      // ── Reply quote block ──────────────────────────────────────
      const replyQuoteHTML = msg.replyTo ? `
        <div class="chat-msg-reply-quote" onclick="window._deityJumpToMsg('${msg.replyTo.id}')">
          <div class="chat-msg-reply-quote-bar"></div>
          <div class="chat-msg-reply-quote-body">
            <div class="chat-msg-reply-quote-name">${escapeHtml(msg.replyTo.charName||'')}</div>
            <div class="chat-msg-reply-quote-text">${escapeHtml(msg.replyTo.text||'')}</div>
          </div>
        </div>` : '';

      const el = document.createElement("div");
      el.className = `chat-msg${isMe?" own":""}${isNpc?" npc-msg":""}`;
      el.dataset.msgId = docId;

      const locColPath = `chats/${locationId}/messages`;

      // ── WORLD EVENT bubble ────────────────────────────────────────
      if (msg.isWorldEvent && msg.uid === 'system') {
        const isUnexpected = msg.eventType === 'unexpected';
        el.className = `chat-msg world-event-msg world-event-${msg.eventType || 'unexpected'}`;
        el.innerHTML = `
          <div class="world-event-bubble">
            <div class="world-event-header">
              <span class="world-event-icon">${isUnexpected ? '⚡' : '📖'}</span>
              <span class="world-event-label">[${msg.eventLabel || (isUnexpected ? 'UNEXPECTED DEVELOPMENT' : 'LOGICAL DEVELOPMENT')}]</span>
              <span class="world-event-time">${time}</span>
            </div>
            <div class="world-event-text">${formatChatText(msg.text || '')}</div>
          </div>`;
        container.appendChild(el);
        return;
      }

      if (isMe) {
        el.innerHTML = `
          <div class="chat-msg-body">
            ${replyQuoteHTML}
            <div class="chat-msg-text ${isNpc?"npc-bubble own-npc":"own-text"}">${formatChatText(msg.text||"")}</div>
            <div class="chat-msg-actions">
              <button class="chat-action-btn" title="Edit" onclick="window._dchatStartEdit('${docId}','${locColPath}',this)">✏️</button>
              <button class="chat-action-btn" title="Delete" onclick="window._dchatDeleteMsg('${docId}','${locColPath}')">🗑️</button>
            </div>
            <div class="chat-msg-time own-time">${time}</div>
          </div>
          <div class="chat-msg-avatar ${isNpc?"npc-avatar":""}">${av}</div>`;
        const msgBody = el.querySelector(".chat-msg-body");
        let _ht = null;
        msgBody.addEventListener("mouseenter", () => { clearTimeout(_ht); msgBody.classList.add("msg-hovered"); });
        msgBody.addEventListener("mouseleave", () => { _ht = setTimeout(() => msgBody.classList.remove("msg-hovered"), 1500); });
        el.querySelector(".own-text, .npc-bubble.own-npc")?.addEventListener("touchstart", e => {
          e.stopPropagation();
          const isOpen = msgBody.classList.contains("msg-hovered");
          document.querySelectorAll(".chat-msg-body.msg-hovered").forEach(b => b.classList.remove("msg-hovered"));
          if (!isOpen) msgBody.classList.add("msg-hovered");
        }, { passive: true });
      } else if (isNpc) {
        el.innerHTML = `
          <div class="chat-msg-avatar npc-avatar">${av}</div>
          <div class="chat-msg-body">
            ${replyQuoteHTML}
            <div class="chat-msg-text npc-bubble">${formatChatText(msg.text||"")}</div>
          </div>`;
      } else {
        const safeName = escapeHtml(msg.charName||'');
        const safeText = escapeHtml(msg.text||'').replace(/'/g,"\\'");
        const locSafeName = (msg.charName||'').replace(/'/g,"\'");
        el.innerHTML = `
          <div class="chat-msg-avatar" onclick="window._openDchatPlayerPopup('${locSafeName}')" style="cursor:pointer">${av}</div>
          <div class="chat-msg-body">
            <div class="chat-msg-meta">
              <span class="chat-msg-time">${time}</span>
            </div>
            ${replyQuoteHTML}
            <div class="chat-msg-text">${formatChatText(msg.text||"")}</div>
            <button class="reply-btn" onclick="window._deityStartReply('${docId}','${safeName}','${safeText}')">↩ Reply</button>
            <button class="chat-action-btn" title="Delete" style="margin-left:4px" onclick="window._dchatDeleteMsg('${docId}','${locColPath}')">🗑️</button>
          </div>`;
      }
      _attachDchatMsgHover(el);
      container.appendChild(el);
    });
    container.scrollTop = container.scrollHeight;
  });
}

async function sendDeityChat() {
  const input  = document.getElementById("deity-chat-input");
  const text   = input?.value.trim();
  const asSel  = document.getElementById("deity-chat-as");
  const speakAs = asSel?.value || "self";
  if (!text || !_deityChatLocation) return;

  if (speakAs === "self") {
    // Send as the deity character
    const location = KNOWN_LOCATIONS.find(l => l.toLowerCase().replace(/[^a-z0-9]/g,"-") === _deityChatLocation) || _deityChatLocation;
    const payload = {
      uid:       _uid,
      charName:  _deityChar?.name || "Deity",
      avatarUrl: _deityChar?.avatarUrl || DEITY_ART[_deityChar?.charClass||""] || "✨",
      rank:      "Deity",
      level:     0,
      title:     DEITY_DATA[_deityChar?.charClass||""]?.title || "",
      location,
      text,
      timestamp: serverTimestamp(),
    };
    if (_deityReplyTo) payload.replyTo = _deityReplyTo;
    await addDoc(collection(db,"chats",_deityChatLocation,"messages"), payload);
  } else {
    // Send as an NPC — use real rank/level/class from NPC data
    const npcId = speakAs.replace("npc_","");
    const npc   = _deityLocationNpcs.find(n => n.id === npcId) || {};
    const payload = {
      uid:        `npc_${npcId}`,
      charName:   npc.name || "NPC",
      avatarUrl:  npc.avatar || "🧙",
      rank:       npc.rank || "NPC",
      level:      npc.level || 1,
      charClass:  npc.charClass || "",
      title:      npc.description || "",
      location:   _deityChatLocation,
      text,
      isNpc:      true,
      npcId,
      deityUid:   _uid,
      timestamp:  serverTimestamp(),
    };
    if (_deityReplyTo) payload.replyTo = _deityReplyTo;
    await addDoc(collection(db,"chats",_deityChatLocation,"messages"), payload);
  }
  if (input) input.value = "";
  window._deityCancelReply?.();
}

// ── Deity chat tab state ─────────────────────────────────────
let _deityChatTab = "location"; // "location" | "general"
let _deityChatGeneralUnsub = null;

window._switchDeityChatTab = function(tab) {
  _deityChatTab = tab;
  // Clear any pending reply when switching tabs
  window._deityCancelReply?.();
  document.getElementById("dchat-tab-location")?.classList.toggle("active", tab === "location");
  document.getElementById("dchat-tab-general")?.classList.toggle("active",  tab === "general");
  const controls        = document.getElementById("dchat-location-controls");
  const generalControls = document.getElementById("dchat-general-controls");
  const bar             = document.getElementById("dchat-players-bar");
  if (controls)        controls.style.display        = tab === "general" ? "none" : "";
  if (generalControls) generalControls.style.display = tab === "general" ? ""     : "none";
  // Show all-players bar on general tab; hide on location tab (presence handles location)
  if (bar) bar.style.display = tab === "general" ? "flex" : "none";
  if (tab === "general") { _dchatLoadAllPlayers(); _loadGeneralNpcs(); }

  const container = document.getElementById("deity-chat-messages");

  if (tab === "general") {
    // Stop location listener
    if (_deityChatUnsub) { _deityChatUnsub(); _deityChatUnsub = null; }
    if (window._dchatPresenceUnsub) { window._dchatPresenceUnsub(); window._dchatPresenceUnsub = null; }
    // Clear background
    if (container) container.style.backgroundImage = "";
    _startGeneralChatListener();
  } else {
    // Stop general listener
    if (_deityChatGeneralUnsub) { _deityChatGeneralUnsub(); _deityChatGeneralUnsub = null; }
    // Clear general chat background
    const win = document.querySelector(".dchat-window");
    if (win) win.style.backgroundImage = "";
    if (container) {
      container.innerHTML = `<div class="chat-empty"><span>✦</span><span>Select a location to view its chat.</span></div>`;
    }
    // Re-apply location chat if one was already selected
    const locSel = document.getElementById("deity-chat-location");
    if (locSel?.value) switchDeityChat(locSel.value);
  }
};

// ── General chat NPC identity cache ──────────────────────────────────────────
let _dchatGeneralNpcs = [];

async function _loadGeneralNpcs() {
  const sel = document.getElementById("deity-general-as");
  if (!sel) return;
  sel.innerHTML = `<option value="self">Myself (${_deityChar?.name || "Deity"})</option>`;
  _dchatGeneralNpcs = [];
  try {
    // Read directly from npcs/global/list — no collectionGroup needed
    const snap = await getDocs(collection(db, "npcs", "global", "list"));
    snap.forEach(d => {
      const npc = { id: d.id, ...d.data() };
      _dchatGeneralNpcs.push(npc);
      const o = document.createElement("option");
      o.value = `npc_${npc.id}`;
      o.textContent = `🧙 ${npc.name}`;
      sel.appendChild(o);
    });
  } catch(e) {
    console.warn("[_loadGeneralNpcs]", e);
  }
}

function _startGeneralChatListener() {
  const container = document.getElementById("deity-chat-messages");
  if (!container) return;
  container.innerHTML = `<div class="chat-empty"><span>✦</span><span>Loading general chat…</span></div>`;

  if (_deityChatGeneralUnsub) { _deityChatGeneralUnsub(); _deityChatGeneralUnsub = null; }

  // ── Apply general chat background (same as player dashboard) ────────────
  const win = document.querySelector(".dchat-window");
  if (win) {
    const GENERAL_BG = "https://firebasestorage.googleapis.com/v0/b/inkcraftrp.firebasestorage.app/o/general%20chat.jpg?alt=media&token=692fa815-c40f-4b8a-8b16-1017ab8af4ea";
    win.style.backgroundImage    = `linear-gradient(rgba(10,10,14,0.70),rgba(10,10,14,0.70)),url('${GENERAL_BG}')`;
    win.style.backgroundSize     = "cover";
    win.style.backgroundPosition = "center";
    win.style.backgroundRepeat   = "no-repeat";
  }

  const msgsRef = collection(db, "general-chat", "global", "messages");
  const q = query(msgsRef, limit(100));

  _deityChatGeneralUnsub = onSnapshot(q, { includeMetadataChanges: true }, snap => {
    if (!container) return;
    const docs = [];
    snap.forEach(d => docs.push(d));
    docs.sort((a, b) => {
      const ta = a.data().timestamp?.toMillis?.() ?? (a.metadata.hasPendingWrites ? Infinity : 0);
      const tb = b.data().timestamp?.toMillis?.() ?? (b.metadata.hasPendingWrites ? Infinity : 0);
      return ta - tb;
    });
    if (!docs.length) {
      container.innerHTML = `<div class="chat-empty"><span>✦</span><span>No general chat messages yet.</span></div>`;
      return;
    }
    container.innerHTML = "";
    docs.forEach(d => {
      const msg     = d.data();
      const docId   = d.id;
      const time    = msg.timestamp?.toDate?.() ? formatTime(msg.timestamp.toDate()) : "";
      const isNpc   = !!msg.isNpc;
      const isMyNpc = isNpc && msg.deityUid === _uid;
      const isMe    = msg.uid === _uid || isMyNpc;
      const av      = msg.avatarUrl?.startsWith("http")
        ? `<img src="${msg.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
        : `<span style="font-size:1rem">${msg.avatarUrl || "⚔️"}</span>`;

      // ── Reply quote ──────────────────────────────────────────────
      const replyQuoteHTML = msg.replyTo ? `
        <div class="chat-msg-reply-quote" onclick="window._deityJumpToMsg('${msg.replyTo.id}')">
          <div class="chat-msg-reply-quote-bar"></div>
          <div class="chat-msg-reply-quote-body">
            <div class="chat-msg-reply-quote-name">${escapeHtml(msg.replyTo.charName||'')}</div>
            <div class="chat-msg-reply-quote-text">${escapeHtml(msg.replyTo.text||'')}</div>
          </div>
        </div>` : '';

      const el = document.createElement("div");
      el.className = `chat-msg${isMe ? " own" : ""}${isNpc ? " npc-msg" : ""}`;
      el.dataset.msgId = docId;

      // ── WORLD EVENT bubble ────────────────────────────────────────
      if (msg.isWorldEvent && msg.uid === 'system') {
        const isUnexpected = msg.eventType === 'unexpected';
        el.className = `chat-msg world-event-msg world-event-${msg.eventType || 'unexpected'}`;
        el.innerHTML = `
          <div class="world-event-bubble">
            <div class="world-event-header">
              <span class="world-event-icon">${isUnexpected ? '⚡' : '📖'}</span>
              <span class="world-event-label">[${msg.eventLabel || (isUnexpected ? 'UNEXPECTED DEVELOPMENT' : 'LOGICAL DEVELOPMENT')}]</span>
              <span class="world-event-time">${time}</span>
            </div>
            <div class="world-event-text">${formatChatText(msg.text || '')}</div>
          </div>`;
        container.appendChild(el);
      return;
      }

      const gcColPath = `general-chat/global/messages`;

      if (isMe) {
        el.innerHTML = `
          <div class="chat-msg-body">
            ${replyQuoteHTML}
            <div class="chat-msg-text ${isNpc ? "npc-bubble own-npc" : "own-text"}">${formatChatText(msg.text || "")}</div>
            <div class="chat-msg-actions">
              <button class="chat-action-btn" title="Edit" onclick="window._dchatStartEdit('${docId}','${gcColPath}',this)">✏️</button>
              <button class="chat-action-btn" title="Delete" onclick="window._dchatDeleteMsg('${docId}','${gcColPath}')">🗑️</button>
            </div>
            <div class="chat-msg-time own-time">${time}</div>
          </div>
          <div class="chat-msg-avatar ${isNpc ? "npc-avatar" : ""}">${av}</div>`;
        const msgBody = el.querySelector(".chat-msg-body");
        let _ht = null;
        msgBody.addEventListener("mouseenter", () => { clearTimeout(_ht); msgBody.classList.add("msg-hovered"); });
        msgBody.addEventListener("mouseleave", () => { _ht = setTimeout(() => msgBody.classList.remove("msg-hovered"), 1500); });
        el.querySelector(".own-text, .npc-bubble.own-npc")?.addEventListener("touchstart", e => {
          e.stopPropagation();
          const isOpen = msgBody.classList.contains("msg-hovered");
          document.querySelectorAll(".chat-msg-body.msg-hovered").forEach(b => b.classList.remove("msg-hovered"));
          if (!isOpen) msgBody.classList.add("msg-hovered");
        }, { passive: true });
      } else if (isNpc) {
        el.innerHTML = `
          <div class="chat-msg-avatar npc-avatar">${av}</div>
          <div class="chat-msg-body">
            ${replyQuoteHTML}
            <div class="chat-msg-text npc-bubble">${formatChatText(msg.text||"")}</div>
          </div>`;
      } else {
        const safeName   = escapeHtml(msg.charName||'');
        const safeText   = escapeHtml(msg.text||'').replace(/'/g,"\\'");
        const gcSafeName = (msg.charName||'').replace(/'/g,"\'");
        el.innerHTML = `
          <div class="chat-msg-avatar" onclick="window._openDchatPlayerPopup('${gcSafeName}')" style="cursor:pointer">${av}</div>
          <div class="chat-msg-body">
            <div class="chat-msg-meta">
              <span class="chat-msg-time">${time}</span>
            </div>
            ${msg.location ? `<div class="chat-msg-location">📍 ${escapeHtml(msg.location)}</div>` : ""}
            ${replyQuoteHTML}
            <div class="chat-msg-text">${formatChatText(msg.text || "")}</div>
            <button class="reply-btn" onclick="window._deityStartReply('${docId}','${safeName}','${safeText}')">↩ Reply</button>
            <button class="chat-action-btn" title="Delete" style="margin-left:4px" onclick="window._dchatDeleteMsg('${docId}','${gcColPath}')">🗑️</button>
          </div>`;
      }
      _attachDchatMsgHover(el);
      container.appendChild(el);
    });
    container.scrollTop = container.scrollHeight;
  });
}

// Patch sendDeityChat to handle general tab (with replyTo + cancel)
const _origSendDeityChat = sendDeityChat;
async function sendDeityChatPatched() {
  if (_deityChatTab === "general") {
    const input   = document.getElementById("deity-chat-input");
    const text    = input?.value.trim();
    if (!text) return;
    const speakAs = document.getElementById("deity-general-as")?.value || "self";
    let payload;
    if (speakAs === "self") {
      payload = {
        uid:       _uid,
        charName:  _deityChar?.name || "Deity",
        avatarUrl: _deityChar?.avatarUrl || DEITY_ART[_deityChar?.charClass || ""] || "✨",
        rank:      "Deity",
        level:     0,
        title:     DEITY_DATA[_deityChar?.charClass || ""]?.title || "",
        text,
        timestamp: serverTimestamp(),
      };
    } else {
      const npcId = speakAs.replace("npc_", "");
      const npc   = _dchatGeneralNpcs.find(n => n.id === npcId) || {};
      payload = {
        uid:       `npc_${npcId}`,
        charName:  npc.name  || "NPC",
        avatarUrl: npc.avatar || "🧙",
        rank:      npc.rank || "NPC",
        level:     npc.level || 1,
        charClass: npc.charClass || "",
        title:     npc.description || "",
        text,
        isNpc:     true,
        npcId,
        deityUid:  _uid,
        timestamp: serverTimestamp(),
      };
    }
    if (_deityReplyTo) payload.replyTo = _deityReplyTo;
    await addDoc(collection(db, "general-chat", "global", "messages"), payload);
    if (input) input.value = "";
    window._deityCancelReply?.();
  } else {
    await _origSendDeityChat();
  }
}
window._sendDeityChat = sendDeityChatPatched;

// ═══════════════════════════════════════════════════
//  BOSS / RAID MANAGER (Deity)
// ═══════════════════════════════════════════════════

let _deityBossUnsub = null;

function initDeityRaids() {
  _loadDeityBosses();

  // ── Seed one blank ability slot on form load ───────────────
  _populateAbilitySlots([]);

  // ── Image file preview ──────────────────────────────────
  const bossFileInput  = document.getElementById("boss-image-file");
  const bossPreview    = document.getElementById("boss-image-preview");
  const bossFilename   = document.getElementById("boss-image-filename");
  if (bossFileInput) {
    bossFileInput.addEventListener("change", function() {
      if (bossFileInput.files && bossFileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = ev => {
          if (bossPreview) { bossPreview.src = ev.target.result; bossPreview.style.display = "block"; }
        };
        reader.readAsDataURL(bossFileInput.files[0]);
        if (bossFilename) bossFilename.textContent = bossFileInput.files[0].name;
      }
    });
  }
  // Accessibility: label triggers file input on Enter/Space
  const bossImageLabel = document.getElementById("boss-image-label");
  if (bossImageLabel && bossFileInput) {
    bossImageLabel.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bossFileInput.click(); }
    });
  }

  window._toggleBossForm = function() {
    const body  = document.getElementById("boss-form-body");
    const arrow = document.getElementById("boss-form-arrow");
    if (!body) return;
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "";
    if (arrow) arrow.textContent = open ? "▶" : "▼";
  };

  window._cancelBossEdit = function() {
    document.getElementById("boss-edit-id").value = "";
    ["boss-name","boss-icon","boss-desc","boss-hp","boss-atk","boss-def"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = id === "boss-icon" ? "👹" : "";
    });
    // Reset ability slots to one blank
    _populateAbilitySlots([]);
    // Clear image state
    document.getElementById("boss-image-current").value = "";
    const bossFileInput = document.getElementById("boss-image-file");
    if (bossFileInput) bossFileInput.value = "";
    const bossPreview = document.getElementById("boss-image-preview");
    if (bossPreview) { bossPreview.src = ""; bossPreview.style.display = "none"; }
    const bossFilename = document.getElementById("boss-image-filename");
    if (bossFilename) bossFilename.textContent = "";
    const currentWrap = document.getElementById("boss-image-current-wrap");
    if (currentWrap) currentWrap.style.display = "none";
    const saveBtn = document.getElementById("boss-save-btn");
    if (saveBtn) saveBtn.textContent = "CREATE BOSS";
    const toggle = document.getElementById("boss-form-toggle");
    if (toggle) { const span = toggle.querySelector("span"); if (span) span.textContent = "👹 CREATE NEW BOSS"; }
    const errEl = document.getElementById("boss-form-error");
    if (errEl) errEl.textContent = "";
  };

  window._saveBoss = _saveBoss;
  window._editBoss = _editBoss;
  window._deleteBoss = _deleteBoss;
  window._toggleBossActive = _toggleBossActive;
}

function _loadDeityBosses() {
  const listEl = document.getElementById("deity-boss-list");
  if (!listEl) return;
  if (_deityBossUnsub) { _deityBossUnsub(); _deityBossUnsub = null; }
  _deityBossUnsub = onSnapshot(
    collection(db, "bosses"),
    snap => {
      if (snap.empty) {
        listEl.innerHTML = `<p style="color:var(--text-dim);font-style:italic;font-size:0.85rem">No custom bosses yet. Create the first one above.</p>`;
        return;
      }
      listEl.innerHTML = snap.docs.map(d => {
        const b = { id: d.id, ...d.data() };
        const abilitiesHTML = Array.isArray(b.abilities) && b.abilities.length
          ? `<div style="display:flex;flex-wrap:wrap;margin-top:4px">${b.abilities.map(a => {
              const name = typeof a === 'object' ? (a.name || '—') : String(a);
              const type = typeof a === 'object' ? (a.type || 'basic') : 'basic';
              return `<span class="boss-ability-pill">${name} <span class="boss-ability-pill-type">${type}</span></span>`;
            }).join('')}</div>`
          : `<span style="color:var(--text-dim);font-size:0.78rem">No abilities listed.</span>`;
        const badge = b.active !== false
          ? `<span class="boss-active-badge">ACTIVE</span>`
          : `<span class="boss-inactive-badge">INACTIVE</span>`;
        return `
        <div class="boss-card">
          <div class="boss-card-icon">${b.imageUrl ? `<img src="${b.imageUrl}" style="width:64px;height:64px;object-fit:cover;border-radius:10px;border:2px solid var(--gold-dim)"/>` : (b.icon || "👹")}</div>
          <div class="boss-card-info">
            <div class="boss-card-name">${b.name}${badge}</div>
            <div class="boss-card-desc">${b.desc || ""}</div>
            <div class="boss-card-stats">HP: ${b.base?.hp || "—"} · ATK: ${b.base?.atk || "—"} · DEF: ${b.base?.def || "—"}</div>
            ${abilitiesHTML}
          </div>
          <div class="boss-card-actions">
            <button class="deity-mini-btn" onclick="window._editBoss('${b.id}')">✏️ Edit</button>
            <button class="deity-mini-btn ${b.active !== false ? 'danger' : 'success'}" onclick="window._toggleBossActive('${b.id}',${!(b.active !== false)})">${b.active !== false ? "Deactivate" : "Activate"}</button>
            <button class="deity-mini-btn danger" onclick="window._deleteBoss('${b.id}','${(b.name || "").replace(/'/g, "\\'")}')">🗑️ Delete</button>
          </div>
        </div>`;
      }).join("");
    }
  );
}

// ── Ability slot helpers ──────────────────────────────────────────────────────

const ABILITY_MECHANIC_TYPES = [
  { value: 'aoe',       label: 'AoE — hits all' },
  { value: 'drain',     label: 'Drain — steal HP' },
  { value: 'freeze',    label: 'Freeze — skip turn' },
  { value: 'weaken',    label: 'Weaken — reduce ATK' },
  { value: 'enrage',    label: 'Enrage — boss +ATK' },
  { value: 'shield',    label: 'Shield — 50% dmg resist' },
  { value: 'instakill', label: 'Instakill — 15% one-shot' },
  { value: 'heal',      label: 'Heal — boss regains HP' },
  { value: 'teleport',  label: 'Teleport — true dmg, bypasses def' },
  { value: 'summon',    label: 'Summon — 2–4 minion strikes' },
  { value: 'curse',     label: 'Curse — detonates if target acts' },
  { value: 'reflect',   label: 'Reflect — mirrors 40% dmg back' },
  { value: 'berserk',   label: 'Berserk — rage at ≤30% HP' },
  { value: 'silence',   label: 'Silence — blocks skills 1 turn' },
  { value: 'execute',   label: 'Execute — kills target below 20% HP' },
  { value: 'blind',     label: 'Blind — 60% miss chance next atk' },
  { value: 'leech',     label: 'Leech — AoE drain, boss heals total' },
  { value: 'basic',     label: 'Basic — single target' },
  { value: 'wormhole',  label: 'Wormhole — true AoE, all party, ignores DEF' },
  { value: 'timewarp',  label: 'Time Warp — boss acts twice in a row' },
  { value: 'petrify',   label: 'Petrify — freeze target for 2 turns' },
  { value: 'shatter',   label: 'Shatter — permanently breaks target DEF' },
  { value: 'doommark',  label: 'Doom Mark — die in 3 turns if boss lives' },
];

function _mechanicOptions(selected) {
  return ABILITY_MECHANIC_TYPES.map(t =>
    `<option value="${t.value}"${t.value === selected ? ' selected' : ''}>${t.label}</option>`
  ).join('');
}

window._addAbilitySlot = function(name = '', type = 'basic') {
  const container = document.getElementById('boss-ability-slots');
  if (!container) return;
  if (container.children.length >= 5) {
    window.showToast('Maximum 5 abilities allowed.', 'error'); return;
  }
  const slot = document.createElement('div');
  slot.className = 'ability-slot';
  slot.innerHTML = `
    <input class="ability-slot-name" type="text" maxlength="60" placeholder="e.g. Rain of Cursed Coins" value="${name.replace(/"/g,'&quot;')}"/>
    <select class="ability-slot-type">${_mechanicOptions(type)}</select>
    <button class="ability-slot-remove" type="button" onclick="this.closest('.ability-slot').remove()">✕</button>
  `;
  container.appendChild(slot);
};

function _readAbilitySlots() {
  const slots = document.querySelectorAll('.ability-slot');
  return Array.from(slots).map(slot => ({
    name: slot.querySelector('.ability-slot-name')?.value.trim() || '',
    type: slot.querySelector('.ability-slot-type')?.value || 'basic',
  })).filter(a => a.name);
}

function _populateAbilitySlots(abilities) {
  const container = document.getElementById('boss-ability-slots');
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(abilities) || abilities.length === 0) {
    window._addAbilitySlot('', 'basic');
    return;
  }
  abilities.forEach(a => {
    // Support both structured { name, type } and legacy plain strings
    if (typeof a === 'object' && a !== null) {
      window._addAbilitySlot(a.name || '', a.type || 'basic');
    } else {
      window._addAbilitySlot(String(a), 'basic');
    }
  });
}

async function _saveBoss() {
  const editId    = document.getElementById("boss-edit-id")?.value.trim();
  const name      = document.getElementById("boss-name")?.value.trim();
  const icon      = document.getElementById("boss-icon")?.value.trim() || "👹";
  const desc      = document.getElementById("boss-desc")?.value.trim();
  const abilities = _readAbilitySlots();
  const hp        = parseInt(document.getElementById("boss-hp")?.value) || 1000;
  const atk       = parseInt(document.getElementById("boss-atk")?.value) || 70;
  const def       = parseInt(document.getElementById("boss-def")?.value) || 35;
  const fileInput = document.getElementById("boss-image-file");
  const currentImageUrl = document.getElementById("boss-image-current")?.value || "";
  const errEl     = document.getElementById("boss-form-error");
  const saveBtn   = document.getElementById("boss-save-btn");
  const origText  = saveBtn?.textContent;
  if (errEl) errEl.textContent = "";
  if (!name) { if (errEl) errEl.textContent = "Enter a boss name."; return; }
  if (abilities.length === 0) { if (errEl) errEl.textContent = "Add at least one ability with a name."; return; }
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = editId ? "Saving..." : "Creating..."; }
  try {
    const bossId = editId || name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

    // ── Image upload ──────────────────────────────────────
    let imageUrl = currentImageUrl; // keep existing if no new file chosen
    if (fileInput && fileInput.files && fileInput.files[0]) {
      if (saveBtn) saveBtn.textContent = "Uploading image...";
      const file = fileInput.files[0];
      const ext  = file.name.split(".").pop() || "jpg";
      const path = `boss-images/${bossId}.${ext}`;
      const fileRef = storageRef(storage, path);
      await uploadBytes(fileRef, file);
      imageUrl = await getDownloadURL(fileRef);
    }

    const data = {
      id:        bossId,
      name,
      icon,
      imageUrl:  imageUrl || "",
      desc:      desc || "",
      abilities,    // structured: [{ name, type }]
      base:      { hp, atk, def },
      active:    true,
      createdBy: _uid,
      updatedAt: serverTimestamp(),
    };
    if (editId) {
      await setDoc(doc(db, "bosses", editId), data, { merge: true });
      window.showToast(`Boss "${name}" updated!`, "success");
    } else {
      data.createdAt = serverTimestamp();
      await setDoc(doc(db, "bosses", bossId), data);
      window.showToast(`Boss "${name}" created!`, "success");
    }
    window._cancelBossEdit?.();
    const body  = document.getElementById("boss-form-body");
    const arrow = document.getElementById("boss-form-arrow");
    if (body)  body.style.display = "none";
    if (arrow) arrow.textContent  = "▶";
  } catch(e) {
    if (errEl) errEl.textContent = e.message || "Failed to save boss.";
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = origText; }
  }
}

function _editBoss(bossDocId) {
  getDoc(doc(db, "bosses", bossDocId)).then(snap => {
    if (!snap.exists()) { window.showToast("Boss not found.", "error"); return; }
    const b = snap.data();
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    setVal("boss-edit-id",    snap.id);
    setVal("boss-name",       b.name || "");
    setVal("boss-icon",       b.icon || "👹");
    setVal("boss-desc",       b.desc || "");
    _populateAbilitySlots(b.abilities || []);
    setVal("boss-hp",         b.base?.hp ?? "");
    setVal("boss-atk",        b.base?.atk ?? "");
    setVal("boss-def",        b.base?.def ?? "");

    // ── Populate image state ──────────────────────────────
    setVal("boss-image-current", b.imageUrl || "");
    // Clear any previously chosen file
    const fileInput = document.getElementById("boss-image-file");
    if (fileInput) fileInput.value = "";
    const newPreview = document.getElementById("boss-image-preview");
    if (newPreview) { newPreview.src = ""; newPreview.style.display = "none"; }
    const filename = document.getElementById("boss-image-filename");
    if (filename) filename.textContent = "";
    // Show existing image if present
    const currentWrap    = document.getElementById("boss-image-current-wrap");
    const currentPreview = document.getElementById("boss-image-current-preview");
    if (b.imageUrl) {
      if (currentPreview) currentPreview.src = b.imageUrl;
      if (currentWrap)    currentWrap.style.display = "block";
    } else {
      if (currentWrap) currentWrap.style.display = "none";
    }

    const saveBtn = document.getElementById("boss-save-btn");
    if (saveBtn) saveBtn.textContent = "SAVE CHANGES";
    const toggle = document.getElementById("boss-form-toggle");
    if (toggle) { const span = toggle.querySelector("span"); if (span) span.textContent = `✏️ EDITING: ${b.name}`; }
    const body  = document.getElementById("boss-form-body");
    const arrow = document.getElementById("boss-form-arrow");
    if (body)  body.style.display = "";
    if (arrow) arrow.textContent  = "▼";
    body?.scrollIntoView({ behavior: "smooth", block: "start" });
  }).catch(e => window.showToast("Failed to load boss: " + e.message, "error"));
}

async function _deleteBoss(bossDocId, bossName) {
  if (!confirm(`Delete boss "${bossName}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "bosses", bossDocId));
    window.showToast(`Boss "${bossName}" deleted.`, "success");
  } catch(e) {
    window.showToast("Failed to delete boss: " + e.message, "error");
  }
}

async function _toggleBossActive(bossDocId, makeActive) {
  try {
    await updateDoc(doc(db, "bosses", bossDocId), { active: makeActive });
    window.showToast(makeActive ? "Boss activated — players can now fight it." : "Boss deactivated.", "success");
  } catch(e) {
    window.showToast("Failed to update boss: " + e.message, "error");
  }
}

// ── Chat edit / delete helpers ────────────────────────────────────────────────

function inkConfirm(message) {
  document.getElementById("ink-confirm-modal")?.remove();
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.id = "ink-confirm-modal";
    overlay.className = "ink-confirm-overlay";
    overlay.innerHTML = `
      <div class="ink-confirm-box">
        <p class="ink-confirm-msg">${message}</p>
        <div class="ink-confirm-btns">
          <button class="ink-confirm-cancel">Cancel</button>
          <button class="ink-confirm-ok">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector(".ink-confirm-cancel").onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector(".ink-confirm-ok").onclick    = () => { overlay.remove(); resolve(true);  };
    overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

window._dchatDeleteMsg = async function(docId, colPath) {
  const confirmed = await inkConfirm("Delete this message?");
  if (!confirmed) return;
  try {
    await deleteDoc(doc(db, colPath, docId));
  } catch(e) {
    window.showToast("Failed to delete message.", "error");
  }
};

window._dchatStartEdit = function(docId, colPath, btn) {
  const body      = btn.closest(".chat-msg-body");
  const textEl    = body.querySelector(".own-text, .npc-bubble.own-npc");
  const actionsEl = body.querySelector(".chat-msg-actions");
  if (!textEl) return;
  const rawText = textEl.innerText;

  textEl.style.display    = "none";
  actionsEl.style.display = "none";

  const wrapper = document.createElement("div");
  wrapper.className = "chat-edit-wrapper";
  wrapper.innerHTML = `
    <textarea class="chat-edit-input">${rawText}</textarea>
    <div class="chat-edit-btns">
      <button class="chat-edit-save">Save</button>
      <button class="chat-edit-cancel">Cancel</button>
    </div>`;
  body.insertBefore(wrapper, textEl);

  const ta = wrapper.querySelector("textarea");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  wrapper.querySelector(".chat-edit-cancel").onclick = () => {
    wrapper.remove();
    textEl.style.display    = "";
    actionsEl.style.display = "";
  };
  wrapper.querySelector(".chat-edit-save").onclick = async () => {
    const newText = ta.value.trim();
    if (!newText) return;
    try {
      await updateDoc(doc(db, colPath, docId), { text: newText, edited: true });
      wrapper.remove();
      textEl.style.display    = "";
      actionsEl.style.display = "";
    } catch(e) {
      window.showToast("Failed to edit message.", "error");
    }
  };
};

function formatTime(date) {
  const h = date.getHours(), m = date.getMinutes();
  return `${h%12||12}:${String(m).padStart(2,"0")} ${h<12?"AM":"PM"}`;
}

function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── @mention highlighter (mirrors player dashboard) ──────────────────────────
function formatChatText(str) {
  return escapeHtml(str).replace(
    /@([A-Za-z0-9_][A-Za-z0-9_\- ]{1,31})(?=[^A-Za-z0-9_\- ]|$)/g,
    '<span class="chat-mention">@$1</span>'
  );
}

// ── Deity reply state & helpers ───────────────────────────────────────────────
let _deityReplyTo = null; // { id, charName, text }

window._deityStartReply = function(msgId, charName, text) {
  _deityReplyTo = { id: msgId, charName, text };
  const bar = document.getElementById('dchat-replying-to');
  if (!bar) return;
  bar.style.display = 'flex';
  bar.innerHTML = `
    <div class="dchat-replying-to-accent"></div>
    <div class="dchat-replying-to-content">
      <div class="dchat-replying-to-name">${escapeHtml(charName)}</div>
      <div class="dchat-replying-to-text">${escapeHtml(text)}</div>
    </div>
    <button class="dchat-cancel-reply" onclick="window._deityCancelReply()" title="Cancel reply">✕</button>`;
  document.getElementById('deity-chat-input')?.focus();
};

window._deityCancelReply = function() {
  _deityReplyTo = null;
  const bar = document.getElementById('dchat-replying-to');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
};

window._deityJumpToMsg = function(msgId) {
  const el = document.querySelector(`#deity-chat-messages [data-msg-id="${msgId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.transition = 'background 0.3s';
  el.style.background = 'rgba(37,211,102,0.18)';
  setTimeout(() => { el.style.background = ''; }, 1200);
};
// ═══════════════════════════════════════════════════════════════════════════
//  DEITY CHAT — PLAYER POPUP + ALL-PLAYERS BAR + HOVER/TOUCH REPLY
// ═══════════════════════════════════════════════════════════════════════════

// ── Hover/touch toggle for reply button visibility ────────────────────────
function _attachDchatMsgHover(el) {
  const body = el.querySelector('.chat-msg-body');
  if (!body) return;
  // Desktop hover — handled by CSS (.chat-msg:hover .reply-btn)
  // Mobile touch — toggle msg-hovered class
  el.addEventListener('touchstart', () => {
    // Remove from any other msg first
    document.querySelectorAll('#deity-chat-messages .chat-msg-body.msg-hovered')
      .forEach(b => { if (b !== body) b.classList.remove('msg-hovered'); });
    body.classList.toggle('msg-hovered');
  }, { passive: true });
}

// ── Player popup: open / close / speak action ─────────────────────────────
let _dchatPopupTargetName = null;

window._openDchatPlayerPopup = function(name) {
  _dchatPopupTargetName = name;
  const popup = document.getElementById('dchat-player-popup');
  const label = document.getElementById('dchat-popup-player-name');
  if (label) label.textContent = name;
  if (popup) popup.style.display = 'flex';
};

window._closeDchatPlayerPopup = function() {
  _dchatPopupTargetName = null;
  const popup = document.getElementById('dchat-player-popup');
  if (popup) popup.style.display = 'none';
};

window._dchatSpeakToPlayer = function() {
  if (!_dchatPopupTargetName) return;
  const input = document.getElementById('deity-chat-input');
  if (input) {
    const tag = `@${_dchatPopupTargetName} `;
    // Append tag if not already at start, else just focus
    if (!input.value.startsWith(tag)) {
      input.value = tag + input.value.replace(new RegExp(`^@${_dchatPopupTargetName}\\s*`), '');
    }
    input.focus();
    // Place cursor at end
    input.selectionStart = input.selectionEnd = input.value.length;
  }
  window._closeDchatPlayerPopup();
};

// ── Load all active players for the general tab bar ───────────────────────
async function _dchatLoadAllPlayers() {
  const bar  = document.getElementById('dchat-players-bar');
  const list = document.getElementById('dchat-players-list');
  if (!bar || !list) return;

  list.innerHTML = '<span style="font-size:0.72rem;color:var(--text-dim);font-style:italic">Loading…</span>';
  bar.style.display = 'flex';

  try {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30-min presence window
    // Fetch all presence subcollections via characters collection instead
    const charsSnap = await getDocs(
      query(collection(db, 'characters'), limit(80))
    );
    const players = [];
    charsSnap.forEach(d => {
      const p = d.data();
      // Skip deities
      if (p.role === 'deity') return;
      // Use lastSeen from character doc if available
      const ls = p.lastSeen;
      if (ls) {
        const ms = ls.toMillis ? ls.toMillis() : new Date(ls).getTime();
        if (ms < cutoff) return;
      }
      players.push({ uid: d.id, ...p });
    });

    if (!players.length) {
      list.innerHTML = '<span style="font-size:0.72rem;color:var(--text-dim);font-style:italic">No active players</span>';
      return;
    }

    list.innerHTML = players.map(p => {
      const av = p.avatarUrl?.startsWith('http')
        ? `<img src="${p.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : `<span style="font-size:0.85rem">${p.avatarUrl || '⚔️'}</span>`;
      const chipName = (p.name || '?').replace(/'/g, "\\'");
      return `<div class="dchat-player-chip" onclick="window._openDchatPlayerPopup('${chipName}')"
        title="${p.name||'?'} · ${p.rank||'Wanderer'} Lv.${p.level||1}" style="cursor:pointer">
        <div class="dchat-player-av">${av}</div>
        <span class="dchat-player-name">${p.name||'?'}</span>
      </div>`;
    }).join('');
  } catch(e) {
    console.warn('[_dchatLoadAllPlayers]', e);
    list.innerHTML = '<span style="font-size:0.72rem;color:var(--text-dim);font-style:italic">Could not load players</span>';
  }
}