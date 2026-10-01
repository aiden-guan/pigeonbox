import { useEffect, useState } from 'react';
import { Toggle } from './SettingsComponents';
export function AnalyticsPreference() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (chrome.storage?.local)
      void chrome.storage.local
        .get('productAnalyticsEnabled')
        .then((stored) => setEnabled(stored.productAnalyticsEnabled === true))
        .catch(() => undefined);
  }, []);
  return (
    <div>
      <Toggle
        label="Keep content-free product counters on this computer"
        checked={enabled}
        onChange={(on) => {
          setEnabled(on);
          void chrome.storage.local.set({ productAnalyticsEnabled: on });
          if (!on) void chrome.storage.local.remove('productEventCounts');
        }}
      />
      <p className="gi-muted text-xs mt-2">
        Off by default. Counts feature use; stores no mail, query text, addresses, documents or timestamps. This build
        sends no analytics to an external service. Turning this off clears the counters.
      </p>
    </div>
  );
}
