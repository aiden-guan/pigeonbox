import { normalizeDraftId } from './tracking-session';

/**
 * Simulates the InboxSDK 2.2.26 compose send path that actually changes Gmail MIME.
 *
 * `registerRequestModifier` throws until `input[name=draft]` has an id, then stores
 * the modifier under that id. Page world later looks the modifier up by the draft id
 * on the sync SEND request and replaces `msg[8][1][0][1]` with the returned body.
 * The isolated-world listener is bound to the first draft id. Registering again
 * under a new id does not retarget that listener, so this harness will not invoke
 * a modifier bound to a different id — the send payload stays unchanged.
 *
 * Tests must assert on `deliverSend()`, which is the payload Gmail would store.
 */
export type HarnessModifier = (params: { body: string; isPlainText?: boolean }) => { body: string } | Promise<{ body: string }>;

type Listener = (event?: { cancel?: () => void; getMessageID?: () => Promise<string>; getThreadID?: () => Promise<string> }) => void;

export class GmailComposeSendHarness {
  draftId: string | null = null;
  subject = 'Hello';
  recipients: Array<{ emailAddress: string }> = [];
  cc: Array<{ emailAddress: string }> = [];
  bcc: Array<{ emailAddress: string }> = [];
  from = 'me@example.com';
  kind: 'new' | 'reply' | 'forward' = 'new';
  threadId: string | null = null;
  messageId: string | null = null;
  sendCalls = 0;
  readonly element: HTMLElement;
  private readonly modifiers = new Map<string, HarnessModifier[]>();
  private boundDraftId: string | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  private failRegistrations = 0;

  constructor(kind: 'new' | 'reply' | 'forward' = 'new') {
    this.kind = kind;
    this.element = document.createElement('div');
    const label = kind === 'reply' ? 'Reply' : kind === 'forward' ? 'Forward' : 'New Message';
    this.element.setAttribute('aria-label', label);
    this.element.id = `compose-${Math.random().toString(36).slice(2, 8)}`;
    const body = document.createElement('div');
    body.setAttribute('aria-label', 'Message Body');
    body.innerHTML = '<p>Hi</p>';
    this.element.append(body);
    const send = document.createElement('div');
    send.setAttribute('data-tooltip', 'Send');
    this.element.append(send);
    this.ensureDraftInput();
  }

  setDraftId(id: string | null): void {
    this.draftId = id ? normalizeDraftId(id) : null;
    this.ensureDraftInput().value = this.draftId ? `msg-a:${this.draftId}` : '';
  }

  /** Next registration attempts throw, the way InboxSDK does before a draft id exists. */
  failNextRegistrations(count: number): void {
    this.failRegistrations = count;
  }

  modifierCount(): number {
    let count = 0;
    for (const list of this.modifiers.values()) count += list.length;
    return count;
  }

  emit(
    event: string,
    payload?: { cancel?: () => void; getMessageID?: () => Promise<string>; getThreadID?: () => Promise<string> },
  ): void {
    for (const listener of this.listeners.get(event) || []) listener(payload);
  }

  /**
   * The body page world would write into the sync SEND request after modifiers run.
   * This is the stand-in for the HTML that ends up in Gmail's stored MIME.
   */
  async deliverSend(body: string, isPlainText = false): Promise<{ body: string; invoked: boolean }> {
    const draftId = this.draftId;
    const mods = draftId ? this.modifiers.get(draftId) || [] : [];
    if (!mods.length || !draftId) return { body, invoked: false };
    if (this.boundDraftId && this.boundDraftId !== draftId) return { body, invoked: false };
    let next = body;
    for (const modifier of mods) {
      const result = await modifier({ body: next, isPlainText });
      if (typeof result?.body === 'string') next = result.body;
    }
    return { body: next, invoked: true };
  }

  view(): {
    on: (event: string, cb: Listener) => void;
    send: () => void;
    registerRequestModifier: (modifier: HarnessModifier) => void;
    getSubject: () => string;
    getToRecipients: () => Array<{ emailAddress: string }>;
    getCcRecipients: () => Array<{ emailAddress: string }>;
    getBccRecipients: () => Array<{ emailAddress: string }>;
    getFromContact: () => { emailAddress: string };
    getElement: () => HTMLElement;
    getHTMLContent: () => string;
    getTextContent: () => string;
    getBodyElement: () => HTMLElement | null;
    getCurrentDraftID: () => Promise<string | null>;
    getDraftID: () => Promise<string | null>;
    isReply: () => boolean;
    isForward: () => boolean;
    getThreadID: () => string | null;
  } {
    return {
      on: (event, cb) => {
        const list = this.listeners.get(event) || [];
        list.push(cb);
        this.listeners.set(event, list);
      },
      send: () => {
        this.sendCalls += 1;
        this.emit('presending', {
          cancel: () => {
            /* The second pass must not cancel. Tests observe cancel on the first event. */
          },
        });
      },
      registerRequestModifier: (modifier) => {
        if (this.failRegistrations > 0) {
          this.failRegistrations -= 1;
          throw new Error('keyId should be set here');
        }
        const keyId = normalizeDraftId(this.ensureDraftInput().value);
        if (!keyId) throw new Error('keyId should be set here');
        const list = this.modifiers.get(keyId) || [];
        list.push(modifier);
        this.modifiers.set(keyId, list);
        if (!this.boundDraftId) this.boundDraftId = keyId;
      },
      getSubject: () => this.subject,
      getToRecipients: () => this.recipients,
      getCcRecipients: () => this.cc,
      getBccRecipients: () => this.bcc,
      getFromContact: () => ({ emailAddress: this.from }),
      getElement: () => this.element,
      getHTMLContent: () => this.element.querySelector('[aria-label="Message Body"]')?.innerHTML || '',
      getTextContent: () => this.element.querySelector('[aria-label="Message Body"]')?.textContent || '',
      getBodyElement: () => this.element.querySelector<HTMLElement>('[aria-label="Message Body"]'),
      getCurrentDraftID: async () => this.draftId,
      getDraftID: async () => this.draftId,
      isReply: () => this.kind === 'reply',
      isForward: () => this.kind === 'forward',
      getThreadID: () => this.threadId,
    };
  }

  private ensureDraftInput(): HTMLInputElement {
    const existing = this.element.querySelector('input[name="draft"]');
    if (existing instanceof HTMLInputElement) return existing;
    const input = document.createElement('input');
    input.name = 'draft';
    input.type = 'hidden';
    this.element.prepend(input);
    return input;
  }
}
