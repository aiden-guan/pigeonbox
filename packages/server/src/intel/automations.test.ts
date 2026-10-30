import type { Approval, Automation, AutomationRunSchema, Briefing } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { parseRawMessage } from '../google/mime.js';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';
import { compileAutomation } from './automations.js';

type AutomationRun = z.infer<typeof AutomationRunSchema>;

const ADA = 'ada@work.test';
const LEE = 'lee@client.test';
const WITH_SEND = ['mail_read', 'drafts', 'organize', 'send'] as const;

describe('Automation compiler', () => {
  it('compiles the documented examples into explainable trigger → conditions → actions', () => {
    const recruiter = compileAutomation('When a recruiter emails me about an internship, label it Recruiting and prepare a reply', 'America/New_York');
    expect(recruiter.trigger.kind).toBe('email_received');
    expect(recruiter.actions.map((action) => action.kind)).toEqual(expect.arrayContaining(['label', 'draft_reply']));
    expect(recruiter.explanation[0]).toMatch(/^When: /);
    expect(recruiter.warnings.join(' ')).toMatch(/Shadow Mode/);

    const digest = compileAutomation('Every weekday at 8am, give me the five threads most likely to need my attention', 'America/New_York');
    expect(digest.trigger.kind).toBe('schedule');
    expect(digest.schedule).toEqual({ cron: '0 8 * * 1-5', timeZone: 'America/New_York' });
    expect(digest.actions).toEqual([{ kind: 'notify', params: expect.objectContaining({ digest: 5 }) }]);

    const followUp = compileAutomation('If a proposal I sent has gone unanswered for four business days, prepare a follow-up', 'UTC');
    expect(followUp.trigger).toEqual({ kind: 'no_reply_by', params: { businessDays: 4 } });
    expect(followUp.conditions).toMatchObject({ direction: 'outbound', noReplyForBusinessDays: 4 });
    expect(followUp.actions.map((action) => action.kind)).toEqual(['draft_follow_up']);

    const send = compileAutomation('When someone replies to my intro, send them a thank-you note', 'UTC');
    expect(send.actions.map((action) => action.kind)).toContain('send_email');
    expect(send.tiers.find((tier) => tier.kind === 'send_email')).toEqual({ kind: 'send_email', tier: 3, runsAutomatically: false });
    expect(send.warnings.join(' ')).toMatch(/never sends on its own/);
  });
});

describe('AI automation conditions', () => {
  it('resolves a person named in lower case to their address', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'allen.hu@partner.test', fromName: 'Allen Hu', to: [ADA], subject: 'Contract redlines', body: 'Can we sign by Monday?' });
    const { draft } = await h.route<{ draft: ReturnType<typeof compileAutomation> }>('automationCompile', user.token, { prompt: 'When an email from allen arrives, label it Partner' });
    expect(draft.conditions.from.include).toEqual(['allen.hu@partner.test']);
    expect(draft.actions).toEqual([{ kind: 'label', params: { label: 'Partner' } }]);
  });
});

async function save(h: IntelHarness, token: string, prompt: string, mode: 'shadow' | 'active' = 'active') {
  const compiled = await h.route<{ draft: ReturnType<typeof compileAutomation> }>('automationCompile', token, { prompt });
  const { draft } = compiled;
  const created = await h.route<{ automation: Automation }>('automationSave', token, { name: draft.name, prompt, trigger: draft.trigger, conditions: draft.conditions, context: draft.context, actions: draft.actions, autonomy: draft.autonomy, schedule: draft.schedule, mode });
  return created.automation;
}

async function activate(h: IntelHarness, token: string, automation: Automation) {
  return (await h.route<{ automation: Automation }>('automationSave', token, { id: automation.id, name: automation.name, prompt: automation.prompt, trigger: automation.trigger, conditions: automation.conditions, context: automation.context, actions: automation.actions, autonomy: automation.autonomy, schedule: automation.schedule, mode: 'active' })).automation;
}

