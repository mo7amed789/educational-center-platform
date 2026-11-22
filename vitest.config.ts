import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration files share one SQLite fixture database.
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
    globalSetup: ['./tests/setup.ts'],
  },
});
