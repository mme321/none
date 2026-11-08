'use strict';
// משיכת תנועות אוטומטית מהבנקים ומחברות האשראי בעזרת הספרייה israeli-bank-scrapers.
const crypto = require('crypto');
const { decrypt } = require('./crypto');

// רשימת הגופים הנתמכים. type: bank = חשבון בנק (זיכויים = הכנסות), card = כרטיס אשראי.
const COMPANIES = {
  hapoalim: { name: 'בנק הפועלים', type: 'bank', fields: ['userCode', 'password'] },
  leumi: { name: 'בנק לאומי', type: 'bank', fields: ['username', 'password'] },
  discount: { name: 'בנק דיסקונט', type: 'bank', fields: ['id', 'password', 'num'] },
  mizrahi: { name: 'מזרחי טפחות', type: 'bank', fields: ['username', 'password'] },
  mercantile: { name: 'בנק מרכנתיל', type: 'bank', fields: ['id', 'password', 'num'] },
  beinleumi: { name: 'הבנק הבינלאומי', type: 'bank', fields: ['username', 'password'] },
  otsarHahayal: { name: 'בנק אוצר החייל', type: 'bank', fields: ['username', 'password'] },
  massad: { name: 'בנק מסד', type: 'bank', fields: ['username', 'password'] },
  pagi: { name: 'בנק פאג"י', type: 'bank', fields: ['username', 'password'] },
  union: { name: 'בנק איגוד', type: 'bank', fields: ['username', 'password'] },
  yahav: { name: 'בנק יהב', type: 'bank', fields: ['username', 'nationalID', 'password'] },
  max: { name: 'מקס', type: 'card', fields: ['username', 'password'] },
  visaCal: { name: 'כאל', type: 'card', fields: ['username', 'password'] },
  isracard: { name: 'ישראכרט', type: 'card', fields: ['id', 'card6Digits', 'password'] },
  amex: { name: 'אמריקן אקספרס', type: 'card', fields: ['id', 'card6Digits', 'password'] },
  beyahadBishvilha: { name: 'ביחד בשבילך', type: 'card', fields: ['id', 'password'] },
  behatsdaa: { name: 'בהצדעה', type: 'card', fields: ['id', 'password'] },
};

const FIELD_LABELS = {
  userCode: 'קוד משתמש',
  username: 'שם משתמש',
  password: 'סיסמה',
  id: 'תעודת זהות',
  num: 'קוד מזהה',
  nationalID: 'תעודת זהות',
  card6Digits: '6 ספרות אחרונות של הכרטיס',
};

function txId(account, accountNumber, t) {
  const basis = t.identifier
    ? `${account.companyId}|${accountNumber}|id:${t.identifier}|${t.date}|${t.chargedAmount}`
    : `${account.companyId}|${accountNumber}|${t.date}|${t.chargedAmount}|${t.description}|${t.memo || ''}`;
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/** ממיר את תוצאת הסקרייפר לתנועות בפורמט של האפליקציה. */
function normalize(account, scrapeAccounts) {
  const source = COMPANIES[account.companyId]?.type || 'bank';
  const out = [];
  for (const acc of scrapeAccounts || []) {
    for (const t of acc.txns || []) {
      if (t.status === 'pending') continue; // נשמור רק תנועות סופיות (מונע כפילויות)
      const amount = Number(t.chargedAmount);
      if (!Number.isFinite(amount) || amount === 0) continue;
      out.push({
        id: txId(account, acc.accountNumber, t),
        accountId: account.id,
        accountNumber: acc.accountNumber,
        source,
        date: t.date,
        processedDate: t.processedDate,
        amount,
        originalAmount: t.originalAmount,
        originalCurrency: t.originalCurrency,
        description: t.description || '',
        memo: t.memo || '',
      });
    }
  }
  return out;
}

/** ממזג תנועות חדשות לתוך מסד הנתונים, מחזיר כמה נוספו. */
function mergeTransactions(db, txns) {
  const existing = new Set(db.transactions.map((t) => t.id));
  let added = 0;
  for (const t of txns) {
    if (existing.has(t.id)) continue;
    existing.add(t.id);
    db.transactions.push(t);
    added++;
  }
  db.transactions.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return added;
}

function startDateFor(db, account) {
  let d;
  if (account.lastSync) {
    d = new Date(account.lastSync);
    d.setDate(d.getDate() - 14); // חפיפה קטנה כדי לא לפספס תנועות שנקלטו באיחור
  } else {
    d = new Date(db.settings.startDate || Date.now() - 365 * 864e5);
  }
  return d;
}

async function scrapeAccount(db, account, key) {
  // טעינה עצלה – כדי שהאפליקציה תעלה גם בלי דפדפן מותקן
  const { createScraper } = require('israeli-bank-scrapers');
  const credentials = JSON.parse(decrypt(key, account.credentials));
  const scraper = createScraper({
    companyId: account.companyId,
    startDate: startDateFor(db, account),
    combineInstallments: false,
    showBrowser: process.env.MAASER_SHOW_BROWSER === '1',
    executablePath: process.env.CHROME_PATH || undefined,
    args: process.env.MAASER_NO_SANDBOX === '1' ? ['--no-sandbox'] : undefined,
    defaultTimeout: 60000,
  });
  const result = await scraper.scrape(credentials);
  if (!result.success) {
    throw new Error(`${result.errorType || 'ERROR'}: ${result.errorMessage || 'ההתחברות נכשלה'}`);
  }
  return normalize(account, result.accounts);
}

/** מסנכרן את כל החשבונות (או חשבון אחד). משנה את db במקום. */
async function syncAll(db, key, { accountId, log = console.log } = {}) {
  const results = [];
  for (const account of db.accounts) {
    if (accountId && account.id !== accountId) continue;
    const name = account.label || COMPANIES[account.companyId]?.name || account.companyId;
    try {
      log(`מסנכרן את ${name}...`);
      const txns = await scrapeAccount(db, account, key);
      const added = mergeTransactions(db, txns);
      account.lastSync = new Date().toISOString();
      account.lastError = null;
      results.push({ accountId: account.id, name, ok: true, added });
      log(`${name}: נוספו ${added} תנועות חדשות`);
    } catch (e) {
      account.lastError = String(e.message || e);
      results.push({ accountId: account.id, name, ok: false, error: account.lastError });
      log(`${name}: שגיאה – ${account.lastError}`);
    }
  }
  return results;
}

module.exports = { COMPANIES, FIELD_LABELS, normalize, mergeTransactions, syncAll };
