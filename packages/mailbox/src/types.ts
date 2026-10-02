import type {
  Contact,
  DraftSuggestion,
  Priority,
  ThreadCategory,
  ThreadDataQuality,
  ThreadDataSource,
  ThreadSummary,
} from '@pigeonbox/shared';

/**
 * MailboxSource seam — V1 is GmailWebSource.
 * FutureImapSource may implement this later; do NOT build IMAP in V1.
 */
export interface MailboxSource {
  readonly kind: 'gmail-web' | 'future-imap';
  observeVisibleThreads(): Promise<IngestThread[]>;
  observeCurrentThread(): Promise<IngestThread | null>;
}

export type IngestThread = {
  mailboxEmail?: string;
  threadId: string;
  subject: string;
  participants: Contact[];
  latestSender?: Contact;
  latestTimestamp?: string;
  messageCount: number;
  snippet: string;
  route: string;
  messages: IngestMessage[];
  quality?: ThreadDataQuality;
  source?: ThreadDataSource;
};

export type IngestMessage = {
  messageId: string;
  threadId: string;
  sender: Contact;
  recipients: Contact[];
  cc: Contact[];
  timestamp?: string;
  bodyText: string;
  bodyHtml?: string;
  attachmentsMetadata: { filename: string; mimeType?: string; sizeBytes?: number }[];
};

export type AccountRow = {
  id: string;
  email: string;
  displayName?: string;
  createdAt: number;
};

export type ThreadRow = {
  mailboxEmail?: string;
  threadId: string;
  accountId: string;
  subject: string;
  participants: Contact[];
  latestSender?: Contact;
  latestTimestamp: string;
  messageCount: number;
  snippet: string;
  route: string;
  /** Seen in Gmail's Sent folder at least once. `route` only keeps the latest view. */
  seenInSent?: boolean;
  quality?: ThreadDataQuality;
  source?: ThreadDataSource;
  manualCategory?: ThreadCategory;
  lastIndexedAt: number;
  contentFingerprint: string;
  classification?: ThreadCategory;
  classificationConfidence?: number;
  priority?: Priority;
  archivedLocally: boolean;
  requiresResponse: boolean;
  awaitingResponse: boolean;
  virtualLabels: string[];
};

export type MessageRow = {
  messageId: string;
  threadId: string;
  accountId: string;
  sender: Contact;
  recipients: Contact[];
  cc: Contact[];
  timestamp: string;
  bodyText: string;
  bodyHtml?: string;
  attachmentsMetadata: { filename: string; mimeType?: string; sizeBytes?: number }[];
  fingerprint: string;
};

export type ContactRow = {
  email: string;
  accountId: string;
  name?: string;
  lastSeenAt: number;
  messageCount: number;
};

export type ClassificationRow = {
  threadId: string;
  category: ThreadCategory;
  confidence: number;
  priority: Priority;
  needsReply: boolean;
  waitingOnReply: boolean;
  archiveRecommendation: boolean;
  reason: string;
  deadline?: string | null;
  source: 'rule' | 'heuristic' | 'ai' | 'override';
  fingerprint: string;
  createdAt: number;
};

export type SummaryRow = {
  /** Owner perspective that produced this summary; legacy ownerless rows are not reused. */
  ownerPerspective?: string;
  sourceFingerprint?: string;
  generationId?: string;
  threadId: string;
  fingerprint: string;
  summary: ThreadSummary;
  createdAt: number;
  /** `message` is read from the open email. A later model result can replace it. */
  source?: 'model' | 'message';
  aiStatus?: 'queued' | 'running' | 'success' | 'failed';
  aiError?: string;
  provider?: string;
  model?: string;
};

export type DraftRow = {
  id: string;
  threadId: string;
  fingerprint: string;
  suggestion: DraftSuggestion;
  insertedIntoGmail: boolean;
  createdAt: number;
};

export type AIJobRow = {
  id: string;
  kind: 'summary' | 'draft';
  threadId: string;
  fingerprint: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  provider?: string;
  model?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  resultId?: string;
};

export type ReminderRow = {
  id: string;
  threadId: string;
  recipients: string[];
  lastOutgoingAt: number;
  dueAt: number;
  status: 'pending' | 'resolved' | 'fired';
  reason: string;
};

export type AgentActionRow = {
  id: string;
  type: string;
  threadId?: string;
  detail: string;
  undoable: boolean;
  undone: boolean;
  tier: number;
  createdAt: number;
  expiresAt?: number;
};

export type AgentRuleRow = {
  id: string;
  naturalLanguage: string;
  structured: StructuredRule;
  enabled: boolean;
  createdAt: number;
};

export type StructuredRule =
  | { kind: 'never_archive_domain'; domain: string }
  | { kind: 'always_archive_domain'; domain: string }
  | { kind: 'never_archive_sender'; email: string }
  | { kind: 'always_archive_sender'; email: string }
  | { kind: 'force_category'; match: 'domain' | 'sender'; value: string; category: ThreadCategory }
  | { kind: 'priority_domain'; domain: string; priority: Priority }
  | { kind: 'keep_inbox_domain'; domain: string };

export type SearchDocumentRow = {
  id: string;
  threadId: string;
  messageId?: string;
  text: string;
  subject: string;
  senders: string;
  recipients: string;
  labels: string;
  timestamp: string;
  fingerprint: string;
  quality?: ThreadDataQuality;
};

export type EmbeddingRow = {
  fingerprint: string;
  vector: number[];
  model: string;
  createdAt: number;
};

export type ModelCacheRow = {
  key: string;
  value: string;
  createdAt: number;
  expiresAt?: number;
};

export type StyleExampleRow = {
  id: string;
  sample: string;
  createdAt: number;
};

export type ThreadOverrideRow = {
  threadId: string;
  category: ThreadCategory;
  createdAt: number;
};

export type SplitView =
  | 'PRIORITY'
  | 'RESPOND'
  | 'WAITING'
  | 'FYI'
  | 'NOTIFICATIONS'
  | 'PROMOTIONS'
  | 'NEWS'
  | 'FOLLOW_UPS';

export type SettingsRow = {
  key: string;
  value: unknown;
};

export type SyncStateRow = {
  key: string;
  value: unknown;
};

export type IndexCoverage = {
  inboxCoverage: 'none' | 'partial' | 'complete';
  recentMailCoverage: 'none' | 'partial' | 'complete';
  sentMailCoverage: 'none' | 'partial' | 'complete';
  totalIndexedThreads: number;
  oldestIndexedDate: string | null;
  newestIndexedDate: string | null;
  lastSuccessfulScan: number | null;
  state: 'idle' | 'running' | 'paused' | 'error';
  lastError?: string;
};

export type IndexCheckpoint = {
  mode: string;
  customQuery?: string;
  cursor?: string;
  processedThreadIds: string[];
  status: 'running' | 'paused' | 'completed' | 'error';
  startedAt: number;
  updatedAt: number;
  error?: string;
};
