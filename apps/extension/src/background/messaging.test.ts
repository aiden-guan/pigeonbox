import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hardenExtensionStorage, isExtensionPageSender, senderMaySend } from './messaging';

const ID = 'abcdefghijklmnopabcdefghijklmnop';

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { id: ID } };
});

const settingsPage = { id: ID, url: `chrome-extension://${ID}/settings.html`, tab: { url: `chrome-extension://${ID}/settings.html` } };
const gmail = { id: ID, url: 'https://mail.google.com/mail/u/0/#inbox', origin: 'https://mail.google.com', tab: { url: 'https://mail.google.com/mail/u/0/#inbox' } };

describe('sender trust', () => {
  it('treats the options page as an extension page even though it is in a tab', () => {
    expect(isExtensionPageSender(settingsPage)).toBe(true);
  });

  it('lets Gmail content scripts send only integration messages', () => {
    expect(senderMaySend(gmail, 'REQUEST_SUMMARY')).toBe(true);
    expect(senderMaySend(gmail, 'CREATE_TRACKED_EMAIL')).toBe(true);
    expect(senderMaySend(gmail, 'RESOLVE_SENDER_TRACKING_LINK')).toBe(true);
    expect(senderMaySend(gmail, 'RESOLVE_SENDER_DOCUMENT_LINK')).toBe(true);
    expect(senderMaySend({ id: ID, origin: 'https://evil.example.com' }, 'RESOLVE_SENDER_DOCUMENT_LINK')).toBe(false);
    expect(senderMaySend({ id: ID, origin: 'https://evil.example.com' }, 'RESOLVE_SENDER_TRACKING_LINK')).toBe(false);
    expect(senderMaySend(gmail, 'inboxsdk__injectPageWorld')).toBe(true);
    // Cloud thread state is readable from Gmail; deciding, connecting and calling other routes are not.
    expect(senderMaySend(gmail, 'CLOUD_THREAD_INTEL')).toBe(true);
    // Real-time Pidgy checks: Gmail may ask, the worker decides; arbitrary Cloud calls stay page-only.
    expect(senderMaySend(gmail, 'CLOUD_COMPOSE_CHECK')).toBe(true);
    expect(senderMaySend({ id: 'other', origin: 'https://mail.google.com' }, 'CLOUD_COMPOSE_CHECK')).toBe(false);
    expect(senderMaySend({ id: ID, origin: 'https://evil.example.com' }, 'CLOUD_COMPOSE_CHECK')).toBe(false);
    for (const type of ['SAVE_SETTINGS', 'CLOUD_SIGN_IN', 'SET_RUN_MODE', 'CLEAR_INDEX', 'ENQUEUE_ACTION', 'CHATGPT_LOGIN', 'LOCAL_MODEL_DOWNLOAD', 'GET_PRODUCT_STATE', 'CLOUD_CALL', 'CLOUD_OPEN', 'CLOUD_INTEL_STATE']) {
      expect(senderMaySend(gmail, type)).toBe(false);
    }
  });

  it('allows everything from extension pages', () => {
    expect(senderMaySend(settingsPage, 'SAVE_SETTINGS')).toBe(true);
    expect(senderMaySend(settingsPage, 'CLOUD_SIGN_IN')).toBe(true);
  });

  it('rejects other extensions and other sites', () => {
    expect(senderMaySend({ id: 'other', url: 'https://mail.google.com/' }, 'REQUEST_SUMMARY')).toBe(false);
    expect(senderMaySend({ id: ID, url: 'https://evil.example.com/' }, 'REQUEST_SUMMARY')).toBe(false);
    expect(senderMaySend({ id: ID, url: 'https://mail.google.com.evil.example/' }, 'REQUEST_SUMMARY')).toBe(false);
  });
});

describe('hardenExtensionStorage', () => {
  it('restricts local and session storage to trusted contexts', async () => {
    const local = { setAccessLevel: vi.fn(async () => undefined) };
    const session = { setAccessLevel: vi.fn(async () => undefined) };
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { id: ID }, storage: { local, session } };
    await hardenExtensionStorage();
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });
});
