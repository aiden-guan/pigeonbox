import { trackProductEvent } from '../ui/analytics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './popup.css';
import { callCloud } from '../sidepanel/cloud-api';
import type { CloudOverview } from '@pigeonbox/api-contract';
import { useProductState } from '../ui/product-state';
import {
  CommandPalette,
  CommandLauncher,
  ConnectionFooter,
  InboxOverviewCard,
  OpenGmailButton,
  PopupHeader,
  QuickActions,
  type ConnectionStatus,
  type PopupCommand,
} from './PopupComponents';

type Diagnostics = {
  gmailTab?: string;
  runMode?: 'local' | 'cloud';
  indexedThreads?: number;
  currentThreadId?: string | null;
  ai?: {
    status?: string;
    provider?: string;
    model?: string;
    mode?: string;
    configurationStatus?: string;
  };
  tracking?: string;
};

type OnDeviceStatus = {
  qwenReady?: boolean;
  chromeAvailability?: string;
};

type LocalReadiness = 'checking' | 'ready' | 'idle' | 'unavailable' | null;
type PanelMode = 'inbox' | 'ask' | 'cloud';

export function PopupApp() {
  const product = useProductState();
  const [overview, setOverview] = useState<CloudOverview | null>(null);
  useEffect(() => { let mounted = true; if (product.state.runMode === 'cloud' && product.state.capabilities.includes('cloud_mail_sync')) void callCloud('cloudOverview', {}).then((result) => { if (mounted && result.ok) setOverview(result.data); }); return () => { mounted = false; }; }, [product.state.runMode, product.state.capabilities]);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [localReadiness, setLocalReadiness] = useState<LocalReadiness>(null);
  const [activeGmailTab, setActiveGmailTab] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const askButtonRef = useRef<HTMLButtonElement>(null);

  const refreshDiagnostics = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (response?: Diagnostics) => {
      if (chrome.runtime.lastError || !response) return;
      setDiag(response);
      const provider = response.ai?.provider;
      if (provider !== 'local' && provider !== 'chrome') {
        setLocalReadiness(null);
        return;
      }

      setLocalReadiness('checking');
      void chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })
        .then((contexts) => {
          if (!contexts.length) {
            setLocalReadiness('idle');
            return;
          }
          chrome.runtime.sendMessage(
            { type: 'ON_DEVICE_STATUS', provider, modelId: response.ai?.model },
            (status?: OnDeviceStatus) => {
              if (chrome.runtime.lastError || !status) {
                setLocalReadiness('unavailable');
              } else if (provider === 'local') {
                setLocalReadiness(status.qwenReady ? 'ready' : 'idle');
              } else {
                setLocalReadiness(status.chromeAvailability === 'available' ? 'ready' : 'idle');
              }
            },
          );
        })
        .catch(() => setLocalReadiness('unavailable'));
    });
  }, []);

  useEffect(() => {
    refreshDiagnostics();
  }, [refreshDiagnostics]);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return;
    void chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => setActiveGmailTab(Boolean(tab?.url?.startsWith('https://mail.google.com/'))))
      .catch(() => setActiveGmailTab(false));
  }, []);

  useEffect(() => {
    if (paletteOpen) return;
    const onShortcut = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      event.stopPropagation();
      trackProductEvent('command_palette_opened', { surface: 'popup' });
      setPaletteOpen(true);
      setActionError(null);
    };
    window.addEventListener('keydown', onShortcut, true);
    return () => window.removeEventListener('keydown', onShortcut, true);
  }, [paletteOpen]);

  const runMode = diag?.runMode ?? product.state.runMode;
  const ai = aiConnection(diag, runMode, localReadiness);
  const gmail = gmailConnection(diag);
  const tracker = trackerConnection(diag);
  const header = headerStatus(diag, gmail, ai, tracker);
  const aiEnabled = Boolean(diag?.ai?.status && diag.ai.status !== 'disabled' && !['error', 'missing_key', 'missing_permissions', 'not_signed_in'].includes(diag.ai.status));
  const hasActiveThread = Boolean(diag?.currentThreadId && activeGmailTab && gmail.tone === 'success' && aiEnabled);

  const openPanel = useCallback(async (mode: PanelMode, category = 'RESPOND', query?: string): Promise<void> => {
    setActionError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.windowId == null) throw new Error('Open a browser window to use this action.');
      const requestId = query ? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined;
      const stored = await chrome.storage.session.get('panelState');
      const current = (stored.panelState || {}) as { splitCategory?: string };
      const panelState: { mode: PanelMode; splitCategory: string; askQuery?: string; askRequestId?: string } = {
        mode,
        splitCategory: category || current.splitCategory || 'RESPOND',
      };
      if (mode === 'ask' && query?.trim() && requestId) {
        panelState.askQuery = query.trim();
        panelState.askRequestId = requestId;
      }
      await chrome.storage.session.set({ panelState });
      // Open from the popup's click handler so Chrome sees the original user gesture.
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    } catch (error) {
      setActionError(messageFor(error, 'Could not open the side panel. Try again.'));
    }
  }, []);

  const openAsk = useCallback((query?: string): Promise<void> => {
    return openPanel('ask', 'RESPOND', query);
  }, [openPanel]);

  const openGmail = useCallback(async (): Promise<void> => {
    setActionError(null);
    try {
      await chrome.tabs.create({ url: 'https://mail.google.com/' });
      window.close();
    } catch (error) {
      setActionError(messageFor(error, 'Could not open Gmail. Try again.'));
    }
  }, []);

  const openSettings = useCallback(async (): Promise<void> => {
    setActionError(null);
    try {
      await chrome.runtime.openOptionsPage();
      window.close();
    } catch (error) {
      setActionError(messageFor(error, 'Could not open Settings. Try again.'));
    }
  }, []);

  const runGmailCommand = useCallback(async (id: 'summarize' | 'draft'): Promise<void> => {
    setActionError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) throw new Error('Open a Gmail thread first.');
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'PIGEONBOX_COMMAND', id }) as { ok?: boolean; reason?: string } | undefined;
      if (!response?.ok) throw new Error(response?.reason || 'Open a Gmail thread first.');
      window.close();
    } catch (error) {
      setActionError(messageFor(error, 'Could not run that Gmail command. Open a thread and try again.'));
    }
  }, []);

  const commands = useMemo<PopupCommand[]>(() => {
    const items: PopupCommand[] = [
      {
        id: 'summarize-inbox',
        label: 'Summarize my inbox',
        detail: aiEnabled ? 'Ask Pigeon to catch you up' : 'Turn on AI in Settings to summarize mail',
        icon: 'document',
        disabled: !aiEnabled,
        run: () => void openAsk('Summarize my inbox'),
      },
      {
        id: 'important',
        label: 'Find important emails',
        detail: 'Open your Priority inbox',
        icon: 'inbox',
        run: () => void openPanel('inbox', 'PRIORITY'),
      },
      {
        id: 'ask',
        label: 'Ask Pigeon',
        detail: 'Search and ask about indexed mail',
        icon: 'sparkles',
        run: () => void openAsk(),
      },
      {
        id: 'inbox',
        label: 'Inbox insights',
        detail: 'Open your inbox categories',
        icon: 'inbox',
        run: () => void openPanel('inbox', 'RESPOND'),
      },
      {
        id: 'tracking',
        label: 'Tracking',
        detail: 'See tracked mail and replies',
        icon: 'tracking',
        run: () => void openPanel('inbox', 'WAITING'),
      },
      {
        id: 'gmail',
        label: 'Open Gmail',
        detail: 'Go to your inbox',
        icon: 'gmail',
        run: openGmail,
      },
      {
        id: 'settings',
        label: 'Settings',
        detail: 'Manage AI, tracking, and preferences',
        icon: 'settings',
        run: openSettings,
      },
    ];
    if (hasActiveThread) {
      items.splice(2, 0,
        {
          id: 'summarize-thread',
          label: 'Summarize this thread',
          detail: 'Add a summary to the open Gmail thread',
          icon: 'document',
          run: () => void runGmailCommand('summarize'),
        },
        {
          id: 'draft-reply',
          label: 'Draft a reply',
          detail: 'Write a draft for the open Gmail thread',
          icon: 'edit',
          run: () => void runGmailCommand('draft'),
        },
      );
    }
    return items;
  }, [aiEnabled, hasActiveThread, openAsk, openPanel, openGmail, openSettings, runGmailCommand]);

  return (
    <div className="gi-app gi-popup-app">
      <main className="pb-popup-main">
        <PopupHeader status={header} onSettings={openSettings} />
        <div className="pb-mode-summary"><strong>{runMode === 'cloud' ? 'Cloud' : 'Local'}</strong><span>{runMode === 'cloud' ? 'Working while you’re away' : 'On this computer'}</span>{overview?.work ? <small>{overview.work.draftsPrepared !== null ? `${overview.work.draftsPrepared} drafts prepared · ` : ''}{overview.work.approvalsWaiting} approvals waiting</small> : null}{runMode === 'cloud' ? <button className="gi-text-btn" type="button" onClick={() => void openPanel('cloud')}>Open PigeonBox Cloud</button> : null}</div>
        <CommandLauncher onOpen={() => {
          setActionError(null);
          trackProductEvent('command_palette_opened', { surface: 'popup' });
      setPaletteOpen(true);
        }} />
        <InboxOverviewCard
          indexedThreads={typeof diag?.indexedThreads === 'number' ? diag.indexedThreads : null}
          loading={!diag}
          onClick={() => void openPanel('inbox', 'RESPOND')}
        />
        <OpenGmailButton connected={gmail.tone === 'success'} onClick={() => void openGmail()} />
        <QuickActions
          askButtonRef={askButtonRef}
          onInbox={() => void openPanel('inbox', 'RESPOND')}
          onAsk={() => {
            setActionError(null);
            trackProductEvent('command_palette_opened', { surface: 'popup' });
      setPaletteOpen(true);
          }}
          onTracking={() => void openPanel('inbox', 'WAITING')}
          onSettings={openSettings}
        />
        {actionError ? <p className="pb-action-error" role="alert">{actionError}</p> : null}
        <ConnectionFooter statuses={[gmail, ai, tracker]} />
      </main>
      {paletteOpen ? (
        <CommandPalette
          commands={commands}
          cloud={product.state.runMode === 'cloud'}
          onClose={() => {
            setPaletteOpen(false);
            window.setTimeout(() => askButtonRef.current?.focus(), 0);
          }}
          onAskQuery={(query) => void openAsk(query)}
        />
      ) : null}
    </div>
  );
}

