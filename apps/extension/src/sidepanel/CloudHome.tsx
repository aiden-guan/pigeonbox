import { Pigeon } from '../ui/Pigeon';
import { rememberTransfer } from '../ui/continuity';
import type { Briefing, CloudOverview, FocusItem } from '@pigeonbox/api-contract';
import { useState } from 'react';
import { Orb } from '../ui/Orb';
import { openCloud } from '../ui/cloud-features';
import { BriefingReader } from './BriefingReader';
import { SourceChips } from './SourceChips';
import { ago, awaySummary, sinceLabel, preparedRows, readyItem, readyList, type DraftFilter, type PreparedRow } from './cloud-presenters';

export type CloudNavigate = (section: string) => void;
export type HomeTarget = { view: 'drafts'; filter: DraftFilter } | { view: 'approvals'; approvalId?: string } | { view: 'activity' };

/**
 * Cloud Home, in the order a person needs it: what needs them now, what is
 * prepared, then what happened while they were away, then tools. Current
 * work and the visit window are separate sections with separate labels, so
 * history never appears to describe the queue.
 */
export function CloudHome(props: {
  data: CloudOverview | null;
  loading: boolean;
  capabilities: readonly string[];
  visitSince: string | null;
  onOpenThread: (id: string, accountId?: string) => void;
  onReviewDraft: (item: FocusItem) => void;
  onGo: (target: HomeTarget) => void;
  onNavigate: CloudNavigate;
}) {
  const { data, capabilities, onOpenThread, onNavigate } = props;
  const [reader, setReader] = useState<Briefing | null>(null);
  if (reader) return <BriefingReader briefing={reader} onBack={() => setReader(null)} onOpenThread={onOpenThread} />;
  if (!data) {
    return props.loading ? (
      <div className="pb-home" aria-busy="true">
        <p className="gi-orb-line gi-muted" role="status"><Orb size={16} state="connecting" />Loading prepared work…</p>
        <div className="pb-skeleton" aria-hidden="true"><i /><i /><i /></div>
      </div>
    ) : null;
  }
  const noAccount = data.accounts !== null && !data.accounts.some((account) => account.status !== 'disconnected');
  const canDraft = capabilities.includes('cloud_auto_drafts');
  const ready = readyList(data);
  const rows = preparedRows(data);
  const preparing = data.prepared?.drafts?.preparing ?? 0;
  const away = awaySummary(data.work);
  const brief = data.latestBriefing;

  return (
    <div className="pb-home">
      {noAccount ? (
        <section className="pb-home-section pb-connect" aria-labelledby="pb-connect-title">
          <h2 id="pb-connect-title" className="pb-home-title">Keep working while you’re away</h2>
          <p>Connect Google to let PigeonBox keep your inbox current. Choose mail and calendar permissions separately.</p>
          <button type="button" className="gi-btn" onClick={() => openCloud('connections')}>Connect Google</button>
        </section>
      ) : null}

      <section className="pb-home-section" aria-labelledby="pb-ready-title">
        <div className="pb-section-head">
          <h2 id="pb-ready-title" className="pb-home-kicker">Ready for you</h2>
          {ready.length ? <button type="button" className="gi-text-btn" onClick={() => onNavigate('focus')}>See all</button> : null}
        </div>
        {!data.focus ? (
          <SectionFailure label="Your queue" />
        ) : ready.length ? (
          <ul className="pb-ready">
            {ready.map((item) => <ReadyRow key={`${item.accountId}-${item.threadId}`} item={item} canDraft={canDraft} onOpenThread={onOpenThread} onReviewDraft={props.onReviewDraft} onGo={props.onGo} />)}
          </ul>
        ) : noAccount ? null : (
          <div className="pb-empty-line">
            <strong>You’re caught up.</strong>
            <span>Nothing needs your attention right now.</span>
          </div>
        )}
      </section>

      {rows.length || preparing ? (
        <section className="pb-home-section" aria-labelledby="pb-prepared-title">
          <div className="pb-section-head">
            <h2 id="pb-prepared-title" className="pb-home-kicker">Prepared for you</h2>
            {canDraft ? <button type="button" className="gi-text-btn" onClick={() => props.onGo({ view: 'drafts', filter: 'ready' })}>View drafts</button> : null}
          </div>
          {rows.length ? (
            <ul className="pb-prepared">
              {rows.map((row) => <PreparedLine key={row.id} row={row} onGo={props.onGo} />)}
            </ul>
          ) : (
            <p className="pb-quiet">{preparing ? '' : 'No drafts or approvals waiting for you.'}</p>
          )}
          {preparing ? <p className="pb-quiet gi-orb-line" role="status"><Orb size={12} state="drafting" />Preparing {preparing === 1 ? 'a reply' : `${preparing} replies`} from new mail…</p> : null}
        </section>
      ) : (
        <SectionFailure label="Prepared work" />
      )}

      {away.length ? (
        <section className="pb-home-section pb-away" aria-labelledby="pb-away-title">
          <div className="pb-section-head">
            <h2 id="pb-away-title" className="pb-home-kicker">While you were away</h2>
            <span className="pb-meta">{props.visitSince ? sinceLabel(data.since) : 'Last 24 hours'}</span>
          </div>
          {away.length ? (
            <ul className="pb-away-list">{away.map((line) => <li key={line}>{line}</li>)}</ul>
          ) : (
            <p className="pb-quiet">Nothing new since your last visit.</p>
          )}
        </section>
      ) : null}

      {capabilities.includes('cloud_automations') && (brief || data.unavailable.includes('briefing')) ? (
        <section className="pb-home-section" aria-labelledby="pb-brief-title">
          <div className="pb-section-head">
            <h2 id="pb-brief-title" className="pb-home-kicker">Latest briefing</h2>
            <button type="button" className="gi-text-btn" onClick={() => onNavigate('briefings')}>All briefings</button>
          </div>
          {data.unavailable.includes('briefing') ? (
            <SectionFailure label="Briefing" />
          ) : brief ? (
            <div className="pb-brief-card">
              <strong>{brief.title}</strong>
              <span className="pb-meta">Prepared {ago(brief.generatedAt)}</span>
              <ul className="gi-brief-preview">
                {brief.sections.flatMap((section) => section.items).slice(0, 3).map((item, index) => (
                  <li key={index}>
                    {item.text}
                    <SourceChips sources={brief.sources.filter((source) => item.sourceIds.includes(source.id))} onOpenThread={onOpenThread} />
                  </li>
                ))}
              </ul>
              <button type="button" className="gi-btn gi-btn-ghost" onClick={() => setReader(brief)}>Open full briefing</button>
            </div>
          ) : (
            <div className="pb-empty-line">
              <span>No briefing yet.</span>
              <button type="button" className="gi-text-btn" onClick={() => onNavigate('briefings')}>Prepare a briefing</button>
            </div>
          )}
        </section>
      ) : null}

      {data.automatic && (data.automatic.views.some((view) => view.enabled) || data.automatic.automations.length) ? (
        <section className="pb-home-section" aria-labelledby="pb-auto-title">
          <h2 id="pb-auto-title" className="pb-home-kicker">Working automatically</h2>
          <ul className="pb-tool-list">
            {data.automatic.views.filter((view) => view.enabled).slice(0, 3).map((view) => (
              <li key={view.id}><button type="button" className="pb-tool" onClick={() => onNavigate('views')}>
                <strong>{view.name}</strong>
                <span>{view.mode === 'shadow' ? 'Shadow Mode' : view.mode === 'active' ? 'On' : 'View only'} · {view.stats.matched} matches · {view.stats.applied} applied</span>
              </button></li>
            ))}
            {data.automatic.automations.slice(0, 3).map((automation) => (
              <li key={automation.id}><button type="button" className="pb-tool" onClick={() => onNavigate('automations')}>
                <strong>{automation.name}</strong>
                <span>{!automation.enabled ? 'Paused' : automation.mode === 'shadow' ? 'Shadow Mode' : 'On'} · {automation.stats.runs} runs{automation.stats.failures ? ` · ${automation.stats.failures} failed` : ''}</span>
              </button></li>
            ))}
          </ul>
        </section>
      ) : data.unavailable.includes('automatic') ? <SectionFailure label="Automatic work" /> : null}

    </div>
  );
}

