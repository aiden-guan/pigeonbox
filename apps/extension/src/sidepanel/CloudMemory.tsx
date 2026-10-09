import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MemorySubject, PersonalMemory, RouteResponse } from '@pigeonbox/api-contract';
import { callCloud } from './cloud-api';
import { Orb } from '../ui/Orb';
import { SourceChips } from './SourceChips';
import './CloudMemory.css';

const CATEGORIES: Record<string, string> = { people: 'Relationships', projects: 'Work & plans', classes: 'School', decisions: 'Plans and decisions', preferences: 'Preferences', logistics: 'Recent context', other: 'Other' };
type Props = { onOpenThread: (id: string, accountId?: string) => void };

/** Saved facts live only in encrypted Cloud storage; questions and answers stay ephemeral. */
export function CloudMemory({ onOpenThread }: Props) {
  const [subjects, setSubjects] = useState<MemorySubject[]>([]);
  const [subject, setSubject] = useState('');
  const [memories, setMemories] = useState<PersonalMemory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [message, setMessage] = useState('');
  const [answer, setAnswer] = useState<RouteResponse<'memoryChat'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const request = useRef(0);
  const mutation = useRef(false);
  const history = useRef<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const response = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const panel = reader.current; const reply = response.current;
    if (!answer || !panel || !reply || panel.closest('[hidden]')) return;
    // Reveal the answer in this panel without moving the Gmail page or animating keyboard input.
    const bottom = reply.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom;
    if (bottom > 0) panel.scrollTop += bottom;
  }, [answer]);
  const busy = loading || working;

  const load = useCallback(async (next?: string) => {
    const revision = ++request.current;
    setLoading(true);
    setError('');
    const result = await callCloud('memoryList', { subject: subject || undefined, query: searched || undefined, cursor: next, limit: 20 });
    if (!alive.current || revision !== request.current) return;
    setLoading(false);
    if (!result.ok) { setError(result.reason); return; }
    setMemories(items => next ? [...new Map([...items, ...result.data.memories].map(item => [item.id, item])).values()] : result.data.memories);
    setCursor(result.data.nextCursor);
  }, [subject, searched]);

  const pages = useCallback(async () => {
    const result = await callCloud('memorySubjects', {});
    if (!alive.current) return;
    if (result.ok) setSubjects(result.data.subjects);
    else setError(result.reason);
  }, []);

  useEffect(() => { alive.current = true; void pages(); return () => { alive.current = false; request.current += 1; }; }, [pages]);
  useEffect(() => { void load(); }, [load]);

  async function change(action: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true;
    setWorking(true); setError(''); setNotice('');
    try { await action(); }
    finally { mutation.current = false; if (alive.current) setWorking(false); }
  }

  async function send() {
    const text = message.trim();
    if (!text || busy) return;
    await change(async () => {
      const result = await callCloud('memoryChat', { message: text, subject: subject || undefined, history: history.current.slice(-8) });
      if (!alive.current) return;
      if (!result.ok) { setError(result.reason); return; }
      setAnswer(result.data); setMessage('');
      history.current = [...history.current, { role: 'user' as const, text: text.length <= 2_000 ? text : '[Profile or notes submitted.]' }, { role: 'assistant' as const, text: result.data.answer }].slice(-8);
      if (result.data.changes.length) { await pages(); await load(); }
      if (document.activeElement === composer.current) composer.current?.focus({ preventScroll: true });
    });
  }

  async function edit(memory: PersonalMemory, text: string) {
    await change(async () => {
      const result = await callCloud('memoryUpdate', { memoryId: memory.id, text });
      if (!alive.current) return;
      if (!result.ok) { setError(result.reason); return; }
      setMemories(items => items.map(item => item.id === memory.id ? result.data.memory : item));
      setSubjects(items => items.map(item => item.id === memory.subject?.id ? { ...item, summary: null } : item));
      setAnswer(null); history.current = [];
      setNotice('Correction saved. Pidgy will use your wording.');
      await pages();
    });
  }

  async function forget(memory: PersonalMemory) {
    await change(async () => {
      const result = await callCloud('memoryForget', { memoryId: memory.id });
      if (!alive.current) return;
      if (!result.ok) { setError(result.reason); return; }
      setMemories(items => items.filter(item => item.id !== memory.id));
      setSubjects(items => items.map(item => item.id === memory.subject?.id ? { ...item, summary: null, factCount: Math.max(0, item.factCount - 1) } : item));
      setAnswer(null); history.current = [];
      setNotice('Forgotten. The original email stays in Gmail.');
      await pages();
    });
  }

  const current = subjects.find(item => item.id === subject);
  const groups = Object.entries(CATEGORIES).map(([category, label]) => ({ category, label, facts: memories.filter(memory => memory.category === category) })).filter(group => group.facts.length);
  return <div className="pb-memory">
    <div className="pb-memory-scroll" ref={reader}>
      <header className="pb-memory-header">
        <div className="pb-memory-mark" aria-hidden="true">✳</div>
        <div><p className="gi-kicker">Your memory</p><h2>Less repeating.<br />More remembering.</h2><p className="gi-muted">Useful context for better replies, right here in Gmail.</p></div>
      </header>
      <div className="pb-memory-tools">
        <label><span className="gi-kicker">Remembered about</span><select className="gi-field" aria-label="Memory page" value={subject} disabled={busy} onChange={event => { setSubject(event.target.value); setSearched(''); setQuery(''); setAnswer(null); history.current = []; }}>
          <option value="">All pages</option>{subjects.map(item => <option key={item.id} value={item.id}>{item.label} · {item.factCount}</option>)}
        </select></label>
        <form className="pb-memory-search" role="search" onSubmit={event => { event.preventDefault(); if (query.trim() === searched) void load(); else setSearched(query.trim()); }}>
          <input className="gi-field" type="search" aria-label="Search memories" placeholder="Find a person or detail…" maxLength={500} value={query} onChange={event => setQuery(event.target.value)} />
          <button className="gi-btn gi-btn-ghost" type="submit" disabled={busy}>Search</button>
        </form>
      </div>
      {current?.summary && !searched ? <p className="pb-memory-summary">{current.summary}</p> : null}
      {error ? <p className="gi-warn" role="alert">{error} <button className="gi-text-btn" type="button" disabled={busy} onClick={() => { void pages(); void load(); }}>Reload memories</button></p> : null}
      {notice ? <p className="pb-memory-notice" role="status">{notice}</p> : null}
      {loading ? <p className="gi-muted gi-orb-line" role="status"><Orb size={16} />Loading memories…</p> : null}
      {!loading && !error && !memories.length ? <div className="pb-memory-empty"><h3>{searched ? 'No matching memories here.' : 'A little context goes a long way.'}</h3><p>{searched ? cursor ? 'Load more to keep searching.' : 'Try another detail or choose All pages.' : 'Tell Pidgy something useful below. You can ask, correct, or forget it whenever you like.'}</p></div> : null}
      <div className="pb-memory-groups" aria-label="Saved memories" aria-busy={loading}>
        {groups.map(group => <details key={`${subject}:${group.category}`} className="pb-memory-group"><summary><span>{group.label}</span><small>{group.facts.length}</small></summary><ul>{group.facts.map(memory => <li key={memory.id}><MemoryFact memory={memory} busy={busy} onEdit={text => edit(memory, text)} onForget={() => forget(memory)} onOpenThread={onOpenThread} /></li>)}</ul></details>)}
      </div>
      {cursor ? <button className="gi-text-btn pb-memory-more" disabled={busy} type="button" onClick={() => void load(cursor)}>Load more memories</button> : null}
      {answer ? <section ref={response} className="pb-memory-answer" aria-label="Memory answer" aria-live="polite"><p>{answer.answer}</p>{answer.changes.length ? <details><summary>Saved changes</summary><ul>{answer.changes.map((item, index) => <li key={`${item.memoryId}:${index}`}><strong>{item.kind}: </strong>{item.text}</li>)}</ul></details> : answer.memories.length ? <details><summary>Memories used</summary><ul>{answer.memories.map(memory => <li key={memory.id}>{memory.text}<SourceChips sources={memory.sources} onOpenThread={onOpenThread} /></li>)}</ul></details> : null}</section> : null}
    </div>
    <form className="pb-memory-composer" onSubmit={event => { event.preventDefault(); void send(); }} aria-busy={working}>
      <div className="pb-memory-prompts">{['What do you remember about me?', 'Remember: '].map(prompt => <button key={prompt} className="gi-text-btn" type="button" disabled={busy} onClick={() => { setMessage(prompt); composer.current?.focus({ preventScroll: true }); }}>{prompt === 'Remember: ' ? '+ Add a detail' : 'Ask about me'}</button>)}</div>
      <label className="sr-only" htmlFor="pb-memory-message">Ask or update memory</label>
      <div className="pb-memory-write"><textarea id="pb-memory-message" className="gi-field" ref={composer} rows={2} maxLength={10_000} placeholder="Ask, paste context, or update…" value={message} readOnly={working} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><button className="gi-btn" type="submit" disabled={busy || !message.trim()}>{working ? <><Orb size={14} tone="on-accent" />Thinking</> : 'Send'}</button></div>
      <p className="gi-muted">Pasted lasting details are saved. Questions stay private to this conversation.</p>
    </form>
  </div>;
}

