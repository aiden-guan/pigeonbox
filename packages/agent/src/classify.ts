import type { ClassificationResult, ThreadCategory, Priority } from '@pigeonbox/shared';
import type { StructuredRule } from '@pigeonbox/mailbox';

export type HeuristicInput = {
  subject: string;
  snippet: string;
  bodyText: string;
  latestSenderEmail: string;
  direction: 'inbound' | 'outbound';
  gmailCategoryHint?: string;
  hasListUnsubscribe?: boolean;
  isNoreply?: boolean;
  previouslyContacted?: boolean;
  userIsLatestMeaningfulSender?: boolean;
};

const NOTIFICATION_PATTERNS =
  /receipt|invoice|shipped|tracking|password reset|verify your|security alert|two-factor|2fa|login attempt|order confirmed|payment received/i;
const PROMO_PATTERNS =
  /unsubscribe|% off|sale|deal|newsletter|limited time|promo|marketing|view in browser/i;
const NEWS_PATTERNS = /daily digest|weekly digest|newsletter|morning briefing|top stories/i;

/**
 * Stage 1 deterministic heuristics.
 * Rule priority applied separately: explicit user > sender/domain > heuristic > AI.
 */
export function classifyHeuristic(input: HeuristicInput): ClassificationResult | null {
  const sender = input.latestSenderEmail.toLowerCase();
  const text = `${input.subject}\n${input.snippet}\n${input.bodyText}`.slice(0, 8000);

  if (input.userIsLatestMeaningfulSender || input.direction === 'outbound') {
    return {
      category: 'WAITING',
      confidence: 0.85,
      priority: 'NORMAL',
      needsReply: false,
      waitingOnReply: true,
      archiveRecommendation: false,
      reason: 'User sent the latest meaningful message',
      deadline: null,
    };
  }

  if (input.isNoreply || /no[-_]?reply|donotreply|notifications?@/i.test(sender)) {
    return {
      category: 'NOTIFICATIONS',
      confidence: 0.9,
      priority: 'LOW',
      needsReply: false,
      waitingOnReply: false,
      archiveRecommendation: true,
      reason: 'Automated / noreply sender',
      deadline: null,
    };
  }

  if (input.hasListUnsubscribe && PROMO_PATTERNS.test(text)) {
    return {
      category: 'PROMOTIONS',
      confidence: 0.82,
      priority: 'LOW',
      needsReply: false,
      waitingOnReply: false,
      archiveRecommendation: true,
      reason: 'List-Unsubscribe + marketing patterns',
      deadline: null,
    };
  }

  if (input.gmailCategoryHint) {
    const hint = input.gmailCategoryHint.toLowerCase();
    if (hint.includes('promo')) {
      return cat('PROMOTIONS', 0.8, 'LOW', false, true, 'Gmail category hint: promotions');
    }
    if (hint.includes('social')) {
      return cat('NOTIFICATIONS', 0.75, 'LOW', false, true, 'Gmail category hint: social');
    }
    if (hint.includes('update')) {
      return cat('NOTIFICATIONS', 0.75, 'LOW', false, true, 'Gmail category hint: updates');
    }
    if (hint.includes('forum')) {
      return cat('FYI', 0.7, 'LOW', false, false, 'Gmail category hint: forums');
    }
  }

  if (NOTIFICATION_PATTERNS.test(text)) {
    return cat('NOTIFICATIONS', 0.78, 'LOW', false, true, 'Transactional/notification patterns');
  }
  if (NEWS_PATTERNS.test(text) && input.hasListUnsubscribe) {
    return cat('NEWS', 0.8, 'LOW', false, true, 'Editorial digest patterns');
  }
  if (PROMO_PATTERNS.test(text)) {
    return cat('PROMOTIONS', 0.75, 'LOW', false, true, 'Marketing patterns');
  }

  if (needsReplyHeuristic(text, input.direction)) {
    return {
      category: 'RESPOND',
      confidence: 0.72,
      priority: input.previouslyContacted ? 'HIGH' : 'NORMAL',
      needsReply: true,
      waitingOnReply: false,
      archiveRecommendation: false,
      reason: 'Inbound message appears to ask a question or request action',
      deadline: null,
    };
  }

  // Useful informational inbound without clear ask
  if (input.direction === 'inbound') {
    return {
      category: 'FYI',
      confidence: 0.55,
      priority: 'NORMAL',
      needsReply: false,
      waitingOnReply: false,
      archiveRecommendation: false,
      reason: 'Inbound informational; no clear response required',
      deadline: null,
    };
  }

  return null;
}

