import type { AskPigeonResponse, AskTurn } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../ai/backends.js';
import { connectedUser, createIntelHarness, type IntelHarness } from '../testing/intel-harness.js';
import { approvalSteps } from './ask-approval.js';

const ADA = 'ada@work.test';
const KV = { id: 'Label_kv', name: 'KV Outreach', type: 'user' };
const MUTATING = /\/(modify|trash|untrash)$|^\/labels/;

/** Ada's outreach under "KV Outreach": three cold emails, one of which got a reply. */
async function outreach(h: IntelHarness) {
  const user = await connectedUser(h, ADA);
  const account = h.google.account(ADA);
  account.labels.push({ ...KV });
  const sent = (subject: string, to: string) => h.google.deliver(ADA, { from: ADA, to: [to], subject, body: `Hi, a quick idea about ${subject}.`, labels: ['SENT', KV.id] });
  const replied = sent('A concept for Humbowl', 'jo@humbowl.test');
  const quiet = [sent('Partnering with Lumen', 'kai@lumen.test'), sent('Idea for Oakline', 'rae@oakline.test')];
  h.google.deliver(ADA, { from: 'jo@humbowl.test', to: [ADA], subject: 'Re: A concept for Humbowl', body: 'Sounds interesting, tell me more.', threadId: replied.threadId });
  return { user, account, replied, quiet };
}

const reply = (request: ChatRequest, patch: Partial<ChatResult>): ChatResult => ({ text: '', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 }, ...patch });
const toolResults = (request: ChatRequest) => request.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content) as Record<string, unknown>);

const QUESTION = 'organize all the cold emails that got a reply into a new label, and delete all the emails in "KV Outreach" and also the label itself';

/** The model: find replied threads, then propose every change in one call, then summarise. */
function proposeScript(h: IntelHarness, seen: { tools?: string[]; listed?: Record<string, unknown> }) {
  let round = 0;
  h.deps.inference.chat = async (request) => {
    seen.tools ??= request.tools?.map((tool) => tool.name);
    round += 1;
    if (round === 1) return reply(request, { toolCalls: [{ id: 'list', name: 'list_threads', arguments: JSON.stringify({ query: 'label:"KV Outreach"', replied: 'yes' }) }] });
    if (round === 2) {
      seen.listed = toolResults(request)[0];
      const source = (seen.listed!.threads as Array<{ source: string }>)[0]!.source;
      return reply(request, {
        toolCalls: [{
          id: 'change',
          name: 'change_mail',
          arguments: JSON.stringify({
            title: 'File replied cold emails and clear KV Outreach',
            steps: [
              { action: 'add_label', label: 'Cold replies', threads: [source] },
              { action: 'trash', query: 'label:"KV Outreach"', exclude_threads: [source] },
              { action: 'delete_label', label: 'KV Outreach' },
            ],
          }),
        }],
      });
    }
    expect(request.toolChoice).toBe('none');
    return reply(request, { text: 'One cold email got a reply. Allow the changes below to file it under "Cold replies", trash the other two and delete the label.\nNext: show me the reply' });
  };
}

