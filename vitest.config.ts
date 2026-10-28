import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'sim/test/**/*.test.ts', 'apps/server/test/**/*.test.ts'],
    testTimeout: 30_000,
    environment: 'node',
  },
});
