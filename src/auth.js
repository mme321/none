'use strict';
// התחברות עם Google (OAuth 2.0 / OpenID Connect) וניהול סשנים.
// אם לא הוגדרו GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET – מצב "מקומי" עם משתמש יחיד
// (מותר רק כשהשרת מאזין למחשב המקומי, אלא אם ALLOW_NO_AUTH=1).
const crypto = require('crypto');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ALLOWED = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const googleEnabled = !!(CLIENT_ID && CLIENT_SECRET);
const SESSION_DAYS = 30;
const sessions = new Map(); // sid -> { userId, email, name, expires }

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return PUBLIC_URL.startsWith('https://') || req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(req, res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isSecure(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...[].concat(prev), parts.join('; ')]);
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}`;
}

function createSession(req, res, user) {
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { ...user, expires: Date.now() + SESSION_DAYS * 864e5 });
  setCookie(req, res, 'sid', sid, SESSION_DAYS * 86400);
}

/** מצמיד req.user אם יש סשן תקף. */
function sessionMiddleware(req, res, next) {
  if (!googleEnabled) {
    req.user = { userId: 'local', email: '', name: 'משתמש מקומי' };
    return next();
  }
  const sid = parseCookies(req).sid;
  const s = sid && sessions.get(sid);
  if (s && s.expires > Date.now()) {
    req.user = s;
    req.sid = sid;
  } else if (s) {
    sessions.delete(sid);
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'יש להתחבר', login: true });
  next();
}

function routes(app) {
  app.get('/auth/google', (req, res) => {
    if (!googleEnabled) return res.redirect('/');
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

      // ה-id_token התקבל ישירות מ-Google בערוץ מוצפן, לכן אין צורך לאמת חתימה (לפי התיעוד של Google)
      const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
      if (claims.aud !== CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss))
        return fail('אסימון לא תקין');
      if (!claims.email_verified) return fail('כתובת המייל בחשבון Google לא מאומתת');
      const email = String(claims.email).toLowerCase();
      if (ALLOWED.length && !ALLOWED.includes(email)) return fail('אין הרשאה לחשבון הזה');

      createSession(req, res, { userId: 'g' + claims.sub, email, name: claims.name || email });
      res.redirect('/');
    } catch (e) {
      console.error('Google login failed', e);
      fail('שגיאה בהתחברות');
    }
  });

  app.post('/auth/logout', (req, res) => {
    if (req.sid) sessions.delete(req.sid);
    setCookie(req, res, 'sid', '', 0);
    res.json({ ok: true });
  });
}

/** סוגר את כל הסשנים של משתמש (למשל אחרי מחיקת חשבון). */
function endUserSessions(userId) {
  for (const [sid, s] of sessions) if (s.userId === userId) sessions.delete(sid);
}

module.exports = { googleEnabled, sessionMiddleware, requireUser, routes, endUserSessions, createSession };
