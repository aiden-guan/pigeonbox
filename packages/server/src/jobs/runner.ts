import type { Logger } from '../http.js';
import type { JobKind, JobQueue, JobRecord } from './queue.js';

/**
 * Executes claimed jobs with bounded concurrency and a retry policy.
 *
 * Failure handling:
 * - `PermanentJobError`: dead-letter now (bad input, access revoked). No retry storm.
 * - `RetryLaterError`: retry after the given delay (e.g. Google's Retry-After).
 * - `DeferJob`: not due yet (outside a sending window, at a daily limit). Runs
 *   again later without spending an attempt.
 * - anything else: exponential backoff with jitter until `maxAttempts`, then dead-letter.
 * Error codes are recorded; messages are not (they could echo content).
 */

export class PermanentJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentJobError';
  }
}

export class RetryLaterError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds: number,
  ) {
    super(code);
    this.name = 'RetryLaterError';
  }
}

export class DeferJob extends Error {
  constructor(
    readonly code: string,
    readonly delaySeconds: number,
  ) {
    super(code);
    this.name = 'DeferJob';
  }
}

/** A job that ran but found nothing to do (e.g. account disconnected meanwhile). Counts as success. */
export class SkipJob extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SkipJob';
  }
}

export type RetryPolicy = { baseSeconds: number; factor: number; maxSeconds: number };

export const DEFAULT_RETRY: RetryPolicy = { baseSeconds: 30, factor: 2, maxSeconds: 3_600 };

const POLICIES: Partial<Record<JobKind, RetryPolicy>> = {
  'gmail.sync': { baseSeconds: 15, factor: 2, maxSeconds: 900 },
  'gmail.watch': { baseSeconds: 60, factor: 2, maxSeconds: 3_600 },
  'thread.analyze': { baseSeconds: 30, factor: 2, maxSeconds: 1_800 },
  'draft.prepare': { baseSeconds: 60, factor: 2, maxSeconds: 1_800 },
  'approval.execute': { baseSeconds: 20, factor: 2, maxSeconds: 600 },
};

export function retryDelaySeconds(kind: JobKind, attempt: number, random: () => number = Math.random): number {
  const policy = POLICIES[kind] ?? DEFAULT_RETRY;
  const raw = Math.min(policy.maxSeconds, policy.baseSeconds * policy.factor ** Math.max(0, attempt - 1));
  // ±20% jitter so retries from one incident spread out.
  return Math.max(1, Math.round(raw * (0.8 + random() * 0.4)));
}

export type JobHandler = (job: JobRecord) => Promise<void>;
export type JobHandlers = Partial<Record<JobKind, JobHandler>>;

export type DrainOptions = {
  maxJobs?: number;
  concurrency?: number;
  /** Stop claiming new work after this many ms (Workers have wall-clock limits). */
  budgetMs?: number;
  leaseSeconds?: number;
};

export type DrainResult = { claimed: number; succeeded: number; retried: number; deferred: number; dead: number; skipped: number };

function errorCode(error: unknown): string {
  if (error instanceof PermanentJobError || error instanceof RetryLaterError) return error.code;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[a-z0-9_.:-]{1,64}$/i.test(code)) return code;
  const name = (error as { name?: unknown })?.name;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? `error:${name}` : 'error';
}

export class JobRunner {
  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: JobHandlers,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Run one claimed job to a terminal or retry state. Never throws. */
  async run(job: JobRecord): Promise<'succeeded' | 'retrying' | 'deferred' | 'dead' | 'skipped'> {
    const handler = this.handlers[job.kind];
    const started = this.now();
    if (!handler) {
      await this.queue.fail(job.id, 'no_handler', 60, true);
      this.log('error', 'job has no handler', { jobId: job.id, jobKind: job.kind });
      return 'dead';
    }
    try {
      await handler(job);
      await this.queue.complete(job.id);
      this.log('info', 'job succeeded', { jobId: job.id, jobKind: job.kind, attempt: job.attempts, latencyMs: this.now() - started });
      return 'succeeded';
    } catch (error) {
      if (error instanceof SkipJob) {
        await this.queue.complete(job.id);
        this.log('info', 'job skipped', { jobId: job.id, jobKind: job.kind, code: error.reason });
        return 'skipped';
      }
      if (error instanceof DeferJob) {
        await this.queue.defer(job.id, error.code, error.delaySeconds);
        this.log('info', 'job deferred', { jobId: job.id, jobKind: job.kind, code: error.code, retryInSeconds: error.delaySeconds });
        return 'deferred';
      }
      const code = errorCode(error);
      const permanent = error instanceof PermanentJobError;
      const delay = error instanceof RetryLaterError ? Math.max(1, error.retryAfterSeconds) : retryDelaySeconds(job.kind, job.attempts);
      const status = await this.queue.fail(job.id, code, delay, permanent);
      this.log(status === 'dead' ? 'error' : 'warn', status === 'dead' ? 'job dead-lettered' : 'job will retry', {
        jobId: job.id,
        jobKind: job.kind,
        attempt: job.attempts,
        code,
        retryInSeconds: status === 'dead' ? undefined : delay,
        latencyMs: this.now() - started,
      }, status === 'dead' ? error : undefined);
      return status === 'dead' ? 'dead' : 'retrying';
    }
  }

  /** Claim and run due jobs until the queue is empty, `maxJobs` ran, or the budget is spent. */
  async drain(options: DrainOptions = {}): Promise<DrainResult> {
    const maxJobs = options.maxJobs ?? 50;
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const deadline = this.now() + (options.budgetMs ?? 20_000);
    // Long enough for a thread analysis with its repair calls on Flex (up to CLOUD_AI_FLEX_TIMEOUT_MS each),
    // so a slow job is not claimed again while it is still running.
    const lease = options.leaseSeconds ?? 300;
    const result: DrainResult = { claimed: 0, succeeded: 0, retried: 0, deferred: 0, dead: 0, skipped: 0 };

    while (result.claimed < maxJobs && this.now() < deadline) {
      const batch = await this.queue.claim(Math.min(concurrency, maxJobs - result.claimed), lease);
      if (!batch.length) break;
      result.claimed += batch.length;
      const outcomes = await Promise.all(batch.map((job) => this.run(job)));
      for (const outcome of outcomes) {
        if (outcome === 'succeeded') result.succeeded += 1;
        else if (outcome === 'retrying') result.retried += 1;
        else if (outcome === 'deferred') result.deferred += 1;
        else if (outcome === 'dead') result.dead += 1;
        else result.skipped += 1;
      }
    }
    return result;
  }
}
