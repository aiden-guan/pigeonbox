/**
 * Voice input for Ask Pigeon, run in Gmail's own page. The Ask panel is an
 * extension frame, where Chrome cannot ask for the microphone; here Chrome
 * shows its normal prompt for mail.google.com once, and the choice sticks.
 * Chrome turns speech into text; no audio reaches PigeonBox.
 *
 * Start and stop arrive from the background (on behalf of the panel); words go
 * back to extension pages as PB_DICTATION_EVENT, tagged with the panel's
 * session so only the panel that asked uses them.
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

function start(session: string, lang: string): { ok: boolean; reason?: string } {
  const scope = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Speech = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Speech) return { ok: false, reason: 'unsupported' };
  active?.recognition.abort();
  const recognition = new Speech();
  recognition.lang = lang || navigator.language || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
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
  recognition.onerror = (event) => emit({ type: 'PB_DICTATION_EVENT', session, event: 'error', error: event.error });
  recognition.onend = () => {
    if (active?.recognition === recognition) active = null;
    emit({ type: 'PB_DICTATION_EVENT', session, event: 'end' });
  };
  active = { session, recognition };
  try {
    recognition.start();
    return { ok: true };
  } catch {
    active = null;
    return { ok: false, reason: 'start_failed' };
  }
}

export function installDictation(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PB_DICTATION_START' && typeof message.session === 'string') {
      sendResponse(start(message.session.slice(0, 64), typeof message.lang === 'string' ? message.lang.slice(0, 35) : ''));
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
