import type { AskApproval } from '@pigeonbox/api-contract';
import { decodeEncodedWords, headerValue } from '../google/mime.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';
import { gmailFor, requireFeature, type AccountRow } from './google-access.js';
import type { GmailClient } from '../google/gmail.js';

/**
 * Mailbox changes Chat proposes and the user approves: labels, archiving,
 * read state, stars and Trash. Planning resolves every target to concrete
 * Gmail thread IDs and label names up front, so the approval card shows
 * exactly what will happen and Allow carries out that and nothing more.
 * Nothing is ever deleted for good: "delete" moves threads to Trash, and
 * deleting a label leaves its emails in place.
 */

export const CHANGE_OPS = ['create_label', 'rename_label', 'delete_label', 'add_label', 'remove_label', 'archive', 'move_to_inbox', 'mark_read', 'mark_unread', 'star', 'unstar', 'trash', 'restore'] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

const LABEL_OPS: ReadonlySet<ChangeOp> = new Set(['create_label', 'rename_label', 'delete_label']);
const NEEDS_LABEL: ReadonlySet<ChangeOp> = new Set(['create_label', 'rename_label', 'delete_label', 'add_label', 'remove_label']);
/** Threads one step may touch. A larger match is cut to its newest threads and says so. */
export const MAX_STEP_THREADS = 500;
/** Thread changes in one approval, across steps: each is a Gmail call. */
export const MAX_PLAN_THREAD_CHANGES = 800;
export const APPROVAL_TTL_MS = 30 * 60_000;

/** System labels a step may name. Their IDs are fixed; they cannot be created, renamed or deleted. */
const SYSTEM_LABELS: Record<string, string> = { inbox: 'INBOX', starred: 'STARRED', important: 'IMPORTANT', unread: 'UNREAD', spam: 'SPAM', trash: 'TRASH', sent: 'SENT' };

/** A step as the model proposes it. */
export type ChangeStepInput = {
  action: string;
  label?: string;
  new_name?: string;
  threads?: string[];
  query?: string;
  exclude_threads?: string[];
};

export type PlannedStep = {
  op: ChangeOp;
  label?: string;
  newName?: string;
  threadIds: string[];
  /** Matches beyond the cap, which this step leaves alone. */
  beyond: number;
  examples: string[];
};

export type MailChangePlan = { kind: 'mail_changes'; accountId: string; accountEmail: string; title: string; steps: PlannedStep[] };

export type ThreadRef = { accountId: string; gmailThreadId: string; title?: string };

export class ChangePlanError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'ChangePlanError';
  }
}

const quote = (value: string) => `“${value}”`;
const threads = (count: number) => `${count} ${count === 1 ? 'thread' : 'threads'}`;

/** How a step reads on the approval card. */
export function describeStep(step: PlannedStep): AskApproval['steps'][number] {
  const n = step.threadIds.length;
  const more = step.beyond ? ` (the newest ${n}; ${step.beyond} more matched and stay as they are)` : '';
  const label = quote(step.label ?? '');
  const text = (() => {
    switch (step.op) {
      case 'create_label': return `Create the label ${label}`;
      case 'rename_label': return `Rename the label ${label} to ${quote(step.newName ?? '')}`;
      case 'delete_label': return `Delete the label ${label}. Its emails stay in your mailbox.`;
      case 'add_label': return `Add the label ${label} to ${threads(n)}${more}`;
      case 'remove_label': return `Remove the label ${label} from ${threads(n)}${more}`;
      case 'archive': return `Archive ${threads(n)}${more}`;
      case 'move_to_inbox': return `Move ${threads(n)} to the inbox${more}`;
      case 'mark_read': return `Mark ${threads(n)} as read${more}`;
      case 'mark_unread': return `Mark ${threads(n)} as unread${more}`;
      case 'star': return `Star ${threads(n)}${more}`;
      case 'unstar': return `Unstar ${threads(n)}${more}`;
      case 'trash': return `Move ${threads(n)} to Trash${more}. Gmail deletes them for good after 30 days.`;
      case 'restore': return `Restore ${threads(n)} from Trash${more}`;
    }
  })();
  return {
    text: text.slice(0, 300),
    ...(LABEL_OPS.has(step.op) ? {} : { count: n }),
    examples: step.examples.slice(0, 5).map((title) => title.slice(0, 200)),
    destructive: step.op === 'trash' || step.op === 'delete_label',
  };
}

