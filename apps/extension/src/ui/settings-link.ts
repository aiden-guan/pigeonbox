import { trackProductEvent } from './analytics';

export type SettingsSource = 'workspace_header' | 'command_palette';

/**
 * Opens PigeonBox Settings, which live on the dashboard. The worker reuses a
 * dashboard tab that is already open.
 */
export function openSettings(source: SettingsSource, mode: 'local' | 'cloud') {
  trackProductEvent('settings_opened', { surface: 'workspace', mode, source });
  void Promise.resolve(chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'general' })).catch(() => undefined);
}
