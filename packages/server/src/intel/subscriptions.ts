import { iso, num, one, type SqlExecutor } from '../db/sql.js';
import { GoogleApiError } from '../google/errors.js';
import type { GmailClient } from '../google/gmail.js';
import { headerValue } from '../google/mime.js';
import { ApiError } from '../http.js';
import { assertSafeUrl, safeFetch, UnsafeUrlError } from '../platform/ssrf.js';
import { recordAudit, type ActorType } from './audit.js';
import type { IntelDeps } from './context.js';
import { ConnectionUnavailableError, gmailFor, loadAccount, type AccountRow } from './google-access.js';
import type { MessageMeta } from './mailstore.js';

/**
 * Mailing lists: finding them and leaving them, the way Gmail's own
 * "Unsubscribe" button does, without opening anyone's website or calling a model.
 *
 * - Finding: synced message metadata already records whether each message
 *   carried a List-Unsubscribe header, so the list of senders is one query.
 * - Leaving: the sender's newest message is fetched (two headers only) and, when
 *   it supports RFC 8058 one-click unsubscribe (required of bulk senders by
 *   Gmail and Yahoo since 2024), PigeonBox POSTs `List-Unsubscribe=One-Click`
 *   to its URL. That is the whole unsubscribe: no browser, no page parsing.
 *   Lists without one-click get the sender's link or a ready unsubscribe email
 *   for the user to open with one click.
 * - Better than Gmail: with the Organize permission, mail already in the inbox
 *   from that sender is archived, and new mail from it keeps being archived on
 *   sync ("silence"), so lists that ignore the request, or that have no
 *   unsubscribe header at all, still stop reaching the inbox.
 */

export type UnsubscribeMethod = 'one_click' | 'link' | 'mailto' | 'archive_only';
export type UnsubscribeStatus = 'done' | 'needs_user' | 'failed';

export type Subscription = {
  accountId: string;
  account: string;
  email: string;
  name: string | null;
  messages: number;
  recent: number;
  inInbox: number;
  lastAt: string;
  unsubscribed: { at: string; method: UnsubscribeMethod; status: UnsubscribeStatus; silenced: boolean; since: number } | null;
};

/** What the user has to do when the list has no one-click unsubscribe. */
export type UnsubscribeFollowUp = { kind: 'open'; url: string } | { kind: 'email'; to: string; subject: string; body: string; gmailUrl: string };

export type UnsubscribeResult = {
  accountId: string;
  email: string;
  name: string | null;
  method: UnsubscribeMethod | null;
  status: UnsubscribeStatus;
  archived: number;
  silenced: boolean;
  followUp?: UnsubscribeFollowUp;
  message: string;
};

const UNSUBSCRIBE_HEADERS = ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post'];
/** Mail older than this after the unsubscribe is still "in flight" and doesn't count as ignoring it. */
const GRACE_DAYS = 2;
const ARCHIVE_LIMIT = 1_000;

type Row = {
  mail_account_id: string;
  account: string;
  sender: string;
  name: string | null;
  messages: number;
  recent: number;
  in_inbox: number;
  last_at: unknown;
  unsubscribed_at: unknown;
  method: UnsubscribeMethod | null;
  status: UnsubscribeStatus | null;
  silence: boolean | null;
  since: number;
};

/**
 * Senders whose mail carried a List-Unsubscribe header, busiest first, with
 * what PigeonBox already did about each. `query` matches address, name or domain.
 */
export async function listSubscriptions(tx: SqlExecutor, options: { query?: string; limit?: number; accountId?: string; includeUnsubscribed?: boolean } = {}): Promise<Subscription[]> {
  const query = (options.query ?? '').trim().toLowerCase().slice(0, 200);
  const rows = await tx.query<Row>(
    `select m.mail_account_id, a.email as account, lower(m.from_email) as sender, max(m.from_name) as name,
            count(*)::int as messages,
            count(*) filter (where m.internal_date > now() - interval '30 days')::int as recent,
            count(*) filter (where 'INBOX' = any (m.label_ids))::int as in_inbox,
            max(m.internal_date) as last_at,
            u.unsubscribed_at, u.method, u.status, u.silence,
            count(*) filter (where u.unsubscribed_at is not null and m.internal_date > u.unsubscribed_at + make_interval(days => $4))::int as since
       from public.message_metadata m
       join public.mail_accounts a on a.id = m.mail_account_id
       left join public.mail_unsubscribes u on u.mail_account_id = m.mail_account_id and u.sender_email = lower(m.from_email)
      where m.direction = 'inbound' and m.list_unsubscribe and m.from_email is not null
        and ($2::uuid is null or m.mail_account_id = $2::uuid)
        and ($3 = '' or lower(m.from_email) like '%' || $3 || '%' or lower(coalesce(m.from_name, '')) like '%' || $3 || '%')
        and ($5 or u.id is null)
      group by m.mail_account_id, a.email, lower(m.from_email), u.unsubscribed_at, u.method, u.status, u.silence
      order by (u.unsubscribed_at is null) desc, count(*) filter (where m.internal_date > now() - interval '30 days') desc, count(*) desc
      limit $1`,
    [Math.max(1, Math.min(500, options.limit ?? 200)), options.accountId ?? null, query, GRACE_DAYS, options.includeUnsubscribed ?? true],
  );
  return rows.map((row) => ({
    accountId: row.mail_account_id,
    account: row.account,
    email: row.sender,
    name: row.name?.slice(0, 200) || null,
    messages: num(row.messages),
    recent: num(row.recent),
    inInbox: num(row.in_inbox),
    lastAt: iso(row.last_at),
    unsubscribed: row.unsubscribed_at
      ? { at: iso(row.unsubscribed_at), method: row.method!, status: row.status!, silenced: Boolean(row.silence), since: num(row.since) }
      : null,
  }));
}

