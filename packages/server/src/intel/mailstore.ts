import { one, type SqlExecutor } from '../db/sql.js';
import type { GmailMessage } from '../google/gmail.js';
import { decodeEncodedWords, headerValue, parseAddressList } from '../google/mime.js';

/**
 * Persistence of Gmail metadata: threads and messages without bodies or
 * snippets. Everything is an upsert keyed by Gmail IDs, so replaying a history
 * page or a recovery pass never duplicates rows.
 */

export type MessageMeta = {
  gmailMessageId: string;
  gmailThreadId: string;
  rfc822MessageId: string | null;
  internalDate: Date;
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  labelIds: string[];
  direction: 'inbound' | 'outbound';
  isAuto: boolean;
  listUnsubscribe: boolean;
  hasAttachment: boolean;
  subject: string;
};

/** Labels that mean "not real mail for triage". */
const IGNORED = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT']);

export function toMessageMeta(message: GmailMessage, ownerEmails: readonly string[]): MessageMeta | null {
  const labels = message.labelIds ?? [];
  if (labels.some((label) => IGNORED.has(label))) return null;
  const headers = message.payload?.headers;
  const from = parseAddressList(headerValue(headers, 'From'))[0] ?? null;
  const owners = new Set(ownerEmails.map((email) => email.toLowerCase()));
  const outbound = labels.includes('SENT') || (from ? owners.has(from.email) : false);
  const autoSubmitted = (headerValue(headers, 'Auto-Submitted') ?? 'no').toLowerCase();
  const precedence = (headerValue(headers, 'Precedence') ?? '').toLowerCase();
  const fromLocal = from?.email.split('@')[0] ?? '';
  const internal = Number(message.internalDate);
  const contentType = (headerValue(headers, 'Content-Type') ?? message.payload?.mimeType ?? '').toLowerCase();
  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    rfc822MessageId: headerValue(headers, 'Message-ID')?.slice(0, 500) ?? null,
    internalDate: Number.isFinite(internal) && internal > 0 ? new Date(internal) : new Date(),
    fromEmail: from?.email ?? null,
    fromName: from?.name ?? null,
    toEmails: parseAddressList(headerValue(headers, 'To')).map((a) => a.email).slice(0, 100),
    ccEmails: parseAddressList(headerValue(headers, 'Cc')).map((a) => a.email).slice(0, 100),
    labelIds: labels.slice(0, 50),
    direction: outbound ? 'outbound' : 'inbound',
    isAuto:
      (autoSubmitted !== 'no' && autoSubmitted !== '') ||
      ['bulk', 'list', 'junk'].includes(precedence) ||
      /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce)/i.test(fromLocal) ||
      Boolean(headerValue(headers, 'X-Autoreply')),
    listUnsubscribe: Boolean(headerValue(headers, 'List-Unsubscribe')),
    hasAttachment: contentType.startsWith('multipart/mixed') || (message.payload?.parts ?? []).some((part) => Boolean(part.filename)),
    subject: decodeEncodedWords(headerValue(headers, 'Subject') ?? '').replace(/\s+/g, ' ').trim().slice(0, 998),
  };
}

export type UpsertResult = {
  /** thread row ID by Gmail thread ID, for threads that got a new message. */
  threads: Map<string, { id: string; newInbound: boolean; newOutbound: boolean; inInbox: boolean }>;
  inserted: number;
  /** Messages seen for the first time, with their thread row, for contact bookkeeping. */
  insertedMetas: Array<MessageMeta & { threadRowId: string }>;
};

export async function upsertMessages(tx: SqlExecutor, userId: string, accountId: string, metas: MessageMeta[]): Promise<UpsertResult> {
  const threads: UpsertResult['threads'] = new Map();
  const insertedMetas: UpsertResult['insertedMetas'] = [];
  let inserted = 0;
  for (const meta of metas) {
    const thread = await one<{ id: string }>(
      tx,
      `insert into public.threads (user_id, mail_account_id, gmail_thread_id, subject)
       values ($1::uuid, $2::uuid, $3, $4)
       on conflict (mail_account_id, gmail_thread_id) do update
         set subject = case when public.threads.subject = '' then excluded.subject else public.threads.subject end
       returning id`,
      [userId, accountId, meta.gmailThreadId, meta.subject],
    );
    const row = await one<{ inserted: boolean }>(
      tx,
      `insert into public.message_metadata
         (user_id, mail_account_id, thread_id, gmail_message_id, rfc822_message_id, internal_date, from_email, from_name,
          to_emails, cc_emails, label_ids, direction, is_auto, list_unsubscribe, has_attachment)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7, $8, $9::text[], $10::text[], $11::text[], $12, $13, $14, $15)
       on conflict (mail_account_id, gmail_message_id) do update set label_ids = excluded.label_ids
       returning (xmax = 0) as inserted`,
      [
        userId,
        accountId,
        thread!.id,
        meta.gmailMessageId,
        meta.rfc822MessageId,
        meta.internalDate,
        meta.fromEmail,
        meta.fromName,
        meta.toEmails,
        meta.ccEmails,
        meta.labelIds,
        meta.direction,
        meta.isAuto,
        meta.listUnsubscribe,
        meta.hasAttachment,
      ],
    );
    const isNew = Boolean(row?.inserted);
    if (isNew) {
      inserted += 1;
      insertedMetas.push({ ...meta, threadRowId: thread!.id });
    }
    const entry = threads.get(meta.gmailThreadId) ?? { id: thread!.id, newInbound: false, newOutbound: false, inInbox: false };
    if (isNew && meta.direction === 'inbound') entry.newInbound = true;
    if (isNew && meta.direction === 'outbound') entry.newOutbound = true;
    if (meta.labelIds.includes('INBOX')) entry.inInbox = true;
    threads.set(meta.gmailThreadId, entry);
  }
  return { threads, inserted, insertedMetas };
}