function MemoryFact({ memory, busy, onEdit, onForget, onOpenThread }: Props & { memory: PersonalMemory; busy: boolean; onEdit: (text: string) => Promise<void>; onForget: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  useEffect(() => { setText(memory.text); setEditing(false); }, [memory]);
  const expired = memory.validUntil && Date.parse(memory.validUntil) <= Date.now();
  return <article className="pb-memory-fact">
    {editing ? <form onSubmit={event => { event.preventDefault(); if (text.trim().length >= 10) void onEdit(text.trim()); }}><label className="gi-kicker">Correct this fact<textarea className="gi-field" aria-label="Correct this fact" required minLength={10} maxLength={600} rows={3} value={text} onChange={event => setText(event.target.value)} /></label><div className="pb-memory-actions"><button className="gi-text-btn" type="submit" disabled={busy || text.trim().length < 10}>Save correction</button><button className="gi-text-btn" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div></form> : <p>{memory.text}</p>}
    <small className="gi-muted">{expired ? 'Expired · ' : ''}{memory.corrected ? 'Your wording' : 'From your mail'}{memory.subject ? ` · ${memory.subject.label}` : ''}</small>
    <details className="pb-memory-evidence"><summary>Sources &amp; freshness</summary><SourceChips sources={memory.sources} onOpenThread={onOpenThread} />{!memory.sources.length ? <p>Saved directly by you. No email source.</p> : null}<p>{memory.validUntil ? 'Useful until' : 'Last confirmed'} {new Date(memory.validUntil ?? memory.lastConfirmedAt).toLocaleDateString()}</p></details>
    {!editing ? <div className="pb-memory-actions"><button className="gi-text-btn" type="button" disabled={busy} onClick={() => setEditing(true)}>Edit</button><button className="gi-text-btn" type="button" disabled={busy} onClick={() => void onForget()}>Forget</button></div> : null}
  </article>;
}
