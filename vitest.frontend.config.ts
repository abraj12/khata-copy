import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['frontend/tests/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    poolOptions: {
      threads: {
        maxThreads: 4,
        minThreads: 1,
      },
    },
  },
});
