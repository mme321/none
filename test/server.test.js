'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MAASER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maaser-'));
const { app } = require('../server');

test('API flow: setup, account, manual tx, summary, lock', async () => {
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await call('GET', '/api/state')).body.hasVault, false);
    assert.equal((await call('POST', '/api/setup', { password: 'abcdef' })).status, 200);
    const acc = await call('POST', '/api/accounts', { companyId: 'leumi', credentials: { username: 'u', password: 'p' } });
    assert.equal(acc.status, 200);
    assert.equal(acc.body.credentials, undefined);
    const raw = fs.readFileSync(path.join(process.env.MAASER_DATA_DIR, 'db.json'), 'utf8');
    assert.ok(!raw.includes('"p"'), 'credentials must be encrypted on disk');
    const today = new Date().toISOString().slice(0, 10);
    await call('POST', '/api/transactions', { type: 'income', date: today, amount: 1000 });
    await call('POST', '/api/transactions', { type: 'donation', date: today, amount: 30 });
    const s = (await call('GET', '/api/state')).body.summary;
    assert.equal(s.due, 100);
    assert.equal(s.balance, 70);
    await call('POST', '/api/lock');
    assert.equal((await call('POST', '/api/sync')).status, 401);
    assert.equal((await call('POST', '/api/unlock', { password: 'nope12' })).status, 401);
    assert.equal((await call('POST', '/api/unlock', { password: 'abcdef' })).status, 200);
  } finally {
    srv.close();
  }
});
