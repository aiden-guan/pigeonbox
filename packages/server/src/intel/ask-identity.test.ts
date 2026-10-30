import type { AskPigeonResponse, CloudDraft } from '@pigeonbox/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { VOICE } from '../testing.js';
import { parseRawMessage } from '../google/mime.js';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';
import { allowScriptedAskAction } from '../testing/scripted-ask.js';
import { readDataBlock, type DraftPromptInput } from './prompts.js';

const OWNER = 'aiden@work.test';
const MAYA = 'maya@client.test';
const worlds: IntelHarness[] = [];
afterEach(async () => { for (const h of worlds.splice(0)) await h.pg.close(); });
const response = { text: 'Prepared for review.', model: 'identity-fixture', provider: 'mock', serviceTier: 'standard' as const, usage: { inputTokens: 10, outputTokens: 10 } };

async function setup() {
  const h = await createIntelHarness();
  worlds.push(h);
  h.google.addAccount(OWNER, 'Aiden Guan');
  const user = await connectedUser(h, OWNER, ['mail_read', 'drafts'], { voice: { ...VOICE, name: 'Aiden', signoff: 'Best' }, autoDrafts: { enabled: false } });
  return { h, user };
}

describe('Chat email identities through the API', () => {
  it('corrects a model-supplied recipient name and signer using actual header identities', async () => {
    const { h, user } = await setup();
    const incoming = await deliverAndSync(h, OWNER, { from: MAYA, fromName: 'Maya Chen', to: [OWNER], subject: 'Review', body: 'Hi Aiden,\n\nCan you review this with Alex?\n\nMaya' });
    let round = 0;
    let readEvidence = '';
    h.deps.inference.chat = async (request) => {
      const allowed = allowScriptedAskAction(request);
      if (allowed) return allowed;
      const evidence = request.messages.filter((item) => item.role === 'tool').map((item) => item.content).join('\n');
      readEvidence += evidence;
      if (!round++) return { ...response, text: '', toolCalls: [{ id: 'r', name: 'read_thread', arguments: JSON.stringify({ source: incoming.threadId }) }] };
      if (round === 2) return { ...response, text: '', toolCalls: [{ id: 'c', name: 'compose_email', arguments: JSON.stringify({ to: [`Alex <${MAYA}>`], subject: 'Re: Review', body: 'Hi Alex,\n\nI will take a look.\n\nBest\nMaya' }) }] };
      return response;
    };
    const result = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Draft an email to Maya saying I will take a look.', features: ['compose'] });
    expect(result.compose).toEqual([{ to: [{ email: MAYA, name: 'Maya Chen' }], cc: [], subject: 'Re: Review', body: 'Hello,\n\nI will take a look.\n\nBest,\nAiden' }]);
    expect(readEvidence).toContain('"author":{"email":"maya@client.test","name":"Maya Chen","role":"correspondent"}');
    expect(readEvidence).toContain('"mailboxOwner":{"email":"aiden@work.test","name":"Aiden Guan"}');
    expect(readEvidence).toContain('"replyRecipients":{"to":[{"email":"maya@client.test","name":"Maya Chen"}]');
    expect(result.context).not.toContain('Can you review this with Alex?');
    expect(h.google.account(OWNER).sent).toHaveLength(0);
  });

  it('normalizes signatures for a new email without another generation pass', async () => {
    const { h, user } = await setup();
    let rounds = 0;
    let reviews = 0;
    h.deps.inference.chat = async (request) => {
      const allowed = allowScriptedAskAction(request);
      if (allowed) { reviews++; return allowed; }
      expect(request.messages.some((message) => message.content.includes('Configured signing name: "Aiden"'))).toBe(true);
      return rounds++ ? response : { ...response, text: '', toolCalls: [{ id: 'c', name: 'compose_email', arguments: JSON.stringify({ to: [], subject: 'Hello', body: 'Hello,\n\nHere is the update.\n\nBest\nAiden' }) }] };
    };
    const result = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Draft an update email; leave the address empty.', features: ['compose'] });
    expect(result.compose[0]!.body).toBe('Hello,\n\nHere is the update.\n\nBest,\nAiden');
    expect(rounds).toBe(2);
    expect(reviews).toBe(1);
  });

  it('uses the active mailbox name instead of the first connected account when no voice name is set', async () => {
    const { h, user } = await setup();
    const second = 'avery@other.test';
    h.google.addAccount(second, 'Avery Smith');
    await h.connect(user.token, second, ['mail_read']);
    await h.drain();
    await h.route('preferencesUpdate', user.token, { preferences: { voice: null } });
    let round = 0;
    h.deps.inference.chat = async (request) => allowScriptedAskAction(request) ?? (round++ ? response : {
      ...response, text: '', toolCalls: [{ id: 'c', name: 'compose_email', arguments: JSON.stringify({ to: [], subject: 'Update', body: 'Here is the update.\n\nBest\nAiden' }) }],
    });
    const result = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Draft an update from this inbox.', mailbox: second, features: ['compose'] });
    expect(result.compose[0]!.body).toBe('Here is the update.\n\nBest,\nAvery');
  });

  it('prepares a reply with Reply-To identity and fixes the model greeting and signature before storage', async () => {
    const { h, user } = await setup();
    const incoming = await deliverAndSync(h, OWNER, { from: 'service@client.test', fromName: 'Support', to: [OWNER], subject: 'Review',
      body: 'Hi Aiden,\n\nCan you review this?\n\nPriya', headers: { 'Reply-To': 'Priya Shah <priya@client.test>' } });
    let captured: DraftPromptInput | undefined;
    const original = h.deps.inference.chat.bind(h.deps.inference);
    h.deps.inference.chat = async (request, context) => {
      if (context.operation !== 'grounded_draft') return original(request, context);
      captured = readDataBlock(request.messages.at(-1)!.content) as DraftPromptInput;
      return { ...response, text: JSON.stringify({ variants: [{ label: 'recommended', strategy: 'Brief reply', body: 'Hi Aiden,\n\nI will take a look.\n\nBest\nPriya', usedSources: [] }], missingFacts: [], confidence: 0.95 }) };
    };
    const result = await h.route<{ draft: CloudDraft }>('draftPrepare', user.token, { threadId: incoming.threadId });
    expect(captured?.recipients).toEqual([{ email: 'priya@client.test', name: 'Priya Shah' }]);
    expect(captured?.owner.signName).toBe('Aiden');
    expect(result.draft.variants[0]!.body).toBe('Hello,\n\nI will take a look.\n\nBest,\nAiden');
    await h.route('draftPlace', user.token, { draftId: result.draft.id, variantId: result.draft.variants[0]!.id, idempotencyKey: 'reply-to-identity-test' });
    const placed = [...h.google.account(OWNER).drafts.values()][0]!;
    expect(parseRawMessage(placed.raw).headers.to).toBe('priya@client.test');
    expect(h.google.account(OWNER).sent).toHaveLength(0);
  });

  it('refreshes an older generated signature once and then reuses the corrected draft', async () => {
    const { h, user } = await setup();
    const incoming = await deliverAndSync(h, OWNER, { from: MAYA, fromName: 'Maya Chen', to: [OWNER], subject: 'Review', body: 'Could you review this?' });
    const first = await h.route<{ draft: CloudDraft }>('draftPrepare', user.token, { threadId: incoming.threadId });
    const legacy = first.draft.variants.map((variant) => ({ ...variant, body: 'Hi Maya,\n\nI will take a look.\n\nBest\nAiden' }));
    const sealed = await h.box.seal(JSON.stringify(legacy), { purpose: 'draft', userId: user.userId, recordId: `${first.draft.id}:1` });
    await h.sql('update public.draft_versions set variants_key_id = $1, variants_iv = $2, variants_ciphertext = $3 where draft_id = $4::uuid and version = 1', [sealed.keyId, sealed.iv, sealed.ciphertext, first.draft.id]);
    const next = await h.route<{ draft: CloudDraft }>('draftPrepare', user.token, { threadId: incoming.threadId });
    expect(next.draft.id).toBe(first.draft.id);
    expect(next.draft.variants.every((variant) => variant.body.includes(',\nAiden'))).toBe(true);
    await h.route('draftPrepare', user.token, { threadId: incoming.threadId });
    expect(await h.sql('select version from public.draft_versions order by version')).toEqual([{ version: 1 }, { version: 2 }]);
  });
});
