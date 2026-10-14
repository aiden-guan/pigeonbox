import { describe, expect, it } from 'vitest';
import { classifyStep, duration, kindsOf, liveLabel } from './reasoning';

describe('classifyStep', () => {
  it('maps every status the Ask agent sends to a category and a short detail', () => {
    const cases: Array<[string, string, string]> = [
      ['Looking through your mail', 'search', ''],
      ['Searching Gmail: from:allen contract', 'search', 'from:allen contract'],
      ['Searching summaries: pricing', 'search', 'Summaries · pricing'],
      ['Searching your notes', 'search', 'Your notes'],
      ['Reading "Contract redlines"', 'read', 'Contract redlines'],
      ['Reading a thread', 'read', ''],
      ['Searching the web: acme pricing', 'web', 'acme pricing'],
      ['Reading acme.com', 'web', 'acme.com'],
      ['Reading a web page', 'web', 'a web page'],
      ['Looking up Allen', 'people', 'Allen'],
      ['Pulling up allen@partner.test', 'people', 'allen@partner.test'],
      ['Checking your calendar', 'calendar', ''],
      ['Finding free time', 'calendar', ''],
      ['Checking who you are waiting on', 'followups', ''],
      ['Checking commitments', 'followups', ''],
      ['Checking deadlines', 'followups', ''],
      ['Checking the "Launch" sequence', 'followups', ''],
      ['Checking opens, clicks and replies', 'tracking', ''],
      ['Checking what Pidgy remembers', 'memory', ''],
      ['Writing the email', 'write', ''],
      ['Drafting a reply', 'write', ''],
      ['Checking your mailing lists', 'inbox', ''],
      ['Unsubscribing from 3 senders', 'inbox', ''],
      ['Working', 'think', ''],
    ];
    for (const [text, kind, detail] of cases) expect(classifyStep(text), text).toMatchObject({ kind, detail });
  });
});

describe('liveLabel', () => {
  const steps = (...texts: string[]) => texts.map(classifyStep);
  it('says what is happening now and counts repeated work', () => {
    expect(liveLabel([])).toBe('Thinking');
    expect(liveLabel(steps('Searching Gmail: a'))).toBe('Searching your mail');
    expect(liveLabel(steps('Searching Gmail: a', 'Reading "A"', 'Reading "B"'))).toBe('Reading 2 threads');
    expect(liveLabel(steps('Searching the web: a', 'Reading a.com', 'Reading b.com', 'Reading c.com'))).toBe('Searching 4 websites');
    expect(liveLabel(steps('Checking your calendar'))).toBe('Checking your calendar');
    expect(liveLabel(steps('Searching Gmail: a'), { thinking: true })).toBe('Thinking');
    expect(liveLabel(steps('Searching Gmail: a'), { writing: true })).toBe('Writing the answer');
  });
  it('lists categories once, in first-use order, and formats durations', () => {
    expect(kindsOf(steps('Searching Gmail: a', 'Reading "A"', 'Searching Gmail: b'))).toEqual(['search', 'read']);
    expect(duration(400)).toBe('1s');
    expect(duration(6_200)).toBe('6s');
    expect(duration(72_000)).toBe('1m 12s');
  });
});
