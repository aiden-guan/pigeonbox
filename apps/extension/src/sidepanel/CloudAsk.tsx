import type { WorkspaceContext } from '../workspace/context';
import { trackProductEvent } from '../ui/analytics';
import type { AskPigeonResponse } from '@pigeonbox/api-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextCard } from '../ui/Primitives';
import { Orb } from '../ui/Orb';
import { cloudCall } from './cloud-api';
import { useWorkspaceInput } from '../workspace/session';
import { SourceChips } from './SourceChips';

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
  const [asked, setAsked] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskPigeonResponse | null>(null);
  const [error, setError] = useState('');
  const [actionAnswer, setActionAnswer] = useState('');
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
    setAsked(question);
    setQuery('');
    setBusy(true);
    setError('');
    setAnswer(null); setActionAnswer('');
    try {
      const action = await onContextQuestion?.(question);
      if (action) { setActionAnswer(action); return; }
      const result = await cloudCall<AskPigeonResponse>('askPigeon', {
        query: question,
        ...(props.context?.owner ? { threadId: props.context.threadId, mailbox: props.context.owner.email } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (result.ok) setAnswer(result.data);
      else {
        setError(result.reason);
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

  const sources = new Map((answer?.sources ?? []).map((source) => [source.id, source]));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pb-ask-content min-h-0 flex-1 overflow-auto">
        {props.context ? <ContextCard subject={props.context.subject} sender={props.context.sender} motionKey={`context:${props.context.threadId}`} /> : null}
        {asked ? (
          <p className="gi-asked">{asked}</p>
        ) : (
          <div className="gi-ask-start">
            <h2>Ask Pigeon</h2>
            <p>{props.context ? `This thread · ${props.context.subject || 'Current conversation'}` : 'Your synced mailbox'}</p>
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
        {busy ? (
          <p className="gi-muted gi-orb-line" role="status">
            <Orb size={18} />
            Reviewing your mail…
          </p>
        ) : null}
        {error ? <p className="gi-danger">{error}</p> : null}
        {actionAnswer ? <p className="pb-intelligence" role="status">{actionAnswer}</p> : null}
        {answer ? (
          <section className="pb-answer"><h2 className="gi-kicker">Answer</h2>
            {answer.claims.length ? (
              <ul className="gi-claims">
                {answer.claims.map((claim, index) => (
                  <li key={index}>
                    <span>{claim.text}</span>
                    {claim.sourceIds.map((id) => {
                      const source = sources.get(id);
                      if (!source) return null;
                      return <span key={id} className="pb-citation-ref" title={source.title}>[{String(answer.sources.findIndex((item) => item.id === id) + 1).padStart(2, '0')}]</span>;
                    })}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pb-intelligence whitespace-pre-wrap">{answer.answer}</p>
            )}
            {answer.sources.length ? <section className="pb-answer-sources" aria-label="Sources"><h2 className="gi-kicker">Sources</h2><ol className="pb-source-list">{answer.sources.map((source, index) => <li key={source.id}><span className="pb-source-number">{String(index + 1).padStart(2, '0')}</span>{source.gmailThreadId ? <button type="button" onClick={() => props.onOpenThread(source.gmailThreadId!, source.accountId)}>{source.title}<span aria-hidden="true">↗</span></button> : <SourceChips sources={[source]} onOpenThread={props.onOpenThread} />}</li>)}</ol></section> : null}
            {answer.unverified.length ? (
              <p className="gi-warn">Could not check: {answer.unverified.join('; ')}</p>
            ) : null}
            {answer.coverage.note ? <p className="gi-muted mt-3 text-[11px] leading-relaxed">{answer.coverage.note}</p> : null}
          </section>
        ) : null}
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
          placeholder="Who am I waiting on?"
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
