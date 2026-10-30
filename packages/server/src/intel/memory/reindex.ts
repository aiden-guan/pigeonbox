import { one } from '../../db/sql.js';
import type { JobRecord } from '../../jobs/queue.js';
import { SkipJob } from '../../jobs/runner.js';
import { embedTexts } from '../ai.js';
import type { IntelDeps } from '../context.js';
import { vectorLiteral } from '../../db/vector.js';
import { memoryState, readMemory } from './store.js';
import type { MemoryRow } from './types.js';

/** Reindex a user correction, never its old text. No content in the job. */
export async function runMemoryReindex(deps: IntelDeps, job: JobRecord): Promise<void> {
  const id = String(job.payload.memoryId ?? '');
  if (!job.userId || !id) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const loaded = await deps.db.asUser(userId, async (tx) => {
    const state = await memoryState(deps, tx, userId);
    const row = await one<MemoryRow & { embedding_model: string | null }>(tx, `select * from public.personal_memories where id = $1::uuid`, [id]);
    return { state, row };
  });
  if (!loaded.row || loaded.state.generation !== job.payload.generation || loaded.row.status !== 'active' || loaded.row.fingerprint !== job.payload.fingerprint)
    throw new SkipJob('memory_reindex_stale');
  if (loaded.row.embedding_model === deps.config.ai.embedModel) throw new SkipJob('up_to_date');
  const content = await readMemory(deps, userId, loaded.row);
  const [vector] = await embedTexts(deps, userId, [content.text], `job_${job.id}`);
  await deps.db.asUser(userId, async (tx) => {
    const state = await memoryState(deps, tx, userId, true);
    if (state.generation !== job.payload.generation) return;
    await tx.query(
      `update public.personal_memories set embedding = $3::extensions.vector,embedding_model = $4,updated_at = now()
      where id = $1::uuid and fingerprint = $2 and status = 'active'`,
      [id, job.payload.fingerprint, vectorLiteral(vector!), deps.config.ai.embedModel],
    );
  });
}
