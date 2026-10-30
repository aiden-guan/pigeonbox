import type { ShadowDecisionSchema, SmartView } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { connectedUser, createIntelHarness, deliverAndSync } from '../testing/intel-harness.js';
import { compileView } from './rule-compiler.js';

const ADA = 'ada@work.test';
type Decision = z.infer<typeof ShadowDecisionSchema>;

describe('Smart View compiler', () => {
  it('turns natural language into explainable, mostly deterministic filters', () => {
    const recruiting = compileView('Important recruiting emails that need my response');
    expect(recruiting.filter.states).toEqual(expect.arrayContaining(['NEEDS_REPLY']));
    expect(recruiting.filter.keywordsAny).toContain('recruiter');
    expect(recruiting.usesAi).toBe(true);
    expect(recruiting.explanation.join(' ')).toMatch(/AI judgment/);

    const receipts = compileView('Receipts and confirmations');
    expect(receipts.usesAi).toBe(false);
    expect(receipts.filter.keywordsAny).toEqual(expect.arrayContaining(['receipt', 'confirmation']));

    const professors = compileView('Messages from professors');
    expect(professors.filter.from.include).toContain('.edu');

    const cold = compileView('People I emailed who have not responded in four business days');
    expect(cold.filter).toMatchObject({ direction: 'outbound', noReplyForBusinessDays: 4 });
    expect(cold.usesAi).toBe(false);

    const newsletters = compileView('Newsletters I actually read');
    expect(newsletters.filter.states).toContain('NEWS');
    expect(newsletters.filter.readByUser).toBe(true);

    const deadlines = compileView('Anything with a deadline this week');
    expect(deadlines.filter.deadlineWithinDays).toBe(7);
  });

  it('resolves names to known contacts and extracts actions', () => {
    const view = compileView('Emails from Maya, label them "Client" and archive', [{ email: 'maya@client.test', name: 'Maya Chen' }]);
    expect(view.filter.from.include).toEqual(['maya@client.test']);
    expect(view.actions.map((action) => action.kind)).toEqual(['archive', 'label']);
    expect(view.warnings.join(' ')).toMatch(/Shadow Mode/);
  });
});

describe('Shadow Mode', () => {
  async function setup() {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const compiled = await h.route<{ draft: { filter: unknown; actions: unknown[] } }>('viewCompile', user.token, { prompt: 'Receipts and confirmations, archive them' });
    const saved = await h.route<{ view: SmartView }>('viewSave', user.token, { name: 'Receipts', prompt: 'Receipts and confirmations', filter: compiled.draft.filter, actions: compiled.draft.actions, mode: 'active' });
    return { h, user, view: saved.view };
  }

  async function receipts(h: Awaited<ReturnType<typeof setup>>['h'], count: number) {
    const threads: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const { threadId } = await deliverAndSync(h, ADA, { from: `orders${i}@shop${i}.test`, to: [ADA], subject: `Your order receipt #${1000 + i}`, body: 'Thanks for your purchase. Here is your receipt.' });
      threads.push(threadId);
    }
    return threads;
  }

  it('starts rules that change the mailbox in Shadow Mode, whatever was requested', async () => {
    const { view } = await setup();
    expect(view.mode).toBe('shadow');
    expect(view.activation).toMatchObject({ eligible: false, required: 5 });
  });

  it('records what it would do and never touches Gmail', async () => {
    const { h, user, view } = await setup();
    await receipts(h, 2);
    const shadow = await h.route<{ decisions: Decision[] }>('viewShadow', user.token, { id: view.id });
    expect(shadow.decisions).toHaveLength(2);
    expect(shadow.decisions[0]!.actions.map((action) => action.kind)).toEqual(['archive']);
    expect(shadow.decisions[0]!.why.join(' ')).toMatch(/receipt/i);
    expect(h.google.calls.some((call) => call.path.includes('/modify'))).toBe(false);
    for (const message of h.google.account(ADA).messages.values()) if (message.headers.Subject?.startsWith('Your order')) expect(message.labelIds).toContain('INBOX');
  });

  it('activates only after enough confirmed examples, then makes only the specified change, audited and undoable', async () => {
    const { h, user, view } = await setup();
    await receipts(h, 5);
    const shadow = await h.route<{ decisions: Decision[] }>('viewShadow', user.token, { id: view.id });
    await expect(h.route('viewActivate', user.token, { id: view.id })).rejects.toMatchObject({ code: 'conflict' });
    for (const decision of shadow.decisions) await h.route('viewReview', user.token, { decisionId: decision.id, verdict: 'correct' });
    const active = await h.route<{ view: SmartView }>('viewActivate', user.token, { id: view.id });
    expect(active.view.mode).toBe('active');

    const [threadId] = await receipts(h, 1);
    const message = [...h.google.account(ADA).messages.values()].find((item) => item.threadId === threadId)!;
    expect(message.labelIds).not.toContain('INBOX');
    // Nothing else changed: no labels added, no other threads touched.
    expect(message.labelIds).toEqual(['UNREAD']);
    const modifies = h.google.calls.filter((call) => call.path.includes('/modify'));
    expect(modifies).toHaveLength(1);

    const audit = await h.route<{ events: Array<{ id: string; action: string; reversible: boolean; actor: { type: string } }> }>('auditList', user.token, {});
    const archived = audit.events.find((event) => event.action === 'archive')!;
    expect(archived).toMatchObject({ reversible: true, actor: { type: 'rule' } });
    await h.route('actionUndo', user.token, { auditId: archived.id, idempotencyKey: 'undo-archive-0001' });
    expect(message.labelIds).toContain('INBOX');
    const after = await h.route<{ events: Array<{ id: string; action: string; undoneAt: string | null }> }>('auditList', user.token, {});
    expect(after.events.find((event) => event.id === archived.id)!.undoneAt).toBeTruthy();
    // Undoing twice with the same key is a no-op; undoing an undone action is refused.
    await h.route('actionUndo', user.token, { auditId: archived.id, idempotencyKey: 'undo-archive-0001' });
    await expect(h.route('actionUndo', user.token, { auditId: archived.id, idempotencyKey: 'undo-archive-0002' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps every rule change as an auditable version; corrections exclude the sender', async () => {
    const { h, user, view } = await setup();
    await receipts(h, 1);
    const shadow = await h.route<{ decisions: Decision[] }>('viewShadow', user.token, { id: view.id });
    await h.route('viewReview', user.token, { decisionId: shadow.decisions[0]!.id, verdict: 'incorrect' });
    const fresh = (await h.route<{ views: SmartView[] }>('views', user.token)).views[0]!;
    await h.route('viewSave', user.token, { id: view.id, name: 'Receipts (renamed)', prompt: fresh.prompt, filter: fresh.filter, actions: fresh.actions, mode: 'shadow' });
    const history = await h.route<{ versions: Array<{ version: number; changedBy: string; name: string }> }>('viewHistory', user.token, { id: view.id });
    expect(history.versions.map((version) => version.version)).toEqual([3, 2, 1]);
    expect(history.versions.find((version) => version.version === 2)!.changedBy).toBe('Your correction');
    const views = await h.route<{ views: SmartView[] }>('views', user.token);
    expect(views.views[0]!.filter.from.exclude).toEqual(['orders0@shop0.test']);
  });

  it('lists matching threads with the reasons they match', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'lee@client.test', to: [ADA], subject: 'Contract renewal deadline', body: 'Can you sign the contract by Friday?' });
    await deliverAndSync(h, ADA, { from: 'news@digest.test', to: [ADA], subject: 'Weekly digest', body: 'Read online.' });
    const saved = await h.route<{ view: SmartView }>('viewSave', user.token, { name: 'Deadlines', prompt: 'Anything with a deadline this week', filter: compileView('Anything with a deadline this week').filter, actions: [] });
    expect(saved.view.mode).toBe('view');
    const results = await h.route<{ items: Array<{ subject: string; why: string[] }> }>('viewResults', user.token, { id: saved.view.id });
    expect(results.items.map((item) => item.subject)).toEqual(['Contract renewal deadline']);
    expect(results.items[0]!.why.join(' ')).toMatch(/Deadline/);
  });
});

