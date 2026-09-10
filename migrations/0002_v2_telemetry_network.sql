-- Thebes IVT v2: decomposed risk, privacy-preserving network evidence,
-- and aggregate behavioral telemetry. Additive only; v1 remains deployable.

ALTER TABLE traffic_sessions ADD COLUMN ip_hash TEXT;
ALTER TABLE traffic_sessions ADD COLUMN network_provider TEXT;
ALTER TABLE traffic_sessions ADD COLUMN network_service TEXT;
ALTER TABLE traffic_sessions ADD COLUMN is_hosting INTEGER;
ALTER TABLE traffic_sessions ADD COLUMN is_proxy INTEGER;
ALTER TABLE traffic_sessions ADD COLUMN is_tor INTEGER;
ALTER TABLE traffic_sessions ADD COLUMN is_relay INTEGER;
ALTER TABLE traffic_sessions ADD COLUMN is_vpn INTEGER;
ALTER TABLE traffic_sessions ADD COLUMN network_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_sessions ADD COLUMN browser_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_sessions ADD COLUMN identity_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_sessions ADD COLUMN behavior_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_sessions ADD COLUMN source_risk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_sessions ADD COLUMN evidence_version TEXT NOT NULL DEFAULT 'v1';

CREATE INDEX IF NOT EXISTS idx_traffic_sessions_ip_hash_created
  ON traffic_sessions(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_traffic_sessions_browser_hash_created
  ON traffic_sessions(browser_evidence_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_traffic_sessions_classification_created
  ON traffic_sessions(classification, created_at);

CREATE TABLE IF NOT EXISTS network_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  asn INTEGER,
  country TEXT,
  provider TEXT NOT NULL,
  provider_version TEXT,
  hosting INTEGER,
  proxy INTEGER,
  tor INTEGER,
  relay INTEGER,
  vpn INTEGER,
  residential_proxy INTEGER,
  service TEXT,
  cache_status TEXT,
  lookup_ms INTEGER,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES traffic_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_network_evidence_session
  ON network_evidence(session_id);
CREATE INDEX IF NOT EXISTS idx_network_evidence_ip_hash_observed
  ON network_evidence(ip_hash, observed_at);

CREATE TABLE IF NOT EXISTS telemetry_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  elapsed_ms INTEGER,
  visible_ms INTEGER,
  focused_ms INTEGER,
  active_ms INTEGER,
  max_scroll_pct REAL,
  pointer_events INTEGER,
  touch_events INTEGER,
  key_events INTEGER,
  visibility_changes INTEGER,
  focus_changes INTEGER,
  custom_events_json TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES traffic_sessions(id),
  UNIQUE(session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_session_received
  ON telemetry_summaries(session_id, received_at);

CREATE TABLE IF NOT EXISTS risk_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  component TEXT NOT NULL,
  score INTEGER NOT NULL,
  reasons_json TEXT,
  evidence_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES traffic_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_risk_components_session
  ON risk_components(session_id);
