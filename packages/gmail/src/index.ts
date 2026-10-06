import type { GmailCapabilities } from '@pigeonbox/shared';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { MailboxEventBus } from './events.js';
import { GmailActionAdapter } from './GmailActionAdapter.js';
import {
  InboxSdkAdapter,
  type InboxSdkLike,
  type InboxSdkHooks,
  type ThreadViewLike,
  type MessageViewLike,
  type ComposeViewLike,
  type ThreadRowViewLike,
} from './InboxSdkAdapter.js';
import type { GmailAdapter, MailboxEventHandler, QueuedGmailAction } from './types.js';

export type CompositeGmailOptions = {
  inboxSdkAppId?: string;
  debounceMs?: number;
  hooks?: InboxSdkHooks;
  onThreadView?: (view: ThreadViewLike) => void | Promise<void>;
  onMessageView?: (view: MessageViewLike) => void | Promise<void>;
  onComposeView?: (view: ComposeViewLike) => void | Promise<void>;
  onThreadRowView?: (view: ThreadRowViewLike) => void | Promise<void>;
};

export type ActiveIntegration = 'inboxsdk' | 'dom';

/**
 * InboxSDK when it was bound before start, otherwise the DOM adapter.
 * The active integration is chosen once, at start, and is not swapped later.
 */
export class CompositeGmailAdapter implements GmailAdapter {
  readonly name = 'composite';
  readonly bus = new MailboxEventBus();
  readonly inboxSdk: InboxSdkAdapter;
  readonly dom: DomFallbackAdapter;
  readonly actions: GmailActionAdapter;

  private primary: GmailAdapter;
  private active: ActiveIntegration | null = null;
  private started = false;
  private caps: GmailCapabilities | null = null;

  constructor(opts: CompositeGmailOptions = {}) {
    this.inboxSdk = new InboxSdkAdapter(opts.inboxSdkAppId || '', {
      hooks: opts.hooks,
      onThreadView: opts.onThreadView,
      onMessageView: opts.onMessageView,
      onComposeView: opts.onComposeView,
      onThreadRowView: opts.onThreadRowView,
    });
    this.dom = new DomFallbackAdapter({ debounceMs: opts.debounceMs });
    this.primary = this.dom;
    this.actions = new GmailActionAdapter(this);
  }

  setHooks(hooks: Partial<InboxSdkHooks>): void {
    this.inboxSdk.setHooks(hooks);
  }

  getHooks(): InboxSdkHooks {
    return this.inboxSdk.getHooks();
  }

  /**
   * Must be called before start. Binding later does not retarget a running adapter.
   */
  bindInboxSdk(sdk: InboxSdkLike): boolean {
    if (this.started) return false;
    this.inboxSdk.bindSdk(sdk);
    return true;
  }

  getActiveIntegration(): ActiveIntegration | null {
    return this.active;
  }

  isStarted(): boolean {
    return this.started;
  }

  async detectCapabilities(): Promise<GmailCapabilities> {
    const [inbox, dom] = await Promise.all([
      this.inboxSdk.detectCapabilities(),
      this.dom.detectCapabilities(),
    ]);
    this.caps = {
      inboxSdkAvailable: Boolean(inbox.inboxSdkAvailable),
      gmailJsCaptureAvailable: false,
      backgroundWorkerTabAvailable: false,
      persistentNativeLabelMutationAvailable: false,
      domFallbackAvailable: Boolean(dom.domFallbackAvailable),
    };
    return this.caps;
  }

  getCapabilities(): GmailCapabilities | null {
    return this.caps;
  }

  async start(handler: MailboxEventHandler): Promise<void> {
    if (this.started) return;
    this.started = true;
    const wrapped: MailboxEventHandler = (event) => {
      this.bus.emit(event);
      handler(event);
    };
    try {
      await this.detectCapabilities();
      if (this.inboxSdk.isBound()) {
        this.active = 'inboxsdk';
        this.primary = this.inboxSdk;
        await this.inboxSdk.start(wrapped);
      } else {
        this.active = 'dom';
        this.primary = this.dom;
        await this.dom.start(wrapped);
      }
    } catch (error) {
      this.started = false;
      this.active = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.all([this.inboxSdk.stop(), this.dom.stop()]);
    this.started = false;
    this.active = null;
    this.primary = this.dom;
  }

  enqueue(action: QueuedGmailAction): string {
    return this.actions.enqueue(action);
  }

  async observeInbox() {
    return this.primary.observeInbox();
  }
  async observeNewMessages() {
    return this.primary.observeNewMessages();
  }
  async observeThreadOpened() {
    return this.primary.observeThreadOpened();
  }
  async observeCompose() {
    return this.primary.observeCompose();
  }
  async getVisibleThreadMetadata() {
    return this.primary.getVisibleThreadMetadata();
  }
  async getCurrentThread() {
    return this.primary.getCurrentThread();
  }
  async getCurrentCompose() {
    return this.primary.getCurrentCompose();
  }
  async openThread(threadId: string) {
    return this.primary.openThread(threadId);
  }
  async archiveThread(threadId: string) {
    return this.primary.archiveThread(threadId);
  }
  async markRead(threadId: string) {
    return this.primary.markRead(threadId);
  }
  async markUnread(threadId: string) {
    return this.primary.markUnread(threadId);
  }
  async starThread(threadId: string) {
    return this.primary.starThread(threadId);
  }
  async createReplyDraft(threadId: string) {
    return this.primary.createReplyDraft(threadId);
  }
  async insertComposeBody(text: string, target?: import('./types.js').ComposeHandle | { threadId?: string }, options?: import('./types.js').InsertComposeOptions) {
    return this.primary.insertComposeBody(text, target, options);
  }
  /** Only InboxSDK can open and fill a compose window reliably; callers fall back to Gmail's compose URL. */
  async openNewDraft(draft: import('./types.js').NewDraft) {
    if (this.active === 'inboxsdk') return this.inboxSdk.openNewDraft(draft);
    return { success: false, capability: 'openNewDraft', action: 'openNewDraft', reason: 'InboxSDK is not loaded', verified: false };
  }
  async navigateToSearch(query: string) {
    return this.primary.navigateToSearch(query);
  }
  async navigateToInbox() {
    return this.primary.navigateToInbox();
  }
  findThreadContainer(root: ParentNode, threadId?: string): HTMLElement | null {
    return this.dom.findThreadContainer(root, threadId);
  }
}

export * from './types.js';
export * from './capabilities.js';
export * from './events.js';
export * from './selectors.js';
export * from './thread-id.js';
export * from './normalize.js';
export * from './verify.js';
export * from './tab-selection.js';
export * from './DomFallbackAdapter.js';
export * from './InboxSdkAdapter.js';
export * from './GmailJsCaptureAdapter.js';
export * from './GmailActionAdapter.js';
export * from './WorkerTabController.js';
export * from './unsubscribe.js';
