'use strict';
// שערי חליפין יומיים להמרת הכנסות/תרומות במטבעות שונים (₪/$) למטבע הבסיס של המשתמש.
// מקור: הבנק המרכזי האירופי (ECB) דרך Frankfurter API – חינמי, בלי מפתח. נשמר במטמון במסד הנתונים.
const db = require('./db');

const FX_URL = () => (process.env.FX_BASE_URL || 'https://api.frankfurter.dev/v1').replace(/\/$/, '');
const lastFetch = new Map(); // "USD>ILS" -> timestamp (לא לפנות שוב ושוב אם נכשל)

const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

async function fetchRange(base, quote, from, to) {
  const res = await fetch(`${FX_URL()}/${from}..${to}?base=${base}&symbols=${quote}`);
  if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
  const json = await res.json();
  const rows = Object.entries(json.rates || {})
    .map(([date, r]) => [date, r[quote]])
    .filter(([, r]) => Number.isFinite(r));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values = chunk.map((_, j) => `($${j * 2 + 1}::date, '${base}', '${quote}', $${j * 2 + 2})`).join(',');
    await db.query(
      `INSERT INTO fx_rates (date, base, quote, rate) VALUES ${values} ON CONFLICT DO NOTHING`,
      chunk.flat()
    );
  }
}

const CURRENCY = /^[A-Z]{3}$/;

/**
 * מחזיר פונקציית המרה convert(amount, currency, date) -> number|null למטבע הבסיס.
 * needs: Map<currency, minDate>
 */
async function converter(baseCurrency, needs) {
  const tables = new Map(); // currency -> [[date, rate], ...] ממוין
  for (const [cur, minDate] of needs) {
    if (cur === baseCurrency || !CURRENCY.test(cur) || !CURRENCY.test(baseCurrency)) continue;
    const key = `${cur}>${baseCurrency}`;
    const want = addDays(minDate, -7);
    const cov = (
      await db.query('SELECT min(date) AS lo, max(date) AS hi FROM fx_rates WHERE base = $1 AND quote = $2', [cur, baseCurrency])
    ).rows[0];
    const stale = !cov.lo || cov.lo > want || cov.hi < addDays(today(), -4);
    if (stale && Date.now() - (lastFetch.get(key) || 0) > 3600e3) {
      lastFetch.set(key, Date.now());
      try {
        await fetchRange(cur, baseCurrency, cov.lo && cov.lo <= want ? cov.hi : want, today());
      } catch (e) {
        console.warn('שגיאה במשיכת שערי חליפין', key, e.message);
      }
    }
    const { rows } = await db.query(
      'SELECT date, rate FROM fx_rates WHERE base = $1 AND quote = $2 AND date >= $3 ORDER BY date',
      [cur, baseCurrency, want]
    );
    tables.set(cur, rows.map((r) => [r.date, r.rate]));
  }

  return function convert(amount, currency, date) {
    if (currency === baseCurrency) return amount;
    const t = tables.get(currency);
    if (!t || !t.length) return null;
    // השער האחרון שפורסם עד התאריך (בסופ"ש/חג – השער של יום העסקים הקודם)
    let lo = 0;
    let hi = t.length - 1;
    if (date < t[0][0]) return amount * t[0][1];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid][0] <= date) lo = mid;
      else hi = mid - 1;
    }
    return amount * t[lo][1];
  };
}

module.exports = { converter };
