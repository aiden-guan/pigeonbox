import type { Preferences, SourceRef } from '@pigeonbox/api-contract';
import { iso, isoOrNull, num, type SqlExecutor } from '../../db/sql.js';
import { BudgetExceededError, embedTexts } from '../ai.js';
import { COMMITMENT_COLUMNS, toCommitment, type CommitmentRow } from '../commitments.js';
import type { IntelDeps } from '../context.js';
import { vectorLiteral } from '../../db/vector.js';
import { decryptSummary } from '../thread-summary.js';
import { loadSubjects, memoryDigest, memorySources, memoryState, readMemory, subjectDigest, type MemoryState } from './store.js';
import { queryTerms, selectContext, type ContextItem } from './rank.js';
import type { MemoryRow } from './types.js';
import { safeMemoryText } from './policy.js';
import { addComposeSources, resolveComposePeople } from './compose-retrieval.js';
import { getEntitlements, hasCapability } from '../../entitlements.js';
import { enforceLimits } from '../../limits.js';
import { selectComposeEvidence } from '../compose-context.js';
import { selectCompletionEvidence } from '../compose-completion.js';

export type ContextRequest = {
  userId: string;
  recipientEmails: string[];
  currentThreadId?: string | null;
  composeText?: string;
  intent?: string;
  subject: string;
  now: Date;
  maxTokens?: number;
  maxItems?: number;
  requestId: string;
  prefs: Preferences;
  /**
   * false: exact and structured context only (recipients, current thread,
   * commitments, notes, events, metadata search), with no embedding call.
   * Default true: the full pool used by drafts and search.
   */
  semantic?: boolean;
  /** false: leave memories' last-access time alone (read-only checks). Default true. */
  recordAccess?: boolean;
  /** Include the owner's page overview as one compact item. Default: with semantic retrieval. */
  profile?: boolean;
  /** Scoped calendar capability, supplied by live orchestration. */
  calendar?: boolean;
  /** Include sourced continuations in the same ephemeral live pool. */
  completion?: boolean;
};

/** Who a fact is about, for a prompt: facts on pages are written without their subject. */
function factSubject(content: { subject?: { type: string; key: string; label: string } }): string {
  if (!content.subject) return '';
  if (content.subject.type === 'self') return 'About the user: ';
  if (content.subject.type === 'person') return `About ${content.subject.label === content.subject.key ? content.subject.key : `${content.subject.label} <${content.subject.key}>`}: `;
  return `${content.subject.label}: `;
}

/**
 * The owner's page in at most ~150 tokens: its synthesized overview when that is
 * current, otherwise the few most important facts. Null when nothing is known.
 */
export async function ownerProfile(deps: IntelDeps, tx: SqlExecutor, userId: string, state: MemoryState, now: Date): Promise<{ text: string; ids: string[]; at: string } | null> {
  const key = await subjectDigest(state, { type: 'self', key: 'self', label: 'You' });
  const page = (await loadSubjects(deps, tx, userId, [key])).get(key);
  if (!page) return null;
  const rows = await tx.query<MemoryRow>(
    `select * from public.personal_memories where scope_key = $1 and status = 'active' and (valid_until is null or valid_until > $2::timestamptz)
     order by corrected desc,importance desc,last_confirmed_at desc limit 6`,
    [key, now],
  );
  if (!rows.length) return null;
  const at = iso(rows.map((row) => iso(row.last_confirmed_at)).sort().at(-1));
  if (page.summaryValid && page.summary && safeMemoryText(page.summary)) return { text: page.summary, ids: page.summaryIds, at };
  const facts: string[] = [];
  for (const row of rows) {
    const content = await readMemory(deps, userId, row);
    if (safeMemoryText(content.text)) facts.push(content.text.replace(/\.$/, ''));
  }
  return facts.length ? { text: `${facts.join('. ')}.`, ids: rows.map((row) => row.id), at } : null;
}
export function retrievalQuery(input: Pick<ContextRequest, 'subject' | 'composeText' | 'intent' | 'recipientEmails'>): string {
  return [input.subject, input.intent ?? '', input.composeText?.slice(-1_000) ?? '', ...input.recipientEmails.slice(0, 5)].join('\n').slice(0, 1_800);
}

