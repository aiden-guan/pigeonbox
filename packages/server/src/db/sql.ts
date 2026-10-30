/**
 * SQL access for the intelligence layer (sync, drafts, rules, jobs, …).
 *
 * Two ways in, chosen explicitly at every call site:
 *
 * - `asUser(userId, fn)` runs `fn` in a transaction as the `pigeonbox_app`
 *   database role with `app.user_id` set. Row-level security then limits every
 *   statement to that user's rows (and their workspaces'), so a bug in a query
 *   cannot read or write another account's data. Request handlers and
 *   per-user jobs use this.
 * - `system(fn)` runs as the connection's owner role, which bypasses RLS. Only
 *   for work that is cross-tenant by nature: claiming jobs, routing a Google
 *   push notification to the accounts it names, cron scans. Keep these
 *   queries few and obvious.
 *
 * Parameters use `$1…$n`. Arrays are sent as Postgres array literals and
 * objects as JSON text, so SQL always casts explicitly (`$1::text[]`,
 * `$2::jsonb`, `$3::timestamptz`).
 */

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface SqlDatabase {
  readonly kind: 'postgres' | 'pglite';
  system<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  asUser<T>(userId: string, fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Opens a database per request (Workers cannot share sockets across requests). */
export interface DatabaseProvider {
  open(): SqlDatabase;
}

/** Marks a value to be sent as JSON even if it is an array. */
export class SqlJson {
  constructor(readonly value: unknown) {}
}
export const json = (value: unknown) => new SqlJson(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, what = 'id'): string {
  if (!UUID.test(value)) throw new Error(`invalid ${what}`);
  return value.toLowerCase();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function arrayLiteral(values: readonly unknown[]): string {
  const items = values.map((value) => {
    if (value === null || value === undefined) return 'NULL';
    if (Array.isArray(value)) return arrayLiteral(value);
    const text = value instanceof Date ? value.toISOString() : String(value);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}

/**
 * Parse a one-dimensional Postgres array literal (`{a,"b c",NULL}`) into
 * strings. The postgres.js driver runs without type discovery (fetch_types is
 * off for Hyperdrive), so array columns arrive as literals and are parsed here.
 */
export function parseArrayLiteral(text: string): (string | null)[] {
  if (text.length < 2 || text[0] !== '{' || text[text.length - 1] !== '}') return [text];
  const out: (string | null)[] = [];
  let i = 1;
  const end = text.length - 1;
  if (i === end) return out;
  while (i <= end) {
    let item: string | null;
    if (text[i] === '"') {
      let value = '';
      i += 1;
      while (i < end && text[i] !== '"') {
        if (text[i] === '\\') i += 1;
        value += text[i];
        i += 1;
      }
      i += 1;
      item = value;
    } else {
      const next = text.indexOf(',', i);
      const stop = next === -1 || next > end ? end : next;
      const raw = text.slice(i, stop);
      i = stop;
      item = raw === 'NULL' ? null : raw;
    }
    out.push(item);
    i += 1;
  }
  return out;
}

/** Normalize a parameter for either driver. */
export function toSqlParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof SqlJson) return JSON.stringify(value.value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  throw new Error('expected a timestamp');
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

export async function one<T>(tx: SqlExecutor, text: string, params?: readonly unknown[]): Promise<T | null> {
  const rows = await tx.query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run `fn` in a user-scoped transaction on a driver-level transaction runner.
 * Shared by both adapters so the role switch is identical everywhere.
 */
export async function scopeToUser(tx: SqlExecutor, userId: string): Promise<void> {
  const id = assertUuid(userId, 'user id');
  await tx.query('set local role pigeonbox_app');
  // search_path is pinned so pgvector's operators resolve whatever the connection default is.
  await tx.query(`select set_config('app.user_id', $1, true), set_config('search_path', 'public, extensions', true)`, [id]);
}

let savepoints = 0;

/**
 * Run `fn` inside a savepoint. A failing statement (for example a row RLS
 * refuses) rolls back only to the savepoint, so the surrounding transaction
 * stays usable. Returns null on failure.
 */
export async function attempt<T>(tx: SqlExecutor, fn: () => Promise<T>): Promise<T | null> {
  const name = `pb_sp_${(savepoints += 1)}`;
  await tx.query(`savepoint ${name}`);
  try {
    const result = await fn();
    await tx.query(`release savepoint ${name}`);
    return result;
  } catch {
    await tx.query(`rollback to savepoint ${name}`);
    return null;
  }
}
