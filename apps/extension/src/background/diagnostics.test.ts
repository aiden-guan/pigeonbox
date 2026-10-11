import { describe, expect, it } from 'vitest';
import { DIAGNOSTICS_KEY, DiagnosticsLog, MAX_EVENTS, chromeMajor, durationBucket, formatDiagnostics, sanitizeDiagnostic, type DiagnosticsSnapshot } from './diagnostics';

function sessionArea(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return { data, get: async (key: string) => ({ [key]: data[key] }), set: async (items: Record<string, unknown>) => void Object.assign(data, items) };
}

const PRIVATE = ['alex@example.test', 'Quarterly numbers', 'I am free tomorrow at 3', 'thread-f:1780000000000000001', '18c2f0a1b2c3d4e5', 'Bearer eyJhbGciOi', 'sk-proj-abcdefghijklmnopqrstuvwxyz', 'https://mail.google.com/mail/u/0/#inbox/abc'];

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    version: '0.6.0',
    build: 'release',
    chromeMajor: 141,
    mode: 'cloud',
    cloud: { status: 'ready', signedIn: true, update: 'none', minimumVersion: null, notice: null, lastOkAgeMinutes: 3 },
    protocol: 1,
    remoteConfig: { source: 'remote', revision: 'r1', ageMinutes: 10, lastError: null },
    composeChecks: { remotelyDisabled: [], preference: 'on' },
    tracking: { enabled: true },
    gmail: { integration: 'inboxsdk', inboxSdk: 'loaded', domFallback: 'healthy', knownAccounts: 2 },
    worker: { startsThisSession: 3, uptimeMinutes: 12 },
    events: [],
    ...overrides,
  };
}

describe('content-free diagnostics', () => {
  it('keeps only allowlisted fields and values', () => {
    expect(sanitizeDiagnostic({ component: 'compose_check', code: 'unavailable', outcome: 'failure', duration: 'lt_2s', requestId: 'req_abc123', claim: 'I am free', mailbox: 'alex@example.test' }, 120_000))
      .toEqual({ minute: 2, component: 'compose_check', code: 'unavailable', outcome: 'failure', duration: 'lt_2s', requestId: 'req_abc123' });
    for (const bad of [
      { component: 'compose_check', code: 'I am free tomorrow', outcome: 'failure' },
      { component: 'compose_check', code: 'alex@example.test', outcome: 'failure' },
      { component: 'anything', code: 'x', outcome: 'failure' },
      { component: 'gmail', code: 'ok', outcome: 'maybe' },
      null,
      'string',
    ]) expect(sanitizeDiagnostic(bad)).toBeNull();
    expect(sanitizeDiagnostic({ component: 'gmail', code: 'ok', outcome: 'success', requestId: 'thread-f:1780000000000000001', duration: 'forever' })).toEqual({ minute: expect.any(Number), component: 'gmail', code: 'ok', outcome: 'success' });
  });

  it('keeps every failure, samples successes and caps the ring', async () => {
    const area = sessionArea();
    let roll = 0.5;
    const log = new DiagnosticsLog(area, () => roll, () => 60_000);
    await log.record({ component: 'cloud_state', code: 'ok', outcome: 'success' });
    expect(await log.events()).toHaveLength(0);
    roll = 0.05;
    await log.record({ component: 'cloud_state', code: 'ok', outcome: 'success' });
    expect(await log.events()).toHaveLength(1);
    roll = 0.99;
    for (let index = 0; index < MAX_EVENTS + 10; index += 1) await log.record({ component: 'cloud_state', code: 'network', outcome: 'failure' });
    const events = await log.events();
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events.every((event) => event.code === 'network')).toBe(true);
  });

  it('re-validates whatever storage holds before reporting it', async () => {
    const area = sessionArea({ [DIAGNOSTICS_KEY]: [{ minute: 1, component: 'gmail', code: 'alex@example.test', outcome: 'failure' }, { minute: 1, component: 'gmail', code: 'inboxsdk_failed', outcome: 'failure' }] });
    expect(await new DiagnosticsLog(area).events()).toEqual([{ minute: 1, component: 'gmail', code: 'inboxsdk_failed', outcome: 'failure' }]);
  });

  it('produces a readable report with no private content, even when fed some', () => {
    const text = formatDiagnostics(snapshot({
      cloud: { status: 'alex@example.test', signedIn: true, update: 'required', minimumVersion: '0.6.1', notice: 'maintenance', lastOkAgeMinutes: null },
      gmail: { integration: 'https://mail.google.com/mail/u/0/#inbox/abc', inboxSdk: 'failed', domFallback: 'selector issue', knownAccounts: 2 },
      remoteConfig: { source: 'last_known_good', revision: 'Quarterly numbers', ageMinutes: 0, lastError: 'unavailable' },
      events: [{ minute: Math.floor(Date.now() / 60_000), component: 'compose_check', code: 'unavailable', outcome: 'failure', duration: 'gte_8s', requestId: 'req_abc123' }],
    }));
    for (const value of PRIVATE) expect(text).not.toContain(value);
    expect(text).not.toContain('@');
    expect(text).toContain('version: 0.6.0 (release build)');
    expect(text).toContain('update required (minimum 0.6.1), notice maintenance');
    expect(text).toContain('InboxSDK failed');
    expect(text).toContain('last error: compose_check unavailable');
    expect(text).toContain('req_abc123');
  });

  it('buckets durations and reads only the Chrome major version', () => {
    expect([50, 200, 1_000, 5_000, 9_000].map(durationBucket)).toEqual(['lt_100ms', 'lt_500ms', 'lt_2s', 'lt_8s', 'gte_8s']);
    expect(chromeMajor('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36')).toBe(141);
    expect(chromeMajor('Firefox')).toBeNull();
  });
});
