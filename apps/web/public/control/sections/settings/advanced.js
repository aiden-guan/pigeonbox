import { button, field, h, settings, textarea, toast } from '../../ui.js';
import { load, save } from './store.js';
import { remember } from '../../../lib/settings-sync.js';

const lines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
const emails = (value) => lines(value).map((line) => line.toLowerCase()).filter((line) => /^[^\s@]+@[^\s@]+$|^@?[a-z0-9.-]+\.[a-z]{2,}$/.test(line));

/** Local rules, sender lists, indexing and diagnostics. */
export async function render({ ext }) {
  const { settings: s, rules } = await load(ext);

  const ruleBox = textarea({ value: rules.join('\n'), rows: 5, placeholder: 'Archive newsletters from substack.com\nMark mail from my manager as Respond' });
  const always = textarea({ value: s.alwaysArchiveSenders.join('\n'), rows: 3, placeholder: 'news@example.com' });
  const never = textarea({ value: s.neverArchiveSenders.join('\n'), rows: 3, placeholder: 'boss@example.com' });
  const output = h('pre', { class: 'code-block', hidden: true });

  return [
    settings(
      { index: '01', title: 'Agent rules', text: 'Plain-language rules PigeonBox follows on this computer, one per line. Lines it cannot understand are skipped.' },
      field('Rules', ruleBox),
      h('div', { class: 'row' }, button('Save rules', async () => {
        const reply = await ext('SAVE_RULES', { lines: lines(ruleBox.value) });
        remember({}, reply.rules);
        ruleBox.value = reply.rules.join('\n');
        toast(`${reply.rules.length} rule${reply.rules.length === 1 ? '' : 's'} saved.`, 'success');
      }, { busy: 'Saving…' })),
    ),
    settings(
      { index: '02', title: 'Senders', text: 'One address or domain per line.' },
      h('div', { class: 'grid-2' }, field('Always archive', always), field('Never archive', never)),
      h('div', { class: 'row' }, button('Save senders', async () => {
        await save(ext, { alwaysArchiveSenders: emails(always.value), neverArchiveSenders: emails(never.value) });
        toast('Senders saved.', 'success');
      }, { variant: 'ghost', busy: 'Saving…' })),
    ),
    settings(
      { index: '03', title: 'Mail index', text: 'PigeonBox indexes mail as you read it. It can also go back 30 days through a background Gmail tab.' },
      h(
        'div',
        { class: 'row' },
        button('Index older messages', async () => {
          await ext('ACTION', { action: 'index_inbox' });
          toast('Indexing started in a background Gmail tab.', 'success');
        }, { variant: 'ghost', busy: 'Starting…' }),
        button('Pause indexing', () => ext('ACTION', { action: 'pause_index' }), { variant: 'ghost' }),
      ),
    ),
    settings(
      { index: '04', title: 'Diagnostics', text: 'A report of PigeonBox’s state on this computer, for troubleshooting.' },
      h('div', { class: 'row' }, button('Run diagnostics', async () => {
        const { result } = await ext('ACTION', { action: 'diagnostics' });
        output.textContent = [result?.trackingReport, JSON.stringify({ ...result, trackingReport: undefined }, null, 2)].filter(Boolean).join('\n\n');
        output.hidden = false;
      }, { variant: 'ghost', busy: 'Running…' })),
      output,
    ),
  ];
}
