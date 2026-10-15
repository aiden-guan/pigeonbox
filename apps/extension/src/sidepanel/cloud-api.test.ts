import type { AskPigeonResponse } from '@pigeonbox/api-contract';
import { ASK_STREAM_TIMEOUT_MS } from '@pigeonbox/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudAskStream } from './cloud-api';

function setup() {
  const listeners: Array<(value: unknown) => void> = [];
  const port = { postMessage: vi.fn(), disconnect: vi.fn(), onMessage: { addListener: (fn: (value: unknown) => void) => listeners.push(fn) }, onDisconnect: { addListener: vi.fn() } };
  vi.stubGlobal('chrome', { runtime: { connect: () => port } });
  return { port, send: (value: unknown) => listeners.forEach((fn) => fn(value)) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Chat transport lifetime', () => {
  it('keeps a quiet request alive past two minutes, then stops pinging on completion', async () => {
    vi.useFakeTimers();
    const { port, send } = setup();
    const settled = vi.fn();
    const result = cloudAskStream({ query: 'Research this' }, vi.fn()).then((value) => { settled(value); return value; });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(settled).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'keepalive' });
    send({ type: 'fallback', result: { ok: true, data: {} as AskPigeonResponse } });
    expect(await result).toMatchObject({ ok: true });
    expect(port.disconnect).toHaveBeenCalledOnce();
    const count = port.postMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ASK_STREAM_TIMEOUT_MS);
    expect(port.postMessage).toHaveBeenCalledTimes(count);
  });

  it('still bounds a stuck request and disconnects it', async () => {
    vi.useFakeTimers();
    const { port } = setup();
    const result = cloudAskStream({ query: 'Research this' }, vi.fn());
    await vi.advanceTimersByTimeAsync(ASK_STREAM_TIMEOUT_MS + 5_000);
    expect(await result).toMatchObject({ ok: false, code: 'timeout' });
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
