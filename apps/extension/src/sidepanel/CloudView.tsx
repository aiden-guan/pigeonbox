/**
 * PigeonBox Cloud in the side panel: Home (what needs you, what is prepared,
 * what happened while you were away), every prepared draft, approvals and
 * activity. Shown only in Cloud mode. Every call goes through the service
 * worker (`CLOUD_CALL`), which holds the session and allows only listed routes.
 */
import type { Approval, CloudOverview, DraftListItem, FocusItem, RouteResponse } from '@pigeonbox/api-contract';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { trackProductEvent } from '../ui/analytics';
import { Orb } from '../ui/Orb';
import { relative } from './WaitingView';
import { CloudHome, type HomeTarget } from './CloudHome';
import { CloudPreview } from './CloudPreview';
import { useProductState } from '../ui/product-state';
import { openCloud, availableCloudFeatures } from '../ui/cloud-features';
import { mailStatus, type DraftFilter } from './cloud-presenters';
import { useWorkspaceInput } from '../workspace/session';
import type { ReviewTarget } from './DraftReview';
const BriefingsView = lazy(() => import('./BriefingsView').then((m) => ({ default: m.BriefingsView })));
const RulesView = lazy(() => import('./RulesView').then((m) => ({ default: m.RulesView })));
const ActivityView = lazy(() => import('./ActivityView').then((m) => ({ default: m.ActivityView })));
const DocumentsView = lazy(() => import('./DocumentsView').then((m) => ({ default: m.DocumentsView })));
const ContactsView = lazy(() => import('./ContactsView').then((m) => ({ default: m.ContactsView })));
const DraftsView = lazy(() => import('./DraftsView').then((m) => ({ default: m.DraftsView })));
const DraftReview = lazy(() => import('./DraftReview').then((m) => ({ default: m.DraftReview })));

export { cloudCall } from './cloud-api';
import { callCloud, cloudCall } from './cloud-api';

const PLACEHOLDER = /\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\]/g;
const newKey = () => crypto.randomUUID();
type FocusQueueResponse = RouteResponse<'focusQueue'>;

