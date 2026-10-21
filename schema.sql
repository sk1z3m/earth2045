-- Earth: 2045 database (Cloudflare D1 / SQLite), stage 1.
-- Run once locally:  npm run db:init:local
-- Run once online:   npm run db:init:remote

CREATE TABLE IF NOT EXISTS nations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  token_hash  TEXT    NOT NULL UNIQUE,   -- SHA-256 of the player's secret key
  state       TEXT    NOT NULL,          -- the whole nation as JSON
  land        INTEGER NOT NULL,          -- copied out of state for rankings
  networth    INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1, -- bumped on every save; stops double-spending
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
