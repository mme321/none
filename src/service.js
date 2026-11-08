'use strict';
// סנכרון חיבורי בנק: משיכת חשבונות ותנועות מהספקים ושמירה במסד הנתונים.
const db = require('./db');
const { encryptSecret, decryptSecret } = require('./crypto');
const plaid = require('./providers/plaid');
const saltedge = require('./providers/saltedge');

const PROVIDERS = { plaid, saltedge };
const inFlight = new Map(); // connectionId -> Promise

// ---------- עזרי שמירה ----------
async function upsertAccounts(c, conn, accounts) {
  const map = new Map();
  for (const a of accounts) {
    const { rows } = await c.query(
      `INSERT INTO accounts (connection_id, user_id, external_id, name, mask, kind, currency, balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (connection_id, external_id) DO UPDATE
         SET name = EXCLUDED.name, mask = EXCLUDED.mask, kind = EXCLUDED.kind,
             currency = EXCLUDED.currency, balance = EXCLUDED.balance
       RETURNING id, kind`,
      [conn.id, conn.user_id, a.externalId, a.name, a.mask, a.kind, a.currency, a.balance]
    );
    map.set(a.externalId, rows[0]);
  }
  return map;
}

async function upsertTransactions(c, conn, accountMap, txs) {
  let added = 0;
  for (const t of txs) {
    const acc = accountMap.get(t.accountExternalId);
    const { rows } = await c.query(
      `INSERT INTO transactions (user_id, connection_id, account_id, provider, external_id, date, amount, currency, description, memo, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (provider, external_id) DO UPDATE
         SET date = EXCLUDED.date, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
             description = EXCLUDED.description, memo = EXCLUDED.memo, account_id = EXCLUDED.account_id
       RETURNING (xmax = 0) AS inserted`,
      [
        conn.user_id,
        conn.id,
        acc?.id || null,
        conn.provider,
        t.externalId,
        t.date,
        t.amount,
        t.currency,
        t.description.slice(0, 500),
        (t.memo || '').slice(0, 500),
        acc?.kind === 'card' ? 'card' : 'bank',
      ]
    );
    if (rows[0].inserted) added++;
  }
  return added;
}

// ---------- סנכרון לפי ספק ----------
async function syncPlaid(conn) {
  const token = decryptSecret(conn.secret);
  const accounts = await plaid.getAccounts(token);
  const { added, modified, removed, cursor } = await plaid.syncTransactions(token, conn.cursor);
  return db.tx(async (c) => {
    const map = await upsertAccounts(c, conn, accounts);
    const n = await upsertTransactions(c, conn, map, [...added, ...modified]);
    if (removed.length)
      await c.query(`DELETE FROM transactions WHERE provider = 'plaid' AND user_id = $1 AND external_id = ANY($2)`, [
        conn.user_id,
        removed,
      ]);
    await c.query(`UPDATE connections SET cursor = $2 WHERE id = $1`, [conn.id, cursor]);
    return n;
  });
}

async function syncSaltEdge(conn) {
  const accounts = await saltedge.getAccounts(conn.external_id);
  const txs = await saltedge.getTransactions(conn.external_id);
  return db.tx(async (c) => {
    const map = await upsertAccounts(c, conn, accounts);
    return upsertTransactions(c, conn, map, txs);
  });
}

function needsReauth(e) {
  return ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'ConsentExpired', 'ConsentRevoked', 'InvalidCredentials'].includes(e.code);
}

/** מסנכרן חיבור אחד. מחזיר { ok, added } או { ok:false, error }. בטוח לקריאה כפולה. */
function syncConnection(connId) {
  if (inFlight.has(connId)) return inFlight.get(connId);
  const p = (async () => {
    const { rows } = await db.query('SELECT * FROM connections WHERE id = $1', [connId]);
    const conn = rows[0];
    if (!conn) return { ok: false, error: 'not found' };
    try {
      const added = conn.provider === 'plaid' ? await syncPlaid(conn) : await syncSaltEdge(conn);
      await db.query(`UPDATE connections SET last_sync = now(), last_error = NULL, status = 'active' WHERE id = $1`, [connId]);
      return { ok: true, added, name: conn.institution_name };
    } catch (e) {
      console.error(`sync ${conn.provider}#${connId} failed:`, e.code || '', e.message);
      await db.query(`UPDATE connections SET last_error = $2, status = $3 WHERE id = $1`, [
        connId,
        String(e.message).slice(0, 500),
        needsReauth(e) ? 'reauth' : 'error',
      ]);
      return { ok: false, error: e.message, name: conn.institution_name };
    }
  })().finally(() => inFlight.delete(connId));
  inFlight.set(connId, p);
  return p;
}

async function syncUser(userId) {
  const { rows } = await db.query(`SELECT id FROM connections WHERE user_id = $1 ORDER BY id`, [userId]);
  const results = [];
  for (const r of rows) results.push(await syncConnection(r.id));
  return results;
}

