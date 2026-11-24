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
});
