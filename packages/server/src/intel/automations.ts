import { FilterSpecSchema, type ActionSpec, type Automation, type FilterSpec, type RiskTier } from '@pigeonbox/api-contract';
import { focusScore, focusSectionFor, type ThreadState } from '@pigeonbox/shared';
import { InferenceError } from '../ai/backends.js';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import { enqueue, type JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { replySubject } from '../google/mime.js';
import { performAction } from './actions.js';
import { BudgetExceededError, runStructured } from './ai.js';
import { createApproval } from './approvals.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';
import { nextCronRun, parseCron } from './cron.js';
import { prepareDraft, replyAddressing } from './drafts.js';
import { loadAccount } from './google-access.js';
import { notify } from './notifications.js';
import { actionTier, ACTION_LABELS, type Autonomy } from './policy.js';
import { loadPreferences } from './preferences.js';
import { matchPrompt, MatchOutputSchema } from './prompts.js';
import { compileView, explainFilter, type CompiledView } from './rule-compiler.js';
import { compileViewWithAi, matchDeterministic, THREAD_CONTEXT, type ThreadContext } from './rules.js';
import { decryptSummary } from './threads.js';

/**
 * Natural-language automations: trigger → conditions → context → actions,
 * under an autonomy policy, with a run history. New automations start in
 * Shadow Mode. Every action goes through `performAction`, so an automation can
 * never do more than the autonomy ladder allows.
 */

type Trigger = Automation['trigger'];

const NUMBER: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };
const num2 = (value: string | undefined, fallback: number) => (value ? (/^\d+$/.test(value) ? Number(value) : NUMBER[value.toLowerCase()] ?? fallback) : fallback);

function runsAutomatically(tier: RiskTier, autonomy: Autonomy): boolean {
  if (tier === 0) return true;
  if (tier === 1) return autonomy !== 'suggest';
  if (tier === 2) return autonomy === 'auto_draft';
  return false;
}

export function tiersFor(actions: ActionSpec[], autonomy: Autonomy) {
  return actions.map((action) => {
    const tier = actionTier(action);
    return { kind: action.kind, tier, runsAutomatically: runsAutomatically(tier, autonomy) };
  });
}

type ParsedTrigger = {
  trigger: Trigger;
  schedule: { cron: string; timeZone: string } | null;
  /** The part of the (lower-cased) prompt that described the trigger, removed before compiling conditions. */
  span: [number, number] | null;
  /** "When Lee replies": where the person named in the trigger is, to become a sender condition. */
  person: [number, number] | null;
};

const spanOf = (match: RegExpMatchArray): [number, number] => [match.index!, match.index! + match[0].length];
const SOMEONE = new Set(['they', 'someone', 'anyone', 'a contact', 'somebody', 'anybody']);

