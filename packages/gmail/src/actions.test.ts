import { describe, expect, it } from 'vitest';
import { selectGmailTab } from './tab-selection.js';
import { WorkerTabController } from './WorkerTabController.js';
import {
  verifyArchive,
  verifyDraftInserted,
  verifyNavigation,
  verifyOpenThread,
} from './verify.js';

describe('action verification', () => {
  it('uses the active Gmail tab in the foreground and only the worker tab in the background', () => {
    const gmailTabs = [
      { id: 1, url: 'https://mail.google.com/mail/u/0/#inbox', active: false },
      { id: 2, url: 'https://mail.google.com/mail/u/0/#inbox/abc', active: true },
    ];
    expect(selectGmailTab({
      mode: 'foreground',
      activeTab: gmailTabs[1],
      workerTabId: 9,
      gmailTabs,
    }).tabId).toBe(2);
    expect(selectGmailTab({
      mode: 'background',
      activeTab: gmailTabs[1],
      workerTabId: 9,
      gmailTabs,
    }).tabId).toBe(9);
    expect(selectGmailTab({
      mode: 'foreground',
      activeTab: { id: 3, url: 'https://example.com', active: true },
      workerTabId: 9,
      gmailTabs,
    }).tabId).toBeNull();
  });

  it('creates a dedicated inactive worker tab instead of reusing an open Gmail tab', async () => {
    let queried = false;
    const created: Array<{ active?: boolean; pinned?: boolean }> = [];
    const tabs = new WorkerTabController({
      query: async () => {
        queried = true;
        return [{ id: 1, url: 'https://mail.google.com/mail/u/0/#inbox' }];
      },
      create: async (props) => {
        created.push(props);
        return { id: 44 };
      },
      update: async () => undefined,
      get: async () => undefined,
    });
    expect(await tabs.ensureTab()).toBe(44);
    expect(queried).toBe(false);
    expect(created[0]).toMatchObject({ active: false, pinned: true });
  });

  it('never opens a tab for automatic work, but reuses one that is already open', async () => {
    let created = 0;
    const open = new Map<number, { id: number; url: string }>();
    const tabs = new WorkerTabController({
      query: async () => [],
      create: async () => {
        created += 1;
        return { id: 44 };
      },
      update: async () => undefined,
      get: async (id) => open.get(id),
    });
    await expect(tabs.runExclusive(async (id) => id, { create: false })).rejects.toThrow(/No Gmail worker tab/);
    expect(created).toBe(0);

    open.set(44, { id: 44, url: 'https://mail.google.com/mail/u/0/#inbox' });
    tabs.adopt(44);
    expect(await tabs.runExclusive(async (id) => id, { create: false })).toBe(44);
    expect(created).toBe(0);
  });

  it('does not treat an open thread missing from the list as archived', () => {
    expect(verifyArchive({
      toastText: null,
      beforeOpenThreadId: 't1',
      afterOpenThreadId: 't1',
      expectedThreadId: 't1',
      inboxContainsThread: false,
    }).verified).toBe(false);
    expect(verifyArchive({
      toastText: 'The conversation has been archived.',
      beforeOpenThreadId: 't1',
      afterOpenThreadId: 't1',
      expectedThreadId: 't1',
      inboxContainsThread: null,
    }).verified).toBe(true);
  });

  it('verifies open, draft, and navigation separately', () => {
    expect(verifyOpenThread('t1', 't1').verified).toBe(true);
    expect(verifyOpenThread('other', 't1').verified).toBe(false);
    expect(verifyDraftInserted({
      composeOpen: true,
      bodyText: 'Thursday afternoon works.',
      expectedText: 'Thursday afternoon works.',
      activeThreadId: 't1',
      expectedThreadId: 't1',
    }).verified).toBe(true);
    expect(verifyDraftInserted({
      composeOpen: false,
      bodyText: 'Thursday afternoon works.',
      expectedText: 'Thursday afternoon works.',
      activeThreadId: 't1',
      expectedThreadId: 't1',
    }).verified).toBe(false);
    // Strict thread matching: null or mismatched activeThreadId must fail
    expect(verifyDraftInserted({
      composeOpen: true,
      bodyText: 'Thursday afternoon works.',
      expectedText: 'Thursday afternoon works.',
      activeThreadId: null,
      expectedThreadId: 't1',
    }).verified).toBe(false);
    expect(verifyDraftInserted({
      composeOpen: true,
      bodyText: 'Thursday afternoon works.',
      expectedText: 'Thursday afternoon works.',
      activeThreadId: 'unrelated-thread',
      expectedThreadId: 't1',
    }).verified).toBe(false);
    expect(verifyNavigation('#search/in%3Ainbox', 'in:inbox').verified).toBe(true);
    expect(verifyNavigation('#inbox', 'from:sarah').verified).toBe(false);
  });
});