async function threadSubject(gmail: GmailClient, id: string): Promise<string | null> {
  const thread = await gmail.getThread(id, 'metadata').catch(() => null);
  const first = thread?.messages?.[0];
  return first ? decodeEncodedWords(headerValue(first.payload?.headers, 'Subject') ?? '') || '(no subject)' : null;
}

/** Every thread matching a Gmail query, newest first, up to `limit`, plus how many more there were. */
async function threadsMatching(gmail: GmailClient, query: string, limit: number): Promise<{ ids: string[]; beyond: number }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let estimate = 0;
  for (let page = 0; page < 10; page += 1) {
    const result = await gmail.listThreads({ q: query, maxResults: 500, ...(pageToken ? { pageToken } : {}) });
    estimate = Math.max(estimate, result.resultSizeEstimate ?? 0);
    for (const thread of result.threads ?? []) if (!ids.includes(thread.id)) ids.push(thread.id);
    pageToken = result.nextPageToken;
    if (!pageToken || ids.length > limit) break;
  }
  const kept = ids.slice(0, limit);
  return { ids: kept, beyond: Math.max(ids.length, pageToken ? estimate : ids.length) - kept.length };
}

/**
 * Resolve the model's proposal into a concrete plan for one inbox. Throws
 * ChangePlanError with what the model must fix (an unknown label, a reference
 * from another inbox, no matching threads).
 */
