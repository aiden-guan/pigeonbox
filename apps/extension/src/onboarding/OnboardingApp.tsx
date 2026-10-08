import { openCloudWaitlist } from '../config';
import { useAppearance } from '../ui/appearance';
import { Pigeon } from '../ui/Pigeon';
import { prefersReducedMotion } from '../ui/motion';
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type ExtensionSettings, type ThreadCategory, type VoiceProfile } from '@pigeonbox/shared';
import { useProductState } from '../ui/product-state';
import { trackProductEvent } from '../ui/analytics';
import { InboxStage, type StagePhase } from './InboxStage';
import { ThemeIntro, type Mode } from './ThemeIntro';
import type { Focus } from './inbox';
import './onboarding.css';
const AiConnect = lazy(() => import('../setup/AiConnect').then((module) => ({ default: module.AiConnect })));

type Path = 'local' | 'cloud';
type Feature = Focus;
type StepId = 'features' | 'engine' | 'voice' | 'followups' | 'archive' | 'tracking' | 'done';

const FEATURES: Array<{ id: Feature; title: string; detail: string }> = [
  { id: 'sort', title: 'Sort the inbox', detail: 'Needs you, waiting, updates. Every thread in its place.' },
  { id: 'summaries', title: 'Summaries', detail: 'One line on every thread, with dates and asks pulled out.' },
  { id: 'drafts', title: 'Replies in your voice', detail: 'A draft ready when you open a thread. You always send.' },
  { id: 'followups', title: 'Follow-up nudges', detail: 'A reminder when someone hasn’t replied.' },
  { id: 'archive', title: 'Quiet the noise', detail: 'Archive promotions and notifications for you.' },
  { id: 'tracking', title: 'Open tracking', detail: 'See when the mail you send gets opened.' },
];

/** Time from the click until the last message lands and the panel can arrive. */
const SORT_MS = 1950;

