import { FlightPath } from '../../ui/FlightPath';
import { Orb } from '../../ui/Orb';
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { categoryLabel } from './chips';
import { CloudCompanion } from './CloudCompanion';

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
  sentAt?: string | null;
  firstOpenedAt?: string | null;
};

export function ThreadPanel(props: {
  intel?: LocalThreadIntel;
  pending?: string | null;
  preview?: string | null;
  tracking?: ThreadTrackingStatus | null;
  canDraft?: boolean;
  drafting?: boolean;
  onDraft: () => void;
  onRemind: () => void;
  onRetrySummary?: () => void;
  /** What PigeonBox Cloud knows about this thread, in Cloud mode with Google connected. */
  cloud?: ThreadIntel | null;
  cloudCapabilities?: string[];
  mailbox?: string;
  onUseCloudDraft?: (body: string) => void;
}) {
  const category = categoryLabel(props.intel?.classification?.category);
  const analyzing = /analyzing|resolving/i.test(props.pending || '');
  const summaryReady =
    !analyzing &&
    ((props.intel?.summary?.source === 'model' && props.intel?.summary?.aiStatus === 'success') ||
      (props.intel?.summary?.source === 'message' && props.intel?.summary?.aiStatus !== 'failed')) &&
    Boolean(props.intel?.summary?.summary?.oneLine);
  const summary = summaryReady ? props.intel?.summary?.summary?.oneLine || null : null;
  const needsReply = Boolean(props.intel?.classification?.needsReply || props.intel?.draft?.suggestion?.body);
  const canDraft = (props.canDraft ?? needsReply) && !props.cloud?.draft?.variants.length;
  const brief = summaryReady ? props.intel?.summary?.summary : null;
  const points = sanitizeList(brief?.keyPoints || []);
  const dates = sanitizeDateTags(brief?.dates || []);
  const actions = sanitizeList(brief?.actionItems || []);
  const modelFailed = !analyzing && (props.intel?.summary?.aiStatus === 'failed' || /failed|could not|too long/i.test(props.pending || ''));
  const line = presentSummary(summary || props.pending || 'No summary yet.');
  const waiting = !summary && Boolean(props.pending);
  return (
    <div className="gi-shell" aria-label="Intelligence">
      <div className="gi-core">
        <div className="gi-catrow">
          <div className="gi-cat">{category || 'Inbox'}</div>
          {props.intel?.manual ? <span className="gi-you">Set by you</span> : null}
          {props.pending && !waiting && /analyzing/i.test(props.pending) ? (
            <span className="gi-pending-tag" style={{ fontSize: 'var(--pb-size-meta)', opacity: 0.7, marginLeft: 'auto' }}>
              {props.pending}
            </span>
          ) : null}
        </div>
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
          <div className="gi-section"><div className="gi-dates">
            {dates.map((date) => (
              <span className="gi-date" key={date}>
                {date}
              </span>
            ))}
          </div></div>
        ) : null}
        {points.length ? (
          <div className="gi-section"><ul className="gi-points">
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
            <FlightPath points={[{ label: props.tracking.sentAt ? "Sent" : "Tracking on", detail: props.tracking.sentAt ? "Tracking enabled for this sent email." : "Tracking is enabled; a send time is not available.", at: props.tracking.sentAt }, { label: props.tracking.opened ? "Open detected" : "Waiting", detail: props.tracking.headline, at: props.tracking.firstOpenedAt, uncertain: props.tracking.opened, current: true }]} note={props.tracking.detail} />
            <div className={props.tracking.opened ? 'gi-open-label is-open' : 'gi-open-label'}>{props.tracking.markLabel}</div>


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
          <details className="pb-thread-more"><summary aria-label="More thread actions">···</summary><div className="pb-thread-menu"><button type="button" className="gi-text-btn" onClick={props.onRemind}>Remind me</button>{props.onRetrySummary ? <button type="button" className="gi-text-btn" onClick={props.onRetrySummary}>Refresh summary</button> : null}</div></details>
        </div>
      </div>
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
