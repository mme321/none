'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MAASER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maaser-'));
delete process.env.GOOGLE_CLIENT_ID;
const { app } = require('../server');

async function withServer(fn) {
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body && JSON.stringify(body),
      redirect: 'manual',
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    await fn(call);
  } finally {
    srv.close();
  }
}

test('local mode API flow: vault, account, manual tx, chomesh, lock, delete', () =>
  withServer(async (call) => {
    assert.equal((await call('GET', '/api/state')).body.hasVault, false);
    assert.equal((await call('POST', '/api/setup', { password: 'abcdef' })).status, 200);
    const acc = await call('POST', '/api/accounts', { companyId: 'leumi', credentials: { username: 'u', password: 'p' } });
    assert.equal(acc.status, 200);
    assert.equal(acc.body.credentials, undefined);
    const raw = fs.readFileSync(path.join(process.env.MAASER_DATA_DIR, 'users', 'local.json'), 'utf8');
    assert.ok(!raw.includes('"p"'), 'credentials must be encrypted on disk');
    const today = new Date().toISOString().slice(0, 10);
    await call('POST', '/api/transactions', { type: 'income', date: today, amount: 1000 });
    await call('POST', '/api/transactions', { type: 'donation', date: today, amount: 30 });
    const s = (await call('GET', '/api/state')).body.summary;
    assert.equal(s.due, 100);
    assert.equal(s.balance, 70);
    assert.equal(s.chomesh.balance, 170);
    const st = await call('PUT', '/api/settings', { percent: 10, showChomesh: true, startDate: '2020-01-01', openingBalance: 0, autoSyncHours: 0 });
    assert.equal(st.status, 200);
    assert.equal((await call('GET', '/api/state')).body.settings.showChomesh, true);
    // CSRF guard: non-JSON POST rejected
    assert.equal((await call('POST', '/api/lock', null, { 'Content-Type': 'text/plain' })).status, 415);
    await call('POST', '/api/lock', {});
    assert.equal((await call('POST', '/api/sync', {})).status, 401);
    assert.equal((await call('POST', '/api/unlock', { password: 'nope12' })).status, 401);
    assert.equal((await call('POST', '/api/unlock', { password: 'abcdef' })).status, 200);
    assert.equal((await call('POST', '/api/account/delete', { confirm: true })).status, 200);
    assert.equal((await call('GET', '/api/state')).body.hasVault, false);
  }));
