import { CloudOverviewResponseSchema, type CloudOverview, type PigeonBoxCapability } from '@pigeonbox/api-contract';
import { one, num } from '../db/sql.js';
import type { IntelDeps } from './context.js';
import { listAccounts } from './connections.js';
import { draftCounts } from './drafts.js';
import { buildFocusQueue, focusCoverage } from './focus.js';
import { listBriefings, loadBriefing } from './briefings.js';
import { listViews } from './rules.js';
import { listAutomations, listRuns } from './automations.js';
import { recentMail } from './recent.js';

/** Separate RLS transactions isolate optional failures, including an unreadable briefing. No inference or writes. */
export async function cloudOverview(deps: IntelDeps, userId: string, capabilities: readonly PigeonBoxCapability[], requestedSince?: string): Promise<CloudOverview> {
  const now = deps.now();
  const requested = requestedSince ? Date.parse(requestedSince) : now.getTime() - 86400000;
  const since = new Date(Math.max(now.getTime() - 30 * 86400000, Math.min(now.getTime(), requested))).toISOString();
  const unavailable: CloudOverview['unavailable'] = [];
  async function section<T>(name: CloudOverview['unavailable'][number], enabled: boolean, read: () => Promise<T>): Promise<T | null> {
    if (!enabled) return null;
    try { return await read(); }
    catch {
      unavailable.push(name);
      deps.log('warn', 'overview section unavailable', { operation: 'overview', code: `overview_${name}_unavailable` });
      return null;
    }
  }
  const canAutomate = capabilities.includes('cloud_automations');
  const canDraft = capabilities.includes('cloud_auto_drafts');
  const [accounts, activity, focus, recent, latestBriefing, automatic] = await Promise.all([
    section('accounts', true, () => deps.db.asUser(userId, listAccounts)),
    section('work', true, () => deps.db.asUser(userId, async (tx) => {
      const row = await one<{ analyzed: number; drafts: number; follows: number; approvals: number }>(tx, `
        select (select count(*)::int from public.thread_states where analyzed_at >= $1::timestamptz) as analyzed,
          (select count(*)::int from public.drafts where created_at >= $1::timestamptz and current_version > 0 and status not in ('failed','discarded')) as drafts,
          (select count(*)::int from public.follow_ups where created_at >= $1::timestamptz) as follows,
          (select count(*)::int from public.approvals where status = 'pending') as approvals`, [since]);
      const open = await one<{ follows: number }>(tx, `select count(*)::int as follows from public.follow_ups where stage not in ('reply', 'closed')`);
      const drafts = canDraft ? await draftCounts(tx, null, now) : null;
      return {
        work: { threadsAnalyzed: num(row?.analyzed), draftsPrepared: canDraft ? num(row?.drafts) : null, followUpsDetected: num(row?.follows), approvalsWaiting: num(row?.approvals) },
        // Current work, independent of the visit window, so Home never mixes the two scopes.
        prepared: {
          drafts: drafts ? { ready: drafts.ready, inGmail: drafts.placed + drafts.user_edited, needsUpdate: drafts.stale + drafts.failed, preparing: drafts.preparing } : null,
          followUpsOpen: num(open?.follows),
          approvalsWaiting: num(row?.approvals),
        },
      };
    })),
    section('focus', true, () => deps.db.asUser(userId, async (tx) => ({ ...(await buildFocusQueue(tx, { accountId: null, limit: 8, now })), generatedAt: now.toISOString(), coverage: await focusCoverage(tx) }))),
    // `recent` has no `unavailable` entry, so older clients keep parsing; null alone says it failed.
    recentMail(deps, userId, { limit: 20, now, canDraft }).catch(() => {
      deps.log('warn', 'overview section unavailable', { operation: 'overview', code: 'overview_recent_unavailable' });
      return null;
    }),
    section('briefing', canAutomate, () => deps.db.asUser(userId, async (tx) => {
      const latest = (await listBriefings(tx, undefined, 1))[0];
      return latest ? loadBriefing(deps, tx, userId, latest.id) : null;
    })),
    section('automatic', canAutomate, () => deps.db.asUser(userId, async (tx) => ({ views: await listViews(tx), automations: await listAutomations(tx), runs: await listRuns(tx, undefined, 10) }))),
  ]);
  if (!canDraft && focus) for (const section of focus.sections) for (const item of section.items) Object.assign(item, { draftReady: false, draftId: null, draftStatus: null });
  return withinContract(deps, { generatedAt: now.toISOString(), since, accounts, work: activity?.work ?? null, prepared: activity?.prepared ?? null, focus, recent, latestBriefing, automatic, unavailable });
}

/** Which `unavailable` entry an off-contract top-level field is reported as; `recent` has none. */
const SECTION_OF: Partial<Record<keyof CloudOverview, CloudOverview['unavailable'][number] | null>> = {
  accounts: 'accounts', work: 'work', prepared: 'work', focus: 'focus', recent: null, latestBriefing: 'briefing', automatic: 'automatic',
};

/**
 * One off-contract section (say, a stored briefing longer than the contract allows)
 * must not fail the whole response: it is dropped like a failed read and logged by
 * field path only, never by value.
 */
export function withinContract(deps: IntelDeps, overview: CloudOverview): CloudOverview {
  const checked = CloudOverviewResponseSchema.safeParse(overview);
  if (checked.success) return overview;
  const result = { ...overview, unavailable: [...overview.unavailable] };
  for (const issue of checked.error.issues) {
    const field = issue.path[0] as keyof CloudOverview;
    if (!(field in SECTION_OF)) continue;
    deps.log('warn', 'overview section off contract', { operation: 'overview', code: `overview_${String(field)}_invalid`, detail: `${issue.path.join('.')}: ${issue.code}`.slice(0, 200) });
    if (field === 'work' || field === 'prepared') Object.assign(result, { work: null, prepared: null });
    else Object.assign(result, { [field]: null });
    const section = SECTION_OF[field];
    if (section && !result.unavailable.includes(section)) result.unavailable.push(section);
  }
  return result;
}
