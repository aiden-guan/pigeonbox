import { runMemoryReindex } from './memory/reindex.js';
import { runMemoryExtract } from './memory/extract.js';
import { runMemoryConsolidate } from './memory/consolidate.js';
import type { PigeonBoxCapability } from '@pigeonbox/api-contract';
import { InferenceError, isTransientInferenceError } from '../ai/backends.js';
import { getEntitlements } from '../entitlements.js';
import { GoogleApiError } from '../google/errors.js';
import { ApiError } from '../http.js';
import type { JobKind, JobRecord } from '../jobs/queue.js';
import { PermanentJobError, RetryLaterError, SkipJob, type JobHandlers } from '../jobs/runner.js';
import { BudgetExceededError } from './ai.js';
import { runThreadAnalyze } from './analyze.js';
import type { IntelDeps } from './context.js';
import { prepareDraft } from './drafts.js';
import { runFollowUpDue } from './followups.js';
import { ConnectionUnavailableError, jobErrorFrom } from './google-access.js';
import { runGmailRecover, runGmailSync, runGmailWatch } from './sync.js';
import { runApprovalExecute } from './approvals.js';
import { runAutomationJob } from './automations.js';
import { runBriefing } from './briefings.js';
import { runCalendarRefresh } from './calendar.js';
import { runReminder, runRetention } from './reminders.js';
import { runRulesEvaluate } from './rules.js';
import { runSearchIndex } from './search-index.js';
import { runSequenceJob } from './sequences.js';
import { runSignalsRefresh } from './signals.js';
import { runWebhookDelivery } from './webhooks.js';

/**
 * Job kind → handler, each behind the capability it needs. When an account
 * loses access, queued work for that user is skipped rather than run.
 */

export type ExtraHandlers = Partial<Record<JobKind, { capability: PigeonBoxCapability | null; run: (job: JobRecord, caps: Set<PigeonBoxCapability>) => Promise<void> }>>;

const REQUIRED: Partial<Record<JobKind, PigeonBoxCapability>> = {
  'gmail.watch': 'cloud_mail_sync',
  'gmail.sync': 'cloud_mail_sync',
  'gmail.recover': 'cloud_mail_sync',
  'thread.analyze': 'cloud_mail_sync',
  'memory.extract': 'cloud_mail_sync',
  'memory.reindex': 'cloud_mail_sync',
  'memory.consolidate': 'cloud_mail_sync',
  'draft.prepare': 'cloud_auto_drafts',
  'followup.due': 'cloud_mail_sync',
  'rules.evaluate': 'cloud_automations',
  'automation.run': 'cloud_automations',
  'briefing.generate': 'cloud_automations',
  'calendar.refresh': 'cloud_calendar',
  'search.index': 'cloud_semantic_search',
  'sequence.step': 'cloud_sequences',
  'signals.refresh': 'cloud_tracking',
  'reminder.fire': 'cloud_mail_sync',
  'webhook.deliver': 'cloud_mcp',
};

/**
 * Map errors from draft generation to retry decisions. Capacity problems (a Flex
 * 429, a timeout) pass through unchanged, so the runner retries them with
 * exponential backoff on the same tier.
 */
export function draftJobError(error: unknown): unknown {
  if (error instanceof BudgetExceededError) return new PermanentJobError(error.message);
  if (isTransientInferenceError(error)) return error;
  if (error instanceof InferenceError) {
    return error.code === 'provider_invalid_response' ? new PermanentJobError(error.code) : new RetryLaterError(error.code, 120);
  }
  if (error instanceof ApiError) return new PermanentJobError(`api_${error.code}`);
  if (error instanceof ConnectionUnavailableError || error instanceof GoogleApiError) return jobErrorFrom(error);
  return error;
}

