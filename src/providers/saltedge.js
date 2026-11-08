'use strict';
// Salt Edge – אגרגטור Open Banking עם כיסוי בישראל (לפי תקן הבנקאות הפתוחה של בנק ישראל).
// המשתמש מאשר גישה בחלון של Salt Edge (Connect widget); האפליקציה לא רואה סיסמאות.
// תיעוד: https://docs.saltedge.com/v6/
const crypto = require('crypto');

const baseUrl = () => (process.env.SALTEDGE_BASE_URL || 'https://www.saltedge.com/api/v6').replace(/\/$/, '');
const enabled = () => !!(process.env.SALTEDGE_APP_ID && process.env.SALTEDGE_SECRET);
const sandbox = () => process.env.SALTEDGE_SANDBOX === '1';

class SaltEdgeError extends Error {
  constructor(body, status) {
    super(body?.error?.message || body?.error_message || `Salt Edge HTTP ${status}`);
    this.code = body?.error?.class || body?.error_class;
    this.status = status;
  }
}

function signHeaders(method, url, body) {
  const pem = process.env.SALTEDGE_PRIVATE_KEY;
  if (!pem) return {};
  // נדרש ללקוחות Live: חתימה על "expires|method|url|body" במפתח פרטי RSA
  const expires = Math.floor(Date.now() / 1000) + 60;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${expires}|${method}|${url}|${body || ''}`)
    .sign(pem.replace(/\\n/g, '\n'), 'base64');
  return { 'Expires-at': String(expires), Signature: signature };
}

async function call(method, path, { query, data } = {}) {
  let url = baseUrl() + path;
  if (query) url += '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null));
  const body = data !== undefined ? JSON.stringify({ data }) : undefined;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'App-id': process.env.SALTEDGE_APP_ID,
      Secret: process.env.SALTEDGE_SECRET,
      ...signHeaders(method, url, body),
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new SaltEdgeError(json, res.status);
  return json;
}

async function listAll(path, query) {
  const out = [];
  let fromId;
  for (let page = 0; page < 200; page++) {
    const r = await call('GET', path, { query: { ...query, from_id: fromId, per_page: 1000 } });
    out.push(...(r.data || []));
    fromId = r.meta?.next_id;
    if (!fromId) break;
  }
  return out;
}

async function createCustomer(identifier) {
  const r = await call('POST', '/customers', { data: { identifier } });
  return r.data.customer_id;
}

async function deleteCustomer(customerId) {
  await call('DELETE', `/customers/${encodeURIComponent(customerId)}`);
}

/** מחזיר כתובת לחלון החיבור של Salt Edge. */
async function createConnectUrl({ customerId, returnTo, fromDate }) {
  const r = await call('POST', '/connections/connect', {
    data: {
      customer_id: customerId,
      consent: { scopes: ['accounts', 'transactions'], from_date: fromDate },
      attempt: {
        fetch_scopes: ['accounts', 'balance', 'transactions'],
        fetch_from_date: fromDate,
        return_to: returnTo,
        locale: 'he',
      },
      widget: { allowed_countries: sandbox() ? ['IL', 'XF'] : ['IL'], popular_providers_country: 'IL' },
      provider: { include_sandboxes: sandbox() },
      automatic_refresh: true, // Salt Edge מרענן אוטומטית ושולח callback
      return_connection_id: true, // מוסיף connection_id לכתובת החזרה
    },
  });
  return r.data.connect_url;
}

async function getConnection(connectionId) {
  const r = await call('GET', `/connections/${encodeURIComponent(connectionId)}`);
  return r.data;
}

async function refresh(connectionId) {
  const r = await call('POST', `/connections/${encodeURIComponent(connectionId)}/refresh`, {
    data: { attempt: { fetch_scopes: ['accounts', 'balance', 'transactions'] } },
  });
  return r.data;
}

async function removeConnection(connectionId) {
  await call('DELETE', `/connections/${encodeURIComponent(connectionId)}`);
}

const CARD_NATURES = new Set(['card', 'credit_card', 'debit_card']);

async function getAccounts(connectionId) {
  const list = await listAll('/accounts', { connection_id: connectionId });
  return list.map((a) => ({
    externalId: String(a.id),
    name: a.extra?.account_name || a.name,
    mask: a.extra?.card_type ? String(a.name).slice(-4) : null,
    kind: CARD_NATURES.has(a.nature) ? 'card' : 'bank',
    currency: a.currency_code || 'ILS',
    balance: a.balance ?? null,
  }));
}

function normalizeTx(t) {
  return {
    externalId: String(t.id),
    accountExternalId: String(t.account_id),
    date: t.made_on,
    amount: Number(t.amount), // ב-Salt Edge חיובי = כסף נכנס, כמו אצלנו
    currency: t.currency_code || 'ILS',
    description: t.description || '',
    memo: t.extra?.additional || '',
    pending: t.status === 'pending',
    duplicated: !!t.duplicated,
  };
}

async function getTransactions(connectionId) {
  const list = await listAll('/transactions', { connection_id: connectionId });
  return list.map(normalizeTx).filter((t) => !t.pending && !t.duplicated);
}

/** אימות callback: חתימת RSA של "callback_url|raw_body" במפתח הציבורי של Salt Edge. */
function verifyCallback(callbackUrl, rawBody, signature) {
  const pub = process.env.SALTEDGE_CALLBACK_PUBLIC_KEY;
  if (!pub) return sandbox(); // בלי מפתח – מותר רק בסביבת בדיקות
  if (!signature) return false;
  try {
    return crypto
      .createVerify('RSA-SHA256')
      .update(`${callbackUrl}|${rawBody}`)
      .verify(pub.replace(/\\n/g, '\n'), signature, 'base64');
  } catch {
    return false;
  }
}

module.exports = {
  id: 'saltedge',
  enabled,
  createCustomer,
  deleteCustomer,
  createConnectUrl,
  getConnection,
  refresh,
  removeConnection,
  getAccounts,
  getTransactions,
  verifyCallback,
  normalizeTx,
  SaltEdgeError,
};
