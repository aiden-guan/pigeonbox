import { useCallback, useEffect, useState } from 'react';
import type { RouteResponse } from '@pigeonbox/api-contract';
import { callCloud } from './cloud-api';
import { relative } from './WaitingView';
import { openCloud } from '../ui/cloud-features';

export function ActivityView({
  capabilities,
  onOpenThread,
}: {
  capabilities: readonly string[];
  onOpenThread: (id: string, accountId?: string) => void;
}) {
  const [waiting, setWaiting] = useState<RouteResponse<'followUps'> | null>(null);
  const [audit, setAudit] = useState<RouteResponse<'auditList'> | null>(null);
  const [signals, setSignals] = useState<RouteResponse<'threadSignals'> | null>(null);
  const [runs, setRuns] = useState<RouteResponse<'automationRuns'> | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setErrors([]);
    const results = await Promise.allSettled([
      callCloud('followUps', { stages: ['waiting', 'engaged', 'follow_up_due'], limit: 30 }).then((result) => {
        if (result.ok) setWaiting(result.data);
        else throw new Error('Waiting could not load.');
      }),
      callCloud('auditList', { limit: 20 }).then((result) => {
        if (result.ok) setAudit(result.data);
        else throw new Error('Recent actions could not load.');
      }),
      ...(capabilities.includes('cloud_automations')
        ? [
            callCloud('automationRuns', { limit: 10 }).then((result) => {
              if (result.ok) setRuns(result.data);
              else throw new Error('Automation runs could not load.');
            }),
          ]
        : []),
    ]);
    setErrors(
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => (result.reason instanceof Error ? result.reason.message : 'This section could not load.')),
    );
    setBusy(false);
  }, [capabilities]);
  useEffect(() => {
    void load();
  }, [load]);
  async function inspect(threadId: string, accountId: string) {
    setSignals(null);
    const result = await callCloud('threadSignals', { threadId, accountId });
    if (result.ok) setSignals(result.data);
    else setErrors((value) => [...value, result.reason]);
  }
  return (
    <section className="gi-cloud-reader">
      <div className="gi-cloud-section-head">
        <h2>Activity & waiting</h2>
        <button className="gi-text-btn" type="button" disabled={busy} onClick={() => void load()}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {errors.map((error, index) => (
        <p className="gi-warn" role="alert" key={index}>
          {error} Other sections remain available.
        </p>
      ))}
      <section className="gi-cloud-block">
        <h3>Waiting for a reply</h3>
        {waiting?.followUps.length ? (
          waiting.followUps.map(({ followUp: follow, subject }) => (
            <div className="gi-shadow-decision" key={follow.id}>
              <button
                type="button"
                className="gi-source"
                onClick={() => onOpenThread(follow.threadId, follow.accountId)}
              >
                {subject || follow.expectedFrom.join(', ') || 'Open conversation'}
              </button>
              <p>{follow.reason}</p>
              <p className="gi-muted">
                {follow.stage === 'follow_up_due' ? 'Follow-up due' : 'Waiting'}
                {follow.dueAt ? ` · ${new Date(follow.dueAt).toLocaleDateString()}` : ''}
                {follow.engagement?.likelyOpens ? ` · ${follow.engagement.likelyOpens} likely opens, no reply yet` : ''}
                {follow.engagement?.clicks ? ` · ${follow.engagement.clicks} clicks` : ''}
              </p>
              {capabilities.includes('cloud_tracking') ? (
                <button
                  className="gi-text-btn"
                  type="button"
                  onClick={() => void inspect(follow.threadId, follow.accountId)}
                >
                  View engagement
                </button>
              ) : null}
            </div>
          ))
        ) : waiting ? (
          <p className="gi-muted">No conversations waiting for a reply.</p>
        ) : (
          <p className="gi-muted">{busy ? 'Loading waiting conversations…' : 'Waiting is unavailable.'}</p>
        )}
      </section>
      {signals ? (
        <section className="gi-cloud-block">
          <h3>Engagement</h3>
          <p className="gi-muted">{signals.attributionNote}</p>
          {signals.signals.map((signal, index) => (
            <p key={index}>
              <strong>{signal.label}</strong>
              <span className="gi-muted"> · {signal.explanation}</span>
            </p>
          ))}
          <ul className="gi-brief-preview">
            {signals.events
              .filter((event) => event.eventClass !== 'SELF_LIKELY')
              .slice(0, 20)
              .map((event, index) => (
                <li key={index}>
                  {event.type === 'click'
                    ? 'Link clicked'
                    : event.type === 'open'
                      ? 'Open observed'
                      : event.type === 'document_view'
                        ? 'Document viewed'
                        : 'Document downloaded'}{' '}
                  · {relative(event.at)}
                  <p className="gi-muted">{event.explanation}</p>
                </li>
              ))}
          </ul>
          {!signals.events.length ? <p className="gi-muted">No observed activity.</p> : null}
        </section>
      ) : null}
      <section className="gi-cloud-block">
        <h3>Recent automatic work</h3>
        {runs?.runs.map((run) => (
          <div className="gi-shadow-decision" key={run.id}>
            <strong>
              {run.status} · {relative(run.startedAt)}
            </strong>
            <p className="gi-muted">
              {run.actions
                .map((action) => `${action.kind.replace(/_/g, ' ')}: ${action.outcome.replace(/_/g, ' ')}`)
                .join(' · ')}
            </p>
          </div>
        ))}
        {runs && !runs.runs.length ? <p className="gi-muted">No recent automation runs.</p> : null}
      </section>
      <section className="gi-cloud-block">
        <h3>Recent actions</h3>
        {audit?.events.map((event) => (
          <div className="gi-shadow-decision" key={event.id}>
            <strong>{event.summary}</strong>
            <p className="gi-muted">
              {relative(event.at)} · {event.actor.name} · {event.policy.reason}
            </p>
          </div>
        ))}
        {audit && !audit.events.length ? <p className="gi-muted">No actions recorded yet.</p> : null}
      </section>
      <p className="gi-muted">
        Opens are observations, not proof of reading. Shared pixels and mail proxies can obscure the reader.
      </p>
      <div className="gi-cloud-actions">
        <button className="gi-btn gi-btn-ghost" type="button" onClick={() => openCloud('activity')}>
          Full activity ↗
        </button>
        {capabilities.includes('cloud_documents') ? (
          <button className="gi-btn gi-btn-ghost" type="button" onClick={() => openCloud('documents')}>
            Tracked documents ↗
          </button>
        ) : null}
      </div>
    </section>
  );
}
