import { MemorySettings } from './MemorySettings';
import { AnalyticsPreference } from './AnalyticsPreference';
import { Section, Toggle, Field } from './SettingsComponents';
import { CloudPreferences } from './CloudPreferences';
import { openCloud } from '../ui/cloud-features';
import { Brand, Pigeon } from '../ui/Pigeon';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, getProviderRequiredOrigin, type ExtensionSettings, type ThreadCategory } from '@pigeonbox/shared';
import { trackerHealthLabel, trackerPermissionOrigin, type TrackerHealthStatus } from '@pigeonbox/tracking';
import { AiConnect } from '../setup/AiConnect';
import { ProfileFields } from '../setup/ProfileFields';
import { RunModePanel } from '../setup/RunModePanel';
import { Orb } from '../ui/Orb';
import { useProductState } from '../ui/product-state';
import { DEV_REBUILD_URL } from '../config';
import { RebuildFailedError, requestExtensionReload } from '../reload-extension';
import {
  checkLatestRelease,
  chromeManagesUpdates,
  readReleaseUpdateStatus,
  RELEASE_CHECK_PERMISSION,
  type ReleaseUpdateStatus,
} from '../background/release-updates';

const CATEGORIES: ThreadCategory[] = ['RESPOND', 'WAITING', 'FYI', 'NOTIFICATIONS', 'PROMOTIONS', 'NEWS'];

