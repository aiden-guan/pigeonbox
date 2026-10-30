import { enqueue } from '../../jobs/queue.js';
import type { PersonalMemory, SourceRef } from '@pigeonbox/api-contract';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../../db/sql.js';
import { ApiError } from '../../http.js';
import { hmacSha256Hex, randomToken } from '../../platform/crypto.js';
import type { IntelDeps } from '../context.js';
import { loadPreferences } from '../preferences.js';
import { vectorLiteral } from '../../db/vector.js';
import type { ReadMessage } from '../thread-reader.js';
import { absorbsFact, DUPLICATE_SIMILARITY, isExplicitReplacement, persistenceDecision, safeMemoryText, sameFactWording, sameSpecifics } from './policy.js';
import {
  StoredContentSchema,
  SubjectContentSchema,
  type MemoryCandidate,
  type MemoryRow,
  type MemorySubjectInput,
  type StoredContent,
  type SubjectContent,
} from './types.js';

export type MemoryState = { generation: string; learnAfter: string | null; hashSecret: string };
export async function memoryState(deps: IntelDeps, tx: SqlExecutor, userId: string, lock = false): Promise<MemoryState> {
  const read = () => one<{ generation: string; learn_after: unknown; hash_key_id: string; hash_iv: string; hash_ciphertext: string }>(
    tx,
    `select * from public.personal_memory_state where user_id = $1::uuid${lock ? ' for update' : ''}`,
    [userId],
  );
  // Existing state is the hot path. Avoid generating/encrypting a throwaway
  // key and issuing an INSERT on every interactive retrieval.
  let row = await read();
  if (!row) {
    const sealed = await deps.box.seal(randomToken(), { purpose: 'personal_memory', userId, recordId: 'hash_key' });
    await tx.query(
      `insert into public.personal_memory_state(user_id,hash_key_id,hash_iv,hash_ciphertext) values($1::uuid,$2,$3,$4) on conflict(user_id) do nothing`,
      [userId, sealed.keyId, sealed.iv, sealed.ciphertext],
    );
    // A concurrent initializer may have won. Read its canonical key, with
    // the same optional row lock used by learning/forget operations.
    row = await read();
  }
  if (!row) throw new ApiError('not_found', 'Memory settings are unavailable.');
  const hashSecret = await deps.box.open(
    { keyId: row.hash_key_id, iv: row.hash_iv, ciphertext: row.hash_ciphertext },
    { purpose: 'personal_memory', userId, recordId: 'hash_key' },
  );
  return { generation: row.generation, learnAfter: isoOrNull(row.learn_after), hashSecret };
}
export const normalizeFact = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.]+/gu, ' ')
    .trim();
export const memoryDigest = (state: MemoryState, type: string, text: string) => hmacSha256Hex(state.hashSecret, `${type}:${normalizeFact(text)}`);
export async function readMemory(deps: IntelDeps, userId: string, row: MemoryRow): Promise<StoredContent> {
  const plain = await deps.box.open(
    { keyId: row.text_key_id, iv: row.text_iv, ciphertext: row.text_ciphertext },
    { purpose: 'personal_memory', userId, recordId: row.id },
  );
  return StoredContentSchema.parse(JSON.parse(plain));
}

type SourceRow = {
  memory_id: string;
  mail_account_id: string;
  gmail_thread_id: string;
  gmail_message_id: string;
  source_at: unknown;
  subject: string;
  status: string;
  source_version: string;
};
export async function memorySources(tx: SqlExecutor, ids: string[], currentOnly = false): Promise<Map<string, SourceRef[]>> {
  if (!ids.length) return new Map();
  const rows = await tx.query<SourceRow>(
    `select * from (
    select s.memory_id,s.mail_account_id,t.gmail_thread_id,s.gmail_message_id,s.source_at,t.subject,a.status,s.source_version,
           row_number() over(partition by s.memory_id order by s.source_at desc,s.id) as ordinal
      from public.personal_memory_sources s join public.threads t on t.id = s.thread_id
      join public.mail_accounts a on a.id = s.mail_account_id
     where s.memory_id = any($1::uuid[]) and a.status <> 'disconnected'
       ${currentOnly ? `and a.status = 'active' and s.source_version = t.content_version and not t.is_bulk
       and not exists(select 1 from public.personal_memory_exclusions x where x.thread_id = t.id)
       and not exists(select 1 from public.thread_states st where st.thread_id = t.id and st.injection_suspected)` : ''}) ranked where ordinal <= 12`,
    [ids],
  );
  const result = new Map<string, SourceRef[]>();
  for (const row of rows) {
    const list = result.get(row.memory_id) ?? [];
    list.push({
      id: `memory:${row.memory_id}:${row.gmail_message_id}`.slice(0, 128),
      kind: 'message',
      title: row.subject.slice(0, 300) || '(no subject)',
      accountId: row.mail_account_id,
      gmailThreadId: row.gmail_thread_id,
      gmailMessageId: row.gmail_message_id,
      at: iso(row.source_at),
      version: row.source_version,
    });
    result.set(row.memory_id, list);
  }
  return result;
}

