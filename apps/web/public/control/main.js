// The dashboard of your PigeonBox server: Settings for the extension and the
// server's control plane, in one hash-routed app. The extension in this
// browser decides the mode:
//
// - Local: settings stored in the extension (AI, inbox, tracking, voice…).
//   No account needed. Read and saved through lib/extension.js.
// - Server (internally `cloud`): your account on this server and everything
//   the server does, over the API, plus the extension settings that still
//   apply in server mode.
//
// Switching modes happens at #cloud (to the server) or from the rail (to
// Local). Without the extension, the dashboard shows the server pages only.
// Each section is its own module, loaded on first visit. Decoration (motion,
// halftone prints) is layered on afterwards and never blocks a page.
import { api, finishSignIn, readSession, restoreExtensionAccount, signOut, startSignIn, takeLinkReturn } from '../lib/session.js';
import { pendingMcpAuthorization } from './mcp-auth.js';
import { ext, findExtension, INSTALL_URL } from '../lib/extension.js';
import { configure as configureSettingsSync, reconcile as reconcileSettings } from '../lib/settings-sync.js';
import { ago, arrowLink, button, clear, confirmDialog, emptyState, forgetEdits, h, hasUnsavedEdits, link, notice, pageLoading, plural, postmarkDate, surface, tag, toast } from './ui.js';
import { enter, leave, placeMarker } from './motion.js';
import { capabilityHint, routeHealth, serverHost } from './shared.js';

const settingsPage = (name) => () => import(`./sections/settings/${name}.js`);

/**
 * Every page. `title` is the rail label, `heading` and `lede` set the
 * masthead. `capability` locks a server page this server is not set up for;
 * `scene` picks its halftone print.
 */
