-- Earth: 2045 database (Cloudflare D1 / SQLite), stage 1.
-- Run once locally:  npm run db:init:local
-- Run once online:   npm run db:init:remote
--
-- Upgrading an older database? Run once, only the lines it doesn't have yet:
--   ALTER TABLE nations ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE nations ADD COLUMN user_id INTEGER;
--   then the users/sessions tables and idx_nations_user below.

CREATE TABLE IF NOT EXISTS nations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  token_hash  TEXT    NOT NULL UNIQUE,   -- legacy sign-in key hash; 'user:…' or 'bot:…' placeholder now
  state       TEXT    NOT NULL,          -- the whole nation as JSON
  land        INTEGER NOT NULL,          -- copied out of state for rankings
  networth    INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1, -- bumped on every save; stops double-spending
  is_bot      INTEGER NOT NULL DEFAULT 0, -- 1 = AI-controlled nation
  user_id     INTEGER,                   -- owning account (empty for AI nations)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nations_rank ON nations (land DESC, networth DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nation_id  INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  detail     TEXT,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_nation ON audit_log (nation_id, at);

-- One nation per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nations_user ON nations (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash      TEXT    NOT NULL,      -- PBKDF2-SHA256
  salt           TEXT    NOT NULL,
  iterations     INTEGER NOT NULL,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,      -- SHA-256 of the browser's session token
  user_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