export async function toMemories(deps: IntelDeps, tx: SqlExecutor, userId: string, rows: MemoryRow[]): Promise<PersonalMemory[]> {
  const sources = await memorySources(
    tx,
    rows.map((row) => row.id),
  );
  const pages = await loadSubjects(deps, tx, userId, [...new Set(rows.filter((row) => row.subject_type).map((row) => row.scope_key))]);
  return Promise.all(
    rows.map(async (row) => {
      const content = await readMemory(deps, userId, row);
      const page = row.subject_type ? pages.get(row.scope_key) : undefined;
      return {
        id: row.id,
        kind: row.kind,
        category: row.category,
        text: content.text,
        confidence: num(row.confidence),
        status: row.status,
        validFrom: iso(row.valid_from),
        validUntil: isoOrNull(row.valid_until),
        lastConfirmedAt: iso(row.last_confirmed_at),
        corrected: row.corrected,
        entities: content.entities,
        sources: sources.get(row.id) ?? [],
        subject: page && row.subject_type ? { id: row.scope_key, type: row.subject_type, label: page.label } : null,
      };
    }),
  );
}

export type MemorySource = { accountId: string; threadId: string; version: string; ownerEmail: string; message: ReadMessage };

/** One page for the owner across every inbox; people by exact email; topics by name. */
export function normalizeSubject(subject: MemorySubjectInput): MemorySubjectInput {
  if (subject.type === 'self') return { type: 'self', key: 'self', label: 'You' };
  if (subject.type === 'person') return { type: 'person', key: subject.key.trim().toLowerCase(), label: subject.label.trim() || subject.key };
  return { type: 'topic', key: normalizeFact(subject.key) || normalizeFact(subject.label), label: subject.label.trim() };
}
export const subjectDigest = (state: MemoryState, subject: MemorySubjectInput) => {
  const normal = normalizeSubject(subject);
  return memoryDigest(state, 'subject', `${normal.type}:${normal.key}`);
};

export async function candidateKeys(state: MemoryState, candidate: MemoryCandidate, source: MemorySource) {
  const subject = normalizeSubject(candidate.subject);
  // The page, not the recipient, scopes a fact: "I'm a freshman" told to five
  // people is one fact about the owner, while the same words from two different
  // correspondents stay two facts on two pages.
  const scopeKey = await subjectDigest(state, subject);
  const fingerprint = await memoryDigest(state, 'fact', `${scopeKey}:${candidate.canonicalText}`);
  // Generic "meeting" must never supersede a different meeting on this page.
  const topic = candidate.concept?.topic ?? '';
  const words = normalizeFact(topic).split(' ');
  const precise = words.length >= 2 && words.every((word) => normalizeFact(source.message.text).includes(word));
  const conceptKey = candidate.concept && precise ? await memoryDigest(state, 'concept', `${scopeKey}:${topic}:${candidate.concept.attribute}`) : null;
  return { fingerprint, conceptKey, scopeKey, subject };
}

