// Small DOM toolkit for the control plane. Everything user- or mail-derived is
// set as text (never HTML), so nothing from an email can run in this page.
//
// Visual primitives follow the Dispatch design system: sheets, slips,
// ledgers, parcels and notices instead of one generic card (see control.css).

const SAFE_HREF = /^(?:\/(?!\/)|https:\/\/|mailto:|#[a-z][a-z0-9/-]*$)/i;

/**
 * h('button', { class: 'x', on: { click } }, 'Label', child, [more])
 * Props: class, text, on, attrs (any attribute), dataset, and common
 * properties (id, type, value, checked, disabled, hidden, name, placeholder…).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) el.addEventListener(event, handler);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'attrs') for (const [name, attr] of Object.entries(value)) attr !== undefined && attr !== null && attr !== false && el.setAttribute(name, attr === true ? '' : String(attr));
    else if (key === 'href') el.setAttribute('href', SAFE_HREF.test(String(value)) ? String(value) : '#');
    else if (key in el) el[key] = value;
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function ago(iso) {
  if (!iso) return '—';
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const units = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return Math.abs(seconds) < 45 ? 'just now' : relative.format(Math.round(seconds / 60), 'minute');
}

export function when(iso, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  return iso ? new Intl.DateTimeFormat(undefined, options).format(new Date(iso)) : '—';
}

export const day = (iso) => when(iso, { dateStyle: 'medium' });
export const clock = (iso) => when(iso, { timeStyle: 'short' });
export const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;
export const humanize = (value) => String(value ?? '').replace(/_/g, ' ');
export const key = () => crypto.randomUUID();

/** Postmark-style date, e.g. "OCT 03 2026". */
export function postmarkDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).format(date).toUpperCase().replace(',', '');
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

let toastRoot = null;
// Set when a confirmation was declined, so the button that asked shows no success mark.
let declined = false;
const TOAST_MARK = { success: 'Done', error: 'Problem', warn: 'Held', info: 'Notice' };

/** A compact dispatch notice. The mark is decoration; the message is the text. */
export function toast(message, tone = 'info') {
  toastRoot ??= document.getElementById('toasts');
  if (!toastRoot) return;
  const item = h(
    'div',
    { class: ['toast', `toast-${tone}`], attrs: { role: tone === 'error' ? 'alert' : 'status' } },
    h('span', { class: 'toast-mark', attrs: { 'aria-hidden': 'true' } }, TOAST_MARK[tone] ?? TOAST_MARK.info),
    h('span', { class: 'toast-msg' }, message),
  );
  toastRoot.append(item);
  while (toastRoot.children.length > 4) toastRoot.firstElementChild.remove();
  let leave = 0;
  const schedule = (ms) => {
    clearTimeout(leave);
    leave = setTimeout(() => {
      item.classList.add('leaving');
      setTimeout(() => item.remove(), 220);
    }, ms);
  };
  // Hovering a notice holds it, so it can be read to the end.
  item.addEventListener('pointerenter', () => clearTimeout(leave));
  item.addEventListener('pointerleave', () => schedule(1_600));
  schedule(tone === 'error' ? 6_500 : 4_200);
}

/**
 * A button that runs an async action, shows progress, and reports failures.
 * `saves` (default: labels starting “Save”) marks it as the Save for the
 * edits around it; see Unsaved edits below.
 */
export function button(label, action, { variant = 'primary', busy = 'Working…', title, disabled = false, small = false, saves = /^Save\b/.test(label) } = {}) {
  const el = h('button', { type: 'button', class: ['btn', `btn-${variant}`, small && 'btn-small'], title, disabled, dataset: saves ? { saves: '' } : null }, label);
  el.addEventListener('click', async (event) => {
    event.preventDefault();
    if (el.disabled) return;
    const saving = saves ? editsSavedBy(el) : [];
    const original = el.textContent;
    el.disabled = true;
    el.classList.remove('is-done');
    el.setAttribute('aria-busy', 'true');
    el.textContent = busy;
    let ok = false;
    declined = false;
    try {
      await action(event);
      ok = !declined;
      if (ok) for (const control of saving) edits.delete(control);
    } catch (error) {
      toast(error?.message || 'Something went wrong.', 'error');
    } finally {
      if (el.isConnected) {
        el.disabled = false;
        el.removeAttribute('aria-busy');
        el.textContent = original;
        // A finished action leaves a brief check where it happened.
        if (ok) {
          el.classList.add('is-done');
          setTimeout(() => el.classList.remove('is-done'), 1_400);
        }
      }
    }
  });
  return el;
}

