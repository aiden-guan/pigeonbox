import {
  addCalendarDays,
  localThreadSummary,
  safeTimeZone,
  zonedParts,
  zonedTimeToUtc,
  type NextActionKind,
  type ThreadCategory,
  type Urgency,
} from '@pigeonbox/shared';
import type { MeetingContext } from './prompts.js';

/**
 * Deterministic thread analysis. Used for bulk mail (no model call needed),
 * when the AI budget is exhausted or the provider fails (clearly marked as
 * `heuristic` in the UI), and as the reference in evals. Never guesses: when a
 * pattern is not clearly present, the field stays empty.
 */

export type AnalysisMessage = {
  from: string;
  fromName?: string | null;
  to: string[];
  cc: string[];
  date: string;
  text: string;
  direction: 'inbound' | 'outbound';
  isAuto?: boolean;
  listUnsubscribe?: boolean;
};

export type AnalysisThread = {
  subject: string;
  messages: AnalysisMessage[];
  ownerEmails: string[];
  labels: string[];
  timeZone: string;
};

export type AnalyzedCommitment = { messageId?: string | null; direction: 'mine' | 'theirs'; who: string; text: string; due: string | null };

export type ThreadAnalysis = {
  category: ThreadCategory;
  needsReply: boolean;
  replyExpectedFrom: 'owner' | 'them' | 'nobody';
  priority: 'HIGH' | 'NORMAL' | 'LOW';
  urgency: Urgency;
  deadline: { at: string; explicit: boolean; label: string } | null;
  importanceReason: string;
  nextAction: { kind: NextActionKind; label: string };
  summary: { oneLine: string; keyPoints: string[] };
  commitments: AnalyzedCommitment[];
  meeting: MeetingContext & { constraints: string[] };
  confidence: number;
  suspiciousInstructions: boolean;
};

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  /\bignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier|preceding) (?:instructions|rules|prompts?|messages)\b/i,
  /\b(?:disregard|forget|override) (?:all |your |the )?(?:previous |prior )?(?:instructions|rules|guidelines|system prompt)\b/i,
  /\bsystem (?:message|prompt|override|instruction)s?\s*[:-]/i,
  /\byou are (?:now )?(?:an? )?(?:ai|assistant|language model|chatgpt|claude|pigeonbox)\b/i,
  /\b(?:assistant|system)\s*:\s*\S/i,
  /<\/?(?:system|instructions?|assistant|tool|email_data)>/i,
  /\b(?:send|forward|reply with|email) (?:me |us )?(?:your |the (?:user'?s? )?)?(?:password|passcode|credentials|api key|2fa|otp|verification code|login)\b/i,
  /\bnew instructions\b/i,
  /\bdo not (?:tell|inform|mention (?:this )?to) the user\b/i,
];

/** Text that tries to instruct an AI. The message is still analyzed, as data. */
export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Dates and deadlines
// ---------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALT = MONTHS.map((month) => (month.length > 4 ? `${month.slice(0, 3)}(?:${month.slice(3)})?` : month)).join('|').replace('sep(?:tember)?', 'sept?(?:ember)?');
const DAY_ALT = WEEKDAYS.map((day) => `${day.slice(0, 3)}(?:${day.slice(3)})?`).join('|');

const DEADLINE_CUE = /\b(by|before|no later than|due(?: on| by)?|deadline(?: is)?:?|until|ahead of|submit by|needed by)\s+/i;

export type LocalDay = { year: number; month: number; day: number; weekday: number };

/** The coming occurrence of a weekday; today counts ("by Friday" said on Friday means today). */
function resolveWeekday(name: string, reference: LocalDay, excludeToday: boolean): LocalDay {
  const target = WEEKDAYS.findIndex((day) => day.startsWith(name.toLowerCase().slice(0, 3)));
  let delta = (target - reference.weekday + 7) % 7;
  if (excludeToday && delta === 0) delta = 7;
  return addCalendarDays(reference, delta);
}

function resolveMonthDay(month: number, day: number, reference: LocalDay): LocalDay | null {
  if (day < 1 || day > 31) return null;
  let year = reference.year;
  // A date more than two months in the past most likely means next year.
  const candidate = Date.UTC(year, month - 1, day);
  const ref = Date.UTC(reference.year, reference.month - 1, reference.day);
  if (candidate < ref - 60 * 86_400_000) year += 1;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return null;
  return { year, month, day, weekday: check.getUTCDay() };
}

/**
 * Resolve a date expression right after `index` in `text`. Returns the local
 * day and the matched wording, or null.
 */
export function dateAt(text: string, reference: LocalDay): { day: LocalDay; label: string; hour: number } | null {
  const s = text.slice(0, 60);
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(today|tonight|eod|end of (?:the )?day|cob|close of business)\b/i))) return { day: reference, label: m[0], hour: 17 };
  if ((m = s.match(/^tomorrow\b/i))) return { day: addCalendarDays(reference, 1), label: m[0], hour: 17 };
  if ((m = s.match(/^(?:the )?end of (?:the |this )?week\b|^eow\b/i))) return { day: resolveWeekday('friday', reference, false), label: m[0], hour: 17 };
  if ((m = s.match(/^(?:the )?end of (?:the |this )?month\b/i))) {
    const last = new Date(Date.UTC(reference.year, reference.month, 0));
    return { day: { year: reference.year, month: reference.month, day: last.getUTCDate(), weekday: last.getUTCDay() }, label: m[0], hour: 17 };
  }
  if ((m = s.match(new RegExp(`^(?:(next|this) )?(${DAY_ALT})\\b`, 'i')))) {
    if ((m[1] ?? '').toLowerCase() === 'next') {
      // "next Friday": that day in the following Monday–Sunday week.
      const toNextMonday = (8 - reference.weekday) % 7 || 7;
      const target = WEEKDAYS.findIndex((day) => day.startsWith(m![2]!.toLowerCase().slice(0, 3)));
      return { day: addCalendarDays(reference, toNextMonday + ((target + 6) % 7)), label: m[0], hour: 17 };
    }
    return { day: resolveWeekday(m[2]!, reference, false), label: m[0], hour: 17 };
  }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})\b/))) {
    const day = resolveMonthDay(Number(m[2]), Number(m[3]), { ...reference, year: Number(m[1]) });
    return day ? { day: { ...day, year: Number(m[1]) }, label: m[0], hour: 17 } : null;
  }
  if ((m = s.match(new RegExp(`^(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')))) {
    const month = MONTHS.findIndex((name) => name.startsWith(m![1]!.toLowerCase().slice(0, 3))) + 1;
    const day = resolveMonthDay(month, Number(m[2]), reference);
    return day ? { day, label: m[0], hour: 17 } : null;
  }
  if ((m = s.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\b`, 'i')))) {
    const month = MONTHS.findIndex((name) => name.startsWith(m![2]!.toLowerCase().slice(0, 3))) + 1;
    const day = resolveMonthDay(month, Number(m[1]), reference);
    return day ? { day, label: m[0], hour: 17 } : null;
  }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const day = resolveMonthDay(Number(m[1]), Number(m[2]), reference);
    return day ? { day, label: m[0], hour: 17 } : null;
  }
  return null;
}

