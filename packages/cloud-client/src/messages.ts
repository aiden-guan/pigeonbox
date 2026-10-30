import { CloudApiError } from './client.js';

export type CloudErrorAction = 'sign_in' | 'retry' | 'switch_to_local' | 'update_extension' | null;

/**
 * User-facing wording for a PigeonBox server failure. Every message states that
 * nothing was sent elsewhere, because server mode never falls back to another provider.
 */
export function cloudErrorMessage(error: unknown): { message: string; action: CloudErrorAction } {
  if (!(error instanceof CloudApiError)) {
    return { message: 'Your PigeonBox server failed. Nothing was sent to another provider.', action: 'switch_to_local' };
  }
  switch (error.code) {
    case 'signed_out':
    case 'unauthenticated':
    case 'invalid_token':
      return { message: 'Sign in to your PigeonBox server, or switch to running on this computer.', action: 'sign_in' };
    case 'entitlement_required':
      return { message: 'Your PigeonBox server does not offer this for your account. PigeonBox still works on this computer.', action: 'switch_to_local' };
    case 'quota_exceeded':
      return { message: 'You reached the limit your PigeonBox server sets for now. PigeonBox still works on this computer.', action: 'switch_to_local' };
    case 'rate_limited':
    case 'provider_rate_limited':
      return { message: 'Your PigeonBox server is busy. Try again in a moment.', action: 'retry' };
    case 'aborted':
      return { message: 'Cancelled.', action: null };
    case 'unsupported_protocol':
    case 'invalid_response':
      return { message: 'This version of PigeonBox does not match your PigeonBox server. Update the extension or the server.', action: 'update_extension' };
    case 'not_configured':
      return { message: 'No PigeonBox server is configured. Add one in Settings → Advanced.', action: 'switch_to_local' };
    case 'network':
    case 'timeout':
    case 'provider_timeout':
    case 'provider_unavailable':
    case 'provider_error':
    case 'internal':
      return { message: 'Your PigeonBox server is unavailable. Nothing was sent to another provider.', action: 'switch_to_local' };
    default:
      return { message: error.message || 'Your PigeonBox server failed.', action: 'switch_to_local' };
  }
}
