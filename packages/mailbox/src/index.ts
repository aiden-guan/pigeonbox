import {
  stableThreadFingerprint,
  stripHtml,
  type ThreadDataQuality,
} from '@pigeonbox/shared';
import { getMailboxDb, type MailboxDatabase } from './db.js';
import type {
  IndexCheckpoint,
  IndexCoverage,
  IngestThread,
  MailboxSource,
  MessageRow,
  SplitView,
  ThreadRow,
} from './types.js';

export class GmailWebSource implements MailboxSource {
  readonly kind = 'gmail-web' as const;

  constructor(
    private readonly observeVisible: () => Promise<IngestThread[]>,
    private readonly observeCurrent: () => Promise<IngestThread | null>,
  ) {}

  observeVisibleThreads(): Promise<IngestThread[]> {
    return this.observeVisible();
  }

  observeCurrentThread(): Promise<IngestThread | null> {
    return this.observeCurrent();
  }
}

/** Seam only — not implemented in V1. */
export class FutureImapSource implements MailboxSource {
  readonly kind = 'future-imap' as const;
  async observeVisibleThreads(): Promise<IngestThread[]> {
    throw new Error('FutureImapSource is not implemented in V1');
  }
  async observeCurrentThread(): Promise<IngestThread | null> {
    throw new Error('FutureImapSource is not implemented in V1');
  }
}

export class MailboxIngestor {
  constructor(
    private readonly db: MailboxDatabase = getMailboxDb(),
    private readonly accountId = 'default',
  ) {}

  /**
   * Incremental ingest. Unchanged fingerprint → skip AI reprocessing flags.
   * Does NOT scrape entire mailbox on startup.
   */
  async ingestThread(thread: IngestThread): Promise<{
    changed: boolean;
    fingerprint: string;
    threadId: string;
    quality: ThreadDataQuality;
  }> {
    const quality = inferQuality(thread);
    const existing = await this.db.threads.get(thread.threadId);
    if (thread.mailboxEmail && existing?.mailboxEmail !== thread.mailboxEmail && existing) {
      await this.db.threads.update(thread.threadId, { mailboxEmail: thread.mailboxEmail });
      existing.mailboxEmail = thread.mailboxEmail;
    }
    if (existing && thread.route === 'sent' && !existing.seenInSent) {
      await this.db.threads.update(thread.threadId, { seenInSent: true });
      existing.seenInSent = true;
    }
    if (existing?.quality === 'THREAD_COMPLETE' && quality !== 'THREAD_COMPLETE') {
      return {
        changed: false,
        fingerprint: existing.contentFingerprint,
        threadId: thread.threadId,
        quality: 'THREAD_COMPLETE',
      };
    }

    const messages = quality === 'ROW_STUB' ? [] : thread.messages;
    const fingerprint = await stableThreadFingerprint({
      quality,
      threadId: thread.threadId,
      subject: thread.subject,
      sender: thread.latestSender?.email || thread.participants[0]?.email || '',
      snippet: thread.snippet,
      messageCount: thread.messageCount || messages.length || undefined,
      stableId: messages.at(-1)?.messageId,
      messages: messages.map((message) => ({
        messageId: message.messageId,
        bodyText: stripHtml(message.bodyText || ''),
      })),
    });

    if (existing?.contentFingerprint === fingerprint) {
      return { changed: false, fingerprint, threadId: thread.threadId, quality };
    }

    const threadRow: ThreadRow = {
      mailboxEmail: thread.mailboxEmail || existing?.mailboxEmail,
      threadId: thread.threadId,
      accountId: this.accountId,
      subject: thread.subject,
      participants: thread.participants,
      latestSender: thread.latestSender,
      latestTimestamp: thread.latestTimestamp || existing?.latestTimestamp || '',
      messageCount: thread.messageCount || messages.length,
      snippet: thread.snippet,
      route: thread.route,
      seenInSent: thread.route === 'sent' || existing?.seenInSent || undefined,
      quality,
      source: thread.source,
      manualCategory: existing?.manualCategory,
      lastIndexedAt: Date.now(),
      contentFingerprint: fingerprint,
      classification: existing?.classification,
      classificationConfidence: existing?.classificationConfidence,
      priority: existing?.priority,
      archivedLocally: existing?.archivedLocally ?? false,
      requiresResponse: existing?.requiresResponse ?? false,
      awaitingResponse: existing?.awaitingResponse ?? false,
      virtualLabels: existing?.virtualLabels ?? [],
    };

    const messageRows: MessageRow[] = [];
    for (const message of messages) {
      const text = stripHtml(message.bodyText || '');
      const fp = await stableThreadFingerprint({
        quality: 'THREAD_COMPLETE',
        threadId: message.threadId,
        subject: thread.subject,
        sender: message.sender.email,
        snippet: '',
        messages: [{ messageId: message.messageId, bodyText: text }],
      });
      messageRows.push({
        messageId: message.messageId,
        threadId: message.threadId,
        accountId: this.accountId,
        sender: message.sender,
        recipients: message.recipients,
        cc: message.cc,
        timestamp: message.timestamp || '',
        bodyText: text,
        bodyHtml: undefined,
        attachmentsMetadata: message.attachmentsMetadata || [],
        fingerprint: fp,
      });
    }

    await this.db.transaction('rw', this.db.threads, this.db.messages, this.db.contacts, this.db.search_documents, async () => {
      await this.db.threads.put(threadRow);
      for (const mr of messageRows) {
        await this.db.messages.put(mr);
        await this.db.contacts.put({
          email: mr.sender.email,
          accountId: this.accountId,
          name: mr.sender.name,
          lastSeenAt: Date.now(),
          messageCount: 1,
        });
      }
      const searchText = [
        thread.subject,
        thread.snippet,
        ...messageRows.map((m) => m.bodyText),
      ].join('\n');
      await this.db.search_documents.put({
        id: thread.threadId,
        threadId: thread.threadId,
        text: searchText.slice(0, 100_000),
        subject: thread.subject,
        senders: thread.participants.map((p) => p.email).join(' '),
        recipients: messageRows.flatMap((m) => m.recipients.map((r) => r.email)).join(' '),
        labels: (threadRow.virtualLabels || []).join(' '),
        timestamp: thread.latestTimestamp || existing?.latestTimestamp || '',
        fingerprint,
        quality,
      });
    });

    return { changed: true, fingerprint, threadId: thread.threadId, quality };
  }

