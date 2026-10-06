/**
 * @vitest-environment jsdom
 */
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOFILL_WINDOW_MS,
  autofillPreparedReply,
  claimThread,
  composerIsEmpty,
  holdsUneditedPrepared,
  preparedReply,
  rememberPlaced,
  resetPreparedRepliesForTests,
  type AutofillDeps,
} from './prepared-reply';
import { rememberVariantChoice } from './variant-choice';

const draft = (status = 'ready', body = 'Hey Maya,\n\nI can do 1:00–1:30 or 2:30–3:00 today. Either work?\n\nBest,\nAiden') =>
  ({
    draft: {
      id: '00000000-0000-4000-8000-000000000003',
      threadId: 't1',
      accountId: '00000000-0000-4000-8000-000000000001',
      kind: 'scheduling',
      status,
      variants: [
        { id: '00000000-0000-4000-8000-000000000004', label: 'recommended', strategy: 'Offer both', body, placeholders: [] },
        { id: '00000000-0000-4000-8000-000000000005', label: 'shorter', strategy: 'Brief', body: '1:00 works.', placeholders: [] },
      ],
      sources: [],
      freshness: { createdAt: '2026-10-06T10:00:00.000Z', basedOnMessageId: null, staleReason: null, refreshAfter: null },
      voice: 'default',
      gmailDraftId: null,
      placedVariantId: null,
      errorCode: null,
    },
  }) as unknown as ThreadIntel;

type Handler = () => void;
function reply(html = '<div><br></div><div class="gmail_signature">-- <br>Aiden</div><div class="gmail_quote">On Mon, Maya wrote:<blockquote>Are you free 1-3pm today?</blockquote></div>', isReply = true) {
  const body = document.createElement('div');
  body.setAttribute('contenteditable', 'true');
  body.innerHTML = html;
  document.body.append(body);
  const handlers = new Map<string, Handler[]>();
  const view = {
    isReply: () => isReply,
    getBodyElement: () => body,
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    emit: (event: string) => handlers.get(event)?.forEach((handler) => handler()),
  };
  return { body, view };
}

function deps(overrides: Partial<AutofillDeps> = {}) {
  const inserted: string[] = [];
  const value: AutofillDeps = {
    available: () => true,
    currentThreadId: () => 't1',
    composeThreadId: async () => 't1',
    intel: async () => draft(),
    insert: vi.fn(async (body: HTMLElement, text: string) => {
      inserted.push(text);
      const top = document.createElement('div');
      top.textContent = text;
      body.prepend(top);
      return true;
    }),
    onFilled: vi.fn(),
    ...overrides,
  };
  return { deps: value, inserted };
}

afterEach(() => {
  resetPreparedRepliesForTests();
  document.body.innerHTML = '';
});

