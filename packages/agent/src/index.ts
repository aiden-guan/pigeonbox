import type { AIProvider, AIJobQueue, MailboxOwner } from '@pigeonbox/ai';
import { draftNeedsRefresh, draftQualityIssue } from '@pigeonbox/ai';
import type { MailboxDatabase } from '@pigeonbox/mailbox';
import {
  AgentSafetyTier,
  addBusinessDays,
  detectPlaceholders,
  isPastedSummary,
  localThreadSummary,
  tightenSummary,
  tagAuthors,
  ownerPerspectiveKey,
  summaryPerspectiveIssue,
  sha256Hex,
  type AuthorRole,
  type AIJobStatus,
  type ClassificationResult,
  type ExtensionSettings,
} from '@pigeonbox/shared';
import {
  applyRules,
  archiveDecision,
  classifyHeuristic,
  type HeuristicInput,
} from './classify.js';

const SUMMARY_VERSION = 'sum9';
type SummaryInput = { fingerprint: string; owner?: MailboxOwner };
async function summaryFingerprint(input: SummaryInput): Promise<string> {
  return `${input.fingerprint}:${SUMMARY_VERSION}:${await sha256Hex(ownerPerspectiveKey(input.owner))}`;
}

export type AgentLoopDeps = {
  db: MailboxDatabase;
  ai: AIProvider | null;
  queue: AIJobQueue;
  settings: () => ExtensionSettings;
  archiveViaGmail: (threadId: string) => Promise<{ success: boolean; error?: string }>;
  insertDraftViaGmail: (
    threadId: string,
    body: string,
  ) => Promise<{ success: boolean; localOnly?: boolean; error?: string }>;
  log: (entry: {
    type: string;
    threadId?: string;
    detail: string;
    undoable?: boolean;
    tier: number;
    expiresAt?: number;
  }) => Promise<string>;
  onIntel?: (threadId: string, kind: 'THREAD_CLASSIFIED' | 'THREAD_SUMMARY_READY' | 'THREAD_DRAFT_READY' | 'THREAD_INTELLIGENCE_UPDATED') => void;
};

/**
 * Deterministic event-driven agent loop.
 * Each step independently retryable; persist after meaningful steps.
 * Tier 3 actions never autonomous.
 */
const summaryCoordinators = new WeakMap<MailboxDatabase, { generations: Map<string, { inputKey: string; id: string }>; writes: Promise<unknown> }>();
export class AgentLoop {
  private get summaryCoordinator() {
    let coordinator = summaryCoordinators.get(this.deps.db);
    if (!coordinator) { coordinator = { generations: new Map(), writes: Promise.resolve() }; summaryCoordinators.set(this.deps.db, coordinator); }
    return coordinator;
  }
  private get summaryGenerations() { return this.summaryCoordinator.generations; }
  private saveSummary(row: Parameters<MailboxDatabase['thread_summaries']['put']>[0], current: () => boolean) {
    const coordinator = this.summaryCoordinator;
    const write = coordinator.writes.then(async () => {
      if (!current()) return false;
      await this.deps.db.thread_summaries.put(row);
      return current();
    });
    coordinator.writes = write.catch(() => undefined);
    return write;
  }
  private lastClassifierRun: number | null = null;
  private inFlightJobs = new Map<
    string,
    {
      jobId: string;
      status: AIJobStatus;
      promise: Promise<{
        ok: boolean;
        oneLine?: string;
        body?: string;
        source?: 'model' | 'message';
        aiStatus?: 'success' | 'failed';
        error?: string;
      }>;
    }
  >();

  constructor(private readonly deps: AgentLoopDeps) {}

  getLastClassifierRun(): number | null {
    return this.lastClassifierRun;
  }

