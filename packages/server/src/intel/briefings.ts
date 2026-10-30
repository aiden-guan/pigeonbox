import { featureEnabled } from '../rollout.js';
import type { Briefing, SourceRef } from '@pigeonbox/api-contract';
import { focusScore, safeTimeZone, startOfLocalDay, type ThreadState } from '@pigeonbox/shared';
import { iso, isoOrNull, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import type { JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { COMMITMENT_COLUMNS, toCommitment, type CommitmentRow } from './commitments.js';
import type { IntelDeps } from './context.js';
import { notify } from './notifications.js';
import { loadPreferences } from './preferences.js';
import { decryptSummary } from './threads.js';

/**
 * Briefings, built from synced data rather than generated prose: every item is
 * a fact with the record it came from. Stored encrypted; delivered as an
 * in-product notification to the extension and web app.
 */

type Section = Briefing['sections'][number];

/** Collects each source once; items refer to sources by their ID. */
class Builder {
  readonly sources: SourceRef[] = [];
  private readonly seen = new Set<string>();

  source(ref: SourceRef): string {
    if (!this.seen.has(ref.id)) {
      this.seen.add(ref.id);
      this.sources.push(ref);
    }
    return ref.id;
  }
}

type ThreadRow = {
  id: string;
  gmail_thread_id: string;
  mail_account_id: string;
  subject: string;
  last_message_at: unknown;
  state: ThreadState;
  urgency: string;
  priority: 'HIGH' | 'NORMAL' | 'LOW';
  deadline_at: unknown;
  relationship_importance: 'vip' | 'close' | 'known' | 'new' | 'unknown';
  confidence: number;
  who: string | null;
  summary_key_id: string | null;
  summary_iv: string | null;
  summary_ciphertext: string | null;
};

const THREAD_ROWS = `
  select t.id, t.gmail_thread_id, t.mail_account_id, t.subject, t.last_message_at, coalesce(s.user_state, s.state) as state, s.urgency, s.priority,
         s.deadline_at, s.relationship_importance, s.confidence, s.summary_key_id, s.summary_iv, s.summary_ciphertext,
         (select coalesce(nullif(m.from_name, ''), m.from_email) from public.message_metadata m where m.thread_id = t.id and m.direction = 'inbound' order by m.internal_date desc limit 1) as who
    from public.threads t join public.thread_states s on s.thread_id = t.id`;

function threadRef(row: Pick<ThreadRow, 'gmail_thread_id' | 'mail_account_id' | 'subject' | 'last_message_at' | 'who'>): SourceRef {
  return {
    id: `thread:${row.gmail_thread_id}`,
    kind: 'thread',
    title: (row.subject || '(no subject)').slice(0, 300),
    gmailThreadId: row.gmail_thread_id,
    accountId: row.mail_account_id,
    ...(row.last_message_at ? { at: iso(row.last_message_at) } : {}),
    ...(row.who ? { who: row.who.slice(0, 320) } : {}),
  };
}

function when(value: unknown, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso(value)));
}

async function threadItems(tx: SqlExecutor, deps: IntelDeps, userId: string, builder: Builder, rows: ThreadRow[], describe: (row: ThreadRow, summary: string | null) => string) {
  const items: Section['items'] = [];
  for (const row of rows) {
    const summary = await decryptSummary(deps.box, userId, row);
    items.push({ text: describe(row, summary?.oneLine ?? null).slice(0, 500), threadId: row.gmail_thread_id, sourceIds: [builder.source(threadRef(row))], at: isoOrNull(row.last_message_at) ?? undefined });
  }
  return items;
}

async function meetingsBetween(tx: SqlExecutor, start: Date, end: Date) {
  return tx.query<{ event_id: string; title: string; start_at: unknown; end_at: unknown; attendees: string[]; html_link: string | null; mail_account_id: string }>(
    `select event_id, title, start_at, end_at, attendees, html_link, mail_account_id from public.calendar_event_cache
      where start_at >= $1::timestamptz and start_at < $2::timestamptz and not all_day and coalesce(status, 'confirmed') <> 'cancelled'
        and coalesce(self_response, 'accepted') <> 'declined' order by start_at limit 20`,
    [start, end],
  );
}

