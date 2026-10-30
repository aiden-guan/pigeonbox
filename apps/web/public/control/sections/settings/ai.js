import { button, facts, h, note, settings, surface, toggle } from '../../ui.js';
import { accessNotice, aiDestination, aiProviderLabel, load, save } from './store.js';

let onReturn = null;
/** Pick up changes made on PigeonBox's setup page when the person comes back to this tab. */
function watchReturn(callback) {
  if (!onReturn) document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && onReturn?.());
  onReturn = callback;
}

/**
 * Local AI. Choosing a provider can mean downloading a model, signing in to
 * ChatGPT or granting Chrome access, which only an extension page can do, so
 * "Set up AI" opens PigeonBox's own setup page. Turning AI off happens here.
 */
export async function render({ ext, rerender }) {
  const { settings: s, missingOrigins, product } = await load(ext);
  const on = s.aiMode !== 'disabled';
  const openSetup = () => ext('ACTION', { action: 'open_ai_setup' });

  const current = surface(
    'card',
    { eyebrow: 'Current', title: aiProviderLabel(s), meta: on && s.aiModel ? s.aiModel : null },
    h('p', { class: 'muted' }, aiDestination(product)),
    h('div', { class: 'row' }, button(on ? 'Change AI setup' : 'Set up AI', openSetup, { busy: 'Opening PigeonBox…' })),
    h('p', { class: 'hint' }, 'Opens PigeonBox’s setup page in a new tab. Come back here when you are done; this page updates when you return.'),
  );

  const options = settings(
    { index: '01', title: 'Choices', text: 'All of these run while PigeonBox runs locally. In server mode, your PigeonBox server runs AI for you.' },
    facts([
      ['On this computer', 'Chrome’s built-in AI or a downloaded model. Nothing leaves this computer.'],
      ['Your provider', 'OpenAI, Anthropic, Gemini or an OpenAI-compatible endpoint with your own API key.'],
      ['Ollama', 'A model you run on this computer with Ollama.'],
    ]),
    on
      ? toggle('Use AI', true, async (value) => {
        if (value) return;
        await save(ext, { aiMode: 'disabled' });
        await rerender();
      }, 'Off: PigeonBox sorts with inbox rules and sends nothing to an AI provider.')
      : note('AI is off. PigeonBox sorts with inbox rules and sends nothing to an AI provider.', 'info'),
  );

  watchReturn(() => current.isConnected && rerender());
  return [accessNotice(ext, missingOrigins), current, options];
}