const PAGES = {
  // Local mode
  general: { title: 'General', heading: 'How PigeonBox runs', lede: 'PigeonBox is running on this computer. Mail stays in this browser unless you set up an AI provider.', scene: 'connections', load: settingsPage('general') },
  ai: { title: 'AI', heading: 'AI on your terms', lede: 'Where summaries, sorting and drafts are worked out while PigeonBox runs locally.', scene: 'memory', load: settingsPage('ai') },
  localInbox: { title: 'Inbox & drafts', heading: 'Inbox & drafts', lede: 'What PigeonBox does with your mail while Gmail is open.', scene: 'views', load: settingsPage('inbox') },
  localTracking: { title: 'Email tracking', heading: 'Email tracking', lede: 'Opens and clicks on mail you send, recorded by a tracker you own.', scene: 'documents', load: settingsPage('tracking') },
  voice: { title: 'Your voice', heading: 'Your voice', lede: 'How drafts should sound. Used for every draft PigeonBox writes for you.', scene: 'memory', load: settingsPage('voice') },
  localPrivacy: { title: 'Privacy & data', heading: 'What stays where', lede: 'Your mail index, settings and drafts stay in this browser.', scene: 'privacy', load: settingsPage('privacy') },
  advanced: { title: 'Advanced', heading: 'Advanced', lede: 'Rules, archive thresholds, keyboard and diagnostics.', scene: 'developers', load: settingsPage('advanced') },
  // Switching to the server
  cloud: { title: 'Your server', heading: 'Use your PigeonBox server', lede: 'Your server keeps working while Gmail is closed: prepared drafts, follow-ups, briefings and calendar context. Sign in, then turn it on in this browser.', scene: 'account', load: () => import('./sections/cloud-setup.js') },
  // Server mode
  overview: { title: 'Overview', heading: 'Your PigeonBox', lede: 'Everything moving through your PigeonBox server.', capability: 'cloud_mail_sync', load: () => import('./sections/overview.js') },
  account: { title: 'Account & server', heading: 'Your server', lede: 'Your account on this PigeonBox server, what the server is set up to do, and the AI it has used.', scene: 'account', load: () => import('./sections/account.js') },
  connections: { title: 'Connected accounts', heading: 'Mail routes', lede: 'Google accounts connected to your PigeonBox server, and how each one is syncing.', capability: 'cloud_mail_sync', scene: 'connections', load: () => import('./sections/connections.js') },
  privacy: { title: 'Privacy & data', heading: 'What your server keeps', lede: 'What your PigeonBox server stores about your mail, how it is sealed, and how to remove it. Local PigeonBox data in your browser is separate and never shown here.', capability: 'cloud_mail_sync', scene: 'privacy', load: () => import('./sections/privacy.js') },
  preferences: { title: 'Sync & routines', heading: 'Working hours & routines', lede: 'When PigeonBox works for you, and what it prepares in the background.', capability: 'cloud_mail_sync', scene: 'preferences', load: () => import('./sections/preferences.js') },
  inbox: { title: 'In Gmail', heading: 'In Gmail', lede: 'What the PigeonBox extension does inside Gmail in this browser.', scene: 'views', load: settingsPage('inbox') },
  tracking: { title: 'Email tracking', heading: 'Email tracking', lede: 'Opens and clicks on mail you send, recorded by your PigeonBox server.', scene: 'documents', load: settingsPage('tracking') },
  personalization: { title: 'Your voice', heading: 'Your voice', lede: 'How drafts should sound, here and in your server’s background drafts.', scene: 'memory', load: settingsPage('voice') },
  memory: { title: 'Memory', heading: 'What Pidgy remembers', lede: 'The useful details you should not have to explain twice. Correct or forget any of it.', scene: 'memory', load: () => import('./sections/memory.js?v=unsaved-tz-20261011-1') },
  activity: { title: 'Audit & activity', heading: 'Dispatch log', lede: 'Everything done on your behalf, with who asked for it and why.', scene: 'activity', load: () => import('./sections/activity.js') },
  team: { title: 'Team', heading: 'Shared desk', lede: 'Share a thread’s summary with teammates, assign it, and discuss it. The email itself never leaves the sharer’s mailbox.', capability: 'cloud_team', scene: 'team', load: () => import('./sections/team.js') },
  developers: { title: 'API & MCP', heading: 'Service entrance', lede: 'Connect tools to PigeonBox with scoped tokens and signed webhooks. Everything they do is audited.', capability: 'cloud_mcp', scene: 'developers', load: () => import('./sections/developers.js') },
  approvals: { title: 'Approvals', heading: 'Waiting for your say', lede: 'PigeonBox never sends email or invites people on its own. Everything that needs your say waits here, in Gmail’s side panel and in the extension.', scene: 'approvals', load: () => import('./sections/approvals.js') },
  automations: { title: 'Automations', heading: 'Standing orders', lede: 'Plain-language rules that run in Shadow Mode until you turn them on.', capability: 'cloud_automations', scene: 'automations', load: () => import('./sections/automations.js') },
  sequences: { title: 'Sequences', heading: 'Sequences', lede: 'Personal sequences for a small list of people you would write to anyway. Every batch waits for your approval, and replies stop it for that person.', capability: 'cloud_sequences', scene: 'sequences', load: () => import('./sections/sequences.js') },
  views: { title: 'Smart Views', heading: 'Smart Views', lede: 'Describe mail in your own words. PigeonBox turns it into rules you can read.', capability: 'cloud_automations', scene: 'views', load: () => import('./sections/views.js') },
  subscriptions: { title: 'Mailing lists', heading: 'Mailing lists', lede: 'Newsletters and stores that email you. Leave any of them in one click, the way Gmail’s Unsubscribe button works, and PigeonBox keeps the ones that ignore it out of your inbox.', capability: 'cloud_mail_sync', scene: 'views', load: () => import('./sections/subscriptions.js') },
  contacts: { title: 'Contacts', heading: 'Correspondents', lede: 'People, open promises and recent progress from your synced conversations. Pidgy checks later emails for evidence that a promise was fulfilled.', capability: 'cloud_relationships', scene: 'contacts', load: () => import('./sections/contacts.js?v=unsaved-tz-20261011-1') },
  documents: { title: 'Documents', heading: 'Tracked documents', lede: 'Share PDFs with per-recipient links and see the activity observed in PigeonBox’s viewer.', capability: 'cloud_documents', scene: 'documents', load: () => import('./sections/documents.js') },
  briefings: { title: 'Briefings', heading: 'Briefings', lede: 'Built from your synced mail and calendar. Every line links to where it came from.', capability: 'cloud_automations', scene: 'briefings', load: () => import('./sections/briefings.js') },
};

/**
 * The rail for each mode: [group, [[hash, page]…], collapsible]. A hash can
 * name different pages per mode (Local and server "privacy" are not the same).
 */