export function link(label, href, props = {}) {
  return h('a', { href, ...props }, label);
}

/** An editorial text link with a mono arrow. */
export function arrowLink(label, href, props = {}) {
  return h('a', { href, class: 'text-link', ...props }, label, h('span', { class: 'arr', attrs: { 'aria-hidden': 'true' } }, '→'));
}

/** A status mark: a dot and mono label. Tone carries meaning in colour and shape, the text carries it in words. */
export function pill(text, tone = 'neutral') {
  return h('span', { class: ['pill', `pill-${tone}`] }, text);
}

export function tag(text, tone = null) {
  return h('span', { class: ['tag', tone && `tag-${tone}`] }, text);
}

export function chips(values, tone = 'neutral') {
  return h('div', { class: 'chips' }, values.map((value) => tag(humanize(value), tone === 'neutral' ? null : tone)));
}

export function eyebrow(...parts) {
  return h('p', { class: 'eyebrow' }, parts);
}

/** Pidgy, the courier. Decorative: the state is always also said in text nearby. */
export function pidgy(state = 'idle', { size = null, still = false } = {}) {
  return h('span', { class: ['pidgy', size && `pidgy-${size}`], dataset: { state, ...(still ? { still: '' } : {}) }, attrs: { 'aria-hidden': 'true' } });
}

