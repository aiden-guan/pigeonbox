import { describe, expect, it, vi } from 'vitest';
import { createPromptBackedProvider } from './prompt-provider';
import { formatThreadForSummary } from './summary-prompt';
const owner = { email: 'aiden@gmail.com', name: 'Aiden Guan', aliases: ['aiden@school.test'] };
const messages = [{ sender: 'Aiden Guan <aiden@school.test>', bodyText: 'I sent the revised scope.', timestamp: '' }, { sender: 'Maya <maya@test.example>', bodyText: 'Thanks for sending that.', timestamp: '' }];
describe('local and hosted provider perspective checks', () => {
  it('renders author roles as deterministic model input for earlier owner messages', () => {
    const formatted = formatThreadForSummary({ subject: 'Scope', owner, messages });
    expect(formatted).toContain('from you (me) [authorRole=owner]');
    expect(formatted).toContain('authorRole=other');
  });
  it.each(['full', 'compact'] as const)('regenerates %s summaries before returning an incorrect owner actor', async (style) => {
    const complete = vi.fn().mockResolvedValueOnce({ text: style === 'full' ? '{"oneLine":"Aiden sent the revised scope."}' : 'Summary: Aiden sent the revised scope.' }).mockResolvedValueOnce({ text: style === 'full' ? '{"oneLine":"You sent the revised scope."}' : 'Summary: You sent the revised scope.' });
    const provider = createPromptBackedProvider('fixture', complete, { summaryStyle: style });
    const result = await provider.summarizeThread({ owner, subject: 'Scope', messages });
    expect(result.result.oneLine).toBe('You sent the revised scope.'); expect(complete).toHaveBeenCalledTimes(2);
  });
  it('rejects repeated bad actor attribution without name substitution', async () => {
    const complete = vi.fn().mockResolvedValue({ text: '{"oneLine":"Aiden sent the revised scope."}' });
    const provider = createPromptBackedProvider('fixture', complete);
    await expect(provider.summarizeThread({ owner, subject: 'Scope', messages })).rejects.toThrow(/perspective/);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
