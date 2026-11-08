'use strict';
// אחסון מקומי פשוט בקובץ JSON (כל הנתונים נשארים על המחשב שלך).
const fs = require('fs');
const path = require('path');
const { DEFAULT_RULES } = require('./classify');

const DATA_DIR = process.env.MAASER_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function defaultDb() {
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  return {
    vault: null, // { salt, verifier }
    settings: {
      percent: 10, // 10 = מעשר, 20 = חומש
      startDate: yearAgo.toISOString().slice(0, 10), // ממתי לחשב
      openingBalance: 0, // יתרת מעשר קודמת (חוב חיובי / זכות שלילי)
      autoSyncHours: 0, // 0 = ללא סנכרון אוטומטי
    },
    accounts: [], // { id, companyId, label, credentials: <encrypted>, lastSync, lastError }
    transactions: [], // ראו sync.js
    overrides: {}, // txId -> 'income' | 'donation' | 'expense' | 'ignore'
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
  };
}

function load() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const def = defaultDb();
    return { ...def, ...db, settings: { ...def.settings, ...(db.settings || {}) } };
  } catch (e) {
    if (e.code === 'ENOENT') return defaultDb();
    throw e;
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

module.exports = { load, save, DB_FILE };