const NAV = {
  local: [
    ['Settings', [['general', 'general'], ['ai', 'ai'], ['inbox', 'localInbox'], ['tracking', 'localTracking'], ['personalization', 'voice'], ['privacy', 'localPrivacy'], ['advanced', 'advanced']]],
  ],
  cloud: [
    ['Account', [['overview', 'overview'], ['account', 'account'], ['connections', 'connections'], ['privacy', 'privacy']]],
    ['Settings', [['preferences', 'preferences'], ['inbox', 'inbox'], ['tracking', 'tracking'], ['personalization', 'personalization'], ['memory', 'memory']]],
    ['Work', [['approvals', 'approvals'], ['subscriptions', 'subscriptions'], ['activity', 'activity'], ['team', 'team'], ['developers', 'developers']]],
    ['Advanced workflows', [['automations', 'automations'], ['sequences', 'sequences'], ['views', 'views'], ['contacts', 'contacts'], ['documents', 'documents'], ['briefings', 'briefings']], true],
  ],
};
/** Hashes from the other mode, and older links, land on the closest page. */
const ALIASES = { local: { overview: 'general', account: 'cloud', connections: 'cloud', preferences: 'general', memory: 'general', activity: 'general', approvals: 'general' }, cloud: { general: 'overview', ai: 'overview', advanced: 'inbox' } };

const view = document.getElementById('view');
const nav = document.getElementById('cp-nav');
const announcer = document.getElementById('cp-announce');
const params = new URLSearchParams(location.search);
// Providers may return failures in the query or fragment. Keep only codes for
// fixed notices; never display their raw description, and clean callback URLs.
const errorFragment = new URLSearchParams(location.hash.slice(1));
const hasErrorFragment = errorFragment.has('error') || errorFragment.has('error_code');
const hasSignInError = params.has('error') || params.has('error_code') || hasErrorFragment;
const signInErrorCode = params.get('error_code') ?? (hasErrorFragment ? errorFragment.get('error_code') : null);
// One-time landing parameters (Google consent result, team invitation, sign-in return,
// the extension's ID and a server setup request). Keep them, then clean the URL.
const landing = Object.fromEntries(['connected', 'missing', 'error', 'invite', 'setup'].filter((name) => params.has(name)).map((name) => [name, params.get(name)]));
const extensionHint = params.get('ext');
const authReturn = params.has('code') || params.has('state') ? new URLSearchParams(params) : null;
if (pendingMcpAuthorization()) history.replaceState(null, '', `${location.pathname}#developers`);
if (Object.keys(landing).length || authReturn || hasSignInError || extensionHint) history.replaceState(null, '', `${location.pathname}${hasErrorFragment ? '' : location.hash}`);

let ctx = null;
let renderToken = 0;
let shownHash = '';
let askingToLeave = false;
let marker = null;

