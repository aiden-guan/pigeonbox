/**
 * An in-memory Google for tests: OAuth (code + PKCE, refresh, revoke, signed
 * ID tokens), Gmail (profile, watch, history with expiry, messages, threads,
 * drafts, labels, send) and Calendar (free/busy, events), with scope checks.
 * Also signs Pub/Sub push requests the way Google does (OIDC JWT).
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { buildRawMessage, parseRawMessage } from '../google/mime.js';
import { SCOPES } from '../google/scopes.js';
import type { CalendarListEntry } from '../google/calendar.js';

export const FAKE_GOOGLE_BASE = 'https://google.test';

export type FakeMessageInput = {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  labels?: string[];
  headers?: Record<string, string>;
  at?: Date;
  attachments?: Array<{ filename: string; mimeType: string; size: number }>;
};

type StoredMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  headers: Record<string, string>;
  body: string;
  historyId: number;
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
};

/**
 * A small subset of Gmail search: from:, to:, subject:, in:/is:/label: (labels), quoted
 * phrases and bare words, all case-insensitive and ANDed. newer_than and negated
 * terms are handled by the caller or ignored, as sync's recovery query needs.
 */
function matchesGmailQuery(message: StoredMessage, q: string, labels: ReadonlyArray<{ id: string; name: string }> = []): boolean {
  const header = (name: string) => (Object.entries(message.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? '').toLowerCase();
  const everything = `${header('from')} ${header('to')} ${header('cc')} ${header('subject')} ${message.body}`.toLowerCase();
  for (const raw of q.match(/-?\w+:"[^"]*"|-?\w+:\S+|"[^"]*"|\S+/g) ?? []) {
    if (raw.startsWith('-')) continue;
    const [, op, value] = raw.match(/^(\w+):(.*)$/) ?? [null, null, raw];
    const term = (value ?? '').replace(/^"|"$/g, '').toLowerCase();
    if (!term || /^(or|and)$/i.test(term)) continue;
    switch (op?.toLowerCase()) {
      case 'newer_than':
      case 'older_than':
      case 'after':
      case 'before':
        continue;
      case 'from':
        if (!header('from').includes(term)) return false;
        continue;
      case 'to':
        if (!`${header('to')} ${header('cc')}`.includes(term)) return false;
        continue;
      case 'subject':
        if (!header('subject').includes(term)) return false;
        continue;
      case 'in':
      case 'is':
      case 'label':
        if (!message.labelIds.some((label) => label.toLowerCase() === term || labels.find((known) => known.id === label)?.name.toLowerCase() === term)) return false;
        continue;
      default:
        if (!everything.includes(term)) return false;
    }
  }
  return true;
}

type HistoryRecord = {
  id: number;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds: string[] } }>;
  messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
};

type CalendarEventRecord = { id: string; calendarId: string; summary: string; start: string; end: string; attendees: string[]; organizer: string; transparency?: string; status: string; sendUpdates?: string };

type FakeAccount = {
  sub: string;
  email: string;
  name: string;
  messages: Map<string, StoredMessage>;
  history: HistoryRecord[];
  historyId: number;
  /** startHistoryId below this returns 404 (history expired). */
  minHistoryId: number;
  drafts: Map<string, { id: string; threadId: string | null; raw: string }>;
  labels: Array<{ id: string; name: string; type: string }>;
  events: CalendarEventRecord[];
  calendars: Array<CalendarListEntry & { freeBusyError?: boolean }>;
  watch: { topic: string; expiration: number } | null;
  sent: string[];
  timeZone: string;
};

let counter = 1_000;
const nextId = (prefix = '') => `${prefix}${(counter++).toString(16)}${Math.random().toString(16).slice(2, 8)}`;

function base64Url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256b64url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function googleError(status: number, reason: string, error = '', message?: string): Response {
  if (error) return json({ error, error_description: reason }, status);
  return json({ error: { code: status, status: reason, errors: [{ reason }], ...(message ? { message } : {}) } }, status);
}