export function OnboardingApp() {
  const theme = useAppearance();
  const product = useProductState();
  const [phase, setPhase] = useState<'theme' | 'welcome' | 'sorting' | 'setup'>('theme');
  const [introLeaving, setIntroLeaving] = useState(false);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [path, setPath] = useState<Path>('local');
  const [waitlisted, setWaitlisted] = useState(false);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [touchedAi, setTouchedAi] = useState(false);
  const [features, setFeatures] = useState<Record<Feature, boolean>>({
    sort: DEFAULT_SETTINGS.autoClassify, summaries: DEFAULT_SETTINGS.autoSummarize, drafts: true,
    followups: DEFAULT_SETTINGS.autoReminders, archive: DEFAULT_SETTINGS.autoArchive, tracking: DEFAULT_SETTINGS.trackingEnabled,
  });
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [hover, setHover] = useState<Feature | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { trackProductEvent('onboarding_started', { surface: 'onboarding' }); }, []);

  const steps: StepId[] = [
    'features',
    ...(path === 'local' && (features.sort || features.summaries || features.drafts) ? ['engine' as const] : []),
    ...(features.drafts ? ['voice' as const] : []),
    ...(features.followups ? ['followups' as const] : []),
    ...(features.archive ? ['archive' as const] : []),
    ...(features.tracking ? ['tracking' as const] : []),
    'done',
  ];
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const focus: Focus | null = phase !== 'setup' ? null
    : step === 'features' ? hover
    : step === 'voice' ? 'drafts' : step === 'followups' ? 'followups' : step === 'archive' ? 'archive' : step === 'tracking' ? 'tracking' : step === 'engine' ? 'sort' : null;
  const stagePhase: StagePhase = phase === 'welcome' || phase === 'theme' ? 'clutter' : phase === 'sorting' ? 'sorting' : 'sorted';

  const patch = (partial: Partial<ExtensionSettings>) => setSettings((current) => ({ ...current, ...partial }));
  const go = (next: number) => { setDirection(next > stepIndex ? 1 : -1); setStepIndex(Math.max(0, Math.min(next, steps.length - 1))); };

  /** The new theme floods out from the word that was picked. */
  function revealTheme(mode: Mode, from: { x: number; y: number }) {
    const next = mode === 'night' ? 'dark' : 'light';
    if (next === theme.appearance) return;
    const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };
    if (!doc.startViewTransition || prefersReducedMotion()) { theme.change(next); return; }
    const radius = Math.hypot(Math.max(from.x, innerWidth - from.x), Math.max(from.y, innerHeight - from.y));
    const transition = doc.startViewTransition(() => theme.change(next));
    void transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${from.x}px ${from.y}px)`, `circle(${radius}px at ${from.x}px ${from.y}px)`] },
        { duration: 950, easing: 'cubic-bezier(.65, 0, .35, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    }).catch(() => undefined);
  }

  function leaveIntro(mode: Mode) {
    if (introLeaving) return;
    const next = mode === 'night' ? 'dark' : 'light';
    if (next !== theme.appearance) theme.change(next);
    setIntroLeaving(true);
    window.setTimeout(() => setPhase('welcome'), 420);
    window.setTimeout(() => setIntroLeaving(false), 1100);
  }

  function choose(next: Path, event: MouseEvent<HTMLButtonElement>) {
    if (phase !== 'welcome') return;
    if (next === 'cloud' && !product.state.cloudAvailable) {
      openCloudWaitlist();
      setWaitlisted(true);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setOrigin(event.detail === 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: event.clientX, y: event.clientY });
    setPath(next);
    if (next === 'local') {
      trackProductEvent('local_selected', { surface: 'onboarding' });
      if (product.state.runMode === 'cloud') void product.useLocal();
    } else {
      trackProductEvent('cloud_selected', { surface: 'onboarding' });
    }
    setPhase('sorting');
    window.setTimeout(() => setPhase('setup'), prefersReducedMotion() ? 200 : SORT_MS);
  }

  function featurePatch(): Partial<ExtensionSettings> {
    return {
      voiceProfile: settings.voiceProfile,
      autoClassify: features.sort,
      autoSummarize: features.summaries,
      autoReminders: features.followups,
      reminderMode: features.followups ? settings.reminderMode : 'disabled',
      reminderBusinessDays: settings.reminderBusinessDays,
      autoArchive: features.archive,
      archiveCategories: settings.archiveCategories,
      trackingEnabled: features.tracking,
    };
  }

  async function finish(skipped = false) {
    setBusy(true); setError('');
    try {
      const ai = path === 'local' && touchedAi
        ? { aiMode: settings.aiMode, aiProvider: settings.aiProvider, aiModel: settings.aiModel, aiApiKey: settings.aiApiKey, aiEndpoint: settings.aiEndpoint }
        : {};
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: skipped ? { voiceProfile: settings.voiceProfile } : { ...featurePatch(), ...ai } });
      await chrome.storage.local.set({ onboardingComplete: true });
      trackProductEvent('onboarding_completed', { surface: 'onboarding', mode: product.state.runMode });
      // Cloud setup (agreement, sign-in, subscription, Google) happens on the dashboard.
      if (path === 'cloud' && !skipped) await chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'cloud', setup: 'cloud' });
      else await chrome.runtime.sendMessage({ type: 'OPEN_PIGEONBOX_WORKSPACE' });
      window.close();
    } catch {
      setError('Setup could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const enabled = FEATURES.filter((feature) => features[feature.id]);
  const initialMode: Mode = theme.appearance === 'dark' ||
    (theme.appearance === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'night' : 'light';

  return (
    <div className="ob-root" data-phase={phase} data-theme-pending={!theme.ready || undefined}>
      {phase !== 'theme' ? <InboxStage phase={stagePhase} origin={origin} focus={focus} finale={phase === 'setup' && step === 'done'} /> : null}

      {theme.ready && (phase === 'theme' || introLeaving) ? (
        <ThemeIntro initial={initialMode} leaving={introLeaving}
          onPick={(mode, from) => revealTheme(mode, from)} onContinue={leaveIntro} />
      ) : null}

      {phase === 'theme' ? null : phase !== 'setup' ? (
        <div className="ob-welcome-wrap" data-leaving={phase === 'sorting' || undefined}>
          <section className="ob-welcome" role="dialog" aria-modal="true" aria-labelledby="ob-welcome-title">
            <div className="ob-welcome-pidgy"><Pigeon state="idle" size={56} /></div>
            <p className="ob-kicker ob-rise" style={{ '--i': 1 } as CSSProperties}>Welcome to PigeonBox</p>
            <Reveal as="h1" id="ob-welcome-title" className="ob-title ob-title-xl" text="Let’s quiet your inbox." delay={2} />
            <p className="ob-sub ob-rise" style={{ '--i': 5 } as CSSProperties}>PigeonBox sorts, summarizes and drafts right inside Gmail. First, where should it run?</p>
            <div className="ob-paths">
              <PathCard index={6} icon={<LaptopIcon />} title="On this computer" detail="Private and free. Works while Gmail is open." tag="Free" onClick={(event) => choose('local', event)} />
              <PathCard index={7} icon={<CloudIcon />} title="PigeonBox Cloud"
                detail={product.state.cloudAvailable ? 'Keeps working while Gmail is closed. Briefings and prepared drafts.' : 'Always-on help while you’re away. Join the waitlist.'}
                tag={product.state.cloudAvailable ? 'Always on' : 'Waitlist'} onClick={(event) => choose('cloud', event)} />
            </div>
            {waitlisted ? <p className="ob-note ob-rise" role="status">Waitlist opened in a new tab. You can start on this computer meanwhile.</p> : null}
            <div className="ob-welcome-foot ob-rise" style={{ '--i': 8 } as CSSProperties}>
              <span>Switch any time in Settings.</span>
              <button type="button" className="ob-link" disabled={busy} onClick={() => void finish(true)}>Skip setup</button>
            </div>
          </section>
        </div>
      ) : (
        <aside className="ob-panel" aria-label="Set up PigeonBox">
          <div className="ob-panel-top">
            <button type="button" className="ob-icon-btn" aria-label="Back" disabled={stepIndex === 0} onClick={() => go(stepIndex - 1)}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <div className="ob-progress" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={stepIndex + 1} aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
              {steps.map((id, index) => <span key={id} data-state={index < stepIndex ? 'done' : index === stepIndex ? 'on' : 'off'} />)}
            </div>
            {step !== 'done' ? <button type="button" className="ob-link" onClick={() => go(steps.length - 1)}>Skip all</button> : <span />}
          </div>

          <Swap id={step} direction={direction}>
            {step === 'features' ? (
              <StepFrame kicker={path === 'cloud' ? 'PigeonBox Cloud' : 'On this computer'} title="What should Pidgy take off your plate?"
                sub="Pick what you want. Each one takes seconds to set up, and you can change it later.">
                <div className="ob-features" onMouseLeave={() => setHover(null)}>
                  {FEATURES.map((feature, index) => (
                    <button key={feature.id} type="button" className="ob-feature ob-rise" style={{ '--i': 3 + index } as CSSProperties}
                      aria-pressed={features[feature.id]}
                      onMouseEnter={() => setHover(feature.id)} onFocus={() => setHover(feature.id)}
                      onClick={() => setFeatures((current) => ({ ...current, [feature.id]: !current[feature.id] }))}>
                      <span className="ob-feature-icon"><FeatureIcon id={feature.id} /></span>
                      <span className="ob-feature-text"><strong>{feature.title}</strong><small>{feature.detail}</small></span>
                      <span className="ob-check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 8.5 7 11l5-6" /></svg></span>
                    </button>
                  ))}
                </div>
                <Actions index={10} primary={enabled.length ? `Continue with ${enabled.length}` : 'Continue'} onPrimary={() => go(stepIndex + 1)} />
              </StepFrame>
            ) : null}

            {step === 'engine' ? (
              <StepFrame fill kicker="The brain" title="Where should Pidgy think?" sub="On-device keeps mail on this computer. You can also bring your own key or Ollama. Mail never goes to the tracker.">
                <div className="ob-engine ob-rise" style={{ '--i': 3 } as CSSProperties}>
                  <Suspense fallback={<p className="ob-sub">Loading options…</p>}>
                    <AiConnect intro={false} settings={settings} experimental={product.state.experimental}
                      onPatch={(partial) => { setTouchedAi(true); patch(partial); }} />
                  </Suspense>
                </div>
                <Actions index={4} primary="Continue" onPrimary={() => go(stepIndex + 1)}
                  secondary="Inbox rules only for now" onSecondary={() => { setTouchedAi(true); patch({ aiMode: 'disabled' }); go(stepIndex + 1); }} />
              </StepFrame>
            ) : null}

            {step === 'voice' ? (
              <StepFrame kicker="Replies in your voice" title="How do you sign off?" sub="Drafts are written as you. Here’s one, live.">
                <VoiceStep voice={settings.voiceProfile} onChange={(partial) => setSettings((current) => ({ ...current, voiceProfile: { ...current.voiceProfile, ...partial } }))} />
                <Actions index={8} primary="Sounds like me" onPrimary={() => go(stepIndex + 1)} secondary="Skip" onSecondary={() => go(stepIndex + 1)} />
              </StepFrame>
            ) : null}

            {step === 'followups' ? (
              <StepFrame kicker="Follow-up nudges" title="When should Pidgy nudge you?" sub="If nobody replies, the thread comes back to the top with a reminder.">
                <FollowupStep days={settings.reminderBusinessDays} mode={settings.reminderMode === 'disabled' ? 'ai_needed' : settings.reminderMode}
                  onDays={(reminderBusinessDays) => patch({ reminderBusinessDays })} onMode={(reminderMode) => patch({ reminderMode })} />
                <Actions index={7} primary="Continue" onPrimary={() => go(stepIndex + 1)} secondary="Skip" onSecondary={() => go(stepIndex + 1)} />
              </StepFrame>
            ) : null}

            {step === 'archive' ? (
              <StepFrame kicker="Quiet the noise" title="What counts as noise?" sub="Pidgy archives only when it’s very sure. Nothing is deleted; it all stays in All Mail.">
                <ArchiveStep value={settings.archiveCategories} onChange={(archiveCategories) => patch({ archiveCategories })} />
                <Actions index={6} primary="Continue" onPrimary={() => go(stepIndex + 1)} secondary="Skip" onSecondary={() => go(stepIndex + 1)} />
              </StepFrame>
            ) : null}

            {step === 'tracking' ? (
              <StepFrame kicker="Open tracking" title="Know when it lands." sub={product.has('cloud_tracking') || path === 'cloud'
                ? 'Cloud hosts your tracker. Reader attribution is approximate, and your own opens are hidden.'
                : 'Local tracking needs a public tracker you own; opens can’t reach a tracker that runs only on this computer. Set it up from your dashboard.'}>
                <TrackingDemo />
                <Actions index={5} primary="Continue" onPrimary={() => go(stepIndex + 1)}
                  secondary="Open tracking settings" onSecondary={() => { void chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'tracking' }); }} />
              </StepFrame>
            ) : null}

            {step === 'done' ? (
              <StepFrame kicker="All set" title={settings.voiceProfile.name ? `You’re set, ${settings.voiceProfile.name}.` : 'You’re set.'}
                sub={path === 'cloud' ? 'One more stop: sign in and connect Google on your dashboard so Pidgy can work while Gmail is closed.' : 'Pidgy works inside Gmail. Click the toolbar Pidgy to open it, or press ⌘K / Ctrl+K for commands.'}>
                <ul className="ob-summary">
                  {(enabled.length ? enabled : [{ id: 'sort' as Feature, title: 'Inbox rules', detail: '' }]).map((feature, index) => (
                    <li key={feature.id} className="ob-rise" style={{ '--i': 3 + index } as CSSProperties}>
                      <span className="ob-summary-check"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5 7 11l5-6" /></svg></span>{feature.title}
                    </li>
                  ))}
                </ul>
                <div className="ob-done-pidgy ob-rise" style={{ '--i': 2 } as CSSProperties}><span className="ob-ring" /><Pigeon state={busy ? 'working' : error ? 'attention' : 'success'} size={44} /></div>
                <Actions index={4 + enabled.length} primary={busy ? 'Saving…' : path === 'cloud' ? 'Continue Cloud setup' : 'Open Gmail'} disabled={busy} onPrimary={() => void finish()} />
                {error ? <p className="ob-error" role="alert">{error}</p> : null}
              </StepFrame>
            ) : null}
          </Swap>
        </aside>
      )}
    </div>
  );
}

/** Words rise out of a mask one after another. */
function Reveal({ text, as: Tag = 'h2', className, delay = 0, id }: { text: string; as?: 'h1' | 'h2'; className?: string; delay?: number; id?: string }) {
  const words = text.split(' ');
  return (
    <Tag id={id} className={className} aria-label={text}>
      {words.map((word, index) => (
        <Fragment key={`${word}-${index}`}>
          <span className="ob-word" aria-hidden="true"><span style={{ '--w': delay * 60 + index * 45 } as CSSProperties}>{word}</span></span>
          {index < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </Tag>
  );
}

function StepFrame({ kicker, title, sub, fill, children }: { kicker: string; title: string; sub: string; fill?: boolean; children: ReactNode }) {
  return (
    <div className="ob-step" data-fill={fill || undefined}>
      <p className="ob-kicker ob-rise" style={{ '--i': 0 } as CSSProperties}>{kicker}</p>
      <Reveal className="ob-title" text={title} delay={1} />
      <p className="ob-sub ob-rise" style={{ '--i': 2 } as CSSProperties}>{sub}</p>
      {children}
    </div>
  );
}

function Actions(props: { index: number; primary: string; onPrimary: () => void; secondary?: string; onSecondary?: () => void; disabled?: boolean }) {
  return (
    <div className="ob-actions ob-rise" style={{ '--i': props.index } as CSSProperties}>
      <button type="button" className="ob-btn" disabled={props.disabled} onClick={props.onPrimary}>
        <span>{props.primary}</span>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7h8M8 3.5 11.5 7 8 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {props.secondary ? <button type="button" className="ob-link" onClick={props.onSecondary}>{props.secondary}</button> : null}
    </div>
  );
}

/**
 * Cross-fades step content. The outgoing step lifts away blurred while the
 * container eases to the new height, so the panel never jumps.
 */
function Swap({ id, direction, children }: { id: string; direction: 1 | -1; children: ReactNode }) {
  const [leaving, setLeaving] = useState<{ id: string; node: ReactNode } | null>(null);
  const last = useRef<{ id: string; node: ReactNode }>({ id, node: children });
  const box = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  const [shown, setShown] = useState(id);
  if (shown !== id) {
    // `last` still holds the previous step's last render.
    setShown(id);
    setLeaving(last.current);
  }
  useLayoutEffect(() => { last.current = { id, node: children }; });
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), 360);
    return () => clearTimeout(timer);
  }, [leaving]);

  useLayoutEffect(() => {
    const node = current.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    setHeight(node.offsetHeight);
    return () => observer.disconnect();
  }, [id]);

  return (
    <div ref={box} className="ob-swap" data-direction={direction} style={{ height: height ?? undefined }}>
      {leaving ? <div key={`leave-${leaving.id}`} className="ob-swap-item" data-leaving="true" aria-hidden="true" inert>{leaving.node}</div> : null}
      <div key={id} ref={current} className="ob-swap-item">{children}</div>
    </div>
  );
}

function PathCard(props: { index: number; icon: ReactNode; title: string; detail: string; tag: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button ref={ref} type="button" className="ob-path ob-rise" style={{ '--i': props.index } as CSSProperties} onClick={props.onClick}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty('--mx', `${event.clientX - rect.left}px`);
        event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`);
      }}>
      <span className="ob-path-glow" aria-hidden="true" />
      <span className="ob-path-icon">{props.icon}</span>
      <span className="ob-path-tag">{props.tag}</span>
      <strong>{props.title}</strong>
      <small>{props.detail}</small>
      <span className="ob-path-go" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8M8 3.5 11.5 7 8 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
    </button>
  );
}