  async getCoverage(): Promise<IndexCoverage> {
    const threads = await this.db.threads.toArray();
    const sync = await this.db.sync_state.get('index_coverage');
    const checkpoint = (await this.db.sync_state.get('index_checkpoint'))?.value as
      | IndexCheckpoint
      | undefined;
    const dates = threads
      .map((t) => t.latestTimestamp)
      .filter(Boolean)
      .sort();
    const state =
      checkpoint?.status === 'running'
        ? 'running'
        : checkpoint?.status === 'paused'
          ? 'paused'
          : checkpoint?.status === 'error'
            ? 'error'
            : 'idle';

    return {
      inboxCoverage: (sync?.value as IndexCoverage | undefined)?.inboxCoverage || (threads.length ? 'partial' : 'none'),
      recentMailCoverage: threads.length ? 'partial' : 'none',
      sentMailCoverage: (sync?.value as IndexCoverage | undefined)?.sentMailCoverage || 'none',
      totalIndexedThreads: threads.length,
      oldestIndexedDate: dates[0] || null,
      newestIndexedDate: dates[dates.length - 1] || null,
      lastSuccessfulScan: (sync?.value as { lastSuccessfulScan?: number } | undefined)?.lastSuccessfulScan ?? null,
      state,
      lastError: checkpoint?.error,
    };
  }

  async saveCheckpoint(cp: IndexCheckpoint): Promise<void> {
    await this.db.sync_state.put({ key: 'index_checkpoint', value: cp });
  }

  async loadCheckpoint(): Promise<IndexCheckpoint | null> {
    const row = await this.db.sync_state.get('index_checkpoint');
    return (row?.value as IndexCheckpoint) || null;
  }

  async clearIndex(): Promise<void> {
    await this.db.transaction(
      'rw',
      [
        this.db.threads,
        this.db.messages,
        this.db.search_documents,
        this.db.embeddings,
        this.db.thread_classifications,
        this.db.thread_summaries,
        this.db.draft_suggestions,
      ],
      async () => {
        await Promise.all([
          this.db.threads.clear(),
          this.db.messages.clear(),
          this.db.search_documents.clear(),
          this.db.embeddings.clear(),
          this.db.thread_classifications.clear(),
          this.db.thread_summaries.clear(),
          this.db.draft_suggestions.clear(),
        ]);
      },
    );
  }
}

/**
 * Optional "Index My Inbox" — user-triggered only.
 * Bounded queue, concurrency 1, pacing, checkpointing, crash recovery.
 */
