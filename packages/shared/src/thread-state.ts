import { z } from 'zod';
import type { Priority, ThreadCategory } from './index.js';

/**
 * ThreadState: what a conversation needs from the user right now.
 *
 * It extends the RESPOND / WAITING / FYI categories instead of replacing them:
 * every state maps to exactly one category (`categoryForThreadState`), so code
 * that only understands categories keeps working, and every category maps to a
 * default state (`threadStateFromCategory`). Local mode derives it from the
 * on-device index; Cloud derives it from synced mail, follow-ups and tracking.
 */
export const THREAD_STATES = [
  'NEEDS_REPLY',
  'WAITING_ON_THEM',
  'WAITING_ON_ME',
  'FYI',
  'NOTIFICATION',
  'PROMOTION',
  'NEWS',
  'SCHEDULED',
  'FOLLOW_UP_DUE',
  'DONE',
] as const;
export const ThreadStateSchema = z.enum(THREAD_STATES);
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const UrgencySchema = z.enum(['critical', 'high', 'normal', 'low']);
export type Urgency = z.infer<typeof UrgencySchema>;

export const NextActionKindSchema = z.enum([
  'reply',
  'follow_up',
  'schedule',
  'send_deliverable',
  'review',
  'wait',
  'read_later',
  'archive',
  'none',
]);
export type NextActionKind = z.infer<typeof NextActionKindSchema>;

export const RelationshipImportanceSchema = z.enum(['vip', 'close', 'known', 'new', 'unknown']);
export type RelationshipImportance = z.infer<typeof RelationshipImportanceSchema>;

export const DeadlineSchema = z.object({
  /** ISO instant, or a local date `YYYY-MM-DD` when only the day is known. */
  at: z.string().max(40),
  /** Stated in the mail ("by Friday") rather than inferred ("next week sometime"). */
  explicit: z.boolean(),
  /** The wording the deadline came from, shortened. Never the message body. */
  label: z.string().max(200),
});
export type Deadline = z.infer<typeof DeadlineSchema>;

export const StateSourceSchema = z.enum(['model', 'heuristic', 'rule', 'user', 'system']);
export type StateSource = z.infer<typeof StateSourceSchema>;

export const ThreadStateDetailSchema = z.object({
  state: ThreadStateSchema,
  priority: z.enum(['HIGH', 'NORMAL', 'LOW']),
  urgency: UrgencySchema,
  confidence: z.number().min(0).max(1),
  deadline: DeadlineSchema.nullable(),
  importanceReason: z.string().max(300),
  relationshipImportance: RelationshipImportanceSchema,
  nextAction: z.object({ kind: NextActionKindSchema, label: z.string().max(200) }),
  source: StateSourceSchema,
  updatedAt: z.string().max(40),
});
export type ThreadStateDetail = z.infer<typeof ThreadStateDetailSchema>;

const STATE_TO_CATEGORY: Record<ThreadState, ThreadCategory> = {
  NEEDS_REPLY: 'RESPOND',
  WAITING_ON_ME: 'RESPOND',
  WAITING_ON_THEM: 'WAITING',
  FOLLOW_UP_DUE: 'WAITING',
  FYI: 'FYI',
  SCHEDULED: 'FYI',
  DONE: 'FYI',
  NOTIFICATION: 'NOTIFICATIONS',
  PROMOTION: 'PROMOTIONS',
  NEWS: 'NEWS',
};

/** The legacy category a state belongs to. Total: every state has one. */
export function categoryForThreadState(state: ThreadState): ThreadCategory {
  return STATE_TO_CATEGORY[state];
}

/** The default state for a legacy classification. */
export function threadStateFromCategory(
  category: ThreadCategory,
  flags: { needsReply?: boolean; waitingOnReply?: boolean } = {},
): ThreadState {
  switch (category) {
    case 'RESPOND':
      return 'NEEDS_REPLY';
    case 'WAITING':
      return 'WAITING_ON_THEM';
    case 'NOTIFICATIONS':
      return 'NOTIFICATION';
    case 'PROMOTIONS':
      return 'PROMOTION';
    case 'NEWS':
      return 'NEWS';
    case 'FYI':
    default:
      if (flags.needsReply) return 'NEEDS_REPLY';
      if (flags.waitingOnReply) return 'WAITING_ON_THEM';
      return 'FYI';
  }
}