function parseTrigger(lower: string): ParsedTrigger {
  const none = { schedule: null, span: null, person: null };
  const day = lower.match(/every (weekday|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: (morning|afternoon|evening))?(?: at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/);
  if (day) {
    let hour = day[3] ? (Number(day[3]) % 12) + (day[5] === 'pm' ? 12 : 0) : day[2] === 'afternoon' ? 13 : day[2] === 'evening' ? 17 : 8;
    if (day[3] && !day[5] && Number(day[3]) >= 12) hour = Number(day[3]);
    const weekdays = day[1] === 'weekday' ? '1-5' : day[1] === 'day' ? '*' : String(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(day[1]!));
    return { ...none, trigger: { kind: 'schedule', params: {} }, schedule: { cron: `${Number(day[4] ?? 0)} ${hour} * * ${weekdays}`, timeZone: 'UTC' }, span: spanOf(day) };
  }
  const unanswered = lower.match(/(?:gone |been |is |are )?(?:unanswered|without (?:a )?reply|no reply)(?: for)? ([\w]+) (business )?days?/);
  if (unanswered) return { ...none, trigger: { kind: 'no_reply_by', params: { businessDays: num2(unanswered[1], 4) } }, schedule: { cron: '0 * * * *', timeZone: 'UTC' }, span: spanOf(unanswered) };
  const before = lower.match(/(\d+) minutes? before (?:a |my |each )?(?:meeting|call|event)/);
  if (before || /before (?:a |my |each )?(?:meeting|call)/.test(lower)) return { ...none, trigger: { kind: 'calendar_approaching', params: { minutesBefore: Number(before?.[1] ?? 30) } } };
  if (/\b(opens?|clicks?|views?)\b.*\b(email|message|link|proposal)\b|\bwhen (?:they|someone) (?:opens?|clicks?)/.test(lower)) return { ...none, trigger: { kind: 'tracking_event', params: {} } };
  const reply = lower.match(/\bwhen (a contact|[a-z]+(?: [a-z]+)?) repl(?:y|ies)(?: to (?:me|my [a-z-]+))?|\breply received\b|\bgets? a reply\b/);
  if (reply) {
    const who = reply[1] && !SOMEONE.has(reply[1]) ? reply.index! + reply[0].indexOf(reply[1], 5) : -1;
    return { ...none, trigger: { kind: 'reply_received', params: {} }, span: spanOf(reply), person: who >= 0 ? [who, who + reply[1]!.length] : null };
  }
  if (/when i send|after i send|i email someone/.test(lower)) return { ...none, trigger: { kind: 'email_sent', params: {} } };
  if (/when i (?:receive|get)|sends? me|(?:emails?|writes? to|messages?|contacts?) me\b|if (?:a|an|someone|anyone)|when (?:a|an) .* (?:arrives|comes in)|\bemails? (?:from|about)\b/.test(lower)) return { ...none, trigger: { kind: 'email_received', params: {} } };
  return { ...none, trigger: { kind: 'manual', params: {} } };
}

function parseActions(lower: string): ActionSpec[] {
  const actions: ActionSpec[] = [];
  if (/mark (?:it |them )?(?:as )?important/.test(lower)) actions.push({ kind: 'mark_important', params: {} });
  const label = lower.match(/label (?:it |them )?(?:as |with )?["“]?([\w\s/-]{2,40}?)["”]?(?:$|[,.]| and)/);
  if (label) actions.push({ kind: 'label', params: { label: label[1]!.trim().replace(/\b\w/g, (c) => c.toUpperCase()) } });
  if (/review queue/.test(lower)) actions.push({ kind: 'label', params: { label: 'Review' } });
  if (/\barchive\b/.test(lower)) actions.push({ kind: 'archive', params: {} });
  if (/\bstar\b/.test(lower)) actions.push({ kind: 'star', params: {} });
  if (/(?:create|add|make) (?:a )?(?:todo|to-do|task)/.test(lower)) actions.push({ kind: 'create_task', params: {} });
  if (/(?:prepare|draft|write) (?:a )?follow[- ]?up/.test(lower)) actions.push({ kind: 'draft_follow_up', params: {} });
  else if (/(?:prepare|draft|write) (?:a )?(?:reply|response)/.test(lower)) actions.push({ kind: 'draft_reply', params: {} });
  if (/remind me/.test(lower)) actions.push({ kind: 'remind', params: { businessDays: 1 } });
  if (/(?:give|send|show) me (?:the )?(\w+)? ?threads?|notify me|tell me|let me know|alert me/.test(lower)) {
    const count = lower.match(/(?:give|send|show) me (?:the )?(\w+) threads?/);
    actions.push({ kind: 'notify', params: count ? { digest: num2(count[1], 5) } : {} });
  }
  if (/\bsnooze\b/.test(lower)) actions.push({ kind: 'snooze', params: { businessDays: 1 } });
  if (/\bsend\b(?! me)/.test(lower) && !/sends? me/.test(lower)) actions.push({ kind: 'send_email', params: {} });
  return actions.slice(0, 8);
}

/**
 * Conditions: the part of the request that describes which mail, without the trigger and action
 * phrases. Taken from the original text so names ("Maya") can resolve to contacts.
 */
export function automationConditionText(prompt: string): string {
  const original = prompt.trim();
  const { span, person } = parseTrigger(original.toLowerCase());
  const rest = span ? `${original.slice(0, span[0])} ${original.slice(span[1])}` : original;
  const conditionText = rest
    .replace(/\b(mark|label|archive|create|add|prepare|draft|write|remind|notify|tell|give|show|snooze|send)\b.*$/i, '')
    .replace(/^[\s,.;:]+|[\s,.;:]+$/g, '')
    .trim();
  return person ? `from ${original.slice(person[0], person[1])} ${conditionText}`.trim() : conditionText;
}

/** `conditionsView` replaces the deterministic compile of the conditions (see compileAutomationWithAi). */
export function compileAutomation(prompt: string, timeZone: string, contacts: Array<{ email: string; name: string | null }> = [], conditionsView?: CompiledView | null) {
  const original = prompt.trim();
  const lower = original.toLowerCase();
  const { trigger, schedule } = parseTrigger(lower);
  const actions = parseActions(lower);
  const warnings: string[] = [];
  const conditionText = automationConditionText(original);
  const view = conditionsView !== undefined ? conditionsView : conditionText.length > 3 ? compileView(conditionText, contacts) : null;
  let conditions: FilterSpec = view?.filter ?? FilterSpecSchema.parse({});
  if (trigger.kind === 'no_reply_by') conditions = { ...conditions, direction: 'outbound', noReplyForBusinessDays: Number(trigger.params.businessDays ?? 4), states: [] };
  if (trigger.kind === 'email_received' && !conditions.states.length) conditions = { ...conditions, direction: 'inbound' };
  // Only the leading words of a digest request are conditions ("threads most likely to need my attention").
  if (actions.some((action) => action.kind === 'notify' && action.params.digest)) conditions = FilterSpecSchema.parse({});
  const existing = /existing contact|people i know|someone i know/.test(lower);
  if (existing) conditions = { ...conditions, relationship: ['known', 'close', 'vip'] };
  if (!actions.length) {
    warnings.push('No action recognized. Add what PigeonBox should do, such as "label it", "create a task" or "prepare a reply".');
    actions.push({ kind: 'notify', params: {} });
  }
  if (actions.some((action) => action.kind === 'send_email')) warnings.push('Sending always needs your approval for each email; PigeonBox never sends on its own.');
  const autonomy: Autonomy = actions.some((action) => actionTier(action) === 2) ? 'auto_draft' : 'auto_reversible';
  const context: Automation['context'] = ['thread'];
  if (/meeting|calendar|free|availability/.test(lower)) context.push('calendar');
  if (/contact|relationship|who/.test(lower)) context.push('contacts');
  const scheduleWithTz = schedule ? { cron: schedule.cron, timeZone } : null;
  const explanation = [
    `When: ${describeTrigger(trigger, scheduleWithTz)}`,
    ...explainFilter(conditions).map((line) => `If: ${line}`),
    ...actions.map((action) => `Then: ${ACTION_LABELS[action.kind]}${action.params.label ? ` "${action.params.label}"` : ''}`),
  ];
  if (view?.warnings.length) warnings.push(...view.warnings.filter((warning) => !/Shadow Mode/.test(warning)));
  warnings.push('New automations start in Shadow Mode: they record what they would do until you turn them on.');
  return {
    name: (view?.name && view.name !== 'Smart View' ? view.name : prompt.split(/[,.]/)[0]!.slice(0, 60)) || 'Automation',
    trigger,
    conditions,
    context,
    actions,
    autonomy,
    schedule: scheduleWithTz,
    explanation: explanation.slice(0, 20).map((line) => line.slice(0, 200)),
    tiers: tiersFor(actions, autonomy),
    warnings: warnings.slice(0, 8).map((line) => line.slice(0, 200)),
    confidence: view ? view.confidence : 0.6,
  };
}

/**
 * The trigger and actions are parsed as above; the conditions ("from allen", "about the
 * lease") are read by the AI view compiler, which falls back to the deterministic one.
 * Digests ignore conditions, so they skip the model call.
 */
export async function compileAutomationWithAi(deps: IntelDeps, userId: string, prompt: string, timeZone: string, contacts: Array<{ email: string; name: string | null }>, requestId: string) {
  const conditionText = automationConditionText(prompt);
  const digest = parseActions(prompt.trim().toLowerCase()).some((action) => action.kind === 'notify' && action.params.digest);
  const view = conditionText.length > 3 && !digest ? await compileViewWithAi(deps, userId, conditionText, contacts, requestId) : null;
  return compileAutomation(prompt, timeZone, contacts, view);
}

export function describeTrigger(trigger: Trigger, schedule: { cron: string; timeZone: string } | null): string {
  switch (trigger.kind) {
    case 'email_received':
      return 'an email arrives';
    case 'email_sent':
      return 'you send an email';
    case 'reply_received':
      return 'someone replies';
    case 'no_reply_by':
      return `an email you sent has no reply after ${trigger.params.businessDays ?? 4} business days`;
    case 'tracking_event':
      return 'a tracked email shows likely recipient activity';
    case 'state_changed':
      return 'a thread changes state';
    case 'calendar_approaching':
      return `${trigger.params.minutesBefore ?? 30} minutes before a meeting`;
    case 'schedule':
      return schedule ? `on schedule (${schedule.cron}, ${schedule.timeZone})` : 'on a schedule';
    default:
      return 'you run it';
  }
}

type AutomationRow = {
  id: string;
  name: string;
  prompt: string;
  trigger_kind: Trigger['kind'];
  trigger_params: Trigger['params'];
  conditions: FilterSpec;
  context: Automation['context'];
  actions: ActionSpec[];
  autonomy: Autonomy;
  schedule_cron: string | null;
  schedule_tz: string | null;
  next_run_at: unknown;
  mode: 'shadow' | 'active';
  enabled: boolean;
  version: number;
  explanation: string[];
  runs: number;
  failures: number;
  last_run_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name.slice(0, 120),
    prompt: row.prompt.slice(0, 1_000),
    trigger: { kind: row.trigger_kind, params: row.trigger_params ?? {} },
    conditions: row.conditions,
    context: row.context,
    actions: row.actions,
    autonomy: row.autonomy,
    schedule: row.schedule_cron ? { cron: row.schedule_cron, timeZone: row.schedule_tz ?? 'UTC' } : null,
    mode: row.mode,
    enabled: row.enabled,
    version: num(row.version),
    explanation: row.explanation.slice(0, 20),
    tiers: tiersFor(row.actions, row.autonomy),
    stats: { runs: num(row.runs), lastRunAt: isoOrNull(row.last_run_at), failures: num(row.failures) },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function listAutomations(tx: SqlExecutor): Promise<Automation[]> {
  return (await tx.query<AutomationRow>(`select * from public.automation_rules order by created_at`)).map(toAutomation);
}

export async function saveAutomation(
  deps: IntelDeps,
  tx: SqlExecutor,
  userId: string,
  input: { id?: string; name: string; prompt: string; trigger: Trigger; conditions: FilterSpec; context: Automation['context']; actions: ActionSpec[]; autonomy: Autonomy; schedule: { cron: string; timeZone: string } | null; mode: 'shadow' | 'active'; enabled: boolean },
): Promise<Automation> {
  if (input.schedule && !parseCron(input.schedule.cron)) throw new ApiError('invalid_request', 'Schedules support "minute hour * * weekday" (for example "0 8 * * 1-5").');
  const nextRun = input.schedule ? nextCronRun(input.schedule.cron, input.schedule.timeZone, deps.now()) : null;
  const explanation = [
    `When: ${describeTrigger(input.trigger, input.schedule)}`,
    ...explainFilter(input.conditions).map((line) => `If: ${line}`),
    ...input.actions.map((action) => `Then: ${ACTION_LABELS[action.kind]}`),
  ].slice(0, 20);
  let row: AutomationRow | null;
  if (input.id) {
    const current = await one<AutomationRow>(tx, `select * from public.automation_rules where id = $1::uuid`, [input.id]);
    if (!current) throw new ApiError('not_found', 'That automation does not exist.');
    const logicChanged = JSON.stringify([current.conditions, current.actions, current.trigger_kind, current.trigger_params, current.autonomy]) !== JSON.stringify([input.conditions, input.actions, input.trigger.kind, input.trigger.params, input.autonomy]);
    // Changing what an active automation does sends it back to Shadow Mode.
    const mode = logicChanged && current.mode === 'active' ? 'shadow' : input.mode;
    row = await one<AutomationRow>(
      tx,
      `update public.automation_rules set name = $2, prompt = $3, trigger_kind = $4, trigger_params = $5::jsonb, conditions = $6::jsonb, context = $7::text[], actions = $8::jsonb,
          autonomy = $9, schedule_cron = $10, schedule_tz = $11, next_run_at = $12::timestamptz, mode = $13, enabled = $14, version = version + 1, explanation = $15::text[], updated_at = now()
        where id = $1::uuid returning *`,
      [input.id, input.name, input.prompt, input.trigger.kind, input.trigger.params, input.conditions, input.context, JSON.stringify(input.actions), input.autonomy, input.schedule?.cron ?? null, input.schedule?.timeZone ?? null, nextRun, mode, input.enabled, explanation],
    );
  } else {
    row = await one<AutomationRow>(
      tx,
      `insert into public.automation_rules (user_id, name, prompt, trigger_kind, trigger_params, conditions, context, actions, autonomy, schedule_cron, schedule_tz, next_run_at, mode, enabled, explanation)
       values ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[], $8::jsonb, $9, $10, $11, $12::timestamptz, 'shadow', $13, $14::text[]) returning *`,
      [userId, input.name, input.prompt, input.trigger.kind, input.trigger.params, input.conditions, input.context, JSON.stringify(input.actions), input.autonomy, input.schedule?.cron ?? null, input.schedule?.timeZone ?? null, nextRun, input.enabled, explanation],
    );
  }
  await recordAudit(tx, {
    userId,
    actor: { type: 'user', id: userId, name: 'You' },
    action: input.id ? 'update_automation' : 'create_automation',
    tier: 0,
    target: { kind: 'automation', id: row!.id, title: row!.name },
    summary: `${input.id ? 'Updated' : 'Created'} automation "${row!.name}" (${row!.mode})`,
    policy: { decision: 'allowed', reason: 'Configuration change' },
  });
  return toAutomation(row!);
}

export async function deleteAutomation(tx: SqlExecutor, userId: string, id: string): Promise<void> {
  const row = await one<{ name: string }>(tx, `delete from public.automation_rules where id = $1::uuid returning name`, [id]);
  if (!row) throw new ApiError('not_found', 'That automation does not exist.');
  await recordAudit(tx, {
    userId,
    actor: { type: 'user', id: userId, name: 'You' },
    action: 'delete_automation',
    tier: 0,
    target: { kind: 'automation', id, title: row.name },
    summary: `Deleted automation "${row.name}"`,
    policy: { decision: 'allowed', reason: 'Configuration change' },
  });
}

type RunOutcome = { kind: ActionSpec['kind']; tier: RiskTier; outcome: 'applied' | 'shadowed' | 'approval_requested' | 'skipped' | 'failed' | 'undone'; auditId: string | null; approvalId: string | null; detail: string };

async function conditionsMatch(deps: IntelDeps, userId: string, automation: AutomationRow, thread: ThreadContext, requestId: string): Promise<string[] | null> {
  const prefs = await deps.db.asUser(userId, (tx) => loadPreferences(tx, userId));
  const summary = (await decryptSummary(deps.box, userId, thread))?.oneLine ?? '';
  const why = matchDeterministic(automation.conditions, thread, { summary, now: deps.now(), timeZone: prefs.timeZone, workdays: prefs.workdays });
  if (!why || !automation.conditions.aiCriteria) return why;
  try {
    const prompt = matchPrompt(automation.conditions.aiCriteria, { subject: thread.subject, summary, from: thread.sender ?? '' });
    // Standard, not Flex: the run row is already recorded, so a capacity miss could not be retried and the automation would silently not fire.
    const run = await runStructured(deps, { userId, operation: 'automation_compile', system: prompt.system, user: prompt.user, schema: MatchOutputSchema, maxTokens: 120, tier: 'standard', requestId });
    return run.value.matches ? [...why, `AI: ${run.value.reason || 'matches'}`] : null;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof InferenceError) return null;
    throw error;
  }
}

/** Top-N digest for "every morning, give me the five threads most likely to need my attention". */
async function digest(deps: IntelDeps, userId: string, size: number, automation: AutomationRow, key: string): Promise<string> {
  return deps.db.asUser(userId, async (tx) => {
    const rows = await tx.query<{ gmail_thread_id: string; subject: string; state: ThreadState; priority: 'HIGH' | 'NORMAL' | 'LOW'; deadline_at: unknown; last_message_at: unknown }>(
      `select t.gmail_thread_id, t.subject, coalesce(s.user_state, s.state) as state, s.priority, s.deadline_at, t.last_message_at
         from public.threads t join public.thread_states s on s.thread_id = t.id where t.last_message_at > $1::timestamptz limit 500`,
      [new Date(deps.now().getTime() - 30 * 86_400_000)],
    );
    const ranked = rows
      .map((row) => {
        const candidate = { state: row.state, priority: row.priority, deadlineAt: isoOrNull(row.deadline_at), lastMessageAt: iso(row.last_message_at ?? deps.now()) };
        return { row, section: focusSectionFor(candidate, deps.now()), score: focusScore(candidate, deps.now()).score };
      })
      .filter((entry) => entry.section && entry.section !== 'fyi')
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(10, size));
    await notify(tx, {
      userId,
      kind: 'briefing',
      title: `${automation.name}: ${ranked.length} thread${ranked.length === 1 ? '' : 's'}`,
      body: ranked.length ? ranked.map((entry, index) => `${index + 1}. ${entry.row.subject || '(no subject)'}`).join('\n').slice(0, 500) : 'Nothing needs your attention right now.',
      dedupeKey: `digest:${key}`,
    });
    return `Sent a digest of ${ranked.length} thread${ranked.length === 1 ? '' : 's'}`;
  });
}