/** `<mailto:a@b?subject=x>, <https://…>` → the URLs, in order. */
export function parseListUnsubscribe(value: string | null | undefined): { https: string[]; mailto: string[] } {
  const out = { https: [] as string[], mailto: [] as string[] };
  for (const match of (value ?? '').matchAll(/<\s*([^<>\s]+)\s*>/g)) {
    const url = match[1]!;
    if (/^https:\/\//i.test(url)) out.https.push(url);
    else if (/^mailto:/i.test(url)) out.mailto.push(url);
  }
  return out;
}

export const supportsOneClick = (post: string | null | undefined) => /List-Unsubscribe\s*=\s*One-Click/i.test(post ?? '');

/** `mailto:list@x.com?subject=unsubscribe` → an email the user can send from Gmail with one click. */
export function mailtoFollowUp(mailto: string, accountEmail: string): Extract<UnsubscribeFollowUp, { kind: 'email' }> | null {
  let url: URL;
  try {
    url = new URL(mailto);
  } catch {
    return null;
  }
  const to = decodeURIComponent(url.pathname).trim().toLowerCase();
  if (!/^[a-z0-9._%+=-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(to) || to.length > 320) return null;
  const subject = (url.searchParams.get('subject') || 'Unsubscribe').slice(0, 300);
  const body = (url.searchParams.get('body') || 'Please unsubscribe me from this list.').slice(0, 2_000);
  const gmail = new URL('https://mail.google.com/mail/');
  gmail.searchParams.set('authuser', accountEmail);
  gmail.searchParams.set('view', 'cm');
  gmail.searchParams.set('fs', '1');
  gmail.searchParams.set('to', to);
  gmail.searchParams.set('su', subject);
  gmail.searchParams.set('body', body);
  return { kind: 'email', to, subject, body, gmailUrl: gmail.toString() };
}

/** RFC 8058: a POST with this exact body, no cookies, no redirects followed. */
async function oneClick(deps: IntelDeps, url: string): Promise<boolean> {
  try {
    const response = await safeFetch(deps.fetch, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'PigeonBox-Unsubscribe/1.0 (+https://github.com/aiden-guan/pigeonbox)' },
      body: 'List-Unsubscribe=One-Click',
      maxBytes: 200_000,
      timeoutMs: 10_000,
    });
    return response.status >= 200 && response.status < 300;
  } catch (error) {
    // A redirect after the POST means the server took it (Gmail treats it the same way).
    if (error instanceof UnsafeUrlError && error.reason === 'redirect') return true;
    return false;
  }
}

async function newestMessageId(tx: SqlExecutor, accountId: string, sender: string): Promise<string | null> {
  const row = await one<{ gmail_message_id: string }>(
    tx,
    `select gmail_message_id from public.message_metadata
      where mail_account_id = $1::uuid and lower(from_email) = $2 and direction = 'inbound'
      order by list_unsubscribe desc, internal_date desc limit 1`,
    [accountId, sender],
  );
  return row?.gmail_message_id ?? null;
}

/** Archive what this sender has in the inbox. Returns how many messages moved. */
async function archiveFrom(gmail: GmailClient, sender: string): Promise<number> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail.listMessages({ q: `from:${sender} in:inbox`, maxResults: 500, pageToken });
    for (const message of page.messages ?? []) ids.push(message.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < ARCHIVE_LIMIT);
  const batch = ids.slice(0, ARCHIVE_LIMIT);
  if (batch.length) await gmail.batchModifyMessages(batch, { removeLabelIds: ['INBOX'] });
  return batch.length;
}

const isEmail = (value: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);

/**
 * Unsubscribe the user from one sender in one connected mailbox.
 * `archive` also clears that sender out of the inbox and keeps it out.
 */
