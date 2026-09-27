import { Brand, Pigeon } from '../ui/Pigeon';
import { useEffect, useState } from 'react';
import { chromeManagesUpdates } from '../background/release-updates';
import { DEV_REBUILD_URL } from '../config';
import { RebuildFailedError, requestExtensionReload } from '../reload-extension';
import { Orb } from '../ui/Orb';
import { useProductState } from '../ui/product-state';

type Diagnostics = {
  gmailTab?: string;
  ai?: { status?: string; provider?: string };
  tracking?: string;
};

export function PopupApp() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  // Chrome Web Store copies update themselves; reloading only helps copies loaded from a folder.
  const [storeInstall, setStoreInstall] = useState(false);
  const product = useProductState();
  const cloudMode = product.state.runMode === 'cloud';
  const cloudReady = product.state.cloud.status === 'ready';

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    void chromeManagesUpdates().then(setStoreInstall);
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (response?: Diagnostics) => {
      if (response) setDiag(response);
    });
  }, []);

  const aiReady = diag?.ai?.status === 'ready';
  const aiOff = diag?.ai?.status === 'disabled';
  const ai = cloudMode
    ? cloudReady ? 'PigeonBox Cloud connected' : 'PigeonBox Cloud not connected'
    : aiReady ? 'AI on this computer ready' : aiOff ? 'AI off' : 'AI needs setup';
  const trackingReady = diag?.tracking === 'healthy';
  const tracking =
    trackingReady ? 'Tracker connected' : diag?.tracking === 'not_configured' ? 'Tracking not set up' : 'Tracker unavailable';

  return (
    <div className="gi-app gi-popup-app w-[320px]">
      <div className="gi-shell">
        <div className="gi-core">
          <Brand />
          <div className="gi-perch">
            <div><div className="gi-kicker">A little breathing room</div><h1>Less inbox.<br />More life.</h1><p>Your mail, in good wings.</p></div>
            <Pigeon state={reloading ? 'indexing' : 'idle'} size={104} />
          </div>
          <div className="gi-section-label">Connections</div>
          <ul className="gi-connections">
            <Status on={diag?.gmailTab === 'connected'} label={diag?.gmailTab === 'connected' ? 'Gmail connected' : 'Gmail not connected'} />
            <Status on={cloudMode ? cloudReady : aiReady || aiOff} label={ai} />
            <Status on={trackingReady} label={tracking} />
          </ul>
          {cloudMode && !cloudReady ? (
            <p className="gi-hint">Nothing is sent to another provider while Cloud is unavailable.</p>
          ) : null}
          <div className="mt-4 grid gap-2">
            {cloudMode && !cloudReady ? (
              <button type="button" className="gi-btn gi-btn-block" disabled={product.busy} onClick={() => void product.useLocal()}>
                Run on this computer instead
              </button>
            ) : null}
            <button type="button" className="gi-btn gi-btn-block" onClick={() => chrome.tabs.create({ url: 'https://mail.google.com/' })}>
              Open Gmail
            </button>
            <button type="button" className="gi-btn gi-btn-ghost gi-btn-block" onClick={() => void openInbox()}>
              Inbox insights
            </button>
            <button type="button" className="gi-btn gi-btn-ghost gi-btn-block" onClick={() => chrome.runtime.openOptionsPage()}>
              Settings
            </button>
            {storeInstall ? null : (
              <>
                <button
                  type="button"
                  className="gi-btn gi-btn-ghost gi-btn-block"
                  disabled={reloading}
                  onClick={() => {
                    setReloading(true);
                    setReloadError(null);
                    void requestExtensionReload(chrome, { devRebuildUrl: DEV_REBUILD_URL }).catch((error) => {
                      setReloading(false);
                      if (error instanceof RebuildFailedError) setReloadError('Build failed. See the dev:reload terminal.');
                    });
                  }}
                >
                  {reloading ? <><Orb size={14} tone="bare" />{DEV_REBUILD_URL ? 'Rebuilding…' : 'Reloading…'}</> : 'Reload extension'}
                </button>
                {reloadError ? <p className="gi-hint" role="alert">{reloadError}</p> : null}
              </>
            )}
          </div>
          <p className="gi-hint"><kbd>⌘ K</kbd> Quick commands in Gmail</p>
        </div>
      </div>
    </div>
  );
}

function Status(props: { on: boolean; label: string }) {
  return (
    <li className="gi-status">
      <span className={props.on ? 'gi-dot' : 'gi-dot is-quiet'} />
      <span>{props.label}</span>
    </li>
  );
}

async function openInbox(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId != null) {
    await chrome.runtime.sendMessage({ type: 'FOCUS_SIDEPANEL', mode: 'inbox' });
    await chrome.sidePanel.open({ windowId: tab.windowId });
    // The side panel takes over from here; the popup would just sit on top of it.
    window.close();
  }
}
