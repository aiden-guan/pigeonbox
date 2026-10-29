import { signOut } from '../../lib/session.js';
import { button, confirmDialog, eyebrow, h, manifest, surface, tag, usageMeter } from '../ui.js';
import { SERVER_FEATURES, serverHost, serverOrigin } from '../shared.js';

/**
 * Your account on this PigeonBox server and what the server is set up to do.
 * There are no plans: every account the server allows gets every feature its
 * configuration supports, so a missing feature names the setting it needs.
 */
export async function render({ api }) {
  const [me, entitlements, version] = await Promise.all([
    api('/v1/me'),
    api('/v1/account/entitlements'),
    api('/v1/version').catch(() => null),
  ]);
  const on = new Set(entitlements.capabilities);
  const features = Object.entries(SERVER_FEATURES);
  const ready = features.filter(([capability]) => on.has(capability));
  const missing = features.filter(([capability]) => !on.has(capability));

  const receipt = surface(
    'card',
    { className: 'receipt' },
    eyebrow('Server'),
    h('p', { class: 'receipt-plan' }, serverHost()),
    h('p', { class: 'receipt-price' }, 'Self-hosted PigeonBox server'),
    manifest([
      ['Account', me.user.email || me.user.id],
      ['Address', serverOrigin()],
      version?.version ? ['Version', `v${version.version}`] : null,
      ['Features', `${ready.length} of ${features.length} set up`],
    ]),
  );

  const usage = on.has('cloud_ai') ? usageMeter(entitlements.usage, entitlements.limits) : null;
  const offered = surface(
    'ledger',
    { title: 'What this server offers', actions: tag(`${ready.length} on`, ready.length ? 'copper' : null) },
    ready.length
      ? h('ul', { class: 'services' }, ready.map(([, [label]]) => h('li', {}, label)))
      : h('p', { class: 'muted' }, 'This server gives your account no features. Ask whoever runs it to add your address to ALLOWED_EMAILS.'),
  );
  const notSetUp = missing.length
    ? surface(
        'ledger',
        { title: 'Not set up on this server', actions: tag(`${missing.length} off`) },
        h('ul', { class: 'services services-off' }, missing.map(([, [label, hint]]) => h('li', {}, h('span', {}, h('strong', {}, label), h('span', { class: 'hint' }, hint))))),
      )
    : null;

  const danger = surface(
    'card',
    { eyebrow: 'Cannot be undone', title: 'Delete account', className: 'danger-zone' },
    h('p', { class: 'muted' }, 'Deletes your account on this PigeonBox server with everything it keeps for you: synced mail data, hosted tracking data and usage records. Local PigeonBox data in your browser is not affected.'),
    h(
      'div',
      { class: 'row' },
      button('Delete account…', async () => {
        const phrase = 'delete my account';
        const ok = await confirmDialog({ title: 'Delete your account on this server?', body: 'This cannot be undone.', confirm: 'Delete account', danger: true, typed: phrase });
        if (!ok) return;
        await api('/v1/account/delete', { method: 'POST', body: { confirm: phrase } });
        await signOut();
        location.replace('/dashboard');
      }, { variant: 'danger-ghost', busy: 'Deleting…' }),
    ),
  );

  return [
    h('div', { class: 'ledger-layout' }, receipt, h('div', { class: 'stack' }, usage ? surface('ledger', { title: 'Usage' }, usage) : null, offered)),
    notSetUp,
    danger,
  ];
}
