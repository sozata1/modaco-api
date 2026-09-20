import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The layering rule is enforced here, not requested in a README.
 * packages/core is pure domain: the moment an infrastructure dependency creeps in,
 * the pricing rules stop being the same code in the API and in the Lambda, which is
 * the one property the whole ingestion design rests on. See ADR-009.
 */
const INFRA_PACKAGES = [
  'pg', 'kysely', 'ioredis', 'redis', 'bullmq', 'express', 'pino',
  '@aws-sdk/*', '@modaco/db', 'prom-client', 'node:fs', 'node:net', 'node:http',
];

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      // A dedicated lint project (rather than projectService) so that test files and
      // config files — deliberately excluded from the build projects — are still
      // type-aware linted instead of silently skipped.
      parserOptions: { project: ['./tsconfig.lint.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: INFRA_PACKAGES,
          message:
            'packages/core is the pure domain layer and cannot import infrastructure. ' +
            'Take what you need as a parameter instead (see ADR-009).',
        }],
      }],
    },
  },
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', 'bench/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // supertest types `response.body` as `any`, so every assertion against a response
      // body trips the unsafe-access rules. Narrowed to test files only: production code
      // keeps the full strictness, and weakening it here costs nothing — an assertion
      // that reads the wrong field fails the test rather than shipping.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
]);
