import { SELF_HOSTING_GUIDE_URL } from '../config';
import { useDispatchLayout } from '../ui/dispatch-motion';
import { useState } from 'react';
import type { ProductControls } from '../ui/product-state';
import { CloudConnections } from './CloudConnections';
import { openCloud, openDashboard } from '../ui/cloud-features';

const CLOUD_STATUS_LABEL: Record<string, string> = {
  not_configured: 'No server configured',
  signed_out: 'Signed out',
  ready: 'Connected',
  not_entitled: 'Signed in. AI is not on for this account',
  expired: 'Session ended. Sign in again',
  unreachable: 'Your PigeonBox server is unreachable',
  update_required: 'PigeonBox needs an update',
};

const CLOUD_NOTICE: Record<string, string> = {
  maintenance: 'Your PigeonBox server is under maintenance. PigeonBox on this computer keeps working.',
  degraded: 'Your PigeonBox server is running slower than usual.',
};

/** "You're using PigeonBox 0.5.8. Your PigeonBox server requires 0.6.0 or newer." */
export function updateMessage(update: { required: boolean; installed: string; minimum: string | null; recommended: string | null }): string {
  const target = update.required ? update.minimum : update.recommended;
  const using = `You're using PigeonBox ${update.installed}.`;
  if (!target) return update.required ? `${using} Your PigeonBox server needs a newer version.` : `${using} A newer version is available.`;
  return update.required ? `${using} Your PigeonBox server requires ${target} or newer.` : `${using} Version ${target} is recommended.`;
}

/**
 * "How should PigeonBox run?" — On this computer, your PigeonBox server (only
 * when one is configured), or Advanced. Choosing the server needs an explicit
 * agreement about where email content goes. Nothing here switches mode
 * automatically.
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
  const modeLayout = useDispatchLayout<HTMLDivElement>(state.runMode);
  const signedIn = cloudStatus === 'ready' || cloudStatus === 'not_entitled' || cloudStatus === 'unreachable' || cloudStatus === 'update_required';
  const update = state.cloud.update;

  return (
    <div ref={modeLayout} className="space-y-3 pb-run-mode" id="run-mode">
      <div className="flex flex-col gap-2">
        <ModeChoice
          title="On this computer"
          detail={
            state.cloudAvailable
              ? 'AI runs on this computer; mail stays here or goes only to an AI provider you set up. Sign in to your server only for its read receipts.'
              : 'AI runs on this computer; mail stays here or goes only to an AI provider you set up.'
          }
          active={!cloudMode}
          onClick={() => {
            setPickingCloud(false);
            if (cloudMode) void product.useLocal();
          }}
        />
        {state.cloudAvailable ? (
          <ModeChoice
            title="Your PigeonBox server"
            detail="Keeps working while Gmail is closed. Connect Google for prepared drafts, follow-ups, briefings and calendar context."
            active={cloudMode}
            // With a dashboard that can reach this build, switching (agreement, sign-in, Google) happens there.
            onClick={() => state.dashboardAvailable ? (cloudMode ? openDashboard('overview') : openDashboard('cloud', 'cloud')) : setPickingCloud(!cloudMode)}
          />
        ) : null}
        {compact ? null : (
          <ModeChoice
            title="Advanced"
            detail="Ollama, your own API key, a standalone tracker or Convex, your PigeonBox server URL, experimental options."
            active={false}
            onClick={() => onAdvanced?.()}
          />
        )}
      </div>
      {!state.cloudAvailable && !compact ? (
        <a className="gi-text-btn text-xs" href={SELF_HOSTING_GUIDE_URL} target="_blank" rel="noreferrer">
          Run your own server ↗
        </a>
      ) : null}

      {pickingCloud && !cloudMode && state.cloudAvailable ? (
        <div className="gi-card">
          <div className="text-sm font-medium">Use your PigeonBox server</div>
          <p className="mt-1 text-xs gi-muted">
            When PigeonBox summarizes, sorts, drafts or answers a question, the email content involved is sent to your
            PigeonBox server and the AI provider it is set up with. The server stores summaries, prepared drafts and related intelligence. Retaining message excerpts requires
            a separate opt-in. Your local index and settings stay on this computer.
          </p>
          <label className="gi-consent mt-3">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>I understand that email content is sent to my PigeonBox server for processing.</span>
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="gi-btn" disabled={!consent || busy} onClick={() => void product.useCloud(consent)}>
              Use my server
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
              <div className="text-sm font-medium">Your PigeonBox server</div>
              <p className="mt-1 text-xs gi-muted">
                {CLOUD_STATUS_LABEL[cloudStatus] ?? cloudStatus}
                {state.cloud.email ? ` · ${state.cloud.email}` : ''}
              </p>
            </div>
            {cloudStatus === 'ready' ? <span className="gi-badge">In use</span> : null}
          </div>
          {state.cloud.notice && CLOUD_NOTICE[state.cloud.notice] ? <p className="mt-2 text-xs gi-muted">{CLOUD_NOTICE[state.cloud.notice]}</p> : null}
          {update ? (
            // Required: server mode stops until the update (Local mode is unaffected). Recommended: one quiet line.
            <p className={update.required ? 'mt-2 text-xs' : 'mt-2 text-xs gi-muted'} role={update.required ? 'status' : undefined}>
              {updateMessage(update)}{' '}
              <button type="button" className="gi-text-btn" disabled={busy} onClick={() => void product.updateExtension()}>
                Update PigeonBox
              </button>
            </p>
          ) : null}
          {cloudStatus === 'not_entitled' ? (
            <p className="mt-2 text-xs gi-muted">Whoever runs your PigeonBox server can turn AI on for this account.</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {!signedIn && state.cloudAvailable ? (
              state.dashboardAvailable ? (
                <button type="button" className="gi-btn" disabled={busy} onClick={() => openDashboard('cloud', 'cloud')}>
                  Finish server setup ↗
                </button>
              ) : (
                <button type="button" className="gi-btn" disabled={busy} onClick={() => void product.signIn()}>
                  Sign in to your server
                </button>
              )
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
              Switch to this computer
            </button>
          </div>
          {cloudStatus === 'ready' && state.cloud.capabilities.includes('cloud_mail_sync') && !compact ? <CloudConnections /> : null}
          {state.cloudAvailable && signedIn && !compact ? (
            // The account page's address is derived from the configured server by the worker.
            <button type="button" className="gi-text-btn mt-3" onClick={() => openCloud('overview')}>
              Manage on your server ↗
            </button>
          ) : null}
          {cloudStatus !== 'ready' ? (
            <p className="mt-2 text-xs gi-muted">
              Until your PigeonBox server is connected, categories use on-device rules and nothing is sent to another AI provider.
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
        {props.active ? <span className="pb-mode-travel" data-motion-id="run-mode-indicator" aria-hidden="true" /> : null}
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
