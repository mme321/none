'use strict';
const path = require('path');
const express = require('express');
const db = require('./src/db');
const auth = require('./src/auth');
const fx = require('./src/fx');
const service = require('./src/service');
const plaid = require('./src/providers/plaid');
const saltedge = require('./src/providers/saltedge');
const { classify, TYPES } = require('./src/classify');
const { summarize } = require('./src/calc');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const CURRENCIES = ['ILS', 'USD'];

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const baseUrl = (req) => PUBLIC_URL || `${req.protocol}://${req.headers.host}`;

// ---------- בדיקת בריאות ----------
app.get('/healthz', wrap(async (req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true });
}));

// ---------- Digital Asset Links (אפליקציית Google Play) ----------
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = process.env.ANDROID_PACKAGE_NAME;
  const fps = (process.env.ANDROID_CERT_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!pkg || !fps.length) return res.json([]);
  res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps } }]);
});

// ---------- Webhooks מהספקים (גוף גולמי – נדרש לאימות חתימה) ----------
const raw = express.raw({ type: '*/*', limit: '1mb' });

app.post('/webhooks/plaid', raw, wrap(async (req, res) => {
  const body = req.body.toString('utf8');
  if (!(await plaid.verifyWebhook(body, req.get('plaid-verification')).catch(() => false))) {
    return res.status(401).json({ error: 'bad signature' });
  }
  const msg = JSON.parse(body);
  res.json({ ok: true }); // לענות מהר; העבודה ממשיכה ברקע
  const { rows } = await db.query(`SELECT id FROM connections WHERE provider = 'plaid' AND external_id = $1`, [msg.item_id]);
  if (!rows[0]) return;
  if (msg.webhook_type === 'TRANSACTIONS' && ['SYNC_UPDATES_AVAILABLE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE'].includes(msg.webhook_code)) {
    service.syncConnection(rows[0].id);
  } else if (msg.webhook_type === 'ITEM' && ['ERROR', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT'].includes(msg.webhook_code)) {
    await db.query(`UPDATE connections SET status = 'reauth', last_error = $2 WHERE id = $1`, [
      rows[0].id,
      msg.error?.error_message || 'נדרש חיבור מחדש לבנק',
    ]);
  }
}));

app.post('/webhooks/saltedge/:type', raw, wrap(async (req, res) => {
  const body = req.body.toString('utf8');
  const url = `${baseUrl(req)}/webhooks/saltedge/${req.params.type}`;
  if (!saltedge.verifyCallback(url, body, req.get('signature'))) return res.status(401).json({ error: 'bad signature' });
  const { data } = JSON.parse(body);
  res.json({ ok: true });
  if (!data?.connection_id || !data?.customer_id) return;
  const type = req.params.type;
  if (type === 'destroy') {
    await db.query(`UPDATE connections SET status = 'reauth', last_error = 'הגישה בוטלה בצד הבנק' WHERE provider = 'saltedge' AND external_id = $1`, [String(data.connection_id)]);
  } else if (type === 'fail') {
    await db.query(`UPDATE connections SET status = 'error', last_error = $2 WHERE provider = 'saltedge' AND external_id = $1`, [
      String(data.connection_id),
      `${data.error_class || ''} ${data.error_message || ''}`.trim(),
    ]);
  } else if (type === 'success' && (!data.stage || data.stage === 'finish')) {
    const id = await service.upsertSaltEdgeConnection(data.customer_id, data.connection_id);
    if (id) service.syncConnection(id);
  }
}));

// ---------- קבצים סטטיים + התחברות ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/plaid-oauth', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.json({ limit: '100kb' }));
app.use(auth.sessionMiddleware);
auth.routes(app);

// הגנה מ-CSRF: בקשות משנות חייבות להיות JSON
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json'))
    return res.status(415).json({ error: 'נדרש JSON' });
  // DELETE בלי גוף: דורשים כותרת מותאמת (דפדפן לא שולח אותה מאתר זר בלי אישור CORS)
  if (req.method === 'DELETE' && req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'בקשה לא תקינה' });
  next();
});

