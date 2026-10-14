/**
 * @vitest-environment jsdom
 */
import type { AskPigeonResponse } from '@pigeonbox/api-contract';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const asked: Array<Record<string, unknown>> = [];
const feedback: Array<Record<string, unknown>> = [];
const connectStarts: Array<Record<string, unknown>> = [];
const openedTabs: string[] = [];
let connectedAccounts: Array<{ email: string; status: string; features: string[] }> = [];
let reply: AskPigeonResponse;
vi.mock('./cloud-api', () => ({
  cloudCall: async (route: string, body: Record<string, unknown>) => {
    if (route === 'askFeedback') feedback.push(body);
    if (route === 'connections') return { ok: true, data: { accounts: connectedAccounts } };
    if (route === 'connectStart') {
      connectStarts.push(body);
      return { ok: true, data: { url: 'https://accounts.google.test/consent' } };
    }
    return { ok: false, code: 'not_found', reason: 'Not configured.' };
  },
  cloudAskStream: async (body: Record<string, unknown>) => {
    asked.push(body);
    return { ok: true, data: reply };
  },
}));
vi.mock('../ui/analytics', () => ({ trackProductEvent: () => undefined }));
vi.mock('../workspace/session', () => ({ useWorkspaceInput: (_key: string, initial: string) => useState(initial) }));

const sent: Array<{ type: string; draft?: unknown; action?: string; session?: string }> = [];
const listeners = new Set<(message: unknown) => void>();
let dictationReply: { ok: boolean; reason?: string } = { ok: true };
/** chrome.storage.local, for chat history. */
const stored = new Map<string, unknown>();
const pick = (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((name) => stored.has(name)).map((name) => [name, structuredClone(stored.get(name))]));
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) => pick(keys),
      set: async (items: Record<string, unknown>) => { for (const [name, value] of Object.entries(items)) stored.set(name, structuredClone(value)); },
      remove: async (keys: string | string[]) => { for (const name of Array.isArray(keys) ? keys : [keys]) stored.delete(name); },
    },
  },
  tabs: { create: async ({ url }: { url: string }) => { openedTabs.push(url); } },
  runtime: {
    lastError: undefined,
    getURL: (path: string) => `chrome-extension://test/${path}`,
    onMessage: { addListener: (fn: (message: unknown) => void) => listeners.add(fn), removeListener: (fn: (message: unknown) => void) => listeners.delete(fn) },
    sendMessage: (message: { type: string; draft?: unknown }, callback?: (response: unknown) => void) => {
      if (!callback) return Promise.resolve();
      sent.push(message);
      callback?.(message.type === 'PB_DICTATION' ? dictationReply : { opened: true });
    },
  },
};
async function deliver(message: Record<string, unknown>) {
  await act(async () => { for (const listener of [...listeners]) listener({ type: 'PB_DICTATION_EVENT', ...message }); });
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CloudAsk, liveText, historyOf } = await import('./CloudAsk');
const { joinSpeech, dictationProblem } = await import('./dictation');

const EMAIL = { to: [{ email: 'junoh@berkeley.edu', name: 'Jun Oh' }], cc: [], subject: 'Hi Jun', body: 'Hi Jun,\n\nJust saying hi.\n\nAda' };
function response(overrides: Partial<AskPigeonResponse> = {}): AskPigeonResponse {
  return {
    answer: 'Opened an email to Jun Oh, from the EECS directory [1].',
    claims: [],
    sources: [{ id: 'web:https://eecs.berkeley.edu/people', kind: 'web', title: 'EECS People', url: 'https://eecs.berkeley.edu/people' }],
    coverage: { complete: true, note: 'Looked at the web (1 page).', since: null },
    unverified: [],
    actions: [],
    drafts: [],
    compose: [],
    retrieval: { strategies: ['web'], candidates: 1, used: 1, window: { from: null, to: null } },
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  asked.length = 0;
  sent.length = 0;
  feedback.length = 0;
  stored.clear();
});
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(mailbox?: string, wait = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<CloudAsk capabilities={[]} onOpenThread={() => undefined} mailbox={mailbox} />); });
  if (wait) await settle();
}
const field = () => host.querySelector('textarea[aria-label="Ask Pigeon"]') as HTMLTextAreaElement;
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(init: KeyboardEventInit) {
  await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
  await settle();
}

