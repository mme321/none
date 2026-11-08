'use strict';
// סיווג תנועות: הכנסה (חייבת במעשר), תרומה (נספרת כמעשר ששולם), הוצאה, או התעלמות.

const TYPES = ['income', 'donation', 'expense', 'ignore'];

// כללי ברירת מחדל – אפשר לערוך/למחוק/להוסיף מתוך האפליקציה.
// הכלל הראשון שמתאים קובע.
const DEFAULT_RULES = [
  { id: 'r-transfer-own', pattern: 'העברה בין חשבונות', type: 'ignore' },
  { id: 'r-deposit1', pattern: 'פיקדון', type: 'ignore' },
  { id: 'r-deposit2', pattern: 'פקדון', type: 'ignore' },
  { id: 'r-loan', pattern: 'הלוואה', type: 'ignore' },
  { id: 'r-donation1', pattern: 'תרומ', type: 'donation' },
  { id: 'r-donation2', pattern: 'צדק', type: 'donation' },
  { id: 'r-donation3', pattern: 'גמ"ח', type: 'donation' },
  // בנקים בארה"ב
  { id: 'r-donation-en1', pattern: 'donation', type: 'donation' },
  { id: 'r-donation-en2', pattern: 'charity', type: 'donation' },
  { id: 'r-donation-en3', pattern: 'tzedak', type: 'donation' },
];

function matchRule(tx, rules) {
  const text = `${tx.description || ''} ${tx.memo || ''}`.toLowerCase();
  for (const rule of rules || []) {
    const p = String(rule.pattern || '').trim().toLowerCase();
    if (!p || !text.includes(p)) continue;
    // כלל עם כיוון מוגדר חל רק על זיכויים/חיובים בהתאם
    if (rule.direction === 'in' && tx.amount <= 0) continue;
    if (rule.direction === 'out' && tx.amount >= 0) continue;
    return rule;
  }
  return null;
}

/**
 * מחזיר { type, reason } עבור תנועה.
 * reason: 'manual' | 'rule' | 'default'
 */
function classify(tx, rules, overrides) {
  const ov = overrides && overrides[tx.id];
  if (ov && TYPES.includes(ov)) return { type: ov, reason: 'manual' };

  const rule = matchRule(tx, rules);
  if (rule) {
    // כלל "תרומה" חל רק על חיובים; כלל "הכנסה" רק על זיכויים – כדי למנוע טעויות
    if (rule.type === 'donation' && tx.amount > 0) {
      // זיכוי שמזכיר "תרומה" (למשל החזר) – לא נחשב תרומה
    } else if (rule.type === 'income' && tx.amount < 0) {
      // חיוב לא יכול להיות הכנסה לפי כלל
    } else {
      return { type: rule.type, reason: 'rule', ruleId: rule.id };
    }
  }

  if (tx.source === 'card') {
    // בכרטיס אשראי: זיכוי = החזר כספי, לא הכנסה
    return { type: tx.amount < 0 ? 'expense' : 'ignore', reason: 'default' };
  }
  return { type: tx.amount > 0 ? 'income' : 'expense', reason: 'default' };
}

module.exports = { TYPES, DEFAULT_RULES, classify, matchRule };