export type ThreadStateInput = {
  category?: ThreadCategory | null;
  needsReply?: boolean;
  waitingOnReply?: boolean;
  /** The newest message was sent by the mailbox owner. */
  lastMessageFromOwner?: boolean;
  /** Promises the owner made in this thread that are not yet fulfilled. */
  openCommitmentsByOwner?: number;
  /** When a follow-up on this conversation becomes due. */
  followUpDueAt?: string | null;
  /** A meeting or reminder is scheduled for this thread. */
  scheduled?: boolean;
  /** The user or a rule marked the conversation done. */
  done?: boolean;
  /** An explicit user choice wins over everything derived. */
  userState?: ThreadState | null;
  now?: Date;
};

/**
 * Combine classification, direction, commitments and follow-up timing into one
 * state. Order matters: an explicit user choice, then completion, then things
 * the user must do, then things others must do.
 */
export function deriveThreadState(input: ThreadStateInput): ThreadState {
  if (input.userState) return input.userState;
  if (input.done) return 'DONE';
  const now = (input.now ?? new Date()).getTime();
  const category = input.category ?? null;
  if (category === 'PROMOTIONS') return 'PROMOTION';
  if (category === 'NEWS') return 'NEWS';
  if (category === 'NOTIFICATIONS' && !input.needsReply) return 'NOTIFICATION';

  if (input.lastMessageFromOwner) {
    const due = input.followUpDueAt ? Date.parse(input.followUpDueAt) : NaN;
    if (Number.isFinite(due) && due <= now) return 'FOLLOW_UP_DUE';
    if ((input.openCommitmentsByOwner ?? 0) > 0) return 'WAITING_ON_ME';
    if (input.scheduled) return 'SCHEDULED';
    if (input.waitingOnReply || category === 'WAITING' || Number.isFinite(due)) return 'WAITING_ON_THEM';
    return category === 'RESPOND' ? 'WAITING_ON_THEM' : 'FYI';
  }

  if (input.needsReply || category === 'RESPOND') return 'NEEDS_REPLY';
  if ((input.openCommitmentsByOwner ?? 0) > 0) return 'WAITING_ON_ME';
  if (input.scheduled) return 'SCHEDULED';
  if (category === 'WAITING' || input.waitingOnReply) return 'WAITING_ON_THEM';
  return 'FYI';
}

// ---------------------------------------------------------------------------
// Focus Queue: rank by what needs action, not by unread status.
// ---------------------------------------------------------------------------

export const FOCUS_SECTIONS = ['respond', 'follow_up', 'waiting', 'soon', 'assigned', 'fyi'] as const;
export const FocusSectionSchema = z.enum(FOCUS_SECTIONS);
export type FocusSection = z.infer<typeof FocusSectionSchema>;

export const FOCUS_SECTION_LABELS: Record<FocusSection, string> = {
  respond: 'Respond',
  follow_up: 'Follow up',
  waiting: 'Waiting',
  soon: 'Soon',
  assigned: 'Assigned',
  fyi: 'FYI',
};

export type FocusCandidate = {
  state: ThreadState;
  priority?: Priority;
  urgency?: Urgency;
  deadlineAt?: string | null;
  /** The newest inbound or outbound message. */
  lastMessageAt: string;
  relationshipImportance?: RelationshipImportance;
  assignedToMe?: boolean;
  confidence?: number;
  /** A reviewed draft is already waiting. */
  draftReady?: boolean;
  /** A follow-up became due at this instant. */
  followUpDueAt?: string | null;
  /** Human-likely recipient engagement after the user's last message. */
  recentEngagement?: boolean;
};

const DAY = 86_400_000;
const SOON_MS = 3 * DAY;