const SIGNOFFS = ['Thanks', 'Best', 'Cheers', 'Warmly'];
const GREETING: Record<VoiceProfile['formality'], string> = { casual: 'Hey', neutral: 'Hi', formal: 'Hello' };
const BODY: Record<VoiceProfile['formality'], [string, string]> = {
  casual: ['Friday works for me! I’ll send the updated screens tonight.', 'Happy to jump on a quick call if anything’s unclear.'],
  neutral: ['Friday works. I’ll send the updated screens tonight so you have time to look.', 'Happy to walk through the changes on a call if that helps.'],
  formal: ['Friday works well for me. I will send the updated screens this evening so you have time to review them.', 'I would be glad to walk you through the changes on a call.'],
};

function VoiceStep({ voice, onChange }: { voice: VoiceProfile; onChange: (partial: Partial<VoiceProfile>) => void }) {
  const set = <K extends keyof VoiceProfile>(key: K, value: VoiceProfile[K]) => onChange({ [key]: value });
  const [first, second] = BODY[voice.formality];
  const body = voice.concision === 'short' ? first.split(/(?<=[.!]) /)[0] : voice.concision === 'long' ? `${first} ${second}` : first;
  return (
    <>
      <div className="ob-fields ob-rise" style={{ '--i': 3 } as CSSProperties}>
        <label className="ob-field">
          <span>Your name</span>
          <input value={voice.name} placeholder="Alex" autoComplete="given-name" onChange={(event) => set('name', event.target.value)} />
        </label>
        <div className="ob-field">
          <span>Sign-off</span>
          <div className="ob-chips" role="radiogroup" aria-label="Sign-off">
            {SIGNOFFS.map((signoff) => <button key={signoff} type="button" role="radio" aria-checked={voice.signoff === signoff} className="ob-chip" onClick={() => set('signoff', signoff)}>{signoff}</button>)}
          </div>
        </div>
        <div className="ob-field-row">
          <Segmented label="Tone" value={voice.formality} options={[['casual', 'Casual'], ['neutral', 'Neutral'], ['formal', 'Formal']]}
            onChange={(formality) => onChange({ formality, greeting: GREETING[formality] })} />
          <Segmented label="Length" value={voice.concision} options={[['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']]} onChange={(value) => set('concision', value)} />
        </div>
      </div>
      <div className="ob-draft ob-rise" style={{ '--i': 6 } as CSSProperties}>
        <div className="ob-draft-head"><span className="ob-draft-dot" />Draft to Maya Chen<span className="ob-draft-tag">Preview</span></div>
        <p key={`${voice.formality}-${voice.concision}`} className="ob-draft-body ob-morph">
          {GREETING[voice.formality]} Maya,<br /><br />{body}<br /><br />{voice.signoff || 'Thanks'},<br /><span className="ob-draft-name">{voice.name || 'You'}</span>
        </p>
      </div>
    </>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  const index = Math.max(0, options.findIndex(([option]) => option === value));
  return (
    <div className="ob-field">
      <span>{label}</span>
      <div className="ob-seg" role="radiogroup" aria-label={label} style={{ '--n': options.length, '--k': index } as CSSProperties}>
        <span className="ob-seg-thumb" aria-hidden="true" />
        {options.map(([option, text]) => <button key={option} type="button" role="radio" aria-checked={option === value} onClick={() => onChange(option)}>{text}</button>)}
      </div>
    </div>
  );
}

function addBusinessDays(from: Date, days: number) {
  const date = new Date(from);
  let left = days;
  while (left > 0) { date.setDate(date.getDate() + 1); if (date.getDay() !== 0 && date.getDay() !== 6) left -= 1; }
  return date;
}

function FollowupStep({ days, mode, onDays, onMode }: { days: number; mode: 'ai_needed' | 'every_external'; onDays: (days: number) => void; onMode: (mode: 'ai_needed' | 'every_external') => void }) {
  const sent = new Date();
  const nudge = addBusinessDays(sent, days);
  const label = nudge.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <>
      <div className="ob-timeline ob-rise" style={{ '--i': 3 } as CSSProperties}>
        <div className="ob-timeline-track"><span className="ob-timeline-fill" style={{ '--p': Math.min(1, days / 7) } as CSSProperties} /></div>
        <div className="ob-timeline-pin" data-at="start"><b>Sent</b>Today</div>
        <div className="ob-timeline-pin" data-at="end" style={{ '--p': Math.min(1, days / 7) } as CSSProperties}><b>Nudge</b><span key={days} className="ob-morph">{label}</span></div>
      </div>
      <div className="ob-field ob-rise" style={{ '--i': 4 } as CSSProperties}>
        <span>Wait</span>
        <div className="ob-chips" role="radiogroup" aria-label="Business days before a nudge">
          {[1, 2, 3, 5, 7].map((value) => <button key={value} type="button" role="radio" aria-checked={days === value} className="ob-chip" onClick={() => onDays(value)}>{value} {value === 1 ? 'day' : 'days'}</button>)}
        </div>
      </div>
      <div className="ob-options ob-rise" style={{ '--i': 5 } as CSSProperties} role="radiogroup" aria-label="Which emails get nudges">
        <button type="button" role="radio" aria-checked={mode === 'ai_needed'} className="ob-option" onClick={() => onMode('ai_needed')}><strong>When a reply is expected</strong><small>Pidgy reads the thread and skips FYIs.</small></button>
        <button type="button" role="radio" aria-checked={mode === 'every_external'} className="ob-option" onClick={() => onMode('every_external')}><strong>Everything I send out</strong><small>Any email to someone outside your domain.</small></button>
      </div>
    </>
  );
}

