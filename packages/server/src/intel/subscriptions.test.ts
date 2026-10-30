import { allowScriptedAskAction } from '../testing/scripted-ask.js';
import type { AskPigeonResponse } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';
import { mailtoFollowUp, parseListUnsubscribe, supportsOneClick } from './subscriptions.js';

const ADA = 'ada@work.test';
const NEWS = 'news@shop.test';
const DIGEST = 'digest@daily.test';
const MAYA = 'maya@client.test';

type Subs = { subscriptions: Array<{ accountId: string; email: string; name: string | null; messages: number; inInbox: number; unsubscribed: { method: string; status: string; silenced: boolean; since: number } | null }>; canArchive: boolean };
type Results = { results: Array<{ email: string; method: string | null; status: string; archived: number; silenced: boolean; followUp?: { kind: string; url?: string; to?: string; gmailUrl?: string }; message: string }> };

/** Record one-click POSTs; answer them like a list server would. */
function listServer(h: IntelHarness, status = 200) {
  const posts: Array<{ url: string; body: string; type: string | null }> = [];
  h.google.external = async (request) => {
    posts.push({ url: request.url, body: await request.text(), type: request.headers.get('Content-Type') });
    return new Response('ok', { status });
  };
  return posts;
}

async function newsletter(h: IntelHarness, from: string, headers: Record<string, string>, count = 1) {
  for (let index = 0; index < count; index += 1) await deliverAndSync(h, ADA, { from, fromName: 'Shop News', to: [ADA], subject: `Sale ${index}`, body: 'Big sale', headers });
}

