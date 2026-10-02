import { Pigeon, type PigeonState } from '../../ui/Pigeon';
import { Orb } from '../../ui/Orb';
import { useState, type MouseEvent } from 'react';
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { categoryLabel } from './chips';
import { CloudCompanion } from './CloudCompanion';

export type IslandMode = 'docked' | 'open' | 'expanded';

/** What PigeonBox derived on this computer for a thread (classification, summary, draft). */
export type LocalThreadIntel = {
  classification?: { category?: string; needsReply?: boolean; reason?: string };
  summary?: {
    source?: 'model' | 'message';
    aiStatus?: 'queued' | 'running' | 'success' | 'failed';
    aiError?: string;
    model?: string;
    provider?: string;
    summary?: {
      reasoning?: string;
      oneLine?: string;
      keyPoints?: string[];
      decisions?: string[];
      unansweredQuestions?: string[];
      commitments?: string[];
      dates?: string[];
      actionItems?: string[];
    };
  };
  draft?: { suggestion?: { body?: string } };
  manual?: boolean;
};

export type ThreadTrackingStatus = {
  opened: boolean;
  markLabel: string;
  headline: string;
  detail: string;
  countLabel: string;
};

export function ThreadPanel(props: {
  intel?: LocalThreadIntel;
  pending?: string | null;
  preview?: string | null;
  tracking?: ThreadTrackingStatus | null;
  mode?: IslandMode;
  variant?: 'float' | 'sidebar';
  canDraft?: boolean;
  drafting?: boolean;
  onMode?: (mode: IslandMode) => void;
  onDraft: () => void;
  onRemind: () => void;
  onRetrySummary?: () => void;
  /** What PigeonBox Cloud knows about this thread, in Cloud mode with Google connected. */
  cloud?: ThreadIntel | null;
  cloudCapabilities?: string[];
  mailbox?: string;
  onUseCloudDraft?: (body: string) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState<IslandMode>('open');
  const mode = props.mode ?? uncontrolled;
  const category = categoryLabel(props.intel?.classification?.category);
  const analyzing = /analyzing/i.test(props.pending || '');
  const summaryReady =
    !analyzing &&
    ((props.intel?.summary?.source === 'model' && props.intel?.summary?.aiStatus === 'success') ||
      (props.intel?.summary?.source === 'message' && props.intel?.summary?.aiStatus !== 'failed')) &&
    Boolean(props.intel?.summary?.summary?.oneLine);
  const summary = summaryReady ? props.intel?.summary?.summary?.oneLine || null : null;
  const needsReply = Boolean(props.intel?.classification?.needsReply || props.intel?.draft?.suggestion?.body);
  const canDraft = props.canDraft ?? needsReply;
  const brief = summaryReady ? props.intel?.summary?.summary : null;
  const points = sanitizeList(brief?.keyPoints || []);
  const dates = sanitizeDateTags(brief?.dates || []);
  const actions = sanitizeList(brief?.actionItems || []);
  const modelFailed = !analyzing && (props.intel?.summary?.aiStatus === 'failed' || /failed|could not|too long/i.test(props.pending || ''));
  const line = presentSummary(summary || props.pending || 'No summary yet.');
  const waiting = !summary && Boolean(props.pending);
  const pigeonState: PigeonState = props.drafting ? 'drafting' : modelFailed ? 'error' : waiting ? 'indexing' : props.tracking?.opened ? 'opened' : 'idle';
  const pigeonLabel = props.drafting ? 'Finding the right words' : modelFailed ? 'Let’s try that again' : waiting ? 'Reading between the lines' : props.tracking?.opened ? 'An open was detected' : summaryReady ? 'The thread, untangled' : 'Ready when you are';

  const floating = (props.variant || 'float') === 'float';

  function setMode(next: IslandMode) {
    if (props.mode == null) setUncontrolled(next);
    props.onMode?.(next);
  }

  function keep(event: MouseEvent) {
    event.stopPropagation();
  }

  if (mode === 'docked') {
    return (
      <button
        type="button"
        className="gi-pill"
        data-gi-drag
        aria-expanded="false"
        aria-label="Show intelligence"
        onMouseDown={keep}
        onClick={(event) => {
          keep(event);
          setMode('open');
        }}
      >
        <Pigeon state={pigeonState} size={30} />
        <span className="gi-pill-label">{category || 'Inbox'}</span>
        <span className={waiting ? 'gi-dot is-live' : needsReply ? 'gi-dot' : 'gi-dot is-quiet'} />
      </button>
    );
  }

  return (
    <div
      className="gi-shell"
      data-mode={mode}
      data-variant={props.variant || 'float'}
      aria-label="Intelligence"
      onMouseDown={keep}
      onClick={keep}
    >
      <div className="gi-core">
        <div className="gi-bar" data-gi-drag={floating || undefined} title={floating ? 'Drag to move · double-click to reset' : undefined}>
          <div className="gi-brand">
            <Pigeon state={pigeonState} size={30} />
            <span className="gi-kicker">Pidgy / Thread brief</span>
          </div>
          <button type="button" className="gi-hide" aria-label="Hide intelligence" onClick={() => setMode('docked')}>
            Hide
          </button>
        </div>
        <div className="gi-thread-mascot" data-gi-drag={floating || undefined}><Pigeon state={pigeonState} size={44} /><div><strong>{pigeonLabel}</strong><small>THREAD BRIEF</small></div></div>
        <div className="gi-catrow">
          <div className="gi-cat">{category || 'Inbox'}</div>
          {props.intel?.manual ? <span className="gi-you">Set by you</span> : null}
          {props.pending && !waiting && /analyzing/i.test(props.pending) ? (
            <span className="gi-pending-tag" style={{ fontSize: '11px', opacity: 0.7, marginLeft: 'auto' }}>
              {props.pending}
            </span>
          ) : null}
        </div>
        <div className="gi-section-heading">Summary</div>
        {summaryReady ? <svg key={summary} className="pb-route-line" viewBox="0 0 280 10" aria-hidden="true"><path pathLength="100" d="M0 9H90Q100 9 108 3H280" fill="none" stroke="currentColor" strokeWidth="1" /></svg> : null}
        <p className={waiting ? 'gi-sum is-wait' : 'gi-sum'}>{waiting && !modelFailed ? <span className="gi-orb-line"><Orb size={14} tone="bare" />{line}</span> : line}</p>
        {modelFailed && props.onRetrySummary ? (
          <div className="gi-retry-row">
            <button
              type="button"
              className="gi-action is-ghost"
              onClick={props.onRetrySummary}
            >
              Retry
            </button>
          </div>
        ) : null}
        {dates.length ? (
          <div className="gi-section"><div className="gi-section-heading">Key date</div><div className="gi-dates">
            {dates.map((date) => (
              <span className="gi-date" key={date}>
                {date}
              </span>
            ))}
          </div></div>
        ) : null}
        {points.length ? (
          <div className="gi-section"><div className="gi-section-heading">Key details</div><ul className="gi-points">
            {points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul></div>
        ) : null}
        {actions.length ? (
          <div className="gi-section"><div className="gi-section-heading">To do</div><ul className="gi-points">
            {actions.map((action) => <li key={action}>{action}</li>)}
          </ul></div>
        ) : null}
        {props.tracking ? (
          <div className="gi-open">
            <div className={props.tracking.opened ? 'gi-open-label is-open' : 'gi-open-label'}>{props.tracking.markLabel}</div>
            <p className="gi-open-line">{props.tracking.headline}</p>
            <p className="gi-open-sub">{props.tracking.detail}</p>
            <div className={props.tracking.opened ? 'gi-open-count is-open' : 'gi-open-count'}>{props.tracking.countLabel}</div>
          </div>
        ) : null}
        {props.cloud ? <CloudCompanion key={props.cloud.threadId} intel={props.cloud} capabilities={props.cloudCapabilities} mailbox={props.mailbox} onUseDraft={(body) => props.onUseCloudDraft?.(body)} /> : null}
        <div className="gi-actions">
          {canDraft ? (
            <button
              type="button"
              className={needsReply ? 'gi-action' : 'gi-action is-ghost'}
              disabled={props.drafting}
              onClick={props.onDraft}
            >
              {props.drafting ? <span className="gi-orb-line"><Orb size={13} tone={needsReply ? 'on-accent' : 'bare'} />Drafting…</span> : 'Draft reply'}
            </button>
          ) : null}
          <button
            type="button"
            className={canDraft && !needsReply ? 'gi-action' : 'gi-action is-ghost'}
            onClick={props.onRemind}
          >
            Remind
          </button>
        </div>
      </div>
      {floating ? <div className="gi-resize" data-gi-resize aria-hidden="true" /> : null}
    </div>
  );
}

function sanitizeList(items: string[]): string[] {
  return items
    .map((item) => item.replace(/^[•\s\-*–—]+/, '').trim())
    .filter((item) => item.length >= 3 && /[a-zA-Z]{2,}/.test(item) && !/^[.\s…\-_?]+$/.test(item));
}

function presentSummary(text: string): string {
  return text
    .replace(/[-_=]{3,}/g, ' ')
    .replace(/\b(?:previous|earlier)\s+announcement\s*:?/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

function sanitizeDateTags(dates: string[]): string[] {
  const MONTHS =
    /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june|july|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
  const WEEKDAYS = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

  const cleaned: string[] = [];
  const hasSpecificDate = dates.some((d) => !MONTHS.test(d.trim()) && !WEEKDAYS.test(d.trim()));

  for (const date of dates) {
    const trimmed = date.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(trimmed)) continue;
    if (MONTHS.test(trimmed)) continue;
    if (hasSpecificDate && WEEKDAYS.test(trimmed)) continue;
    cleaned.push(trimmed);
  }

  const deduped: string[] = [];
  for (const item of cleaned) {
    const lower = item.toLowerCase();
    const alreadySubsumed = deduped.some((existing) => existing.toLowerCase().includes(lower));
    if (alreadySubsumed) continue;
    for (let i = deduped.length - 1; i >= 0; i -= 1) {
      if (lower.includes(deduped[i]!.toLowerCase())) {
        deduped.splice(i, 1);
      }
    }
    deduped.push(item);
  }
  return deduped;
}
