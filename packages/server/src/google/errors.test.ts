import { expect, it } from 'vitest';
import { googleNetworkError } from './errors.js';
it('classifies platform limits and timeouts without retaining exception content', () => {
  expect(googleNetworkError(new Error('Too many subrequests. PRIVATE_CANARY')).code).toBe('subrequest_limit');
  expect(googleNetworkError(new DOMException('PRIVATE_CANARY', 'TimeoutError')).code).toBe('timeout');
  const error = googleNetworkError(new Error('PRIVATE_CANARY'));
  expect(error.code).toBe('network');
  expect(JSON.stringify(error)).not.toContain('PRIVATE_CANARY');
  expect(error.message).not.toContain('PRIVATE_CANARY');
});