export async function unsubscribe(
  deps: IntelDeps,
  userId: string,
  input: { accountId: string; sender: string; archive: boolean; actor?: { type: ActorType; name: string }; requestId?: string },
): Promise<UnsubscribeResult> {
  const sender = input.sender.trim().toLowerCase();
  if (!isEmail(sender) || sender.length > 320) throw new ApiError('invalid_request', 'Pass the sender’s email address.');
  const { account, messageId, name } = await deps.db.asUser(userId, async (tx) => {
    const account = await loadAccount(tx, input.accountId);
    if (!account) throw new ApiError('not_found', 'This mailbox is not connected to your PigeonBox server.');
    const named = await one<{ name: string | null }>(tx, `select max(from_name) as name from public.message_metadata where mail_account_id = $1::uuid and lower(from_email) = $2`, [account.id, sender]);
    return { account, messageId: await newestMessageId(tx, account.id, sender), name: named?.name ?? null };
  });
  const base = { accountId: account.id, email: sender, name: name?.slice(0, 200) || null };
  const fail = (message: string): UnsubscribeResult => ({ ...base, method: null, status: 'failed', archived: 0, silenced: false, message });
  if (account.status !== 'active') return fail(account.status === 'needs_reauth' ? `Reconnect ${account.email} in PigeonBox first.` : `${account.email} is ${account.status.replace(/_/g, ' ')}.`);
  if (!account.features.includes('mail_read')) return fail(`PigeonBox can’t read ${account.email}.`);
  const canArchive = account.features.includes('organize');

  let gmail: GmailClient;
  let headers: { list: string | null; post: string | null } = { list: null, post: null };
  try {
    gmail = gmailFor(deps, account);
    let id = messageId;
    if (!id) id = (await gmail.listMessages({ q: `from:${sender}`, maxResults: 1 })).messages?.[0]?.id ?? null;
    if (id) {
      const message = await gmail.getMessage(id, 'metadata', UNSUBSCRIBE_HEADERS);
      headers = { list: headerValue(message.payload?.headers, 'List-Unsubscribe') ?? null, post: headerValue(message.payload?.headers, 'List-Unsubscribe-Post') ?? null };
    }
  } catch (error) {
    deps.log('warn', 'unsubscribe lookup failed', { userId, accountId: account.id, requestId: input.requestId, code: error instanceof GoogleApiError ? error.code : error instanceof ConnectionUnavailableError ? error.code : 'error' });
    return fail(error instanceof ConnectionUnavailableError && error.code === 'needs_reauth' ? `Reconnect ${account.email} in PigeonBox first.` : 'Gmail could not be reached. Try again in a minute.');
  }

  const links = parseListUnsubscribe(headers.list);
  let method: UnsubscribeMethod | null = null;
  let status: UnsubscribeStatus = 'failed';
  let followUp: UnsubscribeFollowUp | undefined;
  const oneClickUrl = supportsOneClick(headers.post) ? links.https.find((url) => safe(url)) : undefined;
  if (oneClickUrl && (await oneClick(deps, oneClickUrl))) {
    method = 'one_click';
    status = 'done';
  } else if (links.mailto.length && mailtoFollowUp(links.mailto[0]!, account.email)) {
    method = 'mailto';
    status = 'needs_user';
    followUp = mailtoFollowUp(links.mailto[0]!, account.email)!;
  } else if (links.https.some(safe)) {
    method = 'link';
    status = 'needs_user';
    followUp = { kind: 'open', url: links.https.find(safe)! };
  }

  let archived = 0;
  const silence = input.archive && canArchive;
  if (silence) {
    try {
      archived = await archiveFrom(gmail, sender);
    } catch (error) {
      deps.log('warn', 'unsubscribe archive failed', { userId, accountId: account.id, requestId: input.requestId, code: error instanceof GoogleApiError ? error.code : 'error' });
    }
    // Nothing to unsubscribe through: keeping the sender out of the inbox is the unsubscribe.
    if (!method) {
      method = 'archive_only';
      status = 'done';
    }
  }
  if (!method) return fail(canArchive ? 'This sender gives no way to unsubscribe.' : 'This sender gives no way to unsubscribe. Allow PigeonBox to organize your mail and it can keep their mail out of your inbox instead.');

  await deps.db.asUser(userId, async (tx) => {
    await tx.query(
      `insert into public.mail_unsubscribes (user_id, mail_account_id, sender_email, sender_name, method, status, silence, archived_count)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
       on conflict (mail_account_id, sender_email) do update
         set sender_name = coalesce(excluded.sender_name, public.mail_unsubscribes.sender_name), method = excluded.method, status = excluded.status,
             silence = excluded.silence, archived_count = public.mail_unsubscribes.archived_count + excluded.archived_count,
             unsubscribed_at = now(), updated_at = now()`,
      [userId, account.id, sender, base.name, method, status, silence, archived],
    );
    await recordAudit(tx, {
      userId,
      actor: { type: input.actor?.type ?? 'user', id: null, name: input.actor?.name ?? 'You' },
      action: 'unsubscribe',
      tier: 1,
      target: { kind: 'sender', id: sender, title: base.name },
      summary: `${status === 'done' ? 'Unsubscribed from' : 'Started unsubscribing from'} ${base.name ? `${base.name} <${sender}>` : sender}${archived ? `, archived ${archived}` : ''}`,
      policy: { decision: 'allowed', reason: 'Requested by the user' },
      accountId: account.id,
    });
  });
  deps.log('info', 'unsubscribed', { userId, accountId: account.id, requestId: input.requestId, operation: method, decision: status, count: archived, event: silence ? 'silenced' : 'kept' });

  const who = base.name || sender;
  const kept = silence ? ' New mail from them will skip your inbox.' : '';
  const message =
    method === 'one_click'
      ? `Unsubscribed from ${who}.${archived ? ` Archived ${archived} in your inbox.` : ''}${kept}`
      : method === 'archive_only'
        ? `${who} has no unsubscribe option, so PigeonBox will keep their mail out of your inbox.${archived ? ` Archived ${archived}.` : ''}`
        : method === 'mailto'
          ? `${who} unsubscribes by email: send the prepared email to finish.${kept}`
          : `${who} needs you to confirm on their site: open the link to finish.${kept}`;
  return { ...base, method, status, archived, silenced: silence, ...(followUp ? { followUp } : {}), message };
}

