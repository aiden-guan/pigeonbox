import { useCallback, useEffect, useState } from 'react';
import type { Briefing, RouteResponse } from '@pigeonbox/api-contract';
import { callCloud } from './cloud-api';
import { BriefingReader } from './BriefingReader';
import { relative } from './WaitingView';
import { openCloud } from '../ui/cloud-features';
import { Orb } from '../ui/Orb';

export function BriefingsView({ onOpenThread }: { onOpenThread: (id: string, accountId?: string) => void }) {
  const [items, setItems] = useState<RouteResponse<'briefings'>['briefings'] | null>(null);
  const [reader, setReader] = useState<Briefing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    const result = await callCloud('briefings', { limit: 15 });
    if (result.ok) setItems(result.data.briefings);
    else setError(result.reason);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function open(id: string) {
    setBusy(true);
    setError('');
    const result = await callCloud('briefingGet', { id });
    setBusy(false);
    if (result.ok) setReader(result.data.briefing);
    else setError(result.reason);
  }
  async function generate(kind: 'morning' | 'end_of_day') {
    setBusy(true);
    setError('');
    const result = await callCloud('briefingGenerate', { kind });
    setBusy(false);
    if (result.ok) {
      setReader(result.data.briefing);
      void load();
    } else setError(result.reason);
  }
  if (reader) return <BriefingReader briefing={reader} onBack={() => setReader(null)} onOpenThread={onOpenThread} />;
  return (
    <section className="gi-cloud-reader">
      <h2>Briefings</h2>
      <p className="gi-muted">
        Replies, commitments and meetings with sources. Prepared only when requested or scheduled in Cloud.
      </p>
      <div className="gi-cloud-actions">
        <button className="gi-btn" type="button" disabled={busy} onClick={() => void generate('morning')}>
          Prepare morning briefing
        </button>
        <button
          className="gi-btn gi-btn-ghost"
          type="button"
          disabled={busy}
          onClick={() => void generate('end_of_day')}
        >
          Prepare end-of-day wrap-up
        </button>
      </div>
      {busy ? (
        <p className="gi-orb-line" role="status">
          <Orb size={16} />
          Preparing your briefing…
        </p>
      ) : null}
      {error ? (
        <p className="gi-warn" role="alert">
          {error}
          <button className="gi-text-btn" type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}
      {!items && !error ? (
        <p className="gi-muted" role="status">
          Loading briefings…
        </p>
      ) : items?.length ? (
        items.map((item) => (
          <button
            className="gi-automatic-row"
            type="button"
            disabled={busy}
            key={item.id}
            onClick={() => void open(item.id)}
          >
            <strong>{item.title}</strong>
            <span>
              {item.kind === 'meeting' ? 'Meeting briefing' : item.kind === 'morning' ? 'Morning' : 'End of day'} ·{' '}
              {relative(item.generatedAt)}
            </span>
          </button>
        ))
      ) : items ? (
        <p className="gi-muted">No briefing yet. Prepare one above or set a schedule in Cloud.</p>
      ) : null}
      <button className="gi-text-btn" type="button" onClick={() => openCloud('briefings')}>
        Manage schedule ↗
      </button>
    </section>
  );
}
