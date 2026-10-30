import { ago, button, checkbox, clear, confirmDialog, day, emptyState, facts, h, note, plural, surface, toast } from '../ui.js';
import { accounts, cloudHealth, FEATURES, healthPill, healthReasons, phasePill, statusPill, syncPhase, syncPill } from '../shared.js';
import { celebrate } from '../motion.js';

const ORDER = ['mail_read', 'drafts', 'organize', 'calendar_read', 'calendar_write', 'send'];

const ERRORS = {
  access_denied: 'You declined on Google’s consent screen. Nothing was connected.',
  denied: 'Google did not grant access. Nothing was connected.',
  invalid_request: 'That sign-in link expired or was already used. Start again.',
  conflict: 'That Google account is already connected to another PigeonBox account.',
};

// Where a healthy account is on its way to current mail.
const TRACK = ['Import', 'Catch up', 'Review', 'Up to date'];
const STEP = { importing: 0, recovering: 1, catching_up: 1, analyzing: 2, up_to_date: 3 };
const HELD = { degraded: 'Sync is degraded; PigeonBox retries automatically.', stalled: 'Sync stopped and needs attention.', needs_reauth: 'Held until you reconnect.', paused: 'Paused. Nothing new is read.' };

async function connect(api, features, accountId) {
  const { url } = await api('/v1/connections/google/start', { method: 'POST', body: { features, returnTo: 'web', ...(accountId ? { accountId } : {}) } });
  location.assign(url);
}

function featurePicker(selected, locked = []) {
  const boxes = ORDER.map((feature) => checkbox(FEATURES[feature].title, selected.includes(feature), { value: feature, disabled: locked.includes(feature) }, FEATURES[feature].detail));
  const picked = () => boxes.map((row) => row.querySelector('input')).filter((box) => box.checked).map((box) => box.value);
  return { el: h('div', { class: 'checks two' }, boxes), picked };
}

function track(account) {
  const phase = syncPhase(account);
  const at = STEP[phase];
  const list = h(
    'ol',
    { class: 'rc-phases', attrs: { 'aria-label': 'Sync progress' }, dataset: at === undefined ? { broken: '' } : {} },
    TRACK.map((label, position) =>
      h('li', { class: at === undefined ? null : position < at ? 'is-done' : position === at ? 'is-now' : null, attrs: position === at ? { 'aria-current': 'step' } : {} }, label),
    ),
  );
  return h('div', {}, list, at === undefined ? h('p', { class: 'hint' }, HELD[phase] ?? '') : null);
}

function permissions(account) {
  return h(
    'div',
    { class: 'stamps', attrs: { role: 'list', 'aria-label': 'Google permissions' } },
    ORDER.map((feature) => {
      const on = account.features.includes(feature);
      return h('div', { class: ['perm', on && 'is-on'], attrs: { role: 'listitem' } }, h('strong', {}, FEATURES[feature]?.title ?? feature), h('span', {}, on ? 'Granted' : 'Not granted'));
    }),
  );
}

function health(account, derived) {
  const sync = account.sync;
  const mail = derived?.mail.find((item) => item.accountId === account.id) ?? null;
  const calendar = derived?.calendar.find((item) => item.accountId === account.id) ?? null;
  return facts([
    ...(mail ? [['Mail health', healthPill(mail.level)]] : []),
    ...(calendar ? [['Calendar', h('span', {}, healthPill(calendar.level), ' ', calendar.lastRefreshAt ? `refreshed ${ago(calendar.lastRefreshAt)}` : 'not refreshed yet')]] : []),
    ['Sync', syncPill(sync.state)],
    ['Last sync', sync.lastSyncAt ? ago(sync.lastSyncAt) : 'Not yet'],
    ['Last Gmail push', sync.lastPushAt ? ago(sync.lastPushAt) : 'None yet'],
    ['Watch renews', sync.watchExpiresAt ? ago(sync.watchExpiresAt) : '—'],
    ['Synced since', sync.coverageSince ? day(sync.coverageSince) : '—'],
    ['Threads', sync.threadsTracked.toLocaleString()],
    ['Queued work', sync.backlog ? plural(sync.backlog, 'job') : 'None'],
    ...(mail && mail.backfill === 'running' ? [['First import', 'Running']] : []),
  ]);
}

/** Why this route is not current, in plain words; nothing when it is. */
function healthNote(account, derived) {
  const mail = derived?.mail.find((item) => item.accountId === account.id);
  const calendar = derived?.calendar.find((item) => item.accountId === account.id);
  const reasons = [...healthReasons(mail?.reasons), ...healthReasons(calendar?.reasons)].filter((text) => account.status !== 'needs_reauth' || !/reconnect/i.test(text));
  if (!reasons.length) return null;
  const tone = [mail?.level, calendar?.level].some((level) => level === 'failed' || level === 'action_required') ? 'error' : [mail?.level, calendar?.level].some((level) => level === 'stale' || level === 'degraded') ? 'warn' : 'info';
  return note([...new Set(reasons)].join(' '), tone);
}

