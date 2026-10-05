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

/** The Gmail account the panel's Gmail tab is signed in to, whether or not a thread is open. */
export function useWorkspaceMailbox(): MailboxIdentity | null {
  const [mailbox, setMailbox] = useState<MailboxIdentity | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void chrome.runtime
        .sendMessage({ type: 'GET_WORKSPACE_CONTEXT' })
        .then((result) => {
          const next = (result?.mailbox as MailboxIdentity | null | undefined) ?? null;
          if (active) setMailbox((current) => (current?.email === next?.email ? current : next));
        })
        .catch(() => undefined);
    refresh();
    const change = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && (changes.workspaceMailboxes || changes.workspaceContextActive)) refresh();
    };
    chrome.storage.onChanged.addListener(change);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(change);
    };
  }, []);
  return mailbox;
}
