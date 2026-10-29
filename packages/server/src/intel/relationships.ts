import type { ContactSummary, RelationshipBrief } from '@pigeonbox/api-contract';
import type { RelationshipImportance, ThreadState } from '@pigeonbox/shared';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import type { SecretBox } from '../platform/crypto.js';
import { COMMITMENT_COLUMNS, toCommitment, type CommitmentRow } from './commitments.js';
import type { MessageMeta } from './mailstore.js';
import { engagementSignalsForContact } from './signals.js';
import { decryptSummary } from './threads.js';

/**
 * Relationship intelligence derived from mail activity. Contacts carry
 * transparent facts (counts, dates, open promises, user notes and tags). There
 * is no opaque score: importance is VIP (the user said so), close (you write
 * to them often), known, or new.
 */

const WEBMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com']);

async function upsertContact(tx: SqlExecutor, userId: string, email: string, name: string | null, bulk: boolean): Promise<string> {
  const domain = email.split('@')[1] ?? '';
  let companyId: string | null = null;
  if (domain && !WEBMAIL.has(domain) && !bulk) {
    const company = await one<{ id: string }>(
      tx,
      `insert into public.companies (user_id, domain) values ($1::uuid, $2) on conflict (user_id, domain) do update set updated_at = now() returning id`,
      [userId, domain],
    );
    companyId = company?.id ?? null;
  }
  const row = await one<{ id: string }>(
    tx,
    `insert into public.contacts (user_id, email, name, company_id, is_bulk) values ($1::uuid, $2, $3, $4::uuid, $5)
     on conflict (user_id, email_normalized) do update set name = coalesce(public.contacts.name, excluded.name),
       company_id = coalesce(public.contacts.company_id, excluded.company_id), is_bulk = public.contacts.is_bulk and excluded.is_bulk, updated_at = now()
     returning id`,
    [userId, email, name, companyId, bulk],
  );
  return row!.id;
}

/** Contact bookkeeping for newly synced messages. Idempotent per message (called only for first inserts). */
export async function recordContacts(tx: SqlExecutor, userId: string, metas: Array<MessageMeta & { threadRowId: string }>): Promise<void> {
  for (const meta of metas) {
    const bulk = meta.isAuto || meta.listUnsubscribe;
    if (meta.direction === 'inbound' && meta.fromEmail) {
      const id = await upsertContact(tx, userId, meta.fromEmail, meta.fromName, bulk);
      await tx.query(
        `update public.contacts set received_count = received_count + 1, last_inbound_at = greatest(coalesce(last_inbound_at, $2::timestamptz), $2::timestamptz) where id = $1::uuid`,
        [id, meta.internalDate],
      );
      if (!bulk) await relationshipEvent(tx, userId, id, 'email_in', meta.internalDate, meta.threadRowId, meta.gmailThreadId, meta.gmailMessageId, meta.subject);
    } else if (meta.direction === 'outbound') {
      for (const email of [...meta.toEmails, ...meta.ccEmails].slice(0, 20)) {
        const id = await upsertContact(tx, userId, email, null, false);
        await tx.query(
          `update public.contacts set sent_count = sent_count + 1, is_bulk = false, last_outbound_at = greatest(coalesce(last_outbound_at, $2::timestamptz), $2::timestamptz) where id = $1::uuid`,
          [id, meta.internalDate],
        );
        await relationshipEvent(tx, userId, id, 'email_out', meta.internalDate, meta.threadRowId, meta.gmailThreadId, meta.gmailMessageId, meta.subject);
      }
    }
  }
}

export async function relationshipEvent(
  tx: SqlExecutor,
  userId: string,
  contactId: string,
  kind: 'email_in' | 'email_out' | 'meeting' | 'open' | 'click' | 'document_view' | 'commitment' | 'note',
  at: Date,
  threadRowId: string | null,
  gmailThreadId: string | null,
  ref: string,
  label: string,
): Promise<void> {
  await tx.query(
    `insert into public.relationship_events (user_id, contact_id, kind, at, thread_id, gmail_thread_id, ref, label)
     values ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::uuid, $6, $7, $8) on conflict (contact_id, kind, ref) do nothing`,
    [userId, contactId, kind, at, threadRowId, gmailThreadId, ref.slice(0, 200), label.slice(0, 200)],
  );
}

