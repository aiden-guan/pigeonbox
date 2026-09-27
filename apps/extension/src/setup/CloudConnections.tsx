/**
 * Google connection for PigeonBox Cloud's always-on features. Connecting
 * happens on Google's consent screen in a new tab; credentials stay with
 * PigeonBox Cloud and never reach the extension.
 */
import type { MailAccount } from '@pigeonbox/api-contract';
import { useEffect, useState } from 'react';
import { cloudCall } from '../sidepanel/CloudView';

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

  useEffect(() => {
    void cloudCall<{ accounts: MailAccount[]; googleConfigured: boolean }>('connections').then((result) => {
      if (!result.ok) return setError(result.reason);
      setAccounts(result.data.accounts);
      setConfigured(result.data.googleConfigured);
    });
  }, []);

  async function connect() {
    setBusy(true);
    setError('');
    const result = await cloudCall<{ url: string }>('connectStart', { features: picked, returnTo: 'extension' });
    setBusy(false);
    if (!result.ok) return setError(result.reason);
    await chrome.tabs.create({ url: result.data.url });
  }

  if (error) return <p className="mt-3 text-xs gi-danger">{error}</p>;
  if (!accounts) return null;
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <div className="text-sm font-medium">Always-on with Google</div>
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
        <button type="button" className="gi-btn gi-btn-ghost" onClick={() => chrome.runtime.sendMessage({ type: 'CLOUD_OPEN', section: 'connections' })}>
          Manage in PigeonBox Cloud ↗
        </button>
      </div>
    </div>
  );
}
