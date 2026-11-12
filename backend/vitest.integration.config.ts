import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60000,
  },
});