export async function planMailChanges(
  deps: IntelDeps,
  input: { account: AccountRow; title: string; steps: ChangeStepInput[]; resolve: (reference: string) => ThreadRef | null; titleOf: (gmailThreadId: string) => string | undefined },
): Promise<MailChangePlan> {
  const { account } = input;
  const problems: string[] = [];
  if (!account.features.includes('organize'))
    throw new ChangePlanError([`PigeonBox is not allowed to organize ${account.email} yet. The user can allow it in the PigeonBox dashboard: Connected accounts, Add permissions, Organize mail. Then ask again.`]);
  requireFeature(account, 'organize');
  if (!input.steps.length) throw new ChangePlanError(['steps is empty.']);
  const gmail = gmailFor(deps, account);
  const existing = new Map(((await gmail.listLabels()).labels ?? []).filter((label) => label.type !== 'system').map((label) => [label.name.toLowerCase(), label.name]));
  /** Labels as they will be when each step runs: created, renamed and deleted by earlier steps. */
  const labels = new Map(existing);
  const steps: PlannedStep[] = [];
  let changes = 0;

  for (const [index, raw] of input.steps.entries()) {
    const at = `Step ${index + 1}`;
    const op = CHANGE_OPS.find((candidate) => candidate === raw.action);
    if (!op) { problems.push(`${at}: unknown action "${String(raw.action).slice(0, 40)}".`); continue; }
    const name = (raw.label ?? '').trim().replace(/\s+/g, ' ').slice(0, 225);
    const system = SYSTEM_LABELS[name.toLowerCase()];
    if (NEEDS_LABEL.has(op) && !name) { problems.push(`${at} (${op}) needs a label.`); continue; }
    if (system && (LABEL_OPS.has(op) || op === 'add_label' || op === 'remove_label')) { problems.push(`${at}: "${name}" is a Gmail system label; use archive, move_to_inbox, star, mark_read or trash instead.`); continue; }
    const known = labels.get(name.toLowerCase());

    if (op === 'create_label') {
      if (!known) { labels.set(name.toLowerCase(), name); steps.push({ op, label: name, threadIds: [], beyond: 0, examples: [] }); }
      continue;
    }
    if (op === 'rename_label' || op === 'delete_label') {
      if (!known) { problems.push(`${at}: there is no label "${name}" in ${account.email}. Labels: ${[...labels.values()].slice(0, 40).join(', ') || '(none)'}.`); continue; }
      if (op === 'rename_label') {
        const newName = (raw.new_name ?? '').trim().replace(/\s+/g, ' ').slice(0, 225);
        if (!newName) { problems.push(`${at}: rename_label needs new_name.`); continue; }
        labels.delete(known.toLowerCase());
        labels.set(newName.toLowerCase(), newName);
        steps.push({ op, label: known, newName, threadIds: [], beyond: 0, examples: [] });
      } else {
        labels.delete(known.toLowerCase());
        steps.push({ op, label: known, threadIds: [], beyond: 0, examples: [] });
      }
      continue;
    }

    // Thread changes: resolve references and the query to IDs in this inbox.
    if (op === 'remove_label' && !known) { problems.push(`${at}: there is no label "${name}" in ${account.email}.`); continue; }
    const ids: string[] = [];
    for (const reference of raw.threads ?? []) {
      const ref = input.resolve(reference);
      if (!ref) { problems.push(`${at}: unknown thread reference "${reference.slice(0, 40)}"; use source labels from tool results.`); continue; }
      if (ref.accountId !== account.id) { problems.push(`${at}: ${reference} is in another inbox; propose changes for one inbox at a time.`); continue; }
      if (!ids.includes(ref.gmailThreadId)) ids.push(ref.gmailThreadId);
    }
    let beyond = 0;
    const query = (raw.query ?? '').trim().slice(0, 500);
    if (query) {
      const found = await threadsMatching(gmail, query, MAX_STEP_THREADS);
      for (const id of found.ids) if (!ids.includes(id)) ids.push(id);
      beyond = found.beyond;
    }
    const excluded = new Set((raw.exclude_threads ?? []).map((reference) => input.resolve(reference)?.gmailThreadId).filter(Boolean));
    const kept = ids.filter((id) => !excluded.has(id)).slice(0, MAX_STEP_THREADS);
    beyond += Math.max(0, ids.filter((id) => !excluded.has(id)).length - kept.length);
    if (!query && !(raw.threads ?? []).length) { problems.push(`${at} (${op}) needs threads or a query.`); continue; }
    if (!kept.length) { problems.push(`${at} (${op}): no threads matched${query ? ` the query ${query}` : ''}${excluded.size ? ' after exclusions' : ''}.`); continue; }
    changes += kept.length;
    if (op === 'add_label' && !known) {
      // Adding a label that does not exist yet: creating it is part of the change, and shown.
      labels.set(name.toLowerCase(), name);
      steps.push({ op: 'create_label', label: name, threadIds: [], beyond: 0, examples: [] });
    }
    steps.push({ op, ...(name ? { label: labels.get(name.toLowerCase()) ?? name } : {}), threadIds: kept, beyond, examples: [] });
  }
  if (changes > MAX_PLAN_THREAD_CHANGES) problems.push(`These steps change ${changes} threads; one approval can change at most ${MAX_PLAN_THREAD_CHANGES}. Split the work, starting with the most important part.`);
  // Creating a missing label adds a step. Count the expanded plan, so no
  // operation can fall beyond the approval card's twelve visible steps.
  if (steps.length > 12) problems.push('One approval can show at most 12 steps, including creating missing labels. Split these changes into smaller proposals.');
  if (problems.length) throw new ChangePlanError(problems);
  if (!steps.length) throw new ChangePlanError(['Nothing to change: every label already exists as proposed.']);

  // A few subjects per step so the user can tell they are the right threads.
  await Promise.all(steps.map(async (step) => {
    const sample = step.threadIds.slice(0, 3);
    step.examples = (await Promise.all(sample.map(async (id) => input.titleOf(id) ?? (await threadSubject(gmail, id))))).filter((title): title is string => Boolean(title));
  }));
  return { kind: 'mail_changes', accountId: account.id, accountEmail: account.email, title: input.title.trim().slice(0, 200) || 'Change your mailbox', steps };
}

export type StepOutcome = { step: string; changed: number; failed: number; note?: string };

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++]!);
  }));
}

