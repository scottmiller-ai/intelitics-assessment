import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/tests/**/*.unit.test.ts'],
          environment: 'node',
          env: { LOG_LEVEL: 'silent' },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/tests/**/*.integration.test.ts'],
          environment: 'node',
          hookTimeout: 120_000,
          testTimeout: 120_000,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
