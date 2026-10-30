import { createHash } from 'node:crypto';
import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';
export type { Page } from '@playwright/test';

// Each isolated browser represents a different client. Sharing the fixture
// server's "unknown" IP made unrelated sign-in tests exhaust one rate bucket.
// Production limits remain enabled, including repeated attempts in one test.
export const test = base.extend({
  extraHTTPHeaders: async ({}, use, info) => {
    const address = createHash('sha256').update(`${info.testId}:${info.retry}`).digest('hex').slice(0, 28).match(/.{4}/g)!.join(':');
    await use({ 'CF-Connecting-IP': `fd00:${address}` });
  },
});
