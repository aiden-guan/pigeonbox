import { describe, expect, it } from 'vitest';
import { strictJsonSchema } from '../ai/json-schema.js';
import { ComposeInferenceSchema, expandComposeInference } from './compose-inference.js';

const evidence = [{ id: 'E1', advisories: ['You have a meeting at 3 PM today.', 'The workshop fee is $450.'] }];
const advisory = { kind: 'fact_conflict' as const, confidence: 0.97, sourceIds: ['E1'], advisoryIndex: 1, suggestedText: null, highlightText: null };

describe('compact compose inference', () => {
  it('uses strict structured output and expands only an exact supplied advisory', () => {
    expect(strictJsonSchema(ComposeInferenceSchema)).not.toBeNull();
    const value = ComposeInferenceSchema.parse({ advisory, completion: null });
    expect(expandComposeInference(value, evidence)).toMatchObject({ surface: true, message: evidence[0]!.advisories[1], sourceIds: ['E1'] });
    expect(expandComposeInference(value, [])).toMatchObject({ surface: false, message: '' });
    expect(expandComposeInference({ ...value, advisory: { ...advisory, sourceIds: ['E9'] } }, evidence).surface).toBe(false);
    expect(expandComposeInference({ ...value, advisory: { ...advisory, advisoryIndex: 2 } }, evidence).surface).toBe(false);
  });
  it('rejects invalid indexes and keeps completion proof required', () => {
    for (const advisoryIndex of [-1, 3, 0.5]) expect(ComposeInferenceSchema.safeParse({ advisory: { ...advisory, advisoryIndex }, completion: null }).success).toBe(false);
    expect(ComposeInferenceSchema.safeParse({ advisory: null, completion: { text: ' an invented fact', confidence: 1, proofs: [] } }).success).toBe(false);
  });
  it('removes boilerplate from the common abstention and completion replies', () => {
    const compact = { advisory: null, completion: null };
    const full = expandComposeInference(compact, evidence);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2);
    const completion = { text: ' that generated $35k in revenue.', confidence: 0.96, proofs: [{ sourceId: 'E1', quote: 'You generated $35,000 in revenue.' }] };
    expect(JSON.stringify({ ...compact, completion }).length).toBeLessThan(JSON.stringify({ ...full, completion }).length * 0.8);
  });
});
