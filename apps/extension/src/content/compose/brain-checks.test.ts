/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailComposeSendHarness } from '../tracking/gmail-send-harness';
import {
  BRAIN_CACHE_MS,
  BRAIN_COOLDOWN_MS,
  BRAIN_IDLE_MS,
  activeBrainChecks,
  attachComposeBrainChecks,
  readComposeText,
  replaceClaim,
  resetBrainChecksForTests,
  sourceHref,
  type BrainCheckReply,
  type BrainCheckRequest,
  type ComposeBrainDeps,
} from './brain-checks';

const busy: BrainCheckReply = {
  ok: true,
  status: 'notice',
  notice: {
    kind: 'calendar_conflict',
    severity: 'warning',
    message: 'You have Math 52 from 2–4 PM tomorrow.',
    suggestedText: "I'm free tomorrow at 4:30.",
    sources: [{ kind: 'calendar_event', title: 'Math 52', url: 'https://calendar.google.com/calendar/event?eid=abc' }],
  },
};
const none: BrainCheckReply = { ok: true, status: 'none' };

type Compose = { harness: GmailComposeSendHarness; body: HTMLElement; type: (text: string) => void; setText: (html: string) => void; notice: () => ShadowRoot | null; emit: (event: string) => void };

function compose(recipients = ['alex@example.test'], initial = ''): Compose {
  const harness = new GmailComposeSendHarness('new');
  harness.recipients = recipients.map((emailAddress) => ({ emailAddress }));
  harness.subject = 'Coffee next week';
  const body = harness.view().getBodyElement()!;
  body.setAttribute('contenteditable', 'true');
  body.innerHTML = initial;
  document.body.append(harness.element);
  return {
    harness,
    body,
    type: (text) => {
      body.append(document.createTextNode(text));
      body.dispatchEvent(new Event('input', { bubbles: true }));
    },
    setText: (html) => {
      body.innerHTML = html;
      body.dispatchEvent(new Event('input', { bubbles: true }));
    },
    notice: () => (harness.element.querySelector('[data-gi-ui="brain-notice"]') as HTMLElement | null)?.shadowRoot ?? null,
    emit: (event) => harness.emit(event),
  };
}

function brain(reply: BrainCheckReply | ((request: BrainCheckRequest) => Promise<BrainCheckReply | undefined>) = none, available = true) {
  const requests: BrainCheckRequest[] = [];
  const deps: ComposeBrainDeps = {
    available: () => available,
    check: vi.fn(async (request: BrainCheckRequest) => {
      requests.push(request);
      return typeof reply === 'function' ? reply(request) : reply;
    }),
    mailbox: () => 'me@example.test',
    openSource: vi.fn(),
  };
  return { deps, requests };
}

