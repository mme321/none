#!/usr/bin/env node
'use strict';
// סנכרון משורת הפקודה (מתאים להרצה מתוזמנת, למשל cron):
//   MAASER_MASTER_PASSWORD=... npm run sync
const store = require('../src/store');
const { openVault } = require('../src/crypto');
const { syncAll } = require('../src/sync');
const { summarize } = require('../src/calc');

(async () => {
  const db = store.load();
  if (!db.vault) throw new Error('לא הוגדרה סיסמת-על. הפעילו קודם את האפליקציה (npm start).');
  const key = openVault(db.vault, process.env.MAASER_MASTER_PASSWORD || '');
  if (!key) throw new Error('יש להגדיר MAASER_MASTER_PASSWORD נכונה');
  const results = await syncAll(db, key);
  store.save(db);
  const s = summarize(db);
  console.log(`\nהכנסות: ${s.income} ₪ | מעשר (${s.percent}%): ${s.due} ₪ | נתרם: ${s.donated} ₪ | יתרה לתת: ${s.balance} ₪`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
