'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createVault, openVault, encrypt, decrypt } = require('../src/crypto');
const { classify, DEFAULT_RULES } = require('../src/classify');
const { summarize } = require('../src/calc');
const { normalize, mergeTransactions } = require('../src/sync');

test('vault: correct password opens, wrong fails, roundtrip encryption', () => {
  const { vault, key } = createVault('secret123');
  assert.ok(openVault(vault, 'secret123'));
  assert.equal(openVault(vault, 'wrong'), null);
  const box = encrypt(key, '{"a":1}');
  assert.equal(decrypt(openVault(vault, 'secret123'), box), '{"a":1}');
});

test('classify: defaults, rules and overrides', () => {
  const r = DEFAULT_RULES;
  assert.equal(classify({ id: 1, amount: 5000, source: 'bank', description: 'משכורת' }, r, {}).type, 'income');
  assert.equal(classify({ id: 2, amount: -300, source: 'bank', description: 'סופר' }, r, {}).type, 'expense');
  assert.equal(classify({ id: 3, amount: -180, source: 'card', description: 'תרומה לישיבה' }, r, {}).type, 'donation');
  assert.equal(classify({ id: 4, amount: 180, source: 'bank', description: 'החזר תרומה' }, r, {}).type, 'income');
  assert.equal(classify({ id: 5, amount: 1000, source: 'bank', description: 'משיכה מפיקדון' }, r, {}).type, 'ignore');
  assert.equal(classify({ id: 6, amount: 50, source: 'card', description: 'זיכוי' }, r, {}).type, 'ignore');
  assert.equal(classify({ id: 7, amount: 5000, source: 'bank', description: 'משכורת' }, r, { 7: 'ignore' }).type, 'ignore');
});

test('summarize: income, due, donations, balance, monthly', () => {
  const db = {
    settings: { percent: 10, startDate: '2026-01-01', openingBalance: 100 },
    rules: DEFAULT_RULES,
    overrides: {},
    transactions: [
      { id: 'a', date: '2025-12-31T00:00:00Z', amount: 99999, source: 'bank', description: 'ישן' },
      { id: 'b', date: '2026-01-10T00:00:00Z', amount: 10000, source: 'bank', description: 'משכורת' },
      { id: 'c', date: '2026-01-15T00:00:00Z', amount: -500, source: 'card', description: 'תרומה' },
      { id: 'd', date: '2026-02-10T00:00:00Z', amount: 10000, source: 'bank', description: 'משכורת' },
      { id: 'e', date: '2026-02-11T00:00:00Z', amount: -2000, source: 'bank', description: 'שכר דירה' },
    ],
  };
  const s = summarize(db);
  assert.equal(s.income, 20000);
  assert.equal(s.due, 2100);
  assert.equal(s.donated, 500);
  assert.equal(s.balance, 1600);
  assert.deepEqual(s.monthly.map((m) => m.balance), [600, 1600]);
  db.settings.percent = 20;
  assert.equal(summarize(db).due, 4100);
});

test('normalize + merge: skips pending, dedupes', () => {
  const acc = { id: 'x', companyId: 'leumi' };
  const scraped = [{ accountNumber: '123', txns: [
    { date: '2026-03-01T00:00:00Z', chargedAmount: 100, description: 'a', status: 'completed' },
    { date: '2026-03-02T00:00:00Z', chargedAmount: 50, description: 'b', status: 'pending' },
  ] }];
  const db = { transactions: [] };
  assert.equal(mergeTransactions(db, normalize(acc, scraped)), 1);
  assert.equal(mergeTransactions(db, normalize(acc, scraped)), 0);
  assert.equal(db.transactions[0].source, 'bank');
});
