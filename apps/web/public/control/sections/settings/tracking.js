import { button, field, h, input, note, settings, toast, toggle } from '../../ui.js';
import { accessNotice, load, save, saveOne } from './store.js';

/** Open and click tracking. Local mode uses a tracker you host; server mode uses your server's. */
export async function render({ ext, mode, rerender }) {
  const { settings: s, missingOrigins, product } = await load(ext);
  const one = (key) => saveOne(ext, key);

  const prefs = settings(
    { index: '01', title: 'What to track', text: 'Reader attribution is approximate. Your own opens are hidden.' },
    toggle('Email tracking', s.trackingEnabled, one('trackingEnabled'), 'Adds a tracking image to mail you send from Gmail.'),
    toggle('Track opens', s.trackOpens, one('trackOpens')),
    toggle('Track link clicks', s.trackLinks, one('trackLinks')),
    toggle('Hide opens that look like my own', s.hideSuspectedSelfOpens, one('hideSuspectedSelfOpens')),
  );

  if (mode === 'cloud') {
    const { granted } = product.cloudOrigins?.length ? await ext('CHECK_ORIGINS', { origins: product.cloudOrigins }) : { granted: true };
    return [
      granted ? null : accessNotice(ext, product.cloudOrigins),
      prefs,
      note(product.capabilities.includes('cloud_tracking') ? 'Your PigeonBox server hosts your tracker. Opens and clicks show in Gmail and in PigeonBox notifications.' : 'Hosted tracking is not available for your account on this server, so mail you send is not tracked while PigeonBox runs on the server.', product.capabilities.includes('cloud_tracking') ? 'info' : 'warn'),
    ];
  }

  const base = input({ type: 'url', value: s.trackerBaseUrl, placeholder: 'https://your-tracker.example', autocomplete: 'off' });
  const token = input({ type: 'password', value: '', placeholder: s.hasPersonalApiToken ? 'Saved. Type a new token to replace it' : 'Personal API token', autocomplete: 'off' });
  const tracker = settings(
    { index: '02', title: 'Your tracker', text: 'Recipient opens need a public tracker you own: the guided install sets one up on Convex, or use Cloudflare Worker + Supabase. A tracker running only on this computer cannot see recipients’ opens.' },
    field('Tracker address', base),
    field('Personal API token', token, 'Stored in PigeonBox on this computer. This page never shows it again.'),
    h(
      'div',
      { class: 'row' },
      button('Save tracker', async () => {
        const value = base.value.trim().replace(/\/+$/, '');
        if (value && !/^https:\/\/[^\s/]+|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(value)) throw new Error('Use an https:// address, or http://localhost for a tracker on this computer.');
        await save(ext, { trackerBaseUrl: value, ...(token.value.trim() ? { personalApiToken: token.value.trim() } : {}) });
        toast('Tracker saved.', 'success');
        await rerender();
      }, { busy: 'Saving…' }),
      s.hasPersonalApiToken
        ? button('Remove token', async () => {
          await save(ext, { personalApiToken: '' });
          toast('Token removed.', 'success');
          await rerender();
        }, { variant: 'ghost', busy: 'Removing…' })
        : null,
    ),
    h('p', { class: 'hint' }, 'Self-hosting guides for Convex and Cloudflare Worker + Supabase are in the PigeonBox repository under docs/.'),
  );

  return [accessNotice(ext, missingOrigins), prefs, tracker];
}
