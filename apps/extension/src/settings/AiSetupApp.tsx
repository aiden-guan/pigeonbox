import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@pigeonbox/shared';
import { AiConnect } from '../setup/AiConnect';
import { useAppearance } from '../ui/appearance';
import { openDashboard } from '../ui/cloud-features';
import { Brand, Pigeon } from '../ui/Pigeon';
import { useProductState } from '../ui/product-state';

/**
 * AI setup for Local mode. Settings live on the PigeonBox dashboard, but
 * choosing an on-device model, downloading it, signing in to ChatGPT or
 * granting access to a provider has to happen on an extension page, so the
 * dashboard's AI section opens this one.
 */
export function AiSetupApp() {
  useAppearance();
  const product = useProductState();
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res?: { settings?: ExtensionSettings }) => {
      if (res?.settings) setSettings({ ...DEFAULT_SETTINGS, ...res.settings });
    });
  }, []);

  const patch = useCallback((partial: Partial<ExtensionSettings>) => {
    setSettings((current) => ({ ...current, ...partial }));
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: partial }, () => setSaved(true));
  }, []);

  return (
    <div className="gi-app gi-settings min-h-full">
      <div className="mx-auto w-full max-w-[640px] px-6 py-10">
        <div className="pb-settings-brand"><Brand /></div>
        <div className="gi-settings-title mt-6">
          <div>
            <div className="gi-kicker">PigeonBox / Local AI</div>
            <h1 className="gi-display">Set up AI.</h1>
            <p className="gi-muted mt-3 text-sm">Choose where PigeonBox runs AI on this computer. Other settings are on your dashboard.</p>
          </div>
          <Pigeon size={48} />
        </div>
        {product.state.runMode === 'cloud' ? (
          <p className="gi-warn mt-6 text-sm">PigeonBox is in Cloud mode, so Cloud runs AI for you. This setup applies when you switch back to Local.</p>
        ) : null}
        <div className="mt-6">
          <AiConnect settings={settings} onPatch={patch} onSignedIn={patch} experimental={product.state.experimental} />
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button type="button" className="gi-btn" onClick={() => { openDashboard('ai'); window.close(); }}>Back to dashboard</button>
          {saved ? <span className="gi-muted text-xs" role="status">Saved</span> : null}
        </div>
      </div>
    </div>
  );
}
