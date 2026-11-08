'use strict';
// התחברות עם Google (OAuth 2.0 / OpenID Connect). הסשנים נשמרים במסד הנתונים.
const crypto = require('crypto');
const db = require('./db');
const { sha256 } = require('./crypto');
const { DEFAULT_RULES } = require('./classify');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ALLOWED = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// התחברות בלי Google – לפיתוח ובדיקות בלבד, חסומה בייצור
const DEV_LOGIN = process.env.DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production';

const googleEnabled = !!(CLIENT_ID && CLIENT_SECRET);
const SESSION_DAYS = 30;

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return PUBLIC_URL.startsWith('https://') || req.secure;
}

function setCookie(req, res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isSecure(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...[].concat(prev), parts.join('; ')]);
}

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
}

/** יוצר משתמש אם לא קיים (כולל הגדרות וכללי ברירת מחדל) ומחזיר אותו. */
async function upsertUser({ sub, email, name }) {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING id, email, name, (xmax = 0) AS created`,
      [sub, email, name]
    );
    const user = rows[0];
    if (user.created) {
      await c.query('INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
      for (let i = 0; i < DEFAULT_RULES.length; i++) {
        const r = DEFAULT_RULES[i];
        await c.query('INSERT INTO rules (user_id, pattern, type, position) VALUES ($1, $2, $3, $4)', [user.id, r.pattern, r.type, i]);
      }
    }
    return user;
  });
}

async function createSession(req, res, userId) {
  const sid = crypto.randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + $3::interval)`, [
    sha256(sid),
    userId,
    `${SESSION_DAYS} days`,
  ]);
  setCookie(req, res, 'sid', sid, SESSION_DAYS * 86400);
}

/** מצמיד req.user אם יש סשן תקף. */
async function sessionMiddleware(req, res, next) {
  try {
    const sid = parseCookies(req).sid;
    if (sid) {
      const { rows } = await db.query(
        `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > now()`,
        [sha256(sid)]
      );
      if (rows[0]) {
        req.user = rows[0];
        req.sidHash = sha256(sid);
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'יש להתחבר', login: true });
  next();
}

function routes(app) {
  app.get('/auth/google', (req, res) => {
    if (!googleEnabled) return res.redirect('/?login_error=' + encodeURIComponent('התחברות Google לא הוגדרה בשרת'));
    const state = crypto.randomBytes(16).toString('base64url');
    setCookie(req, res, 'oauth_state', state, 600);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${baseUrl(req)}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get('/auth/google/callback', async (req, res) => {
    const fail = (msg) => res.redirect('/?login_error=' + encodeURIComponent(msg));
    try {
      const { code, state, error } = req.query;
      if (error) return fail('ההתחברות בוטלה');
      const expected = parseCookies(req).oauth_state;
      setCookie(req, res, 'oauth_state', '', 0);
      if (!code || !state || !expected || state !== expected) return fail('בקשת התחברות לא תקינה, נסו שוב');

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code),
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: `${baseUrl(req)}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.id_token) return fail('Google דחה את ההתחברות');

      // ה-id_token התקבל ישירות מ-Google בערוץ TLS, ולכן לפי התיעוד של Google אין צורך לאמת חתימה
      const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
      if (claims.aud !== CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss))
        return fail('אסימון לא תקין');
      if (!claims.email_verified) return fail('כתובת המייל בחשבון Google לא מאומתת');
      const email = String(claims.email).toLowerCase();
      if (ALLOWED.length && !ALLOWED.includes(email)) return fail('אין הרשאה לחשבון הזה');

      const user = await upsertUser({ sub: claims.sub, email, name: claims.name || email });
      await createSession(req, res, user.id);
      res.redirect('/');
    } catch (e) {
      console.error('Google login failed', e);
      fail('שגיאה בהתחברות');
    }
  });

  if (DEV_LOGIN) {
    console.warn('⚠️  DEV_LOGIN פעיל – התחברות בלי Google (לפיתוח בלבד)');
    app.post('/auth/dev', express_json_guard, async (req, res) => {
      const email = String((req.body || {}).email || 'dev@example.com').toLowerCase();
      const user = await upsertUser({ sub: 'dev:' + email, email, name: email.split('@')[0] });
      await createSession(req, res, user.id);
      res.json({ ok: true });
    });
  }

  app.post('/auth/logout', async (req, res) => {
    if (req.sidHash) await db.query('DELETE FROM sessions WHERE id = $1', [req.sidHash]);
    setCookie(req, res, 'sid', '', 0);
    res.json({ ok: true });
  });
}

function express_json_guard(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'נדרש JSON' });
  next();
}

async function cleanupSessions() {
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
}

module.exports = { googleEnabled, devLogin: DEV_LOGIN, sessionMiddleware, requireUser, routes, cleanupSessions, upsertUser };
