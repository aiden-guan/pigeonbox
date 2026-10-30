import { describe, expect, it } from 'vitest';
import { validateCompletion } from './compose-completion.js';
import { validateWritingJudgment } from './compose-writing.js';

const input = { claim: 'Could you please send me', ids: [], evidence: [], now: new Date(), timeZone: 'UTC', allowWriting: true };
const value = { text: ' the latest version when you have a chance?', confidence: 0.98, kind: 'writing' as const, proofs: [] };

describe('writing assistance without factual sources', () => {
  it('completes an ordinary request without inventing a source', () => {
    expect(validateCompletion(value, input)).toEqual({ text: value.text, confidence: 0.98, kind: 'writing', sources: [] });
    expect(validateCompletion(value, { ...input, allowWriting: false })).toBeUndefined();
    expect(validateCompletion({ ...value, kind: 'grounded' }, input)).toBeUndefined();
    expect(validateCompletion(value, { ...input, claim: "I'd appreciate it if you could send me" })).toBeDefined();
  });
  it.each([' the $35,000 proposal.', ' the file on Friday.', ' the approved contract.', ' the file from Berkeley.', ' it, and I will pay you.', ' it, since I already sent the payment.', ' the contract, since the proposal is accepted.'])('rejects an unsupported factual continuation: %s', text => {
    expect(validateCompletion({ ...value, text }, input)).toBeUndefined();
  });
  it('does not complete a biography through the nonfactual path', () => {
    expect(validateCompletion({ ...value, text: ' with experience in marketing.' }, { ...input, claim: 'I used to run a paid community' })).toBeUndefined();
  });
  it('offers a concise rewrite while preserving dates, names, amounts and uncertainty', () => {
    const claim = 'I just wanted to ask if you could send the proposal in order to review it before Friday.';
    const writing = { text: 'I wanted to ask if you could send the proposal to review it before Friday.', reason: 'concision' as const, confidence: 0.98 };
    expect(validateWritingJudgment(writing, claim)).toMatchObject({ status: 'notice', kind: 'writing_suggestion', suggestedText: writing.text, sources: [] });
    for (const text of [writing.text.replace('Friday', 'Monday'), writing.text.replace('could', 'will'), writing.text.replace('proposal', 'contract')]) expect(validateWritingJudgment({ ...writing, text }, claim)).toBeNull();
    expect(validateWritingJudgment({ ...writing, confidence: 0.8 }, claim)).toBeNull();
  });
  it('removes an accidental repeated word without changing the claim', () => {
    expect(validateWritingJudgment({ text: 'I sent the proposal yesterday.', reason: 'grammar', confidence: 0.99 }, 'I sent the the proposal yesterday.')).toMatchObject({ kind: 'writing_suggestion' });
  });
});
