import type { ClassificationRow, ThreadRow } from './types.js';

/**
 * Importance ranking for the split inbox: a small logistic model that runs in
 * the browser, so sorting costs nothing and no mail leaves the computer for it.
 *
 * It starts from hand-set weights over what the classifier already decided
 * (category, priority, needs-reply, deadline) plus who the mail is from, and
 * learns from what the person does: moving a thread to Respond or FYI, opening
 * it from PigeonBox, archiving it. Senders and domains also keep their own
 * tallies, so "mail from Alice matters" is learned after a couple of moves.
 */

export const IMPORTANCE_FEATURES = [
  'bias',
  'respond',
  'waiting',
  'fyi',
  'bulk',
  'high',
  'low',
  'needsReply',
  'deadline',
  'repliedBefore',
  'recency',
  'thread',
  'sender',
  'domain',
] as const;
export type ImportanceFeature = (typeof IMPORTANCE_FEATURES)[number];
export type ImportanceVector = Record<ImportanceFeature, number>;

type Tally = { up: number; down: number };
export type ImportanceModel = {
  version: 1;
  weights: ImportanceVector;
  senders: Record<string, Tally>;
  domains: Record<string, Tally>;
  updates: number;
};

/** Signals the person gives, as soft labels: 1 means "this mattered". */
export const IMPORTANCE_SIGNALS = {
  moved_respond: 1,
  opened: 0.85,
  moved_waiting: 0.6,
  moved_fyi: 0.15,
  archived: 0.05,
} as const;
export type ImportanceSignal = keyof typeof IMPORTANCE_SIGNALS;

/** Sensible from day one: needs-reply and people you write to first, bulk mail last. */
export const DEFAULT_IMPORTANCE_WEIGHTS: ImportanceVector = {
  bias: -0.4,
  respond: 1.4,
  waiting: 0.3,
  fyi: -0.4,
  bulk: -1.6,
  high: 1.2,
  low: -0.8,
  needsReply: 0.9,
  deadline: 0.7,
  repliedBefore: 0.8,
  recency: 1.1,
  thread: 0.2,
  sender: 2.2,
  domain: 1,
};

const LEARNING_RATE = 0.15;
const L2 = 0.002;
const MAX_KEYS = 2_000;
/** Mail providers say nothing about how much a sender matters. */
const SHARED_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com']);

export function emptyImportanceModel(): ImportanceModel {
  return { version: 1, weights: { ...DEFAULT_IMPORTANCE_WEIGHTS }, senders: {}, domains: {}, updates: 0 };
}

/** Reads a stored model, falling back to defaults for anything missing or malformed. */
export function importanceModel(value: unknown): ImportanceModel {
  const row = value as Partial<ImportanceModel> | null | undefined;
  if (!row || row.version !== 1) return emptyImportanceModel();
  const weights = { ...DEFAULT_IMPORTANCE_WEIGHTS };
  for (const name of IMPORTANCE_FEATURES) {
    const weight = row.weights?.[name];
    if (typeof weight === 'number' && Number.isFinite(weight)) weights[name] = Math.max(-6, Math.min(6, weight));
  }
  const tallies = (input: unknown): Record<string, Tally> => {
    const out: Record<string, Tally> = {};
    for (const [key, tally] of Object.entries((input as Record<string, Tally>) ?? {})) {
      if (typeof tally?.up === 'number' && typeof tally?.down === 'number' && Number.isFinite(tally.up) && Number.isFinite(tally.down))
        out[key] = { up: Math.max(0, tally.up), down: Math.max(0, tally.down) };
    }
    return out;
  };
  return { version: 1, weights, senders: tallies(row.senders), domains: tallies(row.domains), updates: Number(row.updates) || 0 };
}

export function senderDomain(email: string | undefined): string | null {
  const domain = email?.toLowerCase().split('@')[1]?.trim();
  return domain && !SHARED_DOMAINS.has(domain) ? domain : null;
}

/** -0.5 (always dismissed) … +0.5 (always acted on); 0 with no history. */
function affinity(tally: Tally | undefined): number {
  if (!tally) return 0;
  return (tally.up + 1) / (tally.up + tally.down + 2) - 0.5;
}

export type ImportanceInput = Pick<ThreadRow, 'classification' | 'priority' | 'requiresResponse' | 'latestTimestamp' | 'messageCount' | 'latestSender'> & {
  deadline?: ClassificationRow['deadline'];
};

