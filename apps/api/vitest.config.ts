import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
        },
      },
      {
        // Repository tests against a real, disposable PostgreSQL (DATABASE_URL). They truncate and
        // reseed, so the script runs them one file at a time.
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
