import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Pigeon } from '../ui/Pigeon';
import { prefersReducedMotion } from '../ui/motion';
import { GMAIL, LANES, MAIL, POPUPS, boardFrame, clutterBox, laneCount, sortedBox, tagsFor, type Box, type Focus } from './inbox';

export type StagePhase = 'clutter' | 'sorting' | 'sorted';

const FLY = 1150;
const EASE_IO = 'cubic-bezier(.77, 0, .175, 1)';

function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    let timer = 0;
    const update = () => {
      setResizing(true);
      setSize({ w: window.innerWidth, h: window.innerHeight });
      clearTimeout(timer);
      timer = window.setTimeout(() => setResizing(false), 160);
    };
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); clearTimeout(timer); };
  }, []);
  return { ...size, resizing };
}

const place = (box: Box): CSSProperties => ({ transform: `translate3d(${box.x}px, ${box.y}px, 0)`, width: box.w, height: box.h });

/**
 * The inbox behind onboarding. Before the choice it is a loud Gmail; the sort
 * flies every message, in a wave from the click, into a calm board that then
 * stays behind setup and lights up whatever the current question is about.
 */
export function InboxStage(props: { phase: StagePhase; origin: { x: number; y: number } | null; focus: Focus | null; finale: boolean }) {
  const { phase, origin, focus, finale } = props;
  const { w, h, resizing } = useViewport();
  const frame = boardFrame(w, h);
  const mailRefs = useRef(new Map<string, HTMLDivElement>());
  const popupRefs = useRef(new Map<string, HTMLDivElement>());
  const sorted = phase !== 'clutter';
  const unread = useTicker(2847, phase === 'clutter');

  // Order of departure: a wave that starts where the person clicked.
  const delays = useMemo(() => {
    const from = origin ?? { x: w / 2, y: h / 2 };
    const ranked = MAIL.map((mail, index) => {
      const box = clutterBox(index, w);
      return { id: mail.id, d: Math.hypot(box.x + Math.min(box.w, 520) / 2 - from.x, box.y + box.h / 2 - from.y) };
    }).sort((a, b) => a.d - b.d);
    return new Map(ranked.map((item, rank) => [item.id, 60 + rank * 20]));
  }, [origin, w, h]);

  const flights = useRef<Animation[]>([]);
  useEffect(() => () => flights.current.forEach((animation) => animation.cancel()), []);
  useLayoutEffect(() => {
    if (phase !== 'sorting') return;
    if (prefersReducedMotion()) return;
    const animations = flights.current;
    MAIL.forEach((mail, index) => {
      const node = mailRefs.current.get(mail.id);
      if (!node) return;
      const a = clutterBox(index, w);
      const b = sortedBox(mail, w, h);
      // Lift off the list and drift sideways mid-flight, so the sort reads as hands moving paper.
      const lift = { x: a.x + (b.x - a.x) * 0.42 + (index % 2 ? 18 : -18), y: a.y + (b.y - a.y) * 0.42 - 36 - (index % 5) * 8 };
      const tilt = ((index * 37) % 9) - 4;
      const delay = delays.get(mail.id) ?? 0;
      animations.push(node.animate([
        { transform: `translate3d(${a.x}px, ${a.y}px, 0)`, width: `${a.w}px`, height: `${a.h}px`, opacity: 1, offset: 0 },
        { transform: `translate3d(${lift.x}px, ${lift.y}px, 0) rotate(${tilt}deg) scale(1.03)`, width: `${(a.w + b.w) / 2.4}px`, height: `${b.h}px`, opacity: 1, offset: 0.46 },
        { transform: `translate3d(${b.x}px, ${b.y}px, 0)`, width: `${b.w}px`, height: `${b.h}px`, opacity: b.o ?? 1, offset: 1 },
      ], { duration: FLY, delay, easing: EASE_IO, fill: 'backwards' }));
      const gmailFace = node.querySelector('.ob-face-gmail');
      const cardFace = node.querySelector('.ob-face-card');
      const body = node.querySelector('.ob-mail-body');
      if (gmailFace) animations.push(gmailFace.animate([{ opacity: 1, filter: 'blur(0px)' }, { opacity: 1, filter: 'blur(0px)', offset: 0.22 }, { opacity: 0, filter: 'blur(4px)', offset: 0.5 }, { opacity: 0, filter: 'blur(4px)' }], { duration: FLY, delay, easing: 'linear', fill: 'backwards' }));
      const deep = mail.lane === 'archive' && MAIL.filter((item) => item.lane === 'archive').indexOf(mail) > 0;
      if (cardFace && !deep) animations.push(cardFace.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 0, filter: 'blur(4px)', offset: 0.34 }, { opacity: 1, filter: 'blur(0px)', offset: 0.66 }, { opacity: 1, filter: 'blur(0px)' }], { duration: FLY, delay, easing: 'linear', fill: 'backwards' }));
      if (body) animations.push(body.animate([
        { borderRadius: '0px', boxShadow: '0 0 0 0 transparent' },
        { borderRadius: '12px', boxShadow: '0 18px 40px -12px rgba(20,24,28,.35)', offset: 0.46 },
        { borderRadius: '10px', boxShadow: '0 1px 2px rgba(20,24,28,.06)' },
      ], { duration: FLY, delay, easing: EASE_IO, fill: 'backwards' }));
    });
    const target = sortedBox(MAIL.find((mail) => mail.lane === 'archive')!, w, h);
    POPUPS.forEach((popup, index) => {
      const node = popupRefs.current.get(popup.id);
      if (!node) return;
      animations.push(node.animate([
        { transform: `translate3d(${popup.x * w}px, ${popup.y * h}px, 0) rotate(${popup.r}deg) scale(1)`, opacity: 1 },
        { transform: `translate3d(${target.x + 20}px, ${target.y}px, 0) rotate(0deg) scale(.4)`, opacity: 0 },
      ], { duration: 760, delay: 40 + index * 55, easing: 'cubic-bezier(.6, 0, .4, 1)', fill: 'both' }));
    });
    // Flights end on the sorted inline styles, so they are left to finish when the phase moves on.
    // Geometry is read once when the sort starts; later resizes snap via inline styles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return (
    <div className="ob-stage" data-phase={phase} data-focus={focus ?? undefined} data-finale={finale || undefined} data-resizing={resizing || undefined} aria-hidden="true">
      <div className="ob-stage-glow" />
      <GmailChrome unread={unread} narrow={w < 760} />

      <div className="ob-lanes">
        {LANES.map((lane, index) => (
          <div key={lane.id} className="ob-lane" data-lane={lane.id} data-on={focus === null || focus === 'sort' || (focus === 'archive' && lane.id === 'archive') || (focus === 'followups' && lane.id === 'waiting') || (focus === 'summaries' && lane.id === 'updates') ? 'true' : 'false'}
            style={{ transform: `translate3d(${frame.x + index * (frame.laneW + frame.gap)}px, ${frame.top}px, 0)`, width: frame.laneW, height: frame.bottom - frame.top, '--i': index } as CSSProperties}>
            <div className="ob-lane-head">
              <span className="ob-lane-dot" />
              <span className="ob-lane-title">{lane.title}</span>
              <CountUp className="ob-lane-count" to={laneCount(lane.id)} run={sorted} delay={900 + index * 90} />
            </div>
            <div className="ob-lane-hint">{lane.hint}</div>
          </div>
        ))}
      </div>

      <AgentTicker active={sorted} x={frame.x} width={frame.width} top={frame.top - 56} />

      <div className="ob-mails">
        {MAIL.map((mail, index) => {
          const box = sorted ? sortedBox(mail, w, h) : clutterBox(index, w);
          const tags = tagsFor(mail);
          const lit = focus !== null && tags.includes(focus);
          return (
            <div key={mail.id} ref={(node) => { if (node) mailRefs.current.set(mail.id, node); else mailRefs.current.delete(mail.id); }}
              className="ob-mail" data-lane={mail.lane} data-lit={lit || undefined} data-deep={(mail.lane === 'archive' && (box.z ?? 0) < 40) || undefined}
              style={{ ...place(box), zIndex: box.z ?? 1, opacity: box.o ?? 1, '--ad': `${(delays.get(mail.id) ?? 0) + FLY - 120}ms` } as CSSProperties}>
              <div className="ob-mail-body">
                <GmailRow mail={mail} width={clutterBox(index, w).w} />
                <CardFace mail={mail} width={frame.laneW} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="ob-popups">
        {POPUPS.map((popup, index) => (
          <div key={popup.id} ref={(node) => { if (node) popupRefs.current.set(popup.id, node); else popupRefs.current.delete(popup.id); }}
            className="ob-popup" style={{ transform: `translate3d(${popup.x * w}px, ${popup.y * h}px, 0) rotate(${popup.r}deg)`, '--i': index } as CSSProperties}>
            <div className="ob-popup-inner">
              <span className="ob-popup-icon">{popup.icon}</span>
              <span><strong>{popup.title}</strong><small>{popup.body}</small></span>
              <span className="ob-popup-x">×</span>
            </div>
          </div>
        ))}
      </div>
      <div className="ob-sweep" />
    </div>
  );
}

function GmailChrome({ unread, narrow }: { unread: number; narrow: boolean }) {
  const nav: Array<[string, string]> = [['Inbox', unread.toLocaleString()], ['Starred', ''], ['Snoozed', ''], ['Important', '86'], ['Sent', ''], ['Drafts', '14'], ['Spam', '312'], ['Categories', ''], ['Receipts', '41'], ['Work', '9'], ['Travel', ''], ['Newsletters', '233']];
  return (
    <div className="ob-gmail">
      <header className="ob-gm-top" style={{ height: GMAIL.top }}>
        <span className="ob-gm-burger"><i /><i /><i /></span>
        <span className="ob-gm-logo"><svg width="26" height="20" viewBox="0 0 26 20" aria-hidden="true"><rect x="1" y="1" width="24" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M2 3l11 8 11-8" fill="none" stroke="currentColor" strokeWidth="2" /></svg>Mail</span>
        <span className="ob-gm-search"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>Search mail</span>
        <span className="ob-gm-avatar">A</span>
      </header>
      {narrow ? null : (
        <aside className="ob-gm-side" style={{ top: GMAIL.top, width: GMAIL.side }}>
          <span className="ob-gm-compose">✎ Compose</span>
          {nav.map(([label, count], index) => (
            <span key={label} className="ob-gm-nav" data-on={index === 0 || undefined}>
              <span>{label}</span>{count ? <b key={index === 0 ? count : undefined} className={index === 0 ? 'ob-gm-tick' : undefined}>{count}</b> : null}
            </span>
          ))}
        </aside>
      )}
      <nav className="ob-gm-tabs" style={{ top: GMAIL.top, left: narrow ? 8 : GMAIL.side, height: GMAIL.tabs }}>
        <span data-on="true">Primary</span>
        <span>Promotions <em style={{ background: '#1a7f37' }}>99+ new</em></span>
        <span>Social <em style={{ background: '#1a73e8' }}>48 new</em></span>
        <span>Updates <em style={{ background: '#b06000' }}>312 new</em></span>
      </nav>
    </div>
  );
}

function GmailRow({ mail, width }: { mail: (typeof MAIL)[number]; width: number }) {
  return (
    <div className="ob-face ob-face-gmail" style={{ width }}>
      <span className="ob-gm-box" />
      <span className="ob-gm-star">☆</span>
      <span className="ob-gm-from">{mail.from}</span>
      <span className="ob-gm-labels">{mail.labels?.map(([text, color]) => <span key={text} style={{ background: color }}>{text}</span>)}</span>
      <span className="ob-gm-subject"><b>{mail.subject}</b> – {mail.snippet}</span>
      <span className="ob-gm-time">{mail.time}</span>
    </div>
  );
}

function CardFace({ mail, width }: { mail: (typeof MAIL)[number]; width: number }) {
  return (
    <div className="ob-face ob-face-card" style={{ width }}>
      <div className="ob-card-from"><span className="ob-card-avatar">{mail.from.replace('You → ', '').charAt(0)}</span>{mail.from}<span className="ob-card-time">{mail.time}</span></div>
      <div className="ob-card-subject">{mail.subject}</div>
      {mail.agent ? <div className="ob-agent" data-kind={mail.agent.kind}><AgentIcon kind={mail.agent.kind} />{mail.agent.text}</div> : null}
    </div>
  );
}

function AgentIcon({ kind }: { kind: 'draft' | 'summary' | 'nudge' | 'opened' }) {
  const paths = {
    draft: <path d="M2.5 9.5 9 3l2 2-6.5 6.5H2.5v-2Z" />,
    summary: <path d="M3 4h8M3 7h8M3 10h5" />,
    nudge: <><circle cx="7" cy="7" r="4.5" /><path d="M7 4.5V7l1.6 1.2" /></>,
    opened: <><path d="M1.5 7S3.5 3.5 7 3.5 12.5 7 12.5 7 10.5 10.5 7 10.5 1.5 7 1.5 7Z" /><circle cx="7" cy="7" r="1.6" /></>,
  };
  return <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

const TICKER = ['Sorted 2,847 emails into four lanes', 'Drafted a reply to Maya Chen', 'Summarized Oliver’s contract redlines', 'Will nudge Dana about invoice #2041 on Thursday', 'Archived 20 promotions and notifications', 'Priya opened your proposal 3 times'];

function AgentTicker({ active, x, width, top }: { active: boolean; x: number; width: number; top: number }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % TICKER.length), 2800);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <div className="ob-ticker" style={{ transform: `translate3d(${x}px, ${top}px, 0)`, width }}>
      <span className="ob-ticker-pidgy"><Pigeon state={active ? 'working' : 'idle'} size={30} /></span>
      <span className="ob-ticker-live"><i />Pidgy</span>
      <span className="ob-ticker-text" key={index}>{TICKER[index]}</span>
    </div>
  );
}

/** The unread count keeps climbing while the inbox is loud. */
function useTicker(start: number, running: boolean) {
  const [value, setValue] = useState(start);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setValue((current) => current + 1 + Math.floor(Math.random() * 3)), 1500);
    return () => clearInterval(timer);
  }, [running]);
  return value;
}

export function CountUp({ to, run, delay = 0, className }: { to: number; run: boolean; delay?: number; className?: string }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!run) { setValue(0); return; }
    if (prefersReducedMotion()) { setValue(to); return; }
    let frame = 0;
    const startAt = performance.now() + delay;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - startAt) / 700));
      setValue(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, run, delay]);
  return <span className={className}>{value}</span>;
}

