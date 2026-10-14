import type { WorkspaceContext } from '../workspace/context';
import { trackProductEvent } from '../ui/analytics';
import type { AskCompose, AskPigeonResponse, AskTurn, SourceRef } from '@pigeonbox/api-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextCard } from '../ui/Primitives';
import { cloudAskStream, cloudCall } from './cloud-api';
import { useWorkspaceInput } from '../workspace/session';
import { AnswerText } from './AnswerText';
import { safeSourceUrl, SourceChips } from './SourceChips';
import { ReasoningTrace } from './ReasoningTrace';
import { useDictation } from './dictation';
import { clearAskHistory, loadAskHistory, RETENTION_CHOICES, saveAskHistory, setAskHistoryRetention, type RetentionDays, type StoredTurn } from './ask-history';

type Turn = {
  id: number;
  /** The conversation this turn belongs to. Earlier conversations stay on screen; only the current one is sent as context. */
  chatId: number;
  at: number;
  question: string;
  /** The Gmail thread open when this was asked, if Ask was scoped to one. */
  threadId?: string;
  answer?: AskPigeonResponse;
  error?: string;
  action?: string;
  /** What Pigeon did, one status per tool call. Kept with the answer so the path can be reopened. */
  steps?: string[];
  /** Between tool rounds the model is reasoning over what it found. */
  thinking?: boolean;
  startedAt?: number;
  /** How long the answer took, in milliseconds. */
  took?: number;
  /** Answer text as it is written, before citations are resolved. */
  live?: string;
  /** Whether each composed email reached Gmail's composer. */
  opened?: Record<number, 'opening' | 'opened' | 'failed'>;
  /** Thumbs up or down, and whether the "what went wrong" note is open or sent. */
  rating?: 'up' | 'down';
  feedback?: 'writing' | 'sent';
};

/** Opens a composed email in the user's Gmail tab. PigeonBox never sends it. */
function openInGmail(compose: AskCompose): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_COMPOSE_DRAFT', draft: compose }, (response?: { opened?: boolean }) => {
        resolve(!chrome.runtime.lastError && Boolean(response?.opened));
      });
    } catch {
      resolve(false);
    }
  });
}

function recipients(list: AskCompose['to']): string {
  return list.map((person) => (person.name ? `${person.name} <${person.email}>` : person.email)).join(', ');
}