export class FakeGoogle {
  readonly clientId = 'fake-client-id.apps.googleusercontent.com';
  readonly clientSecret = 'fake-client-secret';
  readonly serviceAccount = 'gmail-push@pigeonbox-test.iam.gserviceaccount.com';
  readonly accounts = new Map<string, FakeAccount>();
  readonly calls: Array<{ method: string; path: string }> = [];
  historyPageSize = 100;
  /** Make the next N calls to paths matching this fail with the status. */
  /** Injected failures; `message` is echoed in the error body, as Google sometimes does with request content. */
  failures: Array<{ pattern: RegExp; status: number; remaining: number; message?: string }> = [];
  private codes = new Map<string, { sub: string; scopes: string[]; challenge: string; redirectUri: string; forceConsent: boolean }>();
  private refreshTokens = new Map<string, { sub: string; scopes: string[]; revoked: boolean }>();
  private accessTokens = new Map<string, { sub: string; scopes: string[]; expiresAt: number }>();
  /** Every OAuth token ever issued, for tests that prove none of them leak. */
  readonly issuedTokens = new Set<string>();
  private grants = new Map<string, Set<string>>();
  private keys!: { privateKey: CryptoKey; jwk: JWK };
  /** Answers fetches to hosts other than Google (e.g. a list's one-click unsubscribe endpoint). */
  external: ((request: Request) => Response | Promise<Response>) | null = null;
  jwks!: JWTVerifyGetKey;

