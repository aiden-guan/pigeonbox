import type { SourceRef } from '@pigeonbox/api-contract';

export type ContextItem = {
  ref: SourceRef;
  text: string;
  confidence: number;
  importance: number;
  semantic: number;
  recipientMatch: boolean;
  threadMatch: boolean;
  openLoop: boolean;
  at: string;
  validUntil: string | null;
  durable: boolean;
  status: 'active' | 'superseded';
  /** Live-only provenance; never serialized or persisted as ranking data. */
  subject?: { type: 'self' | 'person' | 'topic'; key: string; label: string };
  assertion?: string;
  revision?: string;
  entityMatch?: boolean;
  calendar?: { rowId: string; liveEventId?: string; start: string; end: string; allDay: boolean; location: string | null; refreshedAt: string; version: string | null };
  interaction?: { email: string; name: string; direction: 'in' | 'out'; threadRowId: string };
  /** Structured facts for callers that compare values deterministically (real-time checks); prompts use `text`. */
  fact?: { concept: { topic: string; attribute: string } | null; corrected: boolean; replaces: boolean; kind: string };
  commitment?: { direction: 'mine' | 'theirs'; dueAt: string | null; counterparty: string | null; text: string; threadRowId: string };
};
export const queryTerms = (text: string) =>
  [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
        (word) => !new Set(['the', 'and', 'for', 'you', 'your', 'about', 'with', 'this', 'that', 'hello', 'question', 'please', 'wanted', 'thanks']).has(word),
      ),
    ),
  ].slice(0, 12);

export function rankContext(item: ContextItem, now: Date, query: string): number {
  if (item.status !== 'active' || item.confidence < 0.8 || (item.validUntil && Date.parse(item.validUntil) <= now.getTime())) return -Infinity;
  const age = Math.max(0, (now.getTime() - Date.parse(item.at)) / 86_400_000);
  const decay = Math.exp(-age / (item.durable ? 365 : 30));
  const terms = queryTerms(query);
  const overlap = terms.filter((term) => item.text.toLowerCase().includes(term)).length / Math.max(1, terms.length);
  // Recipient is stronger than a slightly better vector. Open promises and
  // current thread beat background facts. Stable roles decay more slowly.
  return (
    (item.threadMatch ? 12 : 0) +
    (item.recipientMatch ? 10 : 0) +
    (item.openLoop ? 8 : 0) +
    Math.max(0, item.semantic) * 4 +
    overlap * 5 +
    item.importance * 2 +
    item.confidence +
    decay * 2 -
    (1 - decay) * 3
  );
}
export function contextTokens(item: ContextItem): number {
  // Conservative upper bound for arbitrary Unicode (including dense CJK).
  return Math.ceil(new TextEncoder().encode(JSON.stringify({ id: item.ref.id, kind: item.ref.kind, title: item.ref.title, text: item.text })).length / 2) + 12;
}
export function selectContext(items: ContextItem[], input: { now: Date; query: string; maxTokens: number; maxItems?: number }): ContextItem[] {
  const ranked = items
    .map((item) => ({ item, score: rankContext(item, input.now, input.query) }))
    .filter(({ score }) => Number.isFinite(score) && score > 3)
    .sort((a, b) => b.score - a.score || a.item.ref.id.localeCompare(b.item.ref.id));
  const out: ContextItem[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const { item } of ranked) {
    const key = item.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const tokens = contextTokens(item);
    if (seen.has(key) || used + tokens > input.maxTokens) continue;
    out.push(item);
    seen.add(key);
    used += tokens;
    if (out.length >= Math.min(12, input.maxItems ?? 10)) break;
  }
  return out;
}
