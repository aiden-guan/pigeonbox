import { flushWorkspaceInput } from './session';
let target: { tabId: number; windowId?: number } | null = null;
export function workspaceTab(tabId: number, windowId?: number) { target = { tabId, windowId }; }
/** The open call is made synchronously inside the click's user gesture. */
export async function requestWorkspaceDisplay(display: 'float' | 'dock') {
  if (!target) return;
  if (display === 'dock') {
    const opened = chrome.sidePanel.open({ tabId: target.tabId });
    await opened;
    await flushWorkspaceInput();
    await chrome.runtime.sendMessage({ type: 'WORKSPACE_DISPLAY', display: 'dock' });
  } else {
    await flushWorkspaceInput();
    await chrome.runtime.sendMessage({ type: 'WORKSPACE_DISPLAY', display: 'float', open: true });
    const panel = chrome.sidePanel as typeof chrome.sidePanel & { close?: (options: { tabId: number }) => Promise<void> };
    if (panel.close) await panel.close({ tabId: target.tabId }).catch(() => undefined);
    else await chrome.sidePanel.setOptions({ tabId: target.tabId, enabled: false }).catch(() => undefined);
  }
}