type SubjectRow = {
  subject_key: string;
  subject_type: 'self' | 'person' | 'topic';
  content_key_id: string;
  content_iv: string;
  content_ciphertext: string;
  dirty: boolean;
  summarized_at: unknown;
  summary_memory_ids: string[];
};
const subjectRecord = (key: string) => `subject:${key}`;
export async function readSubject(deps: IntelDeps, userId: string, row: SubjectRow): Promise<SubjectContent> {
  const plain = await deps.box.open(
    { keyId: row.content_key_id, iv: row.content_iv, ciphertext: row.content_ciphertext },
    { purpose: 'personal_memory', userId, recordId: subjectRecord(row.subject_key) },
  );
  return SubjectContentSchema.parse(JSON.parse(plain));
}
export async function writeSubject(
  deps: IntelDeps,
  tx: SqlExecutor,
  userId: string,
  key: string,
  type: SubjectRow['subject_type'],
  content: SubjectContent,
  summaryIds: string[] | null = null,
): Promise<void> {
  const sealed = await deps.box.seal(JSON.stringify(content), { purpose: 'personal_memory', userId, recordId: subjectRecord(key) });
  await tx.query(
    `insert into public.personal_memory_subjects(user_id,subject_key,subject_type,content_key_id,content_iv,content_ciphertext,dirty,summarized_at,summary_memory_ids)
     values($1::uuid,$2,$3,$4,$5,$6,$7,case when $7 then null else now() end,coalesce($8::uuid[],'{}'))
     on conflict(user_id,subject_key) do update set content_key_id = excluded.content_key_id,content_iv = excluded.content_iv,
       content_ciphertext = excluded.content_ciphertext,dirty = excluded.dirty,
       summarized_at = case when $8::uuid[] is null then personal_memory_subjects.summarized_at else excluded.summarized_at end,
       summary_memory_ids = case when $8::uuid[] is null then personal_memory_subjects.summary_memory_ids else excluded.summary_memory_ids end,
       updated_at = now()`,
    [userId, key, type, sealed.keyId, sealed.iv, sealed.ciphertext, summaryIds === null, summaryIds],
  );
}
/** A page gained or changed facts: create it, or mark it for the next consolidation pass. */
export async function touchSubject(deps: IntelDeps, tx: SqlExecutor, userId: string, key: string, subject: MemorySubjectInput): Promise<void> {
  const row = await one<SubjectRow>(tx, `select * from public.personal_memory_subjects where subject_key = $1`, [key]);
  if (!row) return writeSubject(deps, tx, userId, key, subject.type, { label: subject.label, key: subject.key, summary: null });
  // A person first seen as a bare address gets their name once a message gives it.
  if (subject.type === 'person' && subject.label !== subject.key) {
    const current = await readSubject(deps, userId, row);
    if (current.label === current.key) return writeSubject(deps, tx, userId, key, row.subject_type, { ...current, label: subject.label });
  }
  await tx.query(`update public.personal_memory_subjects set dirty = true,updated_at = now() where subject_key = $1`, [key]);
}
export type LoadedSubject = SubjectContent & { type: SubjectRow['subject_type']; dirty: boolean; summaryIds: string[]; summaryValid: boolean };
/** Pages by key. A summary counts only while every fact it was written from is still active. */
export async function loadSubjects(deps: IntelDeps, tx: SqlExecutor, userId: string, keys: string[] | null): Promise<Map<string, LoadedSubject>> {
  if (keys && !keys.length) return new Map();
  const rows = await tx.query<SubjectRow & { live: number }>(
    `select s.*,(select count(*)::int from public.personal_memories m where m.id = any(s.summary_memory_ids) and m.status = 'active'
       and (m.valid_until is null or m.valid_until > $2::timestamptz)) as live
       from public.personal_memory_subjects s where $1::text[] is null or s.subject_key = any($1::text[])`,
    [keys, deps.now()],
  );
  const out = new Map<string, LoadedSubject>();
  for (const row of rows) {
    const content = await readSubject(deps, userId, row);
    const valid = Boolean(content.summary) && row.summary_memory_ids.length > 0 && num(row.live) === row.summary_memory_ids.length;
    out.set(row.subject_key, { ...content, type: row.subject_type, dirty: row.dirty, summaryIds: row.summary_memory_ids, summaryValid: valid });
  }
  return out;
}
/**
 * Debounced: at most one queued pass per user. Learning schedules it ten minutes
 * out so a burst of mail is consolidated once; opening Memory asks for it now.
 */
export async function scheduleConsolidation(deps: IntelDeps, tx: SqlExecutor, userId: string, generation: string, delayMs = 10 * 60_000): Promise<void> {
  const runAt = new Date(deps.now().getTime() + delayMs);
  // A pass already due by then covers this change. A later one does not: the
  // sooner pass runs, and the later one finds nothing left to do at no cost.
  const queued = await one(
    tx,
    `select 1 from public.jobs where kind = 'memory.consolidate' and status in ('queued','retrying') and payload->>'generation' = $1 and run_at <= $2::timestamptz limit 1`,
    [generation, runAt],
  );
  if (queued) return;
  await enqueue(tx, {
    kind: 'memory.consolidate',
    userId,
    key: `memory-consolidate:${userId}:${runAt.getTime()}:${randomToken().slice(0, 16)}`,
    payload: { generation },
    runAt,
    maxAttempts: 3,
  });
}