function accountCard(account, position, api, redraw, derived) {
  const missing = ORDER.filter((feature) => !account.features.includes(feature));
  const add = featurePicker(account.features, account.features);
  const problem =
    account.status === 'needs_reauth'
      ? note('Google stopped accepting PigeonBox’s access (the password changed or access was removed). Reconnect to resume.', 'error')
      : account.sync.lastErrorCode && account.sync.state !== 'healthy'
        ? note(`Last problem: ${account.sync.lastErrorCode.replace(/_/g, ' ')}. PigeonBox retries automatically.`, 'warn')
        : null;

  return surface(
    'card',
    {
      tag: 'article',
      className: 'route-card',
      eyebrow: `Route ${String(position + 1).padStart(2, '0')} · connected ${ago(account.connectedAt)}`,
      title: account.email,
      meta: account.displayName && account.displayName !== account.email ? account.displayName : null,
      actions: [statusPill(account.status), phasePill(account)],
    },
    problem,
    track(account),
    healthNote(account, derived),
    health(account, derived),
    h('div', { class: 'rc-perms' }, h('p', { class: 'eyebrow' }, 'Permissions'), permissions(account)),
    missing.length
      ? h(
          'details',
          { class: 'disclosure' },
          h('summary', {}, 'Add permissions'),
          h('p', { class: 'hint' }, 'Google asks you to approve only what is new. Existing permissions stay as they are.'),
          add.el,
          h('div', { class: 'row' }, button('Connect Gmail with Google', () => {
            const picked = add.picked().filter((feature) => !account.features.includes(feature));
            if (!picked.length) throw new Error('Choose at least one new permission.');
            return connect(api, [...account.features, ...picked], account.id);
          })),
        )
      : null,
    h(
      'div',
      { class: 'row' },
      account.status === 'needs_reauth'
        ? button('Reconnect', () => connect(api, account.features, account.id))
        : button(account.status === 'paused' ? 'Resume sync' : 'Pause sync', async () => {
            const paused = account.status !== 'paused';
            await api('/v1/connections/update', { method: 'POST', body: { accountId: account.id, paused } });
            toast(account.status === 'paused' ? 'Sync resumed.' : 'Sync paused. Nothing new is read until you resume.', 'success');
            await redraw();
          }, { variant: 'ghost' }),
      account.status === 'active'
        ? button('Resync', async () => {
            await api('/v1/connections/resync', { method: 'POST', body: { accountId: account.id } });
            toast('A full resync is queued.', 'success');
            await redraw();
          }, { variant: 'ghost' })
        : null,
      button('Disconnect…', async () => {
        const wipe = checkbox('Also delete everything synced from this account', true, {}, 'Summaries, drafts, follow-ups, contacts and search data from this mailbox.');
        const ok = await confirmDialog({
          title: `Disconnect ${account.email}?`,
          body: ['PigeonBox stops syncing, revokes its Google access and deletes the stored credentials. Your Gmail is not changed.'],
          extra: wipe,
          confirm: 'Disconnect',
          danger: true,
        });
        if (!ok) return;
        const delete_data = wipe.querySelector('input').checked;
        await api('/v1/connections/disconnect', { method: 'POST', body: { accountId: account.id, deleteData: delete_data } });
        toast('Disconnected.', 'success');
        await redraw();
      }, { variant: 'danger-ghost' }),
    ),
  );
}

export async function render({ api, landing, me }) {
  const root = h('div', { class: 'stack' });
  const justConnected = landing.connected === '1';
  const banner =
    landing.connected === '1'
      ? note(
          landing.missing
            ? `Connected, but Google did not grant: ${landing.missing.split(',').map((feature) => FEATURES[feature]?.title ?? feature).join(', ')}. Those features stay off; add them any time.`
            : 'Connected. PigeonBox is doing the first sync now; this page updates as it goes.',
          landing.missing ? 'warn' : 'success',
        )
      : landing.error
        ? note(ERRORS[landing.error] ?? 'Google connection failed. Try again.', 'error')
        : null;
  delete landing.connected;
  delete landing.error;
  delete landing.missing;

  const draw = async () => {
    const [data, derived] = await Promise.all([accounts(true), cloudHealth()]);
    const fresh = featurePicker(['mail_read', 'drafts'], ['mail_read']);
    clear(
      root,
      banner,
      data.googleConfigured ? null : note('Google sign-in is not configured on this server yet, so accounts cannot be connected.', 'warn'),
      data.accounts.length
        ? data.accounts.map((account, position) => accountCard(account, position, api, draw, derived))
        : emptyState({ state: 'map', title: 'No Google account is connected.', text: 'Connect one and your PigeonBox server keeps triage, follow-ups and drafts current while Gmail is closed.' }),
      data.googleConfigured && data.accounts.length < data.maxAccounts
        ? surface(
            'slip',
            { title: data.accounts.length ? 'Connect another email account' : 'Connect your Gmail', className: 'composer' },
            me ? h('p', { class: 'hint' }, `PigeonBox account: ${me.user.email}. Choose the Gmail account you want your server to work with; it can be a different account.`) : null,
            h('p', { class: 'muted' }, 'Pick what your PigeonBox server may do. Reading mail is required for always-on features; everything else is optional and can be added later.'),
            fresh.el,
            h('div', { class: 'row' }, button('Connect Gmail with Google', () => connect(api, fresh.picked()))),
            h('p', { class: 'hint' }, 'Credentials are encrypted and stay on your PigeonBox server. The extension never receives them.'),
          )
        : data.accounts.length >= data.maxAccounts
          ? h('p', { class: 'hint' }, `You can connect up to ${plural(data.maxAccounts, 'account')}.`)
          : null,
    );
  };
  await draw();
  if (justConnected && !landing.celebrated) {
    // One arrival moment, on the newest route, the first time this page opens after Google.
    landing.celebrated = true;
    setTimeout(() => celebrate([...root.querySelectorAll('.route-card')].at(-1), { state: 'parcel', text: 'Linked', small: 'Gmail' }), 450);
  }
  // Keep sync health current while the first sync runs.
  if (justConnected) {
    let rounds = 0;
    const timer = setInterval(async () => {
      rounds += 1;
      if (!root.isConnected || rounds > 20) return clearInterval(timer);
      await draw().catch(() => undefined);
    }, 6_000);
  }
  return root;
}
