import { ago, button, card, checkbox, clear, day, empty, eyebrow, facts, field, h, input, pill, surface, textarea, timeline, toast } from '../ui.js';
import { accountEmails, gmailLink, STATES } from '../shared.js';

const RADAR = [
  ['unansweredImportant', 'Waiting on you'],
  ['promisedFollowUps', 'You promised'],
  ['goingCold', 'Going quiet'],
  ['revived', 'Back in touch'],
  ['upcomingMeetings', 'Meeting soon'],
  ['vipActivity', 'VIP activity'],
];
const WAITING = { on_me: ['Waiting on you', 'warn'], on_them: ['Waiting on them', 'info'], both: ['Both waiting', 'warn'], none: null };

async function brief(contactId, { api, emails, back }) {
  const { brief: b } = await api('/v1/contacts/brief', { method: 'POST', body: { contactId } });
  const c = b.contact;
  const notes = textarea({ value: b.notes, rows: 4, maxLength: 5_000, attrs: { 'aria-label': 'Your notes' } });
  const tags = input({ value: c.tags.join(', '), attrs: { 'aria-label': 'Tags' } });
  const vip = checkbox('VIP', c.vip, {}, 'Mail from VIPs is always treated as important.');
  const commitments = (items, emptyText) =>
    items.length
      ? h('ul', { class: 'list' }, items.map((item) => h('li', {}, h('div', { class: 'list-main' }, h('span', {}, item.text), h('span', { class: 'muted' }, item.dueAt ? `Due ${day(item.dueAt)}` : 'No date')), h('div', { class: 'row tight' }, item.source?.gmailThreadId ? gmailLink('Promise thread', emails.get(item.source.accountId), item.source.gmailThreadId) : null, item.resolution?.source.gmailThreadId ? gmailLink(`Completed ${ago(item.resolution.at)} · view evidence`, emails.get(item.resolution.source.accountId), item.resolution.source.gmailThreadId) : null))))
      : h('p', { class: 'muted' }, emptyText);

  return h(
    'div',
    { class: 'stack' },
    button('← Correspondents', back, { variant: 'ghost' }),
    surface(
      'card',
      {},
      h('header', { class: 'detail-head' }, h('div', {}, eyebrow([c.name ? c.email : null, c.company].filter(Boolean).join(' · ') || 'Contact'), h('h2', {}, c.name || c.email)), c.vip ? pill('VIP', 'good') : null),
      h('p', {}, b.whoTheyAre),
      facts([
        ['You wrote', `${c.sentCount} times`],
        ['They wrote', `${c.receivedCount} times`],
        ['Last contact', c.lastInteractionAt ? ago(c.lastInteractionAt) : 'Never'],
        ['Next meeting', b.nextMeeting ? `${b.nextMeeting.title} · ${day(b.nextMeeting.start)}` : 'None scheduled'],
      ]),
      b.lastDiscussed ? h('p', {}, h('strong', {}, 'Last discussed: '), b.lastDiscussed.text, b.lastDiscussed.source.gmailThreadId ? gmailLink(' · Open conversation', emails.get(b.lastDiscussed.source.accountId), b.lastDiscussed.source.gmailThreadId) : null) : null,
    ),
    h('div', { class: 'grid-2' }, card('You owe them', commitments(b.youOwe, 'Nothing open.')), card('They owe you', commitments(b.theyOwe, 'Nothing open.'))),
    b.recentlyCompleted?.length ? surface('ledger', { title: 'Recently completed', className: 'contact-completed' }, commitments(b.recentlyCompleted, '')) : null,
    b.importantThreads.length
      ? surface('ledger', { title: 'Threads' }, h('ul', { class: 'list' }, b.importantThreads.map((thread) => h('li', {}, h('div', { class: 'list-main' }, gmailLink(thread.subject || '(no subject)', emails.get(thread.accountId), thread.threadId), h('span', { class: 'muted' }, `${STATES[thread.state] ?? thread.state} · ${ago(thread.lastMessageAt)}`))))))
      : null,
    b.signals.length ? surface('ledger', { title: 'Signals' }, h('ul', { class: 'list' }, b.signals.map((signal) => h('li', {}, h('div', { class: 'list-main' }, h('strong', {}, signal.label), h('span', { class: 'muted' }, signal.explanation)))))) : null,
    surface('ledger', { title: 'Timeline' }, b.timeline.length ? timeline(b.timeline.map((entry) => ({ at: entry.at, title: entry.label, tone: entry.kind === 'commitment' ? 'good' : 'neutral', aside: entry.source?.gmailThreadId ? gmailLink('View email', emails.get(entry.source.accountId), entry.source.gmailThreadId) : null }))) : empty('No activity yet.')),
    card(
      'Your notes',
      notes,
      field('Tags (comma-separated)', tags),
      vip,
      h('div', { class: 'row' }, button('Save', async () => {
        await api('/v1/contacts/update', {
          method: 'POST',
          body: { contactId: c.id, notes: notes.value, vip: vip.querySelector('input').checked, tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 20) },
        });
        toast('Saved.', 'success');
      })),
      h('p', { class: 'hint' }, 'Notes are encrypted and only used for your briefs and drafts.'),
    ),
  );
}

