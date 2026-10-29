import type { ActionSpec, Approval, RiskTier, SourceRef } from '@pigeonbox/api-contract';
import { findPlaceholders } from '@pigeonbox/shared';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import { buildRawMessage, parseRawMessage } from '../google/mime.js';
import { ApiError } from '../http.js';
import { enqueue, type JobRecord } from '../jobs/queue.js';
import { PermanentJobError, SkipJob } from '../jobs/runner.js';
import type { SecretBox } from '../platform/crypto.js';
import { performAction, type ActionTarget } from './actions.js';
import { recordAudit, type ActorType } from './audit.js';
import type { IntelDeps } from './context.js';
import { notify } from './notifications.js';
import { approvalTrackingId, prepareTrackedSend } from './mcp-tracking.js';
import { loadAccount } from './google-access.js';

/**
 * The approval queue. Anything that needs the user's explicit yes — every
 * Tier 3 action, and lower tiers a rule is not allowed to run on its own —
 * becomes an approval card with exactly what would happen. Approving runs the
 * action through the same policy engine, marked approved; nothing else can
 * execute it. The exact outgoing content is sealed at rest.
 */

export type ApprovalPreview = Approval['preview'];

export type NewApproval = {
  userId: string;
  kind: ActionSpec['kind'];
  tier: RiskTier;
  title: string;
  why: string;
  sources: SourceRef[];
  action: ActionSpec;
  target: ActionTarget;
  preview: ApprovalPreview;
  responsible: { type: ActorType; id: string | null; name: string };
  idempotencyKey: string;
  expiresAt?: Date | null;
};

type Row = {
  id: string;
  kind: Approval['kind'];
  tier: number;
  status: Approval['status'];
  title: string;
  why: string;
  sources: SourceRef[];
  action: { spec: ActionSpec; target: ActionTarget };
  preview_key_id: string | null;
  preview_iv: string | null;
  preview_ciphertext: string | null;
  preview_meta: { change?: string; count?: number };
  responsible_type: ActorType;
  responsible_id: string | null;
  responsible_name: string;
  gmail_thread_id: string | null;
  created_at: unknown;
  expires_at: unknown;
  decided_at: unknown;
  result_code: string | null;
  result_message: string | null;
};

export async function createApproval(tx: SqlExecutor, box: SecretBox, input: NewApproval): Promise<{ id: string; created: boolean }> {
  const existing = await one<{ id: string }>(tx, `select id from public.approvals where idempotency_key = $1`, [input.idempotencyKey]);
  if (existing) return { id: existing.id, created: false };
  const id = crypto.randomUUID();
  const { change, count, ...sensitive } = input.preview;
  const sealed = Object.keys(sensitive).length ? await box.seal(JSON.stringify(sensitive), { purpose: 'draft', userId: input.userId, recordId: `approval:${id}` }) : null;
  await tx.query(
    `insert into public.approvals (id, user_id, kind, tier, title, why, sources, action, preview_key_id, preview_iv, preview_ciphertext, preview_meta,
        responsible_type, responsible_id, responsible_name, mail_account_id, thread_id, gmail_thread_id, expires_at, idempotency_key)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::uuid, $17::uuid, $18, $19::timestamptz, $20)`,
    [
      id,
      input.userId,
      input.kind,
      input.tier,
      input.title.slice(0, 200),
      input.why.slice(0, 500),
      JSON.stringify(input.sources.slice(0, 12)),
      JSON.stringify({ spec: input.action, target: input.target }),
      sealed?.keyId ?? null,
      sealed?.iv ?? null,
      sealed?.ciphertext ?? null,
      JSON.stringify({ change: change?.slice(0, 500), count }),
      input.responsible.type,
      input.responsible.id,
      input.responsible.name.slice(0, 120),
      input.target.accountId,
      input.target.threadRowId,
      input.target.gmailThreadId,
      input.expiresAt ?? null,
      input.idempotencyKey,
    ],
  );
  await notify(tx, {
    userId: input.userId,
    kind: 'approval',
    title: `Approval needed: ${input.title.slice(0, 150)}`,
    body: input.why.slice(0, 500),
    accountId: input.target.accountId,
    threadId: input.target.gmailThreadId,
    refId: id,
    dedupeKey: `approval:${id}`,
  });
  return { id, created: true };
}

