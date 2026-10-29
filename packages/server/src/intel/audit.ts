import type { AuditEvent, RiskTier } from '@pigeonbox/api-contract';
import { iso, isoOrNull, one, type SqlExecutor } from '../db/sql.js';

/**
 * The audit log: every action PigeonBox takes or proposes on the user's
 * behalf, who or what caused it, the policy decision, and how to undo it.
 * Rows hold IDs, subjects and short summaries, never message bodies.
 */

export type ActorType = AuditEvent['actor']['type'];

export type AuditInput = {
  userId: string;
  actor: { type: ActorType; id: string | null; name: string };
  action: string;
  tier: RiskTier;
  target: { kind: string; id: string; title: string | null };
  summary: string;
  policy: { decision: AuditEvent['policy']['decision']; reason: string };
  reversible?: boolean;
  /** Inverse operation. IDs only. */
  undo?: Record<string, unknown> | null;
  accountId?: string | null;
  threadId?: string | null;
  idempotencyKey?: string | null;
  undoOf?: string | null;
};

type AuditRow = {
  id: string;
  created_at: unknown;
  actor_type: ActorType;
  actor_id: string | null;
  actor_name: string;
  action: string;
  tier: number;
  target_kind: string;
  target_id: string;
  target_title: string | null;
  summary: string;
  policy_decision: AuditEvent['policy']['decision'];
  policy_reason: string;
  reversible: boolean;
  undone_at: unknown;
  undo_of: string | null;
};

export function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    at: iso(row.created_at),
    actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name.slice(0, 120) },
    action: row.action.slice(0, 64),
    tier: Math.max(0, Math.min(3, Number(row.tier))) as RiskTier,
    target: { kind: row.target_kind.slice(0, 40), id: row.target_id.slice(0, 256), title: row.target_title?.slice(0, 300) ?? null },
    summary: row.summary.slice(0, 300),
    policy: { decision: row.policy_decision, reason: row.policy_reason.slice(0, 200) },
    reversible: row.reversible && !row.undone_at,
    undoneAt: isoOrNull(row.undone_at),
    undoOf: row.undo_of,
  };
}

/**
 * Insert an audit row. With an idempotency key, a repeated call returns the
 * first row instead of inserting a duplicate.
 */
export async function recordAudit(tx: SqlExecutor, input: AuditInput): Promise<{ id: string; created: boolean }> {
  const inserted = await one<{ id: string }>(
    tx,
    `insert into public.audit_events
       (user_id, actor_type, actor_id, actor_name, action, tier, target_kind, target_id, target_title, summary,
        policy_decision, policy_reason, reversible, undo, mail_account_id, gmail_thread_id, idempotency_key, undo_of)
     values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::uuid, $16, $17, $18::uuid)
     on conflict (user_id, idempotency_key) do nothing
     returning id`,
    [
      input.userId,
      input.actor.type,
      input.actor.id,
      input.actor.name.slice(0, 120),
      input.action,
      input.tier,
      input.target.kind,
      input.target.id,
      input.target.title?.slice(0, 300) ?? null,
      input.summary.slice(0, 300),
      input.policy.decision,
      input.policy.reason.slice(0, 200),
      Boolean(input.reversible),
      input.undo ?? null,
      input.accountId ?? null,
      input.threadId ?? null,
      input.idempotencyKey ?? null,
      input.undoOf ?? null,
    ],
  );
  if (inserted) return { id: inserted.id, created: true };
  const existing = await one<{ id: string }>(tx, `select id from public.audit_events where idempotency_key = $1`, [input.idempotencyKey]);
  return { id: existing!.id, created: false };
}

export async function listAudit(tx: SqlExecutor, options: { threadId?: string; limit: number; cursor?: string }): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
  const params: unknown[] = [options.limit + 1];
  let where = 'true';
  if (options.threadId) {
    params.push(options.threadId);
    where += ` and gmail_thread_id = $${params.length}`;
  }
  if (options.cursor) {
    const at = Date.parse(options.cursor);
    if (Number.isFinite(at)) {
      params.push(new Date(at));
      where += ` and created_at < $${params.length}::timestamptz`;
    }
  }
  const rows = await tx.query<AuditRow>(`select * from public.audit_events where ${where} order by created_at desc limit $1`, params);
  const events = rows.slice(0, options.limit).map(toAuditEvent);
  return { events, nextCursor: rows.length > options.limit ? events[events.length - 1]!.at : null };
}

export async function getAuditRow(tx: SqlExecutor, id: string) {
  return one<AuditRow & { undo: Record<string, unknown> | null; mail_account_id: string | null; gmail_thread_id: string | null }>(
    tx,
    `select * from public.audit_events where id = $1::uuid`,
    [id],
  );
}