/** Atomic reconciliation under the per-user state lock. No AI inside the transaction. */
export async function persistCandidate(
  deps: IntelDeps,
  tx: SqlExecutor,
  userId: string,
  state: MemoryState,
  input: {
    candidate: MemoryCandidate;
    source: MemorySource;
    embedding: number[] | null;
    generation: string;
    /** The known fact an update/confirm refers to, resolved from the prompt handle. */
    target?: MemoryRow | null;
  },
): Promise<'persisted' | 'consolidated' | 'skipped'> {
  const prefs = await loadPreferences(tx, userId);
  const { candidate, source } = input;
  if (
    !prefs.memory.enabled ||
    state.generation !== input.generation ||
    (source.message.direction === 'inbound' ? !prefs.memory.learnFromReceivedMail : !prefs.memory.learnFromSentMail) ||
    (state.learnAfter && Date.parse(source.message.date) <= Date.parse(state.learnAfter))
  )
    return 'skipped';
  const decision = persistenceDecision(candidate, source.message, deps.now());
  if (!decision.accepted) return 'skipped';
  const { fingerprint, conceptKey, scopeKey, subject } = await candidateKeys(state, candidate, source);
  // Facts about the owner are not "about" whoever they happened to be emailing.
  const entities =
    subject.type === 'self'
      ? candidate.entities.filter((entity) => entity.type !== 'email')
      : subject.type === 'person' && !candidate.entities.some((entity) => entity.type === 'email' && entity.key.toLowerCase() === subject.key)
        ? [...candidate.entities, { type: 'email' as const, key: subject.key }]
        : candidate.entities;
  if (await one(tx, `select 1 from public.personal_memory_blocks where fingerprint = $1 or fingerprint = $2`, [fingerprint, conceptKey])) {
    await tx.query(`insert into public.personal_memory_exclusions(user_id,thread_id) values($1::uuid,$2::uuid) on conflict do nothing`, [
      userId,
      source.threadId,
    ]);
    return 'skipped';
  }
  const exact = await one<MemoryRow>(tx, `select * from public.personal_memories where fingerprint = $1`, [fingerprint]);
  if (exact && (exact.status !== 'active' || exact.corrected)) {
    await tx.query(`insert into public.personal_memory_exclusions(user_id,thread_id) values($1::uuid,$2::uuid) on conflict do nothing`, [
      userId,
      source.threadId,
    ]);
    return 'skipped';
  }
  let existing = exact;
  let replaces: MemoryRow | null = null;
  const target = input.target ?? null;
  if (!existing && target) {
    // A user's own correction outranks anything mail says later.
    if (target.status !== 'active' || target.corrected) return 'skipped';
    const known = await readMemory(deps, userId, target);
    if (candidate.op === 'confirm' && sameSpecifics(known.text, candidate.canonicalText)) existing = target;
    else if (candidate.op === 'update') replaces = target;
  }
  if (!existing && !replaces && input.embedding) {
    // Backstop for paraphrases the model did not recognize: the nearest fact on
    // this page, when it is near-identical and states the same numbers and dates.
    const near = await one<MemoryRow & { similarity: number }>(
      tx,
      `select *,1-(embedding <=> $2::extensions.vector) as similarity from public.personal_memories
       where scope_key = $1 and status = 'active' and not corrected and embedding is not null and embedding_model = $3
       order by embedding <=> $2::extensions.vector limit 1`,
      [scopeKey, vectorLiteral(input.embedding), deps.config.ai.embedModel],
    );
    if (near && num(near.similarity) >= DUPLICATE_SIMILARITY && sameSpecifics((await readMemory(deps, userId, near)).text, candidate.canonicalText)) existing = near;
  }
  // Facts on this page the new one says everything about, and more: they fold into it.
  const absorbed: MemoryRow[] = [];
  if (!existing && !replaces) {
    // Second backstop, with no model: the page already holds this fact in other
    // words, or a fuller version of it. Pages are small, so reading them is cheap.
    const page = await tx.query<MemoryRow>(
      `select * from public.personal_memories where scope_key = $1 and status = 'active' order by corrected desc,last_confirmed_at desc limit 200`,
      [scopeKey],
    );
    for (const row of page) {
      const known = (await readMemory(deps, userId, row)).text;
      if (sameFactWording(known, candidate.canonicalText) || absorbsFact(known, candidate.canonicalText)) {
        // The user's own wording of this fact outranks anything mail says later.
        if (row.corrected) return 'skipped';
        existing = row;
        absorbed.length = 0;
        break;
      }
      if (!row.corrected && absorbsFact(candidate.canonicalText, known)) absorbed.push(row);
    }
  }
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    const sealed = await deps.box.seal(JSON.stringify({ text: candidate.canonicalText, entities, concept: candidate.concept, subject }), {
      purpose: 'personal_memory',
      userId,
      recordId: id,
    });
    await tx.query(
      `insert into public.personal_memories(id,user_id,kind,category,text_key_id,text_iv,text_ciphertext,fingerprint,concept_key,importance,confidence,valid_from,valid_until,last_confirmed_at,embedding,embedding_model,explicit_update,scope_key,subject_type)
      values($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14::timestamptz,$15::extensions.vector,$16,$17,$18,$19)`,
      [
        id,
        userId,
        candidate.kind,
        candidate.category,
        sealed.keyId,
        sealed.iv,
        sealed.ciphertext,
        fingerprint,
        conceptKey,
        candidate.importance,
        candidate.confidence,
        decision.validFrom,
        decision.validUntil,
        source.message.date,
        input.embedding ? vectorLiteral(input.embedding) : null,
        input.embedding ? deps.config.ai.embedModel : null,
        isExplicitReplacement(candidate) || Boolean(replaces),
        scopeKey,
        subject.type,
      ],
    );
    await touchSubject(deps, tx, userId, scopeKey, subject);
    // Keep every source of the less complete wordings on the fuller fact.
    for (const row of absorbed) await mergeFacts(tx, id, row.id);
  }
  const added = await tx.query(
    `insert into public.personal_memory_sources(memory_id,user_id,mail_account_id,thread_id,gmail_message_id,source_at,source_version)
    values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::timestamptz,$7) on conflict(memory_id,mail_account_id,gmail_message_id) do nothing returning id`,
    [id, userId, source.accountId, source.threadId, source.message.gmailMessageId, source.message.date, source.version],
  );
  await tx.query(
    `update public.personal_memory_sources set source_version = $4 where memory_id = $1::uuid and mail_account_id = $2::uuid and gmail_message_id = $3`,
    [id, source.accountId, source.message.gmailMessageId, source.version],
  );
  if (existing && added.length) {
    await tx.query(
      `update public.personal_memories set confidence = least(0.98,greatest(confidence,$2) + 0.02),last_confirmed_at = greatest(last_confirmed_at,$3::timestamptz),valid_until = case when valid_until is null then null else greatest(valid_until,$4::timestamptz) end,updated_at = now() where id = $1::uuid`,
      [id, candidate.confidence, source.message.date, decision.validUntil],
    );
  }
  for (const entity of entities) {
    const key = await memoryDigest(state, `entity:${entity.type}`, entity.key);
    const reliability =
      entity.type === 'email' && [source.message.from, ...source.message.to, ...source.message.cc].includes(entity.key.toLowerCase()) ? 1 : 0.5;
    await tx.query(
      `insert into public.personal_memory_entities(memory_id,user_id,entity_type,entity_key,reliability) values($1::uuid,$2::uuid,$3,$4,$5) on conflict do nothing`,
      [id, userId, entity.type, key, reliability],
    );
  }
  if (replaces && !existing) {
    // Newer information retires the fact it updates; an older backfill cannot
    // overwrite today, so it lands as history instead.
    if (Date.parse(iso(replaces.last_confirmed_at)) <= Date.parse(source.message.date))
      await tx.query(`update public.personal_memories set status = 'superseded',superseded_by = $2::uuid,updated_at = now() where id = $1::uuid and status = 'active'`, [
        replaces.id,
        id,
      ]);
    else await tx.query(`update public.personal_memories set status = 'superseded',superseded_by = $2::uuid where id = $1::uuid`, [id, replaces.id]);
  }
  if (conceptKey && isExplicitReplacement(candidate) && !existing) {
    // Only newer evidence can retire an earlier value. Backfill must not overwrite today.
    await tx.query(
      `update public.personal_memories set status = 'superseded',superseded_by = $2::uuid,updated_at = now()
      where concept_key = $1 and id <> $2::uuid and status = 'active' and not corrected and last_confirmed_at < $3::timestamptz`,
      [conceptKey, id, source.message.date],
    );
  }
  if (conceptKey && !existing) {
    const newer = await one<{ id: string }>(
      tx,
      `select id from public.personal_memories where concept_key = $1 and id <> $2::uuid
      and status = 'active' and explicit_update and last_confirmed_at > $3::timestamptz order by last_confirmed_at desc limit 1`,
      [conceptKey, id, source.message.date],
    );
    if (newer) await tx.query(`update public.personal_memories set status = 'superseded',superseded_by = $2::uuid where id = $1::uuid`, [id, newer.id]);
  }
  return existing ? 'consolidated' : 'persisted';
}

