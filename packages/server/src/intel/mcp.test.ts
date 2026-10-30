import type { Approval } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import { API } from '../testing.js';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';

const ADA = 'ada@work.test';

type RpcReply = { jsonrpc: '2.0'; id: number; result?: { tools?: Array<{ name: string; annotations: { readOnlyHint: boolean } }>; isError?: boolean; content?: Array<{ text: string }>; structuredContent?: Record<string, unknown>; protocolVersion?: string }; error?: { code: number; message: string } };

async function token(h: IntelHarness, session: string, scopes: Array<'read' | 'prepare' | 'write'>) {
  return (await h.route<{ token: string; id: string }>('controlTokenCreate', session, { name: `Agent ${scopes.join('+')}`, scopes }));
}

let rpcId = 0;
async function mcp(h: IntelHarness, bearer: string, method: string, params?: Record<string, unknown>) {
  const response = await h.api(new Request(`${API}/v1/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, ...(params ? { params } : {}) }) }));
  return { status: response.status, body: response.status === 200 ? ((await response.json()) as RpcReply) : null };
}

const call = (h: IntelHarness, bearer: string, name: string, args: Record<string, unknown>) => mcp(h, bearer, 'tools/call', { name, arguments: args });

describe('MCP server', () => {
  it('lists only the tools a token’s scopes allow, and read tools cannot write', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const { threadId } = await deliverAndSync(h, ADA, { from: 'lee@client.test', to: [ADA], subject: 'Invoice 42', body: 'Please find invoice 42 attached.' });
    const reader = await token(h, user.token, ['read']);
    const init = await mcp(h, reader.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.body!.result!.protocolVersion).toBe('2025-06-18');
    const tools = (await mcp(h, reader.token, 'tools/list')).body!.result!.tools!;
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(tools.map((tool) => tool.name)).not.toContain('archive_thread');

    const found = await call(h, reader.token, 'search_mail', { query: 'invoice' });
    expect(JSON.stringify(found.body!.result!.structuredContent)).toContain(threadId);
    const denied = await call(h, reader.token, 'archive_thread', { thread_id: threadId, idempotency_key: 'mcp-archive-0001' });
    expect(denied.body!.result).toMatchObject({ isError: true });
    expect(denied.body!.result!.content![0]!.text).toMatch(/"write" scope/);
    expect(h.google.calls.some((entry) => entry.path.includes('/modify'))).toBe(false);
  });

  it('asks for approval instead of sending, and a token can never approve', async () => {
    const h = await createIntelHarness({ env: { TRACKER_BASE_URL: 'https://t.test' } });
    const user = await connectedUser(h, ADA, ['mail_read', 'drafts', 'organize', 'send']);
    const writer = await token(h, user.token, ['read', 'prepare', 'write']);
    const result = await call(h, writer.token, 'request_send', { to: ['lee@client.test'], subject: 'Hello', body: 'Hi Lee', idempotency_key: 'mcp-send-000001' });
    const { approvalId } = result.body!.result!.structuredContent as { approvalId: string };
    expect(result.body!.result!.structuredContent).toMatchObject({ decision: 'approval_required' });
    await h.drain();
    expect(h.google.account(ADA).sent).toHaveLength(0);

    // The same request again (retry) makes no second approval.
    await call(h, writer.token, 'request_send', { to: ['lee@client.test'], subject: 'Hello', body: 'Hi Lee', idempotency_key: 'mcp-send-000001' });
    const listed = await h.call('/v1/approvals/list', { method: 'POST', body: {}, token: writer.token });
    const approvals = ((await listed.json()) as { approvals: Approval[] }).approvals;
    expect(approvals.map((approval) => approval.id)).toEqual([approvalId]);
    expect(approvals[0]).toMatchObject({ responsible: { type: 'mcp' }, preview: { to: ['lee@client.test'], body: 'Hi Lee' } });

    const decide = await h.call('/v1/approvals/decide', { body: { id: approvalId, decision: 'approve', idempotencyKey: 'token-approve-001' }, token: writer.token });
    expect(decide.status).toBe(403);
    // Only the person, signed in, can approve.
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', idempotencyKey: 'user-approve-0001' });
    await h.drain();
    expect(h.google.account(ADA).sent).toHaveLength(1);
  });

  it('makes writes idempotent, audited as the MCP client, and undoable', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const { threadId } = await deliverAndSync(h, ADA, { from: 'news@digest.test', to: [ADA], subject: 'Weekly digest', body: 'Read online.' });
    const writer = await token(h, user.token, ['read', 'write']);
    for (let i = 0; i < 2; i += 1) {
      const archived = await call(h, writer.token, 'archive_thread', { thread_id: threadId, idempotency_key: 'mcp-archive-0002' });
      expect(archived.body!.result!.isError).toBe(false);
    }
    expect(h.google.calls.filter((entry) => entry.path.includes('/modify'))).toHaveLength(1);
    const audit = await h.route<{ events: Array<{ id: string; action: string; actor: { type: string }; reversible: boolean }> }>('auditList', user.token, {});
    const event = audit.events.find((item) => item.action === 'archive')!;
    expect(event).toMatchObject({ actor: { type: 'mcp' }, reversible: true });
    await h.route('actionUndo', user.token, { auditId: event.id, idempotencyKey: 'undo-mcp-archive' });
    expect([...h.google.account(ADA).messages.values()].find((message) => message.threadId === threadId)!.labelIds).toContain('INBOX');
  });

  it('stops working the moment a token is revoked, and stores only a hash', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const reader = await token(h, user.token, ['read']);
    expect((await mcp(h, reader.token, 'ping')).status).toBe(200);
    expect(JSON.stringify(await h.sql('select * from public.mcp_clients'))).not.toContain(reader.token);
    const listed = await h.route<{ tokens: Array<{ id: string; prefix: string }> }>('controlTokens', user.token);
    expect(JSON.stringify(listed)).not.toContain(reader.token);
    expect(reader.token.startsWith(listed.tokens[0]!.prefix)).toBe(true);

    await h.route('controlTokenRevoke', user.token, { id: reader.id });
    const after = await mcp(h, reader.token, 'ping');
    expect(after.status).toBe(401);
    expect((await h.call('/v1/threads/intel', { body: { threadIds: ['abc'] }, token: reader.token })).status).toBe(401);
    expect((await mcp(h, 'pbx_not_a_real_token_value_000000', 'ping')).status).toBe(401);
  });
});

describe('Developer API', () => {
  it('limits tokens to their scopes and never to account administration', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const reader = await token(h, user.token, ['read']);
    expect((await h.call('/v1/focus/queue', { method: 'POST', body: {}, token: reader.token })).status).toBe(200);
    // A read token cannot prepare or write.
    expect((await h.call('/v1/drafts/prepare', { body: { threadId: 'abc', idempotencyKey: 'k-000000001' }, token: reader.token })).status).toBe(403);
    // No token can mint tokens, change billing, delete the account or manage Google connections.
    const writer = await token(h, user.token, ['read', 'prepare', 'write']);
    for (const [path, body] of [
      ['/v1/control/tokens/create', { name: 'escalate', scopes: ['write'] }],
      ['/v1/account/delete', { confirm: 'delete my account' }],
      ['/v1/connections/disconnect', { accountId: user.accountId, deleteData: true }],
      ['/v1/connections/google/start', { features: ['send'], returnTo: 'web' }],
      ['/v1/preferences/update', { preferences: {} }],
    ] as const) {
      const response = await h.call(path, { body, token: writer.token });
      expect(response.status, path).toBe(403);
    }
  });
});