describe('Automations', () => {
  it('start in Shadow Mode and only record what they would do', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const automation = await save(h, user.token, 'When a recruiter emails me, label it "Recruiting" and archive it');
    expect(automation.mode).toBe('shadow');
    await deliverAndSync(h, ADA, { from: 'sam@talent.test', to: [ADA], subject: 'Internship opportunity', body: 'Hi! I am a recruiter at Talent and would love to talk about an internship role.' });
    const runs = await h.route<{ runs: AutomationRun[] }>('automationRuns', user.token, { id: automation.id });
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]!.actions.map((action) => action.outcome)).toEqual(['shadowed', 'shadowed']);
    expect(h.google.calls.some((call) => call.path.includes('/modify'))).toBe(false);
  });

  it('once active, applies reversible actions with an audit trail, and runs once per event', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const automation = await activate(h, user.token, await save(h, user.token, 'When a recruiter emails me, label it "Recruiting" and archive it'));
    expect(automation.mode).toBe('active');
    const { threadId } = await deliverAndSync(h, ADA, { from: 'sam@talent.test', to: [ADA], subject: 'Internship opportunity', body: 'Hi! I am a recruiter at Talent and would love to talk about an internship role.' });
    // A second sync of the same thread must not run the automation again.
    await h.route('connectionResync', user.token, { accountId: user.accountId });
    await h.drain();
    const runs = await h.route<{ runs: AutomationRun[] }>('automationRuns', user.token, { id: automation.id });
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]!.actions.map((action) => action.outcome)).toEqual(['applied', 'applied']);
    const message = [...h.google.account(ADA).messages.values()].find((item) => item.threadId === threadId)!;
    expect(message.labelIds).not.toContain('INBOX');
    const audit = await h.route<{ events: Array<{ action: string; actor: { type: string; name: string } }> }>('auditList', user.token, {});
    expect(audit.events.filter((event) => event.actor.type === 'automation').map((event) => event.action).sort()).toEqual(['archive', 'label']);
  });

  it('turns a send into an approval card with the exact email, sends once on approval, and never on rejection', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA, [...WITH_SEND]);
    const intro = await deliverAndSync(h, ADA, { from: ADA, to: [LEE], subject: 'Intro', body: 'Lee, meet Maya. I think you two should talk about the pilot.' });
    const automation = await activate(h, user.token, await save(h, user.token, 'When Lee replies, send a thank-you note'));
    expect(automation.conditions.from.include).toEqual([LEE]);
    const sentBefore = h.google.account(ADA).sent.length;
    const first = await deliverAndSync(h, ADA, { from: LEE, to: [ADA], subject: 'Re: Intro', body: 'Thanks for the intro, happy to chat next week.', threadId: intro.threadId });

    const pending = await h.route<{ approvals: Approval[] }>('approvals', user.token, {});
    expect(pending.approvals).toHaveLength(1);
    const approval = pending.approvals[0]!;
    expect(approval).toMatchObject({ kind: 'send_email', tier: 3, status: 'pending', responsible: { type: 'automation', name: automation.name } });
    expect(approval.preview.to).toEqual([LEE]);
    expect(approval.preview.subject).toBe('Re: Intro');
    expect(approval.why).toMatch(/When Lee replies|matched/);
    expect(approval.preview.body!.length).toBeGreaterThan(10);
    expect(h.google.account(ADA).sent.length).toBe(sentBefore);

    // Approving with edits sends exactly the edited text, once, even if approved again or re-drained.
    const body = 'Thank you, Lee. Talk next week.';
    await h.route('approvalDecide', user.token, { id: approval.id, decision: 'approve', edits: { body }, idempotencyKey: 'approve-thanks-0001' });
    await h.route('approvalDecide', user.token, { id: approval.id, decision: 'approve', idempotencyKey: 'approve-thanks-0002' });
    await h.drain();
    await h.drain();
    const sent = h.google.account(ADA).sent.slice(sentBefore);
    expect(sent).toHaveLength(1);
    const message = parseRawMessage(sent[0]!);
    expect(message.body.trim()).toBe(body);
    expect(message.headers['in-reply-to']).toBeTruthy();
    // Sent in the same conversation: intro, Lee's reply, the thank-you.
    expect([...h.google.account(ADA).messages.values()].filter((item) => item.threadId === first.threadId)).toHaveLength(3);
    const decided = await h.route<{ approvals: Approval[] }>('approvals', user.token, { status: 'decided' });
    expect(decided.approvals[0]!.status).toBe('executed');

    // A rejected approval sends nothing.
    await deliverAndSync(h, ADA, { from: LEE, to: [ADA], subject: 'Re: Intro', body: 'One more thing: the deck looks great.', threadId: intro.threadId });
    const next = (await h.route<{ approvals: Approval[] }>('approvals', user.token, {})).approvals[0]!;
    await h.route('approvalDecide', user.token, { id: next.id, decision: 'reject', idempotencyKey: 'reject-thanks-0001' });
    await h.drain();
    expect(h.google.account(ADA).sent.slice(sentBefore)).toHaveLength(1);
  });

  it('does not queue an approval it could never carry out', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const intro = await deliverAndSync(h, ADA, { from: ADA, to: [LEE], subject: 'Intro', body: 'Lee, meet Maya.' });
    const automation = await activate(h, user.token, await save(h, user.token, 'When Lee replies, send a thank-you note'));
    await deliverAndSync(h, ADA, { from: LEE, to: [ADA], subject: 'Re: Intro', body: 'Thanks!', threadId: intro.threadId });
    expect((await h.route<{ approvals: Approval[] }>('approvals', user.token, {})).approvals).toHaveLength(0);
    const runs = await h.route<{ runs: AutomationRun[] }>('automationRuns', user.token, { id: automation.id });
    expect(runs.runs[0]!.actions[0]).toMatchObject({ outcome: 'skipped', detail: 'Sending is not turned on for this Google account' });
  });

  it('refuses to approve an email that still has placeholders', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA, [...WITH_SEND]);
    const pricing = await deliverAndSync(h, ADA, { from: ADA, to: [LEE], subject: 'Pricing', body: 'Here is the pricing overview you asked for.' });
    await activate(h, user.token, await save(h, user.token, 'When Lee replies, send a thank-you note'));
    await deliverAndSync(h, ADA, { from: LEE, to: [ADA], subject: 'Re: Pricing', body: 'Thanks. What would the total cost be?', threadId: pricing.threadId });
    const approval = (await h.route<{ approvals: Approval[] }>('approvals', user.token, {})).approvals[0]!;
    await expect(h.route('approvalDecide', user.token, { id: approval.id, decision: 'approve', edits: { body: 'The total is [CONFIRM PRICE].' }, idempotencyKey: 'approve-price-0001' })).rejects.toMatchObject({ code: 'conflict' });
    const still = (await h.route<{ approvals: Approval[] }>('approvals', user.token, {})).approvals[0]!;
    expect(still.status).toBe('pending');
    expect(still.preview.body).not.toContain('[CONFIRM PRICE].');
  });

  it('"Run now" without a thread acts on the recent threads that match, and says why when none do', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const { draft } = await h.route<{ draft: ReturnType<typeof compileAutomation> }>('automationCompile', user.token, { prompt: 'Star it' });
    const conditions = { ...draft.conditions, subjectAny: ['Invoice 4471'], aiCriteria: null };
    const { automation } = await h.route<{ automation: Automation }>('automationSave', user.token, { name: 'Star invoice', prompt: 'Star invoice 4471', trigger: { kind: 'manual', params: {} }, conditions, context: draft.context, actions: [{ kind: 'star', params: {} }], autonomy: 'suggest', schedule: null, mode: 'active' });
    await activate(h, user.token, automation);
    const { threadId } = await deliverAndSync(h, ADA, { from: LEE, to: [ADA], subject: 'Invoice 4471', body: 'Attached is the invoice for September.' });
    await deliverAndSync(h, ADA, { from: LEE, to: [ADA], subject: 'Lunch?', body: 'Free on Thursday?' });

    const { run } = await h.route<{ run: AutomationRun }>('automationRun', user.token, { id: automation.id, idempotencyKey: 'run-now-invoice-0001' });
    expect(run.threadId).toBe(threadId);
    expect(run.actions[0]).toMatchObject({ kind: 'star', outcome: 'approval_requested' });
    const pending = await h.route<{ approvals: Approval[] }>('approvals', user.token, {});
    expect(pending.approvals.map((approval) => approval.title)).toEqual(['Star: Invoice 4471']);

    await h.route('automationSave', user.token, { id: automation.id, name: automation.name, prompt: automation.prompt, trigger: automation.trigger, conditions: { ...conditions, subjectAny: ['Nothing like this'] }, context: automation.context, actions: automation.actions, autonomy: automation.autonomy, schedule: null, mode: 'active' });
    const none = await h.route<{ run: AutomationRun }>('automationRun', user.token, { id: automation.id, idempotencyKey: 'run-now-invoice-0002' });
    expect(none.run.actions[0]).toMatchObject({ outcome: 'skipped', detail: 'No recent thread matches' });
  });

  it('runs scheduled digests at the user’s local time', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const automation = await activate(h, user.token, await save(h, user.token, 'Every weekday at 8am, give me the three threads most likely to need my attention'));
    await deliverAndSync(h, ADA, { from: LEE, to: [ADA], subject: 'Contract', body: 'Can you sign the contract by Friday? It is urgent.' });
    const [row] = await h.sql<{ next_run_at: Date }>('select next_run_at from public.automation_rules where id = $1::uuid', [automation.id]);
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(row!.next_run_at);
    expect(local.find((part) => part.type === 'hour')!.value).toBe('08');
    expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(local.find((part) => part.type === 'weekday')!.value);
    await h.advance(row!.next_run_at.getTime() - h.now().getTime() + 60_000);
    await h.sql(`select app.enqueue_scheduled($1::timestamptz)`, [h.now()]);
    await h.drain();
    const notifications = await h.route<{ notifications: Array<{ kind: string; title: string; body: string }> }>('notifications', user.token, {});
    const digest = notifications.notifications.find((item) => item.kind === 'briefing')!;
    expect(digest.title).toMatch(/1 thread/);
    expect(digest.body).toContain('Contract');
  });
});

