import { expect, it } from 'vitest';
import { CloudOverviewResponseSchema, type CloudOverview } from '@pigeonbox/api-contract';
import { connectedUser, createIntelHarness, deliverAndSync } from '../testing/intel-harness.js';
import { cloudOverview, withinContract } from './overview.js';
import { openIntel } from '../routes/jobs.js';
it('counts actual recent user-scoped work, clamps the window, and does no writes or inference', async () => {
  const h = await createIntelHarness();
  const ada = await connectedUser(h, 'ada@work.test', ['mail_read']);
  const bob = await connectedUser(h, 'bob@work.test', ['mail_read']);
  await deliverAndSync(h, 'ada@work.test', { from: 'maya@client.test', to: ['ada@work.test'], subject: 'Quote', body: 'Can you send a quote?' });
  await deliverAndSync(h, 'bob@work.test', { from: 'other@client.test', to: ['bob@work.test'], subject: 'Other private work', body: 'FYI' });
  const before = await h.sql('select id, status from public.jobs order by id');
  const overview = await h.route<CloudOverview>('cloudOverview', ada.token, { since: '2000-01-01T00:00:00.000Z' });
  expect(overview.accounts!.map((item) => item.email)).toEqual(['ada@work.test']);
  expect(overview.work?.threadsAnalyzed).toBe(1);
  expect(overview.work?.draftsPrepared).toBeGreaterThanOrEqual(0);
  const restricted = await cloudOverview(openIntel(h.deps)!, ada.userId, ['cloud_mail_sync']);
  expect(restricted.work?.draftsPrepared).toBeNull();
  expect(restricted.automatic).toBeNull();
  expect(overview.recent?.map((item) => [item.subject, item.who])).toEqual([['Quote', 'maya@client.test']]);
  expect(overview.recent?.[0]?.state).toBeTruthy();
  expect(overview.since).toBe(new Date(Date.parse(overview.generatedAt) - 30 * 86400000).toISOString());
  expect(JSON.stringify(overview)).not.toContain('Other private work');
  expect(await h.sql('select id, status from public.jobs order by id')).toEqual(before);
  const later = await h.route<CloudOverview>('cloudOverview', bob.token, { since: '2099-01-01T00:00:00.000Z' });
  expect(later.since).toBe(later.generatedAt);
});
it('retains healthy sections when an optional section fails without leaking exception details', async () => {
  const h = await createIntelHarness(); const user = await connectedUser(h, 'ada@work.test');
  const deps = openIntel(h.deps)!;
  const scoped = deps.db.asUser.bind(deps.db);
  const db = { ...deps.db, asUser: async <T>(id: string, read: Parameters<typeof deps.db.asUser<T>>[1]) => scoped(id, (tx) => read({ query: async <R>(sql: string, params?: readonly unknown[]) => { if (sql.includes('public.briefings')) throw new Error('secret body prompt token'); return tx.query<R>(sql, params); } })) };
  const overview = await cloudOverview({ ...deps, db }, user.userId, ['cloud_mail_sync', 'cloud_automations']);
  expect(overview.unavailable).toEqual(['briefing']); expect(overview.accounts).not.toBeNull(); expect(overview.work).not.toBeNull(); expect(overview.focus).not.toBeNull();
  expect(JSON.stringify(h.logs)).not.toContain('secret body');
});
it('requires authenticated entitlement, with documents available through the public create contract', async () => {
  const h = await createIntelHarness(); const removed = await h.signIn('removed@work.test');
  // Taken off the access list after signing in.
  h.config.allowedEmails.splice(0, Infinity, 'kept@work.test');
  expect((await h.call('/v1/overview', { body: {} })).status).toBe(401);
  await expect(h.route('cloudOverview', removed.accessToken, {})).rejects.toMatchObject({ status: 402 });
  const session = await h.signIn('kept@work.test');
  const doc = await h.route<{ document: { id: string; status: string }; uploadPath?: string }>('documentCreate', session.accessToken, { title: 'Proposal', filename: 'proposal.pdf' });
  expect(doc.document.status).toBe('uploading'); expect(doc.uploadPath).toBeUndefined();
  const response = await h.call(`/v1/documents/${doc.document.id}/content`, { method: 'OPTIONS', headers: { Origin: `chrome-extension://${h.config.allowedExtensionIds[0]}` } });
  expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
});

it('reports queue health through real SQL without exposing rows', async () => { const h = await createIntelHarness(); const { operationalReporter, reportQueueHealth } = await import('../observability.js'); const reports: string[] = []; const report = operationalReporter({ endpoint: 'https://collector.test/events', fetch: async (_url, init) => { reports.push(String(init?.body)); return new Response(null, { status: 204 }); } }); await reportQueueHealth(h.db, report); await report.flush(); const payload = JSON.parse(reports[0]!); expect(payload.samples.map((sample: { metric: string }) => sample.metric)).toEqual(['dead_jobs', 'oldest_due_seconds', 'expired_leases', 'sync_lag_seconds', 'job_lease_loss']); expect(reports[0]).not.toContain('@'); });

it('drops an off-contract section instead of failing the whole overview, logging only its field path', async () => {
  const h = await createIntelHarness(); const user = await connectedUser(h, 'ada@work.test');
  const deps = openIntel(h.deps)!;
  const healthy = await cloudOverview(deps, user.userId, ['cloud_mail_sync', 'cloud_automations']);
  const logs: unknown[] = [];
  // A stored briefing whose title is longer than the contract allows.
  const at = healthy.generatedAt;
  const broken = withinContract({ ...deps, log: (...args) => { logs.push(args); } }, { ...healthy, latestBriefing: { id: '00000000-0000-4000-8000-000000000001', kind: 'morning', title: 'secret '.repeat(40), generatedAt: at, periodStart: at, periodEnd: at, eventId: null, sections: [], sources: [], coverageNote: '' } });
  expect(broken.latestBriefing).toBeNull();
  expect(broken.unavailable).toEqual(['briefing']);
  expect(broken.accounts).not.toBeNull(); expect(broken.focus).not.toBeNull();
  expect(CloudOverviewResponseSchema.safeParse(broken).success).toBe(true);
  expect(JSON.stringify(logs)).toContain('latestBriefing.title: too_big');
  expect(JSON.stringify(logs)).not.toContain('secret');
});
