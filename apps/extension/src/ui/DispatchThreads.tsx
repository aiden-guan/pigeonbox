import { useEffect, useRef, useState } from 'react';
import type { LocalThreadIntel } from '../content/thread/ThreadPanel';
import { DotField } from './DotField';
import { Pigeon } from './Pigeon';
import { useDispatchLayout } from './dispatch-motion';

export type DispatchThread = { threadId: string; sender: string; subject: string; snippet: string; timestamp: string; priority?: string; manual?: boolean };

export function DispatchThreads(props: { threads: DispatchThread[]; category: string; onOpen: (id: string) => void; onAsk: (question: string) => void; compact?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [intel, setIntel] = useState<LocalThreadIntel | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const rowFocus = useRef<HTMLButtonElement | null>(null);
  const backFocus = useRef<HTMLButtonElement | null>(null);
  const layout = useDispatchLayout<HTMLUListElement>(`${props.category}|${selected}|${props.threads.map((thread) => thread.threadId).join('|')}`);
  useEffect(() => { setSelected(null); setIntel(null); setError(''); request.current++; }, [props.category]);
  useEffect(() => {
    if (!selected) return;
    backFocus.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [selected]);
  function close() { request.current++; setSelected(null); setIntel(null); setReading(false); requestAnimationFrame(() => rowFocus.current?.focus({ preventScroll: true })); }
  function select(thread: DispatchThread, button: HTMLButtonElement) {
    rowFocus.current = button;
    setSelected(thread.threadId); setIntel(null); setReading(true); setError('');
    const id = ++request.current;
    chrome.runtime.sendMessage({ type: 'GET_THREAD_INTEL', threadId: thread.threadId }, (response?: LocalThreadIntel) => {
      if (id !== request.current) return;
      if (chrome.runtime.lastError) setError('Could not read this brief. Open the thread in Gmail to try again.');
      setIntel(response ?? null); setReading(false);
    });
  }
  const summary = intel?.summary;
  const brief = summary && ((summary.source === 'model' && summary.aiStatus === 'success') || (summary.source === 'message' && summary.aiStatus !== 'failed')) ? summary.summary : null;
  return <ul ref={layout} className="pb-dispatch-list" data-detail={Boolean(selected)} aria-label={`${props.category} threads`}>
    {props.threads.map((thread) => <li key={thread.threadId} data-motion-id={`thread:${thread.threadId}`} className="pb-dispatch-thread" data-selected={selected === thread.threadId} hidden={Boolean(selected && selected !== thread.threadId)}>
      {selected === thread.threadId ? <button ref={backFocus} type="button" className="pb-brief-back" onClick={close}>← {props.category.replaceAll('_', ' ')}</button> : null}
      <button type="button" className="pb-thread-heading" aria-expanded={selected === thread.threadId} aria-label={`Read brief: ${thread.subject || '(no subject)'}`} onClick={(event) => selected === thread.threadId ? close() : select(thread, event.currentTarget)}>
        <span className="pb-thread-sender" data-motion-id={`sender:${thread.threadId}`}><i data-priority={thread.priority === 'HIGH'} aria-hidden="true" />{thread.sender}</span>
        <time className="gi-time" dateTime={thread.timestamp}>{threadTime(thread.timestamp)}</time>
        <span className="pb-thread-subject" data-motion-id={`subject:${thread.threadId}`}>{thread.subject || '(no subject)'}</span>
        {!selected && !props.compact && thread.snippet ? <span className="pb-thread-context">{thread.snippet}</span> : null}
        {!selected ? <span className="pb-thread-enter" aria-hidden="true">↗</span> : null}
      </button>
      <div className="pb-brief-reveal" data-open={selected === thread.threadId} inert={selected !== thread.threadId}>
        <div>{selected === thread.threadId ? <section className="pb-thread-brief" aria-label="Pidgy Brief">
          <div className="pb-brief-label"><span className="gi-kicker">Pidgy Brief</span><Pigeon state={reading ? 'searching' : error || summary?.aiStatus === 'failed' ? 'attention' : 'idle'} size={36} /></div>
          {reading ? <p className="gi-muted gi-orb-line" role="status"><DotField state="searching" size={20} />Reading indexed thread…</p> : error ? <p className="gi-danger" role="alert">{error}</p> : brief?.oneLine ? <p className="pb-intelligence">{brief.oneLine}</p> : <p className="gi-muted">No generated brief yet. Open this thread in Gmail to analyze it.</p>}

          {brief?.actionItems?.length ? <div className="pb-brief-section"><h3 className="gi-kicker">Next</h3><ul>{brief.actionItems.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
          {brief?.dates?.length ? <div className="pb-brief-section"><h3 className="gi-kicker">Key date</h3><p>{brief.dates.join(' · ')}</p></div> : null}
          <div className="pb-brief-actions"><button type="button" onClick={() => props.onOpen(thread.threadId)}>Open thread in Gmail <span>↗</span></button><button type="button" onClick={() => props.onAsk(`What needs my attention in the thread "${thread.subject}" from ${thread.sender}?`)}>Ask about thread <span>→</span></button></div>
        </section> : null}</div>
      </div>
    </li>)}
  </ul>;
}

function threadTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}
