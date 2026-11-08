'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./src/store');
const auth = require('./src/auth');
const { createVault, openVault, encrypt } = require('./src/crypto');
const { classify, TYPES } = require('./src/classify');
const { summarize } = require('./src/calc');
const { COMPANIES, FIELD_LABELS, syncAll, mergeTransactions } = require('./src/sync');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

// מצב פעיל לכל משתמש – בזיכרון בלבד
// userId -> { key, syncing, log: [], timer }
const live = new Map();
const liveFor = (userId) => {
  if (!live.has(userId)) live.set(userId, { key: null, syncing: false, log: [], timer: null });
  return live.get(userId);
};

// סנכרון אחד בכל פעם בכל השרת (כל סנכרון פותח דפדפן שצורך זיכרון רב)
let syncQueue = Promise.resolve();

const newId = () => crypto.randomBytes(6).toString('hex');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// קישור דיגיטלי לאפליקציית אנדרואיד (Google Play / TWA) – ראו docs/STORE.md
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = process.env.ANDROID_PACKAGE_NAME;
  const fps = (process.env.ANDROID_CERT_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!pkg || !fps.length) return res.json([]);
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps },
    },
  ]);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(auth.sessionMiddleware);
auth.routes(app);

// הגנה מ-CSRF: בקשות משנות חייבות להיות JSON (טופס מאתר זר לא יכול לשלוח כך בלי אישור CORS)
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json'))
    return res.status(415).json({ error: 'נדרש JSON' });
  next();
});

app.get('/api/config', (req, res) => {
  res.json({ googleLogin: auth.googleEnabled, user: req.user ? { email: req.user.email, name: req.user.name } : null });
});

// מכאן והלאה – רק למשתמש מחובר
app.use('/api', auth.requireUser, (req, res, next) => {
  req.db = store.load(req.user.userId);
  req.live = liveFor(req.user.userId);
  req.persist = () => store.save(req.user.userId);
  if (req.user.email && req.db.profile.email !== req.user.email) {
    req.db.profile = { email: req.user.email, name: req.user.name };
    req.persist();
  }
  next();
});

function requireKey(req, res, next) {
  if (!req.live.key) return res.status(401).json({ error: 'יש לפתוח את הכספת עם סיסמת ההצפנה' });
  next();
}

function publicAccount(a) {
  const { credentials, ...rest } = a;
  return { ...rest, companyName: COMPANIES[a.companyId]?.name || a.companyId };
}

// ---------- מצב כללי ----------
app.get('/api/state', (req, res) => {
  const { db, live: l } = req;
  res.json({
    user: { email: req.user.email, name: req.user.name },
    googleLogin: auth.googleEnabled,
    hasVault: !!db.vault,
    unlocked: !!l.key,
    syncing: l.syncing,
    settings: db.settings,
    accounts: db.accounts.map(publicAccount),
    companies: COMPANIES,
    fieldLabels: FIELD_LABELS,
    summary: summarize(db),
  });
});

// ---------- סיסמת הצפנה (כספת) ----------
app.post('/api/setup', (req, res) => {
  if (req.db.vault) return res.status(400).json({ error: 'כבר הוגדרה סיסמת הצפנה' });
  const { password } = req.body || {};
  if (!password || String(password).length < 6)
    return res.status(400).json({ error: 'הסיסמה צריכה להכיל לפחות 6 תווים' });
  const v = createVault(password);
  req.db.vault = v.vault;
  req.live.key = v.key;
  req.persist();
  scheduleAutoSync(req.user.userId);
  res.json({ ok: true });
});

app.post('/api/unlock', (req, res) => {
  if (!req.db.vault) return res.status(400).json({ error: 'לא הוגדרה סיסמת הצפנה' });
  const k = openVault(req.db.vault, (req.body || {}).password || '');
  if (!k) return res.status(401).json({ error: 'סיסמה שגויה' });
  req.live.key = k;
  scheduleAutoSync(req.user.userId);
  res.json({ ok: true });
});

app.post('/api/lock', (req, res) => {
  req.live.key = null;
  scheduleAutoSync(req.user.userId);
  res.json({ ok: true });
});

// איפוס כספת (שכחתי סיסמה): מוחק את פרטי ההתחברות לבנקים, התנועות נשארות
app.post('/api/vault/reset', (req, res) => {
  if ((req.body || {}).confirm !== true) return res.status(400).json({ error: 'נדרש אישור' });
  req.db.vault = null;
  req.db.accounts = []; // אי אפשר לפענח אותם בלי הסיסמה – יש להוסיף מחדש
  req.live.key = null;
  req.persist();
  res.json({ ok: true });
});

// ---------- הגדרות ----------
app.put('/api/settings', (req, res) => {
  const s = req.body || {};
  const percent = Number(s.percent);
  if (!(percent > 0 && percent <= 100)) return res.status(400).json({ error: 'אחוז לא תקין' });
  req.db.settings = {
    percent,
    showChomesh: !!s.showChomesh,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(s.startDate) ? s.startDate : req.db.settings.startDate,
    openingBalance: Number(s.openingBalance) || 0,
    autoSyncHours: Math.max(0, Number(s.autoSyncHours) || 0),
  };
  req.persist();
  scheduleAutoSync(req.user.userId);
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
    label: String(label || company.name).slice(0, 80),
    credentials: encrypt(req.live.key, JSON.stringify(creds)),
    lastSync: null,
    lastError: null,
  };
  req.db.accounts.push(account);
  req.persist();
  res.json(publicAccount(account));
});

