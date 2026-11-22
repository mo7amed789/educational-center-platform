import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('primary branch scopes and related resource IDs', () => {
  const app = buildApp();
  const ids = [940001, 940002, 940003];
  let center: string, foreignCenter: string, branch: string, siblingBranch: string, foreignBranch: string, course: string, foreignCourse: string;
  const cookies: Record<string, string> = {}, users: Record<string, string> = {};
  let ownSession: string, otherSession: string;
  beforeAll(async () => {
    center = (await prisma.center.create({ data: { slug: 'branch-scope-a', name: 'Center A' } })).id;
    foreignCenter = (await prisma.center.create({ data: { slug: 'branch-scope-b', name: 'Center B' } })).id;
    branch = (await prisma.branch.create({ data: { centerId: center, name: 'Primary A' } })).id;
    siblingBranch = (await prisma.branch.create({ data: { centerId: center, name: 'Sibling B' } })).id;
    foreignBranch = (await prisma.branch.create({ data: { centerId: foreignCenter, name: 'Foreign C' } })).id;
    for (const [key, role, branchId] of [['owner', 'CENTER_OWNER', branch], ['manager', 'BRANCH_ADMIN', branch], ['unassigned', 'BRANCH_ADMIN', null], ['badBranch', 'BRANCH_ADMIN', foreignBranch]] as const) {
      const user = await prisma.user.create({ data: { centerId: center, branchId, role, name: key, email: `${key}@branch-scope.test`, passwordHash: 'unusable-test-fixture', centerMemberships: { create: { centerId: center, role } } } });
      users[key] = user.id; const token = `branch-test-session-${key}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId: center, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[key] = `center_session=${token}`;
    }
    for (let index = 0; index < 3; index++) {
      const centerId = index === 2 ? foreignCenter : center, branchId = [branch, siblingBranch, foreignBranch][index], id = ids[index];
      await prisma.teacher.create({ data: { id, centerId, branchId, name: `Teacher ${index}`, subject: 'Math' } });
      await prisma.group.create({ data: { id, centerId, branchId, teacherId: id, grade: `Group ${index}`, days: 'Sunday', time: '10:00', price: 100 } });
      await prisma.student.create({ data: { id, centerId, branchId, name: `Student ${index}` } });
      await prisma.enrollment.create({ data: { studentId: id, groupId: id } });
      await prisma.attendance.create({ data: { studentId: id, groupId: id, date: '2026-11-01', status: 'PRESENT' } });
      await prisma.subscription.create({ data: { studentId: id, groupId: id, month: '2026-11', dueOn: '2026-11-10', amount: 100, status: 'paid' } });
      await prisma.payment.create({ data: { studentId: id, groupId: id, month: '2026-11', amount: 100, status: 'paid' } });
      const session = await prisma.lessonSession.create({ data: { groupId: id, date: '2026-11-01', startsAt: '10:00', endsAt: '11:00' } });
      if (index === 0) ownSession = session.id; if (index === 1) otherSession = session.id;
      await prisma.classroom.create({ data: { centerId, branchId, name: `Room ${index}`, capacity: 20 } });
    }
    await prisma.student.create({ data: { id: 940004, centerId: center, branchId: branch, name: 'Primary branch student with sibling enrollment' } });
    await prisma.enrollment.createMany({ data: [{ studentId: 940004, groupId: ids[1] }, { studentId: ids[1], groupId: ids[0] }] });
    course = (await prisma.course.create({ data: { centerId: center, name: 'Own course', subject: 'Math', grade: 'One' } })).id;
    foreignCourse = (await prisma.course.create({ data: { centerId: foreignCenter, name: 'Foreign course', subject: 'Science', grade: 'One' } })).id;
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  let requestCount = 0;
  const request = (method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', url: string, payload?: object, who = 'manager') => app.inject({ method, url, remoteAddress: `192.0.2.${++requestCount % 250 + 1}`, headers: { cookie: cookies[who] }, ...(payload ? { payload } : {}) });
  const groupInput = { teacherId: ids[0], grade: 'New group', days: 'Monday', time: '12:00', price: 100 };
  it('restricts the branch student list and hides sibling/foreign student details', async () => {
    const result = await request('GET', '/api/students?pageSize=100');
    expect(result.statusCode).toBe(200); expect(result.json().items.map((row: { id: number }) => row.id).sort()).toEqual([ids[0], 940004]);
    expect((await request('GET', `/api/students/${ids[1]}`)).statusCode).toBe(404);
    expect((await request('GET', `/api/students/${ids[2]}`)).statusCode).toBe(404);
    const own = await request('GET', '/api/students/940004'); expect(own.statusCode).toBe(200); expect(own.json().student.enrollments).toEqual([]);
  });
  it('does not narrow a center owner just because their account has a branch', async () => {
    const result = await request('GET', '/api/students?pageSize=100', undefined, 'owner'); expect(result.json().items).toHaveLength(3);
  });
  it('scopes overview teachers groups and classrooms to the primary branch', async () => {
    const body = (await request('GET', '/api/center/overview')).json();
    expect(body.teachers.map((row: { id: number }) => row.id)).toEqual([ids[0]]);
    expect(body.groups.map((row: { id: number }) => row.id)).toEqual([ids[0]]);
    expect(body.classrooms).toHaveLength(1);
  });
  it.each(['/api/center/attendance', '/api/center/subscriptions?month=2026-11', '/api/center/payments?month=2026-11', '/api/center/sessions'])('scopes branch rows in %s', async (url) => {
    const result = await request('GET', url); expect(result.statusCode).toBe(200);
    const rows = result.json().items || result.json().payments;
    expect(rows).toHaveLength(1); expect(rows[0].groupId).toBe(ids[0]);
  });
  it('scopes branch summaries and the branch list', async () => {
    const result = await request('GET', '/api/center/reports/summary?month=2026-11'); expect(result.statusCode).toBe(200);
    expect(result.json().counts).toEqual({ students: 2, teachers: 1, groups: 1 }); expect(result.json().revenue.amount).toBe(100);
    expect((await request('GET', '/api/center/branches')).json().branches.map((row: { id: string }) => row.id)).toEqual([branch]);
  });
  it.each(['unassigned', 'badBranch'])('never falls back to center scope for %s branch admins', async (who) => {
    for (const url of ['/api/students', '/api/center/overview', '/api/center/branches', '/api/center/attendance', '/api/center/subscriptions', '/api/center/payments', '/api/center/sessions', '/api/center/reports/summary']) {
      expect((await request('GET', url, undefined, who)).statusCode).toBe(403);
    }
  });
  it('honors an explicit inactive primary-branch membership', async () => {
    await prisma.branchMembership.create({ data: { userId: users.manager, branchId: branch, active: false } });
    try { expect((await request('GET', '/api/students')).statusCode).toBe(403); }
    finally { await prisma.branchMembership.delete({ where: { userId_branchId: { userId: users.manager, branchId: branch } } }); }
  });
  it('rejects an inactive center membership even on the branch-list route', async () => {
    await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.manager, centerId: center } }, data: { active: false } });
    try { expect((await request('GET', '/api/center/branches')).statusCode).toBe(403); }
    finally { await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.manager, centerId: center } }, data: { active: true } }); }
  });
  it('does not widen the acting branch through an additional branch membership', async () => {
    await prisma.branchMembership.create({ data: { userId: users.manager, branchId: siblingBranch, active: true } });
    try { expect((await request('GET', `/api/students/${ids[1]}`)).statusCode).toBe(404); }
    finally { await prisma.branchMembership.delete({ where: { userId_branchId: { userId: users.manager, branchId: siblingBranch } } }); }
  });
  it.each(['/api/center/audit-logs', '/api/export/excel'])('denies currently center-wide branch operations at %s', async (url) => { expect((await request('GET', url)).statusCode).toBe(403); });
  it.each(['/api/legacy/import', '/api/import/excel', '/api/center/courses'])('denies unscoped center-wide branch mutations at %s', async (url) => { expect((await request('POST', url, {})).statusCode).toBe(403); });
  it('requires center-level authority for a shared student hard deletion', async () => { expect((await request('DELETE', `/api/students/${ids[0]}`)).statusCode).toBe(403); expect(await prisma.student.findUnique({ where: { id: ids[0] } })).not.toBeNull(); });
  it.each(['%39%34%30%30%30%31', '9.40001e5'])('cannot bypass the hard-delete guard with an alternate numeric path %s', async (id) => {
    expect((await request('DELETE', `/api/students/${id}`)).statusCode).toBe(403);
    expect(await prisma.student.findUnique({ where: { id: ids[0] } })).not.toBeNull();
  });
  it('replaces only acting-branch enrollments while preserving sibling links', async () => {
    const added = await request('PUT', '/api/students/940004', { groupIds: [ids[0], ids[0]] }); expect(added.statusCode).toBe(200);
    expect((await prisma.enrollment.findMany({ where: { studentId: 940004 }, orderBy: { groupId: 'asc' } })).map(row => row.groupId)).toEqual([ids[0], ids[1]]);
    const removed = await request('PUT', '/api/students/940004', { groupIds: [] }); expect(removed.statusCode).toBe(200);
    expect((await prisma.enrollment.findMany({ where: { studentId: 940004 } })).map(row => row.groupId)).toEqual([ids[1]]);
  });
  it('records legitimate class actions for a same-center pupil whose home branch differs', async () => {
    expect((await request('POST', '/api/center/attendance', { studentId: ids[1], groupId: ids[0], date: '2026-11-03', status: 'LATE' })).statusCode).toBe(200);
    expect((await request('POST', '/api/center/subscriptions', { studentId: ids[1], groupId: ids[0], month: '2026-12', amount: 100, dueOn: '2026-12-10', status: 'pending' })).statusCode).toBe(200);
    expect((await request('POST', '/api/center/payments', { studentId: ids[1], groupId: ids[0], month: '2026-12', amount: 100 })).statusCode).toBe(200);
    const scan = await request('POST', '/api/center/attendance/scan', { code: String(ids[1]) }); expect(scan.statusCode).toBe(200); expect(scan.json().group.id).toBe(ids[0]);
  });
  it('does not scan a primary-home pupil into a sibling-only class', async () => {
    expect((await request('POST', '/api/center/attendance/scan', { code: '940004' })).statusCode).toBe(422);
    expect(await prisma.attendance.count({ where: { studentId: 940004 } })).toBe(0);
  });
  it.each([ids[1], ids[2]])('hides sibling/foreign teacher and group mutation targets %i', async (id) => {
    expect((await request('PUT', `/api/teachers/${id}`, { name: 'Not authorized' })).statusCode).toBe(404);
    expect((await request('DELETE', `/api/teachers/${id}`)).statusCode).toBe(404);
    expect((await request('PUT', `/api/groups/${id}`, { grade: 'Not authorized' })).statusCode).toBe(404);
    expect((await request('DELETE', `/api/groups/${id}`)).statusCode).toBe(404);
  });
  it('creates students teachers and rooms in the acting branch by default', async () => {
    const student = await request('POST', '/api/students', { id: 940010, name: 'New branch student', groupIds: [ids[0]] }); expect(student.statusCode).toBe(200); expect(student.json().student.branchId).toBe(branch);
    const teacher = await request('POST', '/api/teachers', { id: 940010, name: 'New branch teacher', subject: 'Math' }); expect(teacher.statusCode).toBe(200); expect(teacher.json().teacher.branchId).toBe(branch);
    const room = await request('POST', '/api/center/classrooms', { name: 'New branch room', capacity: 20 }); expect(room.statusCode).toBe(200); expect(room.json().classroom.branchId).toBe(branch);
  });
  it.each(['sibling', 'foreign', 'missing', 'empty'])('rejects a %s branch assignment without creating rows', async (kind) => {
    const branchId = kind === 'sibling' ? siblingBranch : kind === 'foreign' ? foreignBranch : kind === 'empty' ? '' : 'missing-branch';
    const before = [await prisma.student.count(), await prisma.teacher.count(), await prisma.classroom.count(), await prisma.group.count()];
    expect((await request('POST', '/api/students', { name: 'Bad branch student', branchId })).statusCode).toBe(422);
    expect((await request('POST', '/api/teachers', { name: 'Bad branch teacher', subject: 'Math', branchId })).statusCode).toBe(422);
    expect((await request('POST', '/api/center/classrooms', { name: 'Bad branch room', capacity: 20, branchId })).statusCode).toBe(422);
    expect((await request('POST', '/api/groups', { ...groupInput, branchId })).statusCode).toBe(422);
    expect([await prisma.student.count(), await prisma.teacher.count(), await prisma.classroom.count(), await prisma.group.count()]).toEqual(before);
  });
  it('rejects a foreign branch even for the center owner', async () => { expect((await request('POST', '/api/center/classrooms', { name: 'Foreign branch room', capacity: 20, branchId: foreignBranch }, 'owner')).statusCode).toBe(422); });
  it.each([ids[1], ids[2], 9999999])('rejects an invalid enrollment group %i atomically', async (groupId) => {
    const before = await prisma.student.count();
    expect((await request('POST', '/api/students', { name: 'Invalid enrollment', groupIds: [ids[0], groupId] })).statusCode).toBe(422);
    expect(await prisma.student.count()).toBe(before);
    const original = await prisma.enrollment.findMany({ where: { studentId: ids[0] } });
    expect((await request('PUT', `/api/students/${ids[0]}`, { name: 'Must roll back', groupIds: [groupId] })).statusCode).toBe(422);
    expect(await prisma.enrollment.findMany({ where: { studentId: ids[0] } })).toEqual(original);
  });
  it('does not transfer a branch student or teacher to another branch', async () => {
    expect((await request('PUT', `/api/students/${ids[0]}`, { branchId: siblingBranch })).statusCode).toBe(422);
    expect((await request('PUT', `/api/teachers/${ids[0]}`, { branchId: foreignBranch })).statusCode).toBe(422);
  });
  it.each([ids[1], ids[2]])('rejects a sibling/foreign teacher assignment %i', async (teacherId) => {
    expect((await request('POST', '/api/groups', { ...groupInput, teacherId })).statusCode).toBe(422);
    expect((await request('PUT', `/api/groups/${ids[0]}`, { teacherId })).statusCode).toBe(422);
  });
  it('validates course center on both group create and update', async () => {
    expect((await request('POST', '/api/groups', { ...groupInput, courseId: foreignCourse })).statusCode).toBe(422);
    expect((await request('PUT', `/api/groups/${ids[0]}`, { courseId: foreignCourse })).statusCode).toBe(422);
    const result = await request('POST', '/api/groups', { ...groupInput, id: 940020, courseId: course }); expect(result.statusCode).toBe(200); expect(result.json().group.branchId).toBe(branch);
  });
  it('rejects a foreign student even when a corrupt enrollment points at the acting branch', async () => {
    await prisma.enrollment.create({ data: { studentId: ids[2], groupId: ids[0] } });
    try {
      expect((await request('POST', '/api/center/attendance', { studentId: ids[2], groupId: ids[0], date: '2026-11-04', status: 'PRESENT' })).statusCode).toBe(422);
      expect((await request('POST', '/api/center/subscriptions', { studentId: ids[2], groupId: ids[0], month: '2026-12', amount: 100, dueOn: '2026-12-10', status: 'pending' })).statusCode).toBe(422);
      expect((await request('POST', '/api/center/payments', { studentId: ids[2], groupId: ids[0], month: '2026-12', amount: 100 })).statusCode).toBe(422);
    } finally { await prisma.enrollment.delete({ where: { studentId_groupId: { studentId: ids[2], groupId: ids[0] } } }); }
  });
  it('rolls all related writes back when their audit fails', async () => {
    const counts = () => Promise.all([prisma.student.count(), prisma.teacher.count(), prisma.user.count(), prisma.enrollment.count(), prisma.subscription.count(), prisma.group.count(), prisma.classroom.count(), prisma.attendance.count(), prisma.auditLog.count()]);
    const before = await counts();
    await prisma.$executeRawUnsafe("CREATE TRIGGER branch_audit_fail BEFORE INSERT ON AuditLog WHEN NEW.action IN ('students.create', 'students.update', 'teachers.create', 'groups.create', 'attendance.record', 'subscription.record', 'classrooms.create') BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    try {
      for (const [url, payload] of [
        ['/api/students', { id: 940090, name: 'Rollback pupil', groupIds: [ids[0]] }],
        ['/api/teachers', { id: 940090, name: 'Rollback teacher', subject: 'Math', email: 'rollback@branch-scope.test', password: 'disposable-test-only' }],
        ['/api/groups', { ...groupInput, id: 940090 }],
        ['/api/center/classrooms', { name: 'Rollback room', capacity: 20 }],
        ['/api/center/attendance', { studentId: ids[0], groupId: ids[0], date: '2026-11-06', status: 'ABSENT' }],
        ['/api/center/subscriptions', { studentId: ids[0], groupId: ids[0], month: '2026-09', amount: 100, dueOn: '2026-09-10', status: 'pending' }],
      ] as const) {
        expect((await request('POST', url, payload)).statusCode).toBe(500);
        expect(await counts()).toEqual(before);
      }
      const pupil = await prisma.student.findUniqueOrThrow({ where: { id: ids[0] } });
      const enrollments = await prisma.enrollment.findMany({ where: { studentId: ids[0] } });
      expect((await request('PUT', `/api/students/${ids[0]}`, { name: 'Rollback update', groupIds: [] })).statusCode).toBe(500);
      expect(await prisma.student.findUnique({ where: { id: ids[0] } })).toEqual(pupil);
      expect(await prisma.enrollment.findMany({ where: { studentId: ids[0] } })).toEqual(enrollments);
      expect(await counts()).toEqual(before);
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER branch_audit_fail'); }
  });
  it('keeps branch attendance subscription payment and session writes inside the branch', async () => {
    expect((await request('POST', '/api/center/attendance', { studentId: ids[1], groupId: ids[1], date: '2026-11-02', status: 'ABSENT' })).statusCode).toBe(422);
    expect((await request('POST', '/api/center/subscriptions', { studentId: ids[1], groupId: ids[1], month: '2026-11', amount: 100, discount: 0, dueOn: '2026-11-10', status: 'pending' })).statusCode).toBe(422);
    expect((await request('POST', '/api/center/payments', { studentId: ids[1], groupId: ids[1], month: '2026-11', amount: 100 })).statusCode).toBe(422);
    expect((await request('PATCH', `/api/center/sessions/${otherSession}`, { status: 'cancelled' })).statusCode).toBe(404);
    expect((await request('PATCH', `/api/center/sessions/${ownSession}`, { status: 'active' })).statusCode).toBe(200);
  });
});
