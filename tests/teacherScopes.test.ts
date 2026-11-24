import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('assigned teacher resource boundaries', () => {
  const app = buildApp();
  const own = 950001, other = 950002, foreign = 950003;
  const today = new Date().toISOString().slice(0, 10);
  let center: string, teacherUser: string, cookie: string, ownBranch: string, staffCookie: string;
  beforeAll(async () => {
    center = (await prisma.center.create({ data: { slug: 'teacher-resources-a', name: 'Teaching A' } })).id;
    const foreignCenter = (await prisma.center.create({ data: { slug: 'teacher-resources-b', name: 'Teaching B' } })).id;
    ownBranch = (await prisma.branch.create({ data: { centerId: center, name: 'Teaching branch' } })).id;
    const siblingBranch = (await prisma.branch.create({ data: { centerId: center, name: 'Other teaching branch' } })).id;
    const user = await prisma.user.create({ data: { centerId: center, branchId: ownBranch, role: 'TEACHER', name: 'Assigned teacher', email: 'assigned@teacher-resources.test', passwordHash: 'unusable-fixture', centerMemberships: { create: { centerId: center, role: 'TEACHER' } } } });
    teacherUser = user.id;
    const token = 'assigned-teacher-disposable-session';
    await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId: center, expiresAt: new Date(Date.now() + 3600000) } });
    cookie = `center_session=${token}`;
    const staff = await prisma.user.create({ data: { centerId: center, branchId: ownBranch, role: 'RECEPTIONIST', name: 'Scan staff', email: 'scan-staff@teacher-resources.test', passwordHash: 'unusable-fixture', centerMemberships: { create: { centerId: center, role: 'RECEPTIONIST' } } } });
    const staffToken = 'scan-staff-disposable-session'; await prisma.session.create({ data: { id: createHash('sha256').update(staffToken).digest('hex'), userId: staff.id, centerId: center, expiresAt: new Date(Date.now() + 3600000) } }); staffCookie = 'center_session=' + staffToken;
    for (const id of [own, other, foreign]) {
      const centerId = id === foreign ? foreignCenter : center, branchId = id === own ? ownBranch : id === other ? siblingBranch : null;
      await prisma.teacher.create({ data: { id, centerId, branchId, userId: id === own ? user.id : null, name: `Teacher ${id}`, subject: 'Math', phone: id === own ? 'own-contact' : 'unrelated-contact' } });
      await prisma.group.create({ data: { id, centerId, branchId, teacherId: id, grade: `Group ${id}`, days: 'Sunday', time: '10:00', price: 100 } });
      await prisma.student.create({ data: { id, centerId, branchId, name: `Pupil ${id}` } });
      await prisma.enrollment.create({ data: { studentId: id, groupId: id } });
      const room = await prisma.classroom.create({ data: { centerId, branchId, name: `Room ${id}`, capacity: 20 } });
      await prisma.lessonSession.create({ data: { groupId: id, classroomId: room.id, date: id === own ? '2026-11-01' : today, startsAt: '10:00', endsAt: '11:00' } });
      await prisma.attendance.create({ data: { studentId: own, groupId: id, date: '2026-11-01', status: 'PRESENT' } });
    }
    await prisma.enrollment.createMany({ data: [{ studentId: own, groupId: other }, { studentId: own, groupId: foreign }] });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  let count = 0;
  const request = (method: 'GET'|'POST'|'PATCH'|'PUT'|'DELETE', url: string, payload?: object, asStaff = false) => app.inject({ method, url, remoteAddress: `192.0.2.${++count}`, headers: { cookie: asStaff ? staffCookie : cookie }, ...(payload ? { payload } : {}) });
  it('returns assigned students with only this teacher\'s enrollment IDs', async () => {
    const result = await request('GET', '/api/students'); expect(result.statusCode).toBe(200);
    expect(result.json().items.map((row: { id: number }) => row.id)).toEqual([own]);
    expect(result.json().items[0].enrollments.map((row: { groupId: number }) => row.groupId)).toEqual([own]);
  });
  it('does not disclose unrelated teacher contacts or classrooms through overview', async () => {
    const result = await request('GET', '/api/center/overview'); expect(result.statusCode).toBe(200);
    expect(result.json().teachers.map((row: { id: number }) => row.id)).toEqual([own]);
    expect(result.json().groups.map((row: { id: number }) => row.id)).toEqual([own]);
    expect(result.json().classrooms.map((row: { name: string }) => row.name)).toEqual([`Room ${own}`]);
  });
  it('allows the assigned-detail permission without exposing another class history', async () => {
    const result = await request('GET', `/api/students/${own}`); expect(result.statusCode).toBe(200);
    expect(result.json().student.enrollments.map((row: { groupId: number }) => row.groupId)).toEqual([own]);
    expect(result.json().student.attendance.map((row: { groupId: number }) => row.groupId)).toEqual([own]);
    expect((await request('GET', `/api/students/${other}`)).statusCode).toBe(404);
    expect((await request('GET', `/api/students/${foreign}`)).statusCode).toBe(404);
  });
  it('does not turn a students.view override into access to unassigned pupils', async () => {
    await prisma.userPermission.create({ data: { userId: teacherUser, permissionKey: 'students.view', allowed: true } });
    try { expect((await request('GET', `/api/students/${other}`)).statusCode).toBe(404); }
    finally { await prisma.userPermission.delete({ where: { userId_permissionKey: { userId: teacherUser, permissionKey: 'students.view' } } }); }
  });
  it('denies a scan of an unassigned pupil without an attendance write', async () => {
    const before = await prisma.attendance.count({ where: { studentId: other } });
    expect((await request('POST', '/api/center/attendance/scan', { code: String(other) })).statusCode).toBe(403);
    expect(await prisma.attendance.count({ where: { studentId: other } })).toBe(before);
  });
  it('does not scan even an assigned shared pupil when the actor is a teacher', async () => {
    const before = await prisma.attendance.count(); expect((await request('POST', '/api/center/attendance/scan', { code: String(own) })).statusCode).toBe(403); expect(await prisma.attendance.count()).toBe(before);
  });
  it('keeps attendance and session reads inside the assignment', async () => {
    for (const url of ['/api/center/attendance', '/api/center/sessions']) {
      const result = await request('GET', url); expect(result.statusCode).toBe(200);
      expect(result.json().items.every((row: { groupId: number }) => row.groupId === own)).toBe(true);
    }
    expect((await request('GET', '/api/center/subscriptions')).statusCode).toBe(403);
  });
  it('keeps explicitly granted student teacher and group writes inside the assignment', async () => {
    const permissions = ['students.update', 'students.delete', 'teachers.update', 'teachers.delete', 'groups.update', 'groups.delete'] as const;
    for (const permissionKey of permissions) await prisma.userPermission.create({ data: { userId: teacherUser, permissionKey, allowed: true } });
    try {
      for (const resource of ['students', 'teachers', 'groups']) {
        expect((await request('PUT', `/api/${resource}/${other}`, { name: 'Not allowed', grade: 'Not allowed' })).statusCode).toBe(404);
        expect((await request('DELETE', `/api/${resource}/${other}`)).statusCode).toBe(404);
      }
      expect((await request('DELETE', `/api/students/${own}`)).statusCode).toBe(403);
      expect((await request('PUT', `/api/groups/${own}`, { grade: 'Allowed class update' })).statusCode).toBe(200);
      expect((await request('PUT', `/api/students/${own}`, { name: 'Allowed pupil update', groupIds: [own] })).statusCode).toBe(200);
      expect(await prisma.enrollment.findUnique({ where: { studentId_groupId: { studentId: own, groupId: other } } })).not.toBeNull();
    } finally { await prisma.userPermission.deleteMany({ where: { userId: teacherUser, permissionKey: { in: [...permissions] } } }); }
  });
  it('does not widen schedule or assessment scope through explicit action grants', async () => {
    const permissions = ['groups.manage_schedule', 'academic.manage_grades'] as const;
    for (const permissionKey of permissions) await prisma.userPermission.create({ data: { userId: teacherUser, permissionKey, allowed: true } });
    try {
      const session = await prisma.lessonSession.findFirstOrThrow({ where: { groupId: other } });
      expect((await request('PATCH', `/api/center/sessions/${session.id}`, { status: 'cancelled' })).statusCode).toBe(404);
      expect((await request('GET', `/api/center/grades/enrollments?groupId=${other}`)).statusCode).toBe(404);
      const grade = { studentId: own, title: 'Assignment check', assessedOn: '2026-11-10', score: 8, maxScore: 10 };
      expect((await request('POST', '/api/center/grades', { ...grade, groupId: other })).statusCode).toBe(422);
      expect((await request('POST', '/api/center/grades', { ...grade, groupId: own })).statusCode).toBe(201);
      expect((await request('GET', '/api/center/grades?month=2026-11')).json().items.map((row: { groupId: number }) => row.groupId)).toEqual([own]);
    } finally { await prisma.userPermission.deleteMany({ where: { userId: teacherUser, permissionKey: { in: [...permissions] } } }); }
  });
  it('rolls an authorized staff scan back when its audit fails', async () => {
    const where = { studentId_groupId_date: { studentId: own, groupId: own, date: today } };
    const before = await prisma.attendance.upsert({ where, update: { status: 'ABSENT', note: 'Rollback fixture' }, create: { studentId: own, groupId: own, date: today, status: 'ABSENT', note: 'Rollback fixture' } });
    await prisma.attendance.updateMany({ where: { studentId: own, date: today }, data: { status: 'ABSENT', note: 'Rollback fixture' } });
    const beforeRows = await prisma.attendance.findMany({ where: { studentId: own }, orderBy: [{ groupId: 'asc' }, { date: 'asc' }] });
    await prisma.$executeRawUnsafe("CREATE TRIGGER teacher_scan_audit_fail BEFORE INSERT ON AuditLog WHEN NEW.action = 'attendance.scan' AND NEW.userId = (SELECT id FROM User WHERE email = 'scan-staff@teacher-resources.test') BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    try { expect((await request('POST', '/api/center/attendance/scan', { code: String(own) }, true)).statusCode).toBe(500); }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER teacher_scan_audit_fail'); }
    expect(await prisma.attendance.findUnique({ where })).toEqual(before);
    expect(await prisma.attendance.findMany({ where: { studentId: own }, orderBy: [{ groupId: 'asc' }, { date: 'asc' }] })).toEqual(beforeRows);
  });
  it('rejects a foreign-center teacher profile linked to the local teacher account', async () => {
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: own } });
    const foreignCenter = (await prisma.teacher.findUniqueOrThrow({ where: { id: foreign } })).centerId;
    await prisma.teacher.update({ where: { id: own }, data: { centerId: foreignCenter } });
    try {
      expect((await request('GET', '/api/center/overview')).statusCode).toBe(403);
      expect((await request('GET', '/api/students')).json().items).toEqual([]);
      expect((await request('POST', '/api/center/attendance/scan', { code: String(own) })).statusCode).toBe(403);
    } finally { await prisma.teacher.update({ where: { id: own }, data: { centerId: teacher.centerId } }); }
  });
});
