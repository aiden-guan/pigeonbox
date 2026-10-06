/**
 * Secondary, on-demand context for the Cloud thread companion. Nothing here
 * loads until it matters: a first-contact note opens only when asked, and the
 * Calendar hint asks only whether Calendar is connected (no free/busy read).
 * Availability itself is used automatically by the prepared scheduling reply;
 * there is no calendar card or "insert availability" step.
 */
import { useEffect, useState } from 'react';
import type { RelationshipBrief, ThreadIntel } from '@pigeonbox/api-contract';

type ContextReply<T> = { ok?: boolean; reason?: string; needsConnection?: boolean; data?: T };

function threadContext<T>(kind: 'relationship' | 'calendar_status', intel: ThreadIntel, mailbox?: string): Promise<ContextReply<T>> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'CLOUD_THREAD_CONTEXT', kind, threadId: intel.threadId, mailbox }, (result) =>
        resolve(chrome.runtime.lastError ? { ok: false } : ((result ?? {}) as ContextReply<T>)),
      );
    } catch {
      resolve({ ok: false });
    }
  });
}

/**
 * "Connect Calendar to suggest times": shown only for a scheduling thread whose
 * reply could not use the calendar, and only when Calendar is in fact not connected.
 */
export function CalendarConnectHint({ intel, mailbox }: { intel: ThreadIntel; mailbox?: string }) {
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    let active = true;
    void threadContext<{ connected?: boolean }>('calendar_status', intel, mailbox).then((reply) => {
      if (active && reply.ok && reply.data?.connected === false) setDisconnected(true);
    });
    return () => {
      active = false;
    };
  }, [intel, mailbox]);
  if (!disconnected) return null;
  return (
    <button
      type="button"
      className="gi-text-btn pb-cc-secondary"
      onClick={() => chrome.runtime.sendMessage({ type: 'FOCUS_SIDEPANEL', mode: 'cloud', section: 'connections' })}
    >
      Connect Calendar to suggest times
    </button>
  );
}

/** Who a first-time correspondent is, loaded when the person opens it. */
export function FirstContactNote({ intel, mailbox, name }: { intel: ThreadIntel; mailbox?: string; name: string }) {
  const [brief, setBrief] = useState<RelationshipBrief | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle');
  const load = () => {
    if (state !== 'idle') return;
    setState('loading');
    void threadContext<{ brief?: RelationshipBrief }>('relationship', intel, mailbox).then((reply) => {
      if (!reply.ok) return setState('error');
      const next = reply.data?.brief ?? null;
      const meaningful = next && (next.whoTheyAre?.trim() || next.lastDiscussed || next.nextMeeting || next.youOwe.length || next.theyOwe.length);
      if (meaningful) {
        setBrief(next);
        setState('idle');
      } else setState('empty');
    });
  };
  return (
    <details className="pb-cc-disclosure" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) load(); }}>
      <summary>About {name}</summary>
      {brief ? (
        <div className="pb-cc-detail">
          {brief.whoTheyAre ? <p>{brief.whoTheyAre}</p> : null}
          {brief.lastDiscussed ? <p>Last discussed: {brief.lastDiscussed.text}</p> : null}
          {brief.nextMeeting ? <p>Next meeting: {brief.nextMeeting.title} · {new Date(brief.nextMeeting.start).toLocaleString()}</p> : null}
          {brief.youOwe.length || brief.theyOwe.length ? <p>{brief.youOwe.length} open from you · {brief.theyOwe.length} from them</p> : null}
        </div>
      ) : state === 'loading' ? (
        <p className="pb-cc-detail" role="status">Looking…</p>
      ) : state === 'empty' ? (
        <p className="pb-cc-detail">No earlier conversations.</p>
      ) : state === 'error' ? (
        <p className="pb-cc-detail" role="alert">Could not load this. Try again later.</p>
      ) : null}
    </details>
  );
}
