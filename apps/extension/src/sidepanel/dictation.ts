import { useCallback, useEffect, useRef, useState } from 'react';

/** "hello" + "world" → "hello world", without doubling spaces. */
export function joinSpeech(before: string, spoken: string): string {
  const text = spoken.trim();
  if (!text) return before;
  return before && !/\s$/.test(before) ? `${before} ${text}` : `${before}${text}`;
}

type DictationMessage = { type?: string; session?: string; event?: 'listening' | 'text' | 'error' | 'end'; final?: string; interim?: string; error?: string };

export type DictationState = 'idle' | 'starting' | 'listening';

const PROBLEMS: Record<string, string> = {
  'not-allowed': 'The microphone is blocked for Gmail. Click the microphone icon at the right of the address bar, choose Allow, then tap the mic again.',
  'service-not-allowed': 'The microphone is blocked for Gmail. Click the microphone icon at the right of the address bar, choose Allow, then tap the mic again.',
  'audio-capture': 'No microphone was found. Check that one is connected.',
  network: 'Voice input needs an internet connection.',
  'no-speech': "Didn't catch that. Tap the mic and try again.",
  unsupported: "This browser can't turn speech into text.",
  no_gmail: 'Open Gmail in this window to use voice input.',
};

/**
 * Dictation into the Ask box. Chrome's speech recognition runs in the Gmail
 * page (see content/dictation.ts), where Chrome can show its microphone prompt;
 * this hook starts and stops it and folds the words into the field as they
 * arrive. `onText` gets the field's full text, interim words included.
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const [problem, setProblem] = useState('');
  const [waitingForPermission, setWaitingForPermission] = useState(false);
  const session = useRef<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const textRef = useRef(onText);
  textRef.current = onText;

  const send = (action: 'start' | 'stop', id: string) =>
    new Promise<{ ok?: boolean; reason?: string }>((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'PB_DICTATION', action, session: id, lang: navigator.language }, (response?: { ok?: boolean; reason?: string }) => {
          resolve(chrome.runtime.lastError ? { ok: false, reason: 'no_gmail' } : (response ?? { ok: false, reason: 'no_gmail' }));
        });
      } catch {
        resolve({ ok: false, reason: 'no_gmail' });
      }
    });

  const stop = useCallback(() => {
    if (session.current) void send('stop', session.current);
  }, []);
  useEffect(() => () => {
    if (session.current) void send('stop', session.current);
    cleanup.current?.();
  }, []);

  const start = useCallback(async (current: string) => {
    if (session.current) return;
    const id = crypto.randomUUID();
    session.current = id;
    setProblem('');
    setState('starting');
    let committed = current;
    // Chrome's prompt can take a moment to answer; after a beat, say where it is.
    const hint = setTimeout(() => setWaitingForPermission(true), 1_200);
    const finish = () => {
      clearTimeout(hint);
      setWaitingForPermission(false);
      chrome.runtime.onMessage.removeListener(listener);
      cleanup.current = null;
      session.current = null;
      setState('idle');
    };
    const listener = (message: DictationMessage) => {
      if (message?.type !== 'PB_DICTATION_EVENT' || message.session !== id) return;
      if (message.event === 'listening') {
        clearTimeout(hint);
        setWaitingForPermission(false);
        setState('listening');
      } else if (message.event === 'text') {
        committed = joinSpeech(committed, message.final ?? '');
        textRef.current(joinSpeech(committed, message.interim ?? ''));
      } else if (message.event === 'error') {
        if (message.error !== 'aborted') setProblem(PROBLEMS[message.error ?? ''] ?? 'Voice input stopped. Tap the mic to try again.');
      } else if (message.event === 'end') {
        textRef.current(committed);
        finish();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    cleanup.current = finish;
    const started = await send('start', id);
    if (!started.ok) {
      setProblem(PROBLEMS[started.reason ?? ''] ?? 'Voice input could not start. Try again.');
      finish();
    }
  }, []);

  return { state, listening: state !== 'idle', waitingForPermission, problem, start, stop, clearProblem: () => setProblem('') };
}