/** סנכרון תקופתי של כל החיבורים (גיבוי ל-webhooks). נעילה כדי שרק מכונה אחת תריץ. */
async function syncAllDue(maxAgeHours = 12) {
  const client = await db.getPool().connect();
  try {
    const { rows: lock } = await client.query('SELECT pg_try_advisory_lock(727275) AS ok');
    if (!lock[0].ok) return 0;
    try {
      const { rows } = await client.query(
        `SELECT id FROM connections WHERE status <> 'reauth'
         AND (last_sync IS NULL OR last_sync < now() - $1::interval) ORDER BY last_sync NULLS FIRST LIMIT 200`,
        [`${maxAgeHours} hours`]
      );
      for (const r of rows) await syncConnection(r.id);
      return rows.length;
    } finally {
      await client.query('SELECT pg_advisory_unlock(727275)');
    }
  } finally {
    client.release();
  }
}

// ---------- יצירת חיבורים ----------
async function addPlaidConnection(userId, publicToken) {
  const { accessToken, itemId } = await plaid.exchangePublicToken(publicToken);
  const name = await plaid.institutionName(accessToken).catch(() => null);
  const { rows } = await db.query(
    `INSERT INTO connections (user_id, provider, external_id, institution_name, secret)
     VALUES ($1, 'plaid', $2, $3, $4)
     ON CONFLICT (provider, external_id) DO UPDATE SET secret = EXCLUDED.secret, status = 'active', last_error = NULL
       WHERE connections.user_id = EXCLUDED.user_id
     RETURNING id`,
    [userId, itemId, name, encryptSecret(accessToken)]
  );
  if (!rows[0]) throw new Error('connection belongs to another user');
  return rows[0].id;
}

async function saltEdgeCustomer(userId) {
  const { rows } = await db.query(`SELECT external_id FROM provider_customers WHERE user_id = $1 AND provider = 'saltedge'`, [userId]);
  if (rows[0]) return rows[0].external_id;
  const prefix = process.env.SALTEDGE_CUSTOMER_PREFIX || 'maaser';
  const customerId = await saltedge.createCustomer(`${prefix}-${userId}`);
  await db.query(`INSERT INTO provider_customers (user_id, provider, external_id) VALUES ($1, 'saltedge', $2)`, [userId, customerId]);
  return customerId;
}

/** נקרא מה-callback של Salt Edge או כשהמשתמש חוזר מהחלון. יוצר/מעדכן חיבור לפי לקוח. */
async function upsertSaltEdgeConnection(customerId, connectionId) {
  const { rows: cust } = await db.query(`SELECT user_id FROM provider_customers WHERE provider = 'saltedge' AND external_id = $1`, [
    String(customerId),
  ]);
  if (!cust[0]) return null;
  const info = await saltedge.getConnection(connectionId);
  if (String(info.customer_id) !== String(customerId)) return null;
  const { rows } = await db.query(
    `INSERT INTO connections (user_id, provider, external_id, institution_name)
     VALUES ($1, 'saltedge', $2, $3)
     ON CONFLICT (provider, external_id) DO UPDATE SET institution_name = EXCLUDED.institution_name
       WHERE connections.user_id = EXCLUDED.user_id
     RETURNING id`,
    [cust[0].user_id, String(connectionId), info.provider_name || null]
  );
  return rows[0]?.id || null;
}

async function removeConnection(userId, connId, { purge }) {
  const { rows } = await db.query('SELECT * FROM connections WHERE id = $1 AND user_id = $2', [connId, userId]);
  const conn = rows[0];
  if (!conn) return false;
  try {
    if (conn.provider === 'plaid') await plaid.removeItem(decryptSecret(conn.secret));
    else await saltedge.removeConnection(conn.external_id);
  } catch (e) {
    console.warn('provider removal failed (continuing):', e.message);
  }
  await db.tx(async (c) => {
    if (!purge) {
      // שומרים את התנועות ההיסטוריות, מנתקים אותן מהחיבור
      await c.query(`UPDATE transactions SET connection_id = NULL, account_id = NULL WHERE connection_id = $1`, [connId]);
    }
    await c.query('DELETE FROM connections WHERE id = $1', [connId]);
  });
  return true;
}

/** מחיקת משתמש: מבטל גישה אצל הספקים ומוחק הכל. */
async function deleteUser(userId) {
  const { rows } = await db.query('SELECT id FROM connections WHERE user_id = $1', [userId]);
  for (const r of rows) await removeConnection(userId, r.id, { purge: true });
  const { rows: cust } = await db.query(`SELECT external_id FROM provider_customers WHERE user_id = $1 AND provider = 'saltedge'`, [userId]);
  if (cust[0]) await saltedge.deleteCustomer(cust[0].external_id).catch((e) => console.warn(e.message));
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
}

module.exports = {
  PROVIDERS,
  syncConnection,
  syncUser,
  syncAllDue,
  addPlaidConnection,
  saltEdgeCustomer,
  upsertSaltEdgeConnection,
  removeConnection,
  deleteUser,
};
