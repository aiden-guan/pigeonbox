import { describe, expect, it, vi } from 'vitest';
import type { AskPigeonResponse, SavedTask } from '@pigeonbox/api-contract';
import { connectedUser, createIntelHarness, deliverAndSync } from '../testing/intel-harness.js';
import { MockInferenceBackend, type ChatRequest, type InferenceContext } from '../ai/backends.js';
import { decryptSummary } from './thread-summary.js';
import { analysisPrompt } from './prompts.js';

const OWNER = 'aiden@work.test';
const OTHER = 'maya@client.test';
describe('workspace task and current-conversation contracts', () => {
  it('saves an encrypted source-linked task once, completes and reopens it, and enforces user isolation', async () => {
    const h = await createIntelHarness(); const user = await connectedUser(h, OWNER);
    const mail = await deliverAndSync(h, OWNER, { from: OTHER, to: [OWNER], subject: 'Pricing', body: 'Please send revised pricing by Friday.' });
    const id = crypto.randomUUID();
    const request = { id, title: 'Send revised pricing', threadId: mail.threadId, mailbox: OWNER };
    const created = await h.route<{ tasks: SavedTask[] }>('taskCreate', user.token, request);
    expect(created.tasks.find((task) => task.id === id)).toMatchObject({ title: request.title, threadId: mail.threadId, accountId: user.accountId, status: 'open' });
    await h.route('taskCreate', user.token, request);
    const rows = await h.sql<{ title_ciphertext: string; source: string }>('select title_ciphertext, source from public.tasks where id = $1', [id]);
    expect(rows).toHaveLength(1); expect(rows[0]!.title_ciphertext).not.toContain('pricing'); expect(rows[0]!.source).toBe('user');
    const done = await h.call('/v1/tasks/update', { token: user.token, body: { id, status: 'done' } });
    expect(done.status).toBe(200); expect((await done.json() as { tasks: SavedTask[] }).tasks.find((task) => task.id === id)?.status).toBe('done');
    const reopen = await h.call('/v1/tasks/update', { token: user.token, body: { id, status: 'open' } }); expect(reopen.status).toBe(200);
    const stranger = await h.signIn('stranger@work.test');
    expect((await h.route<{ tasks: SavedTask[] }>('tasks', stranger.accessToken)).tasks).toEqual([]);
    expect((await h.call('/v1/tasks/update', { token: stranger.accessToken, body: { id, status: 'done' } })).status).toBe(404);
    expect((await h.call('/v1/tasks', { token: stranger.accessToken, body: { ...request, id: crypto.randomUUID() } })).status).toBe(404);
  });
  it('grounds “this thread” in the account-bound source and refuses another user’s conversation', async () => {
    const h = await createIntelHarness(); const user = await connectedUser(h, OWNER);
    const mail = await deliverAndSync(h, OWNER, { from: OTHER, to: [OWNER], subject: 'Rare pricing partnership', body: 'The revised pricing is due Friday.' });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Summarize this thread', threadId: mail.threadId, mailbox: OWNER });
    expect(answer.sources.some((source) => source.gmailThreadId === mail.threadId && source.accountId === user.accountId)).toBe(true);
    const stranger = await h.signIn('stranger@work.test');
    expect((await h.call('/v1/ask', { token: stranger.accessToken, body: { query: 'Summarize this thread', threadId: mail.threadId, mailbox: OWNER } })).status).toBe(404);
  });
});

