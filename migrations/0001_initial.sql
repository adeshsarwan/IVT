CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'shadow',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE media_buyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tracking_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_key TEXT NOT NULL UNIQUE,
  buyer_id INTEGER,
  site_id INTEGER NOT NULL,
  destination_url TEXT NOT NULL,
  declared_source TEXT,
  external_campaign_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (buyer_id) REFERENCES media_buyers(id),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE traffic_sessions (
  id TEXT PRIMARY KEY,
  site_id INTEGER NOT NULL,
  buyer_id INTEGER,
  tracking_route_id INTEGER,
  client_nonce_hash TEXT NOT NULL,
  source_class TEXT NOT NULL DEFAULT 'UNKNOWN',
  declared_source TEXT,
  click_id_type TEXT,
  click_id_hash TEXT,
  country TEXT,
  colo TEXT,
  asn INTEGER,
  network_class TEXT,
  cf_bot_score INTEGER,
  cf_verified_bot INTEGER,
  cf_ja4 TEXT,
  user_agent_hash TEXT,
  browser_evidence_hash TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0,
  classification TEXT NOT NULL,
  decision TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shadow',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (site_id) REFERENCES sites(id),
  FOREIGN KEY (buyer_id) REFERENCES media_buyers(id),
  FOREIGN KEY (tracking_route_id) REFERENCES tracking_routes(id)
);

CREATE INDEX idx_sessions_site_created ON traffic_sessions(site_id, created_at);
CREATE INDEX idx_sessions_buyer_created ON traffic_sessions(buyer_id, created_at);
CREATE INDEX idx_sessions_decision_created ON traffic_sessions(decision, created_at);
CREATE INDEX idx_sessions_click_hash ON traffic_sessions(click_id_hash);
CREATE INDEX idx_sessions_asn_created ON traffic_sessions(asn, created_at);

CREATE TABLE ivt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_data TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES traffic_sessions(id)
);

CREATE INDEX idx_ivt_events_session_created ON ivt_events(session_id, created_at);

CREATE TABLE runtime_capabilities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  capability_hash TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES traffic_sessions(id)
);

CREATE INDEX idx_runtime_cap_session ON runtime_capabilities(session_id);

CREATE TABLE click_reconciliation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  platform_account_id TEXT,
  platform_campaign_id TEXT,
  platform_adgroup_id TEXT,
  platform_ad_id TEXT,
  checked_at TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES traffic_sessions(id)
);

CREATE INDEX idx_click_recon_session ON click_reconciliation(session_id);