/** Embedding failures degrade to exact entities and metadata; no second AI stack. */
export async function contextVector(deps: IntelDeps, userId: string, query: string, requestId: string, timeoutMs?: number): Promise<string | null> {
  if (!query.trim()) return null;
  try {
    const [vector] = await embedTexts(deps, userId, [query], requestId, true, timeoutMs);
    return vector ? vectorLiteral(vector) : null;
  } catch (error) {
    deps.log('warn', 'context embedding unavailable', {
      userId,
      requestId,
      code: error instanceof BudgetExceededError ? error.message : 'context_embedding_unavailable',
    });
    return null;
  }
}

type ThreadRow = {
  id: string;
  mail_account_id: string;
  gmail_thread_id: string;
  subject: string;
  last_message_at: unknown;
  content_version: string;
  summary_key_id: string | null;
  summary_iv: string | null;
  summary_ciphertext: string | null;
  recipient_match: boolean;
  semantic: number;
};
const staleHistory = (threadAlias: string, now: string) => `not exists (select 1 from public.personal_memory_exclusions x where x.thread_id = ${threadAlias}.id)
  and not exists (select 1 from public.personal_memory_sources ms join public.personal_memories pm on pm.id = ms.memory_id
  where ms.thread_id = ${threadAlias}.id and (pm.status = 'superseded' or pm.valid_until <= ${now}::timestamptz)
    and not exists (select 1 from public.personal_memory_sources ns where ns.thread_id = ${threadAlias}.id and ns.memory_id = pm.superseded_by))`;

