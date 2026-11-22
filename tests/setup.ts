import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Never reset DATABASE_URL from the caller. Each run gets a new disposable DB.
export default function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'center-platform-test-'));
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${path.join(directory, 'test.db').replaceAll('\\', '/')}`;
  const run = (file: string, args: string[]) => execFileSync(process.execPath, [file, ...args], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdio: 'pipe',
  });
  const cleanup = () => {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    run('node_modules/prisma/build/index.js', ['db', 'push', '--skip-generate']);
    run('node_modules/tsx/dist/cli.mjs', ['prisma/seed.ts']);
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}
