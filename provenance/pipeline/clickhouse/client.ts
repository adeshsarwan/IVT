// Minimal ClickHouse HTTP client (fetch only, so it runs in Workers and Node alike).
// Query parameters use ClickHouse's server-side binding ({name:Type} in SQL, param_name in the URL),
// so values are never spliced into SQL text.

export interface ClickHouseConfig {
  /** e.g. https://abc.eu-west-1.aws.clickhouse.cloud:8443 or http://localhost:8123 */
  url: string;
  database: string;
  user: string;
  password: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export type Params = Record<string, string | number | boolean | null | (string | number)[]>;

export class ClickHouseError extends Error {
  constructor(message: string, readonly status: number, readonly sql: string) { super(message); }
}

/** Encode a value for the param_<name> URL argument. Arrays use ClickHouse literal syntax. */
export function encodeParam(v: Params[string]): string {
  if (v === null) return '\\N';
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === 'number' ? String(x) : `'${String(x).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)).join(',')}]`;
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

export class ClickHouse {
  private readonly f: typeof fetch;
  constructor(readonly cfg: ClickHouseConfig) { this.f = cfg.fetch ?? fetch; }

  private async post(sql: string | null, body: string, params: Params = {}, settings: Record<string, string | number> = {}): Promise<string> {
    const u = new URL(this.cfg.url);
    u.searchParams.set('database', this.cfg.database);
    for (const [k, v] of Object.entries(settings)) u.searchParams.set(k, String(v));
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, encodeParam(v));
    if (sql !== null) u.searchParams.set('query', sql);
    const res = await this.f(u.toString(), {
      method: 'POST',
      headers: { 'X-ClickHouse-User': this.cfg.user, 'X-ClickHouse-Key': this.cfg.password, 'Content-Type': 'text/plain; charset=utf-8' },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new ClickHouseError(text.slice(0, 2000), res.status, sql ?? body.slice(0, 500));
    return text;
  }

  /** SELECT → rows. 64-bit integers come back as JSON numbers. */
  async query<T = Record<string, unknown>>(sql: string, params: Params = {}): Promise<T[]> {
    const text = await this.post(null, `${sql}\nFORMAT JSONEachRow`, params, { output_format_json_quote_64bit_integers: 0, join_use_nulls: 0 });
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
  }

  /** DDL / ALTER / anything without a result set. */
  async command(sql: string, params: Params = {}): Promise<void> {
    await this.post(null, sql, params);
  }

  /** Bulk insert as JSONEachRow. `async` uses server-side batching (good for many small inserts from Workers). */
  async insert(table: string, rows: Record<string, unknown>[], opts: { async?: boolean } = {}): Promise<number> {
    if (!rows.length) return 0;
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(table)) throw new Error(`bad table name: ${table}`);
    const settings: Record<string, string | number> = { date_time_input_format: 'best_effort', input_format_skip_unknown_fields: 1 };
    if (opts.async) Object.assign(settings, { async_insert: 1, wait_for_async_insert: 1 });
    await this.post(`INSERT INTO ${table} FORMAT JSONEachRow`, rows.map((r) => JSON.stringify(r)).join('\n'), {}, settings);
    return rows.length;
  }
}

/** UTC ms → 'YYYY-MM-DD HH:MM:SS.mmm' (DateTime64(3, 'UTC') input). */
export const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
