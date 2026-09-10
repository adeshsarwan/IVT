CREATE TABLE IF NOT EXISTS identity_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  click_reuse_24h INTEGER NOT NULL DEFAULT 0,
  ip_sessions_10m INTEGER NOT NULL DEFAULT 0,
  ip_browser_fanout_24h INTEGER NOT NULL DEFAULT 0,
  browser_sessions_10m INTEGER NOT NULL DEFAULT 0,
  browser_ip_fanout_24h INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES traffic_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_identity_signals_created
  ON identity_signals(created_at);
