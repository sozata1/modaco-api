import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * Load `.env` explicitly. Every host port in this project is remapped there because the
 * defaults were taken, so a test that trusts the defaults connects to nothing — which is
 * exactly how this suite first failed, with ECONNREFUSED against LocalStack on 4566 while
 * it was listening on 54566.
 */
const dotenv: Record<string, string> = {};
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) dotenv[match[1]] = match[2] ?? '';
  }
}

/**
 * End-to-end tests run against a live `docker compose` stack, so they are a separate
 * command rather than part of `npm test`. Two reasons: they should not fail for someone
 * who has not started the system, and running them alongside the Testcontainers suites
 * puts both under resource contention — which once produced three "failing" files and
 * thirty skipped tests that had nothing to do with the code.
 */
export default defineConfig({
  test: {
    env: dotenv,
    include: ['apps/**/test/**/*.e2e.test.ts'],
    testTimeout: 200_000,
    hookTimeout: 200_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
