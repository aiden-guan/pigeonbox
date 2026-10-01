import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', timeout: 45_000, expect: { timeout: 12_000 }, fullyParallel: false, workers: 1, retries: process.env.CI ? 1 : 0, reporter: [['list'], ['html', { open: 'never' }]], use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
