import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These integration suites share one SQLite database and snapshot global rows.
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
    globalSetup: ['./tests/setup.ts'],
  },
});