function safe(url: string): boolean {
  try {
    assertSafeUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** Stop or resume archiving a sender's new mail. */
export async function setSilence(tx: SqlExecutor, accountId: string, sender: string, silence: boolean): Promise<void> {
  const row = await one<{ id: string }>(tx, `update public.mail_unsubscribes set silence = $3, updated_at = now() where mail_account_id = $1::uuid and sender_email = $2 returning id`, [accountId, sender.trim().toLowerCase(), silence]);
  if (!row) throw new ApiError('not_found', 'You haven’t unsubscribed from this sender in PigeonBox.');
}

/**
 * Turn what the user typed ("Uber Eats", "nytimes.com", "deals@x.com") into
 * senders that have List-Unsubscribe mail. Exact addresses win; otherwise
 * every sender whose name, address or domain contains the text.
 */
export async function matchSenders(tx: SqlExecutor, text: string, accountIds: string[]): Promise<Subscription[]> {
  const needle = text.trim().toLowerCase().replace(/^@/, '');
  if (!needle) return [];
  const all = await listSubscriptions(tx, { query: needle.length >= 2 ? needle.split(/\s+/)[0] : needle, limit: 100 });
  const mine = all.filter((item) => accountIds.includes(item.accountId));
  const exact = mine.filter((item) => item.email === needle);
  if (exact.length) return exact;
  const words = needle.split(/\s+/).filter(Boolean);
  const hay = (item: Subscription) => `${item.email} ${item.name ?? ''}`.toLowerCase();
  return mine.filter((item) => words.every((word) => hay(item).includes(word)) || hay(item).replace(/[^a-z0-9]/g, '').includes(needle.replace(/[^a-z0-9]/g, '')));
}

/**
 * New mail from silenced senders skips the inbox. Called by sync with the
 * messages it just stored; costs nothing unless one of them is inbox mail
 * from a sender the user left.
 */
export async function silenceUnsubscribed(deps: IntelDeps, account: AccountRow, metas: MessageMeta[]): Promise<number> {
  if (!account.features.includes('organize')) return 0;
  const inbox = metas.filter((meta) => meta.direction === 'inbound' && meta.fromEmail && meta.labelIds.includes('INBOX'));
  if (!inbox.length) return 0;
  const senders = [...new Set(inbox.map((meta) => meta.fromEmail!.toLowerCase()))];
  const silenced = await deps.db.asUser(account.user_id, (tx) =>
    tx.query<{ sender_email: string }>(`select sender_email from public.mail_unsubscribes where mail_account_id = $1::uuid and silence and sender_email = any ($2::text[])`, [account.id, senders]),
  );
  if (!silenced.length) return 0;
  const set = new Set(silenced.map((row) => row.sender_email));
  const ids = inbox.filter((meta) => set.has(meta.fromEmail!.toLowerCase())).map((meta) => meta.gmailMessageId);
  try {
    await gmailFor(deps, account).batchModifyMessages(ids, { removeLabelIds: ['INBOX'] });
    deps.log('info', 'silenced unsubscribed mail', { userId: account.user_id, accountId: account.id, count: ids.length });
    return ids.length;
  } catch (error) {
    deps.log('warn', 'silencing unsubscribed mail failed', { userId: account.user_id, accountId: account.id, code: error instanceof GoogleApiError ? error.code : 'error' });
    return 0;
  }
}
