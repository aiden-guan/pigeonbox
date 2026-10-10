import { useEffect, useRef, useState } from 'react';
import type { PersonalMemory, Preferences } from '@pigeonbox/api-contract';
import { callCloud } from '../sidepanel/cloud-api';
import { Field, Toggle } from './SettingsComponents';

/** Cloud owns persistence. This view never writes memories to local storage. */
export function MemorySettings() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [memories, setMemories] = useState<PersonalMemory[]>([]);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [correction, setCorrection] = useState('');
  const [purging, setPurging] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const revision = useRef(0);
  async function load(next?: string) {
    const current = ++revision.current;
    setBusy(true);
    setError('');
    const result = await callCloud('memoryList', { query: query.trim() || undefined, cursor: next, limit: 20 });
    if (revision.current !== current) return;
    setBusy(false);
    if (result.ok) {
      setMemories((items) => (next ? [...items, ...result.data.memories] : result.data.memories));
      setCursor(result.data.nextCursor);
    } else setError(result.reason);
  }
  useEffect(() => {
    let alive = true;
    void callCloud('preferences').then((result) => {
      if (!alive) return;
      if (result.ok) setPrefs(result.data.preferences);
      else setError(result.reason);
    });
    setBusy(true);
    void callCloud('memoryList', { limit: 20 }).then((result) => {
      if (!alive) return;
      setBusy(false);
      if (result.ok) {
        setMemories(result.data.memories);
        setCursor(result.data.nextCursor);
      } else setError(result.reason);
    });
    return () => {
      alive = false;
      revision.current += 1;
    };
    // Search is explicit; typing does not send compose/search text to Cloud.
  }, []);
  async function settings(patch: Partial<Preferences['memory']>) {
    setBusy(true);
    setError('');
    setNotice('');
    const result = await callCloud('preferencesUpdate', { preferences: { memory: patch } });
    setBusy(false);
    if (result.ok) {
      setPrefs(result.data.preferences);
      setNotice('Memory preferences saved.');
    } else setError(result.reason);
  }
  async function forget(id: string) {
    setBusy(true);
    setError('');
    const result = await callCloud('memoryForget', { memoryId: id });
    setBusy(false);
    if (result.ok) {
      setMemories((items) => items.filter((item) => item.id !== id));
      setNotice('Memory forgotten. The original email is unchanged.');
    } else setError(result.reason);
  }
  async function saveCorrection(id: string) {
    setBusy(true);
    setError('');
    const result = await callCloud('memoryUpdate', { memoryId: id, text: correction });
    setBusy(false);
    if (result.ok) {
      setMemories((items) => items.map((item) => (item.id === id ? result.data.memory : item)));
      setEditing(null);
      setNotice('Correction saved.');
    } else setError(result.reason);
  }
  async function purge() {
    setBusy(true);
    setError('');
    const result = await callCloud('memoryPurge', { confirm: 'forget all memories' });
    setBusy(false);
    if (result.ok) {
      revision.current += 1;
      setMemories([]);
      setCursor(null);
      setPurging(false);
      setConfirmation('');
      setNotice('All personal memories forgotten. Learning resumes with future mail.');
    } else setError(result.reason);
  }
  return (
    <div className="space-y-3" aria-busy={busy}>
      <p className="gi-muted text-xs">
        Useful facts from your communication, encrypted in Cloud. Saved memories support drafts and can be wrong. Original email stays in Gmail.
      </p>
      {prefs ? (
        <fieldset disabled={busy} className="space-y-3">
          <legend className="sr-only">Memory learning</legend>
          <Toggle label="Learn useful personal context" checked={prefs.memory.enabled} onChange={(enabled) => void settings({ enabled })} />
          <p className="gi-muted text-xs">Turning learning off keeps saved facts available. Use Forget all to erase them.</p>
          <Toggle
            label="Learn facts from received mail"
            checked={prefs.memory.learnFromReceivedMail}
            onChange={(learnFromReceivedMail) => void settings({ learnFromReceivedMail })}
          />
          <Toggle
            label="Learn facts and writing structure from sent mail"
            checked={prefs.memory.learnFromSentMail}
            onChange={(learnFromSentMail) => void settings({ learnFromSentMail })}
          />
          <Toggle
            label="Learn writing structure from my draft edits"
            checked={prefs.memory.learnFromDraftEdits}
            onChange={(learnFromDraftEdits) => void settings({ learnFromDraftEdits })}
          />
          <Toggle
            label="Smart suggestions"
            description="Offers concise wording edits and relevant reminders from your calendar and memory as you write. Only the current phrase is processed; it is never saved."
            checked={prefs.memory.realtimeComposeChecks}
            onChange={(realtimeComposeChecks) => void settings({ realtimeComposeChecks })}
          />
          <Toggle
            label="Smart autofill"
            description="Finishes everyday requests and adds sourced details from your memory and conversation as you type. Tab accepts; Escape dismisses. Only the current phrase is processed, never saved."
            checked={prefs.memory.smartComposeCompletion}
            onChange={(smartComposeCompletion) => void settings({ smartComposeCompletion })}
          />
          <p className="gi-muted text-xs">Press Ctrl/⌘ + Shift + Space in a draft to check the current phrase again.</p>
          <p className="gi-muted text-xs">
            Fast Recall is {prefs.fastRecall.enabled ? 'on' : 'off'}. Its optional encrypted mail excerpts are managed separately in Privacy &amp; data.
          </p>
        </fieldset>
      ) : (
        <p className="gi-muted text-xs">Loading memory preferences…</p>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <input
          className="gi-field"
          aria-label="Search memories"
          placeholder="Search a person, class or project"
          maxLength={500}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="gi-btn gi-btn-ghost" disabled={busy} type="submit">
          Search
        </button>
      </form>
      {error ? (
        <p className="gi-warn text-xs" role="alert">
          {error}{' '}
          <button type="button" className="gi-text-btn" disabled={busy} onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="gi-muted text-xs" role="status">
          {notice}
        </p>
      ) : null}
      {!busy && !error && !memories.length ? (
        <p className="gi-muted text-sm">No memories yet. Useful facts appear here as connected mail is analyzed.</p>
      ) : null}
      <ul className="space-y-3" aria-label="Personal memories">
        {memories.map((memory) => (
          <li key={memory.id} className="gi-surface p-3 rounded-lg">
            <p className="gi-kicker">
              {memory.category}
              {memory.corrected ? ' · Corrected by you' : ''}
              {memory.validUntil && Date.parse(memory.validUntil) <= Date.now() ? ' · Expired' : ''}
            </p>
            {editing === memory.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveCorrection(memory.id);
                }}
              >
                <Field label="Correct remembered fact">
                  <textarea
                    className="gi-field"
                    required
                    minLength={10}
                    maxLength={600}
                    value={correction}
                    onChange={(event) => setCorrection(event.target.value)}
                  />
                </Field>
                <div className="flex gap-3 mt-2">
                  <button className="gi-text-btn" disabled={busy} type="submit">
                    Save correction
                  </button>
                  <button className="gi-text-btn" type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <p className="text-sm mt-2">{memory.text}</p>
            )}
            <details className="text-xs gi-muted mt-2">
              <summary>Source{memory.sources.length === 1 ? '' : 's'} and freshness</summary>
              {memory.sources.map((source) => (
                <p key={source.id} className="mt-2">
                  From “{source.title}”{source.at ? ` · ${new Date(source.at).toLocaleDateString()}` : ''}
                </p>
              ))}
              {!memory.sources.length ? <p>Saved correction; the original account is disconnected.</p> : null}
              {memory.validUntil ? (
                <p>Useful until {new Date(memory.validUntil).toLocaleDateString()}.</p>
              ) : (
                <p>Last confirmed {new Date(memory.lastConfirmedAt).toLocaleDateString()}.</p>
              )}
            </details>
            <div className="flex gap-3 mt-2">
              <button
                className="gi-text-btn"
                disabled={busy}
                type="button"
                onClick={() => {
                  setEditing(memory.id);
                  setCorrection(memory.text);
                }}
              >
                Correct
              </button>
              <button className="gi-text-btn" disabled={busy} type="button" onClick={() => void forget(memory.id)}>
                Forget
              </button>
            </div>
          </li>
        ))}
      </ul>
      {cursor ? (
        <button className="gi-text-btn" type="button" disabled={busy} onClick={() => void load(cursor)}>
          Load more
        </button>
      ) : null}
      {purging ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void purge();
          }}
        >
          <p className="text-xs">
            Erase all personal facts and their search data. Contacts, writing profiles and Fast Recall are managed separately. Gmail and your account stay
            connected.
          </p>
          <Field label="Type forget all memories">
            <input className="gi-field" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </Field>
          <button className="gi-btn gi-btn-ghost" disabled={busy || confirmation !== 'forget all memories'} type="submit">
            Forget all memories
          </button>{' '}
          <button className="gi-text-btn" type="button" onClick={() => setPurging(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="gi-text-btn" disabled={busy} type="button" onClick={() => setPurging(true)}>
          Forget all memories…
        </button>
      )}
    </div>
  );
}
