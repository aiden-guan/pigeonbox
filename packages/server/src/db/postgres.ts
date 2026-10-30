import postgres from 'postgres';
import { parseArrayLiteral, scopeToUser, toSqlParam, type DatabaseProvider, type SqlDatabase, type SqlExecutor } from './sql.js';

// Without fetch_types the driver has no array parsers, so arrays would arrive as
// literals ("{a,b}"). Parameters are always sent as literals (toSqlParam), so
// only parsing is needed. OIDs are Postgres built-ins.
const TEXT_ARRAYS = [1009 /* text[] */, 1015 /* varchar[] */, 2951 /* uuid[] */, 1002 /* char[] */];
const INT_ARRAYS = [1005 /* int2[] */, 1007 /* int4[] */];
export const POSTGRES_TYPES = {
  // toSqlParam already encodes JSON. postgres.js infers json/jsonb parameter
  // OIDs from SQL casts and otherwise JSON.stringify's that text a second time.
  json: { to: 114, from: [114, 3802], serialize: (value: unknown) => String(value), parse: (value: string) => JSON.parse(value) },
  textArray: { to: 1009, from: TEXT_ARRAYS, serialize: (value: unknown) => String(value), parse: (value: string) => parseArrayLiteral(value) },
  intArray: {
    to: 1007,
    from: INT_ARRAYS,
    serialize: (value: unknown) => String(value),
    parse: (value: string) => parseArrayLiteral(value).map((item) => (item === null ? null : Number(item))),
  },
};

/**
 * Production database: Supabase Postgres through Cloudflare Hyperdrive (or the
 * Supabase pooler in transaction mode; Hyperdrive itself targets the session-mode
 * pooler). One client per request; Hyperdrive
 * pools the real connections. Prepared statements are off because transaction
 * pooling cannot keep them.
 */
export class PostgresDatabaseProvider implements DatabaseProvider {
  constructor(private readonly connectionString: string) {}

  open(): SqlDatabase {
    const sql = postgres(this.connectionString, {
      max: 4,
      prepare: false,
      fetch_types: false,
      types: POSTGRES_TYPES,
      idle_timeout: 5,
      connect_timeout: 10,
      // Numbers that fit stay numbers; bigint counters are selected as ::int or ::text in SQL.
      transform: { undefined: null },
      onnotice: () => undefined,
    });

    const executor = (runner: postgres.Sql | postgres.TransactionSql): SqlExecutor => ({
      async query<T>(text: string, params: readonly unknown[] = []) {
        const rows = await runner.unsafe(text, params.map(toSqlParam) as postgres.ParameterOrJSON<never>[]);
        return rows as unknown as T[];
      },
    });

    return {
      kind: 'postgres',
      system: <T>(fn: (tx: SqlExecutor) => Promise<T>) => sql.begin((tx) => fn(executor(tx))) as Promise<T>,
      asUser: <T>(userId: string, fn: (tx: SqlExecutor) => Promise<T>) =>
        sql.begin(async (tx) => {
          const exec = executor(tx);
          await scopeToUser(exec, userId);
          return fn(exec);
        }) as Promise<T>,
      close: () => sql.end({ timeout: 2 }),
    };
  }
}