/**
 * The email an automation asks to send: a grounded reply (or follow-up) to
 * the thread, addressed like a normal reply. Placeholders stay in; the user
 * must resolve them before the approval can be accepted.
 */
async function emailToApprove(deps: IntelDeps, userId: string, thread: ThreadContext, trigger: Trigger['kind'], intent: string, requestId: string): Promise<{ email: { to: string[]; cc: string[]; inReplyTo: string | null; subject: string; body: string } } | { skip: string }> {
  const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, thread.mail_account_id));
  if (!account || account.status !== 'active') return { skip: 'Reconnect this Google account first' };
  // Don't ask for an approval that could never be carried out.
  if (!account.features.includes('send')) return { skip: 'Sending is not turned on for this Google account' };
  const kind = trigger === 'no_reply_by' ? 'follow_up' : 'reply';
  try {
    // The user's own automation wording says what the email is for (it is the user's instruction, not mail content).
    // Standard for the same reason as conditionsMatch: this run cannot retry a Flex capacity miss.
    const draft = await prepareDraft(deps, userId, { threadRowId: thread.id, kind, origin: 'automation', instructions: `Automation the user set up: ${intent}`, requestId, interactive: false, tier: 'standard' });
    const variant = draft.variants.find((item) => item.label === 'recommended') ?? draft.variants[0];
    if (!variant) return { skip: 'Could not prepare an email to approve' };
    const addressing = await replyAddressing(deps, account, thread.gmail_thread_id, kind);
    if (!addressing.to.length) return { skip: 'No one to reply to' };
    return { email: { ...addressing, subject: variant.subject ?? replySubject(thread.subject), body: variant.body } };
  } catch (error) {
    if (error instanceof ApiError || error instanceof BudgetExceededError || error instanceof InferenceError) return { skip: 'Could not prepare an email to approve' };
    throw error;
  }
}