/** The first deadline stated with a cue ("by Friday", "due Oct 3", "before EOD"). */
export function extractDeadline(text: string, reference: Date, timeZone: string): { at: string; explicit: boolean; label: string } | null {
  const zone = safeTimeZone(timeZone);
  const p = zonedParts(reference, zone);
  const today: LocalDay = { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
  const cue = new RegExp(DEADLINE_CUE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = cue.exec(text))) {
    const rest = text.slice(match.index + match[0].length);
    const resolved = dateAt(rest, today);
    if (!resolved) continue;
    const at = zonedTimeToUtc({ ...resolved.day, hour: resolved.hour, minute: 0 }, zone);
    return { at: at.toISOString(), explicit: true, label: `${match[1]} ${resolved.label}`.slice(0, 200) };
  }
  // Soft deadline: "sometime next week" / "this week" with no cue.
  const soft = text.match(/\b(sometime )?(next week|this week|in the next few days)\b/i);
  if (soft) {
    const offset = /next week/i.test(soft[2]!) ? 7 + ((5 - today.weekday + 7) % 7) : (5 - today.weekday + 7) % 7;
    const day = addCalendarDays(today, Math.max(1, offset));
    return { at: zonedTimeToUtc({ ...day, hour: 17, minute: 0 }, zone).toISOString(), explicit: false, label: soft[0].slice(0, 200) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Requests, commitments, meetings
// ---------------------------------------------------------------------------

const REQUEST_PATTERNS = [
  /\b(?:can|could|would|will) you\b/i,
  /\bplease\b(?! (?:find|see) attached)/i,
  /\blet (?:me|us) know\b/i,
  /\bwhat do you think\b/i,
  /\bare you (?:free|available|around|able)\b/i,
  /\bany (?:thoughts|update|feedback|news)\b/i,
  /\bwhen (?:can|could|would|are|will) you\b/i,
  /\bdo you (?:have|know|want|mind)\b/i,
  /\b(?:need|waiting (?:on|for)) (?:your|you to)\b/i,
  /\brsvp\b/i,
  /\bget back to (?:me|us)\b/i,
  /\bconfirm\b.*\b(?:you|your)\b/i,
];

const CLOSERS = /^(?:thanks|thank you|thx|great|perfect|sounds good|got it|ok(?:ay)?|cool|awesome|will do|noted|cheers)[\s!.,]*(?:[a-z]+[!.]*)?$/i;

export function looksLikeRequest(text: string): boolean {
  const body = text.trim();
  if (!body) return false;
  const firstLines = body.split('\n').slice(0, 30).join('\n');
  if (CLOSERS.test(firstLines.replace(/\s+/g, ' ').trim())) return false;
  return /\?\s*(?:\n|$)|\?\s+[A-Z]/.test(firstLines) || REQUEST_PATTERNS.some((pattern) => pattern.test(firstLines));
}

const PROMISE = /\b(?:I|we)(?:'ll| will| am going to|'m going to| can)\s+(?:send|share|get back|follow up|look into|check|review|circle back|have|finish|deliver|update|confirm|call|email|ping|draft|prepare|reply|set up|schedule|book|forward|introduce|sign|pay|submit)\b[^.!?\n]{0,120}/gi;

function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf('.', index) + 1, text.lastIndexOf('\n', index) + 1, 0);
  const endCandidates = ['.', '!', '?', '\n'].map((ch) => text.indexOf(ch, index + length)).filter((i) => i >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) + 1 : text.length;
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function extractCommitments(message: AnalysisMessage, reference: Date, timeZone: string): AnalyzedCommitment[] {
  const out: AnalyzedCommitment[] = [];
  const seen = new Set<string>();
  const who = message.direction === 'outbound' ? message.to[0] ?? '' : message.from;
  for (const match of message.text.matchAll(PROMISE)) {
    const sentence = sentenceAround(message.text, match.index ?? 0, match[0].length);
    const key = sentence.toLowerCase();
    if (seen.has(key) || sentence.length < 8) continue;
    seen.add(key);
    const deadline = extractDeadline(sentence, reference, timeZone);
    out.push({ direction: message.direction === 'outbound' ? 'mine' : 'theirs', who, text: sentence, due: deadline?.at ?? null });
    if (out.length >= 5) break;
  }
  return out;
}

const MEETING = /\b(?:meet(?:ing)?|call|chat|catch up|sync|zoom|google meet|coffee|interview|demo|walk ?through|hop on)\b/i;
const SCHEDULING = /\b(?:available|availability|free|find (?:a )?time|schedule|what time|which (?:day|time)|works for you|calendar|slot|when (?:are|would) you)\b/i;

/** "Could we find 30 minutes…", "can you spare an hour": asking for time is a scheduling request on its own. */
const TIME_ASK = /\b(?:find|grab|get|have|spare|book|set aside|block)\s+(?:a\s+|an\s+)?(?:few\s+|quick\s+|\d{1,3}\s?|half an\s+)?(?:min(?:ute)?s?|hours?|hr)\b/i;

/** "Are you free 1–3pm today?", "does Thursday at 2 work for you?": asking about the reader's time on a named day or hour. */
const AVAILABILITY_ASK = /\b(?:are|r) (?:you|u) (?:free|available|around)\b(?!\s+to\b)|\b(?:does|would|could)\b[^.?!\n]{1,40}\bwork for you\b|\bwhen (?:are|would) you be (?:free|available)\b/i;
const TIME_OR_DAY = new RegExp(`\\b(?:today|tomorrow|this (?:week|morning|afternoon|evening)|next week|${DAY_ALT})\\b|\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b|\\b\\d{1,2}\\s*[-–]\\s*\\d{1,2}\\b`, 'i');

export function detectMeetingRequest(text: string): { isScheduling: boolean; durationMinutes: number | null; constraints: string[] } {
  const isScheduling = (MEETING.test(text) && SCHEDULING.test(text)) || TIME_ASK.test(text) || (AVAILABILITY_ASK.test(text) && TIME_OR_DAY.test(text));
  if (!isScheduling) return { isScheduling: false, durationMinutes: null, constraints: [] };
  let duration: number | null = null;
  const minutes = text.match(/\b(\d{1,3})[\s-]?(?:min(?:ute)?s?)\b/i);
  const hours = text.match(/\b(\d(?:\.\d)?|an?|one|two)[\s-]?(?:hours?|hr)\b/i);
  if (minutes) duration = Number(minutes[1]);
  else if (/\bhalf an hour\b/i.test(text)) duration = 30;
  else if (hours) duration = Math.round((/^(an?|one)$/i.test(hours[1]!) ? 1 : /^two$/i.test(hours[1]!) ? 2 : Number(hours[1])) * 60);
  const constraints: string[] = [];
  for (const pattern of [/\bnext week\b/i, /\bthis week\b/i, /\b(?:mornings?|afternoons?|evenings?)\b/i, new RegExp(`\\b(?:${DAY_ALT})\\b`, 'i'), /\bbefore \d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i, /\bafter \d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i]) {
    const match = text.match(pattern);
    if (match) constraints.push(match[0]);
  }
  return { isScheduling, durationMinutes: duration && duration >= 5 && duration <= 480 ? duration : null, constraints: constraints.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const PROMO = /\b(?:unsubscribe|% off|\bsale\b|deal|discount|coupon|promo(?:tion)?|limited time|offer ends|shop now|free shipping)\b/i;
const NEWSLETTER = /\b(?:newsletter|digest|weekly|this week in|edition|issue #?\d+|roundup|read online|view in browser)\b/i;
const NOTIFICATION = /\b(?:receipt|order (?:confirmation|#|number)|your order|invoice|payment (?:received|confirmation)|verification code|security alert|sign-?in|password reset|has shipped|delivery|confirmation|statement is ready|automated message|do not reply)\b/i;

export function analyzeHeuristically(thread: AnalysisThread, now: Date): ThreadAnalysis {
  const zone = safeTimeZone(thread.timeZone);
  const messages = thread.messages;
  const last = messages[messages.length - 1];
  const owners = new Set(thread.ownerEmails.map((email) => email.toLowerCase()));
  const allText = messages.map((message) => message.text).join('\n\n');
  const suspicious = detectInjection(`${thread.subject}\n${allText}`);
  const summary = localThreadSummary({ subject: thread.subject, messages: messages.map((message) => ({ bodyText: message.text })) });
  const base = {
    summary: { oneLine: summary.oneLine.slice(0, 400), keyPoints: summary.keyPoints.slice(0, 5).map((point) => point.slice(0, 300)) },
    suspiciousInstructions: suspicious,
  };

  if (!last) {
    return {
      ...base,
      category: 'FYI',
      needsReply: false,
      replyExpectedFrom: 'nobody',
      priority: 'NORMAL',
      urgency: 'low',
      deadline: null,
      importanceReason: '',
      nextAction: { kind: 'none', label: '' },
      commitments: [],
      meeting: { isScheduling: false, durationMinutes: null, constraints: [] },
      confidence: 0.3,
    };
  }

  const reference = new Date(Date.parse(last.date) || now.getTime());
  const bulk = messages.some((message) => message.direction === 'inbound' && (message.isAuto || message.listUnsubscribe));
  const labels = new Set(thread.labels);
  const headText = `${thread.subject}\n${last.text.slice(0, 2_000)}`;

  const commitments = messages.flatMap((message) => extractCommitments(message, new Date(Date.parse(message.date) || now.getTime()), zone)).slice(-8);
  const meeting = detectMeetingRequest(last.text);
  const deadline = extractDeadline(last.text, reference, zone) ?? extractDeadline(thread.subject, reference, zone);

  // A person writing to the owner with a request is not a notification, whatever the subject says.
  const addressed = last.to.some((email) => owners.has(email.toLowerCase())) || (last.to.length === 0 && last.cc.length === 0);
  const personalRequest = last.direction === 'inbound' && !bulk && !last.isAuto && addressed && looksLikeRequest(last.text);

  let category: ThreadCategory;
  let needsReply = false;
  let replyExpectedFrom: ThreadAnalysis['replyExpectedFrom'] = 'nobody';
  let confidence = 0.6;

  if (last.direction === 'outbound') {
    replyExpectedFrom = looksLikeRequest(last.text) ? 'them' : 'nobody';
    category = replyExpectedFrom === 'them' ? 'WAITING' : 'FYI';
    confidence = 0.65;
  } else if (labels.has('CATEGORY_PROMOTIONS') || (bulk && PROMO.test(headText))) {
    category = 'PROMOTIONS';
    confidence = 0.85;
  } else if (bulk && NEWSLETTER.test(headText)) {
    category = 'NEWS';
    confidence = 0.75;
  } else if (last.isAuto || (NOTIFICATION.test(thread.subject) && !personalRequest) || (bulk && !looksLikeRequest(last.text)) || labels.has('CATEGORY_UPDATES')) {
    category = 'NOTIFICATIONS';
    confidence = 0.7;
  } else {
    needsReply = looksLikeRequest(last.text) && addressed;
    replyExpectedFrom = needsReply ? 'owner' : 'nobody';
    category = needsReply ? 'RESPOND' : 'FYI';
    confidence = needsReply ? 0.65 : 0.55;
  }

  const hoursLeft = deadline ? (Date.parse(deadline.at) - now.getTime()) / 3_600_000 : Infinity;
  const urgentWords = /\b(?:urgent|asap|as soon as possible|immediately|right away|time[- ]sensitive)\b/i.test(headText);
  const actionable = category === 'RESPOND' || category === 'WAITING';
  const urgency: Urgency = !actionable && category !== 'FYI' ? 'low' : urgentWords || hoursLeft < 24 ? (actionable ? 'critical' : 'high') : hoursLeft < 72 ? 'high' : 'normal';
  const priority = category === 'PROMOTIONS' || category === 'NEWS' ? 'LOW' : urgentWords || (actionable && hoursLeft < 48) ? 'HIGH' : 'NORMAL';

  let nextAction: ThreadAnalysis['nextAction'] = { kind: 'none', label: '' };
  if (category === 'RESPOND') nextAction = meeting.isScheduling ? { kind: 'schedule', label: 'Propose times' } : { kind: 'reply', label: 'Reply' };
  else if (category === 'WAITING') nextAction = { kind: 'wait', label: 'Wait for a reply' };
  else if (commitments.some((item) => item.direction === 'mine')) nextAction = { kind: 'send_deliverable', label: 'Do what you promised' };
  else if (category === 'PROMOTIONS' || category === 'NEWS') nextAction = { kind: 'read_later', label: 'Read later' };

  const reasons: string[] = [];
  if (needsReply) reasons.push('Asks you directly');
  if (deadline?.explicit) reasons.push(`Deadline ${deadline.label}`);
  if (urgentWords) reasons.push('Marked urgent');
  if (meeting.isScheduling) reasons.push('Wants to find a time');

  return {
    ...base,
    category,
    needsReply,
    replyExpectedFrom,
    priority,
    urgency,
    deadline,
    importanceReason: reasons.join(' · ').slice(0, 300),
    nextAction,
    commitments,
    meeting,
    confidence,
  };
}