describe('Cloud Ask history', () => {
  async function reopen(mailbox?: string) {
    act(() => root.unmount());
    host.remove();
    await render(mailbox);
  }
  const select = () => host.querySelector('select[aria-label="Keep chat history for"]') as HTMLSelectElement;

  it('shows earlier chats after the panel reopens, continues a recent one, and starts fresh on New chat', async () => {
    reply = response({ answer: 'Allen sent the redlines.' });
    await render('ada@work.test');
    expect(select().value).toBe('7');
    await type('what did allen send?');
    await key({ key: 'Enter' });
    await settle();
    expect((stored.get('askHistory') as Record<string, unknown[]>)['ada@work.test']).toHaveLength(1);

    await reopen('ada@work.test');
    expect(host.querySelector('.gi-asked')!.textContent).toBe('what did allen send?');
    expect(host.textContent).toContain('Allen sent the redlines.');
    expect(host.querySelector('.pb-chat-divider')!.textContent).toMatch(/^Today, /);
    // Still the same conversation: it goes along as context.
    await type('and when?');
    await key({ key: 'Enter' });
    expect(asked[1]!.history).toMatchObject([{ role: 'user', content: 'what did allen send?' }, { role: 'assistant', content: 'Allen sent the redlines.' }]);

    await act(async () => { (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'New chat') as HTMLButtonElement).click(); });
    await type('something else');
    await key({ key: 'Enter' });
    expect(asked[2]!.history).toBeUndefined();
    expect(host.querySelectorAll('.pb-chat-divider')).toHaveLength(2);
    expect(host.querySelectorAll('.pb-ask-turn[data-earlier]')).toHaveLength(2);

    // Another inbox has its own history.
    await reopen('other@work.test');
    expect(host.querySelector('.gi-asked')).toBeNull();
  });

  it('continues a retained chat after a long pause and preserves an explicitly empty New chat', async () => {
    stored.set('askHistory', { 'ada@work.test': [{ id: 12, chatId: 10, at: Date.now() - 2 * 3_600_000, question: 'Only consider next week.', answer: response({ answer: 'Thursday or Friday?' }) }] });
    reply = response({ answer: 'Friday selected.' });
    await render('ada@work.test');
    await type('Friday');
    await key({ key: 'Enter' });
    expect(asked[0]!.history).toMatchObject([{ role: 'user', content: 'Only consider next week.' }, { role: 'assistant', content: 'Thursday or Friday?' }]);
    await act(async () => { (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'New chat') as HTMLButtonElement).click(); });
    await settle();
    await reopen('ada@work.test');
    await type('A separate question');
    await key({ key: 'Enter' });
    expect(asked[1]!.history).toBeUndefined();
  });

  it('isolates history when switching inboxes without unmounting the panel', async () => {
    reply = response({ answer: 'Work answer.' });
    await render('ada@work.test');
    await type('Work question');
    await key({ key: 'Enter' });
    await act(async () => { root.render(<CloudAsk capabilities={[]} onOpenThread={() => undefined} mailbox="ada@school.test" />); });
    await settle();
    expect(host.textContent).not.toContain('Work question');
    await type('School question');
    await key({ key: 'Enter' });
    expect(asked[1]!.history).toBeUndefined();
    await settle();
    const history = stored.get('askHistory') as Record<string, Array<{ question: string }>>;
    expect(history['ada@work.test']!.map((turn) => turn.question)).toEqual(['Work question']);
    expect(history['ada@school.test']!.map((turn) => turn.question)).toEqual(['School question']);
  });

  it('keeps nothing when history is off, and drops chats older than the chosen days', async () => {
    const old = Date.now() - 4 * 86_400_000;
    stored.set('askHistory', { mailbox: [{ id: 1, chatId: 1, at: old, question: 'old question', action: 'old' }, { id: 2, chatId: 2, at: Date.now() - 3_600_000, question: 'recent question', action: 'recent' }] });
    stored.set('askHistoryRetentionDays', 3);
    reply = response();
    await render();
    expect(select().value).toBe('3');
    expect(Array.from(host.querySelectorAll('.gi-asked')).map((item) => item.textContent)).toEqual(['recent question']);

    await act(async () => {
      select().value = '0';
      select().dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(stored.has('askHistory')).toBe(false);
    expect(stored.get('askHistoryRetentionDays')).toBe(0);
    await type('not kept');
    await key({ key: 'Enter' });
    await settle();
    expect(stored.has('askHistory')).toBe(false);
  });
});

