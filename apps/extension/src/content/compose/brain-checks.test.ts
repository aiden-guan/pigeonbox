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
  claimDiff,
  claimRange,
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
    notice: () => (document.querySelector(`[data-gi-ui="brain-notice"][data-gi-compose="${harness.element.getAttribute('data-gi-compose-id')}"]`) as HTMLElement | null)?.shadowRoot ?? null,
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
  it('checks the calendar denial from the screenshot with empty recipients and subject, excluding the signature', async () => {
    const c = compose([]);
    c.harness.subject = '';
    const { deps, requests } = brain({
      ok: true, status: 'notice', notice: {
        kind: 'calendar_conflict', severity: 'warning', message: 'You have a meeting at noon today.',
        sources: [{ kind: 'calendar_event', title: 'Meeting' }],
      },
    });
    attachComposeBrainChecks(c.harness.view(), deps);
    c.setText('<div>i dont&nbsp;have any meetings left today</div><div>--</div><div class="gmail_signature">Aiden Guan</div>');
    await settle();
    expect(requests).toEqual([expect.objectContaining({ claim: 'i dont have any meetings left today', hint: 'existence', recipientEmails: [], subject: '' })]);
    expect(c.notice()?.textContent).toContain('You have a meeting at noon today.');
    expect(JSON.stringify(requests)).not.toContain('Aiden Guan');
  });
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
    // Inline and quiet: no card, only an on-demand popover labelled by its one-line message.
    expect(root.textContent).not.toContain('Pidgy noticed something');
    const dialog = root.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Pidgy');
    expect(root.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('You have Math 52 from 2–4 PM tomorrow.');
    expect(button(root, 'suggest')?.textContent).toContain('Fix');
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

  it('marks only the words the fix would change', () => {
    expect(claimDiff("I'm free tomorrow at 2pm.", "I'm free tomorrow at 3:30pm.")).toEqual({ start: 21, end: 24, text: '3:30pm' });
    expect(claimDiff("I'm free tomorrow at 3.", "I'm free tomorrow at 4:30.")).toEqual({ start: 21, end: 22, text: '4:30' });
    expect(claimDiff("I'll send the deck by Friday.", "I'll send the deck by Wednesday.")).toMatchObject({ text: 'Wednesday' });
    expect(claimDiff('same', 'same')).toBeNull();
    const body = document.createElement('div');
    body.innerHTML = "<div>Hi Alex,</div><div>I'm free tomorrow at 2pm.</div>";
    document.body.append(body);
    expect(claimRange(body, "I'm free tomorrow at 2pm.", "I'm free tomorrow at 3:30pm.")?.toString()).toBe('2pm');
    expect(claimRange(body, "I'm free tomorrow at 2pm.", null)?.toString()).toBe("I'm free tomorrow at 2pm.");
  });

  it('applies the fix in place and keeps the caret where the user had it', () => {
    const body = document.createElement('div');
    body.setAttribute('contenteditable', 'true');
    body.innerHTML = "<div>I'm free tomorrow at 2pm. See you then</div>";
    document.body.append(body);
    const text = body.firstElementChild!.firstChild!;
    const caret = document.createRange();
    caret.setStart(text, text.nodeValue!.length);
    caret.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(caret);
    expect(replaceClaim(body, "I'm free tomorrow at 2pm.", "I'm free tomorrow at 3:30pm.")).toBe(true);
    expect(body.textContent).toBe("I'm free tomorrow at 3:30pm. See you then");
    const selection = document.getSelection()!;
    expect(selection.focusNode?.nodeValue?.slice(0, selection.focusOffset)).toBe("I'm free tomorrow at 3:30pm. See you then");
  });

  it('while presented, Tab applies the fix and Escape dismisses; otherwise Tab is left to Gmail', async () => {
    const rects = Range.prototype.getClientRects;
    const box = Element.prototype.getBoundingClientRect;
    Range.prototype.getClientRects = () => [{ left: 40, top: 20, right: 70, bottom: 36, width: 30, height: 16 }] as unknown as DOMRectList;
    Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 560, bottom: 300, width: 560, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    try {
      const c = compose();
      const { deps } = brain(busy);
      attachComposeBrainChecks(c.harness.view(), deps);
      c.setText("<div>I'm free tomorrow at 3.</div>");
      await settle();
      const root = c.notice()!;
      const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.hidden).toBe(true);
      // No CSS highlights here (jsdom): the same underline is drawn beside the text instead, and the editor is untouched.
      expect(root.querySelectorAll('.pb-line')).toHaveLength(1);
      expect(c.body.querySelector('[data-gi-ui]')).toBeNull();
      // Closed: Tab is ordinary Gmail behaviour.
      const quiet = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      c.body.dispatchEvent(quiet);
      expect(quiet.defaultPrevented).toBe(false);
      expect(c.body.textContent).toBe("I'm free tomorrow at 3.");
      // The dot presents it; Tab applies exactly the suggested words.
      root.querySelector<HTMLButtonElement>('.pb-dot')!.click();
      expect(dialog.hidden).toBe(false);
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      c.body.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(c.body.textContent).toBe("I'm free tomorrow at 4:30.");
      await vi.advanceTimersByTimeAsync(200);
      expect(c.notice()).toBeNull();

      // Escape dismisses for good.
      c.setText("<div>Also, I'm free tomorrow at 3.</div>");
      await settle();
      await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS);
      c.notice()!.querySelector<HTMLButtonElement>('.pb-dot')!.click();
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      c.body.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(c.notice()).toBeNull();
    } finally {
      Range.prototype.getClientRects = rects;
      Element.prototype.getBoundingClientRect = box;
    }
  });

  it('drops an answer whose words changed while Cloud was answering', async () => {
    const c = compose();
    let resolve: (reply: BrainCheckReply) => void = () => undefined;
    const { deps } = brain(() => new Promise((done) => { resolve = done; }));
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type("I'm free tomorrow at 3.");
    await settle();
    c.setText("I'm free tomorrow at 3:15 instead.");
    resolve(busy);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.notice()).toBeNull();
  });

  it('only links to Gmail threads and Google Calendar', () => {
    expect(sourceHref({ kind: 'thread', title: 't', gmailThreadId: '18c2f0a1b2c3d4e5' }, 'me@example.test')).toBe('https://mail.google.com/mail/?authuser=me%40example.test#all/18c2f0a1b2c3d4e5');
    expect(sourceHref({ kind: 'calendar_event', title: 'e', url: 'https://calendar.google.com/calendar/event?eid=x' }, null)).toContain('calendar.google.com');
    for (const url of ['javascript:alert(1)', 'https://calendar.google.com.evil.test/', 'http://calendar.google.com/x', 'https://evil.test/calendar/'])
      expect(sourceHref({ kind: 'web', title: 'w', url }, null)).toBeNull();
  });
});

