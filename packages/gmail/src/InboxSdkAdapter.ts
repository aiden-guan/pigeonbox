import type { GmailActionResult, GmailCapabilities } from '@pigeonbox/shared';
import { EMPTY_CAPABILITIES } from './capabilities.js';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { queryFirst, SELECTORS } from './selectors.js';
import { resolveMessageId, resolveThreadId, type MessageIdView, type ThreadIdView } from './thread-id.js';
import type {
  ComposeHandle,
  ComposeViewState,
  CurrentThreadView,
  GmailAdapter,
  MailboxEvent,
  MailboxEventHandler,
  NewDraft,
  VisibleThreadRow,
} from './types.js';

export type InboxSdkHooks = {
  onThreadView?: (view: ThreadViewLike) => void | Promise<void>;
  onMessageView?: (view: MessageViewLike) => void | Promise<void>;
  onComposeView?: (view: ComposeViewLike) => void | Promise<void>;
  onThreadRowView?: (view: ThreadRowViewLike) => void | Promise<void>;
};

export type InboxSdkAdapterOptions = {
  rowDebounceMs?: number;
  hooks?: InboxSdkHooks;
  onThreadView?: (view: ThreadViewLike) => void | Promise<void>;
  onMessageView?: (view: MessageViewLike) => void | Promise<void>;
  onComposeView?: (view: ComposeViewLike) => void | Promise<void>;
  onThreadRowView?: (view: ThreadRowViewLike) => void | Promise<void>;
};

const SDK_STATE_KEY = Symbol.for('gi.inboxsdk.adapter.state');

type SdkRegistrationState = {
  registered: boolean;
  activeAdapter: InboxSdkAdapter | null;
};

const sdkRegistrationMap = new WeakMap<object, SdkRegistrationState>();

function getSdkRegistrationState(sdk: InboxSdkLike): SdkRegistrationState {
  const sdkObj = sdk as unknown as object;
  let state = (sdk as any)[SDK_STATE_KEY] as SdkRegistrationState | undefined;
  if (!state) {
    state = sdkRegistrationMap.get(sdkObj);
  }
  if (!state) {
    state = { registered: false, activeAdapter: null };
    try {
      (sdk as any)[SDK_STATE_KEY] = state;
    } catch {
      /* ignore if sdk is frozen */
    }
    sdkRegistrationMap.set(sdkObj, state);
  }
  return state;
}

/**
 * InboxSDK primary adapter.
 * Handlers register once per SDK instance. stop() invalidates them so a later start cannot double-fire.
 */
export class InboxSdkAdapter implements GmailAdapter {
  readonly name = 'inboxsdk';
  private sdk: InboxSdkLike | null = null;
  private handler: MailboxEventHandler | null = null;
  private readonly fallback = new DomFallbackAdapter();
  private generation = 0;
  private started = false;
  private rowTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRows = new Map<string, VisibleThreadRow>();
  private activeComposeView: unknown = null;
  private composeHandles = new Map<string, ComposeHandle>();
  private currentThread: CurrentThreadView | null = null;
  private hooks: InboxSdkHooks = {};

  constructor(
    private readonly appId: string,
    private readonly opts: InboxSdkAdapterOptions = {},
  ) {
    if (opts.hooks) {
      this.hooks = { ...opts.hooks };
    }
    if (opts.onThreadView) this.hooks.onThreadView = opts.onThreadView;
    if (opts.onMessageView) this.hooks.onMessageView = opts.onMessageView;
    if (opts.onComposeView) this.hooks.onComposeView = opts.onComposeView;
    if (opts.onThreadRowView) this.hooks.onThreadRowView = opts.onThreadRowView;
  }

