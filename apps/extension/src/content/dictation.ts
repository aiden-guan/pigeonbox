/**
 * Voice input for Ask Pigeon, run in Gmail's own page. The Ask panel is an
 * extension frame, where Chrome cannot ask for the microphone; here Chrome
 * shows its normal prompt for mail.google.com once, and the choice sticks.
 * Chrome turns speech into text; no audio reaches PigeonBox.
 *
 * Start and stop arrive from the background (on behalf of the panel). Everything
 * that happens, including whether it started, goes back to extension pages as
 * PB_DICTATION_EVENT tagged with the panel's session: other listeners on this
 * page may answer the start message first, so its reply is not relied on.
 */

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onaudiostart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export type DictationEvent =
  | { type: 'PB_DICTATION_EVENT'; session: string; event: 'started' }
  | { type: 'PB_DICTATION_EVENT'; session: string; event: 'listening' }
  | { type: 'PB_DICTATION_EVENT'; session: string; event: 'text'; final: string; interim: string }
  | { type: 'PB_DICTATION_EVENT'; session: string; event: 'error'; error: string }
  | { type: 'PB_DICTATION_EVENT'; session: string; event: 'end' };

let active: { session: string; recognition: Recognition } | null = null;

function emit(event: DictationEvent): void {
  try {
    void chrome.runtime.sendMessage(event).catch(() => undefined);
  } catch {
    // The extension was reloaded; this page's script is orphaned.
  }
}

function start(session: string, lang: string): void {
  const fail = (error: string) => emit({ type: 'PB_DICTATION_EVENT', session, event: 'error', error });
  const scope = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Speech = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Speech) {
    fail('unsupported');
    emit({ type: 'PB_DICTATION_EVENT', session, event: 'end' });
    return;
  }
  active?.recognition.abort();
  let recognition: Recognition;
  try {
    recognition = new Speech();
    recognition.lang = lang || navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
  } catch (error) {
    fail(`start-failed:${error instanceof Error ? error.name : 'Error'}`);
    emit({ type: 'PB_DICTATION_EVENT', session, event: 'end' });
    return;
  }
  recognition.onaudiostart = () => emit({ type: 'PB_DICTATION_EVENT', session, event: 'listening' });
  recognition.onresult = (event) => {
    let final = '';
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]!;
      if (result.isFinal) final += result[0].transcript;
      else interim += result[0].transcript;
    }
    emit({ type: 'PB_DICTATION_EVENT', session, event: 'text', final, interim });
  };
  recognition.onerror = (event) => fail(event.error);
  recognition.onend = () => {
    if (active?.recognition === recognition) active = null;
    emit({ type: 'PB_DICTATION_EVENT', session, event: 'end' });
  };
  active = { session, recognition };
  try {
    recognition.start();
    emit({ type: 'PB_DICTATION_EVENT', session, event: 'started' });
  } catch (error) {
    active = null;
    console.warn('[PigeonBox] voice input could not start', error);
    fail(`start-failed:${error instanceof Error ? error.name : 'Error'}`);
    emit({ type: 'PB_DICTATION_EVENT', session, event: 'end' });
  }
}

let installed = false;

export function installDictation(): void {
  if (installed) return;
  installed = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PB_DICTATION_START' && typeof message.session === 'string') {
      start(message.session.slice(0, 64), typeof message.lang === 'string' ? message.lang.slice(0, 35) : '');
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'PB_DICTATION_STOP') {
      if (active && (!message.session || active.session === message.session)) active.recognition.stop();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}
