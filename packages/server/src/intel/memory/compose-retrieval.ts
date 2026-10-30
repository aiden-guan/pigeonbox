import type { SourceRef } from '@pigeonbox/api-contract';
import { iso, num, type SqlExecutor } from '../../db/sql.js';
import type { IntelDeps } from '../context.js';
import { safeMemoryText } from './policy.js';
import { composeTopicWords } from '../compose-context.js';
import type { ContextItem } from './rank.js';
import type { ContextRequest } from './retrieve.js';

type Person = { email: string; name: string };
/** Resolve only actual scoped contacts, and only unique names. Bare contacts never prove notices. */
export async function resolveComposePeople(tx: SqlExecutor, claim: string): Promise<Person[]> {
  const rows = await tx.query<Person>(
    `select email, coalesce(name,email) as name from public.contacts
     where not is_bulk and ((name is not null and length(split_part(name,' ',1)) >= 3
       and strpos(' ' || lower(regexp_replace($1,'[^[:alnum:]@._]+',' ','g')) || ' ', ' ' || lower(split_part(name,' ',1)) || ' ') > 0)
       or strpos(lower($1),lower(email)) > 0) order by email limit 13`, [claim]);
  if (rows.length > 12) return [];
  const normalized = ` ${claim.toLowerCase().replace(/[^a-z0-9@._]+/g,' ')} `;
  const resolved = rows.filter(row => normalized.includes(` ${row.email.toLowerCase()} `) ||
    (normalized.includes(` ${row.name.toLowerCase()} `) && rows.filter(other => other.name.toLowerCase() === row.name.toLowerCase()).length === 1) ||
    rows.filter(other => other.name.split(' ')[0]!.toLowerCase() === row.name.split(' ')[0]!.toLowerCase()).length === 1);
  if (rows.length && !resolved.length) {
    const error = new Error('ambiguous_compose_person');
    error.name = 'AmbiguousComposePerson';
    throw error;
  }
  return resolved;
}

/** Adds bounded existing metadata to the canonical retrieval pool. No second store. */
export async function addComposeSources(tx: SqlExecutor, deps: IntelDeps, input: ContextRequest, recipients: string[], people: Person[], vector: string | null, pool: ContextItem[], base: (ref: SourceRef, text: string, options?: Partial<ContextItem>) => ContextItem): Promise<void> {
  const interactions = recipients.length ? await tx.query<{ id: string; email: string; name: string; kind: string; at: unknown; thread_id: string; gmail_thread_id: string; mail_account_id: string; subject: string; content_version: string }>(
    `select distinct on (c.email_normalized) e.id,c.email,coalesce(c.name,c.email) as name,e.kind,e.at,e.thread_id,t.gmail_thread_id,t.mail_account_id,t.subject,t.content_version
     from public.relationship_events e join public.contacts c on c.id = e.contact_id
     join public.threads t on t.id = e.thread_id join public.mail_accounts a on a.id = t.mail_account_id
     join public.thread_states s on s.thread_id = t.id
     where c.email_normalized = any($1::text[]) and not c.is_bulk and e.kind in ('email_in','email_out')
       and a.status = 'active' and not t.is_bulk and not s.injection_suspected and s.analyzed_version = t.content_version
       and e.at <= $2::timestamptz and e.at >= $2::timestamptz - interval '90 days'
       and not exists(select 1 from public.personal_memory_exclusions x where x.thread_id = t.id)
     order by c.email_normalized,e.at desc limit 8`, [recipients, input.now]) : [];
  for (const row of interactions) {
    const at = iso(row.at);
    const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: input.prefs.timeZone }).format(new Date(at));
    const text = row.kind === 'email_in' ? `${row.name} emailed you on ${label}.` : `You emailed ${row.name} on ${label}.`;
    if (!safeMemoryText(`${text} ${row.subject}`)) continue;
    pool.push(base({ id: `interaction:${row.id}`, kind: 'message', title: row.subject.slice(0,300), who: row.email, accountId: row.mail_account_id, gmailThreadId: row.gmail_thread_id, at, version: row.content_version }, text, {
      confidence: 1, recipientMatch: input.recipientEmails.includes(row.email), entityMatch: people.some(person => person.email === row.email), at,
      interaction: { email: row.email, name: row.name, direction: row.kind === 'email_in' ? 'in' : 'out', threadRowId: row.thread_id },
    }));
  }
  if (!input.calendar) return;
  const topicQuery = [...composeTopicWords(input.composeText ?? '')].slice(0, 24).join(' OR ');
  const linkedText = pool.filter(item => item.status === 'active' && item.confidence >= 0.9 && safeMemoryText(item.text))
    .slice(0, 12).map(item => (item.assertion ?? item.text).slice(0, 400));
  const events = await tx.query<{ id: string; event_id: string; mail_account_id: string; title: string; location: string | null; start_at: unknown; end_at: unknown; all_day: boolean; html_link: string | null; etag: string | null; updated_at: unknown; semantic: number }>(
    `select e.*,case when $3::extensions.vector is null or e.embedding is null or e.embedding_model is distinct from $4 then 0 else 1-(e.embedding <=> $3::extensions.vector) end as semantic
     from public.calendar_event_cache e join public.mail_accounts a on a.id = e.mail_account_id
     where a.status = 'active' and 'calendar_read' = any(a.features) and e.start_at > $2::timestamptz
       and e.start_at < $2::timestamptz + interval '45 days' and e.updated_at >= $2::timestamptz - interval '30 minutes'
       and coalesce(e.status,'confirmed') <> 'cancelled' and coalesce(e.self_response,'accepted') in ('accepted','organizer')
     order by (e.search_tsv @@ websearch_to_tsquery('simple',$5)) desc,
       exists(select 1 from unnest($6::text[]) as linked(text) where length(e.title) >= 4 and strpos(lower(linked.text),lower(e.title)) > 0) desc,
       (e.attendees && $1::text[]) desc,semantic desc,e.start_at limit 12`, [recipients, input.now, vector, deps.config.ai.embedModel, topicQuery, linkedText]);
  for (const row of events) {
    if (!safeMemoryText(`${row.title} ${row.location ?? ''}`)) continue;
    let url: string | undefined;
    try { const parsed = new URL(row.html_link ?? ''); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && (parsed.hostname === 'calendar.google.com' || (parsed.hostname === 'www.google.com' && parsed.pathname.startsWith('/calendar/')))) url = parsed.href; } catch { /* no link */ }
    const start = iso(row.start_at), end = iso(row.end_at), refreshedAt = iso(row.updated_at);
    pool.push(base({ id: `event:${row.id}`, kind: 'calendar_event', title: row.title, accountId: row.mail_account_id, at: start, version: row.etag ?? refreshedAt, ...(url ? { url } : {}) }, `${row.title}${row.location ? ` at ${row.location}` : ''}. Starts ${start}; ends ${end}.`, {
      confidence: 1, importance: 0.9, semantic: num(row.semantic), at: refreshedAt, validUntil: end,
      calendar: { rowId: row.id, start, end, allDay: row.all_day, location: row.location, refreshedAt, version: row.etag },
    }));
  }
}
