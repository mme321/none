'use strict';
// שרתים מדומים של Plaid, Salt Edge ו-Frankfurter לבדיקות אינטגרציה
const http = require('http');
const crypto = require('crypto');

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      const url = new URL(req.url, 'http://x');
      let json = {};
      try { json = body ? JSON.parse(body) : {}; } catch {}
      const out = await handler({ method: req.method, path: url.pathname, query: url.searchParams, body: json, headers: req.headers });
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json ?? {}));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function fakePlaid() {
  const state = { items: {}, removed: [], webhookKey: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) };
  const txs = (n) => [
    { transaction_id: 'p1', account_id: 'acc-chk', amount: -5000, iso_currency_code: 'USD', date: '2026-10-01', name: 'ACME PAYROLL', merchant_name: null, pending: false },
    { transaction_id: 'p2', account_id: 'acc-chk', amount: 100, iso_currency_code: 'USD', date: '2026-10-03', name: 'Charity Donation', merchant_name: null, pending: false },
    { transaction_id: 'p3', account_id: 'acc-cc', amount: 40, iso_currency_code: 'USD', date: '2026-10-04', name: 'GROCERY', merchant_name: 'Grocery', pending: false },
    { transaction_id: 'p4', account_id: 'acc-chk', amount: -999, iso_currency_code: 'USD', date: '2026-10-05', name: 'PENDING', merchant_name: null, pending: true },
  ].slice(0, n);
  const handler = ({ path, body }) => {
    if (body.client_id !== 'cid' || body.secret !== 'sec') return { status: 400, json: { error_code: 'INVALID_API_KEYS', error_message: 'bad keys' } };
    switch (path) {
      case '/link/token/create':
        state.lastLinkBody = body;
        return { json: { link_token: 'link-sandbox-abc' } };
      case '/item/public_token/exchange':
        state.items['access-1'] = { item_id: 'item-1', cursor: 0 };
        return { json: { access_token: 'access-1', item_id: 'item-1' } };
      case '/item/get':
        return { json: { item: { institution_id: 'ins_td' } } };
      case '/institutions/get_by_id':
        return { json: { institution: { name: 'TD Bank' } } };
      case '/accounts/get':
        return { json: { accounts: [
          { account_id: 'acc-chk', name: 'TD Checking', mask: '1234', type: 'depository', balances: { current: 1000, iso_currency_code: 'USD' } },
          { account_id: 'acc-cc', name: 'TD Card', mask: '9999', type: 'credit', balances: { current: 40, iso_currency_code: 'USD' } },
        ] } };
      case '/transactions/sync': {
        const it = state.items[body.access_token];
        if (state.loginRequired) return { status: 400, json: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' } };
        if (!body.cursor) return { json: { added: txs(4), modified: [], removed: [], next_cursor: 'c1', has_more: false } };
        if (body.cursor === 'c1' && state.removeP3) return { json: { added: [], modified: [], removed: [{ transaction_id: 'p3' }], next_cursor: 'c2', has_more: false } };
        return { json: { added: [], modified: [], removed: [], next_cursor: body.cursor, has_more: false } };
      }
      case '/item/remove':
        state.removed.push(body.access_token);
        return { json: {} };
      case '/webhook_verification_key/get':
        return { json: { key: { ...state.webhookKey.publicKey.export({ format: 'jwk' }), kid: body.key_id, alg: 'ES256', use: 'sig' } } };
      default:
        return { status: 404, json: { error_message: 'unknown ' + path } };
    }
  };
  state.signWebhook = (rawBody) => {
    const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), request_body_sha256: crypto.createHash('sha256').update(rawBody).digest('hex') })).toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: state.webhookKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  return { state, handler };
}