export async function render({ api }) {
  const emails = await accountEmails();
  const root = h('div');
  const filters = { query: '', vipOnly: false };
  let listScroll = 0;
  let revision = 0;

  const drawList = async () => {
    const current = ++revision;
    const [radar, first] = await Promise.all([api('/v1/contacts/radar'), api('/v1/contacts/list', { method: 'POST', body: { limit: 50, query: filters.query, vipOnly: filters.vipOnly } })]);
    if (current !== revision) return;
    let contacts = first.contacts;
    let cursor = first.nextCursor;
    const search = input({ value: filters.query, type: 'search', placeholder: 'Search people or companies', attrs: { 'aria-label': 'Search contacts' } });
    const vipOnly = checkbox('VIPs only', filters.vipOnly, { dataset: { noUnsaved: '' } });
    const listEl = h('div');
    const open = async (id) => {
      const token = ++revision;
      listScroll = window.scrollY;
      try {
        const detail = await brief(id, { api, emails, back: async () => {
          await drawList();
          window.scrollTo({ top: listScroll, behavior: 'instant' });
        } });
        if (token !== revision) return;
        clear(root, detail);
        root.querySelector('.back, .btn')?.focus({ preventScroll: true });
      } catch (error) { toast(error?.message || 'Could not load this person. Try again.', 'error'); }
    };
    const drawContacts = (contacts) =>
      clear(
        listEl,
        contacts.length
          ? h(
              'ul',
              { class: 'list selectable' },
              contacts.map((contact) => {
                const waiting = WAITING[contact.waiting];
                return h(
                  'li',
                  {},
                  h('button', { type: 'button', class: 'list-button', on: { click: () => open(contact.id) } }, h('strong', {}, contact.name || contact.email), h('span', { class: 'muted' }, `${contact.company ?? contact.domain} · ${contact.lastInteractionAt ? ago(contact.lastInteractionAt) : 'no contact yet'}`)),
                  h('div', { class: 'chips' }, contact.vip ? pill('VIP', 'good') : null, waiting ? pill(...waiting) : null, contact.openCommitments ? pill(`${contact.openCommitments} open`, 'neutral') : null),
                );
              }),
            )
          : empty('No contacts match.'),
      );
    const more = button('Load more people', async () => {
      if (!cursor) return;
      const token = ++revision;
      const result = await api('/v1/contacts/list', { method: 'POST', body: { limit: 50, cursor, query: filters.query, vipOnly: filters.vipOnly } });
      if (token !== revision) return;
      contacts.push(...result.contacts); cursor = result.nextCursor;
      drawContacts(contacts); more.hidden = !cursor;
    }, { variant: 'ghost' });
    more.hidden = !cursor;
    let timer = 0;
    let searchRevision = 0;
    const query = () => {
      clearTimeout(timer);
      filters.query = search.value.trim(); filters.vipOnly = vipOnly.querySelector('input').checked;
      const token = ++searchRevision;
      timer = setTimeout(async () => {
        const result = await api('/v1/contacts/list', { method: 'POST', body: { limit: 50, ...(search.value.trim() ? { query: search.value.trim() } : {}), ...(vipOnly.querySelector('input').checked ? { vipOnly: true } : {}) } }).catch(() => null);
        if (token !== searchRevision || !listEl.isConnected) return;
        if (result) { contacts = result.contacts; cursor = result.nextCursor; drawContacts(contacts); more.hidden = !cursor; }
        else toast('Search could not load. Try again.', 'error');
      }, 250);
    };
    search.addEventListener('input', query);
    vipOnly.addEventListener('change', query);
    drawContacts(first.contacts);

    const radarCards = RADAR.filter(([id]) => radar[id].length).map(([id, label]) =>
      surface(
        'bin',
        { title: label },
        h(
          'ul',
          { class: 'list' },
          radar[id].slice(0, 5).map((item) =>
            h('li', {}, h('button', { type: 'button', class: 'list-button', on: { click: () => open(item.contact.id) } }, h('strong', {}, item.contact.name || item.contact.email), h('span', { class: 'muted' }, item.reason))),
          ),
        ),
      ),
    );

    clear(
      root,
      h(
        'div',
        { class: 'stack' },
        radarCards.length ? h('div', { class: 'bins contacts-radar' }, radarCards) : null,
        surface('ledger', { title: 'People' }, h('div', { class: 'row tight people-tools' }, search, vipOnly, button('Refresh', drawList, { variant: 'ghost', small: true })), listEl, more),
      ),
    );
  };
  await drawList();
  return root;
}