/** Fold `drop` into `keep`: every source and entity moves; nothing is forgotten or blocked. */
export async function mergeFacts(tx: SqlExecutor, keep: string, drop: string) {
  await tx.query(
    `insert into public.personal_memory_sources(memory_id,user_id,mail_account_id,thread_id,gmail_message_id,source_at,source_version)
     select $1::uuid,user_id,mail_account_id,thread_id,gmail_message_id,source_at,source_version from public.personal_memory_sources where memory_id = $2::uuid
     on conflict(memory_id,mail_account_id,gmail_message_id) do nothing`,
    [keep, drop],
  );
  await tx.query(
    `insert into public.personal_memory_entities(memory_id,user_id,entity_type,entity_key,reliability)
     select $1::uuid,user_id,entity_type,entity_key,reliability from public.personal_memory_entities where memory_id = $2::uuid
       and not (entity_type = 'email' and exists(select 1 from public.personal_memories k where k.id = $1::uuid and k.subject_type = 'self'))
     on conflict do nothing`,
    [keep, drop],
  );
  await tx.query(
    `update public.personal_memories k set last_confirmed_at = greatest(k.last_confirmed_at,d.last_confirmed_at),
       confidence = least(0.98,greatest(k.confidence,d.confidence) + 0.02),importance = greatest(k.importance,d.importance),updated_at = now()
     from public.personal_memories d where k.id = $1::uuid and d.id = $2::uuid`,
    [keep, drop],
  );
  await tx.query(`update public.personal_memories set superseded_by = $1::uuid where superseded_by = $2::uuid`, [keep, drop]);
  await tx.query(`delete from public.personal_memories where id = $1::uuid`, [drop]);
}