function fakeSaltEdge() {
  const state = { customers: {}, connections: {}, signing: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) };
  const handler = ({ method, path, query, body, headers }) => {
    if (headers['app-id'] !== 'app' || headers.secret !== 'sec') return { status: 401, json: { error: { class: 'Unauthorized', message: 'bad' } } };
    if (method === 'POST' && path === '/customers') {
      const id = String(1000 + Object.keys(state.customers).length);
      state.customers[id] = body.data.identifier;
      return { json: { data: { customer_id: id, identifier: body.data.identifier } } };
    }
    if (method === 'POST' && path === '/connections/connect') {
      state.lastConnect = body.data;
      const connId = String(5000 + Object.keys(state.connections).length);
      state.connections[connId] = { id: connId, customer_id: body.data.customer_id, provider_name: 'בנק לאומי' };
      return { json: { data: { connect_url: `https://www.saltedge.com/connect?token=t&conn=${connId}`, customer_id: body.data.customer_id } } };
    }
    let m;
    if ((m = path.match(/^\/connections\/(\w+)$/)) && method === 'GET') {
      const c = state.connections[m[1]];
      return c ? { json: { data: c } } : { status: 404, json: { error: { class: 'ConnectionNotFound' } } };
    }
    if ((m = path.match(/^\/connections\/(\w+)$/)) && method === 'DELETE') {
      delete state.connections[m[1]];
      return { json: { data: { id: m[1], removed: true } } };
    }
    if (method === 'DELETE' && path.startsWith('/customers/')) return { json: { data: { deleted: true } } };
    if (path === '/accounts') {
      return { json: { data: [
        { id: 11, connection_id: query.get('connection_id'), name: 'עו"ש', nature: 'account', currency_code: 'ILS', balance: 5000 },
        { id: 12, connection_id: query.get('connection_id'), name: '4580', nature: 'credit_card', currency_code: 'ILS', balance: -300 },
      ], meta: { next_id: null } } };
    }
    if (path === '/transactions') {
      const all = [
        { id: 1, account_id: 11, made_on: '2026-10-01', amount: 20000, currency_code: 'ILS', description: 'משכורת', status: 'posted', duplicated: false, extra: {} },
        { id: 2, account_id: 12, made_on: '2026-10-02', amount: -1000, currency_code: 'ILS', description: 'תרומה לקופת העיר', status: 'posted', duplicated: false, extra: {} },
        { id: 3, account_id: 11, made_on: '2026-10-03', amount: 3000, currency_code: 'ILS', description: 'העברה בין חשבונות', status: 'posted', duplicated: false, extra: {} },
        { id: 4, account_id: 11, made_on: '2026-10-04', amount: 777, currency_code: 'ILS', description: 'ממתין', status: 'pending', duplicated: false, extra: {} },
      ];
      // עמוד ראשון/שני לבדיקת דפדוף
      if (!query.get('from_id')) return { json: { data: all.slice(0, 2), meta: { next_id: '3' } } };
      return { json: { data: all.slice(2), meta: { next_id: null } } };
    }
    return { status: 404, json: { error: { class: 'NotFound', message: path } } };
  };
  state.sign = (url, raw) => crypto.createSign('RSA-SHA256').update(`${url}|${raw}`).sign(state.signing.privateKey, 'base64');
  return { state, handler };
}

function fakeFx() {
  return ({ path, query }) => {
    // /2026-..../..2026-..?base=USD&symbols=ILS -> שער קבוע 3.7
    const [from] = path.slice(1).split('..');
    const rates = {};
    const d = new Date(from + 'T00:00:00Z');
    for (let i = 0; i < 60; i++) {
      const day = new Date(d.getTime() + i * 864e5).toISOString().slice(0, 10);
      if (day > new Date().toISOString().slice(0, 10)) break;
      rates[day] = { [query.get('symbols')]: query.get('base') === 'USD' ? 3.7 : 1 / 3.7 };
    }
    return { json: { base: query.get('base'), rates } };
  };
}

module.exports = { listen, fakePlaid, fakeSaltEdge, fakeFx };
