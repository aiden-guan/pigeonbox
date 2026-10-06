import type { Briefing, CloudOverview, FocusItem, RecentMail } from '@pigeonbox/api-contract';
import { useState } from 'react';
import { Orb } from '../ui/Orb';
import { openCloud } from '../ui/cloud-features';
import { BriefingReader } from './BriefingReader';
import { SourceChips } from './SourceChips';
import { ago, awaySummary, countLabel, sinceLabel, mailKind, mailKindCounts, mailTag, MAIL_KINDS, preparedRows, readyItem, readyList, type DraftFilter, type MailKind, type PreparedRow } from './cloud-presenters';

export type CloudNavigate = (section: string) => void;
export type HomeTarget = { view: 'drafts'; filter: DraftFilter } | { view: 'approvals'; approvalId?: string } | { view: 'activity' };

/**
 * Cloud Home, in the order a person needs it: the few things that need them,
 * then what came in (each conversation tagged reply / FYI / updates /
 * marketing), then a quiet line of background work, history and tools.
 * Prepared replies are reviewed in the email itself, never queued here.
 */
export function CloudHome(props: {
  data: CloudOverview | null;
  loading: boolean;
  capabilities: readonly string[];
  visitSince: string | null;
  onOpenThread: (id: string, accountId?: string) => void;
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

      <div className="pb-home-main">
        <section className="pb-home-section" aria-labelledby="pb-ready-title">
          <div className="pb-section-head">
            <h2 id="pb-ready-title" className="pb-home-kicker">Needs you</h2>
            {ready.length ? <button type="button" className="gi-text-btn" onClick={() => onNavigate('focus')}>See all</button> : null}
          </div>
          {!data.focus ? (
            <SectionFailure label="Your queue" />
          ) : ready.length ? (
            <ul className="pb-ready">
              {ready.map((item) => <ReadyRow key={`${item.accountId}-${item.threadId}`} item={item} onOpenThread={onOpenThread} onGo={props.onGo} />)}
            </ul>
          ) : noAccount ? null : (
            <div className="pb-empty-line">
              <strong>You’re caught up.</strong>
              <span>Nothing needs your attention right now.</span>
            </div>
          )}
        </section>

        {data.recent === undefined || noAccount ? null : data.recent === null ? (
          <section className="pb-home-section" aria-labelledby="pb-recent-title">
            <h2 id="pb-recent-title" className="pb-home-kicker">Recent mail</h2>
            <SectionFailure label="Recent mail" />
          </section>
        ) : (
          <RecentMailSection items={data.recent} onOpenThread={onOpenThread} />
        )}
      </div>

      <div className="pb-home-side">
        {rows.length || preparing ? (
          <section className="pb-home-section" aria-labelledby="pb-prepared-title">
            <h2 id="pb-prepared-title" className="pb-home-kicker">In the background</h2>
            {rows.length ? (
              <ul className="pb-prepared">
                {rows.map((row) => <PreparedLine key={row.id} row={row} onGo={props.onGo} />)}
              </ul>
            ) : null}
            {preparing ? <p className="pb-quiet gi-orb-line" role="status"><Orb size={12} state="drafting" />Preparing {preparing === 1 ? 'a reply' : `${preparing} replies`} from new mail…</p> : null}
          </section>
        ) : data.prepared === null && data.work === null ? (
          <SectionFailure label="Prepared work" />
        ) : null}

        {away.length ? (
          <section className="pb-home-section pb-away" aria-labelledby="pb-away-title">
            <div className="pb-section-head">
              <h2 id="pb-away-title" className="pb-home-kicker">While you were away</h2>
              <span className="pb-meta">{props.visitSince ? sinceLabel(data.since) : 'Last 24 hours'}</span>
            </div>
            <ul className="pb-away-list">{away.map((line) => <li key={line}>{line}</li>)}</ul>
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
            ) : null}
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
    </div>
  );
}

