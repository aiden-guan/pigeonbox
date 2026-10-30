import { button, checkbox, field, h, input, select, settings, textarea, toast, toggle } from '../../ui.js';
import { load, save, saveOne } from './store.js';

/** Who drafts come from and how they sound. In server mode the extension copies this to your server. */
export async function render({ ext, mode }) {
  const { settings: s } = await load(ext);
  const v = s.voiceProfile;

  const name = input({ value: v.name, placeholder: 'Alex', autocomplete: 'given-name', maxLength: 80 });
  const about = input({ value: v.about, placeholder: 'CS student at UC Berkeley', maxLength: 160 });
  const greeting = input({ value: v.greeting, placeholder: 'Hi', maxLength: 40 });
  const signoff = input({ value: v.signoff, placeholder: 'Thanks', maxLength: 40, attrs: { list: 'signoffs' } });
  const formality = select([['casual', 'Casual'], ['neutral', 'Neutral'], ['formal', 'Formal']], v.formality);
  const concision = select([['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']], v.concision);
  const capitalization = select([['normal', 'As usual'], ['sentence', 'Sentence case'], ['title', 'Title case']], v.capitalization);
  const emoji = checkbox('Emoji are fine', v.emoji);
  const scheduling = input({ value: v.schedulingPreference, placeholder: 'Afternoons work best; 30-minute calls', maxLength: 200 });
  const instructions = textarea({ value: v.personalInstructions, rows: 4, maxLength: 2000, placeholder: 'Never promise dates. Mention I’m on Pacific time.' });

  const saveVoice = button('Save voice', async () => {
    await save(ext, {
      voiceProfile: {
        ...v,
        name: name.value.trim(),
        about: about.value.trim(),
        greeting: greeting.value.trim() || 'Hi',
        signoff: signoff.value.trim() || 'Thanks',
        formality: formality.value,
        concision: concision.value,
        capitalization: capitalization.value,
        emoji: emoji.querySelector('input').checked,
        schedulingPreference: scheduling.value.trim(),
        personalInstructions: instructions.value.trim(),
      },
    });
    toast(mode === 'cloud' ? 'Voice saved and sent to your server.' : 'Voice saved.', 'success');
  }, { busy: 'Saving…' });

  return h(
    'form',
    { class: 'preferences', on: { submit: (event) => event.preventDefault() } },
    h('datalist', { id: 'signoffs' }, ['Thanks', 'Best', 'Best regards', 'Cheers'].map((value) => h('option', { value }))),
    settings({ index: '01', title: 'About you', text: 'Drafts are signed with your name.' }, h('div', { class: 'grid-2' }, field('Your name', name), field('About you', about, 'Optional. Helps drafts sound like you.')), h('div', { class: 'grid-2' }, field('Greeting', greeting), field('Sign-off', signoff))),
    settings({ index: '02', title: 'Tone' }, h('div', { class: 'grid-2' }, field('Formality', formality), field('Length', concision)), field('Capitalization', capitalization), emoji),
    settings({ index: '03', title: 'Instructions', text: 'Anything drafts should always or never do.' }, field('Scheduling preference', scheduling), field('Custom instructions', instructions)),
    mode === 'local' ? settings({ index: '04', title: 'Learning' }, toggle('Learn from mail I send', s.learnFromSent, saveOne(ext, 'learnFromSent'), 'Style only, kept on this computer.')) : null,
    h('div', { class: 'row sticky-actions' }, saveVoice, h('p', { class: 'hint' }, mode === 'cloud' ? 'Saved in PigeonBox and copied to your server for background drafts.' : 'Saved in PigeonBox on this computer.')),
  );
}
