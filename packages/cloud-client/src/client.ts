import {
  AUTHORIZE_PATH,
  CLIENT_HEADER,
  ErrorBodySchema,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  REQUEST_ID_HEADER,
  ROUTES,
  DocumentResponseSchema,
  documentUploadPath,
  isKnownErrorCode,
  type CloudErrorCode,
  type RouteName,
  type RouteRequest,
  type RouteResponse,
} from '@pigeonbox/api-contract';

/**
 * A Cloud failure. `code` is one of the contract's error codes, or a client-side
 * code: `network` (unreachable), `timeout`, `invalid_response`, `not_configured`
 * (no API URL in this build), `signed_out`.
 */
export class CloudApiError extends Error {
  readonly code: CloudErrorCode | 'network' | 'timeout' | 'aborted' | 'invalid_response' | 'signed_out';
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly retryAfter?: number;

  constructor(opts: {
    code: CloudApiError['code'];
    message: string;
    status?: number;
    retryable?: boolean;
    requestId?: string;
    retryAfter?: number;
  }) {
    super(opts.message);
    this.name = 'CloudApiError';
    this.code = opts.code;
    this.status = opts.status ?? 0;
    this.retryable = opts.retryable ?? false;
    this.requestId = opts.requestId;
    this.retryAfter = opts.retryAfter;
  }
}

export type AccessTokenProvider = {
  /** Current access token, or null when signed out. May refresh proactively. */
  get(): Promise<string | null>;
  /** Called once after a 401 to force a refresh. Returns the new token or null. */
  refresh(): Promise<string | null>;
};

export type CloudClientOptions = {
  baseUrl: string;
  tokens?: AccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** e.g. `extension/0.2.0`. */
  clientName?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export type CallOptions = { signal?: AbortSignal; timeoutMs?: number };

/** Abort when either signal aborts. Uses AbortSignal.any where available. */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (any) return any([a, b]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    // Plain HTTP is only acceptable for a Cloud server on this machine (development).
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return null;
  }
}

export class PigeonBoxCloudClient {
  readonly baseUrl: string;
  private readonly tokens?: AccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clientName: string;

  constructor(options: CloudClientOptions) {
    const base = normalizeBaseUrl(options.baseUrl);
    if (!base) {
      throw new CloudApiError({ code: 'not_configured', message: 'PigeonBox Cloud is not configured in this build.' });
    }
    this.baseUrl = base;
    this.tokens = options.tokens;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientName = options.clientName ?? 'unknown';
  }

  /** URL to open in a browser auth window. Not fetched by the client. */
  authorizeUrl(params: { redirectUri: string; codeChallenge: string; state: string }): string {
    const url = new URL(`${this.baseUrl}${AUTHORIZE_PATH}`);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', params.state);
    return url.toString();
  }

  health() {
    return this.call('health');
  }
  version() {
    return this.call('version');
  }
  exchangeCode(body: RouteRequest<'authToken'>) {
    return this.call('authToken', body);
  }
  refreshSession(body: RouteRequest<'authRefresh'>) {
    return this.call('authRefresh', body);
  }
  signOut(body: RouteRequest<'authSignOut'>) {
    return this.call('authSignOut', body);
  }
  me() {
    return this.call('me');
  }
  capabilities() {
    return this.call('capabilities');
  }
  entitlements() {
    return this.call('entitlements');
  }
  billingCheckout() {
    return this.call('billingCheckout', {});
  }
  billingPortal() {
    return this.call('billingPortal', {});
  }

  listMemories(body: RouteRequest<'memoryList'>) { return this.call('memoryList', body); }
  getMemory(body: RouteRequest<'memoryGet'>) { return this.call('memoryGet', body); }
  forgetMemory(body: RouteRequest<'memoryForget'>) { return this.call('memoryForget', body); }
  correctMemory(body: RouteRequest<'memoryUpdate'>) { return this.call('memoryUpdate', body); }
  purgeMemories(body: RouteRequest<'memoryPurge'>) { return this.call('memoryPurge', body); }
  /**
   * Real-time Pidgy check of one short clause of an unsent draft. Callers decide
   * first that the user turned the preference on; the route is validated both ways.
   */
  composeCheck(body: RouteRequest<'composeCheck'>, options: CallOptions = {}) { return this.call('composeCheck', body, options); }

