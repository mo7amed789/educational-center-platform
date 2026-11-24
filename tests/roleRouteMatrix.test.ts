import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Role } from '@prisma/client';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

// Denial-only matrix: for each route, roles that must be refused with 403.
// Cells that are intentionally allowed, or still need an owner decision
// (RECEPTIONIST branch scope, ACCOUNTANT export breadth, branch list for every role),
// are not asserted here. Roles tested: RECEPTIONIST, ACCOUNTANT, TEACHER, STUDENT, GUARDIAN.
type R = 'RECEPTIONIST' | 'ACCOUNTANT' | 'TEACHER' | 'STUDENT' | 'GUARDIAN';
const ALL: R[] = ['RECEPTIONIST', 'ACCOUNTANT', 'TEACHER', 'STUDENT', 'GUARDIAN'];
const NOT_RECEPTION: R[] = ['ACCOUNTANT', 'TEACHER', 'STUDENT', 'GUARDIAN'];
const MATRIX: Array<[string, R[]]> = [
  ['POST /api/legacy/import', ALL], ['POST /api/import/excel', ALL],
  ['GET /api/export/excel', ['RECEPTIONIST', 'TEACHER', 'STUDENT', 'GUARDIAN']],
  ['GET /api/students', ['ACCOUNTANT', 'GUARDIAN']], ['POST /api/students', NOT_RECEPTION],
  ['GET /api/center/overview', NOT_RECEPTION], ['GET /api/center/reports/summary', ['TEACHER', 'STUDENT', 'GUARDIAN']],
  ['GET /api/center/audit-logs', ALL], ['GET /api/center/attendance', ['ACCOUNTANT', 'TEACHER']],
  ['POST /api/center/attendance', NOT_RECEPTION], ['POST /api/center/attendance/scan', NOT_RECEPTION],
  ['GET /api/center/attendance/selected', ['ACCOUNTANT']], ['POST /api/center/attendance/selected/record', NOT_RECEPTION],
  ['GET /api/center/attendance/teacher-summary', ['RECEPTIONIST', 'ACCOUNTANT', 'STUDENT', 'GUARDIAN']],
  ['GET /api/center/sessions', ['TEACHER']], ['GET /api/center/subscriptions', ['RECEPTIONIST', 'TEACHER', 'STUDENT']],
  ['POST /api/center/subscriptions', ALL], ['GET /api/center/system/update-status', ALL],
  ['POST /api/center/classrooms', ALL], ['POST /api/center/courses', ALL],
  ['GET /api/center/payments', ['RECEPTIONIST', 'TEACHER', 'STUDENT']],
  ['POST /api/center/payments', ['RECEPTIONIST', 'TEACHER', 'STUDENT', 'GUARDIAN']],
  ['GET /api/center/grades', ['RECEPTIONIST', 'ACCOUNTANT', 'STUDENT', 'GUARDIAN']],
  ['POST /api/center/grades', ['RECEPTIONIST', 'ACCOUNTANT', 'STUDENT', 'GUARDIAN']],
  ['GET /api/center/kiosk/students', NOT_RECEPTION],
  ['GET /api/center/exams', ['RECEPTIONIST', 'ACCOUNTANT', 'STUDENT', 'GUARDIAN']],
  ['POST /api/center/exams', ['RECEPTIONIST', 'ACCOUNTANT', 'STUDENT', 'GUARDIAN']],
  ['POST /api/teachers', ALL], ['POST /api/groups', ALL],
  ['GET /api/portal/student', ['RECEPTIONIST', 'ACCOUNTANT', 'TEACHER', 'GUARDIAN']],
  ['GET /api/portal/parent', ['RECEPTIONIST', 'ACCOUNTANT', 'TEACHER', 'STUDENT']],
  ['GET /api/portal/student/learning-report', ['RECEPTIONIST', 'ACCOUNTANT', 'TEACHER', 'GUARDIAN']],
  ['GET /api/portal/parent/learning-report', ['RECEPTIONIST', 'ACCOUNTANT', 'TEACHER', 'STUDENT']],
  ['GET /api/portal/notifications', ['RECEPTIONIST', 'ACCOUNTANT', 'TEACHER']],
];

describe('role by route denial matrix', () => {
  const app = buildApp(); const cookies: Record<string, string> = {};
  beforeAll(async () => {
    const centerId = (await prisma.center.create({ data: { slug: 'matrix-a', name: 'Matrix A' } })).id;
    for (const role of ALL) {
      const user = await prisma.user.create({ data: { centerId, role: role as Role, name: role, email: `${role}@matrix.test`, passwordHash: 'unusable-test-only', centerMemberships: { create: { centerId, role: role as Role } } } });
      const token = `matrix-session-${role}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[role] = `center_session=${token}`;
    }
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  it.each(MATRIX.flatMap(([route, roles]) => roles.map(role => [route, role] as const)))('%s refuses %s', async (route, role) => {
    const [method, url] = route.split(' ');
    const res = await app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {}, headers: { cookie: cookies[role] } });
    expect(res.statusCode).toBe(403);
  });
  // Owner decision (WhatsApp, Nov 24 2026): the accountant may export everything, not only finance data.
  it('lets an accountant export the full workbook, by owner decision', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export/excel', headers: { cookie: cookies.ACCOUNTANT } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('spreadsheetml');
  });
  // Owner decision (WhatsApp, Nov 24 2026): students and guardians only see branches linked to them.
  it('shows students and guardians only their linked branches', async () => {
    const centerId = (await prisma.center.create({ data: { slug: 'matrix-branches', name: 'Matrix branches' } })).id;
    const own = (await prisma.branch.create({ data: { centerId, name: 'Linked branch' } })).id;
    const group = (await prisma.branch.create({ data: { centerId, name: 'Group branch' } })).id;
    await prisma.branch.create({ data: { centerId, name: 'Unlinked branch' } });
    const make = async (role: 'STUDENT' | 'GUARDIAN', label: string = role) => {
      const user = await prisma.user.create({ data: { centerId, role, name: `b-${label}`, email: `b-${label}@matrix.test`, passwordHash: 'unusable-test-only', centerMemberships: { create: { centerId, role } } } });
      const token = `matrix-branch-${label}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId, expiresAt: new Date(Date.now() + 3600000) } });
      return { user, cookie: `center_session=${token}` };
    };
    const student = await make('STUDENT'), guardian = await make('GUARDIAN'), stranger = await make('GUARDIAN', 'STRANGER');
    const teacher = await prisma.teacher.create({ data: { id: 967001, centerId, name: 'T', subject: 'Math' } });
    const grp = await prisma.group.create({ data: { id: 967001, centerId, branchId: group, teacherId: teacher.id, grade: 'G', days: 'Sunday', time: '10:00', price: 1 } });
    const pupil = await prisma.student.create({ data: { id: 967001, centerId, branchId: own, userId: student.user.id, name: 'Pupil' } });
    await prisma.enrollment.create({ data: { studentId: pupil.id, groupId: grp.id } });
    await prisma.guardian.create({ data: { centerId, userId: guardian.user.id, name: 'Parent', children: { create: { studentId: pupil.id, relation: 'parent' } } } });
    const names = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/center/branches', headers: { cookie } })).json().branches.map((b: { name: string }) => b.name).sort();
    expect(await names(student.cookie)).toEqual(['Group branch', 'Linked branch']);
    expect(await names(guardian.cookie)).toEqual(['Group branch', 'Linked branch']);
    expect(await names(stranger.cookie)).toEqual([]);
  });
});
