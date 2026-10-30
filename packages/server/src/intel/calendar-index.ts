import { iso } from '../db/sql.js';
import { vectorLiteral } from '../db/vector.js';
import { sha256Hex } from '../platform/crypto.js';
import { embedTexts } from './ai.js';
import type { IntelDeps } from './context.js';
import { safeMemoryText } from './memory/policy.js';

/** Existing calendar.refresh job does a bounded background batch, never a live check. */
export async function indexCalendarContext(deps: IntelDeps, userId: string, accountId: string): Promise<void> {
  const now = deps.now();
  const rows = await deps.db.asUser(userId, tx => tx.query<{ id: string; title: string; location: string | null; start_at: unknown; end_at: unknown; updated_at: unknown }>(
    `select id,title,location,start_at,end_at,updated_at from public.calendar_event_cache
     where mail_account_id = $1::uuid and end_at > $2::timestamptz
       and start_at < $2::timestamptz + interval '45 days' and updated_at >= $2::timestamptz - interval '30 minutes'
       and coalesce(status,'confirmed') <> 'cancelled' and coalesce(self_response,'accepted') <> 'declined'
       and (embedding is null or embedding_model is distinct from $3)
     order by start_at limit 32`, [accountId, now, deps.config.ai.embedModel]));
  const eligible = rows.filter(row => safeMemoryText(`${row.title} ${row.location ?? ''}`));
  if (!eligible.length) return;
  const texts = eligible.map(row => `${row.title}${row.location ? ` at ${row.location}` : ''}. ${iso(row.start_at)} to ${iso(row.end_at)}`);
  try {
    const vectors = await embedTexts(deps, userId, texts, `calendar-index:${accountId}`);
    const hashes = await Promise.all(texts.map(text => sha256Hex(text)));
    await deps.db.asUser(userId, tx => tx.query(
      `update public.calendar_event_cache e set embedding = v.vector::extensions.vector, embedding_model = $5, embedding_hash = v.hash
       from unnest($1::uuid[], $2::text[], $3::text[], $4::timestamptz[]) as v(id,vector,hash,version)
       where e.id = v.id and e.updated_at = v.version and coalesce(e.status,'confirmed') <> 'cancelled' and coalesce(e.self_response,'accepted') <> 'declined'`,
      [eligible.map(row => row.id), vectors.map(vectorLiteral), hashes, eligible.map(row => iso(row.updated_at)), deps.config.ai.embedModel]));
  } catch {
    // A missed background batch keeps exact/FTS context available; no provider text in logs.
    deps.log('info', 'calendar indexing skipped', { userId, accountId, code: 'calendar_index_unavailable' });
  }
}
