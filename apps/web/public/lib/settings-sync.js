// The extension's settings follow the PigeonBox account. Every change made on
// the dashboard is also saved to the account, and when this browser's
// extension turns out to be a fresh install (its storage is wiped on
// reinstall), the saved settings are put back. Secrets (AI provider keys,
// tracker tokens) are never read from the extension, so they are never saved
// here; they have to be entered again after a reinstall.
//
// The extension remembers which account it last matched (HELLO's
// `settingsSync`). Builds from before this existed do not say, so for them
// changes are saved but nothing is restored.

/** Settings the dashboard can change, minus secrets. Mirrors EDITABLE in the extension's web bridge. */
const KEYS = [
  'trackingEnabled', 'trackOpens', 'trackLinks', 'desktopNotifications', 'hideSuspectedSelfOpens', 'trackerBaseUrl',
  'aiMode', 'aiProvider', 'aiModel', 'aiEndpoint',
  'autoClassify', 'autoSummarize', 'autoDraft', 'autoInsertDraft', 'autoReminders', 'autoArchive',
  'archiveCategories', 'archiveConfidenceThreshold', 'alwaysArchiveSenders', 'neverArchiveSenders',
  'reminderMode', 'reminderBusinessDays', 'commandPaletteEnabled', 'commandPaletteOverrideGmail', 'voiceProfile', 'learnFromSent',
];
const SAVE = '/v1/control/extension-settings/save';

let target = null;

const pick = (settings) => Object.fromEntries(KEYS.filter((key) => settings?.[key] !== undefined).map((key) => [key, settings[key]]));

/** Who to save for: the signed-in account and this browser's extension. Either missing turns syncing off. */
export function configure({ api, ext, userId, extension }) {
  target = api && userId && extension ? { api, ext, userId } : null;
}

/** After a change saved in the extension. Runs in the background and never fails the save. */
export function remember(patch, rules) {
  if (!target) return;
  const settings = pick(patch);
  if (!Object.keys(settings).length && !rules) return;
  void target.api(SAVE, { method: 'POST', body: { settings, ...(rules ? { rules } : {}) } }).catch(() => undefined);
}

/**
 * On load: put the account's settings back after a reinstall, or start the
 * account's copy from this install. Resolves to 'restored', 'saved' or null.
 */
export async function reconcile(hello) {
  if (!target || !hello) return null;
  const knowsSync = 'settingsSync' in hello;
  if (knowsSync && hello.settingsSync?.userId === target.userId) return null;
  const { backup } = await target.api('/v1/control/extension-settings');
  if (backup && !knowsSync) return null;
  if (backup) {
    const patch = pick(backup.settings);
    // Chrome access for a tracker or AI provider is asked for on the pages that need it, not in a popup on load.
    if (Object.keys(patch).length) await target.ext('SAVE_SETTINGS', { settings: patch });
    if (backup.rules) await target.ext('SAVE_RULES', { lines: backup.rules });
    await target.ext('SETTINGS_SYNCED', { userId: target.userId });
    return 'restored';
  }
  const { settings, rules } = await target.ext('GET_SETTINGS');
  await target.api(SAVE, { method: 'POST', body: { settings: pick(settings), rules: rules ?? [], replace: true } });
  if (knowsSync) await target.ext('SETTINGS_SYNCED', { userId: target.userId });
  return 'saved';
}