  /** Upload only to the issuing Cloud origin, with the same refresh and privacy policy as JSON calls. */
  async uploadDocument(id: string, bytes: Uint8Array<ArrayBuffer>, options: CallOptions = {}) {
    const path = documentUploadPath(id);
    if (!bytes.length || bytes.length > 20_000_000 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      throw new CloudApiError({ code: 'invalid_request', message: 'Choose a PDF up to 20 MB.' });
    }
    const send = async (token: string) => {
      try {
        return await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), [CLIENT_HEADER]: this.clientName },
          body: bytes, signal: combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 60_000)), credentials: 'omit', redirect: 'error',
        });
      } catch {
        throw new CloudApiError({ code: 'network', message: 'Could not upload the PDF. Try again.', retryable: true });
      }
    };
    const token = await this.tokens?.get();
    if (!token) throw new CloudApiError({ code: 'signed_out', message: 'Sign in to PigeonBox Cloud first.' });
    let response = await send(token);
    if (response.status === 401) {
      const next = await this.tokens?.refresh();
      if (!next) throw new CloudApiError({ code: 'signed_out', message: 'Sign in to PigeonBox Cloud again.' });
      response = await send(next);
    }
    return this.readResponse(response, DocumentResponseSchema) as Promise<import('@pigeonbox/api-contract').RouteResponse<'documentCreate'>>;
  }

  /**
   * Typed call for any contract route. Request and response are validated.
   * `signal` cancels the request (e.g. when a Gmail thread closes); `timeoutMs`
   * overrides the client default for latency-sensitive UI calls.
   */
  async call<N extends RouteName>(name: N, body?: RouteRequest<N>, options: CallOptions = {}): Promise<RouteResponse<N>> {
    const route = ROUTES[name];
    let payload: unknown;
    if ('request' in route) {
      const parsed = route.request.safeParse(body ?? {});
      if (!parsed.success) {
        throw new CloudApiError({ code: 'invalid_request', status: 400, message: 'The request did not match the PigeonBox Cloud contract.' });
      }
      payload = parsed.data;
    }

    let token: string | null = null;
    if (route.auth === 'user') {
      token = (await this.tokens?.get()) ?? null;
      if (!token) throw new CloudApiError({ code: 'signed_out', status: 401, message: 'Sign in to PigeonBox Cloud first.' });
    }

    let response = await this.send(route.method, route.path, payload, token, options);
    if (response.status === 401 && route.auth === 'user' && this.tokens) {
      const refreshed = await this.tokens.refresh();
      if (!refreshed) throw new CloudApiError({ code: 'signed_out', status: 401, message: 'Your PigeonBox Cloud session ended. Sign in again.' });
      response = await this.send(route.method, route.path, payload, refreshed, options);
    }
    return this.readResponse(response, route.response) as Promise<RouteResponse<N>>;
  }

  /**
   * Streaming call for routes marked `stream: 'ndjson'`: each line of the
   * response is validated against the route's event schema and handed to
   * `onEvent` as it arrives. Resolves when the stream ends. Errors before the
   * stream starts throw like `call()`; a malformed event throws `invalid_response`.
   */
  async stream<N extends RouteName>(name: N, body: RouteRequest<N>, onEvent: (event: RouteResponse<N>) => void, options: CallOptions = {}): Promise<void> {
    const route = ROUTES[name] as (typeof ROUTES)[RouteName] & { stream?: 'ndjson' };
    if (route.stream !== 'ndjson') throw new CloudApiError({ code: 'invalid_request', message: 'That PigeonBox Cloud route does not stream.' });
    const parsed = 'request' in route ? route.request.safeParse(body ?? {}) : null;
    if (parsed && !parsed.success) throw new CloudApiError({ code: 'invalid_request', status: 400, message: 'The request did not match the PigeonBox Cloud contract.' });
    const payload = parsed?.data;
    let token = (await this.tokens?.get()) ?? null;
    if (route.auth === 'user' && !token) throw new CloudApiError({ code: 'signed_out', status: 401, message: 'Sign in to PigeonBox Cloud first.' });
    const streamOptions = { ...options, accept: 'application/x-ndjson' };
    let response = await this.send(route.method, route.path, payload, token, streamOptions);
    if (response.status === 401 && route.auth === 'user' && this.tokens) {
      token = await this.tokens.refresh();
      if (!token) throw new CloudApiError({ code: 'signed_out', status: 401, message: 'Your PigeonBox Cloud session ended. Sign in again.' });
      response = await this.send(route.method, route.path, payload, token, streamOptions);
    }
    if (!response.ok || !response.body) {
      await this.readResponse(response, route.response);
      throw new CloudApiError({ code: 'invalid_response', status: response.status, message: 'PigeonBox Cloud did not stream a response.' });
    }
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const emit = (line: string) => {
      if (!line.trim()) return;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        json = null;
      }
      const event = route.response.safeParse(json);
      if (!event.success) throw new CloudApiError({ code: 'invalid_response', requestId, message: 'PigeonBox Cloud sent a response this version of PigeonBox does not understand.' });
      onEvent(event.data as RouteResponse<N>);
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          emit(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      emit(buffer);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof CloudApiError) throw error;
      if (options.signal?.aborted) throw new CloudApiError({ code: 'aborted', retryable: false, message: 'The request was cancelled.' });
      throw new CloudApiError({ code: 'network', retryable: true, requestId, message: 'The connection to PigeonBox Cloud dropped.' });
    }
  }

  private async send(method: string, path: string, payload: unknown, token: string | null, options: CallOptions & { accept?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/json',
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      [CLIENT_HEADER]: this.clientName,
    };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs)),
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (options.signal?.aborted) {
        throw new CloudApiError({ code: 'aborted', retryable: false, message: 'The request was cancelled.' });
      }
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new CloudApiError({ code: 'timeout', retryable: true, message: 'PigeonBox Cloud did not respond in time.' });
      }
      throw new CloudApiError({ code: 'network', retryable: true, message: 'Could not reach PigeonBox Cloud.' });
    }
  }

  private async readResponse(response: Response, schema: (typeof ROUTES)[RouteName]['response']): Promise<unknown> {
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      if (parsed.success) {
        const { code, message, retryable, retryAfter } = parsed.data.error;
        throw new CloudApiError({
          code: isKnownErrorCode(code) ? code : 'internal',
          status: response.status,
          message,
          retryable,
          requestId: parsed.data.error.requestId ?? requestId,
          retryAfter,
        });
      }
      throw new CloudApiError({
        code: response.status >= 500 ? 'internal' : 'invalid_response',
        status: response.status,
        retryable: response.status >= 500,
        requestId,
        message: `PigeonBox Cloud returned HTTP ${response.status}.`,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new CloudApiError({ code: 'invalid_response', status: response.status, requestId, message: 'PigeonBox Cloud sent a response this version of PigeonBox does not understand.' });
    }
    return parsed.data;
  }
}
