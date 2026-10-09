import { test, expect } from './fixtures';

test('Cloud workspace omits the standalone Memory tab and management panel', async ({ app }) => {
  const page = await app.page('workspace', true);
  await expect(page.getByRole('button', { name: 'Memory', exact: true })).toHaveCount(0);
  await expect(page.locator('.pb-memory-host')).toHaveCount(0);
});

test('Local workspace keeps Cloud memory behind the capability boundary', async ({ app }) => {
  const page = await app.page('workspace');
  await expect(page.getByRole('button', { name: 'Memory', exact: true })).toHaveCount(0);
  expect(app.api.calls.some(call => call.route.startsWith('/v1/memory/'))).toBe(false);
});