/** A new email Pigeon wrote, as it will appear in Gmail. */
function ComposeCard(props: { compose: AskCompose; state?: 'opening' | 'opened' | 'failed'; onOpen: () => void }) {
  const { compose, state } = props;
  return (
    <section className="pb-compose-card" aria-label="Email ready in Gmail">
      <dl>
        <div>
          <dt>To</dt>
          <dd>{compose.to.length ? recipients(compose.to) : <span className="gi-muted">Add a recipient</span>}</dd>
        </div>
        {compose.cc.length ? (
          <div>
            <dt>Cc</dt>
            <dd>{recipients(compose.cc)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Subject</dt>
          <dd>{compose.subject || <span className="gi-muted">(no subject)</span>}</dd>
        </div>
      </dl>
      <p className="pb-compose-body">{compose.body}</p>
      <div className="pb-compose-foot">
        <span className="gi-muted" role="status">
          {state === 'opening' ? 'Opening in Gmail…' : state === 'opened' ? 'Open in Gmail. Review it, then send.' : state === 'failed' ? 'Gmail did not open it.' : 'Not sent.'}
        </span>
        <button type="button" className="gi-btn gi-btn-ghost" disabled={state === 'opening'} onClick={props.onOpen}>
          {state === 'opened' ? 'Open again' : 'Open in Gmail'}
        </button>
      </div>
    </section>
  );
}

/**
 * Streamed text without unresolved citation markers (including a half-written
 * one at the end) and without the trailing "Next: …" follow-ups line, which
 * arrives as chips once the answer is done.
 */
export function liveText(text: string): string {
  return text
    .replace(/\n\s*(?:[-*]\s*)?(?:\*\*)?(?:n(?:e(?:x(?:t)?)?)?|follow[- ]?u?p?s?)?(?:\*\*)?\s*(?::[^\n]*)?$/i, (tail) => (/^\n\s*$/.test(tail) ? tail : ''))
    .replace(/\s*\[(?:\s*S\d+\s*[,;]?)+\]/gi, '')
    .replace(/\s*\[S?\d*,?\s*$/i, '');
}

/** Thumbs up or down on an answer. Down asks, optionally, what went wrong. */
function AnswerFeedback(props: { turn: Turn; onRate: (rating: 'up' | 'down', note?: string) => void }) {
  const { turn } = props;
  const [note, setNote] = useState('');
  if (turn.feedback === 'sent') return <p className="gi-muted pb-feedback-thanks">Thanks, that helps Pigeon get better.</p>;
  return (
    <div className="pb-feedback">
      <div className="pb-feedback-row" role="group" aria-label="Was this answer helpful?">
        {(['up', 'down'] as const).map((rating) => (
          <button
            key={rating}
            type="button"
            className="pb-feedback-button"
            aria-pressed={turn.rating === rating}
            aria-label={rating === 'up' ? 'Good answer' : 'Bad answer'}
            title={rating === 'up' ? 'Good answer' : 'Bad answer'}
            onClick={() => props.onRate(rating)}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill={turn.rating === rating ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" style={rating === 'down' ? { transform: 'rotate(180deg)' } : undefined}>
              <path d="M7 10v11H3V10h4Zm0 0 4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.1 21H7" />
            </svg>
          </button>
        ))}
      </div>
      {turn.feedback === 'writing' ? (
        <form
          className="pb-feedback-note"
          onSubmit={(event) => {
            event.preventDefault();
            props.onRate('down', note);
          }}
        >
          <input className="gi-field min-w-0 flex-1" aria-label="What went wrong?" placeholder="What went wrong? (optional)" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
          <button type="submit" className="gi-btn gi-btn-ghost shrink-0">Send</button>
        </form>
      ) : null}
    </div>
  );
}

/** "Today, 3:42 PM", "Yesterday, 9:10 AM", "Mon, 4:05 PM". */
export function chatStamp(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return `Today, ${time}`;
  if (at >= startOfToday.getTime() - 86_400_000) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** What is kept of a finished turn: no in-progress text, and no half-written feedback note. */
function toStored(turn: Turn): StoredTurn | null {
  if (!turn.answer && !turn.error && !turn.action) return null;
  return {
    id: turn.id,
    chatId: turn.chatId,
    ...(turn.threadId ? { threadId: turn.threadId } : {}),
    at: turn.at,
    question: turn.question,
    ...(turn.answer ? { answer: turn.answer } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.action ? { action: turn.action } : {}),
    ...(turn.steps?.length ? { steps: turn.steps } : {}),
    ...(turn.took ? { took: turn.took } : {}),
    ...(turn.rating ? { rating: turn.rating } : {}),
    ...(turn.feedback === 'sent' ? { feedback: 'sent' as const } : {}),
  };
}

const RETENTION_LABEL: Record<RetentionDays, string> = { 0: 'Off', 1: '1 day', 3: '3 days', 7: '7 days' };

/** Complete exchanges with the artifacts and choices needed to interpret follow-ups. */
export function historyOf(turns: Turn[]): AskTurn[] {
  const finished = turns.filter((turn) => turn.answer || turn.action);
  // Keep the initiating request as well as the newest exchanges within the API's 20-message limit.
  const selected = finished.length > 10 ? [finished[0]!, ...finished.slice(-9)] : finished;
  return selected.flatMap((turn) => {
    const reply = turn.answer?.answer ?? turn.action;
    if (!reply) return [];
    const context: string[] = [];
    if (turn.answer) {
      const answer = turn.answer;
      if (answer.followUps?.length) context.push(`Offered follow-ups: ${JSON.stringify(answer.followUps)}`);
      for (const email of answer.compose ?? []) context.push(`[Prepared email; not sent · To: ${recipients(email.to) || '(none)'} · Cc: ${recipients(email.cc)} · Subject: ${email.subject}]\n${email.body}`);
      for (const draft of answer.drafts) {
        const variant = draft.variants.find((item) => item.label === 'recommended') ?? draft.variants[0];
        if (variant) context.push(`[Reply draft · Gmail thread: ${draft.threadId} · Account: ${draft.accountId} · Status: ${draft.status} · Subject: ${variant.subject || ''}]\n${variant.body}`);
      }
      if (answer.context) context.push(`Tool outcomes and candidates: ${answer.context}`);
      if (answer.sources.length) context.push(`Earlier sources (citation numbers are local to this answer; look them up for current evidence): ${JSON.stringify(answer.sources.map((source, index) => ({ citation: index + 1, ...source })))}`);
      if (!answer.coverage.complete || answer.unverified.length) context.push(`Uncertainty: ${answer.coverage.note} ${answer.unverified.join('; ')}`);
    }
    return [
      { role: 'user' as const, content: turn.question.slice(0, 2_000) },
      { role: 'assistant' as const, content: reply.slice(0, 8_000), ...(context.length ? { context: context.join('\n\n').slice(0, 12_000) } : {}) },
    ];
  });
}

export function CloudAsk(props: {
  onOpenThread: (threadId: string, accountId?: string) => void;
  capabilities: readonly string[];
  context?: WorkspaceContext | null;
  onContextQuestion?: (question: string) => Promise<string | null>;
  pendingQuery?: { id: string; query: string } | null;
  onQueryConsumed?: () => void;
  /** The Gmail account this panel's Gmail tab is signed in to. Ask focuses on it. */
  mailbox?: string;
}) {
  const { pendingQuery, onQueryConsumed, onContextQuestion } = props;
  const [query, setQuery] = useWorkspaceInput(`cloud:ask:${props.context?.owner?.email || 'mailbox'}`, '');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  // Time-based, so new turns and chats never collide with ones restored from history.
  const nextId = useRef(Date.now());
  const [chatId, setChatId] = useState(() => Date.now());
  const chatRef = useRef(chatId);
  chatRef.current = chatId;
  // Chat history: kept in this browser for the chosen number of days (at most 7).
  const historyScope = (props.mailbox || props.context?.owner?.email || 'mailbox').toLowerCase();
  const [retention, setRetention] = useState<RetentionDays | null>(null);
  const savedSignature = useRef('');
  const loadedScope = useRef('');
  useEffect(() => {
    let active = true;
    setRetention(null);
    loadedScope.current = '';
    setTurns([]);
    void loadAskHistory(historyScope).then(({ retentionDays, turns: stored, activeChatId }) => {
      if (!active) return;
      const last = stored[stored.length - 1];
      const resumedChat = activeChatId ?? last?.chatId ?? Date.now();
      setChatId(resumedChat);
      savedSignature.current = '';
      loadedScope.current = historyScope;
      setTurns(stored);
      setRetention(retentionDays);
    });
    return () => {
      active = false;
    };
  }, [historyScope]);
  useEffect(() => {
    if (retention === null || loadedScope.current !== historyScope) return;
    const finished = turns.map(toStored).filter((turn): turn is StoredTurn => Boolean(turn));
    const signature = `${chatId}|` + finished.map((turn) => `${turn.id}:${turn.rating ?? ''}:${turn.feedback ?? ''}`).join('|');
    if (signature === savedSignature.current) return;
    savedSignature.current = signature;
    void saveAskHistory(historyScope, finished, retention, chatId);
  }, [turns, retention, historyScope, chatId]);
  const changeRetention = (days: RetentionDays) => {
    setRetention(days);
    savedSignature.current = '';
    void setAskHistoryRetention(days);
    if (!days) void clearAskHistory();
  };
  const startNewChat = () => setChatId(Math.max(Date.now(), chatRef.current + 1));
  const clearHistory = () => {
    void clearAskHistory();
    savedSignature.current = '';
    setTurns([]);
    startNewChat();
  };
  const chatTurns = turns.filter((turn) => turn.chatId === chatId);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [accounts, setAccounts] = useState<{ email: string; status: string; features: string[] }[] | null>(null);
  const [connecting, setConnecting] = useState('');
  const calendarConnected = Boolean(accounts?.some((account) => account.features.includes('calendar_read')));
  const current = props.mailbox?.toLowerCase();
  const connected = (accounts ?? []).filter((account) => account.status !== 'disconnected');
  /** The Gmail in this tab is signed in but not connected to PigeonBox Cloud, so Ask cannot search it. */
  const unconnected = Boolean(current && accounts && !connected.some((account) => account.email.toLowerCase() === current));
  const consumed = useRef('');
  const inFlight = useRef(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useDictation(setQuery);
  // The field grows with what is typed or dictated, up to a cap, then scrolls.
  const fitField = useCallback(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    // Empty: stay one line. Measuring the placeholder while the panel is collapsing wraps it
    // a character per line and would pin the field at the cap.
    if (!element.value) {
      element.style.height = '';
      element.style.overflowY = 'hidden';
      return;
    }
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    // No scrollbar until the text is taller than the cap.
    element.style.overflowY = element.scrollHeight > 160 ? 'auto' : 'hidden';
  }, []);
  useEffect(fitField, [query, fitField]);
  // A width change rewraps the text, so measure again.
  useEffect(() => {
    const element = field.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fitField();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitField]);
  // Connected Gmail accounts: which inbox Ask focuses on, whether this one is connected, and calendar.
  useEffect(() => {
    let mounted = true;
    const load = () =>
      void cloudCall<{ accounts: { email: string; status: string; features: string[] }[] }>('connections').then((result) => {
        if (mounted && result.ok) setAccounts(result.data.accounts);
      });
    load();
    // Coming back from connecting an account in another tab.
    window.addEventListener('focus', load);
    return () => {
      mounted = false;
      window.removeEventListener('focus', load);
    };
  }, []);
  const connectMailbox = async () => {
    if (!props.mailbox) return;
    setConnecting('Opening Google…');
    trackProductEvent('google_connection_started', { surface: 'workspace', mode: 'cloud' });
    const result = await cloudCall<{ url: string }>('connectStart', { features: ['mail_read', 'drafts'], loginHint: props.mailbox, returnTo: 'extension' });
    if (!result.ok) return setConnecting(result.reason);
    setConnecting('');
    await chrome.tabs.create({ url: result.data.url });
  };
  const runQuestion = useCallback(async (input: string) => {
    const question = input.trim();
    if (!question || inFlight.current || loadedScope.current !== historyScope) return;
    inFlight.current = true;
    trackProductEvent('ask_pigeon_used', { surface: 'sidepanel', mode: 'cloud' });
    const id = nextId.current++;
    const chat = turnsRef.current.filter((turn) => turn.chatId === chatRef.current);
    const history = historyOf(chat);
    const threadId = props.context?.threadId;
    // "This" means the open email only while the whole chat has been about it;
    // otherwise a follow-up like "draft a reply" refers to the conversation.
    const shortcutsApply = Boolean(threadId) && chat.every((turn) => turn.threadId === threadId);
    const update = (patch: Partial<Turn> | ((turn: Turn) => Partial<Turn>)) =>
      setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...(typeof patch === 'function' ? patch(turn) : patch) } : turn)));
    const startedAt = Date.now();
    setTurns((current) => [...current, { id, chatId: chatRef.current, at: startedAt, startedAt, question, ...(threadId ? { threadId } : {}) }]);
    setQuery('');
    setBusy(true);
    try {
      const action = history.length && !shortcutsApply ? null : await onContextQuestion?.(question);
      if (action) { update({ action }); return; }
      const steps: string[] = [];
      let live = '';
      let thinking = false;
      const result = await cloudAskStream(
        {
          query: question,
          // The inbox the user is in: Ask searches it first. A thread is looked up in its own mailbox.
          ...(props.context?.owner ? { threadId: props.context.threadId, mailbox: props.context.owner.email } : props.mailbox ? { mailbox: props.mailbox } : {}),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          features: ['compose'],
          ...(history.length ? { history } : {}),
        },
        (event) => {
          if (event.type === 'status') {
            thinking = event.text === 'Thinking';
            if (!thinking && steps[steps.length - 1] !== event.text) steps.push(event.text);
          } else if (event.type === 'delta') {
            live += event.text;
            thinking = false;
          } else live = '';
          update({ steps: [...steps], live, thinking });
        },
      );
      if (result.ok) {
        update({ answer: result.data, live: undefined, thinking: false, took: Date.now() - startedAt });
        // The user asked for this email: put it in front of them in Gmail right away.
        const first = result.data.compose?.[0];
        if (first) {
          update({ opened: { 0: 'opening' } });
          const opened = await openInGmail(first);
          update((turn) => ({ opened: { ...turn.opened, 0: opened ? 'opened' : 'failed' } }));
        }
      }
      else {
        update({ error: result.reason, live: undefined, thinking: false, took: Date.now() - startedAt });
        setQuery(question);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [props.context, props.mailbox, onContextQuestion, setQuery, historyScope]);
  useEffect(() => {
    const pending = pendingQuery;
    if (!pending || consumed.current === pending.id || inFlight.current || loadedScope.current !== historyScope) return;
    consumed.current = pending.id;
    onQueryConsumed?.();
    void runQuestion(pending.query);
  }, [pendingQuery, onQueryConsumed, runQuestion, busy, retention, historyScope]);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [turns, busy, chatId]);

  const openCompose = async (turnId: number, index: number, compose: AskCompose) => {
    const mark = (state: 'opening' | 'opened' | 'failed') =>
      setTurns((current) => current.map((turn) => (turn.id === turnId ? { ...turn, opened: { ...turn.opened, [index]: state } } : turn)));
    mark('opening');
    mark((await openInGmail(compose)) ? 'opened' : 'failed');
  };
  const submit = () => {
    if (dictation.listening) dictation.stop();
    void runQuestion(query);
  };
  const rate = (turn: Turn, rating: 'up' | 'down', note?: string) => {
    const requestId = turn.answer?.requestId;
    if (!requestId) return;
    // Down first opens the note; sending the note (or rating up) records it.
    const final = rating === 'up' || note !== undefined;
    setTurns((current) => current.map((item) => (item.id === turn.id ? { ...item, rating, feedback: final ? 'sent' : 'writing' } : item)));
    if (final)
      void cloudCall('askFeedback', { requestId, rating, question: turn.question.slice(0, 2_000), ...(note?.trim() ? { note: note.trim().slice(0, 1_000) } : {}) });
  };
  const openSource = (source: SourceRef) => {
    if (source.gmailThreadId) props.onOpenThread(source.gmailThreadId, source.accountId);
    else {
      const url = safeSourceUrl(source.url);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pb-ask-content min-h-0 flex-1 overflow-auto">
        {unconnected ? (
          <section className="pb-connect-inbox" aria-label="Connect this inbox">
            <p>
              <strong>{props.mailbox}</strong> isn&rsquo;t connected to PigeonBox yet, so Pigeon can&rsquo;t search it.
              {connected.length ? ` Answers come from ${connected.map((account) => account.email).join(', ')}.` : ''}
            </p>
            <button type="button" className="gi-btn gi-btn-ghost" disabled={connecting === 'Opening Google…'} onClick={() => void connectMailbox()}>
              Connect this Gmail
            </button>
            {connecting && connecting !== 'Opening Google…' ? <p className="gi-danger" role="alert">{connecting}</p> : null}
          </section>
        ) : null}
        {props.context ? <ContextCard subject={props.context.subject} sender={props.context.sender} motionKey={`context:${props.context.threadId}`} /> : null}
        <div className="pb-ask-thread-head">
          {chatTurns.length ? (
            <button type="button" className="pb-ask-tool" disabled={busy} onClick={startNewChat}>
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              New chat
            </button>
          ) : null}
          <details className="pb-ask-menu">
            <summary className="pb-ask-tool" aria-label="Chat history options" title="Chat history">
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
            </summary>
            <div className="pb-ask-menu-panel">
              <label className="pb-history-keep">
                <span>Keep chats</span>
                <select
                  aria-label="Keep chat history for"
                  value={retention ?? ''}
                  disabled={retention === null}
                  onChange={(event) => changeRetention(Number(event.target.value) as RetentionDays)}
                >
                  {RETENTION_CHOICES.map((days) => (
                    <option key={days} value={days}>
                      {RETENTION_LABEL[days]}
                    </option>
                  ))}
                </select>
              </label>
              <p>Saved in this browser only.</p>
              {turns.length ? (
                <button type="button" className="pb-ask-menu-danger" disabled={busy} onClick={clearHistory}>
                  Clear history
                </button>
              ) : null}
            </div>
          </details>
        </div>
        {turns.map((turn, index) => (
          <div key={turn.id} className="pb-ask-turn" data-earlier={turn.chatId !== chatId || undefined}>
            {index === 0 || turns[index - 1]!.chatId !== turn.chatId ? (
              <p className="pb-chat-divider" role="separator">
                <span>{chatStamp(turn.at)}</span>
              </p>
            ) : null}
            <p className="gi-asked">{turn.question}</p>
            {(() => {
              const working = busy && !turn.answer && !turn.error && !turn.action && turn.id === turns[turns.length - 1]?.id;
              const steps = Array.isArray(turn.steps) ? turn.steps : [];
              return working || (steps.length && (turn.answer || turn.error)) ? (
                <ReasoningTrace steps={steps} live={working} writing={working && Boolean(turn.live)} thinking={turn.thinking} startedAt={turn.startedAt} took={turn.took} stopped={Boolean(turn.error)} note={turn.answer?.coverage.complete ? turn.answer.coverage.note : undefined} />
              ) : null;
            })()}
            {turn.live && !turn.answer ? (
              <section className="pb-answer" aria-live="polite">
                <AnswerText text={liveText(turn.live)} sources={[]} onOpenSource={openSource} />
              </section>
            ) : null}
            {turn.error ? <p className="gi-danger">{turn.error}</p> : null}
            {turn.action ? <p className="pb-intelligence" role="status">{turn.action}</p> : null}
            {turn.answer ? (
              <section className="pb-answer">
                <AnswerText text={turn.answer.answer} sources={turn.answer.sources} onOpenSource={openSource} />
                {(turn.answer.compose ?? []).map((compose, index) => (
                  <ComposeCard key={index} compose={compose} state={turn.opened?.[index]} onOpen={() => void openCompose(turn.id, index, compose)} />
                ))}
                {turn.answer.sources.length ? (
                  // Collapsed by default: the numbered citations in the answer already point here.
                  <details className="pb-answer-sources" aria-label="Sources">
                    <summary className="gi-kicker">
                      Sources <span className="pb-sources-count">{turn.answer.sources.length}</span>
                      <svg className="pb-sources-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </summary>
                    <ol className="pb-source-list">
                      {turn.answer.sources.map((source, index) => (
                        <li key={source.id}>
                          <span className="pb-source-number">{String(index + 1).padStart(2, '0')}</span>
                          {source.gmailThreadId ? (
                            <button type="button" onClick={() => props.onOpenThread(source.gmailThreadId!, source.accountId)}>
                              {source.title}
                              {source.who ? <span className="pb-source-who"> · {source.who.replace(/\s*<[^>]*>/, '')}</span> : null}
                              <span aria-hidden="true">↗</span>
                            </button>
                          ) : (
                            <SourceChips sources={[source]} onOpenThread={props.onOpenThread} />
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                {/* A complete search is described inside the reasoning path; gaps stay in view. */}
                {turn.answer.coverage.note && (!turn.answer.coverage.complete || !turn.steps?.length) ? <p className="gi-muted mt-3 text-[11px] leading-relaxed">{turn.answer.coverage.note}</p> : null}
                {turn.answer.requestId ? <AnswerFeedback turn={turn} onRate={(rating, note) => rate(turn, rating, note)} /> : null}
                {turn.id === turns[turns.length - 1]?.id && turn.chatId === chatId && turn.answer.followUps?.length ? (
                  <div className="gi-suggestions pb-follow-ups" aria-label="Suggested follow-ups">
                    {turn.answer.followUps.map((prompt) => (
                      <button type="button" key={prompt} disabled={busy} onClick={() => void runQuestion(prompt)}>
                        {prompt}
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        ))}
        {!chatTurns.length ? (
          <div className="gi-ask-start" data-after-history={turns.length ? true : undefined}>
            <h2>Ask Pigeon</h2>
            <p>
              {props.context
                ? `This thread · ${props.context.subject || 'Current conversation'}`
                : connected.length > 1 && current && !unconnected
                  ? `Focused on ${props.mailbox}, plus your ${connected.length - 1 === 1 ? 'other inbox' : `${connected.length - 1} other inboxes`}`
                  : 'Your whole mailbox'}
            </p>
            <p className="gi-scope-line" aria-label="What Pigeon can look through">
              {['Mail', ...(calendarConnected ? ['Calendar'] : []), ...(props.capabilities.includes('cloud_relationships') ? ['Contacts'] : [])].map((scope) => <span key={scope}>{scope}</span>)}
            </p>
            <div className="gi-suggestions">
              {[
                'What am I waiting on?',
                'What needs a reply today?',
                ...(calendarConnected ? ['When am I free to meet?'] : []),
                'What commitments have I made this week?',
              ].map((prompt) => (
                <button type="button" key={prompt} onClick={() => setQuery(prompt)}>
                  {prompt}
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      <form
        className="gi-composer pb-ask-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {dictation.problem ? (
          <p className="pb-mic-problem" role="alert">
            <span>{dictation.problem}</span>
            <button type="button" aria-label="Dismiss" onClick={dictation.clearProblem}>×</button>
          </p>
        ) : dictation.waitingForPermission ? (
          <p className="pb-mic-problem" role="status">
            <span>Choose Allow in Chrome&rsquo;s microphone prompt at the top of the window.</span>
          </p>
        ) : null}
        <div className="pb-ask-box" data-listening={dictation.state === 'listening' || undefined}>
          <textarea
            ref={field}
            rows={1}
            className="pb-ask-field"
            aria-label="Ask Pigeon"
            placeholder={dictation.state === 'listening' ? 'Listening…' : dictation.state === 'starting' ? 'Starting the microphone…' : chatTurns.length ? 'Ask a follow-up' : 'Ask Pigeon anything'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter asks; Shift+Enter adds a line. Leave Enter alone while an IME is composing.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!busy && query.trim()) submit();
              }
            }}
          />
          <button
            type="button"
            className="pb-ask-icon pb-mic"
            data-state={dictation.state}
            aria-pressed={dictation.listening}
            aria-label={dictation.listening ? 'Stop dictating' : 'Dictate your question'}
            title={dictation.listening ? 'Stop dictating' : 'Dictate'}
            onClick={() => (dictation.listening ? dictation.stop() : void dictation.start(query))}
          >
            {dictation.state === 'listening' ? (
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            )}
          </button>
          <button type="submit" className="pb-ask-icon pb-ask-send" aria-label="Ask" title="Ask (Enter)" disabled={busy || !query.trim()}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
