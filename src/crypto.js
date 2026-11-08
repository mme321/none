'use strict';
// הצפנת פרטי ההתחברות לבנקים בעזרת סיסמת-על (AES-256-GCM + scrypt).
// סיסמת-העל עצמה לעולם לא נשמרת בדיסק – רק "מאמת" מוצפן שמאפשר לבדוק שהיא נכונה.
const crypto = require('crypto');

const VERIFY_TOKEN = 'maaser-ok';

function deriveKey(password, saltB64) {
  return crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(box.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** יוצר מלח ומאמת עבור סיסמת-על חדשה. */
function createVault(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const key = deriveKey(password, salt);
  return { vault: { salt, verifier: encrypt(key, VERIFY_TOKEN) }, key };
}

/** מחזיר את המפתח אם הסיסמה נכונה, אחרת null. */
function openVault(vault, password) {
  const key = deriveKey(password, vault.salt);
  try {
    return decrypt(key, vault.verifier) === VERIFY_TOKEN ? key : null;
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt, createVault, openVault };
