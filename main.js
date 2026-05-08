const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

let agentWin    = null;
let settingsWin = null;
let popupWin    = null;
let posPollTimer = null;
let posPollBusy  = false;
let activeInvId  = null;
let mssql        = null;
let mssqlPool    = null;
let mssqlPoolKey = '';
let lastPollErr  = '';
let pollCycleCount = 0;
let lastPollInfoMsg = '';

// ── Single instance ───────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else { app.on('second-instance', () => { if (agentWin) agentWin.show(); }); }

// ── Paths ─────────────────────────────────────────────────────────────────────
const USER_DATA             = app.getPath('userData');
const DB_PATH               = path.join(USER_DATA, 'eproloyalty.db');
const POS_SETTINGS_PATH     = path.join(USER_DATA, 'pos-settings.json');
const LEGACY_SETTINGS_PATH  = path.join(USER_DATA, 'settings.json');
const LEGACY_TXN_PATH       = path.join(USER_DATA, 'transactions.json');
const LEGACY_STATS_PATH     = path.join(USER_DATA, 'stats.json');
const APP_ICON_PATH         = path.join(__dirname, 'assets', 'icon.ico');
let db = null;

// ── Default settings ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  authUrl:      'https://jbchqgzsnbliekxonfmi.supabase.co/functions/v1/api-auth',
  txnUrl:       'https://jbchqgzsnbliekxonfmi.supabase.co/functions/v1/api-record-transaction',
  createCustomerUrl: 'https://jbchqgzsnbliekxonfmi.supabase.co/functions/v1/api-create-customer',
  username:     'mlt_gh_loyalty@123',
  password:     'epro_pos_loyal_mlt@321',
  merchantId:   'e206cd4a-16d0-4a42-8e77-36c4a25bc9eb',
  processedBy:  '6a1a2b39-bcb5-4d56-83a6-385d7db73e74',
  dbType: 'Microsoft SQL Server', dbHost: 'localhost\\SQLEXPRESS',
  dbName: 'POSDB', dbPort: '1433', dbUser: 'sa', dbPass: '',
  dbWhere: "Status = 'PAID' AND TransactionType = 'SALE'",
  dbMinAmount: '1.00', dbTableTxn: 'Transactions',
  dbColAmount: 'InvoiceTotal', dbColInvId: 'InvoiceNo',
  dbColDate: 'TransDate', dbColStatus: 'Status',
  ptsRate: '10', pollInterval: '3', autoDismiss: '30',
  countryCode: '+961', monitorOn: true, agentEnabled: true,
  createCustomerEnabled: false,
};

const DEFAULT_STATS = { txnCount:0, sentCount:0, skipCount:0, totalAmt:0, date:'' };

function todayKey() {
  return new Date().toDateString();
}

function readLegacyJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch(e) {
    console.error('legacy json read failed:', e.message);
  }
  return fallback;
}