function ApprovalCard(props: { approval: Approval; focused?: boolean; onDone: (message: string) => void }) {
  const { approval } = props;
  const decisionKeys = useRef({ approve: newKey(), reject: newKey() });
  const [completed, setCompleted] = useState('');
  const [body, setBody] = useState(approval.preview.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = [...new Set(body.match(PLACEHOLDER) ?? [])];
  const editable = approval.kind === 'send_email';
  const card = useRef<HTMLLIElement>(null);
  useEffect(() => { if (props.focused) { card.current?.scrollIntoView({ block: 'nearest' }); card.current?.focus(); } }, [props.focused]);

  async function decide(decision: 'approve' | 'reject') {
    setError('');
    if (decision === 'approve' && open.length) return setError(`Fill in ${open.join(', ')} first.`);
    if (decision === 'approve' && approval.kind === 'send_email') {
      const to = approval.preview.to?.join(', ') ?? 'the recipients shown';
      const many = (approval.preview.count ?? 1) > 1;
      if (!window.confirm(many ? `Send ${approval.preview.count} individual emails, starting within the sending window?` : `Send this email to ${to} now?`)) return;
    }
    setBusy(true);
    const edited = editable && body !== (approval.preview.body ?? '') ? { edits: { body } } : {};
    const result = await cloudCall<{ approval: Approval }>('approvalDecide', { id: approval.id, decision, idempotencyKey: decisionKeys.current[decision], ...edited });
    setBusy(false);
    if (!result.ok) return setError(result.reason);
    trackProductEvent('first_approval_decided', { surface: 'sidepanel', outcome: 'success' });
    setCompleted(decision === 'approve' ? 'Approved.' : 'Rejected. Nothing was done.');
    await new Promise((resolve) => window.setTimeout(resolve, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200));
    props.onDone(decision === 'approve' ? (approval.kind === 'send_email' ? 'Approved. Sending now.' : 'Approved.') : 'Rejected. Nothing was done.');
  }

  return (
    <li ref={card} className="gi-approval" data-complete={Boolean(completed)} data-focused={props.focused || undefined} tabIndex={props.focused ? -1 : undefined}>
      {completed ? <p role="status" className="gi-note">{completed}</p> : null}
      <div className="gi-approval-head">
        <strong>{approval.title}</strong>
        <span className={approval.tier >= 3 ? 'gi-mini is-hot' : 'gi-mini'}>Tier {approval.tier}</span>
      </div>
      <p className="gi-muted text-[12px]">
        {approval.responsible.name} · {relative(approval.createdAt)}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed">{approval.why}</p>
      <dl className="gi-approval-preview">
        {approval.preview.to?.length ? (
          <div>
            <dt>To</dt>
            <dd>{approval.preview.to.join(', ')}</dd>
          </div>
        ) : null}
        {approval.preview.subject ? (
          <div>
            <dt>Subject</dt>
            <dd>{approval.preview.subject}</dd>
          </div>
        ) : null}
        {approval.preview.event ? (
          <div>
            <dt>Event</dt>
            <dd>
              {approval.preview.event.title} · {new Date(approval.preview.event.start).toLocaleString()}
            </dd>
          </div>
        ) : null}
        {approval.preview.change ? (
          <div>
            <dt>Change</dt>
            <dd>{approval.preview.change}</dd>
          </div>
        ) : null}
      </dl>
      {approval.preview.body !== undefined ? (
        <textarea className="gi-field gi-approval-body" aria-label="Message" value={body} readOnly={!editable} rows={Math.min(10, body.split('\n').length + 1)} onChange={(event) => setBody(event.target.value)} />
      ) : null}
      {open.length ? <p className="gi-warn">Fill in {open.join(', ')} before approving.</p> : null}
      {error ? <p className="gi-danger" role="alert">{error}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="button" className="gi-btn" disabled={busy || Boolean(completed) || open.length > 0} onClick={() => void decide('approve')}>
          {busy ? 'Working…' : 'Approve'}
        </button>
        <button type="button" className="gi-btn gi-btn-ghost" disabled={busy || Boolean(completed)} onClick={() => void decide('reject')}>
          Reject
        </button>
      </div>
    </li>
  );
}

function Approvals(props: { focusId?: string; onCount: (count: number) => void }) {
  const [items, setItems] = useState<Approval[] | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const { onCount } = props;

  const load = useCallback(async () => {
    const result = await cloudCall<{ approvals: Approval[]; pending: number }>('approvals', { status: 'pending', limit: 30 });
    if (!result.ok) return setError(result.reason);
    setItems(result.data.approvals);
    onCount(result.data.pending);
  }, [onCount]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="px-4"><p className="gi-warn" role="alert">Approvals could not load. {error}</p><button type="button" className="gi-btn gi-btn-ghost" onClick={() => { setError(''); void load(); }}>Try again</button></div>;
  if (!items) return <p className="gi-muted gi-orb-line px-4" role="status"><Orb size={16} />Loading approvals…</p>;
  return (
    <section className="px-4">
      {notice ? <p className="gi-note" role="status">{notice}</p> : null}
      {items.length ? (
        <ul className="gi-approvals">
          {items.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} focused={approval.id === props.focusId} onDone={(message) => { setNotice(message); void load(); }} />
          ))}
        </ul>
      ) : (
        <p className="gi-muted text-[12px] leading-relaxed">Nothing is waiting. Anything that would send an email or invite people appears here first, exactly as it would go out.</p>
      )}
    </section>
  );
}

