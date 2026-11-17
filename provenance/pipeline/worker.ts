// Cloudflare entry point for the provenance pipeline: a SEPARATE Worker (not the Ad Pass Worker).
// Not deployed. See wrangler.example.jsonc.
//
//   cron (every 6h) ──► one queue message per partner ──► queue consumer: runPartner()
//   Ad Pass Worker  ──► { type: 'landings', rows } messages ──► queue consumer: insert into ClickHouse
//
// The Ad Pass Worker only needs one line per landing (fire-and-forget, never blocks the response):
//   ctx.waitUntil(env.PROVENANCE_Q.send({ type: 'landings', rows: [{ id, ts: Date.now(), site, aff, route, url, ipHash, uaHash, uaDevice }] }));

import { ClickHouse } from './clickhouse/client';
import { GoogleAdsClient } from './googleAds';
import { ingestLandings, runPartner, type JobDeps } from './job';
import { D1Store, type PartnerConfig } from './store';
import type { RawRequest } from '../src/types';
import type { ConfigOverrides } from '../src/config';

export type PipelineMsg =
  | { type: 'landings'; rows: RawRequest[] }
  | { type: 'partner'; aff: string; now: number };

export interface PipelineEnv {
  DB: D1Database;
  PROVENANCE_Q: Queue<PipelineMsg>;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_DB: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_PASSWORD: string;
  GADS_DEVELOPER_TOKEN: string;
  GADS_CLIENT_ID: string;
  GADS_CLIENT_SECRET: string;
  /** Our MCC's refresh token (partners linked to our manager account). */
  GADS_MCC_REFRESH_TOKEN: string;
  GADS_MCC_ID: string;
  /** JSON engine overrides (routes etc.). */
  PROVENANCE_CONFIG?: string;
  /** Partner OAuth refresh tokens, by tokenRef (e.g. GADS_RT_88). At 100+ partners move these to
   *  D1, encrypted with a master key secret. */
  [tokenRef: string]: unknown;
}

function deps(env: PipelineEnv, now: number): JobDeps {
  const ch = new ClickHouse({ url: env.CLICKHOUSE_URL, database: env.CLICKHOUSE_DB, user: env.CLICKHOUSE_USER, password: env.CLICKHOUSE_PASSWORD });
  return {
    ch, now, store: new D1Store(env.DB), log: (m) => console.log(m),
    config: env.PROVENANCE_CONFIG ? (JSON.parse(env.PROVENANCE_CONFIG) as ConfigOverrides) : {},
    googleFor: (p: PartnerConfig) => new GoogleAdsClient({
      developerToken: env.GADS_DEVELOPER_TOKEN, clientId: env.GADS_CLIENT_ID, clientSecret: env.GADS_CLIENT_SECRET,
      refreshToken: p.auth === 'mcc' ? env.GADS_MCC_REFRESH_TOKEN : String(env[p.tokenRef ?? ''] ?? ''),
      loginCustomerId: p.auth === 'mcc' ? env.GADS_MCC_ID : p.loginCustomerId,
    }),
  };
}

export default {
  async scheduled(_c: ScheduledController, env: PipelineEnv): Promise<void> {
    const now = Date.now();
    const partners = await new D1Store(env.DB).partners();
    for (let i = 0; i < partners.length; i += 100)
      await env.PROVENANCE_Q.sendBatch(partners.slice(i, i + 100).map((p) => ({ body: { type: 'partner', aff: p.aff, now } as PipelineMsg })));
  },

  async queue(batch: MessageBatch<PipelineMsg>, env: PipelineEnv): Promise<void> {
    const landings: RawRequest[] = [];
    for (const m of batch.messages) if (m.body.type === 'landings') landings.push(...m.body.rows);
    if (landings.length) {
      const d = deps(env, Date.now());
      await ingestLandings(d.ch, landings); // throws → whole batch retried by the queue
    }
    for (const m of batch.messages) {
      if (m.body.type !== 'partner') continue;
      const body = m.body;
      const d = deps(env, body.now);
      const store = d.store;
      const p = (await store.partners()).find((x) => x.aff === body.aff);
      if (!p) { m.ack(); continue; }
      const prev = (await store.breakers())[`${p.aff}|google`];
      const run = await runPartner(d, p, prev);
      if (run.error) m.retry({ delaySeconds: 900 }); else m.ack();
    }
  },
};