async function toApproval(box: SecretBox, userId: string, row: Row): Promise<Approval> {
  let sensitive: ApprovalPreview = {};
  if (row.preview_key_id && row.preview_iv && row.preview_ciphertext) {
    try {
      sensitive = JSON.parse(await box.open({ keyId: row.preview_key_id, iv: row.preview_iv, ciphertext: row.preview_ciphertext }, { purpose: 'draft', userId, recordId: `approval:${row.id}` }));
    } catch {
      sensitive = {};
    }
  }
  const expired = row.status === 'pending' && row.expires_at && Date.parse(iso(row.expires_at)) < Date.now();
  return {
    id: row.id,
    kind: row.kind,
    tier: Math.max(0, Math.min(3, num(row.tier))) as RiskTier,
    status: expired ? 'expired' : row.status,
    title: row.title.slice(0, 200),
    why: row.why.slice(0, 500),
    sources: (row.sources ?? []).slice(0, 12),
    preview: { ...sensitive, ...(row.preview_meta?.change ? { change: row.preview_meta.change } : {}), ...(row.preview_meta?.count !== undefined ? { count: row.preview_meta.count } : {}) },
    responsible: { type: row.responsible_type, id: row.responsible_id, name: row.responsible_name.slice(0, 120) },
    threadId: row.gmail_thread_id,
    createdAt: iso(row.created_at),
    expiresAt: isoOrNull(row.expires_at),
    decidedAt: isoOrNull(row.decided_at),
    result: row.result_code ? { code: row.result_code.slice(0, 64), message: (row.result_message ?? '').slice(0, 300) } : null,
  };
}

export async function listApprovals(tx: SqlExecutor, box: SecretBox, userId: string, status: 'pending' | 'decided' | 'all', limit: number) {
  const where = status === 'pending' ? `status = 'pending' and (expires_at is null or expires_at > now())` : status === 'decided' ? `status <> 'pending'` : 'true';
  const rows = await tx.query<Row>(`select * from public.approvals where ${where} order by created_at desc limit $1`, [limit]);
  const pending = await one<{ n: number }>(tx, `select count(*)::int as n from public.approvals where status = 'pending' and (expires_at is null or expires_at > now())`);
  return { approvals: await Promise.all(rows.map((row) => toApproval(box, userId, row))), pending: num(pending?.n) };
}

export async function getApproval(tx: SqlExecutor, box: SecretBox, userId: string, id: string): Promise<Approval | null> {
  const row = await one<Row>(tx, `select * from public.approvals where id = $1::uuid`, [id]);
  return row ? toApproval(box, userId, row) : null;
}

/**
 * Approve (optionally with edits) or reject. Approval only queues execution;
 * the executor re-checks everything when it runs.
 */
export async function decideApproval(
  deps: IntelDeps,
  userId: string,
  request: { id: string; decision: 'approve' | 'reject'; edits?: { subject?: string; body?: string }; idempotencyKey: string },
): Promise<Approval> {
  return deps.db.asUser(userId, async (tx) => {
    const row = await one<Row>(tx, `select * from public.approvals where id = $1::uuid for update`, [request.id]);
    if (!row) throw new ApiError('not_found', 'That approval does not exist.');
    if (row.status !== 'pending') return toApproval(deps.box, userId, row);
    if (row.expires_at && Date.parse(iso(row.expires_at)) < deps.now().getTime()) {
      await tx.query(`update public.approvals set status = 'expired', decided_at = now() where id = $1::uuid`, [row.id]);
      throw new ApiError('conflict', 'This approval expired. Nothing was done.');
    }
    if (request.decision === 'reject') {
      await tx.query(`update public.approvals set status = 'rejected', decided_at = now() where id = $1::uuid`, [row.id]);
      await recordAudit(tx, {
        userId,
        actor: { type: 'user', id: userId, name: 'You' },
        action: `reject_${row.kind}`,
        tier: Math.min(3, num(row.tier)) as RiskTier,
        target: { kind: 'approval', id: row.id, title: row.title },
        summary: `Rejected: ${row.title}`,
        policy: { decision: 'denied', reason: 'You rejected it' },
        idempotencyKey: `decide:${request.idempotencyKey}`,
      });
    } else {
      if (request.edits && (request.edits.body || request.edits.subject)) {
        const current = await toApproval(deps.box, userId, row);
        const edited = { ...current.preview, ...(request.edits.subject ? { subject: request.edits.subject } : {}), ...(request.edits.body ? { body: request.edits.body } : {}) };
        const { change: _change, count: _count, ...sensitive } = edited;
        const sealed = await deps.box.seal(JSON.stringify(sensitive), { purpose: 'draft', userId, recordId: `approval:${row.id}` });
        await tx.query(`update public.approvals set preview_key_id = $2, preview_iv = $3, preview_ciphertext = $4 where id = $1::uuid`, [row.id, sealed.keyId, sealed.iv, sealed.ciphertext]);
      }
      if (row.kind === 'send_email') {
        const body = (await toApproval(deps.box, userId, (await one<Row>(tx, `select * from public.approvals where id = $1::uuid`, [row.id]))!)).preview.body ?? '';
        const open = findPlaceholders(body);
        if (open.length) throw new ApiError('conflict', `Fill in ${open.map((item) => item.token).join(', ')} before approving. Nothing was sent.`);
      }
      await tx.query(`update public.approvals set status = 'approved', decided_at = now() where id = $1::uuid`, [row.id]);
      await enqueue(tx, { kind: 'approval.execute', userId, accountId: null, key: `approval:${row.id}`, payload: { approvalId: row.id }, maxAttempts: 3 });
    }
    const updated = await one<Row>(tx, `select * from public.approvals where id = $1::uuid`, [row.id]);
    return toApproval(deps.box, userId, updated!);
  });
}

