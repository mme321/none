'use strict';
// Plaid – חיבור לבנקים בארה"ב (כולל TD Bank, דרך הסכם API ישיר בין TD ל-Plaid).
// המשתמש מתחבר לבנק בחלון של Plaid (Plaid Link); האפליקציה מקבלת רק access token לקריאה.
const crypto = require('crypto');

const ENVS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

const env = () => process.env.PLAID_ENV || 'sandbox';
const baseUrl = () => process.env.PLAID_BASE_URL || ENVS[env()] || ENVS.sandbox;
const enabled = () => !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

class PlaidError extends Error {
  constructor(body, status) {
    super(body?.error_message || `Plaid HTTP ${status}`);
    this.code = body?.error_code;
    this.type = body?.error_type;
    this.status = status;
  }
}

async function call(path, body = {}) {
  const res = await fetch(baseUrl() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlaidError(json, res.status);
  return json;
}

/** יוצר link_token לפתיחת Plaid Link בדפדפן. */
async function createLinkToken({ userId, publicUrl, accessToken }) {
  const body = {
    user: { client_user_id: String(userId) },
    client_name: 'Maaser Calculator',
    country_codes: (process.env.PLAID_COUNTRY_CODES || 'US').split(','),
    language: 'en',
  };
  if (accessToken) body.access_token = accessToken; // מצב "עדכון" – חיבור מחדש אחרי שפג תוקף
  else {
    body.products = ['transactions'];
    body.transactions = { days_requested: 730 };
  }
  if (publicUrl) body.webhook = `${publicUrl}/webhooks/plaid`;
  // בנקים עם OAuth (כמו TD Bank) מחזירים את המשתמש לכתובת הזו; חייבת להיות רשומה בדשבורד של Plaid
  if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;
  const r = await call('/link/token/create', body);
  return r.link_token;
}

async function exchangePublicToken(publicToken) {
  const r = await call('/item/public_token/exchange', { public_token: publicToken });
  return { accessToken: r.access_token, itemId: r.item_id };
}

async function institutionName(accessToken) {
  const { item } = await call('/item/get', { access_token: accessToken });
  if (!item?.institution_id) return null;
  try {
    const r = await call('/institutions/get_by_id', {
      institution_id: item.institution_id,
      country_codes: (process.env.PLAID_COUNTRY_CODES || 'US').split(','),
    });
    return r.institution?.name || null;
  } catch {
    return null;
  }
}

async function getAccounts(accessToken) {
  const r = await call('/accounts/get', { access_token: accessToken });
  return r.accounts.map((a) => ({
    externalId: a.account_id,
    name: a.official_name || a.name,
    mask: a.mask,
    kind: a.type === 'credit' ? 'card' : 'bank',
    currency: a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || 'USD',
    balance: a.balances?.current ?? null,
  }));
}

function normalizeTx(t) {
  return {
    externalId: t.transaction_id,
    accountExternalId: t.account_id,
    date: t.date,
    amount: -Number(t.amount), // ב-Plaid חיובי = כסף יוצא; אצלנו חיובי = כסף נכנס
    currency: t.iso_currency_code || t.unofficial_currency_code || 'USD',
    description: t.merchant_name || t.name || '',
    memo: t.merchant_name && t.name && t.name !== t.merchant_name ? t.name : '',
    pending: !!t.pending,
  };
}

/**
 * מושך שינויים מאז ה-cursor האחרון (/transactions/sync).
 * מחזיר { added, modified, removed, cursor }. תנועות ממתינות מסוננות (יגיעו שוב כשיסתיימו).
 */
async function syncTransactions(accessToken, cursor) {
  const added = [];
  const modified = [];
  const removed = [];
  let next = cursor || undefined;
  for (let page = 0; page < 50; page++) {
    const r = await call('/transactions/sync', { access_token: accessToken, cursor: next, count: 500 });
    added.push(...r.added.map(normalizeTx));
    modified.push(...r.modified.map(normalizeTx));
    removed.push(...r.removed.map((t) => t.transaction_id));
    next = r.next_cursor;
    if (!r.has_more) break;
  }
  const posted = (list) => list.filter((t) => !t.pending);
  return { added: posted(added), modified: posted(modified), removed, cursor: next };
}

async function removeItem(accessToken) {
  await call('/item/remove', { access_token: accessToken });
}

// ---------- אימות webhooks (JWT ES256 בכותרת Plaid-Verification) ----------
const keyCache = new Map();

async function verificationKey(kid) {
  const hit = keyCache.get(kid);
  if (hit && hit.expires > Date.now()) return hit.key;
  const r = await call('/webhook_verification_key/get', { key_id: kid });
  const key = crypto.createPublicKey({ key: r.key, format: 'jwk' });
  keyCache.set(kid, { key, expires: Date.now() + 3600e3 });
  return key;
}

async function verifyWebhook(rawBody, jwt) {
  if (!jwt) return false;
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return false;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  if (header.alg !== 'ES256' || !header.kid) return false;
  const key = await verificationKey(header.kid);
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!ok) return false;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (Math.abs(Date.now() / 1000 - payload.iat) > 300) return false;
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(bodyHash), Buffer.from(String(payload.request_body_sha256 || '').padEnd(64).slice(0, 64)));
}

module.exports = {
  id: 'plaid',
  enabled,
  env,
  createLinkToken,
  exchangePublicToken,
  institutionName,
  getAccounts,
  syncTransactions,
  removeItem,
  verifyWebhook,
  normalizeTx,
  PlaidError,
};
