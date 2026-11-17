// ClickHouse schema for Traffic Provenance (Google). Raw rows only; verdicts and breaker state live in D1.
// Apply with applySchema() (idempotent: CREATE … IF NOT EXISTS).
//
// Sizing: ~5M landings + ~5M Google clicks per day for 100 partners ≈ 300M rows/month.
// MergeTree compresses gclid-heavy rows to roughly 30–60 bytes/row (verify on real data).

import type { ClickHouse } from './client';

export const RETENTION_DAYS = 90;

export const SCHEMA: string[] = [
  // Every landing the Worker logged. gclid is pulled out of the URL once, at insert time.
  `CREATE TABLE IF NOT EXISTS landings (
    id         String,
    ts         DateTime64(3, 'UTC'),
    site       LowCardinality(String),
    aff        LowCardinality(String),
    route      LowCardinality(String) DEFAULT '',
    url        String CODEC(ZSTD(3)),
    ip_hash    String DEFAULT '',
    ua_hash    String DEFAULT '',
    ua_device  LowCardinality(String) DEFAULT '',
    gclid      String MATERIALIZED extractURLParameter(url, 'gclid'),
    INDEX idx_gclid gclid TYPE bloom_filter(0.01) GRANULARITY 4
  ) ENGINE = ReplacingMergeTree
  PARTITION BY toYYYYMMDD(ts)
  ORDER BY (aff, ts, id)
  TTL toDateTime(ts) + INTERVAL ${RETENTION_DAYS} DAY`,

  // Google's click list (click_view), one row per click. Re-syncing a day replaces rows (latest imported_at wins).
  `CREATE TABLE IF NOT EXISTS google_clicks (
    aff             LowCardinality(String),
    customer_id     String,
    date            Date,
    gclid           String,
    campaign_id     String,
    ad_group_id     String DEFAULT '',
    device          LowCardinality(String) DEFAULT '',
    click_type      LowCardinality(String) DEFAULT '',
    ad_network_type LowCardinality(String) DEFAULT '',
    imported_at     DateTime64(3, 'UTC'),
    INDEX idx_gclid gclid TYPE bloom_filter(0.01) GRANULARITY 4
  ) ENGINE = ReplacingMergeTree(imported_at)
  PARTITION BY toYYYYMM(date)
  ORDER BY (aff, date, gclid)
  TTL date + INTERVAL ${RETENTION_DAYS} DAY`,

  // Google's own click totals per day × campaign × network (metrics.clicks). Used for the count check.
  `CREATE TABLE IF NOT EXISTS google_daily (
    aff             LowCardinality(String),
    customer_id     String,
    date            Date,
    campaign_id     String,
    ad_network_type LowCardinality(String),
    clicks          UInt64,
    imported_at     DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree(imported_at)
  PARTITION BY toYYYYMM(date)
  ORDER BY (aff, customer_id, date, campaign_id, ad_network_type)
  TTL date + INTERVAL 400 DAY`,

  // One row per account × day sync attempt (latest wins): drives "coveredThrough" and the status view.
  `CREATE TABLE IF NOT EXISTS google_sync (
    aff          LowCardinality(String),
    customer_id  String,
    date         Date,
    status       LowCardinality(String),
    click_rows   UInt64,
    daily_clicks UInt64,
    time_zone    LowCardinality(String),
    auto_tagging UInt8,
    error        String DEFAULT '',
    synced_at    DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree(synced_at)
  ORDER BY (aff, customer_id, date)
  TTL date + INTERVAL 400 DAY`,
];

export async function applySchema(ch: ClickHouse): Promise<void> {
  for (const sql of SCHEMA) await ch.command(sql);
}

/** Tests / local runs only. */
export async function dropAll(ch: ClickHouse): Promise<void> {
  for (const t of ['landings', 'google_clicks', 'google_daily', 'google_sync']) await ch.command(`DROP TABLE IF EXISTS ${t}`);
}
