// Local end-to-end run: local ClickHouse (Docker) + fake Google Ads API + in-memory state store.
//   docker run -d --name ivt-clickhouse -p 8123:8123 -e CLICKHOUSE_DB=provenance -e CLICKHOUSE_USER=dev \
//     -e CLICKHOUSE_PASSWORD=dev clickhouse/clickhouse-server:25.8
//   npm run provenance:local
// Refuses to run against anything but localhost (it drops and recreates the tables).

import { ClickHouse } from '../clickhouse/client';
import { applySchema, dropAll } from '../clickhouse/schema';
import { ingestLandings, runDaily } from '../job';
import { MemoryStore } from '../store';
import { buildLocalFleet, LOCAL_NOW } from './fixture';

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const pct = (x: number | null) => (x === null ? '   –  ' : `${(x * 100).toFixed(1).padStart(5)}%`);
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const lpad = (s: unknown, n: number) => String(s).padStart(n);

async function main() {
  const url = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url)) { console.error(`refusing to reset non-local ClickHouse: ${url}`); process.exit(1); }
  const ch = new ClickHouse({ url, database: process.env.CLICKHOUSE_DB ?? 'provenance', user: process.env.CLICKHOUSE_USER ?? 'dev', password: process.env.CLICKHOUSE_PASSWORD ?? 'dev' });

  const fleet = buildLocalFleet();
  const t0 = Date.now();
  await dropAll(ch);
  await applySchema(ch);
  for (let i = 0; i < fleet.landings.length; i += 20_000) await ingestLandings(ch, fleet.landings.slice(i, i + 20_000));
  console.log(`\n① ingest   ${fleet.landings.length.toLocaleString()} landings → ClickHouse (${Date.now() - t0} ms)`);

  const store = new MemoryStore(fleet.partners);
  const t1 = Date.now();
  const sum = await runDaily({ ch, store, googleFor: fleet.googleFor, config: fleet.config, now: LOCAL_NOW, log: (m) => console.log(`   ! ${m}`) });
  console.log(`② daily job ${Date.now() - t1} ms · ${sum.partners} partners · accounts synced ${sum.accountsSynced}, failed ${sum.accountsFailed} · ${sum.googleRequests} Google API requests`);

  console.log('\n③ sync (every click pulled from click_view)');
  for (const r of sum.runs) for (const s of r.syncs)
    console.log(`   aff ${pad(r.aff, 4)} acct ${s.customerId}  ${pad(s.status, 9)} days ${s.dates.join(',')}  click rows ${lpad(s.clickRows.toLocaleString(), 7)}  Google total clicks ${lpad(s.dailyClicks.toLocaleString(), 7)}${s.error ? `  (${s.error.slice(0, 60)})` : ''}`);

  console.log(`\n④ match report for ${sum.report[0]?.date ?? '-'} (SQL over ALL gclids and ALL clicks)`);
  console.log('   aff   landings  w/gclid  malformed  matched  foreign  notFound  match%   G clicks  landings/click  unlanded%  covered');
  for (const m of sum.report)
    console.log(`   ${pad(m.aff, 4)} ${lpad(m.landings, 9)} ${lpad(m.withGclid, 8)} ${lpad(m.malformed, 10)} ${lpad(m.matched, 8)} ${lpad(m.foreign, 8)} ${lpad(m.notFound, 9)}  ${pct(m.matchRate)}  ${lpad(m.googleClicks, 8)}  ${lpad(m.landingsPerClick === null ? '–' : m.landingsPerClick.toFixed(2), 14)}  ${pct(m.unlandedShare)}    ${m.covered ? 'yes' : 'no'}`);

  console.log('\n⑤ engine verdicts (tier incl. provisional · committed = final windows only)');
  for (const r of sum.runs) {
    const res = r.result;
    if (!res) { console.log(`   aff ${pad(r.aff, 4)} evaluate error: ${r.error}`); continue; }
    const top = res.windows.flatMap((w) => w.reasons).filter((x) => x.severity > 0).map((x) => x.code);
    console.log(`   aff ${pad(r.aff, 4)} landings ${lpad(res.landings, 6)}  windows ${lpad(res.windows.length, 2)}  tier ${pad(res.tier, 8)} committed ${pad(res.committedTier, 8)} ${[...new Set(top)].slice(0, 4).join(', ')}`);
    console.log(`        expected: ${fleet.expect[r.aff]}`);
  }

  console.log('\n⑥ manual review queue (nothing written to KV; a person applies the kill switch)');
  for (const rv of sum.openReviews) console.log(`   aff ${pad(rv.aff, 4)} suggest ${rv.key} = "${rv.value}"   ← ${rv.reasons[0] ?? ''}`);
  if (!sum.openReviews.length) console.log('   (empty)');

  // Second run a day later: cursor moves on, nothing new → breakers hold.
  const sum2 = await runDaily({ ch, store, googleFor: fleet.googleFor, config: fleet.config, now: LOCAL_NOW + 86_400_000 });
  console.log(`\n⑦ next-day run: ${sum2.runs.map((r) => `${r.aff}:${r.result?.landings ?? 'err'} new`).join('  ')} · open reviews ${sum2.openReviews.length}`);
  console.log(`\ntotal ${Date.now() - t0} ms\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
