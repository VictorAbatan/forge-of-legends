// ═══════════════════════════════════════
//  INKCRAFT RP — Custom Select Dropdown
//  js/custom-select.js
//
//  Wraps a native <select> in a fully styled
//  custom dropdown. The native select stays in
//  the DOM (hidden) so all existing JS that
//  reads/writes .value keeps working unchanged.
//
//  Usage:
//    initCustomSelect(document.getElementById('my-select'));
//
//  To refresh options after JS repopulates the select:
//    refreshCustomSelect(document.getElementById('my-select'));
// ═══════════════════════════════════════

let _openDropdown = null; // currently open dropdown wrapper

// Close any open dropdown when clicking outside
document.addEventListener('click', e => {
  if (_openDropdown && !_openDropdown.contains(e.target)) {
    _closeDropdown(_openDropdown);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _openDropdown) _closeDropdown(_openDropdown);
});

function _closeDropdown(wrapper) {
  wrapper.classList.remove('csel-open');
  _openDropdown = null;
}

function _buildPanel(wrapper, select) {
  const panel = wrapper.querySelector('.csel-panel');
  panel.innerHTML = '';

  const options = Array.from(select.children);
  options.forEach(child => {
    if (child.tagName === 'OPTGROUP') {
      // Group label
      const lbl = document.createElement('div');
      lbl.className = 'csel-group-label';
      lbl.textContent = child.label;
      panel.appendChild(lbl);
      // Group options
      Array.from(child.children).forEach(opt => {
        panel.appendChild(_makeOption(wrapper, select, opt));
      });
    } else {
      panel.appendChild(_makeOption(wrapper, select, child));
    }
  });
}

function _makeOption(wrapper, select, opt) {
  const item = document.createElement('div');
  item.className = 'csel-option';
  if (opt.value === '' || opt.disabled) item.classList.add('csel-placeholder');
  if (opt.value === select.value) item.classList.add('csel-selected');
  item.dataset.value = opt.value;
  item.textContent = opt.textContent;

  item.addEventListener('click', e => {
    e.stopPropagation();
    if (opt.disabled || opt.value === '') {
      _closeDropdown(wrapper);
      return;
    }
    // Update native select value
    select.value = opt.value;
    // Update trigger text
    wrapper.querySelector('.csel-trigger-text').textContent = opt.textContent;
    // Update selected state in panel
    wrapper.querySelectorAll('.csel-option').forEach(el => el.classList.remove('csel-selected'));
    item.classList.add('csel-selected');
    // Fire change event so existing onchange handlers fire
    select.dispatchEvent(new Event('change', { bubbles: true }));
    _closeDropdown(wrapper);
  });
  return item;
}

function _syncTriggerText(wrapper, select) {
  const triggerText = wrapper.querySelector('.csel-trigger-text');
  const selected = select.options[select.selectedIndex];
  triggerText.textContent = selected ? selected.textContent : '—';
}

export function initCustomSelect(select) {
  if (!select || select.dataset.cselInit) return;
  select.dataset.cselInit = '1';

  // Hide native select (keep in DOM for value reads)
  select.style.display = 'none';
  select.style.position = 'absolute';
  select.style.opacity = '0';
  select.style.pointerEvents = 'none';

  // Build wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'csel-wrapper';
  if (select.style.maxWidth) wrapper.style.maxWidth = select.style.maxWidth;
  if (select.className.includes('dchat-select')) wrapper.classList.add('csel-compact');

  // Trigger button
  const trigger = document.createElement('div');
  trigger.className = 'csel-trigger';
  trigger.setAttribute('tabindex', '0');
  trigger.innerHTML = `<span class="csel-trigger-text">—</span><span class="csel-arrow">▾</span>`;

  // Panel
  const panel = document.createElement('div');
  panel.className = 'csel-panel';

  wrapper.appendChild(trigger);
  wrapper.appendChild(panel);
  select.insertAdjacentElement('afterend', wrapper);

  _buildPanel(wrapper, select);
  _syncTriggerText(wrapper, select);

  // Toggle open/close
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = wrapper.classList.contains('csel-open');
    if (_openDropdown && _openDropdown !== wrapper) _closeDropdown(_openDropdown);
    if (isOpen) {
      _closeDropdown(wrapper);
    } else {
      wrapper.classList.add('csel-open');
      _openDropdown = wrapper;
      // Scroll selected option into view
      const sel = panel.querySelector('.csel-selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  });

  // Keyboard nav
  trigger.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger.click(); }
  });

  // Watch for external value changes (e.g. select.value = 'x' from JS)
  const observer = new MutationObserver(() => {
    _buildPanel(wrapper, select);
    _syncTriggerText(wrapper, select);
  });
  observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['value'] });
}

// Call this if you repopulate a select's options in JS
export function refreshCustomSelect(select) {
  if (!select || !select.dataset.cselInit) return;
  const wrapper = select.nextElementSibling;
  if (!wrapper || !wrapper.classList.contains('csel-wrapper')) return;
  _buildPanel(wrapper, select);
  _syncTriggerText(wrapper, select);
}

// Init all selects matching a selector
export function initAllCustomSelects(scopeEl = document) {
  scopeEl.querySelectorAll('select.field-input, select.dchat-select').forEach(initCustomSelect);
}