  async onNewMessage(input: HeuristicInput & {
    threadId: string;
    fingerprint: string;
    subject: string;
    quality?: 'ROW_STUB' | 'THREAD_PARTIAL' | 'THREAD_COMPLETE';
    owner?: MailboxOwner;
    requireOwner?: boolean;
    messages: Array<{ sender: string; bodyText: string; timestamp: string; authorRole?: AuthorRole }>;
  }): Promise<void> {
    const settings = this.deps.settings();
    const quality = input.quality || 'THREAD_PARTIAL';
    const reliable = quality === 'THREAD_COMPLETE';
    const existing = await this.deps.db.thread_classifications.get(input.threadId);
    if (existing?.fingerprint === input.fingerprint) {
      if (hasReadableBody(input.messages) && settings.autoSummarize) await this.summarizeIfNeeded(input);
      return;
    }

    const override = await this.deps.db.thread_overrides.get(input.threadId);
    const rules = (await this.deps.db.agent_rules.filter((r) => r.enabled).toArray()).map(
      (r) => r.structured,
    );
    let classification: ClassificationResult | null = override
      ? null
      : applyRules(input, rules);
    let source: 'rule' | 'heuristic' | 'ai' | 'override' = override ? 'override' : 'rule';

    if (override) {
      const base = classifyHeuristic(input);
      classification = {
        category: override.category,
        confidence: 1,
        priority: base?.priority || 'NORMAL',
        needsReply: override.category === 'RESPOND',
        waitingOnReply: override.category === 'WAITING',
        archiveRecommendation: false,
        reason: 'You set this category',
        deadline: null,
      };
    } else if (!classification) {
      classification = classifyHeuristic(input);
      source = 'heuristic';
    }

    if (
      !override &&
      reliable &&
      (!classification ||
        (classification.confidence < 0.7 && settings.aiMode !== 'disabled' && this.deps.ai && settings.autoClassify))
    ) {
      try {
        const aiResult = await this.deps.queue.enqueue('classify', input.fingerprint, () =>
          this.deps.ai!.classifyEmail({
            subject: input.subject,
            snippet: input.snippet,
            bodyText: input.bodyText,
            latestSender: input.latestSenderEmail,
            direction: input.direction,
            gmailCategoryHint: input.gmailCategoryHint,
            hasListUnsubscribe: input.hasListUnsubscribe,
          }),
          { timeoutMs: this.deps.settings().aiProvider === 'local' ? 300_000 : 25_000 },
        );
        if (!applyRules(input, rules)) {
          classification = aiResult.result;
          source = 'ai';
        }
      } catch {
        // AI failure must never block — keep heuristic
      }
    }

    if (!classification) {
      classification = {
        category: 'FYI',
        confidence: 0.4,
        priority: 'NORMAL',
        needsReply: false,
        waitingOnReply: false,
        archiveRecommendation: false,
        reason: 'Fallback FYI',
        deadline: null,
      };
      source = 'heuristic';
    }

    this.lastClassifierRun = Date.now();

    await this.deps.db.thread_classifications.put({
      threadId: input.threadId,
      ...classification,
      source,
      fingerprint: input.fingerprint,
      createdAt: Date.now(),
    });

    await this.deps.db.threads.update(input.threadId, {
      classification: classification.category,
      classificationConfidence: classification.confidence,
      priority: classification.priority,
      requiresResponse: classification.needsReply,
      awaitingResponse: classification.waitingOnReply,
      virtualLabels: [classification.category],
      manualCategory: override ? override.category : undefined,
    });

    await this.deps.log({
      type: 'classify',
      threadId: input.threadId,
      detail: `${classification.category} (${source}, ${classification.confidence.toFixed(2)}): ${classification.reason}`,
      tier: AgentSafetyTier.READ_ONLY,
    });
    this.deps.onIntel?.(input.threadId, 'THREAD_CLASSIFIED');
    this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');

    if (hasReadableBody(input.messages) && settings.autoSummarize) {
      await this.summarizeIfNeeded(input);
    }
    if (!reliable) return;

    if (classification.category === 'RESPOND' && settings.autoDraft && this.deps.ai && settings.aiMode !== 'disabled') {
      await this.draftResponse(input, settings.autoInsertDraft);
    } else if (classification.category === 'WAITING' && settings.autoReminders) {
      await this.trackFollowUp(input);
    }

    if (settings.autoArchive) {
      await this.maybeArchive(input, classification, rules);
    }
  }

