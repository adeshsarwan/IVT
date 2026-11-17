// Small state the batch job keeps between runs: partner registry, breaker state + cursor per
// affiliate × source, window verdicts, and the manual review queue. D1 in production
// (see d1/0001_provenance.sql), an in-memory store for tests and local runs.

import type { BreakerState, Tier, WindowResult } from '../src/types';

export interface PartnerConfig {
  aff: string;
  /** How we reach Google: our MCC (+ our refresh token) or an OAuth grant the partner gave us. */
  auth: 'mcc' | 'oauth';
  customerIds: string[];
  /** Manager account to send as login-customer-id (our MCC id for 'mcc'). */
  loginCustomerId?: string;
  /** Secret reference for the partner's refresh token ('oauth' only). Never the token itself. */
  tokenRef?: string;
  enabled: boolean;
}

export interface BreakerRow { key: string; state: BreakerState; /** End (ms) of the last final window already applied. */ cursor: number | null }

export interface ReviewItem {
  aff: string;
  tier: Tier;
  /** Proposed KV write, e.g. ads:aff:13 = off. Applied by a human, never by the job. */
  key: string;
  value: string;
  reasons: string[];
  createdAt: number;
  status: 'open' | 'applied' | 'dismissed';
}

export interface StateStore {
  partners(): Promise<PartnerConfig[]>;
  breakers(): Promise<Record<string, BreakerRow>>;
  saveBreakers(rows: BreakerRow[], at: number): Promise<void>;
  saveWindows(windows: WindowResult[], runAt: number): Promise<void>;
  /** Insert or refresh open review items (one open item per affiliate). Applied/dismissed items are kept. */
  upsertReview(items: ReviewItem[]): Promise<void>;
  openReviews(): Promise<ReviewItem[]>;
}

export class MemoryStore implements StateStore {
  b: Record<string, BreakerRow> = {};
  windows = new Map<string, WindowResult>();
  reviews: ReviewItem[] = [];
  constructor(public partnerList: PartnerConfig[] = []) {}
  async partners() { return this.partnerList.filter((p) => p.enabled); }
  async breakers() { return structuredClone(this.b); }
  async saveBreakers(rows: BreakerRow[]) { for (const r of rows) this.b[r.key] = structuredClone(r); }
  async saveWindows(ws: WindowResult[]) { for (const w of ws) this.windows.set(`${w.key}|${w.start}`, w); }
  async upsertReview(items: ReviewItem[]) {
    for (const it of items) {
      const i = this.reviews.findIndex((r) => r.aff === it.aff && r.status === 'open');
      if (i >= 0) this.reviews[i] = { ...it, createdAt: this.reviews[i].createdAt };
      else this.reviews.push(it);
    }
  }
  async openReviews() { return this.reviews.filter((r) => r.status === 'open'); }
}

/** D1 implementation. Table DDL: provenance/pipeline/d1/0001_provenance.sql. */
export class D1Store implements StateStore {
  constructor(private readonly db: D1Database) {}

  async partners(): Promise<PartnerConfig[]> {
    const { results } = await this.db.prepare('SELECT aff, auth, customer_ids, login_customer_id, token_ref, enabled FROM provenance_partner WHERE enabled = 1').all<Record<string, any>>();
    return results.map((r) => ({ aff: r.aff, auth: r.auth, customerIds: JSON.parse(r.customer_ids), loginCustomerId: r.login_customer_id ?? undefined, tokenRef: r.token_ref ?? undefined, enabled: !!r.enabled }));
  }
  async breakers(): Promise<Record<string, BreakerRow>> {
    const { results } = await this.db.prepare('SELECT key, state, cursor_ms FROM provenance_breaker').all<Record<string, any>>();
    return Object.fromEntries(results.map((r) => [r.key, { key: r.key, state: JSON.parse(r.state), cursor: r.cursor_ms ?? null }]));
  }
  async saveBreakers(rows: BreakerRow[], at: number) {
    const st = this.db.prepare(`INSERT INTO provenance_breaker (key, aff, source, tier, state, cursor_ms, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(key) DO UPDATE SET tier = excluded.tier, state = excluded.state, cursor_ms = excluded.cursor_ms, updated_ms = excluded.updated_ms`);
    await this.batch(rows.map((r) => { const [aff, source] = r.key.split('|'); return st.bind(r.key, aff, source, r.state.tier, JSON.stringify(r.state), r.cursor, at); }));
  }
  async saveWindows(ws: WindowResult[], runAt: number) {
    const st = this.db.prepare(`INSERT INTO provenance_window (key, start_ms, end_ms, aff, source, status, tier, hard, reasons, stats, run_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT(key, start_ms) DO UPDATE SET end_ms = excluded.end_ms, status = excluded.status, tier = excluded.tier, hard = excluded.hard, reasons = excluded.reasons, stats = excluded.stats, run_ms = excluded.run_ms`);
    await this.batch(ws.map((w) => st.bind(w.key, w.start, w.end, w.aff, w.source, w.status, w.tier, w.hard ? 1 : 0, JSON.stringify(w.reasons), JSON.stringify(w.stats), runAt)));
  }
  async upsertReview(items: ReviewItem[]) {
    const st = this.db.prepare(`INSERT INTO provenance_review (aff, tier, kv_key, kv_value, reasons, created_ms, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open')
      ON CONFLICT(aff) WHERE status = 'open' DO UPDATE SET tier = excluded.tier, reasons = excluded.reasons`);
    await this.batch(items.map((i) => st.bind(i.aff, i.tier, i.key, i.value, JSON.stringify(i.reasons), i.createdAt)));
  }
  async openReviews(): Promise<ReviewItem[]> {
    const { results } = await this.db.prepare("SELECT aff, tier, kv_key, kv_value, reasons, created_ms, status FROM provenance_review WHERE status = 'open' ORDER BY created_ms").all<Record<string, any>>();
    return results.map((r) => ({ aff: r.aff, tier: r.tier, key: r.kv_key, value: r.kv_value, reasons: JSON.parse(r.reasons), createdAt: r.created_ms, status: r.status }));
  }
  private async batch(stmts: D1PreparedStatement[]) {
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50));
  }
}
