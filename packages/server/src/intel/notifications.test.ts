import { afterEach, describe, expect, it } from 'vitest';
import { connectedUser, createIntelHarness, type IntelHarness } from '../testing/intel-harness.js';
import type { Preferences } from '@pigeonbox/api-contract';
import { DEFAULT_PREFERENCES } from './preferences.js';
import { deliveryTime, listNotifications, NOTIFICATION_BUDGET, NOTIFICATION_CLASS, notify } from './notifications.js';

const harnesses: IntelHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.pg.close();
});

async function setup() {
  const h = await createIntelHarness();
  harnesses.push(h);
  const ada = await connectedUser(h, 'ada@work.test', ['mail_read']);
  const bob = await connectedUser(h, 'bob@work.test', ['mail_read']);
  await h.sql(`delete from public.notifications`);
  const send = (userId: string, kind: Parameters<typeof notify>[1]['kind'], key: string) =>
    h.db.asUser(userId, (tx) => notify(tx, { userId, kind, title: `Draft ready: private subject ${key}`, body: 'A draft to review.', dedupeKey: key }, h.now()));
  const list = (userId: string) => h.db.asUser(userId, (tx) => tx.query<{ kind: string; title: string; body: string; dedupe_key: string; read_at: unknown }>(`select kind, title, body, dedupe_key, read_at from public.notifications order by created_at, dedupe_key`));
  return { h, ada: ada.userId, bob: bob.userId, send, list };
}

describe('notification budget', () => {
  it('collapses a large burst of prepared drafts into one digest after the budget, per person', async () => {
    const { ada, bob, send, list } = await setup();
    const budget = NOTIFICATION_BUDGET.draft_ready!;
    await Promise.all(Array.from({ length: 40 }, (_, index) => send(ada, 'draft_ready', `draft:${index}:1`)));
    const rows = await list(ada);
    expect(rows.filter((row) => !row.dedupe_key.startsWith('digest:'))).toHaveLength(budget);
    const digests = rows.filter((row) => row.dedupe_key.startsWith('digest:'));
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ kind: 'draft_ready', title: `${40 - budget} more drafts ready`, read_at: null });
    expect(digests[0]!.body).toContain('Nothing was sent');
    expect(digests[0]!.title).not.toContain('private subject');
    // Another person's budget is their own.
    await send(bob, 'draft_ready', 'draft:b:1');
    expect(await list(bob)).toHaveLength(1);
  });

  it('dedupes replays without spending budget, and never batches immediate kinds', async () => {
    const { ada, send, list } = await setup();
    for (let round = 0; round < 3; round += 1) await send(ada, 'draft_ready', 'draft:same:1');
    expect(await list(ada)).toHaveLength(1);
    for (let index = 0; index < 30; index += 1) await send(ada, 'approval', `approval:${index}`);
    expect((await list(ada)).filter((row) => row.kind === 'approval')).toHaveLength(30);
    for (const [kind, mode] of Object.entries(NOTIFICATION_CLASS)) if (['approval', 'sync_problem', 'mention', 'assignment'].includes(kind)) expect(mode).toBe('immediate');
  });

  it('starts a new window after it passes', async () => {
    const { h, ada, send, list } = await setup();
    for (let index = 0; index < NOTIFICATION_BUDGET.draft_ready! + 2; index += 1) await send(ada, 'draft_ready', `draft:${index}:1`);
    await h.sql(`update public.notifications set created_at = now() - interval '21 hours'`);
    await send(ada, 'draft_ready', 'draft:new:1');
    expect((await list(ada)).map((row) => row.dedupe_key)).toContain('draft:new:1');
  });
});