const settle = () => vi.advanceTimersByTimeAsync(BRAIN_IDLE_MS + 10);
const button = (root: ShadowRoot | null, action: string) => root?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`) ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T16:00:00Z'));
});
afterEach(() => {
  resetBrainChecksForTests();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('real-time Pidgy checks in compose', () => {
  it('waits for typing to settle, then checks once', async () => {
    const c = compose();
    const { deps, requests } = brain();
    attachComposeBrainChecks(c.harness.view(), deps);
    for (const piece of ["I'm ", 'free ', 'tomorrow ', 'at 3.']) {
      c.type(piece);
      await vi.advanceTimersByTimeAsync(BRAIN_IDLE_MS / 2);
    }
    expect(requests).toHaveLength(0);
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ claim: "I'm free tomorrow at 3.", hint: 'availability', recipientEmails: ['alex@example.test'], subject: 'Coffee next week', mailbox: 'me@example.test' });
  });

  it('sends nothing for ordinary prose, and nothing at all in Local mode', async () => {
    const c = compose();
    const { deps, requests } = brain();
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type('Thanks so much for sending this over. Hope the trip went well!');
    await settle();
    expect(requests).toHaveLength(0);
    const local = compose(['sam@example.test']);
    const off = brain(none, false);
    attachComposeBrainChecks(local.harness.view(), off.deps);
    local.type("I'm free tomorrow at 3.");
    await settle();
    expect(off.requests).toHaveLength(0);
  });

  it('checks commitments, and sends only the changed clause, never the whole draft', async () => {
    const c = compose(['alex@example.test'], '<div>Hi Alex,</div><div>Thanks for the notes on the deck. They were really helpful.</div>');
    const { deps, requests } = brain();
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type(" I'll send it over Friday. Talk soon");
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.claim).toBe("I'll send it over Friday.");
    expect(requests[0]!.hint).toBe('commitment');
    expect(JSON.stringify(requests)).not.toMatch(/Hi Alex|really helpful|Talk soon/);
  });

  it('bounds a claim to 700 characters', async () => {
    const c = compose();
    const { deps, requests } = brain();
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type(`${'and then we can go over everything '.repeat(30)}and honestly I'm free tomorrow at 3`);
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.claim.length).toBeLessThanOrEqual(700);
    expect(requests[0]!.claim.endsWith("I'm free tomorrow at 3")).toBe(true);
  });

  it('ignores quoted Gmail history, signatures and text that was already there', async () => {
    const c = compose(
      ['alex@example.test'],
      '<div>Tuesday at 5 works for me.</div><div class="gmail_signature">Ada · free tomorrow at 3pm</div><div class="gmail_quote"><div>On Mon, Alex wrote:</div><blockquote>Are you free tomorrow at 3?</blockquote></div>',
    );
    const { deps, requests } = brain();
    attachComposeBrainChecks(c.harness.view(), deps);
    c.body.firstElementChild!.append(document.createTextNode(' Looking forward to it.'));
    c.body.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(requests).toHaveLength(0);
    expect(readComposeText(c.body, null).text).not.toMatch(/Are you free|Ada/);
    c.setText('Sounds good.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Alex <alex@example.test> wrote:\n> I am free tomorrow at 3');
    await settle();
    expect(requests).toHaveLength(0);
  });

  it('keeps one remote check per cooldown and reuses answers for the same clause', async () => {
    const c = compose();
    const { deps, requests } = brain(busy);
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type("I'm free tomorrow at 3. ");
    await settle();
    c.type('Wednesday at 11 works for me too.');
    await settle();
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.claim).toBe('Wednesday at 11 works for me too.');
    // The newer notice's words go away: the earlier conflict, still in the message, comes back without a request.
    expect(c.notice()?.textContent).toContain('Math 52');
    c.setText("I'm free tomorrow at 3.");
    await settle();
    expect(c.notice()).not.toBeNull();
    expect(requests).toHaveLength(2);
    // Deleting and retyping the first claim with other casing and spacing is answered from the cache.
    c.setText('Hello.');
    await settle();
    c.setText("Hello.  i'M FREE   tomorrow at 3!");
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    expect(requests).toHaveLength(2);
    expect(c.notice()?.textContent).toContain('Math 52');
    // ...until the cache expires.
    c.setText('Hello.');
    await settle();
    vi.setSystemTime(Date.now() + BRAIN_CACHE_MS + 1);
    c.setText("Hello. I'm free tomorrow at 3.");
    await settle();
    expect(requests).toHaveLength(3);
  });

  it('does not re-check when only whitespace or an unrelated sentence changes', async () => {
    const c = compose();
    const { deps, requests } = brain();
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type("I'm free tomorrow at 3.");
    await settle();
    c.type('   ');
    await settle();
    c.type(' Also, the photos from Saturday are great.');
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    expect(requests).toHaveLength(1);
  });

  it('ignores the answer to an older request once a newer claim was sent', async () => {
    const c = compose();
    const resolvers: Array<(reply: BrainCheckReply) => void> = [];
    const { deps, requests } = brain(() => new Promise((resolve) => resolvers.push(resolve)));
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type("I'm free tomorrow at 3.");
    await settle();
    c.setText("I'm free tomorrow at 5.");
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    expect(requests).toHaveLength(2);
    resolvers[1]!(none);
    await vi.advanceTimersByTimeAsync(0);
    resolvers[0]!(busy);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.notice()).toBeNull();
  });

  it('re-checks when recipients change, and when the subject changes for Brain claims only', async () => {
    const c = compose();
    const { deps, requests } = brain();
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type("I'll send the deck by Friday.");
    await settle();
    c.harness.recipients = [{ emailAddress: 'jordan@example.test' }];
    c.emit('recipientsChanged');
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    expect(requests.map((request) => request.recipientEmails)).toEqual([['alex@example.test'], ['jordan@example.test']]);
    c.harness.subject = 'Board deck';
    c.emit('subjectChanged');
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    expect(requests).toHaveLength(3);

    const calendar = compose(['sam@example.test']);
    const second = brain();
    attachComposeBrainChecks(calendar.harness.view(), second.deps);
    calendar.type("I'm free tomorrow at 3.");
    await settle();
    calendar.harness.subject = 'Another subject';
    calendar.emit('subjectChanged');
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    expect(second.requests).toHaveLength(1);
  });

  it('shows one accessible notice, hides it when the claim goes away, and respects dismissal', async () => {
    const c = compose();
    const { deps, requests } = brain(busy);
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type("I'm free tomorrow at 3.");
    await settle();
    const root = c.notice()!;
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Pidgy noticed something');
    expect(root.textContent).toContain('You have Math 52 from 2–4 PM tomorrow.');
    expect(button(root, 'source')).not.toBeNull();
    button(root, 'source')!.click();
    expect(deps.openSource).toHaveBeenCalledWith(expect.objectContaining({ title: 'Math 52' }), 'me@example.test');
    c.setText('Never mind.');
    await settle();
    await vi.advanceTimersByTimeAsync(200);
    expect(c.notice()).toBeNull();
    c.setText("I'm free tomorrow at 3.");
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    button(c.notice(), 'dismiss')!.click();
    await vi.advanceTimersByTimeAsync(200);
    expect(c.notice()).toBeNull();
    const before = requests.length;
    c.setText("Ok. I'm free tomorrow at 3.");
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
    expect(c.notice()).toBeNull();
    expect(requests).toHaveLength(before);
    // A materially different claim is checked again.
    c.setText("Ok. I'm free tomorrow at 4.");
    await settle();
    expect(requests).toHaveLength(before + 1);
  });

  it('applies a suggestion only to the checked words, and only while they appear once', async () => {
    const c = compose();
    const { deps } = brain(busy);
    attachComposeBrainChecks(c.harness.view(), deps);
    c.setText("<div>Hi Alex!</div><div>I'm free tomorrow at 3.</div><div>Best, Ada</div>");
    await settle();
    button(c.notice(), 'suggest')!.click();
    expect(c.body.textContent).toBe("Hi Alex!I'm free tomorrow at 4:30.Best, Ada");
    await vi.advanceTimersByTimeAsync(200);
    expect(c.notice()).toBeNull();

    const twice = document.createElement('div');
    twice.innerHTML = "<p>I'm free tomorrow at 3.</p><p>I'm free tomorrow at 3.</p>";
    expect(replaceClaim(twice, "I'm free tomorrow at 3.", 'x')).toBe(false);
    expect(twice.textContent).toBe("I'm free tomorrow at 3.I'm free tomorrow at 3.");
  });

  it('cleans up listeners, timers and UI when the compose closes', async () => {
    const c = compose();
    const { deps, requests } = brain(busy);
    attachComposeBrainChecks(c.harness.view(), deps);
    expect(activeBrainChecks()).toBe(1);
    c.type("I'm free tomorrow at 3.");
    await settle();
    expect(c.notice()).not.toBeNull();
    c.type(' Tuesday at 5 works for me.');
    c.emit('destroy');
    expect(activeBrainChecks()).toBe(0);
    expect(c.notice()).toBeNull();
    c.type(' Wednesday at 11 works for me.');
    await settle();
    await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS * 2);
    expect(requests).toHaveLength(1);
  });

  it('keeps two compose windows isolated', async () => {
    const a = compose(['alex@example.test']);
    const b = compose(['sam@example.test']);
    const first = brain(busy);
    const second = brain(none);
    attachComposeBrainChecks(a.harness.view(), first.deps);
    attachComposeBrainChecks(b.harness.view(), second.deps);
    a.type("I'm free tomorrow at 3.");
    b.type('Thanks, see you soon.');
    await settle();
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(0);
    expect(a.notice()).not.toBeNull();
    expect(b.notice()).toBeNull();
    // B's cooldown and cache are its own.
    b.type(" I'm free tomorrow at 3.");
    await settle();
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]!.recipientEmails).toEqual(['sam@example.test']);
    expect(b.notice()).toBeNull();
    button(a.notice(), 'dismiss')!.click();
    a.emit('destroy');
    expect(activeBrainChecks()).toBe(1);
  });

  it('only links to Gmail threads and Google Calendar', () => {
    expect(sourceHref({ kind: 'thread', title: 't', gmailThreadId: '18c2f0a1b2c3d4e5' }, 'me@example.test')).toBe('https://mail.google.com/mail/?authuser=me%40example.test#all/18c2f0a1b2c3d4e5');
    expect(sourceHref({ kind: 'calendar_event', title: 'e', url: 'https://calendar.google.com/calendar/event?eid=x' }, null)).toContain('calendar.google.com');
    for (const url of ['javascript:alert(1)', 'https://calendar.google.com.evil.test/', 'http://calendar.google.com/x', 'https://evil.test/calendar/'])
      expect(sourceHref({ kind: 'web', title: 'w', url }, null)).toBeNull();
  });
});