app.get('/api/config', (req, res) => {
  res.json({
    googleLogin: auth.googleEnabled,
    devLogin: auth.devLogin,
    providers: { plaid: plaid.enabled(), saltedge: saltedge.enabled() },
    plaidEnv: plaid.env(),
    user: req.user ? { email: req.user.email, name: req.user.name } : null,
  });
});

app.use('/api', auth.requireUser);

async function loadSettings(userId) {
  const { rows } = await db.query('SELECT * FROM settings WHERE user_id = $1', [userId]);
  if (rows[0]) return rows[0];
  const r = await db.query('INSERT INTO settings (user_id) VALUES ($1) RETURNING *', [userId]);
  return r.rows[0];
}

const loadRules = async (userId) =>
  (await db.query('SELECT id, pattern, type FROM rules WHERE user_id = $1 ORDER BY position, id', [userId])).rows;

async function buildSummary(userId, settings) {
  const { rows: txs } = await db.query(
    `SELECT id, date, amount, currency, source, description, memo, type_override
     FROM transactions WHERE user_id = $1 AND date >= $2`,
    [userId, settings.start_date]
  );
  const needs = new Map();
  for (const t of txs) if (!needs.has(t.currency) || needs.get(t.currency) > t.date) needs.set(t.currency, t.date);
  const convert = await fx.converter(settings.base_currency, needs);
  return summarize({ transactions: txs, settings, rules: await loadRules(userId), convert });
}

function publicSettings(s) {
  return {
    percent: Number(s.percent),
    showChomesh: s.show_chomesh,
    startDate: s.start_date,
    openingBalance: Number(s.opening_balance),
    baseCurrency: s.base_currency,
  };
}

// ---------- מצב כללי ----------
app.get('/api/state', wrap(async (req, res) => {
  const uid = req.user.id;
  const settings = await loadSettings(uid);
  const { rows: conns } = await db.query(
    `SELECT id, provider, institution_name, status, last_sync, last_error, created_at FROM connections WHERE user_id = $1 ORDER BY id`,
    [uid]
  );
  const { rows: accounts } = await db.query(
    `SELECT id, connection_id, name, mask, kind, currency, balance FROM accounts WHERE user_id = $1 ORDER BY id`,
    [uid]
  );
  res.json({
    user: { email: req.user.email, name: req.user.name },
    providers: { plaid: plaid.enabled(), saltedge: saltedge.enabled() },
    settings: publicSettings(settings),
    connections: conns.map((c) => ({ ...c, accounts: accounts.filter((a) => String(a.connection_id) === String(c.id)) })),
    summary: await buildSummary(uid, settings),
  });
}));

// ---------- הגדרות ----------
app.put('/api/settings', wrap(async (req, res) => {
  const s = req.body || {};
  const percent = Number(s.percent);
  if (!(percent > 0 && percent <= 100)) return res.status(400).json({ error: 'אחוז לא תקין' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate || '')) return res.status(400).json({ error: 'תאריך לא תקין' });
  if (!CURRENCIES.includes(s.baseCurrency)) return res.status(400).json({ error: 'מטבע לא נתמך' });
  await loadSettings(req.user.id);
  await db.query(
    `UPDATE settings SET percent = $2, show_chomesh = $3, start_date = $4, opening_balance = $5, base_currency = $6 WHERE user_id = $1`,
    [req.user.id, percent, !!s.showChomesh, s.startDate, Number(s.openingBalance) || 0, s.baseCurrency]
  );
  res.json({ ok: true });
}));

// ---------- חיבור בנקים: Plaid (ארה"ב) ----------
app.post('/api/plaid/link-token', wrap(async (req, res) => {
  if (!plaid.enabled()) return res.status(400).json({ error: 'Plaid לא מוגדר בשרת' });
  let accessToken;
  const connId = (req.body || {}).connectionId;
  if (connId) {
    const { rows } = await db.query(`SELECT secret FROM connections WHERE id = $1 AND user_id = $2 AND provider = 'plaid'`, [connId, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'חיבור לא נמצא' });
    accessToken = require('./src/crypto').decryptSecret(rows[0].secret);
  }
  const linkToken = await plaid.createLinkToken({ userId: req.user.id, publicUrl: PUBLIC_URL, accessToken });
  res.json({ linkToken });
}));

