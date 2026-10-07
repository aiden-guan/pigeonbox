import { useEffect, useState } from 'react';
import type { RouteResponse } from '@pigeonbox/api-contract';
import { callCloud } from './cloud-api';
import { relative } from './WaitingView';

/** Lives beside its source email, with feedback from the moment it opens. */
export function EngagementDetails({ id, threadId, accountId }: { id: string; threadId: string; accountId: string }) {
  const [data, setData] = useState<RouteResponse<'threadSignals'> | null>(null);
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    void callCloud('threadSignals', { threadId, accountId }).then((result) => {
      if (!active) return;
      if (result.ok) setData(result.data);
      else setError(result.reason);
    });
    return () => { active = false; };
  }, [threadId, accountId, attempt]);
  const events = data?.events.filter((event) => event.eventClass !== 'SELF_LIKELY') ?? [];
  return <section id={id} className="pb-engagement" aria-label="Engagement details" aria-busy={!data && !error}>
    <h4>Engagement</h4>
    {error ? <><p className="gi-warn" role="alert">Could not load engagement. {error}</p><button type="button" className="gi-text-btn" onClick={() => retry((value) => value + 1)}>Try again</button></>
      : !data ? <p className="gi-muted" role="status">Loading engagement…</p>
      : <>
        <p className="gi-muted">{data.attributionNote}</p>
        {data.signals.map((signal, index) => <p key={index}><strong>{signal.label}</strong><span className="gi-muted"> · {signal.explanation}</span></p>)}
        {events.length ? <ul className="gi-brief-preview">{events.slice(0, 20).map((event, index) => <li key={index}>
          {event.type === 'click' ? 'Link clicked' : event.type === 'open' ? 'Open observed' : event.type === 'document_view' ? 'Document viewed' : 'Document downloaded'} · {relative(event.at)}
          <p className="gi-muted">{event.explanation}</p>
        </li>)}</ul> : <p className="gi-muted">No observed recipient activity yet.</p>}
      </>}
  </section>;
}