type ContactRow = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  domain: string | null;
  vip: boolean;
  tags: string[];
  aliases: string[];
  last_inbound_at: unknown;
  last_outbound_at: unknown;
  sent_count: number;
  received_count: number;
  notes_key_id: string | null;
  notes_iv: string | null;
  notes_ciphertext: string | null;
  waiting_on_me: boolean;
  waiting_on_them: boolean;
  open_commitments: number;
};

const CONTACT_QUERY = `
  select c.id, c.email, c.name, co.name as company, co.domain, c.vip, c.tags, c.aliases, c.last_inbound_at, c.last_outbound_at,
         c.sent_count, c.received_count, c.notes_key_id, c.notes_iv, c.notes_ciphertext,
         exists (select 1 from public.threads t join public.thread_states s on s.thread_id = t.id
                  where t.participants @> jsonb_build_array(jsonb_build_object('email', c.email_normalized))
                    and coalesce(s.user_state, s.state) in ('NEEDS_REPLY', 'WAITING_ON_ME')) as waiting_on_me,
         exists (select 1 from public.follow_ups f where c.email_normalized = any (f.expected_from) and f.stage in ('waiting', 'engaged', 'follow_up_due')) as waiting_on_them,
         (select count(*)::int from public.commitments m where lower(m.counterparty) = c.email_normalized and m.status = 'open') as open_commitments
    from public.contacts c left join public.companies co on co.id = c.company_id`;

export function importanceOf(row: Pick<ContactRow, 'vip' | 'sent_count' | 'received_count'>): RelationshipImportance {
  if (row.vip) return 'vip';
  if (num(row.sent_count) >= 5) return 'close';
  if (num(row.sent_count) >= 1) return 'known';
  return num(row.received_count) > 0 ? 'new' : 'unknown';
}

function toSummary(row: ContactRow): ContactSummary {
  const lastIn = isoOrNull(row.last_inbound_at);
  const lastOut = isoOrNull(row.last_outbound_at);
  return {
    id: row.id,
    email: row.email.slice(0, 320),
    name: row.name?.slice(0, 200) ?? null,
    company: row.company?.slice(0, 200) ?? (row.domain && !WEBMAIL.has(row.domain) ? row.domain : null),
    domain: (row.email.split('@')[1] ?? '').slice(0, 253),
    lastInteractionAt: [lastIn, lastOut].filter((value): value is string => Boolean(value)).sort().pop() ?? null,
    lastInboundAt: lastIn,
    lastOutboundAt: lastOut,
    sentCount: num(row.sent_count),
    receivedCount: num(row.received_count),
    waiting: row.waiting_on_me && row.waiting_on_them ? 'both' : row.waiting_on_me ? 'on_me' : row.waiting_on_them ? 'on_them' : 'none',
    openCommitments: num(row.open_commitments),
    vip: row.vip,
    tags: row.tags.slice(0, 20),
    importance: importanceOf(row),
  };
}

export async function listContacts(tx: SqlExecutor, options: { query?: string; cursor?: string; limit: number; vipOnly?: boolean }) {
  const params: unknown[] = [options.limit + 1, Number(options.cursor ?? 0) || 0];
  let where = 'not c.is_bulk';
  if (options.query?.trim()) {
    const query = options.query.trim().toLowerCase();
    params.push(`%${query.replace(/[%_\\]/g, (char) => `\\${char}`)}%`, query);
    where += ` and (c.email_normalized like $${params.length - 1} or lower(coalesce(c.name, '')) like $${params.length - 1} or lower(coalesce(co.name, co.domain, '')) like $${params.length - 1} or $${params.length} = any (c.tags))`;
  }
  if (options.vipOnly) where += ' and c.vip';
  const rows = await tx.query<ContactRow>(
    `${CONTACT_QUERY} where ${where} order by c.vip desc, greatest(c.last_inbound_at, c.last_outbound_at) desc nulls last limit $1 offset $2`,
    params,
  );
  const offset = Number(options.cursor ?? 0) || 0;
  return { contacts: rows.slice(0, options.limit).map(toSummary), nextCursor: rows.length > options.limit ? String(offset + options.limit) : null };
}

async function contactRow(tx: SqlExecutor, selector: { contactId?: string; email?: string }): Promise<ContactRow | null> {
  if (selector.contactId) return one<ContactRow>(tx, `${CONTACT_QUERY} where c.id = $1::uuid`, [selector.contactId]);
  return one<ContactRow>(tx, `${CONTACT_QUERY} where c.email_normalized = lower($1)`, [selector.email ?? '']);
}