  async onOutgoing(input: {
    threadId: string;
    recipients: string[];
    subject: string;
    bodyText: string;
    fingerprint: string;
  }): Promise<void> {
    const settings = this.deps.settings();
    // Tracking is handled separately — never block send
    if (settings.autoReminders && settings.reminderMode !== 'disabled') {
      const likelyFollowUp =
        settings.reminderMode === 'every_external' ||
        /(\?|please|let me know|can you|could you|looking forward)/i.test(input.bodyText);

      if (settings.reminderMode === 'every_external' || (settings.reminderMode === 'ai_needed' && likelyFollowUp)) {
        const due = addBusinessDays(new Date(), settings.reminderBusinessDays).getTime();
        await this.deps.db.reminders.put({
          id: `rem_${input.threadId}`,
          threadId: input.threadId,
          recipients: input.recipients,
          lastOutgoingAt: Date.now(),
          dueAt: due,
          status: 'pending',
          reason:
            settings.reminderMode === 'every_external'
              ? 'Outbound follow-up tracking (every external)'
              : 'Outbound may need follow-up',
        });
        await this.deps.log({
          type: 'reminder_created',
          threadId: input.threadId,
          detail: `Follow-up due ${new Date(due).toLocaleDateString()}`,
          tier: AgentSafetyTier.REVERSIBLE,
          undoable: true,
        });
      }
    }
  }

  async resolveReminderOnInbound(threadId: string): Promise<void> {
    const pending = await this.deps.db.reminders.where('threadId').equals(threadId).toArray();
    let resolved = false;
    for (const rem of pending) {
      if (rem.status !== 'pending') continue;
      await this.deps.db.reminders.update(rem.id, { status: 'resolved' });
      resolved = true;
    }
    if (!resolved) return;
    await this.deps.log({
      type: 'reminder_resolved',
      threadId,
      detail: 'Inbound reply received',
      tier: AgentSafetyTier.READ_ONLY,
    });
  }

