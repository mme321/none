'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./src/store');
const { createVault, openVault, encrypt } = require('./src/crypto');
const { classify, TYPES } = require('./src/classify');
const { summarize } = require('./src/calc');
const { COMPANIES, FIELD_LABELS, syncAll, mergeTransactions } = require('./src/sync');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // ברירת מחדל: נגיש רק מהמחשב הזה

let db = store.load();
let key = null; // מפתח ההצפנה – נשמר רק בזיכרון כל עוד האפליקציה "פתוחה"
let syncing = false;
let syncLog = [];
let autoTimer = null;

const newId = () => crypto.randomBytes(6).toString('hex');
const persist = () => store.save(db);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireKey(req, res, next) {
  if (!key) return res.status(401).json({ error: 'יש לפתוח את האפליקציה עם סיסמת-העל' });
  next();
}

function publicAccount(a) {
  const { credentials, ...rest } = a;
  return { ...rest, companyName: COMPANIES[a.companyId]?.name || a.companyId };
}

// ---------- מצב כללי ----------
app.get('/api/state', (req, res) => {
  res.json({
    hasVault: !!db.vault,
    unlocked: !!key,
    syncing,
    settings: db.settings,
    accounts: db.accounts.map(publicAccount),
    companies: COMPANIES,
    fieldLabels: FIELD_LABELS,
    summary: summarize(db),
  });
});

// ---------- סיסמת-על ----------
app.post('/api/setup', (req, res) => {
  if (db.vault) return res.status(400).json({ error: 'כבר הוגדרה סיסמת-על' });
  const { password } = req.body || {};
  if (!password || String(password).length < 6)
    return res.status(400).json({ error: 'הסיסמה צריכה להכיל לפחות 6 תווים' });
  const v = createVault(password);
  db.vault = v.vault;
  key = v.key;
  persist();
  scheduleAutoSync();
  res.json({ ok: true });
});

app.post('/api/unlock', (req, res) => {
  if (!db.vault) return res.status(400).json({ error: 'לא הוגדרה סיסמת-על' });
  const k = openVault(db.vault, (req.body || {}).password || '');
  if (!k) return res.status(401).json({ error: 'סיסמה שגויה' });
  key = k;
  scheduleAutoSync();
  res.json({ ok: true });
});

app.post('/api/lock', (req, res) => {
  key = null;
  scheduleAutoSync();
  res.json({ ok: true });
});

// ---------- הגדרות ----------
app.put('/api/settings', (req, res) => {
  const s = req.body || {};
  const percent = Number(s.percent);
  if (!(percent > 0 && percent <= 100)) return res.status(400).json({ error: 'אחוז לא תקין' });
  db.settings = {
    percent,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(s.startDate) ? s.startDate : db.settings.startDate,
    openingBalance: Number(s.openingBalance) || 0,
    autoSyncHours: Math.max(0, Number(s.autoSyncHours) || 0),
  };
  persist();
  scheduleAutoSync();
  res.json({ ok: true });
});

// ---------- חשבונות ----------
app.post('/api/accounts', requireKey, (req, res) => {
  const { companyId, label, credentials } = req.body || {};
  const company = COMPANIES[companyId];
  if (!company) return res.status(400).json({ error: 'גוף לא נתמך' });
  for (const f of company.fields) {
    if (!credentials || !String(credentials[f] || '').trim())
      return res.status(400).json({ error: `חסר שדה: ${FIELD_LABELS[f] || f}` });
  }
  const creds = Object.fromEntries(company.fields.map((f) => [f, String(credentials[f]).trim()]));
  const account = {
    id: newId(),
    companyId,
    label: label || company.name,
    credentials: encrypt(key, JSON.stringify(creds)),
    lastSync: null,
    lastError: null,
  };
  db.accounts.push(account);
  persist();
  res.json(publicAccount(account));
});

app.delete('/api/accounts/:id', (req, res) => {
  const { id } = req.params;
  db.accounts = db.accounts.filter((a) => a.id !== id);
  if (req.query.purge === '1') db.transactions = db.transactions.filter((t) => t.accountId !== id);
  persist();
  res.json({ ok: true });
});

// ---------- סנכרון ----------
async function runSync(accountId) {
  if (syncing || !key) return null;
  syncing = true;
  syncLog = [];
  const log = (m) => {
    syncLog.push(`${new Date().toLocaleTimeString('he-IL')} ${m}`);
    console.log(m);
  };
  try {
    const results = await syncAll(db, key, { accountId, log });
    persist();
    return results;
  } finally {
    syncing = false;
  }
}

