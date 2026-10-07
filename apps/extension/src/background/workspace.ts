import { DEFAULT_WORKSPACE, workspaceState, type WorkspaceState } from '../workspace/state';
import { broadcastToGmailTabs } from './messaging';
let writes: Promise<unknown> = Promise.resolve();
export async function readWorkspace(): Promise<WorkspaceState> {
  const stored = await chrome.storage.local.get('workspaceState');
  if (stored.workspaceState) return workspaceState(stored.workspaceState);
  const legacy = await chrome.storage.session.get('panelState');
  return workspaceState(null, legacy.panelState);
}
export function updateWorkspace(patch: Partial<WorkspaceState>): Promise<WorkspaceState> {
  const operation = writes.then(async () => {
    const next = workspaceState({ ...await readWorkspace(), ...patch });
    await chrome.storage.local.set({ workspaceState: next });
    await broadcastToGmailTabs({ type: 'WORKSPACE_PRESENTATION_CHANGED', state: next });
    return next;
  });
  writes = operation.catch(() => undefined);
  return operation;
}
export async function showWorkspace(clicked?: chrome.tabs.Tab, toggle = false) {
  const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  const target = clicked?.url?.startsWith('https://mail.google.com/') ? clicked : [...tabs].sort((a, b) => Number(b.windowId === clicked?.windowId) - Number(a.windowId === clicked?.windowId) || Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0)).find((candidate) => !candidate.pinned) || tabs[0];
  const tab = target || await chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#inbox' });
  if (tab.id == null) return;
  if (target && clicked?.id !== tab.id) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  }
  const current = await readWorkspace();
  const same = Boolean(clicked?.id === tab.id && toggle && current.display === 'float');
  await updateWorkspace({ display: 'float', open: same ? !current.open : true });
  try { await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PIGEONBOX_WORKSPACE', open: same ? !current.open : true }); }
  catch {
    // The content script reads this intention when its shell becomes ready.
    await chrome.storage.session.set({ workspaceReopen: { tabId: tab.id } });
  }
}
export function installWorkspaceToolbar() {
  chrome.action.onClicked.addListener((tab) => { void showWorkspace(tab, true); });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.pigeonboxAppearance) {
      const value = changes.pigeonboxAppearance.newValue;
      const appearance = value === 'dark' || value === 'system' ? value : 'light';
      void broadcastToGmailTabs({ type: 'WORKSPACE_APPEARANCE_CHANGED', appearance });
    }
  });
  const panel = chrome.sidePanel as typeof chrome.sidePanel & { onClosed?: { addListener: (listener: () => void) => void } };
  panel.onClosed?.addListener(() => { void readWorkspace().then((state) => { if (state.display === 'dock') return updateWorkspace({ display: 'float', open: false }); }); });
}
export { DEFAULT_WORKSPACE };
