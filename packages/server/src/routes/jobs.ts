import { reportQueueHealth } from '../observability.js';
import { createIntelDeps, type IntelDeps } from '../intel/context.js';
import { createIntelJobHandlers } from '../intel/jobs.js';
import { JobRunner, type DrainOptions, type DrainResult } from '../jobs/runner.js';
import type { ApiDeps } from './types.js';

/** Intelligence services outside a request (cron, queue drains). The caller closes the database. */
export function openIntel(deps: ApiDeps): IntelDeps | null {
  if (!deps.intel) return null;
  return createIntelDeps({
    config: deps.config,
    db: deps.intel.database.open(),
    box: deps.intel.box,
    google: deps.intel.google,
    inference: deps.inference,
    store: deps.store,
    log: deps.log,
    now: () => deps.now?.() ?? new Date(),
    fetch: deps.intel.fetch,
    storage: deps.intel.storage,
  });
}

/**
 * Claim and run due jobs. Called by the Worker's Cron Trigger every minute,
 * after a Gmail push (best effort, the job is already durable), and by the
 * optional internal drain endpoint.
 */
export async function drainJobs(deps: ApiDeps, options: DrainOptions = {}): Promise<DrainResult> {
  const intel = openIntel(deps);
  if (!intel) return { claimed: 0, succeeded: 0, retried: 0, deferred: 0, dead: 0, skipped: 0 };
  try {
    const runner = new JobRunner(intel.queue, createIntelJobHandlers(intel, deps.intel?.jobs?.(intel) ?? {}), deps.log);
    const result = await runner.drain(options);
    if (result.claimed) deps.log('info', 'job drain', { count: result.claimed, event: `ok:${result.succeeded} retry:${result.retried} defer:${result.deferred} dead:${result.dead} skip:${result.skipped}`.replace(/ /g, '_') });
    if (deps.report?.enabled) await reportQueueHealth(intel.db, deps.report).catch(() => deps.log('warn', 'operational metrics unavailable', { code: 'queue_metrics_unavailable' }));
    return result;
  } finally {
    await intel.db.close();
  }
}
