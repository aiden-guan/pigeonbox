import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from './index.js';
import { AIJobQueue, type AIProvider } from '@pigeonbox/ai';
import { getMailboxDb, resetMailboxDbForTests } from '@pigeonbox/mailbox';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';

describe('AI job asynchronous lifecycle and deduplication', () => {
  beforeEach(() => {
    resetMailboxDbForTests();
  });

  it('runs long-running summary inference (~18s) asynchronously, returning queued immediately, updating DB and emitting intel events', async () => {
    const db = getMailboxDb('lifecycle_' + Math.random());
    const intelEvents: string[] = [];
    let resolveInference!: (val: unknown) => void;
    const inferencePromise = new Promise((resolve) => {
      resolveInference = resolve;
    });

    const ai = {
      summarizeThread: async () => {
        await inferencePromise;
        return {
          result: {
            reasoning: '',
            oneLine: 'Quarterly financial results reviewed.',
            keyPoints: ['Revenue up 12%'],
            decisions: [],
            unansweredQuestions: [],
            commitments: [],
            dates: [],
            actionItems: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoSummarize: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
      onIntel: (_threadId, kind) => {
        intelEvents.push(kind);
      },
    });

    const threadId = 't_long';
    const fingerprint = 'fp_long';
    const input = {
      threadId,
      fingerprint,
      subject: 'Q3 Results',
      messages: [{ sender: 'cfo@corp.test', bodyText: 'Here are the Q3 results.', timestamp: '' }],
    };

    // 1. Initial request returns queued response immediately without blocking on inference
    const queuedRes = await agent.startSummaryJob(input);
    expect(queuedRes.ok).toBe(true);
    expect(queuedRes.status).toBe('queued');
    expect(queuedRes.jobId).toBeTruthy();

    // Verify inference is still in-flight
    expect(await db.thread_summaries.get(threadId)).toBeUndefined();
    const midJob = await db.ai_jobs.get(queuedRes.jobId);
    expect(['queued', 'running']).toContain(midJob?.status);

    // 2. Resolve the long-running model inference
    resolveInference(true);

    // Wait a tick for background async completion
    await new Promise((r) => setTimeout(r, 50));

    const finalJob = await db.ai_jobs.get(queuedRes.jobId);
    expect(finalJob?.status).toBe('succeeded');
    expect(finalJob?.completedAt).toBeDefined();

    // Verify DB updated with model source and success status
    const summary = await db.thread_summaries.get(threadId);
    expect(summary?.source).toBe('model');
    expect(summary?.aiStatus).toBe('success');
    expect(summary?.summary.oneLine).toBe('Quarterly financial results reviewed.');

    // Verify intel events emitted
    expect(intelEvents).toContain('THREAD_SUMMARY_READY');
    expect(intelEvents).toContain('THREAD_INTELLIGENCE_UPDATED');
  });

  it('runs long-running draft inference asynchronously, updating DB and emitting draft ready event', async () => {
    const db = getMailboxDb('lifecycle_draft_' + Math.random());
    const intelEvents: string[] = [];
    let resolveInference!: (val: unknown) => void;
    const inferencePromise = new Promise((resolve) => {
      resolveInference = resolve;
    });

    const ai = {
      draftReply: async () => {
        await inferencePromise;
        return {
          result: {
            mode: 'direct' as const,
            body: 'I will attend the Q3 review.',
            placeholders: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoDraft: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
      onIntel: (_threadId, kind) => {
        intelEvents.push(kind);
      },
    });

    const threadId = 't_draft';
    const fingerprint = 'fp_draft';
    const input = {
      threadId,
      fingerprint,
      subject: 'Review invite',
      messages: [{ sender: 'lead@corp.test', bodyText: 'Can you attend?', timestamp: '' }],
    };

    const queuedRes = await agent.startDraftJob(input);
    expect(queuedRes.ok).toBe(true);
    expect(queuedRes.status).toBe('queued');

    // While running, draft suggestion is not yet stored
    expect(await db.draft_suggestions.where('threadId').equals(threadId).first()).toBeUndefined();

    // Resolve inference
    resolveInference(true);
    await vi.waitFor(() => expect(intelEvents).toContain('THREAD_DRAFT_READY'));

    const savedDraft = await db.draft_suggestions.where('threadId').equals(threadId).first();
    expect(savedDraft?.suggestion.body).toBe('I will attend the Q3 review.');
    expect(savedDraft?.fingerprint).toBe(fingerprint);

    expect(intelEvents).toContain('THREAD_DRAFT_READY');
    expect(intelEvents).toContain('THREAD_INTELLIGENCE_UPDATED');
  });

  it('deduplicates simultaneous requests for the same threadId + fingerprint + job kind', async () => {
    const db = getMailboxDb('lifecycle_dedup_' + Math.random());
    let aiCalls = 0;
    let resolveInference!: (val: unknown) => void;
    const inferencePromise = new Promise((resolve) => {
      resolveInference = resolve;
    });

    const ai = {
      summarizeThread: async () => {
        aiCalls += 1;
        await inferencePromise;
        return {
          result: {
            reasoning: '',
            oneLine: 'Budget approved.',
            keyPoints: [],
            decisions: [],
            unansweredQuestions: [],
            commitments: [],
            dates: [],
            actionItems: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoSummarize: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
    });

    const input = {
      threadId: 't_dedup',
      fingerprint: 'fp_dedup',
      subject: 'Budget',
      messages: [{ sender: 'mgr@corp.test', bodyText: 'Budget is ready.', timestamp: '' }],
    };

    // First request starts inference
    const job1 = await agent.startSummaryJob(input);
    expect(job1.ok).toBe(true);

    // Second request with exact same threadId + fingerprint while job1 is in-flight
    const job2 = await agent.startSummaryJob(input);
    expect(job2.ok).toBe(true);
    expect(job2.jobId).toBe(job1.jobId);

    // Complete inference
    resolveInference(true);
    await new Promise((r) => setTimeout(r, 50));

    // AI model was invoked only ONCE despite two startSummaryJob calls
    expect(aiCalls).toBe(1);
  });

  it('generates a new job when the thread fingerprint changes', async () => {
    const db = getMailboxDb('lifecycle_fp_change_' + Math.random());
    let aiCalls = 0;

    const ai = {
      summarizeThread: async () => {
        aiCalls += 1;
        return {
          result: {
            reasoning: '',
            oneLine: `Summary version ${aiCalls}`,
            keyPoints: [],
            decisions: [],
            unansweredQuestions: [],
            commitments: [],
            dates: [],
            actionItems: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoSummarize: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
    });

    const threadId = 't_fp';
    const input1 = {
      threadId,
      fingerprint: 'fp_initial',
      subject: 'Discussion',
      messages: [{ sender: 'p1@corp.test', bodyText: 'Initial message', timestamp: '' }],
    };

    const res1 = await agent.startSummaryJob(input1);
    await new Promise((r) => setTimeout(r, 50));
    expect(aiCalls).toBe(1);

    // Now a new message arrives, changing the fingerprint
    const input2 = {
      threadId,
      fingerprint: 'fp_updated_with_reply',
      subject: 'Discussion',
      messages: [
        { sender: 'p1@corp.test', bodyText: 'Initial message', timestamp: '' },
        { sender: 'p2@corp.test', bodyText: 'Here is my reply', timestamp: '' },
      ],
    };

    const res2 = await agent.startSummaryJob(input2);
    await new Promise((r) => setTimeout(r, 50));
    expect(aiCalls).toBe(2);
    expect(res2.jobId).not.toBe(res1.jobId);
  });

  it('stores resultId on draft completion and allows direct retrieval', async () => {
    const db = getMailboxDb('lifecycle_result_id_' + Math.random());
    const ai = {
      draftReply: async () => ({
        result: {
          mode: 'direct' as const,
          body: 'Here is the draft content.',
          placeholders: [],
        },
      }),
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoDraft: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
    });

    const res = await agent.startDraftJob({
      threadId: 't_res_id',
      fingerprint: 'fp_res_id',
      subject: 'Subject',
      messages: [{ sender: 'a@test.com', bodyText: 'Body', timestamp: '' }],
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const job = await db.ai_jobs.get(res.jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.resultId).toBeDefined();

    const draft = await db.draft_suggestions.get(job!.resultId!);
    expect(draft).toBeDefined();
    expect(draft?.suggestion.body).toBe('Here is the draft content.');
  });

  it('preserves newer inFlightJob entry when an earlier job completes (ownership check)', async () => {
    const db = getMailboxDb('lifecycle_ownership_' + Math.random());
    let resolveJob1!: () => void;
    const job1Promise = new Promise<void>((resolve) => {
      resolveJob1 = resolve;
    });

    let calls = 0;
    const ai = {
      summarizeThread: async () => {
        calls += 1;
        if (calls === 1) {
          await job1Promise;
        }
        return {
          result: {
            reasoning: '',
            oneLine: `Summary ${calls}`,
            keyPoints: [],
            decisions: [],
            unansweredQuestions: [],
            commitments: [],
            dates: [],
            actionItems: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoSummarize: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
    });

    const input = {
      threadId: 't_owner',
      fingerprint: 'fp_owner',
      subject: 'Ownership Test',
      messages: [{ sender: 'a@test.com', bodyText: 'Message', timestamp: '' }],
    };

    // Start job 1 (hangs on job1Promise)
    const res1 = await agent.startSummaryJob(input);
    expect(res1.ok).toBe(true);

    // Force start job 2 for the same key while job 1 is in-flight
    const res2 = await agent.startSummaryJob({ ...input, force: true });
    expect(res2.ok).toBe(true);
    expect(res2.jobId).not.toBe(res1.jobId);

    // Now complete job 1
    resolveJob1();
    await new Promise((r) => setTimeout(r, 50));

    // Job 1 finished. If the ownership check works, job 2's entry was NOT deleted by job 1's finally block
    // Calling without force while job 2 is still running (or finished with res2) should not resurrect a stale state
    const job1Row = await db.ai_jobs.get(res1.jobId);
    expect(job1Row?.status).toBe('failed');
    expect(job1Row?.error).toMatch(/superseded/i);
    expect((await db.thread_summaries.get(input.threadId))?.generationId).toBeTruthy();
  });
});

describe('owner-aware generations', () => {
  const owner = { email: 'aiden@gmail.com', name: 'Aiden Guan' };
  const input = { threadId: 'perspective', fingerprint: 'body-v1', subject: 'Pricing', messages: [{ sender: 'Aiden Guan <aiden@gmail.com>', bodyText: 'I sent the revised pricing.', timestamp: '' }] };
  function loop(db: ReturnType<typeof getMailboxDb>, ai: AIProvider | null, events: string[] = []) {
    return new AgentLoop({ db, ai, queue: new AIJobQueue(), settings: () => ({ ...DEFAULT_SETTINGS, aiMode: ai ? 'remote' : 'disabled' }), archiveViaGmail: async () => ({ success: false }), insertDraftViaGmail: async () => ({ success: false }), log: async () => 'log', onIntel: (_id, kind) => events.push(kind) });
  }
  it('does not infer or save while Gmail owner identity is still loading', async () => {
    const db = getMailboxDb(`perspective_wait_${Math.random()}`); const model = vi.fn();
    const agent = loop(db, { summarizeThread: model } as unknown as AIProvider);
    const result = await agent.startSummaryJob({ ...input, requireOwner: true });
    expect(result.ok).toBe(false); expect(result.reason).toMatch(/Resolving Gmail account/);
    expect(model).not.toHaveBeenCalled(); expect(await db.thread_summaries.get(input.threadId)).toBeUndefined();
  });
  it('discards an ownerless result after a newer owner-aware job, even after agent rebuild', async () => {
    const db = getMailboxDb(`perspective_rebuild_${Math.random()}`); const events: string[] = [];
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const old = loop(db, { summarizeThread: async () => { await gate; return { result: { oneLine: 'Aiden sent the pricing.', keyPoints: [], actionItems: [], dates: [], decisions: [], commitments: [], unansweredQuestions: [] } }; } } as unknown as AIProvider, events);
    const queued = await old.startSummaryJob(input);
    const current = loop(db, { summarizeThread: async (request) => { expect(request.messages[0]?.authorRole).toBe('owner'); return { result: { oneLine: 'You sent the pricing.', keyPoints: [], actionItems: [], dates: [], decisions: [], commitments: [], unansweredQuestions: [] } }; } } as AIProvider, events);
    await current.startSummaryJob({ ...input, owner, requireOwner: true });
    await vi.waitFor(async () => expect((await db.thread_summaries.get(input.threadId))?.summary.oneLine).toBe('You sent the pricing.'));
    release();
    await vi.waitFor(async () => expect((await db.ai_jobs.get(queued.jobId))?.status).toBe('failed'));
    expect((await db.thread_summaries.get(input.threadId))?.summary.oneLine).toBe('You sent the pricing.');
    expect(events.filter((kind) => kind === 'THREAD_SUMMARY_READY')).toHaveLength(1);
  });
  it('invalidates cached summaries when owner changes and rejects third-person model output', async () => {
    const db = getMailboxDb(`perspective_cache_${Math.random()}`);
    const model = vi.fn(async () => ({ result: { oneLine: 'Aiden sent the pricing.', keyPoints: [], actionItems: [], dates: [], decisions: [], commitments: [], unansweredQuestions: [] } }));
    const agent = loop(db, { summarizeThread: model } as unknown as AIProvider);
    await agent.startSummaryJob({ ...input, owner });
    await vi.waitFor(async () => expect((await db.thread_summaries.get(input.threadId))?.aiStatus).toBe('failed'));
    expect((await db.thread_summaries.get(input.threadId))?.summary.oneLine).not.toMatch(/^Aiden (?:sent|did)/);
    const first = (await db.thread_summaries.get(input.threadId))!.fingerprint;
    await agent.startSummaryJob({ ...input, owner: { email: 'maya@gmail.com', name: 'Maya' } });
    await vi.waitFor(async () => expect((await db.thread_summaries.get(input.threadId))?.source).toBe('model'));
    expect((await db.thread_summaries.get(input.threadId))!.fingerprint).not.toBe(first);
    expect(model).toHaveBeenCalledTimes(2);
  });
});
