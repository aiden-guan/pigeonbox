import { CloudApiError } from './client.js';

export type CloudErrorAction = 'sign_in' | 'subscribe' | 'retry' | 'switch_to_local' | 'update_extension' | null;

/**
 * User-facing wording for a Cloud failure. Every message states that nothing was
 * sent elsewhere, because Cloud mode never falls back to another provider.
 */
export function cloudErrorMessage(error: unknown): { message: string; action: CloudErrorAction } {
  if (!(error instanceof CloudApiError)) {
    return { message: 'PigeonBox Cloud failed. Nothing was sent to another provider.', action: 'switch_to_local' };
  }
  switch (error.code) {
    case 'signed_out':
    case 'unauthenticated':
    case 'invalid_token':
      return { message: 'Sign in to PigeonBox Cloud, or switch to running on this computer.', action: 'sign_in' };
    case 'entitlement_required':
      return { message: 'Your PigeonBox Cloud subscription is not active. Local mode still works.', action: 'subscribe' };
    case 'quota_exceeded':
      return { message: 'You reached your PigeonBox Cloud limit for now. Local mode still works.', action: 'switch_to_local' };
    case 'rate_limited':
    case 'provider_rate_limited':
      return { message: 'PigeonBox Cloud is busy. Try again in a moment.', action: 'retry' };
    case 'aborted':
      return { message: 'Cancelled.', action: null };
    case 'unsupported_protocol':
    case 'invalid_response':
      return { message: 'This version of PigeonBox is out of date for PigeonBox Cloud. Update the extension.', action: 'update_extension' };
    case 'not_configured':
      return { message: 'PigeonBox Cloud is not available in this build. PigeonBox runs on this computer.', action: 'switch_to_local' };
    case 'network':
    case 'timeout':
    case 'provider_timeout':
    case 'provider_unavailable':
    case 'provider_error':
    case 'internal':
      return { message: 'PigeonBox Cloud is unavailable. Nothing was sent to another provider.', action: 'switch_to_local' };
    default:
      return { message: error.message || 'PigeonBox Cloud failed.', action: 'switch_to_local' };
  }
}
