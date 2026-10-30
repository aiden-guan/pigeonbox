import type { AskPigeonResponse, SourceRef } from '@pigeonbox/api-contract';
import { addCalendarDays, safeTimeZone, startOfLocalDay, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { attempt, iso, num, type SqlExecutor } from '../db/sql.js';
import type { IntelDeps } from './context.js';
import { vectorLiteral } from './search-index.js';
import { decryptSummary } from './threads.js';


/**
 * Retrieval primitives over the synced index: query parsing (used by the MCP
 * search tool), lexical and semantic thread search, and the user's notes.
 * Ask Pigeon's agent (ask-agent.ts) calls these as tools; it decides when.
 */

export type Strategy = AskPigeonResponse['retrieval']['strategies'][number];
export type Candidate = {
  ref: SourceRef;
  text: string;
  score: number;
  strategy: Strategy;
};

export type ParsedQuery = {
  window: { from: Date | null; to: Date | null; label: string | null };
  people: Array<{ email: string; name: string | null }>;
  terms: string[];
  intents: Set<'waiting' | 'promised_mine' | 'promised_theirs' | 'deadlines' | 'meetings' | 'availability' | 'tracking' | 'draft_followups' | 'briefing'>;
  durationMinutes: number | null;
};

const STOP = new Set('what who when where which how did do does i me my am are is was were the a an to for of on in with about have has had any all from that this these those there their them they you your we our us before after by it its be been will would should could can please tell give find show everyone anyone someone'.split(' '));

export async function parseQuery(tx: SqlExecutor, query: string, now: Date, timeZone: string): Promise<ParsedQuery> {
  const lower = query.toLowerCase();
  const zone = safeTimeZone(timeZone);
  const p = zonedParts(now, zone);
  const today = { year: p.year, month: p.month, day: p.day };
  const at = (day: { year: number; month: number; day: number }, hour = 0) => zonedTimeToUtc({ ...day, hour, minute: 0 }, zone);
  let window: ParsedQuery['window'] = { from: null, to: null, label: null };
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  // "before Friday" ends when Friday starts; "by/until Friday" includes Friday.
  const before = lower.match(/\b(before|by|until) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)\b/);
  if (/\btoday\b/.test(lower))
    window = {
      from: startOfLocalDay(now, zone),
      to: at(addCalendarDays(today, 1)),
      label: 'today',
    };
  else if (/\byesterday\b/.test(lower))
    window = {
      from: at(addCalendarDays(today, -1)),
      to: startOfLocalDay(now, zone),
      label: 'yesterday',
    };
  else if (/\btomorrow\b/.test(lower) && !before)
    window = {
      from: at(addCalendarDays(today, 1)),
      to: at(addCalendarDays(today, 2)),
      label: 'tomorrow',
    };
  else if (/\bthis week\b/.test(lower))
    window = {
      from: at(addCalendarDays(today, -((p.weekday + 6) % 7))),
      to: at(addCalendarDays(today, 7 - ((p.weekday + 6) % 7))),
      label: 'this week',
    };
  else if (/\bnext week\b/.test(lower))
    window = {
      from: at(addCalendarDays(today, 7 - ((p.weekday + 6) % 7))),
      to: at(addCalendarDays(today, 14 - ((p.weekday + 6) % 7))),
      label: 'next week',
    };
  else if (/\bthis month\b/.test(lower))
    window = {
      from: at({ ...today, day: 1 }),
      to: at(
        addCalendarDays(
          {
            year: p.month === 12 ? p.year + 1 : p.year,
            month: p.month === 12 ? 1 : p.month + 1,
            day: 1,
          },
          0,
        ),
      ),
      label: 'this month',
    };
  else if (/\blast (\d+|few) days\b/.test(lower))
    window = {
      from: new Date(now.getTime() - 7 * 86_400_000),
      to: now,
      label: 'recently',
    };
  if (before) {
    const word = before[1]!;
    const target = before[2]!;
    const idx = weekdays.indexOf(target);
    const day = idx >= 0 ? addCalendarDays(today, (idx - p.weekday + 7) % 7 || 7) : target === 'tomorrow' ? addCalendarDays(today, 1) : addCalendarDays(today, 7 - ((p.weekday + 6) % 7));
    const inclusive = word !== 'before' && target !== 'next week';
    window = { from: window.from, to: at(inclusive ? addCalendarDays(day, 1) : day), label: `${word} ${target}` };
  }

  const people: ParsedQuery['people'] = [];
  for (const match of query.matchAll(/[\w.+-]+@[\w.-]+\.\w+/g)) people.push({ email: match[0].toLowerCase(), name: null });
  const names = [...query.matchAll(/\b([A-Z][a-z]{1,20})(?:\s+([A-Z][a-z]{1,20}))?\b/g)].map((match) => match[0]).filter((name) => !/^(What|Who|When|Where|Which|How|Did|Do|Give|Find|Draft|Show|Tell|Is|Are|Am|I|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)$/.test(name.split(' ')[0]!));
  for (const name of names.slice(0, 4)) {
    const rows = await tx.query<{ email: string; name: string | null }>(
      `select email, name from public.contacts where not is_bulk and (lower(name) like $1 or lower(name) like $2 or email_normalized like $3)
        order by greatest(last_inbound_at, last_outbound_at) desc nulls last limit 3`,
      [`${name.toLowerCase()}%`, `% ${name.toLowerCase()}%`, `${name.toLowerCase().replace(/\s+/g, '.')}%`],
    );
    for (const row of rows) if (!people.some((person) => person.email === row.email.toLowerCase())) people.push({ email: row.email.toLowerCase(), name: row.name });
  }

  const intents: ParsedQuery['intents'] = new Set();
  if (/waiting on|who owes me a reply|haven'?t (?:replied|responded)|went cold|gone cold|no reply|not replied/.test(lower)) intents.add('waiting');
  if (/(did|have) i promise|i (?:promised|owe|committed)|what do i owe|my commitments/.test(lower)) intents.add('promised_mine');
  if (/(?:they|he|she|\w+) promised|owes? me|they committed/.test(lower) && !intents.has('promised_mine')) intents.add('promised_theirs');
  if (/deadlines?|\bdue\b/.test(lower)) intents.add('deadlines');
  if (/meeting|meet with|calendar|call with|brief(?:ing)?/.test(lower)) intents.add('meetings');
  if (/when am i free|free for|availability|available for|open slots?|find (?:a )?time/.test(lower)) intents.add('availability');
  if (/opened|clicked|viewed|looked at|read my|engag/.test(lower)) intents.add('tracking');
  if (/draft (?:a )?follow[- ]?ups?/.test(lower)) intents.add('draft_followups');
  if (/brief(?:ing)? for (?:everyone|each|all)/.test(lower)) intents.add('briefing');
  const duration = lower.match(/(\d{1,3})[\s-]?min/);
  return {
    window,
    people,
    terms: [...new Set((lower.match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter((word) => !STOP.has(word)))].slice(0, 8),
    intents,
    durationMinutes: duration ? Number(duration[1]) : /\bhalf an hour\b/.test(lower) ? 30 : /\ban hour\b/.test(lower) ? 60 : null,
  };
}

export function threadRef(row: { gmail_thread_id: string; mail_account_id: string; subject: string; last_message_at: unknown; who?: string | null }): SourceRef {
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

export type ThreadHit = {
  id: string;
  gmail_thread_id: string;
  mail_account_id: string;
  subject: string;
  last_message_at: unknown;
  state: string | null;
  who: string | null;
  summary_key_id: string | null;
  summary_iv: string | null;
  summary_ciphertext: string | null;
  score?: number;
};

export const THREAD_SELECT = `select t.id, t.gmail_thread_id, t.mail_account_id, t.subject, t.last_message_at, coalesce(s.user_state, s.state) as state,
  s.summary_key_id, s.summary_iv, s.summary_ciphertext,
  (select coalesce(nullif(m.from_name, ''), m.from_email) from public.message_metadata m where m.thread_id = t.id order by m.internal_date desc limit 1) as who
  from public.threads t left join public.thread_states s on s.thread_id = t.id`;

export async function threadCandidate(deps: IntelDeps, userId: string, row: ThreadHit, strategy: Strategy, score: number): Promise<Candidate> {
  const summary = await decryptSummary(deps.box, userId, row);
  const state = row.state ? ` [${row.state.toLowerCase().replace(/_/g, ' ')}]` : '';
  return {
    ref: threadRef(row),
    text: `${row.subject || '(no subject)'}${state}. ${row.who ? `Latest from ${row.who}. ` : ''}${summary?.oneLine ?? ''} ${(summary?.keyPoints ?? []).join(' ')}`.slice(0, 900),
    score,
    strategy,
  };
}

/**
 * Lexical (subjects, participants) and semantic (derived summaries, plus Fast
 * Recall excerpts when on) search over the synced index, merged by thread.
 */
export async function indexSearch(
  deps: IntelDeps,
  tx: SqlExecutor,
  userId: string,
  input: { terms: string[]; vector: number[] | null; fastRecall: boolean; from?: Date | null; to?: Date | null; limit: number },
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const window = [input.from ?? new Date(0), input.to ?? new Date(deps.now().getTime() + 365 * 86_400_000)];
  const terms = input.terms.map((term) => term.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (terms.length) {
    const rows = await tx.query<ThreadHit & { rank: number }>(
      `${THREAD_SELECT.replace('select t.id', "select ts_rank(t.search_tsv, to_tsquery('simple', $1)) as rank, t.id")}
        where t.search_tsv @@ to_tsquery('simple', $1) and t.last_message_at between $2::timestamptz and $3::timestamptz
        order by rank desc, t.last_message_at desc limit $4`,
      [terms.join(' | '), ...window, input.limit],
    );
    for (const row of rows) found.push(await threadCandidate(deps, userId, row, 'lexical', 1 + Math.min(2, num(row.rank) * 10)));
  }
  // A failed vector query must not abort the transaction.
  if (input.vector) {
    const literal = vectorLiteral(input.vector);
    const hits = await attempt(tx, async () => {
      const out: Candidate[] = [];
      const rows = await tx.query<ThreadHit & { distance: number }>(
        `${THREAD_SELECT.replace('select t.id', 'select (d.embedding <=> $1::extensions.vector) as distance, t.id').replace('from public.threads t', 'from public.search_documents d join public.threads t on t.id = d.thread_id')}
        where t.last_message_at between $2::timestamptz and $3::timestamptz order by d.embedding <=> $1::extensions.vector limit $4`,
        [literal, ...window, input.limit],
      );
      for (const row of rows) if (num(row.distance) < 0.85) out.push(await threadCandidate(deps, userId, row, 'semantic', 2.5 * (1 - num(row.distance))));
      if (input.fastRecall) {
        const chunks = await tx.query<{ id: string; text_key_id: string; text_iv: string; text_ciphertext: string; gmail_thread_id: string; mail_account_id: string; subject: string; message_at: unknown; distance: number }>(
          `select c.id, c.text_key_id, c.text_iv, c.text_ciphertext, t.gmail_thread_id, t.mail_account_id, t.subject, c.message_at, (c.embedding <=> $1::extensions.vector) as distance
           from public.recall_chunks c join public.threads t on t.id = c.thread_id where c.expires_at > now() order by c.embedding <=> $1::extensions.vector limit 6`,
          [literal],
        );
        for (const chunk of chunks) {
          if (num(chunk.distance) > 0.8) continue;
          const text = await deps.box
            .open({ keyId: chunk.text_key_id, iv: chunk.text_iv, ciphertext: chunk.text_ciphertext }, { purpose: 'fast_recall', userId, recordId: chunk.id })
            .catch(() => '');
          if (text)
            out.push({
              ref: { id: `thread:${chunk.gmail_thread_id}`, kind: 'message', title: chunk.subject || '(no subject)', gmailThreadId: chunk.gmail_thread_id, accountId: chunk.mail_account_id, at: iso(chunk.message_at) },
              text: text.slice(0, 900),
              score: 2.8 * (1 - num(chunk.distance)),
              strategy: 'semantic',
            });
        }
      }
      return out;
    });
    if (hits === null) deps.log('warn', 'semantic retrieval failed', { code: 'vector_query' });
    found.push(...(hits ?? []));
  }
  // One entry per record: the best score, the longest text.
  const merged = new Map<string, Candidate>();
  for (const candidate of found) {
    const existing = merged.get(candidate.ref.id);
    if (!existing) merged.set(candidate.ref.id, candidate);
    else {
      existing.score = Math.max(existing.score, candidate.score) + 0.3;
      if (candidate.text.length > existing.text.length) existing.text = candidate.text;
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, input.limit);
}

/** The user's notes containing any of the terms (notes are encrypted, so matching happens here). */
export async function searchNotes(deps: IntelDeps, tx: SqlExecutor, userId: string, terms: string[], limit = 8): Promise<Candidate[]> {
  const wanted = terms.map((term) => term.toLowerCase()).filter(Boolean);
  const notes = await tx.query<{ id: string; body_key_id: string; body_iv: string; body_ciphertext: string; created_at: unknown }>(
    `select id, body_key_id, body_iv, body_ciphertext, created_at from public.notes order by created_at desc limit 200`,
  );
  const out: Candidate[] = [];
  for (const note of notes) {
    if (out.length >= limit) break;
    const body = await deps.box.open({ keyId: note.body_key_id, iv: note.body_iv, ciphertext: note.body_ciphertext }, { purpose: 'note', userId, recordId: note.id }).catch(() => '');
    if (body && (!wanted.length || wanted.some((term) => body.toLowerCase().includes(term))))
      out.push({ ref: { id: `note:${note.id}`, kind: 'note', title: body.slice(0, 80), at: iso(note.created_at) }, text: `Your note: ${body.slice(0, 600)}`, score: 2, strategy: 'filters' });
  }
  return out;
}
