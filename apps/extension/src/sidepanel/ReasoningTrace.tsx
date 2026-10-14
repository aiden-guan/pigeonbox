import { useEffect, useId, useState } from 'react';
import { Orb } from '../ui/Orb';
import { classifyStep, duration, kindsOf, liveLabel, STEP_KINDS, type StepKind } from './reasoning';

/** 24-unit stroke glyphs, one per kind of work. */
const GLYPH: Record<StepKind, string> = {
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20',
  read: 'M4 5.5h6a2 2 0 0 1 2 2V19a1.5 1.5 0 0 0-1.5-1.5H4ZM20 5.5h-6a2 2 0 0 0-2 2V19a1.5 1.5 0 0 1 1.5-1.5H20Z',
  web: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM4 12h16M12 4c2.2 2.3 3 5 3 8s-.8 5.7-3 8c-2.2-2.3-3-5-3-8s.8-5.7 3-8Z',
  people: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20c.6-3.5 3.3-5.5 7-5.5s6.4 2 7 5.5',
  calendar: 'M5 6.5h14v13H5ZM5 10.5h14M9 4v4M15 4v4',
  followups: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 8v4.5l3 2',
  tracking: 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  memory: 'M12 20c-1.5-2-6-4.5-6-9a6 6 0 0 1 12 0c0 4.5-4.5 7-6 9ZM12 8v3.5M10 10h4',
  write: 'M5 19l1-4L15.5 5.5a2.1 2.1 0 0 1 3 3L9 18Z M13.5 7.5l3 3',
  inbox: 'M4 13.5 6.5 5h11l2.5 8.5V19H4ZM4 13.5h4.5l1 2h5l1-2H20',
  think: 'M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20M6.3 6.3l1.8 1.8M15.9 15.9l1.8 1.8M6.3 17.7l1.8-1.8M15.9 8.1l1.8-1.8',
};

export function StepGlyph({ kind, size = 12 }: { kind: StepKind; size?: number }) {
  return (
    <svg className="pb-step-glyph" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={GLYPH[kind]} />
    </svg>
  );
}

/**
 * The reasoning path behind one Ask answer. While Pigeon works, one line says
 * what it is doing now, with a shimmer and the matching orb. Expanded, every
 * step shows as a row with a pill naming the kind of work. When the answer
 * lands the line settles into "Worked for 6s" with the kinds it used.
 */
export function ReasoningTrace(props: { steps: readonly string[]; live: boolean; writing?: boolean; thinking?: boolean; startedAt?: number; took?: number; stopped?: boolean; note?: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const steps = props.steps.map(classifyStep);
  const label = props.live ? liveLabel(steps, { writing: props.writing, thinking: props.thinking }) : props.stopped ? 'Stopped' : props.took ? `Worked for ${duration(props.took)}` : 'Worked through it';
  const current = steps[steps.length - 1];
  const orb = props.writing ? 'drafting' : props.thinking || !current ? 'analyzing' : STEP_KINDS[current.kind].orb;
  const kinds = kindsOf(steps);
  const elapsed = useElapsed(props.live ? props.startedAt : undefined);
  const count = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  return (
    <section className="pb-trace" data-live={props.live || undefined} data-open={open || undefined} aria-label="How Pigeon worked">
      <button type="button" className="pb-trace-head" aria-expanded={open} aria-controls={panel} disabled={!steps.length} onClick={() => setOpen((value) => !value)}>
        {props.live ? (
          <Orb size={16} state={orb} />
        ) : (
          <span className="pb-trace-stack" aria-hidden="true">
            {kinds.slice(0, 3).map((kind) => <span key={kind} data-kind={kind}><StepGlyph kind={kind} size={10} /></span>)}
          </span>
        )}
        <span className="pb-trace-label" role="status"><span key={label}>{label}</span></span>
        {props.live && current?.detail && !props.writing && !props.thinking ? <span className="pb-trace-detail">{current.detail}</span> : null}
        {!props.live && steps.length ? <span className="pb-trace-meta">{count}</span> : props.live && elapsed ? <span className="pb-trace-meta">{elapsed}</span> : null}
        {steps.length ? (
          <svg className="pb-trace-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        ) : null}
      </button>
      {open ? (
        <ol className="pb-trace-steps" id={panel}>
          {steps.map((step, index) => {
            const active = props.live && !props.writing && !props.thinking && index === steps.length - 1;
            return (
              <li key={index} data-kind={step.kind} data-active={active || undefined} style={{ ['--i' as string]: Math.min(index, 8) }}>
                <span className="pb-step-pill" data-kind={step.kind}><StepGlyph kind={step.kind} />{STEP_KINDS[step.kind].pill}</span>
                <span className="pb-step-text" title={step.text}>{step.detail || step.text}</span>
              </li>
            );
          })}
          {props.note && !props.live ? <li className="pb-trace-note">{props.note}</li> : null}
        </ol>
      ) : null}
    </section>
  );
}

/** Seconds since a start time, ticking once a second while work is live; quiet for the first two seconds. */
function useElapsed(since?: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  if (!since || now - since < 2000) return '';
  return duration(now - since);
}
