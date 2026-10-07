import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatAfterSend,
  isDeliveredTrackedEmail,
  normalizeGmailId,
  type TrackedEmailSummary,
  type TrackingTimelineEntry,
} from '@pigeonbox/tracking';
import { Orb } from '../ui/Orb';
import { Pigeon } from '../ui/Pigeon';
import type { MailboxIdentity } from '@pigeonbox/shared';

export type WaitingThread = {
  threadId: string;
  subject: string;
  sender: string;
  snippet: string;
  timestamp: string;
};

type Filter = 'all' | 'opened' | 'unopened';

type TimelineState = { loading: boolean; entries?: TrackingTimelineEntry[]; error?: string };
type SentItem = { threadId: string | null; subject: string; who: string; timestamp: string | null };

/**
 * Every email sent with tracking on, newest first, with whether and when it was
 * opened. Threads PigeonBox sorted into Waiting without tracking follow below.
 */
export function WaitingView(props: {
  threads: WaitingThread[];
  onOpenThread: (threadId: string, folder?: 'sent' | 'inbox') => void;
  onCount: (label: string) => void;
  purpose?: 'waiting' | 'sent';
  owner?: MailboxIdentity | null;
}) {
  const { threads, onOpenThread, onCount } = props;
  const [emails, setEmails] = useState<TrackedEmailSummary[] | null>(null);
  const [trackingError, setTrackingError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [visibleCount, setVisibleCount] = useState(20);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [timelines, setTimelines] = useState<Record<string, TimelineState>>({});
  const [recent, setRecent] = useState<SentItem[] | null>(null);
  const [sentError, setSentError] = useState('');
  const [coverage, setCoverage] = useState('');
  const [revision, refresh] = useState(0);
  const purpose = props.purpose ?? 'waiting';
  const ownerEmail = props.owner?.email;
  useEffect(() => {
    if (purpose !== 'sent') return;
    let active = true;
    setRecent(null); setSentError(''); setCoverage('');
    // This fixed list query uses the local index without model inference.
    chrome.runtime.sendMessage({ type: 'ASK_INBOX', query: 'my last 50 sent emails', owner: ownerEmail ? { email: ownerEmail } : undefined }, (result?: { items?: SentItem[]; coverageNote?: string; error?: string }) => {
      if (!active) return;
      if (chrome.runtime.lastError || !result || result.error) { setSentError(result?.error || 'Could not load sent mail. Try again.'); return; }
      setRecent(result.items ?? []); setCoverage(result.coverageNote ?? '');
    });
    return () => { active = false; };
  }, [purpose, ownerEmail, revision]);

  const load = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'GET_TRACKED_EMAILS' }, (res?: { emails?: TrackedEmailSummary[] }) => {
      if (chrome.runtime.lastError || !res?.emails) { setTrackingError('Could not load tracked mail. Try again.'); return; }
      setTrackingError(''); setEmails(res.emails);
    });
  }, []);

  useEffect(() => {
    load();
    // Ask the worker for fresh counts now instead of waiting for the next minute's poll.
    chrome.runtime.sendMessage({ type: 'TRACKING_POLL' }, () => void chrome.runtime.lastError);
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.trackedEmails) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [load]);

  const sent = useMemo(
    () =>
      (emails || [])
        .filter(isDeliveredTrackedEmail)
        .sort((a, b) => ((a.sentAt || a.createdAt || '') < (b.sentAt || b.createdAt || '') ? 1 : -1)),
    [emails],
  );
  const openedCount = sent.filter(isEngaged).length;
  const shown = sent.filter((email) => (filter === 'all' ? true : filter === 'opened' ? isEngaged(email) : !isEngaged(email)));
  const visible = purpose === 'sent' ? shown.slice(0, visibleCount) : shown;
  function chooseFilter(next: Filter) { setFilter(next); setVisibleCount(20); }
  const trackedThreads = useMemo(() => new Set(sent.map((email) => normalizeGmailId(email.gmailThreadId)).filter(Boolean)), [sent]);
  const others = threads.filter((thread) => !trackedThreads.has(normalizeGmailId(thread.threadId)));
  const untracked = (recent ?? []).filter((item) => item.threadId && !trackedThreads.has(normalizeGmailId(item.threadId)));

  useEffect(() => {
    if (emails == null) return;
    onCount(sent.length ? `${sent.length} tracked · ${openedCount} opened` : others.length === 1 ? '1 thread' : `${others.length} threads`);
  }, [emails, sent.length, openedCount, others.length, onCount]);

  const fetched = useRef<Record<string, string>>({});
  const loadTimeline = useCallback((email: TrackedEmailSummary) => {
    // Refetch only when the counters moved since the last successful fetch.
    const key = `${email.openCount}:${email.clickCount}`;
    if (fetched.current[email.trackingId] === key) return;
    fetched.current[email.trackingId] = key;
    setTimelines((current) => ({ ...current, [email.trackingId]: { ...current[email.trackingId], loading: true, error: undefined } }));
    chrome.runtime.sendMessage({ type: 'GET_TRACKING_TIMELINE', trackingId: email.trackingId }, (res?: { timeline?: TrackingTimelineEntry[]; error?: string }) => {
      if (!res?.timeline) delete fetched.current[email.trackingId];
      setTimelines((current) => ({
        ...current,
        [email.trackingId]: res?.timeline
          ? { loading: false, entries: res.timeline }
          : { loading: false, entries: current[email.trackingId]?.entries, error: res?.error || 'Could not load opens.' },
      }));
    });
  }, []);

  useEffect(() => {
    const email = sent.find((item) => item.trackingId === expanded);
    if (email) loadTimeline(email);
  }, [expanded, sent, loadTimeline]);

  if (emails == null && !trackingError) {
    return <p className="gi-muted gi-orb-line px-4" role="status"><Orb size={20} />Checking tracked mail…</p>;
  }

  if (purpose !== 'sent' && !trackingError && !sent.length && !others.length) {
    return (
      <div className="gi-empty">
        <Pigeon size={138} />
        <h2>Nothing in flight.</h2>
        <p>Send an email with tracking on<br />and you’ll see here when it’s opened.</p>
      </div>
    );
  }

  return (
    <div>
      {trackingError ? <div className="px-4"><p className="gi-warn" role="alert">{trackingError}</p><button type="button" className="gi-text-btn" onClick={load}>Try again</button></div> : null}
      {purpose === 'sent' ? <div className="pb-sent-tools"><button type="button" className="gi-text-btn" onClick={() => { load(); refresh((value) => value + 1); chrome.runtime.sendMessage({ type: 'TRACKING_POLL' }, () => void chrome.runtime.lastError); }}>Refresh</button><button type="button" className="gi-text-btn" onClick={() => void openSentSearch('', ownerEmail)}>All sent in Gmail ↗</button></div> : null}
      {sent.length ? (
        <>
          <div className="gi-filter" role="group" aria-label="Filter tracked mail">
            <FilterButton active={filter === 'all'} onClick={() => chooseFilter('all')} label="All" count={sent.length} />
            <FilterButton active={filter === 'opened'} onClick={() => chooseFilter('opened')} label="Opened" count={openedCount} />
            <FilterButton active={filter === 'unopened'} onClick={() => chooseFilter('unopened')} label="Not opened" count={sent.length - openedCount} />
          </div>
          {shown.length ? (
            <ul className="gi-list">
              {visible.map((email) => (
                <TrackedRow
                  key={email.trackingId}
                  email={email}
                  open={expanded === email.trackingId}
                  timeline={timelines[email.trackingId]}
                  onToggle={() => setExpanded((current) => (current === email.trackingId ? null : email.trackingId))}
                  onOpenThread={onOpenThread}
                />
              ))}
            </ul>
          ) : (
            <p className="gi-muted px-4 py-6 text-center text-[12px]">{filter === 'opened' ? 'None opened yet.' : 'Every tracked email has been opened.'}</p>
          )}
          {shown.length > visible.length ? <button type="button" className="gi-text-btn pb-sent-more" onClick={() => setVisibleCount((value) => value + 20)}>Show more tracked mail · {shown.length - visible.length} remaining</button> : null}
        </>
      ) : !trackingError ? (
        <p className="gi-muted px-4 pb-2 text-[12px] leading-relaxed">No tracked emails yet. Turn on tracking when you send and opens show up here.</p>
      ) : null}
      {purpose === 'sent' ? <section className="pb-sent-untracked">
        <h2 className="gi-section-label px-4 pb-1 pt-3">{sent.length ? 'Other sent mail' : 'Recent sent mail'}</h2>
        {sentError ? <p className="gi-warn px-4" role="alert">{sentError}</p> : recent === null ? <p className="gi-muted px-4" role="status">Loading sent mail…</p> : untracked.length ? <ul className="gi-list">{untracked.map((item) => <li key={item.threadId}><button type="button" className="gi-mail" onClick={() => onOpenThread(item.threadId!, 'sent')}>
          <div className="flex items-baseline justify-between gap-3"><span className="truncate text-[13px] font-semibold">{item.who}</span><span className="gi-time shrink-0">{item.timestamp ? relative(item.timestamp) : ''}</span></div>
          <div className="mt-0.5 truncate text-[13px]">{item.subject || '(no subject)'}</div><span className="gi-muted text-[11px]">Not tracked</span>
        </button></li>)}</ul> : <p className="gi-muted px-4 text-[12px]">{sent.length ? 'No other sent mail in the local index.' : 'No sent mail indexed yet. Browse Sent in Gmail to add it here.'}</p>}
        {coverage ? <p className="gi-muted px-4 pb-4 text-[11px]">{coverage}</p> : null}
      </section> : null}
      {others.length ? (
        <section className="mt-3">
          <h2 className="gi-section-label px-4 pb-1 pt-3">Also waiting on a reply</h2>
          <ul className="gi-list">
            {others.map((thread) => (
              <li key={thread.threadId}>
                <button type="button" className="gi-mail" onClick={() => onOpenThread(thread.threadId)}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[13px] font-semibold tracking-[-0.02em]">{thread.sender}</span>
                    <span className="gi-time shrink-0">{relative(thread.timestamp)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[13px] text-[color:var(--pb-fg)]">{thread.subject || '(no subject)'}</div>
                  <div className="mt-1.5"><span className="gi-open-state">Not tracked</span></div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function TrackedRow(props: {
  email: TrackedEmailSummary;
  open: boolean;
  timeline?: TimelineState;
  onToggle: () => void;
  onOpenThread: (threadId: string, folder?: 'sent' | 'inbox') => void;
}) {
  const { email, open, timeline, onToggle, onOpenThread } = props;
  const engaged = isEngaged(email);
  const lastSeen = email.lastOpenedAt || email.firstOpenedAt;
  const panelId = `trk-${email.trackingId}`;
  return (
    <li>
      <button type="button" className="gi-mail" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[13px] font-semibold tracking-[-0.02em]">to {recipients(email.recipients)}</span>
          <span className="gi-time shrink-0">{relative(email.sentAt || email.createdAt || '')}</span>
        </div>
        <div className="mt-0.5 truncate text-[13px] text-[color:var(--pb-fg)]">{email.subject || '(no subject)'}</div>
        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          <span className="gi-open-state" data-opened={engaged}>
            <i aria-hidden="true" />
            {email.openCount > 0 ? (email.openCount > 1 ? `Opened ${email.openCount}×` : 'Opened') : email.clickCount > 0 ? 'Clicked' : 'Not opened'}
          </span>
          {email.clickCount > 0 && email.openCount > 0 ? (
            <span className="gi-click-state">{email.clickCount > 1 ? `${email.clickCount} clicks` : '1 click'}</span>
          ) : null}
          {lastSeen ? <span className="gi-muted truncate">last {relative(lastSeen, true)}</span> : null}
          <span className="gi-chevron ml-auto" data-open={open} aria-hidden="true">›</span>
        </div>
      </button>
      {open ? (
        <div id={panelId} className="gi-timeline-wrap">
          <ol className="gi-timeline" aria-label="Open history">
            <li data-kind="sent">
              <span className="gi-tl-label">Sent</span>
              <time dateTime={email.sentAt || undefined}>{email.sentAt ? stamp(email.sentAt) : 'Unknown time'}</time>
            </li>
            {timeline?.entries?.map((entry, index) => (
              <li key={`${entry.type}-${entry.timestamp}-${index}`} data-kind={entry.type === 'OPEN' ? 'open' : 'click'}>
                <span className="gi-tl-label">{entry.type === 'OPEN' ? 'Opened' : 'Clicked a link'}</span>
                <time dateTime={entry.timestamp}>{stamp(entry.timestamp)}</time>
                <span className="gi-tl-note">
                  {[
                    entry.device,
                    entry.type === 'CLICK' && entry.destination ? hostOf(entry.destination) : null,
                    entry.type === 'OPEN' && index === firstOpenIndex(timeline.entries!) && email.sentAt ? formatAfterSend(email.sentAt, entry.timestamp) : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ol>
          {timeline?.loading && !timeline.entries ? <p className="gi-muted gi-orb-line text-[12px]" role="status"><Orb size={14} />Loading opens…</p> : null}
          {timeline?.error ? <p className="gi-danger text-[12px]">{timeline.error}</p> : null}
          {timeline?.entries && !timeline.entries.length ? (
            <p className="gi-muted text-[12px]">{engaged ? 'The tracker has the count but not the individual times for this email.' : 'No opens yet. Gmail’s own previews and your views are not counted.'}</p>
          ) : null}
          {timeline?.entries?.some((entry) => entry.viaProxy) ? (
            <p className="gi-muted mt-2 text-[11px] leading-relaxed">Gmail loads images through its own proxy, so repeat opens on the same device may not register.</p>
          ) : null}
          <button
            type="button"
            className="gi-link mt-3 text-[12px]"
            onClick={() => (email.gmailThreadId ? onOpenThread(email.gmailThreadId, 'sent') : openSentSearch(email.subject))}
          >
            Open in Gmail ↗
          </button>
        </div>
      ) : null}
    </li>
  );
}

function FilterButton(props: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button type="button" className="gi-filter-btn" aria-pressed={props.active} data-active={props.active} onClick={props.onClick}>
      {props.label}
      <span>{props.count}</span>
    </button>
  );
}

function isEngaged(email: TrackedEmailSummary): boolean {
  return email.openCount > 0 || email.clickCount > 0;
}

function firstOpenIndex(entries: TrackingTimelineEntry[]): number {
  return entries.findIndex((entry) => entry.type === 'OPEN');
}

function recipients(list: string[]): string {
  const names = list.map((value) => value.replace(/<[^>]*>/, '').trim() || value).filter(Boolean);
  if (!names.length) return 'unknown';
  if (names.length <= 2) return names.join(', ');
  return `${names[0]} +${names.length - 1}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function stamp(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function relative(value: string, long = false): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  const suffix = long ? ' ago' : '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h${suffix}`;
  return `${Math.round(hours / 24)}d${suffix}`;
}

async function openSentSearch(subject: string, ownerEmail?: string): Promise<void> {
  const hash = subject ? `search/${encodeURIComponent(`in:sent "${subject}"`)}` : 'sent';
  let url = ownerEmail ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(ownerEmail)}#${hash}` : `https://mail.google.com/mail/u/0/#${hash}`;
  const gmail = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  const tab = gmail.find((item) => item.active && !item.pinned) || gmail.find((item) => !item.pinned);
  if (tab?.id) { if (!ownerEmail && tab.url) { const current = new URL(tab.url); current.hash = hash; url = current.href; } await chrome.tabs.update(tab.id, { url, active: true }); }
  else await chrome.tabs.create({ url });
}