/** A postage stamp, for finished things. Decorative. */
export function stamp(text, small = '') {
  return h('span', { class: 'stamp', attrs: { 'aria-hidden': 'true' } }, text, small ? h('small', {}, small) : null);
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * A surface of one archetype: 'card' (sheet), 'slip', 'ledger', 'parcel' or 'stub'.
 * With only a title, the heading is the first child; with an eyebrow, meta or
 * actions, a header row holds them.
 */
export function surface(kind, { title = null, eyebrow: label = null, meta = null, actions = null, tag: tagName = 'section', className = null, level = 'h2', href = null } = {}, ...children) {
  const heading = title ? h(level, {}, title) : null;
  const rich = label || meta || (actions && [actions].flat().filter(Boolean).length);
  const head = rich
    ? h(
        'header',
        { class: 'surface-head' },
        h('div', {}, label ? eyebrow(label) : null, heading, meta ? h('p', { class: 'muted' }, meta) : null),
        actions ? h('div', { class: 'row tight' }, actions) : null,
      )
    : heading;
  return h(href ? 'a' : tagName, { class: [kind, className], href }, head, ...children);
}

export function card(title, ...children) {
  return surface('card', { title }, ...children);
}

export function slip(title, ...children) {
  return surface('slip', { title }, ...children);
}

export function ledger(title, ...children) {
  return surface('ledger', { title }, ...children);
}

/** Compact empty: a quiet slip with Pidgy waiting. */
export function empty(text, ...actions) {
  return h('div', { class: 'empty' }, pidgy('tea', { size: 'sm' }), h('p', {}, text), actions.length ? h('div', { class: 'row' }, actions) : null);
}

/** A page-level empty state with an editorial headline. */
export function emptyState({ state = 'tea', title, text = null, actions = [], level = 'h2' }) {
  return h('div', { class: 'empty-state' }, pidgy(state, { size: 'lg' }), h(level, {}, title), text ? h('p', {}, text) : null, actions.length ? h('div', { class: 'row' }, actions) : null);
}

const NOTE_MARK = { info: 'Note', success: 'Done', warn: 'Attention', error: 'Problem' };

export function note(text, tone = 'info') {
  return h(
    'div',
    { class: ['note', `note-${tone}`], attrs: { role: tone === 'error' ? 'alert' : null } },
    h('span', { class: 'note-mark', attrs: { 'aria-hidden': 'true' } }, NOTE_MARK[tone] ?? NOTE_MARK.info),
    h('p', { class: 'note-text' }, text),
  );
}

/** A postal notice: something on this account needs a person. */
export function notice({ tone = 'warn', label, title, text = null, state = 'alert', actions = [] }) {
  return h(
    'div',
    { class: ['notice', `notice-${tone}`], attrs: { role: tone === 'bad' ? 'alert' : null } },
    pidgy(state, { size: 'sm' }),
    h('div', { class: 'notice-copy' }, label ? eyebrow(label) : null, h('strong', {}, title), text ? h('p', {}, text) : null),
    actions.length ? h('div', { class: 'row' }, actions) : null,
  );
}

/** Status phrase for a masthead. Only ever derived from real state. */
export function dispatchStatus({ tone = 'good', label, phrase, detail = null, state = 'idle' }) {
  return h(
    'div',
    { class: 'dispatch-status', dataset: { tone }, attrs: { role: 'status' } },
    pidgy(state),
    eyebrow(label),
    h('p', { class: 'ds-phrase' }, phrase),
    detail ? h('p', { class: 'ds-detail' }, detail) : null,
  );
}

export function loading(text = 'Loading…') {
  return h(
    'div',
    { class: 'loading', attrs: { role: 'status' } },
    h('span', { class: 'sr-only' }, text),
    h('span', { class: 'skel skel-line', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'skel skel-short', attrs: { 'aria-hidden': 'true' } }),
  );
}

/** Whole-page skeleton. Pidgy appears only if loading takes a while. */
export function pageLoading(text = 'Loading…') {
  const bar = (className) => h('span', { class: ['skel', className], attrs: { 'aria-hidden': 'true' } });
  return h(
    'div',
    { class: 'loading loading-page', attrs: { role: 'status' } },
    h('span', { class: 'sr-only' }, text),
    h('div', { class: 'loading-head', attrs: { 'aria-hidden': 'true' } }, bar(), bar('skel-title'), bar('skel-line')),
    bar('skel-block'),
    h('div', { class: 'grid-2', attrs: { 'aria-hidden': 'true' } }, bar('skel-block'), bar('skel-block')),
    h('p', { class: 'loading-bird', attrs: { 'aria-hidden': 'true' } }, pidgy('search', { size: 'sm' }), 'Sorting the mail'),
  );
}

export function stat(label, value, detail, href) {
  const body = [h('span', { class: 'stat-label' }, label), h('strong', { class: 'stat-value' }, value), detail ? h('span', { class: 'stat-detail' }, detail) : null];
  return href ? h('a', { class: 'stat', href }, body) : h('div', { class: 'stat' }, body);
}

/**
 * Server AI usage as one bar: the share of this month's allowance used
 * (`usage.aiMonthlyUsed`, from the server), never token counts or prices. A
 * note appears only when today's request cap is nearly reached.
 */
export function usageMeter(usage, limits, now = new Date()) {
  if (!usage) return null;
  const share = Math.min(1, Math.max(0, usage.aiMonthlyUsed ?? 0));
  const percent = Math.round(share * 100);
  const daily = limits.aiRequestsPerDay ? (usage?.aiRequestsToday ?? 0) / limits.aiRequestsPerDay : 0;
  const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const fill = h('span', { class: 'meter-fill' });
  fill.style.setProperty('--v', String(share));
  const detail = daily >= 1
    ? 'You have reached today’s AI limit on this server. It resets tomorrow.'
    : daily >= 0.8
      ? 'You are close to today’s limit. It resets tomorrow.'
      : `Resets ${resets.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}.`;
  const tone = Math.max(share, daily) >= 0.95 ? 'bad' : Math.max(share, daily) >= 0.8 ? 'warn' : 'ok';
  return h(
    'div',
    { class: 'meter', dataset: { tone } },
    h('div', { class: 'meter-head' }, h('span', { class: 'stat-label' }, 'AI this month'), h('b', {}, `${percent}% used`)),
    h('div', { class: 'meter-track', attrs: { role: 'meter', 'aria-label': 'AI used this month', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent, 'aria-valuetext': `${percent}% used` } }, fill),
    h('p', { class: 'meter-note' }, detail),
  );
}

/**
 * A route of stages. `stops` is [{ label, value, detail, state, href }] with
 * state 'done' | 'active' | 'warn' | 'bad' | 'idle'.
 */
export function routeStrip(stops, { label = 'Route' } = {}) {
  const list = h(
    'ol',
    { class: 'route-strip', attrs: { 'aria-label': label } },
    stops.map((stop, index) =>
      h(
        'li',
        { class: 'route-stop', dataset: { state: stop.state ?? 'idle' } },
        h('span', { class: 'route-dot', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'n' }, h('b', {}, String(index + 1).padStart(2, '0')), stop.label),
        stop.href ? h('a', { href: stop.href, class: 'rs-value' }, h('strong', {}, stop.value)) : h('strong', {}, stop.value),
        stop.detail ? h('span', { class: 'rs-detail' }, stop.detail) : null,
      ),
    ),
  );
  list.style.setProperty('--cols', String(stops.length));
  return list;
}

/**
 * The dispatch log. `items` is [{ at, title, meta, tone, aside }]. Grouped
 * under day rules when `days` is set.
 */
export function timeline(items, { days = true } = {}) {
  const rows = [];
  let lastDay = '';
  for (const item of items) {
    const label = day(item.at);
    if (days && label !== lastDay) {
      rows.push(h('li', { class: 'tl-day', attrs: { role: 'presentation' } }, label));
      lastDay = label;
    }
    rows.push(
      h(
        'li',
        {},
        h('time', { dateTime: item.at, title: when(item.at) }, days ? clock(item.at) : when(item.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
        h('span', { class: 'tl-mark', dataset: { tone: item.tone ?? 'neutral' }, attrs: { 'aria-hidden': 'true' } }),
        h('div', { class: 'tl-body' }, h('strong', {}, item.title), item.meta ? h('span', { class: 'muted' }, item.meta) : null),
        item.aside ? h('div', { class: 'tl-aside' }, item.aside) : null,
      ),
    );
  }
  return h('ul', { class: 'timeline' }, rows);
}

/** A directory of destinations: numbered, ruled, with an arrow. */
export function index(items) {
  return h(
    'ul',
    { class: 'index' },
    items.map(([title, detail, href], position) =>
      h(
        'li',
        {},
        h(
          'a',
          /^https?:/.test(href) ? { href, target: '_blank', rel: 'noopener' } : { href },
          h('span', { class: 'n', attrs: { 'aria-hidden': 'true' } }, String(position + 1).padStart(2, '0')),
          h('span', {}, h('strong', {}, title), detail ? h('small', {}, detail) : null),
          h('span', { class: 'arr', attrs: { 'aria-hidden': 'true' } }, '→'),
        ),
      ),
    ),
  );
}

export function table(columns, rows, { emptyText = 'Nothing yet.', stack = true } = {}) {
  if (!rows.length) return empty(emptyText);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: stack ? 'stack-sm' : null },
      h('thead', {}, h('tr', {}, columns.map((column) => h('th', { attrs: { scope: 'col' }, class: column.numeric ? 'num' : null }, column.label)))),
      h('tbody', {}, rows.map((row) => h('tr', {}, columns.map((column) => h('td', { class: column.numeric ? 'num' : null, dataset: column.label ? { col: column.label } : {} }, column.render(row)))))),
    ),
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

let fieldId = 0;

export function field(label, control, hint) {
  // A composite control (like combobox) names the element its label points at.
  const target = control.labelTarget ?? control;
  const id = target.id || `f${(fieldId += 1)}`;
  target.id = id;
  const help = hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null;
  if (help) target.setAttribute('aria-describedby', help.id);
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, help);
}

export function input(props = {}) {
  return h('input', { type: 'text', class: 'input', ...props });
}

export function textarea(props = {}) {
  return h('textarea', { class: 'input', rows: 4, ...props });
}

export function select(options, value, props = {}) {
  return h(
    'select',
    { class: 'input', ...props },
    options.map(([optionValue, label]) => h('option', { value: optionValue, selected: String(optionValue) === String(value) }, label)),
  );
}

/**
 * A text box with a filtered list under it: type to narrow, arrows and Enter
 * or a click to pick. `options` are [value, label, extra?] where `extra` is
 * shown dimmed and also searched. Only listed values can be chosen; leaving
 * the box with other text puts the current choice back. Read and set the
 * choice with `.value`; a pick fires `change` on the returned element.
 */
export function combobox(options, value, { placeholder = 'Type to search', empty: emptyText = 'No matches.' } = {}) {
  const listId = `cb${(fieldId += 1)}`;
  const text = h('input', {
    type: 'text', class: 'input combo-input', placeholder, autocomplete: 'off', spellcheck: false,
    dataset: { noUnsaved: '' },
    attrs: { role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId },
  });
  // Pressing in the list (an option or its scrollbar) keeps focus in the box.
  const list = h('ul', { class: 'combo-list', id: listId, hidden: true, attrs: { role: 'listbox' }, on: { pointerdown: (event) => event.preventDefault() } });
  const box = h('div', { class: 'combo' }, text, list);
  const fold = (value) => String(value).toLowerCase().replace(/[_/]+/g, ' ');
  const entries = options.map(([optionValue, label, extra = '']) => ({ value: optionValue, label, extra, haystack: fold(`${optionValue} ${label} ${extra}`) }));
  const byValue = new Map(entries.map((entry) => [String(entry.value), entry]));
  let current = byValue.get(String(value)) ?? entries[0] ?? null;
  let shown = [];
  let active = -1;

  const show = (entry) => { text.value = entry ? entry.label : ''; };
  const highlight = (index) => {
    active = index;
    list.querySelectorAll('[role="option"]').forEach((item, i) => item.classList.toggle('is-active', i === index));
    const item = list.children[index];
    if (item?.getAttribute('role') === 'option') {
      text.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView({ block: 'nearest' });
    } else text.removeAttribute('aria-activedescendant');
  };
  const close = () => {
    list.hidden = true;
    text.setAttribute('aria-expanded', 'false');
    text.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const open = (query = '') => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    shown = words.length ? entries.filter((entry) => words.every((word) => entry.haystack.includes(word))) : entries;
    clear(
      list,
      shown.length
        ? shown.map((entry, i) =>
            h('li', { id: `${listId}-${i}`, class: entry === current ? 'is-current' : null, attrs: { role: 'option', 'aria-selected': String(entry === current) }, on: { click: () => pick(entry) } }, h('span', {}, entry.label), entry.extra ? h('span', { class: 'combo-extra' }, entry.extra) : null),
          )
        : h('li', { class: 'combo-empty' }, emptyText),
    );
    list.hidden = false;
    text.setAttribute('aria-expanded', 'true');
    highlight(words.length && shown.length ? 0 : shown.indexOf(current));
  };
  const pick = (entry) => {
    const changed = entry !== current;
    current = entry;
    show(entry);
    close();
    if (changed) box.dispatchEvent(new Event('change', { bubbles: true }));
  };

  text.addEventListener('focus', () => { text.select(); open(); });
  text.addEventListener('click', () => list.hidden && open());
  text.addEventListener('input', () => open(text.value));
  text.addEventListener('blur', () => { close(); show(current); });
  text.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) return open();
      if (!shown.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight(active < 0 ? (step > 0 ? 0 : shown.length - 1) : (active + step + shown.length) % shown.length);
    } else if (event.key === 'Enter') {
      if (list.hidden) return;
      event.preventDefault();
      if (shown[active]) pick(shown[active]);
    } else if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      show(current);
      text.select();
    }
  });

  show(current);
  Object.defineProperty(box, 'value', {
    get: () => current?.value ?? '',
    set: (next) => { current = byValue.get(String(next)) ?? current; show(current); },
  });
  box.labelTarget = text;
  return box;
}