export function importanceFeatures(
  thread: ImportanceInput,
  context: { model: ImportanceModel; repliedTo: ReadonlySet<string>; now: number },
): ImportanceVector {
  const sender = thread.latestSender?.email?.toLowerCase() ?? '';
  const domain = senderDomain(sender);
  const ageHours = Math.max(0, (context.now - Date.parse(thread.latestTimestamp)) / 3_600_000);
  const category = thread.classification;
  return {
    bias: 1,
    respond: category === 'RESPOND' ? 1 : 0,
    waiting: category === 'WAITING' ? 1 : 0,
    fyi: category === 'FYI' ? 1 : 0,
    bulk: category === 'NOTIFICATIONS' || category === 'PROMOTIONS' || category === 'NEWS' ? 1 : 0,
    high: thread.priority === 'HIGH' ? 1 : 0,
    low: thread.priority === 'LOW' ? 1 : 0,
    needsReply: thread.requiresResponse ? 1 : 0,
    deadline: thread.deadline ? 1 : 0,
    repliedBefore: sender && context.repliedTo.has(sender) ? 1 : 0,
    // Half-life of two days; unknown dates count as old.
    recency: Number.isFinite(ageHours) ? Math.pow(0.5, ageHours / 48) : 0,
    thread: Math.min(1, Math.log1p(Math.max(0, thread.messageCount - 1)) / Math.log(8)),
    sender: affinity(context.model.senders[sender]),
    domain: domain ? affinity(context.model.domains[domain]) : 0,
  };
}

export function importanceScore(model: ImportanceModel, features: ImportanceVector): number {
  let z = 0;
  for (const name of IMPORTANCE_FEATURES) z += model.weights[name] * features[name];
  return 1 / (1 + Math.exp(-z));
}

/** The biggest reasons a thread ranks where it does, for a short explanation. */
export function importanceReasons(model: ImportanceModel, features: ImportanceVector): string[] {
  const labels: Partial<Record<ImportanceFeature, string>> = {
    respond: 'Needs your reply',
    high: 'High priority',
    needsReply: 'Asks you something',
    deadline: 'Has a deadline',
    repliedBefore: 'Someone you write to',
    recency: 'Recent',
    sender: 'Sender you act on',
    domain: 'From an organization you act on',
  };
  return IMPORTANCE_FEATURES.filter((name) => labels[name])
    .map((name) => ({ name, push: model.weights[name] * features[name] }))
    .filter((entry) => entry.push > 0.35)
    .sort((a, b) => b.push - a.push)
    .slice(0, 2)
    .map((entry) => labels[entry.name]!);
}

/**
 * One online step toward what the person did. Returns a new model; the
 * sender/domain tallies move at once, the shared weights move a little.
 */
export function learnImportance(model: ImportanceModel, features: ImportanceVector, signal: ImportanceSignal, sender: string | undefined): ImportanceModel {
  const label = IMPORTANCE_SIGNALS[signal];
  const error = label - importanceScore(model, features);
  const weights = { ...model.weights };
  for (const name of IMPORTANCE_FEATURES) {
    const decay = name === 'bias' ? 0 : L2 * (weights[name] - DEFAULT_IMPORTANCE_WEIGHTS[name]);
    weights[name] = Math.max(-6, Math.min(6, weights[name] + LEARNING_RATE * (error * features[name] - decay)));
  }
  const email = sender?.toLowerCase();
  const domain = senderDomain(email);
  const bump = (tallies: Record<string, Tally>, key: string | null | undefined) => {
    if (!key) return tallies;
    const current = tallies[key] ?? { up: 0, down: 0 };
    const next = { ...tallies, [key]: { up: current.up + label, down: current.down + (1 - label) } };
    const keys = Object.keys(next);
    // Forget the quietest keys rather than grow without bound.
    if (keys.length > MAX_KEYS)
      for (const stale of keys.sort((a, b) => next[a]!.up + next[a]!.down - (next[b]!.up + next[b]!.down)).slice(0, keys.length - MAX_KEYS)) delete next[stale];
    return next;
  };
  return { version: 1, weights, senders: bump(model.senders, email), domains: bump(model.domains, domain), updates: model.updates + 1 };
}

/** Most important first; ties and near-ties fall back to newest first. */
export function rankByImportance<T extends { timestamp: string; importance: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Math.round(b.importance * 50) - Math.round(a.importance * 50) || (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}
