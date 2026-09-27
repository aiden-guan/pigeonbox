/**
 * PigeonBox Cloud in the side panel: the approval queue, the Focus Queue
 * across connected accounts, and Ask Pigeon with sources. Shown only in Cloud
 * mode with Google connected. Every call goes through the service worker
 * (`CLOUD_CALL`), which holds the session and allows only listed routes.
 */
import type { Approval, AskPigeonResponse, RouteResponse } from '@pigeonbox/api-contract';
import { useCallback, useEffect, useState } from 'react';
import { Orb } from '../ui/Orb';
import { relative } from './WaitingView';

type CallResult<T> = { ok: true; data: T } | { ok: false; code: string; reason: string };

export function cloudCall<T>(route: string, body?: unknown): Promise<CallResult<T>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLOUD_CALL', route, body }, (response?: CallResult<T>) => {
      resolve(response ?? { ok: false, code: 'network', reason: 'PigeonBox did not respond.' });
    });
  });
}

const PLACEHOLDER = /\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+)\]/g;
const newKey = () => crypto.randomUUID();
type FocusQueueResponse = RouteResponse<'focusQueue'>;

function ApprovalCard(props: { approval: Approval; onDone: (message: string) => void }) {
  const { approval } = props;
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
    const result = await cloudCall<{ approval: Approval }>('approvalDecide', { id: approval.id, decision, idempotencyKey: newKey(), ...edited });
    setBusy(false);
    if (!result.ok) return setError(result.reason);
    props.onDone(decision === 'approve' ? (approval.kind === 'send_email' ? 'Approved. Sending now.' : 'Approved.') : 'Rejected. Nothing was done.');
  }

  return (
    <li className="gi-approval">
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
        <button type="button" className="gi-btn" disabled={busy || open.length > 0} onClick={() => void decide('approve')}>
          {busy ? 'Working…' : 'Approve'}
        </button>
        <button type="button" className="gi-btn gi-btn-ghost" disabled={busy} onClick={() => void decide('reject')}>
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

  if (error) return <p className="gi-danger px-4">{error}</p>;
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

function Focus(props: { onOpenThread: (threadId: string) => void }) {
  const [queue, setQueue] = useState<FocusQueueResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void cloudCall<FocusQueueResponse>('focusQueue', { limit: 40 }).then((result) => (result.ok ? setQueue(result.data) : setError(result.reason)));
  }, []);
  if (error) return <p className="gi-danger px-4">{error}</p>;
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
                  <button type="button" className="gi-mail" onClick={() => props.onOpenThread(item.threadId)}>
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

function AskPigeon(props: { onOpenThread: (threadId: string) => void }) {
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskPigeonResponse | null>(null);
  const [error, setError] = useState('');

  async function ask() {
    const question = query.trim();
    if (!question || busy) return;
    setAsked(question);
    setQuery('');
    setBusy(true);
    setError('');
    setAnswer(null);
    const result = await cloudCall<AskPigeonResponse>('askPigeon', { query: question, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    setBusy(false);
    if (result.ok) setAnswer(result.data);
    else setError(result.reason);
  }

  const sources = new Map((answer?.sources ?? []).map((source) => [source.id, source]));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-2">
        {asked ? <p className="gi-asked">{asked}</p> : <p className="gi-muted text-[12px] leading-relaxed">Answers come from everything PigeonBox Cloud has synced, your calendar and your notes, and cite where each part came from.</p>}
        {busy ? <p className="gi-muted gi-orb-line" role="status"><Orb size={18} />Looking through your mail…</p> : null}
        {error ? <p className="gi-danger">{error}</p> : null}
        {answer ? (
          <>
            {answer.claims.length ? (
              <ul className="gi-claims">
                {answer.claims.map((claim, index) => (
                  <li key={index}>
                    <span>{claim.text}</span>
                    {claim.sourceIds.map((id) => {
                      const source = sources.get(id);
                      if (!source) return null;
                      return source.gmailThreadId ? (
                        <button key={id} type="button" className="gi-source" onClick={() => props.onOpenThread(source.gmailThreadId!)}>
                          {source.title}
                        </button>
                      ) : (
                        <span key={id} className="gi-source is-static">{source.title}</span>
                      );
                    })}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{answer.answer}</p>
            )}
            {answer.unverified.length ? <p className="gi-warn">Could not check: {answer.unverified.join('; ')}</p> : null}
            <p className="gi-muted mt-3 text-[11px] leading-relaxed">{answer.coverage.note}</p>
          </>
        ) : null}
      </div>
      <form
        className="gi-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <input className="gi-field min-w-0 flex-1" aria-label="Ask Pigeon" placeholder="Who am I waiting on?" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="gi-btn shrink-0" disabled={busy || !query.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}

export function CloudView(props: { onOpenThread: (threadId: string) => void; onApprovalCount: (count: number) => void }) {
  const [view, setView] = useState<'approvals' | 'focus' | 'ask'>('approvals');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="gi-rail" aria-label="Cloud">
        {(
          [
            ['approvals', 'Approvals'],
            ['focus', 'Focus'],
            ['ask', 'Ask Pigeon'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className="gi-chip-btn" aria-pressed={view === id} data-active={view === id} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
        <button type="button" className="gi-chip-btn" onClick={() => chrome.runtime.sendMessage({ type: 'CLOUD_OPEN', section: view === 'approvals' ? 'approvals' : 'overview' })}>
          Web app ↗
        </button>
      </nav>
      {view === 'ask' ? (
        <AskPigeon onOpenThread={props.onOpenThread} />
      ) : (
        <main className="min-h-0 flex-1 overflow-auto pt-2">{view === 'approvals' ? <Approvals onCount={props.onApprovalCount} /> : <Focus onOpenThread={props.onOpenThread} />}</main>
      )}
    </div>
  );
}
