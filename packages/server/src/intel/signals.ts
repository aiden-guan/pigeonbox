import type { EngagementSignal, EventClass, RouteResponse } from '@pigeonbox/api-contract';
import { detectOpenRequestSource } from '@pigeonbox/tracking';
import { iso, one, type SqlExecutor } from '../db/sql.js';
import type { JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import type { IntelDeps } from './context.js';
import { recordEngagement } from './followups.js';
import { normalizeGmailId } from './ids.js';
import { notify } from './notifications.js';
import { loadPreferences } from './preferences.js';
import { relationshipEvent } from './relationships.js';
import { triggerAutomations } from './automations.js';
import { sha256Hex } from '../platform/crypto.js';

/**
 * Signal intelligence on top of Tracking Protocol v3. The tracker's own
 * classification (self-view suppression, proxy detection, machine detection)
 * is authoritative; this layer names each event honestly, groups events into
 * signals with a stated reason, and never says an email was "read".
 */

type EventRow = {
  id: string;
  tracking_id: string;
  type: 'OPEN' | 'CLICK' | 'SELF_VIEW';
  timestamp: unknown;
  user_agent: string | null;
  suspected_self_open: boolean;
  confidence: number | null;
  classification: string | null;
  destination: string | null;
};

type TrackedRow = { tracking_id: string; subject: string; recipients: string[]; gmail_thread_id: string | null; sent_at: unknown; created_at: unknown };

export type ClassifiedEvent = { at: string; type: 'open' | 'click'; eventClass: EventClass; confidence: number; explanation: string; destination?: string };

const EXPLANATIONS: Record<EventClass, string> = {
  RECIPIENT_LIKELY: 'A browser-like request from a device other than yours, most likely a recipient opening the message.',
  SELF_LIKELY: 'Matched your own view of the sent message, so it is not counted.',
  MACHINE_LIKELY: 'Looked like a security scanner or automated fetch, not a person.',
  PRIVACY_PROXY: 'Loaded through a mail privacy proxy (such as Gmail’s image proxy). A mail client displayed images; it does not show who looked or when.',
  UNKNOWN: 'Not enough information to say whether a person was involved.',
};

export function classifyTrackingEvent(event: Pick<EventRow, 'type' | 'classification' | 'suspected_self_open' | 'user_agent' | 'confidence'>): { eventClass: EventClass; confidence: number } {
  if (event.suspected_self_open || event.classification === 'SELF_LIKELY' || event.type === 'SELF_VIEW') return { eventClass: 'SELF_LIKELY', confidence: event.confidence ?? 0.9 };
  const source = event.user_agent ? detectOpenRequestSource(event.user_agent) : null;
  if (event.classification === 'MACHINE_LIKELY' || source === 'scanner' || source === 'headless') return { eventClass: 'MACHINE_LIKELY', confidence: event.confidence ?? 0.8 };
  if (event.classification === 'PROXY_LIKELY' || (event.type === 'OPEN' && source === 'google_image_proxy')) return { eventClass: 'PRIVACY_PROXY', confidence: Math.min(0.5, event.confidence ?? 0.4) };
  if (event.classification === 'RECIPIENT_LIKELY' || (!event.classification && source === 'browser_like')) return { eventClass: 'RECIPIENT_LIKELY', confidence: Math.min(0.85, event.confidence ?? 0.7) };
  return { eventClass: 'UNKNOWN', confidence: Math.min(0.3, event.confidence ?? 0.3) };
}

function describeDestination(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${path ? path.slice(0, 40) : ''}`;
  } catch {
    return 'a link';
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Signals for one tracked message. Opens within 800 ms collapse (same rule as
 * the tracker's counters). Per-recipient attribution is claimed only when the
 * message had one recipient.
 */
export function deriveSignals(input: { events: EventRow[]; recipients: string[]; sentAt: string | null; now: Date; followUpPending: boolean; historyComplete?: boolean }): { signals: EngagementSignal[]; events: ClassifiedEvent[]; attributionNote: string } {
  const sorted = [...input.events].sort((a, b) => iso(a.timestamp).localeCompare(iso(b.timestamp)));
  const classified: ClassifiedEvent[] = [];
  const lastLikely = new Map<string, number>();
  for (const event of sorted) {
    if (event.type === 'SELF_VIEW') continue;
    const { eventClass, confidence } = classifyTrackingEvent(event);
    const at = iso(event.timestamp);
    if (event.type === 'OPEN' && eventClass === 'RECIPIENT_LIKELY') {
      const ms = Date.parse(at);
      const previous = lastLikely.get(event.tracking_id);
      if (previous !== undefined && ms - previous < 800) continue;
      lastLikely.set(event.tracking_id, ms);
    }
    classified.push({
      at,
      type: event.type === 'CLICK' ? 'click' : 'open',
      eventClass,
      confidence,
      explanation: EXPLANATIONS[eventClass],
      ...(event.type === 'CLICK' && event.destination ? { destination: event.destination.slice(0, 2_000) } : {}),
    });
  }
  const single = input.recipients.length === 1;
  const attribution: EngagementSignal['attribution'] = single ? 'recipient' : input.recipients.length > 1 ? 'message' : 'unknown';
  const recipient = single ? input.recipients[0] : undefined;
  const attributionNote = (single
    ? 'This message had one recipient, so likely opens are probably theirs (or someone they forwarded it to).'
    : input.recipients.length > 1
      ? `This message went to ${input.recipients.length} recipients in one email, so activity cannot be tied to a specific person.`
      : 'Recipients are unknown for this message.') + (input.historyComplete === false ? ' Signals cover recent activity only; earlier detections are outside this window.' : '');
  const signals: EngagementSignal[] = [];
  const base = { attribution, ...(recipient ? { recipient } : {}) };
  const likelyOpens = classified.filter((event) => event.type === 'open' && event.eventClass === 'RECIPIENT_LIKELY');
  const clicks = classified.filter((event) => event.type === 'click' && (event.eventClass === 'RECIPIENT_LIKELY' || event.eventClass === 'UNKNOWN'));
  const ambiguous = classified.filter((event) => event.eventClass === 'PRIVACY_PROXY' || event.eventClass === 'UNKNOWN');
  const nowMs = input.now.getTime();

  if (likelyOpens.length) {
    const first = likelyOpens[0]!;
    const last = likelyOpens[likelyOpens.length - 1]!;
    if (input.historyComplete !== false) signals.push({ kind: 'first_open', label: 'First likely recipient open', explanation: first.explanation, confidence: first.confidence, at: first.at, ...base });
    if (likelyOpens.length > 1 || input.historyComplete === false) signals.push({ kind: 'latest_open', label: 'Latest likely recipient open', explanation: last.explanation, confidence: last.confidence, at: last.at, ...base });
    const today = likelyOpens.filter((event) => nowMs - Date.parse(event.at) < 86_400_000);
    signals.push({
      kind: 'open_count',
      label: input.historyComplete === false ? `At least ${likelyOpens.length} likely opens in recent activity` : today.length >= 2 ? `Viewed ${today.length} times today` : plural(likelyOpens.length, 'likely recipient open'),
      explanation: `${plural(likelyOpens.length, 'open')} classified as recipient-likely; ${plural(ambiguous.filter((event) => event.type === 'open').length, 'other open')} could not be attributed to a person.`,
      confidence: 0.7,
      at: last.at,
      ...base,
    });
    for (let i = 1; i < likelyOpens.length; i += 1) {
      const gap = Date.parse(likelyOpens[i]!.at) - Date.parse(likelyOpens[i - 1]!.at);
      if (gap >= 7 * 86_400_000) {
        const days = Math.round(gap / 86_400_000);
        signals.push({ kind: 'reopened_after_inactivity', label: `Reopened after ${days} days`, explanation: `A recipient-likely open ${days} days after the previous one.`, confidence: 0.65, at: likelyOpens[i]!.at, ...base });
      }
    }
    for (let i = 0; i + 2 < likelyOpens.length; i += 1) {
      const span = Date.parse(likelyOpens[i + 2]!.at) - Date.parse(likelyOpens[i]!.at);
      if (span <= 60 * 60_000) {
        let end = i + 2;
        while (end + 1 < likelyOpens.length && Date.parse(likelyOpens[end + 1]!.at) - Date.parse(likelyOpens[i]!.at) <= 60 * 60_000) end += 1;
        const minutes = Math.max(1, Math.round((Date.parse(likelyOpens[end]!.at) - Date.parse(likelyOpens[i]!.at)) / 60_000));
        signals.push({ kind: 'engagement_burst', label: 'Likely recipient activity', explanation: `${end - i + 1} human-likely opens in ${minutes} minutes.`, confidence: 0.6, at: likelyOpens[end]!.at, ...base });
        break;
      }
    }
    if (nowMs - Date.parse(last.at) < 10 * 60_000) signals.push({ kind: 'active_now', label: 'Recent activity', explanation: 'A recipient-likely open in the last 10 minutes.', confidence: 0.6, at: last.at, ...base });
    if (input.followUpPending && nowMs - Date.parse(last.at) < 86_400_000) {
      signals.push({ kind: 'follow_up_timely', label: 'Follow-up may be timely', explanation: 'They likely looked at this in the last day and have not replied.', confidence: 0.5, at: last.at, ...base });
    }
  } else if (input.historyComplete !== false && !clicks.length && input.sentAt && nowMs - Date.parse(input.sentAt) > 3 * 86_400_000) {
    const days = Math.floor((nowMs - Date.parse(input.sentAt)) / 86_400_000);
    signals.push({
      kind: 'no_engagement',
      label: `No likely recipient activity in ${days} days`,
      explanation: ambiguous.length ? 'Only privacy-proxy or unattributable loads were seen; a person may still have read it with images blocked or proxied.' : 'No open was recorded. Images may be blocked, so this does not mean it was not read.',
      confidence: 0.4,
      at: null,
      ...base,
    });
  }
  for (const click of clicks.slice(-3)) {
    signals.push({ kind: 'click', label: `Clicked ${click.destination ? describeDestination(click.destination) : 'a link'}`, explanation: 'A tracked link was followed from a browser that did not look automated.', confidence: click.eventClass === 'RECIPIENT_LIKELY' ? 0.75 : 0.4, at: click.at, ...base });
  }
  if (ambiguous.length) {
    signals.push({
      kind: 'ambiguous_activity',
      label: plural(ambiguous.length, 'unattributed load'),
      explanation: 'Privacy proxies and unknown clients load images automatically. These could be a person or an automatic fetch, so they are not counted as opens.',
      confidence: 0.3,
      at: ambiguous[ambiguous.length - 1]!.at,
      ...base,
    });
  }
  return { signals: signals.slice(0, 20), events: classified.slice(-200), attributionNote };
}

async function trackedForThread(tx: SqlExecutor, gmailThreadId: string): Promise<TrackedRow[]> {
  const wanted = normalizeGmailId(gmailThreadId);
  const bare = [wanted];
  if (/^[0-9a-f]+$/.test(wanted)) bare.push(BigInt(`0x${wanted}`).toString(10));
  const variants = [...new Set(bare.flatMap(id => [id, `#${id}`, `thread-f:${id}`, `#thread-f:${id}`, `thread-a:${id}`, `#thread-a:${id}`]))];
  const rows = await tx.query<TrackedRow>(
    `select tracking_id, subject, recipients, gmail_thread_id, sent_at, created_at from public.tracked_emails where status = 'SENT' and lower(gmail_thread_id) = any($1::text[]) order by sent_at desc nulls last`,
    [variants],
  );
  return rows.filter((row) => row.gmail_thread_id && normalizeGmailId(row.gmail_thread_id) === wanted);
}

async function eventsFor(tx: SqlExecutor, trackingIds: string[]): Promise<{ events: EventRow[]; complete: boolean }> {
  if (!trackingIds.length) return { events: [], complete: true };
  const events = await tx.query<EventRow>(
    `select id, tracking_id, type, timestamp, user_agent, suspected_self_open, confidence, classification, destination from public.tracking_events where tracking_id = any($1::text[]) order by timestamp desc, id desc limit 2001`,
    [trackingIds],
  );
  return { events: events.slice(0, 2000), complete: events.length <= 2000 };
}

async function documentActivity(tx: SqlExecutor, gmailThreadId: string, trackingIds: string[]): Promise<RouteResponse<'threadSignals'>['events']> {
  // Older links may predate compose associations. Match only owned links present
  // in this conversation's tracker; never use a recipient label to infer a match.
  const destinations = trackingIds.length ? await tx.query<{ destination: string }>(
    `select distinct destination from public.tracked_links where tracking_id = any($1::text[]) limit 2000`, [trackingIds]) : [];
  const hashes = new Set<string>();
  for (const { destination } of destinations) {
    try {
      const token = new URL(destination).pathname.match(/^\/d\/([A-Za-z0-9_-]{32})$/)?.[1];
      if (token) hashes.add(await sha256Hex(token));
    } catch { /* Not a document URL. */ }
  }
  const rows = await tx.query<{ kind: string; at: unknown; filename: string }>(
    `select e.kind, e.at, d.filename from public.document_events e
     join public.document_recipients r on r.id = e.recipient_id and r.user_id = e.user_id
     join public.documents d on d.id = e.document_id and d.user_id = e.user_id
     where (r.gmail_thread_id = $1 or r.token_hash = any($2::text[]))
     and e.kind in ('view_start', 'download') and e.event_class = 'RECIPIENT_LIKELY'
     order by e.at desc, e.id desc limit 100`, [normalizeGmailId(gmailThreadId), [...hashes]]);
  return rows.map(row => ({
    at: iso(row.at),
    type: row.kind === 'view_start' ? 'document_view' : 'document_download',
    eventClass: 'RECIPIENT_LIKELY',
    confidence: 0.75,
    explanation: `${row.filename.slice(0, 255)} · ${row.kind === 'view_start' ? 'Displayed in the PDF viewer.' : 'Downloaded from the PDF viewer.'}`,
  }));
}

export async function threadSignals(tx: SqlExecutor, gmailThreadId: string, now: Date): Promise<RouteResponse<'threadSignals'>> {
  const tracked = await trackedForThread(tx, gmailThreadId);
  const documents = await documentActivity(tx, gmailThreadId, tracked.map(row => row.tracking_id));
  if (!tracked.length) return { signals: [], events: documents, attributionNote: documents.length ? 'PDF activity comes from shared links in this conversation. A link does not verify the reader’s identity.' : 'No tracked message in this thread.' };
  const follow = await one<{ stage: string }>(tx, `select f.stage from public.follow_ups f join public.threads t on t.id = f.thread_id where t.gmail_thread_id = $1`, [normalizeGmailId(gmailThreadId)]);
  const latest = tracked[0]!;
  const window = await eventsFor(tx, tracked.map((row) => row.tracking_id));
  const events = window.events;
  const recipients = [...new Set(tracked.flatMap((row) => (Array.isArray(row.recipients) ? row.recipients : [])).map((email) => String(email).toLowerCase()))];
  const derived = deriveSignals({ events, historyComplete: window.complete, recipients: recipients.length ? recipients : [], sentAt: latest.sent_at ? iso(latest.sent_at) : null, now, followUpPending: ['waiting', 'engaged', 'follow_up_due'].includes(follow?.stage ?? '') });
  return { ...derived, signals: derived.signals.filter(signal => signal.kind !== 'no_engagement' || !documents.length), events: [...derived.events, ...documents].sort((a, b) => a.at.localeCompare(b.at)).slice(-200) };
}

export async function engagementSignalsForContact(tx: SqlExecutor, email: string, now: Date): Promise<EngagementSignal[]> {
  const rows = await tx.query<TrackedRow>(
    `select tracking_id, subject, recipients, gmail_thread_id, sent_at, created_at from public.tracked_emails where status = 'SENT' and recipients ? $1 order by sent_at desc nulls last limit 5`,
    [email],
  );
  const out: EngagementSignal[] = [];
  for (const row of rows) {
    const window = await eventsFor(tx, [row.tracking_id]);
    const events = window.events;
    const derived = deriveSignals({ events, historyComplete: window.complete, recipients: row.recipients, sentAt: row.sent_at ? iso(row.sent_at) : null, now, followUpPending: false });
    out.push(...derived.signals.filter((signal) => signal.kind !== 'ambiguous_activity').map((signal) => ({ ...signal, label: `${signal.label} · ${row.subject.slice(0, 60)}`.slice(0, 160) })));
  }
  return out.slice(0, 10);
}

/**
 * The `signals.refresh` job, queued by a trigger on tracking events: update the
 * conversation's follow-up engagement, relationship timeline and (if the user
 * wants) notify about meaningful activity.
 */
export async function runSignalsRefresh(deps: IntelDeps, job: JobRecord): Promise<void> {
  const trackingId = String(job.payload.trackingId ?? '');
  if (!job.userId || !trackingId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  await deps.db.asUser(userId, async (tx) => {
    const tracked = await one<TrackedRow>(tx, `select tracking_id, subject, recipients, gmail_thread_id, sent_at, created_at from public.tracked_emails where tracking_id = $1`, [trackingId]);
    if (!tracked?.gmail_thread_id) throw new SkipJob('not_linked');
    const thread = await one<{ id: string; mail_account_id: string }>(tx, `select id, mail_account_id from public.threads where gmail_thread_id = $1 order by last_message_at desc limit 1`, [normalizeGmailId(tracked.gmail_thread_id)]);
    const window = await eventsFor(tx, [trackingId]);
    const events = window.events;
    const derived = deriveSignals({ events, historyComplete: window.complete, recipients: tracked.recipients ?? [], sentAt: tracked.sent_at ? iso(tracked.sent_at) : null, now: deps.now(), followUpPending: true });
    const likely = derived.events.filter((event) => event.type === 'open' && event.eventClass === 'RECIPIENT_LIKELY');
    const clicks = derived.events.filter((event) => event.type === 'click' && event.eventClass === 'RECIPIENT_LIKELY');
    const prefs = await loadPreferences(tx, userId);
    if (thread) {
      await recordEngagement(tx, {
        userId,
        accountId: thread.mail_account_id,
        threadRowId: thread.id,
        opens: likely.length,
        clicks: clicks.length,
        lastOpenAt: likely.length ? new Date(likely[likely.length - 1]!.at) : null,
        prefs,
      });
    }
    // Only a single-recipient message says anything about one person.
    if (tracked.recipients?.length === 1) {
      const contact = await one<{ id: string }>(tx, `select id from public.contacts where email_normalized = lower($1)`, [tracked.recipients[0]]);
      if (contact) {
        for (const event of [...likely, ...clicks].slice(-20)) {
          await relationshipEvent(tx, userId, contact.id, event.type === 'click' ? 'click' : 'open', new Date(event.at), thread?.id ?? null, tracked.gmail_thread_id, `${trackingId}:${event.type}:${event.at}`, tracked.subject);
        }
      }
    }
    if (thread && likely.length + clicks.length > 0) {
      const version = `${likely.length}:${clicks.length}`;
      await triggerAutomations(tx, { userId, accountId: thread.mail_account_id, threadRowId: thread.id, version: `signals-${trackingId}-${version}`, kinds: ['tracking_event'] });
    }
    const notable = derived.signals.find((signal) => signal.kind === 'reopened_after_inactivity' || signal.kind === 'engagement_burst');
    if (notable && prefs.notifications.engagement) {
      await notify(tx, {
        userId,
        kind: 'engagement',
        title: `${notable.label}: ${tracked.subject.slice(0, 120)}`,
        body: `${notable.explanation} This is a signal, not proof anyone read it.`,
        accountId: thread?.mail_account_id ?? null,
        threadId: tracked.gmail_thread_id,
        // Opening a conversation fires every tracked message in it; one alert covers them all.
        dedupeKey: `signal:thread:${normalizeGmailId(tracked.gmail_thread_id)}:${notable.at?.slice(0, 13)}`,
      });
    }
  });
}