function meetingItems(builder: Builder, rows: Awaited<ReturnType<typeof meetingsBetween>>, timeZone: string): Section['items'] {
  return rows.map((event) => ({
    text: `${when(event.start_at, timeZone)} · ${event.title || '(untitled)'}${event.attendees.length ? ` · ${event.attendees.length} attendee${event.attendees.length === 1 ? '' : 's'}` : ''}`.slice(0, 500),
    sourceIds: [builder.source({ id: `event:${event.event_id}`, kind: 'calendar_event', title: (event.title || 'Event').slice(0, 300), accountId: event.mail_account_id, at: iso(event.start_at), ...(event.html_link ? { url: event.html_link } : {}) })],
    at: iso(event.start_at),
  }));
}

async function coverageNote(tx: SqlExecutor): Promise<string> {
  const row = await one<{ n: number; unhealthy: number }>(
    tx,
    `select count(*)::int as n, count(*) filter (where s.state in ('stalled', 'degraded', 'recovering'))::int as unhealthy
       from public.mail_accounts a join public.gmail_sync_state s on s.mail_account_id = a.id where a.status = 'active'`,
  );
  if (!row?.n) return 'No Google account is syncing, so this brief is empty.';
  return row.unhealthy ? 'Some mail may be out of date or is still being imported, so this brief may be incomplete.' : 'Built from mail your PigeonBox server has synced.';
}