describe('Chat asks permission before changing the mailbox', () => {
  it('shows every sender in a bulk unsubscribe proposal', () => {
    const senders = Array.from({ length: 30 }, (_, i) => ({ accountId: 'account', email: `list${i}@news.test` }));
    const steps = approvalSteps({ kind: 'unsubscribe', title: 'Leave these lists', senders, archive: true });
    expect(steps.flatMap((step) => step.examples)).toEqual(senders.map((sender) => sender.email));
    expect(steps.length).toBeLessThanOrEqual(12);
  });

  it('refuses a plan whose implicit label creations exceed the visible step limit', async () => {
    const h = await createIntelHarness();
    const { user } = await outreach(h);
    let round = 0;
    let problems: unknown;
    h.deps.inference.chat = async (request) => {
      if (!round++) return reply(request, { toolCalls: [{ id: 'changes', name: 'change_mail', arguments: JSON.stringify({ title: 'File outreach', steps: Array.from({ length: 7 }, (_, i) => ({ action: 'add_label', label: `New ${i}`, query: 'label:"KV Outreach"' })) }) }] });
      problems = toolResults(request)[0];
      return reply(request, { text: 'These changes need to be split into smaller proposals.' });
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'File outreach in seven labels', features: ['approval'] });
    expect(answer.approval).toBeUndefined();
    expect(JSON.stringify(problems)).toContain('at most 12 steps');
  });

  it('proposes every step with real targets and changes nothing until allowed', async () => {
    const h = await createIntelHarness();
    const { user, account, replied, quiet } = await outreach(h);
    const seen: { tools?: string[]; listed?: Record<string, unknown> } = {};
    proposeScript(h, seen);
    const before = h.google.calls.length;
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: QUESTION, features: ['compose', 'approval'] });

    expect(seen.tools).toEqual(expect.arrayContaining(['change_mail', 'list_threads', 'list_labels']));
    expect(seen.listed).toMatchObject({ matching: 1, threads: [{ subject: 'A concept for Humbowl', repliesFromOthers: 1 }] });
    expect(answer.approval?.title).toBe('File replied cold emails and clear KV Outreach');
    expect(answer.approval?.steps.map((step) => step.text)).toEqual([
      'Create the label “Cold replies”',
      'Add the label “Cold replies” to 1 thread',
      'Move 2 threads to Trash. Gmail deletes them for good after 30 days.',
      'Delete the label “KV Outreach”. Its emails stay in your mailbox.',
    ]);
    expect(answer.approval?.steps.map((step) => step.destructive)).toEqual([false, false, true, true]);
    expect(answer.approval?.steps[1]!.examples).toEqual(['A concept for Humbowl']);
    expect(answer.followUps).toEqual([]);
    // Nothing changed: no label, trash or modify calls, and the mailbox is as it was.
    expect(h.google.calls.slice(before).filter((call) => call.method !== 'GET' && MUTATING.test(call.path))).toEqual([]);
    expect(account.labels.map((label) => label.name)).not.toContain('Cold replies');
    expect([...account.messages.values()].some((message) => message.labelIds.includes('TRASH'))).toBe(false);

    // Allow: exactly the sealed plan runs, then Pigeon reports.
    h.deps.inference.chat = async (request) => {
      expect(request.messages.at(-1)!.content).toContain('The user allowed');
      return reply(request, { text: 'Done: filed 1 thread under "Cold replies", trashed 2 and deleted "KV Outreach".' });
    };
    const history: AskTurn[] = [{ role: 'user', content: QUESTION }, { role: 'assistant', content: answer.answer, ...(answer.context ? { context: answer.context } : {}) }];
    const done = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Allow', history, features: ['compose', 'approval'], decision: { token: answer.approval!.token, allow: true } });
    expect(done.answer).toContain('Done');
    expect(done.approval).toBeUndefined();
    const cold = account.labels.find((label) => label.name === 'Cold replies')!;
    expect(cold).toBeTruthy();
    const messages = [...account.messages.values()];
    expect(messages.filter((message) => message.threadId === replied.threadId).every((message) => message.labelIds.includes(cold.id) && !message.labelIds.includes('TRASH'))).toBe(true);
    for (const thread of quiet) expect(messages.filter((message) => message.threadId === thread.threadId).every((message) => message.labelIds.includes('TRASH'))).toBe(true);
    expect(account.labels.some((label) => label.name === 'KV Outreach')).toBe(false);
    expect(done.context).toContain('carried out');
  });

  it('changes nothing on Deny, or for a token that was altered or belongs to someone else', async () => {
    const h = await createIntelHarness();
    const { user, account } = await outreach(h);
    proposeScript(h, {});
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: QUESTION, features: ['compose', 'approval'] });
    const token = answer.approval!.token;
    const snapshot = () => JSON.stringify({ labels: account.labels, messages: [...account.messages.values()].map((message) => message.labelIds) });
    const before = snapshot();
    let modelCalls = 0;
    h.deps.inference.chat = async (request) => {
      modelCalls += 1;
      return reply(request, { text: 'unexpected' });
    };

    const denied = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Deny', features: ['approval'], decision: { token, allow: false } });
    expect(denied.answer).toBe('Okay, I didn\'t change anything.');
    const tampered = `${token.slice(0, -6)}AAAAAA`;
    const forged = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Allow', features: ['approval'], decision: { token: tampered, allow: true } });
    expect(forged.answer).toContain('couldn\'t verify');
    const other = await connectedUser(h, 'bo@else.test');
    const stolen = await h.route<AskPigeonResponse>('askPigeon', other.token, { query: 'Allow', features: ['approval'], decision: { token, allow: true } });
    expect(stolen.answer).toContain('couldn\'t verify');
    expect(modelCalls).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it('expires after half an hour', async () => {
    const h = await createIntelHarness();
    const { user, account } = await outreach(h);
    proposeScript(h, {});
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: QUESTION, features: ['approval'] });
    await h.advance(31 * 60_000);
    const late = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Allow', features: ['approval'], decision: { token: answer.approval!.token, allow: true } });
    expect(late.answer).toContain('expired');
    expect(account.labels.some((label) => label.name === 'KV Outreach')).toBe(true);
  });

  it('consumes Allow exactly once even across simultaneous requests', async () => {
    const h = await createIntelHarness();
    const { user } = await outreach(h);
    proposeScript(h, {});
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: QUESTION, features: ['approval'] });
    h.deps.inference.chat = async (request) => reply(request, { text: 'Done.' });
    const decide = () => h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Allow', features: ['approval'], decision: { token: answer.approval!.token, allow: true } });
    const results = await Promise.all([decide(), decide()]);
    expect(results.filter((item) => item.answer.includes('Done'))).toHaveLength(1);
    expect(results.filter((item) => item.answer.includes('couldn\'t verify'))).toHaveLength(1);
    expect(await h.sql("select key from public.idempotency_keys where scope = 'ask_approval'")).toHaveLength(1);
    expect((await decide()).answer).toContain('couldn\'t verify');
  });

  it('cannot replay a declined token as Allow', async () => {
    const h = await createIntelHarness();
    const { user, account } = await outreach(h);
    proposeScript(h, {});
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: QUESTION, features: ['approval'] });
    await h.route('askPigeon', user.token, { query: 'Deny', decision: { token: answer.approval!.token, allow: false } });
    const replay = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Allow', decision: { token: answer.approval!.token, allow: true } });
    expect(replay.answer).toContain('couldn\'t verify');
    expect(account.labels.some((label) => label.name === KV.name)).toBe(true);
    expect([...account.messages.values()].some((message) => message.labelIds.includes('TRASH'))).toBe(false);
  });

  it('rejects old cards whose preview may have hidden changes', async () => {
    const h = await createIntelHarness();
    const { user } = await outreach(h);
    const id = crypto.randomUUID();
    const sealed = await h.deps.intel!.box.seal(JSON.stringify({ v: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), plan: { kind: 'unsubscribe', title: 'Old proposal', archive: true, senders: [{ accountId: user.accountId, email: 'news@shop.test' }] } }), { purpose: 'ask_approval', userId: user.userId, recordId: id });
    const token = Buffer.from(JSON.stringify({ id, ...sealed })).toString('base64url');
    const result = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Allow', decision: { token, allow: true } });
    expect(result.answer).toContain('couldn\'t verify');
    expect(await h.sql('select * from public.mail_unsubscribes')).toEqual([]);
  });

  it('does not offer mailbox changes to apps that cannot ask the user', async () => {
    const h = await createIntelHarness();
    const { user } = await outreach(h);
    let tools: string[] = [];
    h.deps.inference.chat = async (request) => {
      tools = request.tools?.map((tool) => tool.name) ?? [];
      return reply(request, { text: 'I can\'t change your mailbox from this app.' });
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: QUESTION, features: ['compose'] });
    expect(tools).not.toContain('change_mail');
    expect(tools).toContain('list_threads');
    expect(answer.approval).toBeUndefined();
  });

  it('returns planning problems to the model instead of proposing', async () => {
    const h = await createIntelHarness();
    const { user } = await outreach(h);
    let round = 0;
    let problems: unknown;
    h.deps.inference.chat = async (request) => {
      round += 1;
      if (round === 1) return reply(request, { toolCalls: [{ id: 'c', name: 'change_mail', arguments: JSON.stringify({ title: 'Clean up', steps: [{ action: 'delete_label', label: 'Old stuff' }, { action: 'trash', query: 'label:"Nothing here"' }] }) }] });
      problems = toolResults(request)[0];
      return reply(request, { text: 'There is no label called "Old stuff". Which label did you mean?' });
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'delete the Old stuff label and trash what was in it', features: ['approval'] });
    expect(answer.approval).toBeUndefined();
    expect(problems).toMatchObject({ actionTaken: false, problems: [expect.stringContaining('no label "Old stuff"'), expect.stringContaining('no threads matched')] });
  });

  it('says how to allow organizing when the inbox was connected without it', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA, ['mail_read', 'drafts']);
    let problems: unknown;
    let round = 0;
    h.deps.inference.chat = async (request) => {
      round += 1;
      if (round === 1) return reply(request, { toolCalls: [{ id: 'c', name: 'change_mail', arguments: JSON.stringify({ title: 'Archive', steps: [{ action: 'archive', query: 'in:inbox' }] }) }] });
      problems = toolResults(request)[0];
      return reply(request, { text: 'PigeonBox needs permission to organize this inbox first.' });
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'archive everything', features: ['approval'] });
    expect(answer.approval).toBeUndefined();
    expect(JSON.stringify(problems)).toContain('Organize mail');
  });
});
