import { Orb } from '../ui/Orb';
import {
  CHATGPT_DEFAULT_MODEL,
  CHATGPT_MODELS,
  LOCAL_MODEL_ORIGINS,
  LOCAL_MODELS,
  formatDownloadSize,
  getLocalModel,
  isChatGptModel,
  localModelBytes,
  localModelDtypes,
  type LocalModel,
  type LocalModelVendor,
} from '@pigeonbox/ai';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getProviderRequiredOrigin, type ExtensionSettings } from '@pigeonbox/shared';
import { deleteCachedModel, listDownloadedModelIds } from '../local-model/cache';
import {
  getOnDeviceAvailability,
  onDeviceUnavailableMessage,
  startOnDeviceDownload,
  type OnDeviceAvailability,
} from '../local-model/chrome-model';

type ChatGptStatus = {
  signedIn: boolean;
  email: string | null;
  planType: string | null;
  lastError: string | null;
};

type AdvancedProvider = 'openai' | 'openai-compatible' | 'ollama' | 'anthropic' | 'gemini';

type AdvancedDraft = {
  provider: AdvancedProvider;
  model: string;
  endpoint: string;
  apiKey: string;
};

const inputClass = 'gi-field';
const CHATGPT_ORIGIN = 'https://chatgpt.com/*';

