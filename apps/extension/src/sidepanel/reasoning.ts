import type { OrbState } from '../ui/orb-markup';

/**
 * What kind of work an Ask status line describes. The server sends one plain
 * status per tool call ("Searching Gmail: from:allen", "Reading "Pricing"");
 * these map each to a category pill, a present-tense verb and an orb gesture.
 */
export type StepKind = 'search' | 'read' | 'web' | 'people' | 'calendar' | 'followups' | 'tracking' | 'memory' | 'write' | 'inbox' | 'think';

export type ReasoningStep = { kind: StepKind; text: string; detail: string };

export const STEP_KINDS: Record<StepKind, { pill: string; orb: OrbState }> = {
  search: { pill: 'Search', orb: 'searching' },
  read: { pill: 'Read', orb: 'analyzing' },
  web: { pill: 'Web', orb: 'searching' },
  people: { pill: 'People', orb: 'connecting' },
  calendar: { pill: 'Calendar', orb: 'searching' },
  followups: { pill: 'Follow-ups', orb: 'connecting' },
  tracking: { pill: 'Tracking', orb: 'searching' },
  memory: { pill: 'Memory', orb: 'analyzing' },
  write: { pill: 'Write', orb: 'drafting' },
  inbox: { pill: 'Inbox', orb: 'connecting' },
  think: { pill: 'Think', orb: 'analyzing' },
};

const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');

export function classifyStep(text: string): ReasoningStep {
  const value = text.trim();
  const after = (prefix: RegExp) => unquote(value.replace(prefix, ''));
  if (/^searching the web/i.test(value)) return { kind: 'web', text: value, detail: after(/^searching the web:?\s*/i) };
  if (/^reading (a web page|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i.test(value)) return { kind: 'web', text: value, detail: after(/^reading\s*/i) };
  if (/^reading/i.test(value)) return { kind: 'read', text: value, detail: /^reading a thread$/i.test(value) ? '' : after(/^reading\s*/i) };
  if (/^searching (gmail|summaries|your notes)|^looking through your mail/i.test(value)) {
    const detail = after(/^[^:]*:?\s*/);
    return { kind: 'search', text: value, detail: /^searching your notes/i.test(value) ? 'Your notes' : /^searching summaries/i.test(value) && detail ? `Summaries · ${detail}` : detail };
  }
  if (/^(looking up|pulling up)/i.test(value)) return { kind: 'people', text: value, detail: after(/^(looking up|pulling up)\s*/i) };
  if (/calendar|free time/i.test(value)) return { kind: 'calendar', text: value, detail: '' };
  if (/waiting on|commitments|deadlines|sequence/i.test(value)) return { kind: 'followups', text: value, detail: '' };
  if (/opens|clicks/i.test(value)) return { kind: 'tracking', text: value, detail: '' };
  if (/remembers|memory/i.test(value)) return { kind: 'memory', text: value, detail: '' };
  if (/^(writing|drafting)/i.test(value)) return { kind: 'write', text: value, detail: '' };
  if (/mailing lists|unsubscrib/i.test(value)) return { kind: 'inbox', text: value, detail: '' };
  return { kind: 'think', text: value, detail: '' };
}

/** Present-tense headline for what is happening now, counting repeated work ("Reading 3 threads"). */
export function liveLabel(steps: readonly ReasoningStep[], phase: { writing?: boolean; thinking?: boolean } = {}): string {
  if (phase.writing) return 'Writing the answer';
  const last = steps[steps.length - 1];
  if (!last || phase.thinking) return 'Thinking';
  const same = steps.filter((step) => step.kind === last.kind).length;
  switch (last.kind) {
    case 'search': return same > 1 ? `Searching your mail · ${same} searches` : 'Searching your mail';
    case 'read': return same > 1 ? `Reading ${same} threads` : 'Reading a thread';
    case 'web': {
      const pages = steps.filter((step) => step.kind === 'web').length;
      return pages > 1 ? `Searching ${pages} websites` : 'Searching the web';
    }
    case 'people': return last.detail ? `Looking up ${last.detail}` : 'Looking someone up';
    case 'memory': return 'Recalling what Pidgy remembers';
    case 'think': return 'Thinking';
    default: return last.text;
  }
}

/** "4s", "1m 12s". */
export function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Distinct categories, in the order they were first used. */
export function kindsOf(steps: readonly ReasoningStep[]): StepKind[] {
  return [...new Set(steps.map((step) => step.kind))];
}