function gmailConnection(diag: Diagnostics | null): ConnectionStatus {
  if (!diag) return { id: 'gmail', title: 'Gmail', label: 'Checking', tone: 'muted', icon: 'gmail' };
  return diag.gmailTab === 'connected'
    ? { id: 'gmail', title: 'Gmail', label: 'Connected', tone: 'success', icon: 'gmail' }
    : { id: 'gmail', title: 'Gmail', label: 'Not connected', tone: 'muted', icon: 'gmail' };
}

function aiConnection(diag: Diagnostics | null, runMode: 'local' | 'cloud', localReadiness: LocalReadiness): ConnectionStatus {
  const title = runMode === 'cloud' ? 'Cloud AI' : diag?.ai?.provider === 'local' || diag?.ai?.provider === 'chrome' ? 'Local AI' : 'AI';
  if (!diag?.ai?.status) return { id: 'ai', title, label: 'Checking', tone: 'muted', icon: 'brain' };
  if (diag.ai.status === 'disabled') return { id: 'ai', title, label: 'Off', tone: 'muted', icon: 'brain' };
  if (diag.ai.status === 'not_signed_in') return { id: 'ai', title, label: 'Sign in required', tone: 'warning', icon: 'brain' };
  if (['missing_key', 'missing_permissions'].includes(diag.ai.status)) return { id: 'ai', title, label: 'Needs setup', tone: 'warning', icon: 'brain' };
  if (diag.ai.status === 'error') return { id: 'ai', title, label: 'Unavailable', tone: 'error', icon: 'brain' };
  if (diag.ai.provider === 'local' || diag.ai.provider === 'chrome') {
    if (localReadiness === 'checking') return { id: 'ai', title, label: 'Loading', tone: 'warning', icon: 'brain' };
    if (localReadiness === 'ready') return { id: 'ai', title, label: 'Ready', tone: 'success', icon: 'brain' };
    if (localReadiness === 'unavailable') return { id: 'ai', title, label: 'Unavailable', tone: 'error', icon: 'brain' };
    return { id: 'ai', title, label: 'Model idle', tone: 'muted', icon: 'brain' };
  }
  if (diag.ai.provider === 'chatgpt' || diag.ai.provider === 'pigeonbox-cloud' || diag.ai.configurationStatus === 'provider reachable') {
    return { id: 'ai', title, label: 'Ready', tone: 'success', icon: 'brain' };
  }
  return { id: 'ai', title, label: 'Configured', tone: 'warning', icon: 'brain' };
}

