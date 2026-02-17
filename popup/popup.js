// State
let allAccounts = [];
let currentFilter = 'all';
let currentSort = 'name_asc';
let currentSearch = '';
let deleteTargetId = null;
let debounceTimer = null;
let alertDismissed = false;
let audioCtx = null;

// DOM refs
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search');
const filterChips = document.querySelectorAll('.chip[data-filter]');
const sortSelect = document.getElementById('sort-select');
const accountList = document.getElementById('account-list');
const emptyState = document.getElementById('empty-state');
const emptyMessage = document.getElementById('empty-message');
const filterInfo = document.getElementById('filter-info');
const countBadge = document.getElementById('account-count');
const addBtn = document.getElementById('add-btn');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalClose = document.getElementById('modal-close');
const accountForm = document.getElementById('account-form');
const formCancel = document.getElementById('form-cancel');
const deleteOverlay = document.getElementById('delete-overlay');
const deleteCancel = document.getElementById('delete-cancel');
const deleteConfirm = document.getElementById('delete-confirm');
const alertBanner = document.getElementById('alert-banner');
const alertTitle = document.getElementById('alert-title');
const alertDetail = document.getElementById('alert-detail');
const alertDismissBtn = document.getElementById('alert-dismiss');

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  loadAccounts();
  bindEvents();
  await importPendingAccounts();
});

function bindEvents() {
  // Search
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentSearch = searchInput.value.trim();
      clearSearchBtn.classList.toggle('visible', currentSearch.length > 0);
      renderList();
    }, 150);
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    currentSearch = '';
    clearSearchBtn.classList.remove('visible');
    renderList();
    searchInput.focus();
  });

  // Keyboard shortcut: / to focus search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
    if (e.key === 'Escape') {
      if (!modalOverlay.classList.contains('hidden')) {
        closeModal();
      } else if (!deleteOverlay.classList.contains('hidden')) {
        closeDeleteModal();
      } else if (currentSearch) {
        searchInput.value = '';
        currentSearch = '';
        clearSearchBtn.classList.remove('visible');
        renderList();
      }
    }
  });

  // Filter chips
  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      renderList();
    });
  });

  // Sort
  sortSelect.addEventListener('change', () => {
    currentSort = sortSelect.value;
    renderList();
  });

  // Add button
  addBtn.addEventListener('click', () => openModal());

  // Modal
  modalClose.addEventListener('click', closeModal);
  formCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // Form submit
  accountForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveAccount();
  });

  // Delete modal
  deleteCancel.addEventListener('click', closeDeleteModal);
  deleteOverlay.addEventListener('click', (e) => {
    if (e.target === deleteOverlay) closeDeleteModal();
  });
  deleteConfirm.addEventListener('click', async () => {
    if (deleteTargetId !== null) {
      await deleteAccount(deleteTargetId);
      deleteTargetId = null;
      closeDeleteModal();
      loadAccounts();
    }
  });

  // Alert banner dismiss
  alertDismissBtn.addEventListener('click', () => {
    alertDismissed = true;
    alertBanner.classList.add('hidden');
  });
}

// --- Data ---

function loadAccounts() {
  allAccounts = getAllAccounts();
  countBadge.textContent = `${allAccounts.length} account${allAccounts.length !== 1 ? 's' : ''}`;
  renderList();
  updateOverdueBadge();
  showOverdueAlert();
}

function updateOverdueBadge() {
  const now = new Date();
  const overdueAccounts = allAccounts.filter(a => calcStatus(a, now) === 'overdue');
  try {
    const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
    browserAPI.runtime.sendMessage({
      type: 'updateOverdueCount',
      count: overdueAccounts.length,
      names: overdueAccounts.map(a => a.service_name)
    });
  } catch (e) {
    // Ignore if not running as extension
  }
}

// --- Auto-Import Detected Accounts ---

async function importPendingAccounts() {
  try {
    const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
    const pending = await browserAPI.runtime.sendMessage({ type: 'getPendingAccounts' });

    if (!pending || pending.length === 0) return;

    // Check which ones aren't already tracked (by domain)
    const existingUrls = new Set(allAccounts.map(a => (a.url || '').toLowerCase()));
    const newAccounts = pending.filter(p => !existingUrls.has((p.url || '').toLowerCase()));

    if (newAccounts.length === 0) {
      browserAPI.runtime.sendMessage({ type: 'clearPendingAccounts' });
      return;
    }

    // Add each detected account
    for (const account of newAccounts) {
      await addAccount({
        service_name: account.service_name,
        url: account.url,
        username: account.username || '',
        category: 'general',
        refresh_interval_days: 90,
        last_password_change: account.detected_at || new Date().toISOString(),
        notes: 'Auto-detected signup'
      });
    }

    // Clear pending list
    browserAPI.runtime.sendMessage({ type: 'clearPendingAccounts' });

    // Reload to show new accounts
    loadAccounts();
  } catch (e) {
    // Ignore if not running as extension
  }
}