export async function updateContact(tx: SqlExecutor, box: SecretBox, userId: string, input: { contactId: string; vip?: boolean; tags?: string[]; notes?: string }): Promise<ContactSummary> {
  const existing = await contactRow(tx, { contactId: input.contactId });
  if (!existing) throw new ApiError('not_found', 'That contact does not exist.');
  if (input.vip !== undefined) await tx.query(`update public.contacts set vip = $2, updated_at = now() where id = $1::uuid`, [input.contactId, input.vip]);
  if (input.tags) await tx.query(`update public.contacts set tags = $2::text[], updated_at = now() where id = $1::uuid`, [input.contactId, [...new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]]);
  if (input.notes !== undefined) {
    const sealed = input.notes ? await box.seal(input.notes, { purpose: 'note', userId, recordId: `contact:${input.contactId}` }) : null;
    await tx.query(`update public.contacts set notes_key_id = $2, notes_iv = $3, notes_ciphertext = $4, updated_at = now() where id = $1::uuid`, [
      input.contactId,
      sealed?.keyId ?? null,
      sealed?.iv ?? null,
      sealed?.ciphertext ?? null,
    ]);
  }
  return toSummary((await contactRow(tx, { contactId: input.contactId }))!);
}

async function contactNotes(box: SecretBox, userId: string, row: ContactRow): Promise<string> {
  if (!row.notes_key_id || !row.notes_iv || !row.notes_ciphertext) return '';
  return box.open({ keyId: row.notes_key_id, iv: row.notes_iv, ciphertext: row.notes_ciphertext }, { purpose: 'note', userId, recordId: `contact:${row.id}` }).catch(() => '');
}

const STATE_RANK: Record<string, number> = { NEEDS_REPLY: 0, WAITING_ON_ME: 1, FOLLOW_UP_DUE: 2, WAITING_ON_THEM: 3, SCHEDULED: 4, FYI: 5, DONE: 6 };

