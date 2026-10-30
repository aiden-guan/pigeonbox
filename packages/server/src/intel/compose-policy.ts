import type { ComposeCheckResponse } from '@pigeonbox/api-contract';

/**
 * Per-category policy for compose notices. Ambient notices are interruptions,
 * so each category has its own minimum confidence: a hard contradiction backed
 * by the calendar or a corrected fact needs less than an optional "helpful"
 * aside. These defaults are the thresholds the validators and prompts already
 * use; the table makes them one place to read and tune.
 *
 * Operators may tighten a category or turn it off without a release:
 *
 *   COMPOSE_NOTICE_POLICY="helpful_context=0.98,writing_suggestion=off"
 *
 * Values can only raise a threshold. Lowering one trades precision for recall
 * and needs a code change with an eval run, not a config edit. Unparseable
 * entries are ignored (the default stays) and reported.
 */

export type NoticeKind = Extract<ComposeCheckResponse, { status: 'notice' }>['kind'];

export const DEFAULT_NOTICE_POLICY: Readonly<Record<NoticeKind, number>> = {
  calendar_conflict: 0.9,
  commitment_conflict: 0.9,
  fact_conflict: 0.9,
  context: 0.93,
  overlooked_context: 0.93,
  helpful_context: 0.96,
  writing_suggestion: 0.96,
};

export type NoticePolicy = { minConfidence: Record<NoticeKind, number>; off: ReadonlySet<NoticeKind>; invalid: string[] };

export function parseNoticePolicy(value: string | undefined): NoticePolicy {
  const minConfidence = { ...DEFAULT_NOTICE_POLICY };
  const off = new Set<NoticeKind>();
  const invalid: string[] = [];
  for (const entry of (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const [name = '', setting = ''] = entry.split('=').map((part) => part.trim().toLowerCase());
    if (!(name in DEFAULT_NOTICE_POLICY)) {
      invalid.push(name.slice(0, 40) || 'empty');
      continue;
    }
    const kind = name as NoticeKind;
    if (setting === 'off') {
      off.add(kind);
      continue;
    }
    const number = Number(setting);
    if (!Number.isFinite(number) || number > 1) invalid.push(kind);
    else minConfidence[kind] = Math.max(DEFAULT_NOTICE_POLICY[kind], number);
  }
  return { minConfidence, off, invalid };
}

/** The last gate before a notice leaves the server. A held-back notice keeps any completion. */
export function applyNoticePolicy(response: ComposeCheckResponse, policy: NoticePolicy | undefined): { response: ComposeCheckResponse; held: boolean } {
  if (response.status !== 'notice') return { response, held: false };
  const rules = policy ?? { minConfidence: DEFAULT_NOTICE_POLICY, off: new Set<NoticeKind>() };
  if (!rules.off.has(response.kind) && response.confidence >= rules.minConfidence[response.kind]) return { response, held: false };
  return { response: response.completion ? { status: 'none', completion: response.completion } : { status: 'none' }, held: true };
}

/** Content-free buckets for outcome logs; a raw confidence or latency per notice is not needed for tuning. */
export function confidenceBucket(confidence: number): string {
  if (confidence >= 0.98) return 'c98_100';
  if (confidence >= 0.95) return 'c95_97';
  if (confidence >= 0.9) return 'c90_94';
  return 'c_below_90';
}

export function latencyBucket(ms: number): string {
  if (ms < 500) return 'l0_500';
  if (ms < 1_000) return 'l500_1000';
  if (ms < 2_000) return 'l1000_2000';
  if (ms < 4_000) return 'l2000_4000';
  return 'l4000_plus';
}