// --- Alert Banner + Audible Alert ---

function showOverdueAlert() {
  const now = new Date();
  const overdueAccounts = allAccounts.filter(a => calcStatus(a, now) === 'overdue');
  const dueSoonAccounts = allAccounts.filter(a => calcStatus(a, now) === 'due_soon');

  if (overdueAccounts.length === 0 && dueSoonAccounts.length === 0) {
    alertBanner.classList.add('hidden');
    return;
  }

  if (alertDismissed) return;

  // Build alert message
  if (overdueAccounts.length > 0) {
    const names = overdueAccounts.slice(0, 3).map(a => a.service_name).join(', ');
    const extra = overdueAccounts.length > 3 ? ` +${overdueAccounts.length - 3} more` : '';
    alertTitle.textContent = `${overdueAccounts.length} password${overdueAccounts.length !== 1 ? 's' : ''} overdue!`;
    alertDetail.textContent = `Change now: ${names}${extra}`;
  } else {
    const names = dueSoonAccounts.slice(0, 3).map(a => a.service_name).join(', ');
    alertTitle.textContent = `${dueSoonAccounts.length} password${dueSoonAccounts.length !== 1 ? 's' : ''} due soon`;
    alertDetail.textContent = `Coming up: ${names}`;
  }

  alertBanner.classList.remove('hidden');

  // Play audible alert for overdue accounts
  if (overdueAccounts.length > 0) {
    playAlertSound();
  }
}

function playAlertSound() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Play a 3-tone alert chime
    const tones = [
      { freq: 587.33, start: 0, dur: 0.15 },    // D5
      { freq: 783.99, start: 0.18, dur: 0.15 },  // G5
      { freq: 880.00, start: 0.36, dur: 0.25 }   // A5
    ];

    tones.forEach(({ freq, start, dur }) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.value = freq;

      gain.gain.setValueAtTime(0, audioCtx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + start + 0.02);
      gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + start + dur);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start(audioCtx.currentTime + start);
      osc.stop(audioCtx.currentTime + start + dur);
    });
  } catch (e) {
    // Audio not available
  }
}

// --- Rendering ---

function renderList() {
  let filtered = applySearch(allAccounts, currentSearch);
  filtered = applyFilter(filtered, currentFilter);
  filtered = applySort(filtered, currentSort);

  const total = allAccounts.length;
  const showing = filtered.length;

  // Filter info
  if (currentSearch || currentFilter !== 'all') {
    filterInfo.textContent = `Showing ${showing} of ${total} accounts`;
    filterInfo.classList.remove('hidden');
  } else {
    filterInfo.classList.add('hidden');
  }

  // Empty state
  if (total === 0) {
    accountList.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyMessage.textContent = 'No accounts yet. Add your first one!';
    return;
  }

  if (showing === 0) {
    accountList.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyMessage.textContent = currentSearch
      ? `No accounts match "${currentSearch}"`
      : 'No accounts match this filter.';
    return;
  }

  emptyState.classList.add('hidden');
  accountList.classList.remove('hidden');
  accountList.innerHTML = filtered.map(account => renderRow(account)).join('');

  // Bind row actions
  accountList.querySelectorAll('.row-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      const action = btn.dataset.action;
      handleRowAction(id, action);
    });
  });

  // Row click to edit
  accountList.querySelectorAll('.account-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.dataset.id);
      const account = allAccounts.find(a => a.id === id);
      if (account) openModal(account);
    });
  });
}

function renderRow(account) {
  const now = new Date();
  const status = calcStatus(account, now);
  const days = daysSinceChange(account);
  const daysLeft = daysUntilDue(account);

  let ageText;
  if (days === Infinity) {
    ageText = 'Never changed';
  } else if (days === 0) {
    ageText = 'Changed today';
  } else if (days === 1) {
    ageText = 'Changed 1 day ago';
  } else {
    ageText = `Changed ${days} days ago`;
  }

  if (status === 'overdue' && daysLeft < 0) {
    ageText += ` (${Math.abs(daysLeft)}d overdue)`;
  } else if (status === 'due_soon') {
    ageText += ` (due in ${daysLeft}d)`;
  }

  const serviceName = highlightMatch(escapeHtml(account.service_name), currentSearch);
  const url = highlightMatch(escapeHtml(account.url || ''), currentSearch);
  const username = highlightMatch(escapeHtml(account.username || ''), currentSearch);

  return `
    <div class="account-row" data-id="${account.id}">
      <div class="status-dot ${status}" title="${statusLabel(status)}"></div>
      <div class="row-info">
        <div class="row-primary">
          <span class="service-name">${serviceName}</span>
          ${account.url ? `<span class="domain">${url}</span>` : ''}
        </div>
        <div class="row-secondary">
          ${account.username ? `<span class="row-username">${username}</span>` : ''}
          <span class="row-age ${status}">${ageText}</span>
        </div>
      </div>
      <div class="row-actions">
        <button class="row-action-btn refresh-btn" data-id="${account.id}" data-action="refresh" title="Mark password as refreshed">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button class="row-action-btn" data-id="${account.id}" data-action="open" title="Open site">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
        <button class="row-action-btn delete-btn" data-id="${account.id}" data-action="delete" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `;
}

