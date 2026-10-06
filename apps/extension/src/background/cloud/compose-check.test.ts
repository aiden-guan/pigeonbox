import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';
import type { CloudState } from '@pigeonbox/core';
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { CloudApiError } from '@pigeonbox/cloud-client';
import { handleCloudRequest } from './handlers';
import { MAX_CHECKS_PER_MINUTE, PREFERENCE_TTL_MS, forgetComposeCheckPreference, handleComposeCheck, parseComposeCheck, resetComposeCheckForTests } from './compose-check';

const id = 'a'.repeat(32);
const gmail = { id, origin: 'https://mail.google.com', tab: { id: 10 } };
const ready: CloudState = { status: 'ready', email: 'owner@fixture.test', plan: 'cloud', capabilities: ['cloud_mail_sync'] };
const check = { claim: "I'm free tomorrow at 3", subject: 'Coffee', recipientEmails: ['alex@fixture.test'], threadId: 'thread-f:1780000000000000001', mailbox: 'owner@fixture.test', hint: 'availability' };
const notice = {
  status: 'notice',
  kind: 'calendar_conflict',
  severity: 'warning',
  message: 'You have Math 52 from 2–4 PM tomorrow.',
  confidence: 0.98,
  suggestedText: "I'm free tomorrow at 4:30.",
  sources: [
    { id: 'event:1', kind: 'calendar_event', title: 'Math 52', url: 'https://calendar.google.com/calendar/event?eid=abc', accountId: '00000000-0000-4000-8000-000000000001' },
    { id: 'thread:1', kind: 'thread', title: 'Syllabus', gmailThreadId: '18c2f0a1b2c3d4e5' },
    { id: 'web:1', kind: 'web', title: 'Elsewhere', url: 'javascript:alert(1)' },
    { id: 'web:2', kind: 'web', title: 'Phish', url: 'https://calendar.google.com.evil.test/x' },
  ],
};

function cloud(enabled = true, answer: unknown = notice) {
  const call = vi.fn(async (route: string) => {
    if (route === 'preferences') return { preferences: { memory: { realtimeComposeChecks: enabled } } };
    throw new Error(`unexpected ${route}`);
  });
  const composeCheck = vi.fn(async () => answer);
  const client = vi.fn(async () => ({ call, composeCheck }) as unknown as PigeonBoxCloudClient);
  return { call, composeCheck, client };
}

beforeEach(() => {
  resetComposeCheckForTests();
  vi.stubGlobal('chrome', { runtime: { id } });
});
afterEach(() => vi.unstubAllGlobals());

