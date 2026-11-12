import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['tests/setup.ts'],
  },
});
