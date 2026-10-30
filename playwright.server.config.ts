import { defineConfig, devices } from '@playwright/test';

// Browser tests for the server dashboard (apps/web/public) against the loopback
// fixture server (scripts/server/browser-server.ts): the real API router over
// PGlite and a fake Google. The extension's own browser tests use playwright.config.ts;
// results live beside these specs (gitignored) because that run clears ./test-results.
const origin = `http://127.0.0.1:${process.env.PIGEONBOX_BROWSER_PORT ?? 8790}`;

export default defineConfig({
  testDir: './tests/server',
  outputDir: './tests/server/test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: './tests/server/playwright-report' }]],
  use: { baseURL: origin, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run assets -w @pigeonbox/api-worker && npx tsx scripts/server/browser-server.ts',
    url: `${origin}/__fixture/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
