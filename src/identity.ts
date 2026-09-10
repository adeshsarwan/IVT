export type IdentitySignals = {
  clickReuse24h: number;
  ipSessions10m: number;
  ipBrowserFanout24h: number;
  browserSessions10m: number;
  browserIpFanout24h: number;
};

export type IdentityRisk = {
  score: number;
  reasons: string[];
  signals: IdentitySignals;
};

export type IdentityInput = {
  db: D1Database;
  siteId: number;
  clickIdHash: string | null;
  ipHash: string | null;
  browserEvidenceHash: string | null;
};

type CountRow = { n: number };

async function count(db: D1Database, sql: string, ...bindings: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...bindings).first<CountRow>();
  return Number(row?.n || 0);
}

export async function evaluateIdentityRisk(input: IdentityInput): Promise<IdentityRisk> {
  const { db, siteId, clickIdHash, ipHash, browserEvidenceHash } = input;

  // All windows are retrospective and exclude the not-yet-inserted current session.
  const clickReuse24h = clickIdHash
    ? await count(
        db,
        `SELECT COUNT(*) AS n
           FROM traffic_sessions
          WHERE site_id = ?
            AND click_id_hash = ?
            AND created_at >= datetime('now','-24 hours')`,
        siteId,
        clickIdHash,
      )
    : 0;

  const ipSessions10m = ipHash
    ? await count(
        db,
        `SELECT COUNT(*) AS n
           FROM traffic_sessions
          WHERE site_id = ?
            AND ip_hash = ?
            AND created_at >= datetime('now','-10 minutes')`,
        siteId,
        ipHash,
      )
    : 0;

  const ipBrowserFanout24h = ipHash
    ? await count(
        db,
        `SELECT COUNT(DISTINCT browser_evidence_hash) AS n
           FROM traffic_sessions
          WHERE site_id = ?
            AND ip_hash = ?
            AND browser_evidence_hash IS NOT NULL
            AND created_at >= datetime('now','-24 hours')`,
        siteId,
        ipHash,
      )
    : 0;

  const browserSessions10m = browserEvidenceHash
    ? await count(
        db,
        `SELECT COUNT(*) AS n
           FROM traffic_sessions
          WHERE site_id = ?
            AND browser_evidence_hash = ?
            AND created_at >= datetime('now','-10 minutes')`,
        siteId,
        browserEvidenceHash,
      )
    : 0;

  const browserIpFanout24h = browserEvidenceHash
    ? await count(
        db,
        `SELECT COUNT(DISTINCT ip_hash) AS n
           FROM traffic_sessions
          WHERE site_id = ?
            AND browser_evidence_hash = ?
            AND ip_hash IS NOT NULL
            AND created_at >= datetime('now','-24 hours')`,
        siteId,
        browserEvidenceHash,
      )
    : 0;

  let score = 0;
  const reasons: string[] = [];

  // A paid click identifier should normally map to one acquired visit. A second use can
  // happen through reload/back-navigation, so the first duplicate is observed rather than
  // treated as definitive fraud. Repeated reuse receives strong weight.
  if (clickReuse24h >= 5) {
    score += 50;
    reasons.push("CLICK_ID_REPLAY_HEAVY");
  } else if (clickReuse24h >= 2) {
    score += 35;
    reasons.push("CLICK_ID_REPLAY_REPEATED");
  } else if (clickReuse24h >= 1) {
    score += 15;
    reasons.push("CLICK_ID_REUSED");
  }

  // IP-only velocity is intentionally tolerant of NAT, offices, campuses and carrier gateways.
  if (ipSessions10m >= 100) {
    score += 25;
    reasons.push("IP_VELOCITY_EXTREME");
  } else if (ipSessions10m >= 40) {
    score += 12;
    reasons.push("IP_VELOCITY_HIGH");
  }

  // Many different browser signatures behind one IP can be legitimate. Only large fanout matters.
  if (ipBrowserFanout24h >= 250) {
    score += 15;
    reasons.push("IP_BROWSER_FANOUT_EXTREME");
  } else if (ipBrowserFanout24h >= 100) {
    score += 7;
    reasons.push("IP_BROWSER_FANOUT_HIGH");
  }

  // The inverse relationship is more informative: one stable browser evidence signature rotating
  // through many IPs is consistent with proxy rotation/device farms, but VPN/mobile handoff can
  // also cause changes, so thresholds remain conservative.
  if (browserIpFanout24h >= 30) {
    score += 30;
    reasons.push("BROWSER_IP_FANOUT_EXTREME");
  } else if (browserIpFanout24h >= 12) {
    score += 15;
    reasons.push("BROWSER_IP_FANOUT_HIGH");
  }

  if (browserSessions10m >= 30) {
    score += 20;
    reasons.push("BROWSER_VELOCITY_EXTREME");
  } else if (browserSessions10m >= 12) {
    score += 8;
    reasons.push("BROWSER_VELOCITY_HIGH");
  }

  return {
    score: Math.min(60, score),
    reasons,
    signals: {
      clickReuse24h,
      ipSessions10m,
      ipBrowserFanout24h,
      browserSessions10m,
      browserIpFanout24h,
    },
  };
}