/** Run one automation for one trigger (with or without a thread). Idempotent per key. */
export async function executeAutomation(deps: IntelDeps, userId: string, input: { automationId: string; trigger: Trigger['kind']; threadRowId: string | null; key: string; manual?: boolean }) {
  const automation = await deps.db.asUser(userId, (tx) => one<AutomationRow>(tx, `select * from public.automation_rules where id = $1::uuid`, [input.automationId]));
  if (!automation) throw new ApiError('not_found', 'That automation does not exist.');
  if (!automation.enabled && !input.manual) throw new SkipJob('disabled');
  const existing = await deps.db.asUser(userId, (tx) => one<{ id: string }>(tx, `select id from public.automation_runs where idempotency_key = $1`, [input.key]));
  if (existing) return existing.id;
  const thread = input.threadRowId ? await deps.db.asUser(userId, (tx) => one<ThreadContext>(tx, `${THREAD_CONTEXT} where t.id = $1::uuid`, [input.threadRowId])) : null;
  const runId = await deps.db.asUser(userId, async (tx) => {
    const row = await one<{ id: string }>(
      tx,
      `insert into public.automation_runs (user_id, automation_id, trigger, thread_id, gmail_thread_id, idempotency_key) values ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6) returning id`,
      [userId, automation.id, input.trigger, thread?.id ?? null, thread?.gmail_thread_id ?? null, input.key],
    );
    return row!.id;
  });
  const outcomes: RunOutcome[] = [];
  let status: 'completed' | 'failed' | 'skipped' = 'completed';
  let errorCode: string | null = null;
  try {
    const why = thread ? await conditionsMatch(deps, userId, automation, thread, `automation_${runId}`) : [];
    if (thread && !why) {
      status = 'skipped';
    } else {
      for (const [index, spec] of automation.actions.entries()) {
        const tier = actionTier(spec);
        if (spec.kind === 'notify' && spec.params.digest) {
          outcomes.push({ kind: spec.kind, tier, outcome: automation.mode === 'shadow' ? 'shadowed' : 'applied', auditId: null, approvalId: null, detail: automation.mode === 'shadow' ? 'Would send a digest' : await digest(deps, userId, Number(spec.params.digest), automation, input.key) });
          continue;
        }
        if (!thread && spec.kind !== 'notify') {
          outcomes.push({ kind: spec.kind, tier, outcome: 'skipped', auditId: null, approvalId: null, detail: input.manual ? 'No recent thread matches' : 'Needs a thread' });
          continue;
        }
        const target = thread
          ? { accountId: thread.mail_account_id, threadRowId: thread.id, gmailThreadId: thread.gmail_thread_id, title: thread.subject }
          : { accountId: (await deps.db.asUser(userId, (tx) => one<{ id: string }>(tx, `select id from public.mail_accounts where status = 'active' order by connected_at limit 1`)))?.id ?? '', threadRowId: null, gmailThreadId: null, title: automation.name };
        if (!target.accountId) {
          outcomes.push({ kind: spec.kind, tier, outcome: 'skipped', auditId: null, approvalId: null, detail: 'No connected account' });
          continue;
        }
        const outcome = await performAction(deps, userId, {
          spec,
          target,
          actor: { type: 'automation', id: automation.id, name: automation.name, autonomy: automation.autonomy, mode: automation.mode },
          userInitiated: false,
          idempotencyKey: `${input.key}:${index}`,
        });
        if (outcome.decision === 'shadowed') outcomes.push({ kind: spec.kind, tier, outcome: 'shadowed', auditId: null, approvalId: null, detail: `Would ${ACTION_LABELS[spec.kind].toLowerCase()}` });
        else if (outcome.decision === 'approval_required') {
          // A send needs the exact email in the approval card: prepare a grounded reply to show.
          const prepared = spec.kind === 'send_email' && thread ? await emailToApprove(deps, userId, thread, input.trigger, automation.prompt, `automation_${runId}`) : null;
          if (prepared && 'skip' in prepared) {
            outcomes.push({ kind: spec.kind, tier, outcome: 'skipped', auditId: null, approvalId: null, detail: prepared.skip });
            continue;
          }
          const email = prepared?.email ?? null;
          const approval = await deps.db.asUser(userId, (tx) =>
            createApproval(tx, deps.box, {
              userId,
              kind: spec.kind,
              tier,
              title: `${ACTION_LABELS[spec.kind]}: ${target.title ?? automation.name}`,
              why: `Automation "${automation.name}"${why?.length ? ` matched: ${why.join('; ')}` : ''}`.slice(0, 500),
              sources: thread ? [{ id: `thread:${thread.gmail_thread_id}`, kind: 'thread', title: thread.subject || '(no subject)', gmailThreadId: thread.gmail_thread_id, accountId: thread.mail_account_id }] : [],
              action: email ? { ...spec, params: { ...spec.params, ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}) } } : spec,
              target,
              preview: email ? { to: email.to, cc: email.cc, subject: email.subject, body: email.body } : { change: `${ACTION_LABELS[spec.kind]}${target.title ? ` on "${target.title}"` : ''}` },
              responsible: { type: 'automation', id: automation.id, name: automation.name },
              idempotencyKey: `${input.key}:${index}`,
            }),
          );
          outcomes.push({ kind: spec.kind, tier, outcome: 'approval_requested', auditId: null, approvalId: approval.id, detail: 'Waiting for your approval' });
        } else if (outcome.decision === 'denied') outcomes.push({ kind: spec.kind, tier, outcome: 'skipped', auditId: null, approvalId: null, detail: outcome.reason });
        else if (outcome.errorCode) outcomes.push({ kind: spec.kind, tier, outcome: 'failed', auditId: null, approvalId: null, detail: outcome.errorCode });
        else outcomes.push({ kind: spec.kind, tier, outcome: 'applied', auditId: outcome.auditId, approvalId: null, detail: outcome.result?.summary ?? 'Done' });
      }
      if (outcomes.some((outcome) => outcome.outcome === 'failed')) status = 'failed';
    }
  } catch (error) {
    status = 'failed';
    errorCode = (error as { code?: string })?.code ?? 'failed';
  }
  await deps.db.asUser(userId, async (tx) => {
    await tx.query(`update public.automation_runs set status = $2, outcomes = $3::jsonb, error_code = $4, completed_at = now() where id = $1::uuid`, [runId, status, JSON.stringify(outcomes), errorCode]);
    await tx.query(`update public.automation_rules set runs = runs + 1, failures = failures + $2, last_run_at = now() where id = $1::uuid`, [automation.id, status === 'failed' ? 1 : 0]);
  });
  return runId;
}

