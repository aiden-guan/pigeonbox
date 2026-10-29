import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      reporter: ['text', 'html'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'extension',
          include: [
            'packages/**/src/**/*.test.ts',
            'packages/**/tests/**/*.test.ts',
            'workers/**/src/**/*.test.ts',
            'apps/**/src/**/*.test.ts',
            'apps/**/src/**/*.test.tsx',
            'convex/**/*.test.ts',
          ],
          exclude: ['packages/server/**', '**/node_modules/**'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          include: ['packages/server/src/**/*.test.ts', 'scripts/server/**/*.test.mjs'],
          // Runs after the extension project, with its own worker count.
          sequence: { groupOrder: 1 },
          // Each worker hosts WASM Postgres. Reserve CI memory headroom for the
          // runner and migrated database snapshot; local runs can use four workers.
          maxWorkers: process.env.CI ? 2 : 4,
          restoreMocks: true,
          // Migrates the test database once per run; tests boot copies of it.
          globalSetup: ['packages/server/src/testing/global-setup.ts'],
          // Database-backed acceptance tests boot a WASM Postgres; allow for a loaded machine.
          testTimeout: 20_000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@pigeonbox/shared': path.resolve(__dirname, 'packages/shared/src'),
      '@pigeonbox/gmail': path.resolve(__dirname, 'packages/gmail/src'),
      '@pigeonbox/mailbox': path.resolve(__dirname, 'packages/mailbox/src'),
      '@pigeonbox/ai': path.resolve(__dirname, 'packages/ai/src'),
      '@pigeonbox/search': path.resolve(__dirname, 'packages/search/src'),
      '@pigeonbox/agent': path.resolve(__dirname, 'packages/agent/src'),
      '@pigeonbox/tracking': path.resolve(__dirname, 'packages/tracking/src'),
      '@pigeonbox/api-contract': path.resolve(__dirname, 'packages/api-contract/src'),
      '@pigeonbox/cloud-client': path.resolve(__dirname, 'packages/cloud-client/src'),
      '@pigeonbox/core': path.resolve(__dirname, 'packages/core/src'),
      '@pigeonbox/tracker': path.resolve(__dirname, 'workers/tracker/src'),
      '@pigeonbox/server': path.resolve(__dirname, 'packages/server/src'),
    },
  },
});
