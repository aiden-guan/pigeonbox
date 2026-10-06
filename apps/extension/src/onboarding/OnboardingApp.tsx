import { openCloudWaitlist } from '../config';
import { useAppearance } from '../ui/appearance';
import { useDispatchLayout } from '../ui/dispatch-motion';
import { Brand, Pigeon } from '../ui/Pigeon';
import { lazy, Suspense, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@pigeonbox/shared';
import { ProfileFields } from '../setup/ProfileFields';
import { RunModePanel } from '../setup/RunModePanel';
import { useProductState } from '../ui/product-state';
import { trackProductEvent } from '../ui/analytics';
const AiConnect = lazy(() => import('../setup/AiConnect').then((module) => ({ default: module.AiConnect })));

export function OnboardingApp() {
  useAppearance();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  function go(next: number) { setDirection(next > step ? 1 : -1); setStep(next); }
  const [selected, setSelected] = useState<'local' | 'cloud' | 'advanced' | 'skip'>('local');
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const product = useProductState();
  const stepLayout = useDispatchLayout<HTMLDivElement>(step);
  useEffect(() => { trackProductEvent('onboarding_started', { surface: 'onboarding' }); }, []);
  async function finish() {
    setBusy(true); setError('');
    try {
      const patch = selected === 'cloud' ? { voiceProfile: settings.voiceProfile } : { voiceProfile: settings.voiceProfile, aiMode: settings.aiMode, aiProvider: settings.aiProvider, aiModel: settings.aiModel, aiApiKey: settings.aiApiKey, aiEndpoint: settings.aiEndpoint };
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: patch });
      await chrome.storage.local.set({ onboardingComplete: true });
      trackProductEvent('onboarding_completed', { surface: 'onboarding', mode: product.state.runMode });
      await chrome.runtime.sendMessage({ type: 'OPEN_PIGEONBOX_WORKSPACE' }); window.close();
    } catch { setError('Setup could not be saved. Try again.'); } finally { setBusy(false); }
  }
  /** Cloud setup (agreement, sign-in, subscription, Google) happens on the dashboard. */
  async function continueOnDashboard() {
    trackProductEvent('cloud_selected', { surface: 'onboarding' });
    await chrome.storage.local.set({ onboardingComplete: true });
    await chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'cloud', setup: 'cloud' });
    window.close();
  }
  function choose(mode: typeof selected) {
    setSelected(mode); go(2);
    if (mode !== 'cloud') { trackProductEvent('local_selected', { surface: 'onboarding' }); if (product.state.runMode === 'cloud') void product.useLocal(); }
    if (mode === 'skip') setSettings({ ...settings, aiMode: 'disabled' });
  }
  return <div className="gi-app flex min-h-full items-center justify-center px-6 py-12"><div ref={stepLayout} className="gi-onboarding w-full max-w-[520px]"><Brand /><div className="gi-welcome-pigeon"><Pigeon state={busy ? 'working' : error ? 'attention' : step === 4 ? 'success' : 'idle'} size={48} /></div><div className="gi-steps mb-6" aria-label={`Step ${step + 1} of 5`}>{[0,1,2,3,4].map((item) => <span key={item} data-on={item <= step ? 'true' : 'false'} />)}</div>{step > 0 ? <button type="button" className="gi-text-btn mb-5" onClick={() => go(step - 1)}>← Back</button> : null}<p className="pb-step-count">{String(step + 1).padStart(2, '0')} / 05</p><div className="gi-step" key={step} data-direction={direction}>
    {step === 0 ? <><div className="gi-kicker">Welcome</div><h1 className="gi-display" data-motion-id="onboarding-title">Stay on top of Gmail.</h1><p className="gi-muted mt-4">Sort your inbox, summarize conversations, draft replies and find what matters. Local works on this computer. Cloud is on its way, with always-on help while you’re away.</p><button className="gi-btn mt-6" type="button" onClick={() => go(1)}>Continue</button></> : null}
    {step === 1 ? <><h1 className="gi-display" data-motion-id="onboarding-title">How should PigeonBox work?</h1><p className="gi-muted mt-3">Change this any time in Settings.</p><div className="mt-5 space-y-2"><Choice title="On this computer" detail="Private and free. Summaries, inbox sorting, Ask and drafts while Gmail is open. Mail stays here unless you configure another provider." onClick={() => choose('local')} /><Choice title="With Cloud capabilities" detail={product.state.cloudAvailable ? 'Keeps working while Gmail is closed. Connect Google for prepared drafts, follow-ups, briefings, calendar context and automations.' : 'Cloud is on its way. Join the waitlist for always-on summaries, prepared replies and follow-ups.'} onClick={() => product.state.cloudAvailable ? void continueOnDashboard() : openCloudWaitlist()} /><Choice title="Advanced provider" detail="Use Ollama or a provider you configure. You choose where mail is processed." onClick={() => choose('advanced')} /><Choice title="Start with inbox rules" detail="No AI setup now. Add it later in Settings." onClick={() => choose('skip')} /></div></> : null}
    {step === 2 ? <><h1 className="gi-display" data-motion-id="onboarding-title">{selected === 'cloud' ? 'Connect PigeonBox' : 'Your setup'}</h1>{selected === 'cloud' ? <><p className="gi-muted mt-3 mb-5">Agree to Cloud processing, sign in, then connect Google for continuous sync. Mail and calendar permissions are separate.</p><RunModePanel product={product} initialPickingCloud /></> : selected !== 'skip' ? <Suspense fallback={<p className="gi-muted">Loading setup…</p>}><AiConnect settings={settings} onPatch={(patch) => setSettings((current) => ({ ...current, ...patch }))} experimental={product.state.experimental} /></Suspense> : <p className="gi-muted mt-3">Inbox rules are ready. AI can be configured later.</p>}<details className="mt-5"><summary className="text-sm">Your profile (optional)</summary><p className="gi-muted text-xs mt-2">Your name and writing preferences help drafts sound like you.</p><ProfileFields voice={settings.voiceProfile} onChange={(voiceProfile) => setSettings({ ...settings, voiceProfile })} /></details><button className="gi-btn mt-6" type="button" onClick={() => go(3)}>Continue</button></> : null}
    {step === 3 ? <><h1 className="gi-display" data-motion-id="onboarding-title">Tracking is optional.</h1><p className="gi-muted mt-3">{product.has('cloud_tracking') ? 'Cloud hosts your tracker. Review open and click preferences in Settings. Reader attribution is approximate, and sender self-opens are suppressed.' : 'Local tracking needs a public tracker you own. Configure it in Settings; recipient opens cannot reach a tracker running only on this computer.'}</p><div className="mt-5 space-y-2"><Choice title="Review tracking settings" detail="Choose open and link tracking on your dashboard." onClick={() => { void chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'tracking' }); go(4); }} /><Choice title="Skip for now" detail="Enable tracking later." onClick={() => go(4)} /></div></> : null}
    {step === 4 ? <><h1 className="gi-display" data-motion-id="onboarding-title">Ready for Gmail.</h1><p className="gi-muted mt-3">{selected === 'cloud' ? product.has('cloud_mail_sync') ? 'Your workspace shows prepared replies and follow-ups right inside Gmail. Sending stays under your control.' : 'Connect Google in Settings to turn on always-on sync. Cloud setup can be continued there.' : 'Your workspace follows the conversation in Gmail. Click the toolbar Pidgy to reopen it, or use ⌘K / Ctrl+K for commands.'}</p><button className="gi-btn mt-6" type="button" disabled={busy} onClick={() => void finish()}>{busy ? 'Saving…' : 'Open Gmail'}</button>{selected === 'cloud' && !product.has('cloud_mail_sync') ? <button className="gi-text-btn ml-3" type="button" onClick={() => void chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'cloud', setup: 'cloud' })}>Continue Cloud setup</button> : null}{error ? <p className="gi-warn" role="alert">{error}</p> : null}</> : null}
  </div></div></div>;
}

function Choice(props: { title: string; detail: string; badge?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="gi-choice" disabled={props.disabled} onClick={props.onClick}>
      <span>
        <span className="flex items-center gap-2 text-[14px] font-medium tracking-[-0.02em]">
          {props.title}
          {props.badge ? <span className="gi-badge">{props.badge}</span> : null}
        </span>
        <span className="gi-muted mt-1 block text-[12px] leading-relaxed">{props.detail}</span>
      </span>
      {props.disabled ? null : (
        <span className="gi-choice-go" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 7h8M8 3.5 11.5 7 8 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </button>
  );
}