  setHooks(hooks: Partial<InboxSdkHooks>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  getHooks(): InboxSdkHooks {
    return { ...this.hooks };
  }

  isBound(): boolean {
    return this.sdk != null;
  }

  async detectCapabilities(): Promise<GmailCapabilities> {
    return {
      ...EMPTY_CAPABILITIES,
      inboxSdkAvailable: this.isBound(),
      persistentNativeLabelMutationAvailable: false,
      domFallbackAvailable: true,
    };
  }

  bindSdk(sdk: InboxSdkLike): void {
    this.sdk = sdk;
    const state = getSdkRegistrationState(sdk);
    state.activeAdapter = this;
  }

  async start(handler: MailboxEventHandler): Promise<void> {
    if (this.started) return;
    this.handler = handler;
    this.started = true;
    const generation = ++this.generation;

    if (!this.sdk) {
      await this.fallback.start((event) => {
        if (generation !== this.generation || !this.handler || !this.started) return;
        this.handler(event);
      });
      this.emit({
        type: 'CAPABILITY_CHANGED',
        capabilities: await this.detectCapabilities(),
        at: Date.now(),
      });
      return;
    }

    const sdk = this.sdk;
    this.ensureSdkRegistered(sdk);

    this.emit({
      type: 'CAPABILITY_CHANGED',
      capabilities: await this.detectCapabilities(),
      at: Date.now(),
    });
  }

  private emit(event: MailboxEvent): void {
    if (!this.started || !this.handler) return;
    this.handler(event);
  }

  private ensureSdkRegistered(sdk: InboxSdkLike): void {
    const state = getSdkRegistrationState(sdk);
    state.activeAdapter = this;

    if (state.registered) {
      return;
    }
    state.registered = true;

    try {
      sdk.Router?.handleAllRoutes((routeView) => {
        const currentAdapter = getSdkRegistrationState(sdk).activeAdapter;
        currentAdapter?.handleRouteView(routeView);
      });
    } catch {
      /* degrade */
    }

    try {
      sdk.Conversations?.registerThreadViewHandler((threadView) => {
        const currentAdapter = getSdkRegistrationState(sdk).activeAdapter;
        currentAdapter?.handleThreadView(threadView);
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Conversations?.registerMessageViewHandler?.((messageView) => {
        const currentAdapter = getSdkRegistrationState(sdk).activeAdapter;
        currentAdapter?.handleMessageView(messageView);
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Compose?.registerComposeViewHandler((composeView) => {
        const currentAdapter = getSdkRegistrationState(sdk).activeAdapter;
        currentAdapter?.handleComposeView(composeView);
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Lists?.registerThreadRowViewHandler((rowView) => {
        const currentAdapter = getSdkRegistrationState(sdk).activeAdapter;
        currentAdapter?.handleThreadRowView(rowView);
      });
    } catch {
      /* ignore */
    }
  }

  private handleRouteView(routeView: { getRouteType?: () => string }): void {
    if (!this.started) return;
    const rawType = (routeView.getRouteType?.() || '').toLowerCase();
    const mapped = mapRoute(rawType);
    const isThreadRoute = rawType.includes('thread');
    if (!isThreadRoute && (mapped !== 'unknown' || rawType.includes('list'))) {
      this.currentThread = null;
    }
    this.emit({
      type: 'ROUTE_CHANGED',
      route: mapped,
      at: Date.now(),
    });
  }

  private handleThreadView(threadView: ThreadViewLike): void {
    if (!this.started) return;

    try {
      const res = this.hooks.onThreadView?.(threadView);
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch((error) => {
          console.warn('[gi] onThreadView hook error', error);
        });
      }
    } catch (error) {
      console.warn('[gi] onThreadView hook error', error);
    }

    let destroyed = false;
    const generation = this.generation;
    const threadIdPromise = resolveThreadId(threadView);

    const attachMessageListeners = () => {
      const mvs = threadView.getMessageViewsAll?.() || threadView.getMessageViews?.() || [];
      for (const mv of mvs) {
        mv.on?.('load', () => {
          if (generation !== this.generation || destroyed || !this.started) return;
          void mapThreadView(threadView)
            .then((thread) => {
              if (thread && generation === this.generation && !destroyed && this.started) {
                this.currentThread = thread;
                this.emit({ type: 'THREAD_DATA_UPDATED', thread, at: Date.now() });
              }
            })
            .catch(() => {});
        });
      }
    };
    attachMessageListeners();

    threadView.on?.('destroy', () => {
      destroyed = true;
      if (generation !== this.generation) return;
      void threadIdPromise.then((tid) => {
        if (generation === this.generation && tid && this.currentThread?.threadId === tid) {
          this.currentThread = null;
        }
      });
    });

    void mapThreadView(threadView)
      .then((thread) => {
        if (thread && generation === this.generation && !destroyed && this.started) {
          this.currentThread = thread;
          this.emit({ type: 'THREAD_OPENED', thread, at: Date.now() });
        }
      })
      .catch((error) => {
        console.warn('[gi] Failed to map thread view', error);
      });
  }

  private handleMessageView(messageView: MessageViewLike): void {
    if (!this.started) return;

    try {
      const res = this.hooks.onMessageView?.(messageView);
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch((error) => {
          console.warn('[gi] onMessageView hook error', error);
        });
      }
    } catch (error) {
      console.warn('[gi] onMessageView hook error', error);
    }

    const generation = this.generation;
    const threadView = messageView.getThreadView?.();
    if (threadView) {
      void mapThreadView(threadView)
        .then((thread) => {
          if (thread && generation === this.generation && this.started) {
            if (!this.currentThread || this.currentThread.threadId === thread.threadId) {
              this.currentThread = thread;
              this.emit({ type: 'THREAD_DATA_UPDATED', thread, at: Date.now() });
            }
          }
        })
        .catch(() => {});
    }
  }

  private handleComposeView(composeView: ComposeViewLike): void {
    if (!this.started) return;

    try {
      const res = this.hooks.onComposeView?.(composeView);
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch((error) => {
          console.warn('[gi] onComposeView hook error', error);
        });
      }
    } catch (error) {
      console.warn('[gi] onComposeView hook error', error);
    }

    this.activeComposeView = composeView;
    const composeId = `compose-${Math.random().toString(36).slice(2, 8)}`;
    const handle: ComposeHandle = {
      id: composeId,
      threadId: undefined,
      isReply: false,
      view: composeView,
      element: composeView.getElement?.() || null,
    };
    this.composeHandles.set(composeId, handle);

    composeView.on?.('destroy', () => {
      this.composeHandles.delete(composeId);
      if (this.activeComposeView === composeView) {
        this.activeComposeView = null;
      }
    });

    void resolveThreadId(composeView as ThreadIdView).then((tid) => {
      if (tid) {
        handle.threadId = tid;
        handle.isReply = true;
      }
    });

    const generation = this.generation;
    void mapCompose(composeView)
      .then((compose) => {
        if (compose.threadId) {
          handle.threadId = compose.threadId;
          handle.isReply = compose.isReply;
        }
        if (generation === this.generation && this.started) {
          this.emit({ type: 'COMPOSE_OPENED', compose, at: Date.now() });
        }
        composeView.on?.('sent', () => {
          if (generation === this.generation && this.started) {
            this.emit({ type: 'COMPOSE_SENT', compose, at: Date.now() });
          }
        });
      })
      .catch((error) => {
        console.warn('[gi] Failed to map compose view', error);
      });
  }

  private handleThreadRowView(rowView: ThreadRowViewLike): void {
    if (!this.started) return;

    try {
      const res = this.hooks.onThreadRowView?.(rowView);
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch((error) => {
          console.warn('[gi] onThreadRowView hook error', error);
        });
      }
    } catch (error) {
      console.warn('[gi] onThreadRowView hook error', error);
    }

    const generation = this.generation;
    void mapRow(rowView).then((row) => {
      if (!row || generation !== this.generation || !this.started) return;
      this.pendingRows.set(row.threadId, row);
      if (this.rowTimer) clearTimeout(this.rowTimer);
      this.rowTimer = setTimeout(() => {
        const rows = [...this.pendingRows.values()];
        this.pendingRows.clear();
        this.emit({ type: 'VISIBLE_ROWS_CHANGED', rows, at: Date.now() });
      }, this.opts.rowDebounceMs ?? 200);
    });
  }

  async stop(): Promise<void> {
    this.generation += 1;
    if (this.rowTimer) clearTimeout(this.rowTimer);
    this.rowTimer = null;
    this.pendingRows.clear();
    this.currentThread = null;
    this.activeComposeView = null;
    this.composeHandles.clear();
    this.started = false;
    await this.fallback.stop();
    this.handler = null;
  }

  isStarted(): boolean {
    return this.started;
  }

  async observeInbox() {
    return this.fallback.observeInbox();
  }
  async observeNewMessages() {
    return ok('observeNewMessages');
  }
  async observeThreadOpened() {
    return ok('observeThreadOpened');
  }
  async observeCompose() {
    return ok('observeCompose');
  }
  async getVisibleThreadMetadata() {
    return this.fallback.getVisibleThreadMetadata();
  }
  async getCurrentThread() {
    if (this.currentThread) {
      return { ...ok('getCurrentThread'), thread: this.currentThread };
    }
    return this.fallback.getCurrentThread();
  }
  async getCurrentCompose() {
    return this.fallback.getCurrentCompose();
  }

  async openThread(threadId: string) {
    if (!this.sdk) return this.fallback.openThread(threadId);
    try {
      await Promise.resolve(this.sdk.Router.goto?.(`#inbox/${threadId}`));
      return { ...ok('openThread'), threadId, verified: false };
    } catch (error) {
      return fail('openThread', String(error));
    }
  }

  async archiveThread(threadId: string) {
    return this.fallback.archiveThread(threadId);
  }
  async markRead(threadId: string) {
    return this.fallback.markRead(threadId);
  }
  async markUnread(threadId: string) {
    return this.fallback.markUnread(threadId);
  }
  async starThread(threadId: string) {
    return this.fallback.starThread(threadId);
  }
  async createReplyDraft(threadId: string): Promise<GmailActionResult & { composeHandle?: ComposeHandle }> {
    // 1. Check if a compose handle already exists for this thread's reply
    for (const handle of this.composeHandles.values()) {
      if (handle.threadId === threadId && handle.isReply) {
        return { ...ok('createReplyDraft'), threadId, composeHandle: handle };
      }
    }

    // 2. Trigger reply via fallback (scoped to the thread)
    const fallbackRes = await this.fallback.createReplyDraft(threadId);

    // 3. Check composeHandles
    for (const handle of this.composeHandles.values()) {
      if (handle.threadId === threadId && handle.isReply) {
        return { ...ok('createReplyDraft'), threadId, composeHandle: handle };
      }
    }

    return fallbackRes;
  }

  async insertComposeBody(text: string, target?: ComposeHandle | { threadId?: string }) {
    let targetHandle: ComposeHandle | undefined;

    if (target && 'view' in target && target.view) {
      targetHandle = target as ComposeHandle;
    } else if (target && target.threadId) {
      for (const handle of this.composeHandles.values()) {
        if (handle.threadId === target.threadId && handle.isReply) {
          targetHandle = handle;
          break;
        }
      }
    }

    if (!targetHandle && !target?.threadId && this.composeHandles.size === 1) {
      const only = [...this.composeHandles.values()][0];
      if (only.isReply) targetHandle = only;
    }

    const view = targetHandle?.view as {
      setBodyHTML?: (html: string) => void;
      setBodyText?: (text: string) => void;
      insertTextIntoBodyAtCursor?: (text: string) => void;
    } | null;

    if (view) {
      try {
        // setBodyText assigns textContent, which collapses every line break.
        if (typeof view.setBodyHTML === 'function') {
          view.setBodyHTML(textToComposeHtml(text));
          return { ...ok('insertComposeBody'), verified: true, reason: 'Inserted via InboxSDK' };
        }
        if (typeof view.setBodyText === 'function') {
          view.setBodyText(text);
          return { ...ok('insertComposeBody'), verified: true, reason: 'Inserted via InboxSDK' };
        }
        if (typeof view.insertTextIntoBodyAtCursor === 'function') {
          view.insertTextIntoBodyAtCursor(text);
          return { ...ok('insertComposeBody'), verified: true, reason: 'Inserted via InboxSDK' };
        }
      } catch {
        /* fall back to DOM */
      }
    }
    return this.fallback.insertComposeBody(text, targetHandle || target);
  }
  /** Opens a fresh compose window and fills it in. Never sends. */
  async openNewDraft(draft: NewDraft): Promise<GmailActionResult> {
    const compose = this.sdk?.Compose;
    if (!compose?.openNewComposeView) return fail('openNewDraft', 'InboxSDK compose is not available');
    try {
      const view = await compose.openNewComposeView();
      if (!view) return fail('openNewDraft', 'Gmail did not open a compose window');
      if (draft.to.length) view.setToRecipients?.(draft.to.map((contact) => contact.email));
      if (draft.cc?.length) view.setCcRecipients?.(draft.cc.map((contact) => contact.email));
      if (draft.subject) view.setSubject?.(draft.subject);
      if (draft.body) {
        // setBodyText assigns textContent, which collapses every line break.
        if (view.setBodyHTML) view.setBodyHTML(textToComposeHtml(draft.body));
        else view.insertTextIntoBodyAtCursor?.(draft.body);
      }
      return { ...ok('openNewDraft'), verified: true, reason: 'Opened a new draft' };
    } catch (error) {
      return fail('openNewDraft', String(error));
    }
  }

  async navigateToSearch(query: string) {
    if (this.sdk?.Router?.goto) {
      try {
        await Promise.resolve(this.sdk.Router.goto(`#search/${encodeURIComponent(query)}`));
        return ok('navigateToSearch');
      } catch {
        /* fall through */
      }
    }
    return this.fallback.navigateToSearch(query);
  }
  async navigateToInbox() {
    if (this.sdk?.Router?.goto) {
      try {
        await Promise.resolve(this.sdk.Router.goto('#inbox'));
        return ok('navigateToInbox');
      } catch {
        /* fall through */
      }
    }
    return this.fallback.navigateToInbox();
  }

  addRowLabel(
    rowView: { addLabel?: (desc: { title: string; foregroundColor?: string; backgroundColor?: string }) => void },
    title: string,
    colors: { fg: string; bg: string },
  ): boolean {
    if (!rowView.addLabel) return false;
    try {
      rowView.addLabel({ title, foregroundColor: colors.fg, backgroundColor: colors.bg });
      return true;
    } catch {
      return false;
    }
  }
}

function ok(capability: string): GmailActionResult {
  return { success: true, capability, action: capability, verified: false };
}
function fail(capability: string, error: string, retryable = true): GmailActionResult {
  return { success: false, capability, action: capability, error, reason: error, retryable, verified: false };
}

function mapRoute(value: string): CurrentThreadView['route'] {
  const route = value.toLowerCase();
  if (route.includes('inbox')) return 'inbox';
  if (route.includes('sent')) return 'sent';
  if (route.includes('draft')) return 'drafts';
  if (route.includes('search')) return 'search';
  if (route.includes('star')) return 'starred';
  return 'unknown';
}

async function mapRow(rowView: ThreadRowViewLike): Promise<VisibleThreadRow | null> {
  const threadId = await resolveThreadId(rowView);
  if (!threadId) return null;
  const element = rowView.getElement?.() || null;
  const subjectEl = element ? queryFirst(element, SELECTORS.threadRowSubject) : null;
  const snippetEl = element ? queryFirst(element, SELECTORS.threadRowSnippet) : null;
  const senderEl = element ? queryFirst(element, SELECTORS.threadRowSender) : null;
  const contact = rowView.getContacts?.()?.find((item) => item.emailAddress);
  const email = senderEl?.getAttribute('email') || contact?.emailAddress;
  const sender = email
    ? { email, name: senderEl?.textContent?.trim() || contact?.name }
    : undefined;
  if (element) element.setAttribute('data-gi-thread-id', threadId);
  return {
    threadId,
    subject: rowView.getSubject?.() || subjectEl?.textContent?.trim() || '',
    snippet: snippetEl?.textContent?.trim() || '',
    participants: sender ? [sender] : [],
    latestSender: sender,
    unread: Boolean(element?.classList.contains('zE')),
    starred: Boolean(element?.querySelector('[aria-label="Starred"]')),
    labels: [],
  };
}

async function mapThreadView(view: ThreadViewLike): Promise<CurrentThreadView | null> {
  const threadId = await resolveThreadId(view);
  if (!threadId) return null;
  const subject = view.getSubject?.() || '';
  const messageViews = view.getMessageViewsAll?.() || view.getMessageViews?.() || [];
  const messages = await Promise.all(
    messageViews.map(async (message, index) => {
      const isLoaded = typeof message.isLoaded === 'function' ? message.isLoaded() : true;
      let messageId: string | null = null;
      let senderEmail = 'unknown@local';
      let senderName: string | undefined;
      let recipients: Array<{ email: string }> = [];
      let bodyText = '';

      if (isLoaded) {
        messageId = await resolveMessageId(message);
        try {
          const sender = message.getSender?.();
          if (sender?.emailAddress) senderEmail = sender.emailAddress;
          if (sender?.name) senderName = sender.name;
        } catch {
          /* message may not be fully loaded in DOM */
        }
        try {
          recipients = (message.getRecipientEmailAddresses?.() || []).map((email) => ({ email }));
        } catch {
          /* recipient list in flux */
        }
        try {
          bodyText = message.getBodyElement?.()?.textContent?.trim() || '';
        } catch {
          /* body element in flux */
        }
      }

      return {
        messageId: messageId || `${threadId}-msg-${index}`,
        threadId,
        sender: {
          email: senderEmail,
          name: senderName,
        },
        recipients,
        cc: [],
        bodyText,
        attachmentsMetadata: [],
        loaded: isLoaded,
      };
    }),
  );

  return {
    threadId,
    subject,
    route: 'unknown',
    messages,
  };
}

async function mapCompose(view: ComposeViewLike): Promise<ComposeViewState> {
  const threadId = await resolveThreadId(view as ThreadIdView);
  let to: Array<{ email: string; name?: string }> = [];
  let cc: Array<{ email: string; name?: string }> = [];
  let bcc: Array<{ email: string; name?: string }> = [];
  try {
    to = (view.getToRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    }));
  } catch {
    /* compose recipient DOM in flux */
  }
  try {
    cc = (view.getCcRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    }));
  } catch {
    /* compose cc DOM in flux */
  }
  try {
    bcc = (view.getBccRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    }));
  } catch {
    /* compose bcc DOM in flux */
  }
  return {
    composeId: threadId || view.getElement?.()?.id || `compose-${Math.random().toString(36).slice(2, 8)}`,
    to,
    cc,
    bcc,
    subject: view.getSubject?.() || '',
    bodyText: view.getBodyElement?.()?.textContent || '',
    isReply: Boolean(threadId),
    threadId: threadId || undefined,
  };
}

