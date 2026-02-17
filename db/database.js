// Cross-browser namespace
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

let db = null;

async function initDB() {
  const SQL = await initSqlJs({
    locateFile: file => browserAPI.runtime.getURL(`lib/${file}`)
  });

  // Try to load existing DB from storage
  const stored = await browserAPI.storage.local.get('accountDB');
  if (stored.accountDB) {
    db = new SQL.Database(new Uint8Array(stored.accountDB));
  } else {
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
  const data = db.export();
  await browserAPI.storage.local.set({ accountDB: Array.from(data) });
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
