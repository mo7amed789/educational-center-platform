import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

// User decision (WhatsApp, Nov 24 2026, "only their own branch"): a receptionist works inside their own branch only.
describe('receptionist is limited to their branch', () => {
  const app = buildApp();
  const own = 965001, sibling = 965002;
  let branchA = '', branchB = '';
  const cookies: Record<string, string> = {};
  beforeAll(async () => {
    const centerId = (await prisma.center.create({ data: { slug: 'recep-scope', name: 'Recep scope' } })).id;
    branchA = (await prisma.branch.create({ data: { centerId, name: 'Branch A' } })).id;
    branchB = (await prisma.branch.create({ data: { centerId, name: 'Branch B' } })).id;
    for (const [key, branchId] of [['recA', branchA], ['noBranch', null]] as const) {
      const user = await prisma.user.create({ data: { centerId, branchId, role: 'RECEPTIONIST', name: key, email: `${key}@recep.test`, passwordHash: 'unusable-test-only', centerMemberships: { create: { centerId, role: 'RECEPTIONIST' } } } });
      const token = `recep-session-${key}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[key] = `center_session=${token}`;
    }
    for (const [id, branchId] of [[own, branchA], [sibling, branchB]] as const) {
      await prisma.teacher.create({ data: { id, centerId, branchId, name: `T${id}`, subject: 'Math' } });
      await prisma.group.create({ data: { id, centerId, branchId, teacherId: id, grade: `G${id}`, days: 'Sunday', time: '10:00', price: 100 } });
      await prisma.student.create({ data: { id, centerId, branchId, name: `S${id}` } });
      await prisma.enrollment.create({ data: { studentId: id, groupId: id } });
    }
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  const call = (method: 'GET' | 'POST', url: string, who: string, payload?: object) => app.inject({ method, url, headers: { cookie: cookies[who] }, ...(payload ? { payload } : {}) });

  it('lists only students of the own branch and hides a sibling student', async () => {
    const list = await call('GET', '/api/students?pageSize=100', 'recA');
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((r: { id: number }) => r.id)).toEqual([own]);
    expect((await call('GET', `/api/students/${sibling}`, 'recA')).statusCode).toBe(404);
  });
  it('shows only own-branch groups and teachers in the overview', async () => {
    const res = await call('GET', '/api/center/overview', 'recA');
    expect(res.statusCode).toBe(200);
    expect(res.json().groups.map((g: { id: number }) => g.id)).toEqual([own]);
    expect(res.json().teachers.map((t: { id: number }) => t.id)).toEqual([own]);
  });
  it('shows only the own branch in the branch list', async () => {
    const res = await call('GET', '/api/center/branches', 'recA');
    expect(res.json().branches.map((b: { id: string }) => b.id)).toEqual([branchA]);
  });
  it('cannot record attendance for a sibling-branch student', async () => {
    const res = await call('POST', '/api/center/attendance', 'recA', { studentId: sibling, groupId: sibling, date: '2026-11-24', status: 'PRESENT' });
    expect(res.statusCode).toBe(422);
    expect(await prisma.attendance.count({ where: { studentId: sibling } })).toBe(0);
  });
  it('cannot scan a sibling-branch code, but can scan an own-branch code', async () => {
    const other = await call('POST', '/api/center/attendance/scan', 'recA', { code: `STUDENT:${sibling}` });
    expect([404, 422]).toContain(other.statusCode);
    expect(await prisma.attendance.count({ where: { studentId: sibling } })).toBe(0);
    const mine = await call('POST', '/api/center/attendance/scan', 'recA', { code: `STUDENT:${own}` });
    expect(mine.statusCode).toBe(200);
  });
  it('cannot open a sibling-branch student in the kiosk profile', async () => {
    expect((await call('GET', `/api/center/kiosk/students/${own}?month=2026-11`, 'recA')).statusCode).toBe(200);
    expect((await call('GET', `/api/center/kiosk/students/${sibling}?month=2026-11`, 'recA')).statusCode).toBe(404);
  });
  it('is denied everywhere when the account has no branch', async () => {
    const list = await call('GET', '/api/students?pageSize=100', 'noBranch');
    expect(list.statusCode === 403 || list.json().items.length === 0).toBe(true);
    const overview = await call('GET', '/api/center/overview', 'noBranch');
    expect(overview.statusCode === 403 || (overview.json().groups.length === 0 && overview.json().teachers.length === 0)).toBe(true);
    expect((await call('POST', '/api/center/attendance/scan', 'noBranch', { code: `STUDENT:${own}` })).statusCode).not.toBe(200);
  });
});
