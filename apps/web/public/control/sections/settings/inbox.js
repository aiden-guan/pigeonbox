import { button, checkbox, field, h, input, note, select, settings, toast, toggle } from '../../ui.js';
import { load, save, saveOne } from './store.js';

const CATEGORIES = [
  ['RESPOND', 'Respond'],
  ['WAITING', 'Waiting'],
  ['FYI', 'FYI'],
  ['NOTIFICATIONS', 'Notifications'],
  ['PROMOTIONS', 'Promotions'],
  ['NEWS', 'News'],
];

/** What the extension does in Gmail. Local mode adds on-device drafts, reminders and archiving. */
export async function render({ ext, mode }) {
  const { settings: s } = await load(ext);
  const one = (key) => saveOne(ext, key);

  const gmail = settings(
    { index: '01', title: 'In Gmail', text: mode === 'cloud' ? 'How the extension shows your server’s work inside Gmail.' : 'PigeonBox works while Gmail is open in this browser.' },
    toggle('Organize inbox automatically', s.autoClassify, one('autoClassify'), 'Sorts conversations into Respond, Waiting, FYI and more.'),
    mode === 'local' ? toggle('Summarize conversations', s.autoSummarize, one('autoSummarize')) : null,
    toggle('Desktop alerts', s.desktopNotifications, one('desktopNotifications'), 'Opens, replies due and approvals.'),
    toggle('Command palette (⌘/Ctrl K)', s.commandPaletteEnabled, one('commandPaletteEnabled')),
    toggle('Command palette overrides Gmail shortcuts', s.commandPaletteOverrideGmail, one('commandPaletteOverrideGmail')),
  );

  if (mode === 'cloud') {
    return [
      gmail,
      note('Background drafts, follow-up timing and briefings are server settings: see Sync & routines.', 'info'),
    ];
  }

  const days = input({ type: 'number', min: 1, max: 30, value: s.reminderBusinessDays });
  const reminderMode = select([['ai_needed', 'When a reply looks needed'], ['every_external', 'For every email to someone outside'], ['disabled', 'Never']], s.reminderMode);
  const drafts = settings(
    { index: '02', title: 'Drafts & follow-ups', text: 'Drafts stay on this computer until you add them to Gmail. Nothing is ever sent for you.' },
    toggle('Generate reply drafts', s.autoDraft, one('autoDraft')),
    toggle('Put generated drafts into Gmail automatically', s.autoInsertDraft, one('autoInsertDraft')),
    toggle('Follow-up reminders', s.autoReminders, one('autoReminders')),
    h('div', { class: 'grid-2' }, field('Remind me', reminderMode), field('After (business days)', days)),
    h('div', { class: 'row' }, button('Save reminders', async () => {
      const value = Number(days.value);
      if (!Number.isInteger(value) || value < 1 || value > 30) throw new Error('Choose between 1 and 30 business days.');
      await save(ext, { reminderMode: reminderMode.value, reminderBusinessDays: value });
      toast('Reminders saved.', 'success');
    }, { variant: 'ghost', busy: 'Saving…' })),
  );

  const categories = CATEGORIES.map(([value, label]) => checkbox(label, s.archiveCategories.includes(value), { value }));
  const threshold = input({ type: 'number', min: 0.5, max: 1, step: 0.01, value: s.archiveConfidenceThreshold });
  const archive = settings(
    { index: '03', title: 'Auto archive', text: 'Low-priority mail can leave the inbox on its own. It is archived, never deleted.' },
    toggle('Archive low-priority mail automatically', s.autoArchive, one('autoArchive')),
    h('p', { class: 'eyebrow kinds-label' }, 'Categories to archive'),
    h('div', { class: 'checks two', attrs: { role: 'group', 'aria-label': 'Categories to archive' } }, categories),
    field('Only when PigeonBox is at least this sure (0.5–1)', threshold),
    h('div', { class: 'row' }, button('Save archive rules', async () => {
      const value = Number(threshold.value);
      if (!(value >= 0.5 && value <= 1)) throw new Error('Choose a confidence between 0.5 and 1.');
      await save(ext, { archiveCategories: categories.filter((row) => row.querySelector('input').checked).map((row) => row.querySelector('input').value), archiveConfidenceThreshold: value });
      toast('Archive rules saved.', 'success');
    }, { variant: 'ghost', busy: 'Saving…' })),
  );

  return [gmail, drafts, archive];
}