/** Carry out an approved plan, step by step, and log each step in the audit trail. */
export async function applyMailChanges(deps: IntelDeps, userId: string, plan: MailChangePlan, input: { account: AccountRow; requestId: string }): Promise<StepOutcome[]> {
  requireFeature(input.account, 'organize');
  const gmail = gmailFor(deps, input.account);
  const ids = new Map(((await gmail.listLabels()).labels ?? []).map((label) => [label.name.toLowerCase(), label.id]));
  for (const [name, id] of Object.entries(SYSTEM_LABELS)) ids.set(name, id);
  const outcomes: StepOutcome[] = [];

  for (const step of plan.steps) {
    const text = describeStep(step).text;
    const key = (step.label ?? '').toLowerCase();
    let changed = 0;
    let failed = 0;
    let note: string | undefined;
    try {
      switch (step.op) {
        case 'create_label': {
          if (!ids.has(key)) ids.set(key, (await gmail.createLabel(step.label!)).id);
          changed = 1;
          break;
        }
        case 'rename_label': {
          const id = ids.get(key);
          if (!id) { note = 'The label no longer exists.'; break; }
          await gmail.renameLabel(id, step.newName!);
          ids.delete(key);
          ids.set(step.newName!.toLowerCase(), id);
          changed = 1;
          break;
        }
        case 'delete_label': {
          const id = ids.get(key);
          if (!id) { note = 'The label was already gone.'; break; }
          await gmail.deleteLabel(id);
          ids.delete(key);
          changed = 1;
          break;
        }
        default: {
          const change = await (async (): Promise<((id: string) => Promise<unknown>) | null> => {
            const modify = (add: string[], remove: string[]) => (id: string) => gmail.modifyThread(id, { addLabelIds: add, removeLabelIds: remove });
            switch (step.op) {
              case 'add_label': {
                const id = ids.get(key) ?? (await gmail.createLabel(step.label!)).id;
                ids.set(key, id);
                return modify([id], []);
              }
              case 'remove_label': {
                const id = ids.get(key);
                return id ? modify([], [id]) : null;
              }
              case 'archive': return modify([], ['INBOX']);
              case 'move_to_inbox': return modify(['INBOX'], []);
              case 'mark_read': return modify([], ['UNREAD']);
              case 'mark_unread': return modify(['UNREAD'], []);
              case 'star': return modify(['STARRED'], []);
              case 'unstar': return modify([], ['STARRED']);
              case 'trash': return (id) => gmail.trashThread(id);
              case 'restore': return (id) => gmail.untrashThread(id);
              default: return null;
            }
          })();
          if (!change) { note = 'The label no longer exists.'; break; }
          await mapLimit(step.threadIds, 8, async (id) => {
            try {
              await change(id);
              changed += 1;
            } catch {
              failed += 1;
            }
          });
        }
      }
    } catch (error) {
      failed = Math.max(1, step.threadIds.length - changed);
      note = error instanceof Error && 'code' in error ? `Gmail refused (${String((error as { code: unknown }).code)}).` : 'Gmail could not be reached.';
    }
    outcomes.push({ step: text, changed, failed, ...(note ? { note } : {}) });
    if (changed) {
      await deps.db.asUser(userId, (tx) => recordAudit(tx, {
        userId,
        actor: { type: 'user', id: null, name: 'Chat' },
        action: `chat_${step.op}`,
        tier: 1,
        target: LABEL_OPS.has(step.op) ? { kind: 'label', id: (step.label ?? '').slice(0, 256), title: step.label ?? null } : { kind: 'threads', id: `${step.threadIds.length}:${step.threadIds[0] ?? ''}`.slice(0, 256), title: step.examples[0] ?? null },
        summary: `${text}${failed ? ` (${failed} failed)` : ''}`.slice(0, 500),
        policy: { decision: 'allowed', reason: 'Approved by the user in Chat' },
        reversible: step.op !== 'delete_label',
        undo: null,
        accountId: input.account.id,
        idempotencyKey: `chat:${input.requestId}:${outcomes.length}`.slice(0, 200),
      })).catch(() => deps.log('warn', 'chat change not audited', { requestId: input.requestId, operation: step.op }));
    }
  }
  deps.log('info', 'chat changes applied', { requestId: input.requestId, userId, accountId: input.account.id, count: outcomes.reduce((sum, item) => sum + item.changed, 0), event: outcomes.some((item) => item.failed) ? 'partial' : 'complete' });
  return outcomes;
}