export async function buildDailyBrief(deps: IntelDeps, tx: SqlExecutor, userId: string, kind: 'morning' | 'end_of_day') {
  const prefs = await loadPreferences(tx, userId);
  const zone = safeTimeZone(prefs.timeZone);
  const now = deps.now();
  const dayStart = startOfLocalDay(now, zone);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const builder = new Builder();
  const sections: Section[] = [];

  const open = await tx.query<ThreadRow>(`${THREAD_ROWS} where coalesce(s.user_state, s.state) in ('NEEDS_REPLY', 'WAITING_ON_ME') and t.last_message_at > $1::timestamptz - interval '30 days' limit 200`, [now]);
  const ranked = open
    .map((row) => ({ row, score: focusScore({ state: row.state, priority: row.priority, deadlineAt: isoOrNull(row.deadline_at), lastMessageAt: iso(row.last_message_at ?? now), relationshipImportance: row.relationship_importance, confidence: row.confidence }, now).score }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.row);
  const follows = await tx.query<ThreadRow & { stage: string; due_at: unknown; expected: string[] }>(
    `select t.id, t.gmail_thread_id, t.mail_account_id, t.subject, t.last_message_at, f.stage, f.due_at, f.expected_from as expected, null::text as who
       from public.follow_ups f join public.threads t on t.id = f.thread_id where f.stage in ('waiting', 'engaged', 'follow_up_due') order by f.due_at nulls last limit 20`,
  );

  if (kind === 'morning') {
    const urgent = ranked.filter((row) => row.urgency === 'critical' || row.urgency === 'high' || (row.deadline_at && Date.parse(iso(row.deadline_at)) < dayEnd.getTime()));
    sections.push({ id: 'urgent', title: 'Urgent', items: await threadItems(tx, deps, userId, builder, urgent.slice(0, 5), (row, summary) => `${row.who ?? 'Someone'}: ${summary ?? row.subject}`), empty: 'Nothing urgent.' });
    const replies = ranked.filter((row) => !urgent.includes(row));
    sections.push({ id: 'replies', title: 'Replies needed', items: await threadItems(tx, deps, userId, builder, replies.slice(0, 8), (row, summary) => `${row.who ?? 'Someone'}: ${summary ?? row.subject}`), empty: 'No replies waiting on you.' });
    sections.push({
      id: 'waiting',
      title: 'Waiting on others',
      items: follows.slice(0, 8).map((row) => ({
        text: `${row.subject || '(no subject)'} · ${row.stage === 'follow_up_due' ? 'follow-up due' : row.stage === 'engaged' ? 'likely seen, no reply' : `waiting on ${row.expected[0] ?? 'them'}`}`.slice(0, 500),
        threadId: row.gmail_thread_id,
        sourceIds: [builder.source(threadRef(row))],
      })),
      empty: 'Nobody owes you a reply.',
    });
    const deadlines = await tx.query<ThreadRow>(`${THREAD_ROWS} where s.deadline_at between $1::timestamptz and $1::timestamptz + interval '3 days' order by s.deadline_at limit 10`, [now]);
    const commitments = await tx.query<CommitmentRow>(
      `select ${COMMITMENT_COLUMNS} from public.commitments c join public.threads t on t.id = c.thread_id
        where c.status = 'open' and c.direction = 'mine' and c.due_at < $1::timestamptz + interval '3 days' order by c.due_at limit 10`,
      [now],
    );
    const deadlineItems = await threadItems(tx, deps, userId, builder, deadlines, (row) => `${row.subject || '(no subject)'} · due ${when(row.deadline_at, zone)}`);
    for (const row of commitments) {
      const commitment = await toCommitment(deps.box, userId, row);
      deadlineItems.push({ text: `You promised: ${commitment.text}${commitment.dueAt ? ` · due ${when(commitment.dueAt, zone)}` : ''}`, threadId: row.gmail_thread_id, sourceIds: [builder.source(commitment.source)], at: commitment.dueAt ?? undefined });
    }
    sections.push({ id: 'deadlines', title: 'Deadlines', items: deadlineItems.slice(0, 12), empty: 'No deadlines in the next three days.' });
    sections.push({ id: 'meetings', title: 'Today’s meetings', items: meetingItems(builder, await meetingsBetween(tx, now, dayEnd), zone), empty: 'No meetings on your calendar today.' });
    const drafts = await tx.query<ThreadRow>(
      `${THREAD_ROWS} join public.drafts d on d.thread_id = t.id and d.status in ('ready', 'placed') and d.based_on_version = t.content_version order by d.updated_at desc limit 8`,
    );
    sections.push({ id: 'drafts', title: 'Drafts ready for review', items: await threadItems(tx, deps, userId, builder, drafts, (row) => `Draft ready: ${row.subject || '(no subject)'}`), empty: 'No drafts waiting.' });
  } else {
    sections.push({ id: 'unresolved', title: 'Still needs you', items: await threadItems(tx, deps, userId, builder, ranked.slice(0, 8), (row, summary) => `${row.who ?? 'Someone'}: ${summary ?? row.subject}`), empty: 'You are caught up.' });
    const promised = await tx.query<CommitmentRow>(
      `select ${COMMITMENT_COLUMNS} from public.commitments c join public.threads t on t.id = c.thread_id
        where c.direction = 'mine' and c.status = 'open' and c.created_at >= $1::timestamptz order by c.created_at limit 10`,
      [dayStart],
    );
    const promisedItems: Section['items'] = [];
    for (const row of promised) {
      const commitment = await toCommitment(deps.box, userId, row);
      promisedItems.push({ text: `You promised: ${commitment.text}`, threadId: row.gmail_thread_id, sourceIds: [builder.source(commitment.source)] });
    }
    sections.push({ id: 'promised', title: 'Promised today', items: promisedItems, empty: 'No new promises today.' });
    sections.push({
      id: 'waiting',
      title: 'Replies still pending',
      items: follows.slice(0, 8).map((row) => ({ text: `${row.subject || '(no subject)'} · waiting on ${row.expected[0] ?? 'them'}`.slice(0, 500), threadId: row.gmail_thread_id, sourceIds: [builder.source(threadRef(row))] })),
      empty: 'Nothing pending.',
    });
    sections.push({ id: 'tomorrow', title: 'Tomorrow’s meetings', items: meetingItems(builder, await meetingsBetween(tx, dayEnd, new Date(dayEnd.getTime() + 86_400_000)), zone), empty: 'No meetings tomorrow.' });
  }
  return {
    kind,
    title: kind === 'morning' ? 'Morning brief' : 'End-of-day brief',
    periodStart: dayStart,
    periodEnd: dayEnd,
    eventId: null as string | null,
    sections,
    sources: builder.sources,
    coverageNote: await coverageNote(tx),
  };
}

export async function buildMeetingBrief(deps: IntelDeps, tx: SqlExecutor, userId: string, eventId: string) {
  const event = await one<{ event_id: string; mail_account_id: string; title: string; start_at: unknown; end_at: unknown; attendees: string[]; html_link: string | null }>(
    tx,
    `select event_id, mail_account_id, title, start_at, end_at, attendees, html_link from public.calendar_event_cache where event_id = $1`,
    [eventId],
  );
  if (!event) throw new ApiError('not_found', 'PigeonBox has not seen that event. It refreshes calendars every 15 minutes.');
  const owner = await one<{ email: string }>(tx, `select email from public.mail_accounts where id = $1::uuid`, [event.mail_account_id]);
  const attendees = event.attendees.filter((email) => email !== owner?.email.toLowerCase()).slice(0, 12);
  const builder = new Builder();
  const eventSource = builder.source({ id: `event:${event.event_id}`, kind: 'calendar_event', title: event.title.slice(0, 300) || 'Event', accountId: event.mail_account_id, at: iso(event.start_at), ...(event.html_link ? { url: event.html_link } : {}) });
  const sections: Section[] = [];

  const people: Section['items'] = [];
  for (const email of attendees) {
    const contact = await one<{ name: string | null; sent_count: number; received_count: number; vip: boolean }>(tx, `select name, sent_count, received_count, vip from public.contacts where email_normalized = $1`, [email]);
    const count = (contact?.sent_count ?? 0) + (contact?.received_count ?? 0);
    people.push({ text: `${contact?.name ? `${contact.name} <${email}>` : email}${contact?.vip ? ' · VIP' : ''} · ${count ? `${count} emails exchanged` : 'no email history'}`, sourceIds: [eventSource] });
  }
  sections.push({ id: 'attendees', title: 'Who is coming', items: people, empty: 'Only you are on the invite.' });

  const threads = attendees.length
    ? await tx.query<ThreadRow>(
        `${THREAD_ROWS} where exists (select 1 from jsonb_array_elements(t.participants) p where p ->> 'email' = any ($1::text[])) order by t.last_message_at desc nulls last limit 6`,
        [attendees],
      )
    : [];
  sections.push({ id: 'discussed', title: 'Last discussions', items: await threadItems(tx, deps, userId, builder, threads, (row, summary) => `${row.subject || '(no subject)'}${summary ? `: ${summary}` : ''}`), empty: 'No recent email with these people.' });

  const commitments = attendees.length
    ? await tx.query<CommitmentRow>(`select ${COMMITMENT_COLUMNS} from public.commitments c join public.threads t on t.id = c.thread_id where c.status = 'open' and lower(c.counterparty) = any ($1::text[]) limit 10`, [attendees])
    : [];
  const open: Section['items'] = [];
  for (const row of commitments) {
    const commitment = await toCommitment(deps.box, userId, row);
    open.push({ text: `${commitment.direction === 'mine' ? 'You owe' : `${commitment.owner} owes you`}: ${commitment.text}`, threadId: row.gmail_thread_id, sourceIds: [builder.source(commitment.source)] });
  }
  const unanswered = threads.filter((row) => row.state === 'NEEDS_REPLY' || row.state === 'WAITING_ON_ME');
  for (const row of unanswered) open.push({ text: `Unanswered: ${row.subject || '(no subject)'}`, threadId: row.gmail_thread_id, sourceIds: [builder.source(threadRef(row))] });
  sections.push({ id: 'open', title: 'Open questions and promises', items: open.slice(0, 12), empty: 'Nothing outstanding with these people.' });

  const documents = attendees.length
    ? await tx.query<{ id: string; title: string; created_at: unknown; recipient_email: string }>(
        `select d.id, d.title, r.created_at, r.recipient_email from public.document_recipients r join public.documents d on d.id = r.document_id
          where lower(r.recipient_email) = any ($1::text[]) and d.status = 'ready' order by r.created_at desc limit 5`,
        [attendees],
      )
    : [];
  sections.push({
    id: 'documents',
    title: 'Documents you shared',
    items: documents.map((doc) => ({ text: `${doc.title} → ${doc.recipient_email}`, sourceIds: [builder.source({ id: `document:${doc.id}`, kind: 'document', title: doc.title.slice(0, 300), at: iso(doc.created_at) })] })),
    empty: 'No tracked documents shared with these people.',
  });
  return {
    kind: 'meeting' as const,
    title: `Brief: ${event.title || 'Meeting'}`.slice(0, 200),
    periodStart: new Date(iso(event.start_at)),
    periodEnd: new Date(iso(event.end_at)),
    eventId: event.event_id,
    sections,
    sources: builder.sources,
    coverageNote: await coverageNote(tx),
  };
}

type Built = Awaited<ReturnType<typeof buildDailyBrief>> | Awaited<ReturnType<typeof buildMeetingBrief>>;

export async function saveBriefing(deps: IntelDeps, tx: SqlExecutor, userId: string, built: Built, dedupeKey: string): Promise<Briefing> {
  const existing = await one<{ id: string }>(tx, `select id from public.briefings where dedupe_key = $1`, [dedupeKey]);
  const id = existing?.id ?? crypto.randomUUID();
  const content = { sections: built.sections, sources: built.sources.slice(0, 80), coverageNote: built.coverageNote };
  const sealed = await deps.box.seal(JSON.stringify(content), { purpose: 'briefing', userId, recordId: id });
  await tx.query(
    `insert into public.briefings (id, user_id, kind, title, period_start, period_end, event_id, content_key_id, content_iv, content_ciphertext, dedupe_key)
     values ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10, $11)
     on conflict (user_id, dedupe_key) do update set content_key_id = excluded.content_key_id, content_iv = excluded.content_iv,
       content_ciphertext = excluded.content_ciphertext, generated_at = now()`,
    [id, userId, built.kind, built.title, built.periodStart, built.periodEnd, built.eventId, sealed.keyId, sealed.iv, sealed.ciphertext, dedupeKey],
  );
  return (await loadBriefing(deps, tx, userId, id))!;
}

export async function loadBriefing(deps: IntelDeps, tx: SqlExecutor, userId: string, id: string): Promise<Briefing | null> {
  const row = await one<{ id: string; kind: Briefing['kind']; title: string; generated_at: unknown; period_start: unknown; period_end: unknown; event_id: string | null; content_key_id: string; content_iv: string; content_ciphertext: string }>(
    tx,
    `select * from public.briefings where id = $1::uuid`,
    [id],
  );
  if (!row) return null;
  const content = JSON.parse(await deps.box.open({ keyId: row.content_key_id, iv: row.content_iv, ciphertext: row.content_ciphertext }, { purpose: 'briefing', userId, recordId: row.id })) as {
    sections: Briefing['sections'];
    sources: SourceRef[];
    coverageNote: string;
  };
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    generatedAt: iso(row.generated_at),
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    eventId: row.event_id,
    sections: content.sections,
    sources: content.sources,
    coverageNote: content.coverageNote.slice(0, 300),
  };
}