function trackerConnection(diag: Diagnostics | null): ConnectionStatus {
  if (!diag) return { id: 'tracker', title: 'Tracker', label: 'Checking', tone: 'muted', icon: 'tracking' };
  if (diag.tracking === 'healthy') return { id: 'tracker', title: 'Tracker', label: 'Connected', tone: 'success', icon: 'tracking' };
  if (diag.tracking === 'disabled') return { id: 'tracker', title: 'Tracker', label: 'Off', tone: 'muted', icon: 'tracking' };
  if (diag.tracking === 'not_configured') return { id: 'tracker', title: 'Tracker', label: 'Not set up', tone: 'warning', icon: 'tracking' };
  return { id: 'tracker', title: 'Tracker', label: 'Unavailable', tone: 'error', icon: 'tracking' };
}

function headerStatus(diag: Diagnostics | null, gmail: ConnectionStatus, ai: ConnectionStatus, tracker: ConnectionStatus): ConnectionStatus {
  if (!diag) return { id: 'overall', title: 'PigeonBox', label: 'Checking', tone: 'muted', icon: 'sparkles' };
  if (gmail.tone !== 'success') return { id: 'overall', title: 'PigeonBox', label: 'Gmail not connected', tone: 'muted', icon: 'sparkles' };
  if (ai.tone === 'error' || tracker.tone === 'error' || tracker.tone === 'warning') {
    return { id: 'overall', title: 'PigeonBox', label: 'Needs attention', tone: 'warning', icon: 'sparkles' };
  }
  return { id: 'overall', title: 'PigeonBox', label: 'Ready', tone: 'success', icon: 'sparkles' };
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