export type InboxSdkLike = {
  Router: {
    handleAllRoutes: (cb: (rv: { getRouteType?: () => string }) => void) => void;
    goto?: (path: string) => void | Promise<void>;
  };
  Conversations: {
    registerThreadViewHandler: (cb: (tv: ThreadViewLike) => void) => void;
    registerMessageViewHandler?: (cb: (mv: MessageViewLike) => void) => void;
  };
  Compose: {
    registerComposeViewHandler: (cb: (cv: ComposeViewLike) => void) => void;
    openNewComposeView?: () => Promise<ComposeViewLike | null | undefined>;
  };
  Lists: {
    registerThreadRowViewHandler: (cb: (rv: ThreadRowViewLike) => void) => void;
  };
  NavMenu?: {
    addNavItem: (desc: unknown) => unknown;
  };
};

export type ThreadRowViewLike = ThreadIdView & {
  getSubject?: () => string;
  isSelected?: () => boolean;
  getElement?: () => HTMLElement;
  getContacts?: () => Array<{ emailAddress?: string; name?: string }>;
  addLabel?: (d: { title: string; foregroundColor?: string; backgroundColor?: string }) => void;
};

export type ThreadViewLike = ThreadIdView & {
  getSubject?: () => string;
  getMessageViews?: () => MessageViewLike[];
  getMessageViewsAll?: () => MessageViewLike[];
  addSidebarContentPanel?: (desc: unknown) => { remove?: () => void };
  on?: (event: string, cb: () => void) => void;
};

