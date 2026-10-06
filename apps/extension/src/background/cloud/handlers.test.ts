import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';
import type { CloudState } from '@pigeonbox/core';
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { handleCloudRequest } from './handlers';
const id = 'a'.repeat(32);
const page = { id, origin: `chrome-extension://${id}` };
const gmail = { id, origin: 'https://mail.google.com', tab: { id: 10 } };
const state: CloudState = {
  status: 'ready',
  email: 'fixture@test.test',
  plan: 'cloud',
  capabilities: ['cloud_documents', 'cloud_mail_sync'],
};
const uploadDocument = vi.fn(async () => ({}));
const call = vi.fn(async () => ({}));
const deps = {
  settings: () => ({ ...DEFAULT_SETTINGS, runMode: 'cloud' as const, cloudApiUrl: 'https://cloud.test' }),
  readState: async () => state,
  client: async () => ({ uploadDocument, call }) as unknown as PigeonBoxCloudClient,
  webUrl: (section = 'overview') => `https://cloud.test/app#${section}`,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', {
    runtime: { id },
    tabs: {
      create: vi.fn(),
      get: vi.fn(async () => ({ url: 'https://mail.google.com/mail/u/0/' })),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    storage: {
      session: { get: vi.fn(async () => ({ documentComposeTarget: { tabId: 10, composeId: 'selected-compose' } })) },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
it('rejects content, foreign-extension and hostile-origin privileged calls before touching a client', async () => {
  const client = vi.fn(deps.client);
  for (const sender of [gmail, { ...page, id: 'b'.repeat(32) }, { ...page, origin: 'https://evil.test' }])
    for (const type of ['CLOUD_CALL', 'CLOUD_DOCUMENT_UPLOAD', 'INSERT_DOCUMENT_LINK', 'CLOUD_OPEN'])
      expect(await handleCloudRequest({ type, route: 'approvalDecide' }, sender, { ...deps, client })).toMatchObject({
        ok: false,
        code: 'forbidden',
      });
  expect(client).not.toHaveBeenCalled();
});
it('never loads Cloud thread context in Local mode', async () => {
  const client = vi.fn(deps.client);
  expect(
    await handleCloudRequest({ type: 'CLOUD_THREAD_INTEL', threadIds: ['abc'] }, gmail, {
      ...deps,
      client,
      settings: () => ({ ...DEFAULT_SETTINGS, runMode: 'local' }),
    }),
  ).toMatchObject({ available: false, threads: {} });
  expect(client).not.toHaveBeenCalled();
});
it('requires document capability and rejects malformed or oversized upload payloads', async () => {
  expect(
    await handleCloudRequest({ type: 'CLOUD_DOCUMENT_UPLOAD', bytes: '!not-base64', id: 'id' }, page, deps),
  ).toMatchObject({ ok: false });
  expect(
    await handleCloudRequest({ type: 'CLOUD_DOCUMENT_UPLOAD', bytes: 'JVBERi0=', id: 'id' }, page, {
      ...deps,
      readState: async () => ({ ...state, capabilities: [] }),
    }),
  ).toMatchObject({ ok: false });
  expect(uploadDocument).not.toHaveBeenCalled();
});
it('binds document insertion to the issuing Cloud and chosen Gmail composer, never sending', async () => {
  for (const url of [
    'https://evil.test/d/' + 'a'.repeat(20),
    'https://cloud.test/d/' + 'a'.repeat(20) + '?token=secret',
    'https://u:p@cloud.test/d/' + 'a'.repeat(20),
  ])
    expect(await handleCloudRequest({ type: 'INSERT_DOCUMENT_LINK', url }, page, deps)).toMatchObject({ ok: false });
  expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  const url = 'https://cloud.test/d/' + 'a'.repeat(20);
  expect(await handleCloudRequest({ type: 'INSERT_DOCUMENT_LINK', url, title: '<img>' }, page, deps)).toEqual({
    ok: true,
  });
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(10, {
    type: 'PIGEONBOX_INSERT_DOCUMENT',
    composeId: 'selected-compose',
    url,
    title: '<img>',
  });
  expect(call).not.toHaveBeenCalled();
});
it('allowlists deep-link sections and refuses arbitrary caller URLs', async () => {
  await handleCloudRequest({ type: 'CLOUD_OPEN', section: 'documents' }, page, deps);
  await handleCloudRequest({ type: 'CLOUD_OPEN', section: 'https://evil.test?token=secret' }, page, deps);
  expect(chrome.tabs.create).toHaveBeenNthCalledWith(1, { url: 'https://cloud.test/app#documents' });
  expect(chrome.tabs.create).toHaveBeenNthCalledWith(2, { url: 'https://cloud.test/app#overview' });
});
it('opens the public waitlist when Cloud is unavailable without loading a client', async () => {
  const client = vi.fn(deps.client);
  const settings = { ...DEFAULT_SETTINGS, runMode: 'local' as const };
  expect(await handleCloudRequest({ type: 'CLOUD_OPEN', section: 'documents' }, page, {
    ...deps, client, settings: () => settings, webUrl: () => null,
  })).toEqual({ ok: true });
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://usepigeonbox.com/waitlist?source=extension' });
  expect(client).not.toHaveBeenCalled();
  expect(settings.runMode).toBe('local');
});

it('reports only whether Calendar is connected for the open thread, without reading free/busy', async () => {
  const threadId = '18c2f0a1b2c3d4e5';
  const accountId = '00000000-0000-4000-8000-000000000001';
  const calls: string[] = [];
  const make = (features: string[]) =>
    async () =>
      ({
        call: vi.fn(async (route: string) => {
          calls.push(route);
          if (route === 'threadsIntel') return { threads: { [threadId]: { threadId, accountId, participants: [] } } };
          if (route === 'connections') return { accounts: [{ id: accountId, email: 'fixture@test.test', features }] };
          throw new Error(`unexpected ${route}`);
        }),
      }) as unknown as PigeonBoxCloudClient;
  const calendarState: CloudState = { ...state, capabilities: ['cloud_mail_sync', 'cloud_calendar'] };
  const base = { ...deps, readState: async () => calendarState };
  expect(await handleCloudRequest({ type: 'CLOUD_THREAD_CONTEXT', kind: 'calendar_status', threadId }, gmail, { ...base, client: make(['mail_read']) })).toEqual({ ok: true, data: { connected: false } });
  expect(await handleCloudRequest({ type: 'CLOUD_THREAD_CONTEXT', kind: 'calendar_status', threadId }, gmail, { ...base, client: make(['mail_read', 'calendar_read']) })).toEqual({ ok: true, data: { connected: true } });
  expect(await handleCloudRequest({ type: 'CLOUD_THREAD_CONTEXT', kind: 'calendar_status', threadId: 'other-thread' }, gmail, { ...base, client: make(['mail_read', 'calendar_read']) })).toMatchObject({ ok: false });
  expect(calls).not.toContain('calendarAvailability');
  expect(calls).not.toContain('preferences');
});
