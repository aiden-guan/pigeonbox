import { Brand, Pigeon } from '../ui/Pigeon';
import { useState } from 'react';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@pigeonbox/shared';
import { ProfileFields } from '../setup/ProfileFields';
import { useProductState } from '../ui/product-state';

export function OnboardingApp() {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [openCloudSetup, setOpenCloudSetup] = useState(false);
  const product = useProductState();

  function finish() {
    chrome.storage.local.set({ onboardingComplete: true });
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    // Cloud needs sign-in and explicit consent, which happen in Settings; nothing switches to Cloud here.
    if (openCloudSetup) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: 'https://mail.google.com/' });
    window.close();
  }

  return (
    <div className="gi-app flex min-h-full items-center justify-center px-6 py-16">
      <div className="gi-onboarding w-full max-w-[460px]">
        <Brand />
        <div className="gi-welcome-pigeon"><Pigeon state={step === 3 ? 'opened' : 'idle'} size={176} /></div>
        <div className="gi-steps mb-6" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((item) => (
            <span key={item} data-on={item <= step ? 'true' : 'false'} />
          ))}
        </div>
        {step > 0 ? <button type="button" className="gi-text-btn mb-5" onClick={() => setStep(step - 1)}>← Back</button> : null}
        <div className="gi-step" key={step}>
          {step === 0 ? (
            <>
              <div className="mb-4 flex items-center gap-2">

                <span className="gi-kicker">Welcome</span>
              </div>
              <h1 className="gi-display">A lighter inbox.<br />A little more you.</h1>
              <p className="gi-muted mt-4 text-[15px] leading-relaxed">Meet PigeonBox, your companion for Gmail.</p>
<p className="gi-muted mt-3 text-[14px] leading-relaxed">Catch the important bits, find the right words, and keep an eye on what happens next.</p>
              <button type="button" className="gi-btn mt-8" onClick={() => setStep(1)}>
                Continue
              </button>
            </>
          ) : null}
          {step === 1 ? (
            <>
              <h1 className="gi-display">About you</h1>
              <p className="gi-muted mt-3 text-[14px] leading-relaxed">Drafts are written as you and signed with your name. This stays on this computer.</p>
              <div className="mt-6">
                <ProfileFields voice={settings.voiceProfile} onChange={(voiceProfile) => setSettings({ ...settings, voiceProfile })} />
              </div>
              <button type="button" className="gi-btn mt-8" disabled={!settings.voiceProfile.name.trim()} onClick={() => setStep(2)}>
                Continue
              </button>
            </>
          ) : null}
          {step === 2 ? (
            <>
              <h1 className="gi-display">How should PigeonBox run?</h1>
              <p className="gi-muted mt-3 text-[14px] leading-relaxed">You can change this any time in Settings.</p>
              <div className="mt-6 flex flex-col gap-2">
                <Choice
                  title="On this computer"
                  detail="Private, free, no account. Pick a model to download in Settings, or use Chrome’s built-in model."
                  onClick={() => {
                    setSettings({ ...settings, aiMode: 'local', aiProvider: 'chrome', aiModel: 'gemini-nano' });
                    setStep(3);
                  }}
                />
                {product.state.cloudAvailable ? (
                  <Choice
                    title="PigeonBox Cloud"
                    detail="No model downloads or personal API keys. Sign in and agree to Cloud processing in Settings."
                    onClick={() => {
                      setOpenCloudSetup(true);
                      setStep(3);
                    }}
                  />
                ) : null}
                <Choice
                  title="Advanced"
                  detail="Ollama or your own API key. Set it up in Settings → Change AI."
                  onClick={() => {
                    setSettings({ ...settings, aiMode: 'remote', aiProvider: 'openai' });
                    setStep(3);
                  }}
                />
                <Choice
                  title="Skip for now"
                  detail="Categories still work with on-device rules."
                  onClick={() => {
                    setSettings({ ...settings, aiMode: 'disabled' });
                    setStep(3);
                  }}
                />
              </div>
            </>
          ) : null}
          {step === 3 ? (
            <>
              <h1 className="gi-display">Email tracking</h1>
              <p className="gi-muted mt-3 text-[14px] leading-relaxed">Tracking is separate from local AI. To count recipient opens, use a public tracker you own: Convex or Cloudflare Worker + Supabase. A tracker on your computer only works for local testing.</p>
              <div className="mt-6 flex flex-col gap-2">
                <Choice title="Configure now" detail="First deploy a tracker, then enter its URL and token in Settings." onClick={() => chrome.runtime.openOptionsPage()} />
                <Choice title="Skip for now" detail="You can turn tracking on after setup." onClick={() => setStep(4)} />
              </div>
              <p className="gi-muted mt-4 text-xs leading-relaxed">
                Setup guides: <a className="underline" href="https://github.com/aiden-guan/pigeonbox/blob/main/docs/convex-self-hosting.md" target="_blank" rel="noreferrer">Convex</a> · <a className="underline" href="https://github.com/aiden-guan/pigeonbox/blob/main/docs/self-hosting.md" target="_blank" rel="noreferrer">Cloudflare Worker + Supabase</a>
              </p>
            </>
          ) : null}
          {step === 4 ? (
            <>
              <h1 className="gi-display">Ready</h1>
              <p className="gi-muted mt-3 text-[14px] leading-relaxed">Open Gmail. Categories and summaries show up as you read. Hide the card any time from its corner.</p>
              <button type="button" className="gi-btn mt-8" onClick={finish}>
                {openCloudSetup ? 'Set up PigeonBox Cloud' : 'Open Gmail'}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Choice(props: { title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" className="gi-choice" onClick={props.onClick}>
      <span>
        <span className="block text-[14px] font-medium tracking-[-0.02em]">{props.title}</span>
        <span className="gi-muted mt-1 block text-[12px] leading-relaxed">{props.detail}</span>
      </span>
      <span className="gi-choice-go" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 7h8M8 3.5 11.5 7 8 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  );
}