function ReadyRow(props: { item: FocusItem; canDraft: boolean; onOpenThread: (id: string, accountId?: string) => void; onReviewDraft: (item: FocusItem) => void; onGo: (target: HomeTarget) => void }) {
  const { item } = props;
  const view = readyItem(item);
  const action = view.action.kind === 'draft' && !props.canDraft ? { kind: 'thread' as const, label: 'Open thread' as const } : view.action;
  const primary = () => {
    if (action.kind === 'approval') props.onGo({ view: 'approvals', approvalId: action.approvalId });
    else if (action.kind === 'draft') props.onReviewDraft(item);
    else props.onOpenThread(item.threadId, item.accountId);
  };
  return (
    <li className="pb-ready-item" data-prepared={action.kind === 'draft'}>
      <div className="pb-ready-copy">
        <span className="pb-ready-who" data-continuity="sender">{item.who || item.subject}{action.kind === 'draft' ? <Pigeon state="ready" size={24} /> : null}</span>
        <span className="pb-ready-subject" data-continuity="subject">{item.subject}</span>
        {view.flags.length ? (
          <span className="pb-flags">
            {view.flags.map((flag) => <span key={flag.text} className="pb-flag" data-urgent={flag.urgent}>{flag.text}</span>)}
          </span>
        ) : null}
        {view.reason ? <span className="pb-ready-reason">{view.reason}</span> : null}
      </div>
      <div className="pb-ready-actions">
        <button type="button" className="gi-btn pb-btn-sm" onClick={(event) => { if (action.kind === 'draft') rememberTransfer(event.currentTarget.closest<HTMLElement>('.pb-ready-item')!, `draft:${item.threadId}`); primary(); }} aria-label={`${action.label}: ${item.subject}`}>{action.label}</button>
        {action.kind !== 'thread' ? <button type="button" className="gi-text-btn" onClick={() => props.onOpenThread(item.threadId, item.accountId)} aria-label={`Open thread: ${item.subject}`}>Open thread</button> : null}
      </div>
    </li>
  );
}

function PreparedLine({ row, onGo }: { row: PreparedRow; onGo: (target: HomeTarget) => void }) {
  return (
    <li>
      <button type="button" className="pb-prepared-row" onClick={() => onGo(row.target)}>
        <strong>{row.count}</strong>
        <span>{row.label}</span>
        <i aria-hidden="true">→</i>
      </button>
    </li>
  );
}

function SectionFailure({ label }: { label: string }) {
  return <p className="gi-warn">{label} could not load. Refresh to try again; the rest of Home still works.</p>;
}
