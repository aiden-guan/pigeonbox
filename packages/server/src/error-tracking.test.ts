import { expect, it, vi } from 'vitest';
import { errorTracker, parseDsn, stackFrames } from './error-tracking.js';
import { observedLogger, operationalReporter } from './observability.js';

const DSN = 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/4500000000000001';
const sender = () => vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));

it('never serializes exception messages, URLs, IDs, headers, or mail into error events', async () => {
  const send = sender();
  const errors = errorTracker({ dsn: DSN, environment: 'production', release: '0.1.0', service: 'api', fetch: send as typeof fetch });
  const log = observedLogger(vi.fn(), operationalReporter(), errors);
  const privateText = 'secret@inbox.test body prompt oauth document-token';
  const error = new TypeError(`failed for ${privateText} https://x.test/d/document-token?code=oauth`);
  log('error', 'unhandled error', { requestId: 'req_abc123', route: '/d/document-token?code=oauth', userId: 'user-secret', accountId: 'acct-secret', jobId: 'job-secret', code: 'unhandled_error', detail: privateText }, error);
  log('error', privateText, { code: privateText });
  await errors.flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]![0]).toBe('https://o1.ingest.us.sentry.io/api/4500000000000001/envelope/');
  const headers = send.mock.calls[0]![1]!.headers as Record<string, string>;
  expect(headers['X-Sentry-Auth']).toContain('sentry_key=0123456789abcdef0123456789abcdef');
  const bodies = send.mock.calls.map((call) => String(call[1]!.body));
  for (const body of bodies) for (const secret of ['secret', 'oauth', 'document-token', 'inbox.test', 'prompt', 'failed for', 'x.test']) expect(body).not.toContain(secret);
  const event = JSON.parse(bodies[0]!.split('\n')[2]!);
  expect(event).toMatchObject({ level: 'error', environment: 'production', release: 'pigeonbox-cloud@0.1.0', message: { formatted: 'unhandled error' }, tags: { service: 'api', code: 'unhandled_error' }, extra: { requestId: 'req_abc123' }, user: { ip_address: null } });
  expect(event.tags.route).toBeUndefined();
  expect(event.exception.values[0].type).toBe('TypeError');
  expect(event.exception.values[0].value).toBe('unhandled_error');
  expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  expect(JSON.parse(bodies[1]!.split('\n')[2]!).message.formatted).toBe('[redacted message]');
});

it('reports only error-level lines, once per fingerprint per minute', async () => {
  const send = sender();
  let clock = 0;
  const errors = errorTracker({ dsn: DSN, service: 'api', fetch: send as typeof fetch, now: () => clock });
  const log = observedLogger(vi.fn(), operationalReporter(), errors);
  log('warn', 'job will retry', { code: 'google_timeout' });
  log('info', 'request', { status: 200 });
  for (let i = 0; i < 5; i += 1) log('error', 'job dead-lettered', { jobKind: 'gmail.sync', code: 'google_timeout' });
  log('error', 'job dead-lettered', { jobKind: 'gmail.sync', code: 'provider_error' });
  await errors.flush();
  expect(send).toHaveBeenCalledTimes(2);
  clock = 61_000;
  log('error', 'job dead-lettered', { jobKind: 'gmail.sync', code: 'google_timeout' });
  await errors.flush();
  expect(send).toHaveBeenCalledTimes(3);
});

it('is inert without a valid DSN and absorbs outages', async () => {
  const send = vi.fn(async () => { throw new Error('private upstream detail'); });
  for (const dsn of [undefined, '', 'http://0123456789abcdef0123456789abcdef@sentry.test/1', 'https://sentry.test/1', 'https://0123456789abcdef0123456789abcdef@sentry.test/1?x=1', 'https://0123456789abcdef0123456789abcdef:pw@sentry.test/1', 'not a url']) {
    const errors = errorTracker({ dsn, service: 'api', fetch: send });
    expect(errors.enabled).toBe(false);
    errors.capture('unhandled error', {}, new Error('x'));
    await errors.flush();
  }
  expect(send).not.toHaveBeenCalled();
  const errors = errorTracker({ dsn: DSN, service: 'tracker', fetch: send });
  errors.capture('unhandled error', { code: 'unhandled_error' });
  await expect(errors.flush()).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});

it('parses self-hosted DSNs with a path prefix', () => {
  expect(parseDsn('https://0123456789abcdef0123456789abcdef@sentry.example.com/sentry/7')).toEqual({ endpoint: 'https://sentry.example.com/sentry/api/7/envelope/', publicKey: '0123456789abcdef0123456789abcdef' });
});

it('keeps only stack frame locations', () => {
  const error = new Error('mail from a@b.test');
  error.stack = ['Error: mail from a@b.test', '    at handler (index.js:10:5)', '    at async Promise.all (index 0)', '    at https://pigeonbox.test/worker.js?token=abc:3:9', '    at weird (a@b.test:1:1)'].join('\n');
  expect(stackFrames(error)).toEqual([
    { filename: 'worker.js', lineno: 3, colno: 9, in_app: true },
    { function: 'handler', filename: 'index.js', lineno: 10, colno: 5, in_app: true },
  ]);
  expect(stackFrames('not an error')).toEqual([]);
});
