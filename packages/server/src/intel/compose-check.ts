import { featureEnabled } from '../rollout.js';
import { applyNoticePolicy, confidenceBucket, latencyBucket } from './compose-policy.js';
import type { ComposeCheckNotice, ComposeCheckRequest, ComposeCheckResponse, Preferences, SourceRef } from '@pigeonbox/api-contract';
import { addCalendarDays, classifyComposeClaim, detectComposeContext, detectComposeCompletion, detectComposeWriting, normalizeClaim, safeTimeZone, zonedParts, zonedTimeToUtc, type ComposeClaimKind, type ComposeContextHint } from '@pigeonbox/shared';
import { iso, one, type SqlExecutor } from '../db/sql.js';
import { isTransientInferenceError } from '../ai/backends.js';
import { ApiError } from '../http.js';
import { getEntitlements, hasCapability, type Entitlements } from '../entitlements.js';
import { enforceLimits } from '../limits.js';
import { runStructured } from './ai.js';
import { clockLabel, describeDay, localMinutes, rangeLabel, resolveClaimInterval, rewriteTime, singleDay, daysIn, type ClaimInterval } from './compose-time.js';
import type { IntelDeps } from './context.js';
import { calendarFor, type AccountRow } from './google-access.js';
import { composeCheckPrompt, validateJudgment, evidenceAdvisories, selectComposeEvidence, resolveComposeContext } from './compose-context.js';
import { revalidateComposeEvidence } from './memory/compose-validation.js';
import { liveComposeCalendarContext } from './compose-calendar.js';
export { ComposeJudgmentSchema, composeCheckPrompt, validateJudgment } from './compose-context.js';
import { resolveAccount, threadRowId } from './ids.js';
import { safeMemoryText } from './memory/policy.js';
import type { ContextItem } from './memory/rank.js';
import { getRelevantContext } from './memory/retrieve.js';
import { loadPreferences, minutesOf } from './preferences.js';
import { selectCompletionEvidence, validateCompletion } from './compose-completion.js';
import { ComposeInferenceSchema, expandComposeInference } from './compose-inference.js';
import { proposeSlots } from './scheduling.js';
import { validateWritingJudgment } from './compose-writing.js';

/** One ephemeral clause: re-derive local routing, deterministic calendar/Brain
 * checks, bounded canonical context retrieval, then one extractive Luna judgment.
 * Every failure is silent; prose never enters persistence, queues or logs.
 * See docs/ambient-compose-context.md for the privacy and economics contract.
 */

const NONE: ComposeCheckResponse = { status: 'none' };
const DISABLED: ComposeCheckResponse = { status: 'disabled' };
/** Per-user ceiling on checks (calendar and database work), separate from paid-AI limits. */
export const COMPOSE_CHECKS_PER_MINUTE = 30;
/** Minimum model confidence for a semantic notice. */
export const SEMANTIC_THRESHOLD = 0.9;
const RETRIEVAL = { maxItems: 8, maxTokens: 1_400 };
export const COMPOSE_MODELS_PER_MINUTE = 12;
export const COMPOSE_MODELS_PER_DAY = 600;
export const COMPOSE_SEMANTIC_PER_MINUTE = 12;
export const COMPOSE_SEMANTIC_PER_DAY = 600;
const MODEL_TIMEOUT_MS = 7_000;

export type ComposeCheckPath = 'disabled' | 'unavailable' | 'rate_limited' | 'unchecked' | 'sensitive' | 'calendar' | 'brain' | 'model' | 'error';

type Loaded = { prefs: Preferences; account: AccountRow; threadRow: string | null; checks: boolean; completion: boolean };
type ComposeTimings = { loadMs: number; retrievalMs: number; preflightMs: number; inferenceMs: number; validationMs: number };
type Context = { deps: IntelDeps; userId: string; requestId: string; claim: string; request: ComposeCheckRequest; loaded: Loaded; now: Date; deadline: number; entitlements?: Entitlements; defer?: (work: Promise<void>) => void; metrics: { candidate: ComposeContextHint | null; retrieved: number; semantic: boolean; model: boolean; timings: ComposeTimings } };
type Outcome = { response: ComposeCheckResponse; path: ComposeCheckPath };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notice = (fields: Omit<ComposeCheckNotice, 'status'>): ComposeCheckResponse => ({ status: 'notice', ...fields, sources: fields.sources.slice(0, 4) });