export async function relationshipBrief(tx: SqlExecutor, box: SecretBox, userId: string, selector: { contactId?: string; email?: string }, now: Date): Promise<RelationshipBrief> {
  const row = await contactRow(tx, selector);
  if (!row) throw new ApiError('not_found', 'PigeonBox has not seen mail with this person yet.');
  const contact = toSummary(row);
  const email = row.email.toLowerCase();
  const participant = JSON.stringify([{ email }]);

  const threads = await tx.query<{ id: string; gmail_thread_id: string; mail_account_id: string; subject: string; last_message_at: unknown; content_version: string; state: ThreadState | null; summary_key_id: string | null; summary_iv: string | null; summary_ciphertext: string | null }>(
    `select t.id, t.gmail_thread_id, t.mail_account_id, t.subject, t.last_message_at, t.content_version, coalesce(s.user_state, s.state) as state,
            s.summary_key_id, s.summary_iv, s.summary_ciphertext
       from public.threads t left join public.thread_states s on s.thread_id = t.id
      where t.participants @> $1::jsonb order by t.last_message_at desc nulls last limit 25`,
    [participant],
  );
  const latest = threads[0];
  const latestSummary = latest ? await decryptSummary(box, userId, latest) : null;
  const commitmentRows = await tx.query<CommitmentRow>(
    `select ${COMMITMENT_COLUMNS} from public.commitments c join public.threads t on t.id = c.thread_id where lower(c.counterparty) = $1 and c.status = 'open' order by c.due_at nulls last limit 40`,
    [email],
  );
  const completedRows = await tx.query<CommitmentRow>(
    `select ${COMMITMENT_COLUMNS} from public.commitments c join public.threads t on t.id = c.thread_id where lower(c.counterparty) = $1 and c.status = 'done' order by c.resolved_at desc nulls last limit 20`, [email],
  );
  const commitments = await Promise.all([...commitmentRows, ...completedRows].map((commitment) => toCommitment(box, userId, commitment)));
  const meeting = await one<{ event_id: string; title: string; start_at: unknown; html_link: string | null; mail_account_id: string }>(
    tx,
    `select event_id, title, start_at, html_link, mail_account_id from public.calendar_event_cache where $1 = any (attendees) and start_at > $2::timestamptz order by start_at limit 1`,
    [email, now],
  );
  const events = await tx.query<{ kind: RelationshipBrief['timeline'][number]['kind']; at: unknown; label: string; gmail_thread_id: string | null; mail_account_id: string | null }>(
    `select e.kind, e.at, e.label, e.gmail_thread_id, t.mail_account_id from public.relationship_events e left join public.threads t on t.id = e.thread_id where e.contact_id = $1::uuid order by e.at desc limit 30`,
    [row.id],
  );
  const notes = await contactNotes(box, userId, row);
  const whoParts: string[] = [];
  if (row.name) whoParts.push(row.name);
  if (contact.company) whoParts.push(`at ${contact.company}`);
  if (row.tags.length) whoParts.push(`(${row.tags.join(', ')})`);
  const known = contact.sentCount + contact.receivedCount;
  const exchanged = `${known} email${known === 1 ? '' : 's'} exchanged in synced mail.`;
  const whoTheyAre = whoParts.length ? `${whoParts.join(' ')}. ${exchanged}` : `PigeonBox only knows this person from email activity. ${exchanged}`;

  return {
    contact,
    aliases: row.aliases.slice(0, 20),
    whoTheyAre: whoTheyAre.slice(0, 500),
    lastDiscussed:
      latest && latestSummary?.oneLine
        ? { text: latestSummary.oneLine.slice(0, 400), source: { id: `thread:${latest.gmail_thread_id}`, kind: 'thread', title: latest.subject || '(no subject)', gmailThreadId: latest.gmail_thread_id, accountId: latest.mail_account_id, at: isoOrNull(latest.last_message_at) ?? undefined } }
        : null,
    youOwe: commitments.filter((commitment) => commitment.direction === 'mine' && commitment.status === 'open').slice(0,20),
    theyOwe: commitments.filter((commitment) => commitment.direction === 'theirs' && commitment.status === 'open').slice(0,20),
    recentlyCompleted: commitments.filter((commitment) => commitment.status === 'done').slice(0,20),
    nextMeeting: meeting
      ? { title: meeting.title.slice(0, 300) || '(untitled event)', start: iso(meeting.start_at), source: { id: `event:${meeting.event_id}`, kind: 'calendar_event', title: meeting.title.slice(0, 300) || 'Event', accountId: meeting.mail_account_id, ...(meeting.html_link ? { url: meeting.html_link } : {}) } }
      : null,
    importantThreads: [...threads]
      .filter((thread) => thread.state && thread.state in STATE_RANK)
      .sort((a, b) => (STATE_RANK[a.state!] ?? 9) - (STATE_RANK[b.state!] ?? 9))
      .slice(0, 10)
      .map((thread) => ({ threadId: thread.gmail_thread_id, accountId: thread.mail_account_id, subject: (thread.subject || '(no subject)').slice(0, 998), lastMessageAt: iso(thread.last_message_at ?? now), state: thread.state! })),
    timeline: events.map((event) => ({
      at: iso(event.at),
      kind: event.kind,
      label: event.label.slice(0, 200) || event.kind.replace('_', ' '),
      ...(event.gmail_thread_id ? { source: { id: `thread:${event.gmail_thread_id}`, kind: 'thread' as const, title: event.label.slice(0, 300) || 'Thread', gmailThreadId: event.gmail_thread_id, accountId: event.mail_account_id ?? undefined } } : {}),
    })),
    notes: notes.slice(0, 5_000),
    signals: await engagementSignalsForContact(tx, email, now),
  };
}

type RadarRow = ContactRow & { reason_at: unknown; thread_id: string | null; commitment_id?: string; promise_key?: string; promise_iv?: string; promise_ciphertext?: string };

