'use strict';
// חיבור ל-PostgreSQL ומיגרציות סכמה.
const { Pool, types } = require('pg');

// NUMERIC -> מספר JS (סכומים כספיים עד 2 ספרות אחרי הנקודה – בטוח בדיוק double)
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE -> מחרוזת YYYY-MM-DD (בלי המרות אזור זמן)
types.setTypeParser(1082, (v) => v);

let pool;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL לא מוגדר');
    const ssl = /sslmode=require/.test(url) || process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined;
    pool = new Pool({ connectionString: url, ssl, max: Number(process.env.DATABASE_POOL_MAX) || 10 });
  }
  return pool;
}

const query = (text, params) => getPool().query(text, params);

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    google_sub  TEXT UNIQUE NOT NULL,
    email       TEXT NOT NULL,
    name        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,            -- SHA-256 של מזהה הסשן (המזהה עצמו רק בעוגייה)
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE settings (
    user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    percent          NUMERIC NOT NULL DEFAULT 10,
    show_chomesh     BOOLEAN NOT NULL DEFAULT false,
    start_date       DATE NOT NULL DEFAULT (now() - interval '1 year')::date,
    opening_balance  NUMERIC NOT NULL DEFAULT 0,
    base_currency    TEXT NOT NULL DEFAULT 'ILS'
  );

  -- לקוח אצל ספק (Salt Edge דורש "customer" לכל משתמש)
  CREATE TABLE provider_customers (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    PRIMARY KEY (user_id, provider),
    UNIQUE (provider, external_id)
  );

  -- חיבור לבנק אחד (Plaid item / Salt Edge connection)
  CREATE TABLE connections (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          TEXT NOT NULL,
    external_id       TEXT NOT NULL,
    institution_name  TEXT,
    secret            JSONB,                 -- access token מוצפן (Plaid)
    cursor            TEXT,                  -- Plaid /transactions/sync
    status            TEXT NOT NULL DEFAULT 'active',
    last_sync         TIMESTAMPTZ,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, external_id)
  );
  CREATE INDEX connections_user ON connections(user_id);

  CREATE TABLE accounts (
    id             BIGSERIAL PRIMARY KEY,
    connection_id  BIGINT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id    TEXT NOT NULL,
    name           TEXT,
    mask           TEXT,
    kind           TEXT NOT NULL DEFAULT 'bank',   -- bank | card
    currency       TEXT,
    balance        NUMERIC,
    UNIQUE (connection_id, external_id)
  );

  CREATE TABLE transactions (
    id             BIGSERIAL PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id  BIGINT REFERENCES connections(id) ON DELETE CASCADE,
    account_id     BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
    provider       TEXT NOT NULL,                 -- plaid | saltedge | manual
    external_id    TEXT NOT NULL,
    date           DATE NOT NULL,
    amount         NUMERIC NOT NULL,              -- חיובי = כסף נכנס, שלילי = יוצא
    currency       TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    memo           TEXT NOT NULL DEFAULT '',
    source         TEXT NOT NULL DEFAULT 'bank',  -- bank | card | manual
    type_override  TEXT,                          -- income | donation | expense | ignore
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, external_id)
  );
  CREATE INDEX transactions_user_date ON transactions(user_id, date DESC);

  CREATE TABLE rules (
    id        BIGSERIAL PRIMARY KEY,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern   TEXT NOT NULL,
    type      TEXT NOT NULL,
    position  INT NOT NULL DEFAULT 0
  );
  CREATE INDEX rules_user ON rules(user_id, position);

  -- שערי חליפין יומיים (מקור: ECB דרך frankfurter.app)
  CREATE TABLE fx_rates (
    date   DATE NOT NULL,
    base   TEXT NOT NULL,
    quote  TEXT NOT NULL,
    rate   NUMERIC NOT NULL,
    PRIMARY KEY (base, quote, date)
  );
  `,
];

async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  // נעילה כדי ששתי מכונות לא יריצו מיגרציה במקביל
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727274)');
    const { rows } = await c.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (done.has(i + 1)) continue;
      await c.query(MIGRATIONS[i]);
      await c.query('INSERT INTO schema_migrations(version) VALUES ($1)', [i + 1]);
    }
  });
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { query, tx, migrate, close, getPool };
