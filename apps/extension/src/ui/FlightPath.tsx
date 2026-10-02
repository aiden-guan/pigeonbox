import { useId, useState } from 'react';
export type FlightPoint = { label: string; detail: string; at?: string | null; uncertain?: boolean; current?: boolean };
/** A line represents known events, never inferred delivery or proof of reading. */
export function FlightPath({ points, note }: { points: FlightPoint[]; note?: string }) {
  const id = useId();
  const [dismissed, setDismissed] = useState<number | null>(null);
  if (!points.length) return null;
  return <div className="pb-flight" aria-label="Correspondence activity">
    <ol>{points.map((point, index) => <li key={`${point.label}:${index}`} data-uncertain={Boolean(point.uncertain)} data-current={Boolean(point.current)} data-dismissed={dismissed === index} onMouseEnter={() => setDismissed(null)} onFocus={() => setDismissed(null)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(index); } }}>
      <button type="button" aria-describedby={`${id}-${index}`} className="pb-flight-node"><i aria-hidden="true" /><span>{point.label}</span></button>
      <div role="tooltip" id={`${id}-${index}`} className="pb-flight-detail"><strong>{point.label}</strong><span>{point.detail}</span>{point.at ? <time dateTime={point.at}>{new Date(point.at).toLocaleString()}</time> : null}</div>
    </li>)}</ol>
    {note ? <p className="pb-flight-note">{note}</p> : null}
  </div>;
}
