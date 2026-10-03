import { trackProductEvent } from './analytics';

export type SettingsSource = 'workspace_header' | 'command_palette';

/**
 * Opens PigeonBox Settings (the extension options page). Chrome focuses an
 * options tab that is already open instead of opening a duplicate.
 */
export function openSettings(source: SettingsSource, mode: 'local' | 'cloud') {
  trackProductEvent('settings_opened', { surface: 'workspace', mode, source });
  void Promise.resolve(chrome.runtime.openOptionsPage()).catch(() => undefined);
}