function Focus(props: { initialSection?: string; onOpenThread: (threadId: string, accountId?: string) => void }) {
  const [queue, setQueue] = useState<FocusQueueResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void cloudCall<FocusQueueResponse>('focusQueue', { limit: 40 }).then((result) => (result.ok ? setQueue(result.data) : setError(result.reason)));
  }, []);
  if (error) return <div className="px-4"><p className="gi-warn" role="alert">Your queue could not load. {error}</p></div>;
  if (!queue) return <p className="gi-muted gi-orb-line px-4" role="status"><Orb size={16} />Loading your queue…</p>;
  const sections = queue.sections.filter((section) => section.items.length);
  return (
    <section>
      {sections.length ? (
        sections.map((section) => (
          <div key={section.id}>
            <h3 className="gi-kicker px-4 pt-3">{section.label}</h3>
            <ul className="gi-list">
              {section.items.map((item) => (
                <li key={item.threadId}>
                  <button type="button" className="gi-mail" onClick={() => props.onOpenThread(item.threadId, item.accountId)}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[13px] font-semibold tracking-[-0.02em]">{item.who}</span>
                      <span className="gi-time shrink-0">{relative(item.lastMessageAt)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[13px] text-[color:var(--pb-fg)]">{item.subject || '(no subject)'}</div>
                    {item.reasons.length ? <div className="gi-muted mt-0.5 truncate text-[12px]">{item.reasons.slice(0, 2).join(' · ')}</div> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className="gi-muted px-4 text-[12px]">You’re caught up. Nothing needs you right now.</p>
      )}
      <p className="gi-muted px-4 pb-4 pt-2 text-[11px] leading-relaxed">{queue.coverage.note}</p>
    </section>
  );
}


type OverviewState = { data: CloudOverview | null; loading: boolean; error: string; checkedAt: string | null; visitSince: string | null };

/**
 * One overview request for Home and the status line. Loading shows only while
 * a request is pending; a failed refresh keeps the last data and says so.
 */
function useCloudOverview(enabled: boolean, account: string | null, onCount: (count: number) => void) {
  const [state, setState] = useState<OverviewState>({ data: null, loading: enabled, error: '', checkedAt: null, visitSince: null });
  const since = useRef<string | undefined>(undefined);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setState((current) => ({ ...current, loading: true, error: '' }));
    const result = await callCloud('cloudOverview', since.current ? { since: since.current } : {});
    if (id !== request.current) return;
    if (!result.ok) {
      console.warn('[PigeonBox] Cloud overview refresh failed', result.code);
      return setState((current) => ({ ...current, loading: false, error: result.reason }));
    }
    trackProductEvent('first_cloud_overview_viewed', { surface: 'sidepanel', mode: 'cloud' });
    if (result.data.accounts?.some((item) => item.status === 'active' && item.sync.state === 'healthy' && item.sync.lastSyncAt)) trackProductEvent('first_cloud_sync_completed', { surface: 'sidepanel', mode: 'cloud' });
    setState((current) => ({ ...current, data: result.data, loading: false, error: '', checkedAt: result.data.generatedAt }));
    onCount(result.data.prepared?.approvalsWaiting ?? result.data.work?.approvalsWaiting ?? 0);
    if (!result.data.unavailable.length) void chrome.storage.local.set({ cloudOverviewVisit: { account, at: result.data.generatedAt } });
  }, [account, onCount]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void chrome.storage.local.get('cloudOverviewVisit').then((stored) => {
      if (!active) return;
      const visit = stored.cloudOverviewVisit as { account?: string; at?: string } | undefined;
      since.current = visit?.account === account && visit?.at && Number.isFinite(Date.parse(visit.at)) ? visit.at : undefined;
      setState((current) => ({ ...current, visitSince: since.current ?? null }));
      void load();
    });
    return () => { active = false; };
  }, [enabled, account, load]);
  return { ...state, refresh: load };
}

function CloudStatusLine(props: { overview: OverviewState; onRefresh: () => void }) {
  const { data, loading, error, checkedAt } = props.overview;
  const status = mailStatus({ accounts: data ? data.accounts : undefined, loading, refreshFailed: Boolean(error && data), checkedAt });
  return (
    <div className="pb-status" data-tone={status.tone}>
      <div className="pb-status-copy" role="status" aria-live="polite">
        <span className="pb-status-title"><i className="pb-cloud-dot" aria-hidden="true" />{status.title}</span>
        {status.detail ? <span className="pb-status-detail">{status.detail}</span> : null}
      </div>
      <div className="pb-status-actions">
        {status.action ? <button type="button" className="gi-text-btn" onClick={() => openCloud(status.action!.section)}>{status.action.label}</button> : null}
        <button type="button" className="pb-icon-btn" disabled={loading} onClick={props.onRefresh} aria-label={loading ? 'Refreshing' : 'Refresh'} title="Refresh">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" data-spinning={loading}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
    </div>
  );
}


export function CloudView(props: { initialSection?: string; onSectionChange?: (section: string) => void; onOpenThread: (threadId: string, accountId?: string) => void; onApprovalCount: (count: number) => void }) {
  const product = useProductState();
  const [view, setView] = useState(props.initialSection ?? 'overview');
  const [savedReview, saveReview, reviewReady] = useWorkspaceInput<ReviewTarget | null>(`cloud:review:${product.state.cloud.email || 'signed-out'}`, null);
  const [review, updateReview] = useState<ReviewTarget | null>(null);
  const reviewTouched = useRef(false);
  useEffect(() => { if (reviewReady && !reviewTouched.current) updateReview(savedReview); }, [savedReview, reviewReady]);
  const setReview = (target: ReviewTarget | null) => {
    reviewTouched.current = true;
    // Keep the list's current draft in memory. Only source IDs survive moving shells.
    updateReview(target);
    saveReview(target ? { threadId: target.threadId, accountId: target.accountId, from: target.from } : null);
  };
  const [draftFilter, setDraftFilter] = useState<DraftFilter | undefined>();
  const [approvalFocus, setApprovalFocus] = useState<string | undefined>();
  const [draftsRevision, setDraftsRevision] = useState(0);
  useEffect(() => { setView(props.initialSection ?? 'overview'); }, [props.initialSection]);
  const connected = product.state.runMode === 'cloud' && product.state.capabilities.some((capability) => capability.startsWith('cloud_'));
  const mailSync = product.has('cloud_mail_sync');
  const canDraft = product.has('cloud_auto_drafts');
  const overview = useCloudOverview(connected && mailSync, product.state.cloud.email, props.onApprovalCount);
  const allowed = view === 'overview' || (mailSync && (view === 'approvals' || view === 'focus' || view === 'activity')) || (canDraft && view === 'drafts') || availableCloudFeatures(product.state.capabilities).some((feature) => feature.id === view);
  function go(next: string) { setReview(null); setView(next); props.onSectionChange?.(next); }
  function goTarget(target: HomeTarget) {
    if (target.view === 'drafts') setDraftFilter(target.filter);
    if (target.view === 'approvals') setApprovalFocus(target.approvalId);
    go(target.view);
  }
  function reviewFromHome(item: FocusItem) { setReview({ threadId: item.threadId, accountId: item.accountId, subject: item.subject, who: item.who || undefined, from: 'home' }); }
  function reviewFromDrafts(item: DraftListItem) { setReview({ threadId: item.draft.threadId, accountId: item.draft.accountId, draft: item.draft, subject: item.subject, person: item.person, from: 'drafts' }); }
  function changed() { setDraftsRevision((value) => value + 1); void overview.refresh(); }

  return <div className="flex min-h-0 flex-1 flex-col">
    {connected && mailSync && !review ? <CloudStatusLine overview={overview} onRefresh={() => { void overview.refresh(); if (view === 'drafts') setDraftsRevision((value) => value + 1); }} /> : null}
    {view !== 'overview' && !review ? <div className="pb-secondary-header"><button type="button" className="pb-back" onClick={() => go('overview')}>← Home</button><h2>{view.charAt(0).toUpperCase() + view.slice(1)}</h2></div> : null}
    <main className="pb-cloud-main min-h-0 flex-1 overflow-auto">
      {!connected ? <CloudPreview product={product} /> : !allowed ? <p className="gi-muted px-4 pt-3">This capability is not available for this connection.</p> : <>
        {overview.error && overview.data && !review && view === 'overview' ? <p className="gi-warn pb-inline-alert" role="alert">Could not refresh. Showing the last loaded data.</p> : null}
        {overview.error && !overview.data && view === 'overview' ? <div className="pb-inline-alert"><p className="gi-warn" role="alert">Could not load. {overview.error}</p><button type="button" className="gi-btn gi-btn-ghost" onClick={() => void overview.refresh()}>Try again</button></div> : null}

        <Suspense fallback={<p className="gi-orb-line gi-muted px-4 pt-3" role="status"><Orb size={18} />Opening…</p>}>
          {review ? <DraftReview key={`${review.accountId}:${review.threadId}`} target={review} onBack={() => setReview(null)} onOpenThread={props.onOpenThread} onChanged={changed} />
          : view === 'overview' && !mailSync ? <div className="px-4"><CloudPreview product={product} /><div className="gi-feature-grid">{availableCloudFeatures(product.state.capabilities).map((feature) => <button type="button" key={feature.id} onClick={() => setView(feature.id)}>{feature.title}</button>)}</div></div>
          : view === 'overview' ? <CloudHome data={overview.data} loading={overview.loading} capabilities={product.state.capabilities} visitSince={overview.visitSince} onOpenThread={props.onOpenThread} onReviewDraft={reviewFromHome} onGo={goTarget} onNavigate={go} />
          : view === 'drafts' ? <DraftsView initialFilter={draftFilter} revision={draftsRevision} onReview={reviewFromDrafts} onOpenThread={props.onOpenThread} />
          : view === 'approvals' ? <Approvals focusId={approvalFocus} onCount={props.onApprovalCount} />
          : view === 'focus' ? <Focus onOpenThread={props.onOpenThread} />
          : view === 'activity' ? <ActivityView capabilities={product.state.capabilities} onOpenThread={props.onOpenThread} />
          : view === 'briefings' ? <BriefingsView onOpenThread={props.onOpenThread} />
          : view === 'views' || view === 'automations' ? <RulesView key={view} kind={view} onOpenThread={props.onOpenThread} />
          : view === 'documents' ? <DocumentsView />
          : view === 'contacts' ? <ContactsView onOpenThread={props.onOpenThread} />
          : <button type="button" className="gi-btn" onClick={() => openCloud(view)}>Manage account ↗</button>}
        </Suspense>
      </>}
    </main>
  </div>;
}
