import type { WorkspaceContext } from '../workspace/context';
import { trackProductEvent } from '../ui/analytics';
import type { AskCompose, AskPigeonResponse, AskTurn, SourceRef } from '@pigeonbox/api-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextCard } from '../ui/Primitives';
import { Orb } from '../ui/Orb';
import { cloudAskStream, cloudCall } from './cloud-api';
import { useWorkspaceInput } from '../workspace/session';
import { AnswerText } from './AnswerText';
import { safeSourceUrl, SourceChips } from './SourceChips';
import { useDictation } from './dictation';

type Turn = {
  id: number;
  question: string;
  answer?: AskPigeonResponse;
  error?: string;
  action?: string;
  /** What Pigeon has done so far, while the answer streams. */
  steps?: string[];
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

/** Earlier turns as model context: the question, and the answer without citation markers. */
function historyOf(turns: Turn[]): AskTurn[] {
  return turns.slice(-6).flatMap((turn) => {
    // Composed emails go along so "make it shorter" can revise them.
    const composed = (turn.answer?.compose ?? []).map((email) => `\n\n[Opened in Gmail · To: ${recipients(email.to) || '(none)'} · Subject: ${email.subject}]\n${email.body}`).join('');
    const reply = turn.answer ? turn.answer.answer + composed : turn.action;
    return reply
      ? [
          { role: 'user' as const, content: turn.question.slice(0, 2_000) },
          { role: 'assistant' as const, content: reply.replace(/\[\d{1,2}\]/g, '').slice(0, 4_000) },
        ]
      : [];
  });
}

export function CloudAsk(props: {
  onOpenThread: (threadId: string, accountId?: string) => void;
  capabilities: readonly string[];
  context?: WorkspaceContext | null;
  onContextQuestion?: (question: string) => Promise<string | null>;
  pendingQuery?: { id: string; query: string } | null;
  onQueryConsumed?: () => void;
}) {
  const { pendingQuery, onQueryConsumed, onContextQuestion } = props;
  const [query, setQuery] = useWorkspaceInput(`cloud:ask:${props.context?.owner?.email || 'mailbox'}`, '');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const consumed = useRef('');
  const inFlight = useRef(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useDictation(setQuery);
  // The field grows with what is typed or dictated, up to a cap, then scrolls.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    // No scrollbar until the text is taller than the cap.
    element.style.overflowY = element.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [query]);
  useEffect(() => {
    let mounted = true;
    if (props.capabilities.includes('cloud_calendar'))
      void cloudCall<{ accounts: { features: string[] }[] }>('connections').then((result) => {
        if (mounted)
          setCalendarConnected(
            result.ok && result.data.accounts.some((account) => account.features.includes('calendar_read')),
          );
      });
    return () => {
      mounted = false;
    };
  }, [props.capabilities]);
  const runQuestion = useCallback(async (input: string) => {
    const question = input.trim();
    if (!question || inFlight.current) return;
    inFlight.current = true;
    trackProductEvent('ask_pigeon_used', { surface: 'sidepanel', mode: 'cloud' });
    const id = nextId.current++;
    const history = historyOf(turnsRef.current);
    const update = (patch: Partial<Turn> | ((turn: Turn) => Partial<Turn>)) =>
      setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...(typeof patch === 'function' ? patch(turn) : patch) } : turn)));
    setTurns((current) => [...current, { id, question }]);
    setQuery('');
    setBusy(true);
    try {
      const action = await onContextQuestion?.(question);
      if (action) { update({ action }); return; }
      const steps: string[] = [];
      let live = '';
      const result = await cloudAskStream(
        {
          query: question,
          ...(props.context?.owner ? { threadId: props.context.threadId, mailbox: props.context.owner.email } : {}),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          features: ['compose'],
          ...(history.length ? { history } : {}),
        },
        (event) => {
          if (event.type === 'status') {
            if (event.text !== 'Thinking' && steps[steps.length - 1] !== event.text) steps.push(event.text);
          } else if (event.type === 'delta') live += event.text;
          else live = '';
          update({ steps: [...steps], live });
        },
      );
      if (result.ok) {
        update({ answer: result.data, live: undefined });
        // The user asked for this email: put it in front of them in Gmail right away.
        const first = result.data.compose?.[0];
        if (first) {
          update({ opened: { 0: 'opening' } });
          const opened = await openInGmail(first);
          update((turn) => ({ opened: { ...turn.opened, 0: opened ? 'opened' : 'failed' } }));
        }
      }
      else {
        update({ error: result.reason, live: undefined });
        setQuery(question);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [props.context, onContextQuestion, setQuery]);
  useEffect(() => {
    const pending = pendingQuery;
    if (!pending || consumed.current === pending.id || inFlight.current) return;
    consumed.current = pending.id;
    onQueryConsumed?.();
    void runQuestion(pending.query);
  }, [pendingQuery, onQueryConsumed, runQuestion, busy]);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [turns, busy]);

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
        {props.context ? <ContextCard subject={props.context.subject} sender={props.context.sender} motionKey={`context:${props.context.threadId}`} /> : null}
        {turns.length ? (
          <div className="pb-ask-thread-head">
            <button type="button" className="gi-link" disabled={busy} onClick={() => setTurns([])}>
              New chat
            </button>
          </div>
        ) : (
          <div className="gi-ask-start">
            <h2>Ask Pigeon</h2>
            <p>{props.context ? `This thread · ${props.context.subject || 'Current conversation'}` : 'Your whole mailbox'}</p>
            <div className="gi-scope-chips">
              <span>Mail</span>
              {calendarConnected ? <span>Calendar</span> : null}
              {props.capabilities.includes('cloud_relationships') ? <span>Contacts</span> : null}
            </div>
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
        )}
        {turns.map((turn) => (
          <div key={turn.id} className="pb-ask-turn">
            <p className="gi-asked">{turn.question}</p>
            {turn.steps?.length && !turn.answer && !turn.error ? (
              <ol className="pb-ask-steps" aria-label="What Pigeon is doing">
                {turn.steps.map((step, index) => (
                  <li key={index} className={index === turn.steps!.length - 1 && !turn.live ? 'is-active' : undefined}>
                    {step}
                  </li>
                ))}
              </ol>
            ) : null}
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
                  <section className="pb-answer-sources" aria-label="Sources">
                    <h2 className="gi-kicker">Sources</h2>
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
                  </section>
                ) : null}
                {turn.answer.coverage.note ? <p className="gi-muted mt-3 text-[11px] leading-relaxed">{turn.answer.coverage.note}</p> : null}
                {turn.answer.requestId ? <AnswerFeedback turn={turn} onRate={(rating, note) => rate(turn, rating, note)} /> : null}
                {turn.id === turns[turns.length - 1]?.id && turn.answer.followUps?.length ? (
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
        {busy && !turns[turns.length - 1]?.live ? (
          <p className="gi-muted gi-orb-line" role="status">
            <Orb size={18} />
            Searching your mail…
          </p>
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
            placeholder={dictation.state === 'listening' ? 'Listening…' : dictation.state === 'starting' ? 'Starting the microphone…' : turns.length ? 'Ask a follow-up' : 'Ask Pigeon anything'}
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