app.post('/api/plaid/exchange', wrap(async (req, res) => {
  const { publicToken } = req.body || {};
  if (!publicToken) return res.status(400).json({ error: 'חסר publicToken' });
  const id = await service.addPlaidConnection(req.user.id, publicToken);
  const result = await service.syncConnection(id);
  res.json({ connectionId: id, result });
}));

// ---------- חיבור בנקים: Salt Edge (ישראל) ----------
app.post('/api/saltedge/connect', wrap(async (req, res) => {
  if (!saltedge.enabled()) return res.status(400).json({ error: 'החיבור לבנקים בישראל לא מוגדר בשרת' });
  const settings = await loadSettings(req.user.id);
  const customerId = await service.saltEdgeCustomer(req.user.id);
  const url = await saltedge.createConnectUrl({
    customerId,
    returnTo: `${baseUrl(req)}/?connected=saltedge`,
    fromDate: settings.start_date,
  });
  res.json({ url });
}));

// אחרי החזרה מהחלון: מאתר חיבורים חדשים של הלקוח (למקרה שה-callback עוד לא הגיע)
app.post('/api/saltedge/return', wrap(async (req, res) => {
  const { connectionId } = req.body || {};
  const { rows } = await db.query(`SELECT external_id FROM provider_customers WHERE user_id = $1 AND provider = 'saltedge'`, [req.user.id]);
  if (!rows[0] || !connectionId) return res.json({ ok: false });
  const id = await service.upsertSaltEdgeConnection(rows[0].external_id, String(connectionId));
  if (!id) return res.json({ ok: false });
  const result = await service.syncConnection(id);
  res.json({ ok: true, result });
}));

// ---------- חיבורים ----------
app.post('/api/sync', wrap(async (req, res) => {
  const { connectionId } = req.body || {};
  if (connectionId) {
    const { rows } = await db.query('SELECT id, provider, external_id FROM connections WHERE id = $1 AND user_id = $2', [connectionId, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'חיבור לא נמצא' });
    return res.json({ results: [await service.syncConnection(rows[0].id)] });
  }
  res.json({ results: await service.syncUser(req.user.id) });
}));

