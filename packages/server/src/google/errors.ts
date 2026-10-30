/**
 * Google API failures as codes. Response bodies are discarded: Gmail error
 * bodies can quote request content.
 */
export type GoogleErrorCode =
  | 'auth_revoked'
  | 'unauthorized'
  | 'insufficient_permission'
  | 'not_found'
  | 'history_expired'
  | 'rate_limited'
  | 'unavailable'
  | 'bad_request'
  | 'conflict'
  | 'network'
  | 'subrequest_limit'
  | 'timeout'
  | 'invalid_response';

export class GoogleApiError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`google_${code}`);
    this.name = 'GoogleApiError';
  }

  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'unavailable' || this.code === 'network' || this.code === 'subrequest_limit' || this.code === 'timeout';
  }
}

/** Recognize platform failures without recording an exception's potentially sensitive text. */
export function googleNetworkError(error: unknown): GoogleApiError {
  if (error instanceof Error && /too many subrequests/i.test(error.message)) return new GoogleApiError('subrequest_limit', 0);
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return new GoogleApiError('timeout', 0);
  return new GoogleApiError('network', 0);
}

export async function googleErrorFrom(response: Response): Promise<GoogleApiError> {
  let reason = '';
  let error = '';
  try {
    const body = (await response.json()) as { error?: string | { status?: string; errors?: Array<{ reason?: string }> } };
    if (typeof body.error === 'string') error = body.error;
    else {
      reason = body.error?.errors?.[0]?.reason ?? '';
      error = body.error?.status ?? '';
    }
  } catch {
    /* Body is not JSON; the status is enough. */
  }
  const retryAfter = Number(response.headers.get('Retry-After'));
  const after = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  if (error === 'invalid_grant' || error === 'unauthorized_client') return new GoogleApiError('auth_revoked', response.status);
  if (response.status === 401) return new GoogleApiError('unauthorized', 401);
  if (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason)) {
    return new GoogleApiError('rate_limited', 403, after ?? 60);
  }
  if (response.status === 403) return new GoogleApiError('insufficient_permission', 403);
  if (response.status === 404) return new GoogleApiError('not_found', 404);
  if (response.status === 409) return new GoogleApiError('conflict', 409);
  if (response.status === 429) return new GoogleApiError('rate_limited', 429, after ?? 30);
  if (response.status >= 500) return new GoogleApiError('unavailable', response.status, after ?? 30);
  if (response.status === 400 && error === 'invalid_grant') return new GoogleApiError('auth_revoked', 400);
  return new GoogleApiError('bad_request', response.status);
}