function initDatabase() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stats (
      stat_date  TEXT PRIMARY KEY,
      txn_count  INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      skip_count INTEGER NOT NULL DEFAULT 0,
      total_amt  REAL    NOT NULL DEFAULT 0,
      updated_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      inv_id        TEXT,
      amt           REAL,
      pts           INTEGER,
      mobile        TEXT,
      customer_name TEXT,
      new_balance   REAL,
      status        TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(created_at DESC, id DESC);
  `);

  migrateLegacyFiles();
  return db;
}

function getDb() {
  return db || initDatabase();
}

function migrateLegacyFiles() {
  const database = getDb();

  const settingsCount = database.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
  if (settingsCount === 0 && fs.existsSync(LEGACY_SETTINGS_PATH)) {
    const legacySettings = readLegacyJson(LEGACY_SETTINGS_PATH, {});
    if (legacySettings && typeof legacySettings === 'object') {
      saveSettings(legacySettings);
    }
  }

  const txnCount = database.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
  if (txnCount === 0 && fs.existsSync(LEGACY_TXN_PATH)) {
    const legacyTxns = readLegacyJson(LEGACY_TXN_PATH, []);
    if (Array.isArray(legacyTxns)) {
      legacyTxns.forEach(t => {
        saveTxn({
          invId:        t.invId,
          amt:          t.amt,
          pts:          t.pts,
          mobile:       t.mobile,
          customerName: t.customerName,
          newBalance:   t.newBalance,
          status:       t.status || 'sent',
          time:         t.time || new Date().toISOString(),
        });
      });
    }
  }

  const statsCount = database.prepare('SELECT COUNT(*) AS c FROM stats').get().c;
  if (statsCount === 0 && fs.existsSync(LEGACY_STATS_PATH)) {
    const legacyStats = readLegacyJson(LEGACY_STATS_PATH, null);
    if (legacyStats && typeof legacyStats === 'object') {
      const statDate = legacyStats.date || todayKey();
      database.prepare(`
        INSERT INTO stats (stat_date, txn_count, sent_count, skip_count, total_amt, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(stat_date) DO UPDATE SET
          txn_count = excluded.txn_count,
          sent_count = excluded.sent_count,
          skip_count = excluded.skip_count,
          total_amt = excluded.total_amt,
          updated_at = excluded.updated_at
      `).run(
        statDate,
        Number(legacyStats.txnCount || 0),
        Number(legacyStats.sentCount || 0),
        Number(legacyStats.skipCount || 0),
        Number(legacyStats.totalAmt || 0),
        new Date().toISOString()
      );
    }
  }
}

// ── Settings helpers ──────────────────────────────────────────────────────────
function loadSettings() {
  const database = getDb();
  const rows = database.prepare('SELECT key, value FROM settings').all();
  const fromDb = {};

  rows.forEach(r => {
    try {
      fromDb[r.key] = JSON.parse(r.value);
    } catch(e) {
      fromDb[r.key] = r.value;
    }
  });

  return { ...DEFAULT_SETTINGS, ...fromDb };
}

function saveSettings(data) {
  const database = getDb();
  const merged = { ...loadSettings(), ...data };
  const upsert = database.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const tx = database.transaction((obj) => {
    Object.entries(obj).forEach(([k, v]) => {
      upsert.run(k, JSON.stringify(v));
    });
  });

  tx(merged);

  // Mirror POS settings to a local JSON file for easier on-PC inspection/backups.
  const posSettings = {
    dbType: merged.dbType,
    dbHost: merged.dbHost,
    dbName: merged.dbName,
    dbPort: merged.dbPort,
    dbUser: merged.dbUser,
    dbPass: merged.dbPass,
    dbWhere: merged.dbWhere,
    dbMinAmount: merged.dbMinAmount,
    dbTableTxn: merged.dbTableTxn,
    dbColAmount: merged.dbColAmount,
    dbColInvId: merged.dbColInvId,
    dbColDate: merged.dbColDate,
    dbColStatus: merged.dbColStatus,
    dbFieldMappings: Array.isArray(merged.dbFieldMappings) ? merged.dbFieldMappings : [],
    pollInterval: merged.pollInterval,
    monitorOn: merged.monitorOn,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(POS_SETTINGS_PATH, JSON.stringify(posSettings, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write POS settings file:', e.message);
  }

  return merged;
}

// ── Transaction log helpers (persisted to sqlite) ─────────────────────────────
function loadTxns() {
  const database = getDb();
  const rows = database.prepare(`
    SELECT inv_id, amt, pts, mobile, customer_name, new_balance, status, created_at
    FROM transactions
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 500
  `).all();

  return rows.map(r => ({
    invId:        r.inv_id,
    amt:          r.amt,
    pts:          r.pts,
    mobile:       r.mobile,
    customerName: r.customer_name,
    newBalance:   r.new_balance,
    status:       r.status,
    time:         r.created_at,
  }));
}

function saveTxn(entry) {
  const database = getDb();
  database.prepare(`
    INSERT INTO transactions (inv_id, amt, pts, mobile, customer_name, new_balance, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.invId || null,
    Number(entry.amt || 0),
    Number(entry.pts || 0),
    entry.mobile || null,
    entry.customerName || null,
    entry.newBalance ?? null,
    entry.status || 'sent',
    entry.time || new Date().toISOString()
  );

  database.prepare(`
    DELETE FROM transactions
    WHERE id NOT IN (
      SELECT id FROM transactions
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 500
    )
  `).run();
}

// ── Stats helpers (persisted today's counters) ────────────────────────────────
function loadStats() {
  const database = getDb();
  const today = todayKey();

  let row = database.prepare(`
    SELECT stat_date, txn_count, sent_count, skip_count, total_amt
    FROM stats
    WHERE stat_date = ?
  `).get(today);

  if (!row) {
    database.prepare(`
      INSERT INTO stats (stat_date, txn_count, sent_count, skip_count, total_amt, updated_at)
      VALUES (?, 0, 0, 0, 0, ?)
    `).run(today, new Date().toISOString());

    row = {
      stat_date: today,
      txn_count: 0,
      sent_count: 0,
      skip_count: 0,
      total_amt: 0,
    };
  }

  return {
    txnCount: Number(row.txn_count || 0),
    sentCount: Number(row.sent_count || 0),
    skipCount: Number(row.skip_count || 0),
    totalAmt: Number(row.total_amt || 0),
    date: row.stat_date || today,
  };
}

function saveStats(data) {
  const database = getDb();
  const merged = { ...loadStats(), ...data, date: todayKey() };

  database.prepare(`
    INSERT INTO stats (stat_date, txn_count, sent_count, skip_count, total_amt, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(stat_date) DO UPDATE SET
      txn_count = excluded.txn_count,
      sent_count = excluded.sent_count,
      skip_count = excluded.skip_count,
      total_amt = excluded.total_amt,
      updated_at = excluded.updated_at
  `).run(
    merged.date,
    Number(merged.txnCount || 0),
    Number(merged.sentCount || 0),
    Number(merged.skipCount || 0),
    Number(merged.totalAmt || 0),
    new Date().toISOString()
  );

  return merged;
}

// ── POS poll helpers ─────────────────────────────────────────────────────────
function emitFeed(msg, type = 'info') {
  safeSend(settingsWin, 'feed-log', { msg, type });
}

function emitStats() {
  const s = loadStats();
  safeSend(settingsWin, 'stats-update', s);
  safeSend(agentWin, 'stats-update', s);
}

function normDbType(v) {
  return String(v || '').trim().toLowerCase();
}

function normalizeInvoiceId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const upper = raw.toUpperCase();
  if (/^INV-\d{8}$/.test(upper)) return upper;

  const digits = raw.replace(/\D/g, '');
  if (digits) {
    return `INV-${digits.slice(-8).padStart(8, '0')}`;
  }

  return raw;
}

