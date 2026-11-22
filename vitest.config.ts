import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test' },
    globalSetup: ['./tests/setup.ts'],
  },
});