export async function forgetMemory(deps: IntelDeps, tx: SqlExecutor, userId: string, id: string): Promise<void> {
  await memoryState(deps, tx, userId, true);
  const row = await one<MemoryRow>(tx, `select * from public.personal_memories where id = $1::uuid`, [id]);
  if (!row) throw new ApiError('not_found', 'That memory does not exist.');
  // Block all versions of this single-valued concept too; forgetting history
  // must not silently revive a superseded value on resync.
  await tx.query(
    `insert into public.personal_memory_blocks(user_id,fingerprint)
    select user_id,fingerprint from public.personal_memories where id = $1::uuid or (concept_key is not null and concept_key = $2) on conflict do nothing`,
    [id, row.concept_key],
  );
  if (row.concept_key)
    await tx.query(`insert into public.personal_memory_blocks(user_id,fingerprint) values($1::uuid,$2) on conflict do nothing`, [userId, row.concept_key]);
  await tx.query(
    `insert into public.personal_memory_exclusions(user_id,thread_id)
    select distinct s.user_id,s.thread_id from public.personal_memory_sources s join public.personal_memories m on m.id = s.memory_id
    where m.id = $1::uuid or (m.concept_key is not null and m.concept_key = $2) on conflict do nothing`,
    [id, row.concept_key],
  );
  await tx.query(`update public.personal_memories set superseded_by = null where superseded_by = $1::uuid`, [id]);
  await tx.query(`delete from public.personal_memories where id = $1::uuid`, [id]);
  // Its page summary is now invalid (it named a removed fact); rewrite it, or drop an empty page.
  await tx.query(
    `delete from public.personal_memory_subjects s where s.subject_key = $1 and not exists(select 1 from public.personal_memories m where m.scope_key = s.subject_key)`,
    [row.scope_key],
  );
  await tx.query(`update public.personal_memory_subjects set dirty = true,updated_at = now() where subject_key = $1`, [row.scope_key]);
}