export function checkbox(label, checked, props = {}, hint) {
  const box = h('input', { type: 'checkbox', checked, ...props });
  return h('label', { class: 'check' }, box, h('span', {}, label, hint ? h('small', {}, hint) : null));
}

/** A switch that saves itself; reverts and reports if saving fails. */
export function toggle(label, checked, onChange, hint) {
  const box = h('input', { type: 'checkbox', class: 'switch', checked, attrs: { role: 'switch' } });
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await onChange(box.checked);
    } catch (error) {
      box.checked = !box.checked;
      toast(error?.message || 'Could not save.', 'error');
    } finally {
      box.disabled = false;
    }
  });
  return h('label', { class: 'toggle' }, h('span', {}, label, hint ? h('small', {}, hint) : null), box);
}

/** A labelled group of settings: a label column and its controls. */
export function settings({ index: number = null, title, text = null }, ...children) {
  return h(
    'section',
    { class: 'settings' },
    h('div', { class: 'settings-head' }, number ? eyebrow(number) : null, h('h2', {}, title), text ? h('p', {}, text) : null),
    h('div', { class: 'settings-body' }, children),
  );
}

// ---------------------------------------------------------------------------
// Unsaved edits
// ---------------------------------------------------------------------------

// A control someone changed, mapped to the nearest container with buttons in
// it, when one of those is a Save (`saves`). It stops counting when that Save
// succeeds, or once the control is hidden or gone. Controls whose nearest
// buttons do something else (Invite, Search…), search boxes, switches that
// save themselves and `data-no-unsaved` controls never count.
const edits = new Map();