describe('ambient context transport and phrase highlights', () => {
  it('sends a newly edited self statement only after idle, then highlights a validated phrase', async () => {
    const c=compose();
    const claim="i don't think i have any upcoming hackathons";
    const {deps, requests}=brain({ok:true,status:'notice',notice:{kind:'overlooked_context',severity:'info',message:'You have CalHacks Oct 23–25.',highlightText:'any upcoming hackathons',sources:[]}});
    attachComposeBrainChecks(c.harness.view(),deps);
    c.type(claim);
    expect(requests).toHaveLength(0);
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({claim,hint:'existence'});
    expect(c.notice()?.textContent).toContain('You have CalHacks Oct 23–25.');
    expect(claimRange(c.body,claim,null,'any upcoming hackathons')?.toString()).toBe('any upcoming hackathons');
    expect(claimRange(c.body,claim,null,'invented phrase')?.toString()).toBe(claim);
    expect(claimRange(c.body,"i don't think i have any upcoming hackathons",'i do think i have any upcoming hackathons','any upcoming hackathons')?.toString()).toBe("don't");
  });
  it('invalidates answers immediately on input or recipient changes, even before the next idle check', async () => {
    let resolve!: (reply: BrainCheckReply) => void;
    const c=compose();
    const {deps}=brain(()=>new Promise(r=>{resolve=r;}));
    attachComposeBrainChecks(c.harness.view(),deps);
    c.type("I'm free tomorrow at 3."); await settle();
    c.emit('recipientsChanged');
    resolve(busy); await vi.advanceTimersByTimeAsync(1);
    expect(c.notice()).toBeNull();
  });
});

it('highlights a literal phrase across Gmail inline formatting without changing the editor', () => {
  const body=document.createElement('div');body.innerHTML="i don't think i have any upcoming <b>hackathons</b>";
  const before=body.innerHTML;
  expect(claimRange(body,"i don't think i have any upcoming hackathons",null,'any upcoming hackathons')?.toString()).toBe('any upcoming hackathons');
  expect(body.innerHTML).toBe(before);
});

