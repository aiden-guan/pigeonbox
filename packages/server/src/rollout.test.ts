import type { ComposeCheckResponse } from '@pigeonbox/api-contract';
import { addCalendarDays, detectComposeContext, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNoticePolicy, applyNoticePolicy, confidenceBucket, latencyBucket, DEFAULT_NOTICE_POLICY } from './intel/compose-policy.js';
import { cohortOf, featureEnabled, parseRollout, ROLLOUT_FEATURES } from './rollout.js';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from './testing/intel-harness.js';
import { loadConfig } from './config.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const EARLY = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ZONE = 'America/New_York';

describe('rollout stages', () => {
  it('changes nothing when unset, and old configs without rollout keep every feature', () => {
    const rollout = parseRollout({});
    for (const feature of ROLLOUT_FEATURES) expect(featureEnabled(rollout, feature, OTHER)).toBe(true);
    expect(rollout.invalid).toEqual([]);
    expect(featureEnabled(undefined, 'auto_drafts', OTHER)).toBe(true);
  });

  it('gates by cohort deterministically: internal ⊂ early beta ⊂ beta', () => {
    const rollout = parseRollout({ CLOUD_ROLLOUT: 'compose_semantic=internal, auto_drafts=early_beta, briefings=off', CLOUD_INTERNAL_USER_IDS: OWNER.toUpperCase(), CLOUD_EARLY_BETA_USER_IDS: `${EARLY}, not-a-uuid` });
    expect([cohortOf(rollout, OWNER), cohortOf(rollout, EARLY), cohortOf(rollout, OTHER)]).toEqual(['internal', 'early_beta', 'beta']);
    expect([OWNER, EARLY, OTHER].map((id) => featureEnabled(rollout, 'compose_semantic', id))).toEqual([true, false, false]);
    expect([OWNER, EARLY, OTHER].map((id) => featureEnabled(rollout, 'auto_drafts', id))).toEqual([true, true, false]);
    expect([OWNER, EARLY, OTHER].map((id) => featureEnabled(rollout, 'briefings', id))).toEqual([false, false, false]);
    // Unrelated features are untouched.
    expect([OWNER, EARLY, OTHER].map((id) => featureEnabled(rollout, 'memory_learning', id))).toEqual([true, true, true]);
    expect(rollout.earlyBeta.size).toBe(1);
  });

  it('fails closed on a mistyped stage, ignores unknown features, and reports neither user IDs nor values', () => {
    const rollout = parseRollout({ CLOUD_ROLLOUT: 'auto_drafts=of,unknown_feature=off,compose_checks', CLOUD_INTERNAL_USER_IDS: OWNER });
    expect(featureEnabled(rollout, 'auto_drafts', OWNER)).toBe(false);
    expect(featureEnabled(rollout, 'compose_checks', OWNER)).toBe(false);
    expect(rollout.invalid).toEqual(['auto_drafts', 'unknown_feature', 'compose_checks']);
    expect(JSON.stringify(rollout.invalid)).not.toContain(OWNER);
  });

  it('is part of the typed config', () => {
    const config = loadConfig({ DEV_AUTH_SECRET: 'test-secret-test-secret-test-secret', CLOUD_ROLLOUT: 'auto_drafts=off', COMPOSE_NOTICE_POLICY: 'helpful_context=off' });
    expect(config.rollout.stages.auto_drafts).toBe('off');
    expect(config.composePolicy.off.has('helpful_context')).toBe(true);
  });
});

describe('compose notice policy', () => {
  const notice = (kind: keyof typeof DEFAULT_NOTICE_POLICY, confidence: number) => ({ status: 'notice' as const, kind, severity: 'info' as const, message: 'x', confidence, sources: [] });

  it('keeps independent per-category thresholds and only tightens them', () => {
    const policy = parseNoticePolicy('helpful_context=0.5, calendar_conflict=0.97, writing_suggestion=off, bogus=1, fact_conflict=high');
    expect(policy.minConfidence.helpful_context).toBe(0.96);
    expect(policy.minConfidence.calendar_conflict).toBe(0.97);
    expect(policy.invalid).toEqual(['bogus', 'fact_conflict']);
    expect(applyNoticePolicy(notice('calendar_conflict', 0.98), policy).held).toBe(false);
    expect(applyNoticePolicy(notice('calendar_conflict', 0.95), policy)).toEqual({ response: { status: 'none' }, held: true });
    expect(applyNoticePolicy(notice('overlooked_context', 0.94), policy).held).toBe(false);
    expect(applyNoticePolicy(notice('helpful_context', 0.95), policy).held).toBe(true);
    // A held-back notice keeps its completion.
    const completion = { text: ' Thursday.', confidence: 0.97, sources: [] };
    expect(applyNoticePolicy({ ...notice('writing_suggestion', 0.99), completion }, policy).response).toEqual({ status: 'none', completion });
    expect(applyNoticePolicy({ status: 'none' }, policy)).toEqual({ response: { status: 'none' }, held: false });
  });

  it('buckets confidence and latency', () => {
    expect([0.5, 0.9, 0.96, 0.99].map(confidenceBucket)).toEqual(['c_below_90', 'c90_94', 'c95_97', 'c98_100']);
    expect([10, 700, 1500, 3000, 9000].map(latencyBucket)).toEqual(['l0_500', 'l500_1000', 'l1000_2000', 'l2000_4000', 'l4000_plus']);
  });
});

