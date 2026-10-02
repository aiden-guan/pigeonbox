import { DotField } from '../ui/DotField';
import { useDispatchLayout } from '../ui/dispatch-motion';
import { motionOptions, prefersReducedMotion } from '../ui/motion';
import { useEffect, useState } from 'react';
import type { SavedTask } from '@pigeonbox/api-contract';
import { callCloud } from '../sidepanel/cloud-api';
import { openThread } from './PigeonBoxWorkspace';
import type { WorkspaceContext } from './context';
export function Tasks({ enabled, context, suggestions = [], dueDates = {} }: { enabled: boolean; context: WorkspaceContext | null; suggestions?: string[]; dueDates?: Record<string, string> }) {
  const [tasks, setTasks] = useState<SavedTask[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const list = useDispatchLayout<HTMLUListElement>(tasks.map((task) => `${task.id}:${task.status}`).join('|'));
  const [savedSuggestions, setSavedSuggestions] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    if (enabled) void callCloud('tasks').then((result) => { if (active) { if (result.ok) setTasks(result.data.tasks); else setError(result.reason); } });
    return () => { active = false; };
  }, [enabled]);
  if (!enabled) return null;
  const save = async (text: string, source = false) => {
    if (busy || !text.trim()) return;
    setBusy(true); setError('');
    const result = await callCloud('taskCreate', { id: crypto.randomUUID(), title: text.trim(), ...(source && context ? { threadId: context.threadId, mailbox: context.owner?.email } : {}), ...(source && dueDates[text] ? { dueAt: dueDates[text] } : {}) });
    setBusy(false);
    if (result.ok) { setTasks(result.data.tasks); setTitle(''); setSavedSuggestions((current) => [...current, text]); }
    else setError(result.reason);
  };
  const complete = async (task: SavedTask, row: HTMLElement | null) => {
    if (busy || updating) return;
    const status = task.status === 'done' ? 'open' : 'done';
    setUpdating(task.id); setBusy(true); setError('');
    // Acknowledge immediately; remove the row only after persistence succeeds.
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status } : item));
    const result = await callCloud('taskUpdate', { id: task.id, status });
    if (result.ok) {
      if (status === 'done' && row && !document.hidden && !prefersReducedMotion() && typeof row.animate === 'function') {
        await row.animate([{ transform:'scale(1)', opacity:1 }, { transform:'scale(.99)', opacity:.45 }], motionOptions(row,'standard')).finished.catch(() => undefined);
      }
      setTasks(result.data.tasks); setNotice(status === 'done' ? 'Task complete.' : 'Task reopened.');
    } else { setTasks((current) => current.map((item) => item.id === task.id ? task : item)); setError(result.reason); }
    setUpdating(null); setBusy(false);
  };
  return <section className="pb-tasks" aria-label="Tasks"><details open={tasks.length > 0 || suggestions.length > 0}>
    <summary>Tasks</summary>
    {error ? <p className="gi-warn" role="alert">{error}</p> : null}
    <p className="pb-task-notice gi-muted" role="status">{notice ? <><DotField state="success" size={18} /> {notice}</> : null}</p>
    <ul ref={list}>{tasks.filter((task) => task.status === 'open' || task.id === updating).slice(0, 12).map((task) => <li key={task.id} data-motion-id={`task:${task.id}`} data-done={task.status === 'done'}>
      <input type="checkbox" aria-label={`Complete ${task.title}`} checked={task.status === 'done'} disabled={busy || Boolean(updating)} onChange={(event) => void complete(task, event.currentTarget.closest('li'))} /><span>{task.title}{task.dueAt ? <small>{new Date(task.dueAt).toLocaleDateString()}</small> : null}</span>
      {task.threadId ? <button type="button" className="gi-text-btn" aria-label={`Source email: ${task.title}`} onClick={() => void openThread(task.threadId!, 'inbox', task.accountId || undefined)}>↗</button> : null}
    </li>)}</ul>
    {tasks.some((task) => task.status === 'done') ? <details className="pb-completed-tasks" open={tasks.some((task) => task.status === 'done' && task.threadId === context?.threadId)}><summary>Completed</summary><ul>{tasks.filter((task) => task.status === 'done' && task.id !== updating).slice(0,6).map((task) => <li key={task.id} data-done="true"><input type="checkbox" checked aria-label={`Complete ${task.title}`} disabled={Boolean(updating)} onChange={(event) => void complete(task, event.currentTarget.closest('li'))} /><span>{task.title}</span></li>)}</ul></details> : null}
    {[...new Set(suggestions)].filter((text) => !savedSuggestions.includes(text) && !tasks.some((task) => task.title === text && task.threadId === context?.threadId)).slice(0, 3).map((text) => <div className="pb-task-suggestion" key={text}><small>Suggested · this thread</small><span>{text}</span><button className="gi-text-btn" type="button" disabled={busy} onClick={() => void save(text, true)}>Save task</button></div>)}
    <form onSubmit={(event) => { event.preventDefault(); void save(title, Boolean(context)); }}><input className="gi-field" value={title} maxLength={300} aria-label="New task" placeholder={context ? 'Add a task from this thread…' : 'Add a task…'} onChange={(event) => setTitle(event.target.value)} /><button type="submit" className="gi-text-btn" disabled={!title.trim() || busy}>Add</button></form>
  </details></section>;
}
