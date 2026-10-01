import { useState } from 'react';
import type { ProductControls } from '../ui/product-state';
import { Orb } from '../ui/Orb';
import { CloudConnections } from './CloudConnections';

const CLOUD_STATUS_LABEL: Record<string, string> = {
  not_configured: 'Coming soon',
  signed_out: 'Signed out',
  ready: 'Connected',
  not_entitled: 'Subscription not active',
  expired: 'Session ended. Sign in again',
  unreachable: 'PigeonBox Cloud is unreachable',
};

/**
 * "How should PigeonBox run?" — On this computer, PigeonBox Cloud, or Advanced.
 * Choosing Cloud needs an explicit agreement about where email content goes.
 * Nothing here switches mode automatically.
 */
export function RunModePanel({
  product,
  onAdvanced,
  compact = false,
  initialPickingCloud = false,
}: {
  product: ProductControls;
  onAdvanced?: () => void;
  compact?: boolean;
  initialPickingCloud?: boolean;
}) {
  const { state, busy, error } = product;
  const [pickingCloud, setPickingCloud] = useState(initialPickingCloud);
  const [consent, setConsent] = useState(false);
  const cloudMode = state.runMode === 'cloud';
  const cloudStatus = state.cloud.status;
  const signedIn = cloudStatus === 'ready' || cloudStatus === 'not_entitled' || cloudStatus === 'unreachable';

  return (
    <div className="space-y-3" id="run-mode">
      <div className="flex flex-col gap-2">
        <ModeChoice
          title="On this computer"
          detail="Private and free. No account. Mail stays on this device, or goes only to an AI provider you set up."
          active={!cloudMode}
          onClick={() => {
            setPickingCloud(false);
            if (cloudMode) void product.useLocal();
          }}
        />
        <ModeChoice
          title="PigeonBox Cloud"
          detail={
            state.cloudAvailable
              ? 'Keeps working while Gmail is closed. Connect Google for prepared drafts, follow-ups, briefings and calendar context.'
              : 'An always-on companion for your inbox. Cloud connection is not configured in this build.'
          }
          badge={state.cloudAvailable ? undefined : 'Coming soon'}
          active={cloudMode}
          disabled={!state.cloudAvailable}
          onClick={() => setPickingCloud(true)}
        />
        {compact ? null : (
          <ModeChoice
            title="Advanced"
            detail="Ollama, your own API key, self-hosted tracking and Convex, experimental options."
            active={false}
            onClick={() => onAdvanced?.()}
          />
        )}
      </div>

      {pickingCloud && !cloudMode && state.cloudAvailable ? (
        <div className="gi-card">
          <div className="text-sm font-medium">Use PigeonBox Cloud</div>
          <p className="mt-1 text-xs gi-muted">
            When PigeonBox summarizes, sorts, drafts or answers a question, the email content involved is sent over an
            encrypted connection to PigeonBox Cloud and its AI provider. It is processed to answer the request and is not
            stored. Your local index, drafts and settings stay on this computer.
          </p>
          <label className="gi-consent mt-3">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>I understand that email content is sent to PigeonBox Cloud for processing.</span>
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="gi-btn" disabled={!consent || busy} onClick={() => void product.useCloud(consent)}>
              Use PigeonBox Cloud
            </button>
            <button type="button" className="gi-btn gi-btn-ghost" onClick={() => setPickingCloud(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {cloudMode ? (
        <div className="gi-card" aria-live="polite">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">PigeonBox Cloud</div>
              <p className="mt-1 text-xs gi-muted">
                {CLOUD_STATUS_LABEL[cloudStatus] ?? cloudStatus}
                {state.cloud.email ? ` · ${state.cloud.email}` : ''}
              </p>
            </div>
            {cloudStatus === 'ready' ? <span className="gi-badge">In use</span> : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {!signedIn ? (
              <button type="button" className="gi-btn" disabled={busy} onClick={() => void product.signIn()}>
                {busy ? <><Orb size={14} tone="on-accent" />Signing in…</> : 'Sign in'}
              </button>
            ) : null}
            {cloudStatus === 'not_entitled' ? (
              <button type="button" className="gi-btn" disabled={busy} onClick={() => void product.billing('checkout')}>
                Subscribe
              </button>
            ) : null}
            {cloudStatus === 'ready' ? (
              <button type="button" className="gi-btn gi-btn-ghost" disabled={busy} onClick={() => void product.billing('portal')}>
                Manage billing
              </button>
            ) : null}
            {signedIn ? (
              <button type="button" className="gi-btn gi-btn-ghost" disabled={busy} onClick={() => void product.recheck()}>
                Check again
              </button>
            ) : null}
            {signedIn ? (
              <button type="button" className="gi-btn gi-btn-ghost" disabled={busy} onClick={() => void product.signOut()}>
                Sign out
              </button>
            ) : null}
            <button type="button" className="gi-btn gi-btn-ghost" disabled={busy} onClick={() => void product.useLocal()}>
              Run on this computer instead
            </button>
          </div>
          {cloudStatus === 'ready' && state.cloud.capabilities.includes('cloud_mail_sync') && !compact ? <CloudConnections /> : null}
          {cloudStatus !== 'ready' ? (
            <p className="mt-2 text-xs gi-muted">
              Until PigeonBox Cloud is connected, categories use on-device rules and nothing is sent to another AI provider.
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-xs gi-danger">{error}</p> : null}
    </div>
  );
}

function ModeChoice(props: {
  title: string;
  detail: string;
  badge?: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.active ? 'gi-choice is-active' : 'gi-choice'}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
    >
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
