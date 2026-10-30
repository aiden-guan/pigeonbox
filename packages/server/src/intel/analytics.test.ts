import { describe, expect, it } from 'vitest';
import { seedUsers } from '../testing/database.js';
import { createIntelHarness, type IntelHarness } from '../testing/intel-harness.js';

type Analytics = {
  rows: Array<Record<string, number | string | null>>;
  totals: Record<string, number>;
  notes: string[];
};

const DAY = '2026-09-20';

async function tracked(h: IntelHarness, userId: string, id: string, fields: { recipient: string; opens?: number; clicks?: number; firstOpenAfterMin?: number; status?: string; day?: string }) {
  const sentAt = `${fields.day ?? DAY}T12:00:00.000Z`;
  const firstOpened = fields.firstOpenAfterMin === undefined ? null : new Date(Date.parse(sentAt) + fields.firstOpenAfterMin * 60_000).toISOString();
  await h.sql(
    `insert into public.tracked_emails (tracking_id, user_id, status, subject, sender, recipients, sent_at, open_count, first_opened_at, last_opened_at, click_count)
     values ($1, $2, $3, 'Plan', 'me@example.com', $4::jsonb, $5, $6, $7, $7, $8)`,
    [id, userId, fields.status ?? 'SENT', JSON.stringify([fields.recipient, 'cc@other.test']), sentAt, fields.opens ?? 0, firstOpened, fields.clicks ?? 0],
  );
}

describe('engagement analytics', () => {
  it('reports protocol-counted detections per group, never other accounts’ mail', async () => {
    const h = await createIntelHarness();
    const ada = await h.signIn('ada@analytics.test');
    const bob = await h.signIn('bob@analytics.test');
    await seedUsers(h.pg, [ada.user, bob.user].map((user) => ({ id: user.id, email: user.email! })));

    await tracked(h, ada.user.id, 'trk_a1', { recipient: 'Dana@Client.test', opens: 3, clicks: 1, firstOpenAfterMin: 10 });
    await tracked(h, ada.user.id, 'trk_a2', { recipient: 'sam@client.test', opens: 1, firstOpenAfterMin: 30 });
    await tracked(h, ada.user.id, 'trk_a3', { recipient: 'lee@other.test' });
    await tracked(h, ada.user.id, 'trk_a4', { recipient: 'dana@client.test', opens: 9, status: 'PENDING' });
    await tracked(h, bob.user.id, 'trk_b1', { recipient: 'dana@client.test', opens: 50, clicks: 50, firstOpenAfterMin: 1 });
    // A raw event the tracker did not count must not change the numbers.
    await h.sql(`insert into public.tracking_events (id, tracking_id, type, timestamp, classification, suspected_self_open) values ('evt_self', 'trk_a3', 'OPEN', '${DAY}T12:01:00Z', 'SELF_LIKELY', true)`);

    const range = { from: `${DAY}T00:00:00.000Z`, to: `${DAY}T23:59:59.000Z` };
    const byDay = await h.route<Analytics>('controlAnalytics', ada.accessToken, { ...range, groupBy: 'day' });
    expect(byDay.totals).toMatchObject({ sent: 3, opens: 4, emailsOpened: 2, clicks: 1, emailsClicked: 1, medianFirstOpenMinutes: 20 });
    expect(byDay.rows).toEqual([expect.objectContaining({ key: DAY, sent: 3, opens: 4, emailsOpened: 2, clicks: 1, emailsClicked: 1, medianFirstOpenMinutes: 20 })]);
    expect(byDay.notes.join(' ')).toMatch(/not that someone read it/);
    expect(JSON.stringify(byDay)).not.toMatch(/likely human|human open rate/i);

    const byDomain = await h.route<Analytics>('controlAnalytics', ada.accessToken, { ...range, groupBy: 'domain' });
    expect(byDomain.rows.map((row) => [row.key, row.sent, row.opens])).toEqual([
      ['client.test', 2, 4],
      ['other.test', 1, 0],
    ]);

    const csv = await h.route<{ csv: string }>('controlAnalyticsExport', ada.accessToken, { ...range, groupBy: 'contact' });
    expect(csv.csv.split('\r\n')[0]).toBe('"contact","sent","open_detections","emails_with_open","link_clicks","emails_with_click","median_minutes_to_first_open","replies","median_response_hours","follow_ups_due","follow_ups_answered"');
    expect(csv.csv).not.toContain('trk_b1');

    const bobView = await h.route<Analytics>('controlAnalytics', bob.accessToken, { ...range, groupBy: 'day' });
    expect(bobView.totals).toMatchObject({ sent: 1, opens: 50 });
  });
});
