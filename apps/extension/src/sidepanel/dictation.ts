import { useCallback, useEffect, useRef, useState } from 'react';

/** The parts of Chrome's Web Speech API used here. */
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionClass(): (new () => Recognition) | null {
  const scope = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** "hello" + "world" → "hello world", without doubling spaces. */
export function joinSpeech(before: string, spoken: string): string {
  const text = spoken.trim();
  if (!text) return before;
  return before && !/\s$/.test(before) ? `${before} ${text}` : `${before}${text}`;
}

/**
 * Dictation into a text field with Chrome's speech recognition. `onText`
 * gets the field's full text as words arrive (interim words included), so
 * the user sees what they are saying. Audio is handled by Chrome, not stored.
 */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState('');
  const recognition = useRef<Recognition | null>(null);
  const textRef = useRef(onText);
  textRef.current = onText;
  const supported = recognitionClass() !== null;

  const stop = useCallback(() => recognition.current?.stop(), []);
  useEffect(() => () => recognition.current?.abort(), []);

  const start = useCallback((current: string) => {
    const Speech = recognitionClass();
    if (!Speech || recognition.current) return;
    setProblem('');
    const session = new Speech();
    session.lang = navigator.language || 'en-US';
    session.continuous = true;
    session.interimResults = true;
    let committed = current;
    session.onresult = (event) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        if (result.isFinal) committed = joinSpeech(committed, result[0].transcript);
        else interim += result[0].transcript;
      }
      textRef.current(joinSpeech(committed, interim));
    };
    session.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setProblem('Allow the microphone in the tab that just opened, then tap the mic again.');
        void chrome.tabs?.create?.({ url: chrome.runtime.getURL('microphone.html') });
      } else if (event.error === 'audio-capture') setProblem('No microphone was found.');
      else if (event.error === 'network') setProblem('Voice input needs an internet connection.');
      else if (event.error !== 'no-speech' && event.error !== 'aborted') setProblem('Voice input stopped. Try again.');
    };
    session.onend = () => {
      recognition.current = null;
      setListening(false);
      textRef.current(committed);
    };
    recognition.current = session;
    try {
      session.start();
      setListening(true);
    } catch {
      recognition.current = null;
      setProblem('Voice input could not start. Try again.');
    }
  }, []);

  return { supported, listening, problem, start, stop };
}