/** One bounded pool across existing structured intelligence and derived memory. */
export async function getRelevantContext(deps: IntelDeps, input: ContextRequest): Promise<ContextItem[]> {
  const started = Date.now();
  const live = input.intent === 'compose_check';
  const query = retrievalQuery(input);
  const recipients = [...new Set(input.recipientEmails.map((email) => email.trim().toLowerCase()))].slice(0, 10);
  let semanticAllowed = input.semantic !== false;
  if (live && semanticAllowed) {
    const entitlement = await getEntitlements(input.userId, deps.store, deps.config);
    semanticAllowed = hasCapability(entitlement, 'cloud_ai');
    if (semanticAllowed) try { await enforceLimits(input.userId, entitlement, { store: deps.store, config: deps.config, now: input.now }); } catch { semanticAllowed = false; }
  }
  const vector = semanticAllowed ? await contextVector(deps, input.userId, live ? input.composeText ?? '' : query, input.requestId, live ? 2_000 : undefined) : null;
  const items = await deps.db.asUser(input.userId, async (tx) => {
    const state = await memoryState(deps, tx, input.userId);
    const people = live ? await resolveComposePeople(tx, input.composeText ?? '') : [];
    const linkedRecipients = [...new Set([...recipients, ...people.map(person => person.email)])].slice(0, 12);
    const recipientKeys = await Promise.all(linkedRecipients.map((email) => memoryDigest(state, 'entity:email', email)));
    const words = queryTerms(input.composeText ?? '');
    const phrases = words.flatMap((word, i) => [word, words.slice(i, i + 2).join(' '), words.slice(i, i + 3).join(' ')]).slice(0, 36);
    const entityKeys = live ? await Promise.all(phrases.flatMap(phrase => ['name','topic','project','company','course','event'].map(type => memoryDigest(state, `entity:${type}`, phrase)))) : [];
    const terms = queryTerms(`${input.subject} ${input.composeText ?? ''}`).filter((term) => /^[a-z0-9]+$/.test(term));
    const base = (ref: SourceRef, text: string, options: Partial<ContextItem> = {}): ContextItem => ({
      ref,
      text: text.slice(0, 1_200),
      confidence: 0.9,
      importance: 0.6,
      semantic: 0,
      recipientMatch: false,
      threadMatch: false,
      openLoop: false,
      at: ref.at ?? input.now.toISOString(),
      validUntil: null,
      durable: false,
      status: 'active',
      ...options,
    });
    const pool: ContextItem[] = [];
    // One compact "who the user is" item stands in for the individual facts it covers.
    const profile = (input.profile ?? input.semantic !== false) ? await ownerProfile(deps, tx, input.userId, state, input.now) : null;
    if (profile)
      pool.push(
        base({ id: 'profile:self', kind: 'note', title: 'What Pidgy knows about you', at: profile.at }, `About the user (derived from their email; may be outdated): ${profile.text}`, {
          importance: 0.85,
          durable: true,
          at: profile.at,
        }),
      );
    const covered = new Set(profile?.ids ?? []);
    // Indexed exact entity shortlist plus pgvector shortlist, reranked before decryption.
    const memoryRows = await tx.query<MemoryRow & { recipient_match: boolean; thread_match: boolean; semantic: number; replaces: boolean; entity_match: boolean }>(
      `with eligible as (
      select m.id from public.personal_memories m where m.status = 'active' and m.confidence >= 0.8 and m.valid_from <= $4::timestamptz
      and (m.valid_until is null or m.valid_until > $4::timestamptz)
      ${live ? `and m.kind <> 'instruction' and (m.kind not in ('preference','goal') or ($8 and m.corrected)) and not exists(select 1 from public.personal_memory_sources s join public.personal_memory_exclusions x on x.thread_id = s.thread_id where s.memory_id = m.id)` : ''}
      and (m.corrected or exists(select 1 from public.personal_memory_sources s join public.mail_accounts a on a.id = s.mail_account_id join public.threads t on t.id = s.thread_id where s.memory_id = m.id and a.status = 'active' and s.source_version = t.content_version))
    ), exact as (
      select m.id from public.personal_memories m join eligible e on e.id = m.id where
       exists(select 1 from public.personal_memory_entities l where l.memory_id = m.id and l.entity_type = 'email' and l.entity_key = any($1::text[]))
       or exists(select 1 from public.personal_memory_sources s where s.memory_id = m.id and s.thread_id = $2::uuid)
       or ($6 and m.subject_type = 'self')
       or exists(select 1 from public.personal_memory_entities l where l.memory_id = m.id and l.entity_key = any($7::text[]))
      order by m.importance desc,m.last_confirmed_at desc limit ${live ? 8 : 24}
    ), semantic as (
      select m.id from public.personal_memories m join eligible e on e.id = m.id where m.status = 'active' and $3::extensions.vector is not null and m.embedding is not null and m.embedding_model = $5
      order by m.embedding <=> $3::extensions.vector limit ${live ? 8 : 16}
    ) select m.*,
      exists(select 1 from public.personal_memory_entities l where l.memory_id = m.id and l.entity_type = 'email' and l.entity_key = any($1::text[])) as recipient_match,
      exists(select 1 from public.personal_memory_sources s where s.memory_id = m.id and s.thread_id = $2::uuid) as thread_match,
      exists(select 1 from public.personal_memory_entities l where l.memory_id = m.id and l.entity_key = any($7::text[])) as entity_match,
      case when $3::extensions.vector is null or m.embedding is null or m.embedding_model is distinct from $5 then 0 else 1-(m.embedding <=> $3::extensions.vector) end as semantic,
      exists(select 1 from public.personal_memories o where o.superseded_by = m.id) as replaces
      from public.personal_memories m where m.id in (select id from exact union select id from semantic)
      order by recipient_match desc,thread_match desc,entity_match desc,semantic desc,m.importance desc,m.last_confirmed_at desc limit ${live ? 12 : 24}`,
      [recipientKeys, input.currentThreadId ?? null, vector, input.now, deps.config.ai.embedModel, live, entityKeys, ...(live ? [input.completion === true] : [])],
    );
    const sources = await memorySources(
      tx,
      memoryRows.map((row) => row.id),
      live,
    );
    for (const row of memoryRows) {
      if (covered.has(row.id)) continue;
      const content = await readMemory(deps, input.userId, row);
      if (!safeMemoryText(content.text)) continue;
      const source = sources.get(row.id)?.[0];
      if (!source && !row.corrected) continue;
      pool.push(
        base(
          {
            ...(source ?? { kind: 'note' as const, title: 'Your corrected memory' }),
            id: `memory:${row.id}`,
            title: row.corrected ? 'Your corrected memory' : source!.title,
          },
          `${row.corrected ? 'User-corrected fact' : 'Derived fact from prior communication (may need confirmation)'}: ${factSubject(content)}${content.text}`,
          {
            confidence: num(row.confidence),
            importance: num(row.importance),
            semantic: num(row.semantic),
            recipientMatch: row.recipient_match,
            threadMatch: row.thread_match,
            at: iso(row.last_confirmed_at),
            validUntil: isoOrNull(row.valid_until),
            durable: row.kind !== 'episodic',
            fact: { concept: content.concept, corrected: row.corrected, replaces: Boolean(row.replaces), kind: row.kind },
            assertion: content.text,
            subject: content.subject,
            entityMatch: Boolean(row.entity_match),
            revision: iso(row.updated_at),
          },
        ),
      );
    }
    const threads = await tx.query<ThreadRow>(
      `select t.id,t.mail_account_id,t.gmail_thread_id,t.subject,t.last_message_at,t.content_version,
      s.summary_key_id,s.summary_iv,s.summary_ciphertext,
      exists(select 1 from jsonb_array_elements(t.participants) p where lower(p->>'email') = any($1::text[])) as recipient_match,
      case when $3::extensions.vector is null or d.embedding is null or d.model is distinct from $6 then 0 else 1-(d.embedding <=> $3::extensions.vector) end as semantic
      from public.threads t join public.mail_accounts a on a.id = t.mail_account_id
      join public.thread_states s on s.thread_id = t.id left join public.search_documents d on d.thread_id = t.id and d.content_version = t.content_version
      where t.last_message_at <= $4::timestamptz and not t.is_bulk and a.status = 'active' and not s.injection_suspected
      ${live ? `and s.analyzed_version = t.content_version and ${staleHistory('t', '$4')}` : ''}
      and (t.id = $2::uuid or (${staleHistory('t', '$4')}))
      and (t.id = $2::uuid or exists(select 1 from jsonb_array_elements(t.participants) p where lower(p->>'email') = any($1::text[]))
        or ($5 <> '' and t.search_tsv @@ to_tsquery('simple',$5)) or ($3::extensions.vector is not null and d.model = $6 and 1-(d.embedding <=> $3::extensions.vector) > 0.35))
      order by (t.id = $2::uuid) desc nulls last,recipient_match desc,semantic desc,t.last_message_at desc limit 8`,
      [linkedRecipients, input.currentThreadId ?? null, vector, input.now, terms.join(' | '), deps.config.ai.embedModel],
    );
    for (const row of threads) {
      const summary = await decryptSummary(deps.box, input.userId, row);
      if (!summary || !safeMemoryText([summary.oneLine, ...summary.keyPoints].join('\n'))) continue;
      pool.push(
        base(
          {
            id: `thread:${row.id}`,
            kind: 'thread',
            title: row.subject.slice(0, 300),
            accountId: row.mail_account_id,
            gmailThreadId: row.gmail_thread_id,
            at: iso(row.last_message_at),
            version: row.content_version,
          },
          [summary.oneLine, ...summary.keyPoints].join('\n'),
          { recipientMatch: row.recipient_match, threadMatch: row.id === input.currentThreadId, semantic: num(row.semantic) },
        ),
      );
    }
    const commitments = linkedRecipients.length || input.currentThreadId ? await tx.query<CommitmentRow & { content_version: string }>(
      `select ${COMMITMENT_COLUMNS},t.content_version from public.commitments c join public.threads t on t.id = c.thread_id join public.mail_accounts a on a.id = c.mail_account_id
      where c.status = 'open' and a.status = 'active' and (lower(c.counterparty) = any($1::text[]) or c.thread_id = $2::uuid)
      ${live ? `and ${staleHistory('t', '$3')} and exists(select 1 from public.thread_states st where st.thread_id = t.id and st.analyzed_version = t.content_version and not st.injection_suspected)` : ''}
      order by c.due_at nulls last limit 8`,
      live ? [linkedRecipients, input.currentThreadId ?? null, input.now] : [recipients, input.currentThreadId ?? null],
    ) : [];
    for (const row of commitments) {
      const item = await toCommitment(deps.box, input.userId, row);
      if (!safeMemoryText(item.text)) continue;
      pool.push(
        base(
          { ...item.source, id: `commitment:${item.id}`, kind: 'commitment', version: row.content_version },
          `${item.direction === 'mine' ? 'You promised' : 'They promised'}: ${item.text}${item.dueAt ? ` (due ${item.dueAt})` : ''}`,
          {
            recipientMatch: true,
            threadMatch: row.thread_id === input.currentThreadId,
            openLoop: true,
            importance: 0.9,
            commitment: { direction: item.direction, dueAt: item.dueAt, counterparty: row.counterparty, text: item.text, threadRowId: row.thread_id },
          },
        ),
      );
    }
    await addRelationships(tx, deps, input, linkedRecipients, pool, base);
    if (live) await addComposeSources(tx, deps, input, linkedRecipients, people, vector, pool, base);
    if (input.prefs.fastRecall.enabled && vector) {
      const recall = await tx.query<{
        id: string;
        mail_account_id: string;
        gmail_thread_id: string;
        gmail_message_id: string;
        subject: string;
        text_key_id: string;
        text_iv: string;
        text_ciphertext: string;
        message_at: unknown;
        expires_at: unknown;
        semantic: number;
        content_version: string;
      }>(
        `select r.*,t.gmail_thread_id,t.subject,t.content_version,1-(r.embedding <=> $1::extensions.vector) as semantic from public.recall_chunks r
         join public.threads t on t.id = r.thread_id join public.mail_accounts a on a.id = r.mail_account_id
         join public.thread_states s on s.thread_id = t.id
         where r.expires_at > $2::timestamptz and a.status = 'active' and not s.injection_suspected and not t.is_bulk and ${staleHistory('t', '$2')}
         ${live ? `and s.analyzed_version = t.content_version and r.message_at <= $2::timestamptz
         and (1-(r.embedding <=> $1::extensions.vector) >= 0.65 or exists(select 1 from jsonb_array_elements(t.participants) p where lower(p->>'email') = any($3::text[])))` : `and exists(select 1 from jsonb_array_elements(t.participants) p where lower(p->>'email') = any($3::text[]))`}
         order by r.embedding <=> $1::extensions.vector limit 3`,
        [vector, input.now, linkedRecipients],
      );
      for (const row of recall) {
        const text = await deps.box.open(
          { keyId: row.text_key_id, iv: row.text_iv, ciphertext: row.text_ciphertext },
          { purpose: 'fast_recall', userId: input.userId, recordId: row.id },
        );
        if (!safeMemoryText(text)) continue;
        pool.push(
          base(
            {
              id: `recall:${row.id}`,
              kind: 'message',
              title: row.subject.slice(0, 300),
              accountId: row.mail_account_id,
              gmailThreadId: row.gmail_thread_id,
              gmailMessageId: row.gmail_message_id,
              at: iso(row.message_at),
              version: row.content_version,
            },
            text,
            { recipientMatch: !live, semantic: num(row.semantic), at: iso(row.message_at), validUntil: iso(row.expires_at) },
          ),
        );
      }
    }
    deps.log('info', 'context candidates retrieved', { userId: input.userId, requestId: input.requestId, count: pool.length });
    const boundedPool = live ? pool.map(item => ({ ...item, text: item.text.slice(0, 400), assertion: item.assertion?.slice(0, 400) })) : pool;
    const semanticPool = live ? [...new Set([
      ...selectComposeEvidence(boundedPool, input.composeText ?? '', input.now, input.prefs.timeZone),
      ...(input.completion ? selectCompletionEvidence(boundedPool, input.composeText ?? '', input.now, input.prefs.timeZone) : []),
    ])] : boundedPool;
    // Keep structured promises available to the deterministic resolver for pronouns
    // in the current thread. They still need a topic tie before model arbitration.
    const livePool = live ? [...new Set([...semanticPool, ...boundedPool.filter(item => item.commitment && (item.threadMatch || item.recipientMatch))])] : semanticPool;
    const selected = selectContext(livePool, {
      now: input.now,
      query,
      maxTokens: Math.min(4_000, Math.max(0, input.maxTokens ?? 2_000)),
      maxItems: input.maxItems,
    });
    const ids = selected.filter((item) => item.ref.id.startsWith('memory:')).map((item) => item.ref.id.slice(7));
    if (ids.length && input.recordAccess !== false) await tx.query(`update public.personal_memories set last_accessed_at = $2::timestamptz where id = any($1::uuid[])`, [ids, input.now]);
    return selected;
  });
  deps.log('info', 'context selected', { userId: input.userId, requestId: input.requestId, count: items.length, latencyMs: Date.now() - started });
  return items;
}

