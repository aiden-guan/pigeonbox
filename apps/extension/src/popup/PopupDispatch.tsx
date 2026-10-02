import { DispatchCount } from '../ui/DispatchCount';
import { useEffect, useState } from 'react';
import { DispatchThreads, type DispatchThread } from '../ui/DispatchThreads';
import { useDispatchLayout } from '../ui/dispatch-motion';

const CATEGORIES = [['RESPOND', 'Respond'], ['WAITING', 'Waiting'], ['FYI', 'FYI'], ['FOLLOW_UPS', 'Follow-ups']] as const;
export function PopupDispatch(props: { indexedThreads: number | null; onPanel: (category: string) => void; onAsk: (question: string) => void }) {
  const [category, setCategory] = useState<string>('RESPOND');
  const [data, setData] = useState<Record<string, DispatchThread[]>>({});
  const [loading, setLoading] = useState(false);
  const rail = useDispatchLayout<HTMLElement>(category);
  useEffect(() => {
    let mounted = true;
    if (!props.indexedThreads) { setData({}); return; }
    setLoading(true);
    let remaining = CATEGORIES.length;
    CATEGORIES.forEach(([id]) => {
      chrome.runtime.sendMessage({ type: 'LIST_SPLIT', category: id }, (result?: { threads?: DispatchThread[] }) => {
        if (!mounted) return;
        if (!chrome.runtime.lastError && result?.threads) setData((current) => ({ ...current, [id]: result.threads! }));
        remaining--;
        if (!remaining) setLoading(false);
      });
    });
    return () => { mounted = false; };
  }, [props.indexedThreads]);
  return <section className="pb-dispatch" aria-label="Inbox dispatch">
    <nav className="pb-dispatch-categories" aria-label="Inbox categories" ref={rail}>{CATEGORIES.map(([id, label]) =>
      <button type="button" key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>
        {category === id ? <span className="pb-category-indicator" data-motion-id="category-indicator" aria-hidden="true" /> : null}
        <span>{label}</span>{data[id] ? <strong><DispatchCount value={data[id].length} /></strong> : null}
      </button>)}</nav>
    {data[category]?.length ? <DispatchThreads compact category={category} threads={data[category].slice(0, 2)} onOpen={(id) => { void chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}` }); }} onAsk={props.onAsk} /> :
      <p className="pb-dispatch-empty" role="status">{loading ? 'Reading inbox categories…' : props.indexedThreads === 0 ? 'Open Gmail to build your index.' : data[category] ? 'No threads in this category.' : 'Open inbox intelligence to see your mail.'}</p>}
    <button type="button" className="pb-dispatch-open" onClick={() => props.onPanel(category)}>Open inbox intelligence <span aria-hidden="true">↗</span></button>
  </section>;
}