export class IndexJobRunner {
  private paused = false;
  private stopped = false;

  constructor(
    private readonly ingestor: MailboxIngestor,
    private readonly fetchBatch: (query: string, cursor?: string) => Promise<{
      threads: IngestThread[];
      nextCursor?: string;
      error?: string;
      captchaOrBlock?: boolean;
    }>,
  ) {}

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(opts: {
    mode: '7d' | '30d' | '90d' | '1y' | 'custom' | 'sent_sample';
    customQuery?: string;
    paceMs?: number;
  }): Promise<IndexCheckpoint> {
    this.stopped = false;
    this.paused = false;
    const query = buildIndexQuery(opts.mode, opts.customQuery);
    let cp = (await this.ingestor.loadCheckpoint()) || {
      mode: opts.mode,
      customQuery: opts.customQuery,
      processedThreadIds: [],
      status: 'running' as const,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (cp.mode !== opts.mode || cp.customQuery !== opts.customQuery) {
      cp = {
        mode: opts.mode,
        customQuery: opts.customQuery,
        processedThreadIds: [],
        status: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      cp.status = 'running';
    }
    await this.ingestor.saveCheckpoint(cp);

    let cursor = cp.cursor;
    const pace = opts.paceMs ?? 1200;
    const processed = new Set(cp.processedThreadIds);

    while (!this.stopped) {
      while (this.paused) {
        cp.status = 'paused';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        await sleep(400);
        if (this.stopped) break;
      }
      if (this.stopped) break;

      const batch = await this.fetchBatch(query, cursor);
      if (batch.captchaOrBlock || batch.error) {
        cp.status = 'error';
        cp.error = batch.error || 'Gmail blocked or unexpected state';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        return cp;
      }
      if (!batch.threads.length) {
        cp.status = 'completed';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        return cp;
      }

      const sizeBefore = processed.size;
      for (const t of batch.threads) {
        if (processed.has(t.threadId)) continue;
        await this.ingestor.ingestThread(t);
        processed.add(t.threadId);
        cp.processedThreadIds = [...processed].slice(-5000);
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        await sleep(pace);
        if (this.paused || this.stopped) break;
      }

      cursor = batch.nextCursor;
      cp.cursor = cursor;
      // No new threads this page → done (avoids infinite scroll loops)
      if (processed.size === sizeBefore) {
        cp.status = 'completed';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        return cp;
      }
      if (!cursor) {
        cp.status = 'completed';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        return cp;
      }
      // exponential-ish backoff between pages
      await sleep(pace * 1.5);
    }

    cp.status = this.paused ? 'paused' : 'paused';
    cp.updatedAt = Date.now();
    await this.ingestor.saveCheckpoint(cp);
    return cp;
  }
}

export function buildIndexQuery(
  mode: '7d' | '30d' | '90d' | '1y' | 'custom' | 'sent_sample',
  customQuery?: string,
): string {
  switch (mode) {
    case '7d':
      return 'newer_than:7d';
    case '30d':
      return 'newer_than:30d';
    case '90d':
      return 'newer_than:90d';
    case '1y':
      return 'newer_than:365d';
    case 'sent_sample':
      return 'in:sent newer_than:90d';
    case 'custom':
      return customQuery?.trim() || 'in:inbox';
    default:
      return 'in:inbox';
  }
}

const STUB_MESSAGE_ID = /-(row|visible|unknown)$/;

export function inferQuality(thread: IngestThread): ThreadDataQuality {
  if (thread.quality) return thread.quality;
  const usable = thread.messages.filter(
    (message) => message.bodyText.trim().length > 0 && !STUB_MESSAGE_ID.test(message.messageId),
  );
  if (thread.messages.length > 0 && usable.length === thread.messages.length) return 'THREAD_COMPLETE';
  if (usable.length > 0) return 'THREAD_PARTIAL';
  return 'ROW_STUB';
}

export function filterSplitThreads<T extends Pick<ThreadRow, 'threadId' | 'classification' | 'priority'>>(
  threads: T[],
  category: SplitView,
  followUpIds: string[] = [],
): T[] {
  if (category === 'PRIORITY') return threads.filter((thread) => thread.priority === 'HIGH');
  if (category === 'FOLLOW_UPS') {
    const ids = new Set(followUpIds);
    return threads.filter((thread) => thread.classification === 'WAITING' || ids.has(thread.threadId));
  }
  return threads.filter((thread) => thread.classification === category);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export * from './types.js';
export * from './db.js';
