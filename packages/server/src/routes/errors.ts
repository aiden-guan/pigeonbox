import { InferenceError } from '../ai/backends.js';
import { StoreError } from '@pigeonbox/tracker';
import { GoogleApiError } from '../google/errors.js';
import { ApiError } from '../http.js';
import { BudgetExceededError } from '../intel/ai.js';
import { ConnectionUnavailableError } from '../intel/google-access.js';
import { CryptoError } from '../platform/crypto.js';

/**
 * Known failures → contract errors with messages users can act on. Anything
 * else becomes a generic `internal` error; details stay in structured logs as
 * codes only.
 */
export function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof BudgetExceededError) {
    return error.scope === 'global'
      ? new ApiError('provider_unavailable', 'This PigeonBox server reached its daily AI capacity. Try again later.', { retryAfter: 3_600 })
      : new ApiError('quota_exceeded', 'You reached this PigeonBox server’s AI limit for now.');
  }
  if (error instanceof InferenceError) return new ApiError(error.code, error.message);
  if (error instanceof ConnectionUnavailableError) {
    switch (error.code) {
      case 'needs_reauth':
        return new ApiError('conflict', 'PigeonBox lost access to this Google account. Reconnect it in your PigeonBox server’s dashboard.');
      case 'paused':
        return new ApiError('conflict', 'Syncing is paused for this Google account.');
      case 'missing_feature':
        return new ApiError('forbidden', 'This Google connection does not include that permission. Add it in your PigeonBox server’s dashboard.');
      default:
        return new ApiError('conflict', 'Connect a Google account to your PigeonBox server first.');
    }
  }
  if (error instanceof GoogleApiError) {
    if (error.retryable) return new ApiError('provider_unavailable', 'Google did not respond. Try again in a moment.', { retryAfter: error.retryAfterSeconds });
    if (error.code === 'auth_revoked' || error.code === 'unauthorized') return new ApiError('conflict', 'PigeonBox lost access to this Google account. Reconnect it.');
    if (error.code === 'insufficient_permission') return new ApiError('forbidden', 'This Google connection does not include that permission.');
    if (error.code === 'not_found') return new ApiError('not_found', 'Google could not find that item.');
    return new ApiError('provider_error', 'Google rejected the request.');
  }
  if (error instanceof CryptoError) return new ApiError('internal', 'A stored value could not be read. Contact support.');
  if (error instanceof StoreError) return new ApiError('internal', 'Storage failed. Try again.');
  return null;
}