export async function radar(tx: SqlExecutor, now: Date, box: SecretBox, userId: string) {
  const item = (row: RadarRow, reason: string) => ({ contact: toSummary(row), reason: reason.slice(0, 200), threadId: row.thread_id, at: isoOrNull(row.reason_at) });
  const days = (value: unknown) => Math.floor((now.getTime() - Date.parse(iso(value))) / 86_400_000);
  const goingCold = await tx.query<RadarRow>(
    `${CONTACT_QUERY.replace('select c.id', 'select greatest(c.last_inbound_at, c.last_outbound_at) as reason_at, null::text as thread_id, c.id')}
      where not c.is_bulk and c.sent_count >= 3 and c.received_count >= 2
        and greatest(c.last_inbound_at, c.last_outbound_at) between $1::timestamptz - interval '180 days' and $1::timestamptz - interval '30 days'
      order by c.vip desc, c.sent_count desc limit 10`,
    [now],
  );
  const unanswered = await tx.query<RadarRow>(
    `select distinct on (c.id) t.last_inbound_at as reason_at, t.gmail_thread_id as thread_id, ${CONTACT_QUERY.slice(CONTACT_QUERY.indexOf('c.id'))}
       join public.message_metadata m on lower(m.from_email) = c.email_normalized and m.direction = 'inbound'
       join public.threads t on t.id = m.thread_id join public.thread_states s on s.thread_id = t.id
      where coalesce(s.user_state, s.state) = 'NEEDS_REPLY' and (c.vip or c.sent_count >= 3) and t.last_inbound_at < $1::timestamptz - interval '2 days'
      order by c.id, t.last_inbound_at limit 10`,
    [now],
  );
  const promised = await tx.query<RadarRow>(
    `select distinct on (c.id) m.id as commitment_id,m.text_key_id as promise_key,m.text_iv as promise_iv,m.text_ciphertext as promise_ciphertext,m.due_at as reason_at, t.gmail_thread_id as thread_id, ${CONTACT_QUERY.slice(CONTACT_QUERY.indexOf('c.id'))}
       join public.commitments m on lower(m.counterparty) = c.email_normalized and m.direction = 'mine' and m.status = 'open'
       join public.threads t on t.id = m.thread_id
      where m.due_at is null or m.due_at < $1::timestamptz + interval '7 days'
      order by c.id, m.due_at nulls last limit 10`,
    [now],
  );
  const revived = await tx.query<RadarRow>(
    `select distinct on (c.id) t.last_inbound_at as reason_at, t.gmail_thread_id as thread_id, ${CONTACT_QUERY.slice(CONTACT_QUERY.indexOf('c.id'))}
       join public.message_metadata m on lower(m.from_email) = c.email_normalized and m.direction = 'inbound'
       join public.threads t on t.id = m.thread_id
      where m.internal_date > $1::timestamptz - interval '7 days'
        and exists (select 1 from public.message_metadata p where p.thread_id = t.id and p.internal_date < m.internal_date - interval '21 days')
        and not exists (select 1 from public.message_metadata q where q.thread_id = t.id and q.internal_date < m.internal_date and q.internal_date >= m.internal_date - interval '21 days')
      order by c.id, m.internal_date desc limit 10`,
    [now],
  );
  const meetings = await tx.query<RadarRow>(
    `select distinct on (c.id) e.start_at as reason_at, null::text as thread_id, ${CONTACT_QUERY.slice(CONTACT_QUERY.indexOf('c.id'))}
       join public.calendar_event_cache e on c.email_normalized = any (e.attendees)
      where e.start_at between $1::timestamptz and $1::timestamptz + interval '7 days'
      order by c.id, e.start_at limit 10`,
    [now],
  );
  const vip = await tx.query<RadarRow>(
    `${CONTACT_QUERY.replace('select c.id', 'select c.last_inbound_at as reason_at, null::text as thread_id, c.id')}
      where c.vip and c.last_inbound_at > $1::timestamptz - interval '3 days' order by c.last_inbound_at desc limit 10`,
    [now],
  );
  return {
    goingCold: goingCold.map((row) => item(row, `No contact for ${days(row.reason_at)} days after ${num(row.sent_count) + num(row.received_count)} emails`)),
    unansweredImportant: unanswered.map((row) => item(row, `Waiting on your reply for ${days(row.reason_at)} days`)),
    promisedFollowUps: await Promise.all(promised.map(async (row) => {
      const promise = row.commitment_id && row.promise_key && row.promise_iv && row.promise_ciphertext
        ? await box.open({ keyId: row.promise_key, iv: row.promise_iv, ciphertext: row.promise_ciphertext }, { purpose: 'commitment', userId, recordId: row.commitment_id }).catch(() => '') : '';
      return item(row, `${promise || 'An open promise'}${row.reason_at ? ` · due ${iso(row.reason_at).slice(0,10)}` : ' · no due date'}`);
    })),
    revived: revived.map((row) => item(row, 'Wrote again after a quiet stretch')),
    upcomingMeetings: meetings.map((row) => item(row, `Meeting ${iso(row.reason_at).slice(0, 16).replace('T', ' ')} UTC`)),
    vipActivity: vip.map((row) => item(row, 'Wrote to you recently')),
  };
}
