import { describe, expect, it } from 'vitest';
import { SCOPES } from '../google/scopes.js';
import { createIntelHarness, type IntelHarness } from '../testing/intel-harness.js';
import { drainJobs } from '../routes/jobs.js';
import { runGmailSync } from './sync.js';
import { JobQueue } from '../jobs/queue.js';

const ADA = 'ada@work.test';
const BOB = 'bob@work.test';

async function connected(h: IntelHarness, email = ADA, features: Parameters<IntelHarness['connect']>[2] = ['mail_read']) {
  const session = await h.signIn(email);
  h.google.addAccount(email);
  h.google.deliver(email, { from: 'maya@client.test', fromName: 'Maya Chen', to: [email], subject: 'Kickoff notes', body: 'Here are the notes from the kickoff. No action needed.' });
  const result = await h.connect(session.accessToken, email, features);
  await h.drain();
  return { session, ...result };
}

describe('Google connection', () => {
  it('requests only the scopes for the chosen features, with PKCE, offline access and incremental auth', async () => {
    const h = await createIntelHarness();
    const session = await h.signIn(ADA);
    h.google.addAccount(ADA);
    const { url } = await h.route<{ url: string }>('connectStart', session.accessToken, { features: ['mail_read'], returnTo: 'web' });
    const params = new URL(url).searchParams;
    expect(params.get('scope')!.split(' ').sort()).toEqual(['email', 'openid', 'profile', SCOPES.readonly].sort());
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('include_granted_scopes')).toBe('true');
    expect(url).not.toContain('gmail.send');
  });

  it('stores the refresh token encrypted, bound to its account, and never returns it', async () => {
    const h = await createIntelHarness();
    const { session, landing } = await connected(h);
    expect(landing).toContain('https://app.test/dashboard?connected=1#connections');
    const [row] = await h.sql<{ ciphertext: string; key_id: string; user_id: string; mail_account_id: string; iv: string }>('select * from public.encrypted_credentials');
    expect(row!.ciphertext).not.toMatch(/^rt-/);
    expect(row!.key_id).toBe('k1');
    // The same ciphertext cannot be opened as another account's token (AAD binding).
    await expect(h.box.open({ keyId: row!.key_id, iv: row!.iv, ciphertext: row!.ciphertext }, { purpose: 'google_refresh_token', userId: row!.user_id, recordId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow();
    await expect(h.box.open({ keyId: row!.key_id, iv: row!.iv, ciphertext: row!.ciphertext }, { purpose: 'google_refresh_token', userId: row!.user_id, recordId: row!.mail_account_id })).resolves.toMatch(/^rt-/);
    const listed = await h.route<{ accounts: Array<Record<string, unknown>> }>('connections', session.accessToken);
    expect(JSON.stringify(listed)).not.toMatch(/rt-|ciphertext/);
    expect(listed.accounts[0]).toMatchObject({ email: ADA, status: 'active', features: ['mail_read'] });
  });

  it('refuses a replayed or forged state', async () => {
    const h = await createIntelHarness();
    const session = await h.signIn(ADA);
    h.google.addAccount(ADA);
    const { url } = await h.route<{ url: string }>('connectStart', session.accessToken, { features: ['mail_read'], returnTo: 'web' });
    const callback = await h.google.consent(url, ADA);
    expect((await h.api(new Request(callback))).headers.get('Location')).toContain('connected=1');
    const replay = await h.api(new Request(callback));
    expect(replay.headers.get('Location')).toContain('error=');
    const forged = new URL(callback);
    forged.searchParams.set('state', 'x'.repeat(40));
    expect((await h.api(new Request(forged))).headers.get('Location')).toContain('error=');
  });

  it('records features the user unticked on the consent screen as missing', async () => {
    const h = await createIntelHarness();
    const session = await h.signIn(ADA);
    const { landing } = await h.connect(session.accessToken, ADA, ['mail_read', 'calendar_read'], { grant: (scopes) => scopes.filter((scope) => !scope.includes('calendar')) });
    expect(landing).toContain('missing=calendar_read');
    const listed = await h.route<{ accounts: Array<{ features: string[] }> }>('connections', session.accessToken);
    expect(listed.accounts[0]!.features).toEqual(['mail_read']);
  });

  it('supports several Google accounts per user', async () => {
    const h = await createIntelHarness();
    const session = await h.signIn(ADA);
    await h.connect(session.accessToken, ADA);
    await h.connect(session.accessToken, 'ada.personal@home.test');
    const listed = await h.route<{ accounts: Array<{ email: string }> }>('connections', session.accessToken);
    expect(listed.accounts.map((account) => account.email).sort()).toEqual(['ada.personal@home.test', ADA]);
  });
});

describe('Gmail sync', () => {
  it('commits bounded recovery pages and resumes from durable continuation jobs', async () => {
    const h = await createIntelHarness();
    const session = await h.signIn(ADA);
    h.google.addAccount(ADA);
    for (let i = 0; i < 45; i++) h.google.deliver(ADA, { from: 'maya@client.test', to: [ADA], subject: `Recovery ${i}`, body: 'FYI.' });
    await h.connect(session.accessToken, ADA);
    await drainJobs(h.deps, { maxJobs: 1, concurrency: 1 }); // watch
    await drainJobs(h.deps, { maxJobs: 1, concurrency: 1 }); // first recovery page
    expect((await h.sql<{ n: number }>('select count(*)::int as n from public.message_metadata'))[0]?.n).toBe(20);
    expect((await h.sql<{ state: string }>('select state from public.gmail_sync_state'))[0]?.state).toBe('recovering');
    expect(await h.sql("select id from public.jobs where kind='gmail.recover' and status='queued' and payload ? 'pageToken'")).toHaveLength(1);
    await h.push(ADA);
    const queue = new JobQueue(h.db);
    const [sync] = await h.sql<{ id: string }>("select id from public.jobs where kind='gmail.sync' and status='queued'");
    const pendingBefore = (await h.sql("select id from public.jobs where kind='gmail.recover'")).length;
    const { openIntel } = await import('../routes/jobs.js');
    await expect(runGmailSync(openIntel(h.deps)!, (await queue.get(sync!.id))!)).rejects.toMatchObject({ reason: 'no_cursor' });
    expect(await h.sql("select id from public.jobs where kind='gmail.recover'")).toHaveLength(pendingBefore);
    await h.drain();
    expect((await h.sql<{ n: number }>('select count(*)::int as n from public.message_metadata'))[0]?.n).toBe(45);
    expect((await h.sql<{ state: string }>('select state from public.gmail_sync_state'))[0]?.state).toBe('healthy');
    expect(await h.sql("select id from public.jobs where kind='gmail.recover' and status='succeeded'")).toHaveLength(3);
    await h.route('connectionResync', session.accessToken, { accountId: (await h.sql<{ id: string }>('select id from public.mail_accounts'))[0]!.id });
    await h.drain();
    expect((await h.sql<{ n: number }>('select count(*)::int as n from public.message_metadata'))[0]?.n).toBe(45);
    expect((await h.sql<{ n: number }>('select sum(received_count)::int as n from public.contacts'))[0]?.n).toBe(45);
  });
  it('backfills metadata on connect without storing bodies, then watches the mailbox', async () => {
    const h = await createIntelHarness();
    await connected(h);
    const threads = await h.sql<{ subject: string; participants: Array<{ email: string }> }>('select subject, participants from public.threads');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.subject).toBe('Kickoff notes');
    const columns = await h.sql<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name in ('threads', 'message_metadata') and table_schema = 'public'`,
    );
    expect(columns.map((row) => row.column_name).join(',')).not.toMatch(/body|snippet|text|content_text/);
    expect(h.google.account(ADA).watch?.topic).toBe('projects/pigeonbox-test/topics/gmail-push');
    const [state] = await h.sql<{ state: string; history_id: string }>('select state, history_id::text from public.gmail_sync_state');
    expect(state!.state).toBe('healthy');
    expect(Number(state!.history_id)).toBe(h.google.account(ADA).historyId);
  });

  it('syncs a pushed message once, even when Google delivers the notification twice', async () => {
    const h = await createIntelHarness();
    await connected(h);
    h.google.deliver(ADA, { from: 'lee@client.test', to: [ADA], subject: 'Contract question', body: 'Could you confirm the start date?' });
    const first = await h.push(ADA);
    const second = await h.push(ADA);
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    const jobs = await h.sql<{ n: number }>(`select count(*)::int as n from public.jobs where kind = 'gmail.sync' and idempotency_key like 'sync:%:' || $1`, [String(h.google.account(ADA).historyId)]);
    expect(jobs[0]!.n).toBe(1);
    await h.drain();
    await h.push(ADA);
    await h.drain();
    const messages = await h.sql<{ n: number }>(`select count(*)::int as n from public.message_metadata`);
    expect(messages[0]!.n).toBe(2);
    const analyses = await h.sql<{ n: number }>(`select count(*)::int as n from public.jobs where kind = 'thread.analyze'`);
    expect(analyses[0]!.n).toBe(2);
  });

  it('pages through long history and advances the cursor only forward', async () => {
    const h = await createIntelHarness();
    await connected(h);
    h.google.historyPageSize = 2;
    for (let i = 0; i < 7; i += 1) h.google.deliver(ADA, { from: `p${i}@client.test`, to: [ADA], subject: `Update ${i}`, body: 'FYI.' });
    await h.push(ADA);
    await h.drain();
    expect((await h.sql<{ n: number }>('select count(*)::int as n from public.message_metadata'))[0]!.n).toBe(8);
    const [state] = await h.sql<{ history_id: string }>('select history_id::text from public.gmail_sync_state');
    expect(Number(state!.history_id)).toBe(h.google.account(ADA).historyId);
  });

  it('recovers safely when the history cursor has expired', async () => {
    const h = await createIntelHarness();
    await connected(h);
    h.google.deliver(ADA, { from: 'kim@client.test', to: [ADA], subject: 'While you were away', body: 'Checking in.' });
    h.google.expireHistory(ADA);
    await h.push(ADA);
    await h.drain();
    const recover = await h.sql<{ status: string }>(`select status from public.jobs where kind = 'gmail.recover' and idempotency_key like 'recover:%:expired:%'`);
    expect(recover.map((job) => job.status)).toEqual(['succeeded']);
    expect((await h.sql<{ n: number }>('select count(*)::int as n from public.message_metadata'))[0]!.n).toBe(2);
    const [state] = await h.sql<{ state: string }>('select state from public.gmail_sync_state');
    expect(state!.state).toBe('healthy');
  });

  it('moves revoked credentials to a recoverable state instead of retrying forever', async () => {
    const h = await createIntelHarness();
    const { session } = await connected(h);
    h.google.revokeAll(ADA);
    const { clearAccessTokenCache } = await import('./google-access.js');
    clearAccessTokenCache();
    h.google.deliver(ADA, { from: 'kim@client.test', to: [ADA], subject: 'Hello', body: 'Hi.' });
    await h.push(ADA);
    const result = await h.drain();
    expect(result.retried).toBe(0);
    const listed = await h.route<{ accounts: Array<{ status: string; sync: { state: string } }> }>('connections', session.accessToken);
    expect(listed.accounts[0]).toMatchObject({ status: 'needs_reauth', sync: { state: 'stalled' } });
    const notes = await h.route<{ notifications: Array<{ kind: string }> }>('notifications', session.accessToken, {});
    expect(notes.notifications.map((note) => note.kind)).toContain('sync_problem');
    // Reconnecting restores it.
    await h.connect(session.accessToken, ADA);
    const again = await h.route<{ accounts: Array<{ status: string }> }>('connections', session.accessToken);
    expect(again.accounts[0]!.status).toBe('active');
  });

  it('stops syncing after disconnect, revokes at Google, and deletes data on request', async () => {
    const h = await createIntelHarness();
    const { session } = await connected(h);
    const [account] = await h.route<{ accounts: Array<{ id: string }> }>('connections', session.accessToken).then((r) => r.accounts);
    await h.route('connectionDisconnect', session.accessToken, { accountId: account!.id, deleteData: false });
    expect(h.google.isRevoked(ADA)).toBe(true);
    expect(await h.sql('select * from public.encrypted_credentials')).toHaveLength(0);
    h.google.deliver(ADA, { from: 'kim@client.test', to: [ADA], subject: 'After disconnect', body: 'Hi.' });
    await h.push(ADA);
    const result = await h.drain();
    expect(result.claimed).toBe(0);
    expect(await h.sql(`select * from public.threads where subject = 'After disconnect'`)).toHaveLength(0);
    await h.route('connectionDisconnect', session.accessToken, { accountId: account!.id, deleteData: true });
    expect(await h.sql('select * from public.threads')).toHaveLength(0);
    expect(await h.sql('select * from public.mail_accounts')).toHaveLength(0);
  });

  it('never lets one user’s push touch another user’s data', async () => {
    const h = await createIntelHarness();
    await connected(h, ADA);
    await connected(h, BOB);
    const before = await h.sql<{ user_id: string; n: number }>('select user_id, count(*)::int as n from public.message_metadata group by user_id order by user_id');
    h.google.deliver(ADA, { from: 'x@client.test', to: [ADA], subject: 'Only for Ada', body: 'Hi.' });
    await h.push(ADA);
    await h.drain();
    const bobRows = await h.sql<{ subject: string }>(`select t.subject from public.threads t join public.mail_accounts a on a.id = t.mail_account_id where a.email = $1`, [BOB]);
    expect(bobRows.map((row) => row.subject)).not.toContain('Only for Ada');
    const after = await h.sql<{ user_id: string; n: number }>('select user_id, count(*)::int as n from public.message_metadata group by user_id order by user_id');
    expect(after.find((row) => row.user_id === before.find((b) => b.n === 1 && b.user_id !== after[0]!.user_id)?.user_id)).toBeTruthy();
    // A push naming Bob's address with a huge history ID only syncs Bob, with Bob's own cursor.
    const bogus = await h.push(BOB, 999_999_999);
    expect(bogus.status).toBe(204);
    await h.drain();
    expect(await h.sql(`select t.subject from public.threads t join public.mail_accounts a on a.id = t.mail_account_id where a.email = $1 and t.subject = 'Only for Ada'`, [BOB])).toHaveLength(0);
  });

  it('rejects push requests that are unsigned, tampered, for another audience or from another signer', async () => {
    const h = await createIntelHarness();
    await connected(h);
    expect((await h.push(ADA, undefined, { tamper: true })).status).toBe(401);
    expect((await h.push(ADA, undefined, { audience: 'https://evil.test/push' })).status).toBe(401);
    expect((await h.push(ADA, undefined, { signer: 'someone@else.iam.gserviceaccount.com' })).status).toBe(401);
    const unsigned = await h.api(new Request('https://api.test/v1/google/push', { method: 'POST', body: '{}' }));
    expect(unsigned.status).toBe(401);
  });

  it('keeps each user inside their own rows even in server code (RLS)', async () => {
    const h = await createIntelHarness();
    const ada = await connected(h, ADA);
    const bob = await connected(h, BOB);
    const seen = await h.db.asUser(bob.session.user.id, (tx) => tx.query<{ subject: string }>('select subject from public.threads'));
    expect(seen.every((row) => row.subject === 'Kickoff notes')).toBe(true);
    expect(seen).toHaveLength(1);
    await expect(
      h.db.asUser(bob.session.user.id, (tx) =>
        tx.query(`insert into public.threads (user_id, mail_account_id, gmail_thread_id) select $1::uuid, id, 'x' from public.mail_accounts limit 1`, [ada.session.user.id]),
      ),
    ).rejects.toThrow();
    const creds = await h.db.asUser(bob.session.user.id, (tx) => tx.query('select * from public.encrypted_credentials'));
    expect(creds).toHaveLength(1);
  });
});