/** The one section an item appears in. Null: it does not belong in the queue. */
export function focusSectionFor(item: FocusCandidate, now: Date = new Date()): FocusSection | null {
  if (item.state === 'DONE' || item.state === 'PROMOTION' || item.state === 'NEWS' || item.state === 'NOTIFICATION') {
    return item.assignedToMe ? 'assigned' : null;
  }
  if (item.assignedToMe) return 'assigned';
  if (item.state === 'NEEDS_REPLY' || item.state === 'WAITING_ON_ME') return 'respond';
  if (item.state === 'FOLLOW_UP_DUE') return 'follow_up';
  const deadline = item.deadlineAt ? Date.parse(item.deadlineAt) : NaN;
  if (Number.isFinite(deadline) && deadline - now.getTime() <= SOON_MS) return 'soon';
  if (item.state === 'WAITING_ON_THEM') return 'waiting';
  if (item.state === 'SCHEDULED') return 'soon';
  return 'fyi';
}

const STATE_WEIGHT: Record<ThreadState, number> = {
  NEEDS_REPLY: 60,
  FOLLOW_UP_DUE: 56,
  WAITING_ON_ME: 52,
  SCHEDULED: 30,
  WAITING_ON_THEM: 18,
  FYI: 6,
  NOTIFICATION: 2,
  NEWS: 1,
  PROMOTION: 0,
  DONE: 0,
};

/**
 * A transparent urgency score with the reasons that produced it. The reasons
 * are shown to the user ("why is this here?"), so each one is a plain fact.
 */
export function focusScore(item: FocusCandidate, now: Date = new Date()): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = STATE_WEIGHT[item.state];
  const nowMs = now.getTime();

  if (item.assignedToMe) {
    score += 20;
    reasons.push('Assigned to you');
  }
  if (item.state === 'NEEDS_REPLY') reasons.push('They are waiting on your reply');
  if (item.state === 'WAITING_ON_ME') reasons.push('You promised something here');
  if (item.state === 'FOLLOW_UP_DUE') reasons.push('Your follow-up is due');

  const deadline = item.deadlineAt ? Date.parse(item.deadlineAt) : NaN;
  if (Number.isFinite(deadline)) {
    const left = deadline - nowMs;
    if (left < 0) {
      score += 30;
      reasons.push('Deadline passed');
    } else if (left <= DAY) {
      score += 26;
      reasons.push('Due within a day');
    } else if (left <= SOON_MS) {
      score += 16;
      reasons.push('Due within 3 days');
    } else if (left <= 7 * DAY) {
      score += 6;
      reasons.push('Due this week');
    }
  }
  if (item.priority === 'HIGH') {
    score += 12;
    reasons.push('Marked high priority');
  } else if (item.priority === 'LOW') {
    score -= 8;
  }
  if (item.urgency === 'critical') score += 14;
  else if (item.urgency === 'high') score += 7;

  if (item.relationshipImportance === 'vip') {
    score += 12;
    reasons.push('From someone you marked important');
  } else if (item.relationshipImportance === 'close') {
    score += 6;
    reasons.push('Someone you talk to often');
  }

  const age = nowMs - Date.parse(item.lastMessageAt);
  if (Number.isFinite(age) && (item.state === 'NEEDS_REPLY' || item.state === 'WAITING_ON_ME')) {
    const days = Math.floor(age / DAY);
    // Unanswered mail rises for a week, then plateaus so it does not bury new mail.
    score += Math.min(days, 7) * 2;
    if (days >= 2) reasons.push(`Unanswered for ${days} days`);
  }
  if (item.recentEngagement && (item.state === 'WAITING_ON_THEM' || item.state === 'FOLLOW_UP_DUE')) {
    score += 5;
    reasons.push('Recent likely recipient activity');
  }
  if (item.draftReady) reasons.push('A draft is ready to review');
  if (typeof item.confidence === 'number' && item.confidence < 0.5) {
    score -= 6;
    reasons.push('PigeonBox is not sure about this one');
  }
  return { score: Math.max(0, Math.round(score)), reasons };
}
