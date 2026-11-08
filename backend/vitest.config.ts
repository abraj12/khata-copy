import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 15000,
  },
});
