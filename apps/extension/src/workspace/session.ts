import { useCallback, useEffect, useRef, useState } from 'react';

// Unfinished user input belongs to the trusted extension session, never Gmail storage.
// Browser-session lifetime and scope prevent durable mail/AI-result caches in presentation state.
let writes: Promise<unknown> = Promise.resolve();
const pending = new Map<string, unknown>();
const PREFIX = 'workspaceInput:';
export async function flushWorkspaceInput() { await writes; }
export function useWorkspaceInput<T>(scope: string, initial: T) {
  const key = `${PREFIX}${scope}`;
  const initialRef = useRef(initial);
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    setLoaded(false);
    setValue((pending.get(key) as T | undefined) ?? initialRef.current);
    let active = true;
    void chrome.storage.session.get(key).then((stored) => {
      if (!active) return;
      const row = stored[key] as { value: T; at: number } | undefined;
      if (pending.has(key)) setValue(pending.get(key) as T);
      else if (row && Date.now() - row.at < 24 * 60 * 60 * 1000) setValue(row.value);
      setLoaded(true);
    });
    return () => { active = false; };
  }, [key]);
  const update = useCallback((next: T) => {
    setValue(next);
    pending.set(keyRef.current, next);
    const savedKey = keyRef.current;
    writes = writes.catch(() => undefined).then(() => chrome.storage.session.set({ [savedKey]: { value: next, at: Date.now() } }));
  }, []);
  return [value, update, loaded] as const;
}