export function SettingsApp() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [changeAi, setChangeAi] = useState(false);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);
  const [rules, setRules] = useState('');
  const [trackerHealth, setTrackerHealth] = useState<TrackerHealthStatus | null>(null);
  const [releaseStatus, setReleaseStatus] = useState<ReleaseUpdateStatus | null>(null);
  const [checkingRelease, setCheckingRelease] = useState(false);
  const [releaseNotice, setReleaseNotice] = useState<string | null>(null);
  const [storeInstall, setStoreInstall] = useState(false);
  const [reloadingExtension, setReloadingExtension] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const product = useProductState();
  const cloudMode = product.state.runMode === 'cloud';

  const checkForUpdates = useCallback(async (permissionAlreadyGranted = false) => {
    setCheckingRelease(true);
    setReleaseNotice(null);
    try {
      const granted = permissionAlreadyGranted || await new Promise<boolean>((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.permissions?.request) {
          resolve(false);
          return;
        }
        chrome.permissions.request({ origins: [RELEASE_CHECK_PERMISSION] }, resolve);
      });
      if (!granted) {
        setReleaseNotice('GitHub access was not granted, so PigeonBox did not check for updates.');
        return;
      }

      // Run the check here rather than in the service worker: extension pages hold the same
      // host permission, and this keeps working when Chrome is still running an older worker.
      setReleaseStatus(await checkLatestRelease());
    } catch {
      setReleaseNotice('The update check could not be completed. Try again.');
    } finally {
      setCheckingRelease(false);
    }
  }, []);

  const setAutomaticUpdateChecks = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const granted = await new Promise<boolean>((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.permissions?.request) {
          resolve(false);
          return;
        }
        chrome.permissions.request({ origins: [RELEASE_CHECK_PERMISSION] }, resolve);
      });
      if (!granted) {
        setReleaseNotice('GitHub access was not granted. Automatic update checks remain off.');
        return;
      }
    }

    const response = await new Promise<{ settings?: ExtensionSettings } | undefined>((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'SAVE_SETTINGS', settings: { automaticUpdateChecks: enabled } },
        (result) => resolve(result),
      );
    });
    if (!response?.settings) {
      setReleaseNotice('The update preference could not be saved. Try again.');
      return;
    }
    setSettings(response.settings);
    setSaved(true);
    setReleaseNotice(null);
    if (enabled) {
      await checkForUpdates(true);
    } else if (chrome.permissions?.remove) {
      chrome.permissions.remove({ origins: [RELEASE_CHECK_PERMISSION] });
    }
  }, [checkForUpdates]);

  const reloadExtension = useCallback(async () => {
    setReloadingExtension(true);
    setReloadError(null);
    try {
      await requestExtensionReload(chrome, { devRebuildUrl: DEV_REBUILD_URL });
    } catch (error) {
      setReloadingExtension(false);
      setReloadError(error instanceof RebuildFailedError ? 'Build failed. See the dev:reload terminal.' : 'Could not reload the extension. Try again.');
    }
  }, []);

  const checkTracker = useCallback((current: ExtensionSettings) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage(
      {
        type: 'CHECK_TRACKER',
        trackingEnabled: current.trackingEnabled,
        trackerBaseUrl: current.trackerBaseUrl,
        personalApiToken: current.personalApiToken,
      },
      (res?: { status?: TrackerHealthStatus }) => {
        if (res?.status) setTrackerHealth(res.status);
      },
    );
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    void chromeManagesUpdates().then(setStoreInstall);
    void readReleaseUpdateStatus().then((status) => {
      if (status) setReleaseStatus(status);
    }).catch(() => undefined);
    const updateListener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local' && changes.pigeonboxReleaseUpdateStatus?.newValue) {
        setReleaseStatus(changes.pigeonboxReleaseUpdateStatus.newValue as ReleaseUpdateStatus);
      }
    };
    chrome.storage?.onChanged?.addListener(updateListener);
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, async (res?: { settings?: ExtensionSettings }) => {
      if (res?.settings) {
        let next = { ...DEFAULT_SETTINGS, ...res.settings };
        if (!next.trackerBaseUrl?.trim() && !next.personalApiToken?.trim() && typeof chrome.runtime?.getURL === 'function') {
          try {
            const resp = await fetch(chrome.runtime.getURL('tracker-config.json'));
            if (resp.ok) {
              const cfg = (await resp.json()) as { trackerBaseUrl?: string; personalApiToken?: string };
              if (cfg.trackerBaseUrl?.trim() && cfg.personalApiToken?.trim()) {
                next = {
                  ...next,
                  trackerBaseUrl: cfg.trackerBaseUrl.replace(/\/$/, ''),
                  personalApiToken: cfg.personalApiToken,
                };
                chrome.runtime.sendMessage({
                  type: 'SAVE_SETTINGS',
                  settings: { trackerBaseUrl: next.trackerBaseUrl, personalApiToken: next.personalApiToken },
                });
              }
            }
          } catch {
            /* No bundled tracker config or fetch failed */
          }
        }
        setSettings(next);
        checkTracker(next);
      }
    });
    return () => chrome.storage?.onChanged?.removeListener(updateListener);
  }, [checkTracker]);

  function update<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  const patchSettings = useCallback((partial: Partial<ExtensionSettings>) => {
    setSettings((current) => ({ ...current, ...partial }));
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: partial }, () => setSaved(true));
  }, []);

  function save() {
    const trackerOrigin = trackerPermissionOrigin(settings.trackerBaseUrl);
    const aiOrigin = getProviderRequiredOrigin(settings.aiProvider, settings.aiEndpoint);
    const origins = [trackerOrigin, aiOrigin].filter((o): o is string => Boolean(o));
    const persist = () => {
      chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, (res?: { settings?: ExtensionSettings }) => {
        if (res?.settings) {
          setSettings(res.settings);
          setSaved(true);
          checkTracker(res.settings);
        }
      });
    };
    if (origins.length > 0 && chrome.permissions?.request) {
      chrome.permissions.request({ origins }, () => persist());
      return;
    }
    persist();
  }

  const provider = settings.aiMode === 'disabled'
    ? 'Off'
    : settings.aiProvider === 'chatgpt'
      ? 'ChatGPT (experimental)'
      : settings.aiProvider === 'chrome'
        ? 'On this computer'
        : settings.aiProvider === 'local'
          ? 'Downloaded model'
          : settings.aiProvider;

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      document.querySelectorAll<HTMLAnchorElement>('.gi-settings-nav a').forEach((link) => {
        const active = link.hash === `#${visible.target.id}`;
        link.dataset.active = String(active);
        if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-10% 0px -65% 0px' });
    document.querySelectorAll('.gi-settings section[id]').forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [cloudMode, advanced]);

  return (
    <div className="gi-app gi-settings min-h-full">
      <div className="gi-settings-layout">
      <header className="gi-settings-header">
        <Brand />
        <div className="gi-settings-title"><div><div className="gi-kicker">PigeonBox / Preferences</div><h1 className="gi-display">Settings.</h1><p className="gi-muted mt-3 text-sm">Choose how PigeonBox works for you.</p></div><Pigeon size={54} /></div>
      </header>

      <nav aria-label="Settings sections" className="gi-settings-nav">{[["General", "pigeonbox"], ["AI", "ai"], ["Inbox", "inbox"], ["Tracking", "tracking"], ["Cloud", "cloud"], ["Memory", "memory"], ["Personalization", "personalization"], ["Privacy & data", "privacy"]].filter(([, id]) => (id !== "cloud" && id !== "memory") || cloudMode).map(([label, id]) => <a key={id} className="gi-text-btn" href={`#${id}`}>{label}</a>)}</nav>
      <Section title="PigeonBox" id="pigeonbox">
        <RunModePanel
          product={product}
          onAdvanced={() => {
            setAdvanced(true);
            setChangeAi(true);
            requestAnimationFrame(() => document.getElementById('advanced')?.scrollIntoView({ behavior: 'smooth' }));
          }}
        />
      </Section>

      <Section title="Inbox" id="inbox">
        <Toggle label="AI Inbox" checked={(cloudMode || settings.aiMode !== 'disabled') && settings.autoClassify} onChange={(on) => update('autoClassify', on)} />
        <Toggle label="Email tracking" checked={settings.trackingEnabled} onChange={(on) => update('trackingEnabled', on)} />
        <Toggle label="Desktop alerts" checked={settings.desktopNotifications} onChange={(on) => update('desktopNotifications', on)} />
      </Section>

      <Section title="Updates">
        {storeInstall ? (
          <p className="gi-muted text-xs">
            Chrome keeps PigeonBox up to date from the Chrome Web Store. You are on v{chrome.runtime.getManifest().version}.
          </p>
        ) : (
          <>
            <p className="gi-muted text-xs">
              Update checks work in Local and Cloud. The request sends no email or settings data to GitHub; GitHub can see your IP address.
            </p>
            <Toggle
              label="Check GitHub automatically (once a day)"
              checked={settings.automaticUpdateChecks}
              onChange={(on) => void setAutomaticUpdateChecks(on)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="gi-btn gi-btn-ghost"
                disabled={checkingRelease}
                onClick={() => void checkForUpdates()}
              >
                {checkingRelease ? 'Checking…' : 'Check for updates'}
              </button>
              {releaseStatus?.state === 'available' && releaseStatus.downloadUrl ? (
                <a className="gi-btn" href={releaseStatus.downloadUrl} target="_blank" rel="noreferrer">
                  Download v{releaseStatus.latestVersion}
                </a>
              ) : null}
            </div>
            <p className="gi-muted text-xs" role="status" aria-live="polite">
              {releaseNotice || describeReleaseStatus(releaseStatus)}
            </p>
            {releaseStatus?.releaseUrl ? (
              <a className="gi-text-btn text-xs" href={releaseStatus.releaseUrl} target="_blank" rel="noreferrer">
                View release notes ↗
              </a>
            ) : null}
            <p className="gi-muted text-xs">
              The release ZIP downloads in one click. To apply it, unzip the release and reload PigeonBox on <code>chrome://extensions</code>. Chrome does not let a locally installed extension install itself.
            </p>
          </>
        )}
      </Section>

      <Section title="Agent">
        <Toggle label="Organize inbox automatically" checked={settings.autoClassify} onChange={(on) => update('autoClassify', on)} />
        <Toggle label="Generate reply drafts" checked={settings.autoDraft} onChange={(on) => update('autoDraft', on)} />
        <Toggle label="Follow-up reminders" checked={settings.autoReminders} onChange={(on) => update('autoReminders', on)} />
        <Toggle label="Auto archive low-priority mail" checked={settings.autoArchive} onChange={(on) => update('autoArchive', on)} />
        <p className="gi-muted text-xs">Drafts stay local until you click Draft reply. Nothing is sent automatically.</p>
      </Section>

      {cloudMode ? null : (
        <Section title="AI on this computer" id="ai">
          <p className="text-sm">{provider}{settings.aiModel && settings.aiMode !== 'disabled' ? ` · ${settings.aiModel}` : ''}</p>
          <button type="button" className="gi-text-btn mt-2" onClick={() => setChangeAi((open) => !open)}>
            {changeAi ? 'Hide AI setup' : 'Change AI'}
          </button>
          {changeAi ? <div className="mt-3"><AiConnect settings={settings} onPatch={patchSettings} onSignedIn={patchSettings} experimental={product.state.experimental} /></div> : null}
        </Section>
      )}

      <Section title="Email tracking" id="tracking">
        <Toggle label="Track opens" checked={settings.trackOpens} onChange={(on) => update('trackOpens', on)} />
        <Toggle label="Track links" checked={settings.trackLinks} onChange={(on) => update('trackLinks', on)} />
        {cloudMode ? (
          <p className="gi-muted text-xs">
            {product.has('cloud_tracking')
              ? 'PigeonBox Cloud hosts your tracker. Your self-hosted tracker settings below are kept for when you run on this computer.'
              : 'Hosted tracking is not active for this PigeonBox Cloud account. Your self-hosted tracker is used only in Local mode.'}
          </p>
        ) : (
          <p className="gi-muted text-xs">
            For recipient opens, use a public tracker you own. The guided install defaults to Convex and pre-fills these fields; click Save to grant Chrome access. Cloudflare Worker + Supabase is the alternative. <code>npm run tracker</code> is only local development and cannot receive opens from other devices.
          </p>
        )}
        <Field label="Tracker base URL">
          <input
            className="gi-field"
            value={settings.trackerBaseUrl}
            placeholder="https://your-tracker.example"
            onChange={(event) => update('trackerBaseUrl', event.target.value)}
            onBlur={() => checkTracker(settings)}
          />
        </Field>
        <Field label="Personal API token">
          <input
            className="gi-field"
            type="password"
            value={settings.personalApiToken}
            placeholder="Personal API token"
            onChange={(event) => update('personalApiToken', event.target.value)}
            onBlur={() => checkTracker(settings)}
          />
        </Field>
        <p className="gi-muted text-xs">
          Connection: {trackerHealth ? trackerHealthLabel(trackerHealth) : <span className="gi-orb-line"><Orb size={12} />Checking…</span>}
        </p>
        <p className="gi-muted text-xs">
          Tracking ready means a tracker record exists and Gmail’s send request can be rewritten. The compose window itself does not load the tracking image.
        </p>
      </Section>

      {cloudMode && product.has("cloud_mail_sync") ? <Section title="Cloud" id="cloud"><CloudPreferences capabilities={product.state.capabilities} /></Section> : null}
      <Section title="Personalization" id="personalization">
        <ProfileFields voice={settings.voiceProfile} onChange={(voiceProfile) => update('voiceProfile', voiceProfile)} />
        <Field label="Greeting">
          <input className="gi-field" value={settings.voiceProfile.greeting} onChange={(event) => update('voiceProfile', { ...settings.voiceProfile, greeting: event.target.value })} />
        </Field>
        <Field label="Custom instructions">
          <textarea className="gi-field min-h-[5rem]" value={settings.voiceProfile.personalInstructions} onChange={(event) => update('voiceProfile', { ...settings.voiceProfile, personalInstructions: event.target.value })} />
        </Field>
      </Section>

      <div className="gi-settings-save">
        <button type="button" className="gi-btn" onClick={save}>
          {saved ? 'Saved' : 'Save'}
        </button>
        <button type="button" className="gi-text-btn" onClick={() => setAdvanced((open) => !open)}>
          {advanced ? 'Hide advanced' : 'Advanced'}
        </button>
      </div>

      {advanced ? (
        <Section title="Advanced" id="advanced">
          <p className="gi-muted text-xs">
            Provider endpoints, tokens, index controls, and diagnostics.
          </p>
          {DEV_REBUILD_URL ? <Field label="PigeonBox Cloud API URL (development)">
            <input
              className="gi-field"
              value={settings.cloudApiUrl}
              placeholder="Blank uses this build's default"
              onChange={(event) => update('cloudApiUrl', event.target.value)}
            />
          </Field> : null}
          <p className="gi-muted text-xs">
            Self-hosting guides for Convex and Cloudflare Worker + Supabase are in the PigeonBox repository under docs/.
          </p>
          <Field label="AI endpoint">
            <input className="gi-field" value={settings.aiEndpoint} onChange={(event) => update('aiEndpoint', event.target.value)} />
          </Field>
          <Field label="AI API key">
            <input className="gi-field" type="password" value={settings.aiApiKey} onChange={(event) => update('aiApiKey', event.target.value)} />
          </Field>
          <Field label="InboxSDK app ID">
            <input className="gi-field" value={settings.inboxSdkAppId} onChange={(event) => update('inboxSdkAppId', event.target.value)} />
          </Field>
          <Field label="Archive confidence">
            <input className="gi-field" type="number" min={0} max={1} step={0.01} value={settings.archiveConfidenceThreshold} onChange={(event) => update('archiveConfidenceThreshold', Number(event.target.value))} />
          </Field>
          <Toggle label="Insert generated drafts into Gmail automatically" checked={settings.autoInsertDraft} onChange={(on) => update('autoInsertDraft', on)} />
          <Toggle label="Command palette" checked={settings.commandPaletteEnabled} onChange={(on) => update('commandPaletteEnabled', on)} />
          <Toggle label="Command palette overrides Gmail shortcuts" checked={settings.commandPaletteOverrideGmail} onChange={(on) => update('commandPaletteOverrideGmail', on)} />
          <div className="gi-muted text-xs">Archive categories</div>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((category) => (
              <label key={category} className="gi-check">
                <input
                  className="sr-only"
                  type="checkbox"
                  checked={settings.archiveCategories.includes(category)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...settings.archiveCategories, category]
                      : settings.archiveCategories.filter((item) => item !== category);
                    update('archiveCategories', next);
                  }}
                />
                {category}
              </label>
            ))}
          </div>
          <Field label="Agent rules, one per line">
            <textarea className="gi-field min-h-[5rem]" value={rules} onChange={(event) => setRules(event.target.value)} />
          </Field>
          <button
            type="button"
            className="gi-text-btn"
            onClick={() => chrome.runtime.sendMessage({ type: 'SAVE_AGENT_RULES', lines: rules.split('\n').map((line) => line.trim()).filter(Boolean) })}
          >
            Save rules
          </button>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="gi-btn gi-btn-ghost" onClick={() => chrome.runtime.sendMessage({ type: 'INDEX_INBOX', mode: '30d' })}>Index older messages</button>
            <button type="button" className="gi-btn gi-btn-ghost" onClick={() => chrome.runtime.sendMessage({ type: 'PAUSE_INDEX' })}>Pause</button>
            <button type="button" className="gi-btn gi-btn-ghost" onClick={() => chrome.runtime.sendMessage({ type: 'CLEAR_INDEX' })}>Clear local mail index</button>
            <button type="button" className="gi-btn gi-btn-ghost" onClick={() => chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (next) => setDiag(next))}>Run diagnostics</button>
          </div>
          {diag?.trackingReport ? <pre className="gi-pre">{String(diag.trackingReport)}</pre> : null}
          {diag ? <pre className="gi-pre">{JSON.stringify(diag, null, 2)}</pre> : null}
          {product.state.experimental ? (
            <p className="gi-muted text-xs">ChatGPT web sign-in is experimental and may stop working when ChatGPT’s website changes.</p>
          ) : null}
        </Section>
      ) : null}
      {cloudMode ? <Section title="Memory" id="memory"><MemorySettings /></Section> : null}
      <Section title="Privacy & data" id="privacy"><AnalyticsPreference /><p className="gi-muted text-xs">Local mail and settings stay in this browser unless you explicitly select another provider. Cloud processes mail on your configured infrastructure and stores encrypted derived intelligence; retaining excerpts requires a separate opt-in.</p>{cloudMode ? <button className="gi-text-btn" type="button" onClick={() => openCloud('privacy')}>Manage Cloud data and retention ↗</button> : null}<button className="gi-btn gi-btn-ghost" type="button" onClick={() => { if (window.confirm('Clear the mail index on this computer? Cloud data and your settings are unaffected.')) chrome.runtime.sendMessage({ type: 'CLEAR_INDEX' }); }}>Clear local mail index</button></Section>
      {DEV_REBUILD_URL ? (
        <Section title="Developer">
          <p className="gi-muted text-xs">Rebuild and restart this unpacked extension from the local development helper.</p>
          <button type="button" className="gi-btn gi-btn-ghost" disabled={reloadingExtension} onClick={() => void reloadExtension()}>
            {reloadingExtension ? 'Rebuilding…' : 'Reload extension'}
          </button>
          {reloadError ? <p className="gi-danger text-xs" role="alert">{reloadError}</p> : null}
        </Section>
      ) : null}
      </div>
    </div>
  );
}

function describeReleaseStatus(status: ReleaseUpdateStatus | null): string {
  if (!status) return 'No update check has run.';
  if (status.state === 'current') {
    return `PigeonBox v${status.currentVersion} is up to date. Latest release: v${status.latestVersion}.`;
  }
  if (status.state === 'available') {
    return `PigeonBox v${status.latestVersion} is available. Installed version: v${status.currentVersion}.`;
  }
  return status.message || 'Could not check for updates.';
}