export function createIntelJobHandlers(deps: IntelDeps, extra: ExtraHandlers = {}): JobHandlers {
  const entitlementCache = new Map<string, Promise<Set<PigeonBoxCapability>>>();
  const capabilitiesFor = (userId: string) => {
    let cached = entitlementCache.get(userId);
    if (!cached) {
      cached = getEntitlements(userId, deps.store, deps.config).then((entitlements) => new Set(entitlements.capabilities));
      entitlementCache.set(userId, cached);
    }
    return cached;
  };
  const guard =
    (kind: JobKind, capability: PigeonBoxCapability | null, run: (job: JobRecord, caps: Set<PigeonBoxCapability>) => Promise<void>) =>
    async (job: JobRecord) => {
      let caps = new Set<PigeonBoxCapability>();
      if (job.userId) {
        caps = await capabilitiesFor(job.userId);
        const needed = capability ?? REQUIRED[kind];
        if (needed && !caps.has(needed)) throw new SkipJob('not_entitled');
      }
      await run(job, caps);
    };

  const handlers: JobHandlers = {
    'gmail.watch': guard('gmail.watch', null, (job) => runGmailWatch(deps, job)),
    'gmail.sync': guard('gmail.sync', null, (job) => runGmailSync(deps, job)),
    'gmail.recover': guard('gmail.recover', null, (job) => runGmailRecover(deps, job)),
    'thread.analyze': guard('thread.analyze', null, (job, caps) =>
      runThreadAnalyze(deps, job, {
        autoDrafts: caps.has('cloud_auto_drafts'),
        automations: caps.has('cloud_automations'),
        search: caps.has('cloud_semantic_search'),
        relationships: caps.has('cloud_relationships'),
      }),
    ),
    'memory.reindex': guard('memory.reindex',null,(job) => runMemoryReindex(deps,job)),
    'memory.extract': guard('memory.extract', null, (job) => runMemoryExtract(deps,job)),
    'memory.consolidate': guard('memory.consolidate', null, (job) => runMemoryConsolidate(deps,job)),
    'draft.prepare': guard('draft.prepare', null, async (job) => {
      const threadRowId = String(job.payload.threadId ?? '');
      if (!job.userId || !threadRowId) throw new SkipJob('missing_ids');
      try {
        await prepareDraft(deps, job.userId, {
          threadRowId,
          kind: job.payload.kind as never,
          origin: (job.payload.origin as never) ?? 'auto',
          followUpId: (job.payload.followUpId as string | undefined) ?? null,
          instructions: (job.payload.instructions as string | undefined) ?? null,
          requestId: `job_${job.id}`,
          interactive: false,
        });
      } catch (error) {
        throw draftJobError(error);
      }
    }),
    'followup.due': guard('followup.due', null, (job, caps) => runFollowUpDue(deps, job, caps.has('cloud_auto_drafts'))),
    'rules.evaluate': guard('rules.evaluate', null, (job) => runRulesEvaluate(deps, job)),
    'automation.run': guard('automation.run', null, (job) => runAutomationJob(deps, job)),
    'briefing.generate': guard('briefing.generate', null, (job) => runBriefing(deps, job)),
    'calendar.refresh': guard('calendar.refresh', null, (job, caps) => runCalendarRefresh(deps, job, caps.has('cloud_automations'))),
    'search.index': guard('search.index', null, (job) => runSearchIndex(deps, job)),
    // Approvals run whatever the user approved; the action itself re-checks its own requirements.
    'approval.execute': guard('approval.execute', null, (job) => runApprovalExecute(deps, job)),
    'sequence.step': guard('sequence.step', null, (job) => runSequenceJob(deps, job)),
    'signals.refresh': guard('signals.refresh', null, (job) => runSignalsRefresh(deps, job)),
    'reminder.fire': guard('reminder.fire', null, (job) => runReminder(deps, job)),
    'webhook.deliver': guard('webhook.deliver', null, (job) => runWebhookDelivery(deps, job)),
    'retention.sweep': guard('retention.sweep', null, () => runRetention(deps)),
  };
  for (const [kind, handler] of Object.entries(extra) as Array<[JobKind, NonNullable<ExtraHandlers[JobKind]>]>) {
    handlers[kind] = guard(kind, handler.capability, handler.run);
  }
  return handlers;
}
