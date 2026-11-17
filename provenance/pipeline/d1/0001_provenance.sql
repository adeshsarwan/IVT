-- Traffic Provenance state (small tables). NOT in the main migrations/ folder on purpose:
-- apply only when the pipeline is approved. Raw clicks/landings live in ClickHouse.

CREATE TABLE IF NOT EXISTS provenance_partner (
  aff               TEXT PRIMARY KEY,
  auth              TEXT NOT NULL CHECK (auth IN ('mcc', 'oauth')),
  customer_ids      TEXT NOT NULL,          -- JSON array of Google Ads customer ids
  login_customer_id TEXT,                   -- manager account for login-customer-id
  token_ref         TEXT,                   -- secret name for the partner's refresh token (oauth); never the token
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_ms        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS provenance_breaker (
  key        TEXT PRIMARY KEY,              -- aff|source
  aff        TEXT NOT NULL,
  source     TEXT NOT NULL,
  tier       TEXT NOT NULL,
  state      TEXT NOT NULL,                 -- JSON BreakerState
  cursor_ms  INTEGER,                       -- end of the last final window applied
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance_window (
  key      TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms   INTEGER NOT NULL,
  aff      TEXT NOT NULL,
  source   TEXT NOT NULL,
  status   TEXT NOT NULL,
  tier     TEXT NOT NULL,
  hard     INTEGER NOT NULL,
  reasons  TEXT NOT NULL,
  stats    TEXT NOT NULL,
  run_ms   INTEGER NOT NULL,
  PRIMARY KEY (key, start_ms)
);
CREATE INDEX IF NOT EXISTS provenance_window_aff ON provenance_window (aff, start_ms);

-- Manual review queue: BLOCK recommendations wait here until a human applies or dismisses them.
CREATE TABLE IF NOT EXISTS provenance_review (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  aff        TEXT NOT NULL,
  tier       TEXT NOT NULL,
  kv_key     TEXT NOT NULL,
  kv_value   TEXT NOT NULL,
  reasons    TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'dismissed')),
  decided_by TEXT,
  decided_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS provenance_review_open ON provenance_review (aff) WHERE status = 'open';
