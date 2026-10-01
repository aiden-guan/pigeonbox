import type { RouteName, RouteRequest, RouteResponse } from '@pigeonbox/api-contract';
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
