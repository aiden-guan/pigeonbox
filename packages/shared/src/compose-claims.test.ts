import { describe, expect, it } from 'vitest';
import { boundClaim, classifyComposeClaim, normalizeClaim, splitComposeClauses, stripQuotedHistory } from './compose-claims';

describe('compose claim gate', () => {
  it('checks the claims real-time Pidgy checks exist for', () => {
    const cases: Array<[string, string]> = [
      ["Yeah, I'm free tomorrow at 3.", 'availability'],
      ['Tuesday at 5 works for me', 'availability'],
      ["I'm free tomorrow afternoon", 'availability'],
      ["I'm free Thursday morning.", 'availability'],
      ['Tuesday at 2 works for me.', 'availability'],
      ['I can meet Wednesday at 11', 'availability'],
      ['Are you free at 3pm tomorrow?', 'availability'],
      ["Let's schedule a call tomorrow at 10am.", 'scheduling'],
      ["I'll have it to you Friday", 'commitment'],
      ["I'll send it over Friday.", 'commitment'],
      ['I will finish the report by end of week.', 'commitment'],
      ['The deadline is October 10', 'deadline'],
      ['The report is due Friday.', 'deadline'],
      ['We already agreed on $500', 'fact'],
      ['The meeting is in Soda Hall.', 'fact'],
      ['Midterm 2 has been moved to October 14.', 'fact'],
      ['Midterm 2 is on October 14.', 'fact'],
      ['The design review is in Cory Hall.', 'fact'],
    ];
    for (const [clause, kind] of cases) expect(classifyComposeClaim(clause), clause).toBe(kind);
  });

  it('leaves ordinary prose, negations, past tense and half-typed clauses alone', () => {
    for (const clause of [
      'Thanks so much for the update!',
      'Hope you had a great weekend.',
      "I'll take a look and get back to you.",
      'Sounds good to me.',
      'Please open the attachment tomorrow morning.',
      "Sorry, I can't do tomorrow at 3.",
      "I'm busy tomorrow afternoon.",
      'I was free yesterday at 3.',
      'I had a great meeting this morning.',
      "I'm free tomorrow at",
      'See you tomorrow!',
      'You said you would call me.',
      'The delay was due to the rain on Friday.',
      'The meeting is going well so far.',
      'My class is fun.',
      'ok',
      'https://example.com/tomorrow-at-3',
    ])
      expect(classifyComposeClaim(clause), clause).toBeNull();
  });

  it('splits sentences and semicolon clauses without breaking on a.m./p.m.', () => {
    expect(splitComposeClauses("Hi Alex,\nThanks for this. I'm free tomorrow at 3 p.m. if that helps; let me know!")).toEqual([
      'Hi Alex,',
      'Thanks for this.',
      "I'm free tomorrow at 3 p.m. if that helps",
      'let me know!',
    ]);
  });

  it('drops quoted replies, forwarded headers and signatures', () => {
    const text = "Tuesday works.\n\n-- \nAda\n555-0100\n\nOn Mon, Oct 5, 2026 at 9:00 AM Alex <alex@x.test> wrote:\n> I'm free tomorrow at 3";
    expect(stripQuotedHistory(text).trim()).toBe('Tuesday works.');
    expect(stripQuotedHistory('New text\n> quoted line\nmore new')).toBe('New text\nmore new');
    expect(stripQuotedHistory('Reply\n---------- Forwarded message ---------\nFrom: x')).toBe('Reply');
  });

  it('normalizes case, quotes, spacing, fillers and edge punctuation', () => {
    expect(normalizeClaim('  Yeah, I’m FREE   tomorrow at 3.  ')).toBe("i'm free tomorrow at 3");
    expect(normalizeClaim("I'm free tomorrow at 3")).toBe(normalizeClaim("i'm free tomorrow at 3!"));
  });

  it('bounds a claim to 700 characters from the newest words', () => {
    const long = `${'word '.repeat(300)}I'm free tomorrow at 3`;
    const bounded = boundClaim(long);
    expect(bounded.length).toBeLessThanOrEqual(700);
    expect(bounded.endsWith("I'm free tomorrow at 3")).toBe(true);
    expect(boundClaim('short')).toBe('short');
  });
});