describe('Cloud Ask', () => {
  it('asks on Enter, keeps Shift+Enter for a new line, and opens a composed email in Gmail', async () => {
    reply = response({ compose: [EMAIL] });
    await render();
    await type('draft an email to jun chris oh, a student at berkeley');
    await key({ key: 'Enter', shiftKey: true });
    expect(asked).toHaveLength(0);
    await key({ key: 'Enter' });
    expect(asked[0]).toMatchObject({ query: 'draft an email to jun chris oh, a student at berkeley' });
    expect(sent).toEqual([{ type: 'OPEN_COMPOSE_DRAFT', draft: EMAIL }]);
    const card = host.querySelector('.pb-compose-card')!;
    expect(card.textContent).toContain('Jun Oh <junoh@berkeley.edu>');
    expect(card.textContent).toContain('Open in Gmail. Review it, then send.');
    expect(field().value).toBe('');
  });

  it('keeps sources collapsed until the user opens them', async () => {
    reply = response();
    await render();
    await type('who is on the EECS directory?');
    await key({ key: 'Enter' });
    const sources = host.querySelector('details.pb-answer-sources') as HTMLDetailsElement;
    expect(sources.open).toBe(false);
    expect(sources.querySelector('summary')!.textContent).toBe('Sources 1');
    await act(async () => { sources.querySelector('summary')!.click(); });
    expect(sources.open).toBe(true);
    expect(sources.querySelector('.pb-source-list')!.textContent).toContain('EECS People');
  });

  it('sends the composed email with the next question so it can be revised', async () => {
    reply = response({ compose: [EMAIL] });
    await render();
    await type('email jun');
    await key({ key: 'Enter' });
    reply = response();
    await type('make it shorter');
    await key({ key: 'Enter' });
    const history = asked[1]!.history as Array<{ role: string; content: string; context: string }>;
    expect(history[1]!.context).toContain('Subject: Hi Jun');
    expect(history[1]!.context).toContain('Just saying hi.');
    expect(sent).toHaveLength(1);
  });

  it('offers follow-ups as one-tap questions, and records thumbs down with a note', async () => {
    reply = response({ compose: [], followUps: ['Draft a reply to Allen', 'What else is due?'], requestId: 'req-9' });
    await render();
    await type('what did allen say?');
    await key({ key: 'Enter' });
    const chip = [...host.querySelectorAll('.pb-follow-ups button')].find((node) => node.textContent?.includes('Draft a reply to Allen')) as HTMLButtonElement;
    await act(async () => { (host.querySelector('[aria-label="Bad answer"]') as HTMLButtonElement).click(); });
    expect(feedback).toHaveLength(0);
    const note = host.querySelector('input[aria-label="What went wrong?"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'Missed his second email');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (note.form!.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    expect(feedback).toEqual([{ requestId: 'req-9', rating: 'down', question: 'what did allen say?', note: 'Missed his second email' }]);
    expect(host.textContent).toContain('Thanks, that helps Pigeon get better.');
    await act(async () => { chip.click(); });
    await settle();
    expect(asked.at(-1)).toMatchObject({ query: 'Draft a reply to Allen' });
  });

  it('carries the actual offered choices and outcomes when a suggested follow-up is selected', async () => {
    reply = response({ answer: 'Two possibilities remain.', followUps: ['Let me choose specific items'], context: '[{"tool":"example","result":"nothing changed"}]' });
    await render();
    await type('Only consider undergraduate programs.');
    await key({ key: 'Enter' });
    const chip = host.querySelector('.pb-follow-ups button') as HTMLButtonElement;
    reply = response({ answer: 'Which ones would you like?' });
    await act(async () => { chip.click(); });
    const history = asked[1]!.history as Array<{ content: string; context?: string }>;
    expect(history[0]!.content).toBe('Only consider undergraduate programs.');
    expect(history[1]!.context).toContain('Let me choose specific items');
    expect(history[1]!.context).toContain('nothing changed');
  });

  it('keeps the initiating request and the latest complete artifacts beyond six exchanges', () => {
    const turns = Array.from({ length: 14 }, (_, i) => ({ id: i, chatId: 1, at: Date.now(), question: i === 0 ? 'Keep graduate programs subscribed.' : `Follow-up ${i}`, answer: response({ answer: 'x'.repeat(7_500) + ' These are the actual choices.', followUps: ['Pick the second one'] }) }));
    const history = historyOf(turns);
    expect(history).toHaveLength(20);
    expect(history[0]!.content).toBe('Keep graduate programs subscribed.');
    expect(history.at(-1)!.content).toContain('These are the actual choices.');
    expect(history.at(-1)!.context).toContain('Pick the second one');
  });

  it('preserves a complete composed email before lengthy lookup metadata', () => {
    const body = 'a'.repeat(7_800) + ' Preserve this last constraint.';
    const history = historyOf([{ id: 1, chatId: 1, at: Date.now(), question: 'Write to Jun', answer: response({ compose: [{ ...EMAIL, body }], context: 'x'.repeat(8_000) }) }]);
    expect(history[1]!.context).toContain('Preserve this last constraint.');
    expect(history[1]!.context!.length).toBeLessThanOrEqual(12_000);
  });

  it('includes saved reply drafts so a later revision can identify their thread and wording', () => {
    const history = historyOf([{ id: 1, chatId: 1, at: Date.now(), question: 'Reply to Maya', answer: response({ drafts: [{ id: 'draft-1', threadId: 'gmail-123', accountId: 'account-1', kind: 'reply', status: 'ready', variants: [{ id: 'variant-1', label: 'recommended', strategy: 'Accepts Friday', subject: 'Friday', body: 'Hi Maya, Friday works. Ada', placeholders: [] }], sources: [], freshness: { createdAt: new Date().toISOString(), basedOnMessageId: null, staleReason: null, refreshAfter: null }, voice: 'default', gmailDraftId: null, placedVariantId: null, errorCode: null }] }) }]);
    expect(history[1]!.context).toContain('gmail-123');
    expect(history[1]!.context).toContain('Hi Maya, Friday works. Ada');
  });

  it('uses conversation context for a follow-up instead of a shortcut for the currently open email', async () => {
    reply = response({ answer: 'Maya asked about Friday.' });
    await render();
    await type('What did Maya ask?');
    await key({ key: 'Enter' });
    const shortcut = vi.fn(async () => 'Drafted for the currently open email.');
    await act(async () => { root.render(<CloudAsk capabilities={[]} onOpenThread={() => undefined} onContextQuestion={shortcut} />); });
    await type('draft a reply');
    await key({ key: 'Enter' });
    expect(shortcut).not.toHaveBeenCalled();
    expect(asked[1]!.history).toMatchObject([{ content: 'What did Maya ask?' }, { content: 'Maya asked about Friday.' }]);
  });

  it('keeps open-email shortcuts in a chat that has only been about that email, and drops them after switching emails', async () => {
    const pricing = { tabId: 7, threadId: 'thread-pricing', subject: 'Pricing', sender: 'Maya', owner: { email: 'ada@example.com', name: 'Ada' } };
    const shortcut = vi.fn(async () => 'Task saved: Pricing. The source email is attached.');
    reply = response({ answer: 'Maya wants a quote.' });
    await render();
    await act(async () => { root.render(<CloudAsk capabilities={[]} onOpenThread={() => undefined} context={pricing} onContextQuestion={async () => null} />); });
    await settle();
    await type('Summarize this thread');
    await key({ key: 'Enter' });
    await act(async () => { root.render(<CloudAsk capabilities={[]} onOpenThread={() => undefined} context={pricing} onContextQuestion={shortcut} />); });
    await type('Add this to my tasks');
    await key({ key: 'Enter' });
    expect(shortcut).toHaveBeenCalledWith('Add this to my tasks');
    expect(host.textContent).toContain('Task saved: Pricing.');
    // Another email is open now: "this" is ambiguous, so the conversation decides.
    const before = asked.length;
    await act(async () => { root.render(<CloudAsk capabilities={[]} onOpenThread={() => undefined} context={{ ...pricing, threadId: 'thread-other', subject: 'Other' }} onContextQuestion={shortcut} />); });
    await type('draft a reply');
    await key({ key: 'Enter' });
    expect(shortcut).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(before + 1);
  });

  it('hides citation markers and the follow-ups line while an answer streams', () => {
    expect(liveText('Allen wants Monday [S2].\n\nNext: Draft a re')).toBe('Allen wants Monday.');
    expect(liveText('Allen wants Monday.\nNe')).toBe('Allen wants Monday.');
    expect(liveText('Allen wants Monday.\n**Next:** a | b')).toBe('Allen wants Monday.');
    expect(liveText('One thing.\nNo meetings today')).toBe('One thing.\nNo meetings today');
    expect(liveText('Done [S1')).toBe('Done');
  });

  it('dictates into the box through the Gmail page, without opening any tab', async () => {
    reply = response();
    await render();
    await type('Email Jun');
    const mic = () => host.querySelector('button[aria-label="Dictate your question"], button[aria-label="Stop dictating"]') as HTMLButtonElement;
    await act(async () => { mic().click(); });
    await settle();
    const start = sent.find((message) => message.type === 'PB_DICTATION')!;
    expect(start).toMatchObject({ action: 'start' });
    expect(field().placeholder).toBe('Starting the microphone…');
    await deliver({ session: start.session, event: 'listening' });
    expect(mic().getAttribute('aria-label')).toBe('Stop dictating');
    await deliver({ session: start.session, event: 'text', final: '', interim: 'about fri' });
    expect(field().value).toBe('Email Jun about fri');
    await deliver({ session: 'someone-else', event: 'text', final: 'ignored', interim: '' });
    await deliver({ session: start.session, event: 'text', final: 'about Friday', interim: '' });
    await deliver({ session: start.session, event: 'end' });
    expect(field().value).toBe('Email Jun about Friday');
    expect(mic().getAttribute('aria-label')).toBe('Dictate your question');
    expect(listeners.size).toBe(0);
  });

  it('says how to allow the microphone when Chrome blocks it', async () => {
    reply = response();
    await render();
    await act(async () => { (host.querySelector('button[aria-label="Dictate your question"]') as HTMLButtonElement).click(); });
    await settle();
    const start = sent.find((message) => message.type === 'PB_DICTATION')!;
    await deliver({ session: start.session, event: 'error', error: 'not-allowed' });
    await deliver({ session: start.session, event: 'end' });
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/blocked for Gmail.*address bar/);
    expect(sent.filter((message) => message.type !== 'PB_DICTATION')).toEqual([]);
  });

  it('asks for Gmail when there is no Gmail tab to listen in', async () => {
    reply = response();
    dictationReply = { ok: false, reason: 'no_gmail' };
    await render();
    await act(async () => { (host.querySelector('button[aria-label="Dictate your question"]') as HTMLButtonElement).click(); });
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Open Gmail/);
    dictationReply = { ok: true };
  });

  it('names Chrome errors it has no fix for, so they can be reported', () => {
    expect(dictationProblem('start-failed:NotAllowedError')).toBe('Chrome would not start voice input (NotAllowedError). Reload your Gmail tab and try again.');
    expect(dictationProblem('bad-grammar')).toMatch(/\(bad-grammar\)/);
    expect(dictationProblem('not-allowed')).toMatch(/blocked for Gmail/);
  });

  it('gives up with a clear fix when Gmail never answers', async () => {
    vi.useFakeTimers();
    try {
      reply = response();
      dictationReply = { ok: true };
      await render(undefined, false);
      await act(async () => { (host.querySelector('button[aria-label="Dictate your question"]') as HTMLButtonElement).click(); });
      await act(async () => { vi.advanceTimersByTime(4_100); });
      expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Reload your Gmail tab/);
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('focuses on the inbox the user is in, and sends it with each question', async () => {
    connectedAccounts = [{ email: 'ada@gmail.com', status: 'active', features: ['mail_read'] }, { email: 'aidenguan@berkeley.edu', status: 'active', features: ['mail_read'] }];
    reply = response();
    await render('aidenguan@berkeley.edu');
    expect(host.textContent).toContain('Focused on aidenguan@berkeley.edu, plus your other inbox');
    expect(host.querySelector('.pb-connect-inbox')).toBeNull();
    await type('what is due this week?');
    await key({ key: 'Enter' });
    expect(asked[0]).toMatchObject({ mailbox: 'aidenguan@berkeley.edu' });
    connectedAccounts = [];
  });

  it('offers to connect the Gmail the user is in when it is not connected', async () => {
    connectedAccounts = [{ email: 'ada@gmail.com', status: 'active', features: ['mail_read'] }];
    await render('aidenguan@berkeley.edu');
    const banner = host.querySelector('.pb-connect-inbox')!;
    expect(banner.textContent).toContain('aidenguan@berkeley.edu isn’t connected to PigeonBox yet');
    expect(banner.textContent).toContain('Answers come from ada@gmail.com.');
    await act(async () => { (banner.querySelector('button') as HTMLButtonElement).click(); });
    await settle();
    expect(connectStarts).toEqual([{ features: ['mail_read', 'drafts'], loginHint: 'aidenguan@berkeley.edu', returnTo: 'extension' }]);
    expect(openedTabs).toEqual(['https://accounts.google.test/consent']);
    connectedAccounts = [];
  });

  it('adds dictated words after what was typed', () => {
    expect(joinSpeech('Email Jun', ' about Friday ')).toBe('Email Jun about Friday');
    expect(joinSpeech('', 'hello')).toBe('hello');
    expect(joinSpeech('line\n', 'next')).toBe('line\nnext');
    expect(joinSpeech('kept', '  ')).toBe('kept');
  });
});
