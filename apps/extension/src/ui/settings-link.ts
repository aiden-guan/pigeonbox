/**
 * Opens PigeonBox Settings: on your PigeonBox server's dashboard when this
 * build can reach it (the worker reuses a dashboard tab that is already open),
 * otherwise the Settings page inside the extension.
 */
export function openSettings() {
  void Promise.resolve(chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'general' })).catch(() => undefined);
}
