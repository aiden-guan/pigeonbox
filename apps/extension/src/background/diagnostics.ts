/**
 * Content-free extension diagnostics (schema: docs/diagnostics.md).
 *
 * Server logs cannot see what fails before a Cloud request: InboxSDK loading,
 * Gmail anchoring, the service worker restarting, a check that never left the
 * extension. This module keeps a short ring of structured events about those,
 * in chrome.storage.session only (gone when the browser closes), and turns them
 * into a "Copy diagnostics" report the person can paste into a bug report.
 *
 * Nothing is sent anywhere. Events and the report carry only allowlisted enums,
 * numbers and booleans: never email text, subjects, addresses, names, memory,
 * draft or Ask text, thread or message IDs, URLs, tokens or keys. Every value
 * is re-validated here, whoever recorded it.
 */

export const DIAGNOSTIC_COMPONENTS = ['service_worker', 'cloud_state', 'cloud_request', 'compose_check', 'remote_config', 'gmail', 'tracking'] as const;
export type DiagnosticComponent = (typeof DIAGNOSTIC_COMPONENTS)[number];
export const DURATION_BUCKETS = ['lt_100ms', 'lt_500ms', 'lt_2s', 'lt_8s', 'gte_8s'] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export type DiagnosticEvent = {
  /** Minutes since the epoch: coarse on purpose. */
  minute: number;
  component: DiagnosticComponent;
  /** A stable code such as `unsupported_protocol` or `started`; never free text. */
  code: string;
  outcome: 'success' | 'failure';
  duration?: DurationBucket;
  /** The Cloud request ID, which support can match to server logs. Never a mailbox ID. */
  requestId?: string;
};

export const DIAGNOSTICS_KEY = 'pigeonboxDiagnostics';
export const MAX_EVENTS = 40;
/** Successful events are noisy; keep roughly one in this many. Failures are always kept. */
export const SUCCESS_SAMPLE = 10;

const CODE = /^[a-z][a-z0-9_]{0,39}$/;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{4,64}$/;

export function durationBucket(ms: number): DurationBucket {
  if (ms < 100) return 'lt_100ms';
  if (ms < 500) return 'lt_500ms';
  if (ms < 2_000) return 'lt_2s';
  if (ms < 8_000) return 'lt_8s';
  return 'gte_8s';
}

/** Rebuild an event from untrusted input, keeping only allowlisted values; null when unusable. */
export function sanitizeDiagnostic(input: unknown, now = Date.now()): DiagnosticEvent | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  if (!(DIAGNOSTIC_COMPONENTS as readonly unknown[]).includes(raw.component)) return null;
  if (typeof raw.code !== 'string' || !CODE.test(raw.code)) return null;
  if (raw.outcome !== 'success' && raw.outcome !== 'failure') return null;
  return {
    minute: Math.floor(now / 60_000),
    component: raw.component as DiagnosticComponent,
    code: raw.code,
    outcome: raw.outcome,
    ...((DURATION_BUCKETS as readonly unknown[]).includes(raw.duration) ? { duration: raw.duration as DurationBucket } : {}),
    ...(typeof raw.requestId === 'string' && REQUEST_ID.test(raw.requestId) ? { requestId: raw.requestId } : {}),
  };
}

type SessionArea = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };

export class DiagnosticsLog {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly area: SessionArea, private readonly random: () => number = Math.random, private readonly now: () => number = Date.now) {}

  record(input: Partial<DiagnosticEvent> & { component: DiagnosticComponent; code: string; outcome: 'success' | 'failure' }): Promise<void> {
    const event = sanitizeDiagnostic(input, this.now());
    if (!event) return Promise.resolve();
    if (event.outcome === 'success' && event.component !== 'service_worker' && this.random() * SUCCESS_SAMPLE >= 1) return Promise.resolve();
    const write = this.writes.then(async () => {
      const stored = (await this.area.get(DIAGNOSTICS_KEY))[DIAGNOSTICS_KEY];
      const events = Array.isArray(stored) ? (stored as unknown[]) : [];
      await this.area.set({ [DIAGNOSTICS_KEY]: [...events, event].slice(-MAX_EVENTS) });
    });
    this.writes = write.catch(() => undefined);
    return write.catch(() => undefined);
  }

  async events(): Promise<DiagnosticEvent[]> {
    const stored = (await this.area.get(DIAGNOSTICS_KEY).catch((): Record<string, unknown> => ({})))[DIAGNOSTICS_KEY];
    const now = this.now();
    // Re-validated on the way out too, in case storage was written by something else.
    return (Array.isArray(stored) ? stored : [])
      .map((item) => {
        const event = sanitizeDiagnostic(item, now);
        const minute = (item as { minute?: unknown })?.minute;
        return event && typeof minute === 'number' && Number.isInteger(minute) ? { ...event, minute } : null;
      })
      .filter((event): event is DiagnosticEvent => Boolean(event))
      .slice(-MAX_EVENTS);
  }
}

