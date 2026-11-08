'use strict';
// חישוב המעשר: סך הכנסות, מעשר לתשלום, כמה כבר נתרם, ויתרה.
const { classify } = require('./classify');

const round2 = (n) => Math.round(n * 100) / 100;

function summarize(db) {
  const { settings, rules, overrides } = db;
  const pct = Number(settings.percent) || 0;
  const from = settings.startDate || '0000-00-00';

  let income = 0;
  let donated = 0;
  const months = new Map();

  const month = (key) => {
    if (!months.has(key)) months.set(key, { month: key, income: 0, donated: 0 });
    return months.get(key);
  };

  for (const tx of db.transactions) {
    const day = String(tx.date).slice(0, 10);
    if (day < from) continue;
    const { type } = classify(tx, rules, overrides);
    const m = month(day.slice(0, 7));
    if (type === 'income') {
      income += tx.amount;
      m.income += tx.amount;
    } else if (type === 'donation') {
      // תרומה היא חיוב (סכום שלילי) – נספרת כחיובית
      donated += -tx.amount;
      m.donated += -tx.amount;
    }
  }

  const opening = Number(settings.openingBalance) || 0;
  const due = (income * pct) / 100 + opening;

  // יתרה מצטברת לפי חודשים
  let running = opening;
  const monthly = [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const mDue = (m.income * pct) / 100;
      running += mDue - m.donated;
      return {
        month: m.month,
        income: round2(m.income),
        due: round2(mDue),
        donated: round2(m.donated),
        balance: round2(running),
      };
    });

  return {
    percent: pct,
    income: round2(income),
    opening: round2(opening),
    due: round2(due),
    donated: round2(donated),
    balance: round2(due - donated), // חיובי = נשאר לתת; שלילי = נתת מעבר (זכות)
    monthly,
  };
}

module.exports = { summarize };
