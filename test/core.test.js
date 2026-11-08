'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { encryptSecret, decryptSecret } = require('../src/crypto');
const { classify, DEFAULT_RULES } = require('../src/classify');
const { summarize } = require('../src/calc');
const plaid = require('../src/providers/plaid');
const saltedge = require('../src/providers/saltedge');

test('secret encryption roundtrip; tamper detected', () => {
  const box = encryptSecret('access-sandbox-123');
  assert.equal(decryptSecret(box), 'access-sandbox-123');
  assert.ok(!JSON.stringify(box).includes('access-sandbox'));
  const bad = { ...box, data: Buffer.from('xxxxxxxxxxxxxxxxxx').toString('base64') };
  assert.throws(() => decryptSecret(bad));
});

test('classify: defaults, rules and overrides', () => {
  const r = DEFAULT_RULES;
  assert.equal(classify({ id: 1, amount: 5000, source: 'bank', description: 'משכורת' }, r, {}).type, 'income');
  assert.equal(classify({ id: 2, amount: -300, source: 'bank', description: 'סופר' }, r, {}).type, 'expense');
  assert.equal(classify({ id: 3, amount: -180, source: 'card', description: 'תרומה לישיבה' }, r, {}).type, 'donation');
  assert.equal(classify({ id: 5, amount: 1000, source: 'bank', description: 'משיכה מפיקדון' }, r, {}).type, 'ignore');
  assert.equal(classify({ id: 6, amount: 50, source: 'card', description: 'זיכוי' }, r, {}).type, 'ignore');
  assert.equal(classify({ id: 7, amount: 5000, source: 'bank', description: 'x' }, r, { 7: 'ignore' }).type, 'ignore');
  assert.equal(classify({ id: 8, amount: -100, source: 'bank', description: 'Charity donation' }, r, {}).type, 'donation');
});

test('summarize: multi-currency with conversion, chomesh, monthly', () => {
  const transactions = [
    { id: 1, date: '2025-12-31', amount: 99999, currency: 'ILS', source: 'bank', description: 'ישן' },
    { id: 2, date: '2026-01-10', amount: 10000, currency: 'ILS', source: 'bank', description: 'משכורת' },
    { id: 3, date: '2026-01-15', amount: -500, currency: 'ILS', source: 'card', description: 'תרומה' },
    { id: 4, date: '2026-02-10', amount: 1000, currency: 'USD', source: 'bank', description: 'Payroll' },
    { id: 5, date: '2026-02-11', amount: -2000, currency: 'ILS', source: 'bank', description: 'שכר דירה' },
    { id: 6, date: '2026-02-12', amount: 300, currency: 'EUR', source: 'bank', description: 'x' },
  ];
  const settings = { percent: 10, start_date: '2026-01-01', opening_balance: 100, base_currency: 'ILS' };
  const convert = (a, c) => (c === 'ILS' ? a : c === 'USD' ? a * 3.5 : null);
  const s = summarize({ transactions, settings, rules: DEFAULT_RULES, convert });
  assert.equal(s.income, 13500);
  assert.equal(s.due, 1450);
  assert.equal(s.donated, 500);
  assert.equal(s.balance, 950);
  assert.equal(s.chomesh.due, 2800);
  assert.equal(s.unconverted, 1);
  assert.deepEqual(s.byCurrency.USD, { income: 1000, donated: 0 });
  assert.deepEqual(s.monthly.map((m) => m.balance), [600, 950]);
});

test('provider normalization: Plaid sign flip, Salt Edge passthrough', () => {
  const p = plaid.normalizeTx({ transaction_id: 't1', account_id: 'a', amount: 25.5, iso_currency_code: 'USD', date: '2026-03-01', name: 'STARBUCKS 123', merchant_name: 'Starbucks', pending: false });
  assert.equal(p.amount, -25.5);
  assert.equal(p.description, 'Starbucks');
  assert.equal(p.memo, 'STARBUCKS 123');
  const s = saltedge.normalizeTx({ id: 9, account_id: 3, amount: 1200, currency_code: 'ILS', made_on: '2026-03-02', description: 'משכורת', status: 'posted', extra: { additional: 'חברה' } });
  assert.deepEqual([s.externalId, s.amount, s.memo, s.pending], ['9', 1200, 'חברה', false]);
});
