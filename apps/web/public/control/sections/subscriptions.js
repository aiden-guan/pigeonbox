import { ago, button, checkbox, clear, emptyState, h, input, note, pill, plural, surface, toast, toggle } from '../ui.js';

/**
 * Mailing lists. Found from synced mail headers, left with the sender's own
 * one-click unsubscribe (no website visits), and, with the Organize
 * permission, kept out of the inbox even when a list ignores the request.
 */

const STATUS = {
  done: ['Unsubscribed', 'good'],
  needs_user: ['One step left', 'warn'],
  failed: ['Not done', 'bad'],
};

const label = (item) => item.name || item.email;

/** The one thing left to do for a list without one-click unsubscribe. */
function finishLink(followUp) {
  if (!followUp) return null;
  const href = followUp.kind === 'email' ? followUp.gmailUrl : followUp.url;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-ghost btn-small' }, followUp.kind === 'email' ? 'Send unsubscribe email' : 'Open unsubscribe page');
}

export async function render({ api }) {
  const root = h('div');
  /** Follow-ups from this visit, by sender, so they stay visible after the list redraws. */
  const pending = new Map();
  let archive = true;
  let query = '';

  const draw = async () => {
    const { subscriptions, canArchive } = await api('/v1/control/subscriptions', { method: 'POST', body: query ? { query } : {} });
    const active = subscriptions.filter((item) => !item.unsubscribed || item.unsubscribed.status === 'failed');
    const left = subscriptions.filter((item) => item.unsubscribed && item.unsubscribed.status !== 'failed');
    const selected = new Set();
    const keyOf = (item) => `${item.accountId}:${item.email}`;
    const multipleInboxes = new Set(subscriptions.map((item) => item.accountId)).size > 1;

    const run = async (items) => {
      const { results } = await api('/v1/control/subscriptions/unsubscribe', { method: 'POST', body: { senders: items.map((item) => ({ accountId: item.accountId, email: item.email })), archive: archive && canArchive } });
      for (const result of results) if (result.followUp) pending.set(`${result.accountId}:${result.email}`, result.followUp);
      const done = results.filter((result) => result.status === 'done').length;
      const steps = results.filter((result) => result.status === 'needs_user').length;
      const failed = results.filter((result) => result.status === 'failed');
      if (results.length === 1) toast(results[0].message, results[0].status === 'failed' ? 'error' : results[0].status === 'done' ? 'success' : 'info');
      else toast([done ? `Unsubscribed from ${done}.` : '', steps ? `${steps} need one more click.` : '', failed.length ? `${failed.length} couldn’t be done.` : ''].filter(Boolean).join(' '), failed.length ? 'error' : 'success');
      await draw();
    };

    const bulk = button('Unsubscribe from selected', () => run(active.filter((item) => selected.has(keyOf(item)))), { busy: 'Unsubscribing…', disabled: true });
    const syncBulk = () => {
      bulk.disabled = !selected.size;
      bulk.textContent = selected.size ? `Unsubscribe from ${plural(selected.size, 'list')}` : 'Unsubscribe from selected';
    };

    const meta = (item) =>
      [multipleInboxes ? item.account : null, item.recent === item.messages ? `${plural(item.messages, 'email')} in 30 days` : [item.recent ? `${item.recent} in 30 days` : null, `${plural(item.messages, 'email')} in all`].filter(Boolean).join(', '), item.inInbox ? `${item.inInbox} in inbox` : null, `latest ${ago(item.lastAt)}`].filter(Boolean).join(' · ');

    const row = (item) => {
      const box = h('input', { type: 'checkbox', attrs: { 'aria-label': `Select ${label(item)}` } });
      box.addEventListener('change', () => {
        box.checked ? selected.add(keyOf(item)) : selected.delete(keyOf(item));
        syncBulk();
      });
      return h(
        'li',
        {},
        h('label', { class: 'check sub-pick' }, box),
        h('div', { class: 'list-main' }, h('strong', {}, label(item)), h('span', { class: 'muted' }, item.name ? `${item.email} · ${meta(item)}` : meta(item))),
        item.unsubscribed?.status === 'failed' ? pill('Last try failed', 'bad') : null,
        button('Unsubscribe', () => run([item]), { variant: 'ghost', small: true, busy: 'Unsubscribing…' }),
      );
    };

    const leftRow = (item) => {
      const u = item.unsubscribed;
      const followUp = pending.get(keyOf(item));
      return h(
        'li',
        {},
        h(
          'div',
          { class: 'list-main' },
          h('strong', {}, label(item)),
          h('span', { class: 'muted' }, [item.name ? item.email : null, multipleInboxes ? item.account : null, `left ${ago(u.at)}`, u.method === 'archive_only' ? 'kept out of inbox (no unsubscribe offered)' : null].filter(Boolean).join(' · ')),
        ),
        h(
          'div',
          { class: 'chips' },
          pill(...STATUS[u.status]),
          u.since ? pill(`Still sent ${u.since}`, 'warn') : null,
        ),
        u.status === 'needs_user' ? finishLink(followUp) ?? button('Get the link again', () => run([item]), { variant: 'ghost', small: true, busy: 'Checking…' }) : null,
        canArchive
          ? toggle('Keep out of inbox', u.silenced, async (on) => {
              await api('/v1/control/subscriptions/update', { method: 'POST', body: { accountId: item.accountId, email: item.email, silence: on } });
              toast(on ? `New mail from ${label(item)} will skip your inbox.` : `Mail from ${label(item)} will reach your inbox again.`, 'success');
            })
          : null,
      );
    };

    const search = input({ type: 'search', placeholder: 'Search senders', value: query, attrs: { 'aria-label': 'Search mailing lists' } });
    let timer = 0;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        query = search.value.trim();
        void draw().then(() => root.querySelector('input[type=search]')?.focus());
      }, 300);
    });
    const selectAll = h('button', { type: 'button', class: 'btn btn-ghost btn-small', on: { click: () => {
      const all = selected.size < active.length;
      for (const box of root.querySelectorAll('.sub-pick input')) box.checked = all;
      selected.clear();
      if (all) for (const item of active) selected.add(keyOf(item));
      syncBulk();
    } } }, 'Select all');
    const archiveBox = checkbox('Also clear them out of my inbox', archive && canArchive, { disabled: !canArchive }, canArchive ? 'Archives what they already sent and keeps their new mail out of your inbox, even if they ignore the unsubscribe.' : 'Allow PigeonBox to organize your mail (Connected accounts) to also archive their mail.');
    archiveBox.querySelector('input').addEventListener('change', (event) => (archive = event.target.checked));

    const recent = active.reduce((sum, item) => sum + item.recent, 0);
    clear(
      root,
      h(
        'div',
        { class: 'stack' },
        note('Tip: in Gmail, just tell Chat “unsubscribe me from Uber Eats, LinkedIn and the Medium digest”.', 'info'),
        surface(
          'ledger',
          {
            title: 'Subscribed',
            meta: active.length ? `${plural(active.length, 'list')}${recent ? ` · ${plural(recent, 'email')} in 30 days` : ''}` : null,
          },
          h('div', { class: 'row tight people-tools' }, search, active.length ? selectAll : null),
          active.length
            ? h('ul', { class: 'list selectable subs' }, active.map(row))
            : emptyState({
                state: 'tea',
                title: query ? 'No mailing list matches.' : left.length ? 'No other mailing lists.' : 'No mailing lists found.',
                text: query ? null : left.length ? 'New ones show up here as they write to you.' : 'Senders with an unsubscribe option show up here as PigeonBox syncs your mail.',
              }),
          active.length ? h('div', { class: 'row' }, archiveBox) : null,
          active.length ? h('div', { class: 'row end' }, bulk) : null,
        ),
        left.length ? surface('ledger', { title: 'Unsubscribed', meta: plural(left.length, 'list') }, h('ul', { class: 'list subs' }, left.map(leftRow))) : null,
      ),
    );
  };

  await draw();
  return root;
}