describe('Briefings', () => {
  it('builds a morning briefing whose every item cites a real source', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: LEE, fromName: 'Lee Park', to: [ADA], subject: 'Contract', body: 'Can you sign the contract by tomorrow? It is urgent.' });
    await deliverAndSync(h, ADA, { from: ADA, to: ['maya@client.test'], subject: 'Proposal', body: 'Could you review the proposal and let me know?' });
    const { briefing } = await h.route<{ briefing: Briefing }>('briefingGenerate', user.token, { kind: 'morning' });
    const ids = new Set(briefing.sources.map((source) => source.id));
    expect(briefing.sections.map((section) => section.id)).toEqual(expect.arrayContaining(['urgent', 'replies', 'waiting', 'deadlines', 'meetings', 'drafts']));
    const items = briefing.sections.flatMap((section) => section.items);
    expect(items.length).toBeGreaterThan(1);
    for (const item of items) for (const id of item.sourceIds) expect(ids.has(id)).toBe(true);
    expect(items.map((item) => item.text).join(' ')).toMatch(/Contract/);
    expect(briefing.coverageNote.length).toBeGreaterThan(0);
    const again = await h.route<{ briefing: Briefing }>('briefingGet', user.token, { id: briefing.id });
    expect(again.briefing.sections).toEqual(briefing.sections);
  });

  it('prepares a meeting brief from the attendees’ history', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: LEE, fromName: 'Lee Park', to: [ADA], subject: 'Q4 plan', body: 'Can you send the Q4 plan before our call?' });
    const start = new Date(h.now().getTime() + 3 * 3_600_000);
    const event = h.google.addEvent(ADA, { summary: 'Call with Lee', start, end: new Date(start.getTime() + 1_800_000), attendees: [ADA, LEE] });
    const { briefing: brief } = await h.route<{ briefing: Briefing }>('meetingBrief', user.token, { eventId: event.id });
    expect(brief.kind).toBe('meeting');
    const attendees = brief.sections.find((section) => section.id === 'attendees')!;
    expect(attendees.items.map((item) => item.text).join(' ')).toMatch(/Lee/);
    const discussed = brief.sections.find((section) => section.id === 'discussed')!;
    expect(discussed.items[0]!.text).toMatch(/Q4 plan/);
  });
});
