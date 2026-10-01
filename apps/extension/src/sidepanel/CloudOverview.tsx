import { trackProductEvent } from '../ui/analytics';
import { useCallback, useEffect, useState } from 'react';
import type { Briefing, CloudOverview as OverviewData } from '@pigeonbox/api-contract';
import { callCloud } from './cloud-api';
import { Orb } from '../ui/Orb';
import { availableCloudFeatures, openCloud } from '../ui/cloud-features';
import { relative } from './WaitingView';
import { SourceChips } from './SourceChips';
import { BriefingReader } from './BriefingReader';

export type CloudNavigate = (section: string) => void;
export function CloudOverview({
  capabilities,
  account,
  onOpenThread,
  onCount,
  onNavigate,
}: {
  capabilities: readonly string[];
  account: string | null;
  onOpenThread: (id: string, accountId?: string) => void;
  onCount: (count: number) => void;
  onNavigate: CloudNavigate;
}) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [since, setSince] = useState<string>();
  const [reader, setReader] = useState<Briefing | null>(null);
  const load = useCallback(
    async (windowStart?: string) => {
      setBusy(true);
      setError('');
      const result = await callCloud('cloudOverview', { ...(windowStart ? { since: windowStart } : {}) });
      setBusy(false);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      trackProductEvent('first_cloud_overview_viewed', { surface: 'sidepanel', mode: 'cloud' });
      if (
        result.data.accounts?.some(
          (item) => item.status === 'active' && item.sync.state === 'healthy' && item.sync.lastSyncAt,
        )
      )
        trackProductEvent('first_cloud_sync_completed', { surface: 'sidepanel', mode: 'cloud' });
      setData(result.data);
      if (result.data.work) onCount(result.data.work.approvalsWaiting);
      if (!result.data.unavailable.length)
        void chrome.storage.local.set({ cloudOverviewVisit: { account, at: result.data.generatedAt } });
    },
    [account, onCount],
  );
  useEffect(() => {
    let active = true;
    void chrome.storage.local.get('cloudOverviewVisit').then((stored) => {
      if (!active) return;
      const visit = stored.cloudOverviewVisit as { account?: string; at?: string } | undefined;
      const at =
        visit?.account === account && visit?.at && Number.isFinite(Date.parse(visit.at)) ? visit.at : undefined;
      setSince(at);
      void load(at);
    });
    return () => {
      active = false;
    };
  }, [account, load]);
  if (reader) return <BriefingReader briefing={reader} onBack={() => setReader(null)} onOpenThread={onOpenThread} />;
  const accounts = data?.accounts;
  const active = accounts?.filter((item) => item.status === 'active') ?? [];
  const attention = accounts?.some(
    (item) => ['needs_reauth', 'error'].includes(item.status) || ['degraded', 'stalled'].includes(item.sync.state),
  );
  const syncing = active.some((item) => item.sync.state !== 'healthy' || item.sync.backlog > 0);
  const status = !data
    ? busy
      ? 'Checking Cloud'
      : 'Cloud unavailable'
    : accounts === null
      ? 'Sync status unavailable'
      : attention
        ? 'Needs attention'
        : !active.length
          ? 'Connect Google'
          : syncing
            ? 'Syncing'
            : 'Up to date';
  const ready =
    data?.focus?.sections
      .flatMap((section) => section.items)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8) ?? [];
  const brief = data?.latestBriefing;
  return (
    <div className="gi-cloud-overview">
      <div className="gi-cloud-section-head">
        <span
          className="gi-cloud-health"
          data-state={attention ? 'attention' : syncing ? 'working' : 'quiet'}
          role="status"
        >
          <i aria-hidden="true" />
          {status}
        </span>
        <button type="button" className="gi-text-btn" disabled={busy} onClick={() => void load(since)}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {busy && !data ? (
        <p className="gi-orb-line gi-muted" role="status">
          <Orb size={18} />
          Checking prepared work…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="gi-warn">
          {error}
          {data ? ' Showing the last loaded overview.' : ''}
        </p>
      ) : null}
      {accounts && !active.length ? (
        <section className="gi-cloud-block">
          <h2>Keep working while you’re away</h2>
          <p>Connect Google to start continuous sync. Choose mail and calendar permissions separately.</p>
          <button type="button" className="gi-btn" onClick={() => openCloud('connections')}>
            Connect Google
          </button>
        </section>
      ) : null}
      {data ? (
        <>
          <section className="gi-cloud-block">
            <h2>Since you were last here</h2>
            <p className="gi-muted">
              {since ? `Since ${new Date(data.since).toLocaleString()}` : 'Over the last 24 hours'} · Updated{' '}
              {relative(data.generatedAt)}
            </p>
            {data.work ? (
              <dl className="gi-work-stats">
                <div>
                  <dd>{data.work.threadsAnalyzed}</dd>
                  <dt>Threads analyzed</dt>
                </div>
                {data.work.draftsPrepared !== null ? (
                  <div>
                    <dd>{data.work.draftsPrepared}</dd>
                    <dt>Drafts prepared</dt>
                  </div>
                ) : null}
                <div>
                  <dd>{data.work.followUpsDetected}</dd>
                  <dt>Follow-ups detected</dt>
                </div>
                <div>
                  <dd>{data.work.approvalsWaiting}</dd>
                  <dt>Approvals waiting now</dt>
                </div>
              </dl>
            ) : (
              <SectionFailure label="Recent work" />
            )}
          </section>
          <section className="gi-cloud-block">
            <div className="gi-cloud-section-head">
              <h2>Ready for you</h2>
              <button type="button" className="gi-text-btn" onClick={() => onNavigate('focus')}>
                Open Focus Queue
              </button>
            </div>
            {data.focus ? (
              ready.length ? (
                <ul className="gi-ready-list">
                  {ready.map((item) => (
                    <li key={`${item.accountId}-${item.threadId}`}>
                      <button
                        type="button"
                        className="gi-ready-item"
                        onClick={() => onOpenThread(item.threadId, item.accountId)}
                      >
                        <strong>{item.who || item.subject}</strong>
                        <span>{item.subject}</span>
                        <small>
                          {item.draftReady ? 'Draft prepared · ' : ''}
                          {item.reasons.slice(0, 2).join(' · ')}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="gi-muted">Nothing needs you right now.</p>
              )
            ) : (
              <SectionFailure label="Focus Queue" />
            )}
            {data.focus ? <p className="gi-muted">{data.focus.coverage.note}</p> : null}
          </section>
          {capabilities.includes('cloud_automations') ? (
            <>
              <section className="gi-cloud-block">
                <div className="gi-cloud-section-head">
                  <h2>Latest briefing</h2>
                  <button type="button" className="gi-text-btn" onClick={() => onNavigate('briefings')}>
                    All briefings
                  </button>
                </div>
                {data.unavailable.includes('briefing') ? (
                  <SectionFailure label="Briefing" />
                ) : brief ? (
                  <>
                    <strong>{brief.title}</strong>
                    <p className="gi-muted">Prepared {relative(brief.generatedAt)}</p>
                    <ul className="gi-brief-preview">
                      {brief.sections
                        .flatMap((section) => section.items)
                        .slice(0, 4)
                        .map((item, index) => (
                          <li key={index}>
                            {item.text}
                            <SourceChips
                              sources={brief.sources.filter((source) => item.sourceIds.includes(source.id))}
                              onOpenThread={onOpenThread}
                            />
                          </li>
                        ))}
                    </ul>
                    <p className="gi-muted">{brief.coverageNote}</p>
                    <button type="button" className="gi-btn gi-btn-ghost" onClick={() => setReader(brief)}>
                      Open full briefing
                    </button>
                  </>
                ) : (
                  <>
                    <p className="gi-muted">No briefing yet.</p>
                    <button type="button" className="gi-btn gi-btn-ghost" onClick={() => onNavigate('briefings')}>
                      Prepare a briefing
                    </button>
                  </>
                )}
              </section>
              <section className="gi-cloud-block">
                <h2>Working automatically</h2>
                {data.automatic ? (
                  <>
                    {data.automatic.views
                      .filter((view) => view.enabled)
                      .slice(0, 4)
                      .map((view) => (
                        <button
                          type="button"
                          className="gi-automatic-row"
                          key={view.id}
                          onClick={() => onNavigate('views')}
                        >
                          <strong>{view.name}</strong>
                          <span>
                            {view.mode === 'shadow' ? 'Shadow Mode' : view.mode === 'active' ? 'On' : 'View only'} ·{' '}
                            {view.stats.matched} matches · {view.stats.applied} actions applied
                          </span>
                        </button>
                      ))}
                    {data.automatic.automations.slice(0, 4).map((automation) => (
                      <button
                        type="button"
                        className="gi-automatic-row"
                        key={automation.id}
                        onClick={() => onNavigate('automations')}
                      >
                        <strong>{automation.name}</strong>
                        <span>
                          {!automation.enabled ? 'Paused' : automation.mode === 'shadow' ? 'Shadow Mode' : 'On'} ·{' '}
                          {automation.stats.runs} runs · {automation.stats.failures} failures
                        </span>
                      </button>
                    ))}
                    {!data.automatic.views.length && !data.automatic.automations.length ? (
                      <p className="gi-muted">No rules yet. Try a Smart View in Shadow Mode before making changes.</p>
                    ) : (
                      <p className="gi-muted">Rule totals shown above. Recent runs appear in Activity.</p>
                    )}
                  </>
                ) : (
                  <SectionFailure label="Automatic work" />
                )}
              </section>
            </>
          ) : null}
        </>
      ) : null}
      <section className="gi-cloud-block">
        <h2>Your Cloud tools</h2>
        <div className="gi-feature-grid">
          {availableCloudFeatures(capabilities).map((feature) => (
            <button
              type="button"
              key={feature.title}
              onClick={() =>
                ['briefings', 'views', 'automations', 'documents', 'contacts'].includes(feature.id)
                  ? onNavigate(feature.id)
                  : openCloud(feature.id)
              }
            >
              <strong>
                {feature.title}
                <span aria-hidden="true">↗</span>
              </strong>
              <span>{feature.detail}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
function SectionFailure({ label }: { label: string }) {
  return <p className="gi-warn">{label} could not load. Refresh to try again; other sections are still available.</p>;
}
