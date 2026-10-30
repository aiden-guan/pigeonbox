import { button, clear, confirmDialog, h, index, pill, select, surface, table, toast, toggle } from '../ui.js';

const CONTENT = {
  metadata: ['Metadata', 'neutral', 'IDs, dates, addresses and states. No message text.'],
  encrypted: ['Encrypted', 'good', 'Sealed with AES-256-GCM using keys only your PigeonBox server holds.'],
  configuration: ['Settings', 'neutral', 'Your preferences and rules.'],
};
const RETENTION = [
  ['7', '7 days'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['180', '6 months'],
  ['365', '1 year'],
];

export async function render({ api }) {
  const root = h('div', { class: 'stack' });
  const draw = async () => {
    const { inventory, fastRecall } = await api('/v1/control/privacy');
    const retention = select(RETENTION, String(fastRecall.retentionDays));
    retention.addEventListener('change', async () => {
      try {
        await api('/v1/preferences/update', { method: 'POST', body: { preferences: { fastRecall: { retentionDays: Number(retention.value) } } } });
        toast('Retention updated. Older excerpts are deleted on the next sweep.', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    const records = inventory.reduce((sum, row) => sum + row.count, 0);
    clear(
      root,
      h(
        'div',
        { class: 'grid-2' },
        surface(
          'card',
          { eyebrow: 'Message text', title: 'Fast Recall' },
          h('p', { class: 'muted' }, 'By default PigeonBox keeps no message text: Chat searches summaries and re-reads Gmail when it needs detail. Fast Recall keeps encrypted excerpts of synced messages so deep questions are answered faster.'),
          h(
            'div',
            { class: 'toggles' },
            toggle('Keep encrypted excerpts for Fast Recall', fastRecall.enabled, async (on) => {
              if (!on && !(await confirmDialog({ title: 'Turn off Fast Recall?', body: ['All stored excerpts are deleted immediately.'], confirm: 'Turn off and delete', danger: true }))) throw new Error('Kept on.');
              await api('/v1/preferences/update', { method: 'POST', body: { preferences: { fastRecall: { enabled: on } } } });
              toast(on ? 'Fast Recall is on. New mail is indexed as it syncs.' : 'Fast Recall is off and its excerpts were deleted.', 'success');
              await draw();
            }),
          ),
          h('div', { class: 'row' }, h('label', { class: 'inline-label' }, 'Keep excerpts for ', retention)),
        ),
        surface(
          'slip',
          { title: 'How PigeonBox treats mail' },
          h(
            'ul',
            { class: 'plain' },
            h('li', {}, 'Credentials for Google are encrypted and never leave your PigeonBox server.'),
            h('li', {}, 'Logs never contain message text, prompts, AI output or credentials.'),
            h('li', {}, 'Email content is treated as untrusted data: instructions inside an email are never followed by PigeonBox’s AI.'),
          ),
        ),
      ),
      surface(
        'ledger',
        { title: 'What is stored', actions: pill(`${records.toLocaleString()} records`, 'neutral') },
        table(
          [
            { label: 'Data', render: (row) => row.label },
            { label: 'How', render: (row) => h('span', { title: CONTENT[row.content][2] }, pill(CONTENT[row.content][0], CONTENT[row.content][1])) },
            { label: 'Records', numeric: true, render: (row) => row.count.toLocaleString() },
          ],
          inventory,
        ),
        h('p', { class: 'hint' }, 'Hover a mark to see how that data is kept. Local PigeonBox data in your browser is separate and never shown here.'),
      ),
      h(
        'div',
        { class: 'grid-2' },
        surface(
          'card',
          { eyebrow: 'Cannot be undone', title: 'Delete synced mail data', className: 'danger-zone' },
          h('p', { class: 'muted' }, 'Deletes everything PigeonBox derived from your mail — summaries, drafts, follow-ups, contacts, search data and excerpts — across all connections. Connections stay; new mail syncs from now on. Gmail is not changed.'),
          h('div', { class: 'row' }, button('Delete synced mail data…', async () => {
            const ok = await confirmDialog({ title: 'Delete synced mail data?', body: ['This cannot be undone.'], confirm: 'Delete', danger: true, typed: 'delete synced mail data' });
            if (!ok) return;
            const { removed } = await api('/v1/control/privacy/purge-mail', { method: 'POST', body: { confirm: 'delete synced mail data' } });
            toast(`Deleted ${removed.toLocaleString()} records.`, 'success');
            await draw();
          }, { variant: 'danger-ghost' })),
        ),
        surface(
          'ledger',
          { title: 'More controls' },
          index([
            ['Personal memories', 'Inspect, correct or forget them', '#memory'],
            ['Disconnect a Google account', 'Revokes access and deletes its credentials', '#connections'],
            ['Delete your account', 'Removes your account and its data from this server', '#account'],
            ['Privacy notice', 'How PigeonBox handles your data', 'https://github.com/aiden-guan/pigeonbox/blob/main/PRIVACY.md'],
          ]),
        ),
      ),
    );
  };
  await draw();
  return root;
}
