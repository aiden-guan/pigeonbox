import { API_BASE, linkRedirectUri, restoreExtensionAccount, startSignIn } from '../../lib/session.js';
import { INSTALL_URL } from '../../lib/extension.js';
import { arrowLink, button, checkbox, h, link, note, notice, pill, surface } from '../ui.js';
import { clearIntent, readIntent, writeIntent } from '../setup-intent.js';
import { capabilityHint, serverHost } from '../shared.js';

const SIGNED_IN = new Set(['ready', 'not_entitled', 'unreachable']);
const apiOrigin = () => API_BASE || location.origin;
const sameEmail = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NO_ACCESS = 'This server gives your account no features. Ask whoever runs it to add your address to ALLOWED_EMAILS.';

/**
 * Using your PigeonBox server is one path, always in the same order:
 * 1. sign in to your account on this server, 2. install PigeonBox (only when
 * it is missing or cannot use a server), 3. turn server mode on in this
 * browser, 4. connect Gmail. Each step opens only when the one before it is
 * done, and coming back from sign-in lands here. There is nothing to buy:
 * every account the server allows gets everything the server is set up for.
 * The installed extension receives its own PKCE-bound session without another login.
 */
export async function render(ctx) {
  const { api, ext, extension, me } = ctx;
  const status = h('p', { class: 'hint', attrs: { role: 'status' } });

  if (ctx.accountError) return notice({
    tone: 'warn', label: 'Try again', title: 'Your PigeonBox account could not be loaded',
    text: 'Your sign-in is saved. Check your connection and retry to load your account on this server.',
    actions: [button('Retry account connection', () => ctx.reload())],
  });
  if (extension?.apiBaseUrl && new URL(extension.apiBaseUrl).origin !== apiOrigin()) {
    return notice({
      tone: 'bad',
      label: 'Different server',
      title: 'PigeonBox in this browser uses another server',
      text: `This dashboard belongs to ${apiOrigin()}, but PigeonBox is set up for ${new URL(extension.apiBaseUrl).origin}. Open Settings from PigeonBox to reach its own dashboard.`,
    });
  }

  let product = extension?.product ?? null;
  const installed = Boolean(product?.cloudAvailable);
  const intent = readIntent();
  const consented = product?.runMode === 'cloud' || Boolean(me && intent?.userId === me.user.id);
  const matchingAccount = Boolean(me && product && (extension.account ? extension.account.id === me.user.id : sameEmail(product.cloud.email, me.user.email)));
  const linked = Boolean(product && SIGNED_IN.has(product.cloud.status) && matchingAccount);
  const otherAccount = Boolean(product && SIGNED_IN.has(product.cloud.status) && me && product.cloud.email && !matchingAccount);
  const allowed = Boolean(me && ctx.caps.size);
  const switched = product?.runMode === 'cloud';

  const allowServer = async () => {
    const origins = product.cloudOrigins ?? [];
    if (!origins.length || (await ext('CHECK_ORIGINS', { origins })).granted) return;
    const grant = await ext('GRANT', { origins });
    if (grant.granted) return;
    status.textContent = 'Click Allow in the PigeonBox window so this browser can reach your server.';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(1_000);
      if ((await ext('CHECK_ORIGINS', { origins })).granted) return;
    }
    throw new Error('Access to your server was not allowed. Click Turn on server mode to try again.');
  };
  const finishSwitch = async () => {
    if (!me) throw new Error('Sign in to your account on this server first.');
    if (!allowed) throw new Error(NO_ACCESS);
    if (!agree.querySelector('input').checked) throw new Error('Tick the box to agree first.');
    writeIntent(me.user.id);
    await allowServer();
    if (!linked) {
      status.textContent = 'Connecting PigeonBox in this browser to your server…';
      const begin = await ext('LINK_BEGIN', { redirectUri: linkRedirectUri() });
      const reply = await api('/v1/auth/link', { method: 'POST', body: {
        redirect_uri: linkRedirectUri(), code_challenge: begin.codeChallenge,
        code_challenge_method: 'S256', state: begin.state,
      } });
      if (reply.state !== begin.state) throw new Error('Your account connection could not be verified. Try again.');
      const connected = await ext('LINK_COMPLETE', { code: reply.code, state: reply.state });
      if (connected.user?.id !== me.user.id) throw new Error('PigeonBox connected a different account. Try again.');
      product = connected.product ?? product;
    }
    const refreshed = await ext('REFRESH');
    product = refreshed.product ?? product;
    if (product.cloud.status !== 'ready') throw new Error(product.cloud.status === 'unreachable'
      ? 'This browser could not reach your server. Check your connection and try again.'
      : 'Your server has not given this account access yet. Check that your address is in its ALLOWED_EMAILS, then try again.');
    await ext('SET_RUN_MODE', { mode: 'cloud', consent: true });
    clearIntent();
    status.textContent = '';
    ctx.toast('PigeonBox now runs on your server.', 'success');
    history.replaceState(null, '', ctx.caps.has('cloud_mail_sync') ? '#connections' : '#account');
    await ctx.reload();
  };
  const agree = checkbox('I understand that email content is sent to my PigeonBox server for processing.', consented);

  if (switched && linked && allowed) {
    const mail = ctx.caps.has('cloud_mail_sync');
    return surface(
      'card',
      { eyebrow: 'Mode', title: 'PigeonBox runs on your server', meta: `Account: ${me.user.email}` },
      h('p', { class: 'muted' }, mail
        ? 'Connect the Gmail account you want your server to work with. It can be different from your PigeonBox account.'
        : `${capabilityHint('cloud_mail_sync')} Until then, PigeonBox uses the server for AI and tracking while Gmail is open.`),
      h('div', { class: 'row' }, mail ? link('Set up your email', '#connections', { class: 'btn btn-primary' }) : null, link('Account & server', '#account', { class: mail ? 'btn btn-ghost' : 'btn btn-primary' })),
    );
  }

  // The dashboard and the extension can be signed in as different accounts on this server.
  const reuseExtensionAccount = extension?.accountLink && extension.account && me && extension.account.id !== me.user.id && product?.cloud.status === 'ready'
    ? button(`Continue as ${extension.account.email}`, async () => {
      await restoreExtensionAccount(extension, ext, { replace: true });
      await ctx.reload();
    }, { variant: 'ghost' })
    : null;

  const steps = [
    {
      title: 'Sign in',
      done: Boolean(me),
      summary: me ? me.user.email : `Your account on ${serverHost()}. Any address the server allows works; the server can read a different Gmail later.`,
      body: () => [
        h('p', { class: 'muted' }, 'Sign in to create or open your account on this PigeonBox server.'),
        h('div', { class: 'row' }, button('Sign in', () => startSignIn(status, '#cloud'), { busy: 'Opening sign-in…' })),
        status,
      ],
    },
    ...(installed ? [] : [{
      title: product ? 'Update PigeonBox' : 'Install PigeonBox',
      done: false,
      summary: 'Your server works through the PigeonBox extension in Gmail.',
      body: () => [
        h('p', { class: 'muted' }, product
          ? 'This build of PigeonBox has no server address, so it can’t use this server. Build it again with this server’s address, following the install instructions, then reload this page.'
          : 'Add PigeonBox to Chrome and point it at this server (the install instructions show how), then come back to this page. Your account is already saved.'),
        h('div', { class: 'row' },
          arrowLink('How to install PigeonBox', INSTALL_URL, { target: '_blank', rel: 'noopener' }),
          button('I’ve installed it', () => location.reload(), { variant: 'ghost' })),
      ],
    }]),
    {
      title: 'Turn on server mode',
      done: Boolean(installed && switched && linked && allowed),
      summary: 'PigeonBox keeps running on this computer until you turn server mode on.',
      body: () => [
        me && !allowed ? note(NO_ACCESS, 'warn') : null,
        otherAccount ? note(`PigeonBox in this browser is connected to this server as ${product.cloud.email}. Turning on server mode here uses ${me.user.email} instead.`, 'warn') : null,
        reuseExtensionAccount,
        h('p', { class: 'muted' }, `Email content used for summaries, sorting, drafts and answers is sent over an encrypted connection to your PigeonBox server at ${serverHost()} and the AI provider it is set up with. The server stores encrypted summaries, prepared drafts and related intelligence. Keeping message excerpts is a separate opt-in.`),
        agree,
        h('div', { class: 'row' }, button('Turn on server mode', finishSwitch, { busy: 'Connecting…' })),
        status,
      ],
    },
    {
      title: 'Connect your email',
      done: false,
      summary: 'Choose the Gmail account your server should work with. It can be different from your PigeonBox account.',
      body: () => [],
    },
  ];
  const current = steps.findIndex((step) => !step.done);
  return [
    h('ol', { class: 'setup-steps' }, steps.map((step, index) => h(
      'li',
      { class: ['setup-step', step.done ? 'is-done' : index === current ? 'is-current' : 'is-later'], attrs: { 'aria-current': index === current ? 'step' : null } },
      h('div', { class: 'setup-step-head' }, h('span', { class: 'setup-step-n', attrs: { 'aria-hidden': 'true' } }, String(index + 1).padStart(2, '0')), h('h2', {}, step.title), step.done ? pill('Done', 'good') : null),
      step.summary && index !== current ? h('p', { class: 'hint setup-step-summary' }, step.summary) : null,
      index === current ? h('div', { class: 'setup-step-body' }, step.body()) : null,
    ))),
    me && current > 0 ? h('p', { class: 'hint' }, `Signed in as ${me.user.email}.`) : null,
  ];
}