function noteEdit(event) {
  const control = event.target;
  if (!(control instanceof Element) || edits.has(control)) return;
  if (control.matches('[type="search"], .switch') || control.closest('[data-no-unsaved], dialog')) return;
  for (let node = control.parentElement; node && node !== document.body; node = node.parentElement) {
    if (!node.querySelector('button')) continue;
    if (node.querySelector('button[data-saves]')) edits.set(control, node);
    return;
  }
}
document.addEventListener('input', noteEdit, true);
document.addEventListener('change', noteEdit, true);

function editsSavedBy(saveButton) {
  return [...edits].filter(([, scope]) => scope.contains(saveButton)).map(([control]) => control);
}

/** True while the page holds changes nobody has saved yet. */
export function hasUnsavedEdits() {
  for (const control of edits.keys()) if (!control.isConnected || control.closest('[hidden]')) edits.delete(control);
  return edits.size > 0;
}

/** Drop every pending edit (the page they were on is being replaced). */
export function forgetEdits() {
  edits.clear();
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * Ask before something consequential. With `typed`, the person must type the
 * phrase to enable the confirm button. Resolves to true or false.
 */
export function confirmDialog({ title, body, confirm = 'Confirm', danger = false, typed = null, extra = null, cancellable = true, label = null }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const phrase = typed ? input({ autocomplete: 'off', attrs: { 'aria-label': `Type ${typed} to confirm` } }) : null;
    const ok = h('button', { type: 'submit', class: ['btn', danger ? 'btn-danger' : 'btn-primary'], disabled: Boolean(typed) }, confirm);
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel');
    const dialog = h(
      'dialog',
      { class: 'dialog', attrs: { 'aria-labelledby': 'dialog-title' } },
      h(
        'form',
        { method: 'dialog', class: danger ? 'is-danger' : null },
        eyebrow(label ?? (danger ? 'Please confirm' : 'Confirm')),
        h('h2', { id: 'dialog-title' }, title),
        (Array.isArray(body) ? body : [body]).map((line) => (line instanceof Node ? line : h('p', {}, line))),
        extra,
        typed ? field(`Type “${typed}” to confirm`, phrase) : null,
        h('div', { class: 'row end' }, cancellable ? cancel : null, ok),
      ),
    );
    phrase?.addEventListener('input', () => (ok.disabled = phrase.value.trim() !== typed));
    cancel.addEventListener('click', () => dialog.close('cancel'));
    dialog.addEventListener('close', () => {
      declined = dialog.returnValue !== 'ok';
      resolve(dialog.returnValue === 'ok');
      dialog.remove();
      // After the asking button has re-enabled itself.
      setTimeout(() => opener instanceof HTMLElement && opener.isConnected && opener.focus({ preventScroll: true }), 0);
    });
    ok.addEventListener('click', (event) => {
      event.preventDefault();
      dialog.close('ok');
    });
    document.body.append(dialog);
    dialog.showModal();
    (phrase ?? ok).focus();
  });
}

