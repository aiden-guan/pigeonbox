import type { RouteRequest, PersonalMemory, MemorySubject } from '@pigeonbox/api-contract';
import { iso, num, one } from '../../db/sql.js';
import { ApiError } from '../../http.js';
import type { IntelDeps } from '../context.js';
import { contextVector } from './retrieve.js';
import { loadSubjects, memoryState, normalizeFact, scheduleConsolidation, toMemories } from './store.js';
import type { MemoryRow } from './types.js';

export async function listMemories(deps: IntelDeps, userId: string, input: NonNullable<RouteRequest<'memoryList'>>, requestId: string) {
  const query = input.query?.trim();
  const vector = query ? await contextVector(deps, userId, query, requestId) : null;
  return deps.db.asUser(userId, async (tx) => {
    // Search decrypts only a bounded account-scoped batch, including facts
    // awaiting reindexing. No plaintext index or query is persisted.
    const limit = input.limit ?? 20;
    const offset = Number(input.cursor ?? 0);
    const rows = await tx.query<MemoryRow & { similarity: number | null }>(
      `select *,case when $3::extensions.vector is not null and embedding_model = $6 then 1-(embedding <=> $3::extensions.vector) end as similarity from public.personal_memories
      where ($1::boolean or status = 'active') and ($2::text is null or category = $2) and ($7::text is null or scope_key = $7)
      order by case when $3::extensions.vector is not null and embedding_model = $6 then embedding <=> $3::extensions.vector end nulls last,last_confirmed_at desc,id
      limit $4 offset $5`,
      [input.includeHistory, input.category ?? null, vector, query ? 201 : limit + 1, offset, deps.config.ai.embedModel, input.subject ?? null],
    );
    if (query) {
      const batch = rows.slice(0, 200);
      const candidates = await toMemories(deps, tx, userId, batch);
      const terms = normalizeFact(query).split(' ').filter(Boolean);
      const memories: PersonalMemory[] = [];
      let scanned = 0;
      for (let i = 0; i < candidates.length; i += 1) {
        scanned += 1;
        const memory = candidates[i]!;
        const corpus = normalizeFact([memory.text, memory.subject?.label ?? '', ...memory.entities.map(entity => entity.key)].join(' '));
        if (terms.every(term => corpus.includes(term)) || (rows[i]!.similarity !== null && num(rows[i]!.similarity) >= 0.5)) memories.push(memory);
        if (memories.length === limit) break;
      }
      return { memories, nextCursor: rows.length > scanned ? String(offset + scanned) : null };
    }
    const memories = await toMemories(deps, tx, userId, rows.slice(0, limit));
    return { memories, nextCursor: rows.length > limit ? String(offset + limit) : null };
  });
}
export async function getMemory(deps: IntelDeps, userId: string, id: string): Promise<PersonalMemory> {
  return deps.db.asUser(userId, async (tx) => {
    const row = await one<MemoryRow>(tx, `select * from public.personal_memories where id = $1::uuid`, [id]);
    if (!row) throw new ApiError('not_found', 'That memory does not exist.');
    return (await toMemories(deps, tx, userId, [row]))[0]!;
  });
}

/**
 * Memory pages with their overview and size. The owner's page comes first, then
 * by how much is known. Opening the list nudges a pending consolidation pass so
 * older unsorted facts and changed pages are tidied soon after someone looks.
 */
export async function listSubjects(deps: IntelDeps, userId: string): Promise<{ subjects: MemorySubject[]; organizing: boolean }> {
  return deps.db.asUser(userId, async (tx) => {
    const state = await memoryState(deps, tx, userId);
    const counts = await tx.query<{ scope_key: string; facts: number; last: unknown }>(
      `select scope_key,count(*)::int as facts,max(last_confirmed_at) as last from public.personal_memories
       where status = 'active' and subject_type is not null group by scope_key`,
    );
    const unsorted = await one<{ n: number }>(tx, `select count(*)::int as n from public.personal_memories where status = 'active' and subject_type is null`);
    const dirty = await one(tx, `select 1 from public.personal_memory_subjects where dirty limit 1`);
    if (num(unsorted?.n) || dirty) await scheduleConsolidation(deps, tx, userId, state.generation, 0);
    const pages = await loadSubjects(
      deps,
      tx,
      userId,
      counts.map((row) => row.scope_key),
    );
    const subjects = counts.flatMap((row) => {
      const page = pages.get(row.scope_key);
      if (!page) return [];
      return [
        {
          id: row.scope_key,
          type: page.type,
          label: page.label,
          summary: page.summaryValid ? page.summary : null,
          factCount: num(row.facts),
          lastConfirmedAt: iso(row.last),
        },
      ];
    });
    subjects.sort((a, b) => Number(b.type === 'self') - Number(a.type === 'self') || b.factCount - a.factCount || b.lastConfirmedAt.localeCompare(a.lastConfirmedAt));
    return { subjects: subjects.slice(0, 300), organizing: num(unsorted?.n) > 0 };
  });
}
