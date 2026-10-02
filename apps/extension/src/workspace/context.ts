import { workspaceTab } from './display';
import { useEffect, useState } from 'react';
import type { MailboxIdentity } from '@pigeonbox/shared';
export type WorkspaceContext = { tabId: number; threadId: string; subject: string; sender?: string; owner?: MailboxIdentity; pending?: string | null; drafting?: boolean };
export function useWorkspaceContext() {
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => void chrome.runtime.sendMessage({ type: 'GET_WORKSPACE_CONTEXT' }).then((result) => { if (active) { setContext((current) => JSON.stringify(current) === JSON.stringify(result?.context || null) ? current : result?.context || null); if (typeof result?.tabId === 'number') workspaceTab(result.tabId, result.windowId); } });
    refresh();
    const change = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && (changes.workspaceContexts || changes.workspaceContextActive)) refresh();
    };
    chrome.storage.onChanged.addListener(change);
    return () => { active = false; chrome.storage.onChanged.removeListener(change); };
  }, []);
  return context;
}