export function AiConnect({
  settings,
  onPatch,
  onSignedIn,
  compact = false,
  intro = true,
  experimental = false,
}: {
  settings: ExtensionSettings;
  onPatch: (partial: Partial<ExtensionSettings>) => void;
  onSignedIn?: (partial: Partial<ExtensionSettings>) => void;
  compact?: boolean;
  /** The one-line overview. Off where the page already says it (onboarding). */
  intro?: boolean;
  /** Show experimental providers (ChatGPT web sign-in). Release builds pass false. */
  experimental?: boolean;
}) {
  const [status, setStatus] = useState<ChatGptStatus>({
    signedIn: false,
    email: null,
    planType: null,
    lastError: null,
  });
  const [availability, setAvailability] = useState<OnDeviceAvailability | 'checking'>('checking');
  const [waitingForLogin, setWaitingForLogin] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [downloadedIds, setDownloadedIds] = useState<string[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const shaderF16 = useShaderF16();
  const downloadingRef = useRef<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [experimentalOpen, setExperimentalOpen] = useState(settings.aiProvider === 'chatgpt');
  const [advanced, setAdvanced] = useState<AdvancedDraft>(() => initialAdvanced(settings));

  const chatgptActive =
    settings.aiMode !== 'disabled' && settings.aiProvider === 'chatgpt' && status.signedIn;
  const onDeviceActive =
    settings.aiMode === 'local' && settings.aiProvider === 'chrome' && availability === 'available';
  const localActiveId =
    settings.aiMode === 'local' && settings.aiProvider === 'local' && downloadedIds.includes(settings.aiModel)
      ? settings.aiModel
      : null;

  useEffect(() => {
    void getOnDeviceAvailability().then(setAvailability);
    void listDownloadedModelIds().then(setDownloadedIds);
    if (!hasRuntime()) return;
    const refresh = () => {
      chrome.runtime.sendMessage({ type: 'CHATGPT_STATUS' }, (response?: ChatGptStatus) => {
        if (chrome.runtime.lastError || !response) return;
        setStatus(response);
      });
      void getOnDeviceAvailability().then(setAvailability);
      void listDownloadedModelIds().then(setDownloadedIds);
    };
    refresh();
    const onFinished = (message: {
      type?: string;
      ok?: boolean;
      email?: string | null;
      planType?: string | null;
      error?: string;
    }) => {
      if (message?.type !== 'CHATGPT_LOGIN_FINISHED') return;
      setWaitingForLogin(false);
      if (!message.ok) {
        setAuthError(message.error || 'ChatGPT sign-in did not finish.');
        return;
      }
      setAuthError(null);
      setStatus({
        signedIn: true,
        email: message.email ?? null,
        planType: message.planType ?? null,
        lastError: null,
      });
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response?: { settings?: ExtensionSettings }) => {
        const next = response?.settings;
        if (!next) return;
        const partial = {
          aiMode: next.aiMode,
          aiProvider: next.aiProvider,
          aiModel: next.aiModel,
        };
        (onSignedIn ?? onPatch)(partial);
      });
    };
    const onProgress = (message: { type?: string; modelId?: string; fraction?: number }) => {
      if (message?.type !== 'LOCAL_MODEL_PROGRESS') return;
      if (message.modelId !== downloadingRef.current) return;
      if (typeof message.fraction === 'number') setProgress(message.fraction);
    };
    chrome.runtime.onMessage.addListener(onFinished);
    chrome.runtime.onMessage.addListener(onProgress);
    window.addEventListener('focus', refresh);
    return () => {
      chrome.runtime.onMessage.removeListener(onFinished);
      chrome.runtime.onMessage.removeListener(onProgress);
      window.removeEventListener('focus', refresh);
    };
  }, [onPatch, onSignedIn]);

  function signIn() {
    if (!hasRuntime()) {
      setAuthError('Open Settings from the extension to sign in.');
      return;
    }
    setAuthError(null);
    setWaitingForLogin(true);
    // chatgpt.com is an optional host permission, requested only when this experimental option is used.
    const request = chrome.permissions?.request
      ? chrome.permissions.request({ origins: [CHATGPT_ORIGIN] }).catch(() => false)
      : Promise.resolve(true);
    void request.then((granted) => {
      if (!granted) {
        setWaitingForLogin(false);
        setAuthError('Allow PigeonBox to reach chatgpt.com to use this experimental option.');
        return;
      }
      startChatGptSignIn();
    });
  }

  function startChatGptSignIn() {
    chrome.runtime.sendMessage(
      { type: 'CHATGPT_LOGIN' },
      (response?: { ok?: boolean; error?: string; alreadySignedIn?: boolean }) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setWaitingForLogin(false);
          setAuthError(response?.error || chrome.runtime.lastError?.message || 'Could not start ChatGPT sign-in.');
          return;
        }
        if (response.alreadySignedIn) setWaitingForLogin(false);
      },
    );
  }

  function useChatGpt() {
    onPatch({
      aiMode: 'remote',
      aiProvider: 'chatgpt',
      aiModel: isChatGptModel(settings.aiModel) ? settings.aiModel : CHATGPT_DEFAULT_MODEL,
    });
  }

  function signOut() {
    if (!hasRuntime()) return;
    chrome.runtime.sendMessage({ type: 'CHATGPT_LOGOUT' }, () => {
      setStatus({ signedIn: false, email: null, planType: null, lastError: null });
      if (settings.aiProvider === 'chatgpt') onPatch({ aiMode: 'disabled' });
    });
  }

  function downloadGemini() {
    setDownloadError(null);
    setProgress(0);
    downloadingRef.current = 'gemini-nano';
    setDownloadingId('gemini-nano');
    const pending = startOnDeviceDownload((fraction) => setProgress(fraction));
    void pending
      .then(async () => {
        setProgress(1);
        downloadingRef.current = null;
        setDownloadingId(null);
        setAvailability('available');
        onPatch({ aiMode: 'local', aiProvider: 'chrome', aiModel: 'gemini-nano' });
      })
      .catch((error: unknown) => {
        downloadingRef.current = null;
        setDownloadingId(null);
        setDownloadError(error instanceof Error ? error.message : 'Could not download the model.');
      });
  }

  async function downloadLocal(modelId: string) {
    setDownloadError(null);
    setProgress(0);
    downloadingRef.current = modelId;
    setDownloadingId(modelId);
    if (hasRuntime() && chrome.permissions?.request) {
      const granted = await chrome.permissions.request({ origins: [...LOCAL_MODEL_ORIGINS] });
      if (!granted) {
        downloadingRef.current = null;
        setDownloadingId(null);
        setDownloadError('Allow model downloads to fetch the files.');
        return;
      }
    }
    if (!hasRuntime()) {
      downloadingRef.current = null;
      setDownloadingId(null);
      setDownloadError('Open Settings from the extension to download a model.');
      return;
    }
    chrome.runtime.sendMessage({ type: 'LOCAL_MODEL_DOWNLOAD', modelId }, (response?: { ok?: boolean; error?: string }) => {
      downloadingRef.current = null;
      setDownloadingId(null);
      if (chrome.runtime.lastError || !response?.ok) {
        setDownloadError(response?.error || chrome.runtime.lastError?.message || 'Could not download the model.');
        return;
      }
      setProgress(1);
      setDownloadedIds((current) => (current.includes(modelId) ? current : [...current, modelId]));
      onPatch({ aiMode: 'local', aiProvider: 'local', aiModel: modelId });
    });
  }

  async function removeLocal(modelId: string) {
    const model = getLocalModel(modelId);
    if (!model) return;
    await deleteCachedModel(model);
    if (hasRuntime()) chrome.runtime.sendMessage({ type: 'LOCAL_MODEL_RELEASE', modelId });
    setDownloadedIds((current) => current.filter((id) => id !== modelId));
    if (settings.aiProvider === 'local' && settings.aiModel === modelId) onPatch({ aiMode: 'disabled' });
  }

  const accountLabel = formatAccount(status.email, status.planType);
  const hardwareHint = availability === 'checking' ? '' : onDeviceUnavailableMessage(availability);
  const showChatGptError = authError || (chatgptActive ? status.lastError : null);

  return (
    <div id="ai-setup" className="space-y-3">
      {intro ? (
        <p className="text-sm gi-muted">
          Use a model on this computer, Ollama, or your own API key. Mail never goes to the tracker.
        </p>
      ) : null}

      <div className={cardClass(Boolean(localActiveId) || onDeviceActive)}>
        <div className="text-sm font-medium">On this computer</div>
        <p className="mt-1 text-xs gi-muted">
          Each model downloads only when you choose it. Remove deletes its files from this computer.
        </p>
        <div className="mt-3 space-y-3">
          {LOCAL_MODELS.map((model) => {
            const ready = downloadedIds.includes(model.id);
            const active = localActiveId === model.id;
            const downloading = downloadingId === model.id;
            return (
              <ModelRow
                key={model.id}
                model={model}
                active={active}
                sizeLabel={formatDownloadSize(localModelBytes(model, localModelDtypes(model, shaderF16)[0]!))}
              >
                {ready ? (
                  <>
                    <button
                      className={primaryClass}
                      disabled={active || Boolean(downloadingId)}
                      onClick={() => void downloadLocal(model.id)}
                    >
                      {active ? 'Using this model' : downloading ? <><Orb size={14} tone="on-accent" />Checking model…</> : 'Use this model'}
                    </button>
                    <button className={quietClass} onClick={() => void removeLocal(model.id)} disabled={Boolean(downloadingId)}>
                      Remove
                    </button>
                  </>
                ) : (
                  <button
                    className={primaryClass}
                    onClick={() => void downloadLocal(model.id)}
                    disabled={Boolean(downloadingId)}
                  >
                    {downloading ? <><Orb size={14} tone="on-accent" />Downloading…</> : 'Download'}
                  </button>
                )}
                {downloading ? <ProgressBar progress={progress} /> : null}
              </ModelRow>
            );
          })}
          <ModelRow
            model={{
              ...GEMINI_NANO_INFO,
              blurb: availability === 'available'
                ? 'Already downloaded by Chrome. Summaries and drafts stay on this device.'
                : GEMINI_NANO_INFO.blurb,
            }}
            sizeLabel={availability === 'available' ? 'Installed' : 'Managed by Chrome'}
            active={onDeviceActive}
          >
            {availability === 'available' ? (
              <button
                className={primaryClass}
                onClick={() => onPatch({ aiMode: 'local', aiProvider: 'chrome', aiModel: 'gemini-nano' })}
                disabled={onDeviceActive}
              >
                {onDeviceActive ? 'Using this model' : 'Use this model'}
              </button>
            ) : (
              <button
                className={primaryClass}
                onClick={downloadGemini}
                disabled={
                  Boolean(downloadingId) ||
                  availability === 'checking' ||
                  availability === 'unavailable' ||
                  availability === 'unsupported'
                }
              >
                {downloadingId === 'gemini-nano'
                  ? 'Downloading…'
                  : availability === 'checking'
                    ? 'Checking…'
                    : 'Download'}
              </button>
            )}
            {downloadingId === 'gemini-nano' ? <ProgressBar progress={progress} /> : null}
            {hardwareHint && availability !== 'available' ? (
              <p className="w-full text-xs gi-muted">{hardwareHint}</p>
            ) : null}
          </ModelRow>
        </div>
        {downloadError ? <p className="mt-2 text-xs gi-danger">{downloadError}</p> : null}
      </div>

      {settings.aiMode !== 'disabled' ? (
        <button className={quietClass} onClick={() => onPatch({ aiMode: 'disabled' })}>
          Turn AI off
        </button>
      ) : (
        <p className="text-xs gi-muted">AI is off. Categories still use local rules until you connect a model.</p>
      )}

      {compact ? null : (
        <div className="gi-card">
          <button type="button" className="gi-text-btn" onClick={() => setAdvancedOpen((open) => !open)}>
            {advancedOpen ? 'Hide API key and Ollama' : 'API key or Ollama'}
          </button>
          {advancedOpen ? (
            <div className="mt-3 space-y-3">
              <label className="block text-xs gi-muted">
                Provider
                <select
                  className={`${inputClass} mt-1`}
                  value={advanced.provider}
                  onChange={(event) => {
                    const provider = event.target.value as AdvancedProvider;
                    setAdvanced((current) => ({
                      ...current,
                      provider,
                      endpoint:
                        provider === 'ollama'
                          ? 'http://127.0.0.1:11434/v1'
                          : current.endpoint || 'https://api.openai.com/v1',
                      model: provider === 'ollama' && current.model === 'gpt-4o-mini' ? 'llama3.1' : current.model,
                    }));
                  }}
                >
                  <option value="openai">OpenAI API key</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                  <option value="ollama">Ollama on this computer</option>
                  <option value="anthropic" disabled>Anthropic (Not supported)</option>
                  <option value="gemini" disabled>Gemini API (Not supported)</option>
                </select>
              </label>
              <label className="block text-xs gi-muted">
                Model
                <input
                  className={`${inputClass} mt-1`}
                  value={advanced.model}
                  onChange={(event) => setAdvanced((current) => ({ ...current, model: event.target.value }))}
                />
              </label>
              <label className="block text-xs gi-muted">
                Endpoint
                <input
                  className={`${inputClass} mt-1`}
                  value={advanced.endpoint}
                  onChange={(event) => setAdvanced((current) => ({ ...current, endpoint: event.target.value }))}
                />
              </label>
              {advanced.provider === 'ollama' ? null : (
                <label className="block text-xs gi-muted">
                  API key
                  <input
                    className={`${inputClass} mt-1`}
                    type="password"
                    value={advanced.apiKey}
                    onChange={(event) => setAdvanced((current) => ({ ...current, apiKey: event.target.value }))}
                  />
                </label>
              )}
              <button
                className={primaryClass}
                onClick={async () => {
                  setAuthError(null);
                  const origin = getProviderRequiredOrigin(advanced.provider, advanced.endpoint);
                  if (origin && hasRuntime() && chrome.permissions?.request) {
                    try {
                      const granted = await chrome.permissions.request({ origins: [origin] });
                      if (!granted) {
                        setAuthError(`Host permission for ${origin} was not granted. Please approve to connect.`);
                        return;
                      }
                    } catch (err) {
                      setAuthError(err instanceof Error ? err.message : 'Could not request host permission.');
                      return;
                    }
                  } else if (advanced.provider === 'openai-compatible' && !origin) {
                    setAuthError('Invalid endpoint URL. Please enter a valid http/https URL.');
                    return;
                  }
                  onPatch({
                    aiMode: advanced.provider === 'ollama' ? 'local' : 'remote',
                    aiProvider: advanced.provider,
                    aiModel: advanced.model,
                    aiEndpoint: advanced.endpoint,
                    aiApiKey: advanced.apiKey,
                  });
                }}
              >
                Use this connection
              </button>
              {authError ? <p className="mt-2 text-xs gi-danger">{authError}</p> : null}
              <p className="text-xs gi-muted">
                The key stays in extension storage. Anthropic and Gemini API adapters are not finished; use an
                OpenAI-compatible endpoint for those.
              </p>
            </div>
          ) : null}
        </div>
      )}

      {compact || !experimental ? null : (
        <div className="gi-card">
          <button type="button" className="gi-text-btn" onClick={() => setExperimentalOpen((open) => !open)}>
            {experimentalOpen ? 'Hide experimental options' : 'Experimental options'}
          </button>
          {experimentalOpen ? (
            <div className="mt-3">
      <div className={cardClass(chatgptActive)}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">ChatGPT account · Experimental</div>
                    <p className="mt-1 text-xs gi-muted">
                      Not a supported provider. It reuses your chatgpt.com browser session through unofficial web endpoints.
                    </p>
                    <p className="mt-1 text-xs gi-muted">
                      May stop working when ChatGPT web internals change.{' '}
                      {status.signedIn
                        ? accountLabel
                        : 'Sign in with the ChatGPT account you already use. Requests use that plan’s message allowance. Inbox text is sent as a temporary chat.'}
                    </p>
                  </div>
                  {chatgptActive ? <Badge>In use</Badge> : null}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {status.signedIn ? (
                    <button className={primaryClass} onClick={useChatGpt} disabled={chatgptActive}>
                      {chatgptActive ? 'Using ChatGPT' : 'Use ChatGPT'}
                    </button>
                  ) : (
                    <button className={primaryClass} onClick={signIn} disabled={waitingForLogin}>
                      {waitingForLogin ? <><Orb size={14} tone="on-accent" />Waiting for sign-in…</> : 'Sign in with ChatGPT'}
                    </button>
                  )}
                  {status.signedIn ? (
                    <button className={quietClass} onClick={signOut}>
                      Sign out
                    </button>
                  ) : null}
                </div>
                {status.signedIn && chatgptActive ? (
                  <label className="mt-3 block text-xs gi-muted">
                    Model
                    <select
                      className={`${inputClass} mt-1`}
                      value={isChatGptModel(settings.aiModel) ? settings.aiModel : CHATGPT_DEFAULT_MODEL}
                      onChange={(event) =>
                        onPatch({
                          aiMode: 'remote',
                          aiProvider: 'chatgpt',
                          aiModel: event.target.value,
                        })
                      }
                    >
                      {CHATGPT_MODELS.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {showChatGptError ? <p className="mt-2 text-xs gi-danger">{showChatGptError}</p> : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function initialAdvanced(settings: ExtensionSettings): AdvancedDraft {
  const provider = isAdvancedProvider(settings.aiProvider) ? settings.aiProvider : 'openai';
  return {
    provider,
    model: provider === settings.aiProvider ? settings.aiModel : provider === 'ollama' ? 'llama3.1' : 'gpt-4o-mini',
    endpoint:
      provider === settings.aiProvider
        ? settings.aiEndpoint
        : provider === 'ollama'
          ? 'http://127.0.0.1:11434/v1'
          : 'https://api.openai.com/v1',
    apiKey: settings.aiApiKey,
  };
}

function isAdvancedProvider(provider: ExtensionSettings['aiProvider']): provider is AdvancedProvider {
  return (
    provider === 'openai' ||
    provider === 'openai-compatible' ||
    provider === 'ollama' ||
    provider === 'anthropic' ||
    provider === 'gemini'
  );
}

function formatAccount(email: string | null, planType: string | null): string {
  const plan = planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : null;
  if (email && plan) return `${email} · ${plan}`;
  return email || plan || 'Signed in with ChatGPT';
}

function cardClass(active: boolean): string {
  return active ? 'gi-card gi-card-active' : 'gi-card';
}

function ProgressBar({ progress }: { progress: number }) {
  const amount = Math.max(progress || 0.05, 0.05);
  return (
    <div className="mt-2">
      <div className="gi-progress" aria-hidden="true">
        <div style={{ transform: `scaleX(${amount})` }} />
      </div>
      <p className="mt-1 text-xs gi-muted">
        {progress > 0 ? `${Math.round(progress * 100)}%` : 'Starting download…'} Keep this page open.
      </p>
    </div>
  );
}

/** GPUs with shader-f16 get the smaller q4f16 build of some models. */
function useShaderF16(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter(): Promise<{ features?: { has(name: string): boolean } } | null> };
    }).gpu;
    void gpu
      ?.requestAdapter()
      .then((adapter) => setSupported(Boolean(adapter?.features?.has('shader-f16'))))
      .catch(() => undefined);
  }, []);
  return supported;
}

type ModelInfo = Pick<LocalModel, 'label' | 'vendor' | 'blurb' | 'badge' | 'quality' | 'speed' | 'languages' | 'pros' | 'cons'> & {
  bytes?: number;
};

const GEMINI_NANO_INFO: ModelInfo = {
  label: 'Chrome Gemini Nano',
  vendor: 'google',
  blurb: 'Chrome’s built-in model. Larger download, for desktop Chrome with enough memory and disk.',
  quality: 4,
  speed: 3.5,
  languages: 'English',
  pros: ['Nothing extra to download if Chrome has it', 'Strong summaries'],
  cons: ['Needs about 16 GB of memory and 22 GB of disk', 'Desktop Chrome only'],
};

const VENDOR_LABEL: Record<LocalModelVendor, string> = {
  liquid: 'Liquid AI',
  google: 'Google',
  qwen: 'Alibaba Qwen',
  huggingface: 'Hugging Face',
};

/** The maker's mark from public/brand/models (see LICENSE.txt there). Google ships two families. */
function modelLogo(model: ModelInfo): string {
  const name = model.vendor === 'google' ? (/gemini/i.test(model.label) ? 'gemini' : 'gemma') : model.vendor;
  const path = `brand/models/${name}.svg`;
  return typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : `/${path}`;
}

function ModelRow({
  model,
  active,
  sizeLabel,
  children,
}: {
  model: ModelInfo;
  active: boolean;
  sizeLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className={active ? 'gi-inset gi-model is-active' : 'gi-inset gi-model'}>
      <div className="flex items-start gap-3">
        <span className="gi-model-mark" title={VENDOR_LABEL[model.vendor]} aria-hidden="true">
          <img src={modelLogo(model)} alt="" width={20} height={20} draggable={false} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{model.label}</span>
            {model.badge ? <span className="gi-badge is-tag">{model.badge}</span> : null}
            {active ? <Badge>In use</Badge> : null}
          </div>
          <p className="mt-1 text-xs gi-muted">{model.blurb}</p>
          <div className="gi-model-stats mt-2">
            <Meter label="Quality" value={model.quality} />
            <Meter label="Speed" value={model.speed} />
            <span className="gi-model-fact">{sizeLabel ?? (model.bytes ? formatDownloadSize(model.bytes) : '')}</span>
            <span className="gi-model-fact">{model.languages}</span>
          </div>
          <ul className="gi-model-notes mt-2" aria-label="Benefits and drawbacks">
            {model.pros.map((text) => (
              <li key={text} className="gi-chip is-pro">
                <span aria-hidden="true">+</span>
                <span className="sr-only">Benefit: </span>
                {text}
              </li>
            ))}
            {model.cons.map((text) => (
              <li key={text} className="gi-chip is-con">
                <span aria-hidden="true">−</span>
                <span className="sr-only">Drawback: </span>
                {text}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Five signal bars; a .5 rating half-fills the next bar. */
function Meter({ label, value }: { label: string; value: number }) {
  return (
    <span className="gi-meter" aria-label={`${label} ${value.toFixed(1)} out of 5`}>
      <span className="gi-meter-label">{label}</span>
      <span className="gi-meter-bars" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((bar) => (
          <i key={bar} className={value >= bar ? 'is-on' : value >= bar - 0.5 ? 'is-half' : ''} />
        ))}
      </span>
      <span className="gi-meter-value">{value.toFixed(1)}</span>
    </span>
  );
}

function Badge({ children }: { children: string }) {
  return <span className="gi-badge">{children}</span>;
}

function hasRuntime(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);
}

const primaryClass = 'gi-btn';
const quietClass = 'gi-btn gi-btn-ghost';
