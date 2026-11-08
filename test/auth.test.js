'use strict';
// בודק את מצב ההתחברות עם Google (בלי לפנות ל-Google בפועל)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('google mode: API requires login, /auth/google redirects to Google', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maaser-auth-'));
  const script = `
    const { app } = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    const srv = app.listen(0, async () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      const out = {};
      out.state = (await fetch(base + '/api/state')).status;
      out.config = await (await fetch(base + '/api/config')).json();
      const r = await fetch(base + '/auth/google', { redirect: 'manual' });
      out.redirect = r.headers.get('location');
      out.cookie = r.headers.get('set-cookie');
      const cb = await fetch(base + '/auth/google/callback?code=x&state=bad', { redirect: 'manual' });
      out.badState = cb.headers.get('location');
      console.log(JSON.stringify(out));
      srv.close();
    });`;
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, MAASER_DATA_DIR: dir, GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 's', PUBLIC_URL: 'https://maaser.example' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.state, 401);
  assert.equal(out.config.googleLogin, true);
  assert.equal(out.config.user, null);
  const u = new URL(out.redirect);
  assert.equal(u.host, 'accounts.google.com');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://maaser.example/auth/google/callback');
  assert.match(out.cookie, /oauth_state=.*HttpOnly.*Secure/);
  assert.match(out.badState, /login_error/);
});
