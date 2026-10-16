import { useEffect, useState } from 'react';
import { analyticsEnabled, setAnalyticsEnabled } from '../ui/analytics';
import { Toggle } from './SettingsComponents';
export function AnalyticsPreference() {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (chrome.storage?.local)
      void chrome.storage.local
        .get('productAnalyticsEnabled')
        .then((stored) => setEnabled(analyticsEnabled(stored)))
        .catch(() => undefined);
  }, []);
  return (
    <div>
      <Toggle
        label="Share anonymous usage events"
        checked={enabled}
        onChange={(on) => {
          setEnabled(on);
          void setAnalyticsEnabled(on);
        }}
      />
      <p className="gi-muted text-xs mt-2">
        On by default. Sends feature events (for example “footer kept”, “first tracked email”, “opened Settings”) with
        the extension version, a few fixed labels and a random install ID to PigeonBox, which forwards them to PostHog
        for product analytics. Never mail, subjects, addresses, searches, document names, Gmail IDs or your account.
        Turning this off stops sending and deletes the install ID and local counters.
      </p>
    </div>
  );
}