function quoteSqliteIdent(name) {
  return String(name || '').split('.').map(p => `"${String(p).replace(/"/g, '""')}"`).join('.');
}

function quoteMssqlIdent(name) {
  return String(name || '').split('.').map(p => `[${String(p).replace(/]/g, ']]')}]`).join('.');
}

function buildSelectSql(driver, cfg) {
  const q = driver === 'mssql' ? quoteMssqlIdent : quoteSqliteIdent;
  const table  = q(cfg.dbTableTxn || 'Transactions');
  const invCol = q(cfg.dbColInvId  || 'InvoiceNo');
  const amtCol = q(cfg.dbColAmount || 'InvoiceTotal');
  const dtCol  = q(cfg.dbColDate   || 'TransDate');

  const whereParts = [];
  const minAmt = Number(cfg.dbMinAmount || 0);
  if (!Number.isNaN(minAmt) && minAmt > 0) whereParts.push(`${amtCol} >= ${minAmt}`);
  if (cfg.dbWhere && String(cfg.dbWhere).trim()) whereParts.push(`(${String(cfg.dbWhere).trim()})`);

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  if (driver === 'mssql') {
    return `SELECT TOP 1 ${invCol} AS inv_id, ${amtCol} AS amt, ${dtCol} AS txn_date FROM ${table} ${whereSql} ORDER BY ${dtCol} DESC`;
  }
  return `SELECT ${invCol} AS inv_id, ${amtCol} AS amt, ${dtCol} AS txn_date FROM ${table} ${whereSql} ORDER BY ${dtCol} DESC LIMIT 1`;
}

function resolveSqlitePosPath(cfg) {
  const host = String(cfg.dbHost || '').trim();
  const dbName = String(cfg.dbName || '').trim();
  if (/\.(db|sqlite|sqlite3)$/i.test(host)) return host;
  if (host && dbName) return path.join(host, dbName);
  if (host) return host;
  return dbName;
}