describe('prepared replies in Gmail', () => {
  it('only offers a ready draft, never a stale, placed, edited or sent one', () => {
    expect(preparedReply(draft())?.body).toContain('1:00–1:30');
    expect(preparedReply(draft(), 1)?.body).toBe('1:00 works.');
    for (const status of ['stale', 'placed', 'user_edited', 'sent', 'discarded', 'failed', 'preparing']) expect(preparedReply(draft(status))).toBeNull();
    expect(preparedReply({ draft: null })).toBeNull();
  });

  it('fills an empty reply composer once, at the top, keeping the signature and quote', async () => {
    const { body, view } = reply();
    expect(composerIsEmpty(body)).toBe(true);
    const { deps: d, inserted } = deps();
    expect(await autofillPreparedReply(view, d)).toBe('filled');
    expect(inserted).toHaveLength(1);
    expect(body.querySelector('.gmail_signature')).not.toBeNull();
    expect(body.querySelector('.gmail_quote')).not.toBeNull();
    expect(holdsUneditedPrepared(body)).toBe(true);
    expect(d.onFilled).toHaveBeenCalledWith(body);
    // The same prepared version never comes back, even in a new composer for the thread.
    const again = reply();
    expect(await autofillPreparedReply(again.view, d)).toBe('skipped');
    expect(inserted).toHaveLength(1);
  });

  it('never touches a composer with the person’s own words, or one they type into while Cloud answers', async () => {
    const written = reply('<div>Sounds good, let me check.</div>');
    const { deps: d, inserted } = deps();
    expect(await autofillPreparedReply(written.view, d)).toBe('skipped');
    let release: ((value: ThreadIntel) => void) | null = null;
    const slow = deps({ intel: () => new Promise((resolve) => { release = resolve; }) });
    const typing = reply();
    const pending = autofillPreparedReply(typing.view, slow.deps);
    await vi.waitFor(() => expect(release).not.toBeNull());
    typing.body.prepend(Object.assign(document.createElement('div'), { textContent: 'Actually,' }));
    typing.body.dispatchEvent(new Event('input', { bubbles: true }));
    release!(draft());
    expect(await pending).toBe('skipped');
    expect([...inserted, ...slow.inserted]).toHaveLength(0);
    expect(typing.body.textContent).toContain('Actually,');
  });

  it('stays out of the way of an explicit "Use reply", a closed composer, a different thread, Local mode and slow answers', async () => {
    claimThread('t1');
    expect(await autofillPreparedReply(reply().view, deps().deps)).toBe('skipped');
    resetPreparedRepliesForTests();
    expect(await autofillPreparedReply(reply().view, deps({ available: () => false }).deps)).toBe('skipped');
    expect(await autofillPreparedReply(reply().view, deps({ composeThreadId: async () => 'other' }).deps)).toBe('skipped');
    expect(await autofillPreparedReply(reply(undefined, false).view, deps().deps)).toBe('skipped');
    let now = 1_000;
    expect(await autofillPreparedReply(reply().view, deps({ now: () => (now += AUTOFILL_WINDOW_MS + 1) }).deps)).toBe('skipped');
    let release: ((value: ThreadIntel) => void) | null = null;
    const closing = reply();
    const pending = autofillPreparedReply(closing.view, deps({ intel: () => new Promise((resolve) => { release = resolve; }) }).deps);
    await vi.waitFor(() => expect(release).not.toBeNull());
    closing.view.emit('destroy');
    release!(draft());
    expect(await pending).toBe('skipped');
  });

  it('uses the version picked in the panel, and only versions of this draft', async () => {
    const { deps: d, inserted } = deps({ preferredVariant: async () => '00000000-0000-4000-8000-000000000005' });
    expect(await autofillPreparedReply(reply().view, d)).toBe('filled');
    expect(inserted).toEqual(['1:00 works.']);
    resetPreparedRepliesForTests();
    const stray = deps({ preferredVariant: async () => 'not-a-variant-of-this-draft' });
    expect(await autofillPreparedReply(reply().view, stray.deps)).toBe('filled');
    expect(stray.inserted[0]).toContain('1:00–1:30');
  });

  it('keeps only ids, the newest few, for remembered choices', () => {
    let choices: Record<string, string> | undefined;
    for (let i = 0; i < 25; i += 1) choices = rememberVariantChoice(choices, `d${i}`, `v${i}`);
    choices = rememberVariantChoice(choices, 'd24', 'v-again');
    expect(Object.keys(choices!)).toHaveLength(20);
    expect(choices!.d24).toBe('v-again');
    expect(choices!.d0).toBeUndefined();
  });

  it('tells an unedited prepared reply apart from the person’s edits', () => {
    const { body } = reply('<div>Hey Maya,</div><div><br></div><div>1:00 works.</div>');
    rememberPlaced(body, 'Hey Maya,\n\n1:00 works.');
    expect(holdsUneditedPrepared(body)).toBe(true);
    body.lastElementChild!.textContent = '1:00 works, see you then.';
    expect(holdsUneditedPrepared(body)).toBe(false);
  });
});