export async function checkCompose(deps: IntelDeps, userId: string, request: ComposeCheckRequest, requestId: string, defer?: (work: Promise<void>) => void): Promise<ComposeCheckResponse> {
  const started = Date.now();
  let kind: ComposeClaimKind | null = null;
  const metrics = { candidate: null as ComposeContextHint | null, retrieved: 0, semantic: false, model: false, timings: { loadMs: 0, retrievalMs: 0, preflightMs: 0, inferenceMs: 0, validationMs: 0 } };
  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (error) {
    // Codes only: never the clause, and never a message that could quote it.
    deps.log('warn', 'compose check failed', { requestId, userId, code: (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'unknown') });
    // An outage is not a successful negative check. The extension quietly
    // backs off and retries HTTP failures without caching them as "none".
    if (isTransientInferenceError(error)) throw new ApiError('provider_unavailable', 'The compose check is temporarily unavailable.');
    outcome = { response: NONE, path: 'error' };
  }
  // Per-category policy is the last gate: a category can be tightened or turned off without a release.
  const proposed = outcome.response;
  const gated = applyNoticePolicy(proposed, deps.config.composePolicy);
  const latencyMs = Date.now() - started;
  // Which step decided, the clause kind, and the shown notice's category and buckets: never the clause or the notice text.
  deps.log('info', 'compose check', {
    requestId, userId, decision: outcome.path, event: kind ?? undefined, candidate: metrics.candidate ?? undefined, retrievalCount: metrics.retrieved, semantic: metrics.semantic, modelInvoked: metrics.model,
    count: gated.response.status === 'notice' ? 1 : 0, completionRequested: request.includeCompletion === true, completionCount: 'completion' in gated.response && gated.response.completion ? 1 : 0,
    outcome: proposed.status === 'notice' ? (gated.held ? 'notice_held' : 'notice_shown') : proposed.status,
    noticeKind: proposed.status === 'notice' ? proposed.kind : undefined,
    confidenceBucket: proposed.status === 'notice' ? confidenceBucket(proposed.confidence) : undefined,
    latencyBucket: latencyBucket(latencyMs), latencyMs, ...metrics.timings,
  });
  const response = gated.response;
  // Clients predating ambient hints only accept the original contextual kind.
  if (request.hint === undefined && response.status === 'notice' &&
      ['overlooked_context', 'helpful_context'].includes(response.kind)) return { ...response, kind: 'context' };
  return response;

  async function run(): Promise<Outcome> {
    const now = deps.now();
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    if ((await deps.store.hitRateLimit(`compose:${userId}`, minute)) > COMPOSE_CHECKS_PER_MINUTE) return { response: NONE, path: 'rate_limited' };
    const loaded = await deps.db.asUser(userId, async (tx) => {
      const prefs = await loadPreferences(tx, userId);
      // A rollout stage can only narrow the person's own opt-in. `disabled` makes the extension back off.
      const checks = prefs.memory.realtimeComposeChecks && featureEnabled(deps.config.rollout, 'compose_checks', userId);
      const completion = prefs.memory.smartComposeCompletion && request.includeCompletion === true && featureEnabled(deps.config.rollout, 'compose_completion', userId);
      if (!checks && !completion) return 'disabled' as const;
      // The selector only picks among the signed-in user's own connected accounts.
      const account = await resolveAccount(tx, { mailbox: request.mailbox, accountId: request.accountId && uuid.test(request.accountId) ? request.accountId : undefined });
      if (!account || account.status !== 'active' || !account.features.includes('mail_read')) return null;
      const threadRow = request.threadId ? await threadRowId(tx, account.id, request.threadId) : null;
      return { prefs, account, threadRow, checks, completion };
    });
    metrics.timings.loadMs = Date.now() - started;
    if (loaded === 'disabled') return { response: DISABLED, path: 'disabled' };
    if (!loaded) return { response: NONE, path: 'unavailable' };
    const claim = request.claim;
    if (claim.length > 700) return { response: NONE, path: 'unchecked' };
    // Re-derived here; the extension's hint is only what its own gate thought.
    kind = classifyComposeClaim(claim);
    metrics.candidate = detectComposeContext(claim);
    loaded.completion &&= detectComposeCompletion(claim);
    if ((!loaded.checks || !metrics.candidate) && !loaded.completion) return { response: NONE, path: 'unchecked' };
    // Secrets, health, financial identifiers and embedded instructions are never compared or surfaced.
    if (!safeMemoryText(claim)) return { response: NONE, path: 'sensitive' };
    const context: Context = { deps, userId, requestId, claim, request, loaded, now, metrics, defer, deadline: started + 7_000 };
    if (loaded.checks && (kind === 'availability' || kind === 'scheduling')) {
      const calendar = await calendarCheck(context);
      if (calendar.status !== 'none' || !loaded.completion) return { response: calendar, path: 'calendar' };
      // A clear calendar check still leaves room for a relevant remembered
      // detail. A factual calendar warning always takes priority.
      return brainCheck(context, kind);
    }
    return brainCheck(context, kind);
  }
}

// ---------------------------------------------------------------------------
// Calendar: real free/busy, never a model
// ---------------------------------------------------------------------------

type Busy = { start: number; end: number };

