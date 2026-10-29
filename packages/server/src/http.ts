import { ERROR_STATUS, REQUEST_ID_HEADER, errorBody, type CloudErrorCode } from '@pigeonbox/api-contract';
import type { z } from 'zod';

/** A failure with a contract error code. Messages are shown to users; keep them free of email content. */
export class ApiError extends Error {
  constructor(
    readonly code: CloudErrorCode,
    message: string,
    readonly extra?: { retryAfter?: number; minimumVersion?: string },
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(data: unknown, status = 200, requestId?: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {}),
      ...headers,
    },
  });
}

/** A stream of newline-delimited JSON events, for routes marked `stream: 'ndjson'`. */
export function ndjsonResponse(body: ReadableStream<Uint8Array>, requestId: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}

export function errorResponse(error: ApiError, requestId: string): Response {
  const headers: Record<string, string> = {};
  if (error.extra?.retryAfter !== undefined) headers['Retry-After'] = String(error.extra.retryAfter);
  return json(errorBody(error.code, error.message, { requestId, retryAfter: error.extra?.retryAfter, minimumVersion: error.extra?.minimumVersion }), ERROR_STATUS[error.code], requestId, headers);
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, '')}`;
}

const MAX_BODY_BYTES = 1_000_000;

/** Read and validate a JSON body with a size cap. The body is never logged. */
export async function readJson<S extends z.ZodTypeAny>(request: Request, schema: S, maxBytes = MAX_BODY_BYTES): Promise<z.infer<S>> {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > maxBytes) throw new ApiError('payload_too_large', 'The request is too large.');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new ApiError('payload_too_large', 'The request is too large.');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('invalid_request', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Paths only; values could contain email content.
    const where = parsed.error.issues.slice(0, 3).map((issue) => issue.path.join('.') || '(body)').join(', ');
    throw new ApiError('invalid_request', `The request did not match the contract at: ${where}.`);
  }
  return parsed.data;
}

/**
 * CORS for browser callers. Only the configured web origins and PigeonBox
 * extension origins get CORS headers; there is no wildcard. CORS is a browser
 * convenience, not auth: every protected route still requires a valid token.
 */
export function corsHeaders(request: Request, allowed: { webOrigins: string[]; extensionIds: string[] }): Record<string, string> | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const extension = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
  const ok = allowed.webOrigins.includes(origin) || Boolean(extension && allowed.extensionIds.includes(extension[1]!));
  if (!ok) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-pigeonbox-protocol, x-pigeonbox-client, x-pigeonbox-attribution',
    'Access-Control-Expose-Headers': 'x-request-id, Retry-After',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function withHeaders(response: Response, headers: Record<string, string> | null): Response {
  if (!headers) return response;
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) next.headers.set(key, value);
  return next;
}

/**
 * Structured operational log. Only metadata: never request or response bodies,
 * email text, prompts, tokens or provider error bodies.
 *
 * The allowed keys are fixed, and every value is checked at runtime: strings
 * must look like identifiers, codes or route shapes. Anything else is replaced
 * with "[redacted]", so a mistake at a call site cannot put mail content into
 * logs (see `logging.test.ts`).
 */
export type LogFields = {
  requestId?: string;
  route?: string;
  status?: number;
  latencyMs?: number;
  lagMs?: number;
  attempts?: number;
  /** Chat/compose phase durations and counters; no draft or source content. */
  loadMs?: number;
  primeMs?: number;
  modelMs?: number;
  toolsMs?: number;
  firstDeltaMs?: number;
  memoHits?: number;
  retrievalMs?: number;
  preflightMs?: number;
  inferenceMs?: number;
  validationMs?: number;
  userId?: string;
  code?: string;
  operation?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens the provider served from its prompt cache. */
  cachedTokens?: number;
  /** AI reasoning effort sent (none, low, ...). */
  reasoningEffort?: string;
  /** Processing tier requested (standard or flex). */
  serviceTier?: string;
  /** Processing tier the provider reported using. */
  actualServiceTier?: string;
  /** Estimated cost of the call in micro-dollars. */
  costMicros?: number;
  /** Model rounds in an agent run. */
  rounds?: number;
  event?: string;
  /** Provider error identifiers (type/code/param), never message text. */
  detail?: string;
  jobId?: string;
  jobKind?: string;
  accountId?: string;
  attempt?: number;
  count?: number;
  tier?: number;
  decision?: string;
  capability?: string;
  candidate?: string;
  retrievalCount?: number;
  semantic?: boolean;
  modelInvoked?: boolean;
  completionRequested?: boolean;
  completionCount?: number;
  completionProposed?: boolean;
  completionValidated?: boolean;
  retryInSeconds?: number;
  /** Compose notice category shown (or held back), never its text. */
  noticeKind?: string;
  confidenceBucket?: string;
  latencyBucket?: string;
  /** Fixed outcome code (e.g. answered, insufficient_evidence). */
  outcome?: string;
  /** Numbered sources an answer actually cited. */
  cited?: number;
  coverageComplete?: boolean;
};

/** `error` is never logged; only the error tracker reads its class name and stack frame locations. */
export type Logger = (level: 'info' | 'warn' | 'error', message: string, fields?: LogFields, error?: unknown) => void;

const LOG_KEYS: ReadonlySet<string> = new Set([
  'noticeKind', 'confidenceBucket', 'latencyBucket', 'outcome', 'cited', 'coverageComplete',
  'candidate', 'retrievalCount', 'semantic', 'modelInvoked', 'completionRequested', 'completionCount', 'completionProposed', 'completionValidated',
  'requestId', 'route', 'status', 'latencyMs', 'lagMs', 'attempts', 'loadMs', 'primeMs', 'modelMs', 'toolsMs', 'firstDeltaMs', 'memoHits', 'retrievalMs', 'preflightMs', 'inferenceMs', 'validationMs', 'userId', 'code', 'operation', 'provider', 'model', 'inputTokens',
  'outputTokens', 'cachedTokens', 'reasoningEffort', 'serviceTier', 'actualServiceTier', 'costMicros', 'rounds', 'event', 'detail', 'jobId', 'jobKind', 'accountId', 'attempt', 'count', 'tier', 'decision', 'capability', 'retryInSeconds',
]);

/** Identifiers, model names and IDs: no spaces, no @, bounded. */
const SAFE_STRING = /^[A-Za-z0-9_.:/+-]{0,160}$/;
/** `METHOD /path` or a path. */
const SAFE_ROUTE = /^(?:[A-Z]{3,7} )?\/[A-Za-z0-9_/:.-]{0,200}$/;
/** Error codes and operator-facing configuration problems (env var names and rules, never user data). */
const SAFE_CODE = /^[A-Za-z0-9_.:=,;/ -]{0,300}$/;
const SAFE_MESSAGE = /^[A-Za-z0-9_.:,()/' -]{1,120}$/;

export function sanitizeLogFields(fields: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (!LOG_KEYS.has(key) || value === undefined || value === null) continue;
    if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : 0;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') {
      const pattern = key === 'route' ? SAFE_ROUTE : key === 'code' ? SAFE_CODE : SAFE_STRING;
      out[key] = pattern.test(value) ? value : '[redacted]';
    }
    else out[key] = '[redacted]';
  }
  return out;
}

/** Log messages are fixed operator text; anything else is replaced. */
export function safeLogMessage(message: string): string {
  return SAFE_MESSAGE.test(message) ? message : '[redacted message]';
}

export const consoleLogger: Logger = (level, message, fields) => {
  const safeMessage = safeLogMessage(message);
  const line = JSON.stringify({ level, message: safeMessage, ...sanitizeLogFields(fields), time: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
