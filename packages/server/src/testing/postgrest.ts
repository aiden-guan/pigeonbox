/**
 * A PostgREST stand-in over PGlite, so code written against `supabase-js`
 * (the hosted tracker's store) runs against the real migrations in tests.
 *
 * Supports what the stores use: select with eq/neq/gt/gte/lt/lte/is/not.is/in
 * filters, order, limit, exact counts (including HEAD), insert, upsert
 * (merge or ignore duplicates), update and delete, with `return=representation`.
 * Requests run as the database owner, like the service role (RLS bypassed);
 * triggers, constraints and foreign keys all apply. Never used in production.
 */
import type { PGlite } from '@electric-sql/pglite';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`postgrest stub: bad identifier ${name}`);
  return `"${name}"`;
}

/** jsonb and array values go over the wire as JSON, like PostgREST receives them. */
function param(value: unknown): unknown {
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

type Built = { where: string; params: unknown[] };

function filters(url: URL, params: unknown[]): Built {
  const clauses: string[] = [];
  for (const [key, raw] of url.searchParams) {
    if (RESERVED.has(key)) continue;
    const column = ident(key);
    const negate = raw.startsWith('not.');
    const value = negate ? raw.slice(4) : raw;
    const dot = value.indexOf('.');
    const op = value.slice(0, dot);
    const operand = value.slice(dot + 1);
    let clause: string;
    if (op === 'is') {
      if (!['null', 'true', 'false'].includes(operand)) throw new Error(`postgrest stub: is.${operand}`);
      clause = `${column} is ${operand}`;
    } else if (op === 'in') {
      const items = operand.replace(/^\(|\)$/g, '').split(',').map((item) => item.replace(/^"|"$/g, ''));
      const placeholders = items.map((item) => {
        params.push(item);
        return `$${params.length}`;
      });
      clause = `${column} in (${placeholders.join(', ')})`;
    } else {
      const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      if (!sqlOp) throw new Error(`postgrest stub: unsupported operator ${op}`);
      params.push(operand);
      clause = `${column} ${sqlOp} $${params.length}`;
    }
    clauses.push(negate ? `not (${clause})` : clause);
  }
  return { where: clauses.length ? ` where ${clauses.join(' and ')}` : '', params };
}

function selectList(url: URL): string {
  const select = url.searchParams.get('select') || '*';
  if (select === '*') return '*';
  return select.split(',').map((column) => ident(column.trim())).join(', ');
}

function orderBy(url: URL): string {
  const order = url.searchParams.get('order');
  if (!order) return '';
  const parts = order.split(',').map((term) => {
    const [column, ...mods] = term.split('.');
    const dir = mods.includes('desc') ? 'desc' : 'asc';
    const nulls = mods.includes('nullsfirst') ? ' nulls first' : mods.includes('nullslast') ? ' nulls last' : '';
    return `${ident(column!)} ${dir}${nulls}`;
  });
  return ` order by ${parts.join(', ')}`;
}

function prefers(request: Request): Set<string> {
  return new Set((request.headers.get('Prefer') || '').split(',').map((part) => part.trim()).filter(Boolean));
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A `fetch` that answers `${base}/rest/v1/<table>` from PGlite. */
export function postgrestFetch(pg: PGlite): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(recompute_tracking_stats|tracking_event_page)$/);
    if (rpc && request.method === 'POST') {
      try {
        const body = await request.json() as Record<string, unknown>;
        const entries = Object.entries(body);
        const args = entries.map(([key], i) => `${ident(key)} => $${i + 1}`).join(',');
        const result = await pg.query<{ result: unknown }>(`select public.${ident(rpc[1]!)}(${args}) as result`, entries.map(([, value]) => value));
        return reply(200, result.rows[0]?.result);
      } catch { return reply(400, { message: 'RPC failed' }); }
    }
    const match = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!match) return reply(404, { message: 'not found' });
    const table = `public.${ident(match[1]!)}`;
    const prefer = prefers(request);
    const representation = prefer.has('return=representation');
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const params: unknown[] = [];
        const { where } = filters(url, params);
        const headers: Record<string, string> = {};
        if (prefer.has('count=exact')) {
          const counted = await pg.query<{ n: number }>(`select count(*)::int as n from ${table}${where}`, params);
          headers['Content-Range'] = `*/${counted.rows[0]!.n}`;
        }
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
        const limit = url.searchParams.get('limit');
        const sql = `select ${selectList(url)} from ${table}${where}${orderBy(url)}${limit ? ` limit ${Number(limit)}` : ''}`;
        return reply(200, (await pg.query(sql, params)).rows, headers);
      }
      if (request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown> | Array<Record<string, unknown>>;
        const rows = Array.isArray(body) ? body : [body];
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        const params: unknown[] = [];
        const values = rows.map((row) => `(${columns.map((column) => {
          if (!(column in row)) return 'default';
          params.push(param(row[column]));
          return `$${params.length}`;
        }).join(', ')})`);
        let conflict = '';
        if (prefer.has('resolution=merge-duplicates') || prefer.has('resolution=ignore-duplicates')) {
          const target = (url.searchParams.get('on_conflict') || '').split(',').filter(Boolean).map(ident);
          if (!target.length) throw new Error('postgrest stub: upsert needs on_conflict');
          conflict = prefer.has('resolution=ignore-duplicates')
            ? ` on conflict (${target.join(', ')}) do nothing`
            : ` on conflict (${target.join(', ')}) do update set ${columns.map((column) => `${ident(column)} = excluded.${ident(column)}`).join(', ')}`;
        }
        const sql = `insert into ${table} (${columns.map(ident).join(', ')}) values ${values.join(', ')}${conflict}${representation ? ' returning *' : ''}`;
        const result = await pg.query(sql, params);
        return representation ? reply(201, result.rows) : new Response(null, { status: 201 });
      }
      if (request.method === 'PATCH') {
        const patch = (await request.json()) as Record<string, unknown>;
        const params: unknown[] = [];
        const sets = Object.entries(patch).map(([column, value]) => {
          params.push(param(value));
          return `${ident(column)} = $${params.length}`;
        });
        const { where } = filters(url, params);
        const result = await pg.query(`update ${table} set ${sets.join(', ')}${where}${representation ? ' returning *' : ''}`, params);
        return representation ? reply(200, result.rows) : new Response(null, { status: 204 });
      }
      if (request.method === 'DELETE') {
        const params: unknown[] = [];
        const { where } = filters(url, params);
        const result = await pg.query(`delete from ${table}${where}${representation ? ' returning *' : ''}`, params);
        return representation ? reply(200, result.rows) : new Response(null, { status: 204 });
      }
      return reply(405, { message: 'method not allowed' });
    } catch (error) {
      const pgError = error as { message?: string; code?: string; detail?: string };
      const status = pgError.code === '23505' ? 409 : pgError.code === '42501' ? 403 : 400;
      return reply(status, { message: pgError.message ?? 'error', code: pgError.code ?? '', details: pgError.detail ?? null, hint: null });
    }
  }) as typeof fetch;
}