function mergeBusy(busy: Array<{ start: string; end: string }>, window: Busy): Busy[] {
  const clipped = busy
    .map((item) => ({ start: Math.max(Date.parse(item.start), window.start), end: Math.min(Date.parse(item.end), window.end) }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start);
  const merged: Busy[] = [];
  for (const item of clipped) {
    const last = merged.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

/**
 * Whether the calendar contradicts the claim. A point or range conflicts when
 * busy time overlaps it by 15 minutes or more (or all of a shorter one). A
 * daypart, "after 3" or a whole day conflicts only when no free stretch of one
 * meeting length is left in it: one class does not make "free Tuesday afternoon" false.
 */
export function calendarConflict(interval: Pick<ClaimInterval, 'start' | 'end' | 'precision'>, busy: Array<{ start: string; end: string }>, meetingMinutes: number, requireWholeSpanFree = false): boolean {
  const window = { start: interval.start.getTime(), end: interval.end.getTime() };
  const merged = mergeBusy(busy, window);
  if (!merged.length) return false;
  if (interval.precision !== 'span') {
    const overlap = merged.reduce((sum, item) => sum + (item.end - item.start), 0);
    return overlap >= Math.min(15 * 60_000, window.end - window.start);
  }
  // “Free all day” is a claim about the entire span; one real event disproves
  // it. A daypart such as “free Tuesday afternoon” only conflicts when the
  // remaining free windows are too short to be useful.
  if (requireWholeSpanFree) return true;
  let cursor = window.start;
  let longestFree = 0;
  for (const item of merged) {
    longestFree = Math.max(longestFree, item.start - cursor);
    cursor = Math.max(cursor, item.end);
  }
  longestFree = Math.max(longestFree, window.end - cursor);
  return longestFree < meetingMinutes * 60_000;
}

async function calendarAccountFor(deps: IntelDeps, userId: string, account: AccountRow): Promise<AccountRow | null> {
  if (account.features.includes('calendar_read')) return account;
  return deps.db.asUser(userId, (tx) =>
    one<AccountRow>(
      tx,
      `select id, user_id, email, google_sub, status, features, display_name from public.mail_accounts where status = 'active' and 'calendar_read' = any (features) order by connected_at limit 1`,
    ),
  );
}

type CachedEvent = { event_id: string; mail_account_id: string; title: string; start_at: unknown; end_at: unknown; html_link: string | null };

async function overlappingEvent(tx: SqlExecutor, accountId: string, interval: Busy, busy: Busy[], now: Date): Promise<CachedEvent | null> {
  const rows = await tx.query<CachedEvent>(
    `select event_id, mail_account_id, title, start_at, end_at, html_link from public.calendar_event_cache
      where mail_account_id = $1::uuid and not all_day and coalesce(status, 'confirmed') <> 'cancelled' and coalesce(self_response, 'accepted') <> 'declined'
        and updated_at >= $4::timestamptz - interval '30 minutes'
        and start_at < $3::timestamptz and end_at > $2::timestamptz
      order by least(end_at, $3::timestamptz) - greatest(start_at, $2::timestamptz) desc, start_at limit 5`,
    [accountId, new Date(interval.start), new Date(interval.end), now],
  );
  // Only an event Google also reports as busy names the conflict.
  return rows.find((row) => busy.some((item) => Date.parse(iso(row.start_at)) < item.end && Date.parse(iso(row.end_at)) > item.start)) ?? null;
}

function calendarUrl(link: string | null): string | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && (url.hostname === 'calendar.google.com' || (url.hostname === 'www.google.com' && url.pathname.startsWith('/calendar/'))) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

async function calendarCheck(context: Context): Promise<ComposeCheckResponse> {
  const { deps, userId, claim, loaded, now } = context;
  const entitlements = context.entitlements ?? await getEntitlements(userId, deps.store, deps.config);
  if (!hasCapability(entitlements, 'cloud_calendar')) return NONE;
  const prefs = loaded.prefs;
  const zone = safeTimeZone(prefs.timeZone);
  const work = { start: minutesOf(prefs.workingHours.start), end: minutesOf(prefs.workingHours.end) };
  const interval = resolveClaimInterval(claim, {
    now,
    timeZone: zone,
    defaultMinutes: prefs.calendar.defaultDurationMinutes,
    workday: { start: work.start.hour * 60 + work.start.minute, end: work.end.hour * 60 + work.end.minute },
  });
  if (!interval) return NONE;
  const account = await calendarAccountFor(deps, userId, loaded.account);
  if (!account) return NONE;
  const dayStart = zonedTimeToUtc({ ...interval.day, hour: 0, minute: 0 }, zone);
  const dayEnd = zonedTimeToUtc({ ...addCalendarDays(interval.day, 1), hour: 0, minute: 0 }, zone);
  const result = await calendarFor(deps, account).freeBusyWithSelectedCalendars({ timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), timeZone: zone });
  // A calendar that could not be read proves nothing: never claim free or busy from it.
  if (!result.calendarsChecked) return NONE;
  const requireWholeSpanFree = /\b(?:all\s*day|the\s+whole\s+day|entire\s+day)\b/i.test(claim);
  if (!calendarConflict(interval, result.busy, prefs.calendar.defaultDurationMinutes, requireWholeSpanFree)) return NONE;
  const window = { start: interval.start.getTime(), end: interval.end.getTime() };
  const busy = mergeBusy(result.busy, window);
  const event = await deps.db.asUser(userId, (tx) => overlappingEvent(tx, account.id, window, busy, now));
  const title = event && safeMemoryText(event.title) ? event.title.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const eventStart = event ? new Date(iso(event.start_at)) : null;
  const eventEnd = event ? new Date(iso(event.end_at)) : null;
  const sameDay = eventStart && eventEnd && eventStart >= dayStart && eventEnd <= dayEnd;
  let message: string;
  if (requireWholeSpanFree) {
    message = title && sameDay
      ? `You have ${title} from ${rangeLabel(localMinutes(eventStart!, zone), localMinutes(eventEnd!, zone))} ${interval.dayLabel}.`
      : `Your calendar shows busy time ${interval.dayLabel}.`;
  } else if (interval.precision === 'span') {
    message = `Your calendar is nearly full ${rangeLabel(localMinutes(interval.start, zone), localMinutes(interval.end, zone))} ${interval.dayLabel}${title ? `, including ${title}` : ''}.`;
  } else if (title && sameDay) {
    message = `You have ${title} from ${rangeLabel(localMinutes(eventStart!, zone), localMinutes(eventEnd!, zone))} ${interval.dayLabel}.`;
  } else {
    message = interval.precision === 'point' ? `Your calendar shows you're busy at ${clockLabel(localMinutes(interval.start, zone))} ${interval.dayLabel}.` : `Your calendar shows you're busy for part of ${rangeLabel(localMinutes(interval.start, zone), localMinutes(interval.end, zone))} ${interval.dayLabel}.`;
  }
  // An alternative only from the availability engine, later the same day.
  let suggestedText: string | undefined;
  if (interval.precision !== 'span') {
    const [slot] = proposeSlots({
      busy: result.busy,
      window: { start: interval.start, end: zonedTimeToUtc({ ...interval.day, hour: work.end.hour, minute: work.end.minute }, zone) },
      durationMinutes: Math.max(15, Math.round((window.end - window.start) / 60_000)),
      timeZone: zone,
      workdays: prefs.workdays,
      workingHours: prefs.workingHours,
      bufferMinutes: prefs.calendar.bufferMinutes,
      avoidBackToBack: prefs.calendar.avoidBackToBack,
      preferMornings: false,
      focusBlocks: prefs.calendar.focusBlocks,
      count: 1,
      now,
    });
    if (slot && !result.errors) {
      const minutes = localMinutes(new Date(slot.start), zone);
      const candidate = `${message} You're free at ${clockLabel(minutes)}.`;
      if (candidate.length <= 240) message = candidate;
      if (interval.precision === 'point' && interval.timeText) {
        const { index, text } = interval.timeText;
        const rewritten = `${claim.slice(0, index)}${rewriteTime(text, minutes)}${claim.slice(index + text.length)}`;
        if (rewritten !== claim && rewritten.length <= 700) suggestedText = rewritten;
      }
    }
  }
  const source: SourceRef =
    event && title
      ? { id: `event:${event.event_id}`.slice(0, 128), kind: 'calendar_event', title, accountId: account.id, at: iso(event.start_at), ...(calendarUrl(event.html_link) ? { url: calendarUrl(event.html_link) } : {}) }
      : { id: 'calendar:freebusy', kind: 'calendar_event', title: 'Your Google Calendar', accountId: account.id, url: `https://calendar.google.com/calendar/?authuser=${encodeURIComponent(account.email)}` };
  return notice({ kind: 'calendar_conflict', severity: 'warning', message: message.slice(0, 240), confidence: interval.precision === 'span' ? 0.95 : 0.98, ...(suggestedText ? { suggestedText } : {}), sources: [source] });
}

// ---------------------------------------------------------------------------
// Brain: structured retrieval, deterministic contradictions, then Luna
// ---------------------------------------------------------------------------

const STOP = new Set(
  'about after again also been before being both could didn does doing done from have here into just like make more most much only other over really same send sent should some such than that their them then there these they this those through very want week what when where which while will with would your yours today tomorrow monday tuesday wednesday thursday friday saturday sunday morning afternoon evening tonight thanks'.split(' '),
);
/** Words that carry the topic: four letters or more, not filler, not a day. */
const contentWords = (text: string) => new Set((normalizeClaim(text).match(/[a-z][a-z'-]{3,}/g) ?? []).filter((word) => !STOP.has(word)));
const LOCATION = /\b(?:(?:room|rm\.?|building|bldg\.?|suite)\s+[A-Z0-9][\w-]*|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Hall|Building|Library|Center|Centre|Room|Auditorium|Lab|Theater|Theatre|Annex|Tower|House|Pavilion)(?:\s+\d+[A-Z]?)?)/g;
const TIME_VALUE = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b|\b(\d{1,2}):([0-5]\d)\b/gi;

type Value = { key: string; text: string };
function valuesOf(attribute: string, text: string, now: Date, timeZone: string): Value[] {
  if (attribute === 'date') return daysIn(text, now, timeZone).filter((item) => /\d/.test(item.text) || /day/i.test(item.text)).map((item) => ({ key: `${item.day.year}-${item.day.month}-${item.day.day}`, text: item.text }));
  if (attribute === 'location') return [...text.matchAll(LOCATION)].map((match) => ({ key: match[0].toLowerCase().replace(/\s+/g, ' '), text: match[0] }));
  if (attribute === 'time')
    return [...text.matchAll(TIME_VALUE)].map((match) => {
      let hour = Number(match[1] ?? match[4]);
      if (match[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (match[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
      return { key: `${hour}:${match[2] ?? match[5] ?? '00'}`, text: match[0] };
    });
  return [];
}

function uniqueReplace(text: string, from: string, to: string): string | undefined {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + 1) >= 0 || from === to) return undefined;
  const result = `${text.slice(0, first)}${to}${text.slice(first + from.length)}`;
  return result.length <= 700 ? result : undefined;
}

const dayOf = (instant: string, timeZone: string) => {
  const p = zonedParts(new Date(instant), safeTimeZone(timeZone));
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
};
const dayNumber = (day: { year: number; month: number; day: number }) => Date.UTC(day.year, day.month - 1, day.day) / 86_400_000;

/** Structured evidence decided: a notice, or 'consistent' (it agrees, so nothing more is asked). Null: it could not decide. */
type Decision = ComposeCheckResponse | 'consistent' | null;

/** An open promise of the user's to these recipients (or in this thread) due earlier than the day they now name. */
async function commitmentConflict(context: Context, items: ContextItem[]): Promise<Decision> {
  const { claim, now, loaded, deps, userId } = context;
  const zone = loaded.prefs.timeZone;
  const claimed = singleDay(claim, now, zone);
  if (!claimed) return null;
  const recipients = new Set(context.request.recipientEmails.map((email) => email.toLowerCase()));
  const words = contentWords(claim);
  const matching = items.filter((item) => {
    const promise = item.commitment;
    if (!promise || promise.direction !== 'mine' || !promise.dueAt) return false;
    const party = (promise.counterparty && recipients.has(promise.counterparty.toLowerCase())) || promise.threadRowId === loaded.threadRow;
    if (!party) return false;
    // Same thread, or the same deliverable named again ("the deck").
    return promise.threadRowId === loaded.threadRow || [...contentWords(promise.text)].some((word) => words.has(word));
  });
  const dueDays = new Set(matching.map((item) => dayNumber(dayOf(item.commitment!.dueAt!, zone))));
  if (matching.length === 0 || dueDays.size !== 1) return null;
  const item = matching[0]!;
  const due = dayOf(item.commitment!.dueAt!, zone);
  // Promising later than already promised is the contradiction; earlier or the same day is fine.
  if (dayNumber(claimed.day) <= dayNumber(due)) return 'consistent';
  const who = item.commitment!.counterparty
    ? await deps.db.asUser(userId, async (tx) => (await one<{ name: string | null }>(tx, `select name from public.contacts where email_normalized = lower($1) limit 1`, [item.commitment!.counterparty]))?.name ?? item.commitment!.counterparty!)
    : 'them';
  const dueLabel = describeDay(due, now, zone).replace(/^on /, '');
  const quoted = item.commitment!.text.replace(/\s+/g, ' ').trim();
  const message = quoted.length <= 150 ? `You previously told ${who}: “${quoted}”` : `You previously told ${who} you'd do this by ${dueLabel}.`;
  // "Friday" → "Wednesday"; "by Friday" → "by Oct 14"; "Friday" → "on Oct 14".
  const afterPreposition = /\b(?:by|on|before|until|no later than)\s+$/i.test(claim.slice(0, claim.indexOf(claimed.text)));
  const replacement = /^(?:today|tomorrow)$/.test(dueLabel) || /^[A-Z][a-z]+day$/.test(dueLabel) || afterPreposition ? dueLabel : `on ${dueLabel}`;
  const suggestedText = daysIn(claim, now, zone).length === 1 ? uniqueReplace(claim, claimed.text, replacement) : undefined;
  return notice({ kind: 'commitment_conflict', severity: 'warning', message: message.slice(0, 240), confidence: 0.92, ...(suggestedText ? { suggestedText } : {}), sources: [item.ref] });
}

/** A corrected or explicitly updated fact about the same named thing gives a different value than the claim. */
function factConflict(context: Context, items: ContextItem[]): Decision {
  const { claim, now, loaded } = context;
  const zone = loaded.prefs.timeZone;
  const normalized = ` ${normalizeClaim(claim)} `;
  for (const item of items) {
    const fact = item.fact;
    if (!fact?.concept || !(fact.corrected || fact.replaces)) continue;
    const topicWords = normalizeClaim(fact.concept.topic).match(/[a-z0-9]+/g) ?? [];
    if (!topicWords.length || !topicWords.every((word) => new RegExp(`[^a-z0-9]${word}[^a-z0-9]`).test(normalized))) continue;
    const text = item.text.replace(/^[^:]+:\s*/, '');
    const latest = valuesOf(fact.concept.attribute, text, now, zone);
    const written = valuesOf(fact.concept.attribute, claim, now, zone);
    if (latest.length !== 1 || !written.length) continue;
    if (written.some((value) => value.key === latest[0]!.key)) return 'consistent';
    const topic = fact.concept.topic.replace(/\s+/g, ' ').trim();
    const message = topic.length <= 40 && safeMemoryText(topic) ? `The latest ${topic} details say ${latest[0]!.text}.` : `The latest details say ${latest[0]!.text}.`;
    const suggestedText = written.length === 1 ? uniqueReplace(claim, written[0]!.text, latest[0]!.text) : undefined;
    return notice({ kind: 'fact_conflict', severity: 'warning', message: message.slice(0, 240), confidence: fact.corrected ? 0.95 : 0.93, ...(suggestedText ? { suggestedText } : {}), sources: [item.ref] });
  }
  return null;
}

/** The current thread's explicit deadline is on a different day than the one written. */
async function deadlineConflict(context: Context): Promise<Decision> {
  const { deps, userId, claim, loaded, now } = context;
  if (!loaded.threadRow) return null;
  const claimed = singleDay(claim, now, loaded.prefs.timeZone);
  if (!claimed) return null;
  const row = await deps.db.asUser(userId, (tx) =>
    one<{ deadline_at: unknown; subject: string; gmail_thread_id: string; mail_account_id: string }>(
      tx,
      `select s.deadline_at, t.subject, t.gmail_thread_id, t.mail_account_id from public.thread_states s join public.threads t on t.id = s.thread_id
        where s.thread_id = $1::uuid and s.deadline_explicit and s.deadline_at is not null
          and s.analyzed_version = t.content_version and not s.injection_suspected and not t.is_bulk
          and not exists(select 1 from public.personal_memory_exclusions x where x.thread_id = t.id)`,
      [loaded.threadRow],
    ),
  );
  if (!row) return null;
  const due = dayOf(iso(row.deadline_at), loaded.prefs.timeZone);
  if (dayNumber(due) === dayNumber(claimed.day)) return 'consistent';
  const label = describeDay(due, now, loaded.prefs.timeZone).replace(/^on /, '');
  return notice({
    kind: 'fact_conflict',
    severity: 'warning',
    message: `This conversation's deadline is ${label}.`,
    confidence: 0.9,
    sources: [{ id: `thread:${row.gmail_thread_id}`, kind: 'thread', title: row.subject.slice(0, 300) || '(no subject)', gmailThreadId: row.gmail_thread_id, accountId: row.mail_account_id }],
  });
}

async function modelCheck(context: Context, evidence: ContextItem[]): Promise<ComposeCheckResponse> {
  const modelStarted = Date.now();
  const { deps, userId, requestId, claim, loaded, now } = context;
  if (context.deadline - Date.now() < 500) return NONE;
  let evidenceTokens = 0;
  evidence = evidence.filter(item => {
    const wire = { id: 'E8', kind: item.ref.kind, title: item.ref.title.slice(0,120), at: item.at, text: item.text.slice(0,400), advisories: evidenceAdvisories(item,loaded.prefs.timeZone,now).slice(0,3) };
    const tokens = Math.ceil(new TextEncoder().encode(JSON.stringify(wire)).length / 2) + 12;
    if (evidenceTokens + tokens > 1_400) return false;
    evidenceTokens += tokens;
    return true;
  });
  const checkable = loaded.checks && selectComposeEvidence(evidence,claim,now,loaded.prefs.timeZone).length && evidence.some(item=>evidenceAdvisories(item,loaded.prefs.timeZone,now).length);
  const writingEdits = loaded.checks && context.request.includeWriting === true && detectComposeWriting(claim);
  const completable = loaded.completion && (selectCompletionEvidence(evidence,claim,now,loaded.prefs.timeZone).length > 0 || context.request.includeWriting === true);
  if (!checkable && !completable && !writingEdits) return NONE;
  const entitlements = context.entitlements ?? await getEntitlements(userId, deps.store, deps.config);
  if (!hasCapability(entitlements, 'cloud_ai')) return NONE;
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if ((await deps.store.hitRateLimit(`compose-model-minute:${userId}`, minute)) > COMPOSE_MODELS_PER_MINUTE ||
      (await deps.store.hitRateLimit(`compose-model-day:${userId}`, day)) > COMPOSE_MODELS_PER_DAY) return NONE;
  // The same paid-AI gates as every interactive operation: daily requests, budget, global cap, per-minute rate.
  await enforceLimits(userId, entitlements, { store: deps.store, config: deps.config, now });
  const ids = evidence.map((_, index) => `E${index + 1}`);
  const promptEvidence = evidence.map((item, index) => ({ id: ids[index]!, kind: item.ref.kind, title: item.ref.title.slice(0, 120), at: item.at, text: item.text.slice(0, 400), advisories: evidenceAdvisories(item, loaded.prefs.timeZone, now).slice(0,3) }));
  const prompt = composeCheckPrompt({
    compact: true,
    claim,
    includeCompletion: Boolean(completable),
    checks: Boolean(checkable),
    writing: writingEdits,
    allowWritingCompletion: context.request.includeWriting === true,
    now: now.toISOString(),
    timeZone: loaded.prefs.timeZone,
    evidence: promptEvidence,
  });
  // runStructured checks the monthly budget again, records usage without content, and validates the JSON.
  context.metrics.model = true;
  const result = await runStructured(deps, { userId, operation: 'compose_check', system: prompt.system, user: prompt.user, schema: ComposeInferenceSchema, maxTokens: writingEdits ? 560 : completable ? 440 : 200, interactive: true, requestId, timeoutMs: Math.max(1, Math.min(MODEL_TIMEOUT_MS, context.deadline - Date.now())), repair: false, defer: context.defer });
  context.metrics.timings.inferenceMs = result.latencyMs;
  context.metrics.timings.preflightMs = Math.max(0, Date.now() - modelStarted - result.latencyMs);
  const value = expandComposeInference(result.value, promptEvidence);
  const validationStarted = Date.now();
  try {
    const validation = () => ({ claim, ids, evidence, now: deps.now(), timeZone: loaded.prefs.timeZone, allowWriting: context.request.includeWriting === true });
    let checked = checkable ? validateJudgment(value, validation()) : NONE;
    if (checked.status === 'notice') {
      const cited = evidence.filter((_, index) => value.sourceIds.includes(ids[index]!));
      if (await revalidateComposeEvidence(deps, userId, cited, deps.now(), loaded.account.id)) checked = validateJudgment(value, validation());
      else checked = NONE;
    }
    // Corrections win; never encourage continuing a contradicted assertion.
    if (checked.status === 'notice' && checked.severity === 'warning') return checked;
    if (checked.status === 'none' && writingEdits) {
      const edit = validateWritingJudgment(value.writing, claim);
      if (edit && await revalidateComposeEvidence(deps, userId, [], deps.now(), loaded.account.id)) checked = edit;
    }
    let completion = completable ? validateCompletion(value.completion, validation()) : undefined;
    if (completable) deps.log('info', 'compose check completion judgment', { requestId, userId, completionProposed: Boolean(value.completion), completionValidated: Boolean(completion) });
    if (completion) {
      const cited = evidence.filter(item => completion!.sources.some(source => source.id === item.ref.id));
      if (!(await revalidateComposeEvidence(deps, userId, cited, deps.now(), loaded.account.id, 'completion'))) completion = undefined;
      else completion = validateCompletion(value.completion, validation());
    }
    return completion && checked.status !== 'disabled' ? { ...checked, completion } : checked;
  } finally { context.metrics.timings.validationMs = Date.now() - validationStarted; }
}

async function brainCheck(context: Context, kind: ComposeClaimKind | null): Promise<Outcome> {
  const { deps, userId, requestId, claim, request, loaded, now } = context;
  const decided = (decision: Decision): Outcome | null => (decision === 'consistent' ? { response: NONE, path: 'brain' } : decision ? { response: decision, path: 'brain' } : null);
  if (loaded.checks && kind === 'deadline') {
    const deadline = decided(await deadlineConflict(context));
    if (deadline) return deadline;
  }
  const entitlements = await getEntitlements(userId, deps.store, deps.config);
  // Reuse within this request only; the next phrase reads current entitlements.
  context.entitlements = entitlements;
  const retrieve = async (semantic: boolean) => {
    const started = Date.now();
    try {
      return await getRelevantContext(deps, {
        userId, recipientEmails: request.recipientEmails, currentThreadId: loaded.threadRow,
        subject: request.subject, composeText: claim, intent: 'compose_check', now, requestId,
        prefs: loaded.prefs, ...RETRIEVAL, semantic, recordAccess: false, profile: false,
        calendar: hasCapability(entitlements, 'cloud_calendar'),
        completion: loaded.completion,
      });
    } catch (error) {
      // A common word can also be several contacts' first name. This ambiguity
      // prevents factual retrieval, but need not suppress source-free prose.
      if (request.includeWriting === true && loaded.completion && kind === null && context.metrics.candidate === null &&
          error instanceof Error && error.name === 'AmbiguousComposePerson') return [];
      throw error;
    } finally { context.metrics.timings.retrievalMs += Date.now() - started; }
  };
  // Calendar access and the first encrypted-context lookup are independent.
  // Start both before waiting so their network latency does not accumulate.
  const dateBoundCompletion = loaded.completion && singleDay(claim, now, loaded.prefs.timeZone);
  const liveCalendarPromise = hasCapability(entitlements, 'cloud_calendar') && (
      dateBoundCompletion || (loaded.checks && (context.metrics.candidate === 'general_context' ||
        (['existence', 'temporal', 'uncertainty'].includes(context.metrics.candidate ?? '') && singleDay(claim, now, loaded.prefs.timeZone)))))
    ? liveComposeCalendarContext(deps, userId, loaded.account, claim, now, loaded.prefs.timeZone).catch(() => [] as ContextItem[])
    : Promise.resolve([] as ContextItem[]);
  const [initialItems, liveCalendar] = await Promise.all([retrieve(false), liveCalendarPromise]);
  let items = initialItems;
  context.metrics.retrieved = items.length;
  // When trusted structure decides either way, no model is asked.
  const deterministic = loaded.checks ? decided(kind === 'commitment' ? await commitmentConflict(context, items) : null) ?? decided(factConflict(context, items)) : null;
  if (deterministic) return deterministic;
  // Unknown personal wording and dated context get fresh evidence. The same
  // bounded judgment interprets meaning; no sentence template triggers a notice.
  items = [...liveCalendar, ...items.filter(item => !liveCalendar.some(event => event.ref.accountId === item.ref.accountId && event.ref.title === item.ref.title && event.calendar?.start === item.calendar?.start))];
  context.metrics.retrieved = items.length;
  const selectEvidence = (pool: ContextItem[]) => [...new Set([
    ...(loaded.completion ? selectCompletionEvidence(pool, claim, now, loaded.prefs.timeZone) : []),
    ...(loaded.checks ? selectComposeEvidence(pool, claim, now, loaded.prefs.timeZone) : []),
  ])].slice(0, 8);
  let evidence = selectEvidence(items);
  const general = loaded.checks ? resolveComposeContext(claim, evidence, now, loaded.prefs.timeZone) : null;
  const canComplete = () => loaded.completion && selectCompletionEvidence(evidence, claim, now, loaded.prefs.timeZone).length > 0;
  const canCompleteFromContext = () => loaded.completion && selectCompletionEvidence(evidence.filter(item => !item.calendar), claim, now, loaded.prefs.timeZone).length > 0;
  if (general) return { response: general, path: 'brain' };
  // Exact structure ran first. General candidates can use the existing search vectors
  // without a numeric/date anchor; failures leave only the exact pool.
  if (context.metrics.candidate !== 'writing' && (context.metrics.candidate !== null || context.request.includeWriting !== true) &&
      (!evidence.length || (context.metrics.candidate === 'general_context' && !canComplete()) || (loaded.completion && !canCompleteFromContext())) &&
      (kind === null || kind === 'fact' || loaded.completion) && hasCapability(entitlements, 'cloud_ai') && featureEnabled(deps.config.rollout, 'compose_semantic', userId)) {
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if ((await deps.store.hitRateLimit(`compose-semantic-minute:${userId}`, minute)) <= COMPOSE_SEMANTIC_PER_MINUTE &&
        (await deps.store.hitRateLimit(`compose-semantic-day:${userId}`, day)) <= COMPOSE_SEMANTIC_PER_DAY) {
      context.metrics.semantic = true;
      items = [...liveCalendar, ...await retrieve(true)];
      context.metrics.retrieved = items.length;
      const semanticDecision = loaded.checks ? decided(factConflict(context, items)) : null;
      if (semanticDecision) return semanticDecision;
      evidence = selectEvidence(items);
      const resolved = loaded.checks ? resolveComposeContext(claim, evidence, now, loaded.prefs.timeZone) : null;
      if (resolved) return { response: resolved, path: 'brain' };
    }
  }
  if (!evidence.length && !(context.request.includeWriting && (loaded.completion || (loaded.checks && detectComposeWriting(claim))))) return { response: NONE, path: 'brain' };
  try {
    return { response: await modelCheck(context, evidence), path: 'model' };
  } catch (error) {
    // Budget, rate limit, outage, timeout or an unusable reply: quietly nothing.
    deps.log('info', 'compose check model skipped', { requestId, userId, code: (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'unknown') });
    if (isTransientInferenceError(error)) throw error;
    return { response: NONE, path: 'model' };
  }
}
