'use strict';
// חישוב המעשר: סך הכנסות, מעשר לתשלום, כמה נתרם, ויתרה – במטבע הבסיס של המשתמש.
// מחשב גם חומש (20%) במקביל, ופירוט לפי מטבע מקורי.
const { classify } = require('./classify');

const round2 = (n) => Math.round(n * 100) / 100;
const CHOMESH = 20;

/**
 * @param {object} p
 * @param {Array} p.transactions  { id, date, amount, currency, source, description, memo, type_override }
 * @param {object} p.settings     { percent, start_date, opening_balance, base_currency }
 * @param {Array} p.rules
 * @param {Function} [p.convert]  (amount, currency, date) => number|null
 */
function summarize({ transactions, settings, rules, convert }) {
  const pct = Number(settings.percent) || 0;
  const from = String(settings.start_date || '0000-00-00').slice(0, 10);
  const base = settings.base_currency || 'ILS';
  const conv = convert || ((a, c) => (c === base ? a : null));

  let income = 0;
  let donated = 0;
  let unconverted = 0;
  const months = new Map();
  const byCurrency = {};

  for (const tx of transactions) {
    const day = String(tx.date).slice(0, 10);
    if (day < from) continue;
    const { type } = classify(tx, rules, tx.type_override ? { [tx.id]: tx.type_override } : null);
    if (type !== 'income' && type !== 'donation') continue;

    const cur = (byCurrency[tx.currency] ||= { income: 0, donated: 0 });
    const value = type === 'income' ? tx.amount : -tx.amount; // תרומה היא חיוב (שלילי)
    if (type === 'income') cur.income += value;
    else cur.donated += value;

    const inBase = conv(value, tx.currency, day);
    if (inBase === null) {
      unconverted++;
      continue;
    }
    const key = day.slice(0, 7);
    if (!months.has(key)) months.set(key, { month: key, income: 0, donated: 0 });
    const m = months.get(key);
    if (type === 'income') {
      income += inBase;
      m.income += inBase;
    } else {
      donated += inBase;
      m.donated += inBase;
    }
  }

  const opening = Number(settings.opening_balance) || 0;
  const level = (p) => {
    const due = (income * p) / 100 + opening;
    return { percent: p, due: round2(due), balance: round2(due - donated) };
  };

  let running = opening;
  let runningC = opening;
  const monthly = [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const mDue = (m.income * pct) / 100;
      const mDueC = (m.income * CHOMESH) / 100;
      running += mDue - m.donated;
      runningC += mDueC - m.donated;
      return {
        month: m.month,
        income: round2(m.income),
        due: round2(mDue),
        donated: round2(m.donated),
        balance: round2(running),
        dueChomesh: round2(mDueC),
        balanceChomesh: round2(runningC),
      };
    });

  for (const c of Object.values(byCurrency)) {
    c.income = round2(c.income);
    c.donated = round2(c.donated);
  }

  const main = level(pct);
  return {
    currency: base,
    percent: pct,
    income: round2(income),
    opening: round2(opening),
    due: main.due,
    donated: round2(donated),
    balance: main.balance, // חיובי = נשאר לתת; שלילי = נתת מעבר (זכות)
    chomesh: level(CHOMESH),
    byCurrency,
    unconverted, // תנועות שלא הומרו (אין שער חליפין)
    monthly,
  };
}

module.exports = { summarize };
