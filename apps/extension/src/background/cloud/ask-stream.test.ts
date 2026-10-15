import { ASK_STREAM_TIMEOUT_MS } from '@pigeonbox/api-contract';
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { describe, expect, it, vi } from 'vitest';
import { serveAskStream } from './ask-stream';
import { ASK_STREAM_PORT } from './ask-stream-protocol';

vi.mock('../messaging', () => ({ isExtensionPageSender: () => true }));

function setup(stream: PigeonBoxCloudClient['stream']) {
  const messages: Array<(message: { body?: unknown }) => void> = [];
  const disconnects: Array<() => void> = [];
  const postMessage = vi.fn();
  const port = { name: ASK_STREAM_PORT, sender: {}, postMessage, disconnect: vi.fn(), onMessage: { addListener: (fn: typeof messages[number]) => messages.push(fn) }, onDisconnect: { addListener: (fn: () => void) => disconnects.push(fn) } };
  serveAskStream(port as unknown as chrome.runtime.Port, async () => ({ stream } as PigeonBoxCloudClient));
  return { postMessage, send: () => messages.forEach((fn) => fn({ body: { query: 'Find my emails' } })), disconnect: () => disconnects.forEach((fn) => fn()) };
}

describe('background Chat stream', () => {
  it('fails promptly when a stream ends without its final answer', async () => {
    const stream = vi.fn(async () => undefined);
    const port = setup(stream as PigeonBoxCloudClient['stream']);
    port.send();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'failed', code: 'network' })));
    expect(stream.mock.calls).toHaveLength(1);
  });

  it('keeps one request and cancels it when the panel disconnects', async () => {
    let signal: AbortSignal | undefined;
    const stream = vi.fn(async (_name, _body, _emit, options) => {
      expect(options.timeoutMs).toBe(ASK_STREAM_TIMEOUT_MS);
      signal = options.signal;
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
    });
    const port = setup(stream as PigeonBoxCloudClient['stream']);
    port.send();
    await vi.waitFor(() => expect(signal).toBeDefined());
    port.send();
    expect(stream).toHaveBeenCalledOnce();
    port.disconnect();
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});