/** Apply label changes from history. Unknown messages are ignored (they arrive with messageAdded). */
export async function applyLabelChange(tx: SqlExecutor, accountId: string, gmailMessageId: string, add: string[], remove: string[]): Promise<string | null> {
  const row = await one<{ thread_id: string }>(
    tx,
    `update public.message_metadata
        set label_ids = array(select distinct l from unnest(label_ids || $3::text[]) l where not (l = any($4::text[])))
      where mail_account_id = $1::uuid and gmail_message_id = $2
      returning thread_id`,
    [accountId, gmailMessageId, add, remove],
  );
  return row?.thread_id ?? null;
}

export async function deleteMessage(tx: SqlExecutor, accountId: string, gmailMessageId: string): Promise<string | null> {
  const row = await one<{ thread_id: string }>(
    tx,
    `delete from public.message_metadata where mail_account_id = $1::uuid and gmail_message_id = $2 returning thread_id`,
    [accountId, gmailMessageId],
  );
  return row?.thread_id ?? null;
}

export type ThreadAggregate = {
  id: string;
  gmail_thread_id: string;
  content_version: string;
  analyzed_version: string | null;
  last_message_from_owner: boolean;
  label_ids: string[];
  is_bulk: boolean;
  message_count: number;
  last_message_at: unknown;
};

/**
 * Recompute thread aggregates from its messages in one statement. Threads with
 * no messages left are deleted.
 */
export async function refreshThreads(tx: SqlExecutor, threadIds: string[]): Promise<ThreadAggregate[]> {
  if (!threadIds.length) return [];
  await tx.query(
    `delete from public.threads t where t.id = any($1::uuid[]) and not exists (select 1 from public.message_metadata m where m.thread_id = t.id)`,
    [threadIds],
  );
  return tx.query<ThreadAggregate>(
    `with agg as (
       select m.thread_id,
              count(*)::int as message_count,
              max(m.internal_date) as last_at,
              (array_agg(m.gmail_message_id order by m.internal_date desc))[1] as last_id,
              coalesce((array_agg(m.direction order by m.internal_date desc))[1] = 'outbound', false) as last_from_owner,
              max(m.internal_date) filter (where m.direction = 'inbound') as last_in,
              max(m.internal_date) filter (where m.direction = 'outbound') as last_out,
              bool_or(m.has_attachment) as has_att,
              coalesce(bool_or(m.list_unsubscribe or m.is_auto) filter (where m.direction = 'inbound'), false) as bulk,
              md5(string_agg(m.gmail_message_id, ',' order by m.gmail_message_id)) as version
         from public.message_metadata m
        where m.thread_id = any($1::uuid[])
        group by m.thread_id
     ),
     people as (
       select a.thread_id,
              coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('email', p.email, 'name', p.name)) order by p.first_at)
                          from (select x.email, max(x.name) as name, min(x.at) as first_at
                                  from (select lower(m2.from_email) as email, m2.from_name as name, m2.internal_date as at
                                          from public.message_metadata m2 where m2.thread_id = a.thread_id and m2.from_email is not null
                                        union all
                                        select lower(r), null, m2.internal_date
                                          from public.message_metadata m2, unnest(m2.to_emails || m2.cc_emails) r
                                         where m2.thread_id = a.thread_id) x
                                 group by x.email order by min(x.at) limit 50) p), '[]'::jsonb) as participants,
              coalesce((select array_agg(distinct l) from public.message_metadata m3, unnest(m3.label_ids) l where m3.thread_id = a.thread_id), '{}') as labels
         from agg a
     )
     update public.threads t
        set message_count = agg.message_count,
            last_message_at = agg.last_at,
            last_message_id = agg.last_id,
            last_message_from_owner = agg.last_from_owner,
            last_inbound_at = agg.last_in,
            last_outbound_at = agg.last_out,
            has_attachment = agg.has_att,
            is_bulk = agg.bulk,
            content_version = agg.version,
            participants = people.participants,
            label_ids = people.labels,
            search_tsv = to_tsvector('simple', coalesce(t.subject, '') || ' ' ||
              coalesce((select string_agg(coalesce(e ->> 'name', '') || ' ' || (e ->> 'email'), ' ') from jsonb_array_elements(people.participants) e), '')),
            updated_at = now()
       from agg join people on people.thread_id = agg.thread_id
      where t.id = agg.thread_id
      returning t.id, t.gmail_thread_id, t.content_version, t.analyzed_version, t.last_message_from_owner, t.label_ids, t.is_bulk, t.message_count, t.last_message_at`,
    [threadIds],
  );
}