async function addRelationships(
  tx: SqlExecutor,
  deps: IntelDeps,
  input: ContextRequest,
  recipients: string[],
  pool: ContextItem[],
  base: (ref: SourceRef, text: string, options?: Partial<ContextItem>) => ContextItem,
) {
  const contacts = recipients.length ? await tx.query<{
    id: string;
    email: string;
    name: string | null;
    company: string | null;
    vip: boolean;
    sent_count: number;
    received_count: number;
    notes_key_id: string | null;
    notes_iv: string | null;
    notes_ciphertext: string | null;
  }>(
    `select c.*,coalesce(co.name,co.domain) as company from public.contacts c left join public.companies co on co.id = c.company_id where c.email_normalized = any($1::text[]) and not c.is_bulk limit 10`,
    [recipients],
  ) : [];
  for (const row of contacts) {
    const ref: SourceRef = { id: `contact:${row.id}`, kind: 'contact', title: row.name ?? row.email, who: row.email };
    pool.push(
      base(
        ref,
        `${row.name ?? row.email}${row.company ? ` at ${row.company}` : ''}. ${num(row.sent_count)} sent and ${num(row.received_count)} received emails.${row.vip ? ' User marked this contact VIP.' : ''}`,
        { recipientMatch: true, durable: true, importance: row.vip ? 0.95 : 0.6 },
      ),
    );
    if (row.notes_key_id && row.notes_iv && row.notes_ciphertext) {
      const text = await deps.box.open(
        { keyId: row.notes_key_id, iv: row.notes_iv, ciphertext: row.notes_ciphertext },
        { purpose: 'note', userId: input.userId, recordId: `contact:${row.id}` },
      );
      if (safeMemoryText(text))
        pool.push(base({ ...ref, id: `contact-note:${row.id}`, kind: 'note' }, text, { recipientMatch: true, durable: true, importance: 0.8, confidence: 1, revision: row.notes_ciphertext }));
    }
  }
  const notes = await tx.query<{ id: string; body_key_id: string; body_iv: string; body_ciphertext: string; updated_at: unknown; thread_id: string | null }>(
    `select * from public.notes n where source = 'user' and (lower(contact_email) = any($1::text[]) or thread_id = $2::uuid
      ${input.intent === 'compose_check' ? `or (contact_email is null and thread_id is null)` : ''})
      ${input.intent === 'compose_check' ? `and not exists(select 1 from public.personal_memory_exclusions x where x.thread_id = n.thread_id)` : ''} order by updated_at desc limit 4`,
    [recipients, input.currentThreadId ?? null],
  );
  for (const row of notes) {
    const text = await deps.box.open(
      { keyId: row.body_key_id, iv: row.body_iv, ciphertext: row.body_ciphertext },
      { purpose: 'note', userId: input.userId, recordId: row.id },
    );
    if (safeMemoryText(text))
      pool.push(
        base({ id: `note:${row.id}`, kind: 'note', title: 'Your note', at: iso(row.updated_at) }, text, {
          recipientMatch: true,
          threadMatch: row.thread_id === input.currentThreadId,
          confidence: 1,
          revision: row.body_ciphertext,
        }),
      );
  }
  if (input.intent === 'compose_check') return;
  const events = await tx.query<{ event_id: string; mail_account_id: string; title: string; start_at: unknown; end_at: unknown; html_link: string | null }>(
    `select e.* from public.calendar_event_cache e join public.mail_accounts a on a.id = e.mail_account_id
     where a.status = 'active' and e.start_at > $2::timestamptz and e.start_at < $2::timestamptz + interval '14 days' and e.attendees && $1::text[] order by e.start_at limit 3`,
    [recipients, input.now],
  );
  for (const row of events)
    if (safeMemoryText(row.title))
      pool.push(
        base(
          {
            id: `event:${row.event_id}`,
            kind: 'calendar_event',
            title: row.title.slice(0, 300),
            accountId: row.mail_account_id,
            at: iso(row.start_at),
            ...(row.html_link ? { url: row.html_link } : {}),
          },
          `Upcoming meeting: ${row.title} at ${iso(row.start_at)}`,
          { recipientMatch: true, importance: 0.85, validUntil: iso(row.end_at) },
        ),
      );
}
