/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';

const emitted: unknown[] = [];
let onMessage: ((message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean) | null = null;
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    sendMessage: (message: unknown) => {
      emitted.push(message);
      return Promise.resolve();
    },
    onMessage: { addListener: (fn: typeof onMessage) => (onMessage = fn) },
  },
};

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  started = false;
  onaudiostart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
}
(window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;

const { installDictation } = await import('./dictation');

function send(message: Record<string, unknown>): unknown {
  let response: unknown;
  onMessage!(message, {}, (value) => (response = value));
  return response;
}

describe('Gmail-page dictation', () => {
  it('listens in the Gmail page and sends words back for the panel that asked', () => {
    installDictation();
    expect(send({ type: 'PB_DICTATION_START', session: 's1', lang: 'en-GB' })).toEqual({ ok: true });
    const recognition = FakeRecognition.last!;
    expect(recognition).toMatchObject({ started: true, lang: 'en-GB', continuous: true, interimResults: true });
    recognition.onaudiostart!();
    recognition.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'email jun' } }, { isFinal: false, 0: { transcript: ' about' } }] });
    send({ type: 'PB_DICTATION_STOP', session: 'other' });
    expect(emitted.at(-1)).toMatchObject({ event: 'text' });
    send({ type: 'PB_DICTATION_STOP', session: 's1' });
    expect(emitted).toEqual([
      { type: 'PB_DICTATION_EVENT', session: 's1', event: 'started' },
      { type: 'PB_DICTATION_EVENT', session: 's1', event: 'listening' },
      { type: 'PB_DICTATION_EVENT', session: 's1', event: 'text', final: 'email jun', interim: ' about' },
      { type: 'PB_DICTATION_EVENT', session: 's1', event: 'end' },
    ]);
  });

  it('reports why Chrome would not start, as an event rather than only a reply', () => {
    emitted.length = 0;
    const original = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = () => {
      throw Object.assign(new Error('nope'), { name: 'NotAllowedError' });
    };
    expect(send({ type: 'PB_DICTATION_START', session: 's2' })).toEqual({ ok: true });
    FakeRecognition.prototype.start = original;
    expect(emitted).toEqual([
      { type: 'PB_DICTATION_EVENT', session: 's2', event: 'error', error: 'start-failed:NotAllowedError' },
      { type: 'PB_DICTATION_EVENT', session: 's2', event: 'end' },
    ]);
  });
});
