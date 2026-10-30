import { GoogleApiError, googleErrorFrom, googleNetworkError } from './errors.js';
import type { GmailPart } from './mime.js';

/**
 * Gmail REST API client for one connected account. Server-side only.
 * Access tokens come from a provider that refreshes them; a 401 forces one
 * refresh and one retry.
 */

export type AccessTokenSource = {
  get(): Promise<string>;
  /** Forget the cached token so the next `get` refreshes. */
  invalidate(): void;
};

export type GmailMessageRef = { id: string; threadId: string; labelIds?: string[] };

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
};

export type GmailThread = { id: string; historyId?: string; messages?: GmailMessage[] };

export type GmailHistoryRecord = {
  id: string;
  messages?: GmailMessageRef[];
  messagesAdded?: Array<{ message: GmailMessageRef }>;
  messagesDeleted?: Array<{ message: GmailMessageRef }>;
  labelsAdded?: Array<{ message: GmailMessageRef; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: GmailMessageRef; labelIds: string[] }>;
};

export type GmailDraft = { id: string; message?: GmailMessage & { raw?: string } };

export const METADATA_HEADERS = ['From', 'Reply-To', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'List-Unsubscribe', 'Auto-Submitted', 'Precedence', 'X-Autoreply', 'Content-Type'];

export class GmailClient {
  constructor(
    private readonly tokens: AccessTokenSource,
    private readonly fetchImpl: typeof fetch,
    private readonly base: string = 'https://gmail.googleapis.com/gmail/v1',
  ) {}

  private async request<T>(method: string, path: string, options: { query?: Record<string, string | string[] | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.base}/users/me${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    const send = async (token: string) => {
      try {
        return await this.fetchImpl(url.toString(), {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw googleNetworkError(error);
      }
    };
    let response = await send(await this.tokens.get());
    if (response.status === 401) {
      await response.body?.cancel();
      this.tokens.invalidate();
      response = await send(await this.tokens.get());
    }
    if (!response.ok) throw await googleErrorFrom(response);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getProfile() {
    return this.request<{ emailAddress: string; historyId: string; messagesTotal?: number }>('GET', '/profile');
  }

  watch(topicName: string) {
    return this.request<{ historyId: string; expiration: string }>('POST', '/watch', {
      body: { topicName, labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'include' },
    });
  }

  stop() {
    return this.request<void>('POST', '/stop');
  }

  /** Throws `history_expired` when Google no longer has history since `startHistoryId`. */
  async listHistory(startHistoryId: string, pageToken?: string) {
    try {
      return await this.request<{ history?: GmailHistoryRecord[]; nextPageToken?: string; historyId: string }>('GET', '/history', {
        query: {
          startHistoryId,
          pageToken,
          maxResults: 500,
          historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
        },
      });
    } catch (error) {
      if (error instanceof GoogleApiError && error.code === 'not_found') throw new GoogleApiError('history_expired', 404);
      throw error;
    }
  }

  listMessages(params: { q?: string; pageToken?: string; maxResults?: number; labelIds?: string[] }) {
    return this.request<{ messages?: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }>('GET', '/messages', {
      query: { q: params.q, pageToken: params.pageToken, maxResults: params.maxResults ?? 100, labelIds: params.labelIds },
    });
  }

  getMessage(id: string, format: 'metadata' | 'full' | 'minimal' = 'metadata', headers: string[] = METADATA_HEADERS) {
    return this.request<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}`, {
      query: { format, metadataHeaders: format === 'metadata' ? headers : undefined },
    });
  }

  listThreads(params: { q?: string; pageToken?: string; maxResults?: number }) {
    return this.request<{ threads?: Array<{ id: string; snippet?: string }>; nextPageToken?: string; resultSizeEstimate?: number }>('GET', '/threads', { query: params });
  }

  getThread(id: string, format: 'metadata' | 'full' | 'minimal' = 'full') {
    return this.request<GmailThread>('GET', `/threads/${encodeURIComponent(id)}`, {
      query: { format, metadataHeaders: format === 'metadata' ? METADATA_HEADERS : undefined },
    });
  }

  createDraft(threadId: string | null, raw: string) {
    return this.request<GmailDraft>('POST', '/drafts', { body: { message: { raw, ...(threadId ? { threadId } : {}) } } });
  }

  updateDraft(draftId: string, threadId: string | null, raw: string) {
    return this.request<GmailDraft>('PUT', `/drafts/${encodeURIComponent(draftId)}`, {
      body: { id: draftId, message: { raw, ...(threadId ? { threadId } : {}) } },
    });
  }

  getDraft(draftId: string) {
    return this.request<GmailDraft>('GET', `/drafts/${encodeURIComponent(draftId)}`, { query: { format: 'raw' } });
  }

  deleteDraft(draftId: string) {
    return this.request<void>('DELETE', `/drafts/${encodeURIComponent(draftId)}`);
  }

  modifyThread(threadId: string, change: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
    return this.request<GmailThread>('POST', `/threads/${encodeURIComponent(threadId)}/modify`, {
      body: { addLabelIds: change.addLabelIds ?? [], removeLabelIds: change.removeLabelIds ?? [] },
    });
  }

  /** Up to 1,000 messages per call. */
  batchModifyMessages(ids: string[], change: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
    return this.request<void>('POST', '/messages/batchModify', {
      body: { ids, addLabelIds: change.addLabelIds ?? [], removeLabelIds: change.removeLabelIds ?? [] },
    });
  }

  /** Moves every message in the thread to Trash; Gmail deletes it for good after 30 days. */
  trashThread(threadId: string) {
    return this.request<GmailThread>('POST', `/threads/${encodeURIComponent(threadId)}/trash`);
  }

  untrashThread(threadId: string) {
    return this.request<GmailThread>('POST', `/threads/${encodeURIComponent(threadId)}/untrash`);
  }

  listLabels() {
    return this.request<{ labels?: Array<{ id: string; name: string; type?: string }> }>('GET', '/labels');
  }

  createLabel(name: string) {
    return this.request<{ id: string; name: string }>('POST', '/labels', {
      body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
  }

  renameLabel(labelId: string, name: string) {
    return this.request<{ id: string; name: string }>('PATCH', `/labels/${encodeURIComponent(labelId)}`, { body: { name } });
  }

  /** Removes the label from every message; the messages themselves stay. */
  deleteLabel(labelId: string) {
    return this.request<void>('DELETE', `/labels/${encodeURIComponent(labelId)}`);
  }

  /** Only called by the approval executor for an approved Tier 3 send. */
  sendMessage(raw: string, threadId: string | null) {
    return this.request<GmailMessage>('POST', '/messages/send', { body: { raw, ...(threadId ? { threadId } : {}) } });
  }
}