app.post('/api/connections/:id/reconnected', wrap(async (req, res) => {
  const { rowCount } = await db.query(`UPDATE connections SET status = 'active', last_error = NULL WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: 'חיבור לא נמצא' });
  res.json({ result: await service.syncConnection(Number(req.params.id)) });
}));

app.delete('/api/connections/:id', wrap(async (req, res) => {
  const ok = await service.removeConnection(req.user.id, req.params.id, { purge: req.query.purge === '1' });
  if (!ok) return res.status(404).json({ error: 'חיבור לא נמצא' });
  res.json({ ok: true });
}));

// ---------- תנועות ----------
app.get('/api/transactions', wrap(async (req, res) => {
  const uid = req.user.id;
  const { type, q, from, to } = req.query;
  const params = [uid];
  let where = 't.user_id = $1';
  if (from) { params.push(from); where += ` AND t.date >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND t.date <= $${params.length}`; }
  if (q) { params.push(`%${String(q).replace(/[%_\\]/g, '\\$&')}%`); where += ` AND (t.description ILIKE $${params.length} OR t.memo ILIKE $${params.length})`; }
  const { rows } = await db.query(
    `SELECT t.id, t.date, t.amount, t.currency, t.description, t.memo, t.source, t.provider, t.type_override,
            COALESCE(c.institution_name, CASE WHEN t.provider = 'manual' THEN 'ידני' ELSE 'חשבון שנותק' END) AS institution,
            a.name AS account_name, a.mask
     FROM transactions t
     LEFT JOIN connections c ON c.id = t.connection_id
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE ${where} ORDER BY t.date DESC, t.id DESC LIMIT 3000`,
    params
  );
  const rules = await loadRules(uid);
  let list = rows.map((t) => ({ ...t, ...classify(t, rules, t.type_override ? { [t.id]: t.type_override } : null) }));
  if (type) list = list.filter((t) => t.type === type);
  res.json(list.slice(0, 2000));
}));

app.put('/api/transactions/:id/type', wrap(async (req, res) => {
  const { type } = req.body || {};
  if (type && type !== 'auto' && !TYPES.includes(type)) return res.status(400).json({ error: 'סוג לא תקין' });
  const value = !type || type === 'auto' ? null : type;
  const { rowCount } = await db.query(
    `UPDATE transactions SET type_override = $3 WHERE id = $1 AND user_id = $2 AND provider <> 'manual'`,
    [req.params.id, req.user.id, value]
  );
  if (!rowCount) return res.status(404).json({ error: 'תנועה לא נמצאה' });
  res.json({ ok: true });
}));

app.post('/api/transactions', wrap(async (req, res) => {
  const { date, amount, description, type, currency } = req.body || {};
  const amt = Math.abs(Number(amount));
  const cur = currency || (await loadSettings(req.user.id)).base_currency;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !amt || !['income', 'donation'].includes(type) || !CURRENCIES.includes(cur))
    return res.status(400).json({ error: 'נתונים לא תקינים' });
  const { rows } = await db.query(
    `INSERT INTO transactions (user_id, provider, external_id, date, amount, currency, description, source, type_override)
     VALUES ($1, 'manual', gen_random_uuid()::text, $2, $3, $4, $5, 'manual', $6) RETURNING id`,
    [req.user.id, date, type === 'income' ? amt : -amt, cur, String(description || (type === 'income' ? 'הכנסה ידנית' : 'תרומה ידנית')).slice(0, 200), type]
  );
  res.json({ id: rows[0].id });
}));

app.delete('/api/transactions/:id', wrap(async (req, res) => {
  const { rowCount } = await db.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2 AND provider = 'manual'`, [req.params.id, req.user.id]);
  if (!rowCount) return res.status(400).json({ error: 'אפשר למחוק רק תנועות ידניות' });
  res.json({ ok: true });
}));

// ---------- כללי סיווג ----------
app.get('/api/rules', wrap(async (req, res) => res.json(await loadRules(req.user.id))));

app.post('/api/rules', wrap(async (req, res) => {
  const { pattern, type } = req.body || {};
  if (!String(pattern || '').trim() || !TYPES.includes(type)) return res.status(400).json({ error: 'כלל לא תקין' });
  const { rows } = await db.query(
    `INSERT INTO rules (user_id, pattern, type, position)
     VALUES ($1, $2, $3, COALESCE((SELECT min(position) FROM rules WHERE user_id = $1), 0) - 1) RETURNING id, pattern, type`,
    [req.user.id, String(pattern).trim().slice(0, 100), type]
  );
  res.json(rows[0]);
}));

app.delete('/api/rules/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM rules WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ---------- מחיקת חשבון משתמש ----------
app.post('/api/account/delete', wrap(async (req, res) => {
  if ((req.body || {}).confirm !== true) return res.status(400).json({ error: 'נדרש אישור' });
  await service.deleteUser(req.user.id);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status && err.status < 500 ? 400 : 500;
  res.status(status).json({ error: err.code === 'ITEM_LOGIN_REQUIRED' ? 'נדרש חיבור מחדש לבנק' : 'שגיאת שרת' });
});

async function start() {
  if (!auth.googleEnabled && !auth.devLogin) {
    console.error('התחברות Google לא מוגדרת (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). ראו docs/GOOGLE_SETUP.md');
    process.exit(1);
  }
  await db.migrate();
  app.listen(PORT, HOST, () => console.log(`מחשבון מעשר פועל על פורט ${PORT}`));
  // סנכרון תקופתי (גיבוי ל-webhooks) וניקוי סשנים
  const hours = Number(process.env.SYNC_INTERVAL_HOURS || 6);
  setInterval(() => service.syncAllDue(hours).catch((e) => console.error('periodic sync', e)), 15 * 60e3).unref();
  setInterval(() => auth.cleanupSessions().catch(() => {}), 3600e3).unref();
}

if (require.main === module) start();

module.exports = { app };
