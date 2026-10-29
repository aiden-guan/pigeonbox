import { iso } from '../../db/sql.js';
import type { IntelDeps } from '../context.js';
import type { ContextItem } from './rank.js';
import { loadPreferences } from '../preferences.js';
import { calendarFor, type AccountRow } from '../google-access.js';
import { composeCalendarItem } from '../compose-calendar.js';

/** Batched, user-scoped source checks after slow arbitration; no source prose is loaded. */
export async function revalidateComposeEvidence(deps: IntelDeps, userId: string, evidence: ContextItem[], now: Date, accountId: string, mode: 'checks' | 'completion' = 'checks'): Promise<boolean> {
  const live = evidence.filter(item => item.calendar?.liveEventId);
  const livePrefs = live.length ? await deps.db.asUser(userId, tx => loadPreferences(tx, userId)) : null;
  const accounts = live.length ? await deps.db.asUser(userId, tx => tx.query<AccountRow>(
    `select id,user_id,email,google_sub,status,features,display_name from public.mail_accounts where id = any($1::uuid[]) and status = 'active' and 'calendar_read' = any(features)`,
    [live.map(item => item.ref.accountId)])) : [];
  try {
    const fresh = await Promise.all(live.map(async item => {
      const account = accounts.find(row => row.id === item.ref.accountId);
      if (!account) return false;
      const event = await calendarFor(deps, account).getEvent(item.calendar!.liveEventId!);
      const current = composeCalendarItem(event, account, deps.now(), livePrefs!.timeZone);
      return Boolean(current && current.ref.title === item.ref.title && current.text === item.text && current.ref.version === item.ref.version);
    }));
    if (fresh.some(valid => !valid)) return false;
  } catch { return false; }
  return deps.db.asUser(userId, async tx => {
    const prefs = await loadPreferences(tx,userId);
    if (!(mode === 'completion' ? prefs.memory.smartComposeCompletion : prefs.memory.realtimeComposeChecks) || (evidence.some(item=>item.ref.id.startsWith('recall:')) && !prefs.fastRecall.enabled)) return false;
    if (live.length && (await tx.query(`select id from public.mail_accounts where id = any($1::uuid[]) and status = 'active' and 'calendar_read' = any(features)`, [accounts.map(account => account.id)])).length !== accounts.length) return false;
    if (!(await tx.query(`select 1 from public.mail_accounts where id = $1::uuid and status = 'active' and 'mail_read' = any(features)`,[accountId])).length) return false;
    const ids = (prefix: string) => evidence.filter(item => item.ref.id.startsWith(prefix)).map(item => item.ref.id.slice(prefix.length));
    // A transaction uses one connection: Promise.all cannot make empty source
    // queries free. Only check source types actually cited by this answer.
    const queryCited = <T>(keys: unknown[], sql: string, params: readonly unknown[]) => keys.length ? tx.query<T>(sql, params) : Promise.resolve([] as T[]);
    const threadIds = evidence.flatMap(item => item.ref.gmailThreadId ? [item.ref.gmailThreadId] : []);
    const eventIds = evidence.flatMap(item => item.calendar && !item.calendar.liveEventId ? [item.calendar.rowId] : []);
    const [memories, threads, events, notes, contacts, interactions, commitments, recall] = await Promise.all([
      queryCited<{ id:string; updated_at:unknown }>(ids('memory:'), `select m.id,m.updated_at from public.personal_memories m where m.id = any($1::uuid[]) and m.status = 'active'
        and m.valid_from <= $2::timestamptz and (m.valid_until is null or m.valid_until > $2::timestamptz)
        and not exists(select 1 from public.personal_memory_sources ms join public.personal_memory_exclusions x on x.thread_id = ms.thread_id where ms.memory_id = m.id)
        and (m.corrected or exists(select 1 from public.personal_memory_sources ms join public.threads t on t.id = ms.thread_id join public.mail_accounts a on a.id = ms.mail_account_id where ms.memory_id = m.id and a.status = 'active' and ms.source_version = t.content_version))`,[ids('memory:'),now]),
      queryCited<{ gmail_thread_id:string; mail_account_id:string; content_version:string }>(threadIds, `select t.gmail_thread_id,t.mail_account_id,t.content_version from public.threads t join public.mail_accounts a on a.id = t.mail_account_id join public.thread_states s on s.thread_id = t.id
        where t.gmail_thread_id = any($1::text[]) and a.status = 'active' and not t.is_bulk and not s.injection_suspected and s.analyzed_version = t.content_version
        and not exists(select 1 from public.personal_memory_exclusions x where x.thread_id = t.id)`,[threadIds]),
      queryCited<{ id:string; etag:string|null; updated_at:unknown; title:string; location:string|null; start_at:unknown; end_at:unknown; all_day:boolean }>(eventIds, `select e.id,e.etag,e.updated_at,e.title,e.location,e.start_at,e.end_at,e.all_day from public.calendar_event_cache e join public.mail_accounts a on a.id = e.mail_account_id
        where e.id = any($1::uuid[]) and a.status = 'active' and 'calendar_read' = any(a.features) and e.start_at > $2::timestamptz
        and e.updated_at >= $2::timestamptz - interval '30 minutes' and coalesce(e.status,'confirmed') <> 'cancelled' and coalesce(e.self_response,'accepted') in ('accepted','organizer')`,[eventIds,now]),
      queryCited<{id:string; body_ciphertext:string}>(ids('note:'), `select id,body_ciphertext from public.notes n where id = any($1::uuid[]) and source = 'user'
        and not exists(select 1 from public.personal_memory_exclusions x where x.thread_id = n.thread_id)`,[ids('note:')]),
      queryCited<{id:string; notes_ciphertext:string}>(ids('contact-note:'), `select id,notes_ciphertext from public.contacts where id = any($1::uuid[]) and not is_bulk`,[ids('contact-note:')]),
      queryCited<{id:string}>(ids('interaction:'), `select id from public.relationship_events where id = any($1::uuid[]) and kind in ('email_in','email_out')`,[ids('interaction:')]),
      queryCited<{id:string}>(ids('commitment:'), `select id from public.commitments where id = any($1::uuid[]) and status = 'open'`,[ids('commitment:')]),
      queryCited<{id:string}>(ids('recall:'), `select id from public.recall_chunks where id = any($1::uuid[]) and expires_at > $2::timestamptz`,[ids('recall:'),now]),
    ]);
    return evidence.every(item=> {
      if (item.ref.gmailThreadId && !threads.some(row=>row.gmail_thread_id===item.ref.gmailThreadId && row.mail_account_id===item.ref.accountId && row.content_version===item.ref.version)) return false;
      const id=item.ref.id;
      if (id.startsWith('memory:')) return memories.some(row=>row.id===id.slice(7) && iso(row.updated_at)===item.revision);
      if (item.calendar?.liveEventId) return accounts.some(row => row.id === item.ref.accountId);
      if (item.calendar) return events.some(row=>row.id===item.calendar!.rowId && (row.etag ?? iso(row.updated_at))===item.ref.version && row.title===item.ref.title && row.location===item.calendar!.location && iso(row.start_at)===item.calendar!.start && iso(row.end_at)===item.calendar!.end && row.all_day===item.calendar!.allDay);
      if (id.startsWith('thread:')) return true; // verified above with account + version
      if (id.startsWith('interaction:')) return interactions.some(row=>row.id===id.slice(12));
      if (id.startsWith('commitment:')) return commitments.some(row=>row.id===id.slice(11));
      if (id.startsWith('recall:')) return recall.some(row=>row.id===id.slice(7));
      if (id.startsWith('note:')) return notes.some(row=>row.id===id.slice(5) && row.body_ciphertext===item.revision);
      if (id.startsWith('contact-note:')) return contacts.some(row=>row.id===id.slice(13) && row.notes_ciphertext===item.revision);
      return false;
    });
  });
}
