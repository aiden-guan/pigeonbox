import type { WorkspaceContext } from '../workspace/context';
import { trackProductEvent } from '../ui/analytics';
import type { AskPigeonResponse, AskTurn, SourceRef } from '@pigeonbox/api-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextCard } from '../ui/Primitives';
import { Orb } from '../ui/Orb';
import { cloudAskStream, cloudCall } from './cloud-api';
import { useWorkspaceInput } from '../workspace/session';
import { AnswerText } from './AnswerText';
import { safeSourceUrl, SourceChips } from './SourceChips';

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
};

/** Streamed text without unresolved citation markers (including a half-written one at the end). */
function liveText(text: string): string {
  return text.replace(/\s*\[(?:\s*S\d+\s*[,;]?)+\]/gi, '').replace(/\s*\[S?\d*,?\s*$/i, '');
}

/** Earlier turns as model context: the question, and the answer without citation markers. */
function historyOf(turns: Turn[]): AskTurn[] {
  return turns.slice(-6).flatMap((turn) => {
    const reply = turn.answer?.answer ?? turn.action;
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
    const update = (patch: Partial<Turn>) => setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)));
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
      if (result.ok) update({ answer: result.data, live: undefined });
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
        className="gi-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void runQuestion(query);
        }}
      >
        <input
          className="gi-field min-w-0 flex-1"
          aria-label="Ask Pigeon"
          placeholder={turns.length ? 'Ask a follow-up…' : 'Ask anything about your mail'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="gi-btn shrink-0" disabled={busy || !query.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