function cat(
  category: ThreadCategory,
  confidence: number,
  priority: Priority,
  needsReply: boolean,
  archiveRecommendation: boolean,
  reason: string,
): ClassificationResult {
  return {
    category,
    confidence,
    priority,
    needsReply,
    waitingOnReply: false,
    archiveRecommendation,
    reason,
    deadline: null,
  };
}

export function needsReplyHeuristic(text: string, direction: 'inbound' | 'outbound'): boolean {
  if (direction !== 'inbound') return false;
  if (NOTIFICATION_PATTERNS.test(text) || PROMO_PATTERNS.test(text)) return false;
  return /(\?|please (confirm|review|send|reply|let me know)|can you|could you|would you|asap|by (eod|friday|monday)|looking forward to hearing)/i.test(
    text,
  );
}

export function detectNeedsReply(input: HeuristicInput): {
  needsReply: boolean;
  confidence: number;
  reason: string;
} {
  if (input.direction === 'outbound' || input.userIsLatestMeaningfulSender) {
    return { needsReply: false, confidence: 0.9, reason: 'User is awaiting a reply' };
  }
  if (input.isNoreply || NOTIFICATION_PATTERNS.test(input.bodyText) || PROMO_PATTERNS.test(input.bodyText)) {
    return { needsReply: false, confidence: 0.88, reason: 'Automated or marketing content' };
  }
  if (needsReplyHeuristic(`${input.subject}\n${input.bodyText}`, input.direction)) {
    return { needsReply: true, confidence: 0.75, reason: 'Contains question or action request' };
  }
  return { needsReply: false, confidence: 0.6, reason: 'No clear ask detected' };
}

export function applyRules(
  input: HeuristicInput,
  rules: StructuredRule[],
): ClassificationResult | null {
  const domain = input.latestSenderEmail.split('@')[1]?.toLowerCase() || '';
  const email = input.latestSenderEmail.toLowerCase();

  for (const rule of rules) {
    if (rule.kind === 'force_category') {
      const matchVal = rule.value.toLowerCase();
      if (
        (rule.match === 'sender' && email === matchVal) ||
        (rule.match === 'domain' && domain === matchVal)
      ) {
        return {
          category: rule.category,
          confidence: 1,
          priority: rule.category === 'RESPOND' ? 'HIGH' : 'NORMAL',
          needsReply: rule.category === 'RESPOND',
          waitingOnReply: rule.category === 'WAITING',
          archiveRecommendation: ['NOTIFICATIONS', 'PROMOTIONS', 'NEWS'].includes(rule.category),
          reason: `User rule: force ${rule.category}`,
          deadline: null,
        };
      }
    }
  }
  return null;
}

