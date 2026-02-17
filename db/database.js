// Cross-browser namespace
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

let db = null;
let _cryptoKey = null;
let _cryptoSalt = null;

// --- Encryption (PBKDF2 + AES-256-GCM) ---

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, data
  );
  return { iv, data: new Uint8Array(encrypted) };
}

async function decryptData(encryptedData, iv, key) {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, encryptedData
  );
  return new Uint8Array(decrypted);
}

// --- DB State Detection ---

async function getDBState() {
  const stored = await browserAPI.storage.local.get(['accountDB', 'accountDB_encrypted']);
  if (stored.accountDB_encrypted) return 'encrypted';
  if (stored.accountDB) return 'unencrypted';
  return 'new';
}

// --- Init ---

async function initDB(passphrase) {
  const SQL = await initSqlJs({
    locateFile: file => browserAPI.runtime.getURL(`lib/${file}`)
  });

  const stored = await browserAPI.storage.local.get(['accountDB', 'accountDB_encrypted']);

  if (stored.accountDB_encrypted) {
    // Decrypt existing encrypted DB
    const enc = stored.accountDB_encrypted;
    _cryptoSalt = new Uint8Array(enc.salt);
    _cryptoKey = await deriveKey(passphrase, _cryptoSalt);
    try {
      const decrypted = await decryptData(
        new Uint8Array(enc.data), new Uint8Array(enc.iv), _cryptoKey
      );
      db = new SQL.Database(decrypted);
      db.exec('SELECT count(*) FROM accounts');
    } catch (err) {
      _cryptoKey = null;
      _cryptoSalt = null;
      db = null;
      throw new Error('WRONG_PASSPHRASE');
    }
  } else if (stored.accountDB) {
    // Migrate unencrypted DB to encrypted
    _cryptoSalt = crypto.getRandomValues(new Uint8Array(16));
    _cryptoKey = await deriveKey(passphrase, _cryptoSalt);
    try {
      db = new SQL.Database(new Uint8Array(stored.accountDB));
      db.exec('SELECT count(*) FROM accounts');
    } catch (err) {
      console.warn('Stored database corrupted, creating fresh database:', err);
      db = null;
    }
    if (db) {
      await saveDB();
      // Remove old unencrypted data
      await browserAPI.storage.local.remove('accountDB');
    }
  }

  if (!db) {
    // Brand new DB
    if (!_cryptoKey) {
      _cryptoSalt = crypto.getRandomValues(new Uint8Array(16));
      _cryptoKey = await deriveKey(passphrase, _cryptoSalt);
    }
    db = new SQL.Database();
    db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_name TEXT NOT NULL,
        url TEXT,
        username TEXT,
        category TEXT DEFAULT 'general',
        refresh_interval_days INTEGER DEFAULT 90,
        last_password_change TEXT,
        date_added TEXT,
        notes TEXT
      )
    `);
    await saveDB();
  }
  return db;
}

async function saveDB() {
  try {
    const rawData = db.export();
    if (_cryptoKey && _cryptoSalt) {
      const { iv, data } = await encryptData(rawData, _cryptoKey);
      await browserAPI.storage.local.set({
        accountDB_encrypted: {
          salt: Array.from(_cryptoSalt),
          iv: Array.from(iv),
          data: Array.from(data)
        }
      });
    }
  } catch (err) {
    console.error('Failed to save database:', err);
  }
}

function lockDB() {
  _cryptoKey = null;
  _cryptoSalt = null;
  if (db) {
    db.close();
    db = null;
  }
}

async function changePassphrase(newPassphrase) {
  _cryptoSalt = crypto.getRandomValues(new Uint8Array(16));
  _cryptoKey = await deriveKey(newPassphrase, _cryptoSalt);
  await saveDB();
}

// --- CRUD Operations ---

async function addAccount({ service_name, url, username, category, refresh_interval_days, last_password_change, notes }) {
  const dateAdded = new Date().toISOString();
  db.run(
    `INSERT INTO accounts (service_name, url, username, category, refresh_interval_days, last_password_change, date_added, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [service_name, url || '', username || '', category || 'general', refresh_interval_days || 90, last_password_change || dateAdded, dateAdded, notes || '']
  );
  await saveDB();
}

async function updateAccount(id, fields) {
  const allowed = ['service_name', 'url', 'username', 'category', 'refresh_interval_days', 'last_password_change', 'notes'];
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  db.run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, values);
  await saveDB();
}

async function deleteAccount(id) {
  db.run('DELETE FROM accounts WHERE id = ?', [id]);
  await saveDB();
}

async function markRefreshed(id) {
  const now = new Date().toISOString();
  db.run('UPDATE accounts SET last_password_change = ? WHERE id = ?', [now, id]);
  await saveDB();
}

function getAllAccounts() {
  const results = db.exec('SELECT * FROM accounts ORDER BY service_name COLLATE NOCASE');
  return parseResults(results);
}