app.post('/api/sync', requireKey, async (req, res) => {
  if (syncing) return res.status(409).json({ error: 'סנכרון כבר רץ' });
  const results = await runSync((req.body || {}).accountId);
  res.json({ results, log: syncLog });
});

app.get('/api/sync/log', (req, res) => res.json({ syncing, log: syncLog }));

function scheduleAutoSync() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  const hours = Number(db.settings.autoSyncHours) || 0;
  if (key && hours > 0) {
    autoTimer = setInterval(() => runSync().catch((e) => console.error(e)), hours * 3600e3);
    autoTimer.unref();
  }
}

// ---------- תנועות ----------
app.get('/api/transactions', (req, res) => {
  const { type, q, from, to } = req.query;
  const accName = Object.fromEntries(db.accounts.map((a) => [a.id, a.label]));
  let list = db.transactions.map((t) => ({
    ...t,
    accountLabel: t.source === 'manual' ? 'ידני' : accName[t.accountId] || 'חשבון שנמחק',
    ...classify(t, db.rules, db.overrides),
  }));
  if (type) list = list.filter((t) => t.type === type);
  if (from) list = list.filter((t) => String(t.date).slice(0, 10) >= from);
  if (to) list = list.filter((t) => String(t.date).slice(0, 10) <= to);
  if (q) {
    const s = String(q).toLowerCase();
    list = list.filter((t) => `${t.description} ${t.memo}`.toLowerCase().includes(s));
  }
  res.json(list.slice(0, 2000));
});

app.put('/api/transactions/:id/type', (req, res) => {
  const { type } = req.body || {};
  if (type === 'auto' || !type) delete db.overrides[req.params.id];
  else if (TYPES.includes(type)) db.overrides[req.params.id] = type;
  else return res.status(400).json({ error: 'סוג לא תקין' });
  persist();
  res.json({ ok: true });
});

// הוספה ידנית – למשל הכנסה במזומן או תרומה במזומן
app.post('/api/transactions', (req, res) => {
  const { date, amount, description, type } = req.body || {};
  const amt = Math.abs(Number(amount));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !amt || !['income', 'donation'].includes(type))
    return res.status(400).json({ error: 'נתונים לא תקינים' });
  const tx = {
    id: 'm-' + newId(),
    accountId: 'manual',
    source: 'manual',
    date: new Date(date + 'T12:00:00').toISOString(),
    amount: type === 'income' ? amt : -amt,
    description: description || (type === 'income' ? 'הכנסה ידנית' : 'תרומה ידנית'),
    memo: '',
  };
  mergeTransactions(db, [tx]);
  db.overrides[tx.id] = type;
  persist();
  res.json(tx);
});

app.delete('/api/transactions/:id', (req, res) => {
  const { id } = req.params;
  if (!id.startsWith('m-')) return res.status(400).json({ error: 'אפשר למחוק רק תנועות ידניות' });
  db.transactions = db.transactions.filter((t) => t.id !== id);
  delete db.overrides[id];
  persist();
  res.json({ ok: true });
});

// ---------- כללי סיווג ----------
app.get('/api/rules', (req, res) => res.json(db.rules));

app.post('/api/rules', (req, res) => {
  const { pattern, type } = req.body || {};
  if (!String(pattern || '').trim() || !TYPES.includes(type))
    return res.status(400).json({ error: 'כלל לא תקין' });
  const rule = { id: 'r-' + newId(), pattern: String(pattern).trim(), type };
  db.rules.unshift(rule); // כלל חדש מקבל עדיפות
  persist();
  res.json(rule);
});

app.delete('/api/rules/:id', (req, res) => {
  db.rules = db.rules.filter((r) => r.id !== req.params.id);
  persist();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: String(err.message || err) });
});

if (require.main === module) {
  // אפשרות לפתיחה אוטומטית (למשל בהרצה על שרת ביתי)
  if (process.env.MAASER_MASTER_PASSWORD && db.vault) {
    key = openVault(db.vault, process.env.MAASER_MASTER_PASSWORD);
    if (!key) console.warn('MAASER_MASTER_PASSWORD שגויה – האפליקציה נשארת נעולה');
    scheduleAutoSync();
  }
  app.listen(PORT, HOST, () => console.log(`מחשבון מעשר פועל בכתובת http://${HOST}:${PORT}`));
}

module.exports = { app };
