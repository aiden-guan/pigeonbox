import type { AskPigeonResponse, AskStreamEvent, RouteName, RouteRequest, RouteResponse } from '@pigeonbox/api-contract';
import { ASK_STREAM_PORT, type AskStreamPortMessage } from '../background/cloud/ask-stream-protocol';
export type CallResult<T> = { ok: true; data: T } | { ok: false; code: string; reason: string };

/** No tokens in UI. Both directions are schema validated by the worker's client. */
export function callCloud<N extends RouteName>(route: N, body?: RouteRequest<N>): Promise<CallResult<RouteResponse<N>>> {
  return cloudCall<RouteResponse<N>>(route, body);
}
export function cloudCall<T>(route: string, body?: unknown): Promise<CallResult<T>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: CallResult<T>) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout', reason: 'Cloud did not respond in time. Try again.' }), 65_000);
    try {
      chrome.runtime.sendMessage({ type: 'CLOUD_CALL', route, body }, (response?: CallResult<T>) => {
        finish(chrome.runtime.lastError ? { ok: false, code: 'network', reason: 'Reconnect PigeonBox and try again.' } : response ?? { ok: false, code: 'network', reason: 'PigeonBox did not respond. Try again.' });
      });
    } catch { finish({ ok: false, code: 'network', reason: 'Reconnect PigeonBox and try again.' }); }
  });
}

/**
 * Ask Pigeon, streamed through the background: `onEvent` gets progress and
 * answer text as they arrive; the promise settles with the final response.
 * Settling (or the panel closing) closes the port, which cancels the request.
 */
export function cloudAskStream(body: RouteRequest<'askPigeonStream'>, onEvent: (event: Exclude<AskStreamEvent, { type: 'done' | 'error' }>) => void): Promise<CallResult<AskPigeonResponse>> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port | null = null;
    let done = false;
    const finish = (result: CallResult<AskPigeonResponse>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout', reason: 'Cloud did not respond in time. Try again.' }), 120_000);
    try {
      port = chrome.runtime.connect({ name: ASK_STREAM_PORT });
    } catch {
      return finish({ ok: false, code: 'network', reason: 'Reconnect PigeonBox and try again.' });
    }
    port.onDisconnect.addListener(() => finish({ ok: false, code: 'network', reason: 'PigeonBox did not respond. Try again.' }));
    port.onMessage.addListener((message: AskStreamPortMessage) => {
      if (message.type === 'fallback') return finish(message.result);
      if (message.type === 'failed') return finish({ ok: false, code: message.code, reason: message.reason });
      const event = message.event;
      if (event.type === 'done') finish({ ok: true, data: event.response });
      else if (event.type === 'error') finish({ ok: false, code: event.code, reason: event.message });
      else onEvent(event);
    });
    port.postMessage({ body });
  });
}
