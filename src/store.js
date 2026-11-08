'use strict';
// אחסון בקובץ JSON נפרד לכל משתמש. הנתונים נטענים לזיכרון פעם אחת ונשמרים בכל שינוי
// (תהליך שרת יחיד – הזיכרון הוא מקור האמת, כך שאין דריסות בין בקשות).
const fs = require('fs');
const path = require('path');
const { DEFAULT_RULES } = require('./classify');

const DATA_DIR = process.env.MAASER_DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const LEGACY_DB = path.join(DATA_DIR, 'db.json'); // גרסה ראשונה (משתמש יחיד)

const cache = new Map();

function defaultDb() {
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  return {
    profile: {}, // { email, name }
    vault: null, // { salt, verifier }
    settings: {
      percent: 10, // 10 = מעשר, 20 = חומש
      showChomesh: false, // להציג גם חישוב חומש לצד המעשר
      startDate: yearAgo.toISOString().slice(0, 10),
      openingBalance: 0,
      autoSyncHours: 0,
    },
    accounts: [],
    transactions: [],
    overrides: {},
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
  };
}

function fileFor(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(USERS_DIR, `${safe}.json`);
}

function readFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function load(userId) {
  if (cache.has(userId)) return cache.get(userId);
  let raw = readFile(fileFor(userId));
  if (!raw && userId === 'local') raw = readFile(LEGACY_DB);
  const def = defaultDb();
  const db = raw ? { ...def, ...raw, settings: { ...def.settings, ...(raw.settings || {}) } } : def;
  cache.set(userId, db);
  return db;
}

function save(userId) {
  const db = cache.get(userId);
  if (!db) return;
  fs.mkdirSync(USERS_DIR, { recursive: true, mode: 0o700 });
  const file = fileFor(userId);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** מחיקת כל נתוני המשתמש (נדרש גם לפי מדיניות חנויות האפליקציות). */
function remove(userId) {
  cache.delete(userId);
  fs.rmSync(fileFor(userId), { force: true });
  if (userId === 'local') fs.rmSync(LEGACY_DB, { force: true });
}

function listUsers() {
  try {
    return fs.readdirSync(USERS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

module.exports = { load, save, remove, listUsers, DATA_DIR };