const MANUAL_RUN_DAYS = 30;
const MANUAL_RUN_LIMIT = 25;

/**
 * "Run now" without a thread: once per recent matching thread (newest first),
 * or once without a thread when no action needs one. Returns the newest run.
 */
export async function runManually(deps: IntelDeps, userId: string, input: { automationId: string; key: string }): Promise<string> {
  const automation = await deps.db.asUser(userId, (tx) => one<AutomationRow>(tx, `select * from public.automation_rules where id = $1::uuid`, [input.automationId]));
  if (!automation) throw new ApiError('not_found', 'That automation does not exist.');
  const run = (threadRowId: string | null, key: string) => executeAutomation(deps, userId, { automationId: automation.id, trigger: 'manual', threadRowId, key, manual: true });
  if (automation.actions.every((spec) => spec.kind === 'notify')) return run(null, input.key);
  const { threads, prefs } = await deps.db.asUser(userId, async (tx) => ({
    prefs: await loadPreferences(tx, userId),
    threads: await tx.query<ThreadContext>(`${THREAD_CONTEXT} where t.last_message_at > $1::timestamptz order by t.last_message_at desc limit 300`, [new Date(deps.now().getTime() - MANUAL_RUN_DAYS * 86_400_000)]),
  }));
  const matches: ThreadContext[] = [];
  for (const thread of threads) {
    if (matches.length >= MANUAL_RUN_LIMIT) break;
    const summary = (await decryptSummary(deps.box, userId, thread))?.oneLine ?? '';
    if (matchDeterministic(automation.conditions, thread, { summary, now: deps.now(), timeZone: prefs.timeZone, workdays: prefs.workdays })) matches.push(thread);
  }
  if (!matches.length) return run(null, input.key);
  const runIds: string[] = [];
  for (const thread of matches) runIds.push(await run(thread.id, `${input.key}:${thread.id}`));
  return runIds[0]!;
}

