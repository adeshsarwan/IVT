// Browser UI for the Traffic Provenance logic. Bundled into a single self-contained
// provenance/demo/index.html by build.mjs (open it as a file; no server, no network).

import {
  buildScenario, googleClicksFromCsv, googleDailyFromCsv, makeConfig, metaFromCsv, partnerStatus, planSyncJobs, runFleet, SCENARIOS,
  spotAuditPlan, strengthByAffiliate, type FleetContext, type FleetResult, type ScenarioId, type ConnectorType,
} from '../src/index';
import type { ProvenanceInput, Reason, WindowResult } from '../src/types';

type Fixture = { input: ProvenanceInput; config: Record<string, unknown>; title?: string; expect?: string; fleet?: FleetContext };

const $ = <T = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(d)}%`);
const fmtTs = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');

let fixture: Fixture | null = null;
let current: ScenarioId | 'custom' = 'clean';

function presetButtons() {
  const box = $('presets');
  box.innerHTML = (Object.keys(SCENARIOS) as ScenarioId[]).map((id) =>
    `<button class="preset" data-id="${id}" title="${esc(SCENARIOS[id].expect)}">${esc(SCENARIOS[id].title)}</button>`).join('');
  box.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button.preset') as HTMLButtonElement | null;
    if (b) loadPreset(b.dataset.id as ScenarioId);
  });
}

function loadPreset(id: ScenarioId) {
  const s = buildScenario(id);
  current = id;
  fixture = { input: s.input, config: s.config as Record<string, unknown>, title: s.title, expect: s.expect, fleet: s.fleet };
  document.querySelectorAll('button.preset').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.id === id));
  $('fx-title').textContent = s.title;
  $('fx-expect').textContent = `Expected: ${s.expect}`;
  $<HTMLTextAreaElement>('cfg-json').value = JSON.stringify(s.config, null, 2);
  syncFixtureSummary();
  closeEditor();
  run();
}

function syncFixtureSummary() {
  if (!fixture) return;
  const i = fixture.input;
  const affs = Object.keys(i.platform || {});
  const g = affs.reduce((a, k) => a + (i.platform[k].google?.clicks.length || 0), 0);
  const m = affs.reduce((a, k) => a + (i.platform[k].meta?.insights.length || 0), 0);
  $('fx-summary').innerHTML = `<b>${i.requests.length.toLocaleString()}</b> logged requests · <b>${g.toLocaleString()}</b> Google click rows · <b>${m.toLocaleString()}</b> Meta Insights rows · affiliates with platform data: ${affs.map(esc).join(', ') || 'none'} · now = ${esc(new Date(i.now as any).toISOString())}`;
}

function readConfig(): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  try { base = JSON.parse($<HTMLTextAreaElement>('cfg-json').value || '{}'); $('cfg-err').textContent = ''; }
  catch (e) { $('cfg-err').textContent = `Config JSON error: ${(e as Error).message}`; throw e; }
  const n = $<HTMLSelectElement>('win-size').value;
  const custom = Number($<HTMLInputElement>('win-custom').value);
  return {
    ...base,
    windowSize: n === 'custom' ? custom : Number(n),
    windowMaxMs: Number($<HTMLInputElement>('win-hours').value) * 3600_000,
    sampleRate: Number($<HTMLInputElement>('sample-rate').value) / 100,
    minSample: Number($<HTMLInputElement>('min-sample').value),
    minWindowRequests: Number($<HTMLInputElement>('min-window').value),
  };
}

function run() {
  if (!fixture) return;
  let rep: FleetResult;
  const t0 = performance.now();
  // One reconciliation job per affiliate, exactly as the queue consumer would run them.
  try { rep = runFleet(fixture.input, readConfig() as any); }
  catch (e) { $('results').innerHTML = `<div class="err">Run failed: ${esc((e as Error).message)}</div>`; return; }
  const ms = performance.now() - t0;
  render(rep, ms);
}

const tierClass = (t: string) => ({ OK: 'ok', WATCH: 'watch', THROTTLE: 'thr', BLOCK: 'block' }[t] || '');

function ciBar(rate: number | null | undefined, ci: [number, number] | null | undefined, marks: number[] = []) {
  if (rate === null || rate === undefined || !ci) return '<span class="muted">–</span>';
  const m = marks.map((x) => `<i class="mark" style="left:${x * 100}%"></i>`).join('');
  return `<span class="ci" title="${pct(rate, 2)} (95% CI ${pct(ci[0], 2)}–${pct(ci[1], 2)})"><span class="ci-band" style="left:${ci[0] * 100}%;width:${Math.max(0.6, (ci[1] - ci[0]) * 100)}%"></span><span class="ci-pt" style="left:${rate * 100}%"></span>${m}</span> ${pct(rate)}`;
}

function fleetHtml(rep: FleetResult): string {
  const f = fixture?.fleet;
  if (!f) return '';
  const now = Number(new Date(fixture!.input.now as any));
  const rows = partnerStatus(f.connectors, f.states, rep.affiliates, now, rep.config);
  const plan = planSyncJobs(f.connectors, f.states, now);
  const audits = spotAuditPlan(strengthByAffiliate(f.connectors, rep.affiliates.map((a) => a.aff)), '2026-W47', 'demo-salt', rep.config);
  const count = (k: string) => rows.filter((r) => r.health === k).length;
  const hc: Record<string, string> = { healthy: 'ok', late: 'watch', failing: 'thr', parked: 'block', never_synced: 'watch', disabled: '' };
  const showAll = $<HTMLInputElement>('all-partners')?.checked;
  const visible = showAll ? rows : rows.filter((r) => r.health !== 'healthy' || (r.tier && r.tier !== 'OK'));
  return `<h3>Partner status <span class="muted small">(${rows.length} connectors · ${['healthy', 'late', 'failing', 'parked', 'never_synced'].map((k) => `${count(k)} ${k.replace('_', ' ')}`).join(' · ')})</span></h3>
    <div class="row small" style="margin-bottom:6px"><label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="all-partners" ${showAll ? 'checked' : ''}> show healthy OK partners too</label>
      <span class="muted">Sync plan now: <b>${plan.jobs.length}</b> pull jobs queued, ${plan.deferred.length} deferred (rate limit), ${plan.parked.length} parked · Spot audits this week: <b>${audits.length}</b> (${audits.slice(0, 12).map(esc).join(', ')}${audits.length > 12 ? '…' : ''})</span></div>
    <div class="scroll"><table class="wins"><thead><tr><th>Affiliate</th><th>Platform</th><th>Connector</th><th>Strength</th><th>Health</th><th>Covered through</th><th>Last success</th><th>Tier</th><th>Audit rate</th></tr></thead><tbody>
    ${visible.map((r) => `<tr><td><b>${esc(r.aff)}</b></td><td>${r.platform}</td><td><code>${r.type}</code> <span class="muted small">${r.mode}</span></td><td>${r.strength}</td>
      <td><span class="pill ${hc[r.health]}">${r.health.replace('_', ' ')}</span>${r.lastError ? `<br><span class="muted small">${esc(r.lastError)} ×${r.consecutiveFailures}</span>` : ''}</td>
      <td>${esc(r.coveredThrough ?? '–')}</td><td class="num">${r.lastSuccessAgeHours === null ? '–' : `${r.lastSuccessAgeHours}h ago`}</td>
      <td>${r.tier ? `<span class="pill ${tierClass(r.tier)}">${r.tier}</span>` : '–'}</td><td class="num">${pct(r.auditRate, 0)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">All partners healthy and OK.</td></tr>'}
    </tbody></table></div>`;
}

function render(rep: FleetResult, ms: number) {
  const many = rep.affiliates.length > 12;
  const tierCount = (t: string) => rep.affiliates.filter((a) => a.tier === t).length;
  const affList = many ? rep.affiliates.filter((a) => a.tier !== 'OK') : rep.affiliates;
  const connOf = (aff: string) => [...new Set(rep.windows.filter((w) => w.aff === aff && w.stats.connector).map((w) => `${w.source}: ${w.stats.connector}`))].join(' · ');
  const affHtml = affList.map((a) => `
    <div class="aff ${tierClass(a.tier)}">
      <div class="aff-head"><span class="aff-id">aff ${esc(a.aff)}</span><span class="pill ${tierClass(a.tier)}">${a.tier}</span></div>
      <div class="muted small">by source: ${Object.entries(a.bySource).map(([s, t]) => `${s} <b>${t}</b>`).join(' · ')}</div>
      <div class="muted small">access: ${Object.entries(a.access).map(([s, t]) => `${s} ${t}`).join(' · ') || '–'}${connOf(a.aff) ? ` · data via ${esc(connOf(a.aff))}` : ''}</div>
      <ul class="actions">${a.actions.map((x) => `<li><code>${x.op === 'none' ? 'no change' : `${x.op === 'suggest' ? 'recommend (manual):' : x.op} ${esc(x.key)}${x.value ? ` = "${esc(x.value)}"` : ''}`}</code> <span class="muted">${esc(x.note)}</span></li>`).join('')}</ul>
      ${a.notes.map((n) => `<div class="note small">${esc(n)}</div>`).join('')}
    </div>`).join('');

  const onlyBad = $<HTMLInputElement>('only-bad')?.checked ?? many;
  const rows = rep.windows.map((w, i) => {
    if (onlyBad && w.tier === 'OK' && w.breakerTier === 'OK') return '';
    const s = w.stats;
    const ratio = s.ratio ? (s.ratio.value === null ? '–' : Number.isFinite(s.ratio.value) ? `${s.ratio.value.toFixed(3)}×` : '∞') : '–';
    const top = w.reasons.filter((r) => r.severity > 0).slice(0, 2).map((r) => `<code class="sev${r.severity}">${esc(r.code)}</code>`).join(' ');
    const mr = s.matchRate;
    return `<tr class="wrow" data-i="${i}">
      <td><b>${esc(w.aff)}</b> · ${w.source} #${w.index}</td>
      <td class="small">${fmtTs(w.start)} →<br>${fmtTs(w.end)}<br><span class="muted">closed by ${w.closedBy}</span></td>
      <td><span class="st st-${w.status}">${w.status}</span></td>
      <td class="num">${s.requests.toLocaleString()}<br><span class="muted small">${s.sampled.toLocaleString()} sampled</span></td>
      <td>${w.source === 'google' ? ciBar(mr?.rate, mr?.ci, [0.75, 0.9, 0.95]) : w.source === 'meta' ? `<span class="muted small">no click ledger</span>` : '–'}</td>
      <td class="num">${ratio}</td>
      <td><span class="pill ${tierClass(w.tier)}">${w.tier}${w.hard ? ' · hard' : ''}</span></td>
      <td><span class="pill ${tierClass(w.breakerTier!)}">${w.breakerTier}</span></td>
      <td class="small">${top}</td>
    </tr>
    <tr class="detail" id="d${i}" hidden><td colspan="9">${detail(w)}</td></tr>`;
  }).join('');

  $('results').innerHTML = `
    <div class="meta-line muted small">Ran in ${ms.toFixed(0)} ms as ${rep.affiliates.length} per-affiliate jobs · ${fixture!.input.requests.length.toLocaleString()} requests · window N = ${rep.config.windowSize.toLocaleString()} or ${rep.config.windowMaxMs / 3600_000}h · sample ${pct(rep.config.sampleRate, 0)}${Object.keys(rep.failed).length ? ` · <b class="bad">${Object.keys(rep.failed).length} job(s) failed</b>` : ''}</div>
    <h3>Affiliates → Ad Pass kill-switch plan <span class="muted small">(plan only; nothing is written)${many ? ` · ${rep.affiliates.length} affiliates: ${['OK', 'WATCH', 'THROTTLE', 'BLOCK'].map((t) => `${tierCount(t)} ${t}`).join(' · ')} · showing non-OK` : ''}</span></h3>
    <div class="affs">${affHtml || '<p class="muted">No affiliates.</p>'}</div>
    ${fleetHtml(rep)}
    <h3>Windows <span class="muted small">(click a row for every stat and reason)</span></h3>
    <label class="small" style="flex-direction:row;align-items:center;gap:6px;margin-bottom:6px"><input type="checkbox" id="only-bad" ${onlyBad ? 'checked' : ''}> only windows that are not OK</label>
    <div class="scroll"><table class="wins">
      <thead><tr><th>Affiliate · source</th><th>Span (UTC)</th><th>Status</th><th>Requests</th><th>gclid match (95% CI)</th><th>Landings ÷ clicks</th><th>Window</th><th>Breaker</th><th>Top reasons</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  $('only-bad').addEventListener('change', run);
  $('all-partners')?.addEventListener('change', run);
  $('results').querySelectorAll('tr.wrow').forEach((tr) => tr.addEventListener('click', () => {
    const d = $(`d${(tr as HTMLElement).dataset.i}`); d.hidden = !d.hidden; tr.classList.toggle('open', !d.hidden);
  }));
}

function detail(w: WindowResult) {
  const s = w.stats;
  const rate = (label: string, r?: { k: number; n: number; rate: number | null; ci: [number, number] | null }) =>
    r && r.n > 0 ? `<tr><td>${label}</td><td>${r.k.toLocaleString()} / ${r.n.toLocaleString()}</td><td>${ciBar(r.rate, r.ci)}</td></tr>` : '';
  const reasons = (rs: Reason[]) => rs.map((r) => `<li class="sev${r.severity}"><code>${esc(r.code)}</code> <span class="pill ${tierClass(['OK', 'WATCH', 'THROTTLE', 'BLOCK'][r.severity])}">${['info', 'WATCH', 'THROTTLE', 'BLOCK'][r.severity]}</span>${r.hard ? ' <b>hard</b>' : ''}${r.edgeOnly ? ' <span class="muted">edge-only</span>' : ''} — ${esc(r.message)}</li>`).join('');
  const mix = (m?: Record<string, number>) => m && Object.keys(m).length ? Object.entries(m).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') : '–';
  const fr = w.freshness;
  return `<div class="det">
    <div><h4>Reasons</h4><ul class="reasons">${reasons(w.reasons) || '<li class="muted">none — clean</li>'}</ul>
      <p class="small muted">Breaker: ${esc(w.breakerNote || '')}</p>
      ${fr ? `<p class="small">Freshness: covered through <b>${esc(fr.coveredThrough ?? '–')}</b> · import age ${fr.ageHours ?? '–'}h${fr.stale ? ' <b class="bad">stale</b>' : ''} · pending ${pct(fr.pendingShare)}</p>` : ''}
    </div>
    <div><h4>Stats</h4><table class="mini">
      ${rate('gclid match rate', s.matchRate)}${rate('no click id', s.noClickIdRate)}${rate('invalid click id / macro', s.invalidClickIdRate)}
      ${rate('reused click id', s.reusedClickIdRate)}${rate('timing anomaly', s.timingAnomalyRate)}${rate('device mismatch', s.deviceMismatchRate)}
      ${rate('risky network', s.riskyNetworkRate)}${rate('blocked placement', s.blockedPlacementRate)}${rate('unlinked campaign', s.unlinkedCampaignRate)}
      ${rate('fbclid missing', s.fbclidMissingRate)}${rate('unknown ad id', s.unknownAdRate)}
      ${s.connector ? `<tr><td>data source</td><td colspan="2"><code>${esc(s.connector)}</code>${s.clickLevel === false ? ' · aggregate only (no gclids)' : ''}</td></tr>` : ''}
      ${rate('Google vs ValueTrack mismatch', s.paramMismatchRate)}
      ${s.platformOnlyShare !== undefined && s.platformOnlyShare !== null ? `<tr><td>reported clicks that never landed</td><td colspan="2">${pct(s.platformOnlyShare, 2)} <span class="muted">(≈0 = report mirrors our landings)</span></td></tr>` : ''}
      ${s.braidShare ? `<tr><td>gbraid/wbraid only</td><td colspan="2">${pct(s.braidShare)}</td></tr>` : ''}
      ${s.audienceNetworkShare !== undefined && s.audienceNetworkShare !== null ? `<tr><td>Audience Network share</td><td colspan="2">${pct(s.audienceNetworkShare)}</td></tr>` : ''}
      ${s.ratio ? `<tr><td>landings ÷ ${esc(s.ratio.metric)}</td><td colspan="2">${s.ratio.ours.toLocaleString()} / ${s.ratio.platform.toLocaleString()} on ${s.ratio.days.join(', ') || 'no complete days'}</td></tr>` : ''}
      ${s.lpvRatio ? `<tr><td>landings ÷ landing_page_views</td><td colspan="2">${s.lpvRatio.ours} / ${s.lpvRatio.platform} = ${s.lpvRatio.value}×</td></tr>` : ''}
      ${s.hourCurveEntropy !== undefined && s.hourCurveEntropy !== null ? `<tr><td>hour-curve entropy (24h)</td><td colspan="2">${s.hourCurveEntropy} <span class="muted">(1 = flat 24/7)</span></td></tr>` : ''}
    </table>
    <p class="small">Outcomes: ${mix(s.outcomes)}</p>
    ${s.networkMix ? `<p class="small">Network mix: ${mix(s.networkMix)}</p>` : ''}
    ${s.placementMix && Object.keys(s.placementMix).length ? `<p class="small">Top placements: ${mix(s.placementMix)}</p>` : ''}
    ${s.inflatedAds?.length ? `<p class="small">Inflated ads: ${s.inflatedAds.map((a) => `${a.adId} (${a.ours} vs ${a.linkClicks})`).join(', ')}</p>` : ''}
    </div></div>`;
}

// ── Fixture editing ──
function openEditor() {
  if (!fixture) return;
  const txt = JSON.stringify({ input: fixture.input, config: JSON.parse($<HTMLTextAreaElement>('cfg-json').value || '{}') }, null, 1);
  $<HTMLTextAreaElement>('fx-json').value = txt;
  $('fx-editor').hidden = false;
  $('fx-size').textContent = `${(txt.length / 1024 / 1024).toFixed(1)} MB`;
}
function closeEditor() { $('fx-editor').hidden = true; $<HTMLTextAreaElement>('fx-json').value = ''; }
function applyEditor() {
  try {
    const f = JSON.parse($<HTMLTextAreaElement>('fx-json').value);
    useFixture(f, 'Edited fixture');
  } catch (e) { $('fx-err').textContent = `JSON error: ${(e as Error).message}`; }
}
function useFixture(f: any, title: string) {
  const input: ProvenanceInput = f.input ?? f;
  if (!Array.isArray(input.requests) || !input.platform || input.now === undefined) throw new Error('fixture needs { input: { requests[], platform{}, now } , config? }');
  fixture = { input, config: f.config ?? {}, title };
  current = 'custom';
  document.querySelectorAll('button.preset').forEach((b) => b.classList.remove('on'));
  $('fx-title').textContent = title;
  $('fx-expect').textContent = '';
  if (f.config) $<HTMLTextAreaElement>('cfg-json').value = JSON.stringify(f.config, null, 2);
  $('fx-err').textContent = '';
  syncFixtureSummary();
  run();
}
function download() {
  if (!fixture) return;
  const blob = new Blob([JSON.stringify({ input: fixture.input, config: JSON.parse($<HTMLTextAreaElement>('cfg-json').value || '{}') })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `provenance-fixture-${current}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Paste a partner report (exercises the real connectors) ──
function usePaste() {
  if (!fixture) return;
  const kind = $<HTMLSelectElement>('paste-kind').value;
  const aff = $<HTMLInputElement>('paste-aff').value.trim();
  const tz = $<HTMLInputElement>('paste-tz').value.trim() || 'UTC';
  const type = $<HTMLSelectElement>('paste-type').value as ConnectorType;
  const text = $<HTMLTextAreaElement>('paste-text').value;
  const connector = { type, id: `${kind}-${aff}` };
  const r = kind === 'meta_csv'
    ? metaFromCsv(text, { timeZone: tz, accounts: [{ id: 'act_pasted', linked: true }], connector, importedAt: fixture.input.now as any })
    : (kind === 'google_click_csv' ? googleClicksFromCsv : googleDailyFromCsv)(text, { timeZone: tz, accounts: [{ customerId: 'pasted', linked: true }], connector, importedAt: fixture.input.now as any });
  $('paste-out').innerHTML = `${r.data.status === 'ok' ? `Parsed <b>${r.rowsAccepted}</b> rows (${r.rowsRejected} rejected), covered through <b>${esc(r.data.coveredThrough ?? '–')}</b>.` : '<b class="bad">Could not parse.</b>'} ${r.issues.map(esc).join(' · ')}`;
  if (r.data.status !== 'ok') return;
  const slot = (fixture.input.platform[aff] ??= {});
  if (kind === 'meta_csv') slot.meta = r.data as any; else slot.google = r.data as any;
  run();
}

function init() {
  presetButtons();
  $('run').addEventListener('click', run);
  $('win-size').addEventListener('change', () => { $('win-custom-wrap').hidden = $<HTMLSelectElement>('win-size').value !== 'custom'; run(); });
  for (const id of ['win-custom', 'win-hours', 'sample-rate', 'min-sample', 'min-window']) $(id).addEventListener('change', run);
  $('sample-rate').addEventListener('input', () => { $('sample-out').textContent = `${$<HTMLInputElement>('sample-rate').value}%`; });
  $('edit').addEventListener('click', openEditor);
  $('apply').addEventListener('click', applyEditor);
  $('cancel').addEventListener('click', closeEditor);
  $('download').addEventListener('click', download);
  $('paste-run').addEventListener('click', usePaste);
  $('defaults').addEventListener('click', () => { $<HTMLTextAreaElement>('cfg-json').value = JSON.stringify(makeConfig(fixture?.config as any), null, 2); });
  $<HTMLInputElement>('file').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try { useFixture(JSON.parse(await f.text()), f.name); } catch (err) { $('fx-err').textContent = `Load failed: ${(err as Error).message}`; }
  });
  loadPreset('clean');
}

init();