// --- Search, Filter, Sort ---

function applySearch(accounts, query) {
  if (!query) return accounts;
  const q = query.toLowerCase();
  return accounts.filter(a =>
    (a.service_name || '').toLowerCase().includes(q) ||
    (a.url || '').toLowerCase().includes(q) ||
    (a.username || '').toLowerCase().includes(q)
  );
}

function applyFilter(accounts, filter) {
  if (filter === 'all') return accounts;
  const now = new Date();
  return accounts.filter(a => calcStatus(a, now) === filter);
}

function applySort(accounts, sort) {
  const sorted = [...accounts];
  switch (sort) {
    case 'name_asc':
      sorted.sort((a, b) => (a.service_name || '').localeCompare(b.service_name || ''));
      break;
    case 'name_desc':
      sorted.sort((a, b) => (b.service_name || '').localeCompare(a.service_name || ''));
      break;
    case 'urgency':
      sorted.sort((a, b) => daysUntilDue(a) - daysUntilDue(b));
      break;
    case 'oldest_change':
      sorted.sort((a, b) => daysSinceChange(b) - daysSinceChange(a));
      break;
    case 'date_added':
      sorted.sort((a, b) => (b.date_added || '').localeCompare(a.date_added || ''));
      break;
  }
  return sorted;
}

// --- Highlight ---

function highlightMatch(text, query) {
  if (!query || !text) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  return text.replace(regex, '<mark>$1</mark>');
}

// --- Row Actions ---

async function handleRowAction(id, action) {
  switch (action) {
    case 'refresh':
      await markRefreshed(id);
      loadAccounts();
      break;
    case 'open': {
      const account = allAccounts.find(a => a.id === id);
      if (account && account.url) {
        let url = account.url;
        if (!url.startsWith('http')) url = 'https://' + url;
        window.open(url, '_blank');
      }
      break;
    }
    case 'delete':
      deleteTargetId = id;
      const account = allAccounts.find(a => a.id === id);
      document.getElementById('delete-message').textContent =
        `Remove "${account?.service_name || 'this account'}" from tracking?`;
      deleteOverlay.classList.remove('hidden');
      break;
  }
}

// --- Modal ---

function openModal(account = null) {
  accountForm.reset();
  document.getElementById('form-id').value = '';

  if (account) {
    modalTitle.textContent = 'Edit Account';
    document.getElementById('form-id').value = account.id;
    document.getElementById('form-service').value = account.service_name || '';
    document.getElementById('form-url').value = account.url || '';
    document.getElementById('form-username').value = account.username || '';
    document.getElementById('form-category').value = account.category || 'general';
    document.getElementById('form-interval').value = account.refresh_interval_days || 90;
    if (account.last_password_change) {
      document.getElementById('form-lastchange').value = account.last_password_change.split('T')[0];
    }
    document.getElementById('form-notes').value = account.notes || '';
  } else {
    modalTitle.textContent = 'Add Account';
    document.getElementById('form-lastchange').value = new Date().toISOString().split('T')[0];
  }

  modalOverlay.classList.remove('hidden');
  document.getElementById('form-service').focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
}

function closeDeleteModal() {
  deleteOverlay.classList.add('hidden');
  deleteTargetId = null;
}

async function saveAccount() {
  const id = document.getElementById('form-id').value;
  const data = {
    service_name: document.getElementById('form-service').value.trim(),
    url: document.getElementById('form-url').value.trim(),
    username: document.getElementById('form-username').value.trim(),
    category: document.getElementById('form-category').value,
    refresh_interval_days: parseInt(document.getElementById('form-interval').value) || 90,
    last_password_change: document.getElementById('form-lastchange').value
      ? new Date(document.getElementById('form-lastchange').value).toISOString()
      : new Date().toISOString(),
    notes: document.getElementById('form-notes').value.trim()
  };

  if (!data.service_name) return;

  if (id) {
    await updateAccount(parseInt(id), data);
  } else {
    await addAccount(data);
  }

  closeModal();
  loadAccounts();
}

// --- Helpers ---

function statusLabel(status) {
  switch (status) {
    case 'overdue': return 'Password overdue for refresh';
    case 'due_soon': return 'Password refresh due soon';
    case 'good': return 'Password recently changed';
    default: return '';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
