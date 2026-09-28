import Dexie, { type Table } from 'dexie';
import type {
  AccountRow,
  AgentActionRow,
  AgentRuleRow,
  AIJobRow,
  ClassificationRow,
  ContactRow,
  DraftRow,
  EmbeddingRow,
  MessageRow,
  ModelCacheRow,
  ReminderRow,
  SearchDocumentRow,
  SettingsRow,
  StyleExampleRow,
  SummaryRow,
  SyncStateRow,
  ThreadOverrideRow,
  ThreadRow,
} from './types.js';

/**
 * Local mailbox store — IndexedDB via Dexie.
 * Mailbox contents MUST NOT use chrome.storage.local.
 * Mailbox contents MUST NEVER be sent to the tracking backend.
 */
export class MailboxDatabase extends Dexie {
  accounts!: Table<AccountRow, string>;
  threads!: Table<ThreadRow, string>;
  messages!: Table<MessageRow, string>;
  contacts!: Table<ContactRow, string>;
  thread_classifications!: Table<ClassificationRow, string>;
  thread_summaries!: Table<SummaryRow, string>;
  draft_suggestions!: Table<DraftRow, string>;
  reminders!: Table<ReminderRow, string>;
  agent_actions!: Table<AgentActionRow, string>;
  agent_rules!: Table<AgentRuleRow, string>;
  search_documents!: Table<SearchDocumentRow, string>;
  embeddings!: Table<EmbeddingRow, string>;
  model_cache!: Table<ModelCacheRow, string>;
  style_examples!: Table<StyleExampleRow, string>;
  settings!: Table<SettingsRow, string>;
  sync_state!: Table<SyncStateRow, string>;
  thread_overrides!: Table<ThreadOverrideRow, string>;
  ai_jobs!: Table<AIJobRow, string>;

  /**
   * `gi_mailbox_v1` is the legacy ("Gmail Intelligence") IndexedDB name. It
   * must not change: existing installs keep their indexed mail under it, and
   * renaming it would need an explicit data migration.
   */
  constructor(name = 'gi_mailbox_v1') {
    super(name);
    this.version(1).stores({
      accounts: 'id, email',
      threads: 'threadId, accountId, latestTimestamp, classification, contentFingerprint, requiresResponse, awaitingResponse',
      messages: 'messageId, threadId, accountId, timestamp, fingerprint',
      contacts: '[accountId+email], email, lastSeenAt',
      thread_classifications: 'threadId, category, fingerprint, createdAt',
      thread_summaries: 'threadId, fingerprint, createdAt',
      draft_suggestions: 'id, threadId, fingerprint, createdAt',
      reminders: 'id, threadId, status, dueAt',
      agent_actions: 'id, threadId, createdAt, type',
      agent_rules: 'id, enabled, createdAt',
      search_documents: 'id, threadId, fingerprint, timestamp',
      embeddings: 'fingerprint, model, createdAt',
      model_cache: 'key, createdAt',
      style_examples: 'id, createdAt',
      settings: 'key',
      sync_state: 'key',
    });
    this.version(2).stores({
      accounts: 'id, email',
      threads: 'threadId, accountId, latestTimestamp, classification, contentFingerprint, requiresResponse, awaitingResponse',
      messages: 'messageId, threadId, accountId, timestamp, fingerprint',
      contacts: '[accountId+email], email, lastSeenAt',
      thread_classifications: 'threadId, category, fingerprint, createdAt',
      thread_summaries: 'threadId, fingerprint, createdAt',
      draft_suggestions: 'id, threadId, fingerprint, createdAt',
      reminders: 'id, threadId, status, dueAt',
      agent_actions: 'id, threadId, createdAt, type',
      agent_rules: 'id, enabled, createdAt',
      search_documents: 'id, threadId, fingerprint, timestamp',
      embeddings: 'fingerprint, model, createdAt',
      model_cache: 'key, createdAt',
      style_examples: 'id, createdAt',
      settings: 'key',
      sync_state: 'key',
      thread_overrides: 'threadId, category, createdAt',
    });
    this.version(3).stores({
      accounts: 'id, email',
      threads: 'threadId, accountId, latestTimestamp, classification, contentFingerprint, requiresResponse, awaitingResponse',
      messages: 'messageId, threadId, accountId, timestamp, fingerprint',
      contacts: '[accountId+email], email, lastSeenAt',
      thread_classifications: 'threadId, category, fingerprint, createdAt',
      thread_summaries: 'threadId, fingerprint, createdAt',
      draft_suggestions: 'id, threadId, fingerprint, createdAt',
      reminders: 'id, threadId, status, dueAt',
      agent_actions: 'id, threadId, createdAt, type',
      agent_rules: 'id, enabled, createdAt',
      search_documents: 'id, threadId, fingerprint, timestamp',
      embeddings: 'fingerprint, model, createdAt',
      model_cache: 'key, createdAt',
      style_examples: 'id, createdAt',
      settings: 'key',
      sync_state: 'key',
      thread_overrides: 'threadId, category, createdAt',
      ai_jobs: 'id, kind, threadId, fingerprint, status, createdAt',
    });
    this.version(4).stores({
      ai_jobs: 'id, kind, threadId, fingerprint, status, createdAt, resultId',
    });
  }
}

let singleton: MailboxDatabase | null = null;

export function getMailboxDb(name?: string): MailboxDatabase {
  if (name) return new MailboxDatabase(name);
  if (!singleton) singleton = new MailboxDatabase();
  return singleton;
}

export function resetMailboxDbForTests(): void {
  singleton = null;
}