describe('smart autofill editor behavior and Pidgy coverage', () => {
  function caret(body: HTMLElement) {
    body.focus();
    body.getBoundingClientRect = () => ({left:0,right:600,top:0,bottom:200,width:600,height:200,x:0,y:0,toJSON:()=>({})});
    Range.prototype.getBoundingClientRect = () => ({left:20,right:20,top:20,bottom:40,width:0,height:20,x:20,y:20,toJSON:()=>({})});
    const range = document.createRange(); range.selectNodeContents(body); range.collapse(false);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }
  const answer: BrainCheckReply = { ok: true, status: 'none', completion: { text: ' where I made 35k in revenue.', sources: [{ kind: 'message', title: 'Community revenue', gmailThreadId: 'abc123' }] } };
  it('shows only an overlay at the live caret, accepts explicitly and never inserts on appearance', async () => {
    const c = compose(); const {deps, requests} = brain(answer); attachComposeBrainChecks(c.harness.view(), deps);
    c.type('I used to have a paid community'); caret(c.body); await settle();
    const host = document.querySelector('[data-gi-ui="brain-completion"]');
    expect(host).not.toBeNull(); expect(host?.shadowRoot?.textContent).toContain('35k in revenue');
    expect(requests[0]).toMatchObject({ includeCompletion: true, claim: 'I used to have a paid community' });
    expect(c.body.textContent).toBe('I used to have a paid community');
    expect(c.body.querySelectorAll('[data-gi-ui]')).toHaveLength(0);
    const insert = vi.fn(() => true); Object.defineProperty(document, 'execCommand', { configurable: true, value: insert });
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); c.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(insert).toHaveBeenCalledWith('insertText', false, answer.completion!.text);
    expect(document.querySelector('[data-gi-ui="brain-completion"]')).toBeNull();
  });
  it('starts after a short typing pause and shows the untyped part of an in-flight continuation', async () => {
    const c = compose(); let resolve!: (reply: BrainCheckReply) => void;
    const { deps, requests } = brain(() => new Promise(done => { resolve = done; }));
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type('I used to have a paid community'); caret(c.body);
    await vi.advanceTimersByTimeAsync(449); expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(requests).toHaveLength(1);
    c.type(' where I made'); caret(c.body);
    resolve(answer); await vi.advanceTimersByTimeAsync(1);
    const host = document.querySelector('[data-gi-ui="brain-completion"]');
    expect(host?.shadowRoot?.textContent).toContain('35k in revenue');
    expect(c.body.textContent).toBe('I used to have a paid community where I made');
    const insert = vi.fn(() => true); Object.defineProperty(document, 'execCommand', { configurable: true, value: insert });
    c.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(insert).toHaveBeenCalledWith('insertText', false, ' 35k in revenue.');
    expect(requests).toHaveLength(1);
  });
  it.each(['different words', 'recipient change', 'warning'])('drops an in-flight continuation after %s', async reason => {
    const c = compose(); let resolve!: (reply: BrainCheckReply) => void;
    const { deps } = brain(() => new Promise(done => { resolve = done; }));
    attachComposeBrainChecks(c.harness.view(), deps);
    c.type('I used to have a paid community'); caret(c.body); await settle();
    c.type(reason === 'different words' ? ' where I lost' : ' where I made'); caret(c.body);
    if (reason === 'recipient change') { c.harness.recipients = [{emailAddress:'someoneelse@example.test'}]; c.emit('recipientsChanged'); }
    resolve(reason === 'warning' ? { ...busy, completion: answer.completion } : answer);
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('[data-gi-ui="brain-completion"]')).toBeNull();
  });
  it('drops completion immediately on editing, selection movement or text-input composition', async () => {
    const c = compose(); const {deps} = brain(answer); attachComposeBrainChecks(c.harness.view(), deps);
    c.type('I used to have a paid community'); caret(c.body); await settle();
    c.body.dispatchEvent(new Event('compositionstart'));
    expect(document.querySelector('[data-gi-ui="brain-completion"]')).toBeNull();
    await settle(); c.body.dispatchEvent(new Event('compositionend')); await settle();
    c.type(' with paid members');
    expect(document.querySelector('[data-gi-ui="brain-completion"]')).toBeNull();
  });
  it('does not offer or accept a continuation away from the clause end', async () => {
    const c = compose(); const {deps, requests} = brain(answer); attachComposeBrainChecks(c.harness.view(), deps);
    c.type('I used to have a paid community');
    const range = document.createRange(); range.setStart(c.body.firstChild!, 4); range.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); await settle();
    expect(requests[0]).not.toHaveProperty('includeCompletion');
    expect(document.querySelector('[data-gi-ui="brain-completion"]')).toBeNull();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); c.body.dispatchEvent(tab); expect(tab.defaultPrevented).toBe(false);
  });
  it('checks multiple freshly pasted factual clauses instead of marking the unexamined ones seen', async () => {
    const c = compose(); const {deps, requests} = brain(none); attachComposeBrainChecks(c.harness.view(), deps);
    c.type("I have no meetings today. I already sent the proposal. The deadline is Friday.");
    await settle(); await vi.advanceTimersByTimeAsync(BRAIN_COOLDOWN_MS * 2 + 20);
    expect(new Set(requests.map(item => item.claim)).size).toBe(3);
  });
  it('retries an unavailable check without caching it as no advice, and cleans up on close', async () => {
    const c = compose(); let calls = 0;
    const {deps, requests} = brain(async () => ++calls === 1 ? { ok: true, status: 'unavailable' } : busy);
    attachComposeBrainChecks(c.harness.view(), deps); c.type("I'm free tomorrow at 3."); await settle();
    await vi.advanceTimersByTimeAsync(15_010); expect(requests).toHaveLength(2); expect(c.notice()).not.toBeNull();
    c.emit('destroy'); expect(document.querySelector('[data-gi-ui="brain-completion"]')).toBeNull();
  });
  it('allows an explicit current-phrase recheck of an existing draft', async () => {
    const c = compose([], 'I used to have a paid community'); const {deps, requests} = brain(answer);
    attachComposeBrainChecks(c.harness.view(), deps); caret(c.body);
    c.body.dispatchEvent(new KeyboardEvent('keydown', {code:'Space',key:' ',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
    await vi.advanceTimersByTimeAsync(10); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ includeCompletion: true });
  });
});