const hashId = () => location.hash.replace(/^#/, '').split('/')[0];

/** The page for the current hash in the current mode, and the hash it lives at. */
function currentPage() {
  const id = hashId();
  if (id === 'cloud' || ALIASES[ctx.mode][id] === 'cloud') return { hash: 'cloud', page: 'cloud' };
  const entries = NAV[ctx.mode].flatMap(([, items]) => items);
  const found = entries.find(([hash]) => hash === id) ?? entries.find(([hash]) => hash === ALIASES[ctx.mode][id]) ?? entries[0];
  return { hash: found[0], page: found[1] };
}

// ---------------------------------------------------------------------------
// Page frame
// ---------------------------------------------------------------------------

function masthead({ n, path, heading, lede = null, scene = null }) {
  const aside = h('div', { class: 'mh-aside' });
  const art = scene ? h('canvas', { class: 'mh-art', dataset: { scene }, attrs: { 'aria-hidden': 'true' } }) : null;
  const el = h(
    'header',
    { class: 'masthead' },
    h(
      'div',
      { class: 'mh-rule' },
      h('p', { class: 'eyebrow' }, n ? h('span', { class: 'mh-index' }, n) : null, h('span', { class: 'mh-path' }, path)),
      h('span', { class: 'mh-date', attrs: { 'aria-hidden': 'true' } }, postmarkDate()),
    ),
    h('div', { class: 'mh-grid' }, h('div', { class: 'mh-copy' }, h('h1', { class: 'mh-title' }, heading), lede ? h('p', { class: 'mh-lede' }, lede) : null), aside),
    art,
  );
  return { el, aside, art };
}

function pageMasthead(hash, pageId) {
  const page = PAGES[pageId];
  const groups = NAV[ctx.mode];
  const group = groups.find(([, items]) => items.some(([itemHash]) => itemHash === hash))?.[0] ?? (ctx.mode === 'cloud' ? 'Server' : 'Local');
  const position = groups.flatMap(([, items]) => items).findIndex(([itemHash]) => itemHash === hash);
  return masthead({ n: position >= 0 ? String(position + 1).padStart(2, '0') : null, path: `${group} / ${page.title}`, heading: page.heading, lede: page.lede, scene: page.scene ?? null });
}

/** Section modules return a node, or { content, aside, art, className } to dress the masthead. */
function dress(head, result) {
  if (!result || result instanceof Node || Array.isArray(result)) return result;
  if (result.aside) {
    clear(head.aside, result.aside);
    head.el.classList.add('has-aside');
  }
  if (result.art) {
    head.art?.remove();
    head.el.append(result.art);
  }
  if (result.className) head.el.classList.add(result.className);
  return result.content;
}

function decorate() {
  // Prints are progressive enhancement: loaded after the page, never awaited.
  import('./halftone.js').then((halftone) => halftone.mount(view)).catch(() => undefined);
}

function paint(head, body, { settle = false } = {}) {
  const page = h('div', { class: 'page' }, body);
  if (settle && head.el.isConnected) view.querySelector(':scope > .page')?.replaceWith(page);
  else clear(view, head.el, page);
  enter(view, { masthead: !settle });
  decorate();
}

/** A server page whose capability this server does not have: say which setting turns it on. */
function lockedBody(page) {
  const noAccess = ctx.caps.size === 0;
  return emptyState({
    state: 'lantern',
    title: noAccess ? `Your account has no access to ${page.title} on this server.` : `${page.title} isn’t set up on this server.`,
    text: noAccess
      ? 'This server gives your account no features. Ask the server owner to add your address to ALLOWED_EMAILS.'
      : `${capabilityHint(page.capability)} Nothing is wrong with your account: whoever runs this server can turn it on.`,
    actions: [link('Account & server', '#account', { class: 'btn btn-ghost' }), tag('Server setting')],
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function render({ focus = false, preserveScroll = false } = {}) {
  const scroll = preserveScroll ? { x: window.scrollX, y: window.scrollY, height: view.getBoundingClientRect().height } : null;
  view.style.minHeight = scroll ? `${scroll.height}px` : '';
  const { hash, page: pageId } = currentPage();
  if (hashId() !== hash) history.replaceState(null, '', `#${hash}`);
  shownHash = location.hash;
  forgetEdits();
  const page = PAGES[pageId];
  const token = (renderToken += 1);
  document.title = `${page.title} · PigeonBox`;
  updateNav(hash);
  closeMenu();
  const head = pageMasthead(hash, pageId);

  if (ctx.mode === 'cloud' && page.capability && !ctx.caps.has(page.capability)) {
    head.art?.setAttribute('data-scene', 'locked');
    paint(head, lockedBody(page));
    return finish(page, focus);
  }

  // The current page dims at once; a skeleton follows only if loading is slow.
  const first = !view.querySelector(':scope > .page') || view.querySelector('.loading-page');
  leave(view);
  let skeleton = false;
  const slow = setTimeout(() => {
    if (token !== renderToken) return;
    skeleton = true;
    paint(head, pageLoading(`Loading ${page.title}…`));
  }, first ? 0 : 200);

  try {
    const module = await page.load();
    const result = await module.render({ ...ctx, landing, section: hash, rerender: () => render({ preserveScroll: true }) });
    if (token !== renderToken) return;
    clearTimeout(slow);
    paint(head, dress(head, result), { settle: skeleton });
  } catch (error) {
    if (token !== renderToken) return;
    clearTimeout(slow);
    if (error?.status === 401) return signedOut();
    paint(
      head,
      notice({
        tone: 'bad',
        label: 'Returned',
        title: error?.message || 'This page could not load.',
        text: ctx.mode === 'local' ? 'PigeonBox did not answer as expected. Nothing was changed.' : 'Your PigeonBox server did not answer as expected. Nothing was changed.',
        actions: [button('Try again', () => render(), { variant: 'ghost' })],
      }),
      { settle: skeleton },
    );
  }
  if (scroll && token === renderToken) {
    window.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
    view.style.minHeight = '';
  }
  finish(page, focus);
}

/** Moving to another page asks first when this one has unsaved changes. */
async function leavePage() {
  if (!ctx?.mode || askingToLeave || location.hash === shownHash) return;
  if (hasUnsavedEdits()) {
    const target = location.hash;
    // Show the page being left in the address bar while asking.
    history.replaceState(null, '', `${location.pathname}${location.search}${shownHash}`);
    askingToLeave = true;
    const ok = await confirmDialog({
      title: 'Leave without saving?',
      body: 'You have changes on this page that are not saved yet. If you leave now, they will be lost.',
      confirm: 'Leave page',
      danger: true,
      label: 'Unsaved changes',
    }).finally(() => (askingToLeave = false));
    if (!ok) return;
    history.replaceState(null, '', target);
  }
  render({ focus: true });
}

function finish(page, focus) {
  announcer.textContent = `${page.title} loaded`;
  if (focus) {
    view.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

function buildNav() {
  marker = h('span', { class: 'cp-nav-marker', attrs: { 'aria-hidden': 'true' } });
  let n = 0;
  const groups = NAV[ctx.mode].map(([title, items, collapsible]) => {
    n += 1;
    const number = h('span', { class: 'n', attrs: { 'aria-hidden': 'true' } }, String(n).padStart(2, '0'));
    const links = items.map(([hash, pageId]) => {
      const page = PAGES[pageId];
      const locked = ctx.mode === 'cloud' && page.capability && !ctx.caps.has(page.capability);
      return h(
        'a',
        { href: `#${hash}`, dataset: { section: hash, ...(locked ? { locked: '' } : {}) }, title: locked ? 'Not set up on this server' : null },
        h('span', {}, page.title),
        hash === 'approvals' ? [' ', h('span', { class: 'count', dataset: { count: 'approvals' }, hidden: true })] : null,
      );
    });
    if (collapsible) return h('details', { class: 'cp-advanced' }, h('summary', {}, number, title), links);
    return [h('p', { class: 'cp-group' }, number, title), links];
  });
  clear(nav, marker, groups);
  nav.querySelector('details')?.addEventListener('toggle', () => placeMarker(marker, nav.querySelector('a[aria-current="page"]'), { instant: true }));
  document.querySelector('.cp-badge').textContent = ctx.mode === 'cloud' ? 'Server' : 'Local';
  renderModeSwitch();
}

/** Local / Server switch at the top of the rail. Only shown when the extension is here to switch. */
function renderModeSwitch() {
  const box = document.getElementById('cp-mode');
  if (!ctx.extension) {
    clear(
      box,
      h('p', { class: 'cp-mode-note' }, 'PigeonBox isn’t installed in this browser, or needs an update, so only your server’s pages are shown.'),
      arrowLink('How to install PigeonBox', INSTALL_URL, { target: '_blank', rel: 'noopener' }),
    );
    box.hidden = false;
    return;
  }
  const choice = (mode, label, detail) =>
    h(
      'button',
      { type: 'button', class: 'cp-mode-choice', attrs: { 'aria-pressed': String(ctx.mode === mode) }, on: { click: () => switchMode(mode) } },
      h('span', { class: 'cp-mode-label' }, label),
      h('span', { class: 'cp-mode-detail' }, detail),
    );
  clear(
    box,
    h('p', { class: 'cp-mode-title', id: 'cp-mode-title' }, 'PigeonBox runs'),
    h('div', { class: 'cp-mode-switch', attrs: { role: 'group', 'aria-labelledby': 'cp-mode-title' } }, choice('local', 'Local', 'On this computer'), choice('cloud', 'Server', 'Always on')),
  );
  box.hidden = false;
}

async function switchMode(mode) {
  if (mode === ctx.mode) return;
  if (mode === 'cloud') {
    location.hash = '#cloud';
    return;
  }
  const ok = await confirmDialog({
    title: 'Switch PigeonBox to Local?',
    body: [
      'PigeonBox stops sending mail to your server from this browser. Summaries, sorting and drafts use the AI you set up for Local mode.',
      'Your account on the server and anything it already prepared stay as they are. You can switch back any time.',
    ],
    confirm: 'Switch to Local',
    label: 'Change mode',
  });
  if (!ok) return;
  try {
    await ext('SET_RUN_MODE', { mode: 'local' });
    toast('PigeonBox now runs locally on this computer.', 'success');
    history.replaceState(null, '', '#general');
    await boot();
  } catch (error) {
    toast(error?.message || 'Could not switch modes.', 'error');
  }
}

function updateNav(hash) {
  let current = null;
  for (const anchor of nav.querySelectorAll('a[data-section]')) {
    if (anchor.dataset.section === hash) {
      anchor.setAttribute('aria-current', 'page');
      // Never hide the current page inside the collapsed group.
      anchor.closest('details')?.setAttribute('open', '');
      current = anchor;
    } else anchor.removeAttribute('aria-current');
  }
  document.getElementById('cp-top-section').textContent = PAGES[currentPage().page].title;
  requestAnimationFrame(() => placeMarker(marker, current));
}

function showRouteHealth(data) {
  const health = routeHealth(data);
  const box = document.getElementById('cp-status');
  const mark = document.getElementById('cp-status-mark');
  mark.className = `pill pill-${health.tone}`;
  mark.textContent = health.phrase;
  document.getElementById('cp-status-detail').textContent = health.live.length
    ? `${plural(health.live.length, 'account')}${health.lastSync ? ` · synced ${ago(health.lastSync)}` : ''}`
    : 'Connect Google to start';
  box.hidden = ctx?.mode !== 'cloud';
}

async function refreshCounts(force = false) {
  if (!ctx || ctx.mode !== 'cloud' || !ctx.me || (document.hidden && !force)) return;
  try {
    const { pending } = await api('/v1/approvals/list', { method: 'POST', body: { status: 'pending', limit: 1 } });
    for (const badge of document.querySelectorAll('[data-count="approvals"]')) {
      badge.textContent = String(pending);
      badge.hidden = !pending;
      badge.setAttribute('aria-label', `${pending} waiting`);
    }
    document.getElementById('cp-top-count').hidden = !pending;
    document.getElementById('cp-top-count').setAttribute('aria-label', `${plural(pending, 'approval')} waiting`);
  } catch {
    // Counts are a convenience; the section shows errors itself.
  }
}

function showUser() {
  const user = document.getElementById('cp-user');
  const out = document.getElementById('cp-signout');
  if (ctx.me) {
    const email = ctx.me.user.email || '';
    document.getElementById('cp-email').textContent = email;
    document.getElementById('cp-email').title = email;
    document.getElementById('cp-avatar').textContent = (email || 'P').slice(0, 1);
    document.getElementById('cp-host').textContent = serverHost();
    out.hidden = false;
  } else {
    document.getElementById('cp-email').textContent = 'PigeonBox in this browser';
    document.getElementById('cp-avatar').textContent = 'P';
    document.getElementById('cp-host').textContent = ctx.extension ? `Local · v${ctx.extension.version}` : '';
    out.hidden = true;
  }
  user.hidden = false;
}

// ---------------------------------------------------------------------------
// Signed out, unreachable
// ---------------------------------------------------------------------------

const INVITE_KEY = 'pigeonbox.invite';

function signedOut() {
  // An invitation link must survive the trip through sign-in.
  if (landing.invite) {
    try {
      sessionStorage.setItem(INVITE_KEY, landing.invite);
    } catch {
      // Storage blocked: the person can open the link again after signing in.
    }
  }
  document.body.dataset.auth = 'out';
  const status = h('p', { class: 'hint', attrs: { role: 'status' } });
  const inCloudMode = ctx?.extension?.product?.runMode === 'cloud';
  const head = masthead({ n: '00', path: 'PigeonBox / Sign in', heading: inCloudMode ? 'Sign in to your PigeonBox server' : 'Your PigeonBox desk', lede: inCloudMode ? 'PigeonBox in this browser runs on this server. Sign in to manage it.' : 'Connections, approvals, automations and privacy for your PigeonBox server, in one place.', scene: 'connections' });
  paint(
    head,
    [hasSignInError ? notice(signInErrorCode === 'signup_disabled' ? {
      label: 'Sign in',
      title: 'This server isn’t taking new accounts',
      text: 'Sign-ups are turned off on this PigeonBox server. Sign in with an account that already exists here, or ask whoever runs the server for access.',
    } : {
      label: 'Sign in',
      title: 'Sign-in was not completed',
      text: 'You can try signing in again. Use an account this server allows.',
    }) : null,
    h(
      'div',
      { class: 'grid-2' },
      surface(
        'stub',
        { title: 'Sign in', eyebrow: 'Account' },
        h('p', { class: 'muted' }, 'Sign in with the account you use on this PigeonBox server.'),
        h('div', { class: 'row' }, button('Sign in', () => startSignIn(status, location.hash))),
        status,
      ),
      inCloudMode
        ? surface(
          'slip',
          { title: 'Rather run locally?' },
          h('p', { class: 'muted' }, 'PigeonBox works in Gmail without an account. Switch this browser back to Local mode.'),
          h('div', { class: 'row' }, button('Switch to Local', async () => {
            await ext('SET_RUN_MODE', { mode: 'local' });
            history.replaceState(null, '', '#general');
            await boot();
          }, { variant: 'ghost' })),
        )
        : surface(
          'slip',
          { title: 'Not using a server yet?' },
          h('p', { class: 'muted' }, 'PigeonBox works in Gmail without an account. Server setup walks you through signing in and turning the server on in this browser.'),
          h('div', { class: 'row' }, arrowLink('Set up this server', '#cloud', { on: { click: () => setTimeout(() => void boot()) } }), arrowLink('How to install PigeonBox', INSTALL_URL, { target: '_blank', rel: 'noopener' })),
        ),
    )],
  );
  document.getElementById('cp-signout').hidden = true;
}

function unreachable(error) {
  const head = masthead({ n: '00', path: 'PigeonBox server', heading: 'Your PigeonBox server', scene: 'locked' });
  // An account the server no longer allows (ALLOWED_EMAILS) can only sign out and use another one.
  const refused = error?.code === 'forbidden' && Boolean(readSession());
  paint(
    head,
    notice({
      tone: 'bad',
      label: 'Returned',
      title: error?.message || 'Could not reach your PigeonBox server.',
      text: refused ? 'Sign out to use another account on this server.' : 'Your session is kept. Reload the page to try again.',
      actions: [
        button('Reload', () => location.reload(), { variant: 'ghost' }),
        refused ? button('Sign out', async () => { await signOut(); location.replace('/dashboard'); }, { variant: 'ghost' }) : null,
      ].filter(Boolean),
    }),
  );
}

// ---------------------------------------------------------------------------
// Drawer (small screens)
// ---------------------------------------------------------------------------

const menu = document.querySelector('.cp-menu');
const side = document.getElementById('cp-side');
const scrim = document.getElementById('cp-scrim');
const body = document.querySelector('.cp-desk');
const narrow = matchMedia('(max-width: 900px)');

function closeMenu() {
  if (!side.classList.contains('open')) return;
  side.classList.remove('open');
  scrim.classList.remove('open');
  menu.setAttribute('aria-expanded', 'false');
  body.inert = false;
}
function openMenu() {
  side.classList.add('open');
  scrim.classList.add('open');
  menu.setAttribute('aria-expanded', 'true');
  body.inert = true;
  (nav.querySelector('a[aria-current="page"]') ?? nav.querySelector('a'))?.focus({ preventScroll: true });
  requestAnimationFrame(() => placeMarker(marker, nav.querySelector('a[aria-current="page"]'), { instant: true }));
}
menu.addEventListener('click', () => (side.classList.contains('open') ? closeMenu() : openMenu()));
scrim.addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && side.classList.contains('open')) {
    closeMenu();
    menu.focus();
  }
});
narrow.addEventListener('change', () => {
  closeMenu();
  placeMarker(marker, nav.querySelector('a[aria-current="page"]'), { instant: true });
});
window.addEventListener('resize', () => placeMarker(marker, nav.querySelector('a[aria-current="page"]'), { instant: true }), { passive: true });

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** Finish a sign-in, or a sign-in done for the extension, when this load returns from one. */
async function completeAuthReturn() {
  if (!authReturn || hasSignInError) return;
  const linked = takeLinkReturn(authReturn);
  if (linked) {
    history.replaceState(null, '', `${location.pathname}${linked.back}`);
    try {
      await ext('LINK_COMPLETE', { code: linked.code, state: linked.state });
      toast('PigeonBox in this browser is connected to your server.', 'success');
    } catch (error) {
      toast(error?.message || 'Connecting PigeonBox failed. Try again.', 'error');
    }
    return;
  }
  try {
    const back = await finishSignIn(authReturn);
    if (back) history.replaceState(null, '', `${location.pathname}${back}`);
  } catch (error) {
    toast(error?.message || 'Sign-in failed. Try again.', 'error');
  }
}

/** What this dashboard knows: the extension, the mode, and (when signed in) the account on this server. */
async function loadContext(hello) {
  const extension = hello ? { ...hello, product: hello.product } : null;
  const mode = pendingMcpAuthorization() ? 'cloud' : extension ? (extension.product.runMode === 'cloud' ? 'cloud' : 'local') : 'cloud';
  let me = null;
  let accountError = null;
  let capabilities = { capabilities: [] };
  try { await restoreExtensionAccount(hello, ext); }
  catch (error) { accountError = error; }
  if (readSession()) {
    try {
      [me, capabilities] = await Promise.all([api('/v1/me'), api('/v1/capabilities')]);
    } catch (error) {
      if (readSession() && mode === 'cloud') throw error;
      accountError = readSession() ? error : null;
      me = null;
    }
  }
  return {
    api,
    ext,
    extension,
    mode,
    me,
    accountError,
    caps: new Set(capabilities.capabilities),
    refreshCounts: () => refreshCounts(true),
    reload: () => boot(),
    toast,
  };
}

let listening = false;

async function boot() {
  const hello = await findExtension(extensionHint);
  try {
    ctx = await loadContext(hello);
  } catch (error) {
    ctx = { mode: 'cloud', extension: hello, caps: new Set() };
    unreachable(error);
    return;
  }
  // The extension asks for server setup: straight to the work once this browser already runs on the server.
  if (landing.setup === 'cloud') history.replaceState(null, '', ctx.mode === 'cloud' && ctx.me
    ? (ctx.caps.has('cloud_mail_sync') ? '#connections' : '#account') : '#cloud');
  delete landing.setup;

  const needsAccount = ctx.mode === 'cloud' && hashId() !== 'cloud';
  if (needsAccount && !ctx.me) {
    buildNav();
    if (ctx.accountError) return unreachable(ctx.accountError);
    return signedOut();
  }
  document.body.dataset.auth = 'in';
  document.body.dataset.mode = ctx.mode;
  // The extension's settings follow the account: restore them after a reinstall before any page reads them.
  configureSettingsSync({ api, ext, userId: ctx.me?.user.id, extension: ctx.extension });
  const settingsSync = await reconcileSettings(ctx.extension).catch(() => null);
  if (settingsSync === 'restored') toast('Your settings were restored from your PigeonBox account. API keys are never saved there, so add yours again under AI if you use one.', 'success');
  try {
    const saved = sessionStorage.getItem(INVITE_KEY);
    if (saved && !landing.invite) landing.invite = saved;
    sessionStorage.removeItem(INVITE_KEY);
  } catch {
    // Storage blocked.
  }
  buildNav();
  showUser();
  document.getElementById('cp-status').hidden = true;
  if (ctx.mode !== 'cloud') document.getElementById('cp-top-count').hidden = true;
  if (ctx.mode === 'cloud' && ctx.caps.has('cloud_mail_sync')) import('./shared.js').then(({ accounts }) => accounts()).catch(() => undefined);
  if (ctx.mode === 'cloud') {
    if (!location.hash && landing.invite) history.replaceState(null, '', '#team');
    // Without always-on sync (no Google settings on this server) the Overview has nothing to show.
    if (!location.hash && !ctx.caps.has('cloud_mail_sync')) history.replaceState(null, '', '#account');
    if (!location.hash && (landing.connected || landing.error)) history.replaceState(null, '', '#connections');
  }
  if (!listening) {
    listening = true;
    window.addEventListener('hashchange', leavePage);
    window.addEventListener('beforeunload', (event) => {
      // Browsers show their own wording here; custom text is ignored.
      if (!hasUnsavedEdits()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    document.addEventListener('pigeonbox:accounts', (event) => showRouteHealth(event.detail));
    document.getElementById('cp-signout').addEventListener('click', async () => {
      await signOut();
      location.replace('/dashboard');
    });
    setInterval(refreshCounts, 60_000);
    document.addEventListener('visibilitychange', () => void refreshCounts());
  }
  await render();
  void refreshCounts(true);
}

async function start() {
  // The extension must be found before a sign-in done for it can be handed back.
  await findExtension(extensionHint);
  await completeAuthReturn();
  await boot();
}

void start();
