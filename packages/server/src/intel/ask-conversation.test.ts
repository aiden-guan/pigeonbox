import type { AskPigeonResponse, AskTurn } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../ai/backends.js';
import { connectedUser, createIntelHarness, deliverAndSync } from '../testing/intel-harness.js';
import { conversationResult, recentHistory } from './ask-agent.js';

const ADA = 'ada@work.test';

describe('Ask conversation continuity', () => {
  it('retains candidate identities and thread references without keeping raw email or web text', () => {
    const result = conversationResult({ results: [{ source: 'S2', name: 'Maya', email: 'maya@client.test', text: 'Private message body', messages: [{ from: 'maya@client.test', body: 'Another raw body', snippet: 'Raw snippet' }] }, { name: 'Lee', email: 'lee@work.test', html: '<p>Raw HTML</p>' }], text: 'Raw page content' }, new Map([['S2', { id: 'thread:abcdef', kind: 'thread', title: 'Meeting', gmailThreadId: 'abcdef' }]]));
    expect(result).toContain('maya@client.test');
    expect(result).toContain('lee@work.test');
    expect(result).toContain('abcdef');
    expect(result).not.toMatch(/Private message|raw body|Raw snippet|Raw HTML|Raw page/);
  });

  it('preserves the original constraints and complete recent choices and artifacts within the history budget', () => {
    const history: AskTurn[] = [{ role: 'user', content: 'Find undergraduate college lists. Keep graduate programs.' }];
    for (let i = 0; i < 9; i++) history.push({ role: 'assistant', content: `Answer ${i}: ${'x'.repeat(7_900)}`, context: 'y'.repeat(12_000) }, { role: 'user', content: `Follow-up ${i}` });
    history.push({ role: 'assistant', content: 'Which of the two would you like?', context: 'Offered follow-ups: ["The first one", "The second one"]\nReply draft: the complete body\nTool outcomes: nothing changed.' });
    const kept = recentHistory(history);
    expect(kept[0]!.content).toBe(history[0]!.content);
    expect(kept.at(-1)!.content).toContain('The second one');
    expect(kept.at(-1)!.content).toContain('the complete body');
    expect(kept.at(-1)!.content).toContain('nothing changed');
    expect(kept.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(64_000);
    // No partial assistant answers with their options truncated off.
    expect(kept.filter((item) => item.role === 'assistant' && item.content.includes('Answer ')).every((item) => item.content.endsWith('y'.repeat(12_000)))).toBe(true);
  });

  it.each([
    { query: 'Unsubscribe from specific senders', call: { id: 'a', name: 'unsubscribe', arguments: '{"senders":["news@college.test","news@grad.test"]}' }, missing: 'Which senders the user wants to leave', history: [{ role: 'user', content: 'Leave undergraduate lists. Keep graduate lists.' }, { role: 'assistant', content: 'Some senders are unclear.', context: 'Offered follow-ups: ["Unsubscribe from specific senders"]' }] },
    { query: 'yes', call: { id: 'a', name: 'compose_email', arguments: '{"to":["maya@client.test"],"subject":"Accept","body":"Yes, Friday works."}' }, missing: 'Which of the two dates to accept', history: [{ role: 'user', content: 'Help me answer Maya.' }, { role: 'assistant', content: 'Would you prefer Thursday or Friday?' }] },
    { query: 'make the second one shorter', call: { id: 'a', name: 'compose_email', arguments: '{"to":["lee@work.test"],"subject":"First draft","body":"Shortened first draft."}' }, missing: 'The proposal revises the first draft instead of the second', history: [{ role: 'user', content: 'Prepare two different drafts.' }, { role: 'assistant', content: 'Here are both.', context: 'First: Lee. Second: Maya.' }] },
    { query: 'draft a reply', call: { id: 'a', name: 'draft_reply', arguments: '{"source":"S1"}' }, missing: 'Which of the previously discussed threads to reply to', history: [{ role: 'user', content: 'Compare these two threads.' }, { role: 'assistant', content: 'Both are awaiting a reply.' }] },
  ])('blocks an out-of-scope $call.name proposal and lets the model ask a contextual question', async ({ query, call, missing, history }) => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'news@college.test', to: [ADA], subject: 'Undergraduate admissions', body: 'News', headers: { 'List-Unsubscribe': '<https://college.test/leave>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
    const before = h.google.calls.length;
    let rounds = 0;
    let reviews = 0;
    const seen: unknown[] = [];
    h.deps.inference.chat = async (request) => {
      const base = { model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 } };
      if (request.responseFormat) {
        reviews++;
        const data = JSON.parse(request.messages.at(-1)!.content) as { currentRequest: string; conversation: unknown; proposal: { tool: string } };
        expect(data.currentRequest).toBe(query);
        expect(JSON.stringify(data.conversation)).toContain(history[0]!.content);
        expect(data.proposal.tool).toBe(call.name);
        return { ...base, text: JSON.stringify({ allowed: false, reason: missing, missing: [missing] }) };
      }
      if (!rounds++) return { ...base, text: '', toolCalls: [call, { ...call, id: 'b' } as ToolCall] };
      seen.push(...request.messages.filter((item) => item.role === 'tool').map((item) => JSON.parse(item.content)));
      return { ...base, text: `Please clarify: ${missing}?` };
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query, history, features: ['compose'] });
    expect(answer.answer).toContain(missing);
    expect(reviews).toBe(1);
    expect(seen).toEqual([expect.objectContaining({ status: 'needs_clarification', actionTaken: false }), expect.objectContaining({ status: 'needs_clarification' })]);
    expect(answer.compose).toEqual([]);
    expect(answer.drafts).toEqual([]);
    expect(answer.context).toContain('needs_clarification');
    expect(await h.sql('select * from public.mail_unsubscribes')).toEqual([]);
    expect(await h.sql('select * from public.drafts')).toEqual([]);
    expect(h.google.calls.slice(before).some((item) => /modify|send|drafts/.test(item.path))).toBe(false);
  });

  it('fails closed on an invalid action review', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    let round = 0;
    h.deps.inference.chat = async (request) => {
      const base = { model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 } };
      if (request.responseFormat) return { ...base, text: 'not a decision' };
      return round++ ? { ...base, text: 'Could not verify the action.' } : { ...base, text: '', toolCalls: [{ id: 'a', name: 'compose_email', arguments: '{"to":[],"subject":"Hello","body":"Hi"}' }] };
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Write a hello email', features: ['compose'] });
    expect(answer.compose).toEqual([]);
    expect(answer.context).toContain('action_not_verified');
  });

  it('allows a resolved draft revision and carries its actual outcome forward', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    let round = 0;
    h.deps.inference.chat = async (request) => {
      const base = { model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 } };
      if (request.responseFormat) {
        expect(request.messages.at(-1)!.content).toContain('Original email to Maya');
        return { ...base, text: '{"allowed":true,"reason":"The identified draft is being revised.","missing":[]}' };
      }
      return round++ ? { ...base, text: 'Prepared the shorter draft.' } : { ...base, text: '', toolCalls: [{ id: 'a', name: 'compose_email', arguments: '{"to":["maya@client.test"],"subject":"Friday","body":"Friday works. Ada"}' }] };
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'make it shorter', history: [{ role: 'user', content: 'Write to Maya accepting Friday.' }, { role: 'assistant', content: 'Prepared.', context: 'Original email to Maya: Dear Maya, Friday works for me. Ada' }], features: ['compose'] });
    expect(answer.compose).toEqual([expect.objectContaining({ body: 'Friday works.\n\nBest,\nada' })]);
    expect(answer.context).toContain('compose_email');
    expect(answer.context).toContain('review and send');
  });

  it('corrects an incorrect proposal without asking the user to repeat an already resolved choice', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    let round = 0;
    h.deps.inference.chat = async (request) => {
      const base = { model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 } };
      if (request.responseFormat) {
        const data = JSON.parse(request.messages.at(-1)!.content) as { proposal: { arguments: { to: string[] } } };
        const allowed = data.proposal.arguments.to[0] === 'maya@client.test';
        return { ...base, text: JSON.stringify({ allowed, reason: allowed ? 'Revises the selected second draft.' : 'The user selected Maya, not Lee.', missing: [] }) };
      }
      const recipient = round++ ? 'maya@client.test' : 'lee@work.test';
      return round > 2 ? { ...base, text: 'Prepared Maya’s shorter draft.' } : { ...base, text: '', toolCalls: [{ id: String(round), name: 'compose_email', arguments: JSON.stringify({ to: [recipient], subject: 'Friday', body: 'Friday works.' }) }] };
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'make the second one shorter', history: [{ role: 'user', content: 'Prepare drafts for Lee and Maya.' }, { role: 'assistant', content: 'First: Lee. Second: Maya <maya@client.test>.' }], features: ['compose'] });
    expect(answer.compose).toHaveLength(1);
    expect(answer.compose[0]!.to).toEqual([{ email: 'maya@client.test' }]);
    expect(answer.context).toContain('out_of_scope');
  });
});
