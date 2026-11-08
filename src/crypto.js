'use strict';
// הצפנת סודות (access tokens של ספקי הבנקאות) במנוחה, עם מפתח שרת (ENCRYPTION_KEY).
// גם מי שמשיג גישה למסד הנתונים לא יכול להשתמש בטוקנים בלי המפתח.
const crypto = require('crypto');

let cachedKey;
function key() {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY לא מוגדר (32 בתים ב-base64: openssl rand -base64 32)');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY חייב להיות 32 בתים ב-base64');
  cachedKey = k;
  return k;
}

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decryptSecret(box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { encryptSecret, decryptSecret, sha256 };