const ONE_CLICK = { 'List-Unsubscribe': '<mailto:leave@shop.test?subject=unsubscribe>, <https://lists.shop.test/u/abc123>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };

describe('List-Unsubscribe parsing', () => {
  it('reads https and mailto targets and the one-click marker', () => {
    expect(parseListUnsubscribe('<mailto:a@b.test?subject=x>, < https://x.test/u?id=1 >,<http://insecure.test/u>')).toEqual({ https: ['https://x.test/u?id=1'], mailto: ['mailto:a@b.test?subject=x'] });
    expect(parseListUnsubscribe(null)).toEqual({ https: [], mailto: [] });
    expect(supportsOneClick('List-Unsubscribe=One-Click')).toBe(true);
    expect(supportsOneClick('')).toBe(false);
  });

  it('turns a mailto into a ready Gmail email and refuses junk', () => {
    const email = mailtoFollowUp('mailto:Leave@Shop.test?subject=Remove%20me', ADA)!;
    expect(email).toMatchObject({ kind: 'email', to: 'leave@shop.test', subject: 'Remove me' });
    expect(new URL(email.gmailUrl).searchParams.get('authuser')).toBe(ADA);
    expect(mailtoFollowUp('mailto:not-an-address', ADA)).toBeNull();
  });
});

describe('Unsubscribe', () => {
  it('lists mailing lists from synced metadata, unsubscribes with one click, archives and keeps new mail out', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await newsletter(h, NEWS, ONE_CLICK, 3);
    await deliverAndSync(h, ADA, { from: MAYA, to: [ADA], subject: 'Lunch?', body: 'Free Friday?' });
    const posts = listServer(h);

    const listed = await h.route<Subs>('controlSubscriptions', user.token, {});
    expect(listed.canArchive).toBe(true);
    expect(listed.subscriptions).toEqual([expect.objectContaining({ email: NEWS, name: 'Shop News', messages: 3, inInbox: 3, unsubscribed: null })]);

    const done = await h.route<Results>('controlUnsubscribe', user.token, { senders: [{ accountId: user.accountId, email: NEWS }] });
    expect(done.results[0]).toMatchObject({ email: NEWS, method: 'one_click', status: 'done', archived: 3, silenced: true });
    expect(posts).toEqual([{ url: 'https://lists.shop.test/u/abc123', body: 'List-Unsubscribe=One-Click', type: 'application/x-www-form-urlencoded' }]);
    const inbox = [...h.google.accounts.get(`sub-${ADA}`)!.messages.values()].filter((message) => message.labelIds.includes('INBOX'));
    expect(inbox.map((message) => message.headers.Subject)).toEqual(['Lunch?']);

    // The list keeps sending anyway: it skips the inbox, and the dashboard shows it ignored the request.
    const late = await deliverAndSync(h, ADA, { from: NEWS, to: [ADA], subject: 'One more sale', body: 'x', headers: ONE_CLICK, at: new Date(Date.now() + 3 * 86_400_000) });
    expect(h.google.accounts.get(`sub-${ADA}`)!.messages.get(late.id)!.labelIds).not.toContain('INBOX');
    const after = await h.route<Subs>('controlSubscriptions', user.token, {});
    expect(after.subscriptions[0]!.unsubscribed).toMatchObject({ method: 'one_click', status: 'done', silenced: true, since: 1 });

    // Turning silence off lets new mail through again.
    await h.route('controlSubscriptionUpdate', user.token, { accountId: user.accountId, email: NEWS, silence: false });
    const through = await deliverAndSync(h, ADA, { from: NEWS, to: [ADA], subject: 'Again', body: 'x', headers: ONE_CLICK });
    expect(h.google.accounts.get(`sub-${ADA}`)!.messages.get(through.id)!.labelIds).toContain('INBOX');

    const audit = await h.sql<{ action: string; summary: string }>(`select action, summary from public.audit_events where action = 'unsubscribe'`);
    expect(audit).toEqual([expect.objectContaining({ summary: expect.stringMatching(/Unsubscribed from Shop News <news@shop\.test>, archived 3/) })]);
  });

  it('hands back the link or email when a list has no one-click, and archives without the organize permission only when allowed', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA, ['mail_read', 'drafts']);
    await newsletter(h, NEWS, { 'List-Unsubscribe': '<https://shop.test/preferences?u=1>' });
    await newsletter(h, DIGEST, { 'List-Unsubscribe': '<mailto:leave@daily.test?subject=stop>' });
    await deliverAndSync(h, ADA, { from: 'promo@noheader.test', to: [ADA], subject: 'Promo', body: 'x', headers: { Precedence: 'bulk' } });
    const posts = listServer(h);
    const done = await h.route<Results>('controlUnsubscribe', user.token, {
      senders: [
        { accountId: user.accountId, email: NEWS },
        { accountId: user.accountId, email: DIGEST },
        { accountId: user.accountId, email: 'promo@noheader.test' },
      ],
    });
    expect(posts).toEqual([]);
    expect(done.results[0]).toMatchObject({ method: 'link', status: 'needs_user', silenced: false, followUp: { kind: 'open', url: 'https://shop.test/preferences?u=1' } });
    expect(done.results[1]).toMatchObject({ method: 'mailto', status: 'needs_user', followUp: { kind: 'email', to: 'leave@daily.test' } });
    expect(done.results[2]).toMatchObject({ method: null, status: 'failed', message: expect.stringMatching(/organize/) });
  });

  it('falls back to keeping a sender out of the inbox when the one-click endpoint fails or there is no header', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await newsletter(h, NEWS, { 'List-Unsubscribe': '<https://lists.shop.test/u/abc123>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    listServer(h, 500);
    const done = await h.route<Results>('controlUnsubscribe', user.token, { senders: [{ accountId: user.accountId, email: NEWS }] });
    // One-click failed and there is no other way, but PigeonBox can still keep them out.
    expect(done.results[0]).toMatchObject({ method: 'link', status: 'needs_user', archived: 1, silenced: true });
  });

  it('requires approval before Ask unsubscribes from several senders', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await newsletter(h, NEWS, ONE_CLICK, 2);
    await deliverAndSync(h, ADA, { from: DIGEST, fromName: 'Daily Digest', to: [ADA], subject: 'Today', body: 'x', headers: { 'List-Unsubscribe': '<mailto:leave@daily.test?subject=stop>' } });
    const posts = listServer(h);
    let system = '';
    const results: string[] = [];
    const rounds = [[{ id: 'a', name: 'unsubscribe', arguments: JSON.stringify({ senders: ['shop news', 'Daily Digest'] }) }]];
    let round = 0;
    h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      system = request.messages.find((message) => message.role === 'system')?.content ?? system;
      results.push(...request.messages.filter((message) => message.role === 'tool').map((message) => message.content));
      const calls = rounds[round++] ?? [];
      const usage = { inputTokens: 10, outputTokens: 1 };
      return calls.length ? { text: '', toolCalls: calls, model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage } : { text: 'Done.', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage };
    };
    const proposal = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'unsubscribe me from shop news and daily digest', features: ['compose', 'approval'] });
    expect(system).toMatch(/call unsubscribe once with all of them/);
    expect(proposal.approval).toBeTruthy();
    expect(posts).toEqual([]);
    expect(await h.sql('select * from public.mail_unsubscribes')).toEqual([]);
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Allow', features: ['compose', 'approval'], decision: { token: proposal.approval!.token, allow: true } });
    expect(answer.context).toContain('unsubscribed');
    expect(answer.context).toContain('archivedFromInbox');
    expect(posts).toHaveLength(1);
    // The unsubscribe email opens in Gmail for the user to send.
    expect(answer.compose).toEqual([expect.objectContaining({ to: [{ email: 'leave@daily.test' }], subject: 'stop' })]);
  });

  it('asks instead of guessing when a name matches several lists', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await newsletter(h, 'deals@shop.test', ONE_CLICK);
    await newsletter(h, 'orders@shop.test', ONE_CLICK);
    const posts = listServer(h);
    const results: string[] = [];
    let round = 0;
    h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      results.push(...request.messages.filter((message) => message.role === 'tool').map((message) => message.content));
      const calls = round++ ? [] : [{ id: 'a', name: 'unsubscribe', arguments: '{"senders":["shop.test"]}' }];
      const usage = { inputTokens: 10, outputTokens: 1 };
      return calls.length ? { text: '', toolCalls: calls, model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage } : { text: 'Which one?', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage };
    };
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'unsubscribe from shop' });
    const result = JSON.parse(results.at(-1)!) as { results: unknown[]; notDone: Array<{ candidates: string[] }> };
    expect(result.results).toEqual([]);
    expect(result.notDone[0]!.candidates).toHaveLength(2);
    expect(posts).toEqual([]);
  });
});
