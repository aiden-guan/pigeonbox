/**
 * Streamed Ask Pigeon for extension pages. The side panel opens a port, sends
 * one request, and receives the Cloud's events (progress, answer text, the
 * final cited response) as they arrive. Closing the port cancels the request,
 * which stops the agent on the server. A Cloud without the streaming route
 * gets the one-shot `askPigeon` call instead.
 */
import type { AskPigeonResponse, RouteRequest } from '@pigeonbox/api-contract';
import { CloudApiError, cloudErrorMessage, type PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { isExtensionPageSender } from '../messaging';
import { ASK_STREAM_PORT, type AskStreamPortMessage } from './ask-stream-protocol';
import { pageCall } from './page-calls';

/** User-facing text for a failure, matching one-shot Cloud calls. */
function reason(code: string, message: string): string {
  return ['conflict', 'forbidden', 'invalid_request', 'not_found'].includes(code) ? message : cloudErrorMessage(new CloudApiError({ code: code as never, message })).message;
}

export function serveAskStream(port: chrome.runtime.Port, client: () => Promise<PigeonBoxCloudClient | null>): void {
  if (port.name !== ASK_STREAM_PORT) return;
  if (!port.sender || !isExtensionPageSender(port.sender)) {
    port.disconnect();
    return;
  }
  const cancel = new AbortController();
  let started = false;
  const post = (message: AskStreamPortMessage) => {
    if (cancel.signal.aborted) return;
    try {
      port.postMessage(message);
    } catch {
      cancel.abort();
    }
  };
  port.onDisconnect.addListener(() => cancel.abort());
  port.onMessage.addListener((message: { body?: unknown }) => {
    if (started) return;
    started = true;
    void (async () => {
      const cloud = await client();
      if (!cloud) return post({ type: 'failed', code: 'not_configured', reason: 'Turn on Cloud and sign in to use this.' });
      try {
        await cloud.stream(
          'askPigeonStream',
          message.body as RouteRequest<'askPigeonStream'>,
          (event) => post({ type: 'event', event: event.type === 'error' ? { ...event, message: reason(event.code, event.message) } : event }),
          { signal: cancel.signal, timeoutMs: 110_000 },
        );
      } catch (error) {
        if (cancel.signal.aborted) return;
        // An older Cloud without the streaming route answers in one piece.
        if (error instanceof CloudApiError && (error.code === 'not_found' || error.code === 'method_not_allowed' || error.status === 404 || error.status === 405)) {
          return post({ type: 'fallback', result: (await pageCall(cloud, 'askPigeon', message.body)) as { ok: true; data: AskPigeonResponse } | { ok: false; code: string; reason: string } });
        }
        const code = error instanceof CloudApiError ? error.code : 'network';
        post({ type: 'failed', code, reason: error instanceof CloudApiError ? reason(code, error.message) : cloudErrorMessage(error).message });
      }
    })();
  });
}