function ReadyRow(props: { item: FocusItem; onOpenThread: (id: string, accountId?: string) => void; onGo: (target: HomeTarget) => void }) {
  const { item } = props;
  const view = readyItem(item);
  const { action } = view;
  const primary = () => {
    if (action.kind === 'approval') props.onGo({ view: 'approvals', approvalId: action.approvalId });
    else props.onOpenThread(item.threadId, item.accountId);
  };
  return (
    <li className="pb-ready-item">
      <div className="pb-ready-copy">
        <span className="pb-ready-who" data-continuity="sender">{item.who || item.subject}</span>
        <span className="pb-ready-subject" data-continuity="subject">{item.subject}</span>
        {view.flags.length ? (
          <span className="pb-flags">
            {view.flags.map((flag) => <span key={flag.text} className="pb-flag" data-urgent={flag.urgent}>{flag.text}</span>)}
          </span>
        ) : null}
        {view.reason ? <span className="pb-ready-reason">{view.reason}</span> : null}
      </div>
      <div className="pb-ready-actions">
        <button type="button" className="gi-btn pb-btn-sm" onClick={primary} aria-label={`${action.label}: ${item.subject}`}>{action.label}</button>
        {action.kind === 'approval' ? <button type="button" className="gi-text-btn" onClick={() => props.onOpenThread(item.threadId, item.accountId)} aria-label={`Open: ${item.subject}`}>Open</button> : null}
      </div>
    </li>
  );
}

const RECENT_PAGE = 6;

/** What came in, newest first, each tagged so it can be skimmed or filtered. */
function RecentMailSection({ items, onOpenThread }: { items: RecentMail[]; onOpenThread: (id: string, accountId?: string) => void }) {
  const [filter, setFilter] = useState<MailKind | 'all'>('all');
  const [expanded, setExpanded] = useState(false);
  const counts = mailKindCounts(items);
  const kinds = MAIL_KINDS.filter((kind) => counts[kind.id] > 0);
  const active = filter !== 'all' && counts[filter] === 0 ? 'all' : filter;
  const shown = active === 'all' ? items : items.filter((item) => mailKind(item.state) === active);
  const visible = expanded ? shown : shown.slice(0, RECENT_PAGE);
  return (
    <section className="pb-home-section" aria-labelledby="pb-recent-title">
      <div className="pb-section-head">
        <h2 id="pb-recent-title" className="pb-home-kicker">Recent mail</h2>
      </div>
      {!items.length ? (
        <p className="pb-quiet">Nothing new in the last two weeks.</p>
      ) : (
        <>
          {kinds.length > 1 ? (
            <div className="pb-filter pb-mail-filter" role="toolbar" aria-label="Filter recent mail">
              <button type="button" className="pb-filter-btn" aria-pressed={active === 'all'} onClick={() => { setFilter('all'); setExpanded(false); }}>All</button>
              {kinds.map((kind) => (
                <button key={kind.id} type="button" className="pb-filter-btn" data-kind={kind.id} aria-pressed={active === kind.id} onClick={() => { setFilter(kind.id); setExpanded(false); }}>
                  {kind.label}<span className="pb-count">{countLabel(counts[kind.id])}</span>
                </button>
              ))}
            </div>
          ) : null}
          <ul className="pb-mail-list">
            {visible.map((item) => <RecentMailRow key={`${item.accountId}-${item.threadId}`} item={item} onOpenThread={onOpenThread} />)}
          </ul>
          {shown.length > RECENT_PAGE ? (
            <button type="button" className="gi-text-btn pb-mail-more" onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Show fewer' : `Show ${shown.length - RECENT_PAGE} more`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function RecentMailRow({ item, onOpenThread }: { item: RecentMail; onOpenThread: (id: string, accountId?: string) => void }) {
  const tag = mailTag(item);
  return (
    <li>
      <button type="button" className="pb-mail" data-kind={tag.kind} onClick={() => onOpenThread(item.threadId, item.accountId)} aria-label={`Open: ${item.subject}, from ${item.who || 'unknown sender'}, ${tag.text}`}>
        <span className="pb-mail-top">
          <strong className="pb-mail-who">{item.who || 'Unknown sender'}</strong>
          <span className="pb-tag" data-kind={tag.kind}>{tag.text}</span>
          <time className="pb-meta" dateTime={item.lastMessageAt}>{ago(item.lastMessageAt)}</time>
        </span>
        <span className="pb-mail-subject">{item.subject}</span>
        {item.summary ? <span className="pb-mail-summary">{item.summary}</span> : null}
        {item.draftReady ? <span className="pb-mail-note">Reply drafted · review it in the email</span> : null}
      </button>
    </li>
  );
}

function PreparedLine({ row, onGo }: { row: PreparedRow; onGo: (target: HomeTarget) => void }) {
  return (
    <li>
      <button type="button" className="pb-prepared-row" onClick={() => onGo(row.target)} aria-label={`${row.count} ${row.label}`}>
        <strong>{countLabel(row.count)}</strong>
        <span>{row.label}</span>
      </button>
    </li>
  );
}

function SectionFailure({ label }: { label: string }) {
  return <p className="gi-warn">{label} could not load. Refresh to try again; the rest of Home still works.</p>;
}
