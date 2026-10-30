/**
 * Real Postgres for tests: PGlite (WASM Postgres) with pgvector, the
 * Supabase migrations, and small stand-ins for what Supabase provides
 * (`auth` schema, roles, Supabase Queues/pgmq, pg_cron). Never used in
 * production; the Worker uses `PostgresDatabaseProvider`.
 */
import { PGlite, type ParserOptions } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSTGRES_TYPES } from '../db/postgres.js';
import { scopeToUser, toSqlParam, type DatabaseProvider, type SqlDatabase, type SqlExecutor } from '../db/sql.js';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'supabase', 'migrations');

/** Supabase's `auth` schema and roles, minimally. */
export const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role authenticator nologin noinherit;
  grant anon, authenticated to authenticator;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  create schema auth;
  create schema extensions;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
`;

/**
 * The subset of Supabase Queues (pgmq) the job queue uses, with the same
 * signatures and visibility-timeout semantics.
 */
export const PGMQ_STUB = `
  create schema pgmq;
  create type pgmq.message_record as (msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb);
  create function pgmq.create(queue_name text) returns void language plpgsql as $$
  begin
    execute format('create table if not exists pgmq.%I (msg_id bigserial primary key, read_ct integer not null default 0, enqueued_at timestamptz not null default now(), vt timestamptz not null, message jsonb)', 'q_' || queue_name);
    execute format('create table if not exists pgmq.%I (msg_id bigint primary key, read_ct integer, enqueued_at timestamptz, archived_at timestamptz not null default now(), vt timestamptz, message jsonb)', 'a_' || queue_name);
  end $$;
  create function pgmq.send(queue_name text, msg jsonb, delay integer default 0) returns setof bigint language plpgsql as $$
  begin
    return query execute format('insert into pgmq.%I (vt, message) values (now() + make_interval(secs => $1), $2) returning msg_id', 'q_' || queue_name) using delay, msg;
  end $$;
  create function pgmq.read(queue_name text, vt integer, qty integer, conditional jsonb default '{}') returns setof pgmq.message_record language plpgsql as $$
  begin
    return query execute format(
      'with picked as (select msg_id from pgmq.%1$I where vt <= clock_timestamp() and message @> $3 order by msg_id limit $2 for update skip locked)
       update pgmq.%1$I q set vt = clock_timestamp() + make_interval(secs => $1), read_ct = q.read_ct + 1
       from picked where q.msg_id = picked.msg_id
       returning q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message', 'q_' || queue_name) using vt, qty, conditional;
  end $$;
  create function pgmq.delete(queue_name text, msg_id bigint) returns boolean language plpgsql as $$
  declare n integer;
  begin
    execute format('delete from pgmq.%I where msg_id = $1', 'q_' || queue_name) using msg_id;
    get diagnostics n = row_count;
    return n > 0;
  end $$;
  create function pgmq.archive(queue_name text, msg_id bigint) returns boolean language plpgsql as $$
  declare n integer;
  begin
    execute format('with moved as (delete from pgmq.%1$I where msg_id = $1 returning *)
      insert into pgmq.%2$I (msg_id, read_ct, enqueued_at, vt, message) select msg_id, read_ct, enqueued_at, vt, message from moved', 'q_' || queue_name, 'a_' || queue_name) using msg_id;
    get diagnostics n = row_count;
    return n > 0;
  end $$;
  create function pgmq.set_vt(queue_name text, msg_id bigint, vt integer) returns setof pgmq.message_record language plpgsql as $$
  begin
    return query execute format('update pgmq.%I set vt = clock_timestamp() + make_interval(secs => $2) where msg_id = $1 returning msg_id, read_ct, enqueued_at, vt, message', 'q_' || queue_name) using msg_id, vt;
  end $$;
  create schema cron;
  create table cron.job (jobid serial primary key, jobname text unique, schedule text not null, command text not null);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid
  $$;
`;

/** Extensions Supabase installs; PGlite gets stubs or the real pgvector. */
export function prepareMigration(sql: string): string {
  return sql
    .replace(/create extension if not exists (pgmq|pg_cron)[^;]*;/gi, '')
    .replace(/create extension if not exists vector[^;]*;/gi, 'create extension if not exists vector with schema extensions;');
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
}

async function migratedDatabase(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec(SUPABASE_STUB);
  await pg.exec(PGMQ_STUB);
  for (const file of migrationFiles()) await pg.exec(prepareMigration(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')));
  return pg;
}

/** Migrate once and dump the data directory (a tarball PGlite can boot from). */
export async function buildSnapshot(): Promise<Blob> {
  const pg = await migratedDatabase();
  const data = await pg.dumpDataDir('none');
  await pg.close();
  return data;
}

/** Changes whenever a migration or a stub changes, so a cached snapshot is never stale. */
export function snapshotKey(): string {
  const hash = createHash('sha256').update(SUPABASE_STUB).update(PGMQ_STUB);
  for (const file of migrationFiles()) hash.update(file).update(readFileSync(join(MIGRATIONS_DIR, file)));
  return hash.digest('hex').slice(0, 16);
}

/** Set by the Vitest global setup: a snapshot file every test worker boots from. */
export const SNAPSHOT_ENV = 'PIGEONBOX_PGLITE_SNAPSHOT';

/**
 * Migrating takes seconds, so the test run migrates once (global setup) and
 * every test gets a fresh copy of that database. Without the global setup
 * (e.g. running a file directly), each worker migrates once.
 */
let snapshot: Promise<Blob> | null = null;

function loadSnapshot(): Promise<Blob> {
  const file = process.env[SNAPSHOT_ENV];
  if (file && existsSync(file) && file.includes(snapshotKey())) return Promise.resolve(new Blob([readFileSync(file)]));
  return buildSnapshot();
}

export async function createPglite(): Promise<PGlite> {
  snapshot ??= loadSnapshot();
  const pg = new PGlite({ extensions: { vector }, loadDataDir: await snapshot });
  await pg.exec(`set search_path to public, extensions;`);
  return pg;
}

/** The only array types production's driver parses: it runs without type discovery. */
const PARSED_ARRAYS = new Set<number>([...POSTGRES_TYPES.textArray.from, ...POSTGRES_TYPES.intArray.from]);
const productionParsers = new WeakMap<PGlite, Promise<ParserOptions>>();

/**
 * Leave every other array as the literal production receives ("{a,b}"), so a
 * query that only works because PGlite parses, say, timestamptz[] fails here too.
 */
function arraysAsProduction(pg: PGlite, runner: { query: PGlite['query'] }): Promise<ParserOptions> {
  let parsers = productionParsers.get(pg);
  if (!parsers) {
    parsers = runner
      .query<{ oid: number }>('select typarray as oid from pg_catalog.pg_type where typarray <> 0')
      .then(({ rows }) => Object.fromEntries(rows.filter((row) => !PARSED_ARRAYS.has(row.oid)).map((row) => [row.oid, (value: string) => value])));
    productionParsers.set(pg, parsers);
  }
  return parsers;
}

function executor(pg: PGlite, runner: { query: PGlite['query'] }): SqlExecutor {
  return {
    async query<T>(text: string, params: readonly unknown[] = []) {
      const parsers = await arraysAsProduction(pg, runner);
      const result = await runner.query<T>(text, params.map(toSqlParam) as unknown[], { parsers });
      return result.rows;
    },
  };
}

/** A SqlDatabase over one PGlite instance. Transactions are serialized by PGlite. */
export function pgliteDatabase(pg: PGlite): SqlDatabase & DatabaseProvider {
  const db: SqlDatabase & DatabaseProvider = {
    kind: 'pglite',
    open: () => db,
    system: (fn) => pg.transaction((tx) => fn(executor(pg, tx))),
    asUser: (userId, fn) =>
      pg.transaction(async (tx) => {
        const exec = executor(pg, tx);
        await scopeToUser(exec, userId);
        return fn(exec);
      }),
    close: async () => undefined,
  };
  return db;
}

/** A fresh database with every migration applied. */
export async function createTestDatabase() {
  const pg = await createPglite();
  return { pg, db: pgliteDatabase(pg) };
}

/** Insert Supabase auth users (which creates profiles through the trigger). */
export async function seedUsers(pg: PGlite, users: Array<{ id: string; email: string }>): Promise<void> {
  for (const user of users) {
    await pg.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [user.id, user.email]);
  }
}
