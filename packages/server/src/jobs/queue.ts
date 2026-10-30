import { iso, isoOrNull, num, one, type SqlDatabase, type SqlExecutor } from '../db/sql.js';

/**
 * Durable background work on Supabase Queues (pgmq). See the `jobs` table and
 * `app.*_job` functions in the foundation migration.
 *
 * Every job has an idempotency key: enqueueing the same key twice returns the
 * first job and sends nothing. Keys are built from what makes the work unique
 * (`sync:<account>:<historyId>`, `analyze:<thread>:<version>`), so duplicate
 * Google notifications or retried requests never duplicate work.
 */

export const JOB_KINDS = [
  'gmail.watch',
  'gmail.sync',
  'gmail.recover',
  'thread.analyze',
  'memory.extract',
  'memory.reindex',
  'memory.consolidate',
  'draft.prepare',
  'followup.due',
  'rules.evaluate',
  'automation.run',
  'briefing.generate',
  'briefing.schedule',
  'calendar.refresh',
  'search.index',
  'approval.execute',
  'sequence.step',
  'signals.refresh',
  'reminder.fire',
  'webhook.deliver',
  'retention.sweep',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type JobStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'dead' | 'cancelled';

export type JobRecord = {
  id: string;
  kind: JobKind;
  userId: string | null;
  accountId: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastErrorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type EnqueueOptions = {
  kind: JobKind;
  userId: string | null;
  accountId?: string | null;
  key: string;
  /** IDs and small parameters only. Never mail content. */
  payload?: Record<string, unknown>;
  runAt?: Date | string;
  maxAttempts?: number;
};

type JobRow = {
  id: string;
  kind: string;
  user_id: string | null;
  mail_account_id: string | null;
  idempotency_key: string;
  payload: Record<string, unknown> | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: unknown;
  last_error_code: string | null;
  created_at: unknown;
  started_at: unknown;
  completed_at: unknown;
};

function toJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    userId: row.user_id,
    accountId: row.mail_account_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload ?? {},
    status: row.status,
    attempts: num(row.attempts),
    maxAttempts: num(row.max_attempts),
    runAt: iso(row.run_at),
    lastErrorCode: row.last_error_code,
    createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    completedAt: isoOrNull(row.completed_at),
  };
}

const MAX_KEY = 200;

/**
 * Enqueue inside the caller's transaction, so the job exists if and only if
 * the write that caused it commits (transactional outbox).
 */
export async function enqueue(tx: SqlExecutor, options: EnqueueOptions): Promise<{ jobId: string; created: boolean }> {
  if (!options.key || options.key.length > MAX_KEY) throw new Error('job idempotency key must be 1-200 characters');
  const row = await one<{ job_id: string; created: boolean }>(
    tx,
    `select job_id, created from app.enqueue_job($1, $2::uuid, $3::uuid, $4, $5::jsonb, $6::timestamptz, $7)`,
    [
      options.kind,
      options.userId,
      options.accountId ?? null,
      options.key,
      options.payload ?? {},
      options.runAt ? new Date(options.runAt) : null,
      options.maxAttempts ?? null,
    ],
  );
  if (!row) throw new Error('enqueue returned nothing');
  return { jobId: row.job_id, created: row.created };
}

export class JobQueue {
  constructor(private readonly db: SqlDatabase) {}

  enqueue(options: EnqueueOptions): Promise<{ jobId: string; created: boolean }> {
    return options.userId ? this.db.asUser(options.userId, (tx) => enqueue(tx, options)) : this.db.system((tx) => enqueue(tx, options));
  }

  async claim(limit: number, leaseSeconds: number): Promise<JobRecord[]> {
    const rows = await this.db.system((tx) => tx.query<JobRow>('select * from app.claim_jobs($1, $2)', [limit, leaseSeconds]));
    return rows.map(toJob);
  }

  async complete(jobId: string): Promise<void> {
    await this.db.system((tx) => tx.query('select app.complete_job($1::uuid)', [jobId]));
  }

  /** Returns the resulting status: 'retrying' or 'dead'. */
  async fail(jobId: string, code: string, retrySeconds: number, dead: boolean): Promise<'retrying' | 'dead' | 'missing'> {
    const row = await this.db.system((tx) =>
      one<{ status: 'retrying' | 'dead' | 'missing' }>(tx, 'select app.fail_job($1::uuid, $2, $3, $4) as status', [jobId, code.slice(0, 64), Math.max(1, Math.round(retrySeconds)), dead]),
    );
    return row?.status ?? 'missing';
  }

  /** Put a job back until later without spending an attempt. */
  async defer(jobId: string, code: string, seconds: number): Promise<void> {
    await this.db.system((tx) => tx.query('select app.defer_job($1::uuid, $2, $3)', [jobId, code.slice(0, 64), Math.max(1, Math.round(seconds))]));
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const row = await this.db.system((tx) => one<JobRow>(tx, 'select * from public.jobs where id = $1::uuid', [jobId]));
    return row ? toJob(row) : null;
  }

  /** Jobs waiting per account, for sync health. */
  async backlog(tx: SqlExecutor, accountId: string): Promise<number> {
    const row = await one<{ n: number }>(
      tx,
      `select count(*)::int as n from public.jobs where mail_account_id = $1::uuid and status in ('queued', 'retrying', 'running')`,
      [accountId],
    );
    return num(row?.n);
  }
}
