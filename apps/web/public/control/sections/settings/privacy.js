import { button, confirmDialog, h, manifest, settings, toast } from '../../ui.js';

/** Local privacy: where data lives, and clearing local data. */
export async function render({ ext }) {
  return [
    settings(
      { index: '01', title: 'Where your data is', text: 'In Local mode, mail content leaves this browser only for an AI provider you set up.' },
      manifest([
        ['On this computer', 'Your mail index, settings, drafts and downloaded models stay in this browser.'],
        ['AI provider', 'Only when you set one up, the email content a request needs is sent to that provider.'],
        ['Your PigeonBox server', 'Only after you switch to server mode. This page then shows what your server keeps.'],
        ['Tracking', 'Opens and clicks are recorded by the tracker you set up.'],
      ]),
    ),
    settings(
      { index: '02', title: 'Clear local data', text: 'Your settings are kept.' },
      h(
        'div',
        { class: 'row' },
        button('Clear local mail index…', async () => {
          const ok = await confirmDialog({ title: 'Clear the mail index on this computer?', body: 'PigeonBox rebuilds it as you use Gmail. Server data and your settings are unaffected.', confirm: 'Clear index', danger: true });
          if (!ok) return;
          await ext('ACTION', { action: 'clear_index' });
          toast('Local mail index cleared.', 'success');
        }, { variant: 'danger-ghost', busy: 'Clearing…' }),
        button('Clear AI cache', async () => {
          await ext('ACTION', { action: 'clear_ai_cache' });
          toast('AI cache cleared.', 'success');
        }, { variant: 'ghost', busy: 'Clearing…' }),
      ),
    ),
  ];
}
