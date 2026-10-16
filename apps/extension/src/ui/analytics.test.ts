import { afterEach, expect, it, vi } from 'vitest';
import {
  analyticsEnabled,
  analyticsPayload,
  cloudEventsProvider,
  configureAnalytics,
  noteActiveDay,
  recordProductEvent,
  setAnalyticsEnabled,
  trackProductEvent,
} from './analytics';
afterEach(() => {
  configureAnalytics();
  vi.unstubAllGlobals();
});
it('drops private fields, unknown events, and untrusted enum values before any provider sees them', () => {
  const canary = 'secret@inbox.test body prompt token';
  expect(analyticsPayload(canary)).toBeNull();
  const payload = analyticsPayload(
    'ask_pigeon_used',
    {
      query: canary,
      subject: canary,
      url: 'https://site/?token=secret',
      surface: canary,
      mode: 'cloud',
      outcome: 'success',
    },
    canary,
  );
  expect(payload).toEqual({ event: 'ask_pigeon_used', metadata: { mode: 'cloud', outcome: 'success' }, version: '' });
});
it('has no default provider and isolates provider failures', async () => {
  expect(() => trackProductEvent('prepared_draft_used')).not.toThrow();
  const provider = vi.fn(() => {
    throw new Error('unavailable');
  });
  configureAnalytics(provider);
  expect(() => trackProductEvent('prepared_draft_used', { surface: 'gmail' })).not.toThrow();
  expect(provider).toHaveBeenCalledTimes(1);
});

it('records only opt-in bounded local counters, serializes updates and deduplicates first-use events', async () => {
  const store: Record<string, unknown> = {
    productAnalyticsEnabled: false,
    productEventCounts: { email: 'private', ask_pigeon_used: 1e9 },
  };
  const set = vi.fn(async (value: object) => Object.assign(store, value));
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.3.1' }) },
    storage: { local: { get: async () => store, set } },
  });
  const send = vi.fn();
  configureAnalytics(send);
  await recordProductEvent('ask_pigeon_used', { query: 'private' });
  expect(set).not.toHaveBeenCalled();
  store.productAnalyticsEnabled = true;
  await Promise.all([
    recordProductEvent('first_briefing_viewed', {}),
    recordProductEvent('first_briefing_viewed', {}),
    recordProductEvent('ask_pigeon_used', { query: 'private', surface: 'gmail' }),
  ]);
  expect(store.productEventCounts).toEqual({ ask_pigeon_used: 1e6, first_briefing_viewed: 1 });
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(send.mock.calls)).not.toContain('private');
  await recordProductEvent('private', {});
  expect(send).toHaveBeenCalledTimes(2);
});

it('records where Settings was opened from without accepting other sources', () => {
  expect(analyticsPayload('settings_opened', { surface: 'workspace', mode: 'local', source: 'workspace_header' })).toEqual({
    event: 'settings_opened',
    metadata: { surface: 'workspace', mode: 'local', source: 'workspace_header' },
    version: '',
  });
  expect(analyticsPayload('settings_opened', { source: 'owner@fixture.test', subject: 'Pricing' })?.metadata).toEqual({});
});

it('collects by default and stops only when the person turns it off', async () => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.8.1' }) },
    storage: {
      local: {
        get: async () => store,
        set: async (value: object) => Object.assign(store, value),
        remove: async (keys: string[]) => { for (const key of keys) delete store[key]; },
      },
    },
  });
  expect(analyticsEnabled({})).toBe(true);
  await recordProductEvent('footer_sent', {});
  expect(store.productEventCounts).toEqual({ footer_sent: 1 });
  store.productAnalyticsInstallId = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
  await setAnalyticsEnabled(false);
  expect(store).toEqual({ productAnalyticsEnabled: false });
  await recordProductEvent('footer_sent', {});
  await noteActiveDay(new Date('2026-10-15T10:00:00'));
  expect(store).toEqual({ productAnalyticsEnabled: false });
  await setAnalyticsEnabled(true);
  await noteActiveDay(new Date('2026-10-15T10:00:00'));
  await noteActiveDay(new Date('2026-10-15T23:00:00'));
  expect(store.productEventCounts).toEqual({ extension_active: 1 });
  await noteActiveDay(new Date('2026-10-16T08:00:00'));
  expect(store.productEventCounts).toEqual({ extension_active: 2 });
});

it('network canary: POSTs only event, enum metadata, version and a random install ID to Cloud', async () => {
  const canary = 'dana@client.test Re: Q3 board deck 18c2f0a1b2 thread-f:1789 secret query https://drive.test/doc?token=x';
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.8.1' }) },
    storage: { local: { get: async () => store, set: async (value: object) => Object.assign(store, value), remove: async () => undefined } },
  });
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 202 }));
  const provider = cloudEventsProvider({ baseUrl: () => 'https://api.pigeonbox.test', fetch: fetchImpl as unknown as typeof fetch });
  configureAnalytics(provider);
  await recordProductEvent('footer_removed', {
    surface: 'gmail',
    mode: 'local',
    subject: canary,
    recipients: [canary],
    threadId: canary,
    messageId: canary,
    query: canary,
    url: canary,
    source: canary,
  });
  await recordProductEvent('first_tracked_email_created', { surface: 'gmail', email: canary });
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe('https://api.pigeonbox.test/v1/events');
  expect(init?.credentials).toBe('omit');
  const bodies = fetchImpl.mock.calls.map(([, call]) => JSON.parse(String(call?.body)));
  const installId = store.productAnalyticsInstallId as string;
  expect(installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(bodies).toEqual([
    { installId, event: 'footer_removed', metadata: { surface: 'gmail', mode: 'local' }, version: '0.8.1' },
    { installId, event: 'first_tracked_email_created', metadata: { surface: 'gmail' }, version: '0.8.1' },
  ]);
  const wire = JSON.stringify(fetchImpl.mock.calls);
  for (const fragment of ['dana', 'client.test', 'board', '18c2f0a1b2', 'thread-f', 'secret', 'drive.test', 'token']) expect(wire).not.toContain(fragment);
  // A provider handed a tampered payload still rebuilds it from the allowlist.
  await provider({ event: 'footer_sent', metadata: { surface: 'gmail', subject: canary } as never, version: canary });
  expect(JSON.parse(String(fetchImpl.mock.calls[2]![1]?.body))).toEqual({ installId, event: 'footer_sent', metadata: { surface: 'gmail' }, version: '' });
  // No Cloud URL configured: nothing leaves the browser.
  const offline = vi.fn();
  await cloudEventsProvider({ baseUrl: () => null, fetch: offline as unknown as typeof fetch })({ event: 'footer_sent', metadata: {}, version: '' });
  expect(offline).not.toHaveBeenCalled();
});
