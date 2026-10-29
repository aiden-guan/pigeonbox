import { describe, expect, it } from 'vitest';
import { validateCompletion } from './compose-completion.js';
import type { ContextItem } from './memory/rank.js';

const now = new Date('2026-10-08T12:00:00Z');
const claim = 'I used to have a paid community';
const quote = 'You ran a paid community that generated $35,000 in revenue.';
const evidence: ContextItem = { ref: { id: 'memory:one', kind: 'note', title: 'Community revenue' },
  text: quote, assertion: quote, subject: { type: 'self', key: 'self', label: 'You' },
  confidence: 1, importance: 1, semantic: 0, recipientMatch: false, threadMatch: false,
  openLoop: false, at: now.toISOString(), validUntil: null, durable: true, status: 'active' };
const input = { claim, ids: ['E1'], evidence: [evidence], now, timeZone: 'UTC' };
const value = { text: ' where I made 35k in revenue.', confidence: 0.96, proofs: [{ sourceId: 'E1', quote }] };

describe('source-grounded AI continuations', () => {
  it('accepts AI-written phrasing and equivalent sourced shorthand, without any canned completion', () => {
    expect(validateCompletion(value, input)).toMatchObject({ text: value.text, sources: [evidence.ref] });
    expect(validateCompletion({ ...value, text: ' that generated $35k in revenue.' }, input)).toBeDefined();
    expect(validateCompletion({ ...value, text: value.text.trimStart() }, input)?.text).toBe(value.text);
  });
  it.each([
    { text: ' where I made 45k in revenue.' }, { text: ' where I made $35 in revenue.' },
    { text: ' where I made €35k in revenue.' }, { text: ' with 35,000 members.' },
    { text: ' where I made 35k in profit.' }, { text: ' where I lost 35k.' },
    { text: ' that launched on Friday.' }, { text: ' and I will send you the results.' },
    { text: '<script>alert(1)</script>' }, { text: ' my password is hidden.' },
    { text: 'I used to have a paid community that made 35k.' },
    { confidence: 0.7 }, { proofs: [{ sourceId: 'E9', quote }] },
    { proofs: [{ sourceId: 'E1', quote: 'You made $50,000 in revenue.' }] },
  ])('rejects unsupported, unsafe or ungrounded output: %j', patch => {
    expect(validateCompletion({ ...value, ...patch }, input)).toBeUndefined();
  });
  it('rejects missing, unrelated, superseded, expired and weak evidence', () => {
    for (const patch of [
      { status: 'superseded' as const }, { validUntil: '2026-10-07T00:00:00Z' }, { confidence: 0.7 },
      { subject: { type: 'person' as const, key: 'other@work.test', label: 'Other' }, text: 'Another company made $35,000.', assertion: 'Another company made $35,000.' },
    ]) expect(validateCompletion(value, { ...input, evidence: [{ ...evidence, ...patch }] })).toBeUndefined();
    expect(validateCompletion(value, { ...input, evidence: [] })).toBeUndefined();
    expect(validateCompletion(value, { ...input, evidence: [{ ...evidence,
      subject: { type: 'person', key: 'other@work.test', label: 'Other' }, recipientMatch: true, semantic: 0.99,
    }] })).toBeUndefined();
  });
});
