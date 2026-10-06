import type { GmailActionResult, GmailCapabilities } from '@pigeonbox/shared';
import { EMPTY_CAPABILITIES } from './capabilities.js';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import type {
  GmailAdapter,
  MailboxEventHandler,
  ThreadMessageView,
} from './types.js';

/**
 * Optional Gmail.js capture adapter.
 * Gmail.js MUST run in MAIN world (not content script). This adapter only
 * consumes sanitized events forwarded via the bridge — it never trusts raw
 * page payloads without validation at the content-script boundary.
 *
 * Degrades if Gmail.js methods break; never the sole source of truth.
 */
export class GmailJsCaptureAdapter implements GmailAdapter {
  readonly name = 'gmail-js-capture';
  private available = false;
  private handler: MailboxEventHandler | null = null;
  private fallback = new DomFallbackAdapter();
  private cachedMessages = new Map<string, ThreadMessageView[]>();

  markAvailable(available: boolean): void {
    this.available = available;
  }

  /** Ingest a validated bridge event from MAIN world. */
  ingestValidatedCapture(event: {
    type: string;
    threadId?: string;
    messageId?: string;
    subject?: string;
    bodyText?: string;
    senderEmail?: string;
    recipients?: string[];
    timestamp?: string;
  }): void {
    if (!this.handler) return;
    if (event.type === 'email_data' && event.threadId && event.messageId) {
      const msg: ThreadMessageView = {
        messageId: event.messageId,
        threadId: event.threadId,
        sender: { email: event.senderEmail || 'unknown@local' },
        recipients: (event.recipients || []).map((e) => ({ email: e })),
        cc: [],
        timestamp: event.timestamp,
        bodyText: event.bodyText || '',
        attachmentsMetadata: [],
      };
      const list = this.cachedMessages.get(event.threadId) || [];
      if (!list.some((m) => m.messageId === msg.messageId)) {
        list.push(msg);
        this.cachedMessages.set(event.threadId, list);
      }
      this.handler({
        type: 'THREAD_OPENED',
        thread: {
          threadId: event.threadId,
          subject: event.subject || '',
          messages: list,
          route: 'unknown',
        },
        at: Date.now(),
      });
    }
  }

  getCachedMessages(threadId: string): ThreadMessageView[] {
    return this.cachedMessages.get(threadId) || [];
  }

  async detectCapabilities(): Promise<GmailCapabilities> {
    return {
      ...EMPTY_CAPABILITIES,
      gmailJsCaptureAvailable: this.available,
      domFallbackAvailable: true,
      persistentNativeLabelMutationAvailable: false,
    };
  }

  async start(handler: MailboxEventHandler): Promise<void> {
    this.handler = handler;
    if (!this.available) {
      await this.fallback.start(handler);
    }
    handler({
      type: 'CAPABILITY_CHANGED',
      capabilities: await this.detectCapabilities(),
      at: Date.now(),
    });
  }

  async stop(): Promise<void> {
    await this.fallback.stop();
    this.handler = null;
  }

  async observeInbox() {
    return this.fallback.observeInbox();
  }
  async observeNewMessages() {
    return { success: true, capability: 'observeNewMessages' };
  }
  async observeThreadOpened() {
    return { success: true, capability: 'observeThreadOpened' };
  }
  async observeCompose() {
    return { success: true, capability: 'observeCompose' };
  }
  async getVisibleThreadMetadata() {
    return this.fallback.getVisibleThreadMetadata();
  }
  async getCurrentThread() {
    const base = await this.fallback.getCurrentThread();
    if (base.success && 'thread' in base && base.thread) {
      const cached = this.getCachedMessages(base.thread.threadId);
      if (cached.length) {
        return {
          ...base,
          thread: { ...base.thread, messages: cached },
        };
      }
    }
    return base;
  }
  async getCurrentCompose() {
    return this.fallback.getCurrentCompose();
  }
  async openThread(threadId: string) {
    return this.fallback.openThread(threadId);
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
  async createReplyDraft(threadId: string) {
    return this.fallback.createReplyDraft(threadId);
  }
  async insertComposeBody(text: string, target?: import('./types.js').ComposeHandle | { threadId?: string }) {
    // The DOM path always inserts at the top and keeps what is already there.
    return this.fallback.insertComposeBody(text, target);
  }
  async navigateToSearch(query: string) {
    return this.fallback.navigateToSearch(query);
  }
  async navigateToInbox() {
    return this.fallback.navigateToInbox();
  }
}

export function validateGmailJsBridgePayload(raw: unknown): {
  ok: true;
  data: {
    type: string;
    threadId?: string;
    messageId?: string;
    subject?: string;
    bodyText?: string;
    senderEmail?: string;
    recipients?: string[];
    timestamp?: string;
  };
} | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not object' };
  const o = raw as Record<string, unknown>;
  if (typeof o.type !== 'string' || o.type.length > 64) {
    return { ok: false, error: 'bad type' };
  }
  const str = (k: string) =>
    typeof o[k] === 'string' ? (o[k] as string).slice(0, 50_000) : undefined;
  const recipients = Array.isArray(o.recipients)
    ? o.recipients.filter((x): x is string => typeof x === 'string').slice(0, 50)
    : undefined;
  return {
    ok: true,
    data: {
      type: o.type,
      threadId: str('threadId'),
      messageId: str('messageId'),
      subject: str('subject'),
      bodyText: str('bodyText'),
      senderEmail: str('senderEmail'),
      recipients,
      timestamp: str('timestamp'),
    },
  };
}

// silence unused import when tree-shaken in node tests
void (0 as unknown as GmailActionResult);