export async function purgeMemories(deps: IntelDeps, tx: SqlExecutor, userId: string): Promise<number> {
  await memoryState(deps, tx, userId, true);
  // Changing generation invalidates in-flight/queued work; cutoff prevents an
  // unrelated future resync from reconstructing the pre-forget mailbox.
  await tx.query(
    `update public.personal_memory_state set generation = gen_random_uuid(),learn_after = $2::timestamptz,updated_at = now() where user_id = $1::uuid`,
    [userId, deps.now()],
  );
  await tx.query(`insert into public.personal_memory_exclusions(user_id,thread_id) select user_id,id from public.threads on conflict do nothing`);
  const removed = await tx.query(`delete from public.personal_memories returning id`);
  await tx.query(`delete from public.personal_memory_blocks`);
  await tx.query(`delete from public.personal_memory_subjects`);
  await tx.query(`delete from public.personal_memory_extractions`);
  return removed.length;
}

export async function correctMemory(
  deps: IntelDeps,
  userId: string,
  input: { memoryId: string; text: string; validUntil?: string | null },
  transaction?: SqlExecutor,
): Promise<PersonalMemory> {
  if (!safeMemoryText(input.text)) throw new ApiError('invalid_request', 'Secrets, sensitive information and embedded instructions cannot be saved as memory.');
  const mutate = async (tx: SqlExecutor) => {
    const state = await memoryState(deps, tx, userId, true);
    const row = await one<MemoryRow>(tx, `select * from public.personal_memories where id = $1::uuid`, [input.memoryId]);
    if (!row) throw new ApiError('not_found', 'That memory does not exist.');
    if (row.status !== 'active') throw new ApiError('conflict', 'Correct the active version of this memory.');
    const content = await readMemory(deps, userId, row);
    const until = input.validUntil === undefined ? isoOrNull(row.valid_until) : input.validUntil;
    if (until && Date.parse(until) <= Date.parse(iso(row.valid_from))) throw new ApiError('invalid_request', 'Expiry must be after the memory begins.');
    if (row.corrected && content.text === input.text && until === isoOrNull(row.valid_until))
      return (await toMemories(deps, tx, userId, [row]))[0]!;
    await tx.query(`insert into public.personal_memory_blocks(user_id,fingerprint) values($1::uuid,$2) on conflict do nothing`, [userId, row.fingerprint]);
    const sealed = await deps.box.seal(JSON.stringify({ ...content, text: input.text }), { purpose: 'personal_memory', userId, recordId: row.id });
    const fingerprint = await memoryDigest(state, 'fact', `${row.scope_key}:${input.text}`);
    const duplicate = await one(tx, `select 1 from public.personal_memories where fingerprint = $1 and id <> $2::uuid`, [fingerprint, row.id]);
    if (duplicate) throw new ApiError('conflict', 'That fact is already remembered. Correct or forget the existing memory.');
    const rows = await tx.query<MemoryRow>(
      `update public.personal_memories set text_key_id = $2,text_iv = $3,text_ciphertext = $4,fingerprint = $5,
      embedding = null,embedding_model = null,corrected = true,confidence = 1,valid_until = $6::timestamptz,last_confirmed_at = $7::timestamptz,updated_at = now() where id = $1::uuid returning *`,
      [row.id, sealed.keyId, sealed.iv, sealed.ciphertext, fingerprint, until, deps.now()],
    );
    // The page overview was written from the old wording; hide it until it is rewritten.
    await tx.query(`update public.personal_memory_subjects set dirty = true,summary_memory_ids = '{}',updated_at = now() where subject_key = $1`, [row.scope_key]);
    if (row.subject_type) await scheduleConsolidation(deps, tx, userId, state.generation, 0);
    await enqueue(tx, {
      kind: 'memory.reindex',
      userId,
      // A -> B -> A must index A again even if its first job already finished.
      key: `memory-index:${row.id}:${fingerprint}:${state.generation}:${randomToken().slice(0, 12)}`,
      payload: { memoryId: row.id, fingerprint, generation: state.generation },
      maxAttempts: 4,
    });
    // Corrected text remains immediately available by entity. Its stale vector
    // is removed, so semantic retrieval cannot use the previous wording.
    return (await toMemories(deps, tx, userId, rows))[0]!;
  };
  return transaction ? mutate(transaction) : deps.db.asUser(userId, mutate);
}
