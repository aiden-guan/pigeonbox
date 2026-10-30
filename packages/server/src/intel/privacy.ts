import { purgeMemories } from './memory/store.js';
import { num, type SqlExecutor } from '../db/sql.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';

/**
 * What the server holds for the user, and ways to delete it. Counts only.
 */
const INVENTORY: Array<{ table: string; label: string; content: 'metadata' | 'encrypted' | 'configuration' }> = [
  { table: 'mail_accounts', label: 'Connected Google accounts', content: 'metadata' },
  { table: 'encrypted_credentials', label: 'Encrypted Google access tokens', content: 'encrypted' },
  { table: 'threads', label: 'Thread metadata (subjects, participants, dates, labels)', content: 'metadata' },
  { table: 'message_metadata', label: 'Message metadata (no bodies)', content: 'metadata' },
  { table: 'thread_states', label: 'Thread states and encrypted summaries', content: 'encrypted' },
  { table: 'commitments', label: 'Encrypted commitments', content: 'encrypted' },
  { table: 'drafts', label: 'Prepared drafts (text encrypted)', content: 'encrypted' },
  { table: 'follow_ups', label: 'Follow-up tracking', content: 'metadata' },
  { table: 'contacts', label: 'Contacts derived from mail', content: 'metadata' },
  { table: 'search_documents', label: 'Search vectors (from subjects and summaries)', content: 'metadata' },
  { table: 'personal_memories', label: 'Personal memories (derived facts, encrypted)', content: 'encrypted' },
  { table: 'personal_memory_subjects', label: 'Memory pages (labels and summaries, encrypted)', content: 'encrypted' },
  { table: 'personal_memory_entities', label: 'Memory entity links (keyed digests)', content: 'metadata' },
  { table: 'personal_memory_state', label: 'Memory learning/reset state and encrypted digest key', content: 'encrypted' },
  { table: 'personal_memory_sources', label: 'Memory source references (no bodies)', content: 'metadata' },
  { table: 'personal_memory_extractions', label: 'Memory processing checkpoints (IDs only)', content: 'metadata' },
  { table: 'personal_memory_blocks', label: 'Forgotten fact markers (keyed digests only)', content: 'metadata' },
  { table: 'personal_memory_exclusions', label: 'Forgotten historical context markers (IDs only)', content: 'metadata' },
  { table: 'recall_chunks', label: 'Fast Recall excerpts (opt-in, encrypted)', content: 'encrypted' },
  { table: 'calendar_event_cache', label: 'Upcoming calendar events (titles and times)', content: 'metadata' },
  { table: 'briefings', label: 'Briefings (encrypted)', content: 'encrypted' },
  { table: 'notes', label: 'Your notes (encrypted)', content: 'encrypted' },
  { table: 'ask_feedback', label: 'Ask Pigeon feedback (questions and notes encrypted)', content: 'encrypted' },
  { table: 'documents', label: 'Tracked documents', content: 'encrypted' },
  { table: 'document_events', label: 'Document activity (pages and visible time)', content: 'metadata' },
  { table: 'document_viewer_sessions', label: 'Document viewer sessions (temporary)', content: 'metadata' },
  { table: 'audit_events', label: 'Activity log', content: 'metadata' },
  { table: 'smart_views', label: 'Smart Views and rules', content: 'configuration' },
  { table: 'automation_rules', label: 'Automations', content: 'configuration' },
  { table: 'mail_unsubscribes', label: 'Mailing lists you left (sender addresses)', content: 'configuration' },
];

export async function inventory(tx: SqlExecutor) {
  const out = [];
  for (const entry of INVENTORY) {
    const rows = await tx.query<{ n: number }>(`select count(*)::int as n from public.${entry.table}`);
    out.push({ ...entry, count: num(rows[0]?.n) });
  }
  return out;
}

/**
 * Delete everything synced from mail (threads, states, drafts, commitments,
 * contacts, vectors, excerpts) but keep connections and settings. Sync starts
 * again from scratch on the next run.
 */
export async function purgeMailData(deps: IntelDeps, userId: string): Promise<number> {
  return deps.db.asUser(userId, async (tx) => {
    let removed = await purgeMemories(deps,tx,userId);
    for (const table of ['recall_chunks', 'search_documents', 'relationship_events', 'contacts', 'companies', 'threads', 'calendar_event_cache', 'briefings']) {
      removed += (await tx.query(`delete from public.${table} returning 1`)).length;
    }
    await tx.query(`update public.gmail_sync_state set history_id = null, coverage_since = null, state = 'initializing'`);
    const accounts = await tx.query<{ id: string }>(`select id from public.mail_accounts where status = 'active' and 'mail_read' = any (features)`);
    const { enqueue } = await import('../jobs/queue.js');
    for (const account of accounts) {
      await enqueue(tx, { kind: 'gmail.recover', userId, accountId: account.id, key: `recover:${account.id}:purge:${deps.now().toISOString()}`, payload: { reason: 'purge' } });
    }
    await recordAudit(tx, { userId, actor: { type: 'user', id: userId, name: 'You' }, action: 'purge_mail_data', tier: 0, target: { kind: 'account', id: userId, title: null }, summary: `Deleted ${removed} synced records`, policy: { decision: 'allowed', reason: 'User request' } });
    return removed;
  });
}