describe('Real-time Pidgy checks in the worker', () => {
  it('never contacts Cloud in Local mode or without a ready Cloud session', async () => {
    const api = cloud();
    for (const [state, runMode] of [
      [ready, 'local'],
      [{ ...ready, status: 'signed_out' }, 'cloud'],
      [{ ...ready, capabilities: [] }, 'cloud'],
    ] as Array<[CloudState, string]>)
      expect(await handleComposeCheck(check, { state, runMode, client: api.client })).toEqual({ ok: true, status: 'disabled' });
    expect(api.client).not.toHaveBeenCalled();
  });

  it('reads the opt-in before sending, and sends nothing while it is off', async () => {
    const api = cloud(false);
    expect(await handleComposeCheck(check, { state: ready, runMode: 'cloud', client: api.client })).toEqual({ ok: true, status: 'disabled' });
    expect(api.call).toHaveBeenCalledWith('preferences', undefined, expect.anything());
    expect(api.composeCheck).not.toHaveBeenCalled();
  });

  it('caches the preference briefly, forwards only the bounded contract fields, and forgets on settings changes', async () => {
    const api = cloud(true);
    let now = 1_000_000;
    const deps = { state: ready, runMode: 'cloud', client: api.client, now: () => now };
    const reply = await handleComposeCheck({ ...check, body: 'the whole draft', accessToken: 'x' }, deps);
    expect(reply).toMatchObject({ status: 'notice', notice: { message: 'You have Math 52 from 2–4 PM tomorrow.', suggestedText: "I'm free tomorrow at 4:30." } });
    expect(api.composeCheck).toHaveBeenCalledWith(check, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    await handleComposeCheck(check, deps);
    expect(api.call).toHaveBeenCalledTimes(1);
    now += PREFERENCE_TTL_MS + 1;
    await handleComposeCheck(check, deps);
    expect(api.call).toHaveBeenCalledTimes(2);
    forgetComposeCheckPreference();
    await handleComposeCheck(check, deps);
    expect(api.call).toHaveBeenCalledTimes(3);
  });

  it('passes only Google Calendar links and Gmail thread ids to the page, never credentials or internal ids', async () => {
    const reply = await handleComposeCheck(check, { state: ready, runMode: 'cloud', client: cloud().client });
    if (reply.status !== 'notice') throw new Error('expected a notice');
    expect(reply.notice.sources).toEqual([
      { kind: 'calendar_event', title: 'Math 52', url: 'https://calendar.google.com/calendar/event?eid=abc' },
      { kind: 'thread', title: 'Syllabus', gmailThreadId: '18c2f0a1b2c3d4e5' },
      { kind: 'web', title: 'Elsewhere' },
      { kind: 'web', title: 'Phish' },
    ]);
    expect(JSON.stringify(reply)).not.toMatch(/token|accountId|event:1|confidence/i);
  });

  it('drops malformed or oversized requests without a network call', async () => {
    const api = cloud();
    for (const bad of [null, 'text', { ...check, claim: 'x'.repeat(701) }, { ...check, recipientEmails: ['nope'] }, { ...check, hint: 'everything' }])
      expect(await handleComposeCheck(bad, { state: ready, runMode: 'cloud', client: api.client })).toEqual({ ok: true, status: 'none' });
    expect(api.composeCheck).not.toHaveBeenCalled();
    expect(parseComposeCheck({ ...check, threadId: '<script>' })).not.toHaveProperty('threadId');
  });

  it('fails open: expired session, timeout or a disabled answer are quiet', async () => {
    const failing = cloud(true);
    failing.composeCheck.mockRejectedValueOnce(new CloudApiError({ code: 'signed_out', message: 'Sign in again.' }));
    expect(await handleComposeCheck(check, { state: ready, runMode: 'cloud', client: failing.client })).toEqual({ ok: true, status: 'none' });
    const off = cloud(true, { status: 'disabled' });
    expect(await handleComposeCheck(check, { state: ready, runMode: 'cloud', client: off.client })).toEqual({ ok: true, status: 'disabled' });
    // The server said off: the next check is not sent until the preference is read again.
    await handleComposeCheck(check, { state: ready, runMode: 'cloud', client: off.client });
    expect(off.composeCheck).toHaveBeenCalledTimes(1);
  });

  it('caps how many clauses one worker forwards per minute', async () => {
    const api = cloud(true, { status: 'none' });
    for (let i = 0; i < MAX_CHECKS_PER_MINUTE + 5; i += 1) await handleComposeCheck(check, { state: ready, runMode: 'cloud', client: api.client, now: () => 5_000 });
    expect(api.composeCheck).toHaveBeenCalledTimes(MAX_CHECKS_PER_MINUTE);
  });

  it('routes through the Cloud handler: Gmail may ask, other senders are refused before any client exists', async () => {
    const api = cloud(true, { status: 'none' });
    const deps = { settings: () => ({ ...DEFAULT_SETTINGS, runMode: 'cloud' as const }), readState: async () => ready, client: api.client, webUrl: () => null };
    expect(await handleCloudRequest({ type: 'CLOUD_COMPOSE_CHECK', check }, gmail, deps)).toEqual({ ok: true, status: 'none' });
    for (const sender of [{ ...gmail, id: 'b'.repeat(32) }, { ...gmail, origin: 'https://evil.test' }])
      expect(await handleCloudRequest({ type: 'CLOUD_COMPOSE_CHECK', check }, sender, { ...deps, client: vi.fn() })).toMatchObject({ ok: false, code: 'forbidden' });
    // Gmail still cannot make arbitrary Cloud calls.
    expect(await handleCloudRequest({ type: 'CLOUD_CALL', route: 'composeCheck', body: check }, gmail, deps)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(api.composeCheck).toHaveBeenCalledTimes(1);
  });
});
