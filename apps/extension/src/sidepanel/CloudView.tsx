import { trackProductEvent } from '../ui/analytics';
/**
 * PigeonBox Cloud in the side panel: the approval queue, the Focus Queue
 * across connected accounts, and Ask Pigeon with sources. Shown only in Cloud
 * mode with Google connected. Every call goes through the service worker
 * (`CLOUD_CALL`), which holds the session and allows only listed routes.
 */
import type { Approval, RouteResponse } from '@pigeonbox/api-contract';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Orb } from '../ui/Orb';
import { relative } from './WaitingView';
import { CloudOverview } from './CloudOverview';
import { CloudPreview } from './CloudPreview';
import { useProductState } from '../ui/product-state';
import { openCloud, availableCloudFeatures } from '../ui/cloud-features';
const BriefingsView = lazy(() => import('./BriefingsView').then((m) => ({ default: m.BriefingsView })));
const RulesView = lazy(() => import('./RulesView').then((m) => ({ default: m.RulesView })));
const ActivityView = lazy(() => import('./ActivityView').then((m) => ({ default: m.ActivityView })));
const DocumentsView = lazy(() => import('./DocumentsView').then((m) => ({ default: m.DocumentsView })));
const ContactsView = lazy(() => import('./ContactsView').then((m) => ({ default: m.ContactsView })));

export { cloudCall } from './cloud-api';
import { cloudCall } from './cloud-api';

const PLACEHOLDER = /\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\]/g;
const newKey = () => crypto.randomUUID();
type FocusQueueResponse = RouteResponse<'focusQueue'>;

function ApprovalCard(props: { approval: Approval; onDone: (message: string) => void }) {
  const { approval } = props;
  const decisionKeys = useRef({ approve: newKey(), reject: newKey() });
  const [completed, setCompleted] = useState('');
  const [body, setBody] = useState(approval.preview.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = [...new Set(body.match(PLACEHOLDER) ?? [])];
  const editable = approval.kind === 'send_email';

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
    <li className="gi-approval" data-complete={Boolean(completed)}>
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

function Approvals(props: { onCount: (count: number) => void }) {
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

  if (error) return <div className="px-4"><p className="gi-warn" role="alert">{error}</p><button type="button" className="gi-btn gi-btn-ghost" onClick={() => window.location.reload()}>Try again</button></div>;
  if (!items) return <p className="gi-muted gi-orb-line px-4" role="status"><Orb size={16} />Loading approvals…</p>;
  return (
    <section className="px-4">
      {notice ? <p className="gi-note" role="status">{notice}</p> : null}
      {items.length ? (
        <ul className="gi-approvals">
          {items.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} onDone={(message) => { setNotice(message); void load(); }} />
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
  if (error) return <div className="px-4"><p className="gi-warn" role="alert">{error}</p><button type="button" className="gi-btn gi-btn-ghost" onClick={() => window.location.reload()}>Try again</button></div>;
  if (!queue) return <p className="gi-muted gi-orb-line px-4" role="status"><Orb size={16} />Loading…</p>;
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
                    <div className="mt-0.5 truncate text-[13px] text-[#e7e2d7]">{item.subject || '(no subject)'}</div>
                    {item.reasons.length ? <div className="gi-muted mt-0.5 truncate text-[12px]">{item.reasons.slice(0, 2).join(' · ')}</div> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className="gi-muted px-4 text-[12px]">Nothing needs you right now.</p>
      )}
      <p className="gi-muted px-4 pb-4 pt-2 text-[11px] leading-relaxed">{queue.coverage.note}</p>
    </section>
  );
}


export function CloudView(props: { initialSection?: string; onOpenThread: (threadId: string, accountId?: string) => void; onApprovalCount: (count: number) => void }) {
  const product = useProductState();
  const [view, setView] = useState(props.initialSection ?? 'overview');
  useEffect(() => { setView(props.initialSection ?? 'overview'); }, [props.initialSection]);
  const connected = product.state.runMode === 'cloud' && product.state.capabilities.some((capability) => capability.startsWith('cloud_'));
  const mailSync = product.has('cloud_mail_sync');
  const allowed = view === 'overview' || view === 'approvals' || (mailSync && (view === 'focus' || view === 'activity')) || availableCloudFeatures(product.state.capabilities).some((feature) => feature.id === view);
  return <div className="flex min-h-0 flex-1 flex-col">
    <nav className="gi-rail" aria-label="Cloud">
      {([['overview', 'Overview'], ['approvals', 'Approvals'], ['activity', 'Activity']] as const).map(([id, label]) => <button key={id} type="button" className="gi-chip-btn" disabled={connected && id === 'activity' && !mailSync} aria-pressed={view === id} data-active={view === id} onClick={() => setView(id)}>{label}</button>)}
    </nav>
    <main className="min-h-0 flex-1 overflow-auto pt-2">
      {!connected ? <CloudPreview product={product} /> : !allowed ? <p className="gi-muted px-4">This tool is not available for your Cloud connection.</p> : <>
        {!['overview', 'approvals', 'activity'].includes(view) ? <div className="px-4"><button type="button" className="gi-text-btn" onClick={() => setView('overview')}>← Overview</button></div> : null}
        <Suspense fallback={<p className="gi-orb-line gi-muted px-4" role="status"><Orb size={18} />Opening Cloud tools…</p>}>
          {view === 'overview' && !mailSync ? <div className="px-4"><CloudPreview product={product} /><div className="gi-feature-grid">{availableCloudFeatures(product.state.capabilities).map((feature) => <button type="button" key={feature.id} onClick={() => setView(feature.id)}>{feature.title}</button>)}</div></div> : view === 'overview' ? <CloudOverview capabilities={product.state.capabilities} account={product.state.cloud.email} onOpenThread={props.onOpenThread} onCount={props.onApprovalCount} onNavigate={setView} /> : view === 'approvals' ? <Approvals onCount={props.onApprovalCount} /> : view === 'focus' ? <Focus onOpenThread={props.onOpenThread} /> : view === 'activity' ? <ActivityView capabilities={product.state.capabilities} onOpenThread={props.onOpenThread} /> : view === 'briefings' ? <BriefingsView onOpenThread={props.onOpenThread} /> : view === 'views' || view === 'automations' ? <RulesView key={view} kind={view} onOpenThread={props.onOpenThread} /> : view === 'documents' ? <DocumentsView /> : view === 'contacts' ? <ContactsView onOpenThread={props.onOpenThread} /> : <button type="button" className="gi-btn" onClick={() => openCloud(view)}>Open in Cloud ↗</button>}
        </Suspense>
      </>}
    </main>
  </div>;
}