  async startSummaryJob(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string; authorRole?: AuthorRole }>;
    owner?: MailboxOwner;
    force?: boolean;
    requireOwner?: boolean;
  }): Promise<{
    ok: boolean;
    jobId: string;
    status: AIJobStatus;
    oneLine?: string;
    source?: 'model' | 'message';
    aiStatus?: 'queued' | 'running' | 'success' | 'failed';
    error?: string;
    reason?: string;
  }> {
    if (!input.messages.some((message) => message.bodyText.trim())) {
      return { ok: false, jobId: '', status: 'failed', reason: 'Open the thread so the message can be read.' };
    }
    if (input.requireOwner && !input.owner?.email) {
      return { ok: false, jobId: '', status: 'failed', reason: 'Resolving Gmail account…' };
    }
    input = { ...input, messages: tagAuthors(input.messages, input.owner) };
    const perspective = ownerPerspectiveKey(input.owner);
    const inputKey = `${input.fingerprint}:${perspective}`;
    const previousGeneration = this.summaryGenerations.get(input.threadId);
    const generation = !input.force && previousGeneration?.inputKey === inputKey ? previousGeneration
      : { inputKey, id: crypto.randomUUID() };
    this.summaryGenerations.set(input.threadId, generation);
    const isCurrent = () => this.summaryGenerations.get(input.threadId)?.id === generation.id;
    const fingerprint = await summaryFingerprint(input);
    const existing = await this.deps.db.thread_summaries.get(input.threadId);
    const storedLine = existing?.summary.oneLine || '';
    const stalePaste = Boolean(storedLine) && isPastedSummary(storedLine, input.messages);

    if (!input.force && existing?.fingerprint === fingerprint && existing.source === 'model' && existing.aiStatus === 'success' && !stalePaste) {
      return {
        ok: true,
        jobId: 'completed',
        status: 'succeeded',
        oneLine: existing.summary.oneLine,
        source: 'model',
        aiStatus: 'success',
      };
    }

    const key = `summary:${input.threadId}:${fingerprint}`;
    const inFlight = this.inFlightJobs.get(key);
    if (!input.force && inFlight) {
      return { ok: true, jobId: inFlight.jobId, status: inFlight.status };
    }

    if (!isCurrent()) return { ok: false, jobId: '', status: 'failed', reason: 'Summary superseded by newer input.' };
    const aiReady = Boolean(this.deps.ai) && this.deps.settings().aiMode !== 'disabled';
    if (!aiReady) {
      const summary = perspectiveSafeFallback(input);
      const saved = await this.saveSummary({
        threadId: input.threadId,
        fingerprint,
        sourceFingerprint: input.fingerprint,
        ownerPerspective: perspective,
        generationId: generation.id,
        summary,
        createdAt: Date.now(),
        source: 'message',
      }, isCurrent);
      if (!saved) return { ok: false, jobId: '', status: 'failed', reason: 'Summary superseded by newer input.' };
      await this.deps.log({
        type: 'summarize',
        threadId: input.threadId,
        detail: summary.oneLine,
        tier: AgentSafetyTier.READ_ONLY,
      });
      this.deps.onIntel?.(input.threadId, 'THREAD_SUMMARY_READY');
      this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');
      return {
        ok: true,
        jobId: 'local',
        status: 'succeeded',
        oneLine: summary.oneLine,
        source: 'message',
      };
    }

    const jobId = `job_sum_${input.threadId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.deps.db.ai_jobs?.put({
      id: jobId,
      kind: 'summary',
      threadId: input.threadId,
      fingerprint,
      status: 'queued',
      provider: this.deps.settings().aiProvider,
      model: this.deps.settings().aiModel,
      createdAt: Date.now(),
    }).catch(() => {});

    const p = (async () => {
      try {
        await this.deps.db.ai_jobs?.update(jobId, { status: 'running', startedAt: Date.now() }).catch(() => {});
        const active = this.inFlightJobs.get(key);
        if (active) active.status = 'running';

        const { result } = await this.deps.queue.enqueue(
          'summary',
          fingerprint,
          () =>
            this.deps.ai!.summarizeThread({
              subject: input.subject,
              messages: input.messages,
              owner: input.owner,
            }),
          { bypassCache: Boolean(input.force), timeoutMs: this.deps.settings().aiProvider === 'local' ? 300_000 : 25_000 },
        );
        const summary = tightenSummary(result, input);
        if (!isCurrent()) throw new Error('Summary superseded by newer input.');
        if (summaryPerspectiveIssue(summary, input)) throw new Error('The model returned an inconsistent owner perspective.');
        const saved = await this.saveSummary({
          threadId: input.threadId,
          fingerprint,
          sourceFingerprint: input.fingerprint,
          ownerPerspective: perspective,
          generationId: generation.id,
          summary,
          createdAt: Date.now(),
          source: 'model',
          aiStatus: 'success',
          provider: this.deps.settings().aiProvider,
          model: this.deps.settings().aiModel,
        }, isCurrent);
        if (!saved) throw new Error('Summary superseded by newer input.');
        await this.deps.db.ai_jobs?.update(jobId, {
          status: 'succeeded',
          completedAt: Date.now(),
          resultId: input.threadId,
        }).catch(() => {});
        await this.deps.log({
          type: 'summarize',
          threadId: input.threadId,
          detail: summary.oneLine,
          tier: AgentSafetyTier.READ_ONLY,
        });
        this.deps.onIntel?.(input.threadId, 'THREAD_SUMMARY_READY');
        this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');
        return { ok: true, oneLine: summary.oneLine, source: 'model' as const, aiStatus: 'success' as const };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (!isCurrent()) {
          await this.deps.db.ai_jobs?.update(jobId, { status: 'failed', completedAt: Date.now(), error: 'Summary superseded by newer input.' }).catch(() => {});
          return { ok: false, error: 'Summary superseded by newer input.' };
        }
        const fallback = perspectiveSafeFallback(input);
        const saved = await this.saveSummary({
          threadId: input.threadId,
          fingerprint,
          sourceFingerprint: input.fingerprint,
          ownerPerspective: perspective,
          generationId: generation.id,
          summary: fallback,
          createdAt: Date.now(),
          source: 'message',
          aiStatus: 'failed',
          aiError: errorMsg,
          provider: this.deps.settings().aiProvider,
          model: this.deps.settings().aiModel,
        }, isCurrent);
        if (!saved) return { ok: false, error: 'Summary superseded by newer input.' };
        await this.deps.db.ai_jobs?.update(jobId, {
          status: 'failed',
          completedAt: Date.now(),
          error: errorMsg,
        }).catch(() => {});
        this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');
        return { ok: false, error: errorMsg, source: 'message' as const, aiStatus: 'failed' as const, oneLine: fallback.oneLine };
      } finally {
        if (this.inFlightJobs.get(key)?.jobId === jobId) {
          this.inFlightJobs.delete(key);
        }
      }
    })();

    this.inFlightJobs.set(key, { jobId, status: 'queued', promise: p });
    return { ok: true, jobId, status: 'queued' };
  }

  async startDraftJob(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string; authorRole?: AuthorRole }>;
    owner?: MailboxOwner;
    force?: boolean;
    insertIntoGmail?: boolean;
  }): Promise<{
    ok: boolean;
    jobId: string;
    status: AIJobStatus;
    body?: string;
    error?: string;
    reason?: string;
  }> {
    if (!this.deps.ai || this.deps.settings().aiMode === 'disabled') {
      return { ok: false, jobId: '', status: 'failed', reason: 'Turn on AI in Settings to draft a reply.' };
    }
    if (!input.messages.some((message) => message.bodyText.trim())) {
      return { ok: false, jobId: '', status: 'failed', reason: 'Open the thread so a reply can be drafted.' };
    }

    const drafts = await this.deps.db.draft_suggestions.where('threadId').equals(input.threadId).toArray();
    const existing = drafts.find((d) => d.fingerprint === input.fingerprint);
    const voice = this.deps.settings().voiceProfile;
    const existingQualityIssue = existing?.suggestion?.body
      ? draftQualityIssue(input.messages, existing.suggestion.body, input.owner, voice) ||
        (draftNeedsRefresh(existing.suggestion.body, { ...input, voice, kind: 'reply' }) ? 'Saved draft predates the current sign-off.' : null)
      : null;
    if (!input.force && existing?.suggestion?.body && !existingQualityIssue) {
      return { ok: true, jobId: 'completed', status: 'succeeded', body: existing.suggestion.body };
    }
    if (existingQualityIssue && existing) await this.deps.db.draft_suggestions.delete(existing.id);

    const key = `draft:${input.threadId}:${input.fingerprint}`;
    const inFlight = this.inFlightJobs.get(key);
    if (!input.force && inFlight) {
      return { ok: true, jobId: inFlight.jobId, status: inFlight.status };
    }

    const jobId = `job_draft_${input.threadId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.deps.db.ai_jobs?.put({
      id: jobId,
      kind: 'draft',
      threadId: input.threadId,
      fingerprint: input.fingerprint,
      status: 'queued',
      provider: this.deps.settings().aiProvider,
      model: this.deps.settings().aiModel,
      createdAt: Date.now(),
    }).catch(() => {});

    const p = (async () => {
      try {
        await this.deps.db.ai_jobs?.update(jobId, { status: 'running', startedAt: Date.now() }).catch(() => {});
        const active = this.inFlightJobs.get(key);
        if (active) active.status = 'running';

        const { result } = await this.deps.queue.enqueue(
          'draft',
          input.fingerprint,
          () =>
            this.deps.ai!.draftReply({
              threadId: input.threadId,
              subject: input.subject,
              messages: input.messages,
              owner: input.owner,
              voice: this.deps.settings().voiceProfile,
              mode: 'direct',
              kind: 'reply',
            }),
          { bypassCache: Boolean(input.force || existingQualityIssue), timeoutMs: this.deps.settings().aiProvider === 'local' ? 300_000 : 25_000 },
        );
        const qualityIssue = draftQualityIssue(input.messages, result.body, input.owner, voice);
        if (qualityIssue) throw new Error(qualityIssue);
        const placeholders = detectPlaceholders(result.body);
        const suggestion = { ...result, placeholders };
        const id = `draft_${input.threadId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await this.deps.db.draft_suggestions.put({
          id,
          threadId: input.threadId,
          fingerprint: input.fingerprint,
          suggestion,
          insertedIntoGmail: false,
          createdAt: Date.now(),
        });
        await this.deps.db.ai_jobs?.update(jobId, {
          status: 'succeeded',
          completedAt: Date.now(),
          resultId: id,
        }).catch(() => {});

        let inserted = false;
        if (input.insertIntoGmail) {
          const res = await this.deps.insertDraftViaGmail(input.threadId, suggestion.body);
          inserted = res.success;
          if (inserted) await this.deps.db.draft_suggestions.update(id, { insertedIntoGmail: true });
        }
        await this.deps.log({
          type: 'draft',
          threadId: input.threadId,
          detail: inserted ? 'Draft inserted into Gmail' : 'Draft saved locally',
          tier: AgentSafetyTier.DRAFT_WRITE,
          undoable: true,
        });
        this.deps.onIntel?.(input.threadId, 'THREAD_DRAFT_READY');
        this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');
        return { ok: true, body: result.body };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Could not draft a reply.';
        await this.deps.db.ai_jobs?.update(jobId, {
          status: 'failed',
          completedAt: Date.now(),
          error: errorMsg,
        }).catch(() => {});
        this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');
        return { ok: false, error: errorMsg };
      } finally {
        if (this.inFlightJobs.get(key)?.jobId === jobId) {
          this.inFlightJobs.delete(key);
        }
      }
    })();

    this.inFlightJobs.set(key, { jobId, status: 'queued', promise: p });
    return { ok: true, jobId, status: 'queued' };
  }

  async requestSummary(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string; authorRole?: AuthorRole }>;
    owner?: MailboxOwner;
    force?: boolean;
  }): Promise<{ ok: boolean; oneLine?: string; source?: 'model' | 'message'; aiStatus?: 'queued' | 'running' | 'success' | 'failed'; reason?: string; error?: string }> {
    if (!input.messages.some((message) => message.bodyText.trim())) {
      return { ok: false, reason: 'Open the thread so the message can be read.' };
    }
    // Fingerprint first: the job can finish while this awaits, and finishing removes it from inFlightJobs.
    const key = `summary:${input.threadId}:${await summaryFingerprint(input)}`;
    const launched = await this.startSummaryJob(input);
    const job = this.inFlightJobs.get(key);
    if (launched.status === 'succeeded') {
      return {
        ok: true,
        oneLine: launched.oneLine,
        source: launched.source,
        aiStatus: launched.aiStatus || 'success',
      };
    }
    if (launched.status === 'failed') {
      return {
        ok: false,
        reason: launched.reason || launched.error,
        error: launched.error,
        source: 'message',
        aiStatus: 'failed',
        oneLine: launched.oneLine,
      };
    }
    if (job) {
      const res = await job.promise;
      if (res.ok) {
        return { ok: true, oneLine: res.oneLine, source: 'model', aiStatus: 'success' };
      }
      return {
        ok: false,
        oneLine: res.oneLine,
        source: 'message',
        aiStatus: 'failed',
        error: res.error,
        reason: res.error,
      };
    }
    return { ok: false, reason: 'Summary job not found' };
  }

  async requestDraft(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string; authorRole?: AuthorRole }>;
    owner?: MailboxOwner;
    force?: boolean;
  }): Promise<{ ok: boolean; body?: string; reason?: string; error?: string }> {
    const launched = await this.startDraftJob(input);
    if (launched.status === 'succeeded' && launched.body) {
      return { ok: true, body: launched.body };
    }
    if (launched.status === 'failed') {
      return { ok: false, reason: launched.reason || launched.error, error: launched.error };
    }
    const key = `draft:${input.threadId}:${input.fingerprint}`;
    const job = this.inFlightJobs.get(key);
    if (job) {
      const res = await job.promise;
      if (res.ok && res.body) return { ok: true, body: res.body };
      return { ok: false, reason: res.error || 'Could not draft a reply.', error: res.error };
    }
    return { ok: false, reason: 'Draft job not found' };
  }

  private async summarizeIfNeeded(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender?: string; bodyText: string; timestamp?: string }>;
    owner?: MailboxOwner;
  }): Promise<void> {
    const launched = await this.startSummaryJob({
      threadId: input.threadId,
      fingerprint: input.fingerprint,
      subject: input.subject,
      messages: input.messages.map((m) => ({
        sender: m.sender || 'unknown@local',
        bodyText: m.bodyText,
        timestamp: m.timestamp || '',
      })),
      owner: input.owner,
      requireOwner: (input as { requireOwner?: boolean }).requireOwner,
    });
    if (launched.status === 'queued') {
      const fingerprint = await summaryFingerprint(input);
      const key = `summary:${input.threadId}:${fingerprint}`;
      const job = this.inFlightJobs.get(key);
      if (job) await job.promise;
    }
  }

  private async draftResponse(
    input: {
      threadId: string;
      fingerprint: string;
      subject: string;
      messages: Array<{ sender?: string; bodyText: string; timestamp?: string }>;
      owner?: MailboxOwner;
    },
    autoInsert = false,
  ): Promise<void> {
    const launched = await this.startDraftJob({
      threadId: input.threadId,
      fingerprint: input.fingerprint,
      subject: input.subject,
      messages: input.messages.map((m) => ({
        sender: m.sender || 'unknown@local',
        bodyText: m.bodyText,
        timestamp: m.timestamp || '',
      })),
      owner: input.owner,
      insertIntoGmail: autoInsert,
    });
    if (launched.status === 'queued') {
      const key = `draft:${input.threadId}:${input.fingerprint}`;
      const job = this.inFlightJobs.get(key);
      if (job) await job.promise;
    }
  }

  private async trackFollowUp(input: {
    threadId: string;
    latestSenderEmail: string;
  }): Promise<void> {
    const settings = this.deps.settings();
    const due = addBusinessDays(new Date(), settings.reminderBusinessDays).getTime();
    await this.deps.db.reminders.put({
      id: `rem_${input.threadId}`,
      threadId: input.threadId,
      recipients: [input.latestSenderEmail],
      lastOutgoingAt: Date.now(),
      dueAt: due,
      status: 'pending',
      reason: 'Waiting on reply',
    });
  }

  private async maybeArchive(
    input: { threadId: string; latestSenderEmail: string },
    classification: ClassificationResult,
    rules: import('@pigeonbox/mailbox').StructuredRule[],
  ): Promise<void> {
    const settings = this.deps.settings();
    const decision = archiveDecision({
      category: classification.category,
      confidence: classification.confidence,
      senderEmail: input.latestSenderEmail,
      archiveCategories: settings.archiveCategories,
      threshold: settings.archiveConfidenceThreshold,
      alwaysArchive: settings.alwaysArchiveSenders,
      neverArchive: settings.neverArchiveSenders,
      rules,
    });

    if (!decision.shouldArchive) return;

    if (!decision.autonomous) {
      await this.deps.log({
        type: 'archive_recommendation',
        threadId: input.threadId,
        detail: decision.reason,
        tier: AgentSafetyTier.REVERSIBLE,
      });
      return;
    }

    // Tier 1 — only if enabled (settings.autoArchive already checked)
    const result = await this.deps.archiveViaGmail(input.threadId);
    if (result.success) {
      await this.deps.db.threads.update(input.threadId, { archivedLocally: true });
      await this.deps.log({
        type: 'archive',
        threadId: input.threadId,
        detail: decision.reason,
        undoable: true,
        tier: AgentSafetyTier.REVERSIBLE,
        expiresAt: Date.now() + 30_000, // short-lived undo
      });
    }
  }
}

function hasReadableBody(messages: Array<{ bodyText: string }>): boolean {
  return messages.some((message) => message.bodyText.trim().length > 0);
}

export * from './classify.js';

function perspectiveSafeFallback(input: { subject: string; owner?: MailboxOwner; messages: Array<{ sender: string; bodyText: string; authorRole?: AuthorRole }> }) {
  const summary = localThreadSummary(input);
  if (!summaryPerspectiveIssue(summary, input)) return summary;
  return { ...summary, oneLine: 'Your conversation is ready to review.', keyPoints: [], commitments: [], actionItems: [] };
}