async function getMssqlPool(cfg) {
  if (!mssql) mssql = require('mssql');
  const key = JSON.stringify({
    server: cfg.dbHost,
    database: cfg.dbName,
    user: cfg.dbUser,
    port: Number(cfg.dbPort || 1433),
  });

  if (mssqlPool && mssqlPoolKey !== key) {
    try { await mssqlPool.close(); } catch(e) {}
    mssqlPool = null;
  }

  if (!mssqlPool) {
    mssqlPool = await mssql.connect({
      server: cfg.dbHost,
      database: cfg.dbName,
      user: cfg.dbUser,
      password: cfg.dbPass,
      port: Number(cfg.dbPort || 1433),
      options: { encrypt: false, trustServerCertificate: true },
      pool: { max: 3, min: 0, idleTimeoutMillis: 10000 },
    });
    mssqlPoolKey = key;
  }

  return mssqlPool;
}

async function readLatestPosTxn(cfg) {
  const t = normDbType(cfg.dbType);
  if (t.includes('sqlite')) {
    const posPath = resolveSqlitePosPath(cfg);
    if (!posPath) return null;
    const posDb = new Database(posPath, { readonly: true, fileMustExist: true });
    try {
      const row = posDb.prepare(buildSelectSql('sqlite', cfg)).get();
      if (!row) return null;
      return {
        invId: normalizeInvoiceId(row.inv_id),
        amt: Number(row.amt || 0),
        txnDate: row.txn_date ?? null,
      };
    } finally {
      posDb.close();
    }
  }

  if (t.includes('sql server') || t.includes('microsoft')) {
    const pool = await getMssqlPool(cfg);
    const result = await pool.request().query(buildSelectSql('mssql', cfg));
    const row = result && result.recordset && result.recordset[0];
    if (!row) return null;
    return {
      invId: normalizeInvoiceId(row.inv_id),
      amt: Number(row.amt || 0),
      txnDate: row.txn_date ?? null,
    };
  }

  throw new Error(`Unsupported DB type: ${cfg.dbType}`);
}

function isInvoiceHandled(invId) {
  if (!invId) return true;
  const database = getDb();
  const row = database.prepare('SELECT 1 AS ok FROM transactions WHERE inv_id = ? LIMIT 1').get(invId);
  return !!row;
}

function reportPollError(err) {
  const msg = (err && err.message) ? err.message : String(err || 'Unknown poll error');
  console.error('[POS poll error]', msg);
  if (msg !== lastPollErr) {
    emitFeed(`POS poll error: ${msg}`, 'warn');
    lastPollErr = msg;
  }
}

function clearPollError() {
  lastPollErr = '';
}

function emitPollInfo(msg, force = false) {
  // Keep feed useful: avoid repeating the same informational line every cycle.
  if (!force && msg === lastPollInfoMsg) return;
  emitFeed(msg, 'info');
  lastPollInfoMsg = msg;
}

async function pollPosOnce() {
  if (posPollBusy) return;
  posPollBusy = true;
  pollCycleCount += 1;

  try {
    const cfg = loadSettings();
    if (cfg.agentEnabled === false) {
      if (pollCycleCount % 20 === 0) emitPollInfo('POS polling paused (agent is STOPPED).');
      return;
    }
    if (!cfg.monitorOn) {
      if (pollCycleCount % 20 === 0) emitPollInfo('POS polling paused (monitor is OFF).');
      return;
    }

    const tx = await readLatestPosTxn(cfg);
    if (!tx || !tx.invId || Number.isNaN(tx.amt)) {
      if (pollCycleCount % 10 === 0) emitPollInfo('Polling active: no matching POS transaction found.');
      return;
    }

    if (activeInvId && activeInvId === tx.invId) {
      emitPollInfo(`Polling active: waiting for invoice ${tx.invId} flow to finish.`);
      return;
    }
    if (isInvoiceHandled(tx.invId)) {
      emitPollInfo(`Polling active: latest invoice ${tx.invId} already handled.`);
      return;
    }
    if (popupWin && !popupWin.isDestroyed()) {
      emitPollInfo('Polling active: popup is open, waiting before showing next invoice.');
      return;
    }

    const stats = loadStats();
    stats.txnCount += 1;
    stats.totalAmt += Number(tx.amt || 0);
    saveStats(stats);
    emitStats();

    activeInvId = tx.invId;
  lastPollInfoMsg = '';
    emitFeed(`New invoice: ${tx.invId} — $${Number(tx.amt).toFixed(2)}`, 'ok');
    openPopupWindow({ invId: tx.invId, amt: tx.amt }, false);
    clearPollError();
  } catch(err) {
    reportPollError(err);
  } finally {
    posPollBusy = false;
  }
}

