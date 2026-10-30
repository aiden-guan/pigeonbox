import { ago, button, clear, confirmDialog, day, emptyState, h, input, link, note, plural, surface, toast, toggle } from '../ui.js';
import { accountEmails, gmailLink } from '../shared.js';

// Memory as pages, the way a notebook or wiki holds it: one page for you, one
// per person, one per topic. Facts are grouped by kind; names of other pages
// become links.

const CATEGORY = {
  people: 'Relationships',
  projects: 'Work & plans',
  classes: 'School',
  logistics: 'Recent context',
  decisions: 'Plans and decisions',
  preferences: 'Preferences',
  other: 'Other',
};
const CATEGORY_ORDER = ['people', 'projects', 'classes', 'decisions', 'preferences', 'logistics', 'other'];
const GROUPS = [
  ['self', 'You'],
  ['person', 'People'],
  ['topic', 'Topics'],
];
const TYPE_LABEL = { self: 'About you', person: 'Person', topic: 'Topic' };
const UNSORTED = 'unsorted';

export async function render({ api }) {
  const root = h('div', { class: 'stack memory-view' });
  const state = { subjects: [], organizing: false, active: null, query: '', history: false };
  const emails = await accountEmails();
  const index = h('nav', { class: 'brain-index', attrs: { 'aria-label': 'Memory pages' } });
  const page = h('article', { class: 'brain-page', attrs: { 'aria-live': 'polite', tabindex: '-1' } });
  const filter = input({ type: 'search', placeholder: 'Find a page or search facts', maxLength: 500, attrs: { 'aria-label': 'Find a page or search facts' } });
  let revision = 0;
  const expanded = new Set();
  let conversation = [];
  let chatRevision = 0;
  let chatting = false;
  const response = h('div', { class: 'memory-response', attrs: { 'aria-live': 'polite' } });
  const message = h('textarea', { class: 'input', rows: 2, maxLength: 10_000, placeholder: 'Ask, paste context, or update…', attrs: { 'aria-label': 'Ask or update memory' } });
  const send = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send');
  const chat = h('form', { class: 'memory-chat', on: { submit: async (event) => {
    event.preventDefault();
    const text = message.value.trim();
    if (!text || chatting) return;
    const subject = state.active && state.active !== UNSORTED ? state.active : undefined;
    const currentChat = chatRevision;
    chatting = true;
    send.disabled = true;
    send.textContent = 'Thinking…';
    chat.dataset.working = 'true';
    message.readOnly = true;
    response.setAttribute('aria-busy', 'true');
    try {
      const historyText = text.length <= 2_000 ? text : '[A long profile or notes paste was submitted and processed.]';
      const result = await api('/v1/memory/chat', { method: 'POST', body: { message: text, subject, history: conversation.slice(-8) } });
      if (currentChat !== chatRevision || !root.isConnected) {
        if (result.changes.length) { toast(result.answer, 'success'); if (root.isConnected) await refresh(); }
        return;
      }
      conversation.push({ role: 'user', text: historyText }, { role: 'assistant', text: result.answer });
      conversation = conversation.slice(-8);
      message.value = '';
      clear(response, h('p', { class: 'memory-question' }, text.length > 500 ? `${text.slice(0, 500)}…` : text), h('p', { class: 'memory-answer' }, result.answer),
        result.changes.length ? h('details', { class: 'memory-used' }, h('summary', {}, 'Saved changes'), h('ul', { class: 'memory-change-list' }, result.changes.map(change => h('li', {}, h('strong', {}, `${change.kind}: `), change.text))))
        : result.memories.length ? h('details', { class: 'memory-used' }, h('summary', {}, 'Memories used'), h('ul', { class: 'brain-facts' }, result.memories.map((memory) => drawFact(memory)))) : null);
      if (result.changes.length) await refreshAfterChange();
    } catch (error) {
      if (currentChat === chatRevision && root.isConnected) clear(response, note(error?.message || 'Could not answer. Your message is still here; try again.', 'error'));
    } finally {
      chatting = false;
      send.disabled = false;
      send.textContent = 'Send';
      message.readOnly = false;
      response.removeAttribute('aria-busy');
      delete chat.dataset.working;
      if (currentChat === chatRevision && root.isConnected && (document.activeElement === send || document.activeElement === message)) message.focus({ preventScroll: true });
    }
  } } }, h('label', { class: 'eyebrow', attrs: { for: 'memory-message' } }, 'Ask or update memory'),
  h('p', { class: 'hint' }, 'Ask what Pidgy knows, or paste a profile, notes, or update. Pidgy saves lasting details automatically and skips questions, one-off details, and anything you say not to save.'), response,
  h('div', { class: 'memory-prompts' }, ['What do you remember about me?', 'What are my current plans?', 'Remember: '].map(prompt => h('button', { type: 'button', class: 'memory-prompt', on: { click: () => { if (!chatting) { message.value = prompt; message.focus({ preventScroll: true }); } } } }, prompt === 'Remember: ' ? '+ Add a lasting detail' : prompt))),
  h('div', { class: 'memory-composer' }, message, send), h('p', { class: 'memory-keyboard hint' }, 'Enter to send · Shift + Enter for a new line'));
  message.id = 'memory-message';
  message.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); chat.requestSubmit(); }
  });

  // ---- Index ---------------------------------------------------------------

  const drawIndex = () => {
    const term = filter.value.trim().toLowerCase();
    const shown = state.subjects.filter((subject) => !term || subject.label.toLowerCase().includes(term));
    const entry = (id, label, count) =>
      h(
        'li',
        {},
        h(
          'button',
          { type: 'button', class: ['bi-item', state.active === id && 'is-active'], attrs: { 'aria-current': state.active === id ? 'page' : null }, on: { click: () => open(id) } },
          h('span', { class: 'bi-label' }, label),
          h('span', { class: 'bi-count', attrs: { 'aria-label': plural(count, 'fact') } }, String(count)),
        ),
      );
    clear(
      index,
      GROUPS.map(([type, heading]) => {
        const items = shown.filter((subject) => subject.type === type);
        if (!items.length) return null;
        return h(
          'section',
          { class: 'bi-group' },
          h('h3', { class: 'bi-heading' }, heading, type !== 'self' ? h('span', {}, String(items.length)) : null),
          h(
            'ul',
            {},
            items.map((subject) => entry(subject.id, subject.label, subject.factCount)),
          ),
        );
      }),
      state.organizing && !term
        ? h('section', { class: 'bi-group' }, h('h3', { class: 'bi-heading' }, 'Being organized'), h('ul', {}, entry(UNSORTED, 'Older memories', '…')))
        : null,
      term
        ? h(
            'button',
            { type: 'submit', class: 'bi-search' },
            h('span', { attrs: { 'aria-hidden': 'true' } }, '↵'),
            ` Search every fact for “${filter.value.trim().slice(0, 60)}”`,
          )
        : null,
      !shown.length && !term && !state.organizing ? h('p', { class: 'hint' }, 'Pages appear as Pidgy learns from your mail.') : null,
    );
  };

  // ---- Text with links to other pages ---------------------------------------

  /** Mentions of other pages' names become links, like wiki links. Text stays text. */
  const linked = (text, self) => {
    const names = state.subjects
      .filter((subject) => subject.id !== self && subject.type !== 'self' && subject.label.length >= 4 && !subject.label.includes('@'))
      .sort((a, b) => b.label.length - a.label.length);
    if (!names.length) return [text];
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b(${names.map((subject) => escape(subject.label)).join('|')})\\b`, 'g');
    const out = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const subject = names.find((candidate) => candidate.label === match[0]);
      out.push(text.slice(last, match.index));
      out.push(h('button', { type: 'button', class: 'wikilink', on: { click: () => open(subject.id) } }, match[0]));
      last = match.index + match[0].length;
    }
    out.push(text.slice(last));
    return out;
  };

  // ---- One fact -------------------------------------------------------------

  const drawFact = (memory, { showPage = false } = {}) => {
    const item = h('li', { class: ['fact', memory.status !== 'active' && 'is-history'], dataset: { memoryId: memory.id } });
    const expired = memory.validUntil && Date.parse(memory.validUntil) <= Date.now();
    const text = h('p', { class: 'fact-text' }, linked(memory.text, memory.subject?.id));
    const correction = h('textarea', { class: 'input', value: memory.text, required: true, minLength: 10, maxLength: 600, rows: 2, attrs: { 'aria-label': 'Correct this fact' } });
    const editor = h(
      'div',
      { class: 'fact-editor', hidden: true },
      correction,
      h(
        'div',
        { class: 'row tight' },
        button('Save', async () => {
          const value = correction.value.trim();
          if (value.length < 10) throw new Error('Use at least 10 characters for a clear fact.');
          const { memory: updated } = await api('/v1/memory/update', { method: 'POST', body: { memoryId: memory.id, text: value } });
          item.replaceWith(drawFact(updated, { showPage }));
          page.querySelector('.bp-summary')?.remove();
          chatRevision += 1; conversation = []; clear(response, h('p', { class: 'memory-answer' }, 'Correction saved. Pidgy will use your wording.'));
          toast('Saved. Pidgy will use your wording from now on.', 'success');
          await refreshAfterChange();
        }, { small: true }),
        button('Cancel', () => {
          editor.hidden = true;
          text.hidden = false;
        }, { variant: 'ghost', small: true }),
      ),
    );
    const sourceCount = memory.sources.length;
    const sources = h(
      'details',
      { class: 'fact-sources' },
      h(
        'summary',
        {},
        !sourceCount ? 'Saved by you' : memory.corrected ? 'Your wording' : `From ${plural(sourceCount, 'email')}`,
        ' · ',
        memory.status !== 'active' ? 'replaced' : expired ? `expired ${day(memory.validUntil)}` : memory.validUntil ? `until ${day(memory.validUntil)}` : `confirmed ${ago(memory.lastConfirmedAt)}`,
      ),
      h(
        'ul',
        {},
        memory.sources.map((source) => h('li', {}, source.gmailThreadId && emails.has(source.accountId) ? gmailLink(source.title, emails.get(source.accountId), source.gmailThreadId) : `“${source.title}”`, source.at ? h('span', { class: 'hint' }, ` · ${day(source.at)}`) : null)),
        !sourceCount ? h('li', { class: 'hint' }, 'Saved directly in your memory. No email source.') : null,
      ),
    );
    const actions =
      memory.status === 'active'
        ? h(
            'div',
            { class: 'fact-actions' },
            button('Edit', () => {
              editor.hidden = false;
              text.hidden = true;
              correction.focus({ preventScroll: true });
            }, { variant: 'ghost', small: true, title: 'Correct this fact' }),
            button('Forget', async () => {
              await api('/v1/memory/forget', { method: 'POST', body: { memoryId: memory.id } });
              root.querySelectorAll(`.fact[data-memory-id="${memory.id}"]`).forEach(fact => fact.remove());
              chatRevision += 1; conversation = []; clear(response, h('p', { class: 'memory-answer' }, 'Forgotten. This fact is no longer in your memory.'));
              const subject = state.subjects.find((value) => value.id === memory.subject?.id);
              if (subject) {
                subject.factCount -= 1;
                // The overview named this fact; it is withheld until rewritten.
                subject.summary = null;
                page.querySelector('.bp-summary')?.remove();
                if (subject.factCount <= 0) state.subjects = state.subjects.filter((value) => value !== subject);
                drawIndex();
              }
              toast('Forgotten. Gmail is unchanged.', 'success');
              await refreshAfterChange();
            }, { variant: 'danger-ghost', small: true, title: 'Forget this fact' }),
          )
        : null;
    return clear(
      item,
      showPage && memory.subject
        ? h('button', { type: 'button', class: 'fact-page', on: { click: () => open(memory.subject.id) } }, memory.subject.label)
        : null,
      text,
      editor,
      h('div', { class: 'fact-meta' }, sources, actions),
    );
  };

  const grouped = (memories, options) => {
    const byCategory = new Map();
    for (const memory of memories) byCategory.set(memory.category, [...(byCategory.get(memory.category) ?? []), memory]);
    return CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => {
      const key = `${state.active}:${category}`;
      const items = byCategory.get(category);
      return h('details', { class: 'fact-group', open: expanded.has(key), on: { toggle: (event) => {
        if (event.target.open) expanded.add(key); else expanded.delete(key);
      } } }, h('summary', {}, h('span', {}, CATEGORY[category] ?? category), h('span', { class: 'hint' }, plural(items.length, 'memory', 'memories'))),
      h('ul', { class: 'brain-facts' }, items.map((memory) => drawFact(memory, options))));
    });
  };

  // ---- Pages ----------------------------------------------------------------

  async function fetchAll(body) {
    return api('/v1/memory/list', { method: 'POST', body: { ...body, limit: 50 } });
  }

  function more(body, result, redraw) {
    return result.nextCursor ? button('Load more memories', async () => {
      const current = revision;
      const next = await api('/v1/memory/list', { method: 'POST', body: { ...body, cursor: result.nextCursor, limit: 50 } });
      if (current !== revision || !root.isConnected) return;
      result.memories.push(...next.memories);
      result.nextCursor = next.nextCursor;
      redraw();
    }, { variant: 'ghost', small: true }) : null;
  }

  async function open(id, preserveConversation = false) {
    if (state.active !== id && !preserveConversation) { chatRevision += 1; conversation = []; message.value = ''; clear(response); }
    state.active = id;
    state.query = '';
    drawIndex();
    const current = ++revision;
    page.setAttribute('aria-busy', 'true');
    try {
      if (id === UNSORTED) {
        const result = await fetchAll({});
        if (current !== revision) return;
        const redraw = () => { const memories = result.memories.filter(memory => !memory.subject); clear(
          page,
          h('header', { class: 'bp-head' }, h('p', { class: 'eyebrow' }, 'Being organized'), h('h2', {}, 'Older memories')),
          note('Pidgy is filing these into pages and merging repeats. This happens in the background and usually takes a few minutes.'),
          memories.length ? h('ul', { class: 'brain-facts' }, memories.map((memory) => drawFact(memory))) : h('p', { class: 'hint' }, 'All filed.'),
          more({}, result, redraw),
        ); }; redraw();
        return;
      }
      const subject = state.subjects.find((value) => value.id === id);
      if (!subject) return;
      const body = { subject: id, includeHistory: state.history };
      const result = await fetchAll(body);
      if (current !== revision) return;
      const redraw = () => { const memories = result.memories;
      const active = memories.filter((memory) => memory.status === 'active');
      const history = memories.filter((memory) => memory.status !== 'active');
      const historyToggle = h('label', { class: 'bp-history', dataset: { noUnsaved: '' } }, h('input', { type: 'checkbox', checked: state.history, on: { change: (event) => { state.history = event.target.checked; open(id); } } }), 'Show replaced facts');
      clear(
        page,
        h(
          'header',
          { class: 'bp-head' },
          h('p', { class: 'eyebrow' }, TYPE_LABEL[subject.type], ' · ', plural(subject.factCount, 'fact'), ' · ', `updated ${ago(subject.lastConfirmedAt)}`),
          h('h2', {}, subject.type === 'self' ? 'You' : subject.label),
        ),
        subject.summary ? h('p', { class: 'bp-summary' }, linked(subject.summary, subject.id)) : null,
        active.length ? grouped(active) : h('p', { class: 'hint' }, 'Nothing current on this page.'),
        history.length ? h('section', { class: 'fact-group' }, h('h4', {}, 'Replaced'), h('ul', { class: 'brain-facts' }, history.map((memory) => drawFact(memory)))) : null,
        more(body, result, redraw), h('footer', { class: 'bp-foot' }, historyToggle),
      ); }; redraw();
    } catch (error) {
      if (current === revision) clear(page, note(error?.message || 'Could not load this page.', 'error'), button('Try again', () => open(id, true), { variant: 'ghost' }));
    } finally {
      if (current === revision) page.removeAttribute('aria-busy');
    }
  }

  async function search(preserveConversation = false) {
    const query = filter.value.trim();
    if (!query) return;
    if (!preserveConversation) { chatRevision += 1; conversation = []; clear(response); }
    state.active = null;
    state.query = query;
    drawIndex();
    const current = ++revision;
    page.setAttribute('aria-busy', 'true');
    try {
      const result = await api('/v1/memory/list', { method: 'POST', body: { query, limit: 30 } });
      if (current !== revision) return;
      const redraw = () => { const { memories } = result; clear(
        page,
        h('header', { class: 'bp-head' }, h('p', { class: 'eyebrow' }, 'Search'), h('h2', {}, `“${query.slice(0, 80)}”`)),
        memories.length ? h('ul', { class: 'brain-facts' }, memories.map((memory) => drawFact(memory, { showPage: true }))) : h('p', { class: 'hint' }, result.nextCursor ? 'No matches in this batch. Load more to keep searching.' : 'Nothing remembered matches that.'),
        more({ query }, result, redraw),
      ); }; redraw();
    } catch (error) {
      if (current === revision) clear(page, note(error?.message || 'Could not search memory.', 'error'), button('Try again', () => search(true), { variant: 'ghost' }));
    } finally {
      if (current === revision) page.removeAttribute('aria-busy');
    }
  }

  async function refresh() {
    const result = await api('/v1/memory/subjects', { method: 'POST', body: {} });
    state.subjects = result.subjects;
    state.organizing = result.organizing;
    drawIndex();
    if (state.query) { await search(true); return; }
    const keep = state.active && (state.active === UNSORTED ? state.organizing : state.subjects.some((subject) => subject.id === state.active));
    const first = keep ? state.active : state.subjects[0]?.id ?? (state.organizing ? UNSORTED : null);
    if (first) await open(first, true);
    else {
      state.active = null;
      clear(
        page,
        emptyState({ state: 'map', title: 'Nothing remembered yet', text: 'As connected mail is analyzed, Pidgy keeps a page about you and the people and projects you write about.', level: 'h3' }),
      );
    }
  }

  async function refreshAfterChange() {
    try { await refresh(); }
    catch { toast('Your change is saved. Refresh this page to reload the memory list.', 'info'); }
  }

  filter.addEventListener('input', drawIndex);

  // ---- Settings -------------------------------------------------------------

  const { preferences } = await api('/v1/preferences');
  const settings = Object.entries({
    enabled: 'Learn useful personal context',
    learnFromReceivedMail: 'Learn facts from received mail',
    learnFromSentMail: 'Learn facts and writing structure from sent mail',
    learnFromDraftEdits: 'Learn writing structure from my draft edits',
  }).map(([key, label]) =>
    toggle(label, preferences.memory[key], async (on) => {
      await api('/v1/preferences/update', { method: 'POST', body: { preferences: { memory: { [key]: on } } } });
      toast('Memory preferences saved.', 'success');
    }),
  );
  // Separate from learning: checks a short phrase while you write, and never turns it into a memory.
  settings.push(
    toggle(
      'Smart autofill',
      preferences.memory.smartComposeCompletion === true,
      async (on) => {
        await api('/v1/preferences/update', { method: 'POST', body: { preferences: { memory: { smartComposeCompletion: on } } } });
        toast(on ? 'Smart autofill is on.' : 'Smart autofill is off.', 'success');
      },
      'Suggests a short continuation from your Brain and conversation as you type. Tab accepts; Escape dismisses. Only the current phrase is processed, never saved.',
    ),
    toggle(
      'Real-time Pidgy checks',
      preferences.memory.realtimeComposeChecks === true,
      async (on) => {
        await api('/v1/preferences/update', { method: 'POST', body: { preferences: { memory: { realtimeComposeChecks: on } } } });
        toast(on ? 'Real-time Pidgy checks are on.' : 'Real-time Pidgy checks are off.', 'success');
      },
      'While you write, Pidgy can privately check a short relevant phrase against your calendar and Brain. Draft text used for a check is processed ephemerally and is not saved as a memory.',
    ),
  );

  clear(
    root,
    surface(
      'ledger',
      { className: 'brain' },
      h(
        'div',
        { class: 'brain-grid' },
        h(
          'aside',
          { class: 'brain-side' },
          h(
            'form',
            {
              class: 'brain-find',
              attrs: { role: 'search' },
              on: {
                submit: (event) => {
                  event.preventDefault();
                  search();
                },
              },
            },
            filter,
          ),
          index,
        ),
        h('div', { class: 'brain-reader' }, page, chat),
      ),
    ),
    h(
      'div',
      { class: 'grid-2' },
      surface(
        'card',
        { eyebrow: 'Learning', title: 'Personal context' },
        h('p', { class: 'muted' }, 'Pidgy keeps durable, useful facts from your mail, merges repeats, and writes a short overview for each page. Everything is encrypted on your server and can be wrong. Original email stays in Gmail.'),
        h('div', { class: 'toggles' }, settings),
        h('p', { class: 'hint' }, 'Turning learning off keeps saved facts available. Use Forget all to erase them.'),
        h('p', { class: 'hint' }, `Fast Recall is ${preferences.fastRecall.enabled ? 'on' : 'off'}. Its optional encrypted excerpts are managed separately. `, link('Manage Fast Recall', '#privacy')),
      ),
      surface(
        'card',
        { eyebrow: 'Cannot be undone', title: 'Forget everything', className: 'danger-zone' },
        h('p', { class: 'muted' }, 'Erase all personal facts, pages, entity links, source references and their search data. Contacts, writing profiles and Fast Recall are managed separately. Gmail and your account stay connected.'),
        h(
          'div',
          { class: 'row' },
          button(
            'Forget all memories…',
            async () => {
              if (
                !(await confirmDialog({
                  title: 'Forget all memories?',
                  body: ['This cannot be undone. Learning resumes with future mail.'],
                  typed: 'forget all memories',
                  confirm: 'Forget all memories',
                  danger: true,
                }))
              )
                return;
              await api('/v1/memory/purge', { method: 'POST', body: { confirm: 'forget all memories' } });
              state.active = null;
              chatRevision += 1; conversation = []; clear(response);
              await refresh();
              toast('All personal memories forgotten.', 'success');
            },
            { variant: 'danger-ghost' },
          ),
        ),
      ),
    ),
  );
  await refresh();
  return root;
}
