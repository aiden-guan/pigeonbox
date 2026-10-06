import { useEffect, useState } from 'react';
import { IconButton } from './Primitives';
export type Appearance = 'system' | 'light' | 'dark';
export const APPEARANCE_KEY = 'pigeonboxAppearance';
export const normalizeAppearance = (value: unknown): Appearance => value === 'light' || value === 'dark' ? value : 'system';
export function watchAppearance(apply: (value: Appearance) => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) { apply('system'); return () => undefined; }
  let live = true;
  if (typeof location !== 'undefined' && location.protocol !== 'chrome-extension:') {
    // Gmail's isolated script has no access to trusted extension storage. Only
    // presentation metadata crosses this already-allowlisted worker bridge.
    void chrome.runtime.sendMessage({ type: 'GET_WORKSPACE_PRESENTATION' }).then((result) => { if (live) apply(normalizeAppearance(result?.appearance)); }).catch(() => { if (live) apply('system'); });
    const changed = (message: { type?: string; appearance?: unknown }) => { if (live && message.type === 'WORKSPACE_APPEARANCE_CHANGED') apply(normalizeAppearance(message.appearance)); };
    chrome.runtime.onMessage.addListener(changed);
    return () => { live = false; chrome.runtime.onMessage.removeListener(changed); };
  }
  void chrome.storage.local.get(APPEARANCE_KEY).then((stored) => { if (live) apply(normalizeAppearance(stored[APPEARANCE_KEY])); });
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && changes[APPEARANCE_KEY]) apply(normalizeAppearance(changes[APPEARANCE_KEY].newValue)); };
  chrome.storage.onChanged.addListener(changed);
  return () => { live = false; chrome.storage.onChanged.removeListener(changed); };
}
/**
 * Swap the theme in one frame. Color transitions are suspended for the swap,
 * so hundreds of elements don't each animate to the new palette at once.
 */
export function applyTheme(target: HTMLElement, value: Appearance) {
  if (target.dataset.pbTheme === value) return;
  const scope = target.shadowRoot ?? target.ownerDocument.head;
  const freeze = target.ownerDocument.createElement('style');
  freeze.textContent = '*,*::before,*::after{transition:none!important}';
  scope.append(freeze);
  target.dataset.pbTheme = value;
  void target.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => freeze.remove()));
}
export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>('system');
  useEffect(() => watchAppearance((value) => { applyTheme(document.documentElement, value); setAppearance(value); }), []);
  const change = (value: Appearance) => {
    applyTheme(document.documentElement, value);
    setAppearance(value);
    // Inside Gmail's floating shell, let the frame around us switch now rather than after the storage round trip.
    if (window.parent !== window) window.parent.postMessage({ type: 'PB_APPEARANCE', appearance: value }, '*');
    void chrome.storage.local.set({ [APPEARANCE_KEY]: value });
  };
  return { appearance, change };
}
export function AppearanceButton() {
  const { appearance, change } = useAppearance();
  const next = appearance === 'system' ? 'light' : appearance === 'light' ? 'dark' : 'system';
  return <IconButton label={`Appearance: ${appearance}. Switch to ${next}`} onClick={() => change(next)}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="7" /><path d="M12 5v14a7 7 0 0 0 0-14Z" fill="currentColor" stroke="none" /></svg>
  </IconButton>;
}
