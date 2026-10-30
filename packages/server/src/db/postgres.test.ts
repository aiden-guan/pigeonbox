import { expect, it } from 'vitest';
import { createTestDatabase } from '../testing/database.js';
import { POSTGRES_TYPES } from './postgres.js';
import { json, toSqlParam } from './sql.js';
import { readFileSync } from 'node:fs';

it('keeps JSON parameters as database objects and arrays after driver serialization', async () => {
  const { pg } = await createTestDatabase();
  try {
    for (const input of [{ threadId: 'thread-fixture', nested: { enabled: true } }, json([{ email: 'fixture@work.test' }])]) {
      const wire = POSTGRES_TYPES.json.serialize(toSqlParam(input));
      const result = await pg.query<{ value: unknown; kind: string }>('select $1::jsonb as value, jsonb_typeof($1::jsonb) as kind', [wire]);
      const expected = input instanceof Object && 'value' in input ? input.value : input;
      expect(result.rows[0]?.value).toEqual(expected);
      expect(result.rows[0]?.kind).toBe(Array.isArray(expected) ? 'array' : 'object');
    }
  } finally { await pg.close(); }
});

it('repairs double encoded containers and requeues skipped analysis without changing scalars', async () => {
  const { pg } = await createTestDatabase();
  try {
    const userId = '11111111-1111-4111-8111-111111111111';
    await pg.query('insert into auth.users (id, email) values ($1::uuid, $2)', [userId, 'fixture@work.test']);
    await pg.query("select app.enqueue_job('thread.analyze',$1::uuid,null,'json-repair-fixture',$2::jsonb,now(),5)", [userId, JSON.stringify({ threadId: 'thread-fixture' })]);
    await pg.exec("update public.jobs set status='succeeded', payload=to_jsonb(payload::text); drop function if exists pg_temp.restore_container(jsonb);");
    const script = readFileSync(new URL('../../../../supabase/migrations/20260930000000_repair_double_encoded_json.sql', import.meta.url), 'utf8');
    await pg.exec(`begin; ${script}`);
    const jobs = await pg.query<{ payload: unknown; status: string }>('select payload,status from public.jobs order by created_at');
    expect(jobs.rows).toEqual([{ payload: { threadId: 'thread-fixture' }, status: 'succeeded' }, { payload: { threadId: 'thread-fixture' }, status: 'queued' }]);
    const unchanged = await pg.query<{ malformed: unknown; scalar: unknown }>("select pg_temp.restore_container(to_jsonb('not-json'::text)) as malformed, pg_temp.restore_container('42'::jsonb) as scalar");
    expect(unchanged.rows[0]).toEqual({ malformed: 'not-json', scalar: 42 });
    await pg.exec('commit');
  } finally { await pg.close(); }
});

it('reserves a sync slot behind analysis backlog without duplicate claims or starving FIFO', async () => {
  const { pg } = await createTestDatabase();
  try {
    for (const [kind, key] of [['thread.analyze','analysis-1'],['thread.analyze','analysis-2'],['gmail.recover','recover-1'],['gmail.sync','sync-1']]) {
      await pg.query('select app.enqueue_job($1,null,null,$2,\'{}\'::jsonb,now(),8)', [kind,key]);
    }
    const first = await pg.query<{ id: string; idempotency_key: string }>('select * from app.claim_jobs(2,120)');
    expect(first.rows.map(row => row.idempotency_key)).toEqual(['recover-1','analysis-1']);
    const second = await pg.query<{ id: string; idempotency_key: string }>('select * from app.claim_jobs(2,120)');
    expect(second.rows.map(row => row.idempotency_key)).toEqual(['sync-1','analysis-2']);
    expect(new Set([...first.rows,...second.rows].map(row => row.id)).size).toBe(4);
    expect((await pg.query('select * from app.claim_jobs(2,120)')).rows).toHaveLength(0);
  } finally { await pg.close(); }
});
