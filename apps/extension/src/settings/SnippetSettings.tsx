import { useEffect, useState } from 'react';
import { Field } from './SettingsComponents';

type Snippet = { id: string; name: string; body: string };

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Snippets: `;name` + Tab, or ⌘/Ctrl ; in a Gmail compose. Stored in this browser. */
export function SnippetSettings() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'GET_SNIPPETS' }, (res?: { snippets?: Snippet[] }) => {
      if (Array.isArray(res?.snippets)) setSnippets(res.snippets);
    });
  }, []);

  const edit = (id: string, patch: Partial<Snippet>) => {
    setSnippets((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setStatus(null);
  };

  const invalid = snippets.filter((item) => !NAME.test(item.name.trim().toLowerCase().replace(/^;/, '')) || !item.body.trim());
  const names = snippets.map((item) => item.name.trim().toLowerCase().replace(/^;/, ''));
  const duplicate = names.find((name, index) => name && names.indexOf(name) !== index);

  const save = () => {
    chrome.runtime.sendMessage({ type: 'SAVE_SNIPPETS', snippets }, (res?: { ok?: boolean; snippets?: Snippet[]; reason?: string }) => {
      if (res?.ok && res.snippets) {
        setSnippets(res.snippets);
        setStatus(`Saved ${res.snippets.length} snippet${res.snippets.length === 1 ? '' : 's'}.`);
      } else setStatus(res?.reason || 'Snippets could not be saved.');
    });
  };

  return (
    <div className="space-y-3">
      <p className="gi-muted text-xs">
        In a Gmail compose, type <code>;name</code> and press Tab, or press ⌘/Ctrl ; to pick one. Variables:{' '}
        <code>{'{first_name}'}</code> <code>{'{last_name}'}</code> <code>{'{name}'}</code> <code>{'{email}'}</code> <code>{'{my_name}'}</code> <code>{'{date}'}</code>.
      </p>
      {snippets.map((item) => (
        <div key={item.id} className="gi-card space-y-2">
          <Field label="Name (what you type after ;)">
            <input className="gi-field" value={item.name} placeholder="intro" onChange={(event) => edit(item.id, { name: event.target.value })} />
          </Field>
          <Field label="Text">
            <textarea className="gi-field min-h-[5rem]" value={item.body} placeholder="Hi {first_name}, …" onChange={(event) => edit(item.id, { body: event.target.value })} />
          </Field>
          <button type="button" className="gi-text-btn" onClick={() => { setSnippets((current) => current.filter((other) => other.id !== item.id)); setStatus(null); }}>
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="gi-btn gi-btn-ghost" onClick={() => setSnippets((current) => [...current, { id: crypto.randomUUID(), name: '', body: '' }])}>
          Add snippet
        </button>
        <button type="button" className="gi-btn" disabled={invalid.length > 0 || Boolean(duplicate)} onClick={save}>
          Save snippets
        </button>
      </div>
      {duplicate ? <p className="gi-danger text-xs">Two snippets are named “{duplicate}”.</p> : null}
      {!duplicate && invalid.length ? <p className="gi-muted text-xs">Each snippet needs a name (letters, numbers, - or _) and some text.</p> : null}
      {status ? <p className="gi-muted text-xs" role="status">{status}</p> : null}
    </div>
  );
}