function searchAccounts(query) {
  const q = `%${query}%`;
  const results = db.exec(
    `SELECT * FROM accounts
     WHERE service_name LIKE ? OR url LIKE ? OR username LIKE ?
     ORDER BY service_name COLLATE NOCASE`,
    [q, q, q]
  );
  return parseResults(results);
}

function getAccountsByStatus(status) {
  const all = getAllAccounts();
  const now = new Date();
  return all.filter(account => {
    const s = calcStatus(account, now);
    return s === status;
  });
}

function getOverdueCount() {
  const all = getAllAccounts();
  const now = new Date();
  return all.filter(a => calcStatus(a, now) === 'overdue').length;
}

// --- Backup & Restore ---

function exportAllAccounts() {
  const accounts = getAllAccounts();
  return {
    version: 1,
    app: 'Able Account',
    exported_at: new Date().toISOString(),
    count: accounts.length,
    accounts: accounts.map(a => ({
      service_name: a.service_name,
      url: a.url || '',
      username: a.username || '',
      category: a.category || 'general',
      refresh_interval_days: a.refresh_interval_days || 90,
      last_password_change: a.last_password_change || '',
      date_added: a.date_added || '',
      notes: a.notes || ''
    }))
  };
}

function validateImportData(data) {
  if (!data || typeof data !== 'object') return 'Invalid file format.';
  if (data.app !== 'Able Account') return 'This file was not exported from Able Account.';
  if (!Array.isArray(data.accounts)) return 'No accounts found in backup file.';
  if (data.accounts.length === 0) return 'Backup file contains no accounts.';

  const validCategories = ['general', 'financial', 'email', 'social', 'shopping', 'streaming', 'work', 'gaming'];

  for (let i = 0; i < data.accounts.length; i++) {
    const a = data.accounts[i];
    if (!a || typeof a !== 'object') return `Account #${i + 1} is invalid.`;
    if (typeof a.service_name !== 'string' || !a.service_name.trim()) {
      return `Account #${i + 1} is missing a service name.`;
    }
    if (a.service_name.length > 200) return `Account #${i + 1} service name is too long.`;
    if (a.url && (typeof a.url !== 'string' || a.url.length > 200)) {
      return `Account #${i + 1} has an invalid URL.`;
    }
    if (a.username && (typeof a.username !== 'string' || a.username.length > 200)) {
      return `Account #${i + 1} has an invalid username.`;
    }
    if (a.category && !validCategories.includes(a.category)) {
      a.category = 'general';
    }
    if (a.refresh_interval_days != null) {
      const interval = parseInt(a.refresh_interval_days, 10);
      if (isNaN(interval) || interval < 1 || interval > 365) a.refresh_interval_days = 90;
      else a.refresh_interval_days = interval;
    }
  }
  return null; // no error
}

async function importAccounts(accounts, mode) {
  const existing = getAllAccounts();
  const existingKeys = new Set(
    existing.map(a => `${(a.service_name || '').toLowerCase()}|${(a.url || '').toLowerCase()}`)
  );

  let added = 0;
  let skipped = 0;

  if (mode === 'replace') {
    db.run('DELETE FROM accounts');
    existingKeys.clear();
  }

  for (const a of accounts) {
    const key = `${(a.service_name || '').toLowerCase().trim()}|${(a.url || '').toLowerCase().trim()}`;
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }
    existingKeys.add(key);

    db.run(
      `INSERT INTO accounts (service_name, url, username, category, refresh_interval_days, last_password_change, date_added, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.service_name.trim().slice(0, 200),
        (a.url || '').trim().slice(0, 200),
        (a.username || '').trim().slice(0, 200),
        a.category || 'general',
        a.refresh_interval_days || 90,
        a.last_password_change || new Date().toISOString(),
        a.date_added || new Date().toISOString(),
        (a.notes || '').trim().slice(0, 1000)
      ]
    );
    added++;
  }

  await saveDB();
  return { added, skipped };
}

// --- Helpers ---

function calcStatus(account, now) {
  if (!account.last_password_change) return 'overdue';
  const lastChange = new Date(account.last_password_change);
  const intervalMs = (account.refresh_interval_days || 90) * 24 * 60 * 60 * 1000;
  const dueDate = new Date(lastChange.getTime() + intervalMs);
  const warningDate = new Date(dueDate.getTime() - 7 * 24 * 60 * 60 * 1000);

  if (now >= dueDate) return 'overdue';
  if (now >= warningDate) return 'due_soon';
  return 'good';
}

function daysUntilDue(account) {
  if (!account.last_password_change) return -999;
  const lastChange = new Date(account.last_password_change);
  const intervalMs = (account.refresh_interval_days || 90) * 24 * 60 * 60 * 1000;
  const dueDate = new Date(lastChange.getTime() + intervalMs);
  const now = new Date();
  return Math.ceil((dueDate - now) / (24 * 60 * 60 * 1000));
}

function daysSinceChange(account) {
  if (!account.last_password_change) return Infinity;
  const lastChange = new Date(account.last_password_change);
  return Math.floor((new Date() - lastChange) / (24 * 60 * 60 * 1000));
}

function parseResults(results) {
  if (!results || results.length === 0) return [];
  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}
