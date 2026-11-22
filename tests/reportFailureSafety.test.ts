import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { assertLearningSchemaReady, SCHEMA_REPAIR_MESSAGE } from '../src/schemaReadiness.js';
import { readLearningReport } from '../src/learningReports.js';
import { prisma } from '../src/prisma.js';

const fakeReady = () => ({ exam: { findFirst: vi.fn().mockResolvedValue(null) }, gradeRecord: { findFirst: vi.fn().mockResolvedValue(null) }, gradeCorrection: { findFirst: vi.fn().mockResolvedValue(null) }, learnerNotification: { findFirst: vi.fn().mockResolvedValue(null) } });
type ReadyClient = Parameters<typeof assertLearningSchemaReady>[0];

// Run under Node's real unhandled-rejection behavior, outside Vitest's handlers.
const regression = `
import assert from 'node:assert/strict';
import { readLearningReport, readMonthlyLearningReport } from './src/learningReports.ts';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const monthly of [false, true]) {
  let calls = 0;
  const client = { attendance: { findMany: () => { calls++; return new Promise((_, reject) => setTimeout(() => reject(new Error('fixture transaction closed')), 10)); } }, enrollment: {findMany: async()=>[]}, lessonSession: {findMany: async()=>[]} };
  if (!monthly) client.gradeRecord = {findMany:async()=>[]};
  await assert.rejects(() => (monthly ? readMonthlyLearningReport : readLearningReport)(client,{id:1,name:'Pupil'},'center','2026-11','2026-11-22'),/fixture transaction closed/);
  await delay(30);
  assert.equal(calls,1);
}
let active=0,max=0;
const query = async () => { active++;max=Math.max(max,active);await delay(5);active--;return []; };
const client = Object.fromEntries(['attendance','gradeRecord','enrollment','lessonSession'].map(name=>[name,{findMany:query}]));
await assert.rejects(()=>readLearningReport(client,{id:1,name:'Pupil'},'center','2026-11','2026-11-22'),TypeError);
assert.equal(active,0);assert.equal(max,1);
await delay(30);
console.log('NO_ORPHANED_REPORT_QUERIES');
`;

describe('learning report failure containment', () => {
  afterAll(async () => { await prisma.$disconnect(); });
  it('does not leave nested or outer transaction promises unobserved on a synchronous delegate failure', () => {
    const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', regression], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '--unhandled-rejections=strict' }, timeout: 10000 });
    expect(result).toContain('NO_ORPHANED_REPORT_QUERIES');
  });
  it('returns 500 for a failed report and continues serving later requests', async () => {
    const app = Fastify({ logger: false });
    const badClient = { attendance: { findMany: async () => { throw new Error('fixture query failure'); } } };
    app.get('/api/portal/parent/learning-report', async () => readLearningReport(badClient as unknown as Parameters<typeof readLearningReport>[0], { id: 1, name: 'Pupil' }, 'center', '2026-11', '2026-11-22'));
    app.get('/healthz', async () => ({ ok: true }));
    try {
      expect((await app.inject('/api/portal/parent/learning-report')).statusCode).toBe(500);
      expect((await app.inject('/healthz')).json()).toEqual({ ok: true });
      expect((await app.inject('/api/portal/parent/learning-report')).statusCode).toBe(500);
      expect((await app.inject('/healthz')).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it('accepts the current generated client and actual schema without changing data', async () => {
    const before = await prisma.exam.count();
    await expect(assertLearningSchemaReady(prisma)).resolves.toBeUndefined();
    expect(await prisma.exam.count()).toBe(before);
  });
  it('accepts empty tables and waits for each read-only probe', async () => {
    const fake = fakeReady();
    await expect(assertLearningSchemaReady(fake as unknown as ReadyClient)).resolves.toBeUndefined();
    for (const delegate of Object.values(fake)) expect(delegate.findFirst).toHaveBeenCalledWith({ where: { id: '__schema_readiness_probe__' } });
    expect(fake.exam.findFirst.mock.invocationCallOrder[0]).toBeLessThan(fake.gradeRecord.findFirst.mock.invocationCallOrder[0]);
  });
  it.each(['exam', 'gradeRecord', 'gradeCorrection', 'learnerNotification'] as const)('fails before listening for a missing generated %s delegate', async name => {
    const fake = fakeReady();
    delete (fake as Partial<typeof fake>)[name];
    await expect(assertLearningSchemaReady(fake as unknown as ReadyClient)).rejects.toThrow(SCHEMA_REPAIR_MESSAGE);
    for (const delegate of Object.values(fake)) expect(delegate.findFirst).not.toHaveBeenCalled();
  });
  it.each(['P2021', 'P2022', 'PrismaClientValidationError'])('gives backup/generate/push guidance for %s', async failure => {
    const fake = fakeReady();
    fake.exam.findFirst.mockRejectedValue({ code: failure, name: failure });
    await expect(assertLearningSchemaReady(fake as unknown as ReadyClient)).rejects.toThrow(SCHEMA_REPAIR_MESSAGE);
    expect(fake.gradeRecord.findFirst).not.toHaveBeenCalled();
  });
  it.each(['P1001', 'P1010'])('does not suggest schema changes for a database access failure %s', async code => {
    const fake = fakeReady(); fake.exam.findFirst.mockRejectedValue({ code });
    await expect(assertLearningSchemaReady(fake as unknown as ReadyClient)).rejects.toThrow('STARTUP_DATABASE_UNAVAILABLE');
    await expect(assertLearningSchemaReady(fake as unknown as ReadyClient)).rejects.not.toThrow('db:push');
  });
  it('detects a missing column in a real empty SQLite table and exits cleanly before listening', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'center-schema-probe-'));
    const url = 'file:' + path.join(directory, 'old.db').replaceAll('\\', '/');
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      await client.$executeRawUnsafe('CREATE TABLE "Exam" ("id" TEXT PRIMARY KEY)');
      await expect(assertLearningSchemaReady(client)).rejects.toThrow(SCHEMA_REPAIR_MESSAGE);
      const columns = await client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Exam")');
      expect(columns.map(column => column.name)).toEqual(['id']);
      await client.$disconnect();
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: url, PORT: '3199' } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SCHEMA_UPDATE_REQUIRED');
      expect(result.stderr).toContain('npm run db:generate');
      expect(result.stderr).toContain('npm run db:push');
      expect(result.stderr).not.toMatch(/TypeError|Transaction already closed|passwordHash/);
      expect(result.stdout).not.toContain('Server listening');
    } finally { await client.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
  });
});
