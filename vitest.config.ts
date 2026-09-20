import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    // End-to-end tests need a running stack and have their own config.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // Containers are expensive; a single fork keeps startup cost to one container per
    // file rather than one per worker.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
