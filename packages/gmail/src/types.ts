import type { Contact, GmailActionResult, GmailCapabilities } from '@pigeonbox/shared';

export type ThreadRoute =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'starred'
  | 'spam'
  | 'trash'
  | 'search'
  | 'custom'
  | 'unknown';

export type VisibleThreadRow = {
  threadId: string;
  subject: string;
  snippet: string;
  participants: Contact[];
  latestSender?: Contact;
  latestTimestamp?: string;
  unread: boolean;
  starred: boolean;
  labels: string[];
  messageCount?: number;
};

export type ThreadMessageView = {
  messageId: string;
  threadId: string;
  sender: Contact;
  recipients: Contact[];
  cc: Contact[];
  /** Present only when Gmail exposed a real timestamp. Never a generated clock reading. */
  timestamp?: string;
  bodyText: string;
  bodyHtml?: string;
  attachmentsMetadata: { filename: string; mimeType?: string; sizeBytes?: number }[];
  loaded?: boolean;
};

export type CurrentThreadView = {
  threadId: string;
  subject: string;
  messages: ThreadMessageView[];
  route: ThreadRoute;
};

export type ComposeViewState = {
  composeId: string;
  to: Contact[];
  cc: Contact[];
  bcc: Contact[];
  subject: string;
  bodyText: string;
  isReply: boolean;
  threadId?: string;
};

export type ComposeHandle = {
  id: string;
  threadId?: string;
  isReply: boolean;
  view?: unknown;
  element?: HTMLElement | null;
};

/** A new email to open in Gmail's compose window. */
export type NewDraft = {
  to: Contact[];
  cc?: Contact[];
  subject: string;
  body: string;
};

export type MailboxEvent =
  | { type: 'VISIBLE_ROWS_CHANGED'; rows: VisibleThreadRow[]; at: number }
  | { type: 'MESSAGE_ARRIVED'; row: VisibleThreadRow; at: number }
  | { type: 'THREAD_OPENED'; thread: CurrentThreadView; at: number }
  | { type: 'THREAD_DATA_UPDATED'; thread: CurrentThreadView; at: number }
  | { type: 'COMPOSE_OPENED'; compose: ComposeViewState; at: number }
  | { type: 'COMPOSE_SENT'; compose: ComposeViewState; at: number }
  | { type: 'ROUTE_CHANGED'; route: ThreadRoute; query?: string; at: number }
  | { type: 'CAPABILITY_CHANGED'; capabilities: GmailCapabilities; at: number };

export type MailboxEventHandler = (event: MailboxEvent) => void;

export interface GmailAdapter {
  readonly name: string;
  detectCapabilities(): Promise<GmailCapabilities>;
  start(handler: MailboxEventHandler): Promise<void>;
  stop(): Promise<void>;

  observeInbox(): Promise<GmailActionResult & { rows?: VisibleThreadRow[] }>;
  observeNewMessages(): Promise<GmailActionResult>;
  observeThreadOpened(): Promise<GmailActionResult>;
  observeCompose(): Promise<GmailActionResult>;

  getVisibleThreadMetadata(): Promise<GmailActionResult & { rows?: VisibleThreadRow[] }>;
  getCurrentThread(): Promise<GmailActionResult & { thread?: CurrentThreadView }>;
  getCurrentCompose(): Promise<GmailActionResult & { compose?: ComposeViewState }>;

  openThread(threadId: string): Promise<GmailActionResult>;
  archiveThread(threadId: string): Promise<GmailActionResult>;
  markRead(threadId: string): Promise<GmailActionResult>;
  markUnread(threadId: string): Promise<GmailActionResult>;
  starThread(threadId: string): Promise<GmailActionResult>;
  createReplyDraft(threadId: string): Promise<GmailActionResult & { composeHandle?: ComposeHandle }>;
  insertComposeBody(text: string, target?: ComposeHandle | { threadId?: string }): Promise<GmailActionResult>;
  navigateToSearch(query: string): Promise<GmailActionResult>;
  navigateToInbox(): Promise<GmailActionResult>;
}

export type QueuedGmailAction =
  | { kind: 'ARCHIVE_THREAD'; threadId: string }
  | { kind: 'MARK_READ'; threadId: string }
  | { kind: 'MARK_UNREAD'; threadId: string }
  | { kind: 'STAR'; threadId: string }
  | { kind: 'OPEN_THREAD'; threadId: string }
  | { kind: 'CREATE_REPLY_DRAFT'; threadId: string }
  | { kind: 'INSERT_COMPOSE_BODY'; text: string }
  | { kind: 'NAVIGATE_SEARCH'; query: string }
  | { kind: 'NAVIGATE_INBOX' };
