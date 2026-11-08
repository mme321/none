'use strict';
// בדיקת אינטגרציה מלאה מול PostgreSQL אמיתי וספקים מדומים.
// דורש DATABASE_URL (למשל: docker run -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16-alpine)
const test = require('node:test');
const assert = require('node:assert');
const { listen, fakePlaid, fakeSaltEdge, fakeFx } = require('./fakes');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('full flow: login, TD Bank via Plaid, Israeli bank via Salt Edge, ma\'aser in ILS', { skip: !DB_URL && 'no DATABASE_URL' }, async (t) => {
  const plaidF = fakePlaid();
  const seF = fakeSaltEdge();
  const servers = [await listen(plaidF.handler), await listen(seF.handler), await listen(fakeFx())];
  const [pl, se, fxs] = servers;

  Object.assign(process.env, {
    DATABASE_URL: DB_URL,
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    DEV_LOGIN: '1',
    NODE_ENV: 'test',
    PLAID_CLIENT_ID: 'cid',
    PLAID_SECRET: 'sec',
    PLAID_BASE_URL: pl.url,
    SALTEDGE_APP_ID: 'app',
    SALTEDGE_SECRET: 'sec',
    SALTEDGE_BASE_URL: se.url,
    SALTEDGE_CALLBACK_PUBLIC_KEY: seF.state.signing.publicKey.export({ type: 'spki', format: 'pem' }),
    FX_BASE_URL: fxs.url,
  });
  const db = require('../src/db');
  // מסד נקי
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  await db.migrate(); // אידמפוטנטי
  const { app } = require('../server');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;

  t.after(async () => {
    srv.close();
    servers.forEach((s) => s.srv.close());
    await db.close();
  });

  const client = () => {
    let cookie = '';
    return async (method, url, body, extra = {}) => {
      const headers = { 'X-Requested-With': 'fetch', cookie, ...extra };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set && set.startsWith('sid=')) cookie = set.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => null) };
    };
  };

  const a = client();
  assert.equal((await a('GET', '/api/state')).status, 401);
  assert.equal((await a('POST', '/auth/dev', { email: 'a@example.com' })).status, 200);
  let st = (await a('GET', '/api/state')).body;
  assert.equal(st.user.email, 'a@example.com');
  assert.deepEqual(st.providers, { plaid: true, saltedge: true });

  // --- TD Bank דרך Plaid ---
  const lt = await a('POST', '/api/plaid/link-token', {});
  assert.equal(lt.body.linkToken, 'link-sandbox-abc');
  assert.deepEqual(plaidF.state.lastLinkBody.products, ['transactions']);
  const ex = await a('POST', '/api/plaid/exchange', { publicToken: 'public-1' });
  assert.equal(ex.status, 200);
  assert.equal(ex.body.result.ok, true);
  assert.equal(ex.body.result.added, 3, 'pending transaction skipped');
  const raw = (await db.query(`SELECT secret FROM connections WHERE provider='plaid'`)).rows[0].secret;
  assert.ok(!JSON.stringify(raw).includes('access-1'), 'access token encrypted at rest');

  // --- בנק ישראלי דרך Salt Edge ---
  const cn = await a('POST', '/api/saltedge/connect', {});
  assert.match(cn.body.url, /saltedge\.com\/connect/);
  assert.deepEqual(seF.state.lastConnect.widget.allowed_countries, ['IL']);
  const seConnId = cn.body.url.split('conn=')[1];
  const ret = await a('POST', '/api/saltedge/return', { connectionId: seConnId });
  assert.equal(ret.body.ok, true);
  assert.equal(ret.body.result.added, 3, 'paged, pending skipped');

  // --- סיכום: ₪20,000 + $5,000×3.7 = ₪38,500 הכנסות; תרומות ₪1,000 + $100×3.7 ---
  st = (await a('GET', '/api/state')).body;
  assert.equal(st.connections.length, 2);
  assert.equal(st.connections.find((c) => c.provider === 'plaid').institution_name, 'TD Bank');
  const s = st.summary;
  assert.equal(s.currency, 'ILS');
  assert.equal(s.income, 38500);
  assert.equal(s.donated, 1370);
  assert.equal(s.due, 3850);
  assert.equal(s.balance, 2480);
  assert.deepEqual(s.byCurrency.USD, { income: 5000, donated: 100 });

  // מעבר למטבע בסיס דולר
  assert.equal((await a('PUT', '/api/settings', { percent: 10, showChomesh: true, baseCurrency: 'USD', startDate: '2026-01-01', openingBalance: 0 })).status, 200);
  const sUsd = (await a('GET', '/api/state')).body.summary;
  assert.equal(sUsd.currency, 'USD');
  assert.ok(Math.abs(sUsd.income - (5000 + 20000 / 3.7)) < 0.02);

  // סיווג ידני + כלל
  const txs = (await a('GET', '/api/transactions')).body;
  const transfer = txs.find((x) => x.description === 'העברה בין חשבונות');
  assert.equal(transfer.type, 'ignore');
  const groceries = txs.find((x) => x.description === 'Grocery');
  assert.equal(groceries.source, 'card');
  assert.equal((await a('PUT', `/api/transactions/${transfer.id}/type`, { type: 'income' })).status, 200);
  assert.equal((await a('GET', '/api/transactions?type=income')).body.length, 3);
  const rule = await a('POST', '/api/rules', { pattern: 'ACME', type: 'ignore' });
  assert.equal((await a('GET', '/api/rules')).body[0].id, rule.body.id, 'new rule first');

  // --- webhook של Plaid: חתימה נדרשת ---
  plaidF.state.removeP3 = true;
  const hook = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-1' });
  let r = await fetch(base + '/webhooks/plaid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: hook });
  assert.equal(r.status, 401, 'unsigned webhook rejected');
  r = await fetch(base + '/webhooks/plaid', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Plaid-Verification': plaidF.state.signWebhook(hook) }, body: hook });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!(await a('GET', '/api/transactions')).body.some((x) => x.description === 'Grocery'), 'removed tx deleted');

  // --- callback של Salt Edge: חתימה נדרשת ---
  const cbBody = JSON.stringify({ data: { connection_id: seConnId, customer_id: '1000', custom_fields: {} }, meta: { version: '6' } });
  const cbUrl = `${base}/webhooks/saltedge/fail`;
  r = await fetch(cbUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Signature: 'bad' }, body: cbBody });
  assert.equal(r.status, 401);
  r = await fetch(cbUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Signature: seF.state.sign(cbUrl, cbBody) }, body: cbBody });
  assert.equal(r.status, 200);

  // --- Plaid דורש התחברות מחדש ---
  plaidF.state.loginRequired = true;
  const plaidConn = st.connections.find((c) => c.provider === 'plaid');
  const sync = await a('POST', '/api/sync', { connectionId: plaidConn.id });
  assert.equal(sync.body.results[0].ok, false);
  assert.equal((await a('GET', '/api/state')).body.connections.find((c) => c.id === plaidConn.id).status, 'reauth');

  // --- בידוד בין משתמשים ---
  const b = client();
  await b('POST', '/auth/dev', { email: 'b@example.com' });
  const sb = (await b('GET', '/api/state')).body;
  assert.equal(sb.connections.length, 0);
  assert.equal((await b('GET', '/api/transactions')).body.length, 0);
  assert.equal((await b('POST', '/api/sync', { connectionId: plaidConn.id })).status, 404);
  assert.equal((await b('DELETE', `/api/connections/${plaidConn.id}`)).status, 404);
  assert.equal((await b('PUT', `/api/transactions/${transfer.id}/type`, { type: 'ignore' })).status, 404);
  assert.equal((await b('POST', '/api/saltedge/return', { connectionId: seConnId })).body.ok, false, 'cannot claim another user\'s connection');

  // --- CSRF ---
  assert.equal((await a('POST', '/api/sync', undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await a('DELETE', `/api/connections/${plaidConn.id}`, undefined, { 'X-Requested-With': '' })).status, 403);

  // --- ניתוק (שמירת תנועות) ומחיקת משתמש ---
  assert.equal((await a('DELETE', `/api/connections/${plaidConn.id}`)).status, 200);
  assert.deepEqual(plaidF.state.removed, ['access-1'], 'item removed at Plaid');
  assert.ok((await a('GET', '/api/transactions')).body.some((x) => x.description === 'ACME PAYROLL'), 'history kept');
  assert.equal((await a('POST', '/api/account/delete', { confirm: true })).status, 200);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM transactions WHERE user_id IN (SELECT id FROM users WHERE email='a@example.com')`)).rows[0].n, 0);
  assert.equal((await a('GET', '/api/state')).status, 401, 'session gone with user');
});
