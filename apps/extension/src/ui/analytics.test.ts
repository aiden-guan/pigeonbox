import { afterEach, expect, it, vi } from 'vitest';
import { analyticsPayload, configureAnalytics, trackProductEvent, recordProductEvent } from './analytics';
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
