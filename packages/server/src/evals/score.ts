/**
 * Scoring for the AI evals. The fact checker here is deliberately independent
 * of the production grounding guard (`intel/grounding.ts`), so the evals do
 * not grade the guard with its own rules.
 */

export type Check = { name: string; pass: boolean; detail?: string };
export type FixtureResult = { id: string; kind: string; checks: Check[] };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Concrete facts a reader would rely on: money, times, dates, addresses, links, numbers with units. */
export function extractFacts(text: string): Array<{ kind: string; raw: string; key: string }> {
  const withoutPlaceholders = text.replace(/\[[A-Z][A-Z ]+\]/g, ' ');
  const facts: Array<{ kind: string; raw: string; key: string }> = [];
  const add = (kind: string, raw: string, key: string) => facts.push({ kind, raw, key });
  for (const m of withoutPlaceholders.matchAll(/[$€£]\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m)?/gi)) add('money', m[0], `money:${m[1]!.replace(/,/g, '')}${(m[2] ?? '').toLowerCase()}`);
  for (const m of withoutPlaceholders.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/gi)) {
    let hour = Number(m[1]) % 12;
    if (m[3]!.toLowerCase() === 'pm') hour += 12;
    add('time', m[0], `time:${hour}:${m[2] ?? '00'}`);
  }
  for (const m of withoutPlaceholders.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) add('date', m[0], `date:${Number(m[1])}/${Number(m[2])}`);
  const monthPattern = new RegExp(`\\b(${MONTHS.map((month) => month.slice(0, 3)).join('|')})[a-z]*\\.?\\s+(\\d{1,2})\\b`, 'gi');
  for (const m of withoutPlaceholders.matchAll(monthPattern)) add('date', m[0], `date:${MONTHS.findIndex((month) => month.startsWith(m[1]!.toLowerCase())) + 1}/${Number(m[2])}`);
  for (const m of withoutPlaceholders.matchAll(/\bhttps?:\/\/[^\s)>\]]+/gi)) add('link', m[0], `link:${m[0].toLowerCase().replace(/[/.]+$/, '')}`);
  for (const m of withoutPlaceholders.matchAll(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g)) add('email', m[0], `email:${m[0].toLowerCase()}`);
  for (const m of withoutPlaceholders.matchAll(/\b(\d[\d,]*)\s?(%|percent|seats?|users?|days?|weeks?|months?|hours?)\b/gi)) add('quantity', m[0], `quantity:${m[1]!.replace(/,/g, '')}${m[2]!.toLowerCase().replace(/s$/, '').replace('percent', '%')}`);
  return facts;
}

/** Facts in `draft` that do not appear anywhere in `context` (and that `allow` does not vouch for). */
export function unsupportedFacts(draft: string, context: string, allow: (fact: { kind: string; raw: string; key: string }) => boolean = () => false): string[] {
  const known = new Set(extractFacts(context).map((fact) => fact.key));
  return extractFacts(draft)
    .filter((fact) => !known.has(fact.key) && !allow(fact))
    .map((fact) => fact.raw);
}

export function placeholderKinds(text: string): Set<string> {
  const kinds = new Set<string>();
  for (const [, words] of text.matchAll(/\[([A-Z][A-Z ]+)\]/g)) {
    const w = words!.toLowerCase();
    if (/date|day|deadline|when/.test(w)) kinds.add('date');
    if (/time|slot/.test(w)) kinds.add('time');
    if (/price|amount|cost|fee|total|discount|rate/.test(w)) kinds.add('amount');
    if (/attach|file|resume|document/.test(w)) kinds.add('attachment');
    if (/link|url/.test(w)) kinds.add('link');
    if (/address|location/.test(w)) kinds.add('address');
    if (/name/.test(w)) kinds.add('name');
    if (/number|count/.test(w)) kinds.add('number');
    kinds.add('any');
  }
  return kinds;
}

export function jaccard(a: string, b: string): number {
  const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, left.size + right.size - shared);
}

/** A metric can name the AI operation whose output it grades, so telemetry can show a pass rate per operation. */
export type Metric = { name: string; passed: number; total: number; threshold: number; safety: boolean; operation?: string };

