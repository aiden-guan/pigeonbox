import type { AskApproval } from '@pigeonbox/api-contract';
import type { IntelDeps } from './context.js';
import { APPROVAL_TTL_MS, describeStep, type MailChangePlan } from './mail-changes.js';

/**
 * Permission for Chat's changes, the way Claude asks before running a
 * command. A tool that would change the mailbox does not run: it plans the
 * change and the server seals that plan into the approval token (encrypted,
 * bound to the user, expiring). The client shows the steps with Allow and
 * Deny; Allow sends the token back and exactly the sealed plan is carried
 * out. The model never sees or edits the token, and nothing it writes after
 * proposing can widen what was approved.
 */

export type UnsubscribePlan = { kind: 'unsubscribe'; title: string; senders: Array<{ accountId: string; email: string }>; archive: boolean };
export type ApprovalPlan = MailChangePlan | UnsubscribePlan;

type Sealed = { v: 2; expiresAt: string; plan: ApprovalPlan };

const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)));

export function approvalSteps(plan: ApprovalPlan): AskApproval['steps'] {
  if (plan.kind === 'mail_changes') return plan.steps.map(describeStep);
  const senders = plan.senders.map((sender) => sender.email);
  const groups = Array.from({ length: Math.ceil(senders.length / 5) }, (_, index) => senders.slice(index * 5, index * 5 + 5));
  return [
    ...groups.map((group) => ({ text: `Unsubscribe from ${group.length === 1 ? group[0] : `these ${group.length} mailing lists`}`, count: group.length, examples: group, destructive: true })),
    ...(plan.archive ? [{ text: 'Archive their mail in your inbox and keep new mail from them out of it', examples: [], destructive: false }] : []),
  ];
}

export async function sealApproval(deps: IntelDeps, userId: string, plan: ApprovalPlan): Promise<AskApproval> {
  const steps = approvalSteps(plan);
  if (!steps.length || steps.length > 12) throw new Error('Approval cannot show every planned change.');
  const id = crypto.randomUUID();
  const expiresAt = new Date(deps.now().getTime() + APPROVAL_TTL_MS).toISOString();
  const body: Sealed = { v: 2, expiresAt, plan };
  const sealed = await deps.box.seal(JSON.stringify(body), { purpose: 'ask_approval', userId, recordId: id });
  return { title: plan.title, steps, token: encode(JSON.stringify({ id, ...sealed })), expiresAt };
}

export type OpenedApproval = { ok: true; id: string; plan: ApprovalPlan } | { ok: false; reason: 'expired' | 'invalid' | 'consumed' };

/** The sealed plan, if the token is this user's, untampered and not expired. */
export async function openApproval(deps: IntelDeps, userId: string, token: string): Promise<OpenedApproval> {
  try {
    const { id, keyId, iv, ciphertext } = JSON.parse(decode(token)) as { id: string; keyId: string; iv: string; ciphertext: string };
    const body = JSON.parse(await deps.box.open({ keyId, iv, ciphertext }, { purpose: 'ask_approval', userId, recordId: String(id) })) as Sealed;
    // Old cards could omit expanded steps or some unsubscribe targets.
    if (body.v !== 2 || !body.plan || typeof id !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) return { ok: false, reason: 'invalid' };
    const steps = approvalSteps(body.plan);
    if (!steps.length || steps.length > 12) return { ok: false, reason: 'invalid' };
    if (Date.parse(body.expiresAt) <= deps.now().getTime()) return { ok: false, reason: 'expired' };
    return { ok: true, id, plan: body.plan };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/** Reserve before Allow OR Deny, in a committed transaction, before any effects.
 * A crash may require a fresh proposal; it must never let a retry run twice.
 */
export async function consumeApproval(deps: IntelDeps, userId: string, token: string): Promise<OpenedApproval> {
  const opened = await openApproval(deps, userId, token);
  if (!opened.ok) return opened;
  const rows = await deps.db.asUser(userId, (tx) => tx.query(
    `insert into public.idempotency_keys (user_id, scope, key) values ($1::uuid, 'ask_approval', $2)
     on conflict (user_id, scope, key) do nothing returning key`,
    [userId, opened.id],
  ));
  return rows.length ? opened : { ok: false, reason: 'consumed' };
}
