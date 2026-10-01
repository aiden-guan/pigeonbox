/**
 * Google connection for PigeonBox Cloud's always-on features. Connecting
 * happens on Google's consent screen in a new tab; credentials stay with
 * PigeonBox Cloud and never reach the extension.
 */
import type { MailAccount } from '@pigeonbox/api-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudCall } from '../sidepanel/cloud-api';
import { trackProductEvent } from '../ui/analytics';

const FEATURES: Array<[string, string, string]> = [
  ['mail_read', 'Read and sync mail', 'Required. Keeps triage, follow-ups and drafts current while Gmail is closed.'],
  ['drafts', 'Create drafts', 'Puts prepared drafts in Gmail. Nothing is sent.'],
  ['calendar_read', 'Read calendar', 'Suggests only times you are free and prepares meeting briefs.'],
];

const SYNC: Record<string, string> = {
  initializing: 'Setting up',
  healthy: 'Up to date',
  catching_up: 'Catching up',
  recovering: 'Recovering',
  degraded: 'Having trouble',
  stalled: 'Needs attention',
  paused: 'Paused',
};

export function CloudConnections() {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [picked, setPicked] = useState<string[]>(['mail_read', 'drafts']);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loading = useRef(false);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const result = await cloudCall<{ accounts: MailAccount[]; googleConfigured: boolean }>('connections');
    loading.current = false;
    if (!result.ok) { setError(result.reason); return; }
    setError(''); setAccounts(result.data.accounts); setConfigured(result.data.googleConfigured);
    if (result.data.accounts.length && chrome.storage?.session) {
      const pending = await chrome.storage.session.get('googleConnectionPending');
      if (pending.googleConnectionPending) {
        trackProductEvent('google_connection_completed', { surface: 'settings', mode: 'cloud', outcome: 'success' });
        await chrome.storage.session.remove('googleConnectionPending');
      }
    }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);

  async function connect() {
    trackProductEvent('google_connection_started', { surface: 'settings', mode: 'cloud' });
    setBusy(true);
    setError('');
    const result = await cloudCall<{ url: string }>('connectStart', { features: picked, returnTo: 'extension' });
    setBusy(false);
    if (!result.ok) return setError(result.reason);
    if (chrome.storage?.session) await chrome.storage.session.set({ googleConnectionPending: true });
    await chrome.tabs.create({ url: result.data.url });
  }

  if (error && !accounts) return <div><p className="mt-3 text-xs gi-danger" role="alert">{error}</p><button type="button" className="gi-text-btn" onClick={() => void load()}>Retry connections</button></div>;
  if (!accounts) return <p className="gi-muted text-xs" role="status">Checking Google connections…</p>;
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <div className="text-sm font-medium">Always-on with Google</div>{error ? <p className="gi-warn" role="alert">{error} Showing the last loaded connections.</p> : null}
      {accounts.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {accounts.map((account) => (
            <li key={account.id} className="flex justify-between gap-3">
              <span className="truncate">{account.email}</span>
              <span className="gi-muted shrink-0">{account.status === 'active' ? SYNC[account.sync.state] ?? account.sync.state : account.status === 'needs_reauth' ? 'Reconnect needed' : account.status}</span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className="mt-1 text-xs gi-muted">
            Connect a Google account and PigeonBox Cloud keeps your inbox triaged and drafts prepared even while Gmail is closed. It asks before anything is sent. Credentials stay with PigeonBox Cloud, never in this extension.
          </p>
          {configured ? (
            <>
              <div className="mt-2 space-y-1">
                {FEATURES.map(([id, title, detail]) => (
                  <label key={id} className="gi-consent">
                    <input
                      type="checkbox"
                      checked={picked.includes(id)}
                      disabled={id === 'mail_read'}
                      onChange={(event) => setPicked((current) => (event.target.checked ? [...current, id] : current.filter((item) => item !== id)))}
                    />
                    <span>
                      {title} <span className="gi-muted">· {detail}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="gi-btn" disabled={busy} onClick={() => void connect()}>
                  Connect Google
                </button>
              </div>
            </>
          ) : (
            <p className="mt-2 text-xs gi-muted">Google connections are not available on this PigeonBox Cloud server yet.</p>
          )}
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="gi-text-btn" onClick={() => void load()}>Refresh status</button>
        <button type="button" className="gi-btn gi-btn-ghost" onClick={() => chrome.runtime.sendMessage({ type: 'CLOUD_OPEN', section: 'connections' })}>
          Manage in PigeonBox Cloud ↗
        </button>
      </div>
    </div>
  );
}