describe('AI view compiler and judgment', () => {
  it('reads a request in plain words and resolves a lower-case name to the contact', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'allen.hu@partner.test', fromName: 'Allen Hu', to: [ADA], subject: 'Contract redlines', body: 'Can we sign by Monday?' });
    const { draft } = await h.route<{ draft: { filter: SmartView['filter']; explanation: string[]; usesAi: boolean } }>('viewCompile', user.token, { prompt: 'emails from allen with attachments' });
    expect(draft.filter.from.include).toEqual(['allen.hu@partner.test']);
    expect(draft.filter.hasAttachment).toBe(true);
    expect(draft.usesAi).toBe(false);
    expect(draft.explanation.join(' ')).toMatch(/From allen \(allen\.hu@partner\.test\)/);
  });

  it('falls back to the deterministic compiler when the AI provider fails', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const { draft } = await h.route<{ draft: { filter: SmartView['filter'] } }>('viewCompile', user.token, { prompt: 'Receipts and confirmations [[mock:500]]' });
    expect(draft.filter.keywordsAny).toContain('receipt');
  });

  it('judges threads in batches, once per thread version', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    for (let i = 0; i < 25; i += 1) await h.google.deliver(ADA, { from: `vendor${i}@supply${i}.test`, to: [ADA], subject: i % 2 ? `Invoice ${i} attached` : `Lunch plans ${i}`, body: i % 2 ? 'Your invoice is attached.' : 'Tacos?' });
    await h.push(ADA);
    await h.drain();
    const filter = { ...compileView('Anything').filter, keywordsAny: [], aiCriteria: 'any invoice' };
    const saved = await h.route<{ view: SmartView }>('viewSave', user.token, { name: 'Invoices', prompt: 'Invoices from vendors', filter, actions: [] });
    let calls = 0;
    const chat = h.deps.inference.chat.bind(h.deps.inference);
    h.deps.inference.chat = async (request, context) => {
      calls += 1;
      return chat(request, context);
    };
    const first = await h.route<{ items: Array<{ subject: string; why: string[] }> }>('viewResults', user.token, { id: saved.view.id, limit: 100 });
    expect(calls).toBe(2);
    expect(first.items).toHaveLength(12);
    expect(first.items.every((item) => /^Invoice/.test(item.subject) && /AI:/.test(item.why.join(' ')))).toBe(true);
    const again = await h.route<{ items: unknown[] }>('viewResults', user.token, { id: saved.view.id, limit: 100 });
    expect(calls).toBe(2);
    expect(again.items).toHaveLength(12);
  });
});
