import { ago, button, clear, empty, field, h, humanize, input, key, note, pill, select, stat, table, tabs, timeline, toast } from '../ui.js';
import { download, tierPill } from '../shared.js';

const isoDay = (date) => date.toISOString().slice(0, 10);
const TOTALS = {
  sent: 'Tracked emails',
  opens: 'Open detections',
  emailsOpened: 'Emails with an open',
  clicks: 'Link clicks',
  emailsClicked: 'Emails with a click',
  medianFirstOpenMinutes: 'Median time to first open',
  replies: 'Replies',
  followUpsDue: 'Follow-ups due',
  followUpsAnswered: 'Follow-ups answered',
};
const DECISION = { allowed: 'neutral', shadowed: 'quiet', approval_required: 'warn', denied: 'bad' };

function minutes(value) {
  if (value === null || value === undefined) return '–';
  if (value < 60) return `${Math.round(value)} min`;
  if (value < 48 * 60) return `${(value / 60).toFixed(1)} h`;
  return `${(value / 1440).toFixed(1)} d`;
}

function totalValue(name, value) {
  return name === 'medianFirstOpenMinutes' ? minutes(value) : Number(value).toLocaleString();
}

function engagement(api) {
  return async () => {
    const to = input({ type: 'date', value: isoDay(new Date()) });
    const from = input({ type: 'date', value: isoDay(new Date(Date.now() - 29 * 86_400_000)) });
    const group = select([['day', 'By day'], ['contact', 'By person'], ['domain', 'By company domain']], 'day');
    const results = h('div', { class: 'stack' });
    const body = () => ({ from: from.value, to: to.value, groupBy: group.value });
    const draw = async () => {
      const data = await api('/v1/control/analytics', { method: 'POST', body: body() });
      clear(
        results,
        h('div', { class: 'stats' }, Object.entries(data.totals).map(([name, value]) => stat(TOTALS[name] ?? humanize(name), totalValue(name, value)))),
        table(
          [
            { label: group.value === 'day' ? 'Day' : group.value === 'contact' ? 'Person' : 'Domain', render: (row) => row.key },
            { label: 'Tracked', numeric: true, render: (row) => row.sent },
            { label: 'Open detections', numeric: true, render: (row) => row.opens },
            { label: 'With an open', numeric: true, render: (row) => row.emailsOpened },
            { label: 'First open (median)', numeric: true, render: (row) => minutes(row.medianFirstOpenMinutes) },
            { label: 'Link clicks', numeric: true, render: (row) => row.clicks },
            { label: 'With a click', numeric: true, render: (row) => row.emailsClicked },
            { label: 'Replies', numeric: true, render: (row) => row.replies },
            { label: 'Median reply', numeric: true, render: (row) => (row.medianResponseHours === null ? '–' : `${row.medianResponseHours.toFixed(1)} h`) },
            { label: 'Follow-ups answered', numeric: true, render: (row) => `${row.followUpsAnswered}/${row.followUpsDue}` },
          ],
          data.rows,
          { emptyText: 'No tracked email in this period.' },
        ),
        data.notes.length ? h('div', {}, data.notes.map((text) => h('p', { class: 'hint' }, text))) : null,
      );
    };
    const controls = h(
      'form',
      { class: 'row wrap-end tight', on: { submit: (event) => event.preventDefault() } },
      field('From', from),
      field('To', to),
      field('Group', group),
      button('Update', draw, { variant: 'ghost' }),
      button('Export CSV', async () => {
        const { filename, csv } = await api('/v1/control/analytics/export', { method: 'POST', body: body() });
        download(filename, csv);
      }, { variant: 'quiet', busy: 'Exporting…' }),
    );
    await draw();
    return h('div', { class: 'stack' }, note('An open detection means the tracking image loaded where the tracker attributes it to a recipient, often through Gmail’s image proxy. Your own views, delivery prefetches and security scanners are not counted. None of these numbers means an email was read.', 'info'), controls, results);
  };
}

function audit(api) {
  return async () => {
    const holder = h('div');
    const draw = async () => {
      const { events } = await api('/v1/audit/list', { method: 'POST', body: { limit: 100 } });
      clear(
        holder,
        events.length
          ? timeline(
              events.map((event) => ({
                at: event.at,
                title: event.summary,
                meta: `${event.actor.name} · ${event.policy.reason}${event.target.title ? ` · ${event.target.title}` : ''}`,
                tone: event.undoneAt ? 'quiet' : DECISION[event.policy.decision] ?? (event.tier >= 2 ? 'copper' : 'neutral'),
                aside: [
                  tierPill(event.tier),
                  event.undoneAt
                    ? pill(`Undone ${ago(event.undoneAt)}`, 'neutral')
                    : event.reversible
                      ? button('Undo', async () => {
                          await api('/v1/audit/undo', { method: 'POST', body: { auditId: event.id, idempotencyKey: key() } });
                          toast('Undone.', 'success');
                          await draw();
                        }, { small: true, variant: 'ghost', busy: 'Undoing…' })
                      : null,
                ],
              })),
            )
          : empty('Nothing has been done on your behalf yet. Every change PigeonBox makes appears here, with who asked for it and why.'),
      );
    };
    await draw();
    return holder;
  };
}

function recent(api) {
  return async () => {
    const { items } = await api('/v1/control/activity', { method: 'POST', body: { limit: 100 } });
    return items.length ? timeline(items.map((item) => ({ at: item.at, title: item.label, meta: humanize(item.kind), tone: 'neutral' }))) : empty('No recent activity.');
  };
}

export async function render({ api, caps }) {
  const items = [];
  if (caps.has('cloud_relationships')) items.push(['timeline', 'Recent', recent(api)]);
  if (caps.has('cloud_tracking')) items.push(['engagement', 'Engagement', engagement(api)]);
  items.push(['audit', 'Audit log', audit(api)]);
  return tabs(items);
}