function restartPosPolling() {
  if (posPollTimer) {
    clearInterval(posPollTimer);
    posPollTimer = null;
  }

  const cfg = loadSettings();
  const sec = Math.max(1, parseInt(cfg.pollInterval || '3', 10) || 3);
  emitFeed(`POS polling started (every ${sec}s).`, 'info');
  emitFeed(
    `Polling source: table=${cfg.dbTableTxn || 'Transactions'}, invoice_col=${cfg.dbColInvId || 'InvoiceNo'}, amount_col=${cfg.dbColAmount || 'InvoiceTotal'}.`,
    'info'
  );
  if (cfg.dbWhere && String(cfg.dbWhere).trim()) {
    emitFeed(`Polling filter: ${String(cfg.dbWhere).trim()}`, 'info');
  }
  posPollTimer = setInterval(() => { pollPosOnce(); }, sec * 1000);
  pollPosOnce();
}

async function closePosConnections() {
  if (mssqlPool) {
    try { await mssqlPool.close(); } catch(e) {}
    mssqlPool = null;
    mssqlPoolKey = '';
  }
}

// ── Safe IPC send (never throws if window closed) ─────────────────────────────
function safeSend(win, channel, data) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed())
      win.webContents.send(channel, data);
  } catch(e) {}
}

// ── Window sizes ──────────────────────────────────────────────────────────────
const ICON_W = 66, ICON_H = 66;
const MENU_W = 252, MENU_H = 390;
const PAD    = 16;

// ── Agent window ──────────────────────────────────────────────────────────────
function createAgentWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  agentWin = new BrowserWindow({
    width: ICON_W, height: ICON_H,
    x: width - ICON_W - PAD, y: height - ICON_H - PAD,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: true, hasShadow: false,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  agentWin.loadFile(path.join(__dirname, 'renderer', 'agent.html'));
  agentWin.setAlwaysOnTop(true, 'screen-saver');
  agentWin.on('closed', () => { agentWin = null; });
  agentWin.webContents.once('did-finish-load', () => {
    safeSend(agentWin, 'settings-loaded', loadSettings());
    safeSend(agentWin, 'stats-loaded', loadStats());
  });
}

// ── Agent resize ──────────────────────────────────────────────────────────────
ipcMain.on('agent-expand', () => {
  if (!agentWin || agentWin.isDestroyed()) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  agentWin.setBounds({ width: MENU_W, height: MENU_H + ICON_H + 10,
    x: width - MENU_W - PAD, y: height - MENU_H - ICON_H - 10 - PAD }, true);
});
ipcMain.on('agent-collapse', () => {
  if (!agentWin || agentWin.isDestroyed()) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  agentWin.setBounds({ width: ICON_W, height: ICON_H,
    x: width - ICON_W - PAD, y: height - ICON_H - PAD }, true);
});

// ── Settings window ───────────────────────────────────────────────────────────
ipcMain.on('open-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 1100, height: 750, minWidth: 860, minHeight: 560,
    title: 'eProLoyalty POS Bridge — Settings',
    frame: true, show: false,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => { settingsWin.show(); settingsWin.focus(); });
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.webContents.once('did-finish-load', () => {
    // Push settings + persisted stats + full transaction history
    safeSend(settingsWin, 'settings-loaded', loadSettings());
    safeSend(settingsWin, 'stats-loaded',    loadStats());
    safeSend(settingsWin, 'txns-loaded',     loadTxns());
  });
});

