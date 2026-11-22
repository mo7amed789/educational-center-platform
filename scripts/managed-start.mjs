import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createUpdater, sqlitePath, updateInterval } from './update-core.mjs';

const exec = promisify(execFile), root = process.cwd();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Start with npm run start:managed');
if (process.env.NODE_ENV === 'production') throw new Error('Managed updates are for a single-process local SQLite installation, not production.');
const database = sqlitePath(root, process.env.DATABASE_URL);
const directory = path.resolve(root, (await exec('git', ['rev-parse', '--git-path', 'educational-center-updater'], { cwd: root })).stdout.trim());
await mkdir(directory, { recursive: true });
const lockPath = path.join(directory, 'launcher.lock'), statePath = path.join(directory, 'status.json');
try {
  const previous = JSON.parse(await readFile(lockPath, 'utf8'));
  try { process.kill(previous.pid, 0); throw new Error('Another managed launcher is already running.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; await rm(lockPath); }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
let child, instanceId, updating, quitting = false, state = { enabled: process.env.AUTO_UPDATE_ENABLED === 'true', state: 'starting' };
const interval = updateInterval(process.env.AUTO_UPDATE_INTERVAL_MINUTES);
async function status(patch) {
  state = { ...state, ...patch };
  await writeFile(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
  await rename(statePath + '.tmp', statePath);
  console.log('[update]', state.state, state.failureStage || '');
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('APP_STOP_TIMEOUT')), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function start() {
  instanceId = randomUUID();
  child = spawn(process.execPath, ['dist/src/server.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, DATABASE_URL: 'file:' + database, EDU_MANAGED_STATE: statePath, EDU_INSTANCE_ID: instanceId } });
  child.on('error', error => console.error('[app]', error.message));
}
async function health() {
  const host = ['0.0.0.0', '::'].includes(process.env.HOST) ? '127.0.0.1' : (process.env.HOST || '127.0.0.1');
  const url = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + (process.env.PORT || '3000') + '/readyz';
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('APP_EXITED');
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); const data = await response.json(); if (response.ok && data.database === 'ready' && data.instanceId === instanceId) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('APP_READINESS_TIMEOUT');
}
async function command(file, args) {
  const result = await exec(file, args, { cwd: root, env: { ...process.env, DATABASE_URL: 'file:' + database, CI: 'true' }, timeout: 600000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return result.stdout;
}
const git = args => command('git', args), npm = args => command(process.execPath, [npmCli, ...args]);
async function backup() {
  const filename = path.join(directory, 'backup-' + Date.now() + '-' + randomUUID() + '.db');
  const client = new PrismaClient({ datasources: { db: { url: 'file:' + database } } });
  try { await client.$executeRaw`VACUUM INTO ${filename}`; } finally { await client.$disconnect(); }
  return filename;
}
async function restore(filename) {
  // The managed app is stopped and the backup connection is closed before restoring.
  await rm(database + '-wal', { force: true }); await rm(database + '-shm', { force: true });
  await copyFile(filename, database + '.restore'); await rename(database + '.restore', database);
}
const check = createUpdater({ git, npm, start, stop, health, backup, restore, status });
async function shutdown() {
  if (quitting) return; quitting = true;
  if (updating) await updating.catch(() => {});
  await stop().catch(() => {}); await rm(lockPath, { force: true }); process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
try {
  await status({ currentCommit: (await git(['rev-parse', 'HEAD'])).trim() });
  await start(); await health();
  if (!state.enabled) await status({ state: 'disabled' });
  else await status({ state: 'waiting' });
  while (!quitting) {
    if (state.enabled) { updating = check(); const result = await updating; updating = null; if (['rolled_back', 'manual_recovery'].includes(result.state)) state.enabled = false; }
    await status({ nextCheckAt: state.enabled ? new Date(Date.now() + interval).toISOString() : null });
    await new Promise(resolve => setTimeout(resolve, interval));
  }
} catch (error) {
  console.error('[launcher]', error.message);
  await status({ state: 'manual_recovery', enabled: false, message: 'LAUNCHER_STOPPED' }).catch(() => {});
  await stop().catch(() => {}); await rm(lockPath, { force: true }); process.exitCode = 1;
    }
