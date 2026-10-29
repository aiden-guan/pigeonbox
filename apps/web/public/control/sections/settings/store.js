// Shared by the Settings pages: read the extension's settings and save
// changes back. Secrets never come back from the extension; it only says
// whether one is set. When a saved address (tracker, AI provider) needs a new
// Chrome permission, the extension opens its own window to ask for it.
// Changes are also saved to the signed-in account (lib/settings-sync.js).
import { button, notice } from '../../ui.js';
import { remember } from '../../../lib/settings-sync.js';

/** { settings, rules, missingOrigins, product } from the extension. */
export const load = (ext) => ext('GET_SETTINGS');

/** Save a partial settings object. Resolves to the saved settings view. */
export async function save(ext, patch) {
  const reply = await ext('SAVE_SETTINGS', { settings: patch });
  remember(patch);
  if (reply.missingOrigins?.length) await ext('GRANT', { origins: reply.missingOrigins });
  return reply.settings;
}

/** Saves one setting; for toggle(). */
export const saveOne = (ext, key) => (value) => save(ext, { [key]: value });

/** A notice when settings need Chrome access PigeonBox does not have yet. */
export function accessNotice(ext, origins) {
  if (!origins?.length) return null;
  return notice({
    tone: 'warn',
    label: 'Chrome access',
    title: 'PigeonBox needs permission to reach a site you set up',
    text: `${origins.map((origin) => origin.replace(/\/\*$/, '')).join(', ')}. Until you allow it, that setting does not work.`,
    actions: [button('Allow access', () => ext('GRANT', { origins }), { busy: 'Opening…' })],
  });
}

const AI_DESTINATION = {
  none: 'AI is off. Nothing is sent to an AI provider.',
  this_device: 'Runs on this computer. Mail is not sent to an AI provider.',
  your_provider: 'The email content a request needs is sent to the provider you configured.',
  chatgpt_web: 'The email content a request needs is sent to ChatGPT through your signed-in session.',
  pigeonbox_cloud: 'Email content is processed by your PigeonBox server.',
};
export const aiDestination = (product) => AI_DESTINATION[product.aiDestination] ?? AI_DESTINATION.none;

const PROVIDERS = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', 'openai-compatible': 'OpenAI-compatible provider', ollama: 'Ollama on this computer', chatgpt: 'ChatGPT (experimental)', chrome: 'Chrome’s built-in AI', local: 'Downloaded model' };
export function aiProviderLabel(settings) {
  if (settings.aiMode === 'disabled') return 'Off';
  return PROVIDERS[settings.aiProvider] ?? settings.aiProvider;
}