describe('notification preferences and quiet hours', () => {
  const prefs = (patch: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, timeZone: 'America/New_York', ...patch });

  it('delivers inside the day and holds outside it until the next workday starts', () => {
    // Tuesday 2026-10-13, New York (UTC-4).
    const at = (local: string) => new Date(`${local}-04:00`);
    expect(deliveryTime(prefs(), at('2026-10-13T10:00:00')).toISOString()).toBe(at('2026-10-13T10:00:00').toISOString());
    // Follow-ups come due at 08:30, before 09:00 working hours: the day starts at the earlier one.
    expect(deliveryTime(prefs(), at('2026-10-13T08:30:00')).toISOString()).toBe(at('2026-10-13T08:30:00').toISOString());
    expect(deliveryTime(prefs(), at('2026-10-13T06:10:00')).toISOString()).toBe(at('2026-10-13T08:30:00').toISOString());
    expect(deliveryTime(prefs(), at('2026-10-13T21:00:00')).toISOString()).toBe(at('2026-10-14T08:30:00').toISOString());
    // Friday evening and the weekend wait for Monday.
    expect(deliveryTime(prefs(), at('2026-10-16T18:00:00')).toISOString()).toBe(at('2026-10-19T08:30:00').toISOString());
    expect(deliveryTime(prefs(), at('2026-10-17T12:00:00')).toISOString()).toBe(at('2026-10-19T08:30:00').toISOString());
    // Someone who works weekends is reached on weekends.
    expect(deliveryTime(prefs({ workdays: [0, 1, 2, 3, 4, 5, 6] }), at('2026-10-17T12:00:00')).toISOString()).toBe(at('2026-10-17T12:00:00').toISOString());
  });

  it('holds a routine alert sent at night, hides it until then, and never holds an approval', async () => {
    const { h, ada, list } = await setup();
    await h.sql(`insert into public.user_preferences (user_id, time_zone, workdays, settings) values ($1::uuid, 'UTC', '{0,1,2,3,4,5,6}', '{}'::jsonb)
                 on conflict (user_id) do update set time_zone = 'UTC', workdays = '{0,1,2,3,4,5,6}', settings = '{}'::jsonb`, [ada]);
    const night = new Date(h.now());
    night.setUTCHours(23, 0, 0, 0);
    await h.db.asUser(ada, (tx) => notify(tx, { userId: ada, kind: 'draft_ready', title: 'Draft ready', body: 'b', dedupeKey: 'draft:night:1' }, night));
    await h.db.asUser(ada, (tx) => notify(tx, { userId: ada, kind: 'approval', title: 'Approval needed', body: 'b', dedupeKey: 'approval:night:1' }, night));
    expect((await list(ada)).map((row) => row.dedupe_key).sort()).toEqual(['approval:night:1', 'draft:night:1']);
    const [held] = await h.sql<{ created_at: Date }>(`select created_at from public.notifications where dedupe_key = 'draft:night:1'`);
    const morning = new Date(night);
    morning.setUTCDate(morning.getUTCDate() + 1);
    morning.setUTCHours(8, 30, 0, 0);
    expect(new Date(held!.created_at).toISOString()).toBe(morning.toISOString());
    const listed = await h.db.asUser(ada, (tx) => listNotifications(tx, { unreadOnly: false, limit: 30 }));
    expect(listed.notifications.map((row) => row.kind)).toEqual(['approval']);
    expect(listed.unread).toBe(1);
  });

  it('respects the follow-up, approval and engagement switches', async () => {
    const { h, ada, list } = await setup();
    await h.sql(`insert into public.user_preferences (user_id, time_zone, workdays, settings) values ($1::uuid, 'UTC', '{0,1,2,3,4,5,6}', $2::jsonb)
                 on conflict (user_id) do update set settings = excluded.settings, workdays = excluded.workdays`,
      [ada, JSON.stringify({ notifications: { followUpsDue: false, approvals: false, engagement: false }, workingHours: { start: '00:00', end: '23:59' }, followUp: { morningAt: '00:00' } })]);
    for (const kind of ['follow_up_due', 'approval', 'engagement', 'draft_ready', 'sync_problem'] as const) {
      await h.db.asUser(ada, (tx) => notify(tx, { userId: ada, kind, title: kind, body: 'b', dedupeKey: `${kind}:1` }, h.now()));
    }
    expect((await list(ada)).map((row) => row.kind).sort()).toEqual(['draft_ready', 'sync_problem']);
  });
});

describe('engagement alerts', () => {
  it('sends one alert when opening a conversation fires every tracked message in it', async () => {
    const { h, ada, list } = await setup();
    await h.sql(`insert into public.user_preferences (user_id, time_zone, workdays, settings) values ($1::uuid, 'UTC', '{0,1,2,3,4,5,6}', '{"notifications":{"engagement":true}}'::jsonb)
                 on conflict (user_id) do update set time_zone = 'UTC', workdays = '{0,1,2,3,4,5,6}', settings = excluded.settings`, [ada]);
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const now = h.now().getTime();
    const before = new Date(now - 15 * 86_400_000).toISOString();
    const opened = (offsetMs: number) => new Date(now - 60_000 + offsetMs).toISOString();
    for (const [index, trackingId] of ['trk_thread_a', 'trk_thread_b', 'trk_thread_c'].entries()) {
      await h.sql(`insert into public.tracked_emails (tracking_id, user_id, status, subject, sender, recipients, gmail_thread_id, sent_at) values ($1, $2::uuid, 'SENT', $3, 'ada@work.test', '["client@work.test"]', '18c1f5a3b2d4e6f7', $4::timestamptz)`,
        [trackingId, ada, index ? 'Re: Proposal' : 'Proposal', new Date(now - 20 * 86_400_000).toISOString()]);
      await h.sql(`insert into public.tracking_events (id, tracking_id, type, timestamp, user_agent, suspected_self_open, confidence, classification) values
                   ($1, $2, 'OPEN', $3::timestamptz, $5, false, 0.9, 'RECIPIENT_LIKELY'), ($4, $2, 'OPEN', $6::timestamptz, $5, false, 0.9, 'RECIPIENT_LIKELY')`,
        [`evt_old_${trackingId}`, trackingId, before, `evt_new_${trackingId}`, ua, opened(index * 1_500)]);
    }
    await h.advance(30_000);
    await h.drain();
    const engagement = (await list(ada)).filter((row) => row.kind === 'engagement');
    expect(engagement).toHaveLength(1);
    expect(engagement[0]!.title).toMatch(/^Reopened after 15 days/);
  });
});
