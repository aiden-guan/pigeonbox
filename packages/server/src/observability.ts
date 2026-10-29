import { safeLogMessage, type Logger, type LogFields } from './http.js';
import type { SqlDatabase } from './db/sql.js';
import type { ErrorTracker } from './error-tracking.js';

export const METRICS = ['worker_5xx', 'provider_error', 'auth_refresh_failure', 'google_sync_failure', 'tracking_endpoint_error', 'tracking_ingest_retry', 'tracking_ingested', 'tracking_ingest_lag_ms', 'tracking_dead_letter_pending', 'dead_jobs', 'oldest_due_seconds', 'expired_leases', 'sync_lag_seconds', 'job_lease_loss'] as const;
export type Metric = typeof METRICS[number];
type Sample = { metric: Metric; value: number };
/** Reconstruct a fixed numeric schema. Never serialize an Error, request, URL, ID, or caller fields. */
export function safeSample(metric: string, value: unknown): Sample | null {
  return (METRICS as readonly string[]).includes(metric) && typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { metric: metric as Metric, value: Math.min(value, 1e12) } : null;
}
export function operationalReporter(options: { endpoint?: string; token?: string; fetch?: typeof fetch } = {}) {
  let endpoint: string | null = null;
  try { const url = new URL(options.endpoint ?? ''); if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) endpoint = url.href; } catch { /* Disabled without a valid configured collector. */ }
  const pending: Sample[] = [];
  return {
    enabled: Boolean(endpoint),
    metric(name: Metric, value = 1) { const sample = safeSample(name, value); if (endpoint && sample && pending.length < 100) pending.push(sample); },
    async flush() {
      if (!endpoint || !pending.length) return;
      const samples = pending.splice(0, 100);
      try { await (options.fetch ?? fetch)(endpoint, { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(2000), headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, body: JSON.stringify({ schema: 1, samples }) }); } catch { /* Reporting outages cannot fail requests or jobs. No error text is retained. */ }
    },
  };
}
export type OperationalReporter = ReturnType<typeof operationalReporter>;
/** A strict classifier over existing sanitized operational events. External reports include only metric names/counts. */
export function observedLogger(log: Logger, report: OperationalReporter, errors?: ErrorTracker): Logger {
  return (level, message, fields: LogFields = {}, error?: unknown) => {
    log(level, message, fields);
    if (level === 'error' && errors) errors.capture(safeLogMessage(message), fields, error);
    if (fields.code === 'tracking_ingested' || fields.code === 'tracking_ingest_retry' || fields.code === 'tracking_dead_letter_pending') {
      report.metric(fields.code);
      if (typeof fields.lagMs === 'number') report.metric('tracking_ingest_lag_ms', fields.lagMs);
    }
    const route = fields.route ?? '';
    if (typeof fields.status === 'number' && fields.status >= 500) {
      report.metric('worker_5xx');
      if (/\/t\/|\/l\/|\/d\/|\/open\/|\/c\//.test(route)) report.metric('tracking_endpoint_error');
    }
    if (message === 'ai operation failed') report.metric('provider_error');
    if (message === 'job will retry' || message === 'job dead-lettered') {
      if (fields.jobKind?.startsWith('gmail.')) report.metric('google_sync_failure');
      if (fields.code === 'lease_lost') report.metric('job_lease_loss');
    }
    if (fields.code === 'invalid_grant' || fields.code === 'needs_reauth' || fields.code === 'auth_revoked') report.metric('auth_refresh_failure');
  };
}
/** Cross-tenant aggregate operational health only. No rows, identifiers, content, or credential fields leave this function. */
export async function reportQueueHealth(db: SqlDatabase, report: OperationalReporter) {
  if (!report.enabled) return;
  const rows = await db.system((tx) => tx.query<{ dead_jobs: number; oldest_due_seconds: number; expired_leases: number; sync_lag_seconds: number; job_lease_loss: number }>(`
    select (select count(*)::int from public.jobs where status = 'dead') as dead_jobs,
      (select coalesce(extract(epoch from now() - min(run_at)), 0)::float from public.jobs where status in ('queued','retrying') and run_at < now()) as oldest_due_seconds,
      (select count(*)::int from public.jobs where status = 'running' and locked_until < now()) as expired_leases,
      (select count(*)::int from public.jobs where last_error_code in ('lease_expired','lease_lost')) as job_lease_loss,
      (select coalesce(extract(epoch from now() - min(last_sync_completed_at)), 0)::float from public.gmail_sync_state) as sync_lag_seconds`));
  const row = rows[0];
  if (row) for (const metric of ['dead_jobs', 'oldest_due_seconds', 'expired_leases', 'sync_lag_seconds', 'job_lease_loss'] as const) report.metric(metric, Number(row[metric]));
}