  static async create(): Promise<FakeGoogle> {
    const google = new FakeGoogle();
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'fake-key', alg: 'RS256', use: 'sig' };
    google.keys = { privateKey: privateKey as CryptoKey, jwk };
    google.jwks = createLocalJWKSet({ keys: [jwk] });
    return google;
  }

  get endpoints() {
    return {
      authorize: `${FAKE_GOOGLE_BASE}/o/oauth2/v2/auth`,
      token: `${FAKE_GOOGLE_BASE}/token`,
      revoke: `${FAKE_GOOGLE_BASE}/revoke`,
      jwks: `${FAKE_GOOGLE_BASE}/certs`,
      gmail: `${FAKE_GOOGLE_BASE}/gmail/v1`,
      calendar: `${FAKE_GOOGLE_BASE}/calendar/v3`,
    };
  }

  addAccount(email: string, name = email.split('@')[0]!, timeZone = 'America/New_York'): FakeAccount {
    const sub = `sub-${email}`;
    const account: FakeAccount = {
      sub,
      email,
      name,
      messages: new Map(),
      history: [],
      historyId: 5_000,
      minHistoryId: 0,
      drafts: new Map(),
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'SENT', name: 'SENT', type: 'system' },
        { id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' },
        { id: 'UNREAD', name: 'UNREAD', type: 'system' },
        { id: 'STARRED', name: 'STARRED', type: 'system' },
      ],
      events: [],
      calendars: [{ id: 'primary', primary: true, selected: true, accessRole: 'owner', timeZone }],
      watch: null,
      sent: [],
      timeZone,
    };
    this.accounts.set(sub, account);
    return account;
  }

  account(email: string): FakeAccount {
    for (const account of this.accounts.values()) if (account.email === email) return account;
    throw new Error(`no fake account ${email}`);
  }

  /** The user clicks "Allow" on the consent screen. `grant` can drop scopes (granular consent). */
  async consent(authorizationUrl: string, email: string, options: { grant?: (scopes: string[]) => string[] } = {}): Promise<string> {
    const url = new URL(authorizationUrl);
    if (url.searchParams.get('client_id') !== this.clientId) throw new Error('wrong client');
    if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE required');
    const account = this.account(email);
    const requested = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
    const granted = options.grant ? options.grant(requested) : requested;
    const previous = url.searchParams.get('include_granted_scopes') === 'true' ? this.grants.get(account.sub) ?? new Set<string>() : new Set<string>();
    const all = [...new Set([...previous, ...granted])];
    this.grants.set(account.sub, new Set(all));
    const code = nextId('code-');
    this.codes.set(code, {
      sub: account.sub,
      scopes: all,
      challenge: url.searchParams.get('code_challenge')!,
      redirectUri: url.searchParams.get('redirect_uri')!,
      forceConsent: url.searchParams.get('prompt') === 'consent',
    });
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    return callback.toString();
  }

  private async idToken(account: FakeAccount): Promise<string> {
    return new SignJWT({ email: account.email, email_verified: true, name: account.name })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience(this.clientId)
      .setSubject(account.sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.keys.privateKey);
  }

  /** A push request signed like Pub/Sub's OIDC token. */
  async pushRequest(url: string, emailAddress: string, historyId: number | string, options: { audience: string; signer?: string; tamper?: boolean } ): Promise<Request> {
    const token = await new SignJWT({ email: options.signer ?? this.serviceAccount, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience(options.audience)
      .setSubject('push-sa')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.keys.privateKey);
    const body = { message: { data: btoa(JSON.stringify({ emailAddress, historyId: Number(historyId) })), messageId: nextId('msg-') }, subscription: 'projects/x/subscriptions/y' };
    return new Request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.tamper ? `${token.slice(0, -4)}AAAA` : token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  revokeAll(email: string): void {
    const sub = this.account(email).sub;
    for (const record of this.refreshTokens.values()) if (record.sub === sub) record.revoked = true;
    for (const [token, record] of this.accessTokens) if (record.sub === sub) this.accessTokens.delete(token);
  }

  isRevoked(email: string): boolean {
    const sub = this.account(email).sub;
    const tokens = [...this.refreshTokens.values()].filter((record) => record.sub === sub);
    return tokens.length > 0 && tokens.every((record) => record.revoked);
  }

  /** Google no longer has history before the current point (as after ~a week). */
  expireHistory(email: string): void {
    const account = this.account(email);
    account.minHistoryId = account.historyId;
  }

  private record(account: FakeAccount, change: Omit<HistoryRecord, 'id'>): number {
    account.historyId += 1;
    account.history.push({ id: account.historyId, ...change });
    return account.historyId;
  }

  /** Mail arrives in `to`'s mailbox (or, with SENT, the owner sends). Returns the message and thread IDs. */
  deliver(ownerEmail: string, input: FakeMessageInput): { id: string; threadId: string } {
    const account = this.account(ownerEmail);
    const id = nextId();
    const threadId = input.threadId ?? id;
    const outbound = input.from.toLowerCase() === ownerEmail.toLowerCase();
    const labelIds = input.labels ?? (outbound ? ['SENT'] : ['INBOX', 'UNREAD']);
    const headers: Record<string, string> = {
      From: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
      To: input.to.join(', '),
      Subject: input.subject,
      Date: (input.at ?? new Date()).toUTCString(),
      'Message-ID': `<${id}@mail.test>`,
      ...(input.cc?.length ? { Cc: input.cc.join(', ') } : {}),
      ...(input.attachments?.length ? { 'Content-Type': 'multipart/mixed; boundary=x' } : { 'Content-Type': 'text/plain; charset=UTF-8' }),
      ...input.headers,
    };
    const message: StoredMessage = {
      id,
      threadId,
      labelIds,
      internalDate: (input.at ?? new Date()).getTime(),
      headers,
      body: input.body,
      historyId: 0,
      attachments: input.attachments ?? [],
    };
    message.historyId = this.record(account, { messagesAdded: [{ message: { id, threadId, labelIds } }] });
    account.messages.set(id, message);
    return { id, threadId };
  }

  modifyLabels(ownerEmail: string, messageId: string, add: string[], remove: string[]): void {
    const account = this.account(ownerEmail);
    const message = account.messages.get(messageId)!;
    message.labelIds = [...new Set([...message.labelIds.filter((label) => !remove.includes(label)), ...add])];
    if (add.length) this.record(account, { labelsAdded: [{ message: { id: message.id, threadId: message.threadId }, labelIds: add }] });
    if (remove.length) this.record(account, { labelsRemoved: [{ message: { id: message.id, threadId: message.threadId }, labelIds: remove }] });
  }

  addEvent(ownerEmail: string, event: { summary: string; start: Date; end: Date; attendees?: string[]; transparency?: string; calendarId?: string }): CalendarEventRecord {
    const account = this.account(ownerEmail);
    const record = { id: nextId('evt'), calendarId: event.calendarId ?? 'primary', summary: event.summary, start: event.start.toISOString(), end: event.end.toISOString(), attendees: event.attendees ?? [], organizer: ownerEmail, transparency: event.transparency, status: 'confirmed' };
    account.events.push(record);
    return record;
  }

  /** The user edits a Gmail draft by hand. */
  editDraft(ownerEmail: string, draftId: string, body: string): void {
    const account = this.account(ownerEmail);
    const draft = account.drafts.get(draftId)!;
    const parsed = parseRawMessage(draft.raw);
    draft.raw = buildRawMessage({ to: [{ email: parsed.headers.to ?? '' }], subject: parsed.headers.subject ?? '', body });
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  readonly fetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (!url.href.startsWith(FAKE_GOOGLE_BASE)) {
      if (this.external) return this.external(request);
      throw new TypeError(`unexpected fetch to ${url.origin}`);
    }
    const path = url.pathname;
    this.calls.push({ method: request.method, path });
    for (const failure of this.failures) {
      if (failure.remaining > 0 && failure.pattern.test(path)) {
        failure.remaining -= 1;
        return googleError(failure.status, failure.status === 429 ? 'rateLimitExceeded' : 'backendError', '', failure.message);
      }
    }
    if (path === '/token') return this.token(await request.text());
    if (path === '/revoke') return this.revoke(await request.text());
    const auth = (request.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    const access = this.accessTokens.get(auth);
    if (!access || access.expiresAt < Date.now()) return googleError(401, 'authError');
    const account = this.accounts.get(access.sub)!;
    const has = (...scopes: string[]) => scopes.some((scope) => access.scopes.includes(scope));
    const body = (request.method === 'GET' || request.method === 'DELETE' ? null : await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (path.startsWith('/gmail/v1/users/me')) return this.gmail(account, request.method, path.slice('/gmail/v1/users/me'.length), url, body, has);
    if (path.startsWith('/calendar/v3')) return this.calendar(account, request.method, path.slice('/calendar/v3'.length), url, body, has);
    return googleError(404, 'notFound');
  };

  private async token(text: string): Promise<Response> {
    const form = new URLSearchParams(text);
    if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) return googleError(401, 'invalid client', 'invalid_client');
    if (form.get('grant_type') === 'authorization_code') {
      const code = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      if (!code) return googleError(400, 'bad code', 'invalid_grant');
      if ((await sha256b64url(form.get('code_verifier') ?? '')) !== code.challenge) return googleError(400, 'PKCE failed', 'invalid_grant');
      if (form.get('redirect_uri') !== code.redirectUri) return googleError(400, 'redirect mismatch', 'redirect_uri_mismatch');
      const account = this.accounts.get(code.sub)!;
      const refresh = nextId('rt-');
      this.refreshTokens.set(refresh, { sub: code.sub, scopes: code.scopes, revoked: false });
      this.issuedTokens.add(refresh);
      const accessToken = nextId('at-');
      this.accessTokens.set(accessToken, { sub: code.sub, scopes: code.scopes, expiresAt: Date.now() + 3_600_000 });
      this.issuedTokens.add(accessToken);
      return json({ access_token: accessToken, expires_in: 3600, refresh_token: refresh, scope: code.scopes.join(' '), id_token: await this.idToken(account), token_type: 'Bearer' });
    }
    if (form.get('grant_type') === 'refresh_token') {
      const record = this.refreshTokens.get(form.get('refresh_token') ?? '');
      if (!record || record.revoked) return googleError(400, 'Token has been expired or revoked.', 'invalid_grant');
      const accessToken = nextId('at-');
      this.accessTokens.set(accessToken, { sub: record.sub, scopes: record.scopes, expiresAt: Date.now() + 3_600_000 });
      this.issuedTokens.add(accessToken);
      return json({ access_token: accessToken, expires_in: 3600, scope: record.scopes.join(' '), token_type: 'Bearer' });
    }
    return googleError(400, 'unsupported', 'unsupported_grant_type');
  }

  private revoke(text: string): Response {
    const token = new URLSearchParams(text).get('token') ?? '';
    const record = this.refreshTokens.get(token);
    if (!record) return googleError(400, 'invalid_token', 'invalid_token');
    // Revoking a refresh token revokes the whole grant for this client.
    for (const other of this.refreshTokens.values()) if (other.sub === record.sub) other.revoked = true;
    for (const [access, value] of this.accessTokens) if (value.sub === record.sub) this.accessTokens.delete(access);
    this.grants.delete(record.sub);
    return json({});
  }

  private payload(message: StoredMessage, format: string, wanted: string[] | null) {
    const headers = Object.entries(message.headers)
      .filter(([name]) => !wanted || wanted.some((header) => header.toLowerCase() === name.toLowerCase()))
      .map(([name, value]) => ({ name, value }));
    if (format === 'metadata' || format === 'minimal') return { mimeType: message.headers['Content-Type']?.split(';')[0] ?? 'text/plain', headers: format === 'minimal' ? [] : headers };
    const text = { partId: '0', mimeType: 'text/plain', filename: '', headers: [], body: { size: message.body.length, data: base64Url(message.body) } };
    const files = message.attachments.map((file, index) => ({ partId: `${index + 1}`, mimeType: file.mimeType, filename: file.filename, headers: [], body: { size: file.size, attachmentId: `att-${index}` } }));
    return files.length ? { mimeType: 'multipart/mixed', headers, parts: [text, ...files] } : { ...text, headers };
  }

  private messageJson(message: StoredMessage, format: string, wanted: string[] | null) {
    return {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds,
      historyId: String(message.historyId),
      internalDate: String(message.internalDate),
      snippet: message.body.replace(/\s+/g, ' ').slice(0, 160),
      sizeEstimate: message.body.length,
      payload: this.payload(message, format, wanted),
    };
  }

  private gmail(account: FakeAccount, method: string, path: string, url: URL, body: Record<string, unknown> | null, has: (...scopes: string[]) => boolean): Response {
    const read = has(SCOPES.readonly, SCOPES.modify, SCOPES.full);
    const compose = has(SCOPES.compose, SCOPES.modify, SCOPES.full);
    const modify = has(SCOPES.modify, SCOPES.full);
    const denied = () => googleError(403, 'insufficientPermissions');
    const wanted = url.searchParams.getAll('metadataHeaders');
    if (method === 'GET' && path === '/profile') return read ? json({ emailAddress: account.email, historyId: String(account.historyId), messagesTotal: account.messages.size }) : denied();
    if (method === 'POST' && path === '/watch') {
      if (!read) return denied();
      account.watch = { topic: String(body?.topicName), expiration: Date.now() + 7 * 86_400_000 };
      return json({ historyId: String(account.historyId), expiration: String(account.watch.expiration) });
    }
    if (method === 'POST' && path === '/stop') {
      account.watch = null;
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === '/history') {
      if (!read) return denied();
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < account.minHistoryId) return googleError(404, 'notFound');
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const all = account.history.filter((record) => record.id > start);
      const page = all.slice(offset, offset + this.historyPageSize);
      const more = offset + this.historyPageSize < all.length;
      return json({
        history: page.map((record) => ({ ...record, id: String(record.id) })),
        historyId: String(account.historyId),
        ...(more ? { nextPageToken: String(offset + this.historyPageSize) } : {}),
      });
    }
    if (method === 'GET' && path === '/messages') {
      if (!read) return denied();
      const q = url.searchParams.get('q') ?? '';
      const days = Number(q.match(/newer_than:(\d+)d/)?.[1] ?? 3650);
      const since = Date.now() - days * 86_400_000;
      const ids = [...account.messages.values()]
        .filter((message) => message.internalDate >= since && !message.labelIds.some((label) => ['SPAM', 'TRASH', 'DRAFT'].includes(label)))
        .filter((message) => matchesGmailQuery(message, q, account.labels))
        .sort((a, b) => b.internalDate - a.internalDate)
        .map((message) => ({ id: message.id, threadId: message.threadId }));
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const page = ids.slice(offset, offset + max);
      return json({ messages: page, ...(offset + max < ids.length ? { nextPageToken: String(offset + max) } : {}), resultSizeEstimate: ids.length });
    }
    const messageMatch = path.match(/^\/messages\/([^/]+)$/);
    if (method === 'GET' && messageMatch) {
      if (!read) return denied();
      const message = account.messages.get(decodeURIComponent(messageMatch[1]!));
      return message ? json(this.messageJson(message, url.searchParams.get('format') ?? 'full', wanted.length ? wanted : null)) : googleError(404, 'notFound');
    }
    if (method === 'GET' && path === '/threads') {
      if (!read) return denied();
      const q = url.searchParams.get('q') ?? '';
      const ids = [...new Set([...account.messages.values()]
        .filter((message) => !message.labelIds.some((label) => ['SPAM', 'TRASH', 'DRAFT'].includes(label)))
        .filter((message) => matchesGmailQuery(message, q, account.labels))
        .sort((a, b) => b.internalDate - a.internalDate)
        .map((message) => message.threadId))];
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      return json({ threads: ids.slice(offset, offset + max).map((id) => ({ id })), ...(offset + max < ids.length ? { nextPageToken: String(offset + max) } : {}), resultSizeEstimate: ids.length });
    }
    const trashMatch = path.match(/^\/threads\/([^/]+)\/(trash|untrash)$/);
    if (method === 'POST' && trashMatch) {
      if (!modify) return denied();
      const id = decodeURIComponent(trashMatch[1]!);
      const trash = trashMatch[2] === 'trash';
      let found = false;
      for (const message of account.messages.values()) {
        if (message.threadId !== id) continue;
        found = true;
        this.modifyLabels(account.email, message.id, trash ? ['TRASH'] : [], trash ? ['INBOX'] : ['TRASH']);
      }
      return found ? json({ id }) : googleError(404, 'notFound');
    }
    const threadMatch = path.match(/^\/threads\/([^/]+)$/);
    if (method === 'GET' && threadMatch) {
      if (!read) return denied();
      const id = decodeURIComponent(threadMatch[1]!);
      const messages = [...account.messages.values()].filter((message) => message.threadId === id).sort((a, b) => a.internalDate - b.internalDate);
      if (!messages.length) return googleError(404, 'notFound');
      return json({ id, historyId: String(account.historyId), messages: messages.map((message) => this.messageJson(message, url.searchParams.get('format') ?? 'full', wanted.length ? wanted : null)) });
    }
    const modifyMatch = path.match(/^\/threads\/([^/]+)\/modify$/);
    if (method === 'POST' && modifyMatch) {
      if (!modify) return denied();
      const id = decodeURIComponent(modifyMatch[1]!);
      const add = (body?.addLabelIds as string[]) ?? [];
      const remove = (body?.removeLabelIds as string[]) ?? [];
      for (const message of account.messages.values()) if (message.threadId === id) this.modifyLabels(account.email, message.id, add, remove);
      return json({ id });
    }
    if (method === 'POST' && path === '/messages/batchModify') {
      if (!modify) return denied();
      const add = (body?.addLabelIds as string[]) ?? [];
      const remove = (body?.removeLabelIds as string[]) ?? [];
      for (const id of (body?.ids as string[]) ?? []) if (account.messages.has(id)) this.modifyLabels(account.email, id, add, remove);
      return new Response(null, { status: 204 });
    }
    if (path === '/labels' && method === 'GET') return read ? json({ labels: account.labels }) : denied();
    if (path === '/labels' && method === 'POST') {
      if (!modify) return denied();
      const label = { id: nextId('Label_'), name: String(body?.name), type: 'user' };
      account.labels.push(label);
      return json(label);
    }
    const labelMatch = path.match(/^\/labels\/([^/]+)$/);
    if (labelMatch && (method === 'PATCH' || method === 'DELETE')) {
      if (!modify) return denied();
      const id = decodeURIComponent(labelMatch[1]!);
      const label = account.labels.find((item) => item.id === id && item.type === 'user');
      if (!label) return googleError(404, 'notFound');
      if (method === 'PATCH') {
        label.name = String(body?.name ?? label.name);
        return json(label);
      }
      account.labels.splice(account.labels.indexOf(label), 1);
      for (const message of account.messages.values()) if (message.labelIds.includes(id)) this.modifyLabels(account.email, message.id, [], [id]);
      return new Response(null, { status: 204 });
    }
    if (path === '/drafts' && method === 'POST') {
      if (!compose) return denied();
      const message = body?.message as { raw: string; threadId?: string };
      const id = nextId('r-');
      account.drafts.set(id, { id, threadId: message.threadId ?? null, raw: message.raw });
      return json({ id, message: { id: nextId(), threadId: message.threadId ?? id } });
    }
    const draftMatch = path.match(/^\/drafts\/([^/]+)$/);
    if (draftMatch) {
      const id = decodeURIComponent(draftMatch[1]!);
      const draft = account.drafts.get(id);
      if (method === 'GET') return !read && !compose ? denied() : draft ? json({ id, message: { id: nextId(), threadId: draft.threadId, raw: draft.raw } }) : googleError(404, 'notFound');
      if (!compose) return denied();
      if (!draft) return googleError(404, 'notFound');
      if (method === 'PUT') {
        draft.raw = (body?.message as { raw: string }).raw;
        return json({ id, message: { id: nextId(), threadId: draft.threadId } });
      }
      if (method === 'DELETE') {
        account.drafts.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    if (path === '/messages/send' && method === 'POST') {
      if (!has(SCOPES.send, SCOPES.compose, SCOPES.modify, SCOPES.full)) return denied();
      const raw = String((body as { raw: string }).raw);
      const parsed = parseRawMessage(raw);
      account.sent.push(raw);
      const sent = this.deliver(account.email, {
        from: account.email,
        to: (parsed.headers.to ?? '').split(',').map((part) => part.trim()).filter(Boolean),
        subject: parsed.headers.subject ?? '',
        body: parsed.body,
        threadId: (body as { threadId?: string }).threadId,
      });
      return json({ id: sent.id, threadId: sent.threadId, labelIds: ['SENT'] });
    }
    return googleError(404, 'notFound');
  }

  private calendar(account: FakeAccount, method: string, path: string, url: URL, body: Record<string, unknown> | null, has: (...scopes: string[]) => boolean): Response {
    const read = has(SCOPES.calendarReadonly, SCOPES.calendarFull, SCOPES.calendarEvents);
    const write = has(SCOPES.calendarEvents, SCOPES.calendarFull);
    if (method === 'GET' && path === '/users/me/calendarList') return read ? json({ items: account.calendars }) : googleError(403, 'insufficientPermissions');
    if (method === 'POST' && path === '/freeBusy') {
      if (!has(SCOPES.calendarReadonly, SCOPES.calendarFull)) return googleError(403, 'insufficientPermissions');
      const min = Date.parse(String(body?.timeMin));
      const max = Date.parse(String(body?.timeMax));
      const calendars = Object.fromEntries(((body?.items as Array<{ id: string }>) ?? [{ id: 'primary' }]).map(({ id }) => {
        const calendar = account.calendars.find(item => item.id === id);
        const busy = account.events
          .filter(event => event.calendarId === id && event.transparency !== 'transparent' && event.status !== 'cancelled' && Date.parse(event.end) > min && Date.parse(event.start) < max)
          .map(event => ({ start: event.start, end: event.end }));
        return [id, !calendar || calendar.freeBusyError ? { errors: [{ reason: 'notFound' }] } : { busy }];
      }));
      return json({ calendars });
    }
    if (method === 'GET' && path === '/users/me/settings/timezone') return read ? json({ value: account.timeZone }) : googleError(403, 'insufficientPermissions');
    const events = path.match(/^\/calendars\/([^/]+)\/events$/);
    if (events && method === 'GET') {
      if (!read) return googleError(403, 'insufficientPermissions');
      const min = Date.parse(url.searchParams.get('timeMin') ?? '');
      const max = Date.parse(url.searchParams.get('timeMax') ?? '');
      const calendarId = decodeURIComponent(events[1]!);
      const items = account.events
        .filter((event) => event.calendarId === calendarId && Date.parse(event.end) > min && Date.parse(event.start) < max)
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((event) => ({
          id: event.id,
          status: event.status,
          summary: event.summary,
          start: { dateTime: event.start },
          end: { dateTime: event.end },
          attendees: event.attendees.map((email) => ({ email, self: email === account.email })),
          organizer: { email: event.organizer, self: event.organizer === account.email },
          htmlLink: `https://calendar.test/${event.id}`,
          transparency: event.transparency,
          etag: `"${event.id}"`,
        }));
      return json({ items, timeZone: account.timeZone });
    }
    const single = path.match(/^\/calendars\/([^/]+)\/events\/([^/]+)$/);
    if (single && method === 'GET') {
      if (!read) return googleError(403, 'insufficientPermissions');
      const event = account.events.find((item) => item.id === decodeURIComponent(single[2]!));
      if (!event) return googleError(404, 'notFound');
      return json({ id: event.id, summary: event.summary, start: { dateTime: event.start }, end: { dateTime: event.end }, attendees: event.attendees.map((email) => ({ email, self: email === account.email })), organizer: { email: event.organizer }, status: event.status, etag: `"${event.id}"` });
    }
    if (single && method === 'DELETE') {
      if (!write) return googleError(403, 'insufficientPermissions');
      const index = account.events.findIndex((event) => event.id === decodeURIComponent(single[2]!));
      if (index < 0) return googleError(404, 'notFound');
      account.events.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (events && method === 'POST') {
      if (!write) return googleError(403, 'insufficientPermissions');
      const event = body as { summary: string; start: { dateTime: string }; end: { dateTime: string }; attendees?: Array<{ email: string }> };
      const record = this.addEvent(account.email, {
        summary: event.summary,
        start: new Date(event.start.dateTime),
        end: new Date(event.end.dateTime),
        attendees: event.attendees?.map((attendee) => attendee.email),
      });
      record.sendUpdates = url.searchParams.get('sendUpdates') ?? 'none';
      return json({ id: record.id, htmlLink: `https://calendar.test/${record.id}`, status: 'confirmed', summary: record.summary, start: { dateTime: record.start }, end: { dateTime: record.end } });
    }
    return googleError(404, 'notFound');
  }
}
