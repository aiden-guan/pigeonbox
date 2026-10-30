import { sanitizeLogFields, type LogFields } from './http.js';

/**
 * Content-free error tracking (Sentry envelope API, no SDK). Disabled unless SENTRY_DSN is set.
 *
 * Events are built only from the sanitized logger output: the fixed log message, allowlisted
 * field values that already passed `sanitizeLogFields`, and for exceptions the error class name
 * and stack frame locations. Exception messages, URLs, query strings, headers, bodies, cookies,
 * user/account/job IDs, breadcrumbs and IP addresses are never sent.
 */
const TAG_KEYS = ['route', 'code', 'jobKind', 'operation', 'provider', 'model', 'status', 'attempt'] as const;
const SAFE_NAME = /^[A-Za-z0-9_$.]{1,80}$/;
const SAFE_FILE = /^[A-Za-z0-9_./-]{1,160}$/;
const MAX_FRAMES = 30;
const MAX_PENDING = 10;
const DEDUPE_MS = 60_000;

type Dsn = { endpoint: string; publicKey: string };
type Frame = { function?: string; filename: string; lineno: number; colno?: number; in_app: true };

/** `https://<key>@<host>[/<path>]/<project>` → envelope endpoint. Anything else disables reporting. */
export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const parts = url.pathname.split('/').filter(Boolean);
    const project = parts.pop();
    if (url.protocol !== 'https:' || !/^[a-f0-9]{16,64}$/.test(url.username) || url.password || url.search || url.hash || !project || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? `/${parts.join('/')}` : '';
    return { endpoint: `https://${url.host}${prefix}/api/${project}/envelope/`, publicKey: url.username };
  } catch {
    return null;
  }
}

/** Stack frame locations only. The first stack line (`Name: message`) and any unparseable line are dropped. */
export function stackFrames(error: unknown): Frame[] {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  const frames: Frame[] = [];
  for (const line of stack.split('\n')) {
    const match = /^\s*at (?:(?:async )?([^\s(]+) \()?([^\s()]+?):(\d+)(?::(\d+))?\)?\s*$/.exec(line);
    if (!match) continue;
    const [, fn, rawFile, lineno, colno] = match;
    const file = rawFile!.replace(/^[a-z]+:\/\/[^/]*\//i, '').replace(/[?#].*$/, '');
    if (!SAFE_FILE.test(file)) continue;
    frames.push({ ...(fn && SAFE_NAME.test(fn) ? { function: fn } : {}), filename: file, lineno: Number(lineno), ...(colno ? { colno: Number(colno) } : {}), in_app: true });
    if (frames.length >= MAX_FRAMES) break;
  }
  // Sentry expects the oldest frame first.
  return frames.reverse();
}

function errorType(error: unknown): string {
  const name = error instanceof Error ? error.constructor?.name || error.name : typeof error;
  return SAFE_NAME.test(name) ? name : 'Error';
}

export function errorTracker(options: { dsn?: string; environment?: string; release?: string; service: string; fetch?: typeof fetch; now?: () => number }) {
  const dsn = parseDsn(options.dsn);
  const now = options.now ?? Date.now;
  const pending: string[] = [];
  const lastSent = new Map<string, number>();
  const environment = sanitizeLogFields({ code: options.environment ?? 'production' }).code;
  const release = options.release && /^[A-Za-z0-9_.+-]{1,64}$/.test(options.release) ? `pigeonbox-cloud@${options.release}` : undefined;
  return {
    enabled: Boolean(dsn),
    /** Queue one event for an error-level log line. `message` must already be the fixed log message. */
    capture(message: string, fields: LogFields = {}, error?: unknown) {
      if (!dsn || pending.length >= MAX_PENDING) return;
      const safe = sanitizeLogFields(fields);
      const tags: Record<string, string> = { service: options.service };
      for (const key of TAG_KEYS) if (safe[key] !== undefined && safe[key] !== '[redacted]') tags[key] = String(safe[key]).slice(0, 200);
      const fingerprint = [options.service, message, tags.code ?? '', tags.route ?? '', tags.jobKind ?? ''];
      const key = fingerprint.join('|');
      const at = now();
      // One event per fingerprint per minute per isolate keeps a failure storm inside the plan quota.
      if ((lastSent.get(key) ?? -Infinity) > at - DEDUPE_MS) return;
      lastSent.set(key, at);
      if (lastSent.size > 200) lastSent.delete(lastSent.keys().next().value!);
      const eventId = crypto.randomUUID().replace(/-/g, '');
      const frames = error === undefined ? [] : stackFrames(error);
      const event = {
        event_id: eventId,
        timestamp: at / 1000,
        platform: 'javascript',
        level: 'error',
        logger: options.service,
        environment,
        ...(release ? { release } : {}),
        message: { formatted: message },
        tags,
        // requestId correlates with Workers Logs; it is random per request and identifies no one.
        ...(typeof safe.requestId === 'string' && safe.requestId !== '[redacted]' ? { extra: { requestId: safe.requestId } } : {}),
        ...(error === undefined ? {} : { exception: { values: [{ type: errorType(error), value: tags.code ?? message, ...(frames.length ? { stacktrace: { frames } } : {}) }] } }),
        fingerprint,
        user: { ip_address: null },
      };
      pending.push(`${JSON.stringify({ event_id: eventId, sent_at: new Date(at).toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`);
    },
    async flush() {
      if (!dsn || !pending.length) return;
      const envelopes = pending.splice(0, MAX_PENDING);
      await Promise.all(envelopes.map(async (body) => {
        try {
          await (options.fetch ?? fetch)(dsn.endpoint, {
            method: 'POST',
            credentials: 'omit',
            redirect: 'error',
            signal: AbortSignal.timeout(2000),
            headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=pigeonbox-cloud/1.0, sentry_key=${dsn.publicKey}` },
            body,
          });
        } catch {
          /* Tracking outages cannot fail requests or jobs. No error text is retained. */
        }
      }));
    },
  };
}
export type ErrorTracker = ReturnType<typeof errorTracker>;
