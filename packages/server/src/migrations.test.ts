/**
 * Applies supabase/migrations to a real Postgres (PGlite) with a minimal stand-in
 * for Supabase's `auth` schema and roles, then checks the functions, the
 * tracking owner trigger and row-level security.
 */
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPglite } from './testing/database.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

let db: PGlite;

async function asUser(userId: string | null, sql: string) {
  await db.exec(`set role ${userId ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${userId ?? ''}', false);`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

beforeAll(async () => {
  db = await createPglite();
  await db.exec(`insert into auth.users (id, email) values ('${ADA}', 'ada@example.com'), ('${BOB}', 'bob@example.com');`);
}, 60_000);

describe('Cloud migrations', () => {
  it('create a profile for each new auth user', async () => {
    const { rows } = await db.query<{ id: string }>('select id from public.profiles order by email');
    expect(rows.map((row) => row.id)).toEqual([ADA, BOB]);
  });

  it('record usage atomically with daily and global rollups', async () => {
    const call = `select public.record_usage('${ADA}', 'summarize', 'mock', 'm', 'ok', null, 12, 100, 20, 0, 'req_1', '2026-09-26T10:00:00Z')`;
    await db.query(call);
    await db.query(call.replace('req_1', 'req_2'));
    const daily = await db.query<{ requests: number; tokens: string }>(`select requests, tokens from public.usage_daily where user_id = '${ADA}'`);
    expect(daily.rows[0]).toMatchObject({ requests: 2 });
    expect(Number(daily.rows[0]!.tokens)).toBe(240);
    const global = await db.query<{ tokens: string }>(`select tokens from public.usage_global_daily where day = '2026-09-26'`);
    expect(Number(global.rows[0]!.tokens)).toBe(240);
    const columns = await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'usage_events'`);
    expect(columns.rows.map((row) => row.column_name).join(',')).not.toMatch(/prompt|body|subject|text|content/);
  });

  it('count rate-limit hits per window', async () => {
    const hit = async () => (await db.query<{ n: number }>(`select public.hit_rate_limit('ai:${ADA}', '2026-09-26T10:01:00Z') as n`)).rows[0]!.n;
    expect([await hit(), await hit(), await hit()]).toEqual([1, 2, 3]);
  });

  it('leave no billing or waitlist objects behind', async () => {
    const tables = await db.query<{ relname: string }>(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('subscriptions', 'billing_customers', 'stripe_events', 'cloud_waitlist')`);
    expect(tables.rows).toEqual([]);
    const functions = await db.query<{ proname: string }>(`select proname from pg_proc where proname in ('apply_subscription', 'begin_stripe_event')`);
    expect(functions.rows).toEqual([]);
  });

  it('stamp tracking rows with the owner of the email and reject forged owners', async () => {
    await db.query(`insert into public.tracked_emails (tracking_id, user_id, subject, sender) values ('trk_a', '${ADA}', 's', 'ada@example.com')`);
    await db.query(`insert into public.tracking_events (id, tracking_id, type) values ('evt_a', 'trk_a', 'OPEN')`);
    const owner = await db.query<{ user_id: string }>(`select user_id from public.tracking_events where id = 'evt_a'`);
    expect(owner.rows[0]!.user_id).toBe(ADA);
    await expect(db.query(`insert into public.tracking_events (id, tracking_id, user_id, type) values ('evt_b', 'trk_a', '${BOB}', 'OPEN')`)).rejects.toThrow(/owner mismatch/);
    await expect(db.query(`insert into public.tracked_links (click_id, tracking_id, destination) values ('clk_x', 'trk_a', 'javascript:alert(1)')`)).rejects.toThrow();
  });

  it('enforce row-level security for signed-in clients', async () => {
    expect((await asUser(ADA, 'select tracking_id from public.tracked_emails')).rows).toHaveLength(1);
    expect((await asUser(BOB, 'select tracking_id from public.tracked_emails')).rows).toHaveLength(0);
    expect((await asUser(BOB, 'select * from public.usage_events')).rows).toHaveLength(0);
    expect((await asUser(null, 'select * from public.profiles')).rows).toHaveLength(0);
    // No update policy: RLS lets the statement run but it changes nothing.
    expect((await asUser(ADA, `update public.profiles set email = 'x' returning id`)).rows).toHaveLength(0);
    expect((await asUser(BOB, `delete from public.tracked_emails returning tracking_id`)).rows).toHaveLength(0);
    await expect(asUser(ADA, 'select * from public.rate_limit_windows')).rejects.toThrow();
    await expect(asUser(ADA, `select public.record_usage('${ADA}', 'x', 'x', null, 'ok', null, 1, 1, 1, 0, 'r', now())`)).rejects.toThrow();
  });

  it('delete everything a user owns with the profile', async () => {
    await db.query(`delete from public.profiles where id = '${ADA}'`);
    for (const table of ['tracked_emails', 'tracking_events', 'usage_events', 'usage_daily']) {
      const { rows } = await db.query(`select 1 from public.${table} where user_id = '${ADA}'`);
      expect(rows, table).toHaveLength(0);
    }
  });
});

/**
 * Structural guarantees for every table and function, so a new migration
 * cannot quietly ship a table without row-level security or a privileged
 * function without a pinned search_path.
 */
describe('Schema security invariants', () => {
  const rows = async <T>(sql: string) => (await db.query<T>(sql)).rows;
  /** Tables owned by the original tracking and usage schema, which predates these rules. */
  const LEGACY = new Set(['profiles', 'usage_events', 'usage_daily', 'tracked_emails', 'tracked_links', 'tracking_events', 'tracking_self_view_claims', 'rate_limit_windows']);

  it('enables row-level security on every public table', async () => {
    expect(await rows(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`)).toEqual([]);
  });

  it('gives signed-out clients nothing, and signed-in clients no direct writes', async () => {
    const anon = await rows<{ table_name: string }>(`select distinct table_name from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`);
    expect(anon.map((row) => row.table_name).filter((name) => !LEGACY.has(name))).toEqual([]);
    const writes = await rows<{ table_name: string }>(
      `select distinct table_name from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`,
    );
    expect(writes.map((row) => row.table_name).filter((name) => !LEGACY.has(name))).toEqual([]);
  });

  it('never lets the browser read credentials, OAuth state, jobs, tokens or invitations', async () => {
    for (const table of ['encrypted_credentials', 'oauth_states', 'jobs', 'mcp_clients', 'webhooks', 'document_recipients', 'document_viewer_sessions', 'workspace_invitations', 'idempotency_keys']) {
      const grants = await rows(`select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = '${table}' and grantee in ('anon', 'authenticated')`);
      expect(grants, table).toEqual([]);
    }
  });

  it('scopes every user-owned table for server code through pigeonbox_app policies', async () => {
    const missing = await rows<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'user_id')
          and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and 'pigeonbox_app' = any (p.roles))`,
    );
    expect(missing.map((row) => row.relname).filter((name) => !LEGACY.has(name))).toEqual([]);
    // The server's role can never be assumed from a client JWT.
    expect((await rows<{ member: boolean }>(`select pg_has_role('authenticator', 'pigeonbox_app', 'member') as member`))[0]!.member).toBe(false);
  });

  it('pins search_path on every security-definer function and keeps app functions away from anon', async () => {
    expect(
      await rows(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname in ('public', 'app') and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`),
    ).toEqual([]);
    const callable = await rows<{ f: string }>(`select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(callable.map((row) => row.f)).toEqual([]);
  });

  it('deletes everything a user owns when the profile goes', async () => {
    const tables = await rows<{ table_name: string }>(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id'`);
    const orphans = await rows<{ table_name: string }>(
      `select col.table_name from information_schema.columns col where col.table_schema = 'public' and col.column_name = 'user_id'
          and not exists (
            select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
             where c.relname = col.table_name and k.contype = 'f' and k.confdeltype in ('c', 'n')
               and k.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass))`,
    );
    expect(tables.length).toBeGreaterThan(60);
    expect(orphans.map((row) => row.table_name)).toEqual([]);
  });
});