app.delete('/api/accounts/:id', (req, res) => {
  const { id } = req.params;
  req.db.accounts = req.db.accounts.filter((a) => a.id !== id);
  if (req.query.purge === '1') req.db.transactions = req.db.transactions.filter((t) => t.accountId !== id);
  req.persist();
  res.json({ ok: true });
});

// ---------- סנכרון ----------
function runSync(userId, accountId) {
  const l = liveFor(userId);
  if (l.syncing || !l.key) return Promise.resolve(null);
  l.syncing = true;
  l.log = [];
  const log = (m) => {
    l.log.push(`${new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })} ${m}`);
    console.log(`[${userId}] ${m}`);
  };
  log('ממתין לתורו...');
  const job = syncQueue.then(async () => {
    try {
      if (!l.key) return null; // ננעל בזמן ההמתנה
      const db = store.load(userId);
      const results = await syncAll(db, l.key, { accountId, log });
      store.save(userId);
      return results;
    } finally {
      l.syncing = false;
    }
  });
  syncQueue = job.catch(() => {});
  return job;
}

app.post('/api/sync', requireKey, async (req, res) => {
  if (req.live.syncing) return res.status(409).json({ error: 'סנכרון כבר רץ' });
  const results = await runSync(req.user.userId, (req.body || {}).accountId);
  res.json({ results, log: req.live.log });
});

app.get('/api/sync/log', (req, res) => res.json({ syncing: req.live.syncing, log: req.live.log }));

function scheduleAutoSync(userId) {
  const l = liveFor(userId);
  if (l.timer) clearInterval(l.timer);
  l.timer = null;
  const hours = Number(store.load(userId).settings.autoSyncHours) || 0;
  if (l.key && hours > 0) {
    l.timer = setInterval(() => runSync(userId).catch((e) => console.error(e)), hours * 3600e3);
    l.timer.unref();
  }
}

// ---------- תנועות ----------
app.get('/api/transactions', (req, res) => {
  const { db } = req;
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
  if (type === 'auto' || !type) delete req.db.overrides[req.params.id];
  else if (TYPES.includes(type)) req.db.overrides[req.params.id] = type;
  else return res.status(400).json({ error: 'סוג לא תקין' });
  req.persist();
  res.json({ ok: true });
});

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
    description: String(description || (type === 'income' ? 'הכנסה ידנית' : 'תרומה ידנית')).slice(0, 200),
    memo: '',
  };
  mergeTransactions(req.db, [tx]);
  req.db.overrides[tx.id] = type;
  req.persist();
  res.json(tx);
});

app.delete('/api/transactions/:id', (req, res) => {
  const { id } = req.params;
  if (!id.startsWith('m-')) return res.status(400).json({ error: 'אפשר למחוק רק תנועות ידניות' });
  req.db.transactions = req.db.transactions.filter((t) => t.id !== id);
  delete req.db.overrides[id];
  req.persist();
  res.json({ ok: true });
});

// ---------- כללי סיווג ----------
app.get('/api/rules', (req, res) => res.json(req.db.rules));

app.post('/api/rules', (req, res) => {
  const { pattern, type } = req.body || {};
  if (!String(pattern || '').trim() || !TYPES.includes(type))
    return res.status(400).json({ error: 'כלל לא תקין' });
  const rule = { id: 'r-' + newId(), pattern: String(pattern).trim().slice(0, 100), type };
  req.db.rules.unshift(rule);
  req.persist();
  res.json(rule);
});

app.delete('/api/rules/:id', (req, res) => {
  req.db.rules = req.db.rules.filter((r) => r.id !== req.params.id);
  req.persist();
  res.json({ ok: true });
});

// ---------- מחיקת חשבון משתמש ----------
app.post('/api/account/delete', (req, res) => {
  if ((req.body || {}).confirm !== true) return res.status(400).json({ error: 'נדרש אישור' });
  const { userId } = req.user;
  const l = live.get(userId);
  if (l?.timer) clearInterval(l.timer);
  live.delete(userId);
  store.remove(userId);
  auth.endUserSessions(userId);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'שגיאת שרת' });
});

if (require.main === module) {
  if (!auth.googleEnabled && !LOOPBACK && process.env.ALLOW_NO_AUTH !== '1') {
    console.error(
      'השרת מאזין לרשת אבל התחברות Google לא מוגדרת. הגדירו GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET ' +
        '(ראו docs/GOOGLE_SETUP.md), או הריצו עם HOST=127.0.0.1.'
    );
    process.exit(1);
  }
  // פתיחה אוטומטית במצב מקומי (למשל שרת ביתי עם cron)
  if (!auth.googleEnabled && process.env.MAASER_MASTER_PASSWORD) {
    const db = store.load('local');
    const k = db.vault && openVault(db.vault, process.env.MAASER_MASTER_PASSWORD);
    if (k) {
      liveFor('local').key = k;
      scheduleAutoSync('local');
    } else console.warn('MAASER_MASTER_PASSWORD שגויה – הכספת נשארת נעולה');
  }
  app.listen(PORT, HOST, () =>
    console.log(`מחשבון מעשר פועל בכתובת http://${HOST}:${PORT} (${auth.googleEnabled ? 'התחברות Google' : 'מצב מקומי'})`)
  );
}

module.exports = { app };