export async function listRuns(tx: SqlExecutor, automationId: string | undefined, limit: number) {
  const rows = await tx.query<{ id: string; automation_id: string; trigger: Trigger['kind']; gmail_thread_id: string | null; status: 'running' | 'completed' | 'failed' | 'skipped'; started_at: unknown; completed_at: unknown; outcomes: RunOutcome[]; error_code: string | null }>(
    `select * from public.automation_runs ${automationId ? 'where automation_id = $2::uuid' : ''} order by started_at desc limit $1`,
    automationId ? [limit, automationId] : [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    automationId: row.automation_id,
    trigger: row.trigger,
    threadId: row.gmail_thread_id,
    status: row.status,
    startedAt: iso(row.started_at),
    completedAt: isoOrNull(row.completed_at),
    actions: (row.outcomes ?? []).map((outcome) => ({ ...outcome, detail: String(outcome.detail).slice(0, 200) })),
    errorCode: row.error_code,
  }));
}

/** Queue automations that listen for a thread event. Called from analysis and signal jobs. */
export async function triggerAutomations(tx: SqlExecutor, input: { userId: string; accountId: string; threadRowId: string; version: string; kinds: Trigger['kind'][] }): Promise<void> {
  if (!input.kinds.length) return;
  const rows = await tx.query<{ id: string; trigger_kind: string; version: number }>(`select id, trigger_kind, version from public.automation_rules where enabled and trigger_kind = any($1::text[])`, [input.kinds]);
  for (const row of rows) {
    await enqueue(tx, {
      kind: 'automation.run',
      userId: input.userId,
      accountId: input.accountId,
      key: `automation:${row.id}:v${row.version}:${input.threadRowId}:${input.version}:${row.trigger_kind}`,
      payload: { automationId: row.id, trigger: row.trigger_kind, threadId: input.threadRowId },
      maxAttempts: 3,
    });
  }
}

