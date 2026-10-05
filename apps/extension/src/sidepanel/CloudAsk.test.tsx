/**
 * @vitest-environment jsdom
 */
import type { AskPigeonResponse } from '@pigeonbox/api-contract';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const asked: Array<Record<string, unknown>> = [];
const feedback: Array<Record<string, unknown>> = [];
let reply: AskPigeonResponse;
vi.mock('./cloud-api', () => ({
  cloudCall: async (route: string, body: Record<string, unknown>) => {
    if (route === 'askFeedback') feedback.push(body);
    return { ok: false, code: 'not_found', reason: 'Not configured.' };
  },
  cloudAskStream: async (body: Record<string, unknown>) => {
    asked.push(body);
    return { ok: true, data: reply };
  },
}));
vi.mock('../ui/analytics', () => ({ trackProductEvent: () => undefined }));
vi.mock('../workspace/session', () => ({ useWorkspaceInput: (_key: string, initial: string) => useState(initial) }));

const sent: Array<{ type: string; draft?: unknown }> = [];
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    lastError: undefined,
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: (message: { type: string; draft?: unknown }, callback?: (response: unknown) => void) => {
      sent.push(message);
      callback?.({ opened: true });
    },
  },
};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CloudAsk, liveText } = await import('./CloudAsk');
const { joinSpeech } = await import('./dictation');

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
});
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<CloudAsk capabilities={[]} onOpenThread={() => undefined} />); });
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

  it('sends the composed email with the next question so it can be revised', async () => {
    reply = response({ compose: [EMAIL] });
    await render();
    await type('email jun');
    await key({ key: 'Enter' });
    reply = response();
    await type('make it shorter');
    await key({ key: 'Enter' });
    const history = asked[1]!.history as Array<{ role: string; content: string }>;
    expect(history[1]!.content).toContain('Subject: Hi Jun');
    expect(history[1]!.content).toContain('Just saying hi.');
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

  it('hides citation markers and the follow-ups line while an answer streams', () => {
    expect(liveText('Allen wants Monday [S2].\n\nNext: Draft a re')).toBe('Allen wants Monday.');
    expect(liveText('Allen wants Monday.\nNe')).toBe('Allen wants Monday.');
    expect(liveText('Allen wants Monday.\n**Next:** a | b')).toBe('Allen wants Monday.');
    expect(liveText('One thing.\nNo meetings today')).toBe('One thing.\nNo meetings today');
    expect(liveText('Done [S1')).toBe('Done');
  });

  it('adds dictated words after what was typed', () => {
    expect(joinSpeech('Email Jun', ' about Friday ')).toBe('Email Jun about Friday');
    expect(joinSpeech('', 'hello')).toBe('hello');
    expect(joinSpeech('line\n', 'next')).toBe('line\nnext');
    expect(joinSpeech('kept', '  ')).toBe('kept');
  });
});