export type MessageViewLike = MessageIdView & {
  isLoaded?: () => boolean;
  getMessageID?: () => string;
  getMessageIDAsync?: () => string | Promise<string>;
  getSender?: () => { name?: string; emailAddress: string };
  getRecipientEmailAddresses?: () => string[];
  getBodyElement?: () => HTMLElement | null;
  getThreadView?: () => ThreadViewLike;
  on?: (event: string, cb: () => void) => void;
};

export type ComposeViewLike = ThreadIdView & {
  getToRecipients?: () => { emailAddress: string; name?: string }[];
  getCcRecipients?: () => { emailAddress: string; name?: string }[];
  getBccRecipients?: () => { emailAddress: string; name?: string }[];
  getSubject?: () => string;
  getBodyElement?: () => HTMLElement | null;
  getElement?: () => HTMLElement;
  on?: (event: string, cb: () => void) => void;
  insertTextIntoBodyAtCursor?: (text: string) => void;
  setToRecipients?: (emails: string[]) => void;
  setCcRecipients?: (emails: string[]) => void;
  setSubject?: (subject: string) => void;
  setBodyHTML?: (html: string) => void;
};

/** Plain text as Gmail compose markup: one div per line, an empty line as <div><br></div>. */
export function textToComposeHtml(text: string): string {
  const escape = (line: string) =>
    line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? `<div>${escape(line)}</div>` : '<div><br></div>'))
    .join('');
}