describe('rollout in the running server', () => {
  const harnesses: IntelHarness[] = [];
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.pg.close();
  });

  it('turns compose checks and categories off without a client change, and logs only categories and buckets', async () => {
    const h = await createIntelHarness();
    harnesses.push(h);
    const user = await connectedUser(h, 'ada@work.test', ['mail_read', 'calendar_read'], { memory: { realtimeComposeChecks: true }, autoDrafts: { enabled: false } });
    const p = zonedParts(h.now(), ZONE);
    const monday = addCalendarDays({ year: p.year, month: p.month, day: p.day }, (8 - p.weekday) % 7 || 7);
    await h.advance(zonedTimeToUtc({ ...monday, hour: 10, minute: 0 }, ZONE).getTime() - h.now().getTime());
    const sunday = (hour: number) => zonedTimeToUtc({ ...addCalendarDays(monday, 6), hour, minute: 0 }, ZONE);
    h.google.addEvent('ada@work.test', { summary: 'Dinner', start: sunday(20), end: sunday(21) });
    const claim = 'I should be free on Sunday all day';
    const check = () => h.route<ComposeCheckResponse>('composeCheck', user.token, { claim, subject: '', recipientEmails: [], mailbox: 'ada@work.test', hint: detectComposeContext(claim) ?? undefined });

    expect(await check()).toMatchObject({ status: 'notice', kind: 'calendar_conflict' });
    const shown = h.logs.filter((line) => line.message === 'compose check').at(-1)!;
    expect(shown.fields).toMatchObject({ outcome: 'notice_shown', noticeKind: 'calendar_conflict', confidenceBucket: expect.stringMatching(/^c/), latencyBucket: expect.stringMatching(/^l/) });
    expect(JSON.stringify(h.logs)).not.toContain('Sunday');

    h.config.composePolicy = parseNoticePolicy('calendar_conflict=off');
    expect(await check()).toEqual({ status: 'none' });
    expect(h.logs.filter((line) => line.message === 'compose check').at(-1)!.fields).toMatchObject({ outcome: 'notice_held', noticeKind: 'calendar_conflict', count: 0 });

    // Emergency disable: the installed extension already backs off on `disabled`.
    h.config.composePolicy = parseNoticePolicy('');
    h.config.rollout = parseRollout({ CLOUD_ROLLOUT: 'compose_checks=off' });
    expect(await check()).toEqual({ status: 'disabled' });
    h.config.rollout = parseRollout({ CLOUD_ROLLOUT: 'compose_checks=internal', CLOUD_INTERNAL_USER_IDS: user.userId });
    expect(await check()).toMatchObject({ status: 'notice' });
  });

  it('skips auto drafts and memory learning when rolled back, leaving analysis and follow-ups alone', async () => {
    const h = await createIntelHarness();
    harnesses.push(h);
    h.config.rollout = parseRollout({ CLOUD_ROLLOUT: 'auto_drafts=off,memory_learning=off' });
    await connectedUser(h, 'ada@work.test', ['mail_read', 'drafts']);
    await deliverAndSync(h, 'ada@work.test', { from: 'maya@client.test', to: ['ada@work.test'], subject: 'Quick question', body: 'Can you confirm Thursday at 2pm works?' });
    expect(await h.sql(`select count(*)::int as n from public.thread_states`)).toEqual([{ n: 1 }]);
    expect(await h.sql(`select count(*)::int as n from public.jobs where kind = 'draft.prepare'`)).toEqual([{ n: 0 }]);
    expect(h.logs.some((line) => line.message === 'job skipped' && line.fields?.jobKind === 'memory.extract' && line.fields?.code === 'rollout_off')).toBe(true);
    expect(h.logs.some((line) => line.message === 'auto draft decision' && line.fields?.code === 'rollout_off')).toBe(true);
  });
});