/** Everything the report may say. Each field is an enum, a number, a boolean or a version. */
export type DiagnosticsSnapshot = {
  version: string;
  build: 'release' | 'source';
  chromeMajor: number | null;
  mode: 'local' | 'cloud';
  cloud: { status: string; signedIn: boolean; update: 'none' | 'recommended' | 'required'; minimumVersion: string | null; notice: string | null; lastOkAgeMinutes: number | null };
  protocol: number;
  remoteConfig: { source: string; revision: string; ageMinutes: number | null; lastError: string | null };
  composeChecks: { remotelyDisabled: string[]; preference: 'on' | 'off' | 'unknown' };
  tracking: { enabled: boolean };
  gmail: { integration: string | null; inboxSdk: string | null; domFallback: string | null; knownAccounts: number };
  worker: { startsThisSession: number; uptimeMinutes: number };
  events: DiagnosticEvent[];
};

const TOKEN = /^[a-z][a-z0-9_ -]{0,39}$/i;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const safe = (value: unknown): string | null => (typeof value === 'string' && TOKEN.test(value) && !value.includes('@') ? value : null);

export function chromeMajor(userAgent: string): number | null {
  const match = /Chrome\/(\d{2,4})\./.exec(userAgent);
  return match ? Number(match[1]) : null;
}

/** Plain text, one fact per line, safe to paste into a public issue. */
export function formatDiagnostics(snapshot: DiagnosticsSnapshot, now = Date.now()): string {
  const s = snapshot;
  const minutes = (value: number | null) => (value === null ? 'never' : value < 1 ? 'under 1 min' : `${value} min`);
  const nowMinute = Math.floor(now / 60_000);
  const lines = [
    'PigeonBox diagnostics (no email content, addresses or IDs)',
    `version: ${VERSION.test(s.version) ? s.version : 'source'} (${s.build} build)`,
    `chrome: ${s.chromeMajor ?? 'unknown'}`,
    `mode: ${s.mode}`,
    `cloud: ${safe(s.cloud.status) ?? 'unknown'}, ${s.cloud.signedIn ? 'signed in' : 'signed out'}, last OK ${minutes(s.cloud.lastOkAgeMinutes)} ago`,
    `compatibility: protocol ${s.protocol}, update ${s.cloud.update}${s.cloud.minimumVersion && VERSION.test(s.cloud.minimumVersion) ? ` (minimum ${s.cloud.minimumVersion})` : ''}${safe(s.cloud.notice) ? `, notice ${s.cloud.notice}` : ''}`,
    `remote config: ${safe(s.remoteConfig.source) ?? 'unknown'}, revision ${/^[A-Za-z0-9._:-]{1,64}$/.test(s.remoteConfig.revision) ? s.remoteConfig.revision : 'invalid'}, age ${minutes(s.remoteConfig.ageMinutes)}${safe(s.remoteConfig.lastError) ? `, last error ${s.remoteConfig.lastError}` : ''}`,
    `compose checks: preference ${s.composeChecks.preference}${s.composeChecks.remotelyDisabled.length ? `, remotely off: ${s.composeChecks.remotelyDisabled.map(safe).filter(Boolean).join(' ')}` : ''}`,
    `tracking: ${s.tracking.enabled ? 'on' : 'off'}`,
    `gmail: integration ${safe(s.gmail.integration) ?? 'unknown'}, InboxSDK ${safe(s.gmail.inboxSdk) ?? 'unknown'}, DOM ${safe(s.gmail.domFallback) ?? 'unknown'}, accounts seen ${s.gmail.knownAccounts}`,
    `worker: ${s.worker.startsThisSession} start(s) this browser session, up ${minutes(s.worker.uptimeMinutes)}`,
  ];
  const failures = s.events.filter((event) => event.outcome === 'failure');
  const last = failures.at(-1);
  lines.push(`last error: ${last ? `${last.component} ${last.code} ${minutes(nowMinute - last.minute)} ago` : 'none'}`);
  if (s.events.length) {
    lines.push('recent events:');
    for (const event of s.events.slice(-15)) {
      lines.push(`  -${Math.max(0, nowMinute - event.minute)}m ${event.component} ${event.code} ${event.outcome}${event.duration ? ` ${event.duration}` : ''}${event.requestId ? ` ${event.requestId}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** The worker's log; null outside an extension (tests, previews). */
export const diagnostics: DiagnosticsLog | null =
  typeof chrome !== 'undefined' && chrome.storage?.session ? new DiagnosticsLog(chrome.storage.session) : null;