const NOISE: Array<{ id: ThreadCategory; title: string; example: string }> = [
  { id: 'PROMOTIONS', title: 'Promotions', example: 'Sales, deals, “last chance”' },
  { id: 'NOTIFICATIONS', title: 'Notifications', example: 'Likes, mentions, app alerts' },
  { id: 'NEWS', title: 'Newsletters', example: 'Digests and roundups' },
];

function ArchiveStep({ value, onChange }: { value: ThreadCategory[]; onChange: (value: ThreadCategory[]) => void }) {
  return (
    <div className="ob-options ob-rise" style={{ '--i': 3 } as CSSProperties}>
      {NOISE.map((item) => {
        const on = value.includes(item.id);
        return (
          <button key={item.id} type="button" className="ob-option ob-option-check" aria-pressed={on}
            onClick={() => onChange(on ? value.filter((category) => category !== item.id) : [...value, item.id])}>
            <span><strong>{item.title}</strong><small>{item.example}</small></span>
            <span className="ob-check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 8.5 7 11l5-6" /></svg></span>
          </button>
        );
      })}
    </div>
  );
}

function TrackingDemo() {
  return (
    <div className="ob-track ob-rise" style={{ '--i': 3 } as CSSProperties}>
      <div className="ob-track-row">
        <span className="ob-track-to">To Priya Raman</span>
        <span className="ob-track-subject">Proposal for Q4 partnership</span>
        <span className="ob-track-pill"><span className="ob-track-ping" />Opened 3×</span>
      </div>
      <ol className="ob-track-log">
        <li style={{ '--i': 0 } as CSSProperties}><b>Opened</b> on Mac · 2h ago</li>
        <li style={{ '--i': 1 } as CSSProperties}><b>Clicked</b> the deck link · 1h ago</li>
        <li style={{ '--i': 2 } as CSSProperties}><b>Opened</b> on iPhone · 12m ago</li>
      </ol>
    </div>
  );
}

function FeatureIcon({ id }: { id: Feature }) {
  const paths: Record<Feature, ReactNode> = {
    sort: <><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="10" rx="1.5" /><rect x="17" y="4" width="4" height="6" rx="1.5" /></>,
    summaries: <><path d="M5 6h14M5 10h14M5 14h9" /><path d="m17 15 1 2.2 2.2 1-2.2 1L17 21.4l-1-2.2-2.2-1 2.2-1Z" /></>,
    drafts: <><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    followups: <><circle cx="12" cy="13" r="7" /><path d="M12 9v4l2.5 2M9 3h6" /></>,
    archive: <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" /></>,
    tracking: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[id]}</svg>;
}

function LaptopIcon() {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /><path d="M10 9.5 12 11.5l3-3" /></svg>;
}

function CloudIcon() {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.5 9.6 4.2 4.2 0 0 0 7 18Z" /><path d="M12 11v4M10 13h4" /></svg>;
}