/** Show a secret once, with a copy button. */
export function secretDialog(title, secret, lines = [], extra = null) {
  const value = h('code', { class: 'secret' }, secret);
  const copy = button('Copy', () => copyText(secret), { variant: 'ghost', small: true, busy: 'Copying…' });
  return confirmDialog({ title, body: [...lines, h('div', { class: 'secret-row' }, value, copy)], confirm: 'Done', extra, cancellable: false, label: 'Shown once' });
}

export async function copyText(text, message = 'Copied.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 'success');
  } catch {
    throw new Error('Your browser blocked copying. Select the text and copy it instead.');
  }
}

let tabsId = 0;

/** Tabs within a section. `items` is [[id, label, render]]. Arrow keys move between tabs. */
export function tabs(items, initial = items[0][0]) {
  const base = `t${(tabsId += 1)}`;
  const panel = h('div', { class: 'tab-panel', id: `${base}-panel`, attrs: { role: 'tabpanel', tabindex: '-1' } });
  const ink = h('span', { class: 'tab-ink is-instant', attrs: { 'aria-hidden': 'true' } });
  const buttons = items.map(([id, label]) =>
    h('button', { type: 'button', class: 'tab', id: `${base}-${id}`, attrs: { role: 'tab', 'aria-selected': 'false', 'aria-controls': panel.id, tabindex: '-1' }, dataset: { tab: id } }, label),
  );
  const bar = h('div', { class: 'tabs', attrs: { role: 'tablist' } }, buttons, ink);
  const place = (target) => {
    if (!target.offsetWidth) return;
    ink.style.setProperty('--x', `${target.offsetLeft + (target === buttons[0] ? 0 : 12)}px`);
    ink.style.setProperty('--w', `${target.offsetWidth - (target === buttons[0] ? 12 : 24)}px`);
  };
  let revision = 0;
  const show = async (id) => {
    const current = (revision += 1);
    let selected = buttons[0];
    for (const el of buttons) {
      const on = el.dataset.tab === id;
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      el.tabIndex = on ? 0 : -1;
      if (on) selected = el;
    }
    panel.setAttribute('aria-labelledby', selected.id);
    place(selected);
    requestAnimationFrame(() => {
      place(selected);
      requestAnimationFrame(() => ink.classList.remove('is-instant'));
    });
    clear(panel, loading());
    try {
      const content = await items.find(([itemId]) => itemId === id)[2]();
      if (current !== revision) return;
      clear(panel, content);
    } catch (error) {
      if (current !== revision) return;
      clear(panel, note(error?.message || 'Could not load this.', 'error'));
    }
    panel.classList.remove('is-entering');
    void panel.offsetWidth;
    panel.classList.add('is-entering');
  };
  for (const el of buttons) el.addEventListener('click', () => show(el.dataset.tab));
  bar.addEventListener('keydown', (event) => {
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = buttons[(next + buttons.length) % buttons.length];
    target.focus();
    show(target.dataset.tab);
  });
  new ResizeObserver(() => place(buttons.find((el) => el.getAttribute('aria-selected') === 'true') ?? buttons[0])).observe(bar);
  show(initial);
  return h('div', { class: 'tabset' }, bar, panel);
}

/** Label/value pairs as a responsive grid. `pairs` is [[label, value]]. */
export function facts(pairs) {
  return h('dl', { class: 'facts' }, pairs.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))));
}

/** Label/value rows, like a shipping manifest or receipt. */
export function manifest(pairs) {
  return h('dl', { class: 'manifest' }, pairs.filter(Boolean).flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]));
}
