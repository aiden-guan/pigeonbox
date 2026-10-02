import type { DraftListItem, DraftListResponse } from '@pigeonbox/api-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Orb } from '../ui/Orb';
import { callCloud } from './cloud-api';
import { ago, DRAFT_FILTERS, draftFilterCount, draftKindLabel, draftStateLabel, openPlaceholders, personLabel, preview, type DraftFilter } from './cloud-presenters';

const EMPTY: Record<DraftFilter, { title: string; detail: string }> = {
  ready: { title: 'No drafts waiting for you.', detail: 'When new mail needs a reply, PigeonBox prepares one here.' },
  gmail: { title: 'Nothing in Gmail yet.', detail: 'Drafts you add to Gmail appear here. Nothing is sent automatically.' },
  update: { title: 'Every draft is current.', detail: 'Drafts move here when a conversation changes after they were prepared.' },
};

/**
 * Every prepared draft, as a task inbox. One request per filter page; each
 * row carries enough to render without per-draft calls. Full thread context
 * loads only when a draft is opened for review.
 */
export function DraftsView(props: {
  initialFilter?: DraftFilter;
  onReview: (item: DraftListItem) => void;
  onOpenThread: (id: string, accountId?: string) => void;
  /** Drafts that changed in review, so the list reflects them without a reload. */
  revision: number;
}) {
  const [filter, setFilter] = useState<DraftFilter>(props.initialFilter ?? 'ready');
  const [data, setData] = useState<DraftListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => { if (props.initialFilter) setFilter(props.initialFilter); }, [props.initialFilter]);

  const load = useCallback(async (next: DraftFilter) => {
    const id = ++request.current;
    setLoading(true);
    setError('');
    const statuses = DRAFT_FILTERS.find((item) => item.id === next)!.statuses;
    const result = await callCloud('draftList', { statuses, limit: 20 });
    if (id !== request.current) return;
    setLoading(false);
    if (!result.ok) return setError(result.reason);
    setData(result.data);
  }, []);
  useEffect(() => { void load(filter); }, [filter, load, props.revision]);

  async function loadMore() {
    if (!data?.nextCursor) return;
    setMore(true);
    const result = await callCloud('draftList', { statuses: DRAFT_FILTERS.find((item) => item.id === filter)!.statuses, limit: 20, cursor: data.nextCursor });
    setMore(false);
    if (!result.ok) return setError(result.reason);
    setData({ ...result.data, drafts: [...data.drafts, ...result.data.drafts] });
  }

  async function retry(item: DraftListItem) {
    setRetrying(item.draft.id);
    const result = await callCloud('draftPrepare', { accountId: item.draft.accountId, threadId: item.draft.threadId, kind: item.draft.kind });
    setRetrying(null);
    if (!result.ok) return setError(`This reply could not be prepared. ${result.reason}`);
    void load(filter);
  }

  const counts = data?.counts;
  return (
    <section className="pb-drafts" aria-labelledby="pb-drafts-title">
      <h2 id="pb-drafts-title" className="sr-only">Prepared drafts</h2>
      <div className="pb-filter" role="tablist" aria-label="Draft status">
        {DRAFT_FILTERS.map((item) => {
          const count = counts ? draftFilterCount(item.id, counts) : null;
          return (
            <button key={item.id} type="button" role="tab" id={`pb-draft-tab-${item.id}`} aria-selected={filter === item.id} aria-controls="pb-draft-panel" className="pb-filter-btn" onClick={() => setFilter(item.id)}>
              {item.label}{count ? <span className="pb-count">{count}</span> : null}
            </button>
          );
        })}
      </div>
      <div id="pb-draft-panel" role="tabpanel" aria-labelledby={`pb-draft-tab-${filter}`} aria-busy={loading}>
        {error ? (
          <p className="gi-warn" role="alert">{data ? `Drafts could not refresh. Showing the last loaded list. ${error}` : error} <button type="button" className="gi-text-btn" onClick={() => void load(filter)}>Try again</button></p>
        ) : null}
        {loading && !data ? <p className="gi-orb-line gi-muted" role="status"><Orb size={16} />Loading prepared drafts…</p> : null}
        {data && !data.drafts.length && !loading ? (
          <div className="pb-empty-line">
            <strong>{EMPTY[filter].title}</strong>
            <span>{EMPTY[filter].detail}</span>
            {filter === 'ready' && counts?.preparing ? <span className="gi-orb-line"><Orb size={12} />Preparing replies from new mail…</span> : null}
          </div>
        ) : null}
        {data?.drafts.length ? (
          <ul className="pb-draft-list" data-loading={loading}>
            {data.drafts.map((item) => <DraftRow key={item.draft.id} item={item} retrying={retrying === item.draft.id} onReview={props.onReview} onOpenThread={props.onOpenThread} onRetry={() => void retry(item)} />)}
          </ul>
        ) : null}
        {data?.nextCursor ? <button type="button" className="gi-btn gi-btn-ghost pb-more" disabled={more} onClick={() => void loadMore()}>{more ? 'Loading…' : 'Show more'}</button> : null}
      </div>
    </section>
  );
}

function DraftRow(props: { item: DraftListItem; retrying: boolean; onReview: (item: DraftListItem) => void; onOpenThread: (id: string, accountId?: string) => void; onRetry: () => void }) {
  const { draft, subject, person } = props.item;
  const variant = draft.variants[0];
  const kind = draftKindLabel(draft.kind);
  const fill = variant ? openPlaceholders(variant.body).length : 0;
  const who = personLabel(person, subject);
  return (
    <li className="pb-draft" data-status={draft.status}>
      <div className="pb-draft-top">
        <span className="pb-draft-who">{who}</span>
        <span className="pb-state" data-status={draft.status}>{draftStateLabel(draft)}</span>
      </div>
      <span className="pb-draft-subject">{subject}</span>
      <span className="pb-meta">
        {[kind, draft.status === 'preparing' ? 'Preparing now' : `Prepared ${ago(draft.freshness.createdAt)}`, fill ? `${fill} ${fill === 1 ? 'detail' : 'details'} to fill in` : null].filter(Boolean).join(' · ')}
      </span>
      {variant ? <p className="pb-draft-preview">{preview(variant.body)}</p> : null}
      {draft.status === 'stale' && draft.freshness.staleReason ? <span className="pb-draft-note">{draft.freshness.staleReason}</span> : null}
      <div className="pb-draft-actions">
        {draft.status === 'failed' ? (
          <button type="button" className="gi-btn pb-btn-sm" disabled={props.retrying} onClick={props.onRetry}>{props.retrying ? 'Preparing draft…' : 'Try again'}</button>
        ) : variant ? (
          <button type="button" className="gi-btn pb-btn-sm" onClick={() => props.onReview(props.item)} aria-label={`Review draft: ${subject}`}>Review</button>
        ) : null}
        <button type="button" className="gi-text-btn" onClick={() => props.onOpenThread(draft.threadId, draft.accountId)} aria-label={`Open thread: ${subject}`}>Open thread</button>
      </div>
    </li>
  );
}