/** Execute an approved action. Exactly once per approval (job idempotency + status check). */
export async function runApprovalExecute(deps: IntelDeps, job: JobRecord): Promise<void> {
  const approvalId = String(job.payload.approvalId ?? '');
  if (!job.userId || !approvalId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const approval = await deps.db.asUser(userId, (tx) => getApproval(tx, deps.box, userId, approvalId));
  if (!approval) throw new SkipJob('approval_gone');
  if (approval.status !== 'approved') throw new SkipJob(`status_${approval.status}`);
  const row = await deps.db.asUser(userId, (tx) => one<{ action: { spec: ActionSpec; target: ActionTarget } }>(tx, `select action from public.approvals where id = $1::uuid`, [approvalId]));
  const spec = { ...row!.action.spec, params: { ...row!.action.spec.params } };
  let trackingId: string | null = null;
  // A sequence batch approval schedules each individually approved send; each send re-checks everything.
  if (spec.kind === 'send_email' && typeof spec.params.sequenceId === 'string') {
    const { scheduleApprovedBatch } = await import('./sequences.js');
    const scheduled = await scheduleApprovedBatch(deps, userId, approvalId, spec.params.sequenceId);
    await deps.db.asUser(userId, (tx) =>
      tx.query(`update public.approvals set status = 'executed', executed_at = now(), result_code = 'ok', result_message = $2 where id = $1::uuid`, [approvalId, `Scheduled ${scheduled} email${scheduled === 1 ? '' : 's'} within your sending window`]),
    );
    return;
  }
  // An approved email is sent exactly as shown (with the user's edits).
  if (spec.kind === 'send_email') {
    const completed = await deps.db.asUser(userId, (tx) => one<{ undo: { gmailMessageId?: string; gmailThreadId?: string | null } }>(tx, `select undo from public.audit_events where idempotency_key = $1`, [`action:approval:${approvalId}`]));
    if (completed?.undo?.gmailMessageId) {
      // This send already completed. Repair bookkeeping without needing current
      // billing, Google access or tracker configuration, and without dispatch.
      if (spec.params.trackOpens === true || spec.params.trackLinks === true) await deps.store.trackerStoreFor(userId).updateEmail(await approvalTrackingId(userId, approvalId), {
        status: 'SENT', gmail_message_id: completed.undo.gmailMessageId, gmail_thread_id: completed.undo.gmailThreadId ?? null,
      });
      await deps.db.asUser(userId, (tx) => tx.query(`update public.approvals set status = 'executed', executed_at = now(), result_code = 'ok', result_message = 'Sent the approved email' where id = $1::uuid`, [approvalId]));
      return;
    }
    const preview = approval.preview;
    const to = (preview.to ?? []).map((email) => ({ email }));
    if (!to.length || !preview.body) throw new PermanentJobError('approval_incomplete');
    if (findPlaceholders(preview.body).length) throw new PermanentJobError('placeholders_unresolved');
    const headers = typeof spec.params.headers === 'string' ? (JSON.parse(spec.params.headers) as Record<string, string>) : undefined;
    const tracking = { opens: spec.params.trackOpens === true, links: spec.params.trackLinks === true };
    const account = tracking.opens || tracking.links ? await deps.db.asUser(userId, (tx) => loadAccount(tx, row!.action.target.accountId)) : null;
    if ((tracking.opens || tracking.links) && !account) throw new PermanentJobError('account_gone');
    let tracked;
    try {
      tracked = await prepareTrackedSend(deps, { userId, approvalId, sender: account?.email ?? '', recipients: [...(preview.to ?? []), ...(preview.cc ?? [])], subject: preview.subject ?? '', body: preview.body, tracking });
    } catch (error) {
      if (error instanceof ApiError) {
        await deps.db.asUser(userId, (tx) => tx.query(`update public.approvals set status = 'failed', result_code = $2, result_message = $3 where id = $1::uuid`, [approvalId, error.code, error.message.slice(0, 300)]));
        throw new PermanentJobError(error.code);
      }
      throw error;
    }
    trackingId = tracked?.trackingId ?? null;
    if (trackingId) spec.params.trackingId = trackingId;
    spec.params.raw = buildRawMessage({
      to,
      cc: (preview.cc ?? []).map((email) => ({ email })),
      subject: preview.subject ?? '',
      body: preview.body,
      html: tracked?.html,
      inReplyTo: typeof spec.params.inReplyTo === 'string' ? spec.params.inReplyTo : null,
      references: typeof spec.params.inReplyTo === 'string' ? spec.params.inReplyTo : null,
      headers,
    });
    // Sanity: what is sent is what was approved.
    if (parseRawMessage(String(spec.params.raw)).body.trim() !== preview.body.replace(/\r\n/g, '\n').trim()) throw new PermanentJobError('approval_mismatch');
  }
  const outcome = await performAction(deps, userId, {
    spec,
    target: row!.action.target,
    actor: { type: approval.responsible.type, id: approval.responsible.id, name: approval.responsible.name },
    userInitiated: false,
    approved: true,
    idempotencyKey: `approval:${approvalId}`,
  });
  if (trackingId) {
    // Recover the receipt from the existing audit when bookkeeping retries after
    // an accepted send. The irreversible-action reservation prevents resending.
    const receipt = outcome.result?.undo ?? (outcome.auditId ? (await deps.db.asUser(userId, (tx) => one<{ undo: Record<string, unknown> }>(tx, `select undo from public.audit_events where id = $1::uuid`, [outcome.auditId])))?.undo : null);
    if (!outcome.errorCode && outcome.decision === 'allowed' && receipt?.gmailMessageId) {
      await deps.store.trackerStoreFor(userId).updateEmail(trackingId, { status: 'SENT', gmail_message_id: String(receipt.gmailMessageId), gmail_thread_id: typeof receipt.gmailThreadId === 'string' ? receipt.gmailThreadId : null });
    } else if (outcome.errorCode && outcome.errorCode !== 'action_unconfirmed') {
      await deps.store.trackerStoreFor(userId).updateEmail(trackingId, { status: 'FAILED' });
    }
  }
  await deps.db.asUser(userId, async (tx) => {
    if (outcome.decision === 'allowed' && !outcome.errorCode) {
      await tx.query(`update public.approvals set status = 'executed', executed_at = now(), result_code = 'ok', result_message = $2 where id = $1::uuid`, [approvalId, outcome.result?.summary?.slice(0, 300) ?? 'Done']);
    } else {
      await tx.query(`update public.approvals set status = 'failed', result_code = $2, result_message = $3 where id = $1::uuid`, [approvalId, outcome.errorCode ?? outcome.decision, outcome.reason.slice(0, 300)]);
    }
  });
  if (outcome.errorCode?.startsWith('google_') && /rate_limited|unavailable|network/.test(outcome.errorCode)) {
    await deps.db.asUser(userId, (tx) => tx.query(`update public.approvals set status = 'approved' where id = $1::uuid`, [approvalId]));
    throw Object.assign(new Error(outcome.errorCode), { code: outcome.errorCode });
  }
}