export async function listBriefings(tx: SqlExecutor, kind: Briefing['kind'] | undefined, limit: number) {
  const rows = await tx.query<{ id: string; kind: Briefing['kind']; title: string; generated_at: unknown; event_id: string | null }>(
    `select id, kind, title, generated_at, event_id from public.briefings ${kind ? 'where kind = $2' : ''} order by generated_at desc limit $1`,
    kind ? [limit, kind] : [limit],
  );
  return rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, generatedAt: iso(row.generated_at), eventId: row.event_id }));
}

/** Scheduled or meeting briefing job. */
export async function runBriefing(deps: IntelDeps, job: JobRecord): Promise<void> {
  if (!job.userId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const kind = String(job.payload.kind ?? 'morning') as Briefing['kind'];
  // Briefing jobs are always scheduled; one the person asks for runs through its route.
  if (!featureEnabled(deps.config.rollout, 'briefings', userId)) throw new SkipJob('rollout_off');
  await deps.db.asUser(userId, async (tx) => {
    const prefs = await loadPreferences(tx, userId);
    if (kind === 'meeting' && !prefs.briefings.meeting.enabled) throw new SkipJob('disabled');
    if (kind === 'morning' && !prefs.briefings.morning.enabled) throw new SkipJob('disabled');
    if (kind === 'end_of_day' && !prefs.briefings.endOfDay.enabled) throw new SkipJob('disabled');
    const built = kind === 'meeting' ? await buildMeetingBrief(deps, tx, userId, String(job.payload.eventId ?? '')) : await buildDailyBrief(deps, tx, userId, kind);
    const briefing = await saveBriefing(deps, tx, userId, built, job.idempotencyKey);
    const count = briefing.sections.reduce((sum, section) => sum + section.items.length, 0);
    await notify(tx, {
      userId,
      kind: 'briefing',
      title: briefing.title,
      body: count ? `${count} item${count === 1 ? '' : 's'} across ${briefing.sections.filter((section) => section.items.length).length} sections.` : 'Nothing needs you right now.',
      refId: briefing.id,
      dedupeKey: `briefing:${job.idempotencyKey}`,
    });
  });
}