export function archiveDecision(opts: {
  category: ThreadCategory;
  confidence: number;
  senderEmail: string;
  archiveCategories: ThreadCategory[];
  threshold: number;
  alwaysArchive: string[];
  neverArchive: string[];
  rules: StructuredRule[];
  /** A model's self-reported confidence cannot authorize a mailbox mutation. */
  modelDerived?: boolean;
}): { shouldArchive: boolean; reason: string; autonomous: boolean } {
  const email = opts.senderEmail.toLowerCase();
  const domain = email.split('@')[1] || '';

  for (const rule of opts.rules) {
    if (rule.kind === 'never_archive_sender' && rule.email === email) {
      return { shouldArchive: false, reason: 'Rule: never archive sender', autonomous: false };
    }
    if (rule.kind === 'never_archive_domain' && rule.domain === domain) {
      return { shouldArchive: false, reason: 'Rule: never archive domain', autonomous: false };
    }
    if (rule.kind === 'keep_inbox_domain' && rule.domain === domain) {
      return { shouldArchive: false, reason: 'Rule: keep inbox domain', autonomous: false };
    }
  }

  if (opts.neverArchive.some((x) => x.toLowerCase() === email || x.toLowerCase() === domain)) {
    return { shouldArchive: false, reason: 'Never-archive list', autonomous: false };
  }

  for (const rule of opts.rules) {
    if (rule.kind === 'always_archive_sender' && rule.email === email) {
      return { shouldArchive: true, reason: 'Rule: always archive sender', autonomous: true };
    }
    if (rule.kind === 'always_archive_domain' && rule.domain === domain) {
      return { shouldArchive: true, reason: 'Rule: always archive domain', autonomous: true };
    }
  }

  if (opts.alwaysArchive.some((x) => x.toLowerCase() === email || x.toLowerCase() === domain)) {
    return { shouldArchive: true, reason: 'Always-archive list', autonomous: true };
  }

  // Never default-archive RESPOND, WAITING, FYI
  if (opts.category === 'RESPOND' || opts.category === 'WAITING' || opts.category === 'FYI') {
    return { shouldArchive: false, reason: 'Protected category', autonomous: false };
  }

  if (!opts.archiveCategories.includes(opts.category)) {
    return { shouldArchive: false, reason: 'Category not eligible', autonomous: false };
  }

  if (opts.confidence >= opts.threshold) {
    return {
      shouldArchive: true,
      reason: `Category ${opts.category} above threshold`,
      autonomous: !opts.modelDerived,
    };
  }

  return {
    shouldArchive: true,
    reason: `Recommend archive (${opts.category}) but confidence below threshold`,
    autonomous: false,
  };
}

export function parseNaturalLanguageRule(text: string): StructuredRule | null {
  const t = text.trim();
  const neverArchDomain = t.match(/never archive\s+(\S+\.\w+)/i);
  if (neverArchDomain) {
    return { kind: 'never_archive_domain', domain: neverArchDomain[1]!.toLowerCase() };
  }
  const alwaysArchDomain = t.match(/always archive\s+(\S+\.\w+)/i);
  if (alwaysArchDomain) {
    return { kind: 'always_archive_domain', domain: alwaysArchDomain[1]!.toLowerCase() };
  }
  const forceImportant = t.match(/always treat\s+(.+?)\s+as important/i);
  if (forceImportant) {
    const value = forceImportant[1]!.trim().toLowerCase();
    if (value.includes('.')) {
      return { kind: 'priority_domain', domain: value, priority: 'HIGH' };
    }
  }
  const professors = t.match(/professors? stay in inbox|keep\s+(\S+\.\w+)\s+in inbox/i);
  if (professors) {
    const domain = professors[1]?.toLowerCase() || 'edu';
    return { kind: 'keep_inbox_domain', domain: domain === 'edu' ? 'berkeley.edu' : domain };
  }
  const forceCat = t.match(/treat\s+(\S+)\s+as\s+(respond|waiting|fyi|notifications|promotions|news)/i);
  if (forceCat) {
    const value = forceCat[1]!.toLowerCase();
    const category = forceCat[2]!.toUpperCase() as ThreadCategory;
    return {
      kind: 'force_category',
      match: value.includes('@') ? 'sender' : 'domain',
      value,
      category,
    };
  }
  return null;
}

export function computePriority(input: {
  requiresResponse: boolean;
  senderKnown: boolean;
  previouslyEmailed: boolean;
  isList: boolean;
  hasDeadline: boolean;
  priorityDomain: boolean;
}): { priority: Priority; explanation: string } {
  const reasons: string[] = [];
  let score = 0;
  if (input.requiresResponse) {
    score += 3;
    reasons.push('requires response');
  }
  if (input.priorityDomain) {
    score += 2;
    reasons.push('priority domain');
  }
  if (input.previouslyEmailed || input.senderKnown) {
    score += 1;
    reasons.push('known contact');
  }
  if (input.hasDeadline) {
    score += 2;
    reasons.push('deadline mentioned');
  }
  if (input.isList) {
    score -= 2;
    reasons.push('list/broadcast');
  }
  const priority: Priority = score >= 4 ? 'HIGH' : score <= 0 ? 'LOW' : 'NORMAL';
  return {
    priority,
    explanation: reasons.length ? reasons.join('; ') : 'default priority',
  };
}