/** Aggregate named checks across fixtures into metrics. */
export function metrics(results: FixtureResult[], thresholds: Record<string, { threshold: number; safety?: boolean; operation?: string }>): Metric[] {
  return Object.entries(thresholds).map(([name, config]) => {
    const checks = results.flatMap((result) => result.checks.filter((check) => check.name === name));
    return { name, passed: checks.filter((check) => check.pass).length, total: checks.length, threshold: config.threshold, safety: Boolean(config.safety), operation: config.operation };
  });
}

/** The operational fields of a usage record. Usage records have no content fields. */
export type UsageSample = { operation: string; model: string | null; status: string; latencyMs: number; inputTokens: number; outputTokens: number; estimatedCostMicros: number };

/**
 * Per model and operation: calls (a structured call includes its repair
 * round trip), errors, tokens, latency, estimated cost and the pass rate of
 * the metrics that grade that operation.
 */
export function telemetryReport(samples: UsageSample[], rows: Metric[]): string {
  const groups = new Map<string, UsageSample[]>();
  for (const sample of samples) {
    const key = `${sample.model ?? '(none)'}\t${sample.operation.replace(/^intel\./, '')}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const header = `${'model'.padEnd(30)} ${'operation'.padEnd(18)} ${'calls'.padStart(5)} ${'err'.padStart(4)} ${'in tok'.padStart(9)} ${'out tok'.padStart(8)} ${'p50 ms'.padStart(7)} ${'p95 ms'.padStart(7)} ${'est $'.padStart(9)}  eval`;
  const lines = ['\nModel telemetry (usage records; no content)', '─'.repeat(header.length), header];
  const total = { calls: 0, errors: 0, input: 0, output: 0, cost: 0 };
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [model, operation] = key.split('\t') as [string, string];
    const latency = group.map((sample) => sample.latencyMs).sort((a, b) => a - b);
    const pick = (q: number) => latency[Math.min(latency.length - 1, Math.floor(q * latency.length))]!;
    const errors = group.filter((sample) => sample.status !== 'ok').length;
    const input = group.reduce((sum, sample) => sum + sample.inputTokens, 0);
    const output = group.reduce((sum, sample) => sum + sample.outputTokens, 0);
    const cost = group.reduce((sum, sample) => sum + sample.estimatedCostMicros, 0);
    const graded = rows.filter((row) => row.operation === operation);
    const passed = graded.reduce((sum, row) => sum + row.passed, 0);
    const checks = graded.reduce((sum, row) => sum + row.total, 0);
    const score = checks ? `${((passed / checks) * 100).toFixed(0)}% (${passed}/${checks})` : '—';
    lines.push(
      `${model.slice(0, 30).padEnd(30)} ${operation.padEnd(18)} ${String(group.length).padStart(5)} ${String(errors).padStart(4)} ${input.toLocaleString('en-US').padStart(9)} ${output.toLocaleString('en-US').padStart(8)} ${String(pick(0.5)).padStart(7)} ${String(pick(0.95)).padStart(7)} ${(cost / 1e6).toFixed(4).padStart(9)}  ${score}`,
    );
    total.calls += group.length;
    total.errors += errors;
    total.input += input;
    total.output += output;
    total.cost += cost;
  }
  lines.push(
    `${'total'.padEnd(49)} ${String(total.calls).padStart(5)} ${String(total.errors).padStart(4)} ${total.input.toLocaleString('en-US').padStart(9)} ${total.output.toLocaleString('en-US').padStart(8)} ${''.padStart(15)} ${(total.cost / 1e6).toFixed(4).padStart(9)}`,
  );
  return lines.join('\n');
}

export function report(title: string, rows: Metric[], results: FixtureResult[]): string {
  const lines = [`\n${title}`, '─'.repeat(64)];
  for (const row of rows) {
    if (!row.total) {
      lines.push(`— ${row.name.padEnd(34)}     0/0   N/A (not exercised)`);
      continue;
    }
    const rate = row.total ? row.passed / row.total : 1;
    const ok = rate >= row.threshold;
    lines.push(`${ok ? '✓' : '✗'} ${row.name.padEnd(34)} ${`${row.passed}/${row.total}`.padStart(7)}  ${(rate * 100).toFixed(0).padStart(3)}%  (≥ ${(row.threshold * 100).toFixed(0)}%${row.safety ? ', safety' : ''})`);
  }
  const failures = results.flatMap((result) => result.checks.filter((check) => !check.pass).map((check) => `  ${result.id}: ${check.name}${check.detail ? ` (${check.detail})` : ''}`));
  if (failures.length) lines.push('', 'Misses:', ...failures);
  return lines.join('\n');
}