// ── Popup window ──────────────────────────────────────────────────────────────
function openPopupWindow(data, replaceExisting = true) {
  if (popupWin && !popupWin.isDestroyed()) {
    if (!replaceExisting) return false;
    popupWin.destroy();
    popupWin = null;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  // Window exactly matches card size — no padding needed since no drop-shadow filter
  const PW = 390, PH = 400;

  popupWin = new BrowserWindow({
    width: PW, height: PH,
    x: width - PW - PAD,
    y: PAD,
    icon: APP_ICON_PATH,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    // 'toolbar' type forces true per-pixel compositing on Windows — eliminates gray bg
    type: process.platform === 'win32' ? 'toolbar' : 'panel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  const settings  = loadSettings();
  const earnedPts = Math.floor(parseFloat(data.amt) * parseInt(settings.ptsRate || '10'));

  const normalizedInvId = normalizeInvoiceId(data && data.invId);

  popupWin.loadFile(path.join(__dirname, 'renderer', 'popup.html'), {
    query: { invId: normalizedInvId, amt: String(data.amt), pts: String(earnedPts) }
  });
  popupWin.setAlwaysOnTop(true, 'screen-saver');
  popupWin.on('closed', () => { popupWin = null; });
  popupWin.webContents.once('did-finish-load', () => {
    if (popupWin && !popupWin.isDestroyed())
      safeSend(popupWin, 'settings-loaded', settings);
  });
  return true;
}

ipcMain.on('open-popup', (event, data) => {
  openPopupWindow(data, true);
});

ipcMain.on('close-popup', () => {
  if (popupWin && !popupWin.isDestroyed()) popupWin.close();
});

// ── Points sent — save to disk, relay to windows ──────────────────────────────
ipcMain.on('points-sent', (event, data) => {
  // Do not close here: popup renderer shows a success toast, then closes itself.

  // Build transaction record
  const txn = {
    invId:        normalizeInvoiceId(data.invId),
    amt:          data.amt,
    pts:          data.pts,
    mobile:       data.mobile,
    customerName: data.customerName || null,
    newBalance:   data.newBalance   || null,
    status:       'sent',
    time:         new Date().toISOString(),
  };

  // Persist transaction
  saveTxn(txn);

  // Update persisted stats
  const stats = loadStats();
  stats.sentCount++;
  saveStats(stats);
  if (activeInvId === normalizeInvoiceId(data.invId)) activeInvId = null;

  // Relay to open windows
  safeSend(agentWin,    'points-sent', { ...txn, stats: loadStats() });
  safeSend(settingsWin, 'points-sent', { ...txn, stats: loadStats() });
  emitStats();
});

// ── Points skipped — save to disk ─────────────────────────────────────────────
ipcMain.on('points-skipped', (event, data) => {
  if (popupWin && !popupWin.isDestroyed()) popupWin.close();

  const txn = {
    invId:  normalizeInvoiceId(data.invId),
    amt:    data.amt,
    pts:    0,
    mobile: null,
    status: 'skipped',
    time:   new Date().toISOString(),
  };

  saveTxn(txn);

  const stats = loadStats();
  stats.skipCount++;
  saveStats(stats);
  if (activeInvId === normalizeInvoiceId(data.invId)) activeInvId = null;

  safeSend(agentWin,    'points-skipped', { ...txn, stats: loadStats() });
  safeSend(settingsWin, 'points-skipped', { ...txn, stats: loadStats() });
  emitStats();
});

// ── Points failed — save to disk as failed (not skipped) ────────────────────
ipcMain.on('points-failed', (event, data) => {
  const txn = {
    invId:        normalizeInvoiceId(data.invId),
    amt:          data.amt,
    pts:          Number(data.pts || 0),
    mobile:       data.mobile || null,
    customerName: null,
    newBalance:   null,
    status:       'failed',
    time:         new Date().toISOString(),
  };

  saveTxn(txn);

  safeSend(agentWin,    'points-failed', txn);
  safeSend(settingsWin, 'points-failed', txn);
});

// ── Stats update from agent ───────────────────────────────────────────────────
ipcMain.on('stats-update', (e, s) => {
  // Merge and persist stats from agent
  const current = loadStats();
  const merged  = { ...current, txnCount: s.txnCount ?? current.txnCount, totalAmt: s.totalAmt ?? current.totalAmt };
  saveStats(merged);
  safeSend(settingsWin, 'stats-update', loadStats());
  safeSend(agentWin,    'stats-update', loadStats());
});

// ── Settings save / load ──────────────────────────────────────────────────────
ipcMain.handle('save-settings', (event, data) => {
  const saved = saveSettings(data);
  [agentWin, settingsWin, popupWin].forEach(w => safeSend(w, 'settings-loaded', saved));
  restartPosPolling();
  return saved;
});
ipcMain.handle('load-settings', () => loadSettings());
ipcMain.handle('load-stats',    () => loadStats());
ipcMain.handle('load-txns',     () => loadTxns());
ipcMain.handle('get-db-path',   () => DB_PATH);
ipcMain.on('open-db-folder',    () => shell.showItemInFolder(DB_PATH));

// ── Test POS DB connection ──────────────────────────────────────────────────
ipcMain.handle('test-db-conn', async (event, cfg) => {
  const t = normDbType(cfg.dbType);

  if (t.includes('sqlite')) {
    const posPath = resolveSqlitePosPath(cfg);
    if (!posPath) return { ok: false, message: 'No file path specified.' };
    if (!fs.existsSync(posPath)) return { ok: false, message: `File not found: ${posPath}` };
    let posDb;
    try {
      posDb = new Database(posPath, { readonly: true, fileMustExist: true });
      const tables = posDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map(r => r.name);
      const rowCount = tables.includes(cfg.dbTableTxn || 'Transactions')
        ? posDb.prepare(`SELECT COUNT(*) AS c FROM "${(cfg.dbTableTxn || 'Transactions').replace(/"/g,'""')}"`).get().c
        : null;
      return {
        ok: true,
        dbPath: posPath,
        tables,
        message: `Connected. Tables: ${tables.join(', ') || 'none'}.${rowCount !== null ? ` "${cfg.dbTableTxn || 'Transactions'}" has ${rowCount} row(s).` : ''}`,
      };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      if (posDb) try { posDb.close(); } catch(e) {}
    }
  }

  if (t.includes('sql server') || t.includes('microsoft')) {
    // Close stale pool so test uses fresh config
    if (mssqlPool) {
      try { await mssqlPool.close(); } catch(e) {}
      mssqlPool = null; mssqlPoolKey = '';
    }
    try {
      const pool = await getMssqlPool(cfg);
      const table = quoteMssqlIdent(cfg.dbTableTxn || 'Transactions');
      const result = await pool.request().query(`SELECT COUNT(*) AS c FROM ${table}`);
      const count = result.recordset[0]?.c ?? '?';
      const tbls = await pool.request().query(`
        SELECT TOP 50 TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_SCHEMA, TABLE_NAME
      `);
      const tables = (tbls.recordset || []).map(r => `${r.schema_name}.${r.table_name}`);
      return {
        ok: true,
        tables,
        message: `Connected to ${cfg.dbName}. Found ${tables.length} table(s). "${cfg.dbTableTxn || 'Transactions'}" has ${count} row(s).`,
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  return { ok: false, message: `DB type "${cfg.dbType}" is not supported yet. Supported: SQLite, Microsoft SQL Server.` };
});

// ── Load DB schema for mapping UI ────────────────────────────────────────────
ipcMain.handle('load-db-schema', async (event, cfg) => {
  const t = normDbType(cfg.dbType);
  const selected = String(cfg.dbTableTxn || 'Transactions');

  if (t.includes('sqlite')) {
    const posPath = resolveSqlitePosPath(cfg);
    if (!posPath) return { ok: false, message: 'No file path specified.' };
    if (!fs.existsSync(posPath)) return { ok: false, message: `File not found: ${posPath}` };
    let posDb;
    try {
      posDb = new Database(posPath, { readonly: true, fileMustExist: true });
      const tables = posDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map(r => r.name);

      let columns = [];
      if (tables.includes(selected)) {
        const qTable = `"${selected.replace(/"/g, '""')}"`;
        columns = posDb.prepare(`PRAGMA table_info(${qTable})`).all().map(r => r.name);
      }

      return { ok: true, dbPath: posPath, tables, columns, selectedTable: selected };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      if (posDb) try { posDb.close(); } catch (e) {}
    }
  }

  if (t.includes('sql server') || t.includes('microsoft')) {
    try {
      const pool = await getMssqlPool(cfg);
      const tbls = await pool.request().query(`
        SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_SCHEMA, TABLE_NAME
      `);

      const tableRows = tbls.recordset || [];
      const tables = tableRows.map(r => `${r.schema_name}.${r.table_name}`);

      let columns = [];
      const fallbackTable = tableRows.find(r => String(r.table_name).toLowerCase() === selected.toLowerCase());
      const selectedPair = selected.includes('.')
        ? { schema_name: selected.split('.')[0], table_name: selected.split('.').slice(1).join('.') }
        : fallbackTable;

      if (selectedPair && selectedPair.schema_name && selectedPair.table_name) {
        const colReq = pool.request();
        colReq.input('schema', mssql.NVarChar(128), selectedPair.schema_name);
        colReq.input('table', mssql.NVarChar(128), selectedPair.table_name);
        const cols = await colReq.query(`
          SELECT COLUMN_NAME AS col
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
          ORDER BY ORDINAL_POSITION
        `);
        columns = (cols.recordset || []).map(r => r.col);
      }

      return { ok: true, tables, columns, selectedTable: selectedPair ? `${selectedPair.schema_name}.${selectedPair.table_name}` : selected };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  return { ok: false, message: `DB type "${cfg.dbType}" is not supported yet. Supported: SQLite, Microsoft SQL Server.` };
});

// ── Get latest POS transaction (manual quick check) ─────────────────────────
ipcMain.handle('get-latest-pos-txn', async (event, cfg) => {
  const merged = { ...loadSettings(), ...(cfg || {}) };
  const t = normDbType(merged.dbType);
  const table = String(merged.dbTableTxn || 'Transactions');

  if (t.includes('sqlite')) {
    const posPath = resolveSqlitePosPath(merged);
    if (!posPath) return { ok: false, message: 'No file path specified.' };
    if (!fs.existsSync(posPath)) return { ok: false, message: `File not found: ${posPath}` };

    const sql = buildSelectSql('sqlite', merged);
    const posDb = new Database(posPath, { readonly: true, fileMustExist: true });
    try {
      const row = posDb.prepare(sql).get();
      if (!row) {
        return {
          ok: true,
          found: false,
          dbType: merged.dbType,
          dbPath: posPath,
          table,
          sql,
        };
      }
      return {
        ok: true,
        found: true,
        dbType: merged.dbType,
        dbPath: posPath,
        table,
        sql,
        transaction: {
          invId: normalizeInvoiceId(row.inv_id),
          amt: Number(row.amt || 0),
          txnDate: row.txn_date ?? null,
        },
      };
    } finally {
      posDb.close();
    }
  }

  if (t.includes('sql server') || t.includes('microsoft')) {
    const sql = buildSelectSql('mssql', merged);
    const pool = await getMssqlPool(merged);
    const result = await pool.request().query(sql);
    const row = result && result.recordset && result.recordset[0];
    if (!row) {
      return { ok: true, found: false, dbType: merged.dbType, table, sql };
    }
    return {
      ok: true,
      found: true,
      dbType: merged.dbType,
      table,
      sql,
      transaction: {
        invId: normalizeInvoiceId(row.inv_id),
        amt: Number(row.amt || 0),
        txnDate: row.txn_date ?? null,
      },
    };
  }

  return { ok: false, message: `DB type "${merged.dbType}" is not supported yet. Supported: SQLite, Microsoft SQL Server.` };
});

// ── Feed log ──────────────────────────────────────────────────────────────────
ipcMain.on('feed-log', (e, entry) => safeSend(settingsWin, 'feed-log', entry));

// ── Monitor toggle ────────────────────────────────────────────────────────────
ipcMain.on('monitor-state', (e, isOn) => {
  saveSettings({ monitorOn: isOn });
  [agentWin, settingsWin].forEach(w => {
    if (w && !w.isDestroyed() && w.webContents !== e.sender)
      safeSend(w, 'monitor-state', isOn);
  });
  if (isOn) pollPosOnce();
});

ipcMain.on('agent-state', (e, isOn) => {
  const enabled = !!isOn;
  saveSettings({ agentEnabled: enabled });

  if (!enabled) {
    if (popupWin && !popupWin.isDestroyed()) popupWin.close();
    activeInvId = null;
  } else {
    pollPosOnce();
  }

  [agentWin, settingsWin].forEach(w => {
    if (w && !w.isDestroyed() && w.webContents !== e.sender) {
      safeSend(w, 'agent-state', enabled);
    }
  });
});

// ── Quit ──────────────────────────────────────────────────────────────────────
ipcMain.on('quit-app', () => app.quit());

app.on('before-quit', () => {
  try {
    if (posPollTimer) clearInterval(posPollTimer);
    if (db) db.close();
  } catch(e) {}
  closePosConnections();
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  initDatabase();
  createAgentWindow();
  restartPosPolling();
});
app.on('window-all-closed', e => {
  if (agentWin) e.preventDefault();
  else app.quit();
});