describe('hosted owner perspective', () => {
  it('sends explicit owner roles and from you for sent aliases without changing quoted bodies', () => {
    const prompt = analysisPrompt({ perspectiveVersion: 1, now: new Date().toISOString(), timeZone: 'UTC', ownerEmails: [OWNER, 'aiden@alias.test'], subject: 'Scope', labels: [], messages: [{ from: 'aiden@alias.test', fromName: 'Aiden Guan', authorRole: 'owner', to: [OTHER], cc: [], date: new Date().toISOString(), direction: 'outbound', isAuto: false, listUnsubscribe: false, attachments: [], text: 'Maya said Aiden sent an example.' }] });
    expect(prompt.user).toContain('"authorRole":"owner"'); expect(prompt.user).toContain('"from":"you"'); expect(prompt.user).toContain('Maya said Aiden sent an example.');
  });
  it('keeps legacy ownerless summaries neutral until regenerated', async () => {
    const h = await createIntelHarness(); const id = crypto.randomUUID();
    const seal = async (value: unknown) => ({ id, summary_key_id: 'k1', ...await h.box.seal(JSON.stringify(value), { purpose: 'thread_summary', userId: id, recordId: id }) });
    const legacy = await seal({ oneLine: 'Aiden sent pricing.', keyPoints: [] });
    const current = await seal({ perspectiveVersion: 1, oneLine: 'You sent pricing.', keyPoints: [] });
    const row = (value: Awaited<ReturnType<typeof seal>>) => ({ id, summary_key_id: value.keyId, summary_iv: value.iv, summary_ciphertext: value.ciphertext });
    expect(await decryptSummary(h.box, id, row(legacy))).toBeNull();
    expect(await decryptSummary(h.box, id, row(current))).toEqual({ oneLine: 'You sent pricing.', keyPoints: [] });
  });
  it('repairs owner-as-third-person before saving the hosted summary', async () => {
    class WrongPerspective extends MockInferenceBackend {
      calls = 0;
      override async chat(request: ChatRequest, context: InferenceContext) {
        const result = await super.chat(request, context);
        if (context.operation === 'thread_analysis') {
          this.calls += 1; const parsed = JSON.parse(result.text) as { summary: { oneLine: string } };
          parsed.summary.oneLine = this.calls === 1 ? 'Aiden sent the revised scope.' : 'You sent the revised scope.';
          result.text = JSON.stringify(parsed);
        }
        return result;
      }
    }
    const inference = new WrongPerspective(); const h = await createIntelHarness({ inference }); const user = await connectedUser(h, OWNER);
    const mail = await deliverAndSync(h, OWNER, { from: OWNER, fromName: 'Aiden Guan', to: [OTHER], subject: 'Revised scope', body: 'I sent the revised scope.' });
    const result = await h.route<{ threads: Record<string, { summary: { oneLine: string } | null }> }>('threadsIntel', user.token, { accountId: user.accountId, threadIds: [mail.threadId] });
    expect(result.threads[mail.threadId]?.summary?.oneLine).toBe('You sent the revised scope.'); expect(inference.calls).toBe(2);
    const state = await h.sql<{ input_fingerprint: string }>('select input_fingerprint from public.thread_states'); expect(state[0]?.input_fingerprint).toMatch(/^owner-v1:/);
  });
  it('does not save or emit side effects for inference whose thread changed while it was running', async () => {
    const inference = new MockInferenceBackend(); const h = await createIntelHarness({ inference }); const user = await connectedUser(h, OWNER);
    const chat = inference.chat.bind(inference);
    vi.spyOn(inference, 'chat').mockImplementation(async (request, context) => {
      const result = await chat(request, context);
      if (context.operation === 'thread_analysis') await h.sql("update public.threads set content_version = content_version || '-newer'");
      return result;
    });
    h.google.deliver(OWNER, { from: OTHER, to: [OWNER], subject: 'Changing context', body: 'Please send the scope.' }); await h.push(OWNER); const drained = await h.drain();
    expect(drained.skipped).toBeGreaterThan(0);
    expect(await h.sql('select * from public.thread_states')).toHaveLength(0);
    expect(await h.sql('select * from public.commitments')).toHaveLength(0);
    expect(await h.sql('select * from public.drafts')).toHaveLength(0);
    expect(user.accountId).toBeTruthy();
  });
});