/** `automation.run` job. Scheduled runs fan out to candidate threads for no-reply triggers. */
export async function runAutomationJob(deps: IntelDeps, job: JobRecord): Promise<void> {
  if (!job.userId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const automationId = String(job.payload.automationId ?? '');
  const trigger = String(job.payload.trigger ?? 'manual') as Trigger['kind'];
  const automation = await deps.db.asUser(userId, (tx) => one<AutomationRow>(tx, `select * from public.automation_rules where id = $1::uuid`, [automationId]));
  if (!automation) throw new SkipJob('automation_gone');
  if (trigger === 'schedule' && automation.schedule_cron) {
    const next = nextCronRun(automation.schedule_cron, automation.schedule_tz ?? 'UTC', deps.now());
    await deps.db.asUser(userId, (tx) => tx.query(`update public.automation_rules set next_run_at = $2::timestamptz where id = $1::uuid`, [automation.id, next]));
    if (automation.trigger_kind === 'no_reply_by') {
      // Hourly sweep: every outbound thread past the threshold, once per thread version.
      const candidates = await deps.db.asUser(userId, (tx) =>
        tx.query<{ id: string; content_version: string }>(
          `select t.id, t.content_version from public.threads t where t.last_message_from_owner and t.last_outbound_at > $1::timestamptz order by t.last_outbound_at desc limit 200`,
          [new Date(deps.now().getTime() - 60 * 86_400_000)],
        ),
      );
      for (const candidate of candidates) {
        await executeAutomation(deps, userId, { automationId, trigger: 'no_reply_by', threadRowId: candidate.id, key: `automation:${automationId}:v${automation.version}:${candidate.id}:${candidate.content_version}:no_reply` });
      }
      return;
    }
  }
  await executeAutomation(deps, userId, { automationId, trigger, threadRowId: (job.payload.threadId as string | undefined) ?? null, key: job.idempotencyKey });
}
