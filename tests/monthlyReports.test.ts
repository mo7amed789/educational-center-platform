import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('parent monthly reports and managed grade records', () => {
  const app = buildApp();
  const childId = 920001, otherChildId = 920002, foreignChildId = 920003;
  const groupId = 920001, foreignGroupId = 920002;
  let centerId: string, foreignCenterId: string, guardianId: string, branchId: string;
  const cookies: Record<string, string> = {};
  const users: Record<string, string> = {};
  beforeAll(async () => {
    centerId = (await prisma.center.create({ data: { slug: 'monthly-a', name: 'Report Center A' } })).id;
    foreignCenterId = (await prisma.center.create({ data: { slug: 'monthly-b', name: 'Report Center B' } })).id;
    for (const [key, role, center] of [
      ['parent', 'GUARDIAN', centerId], ['otherParent', 'GUARDIAN', centerId],
      ['owner', 'CENTER_OWNER', centerId], ['teacher', 'TEACHER', centerId],
      ['foreignOwner', 'CENTER_OWNER', foreignCenterId], ['branchAdmin', 'BRANCH_ADMIN', centerId], ['unassignedAdmin', 'BRANCH_ADMIN', centerId],
    ] as const) {
      const user = await prisma.user.create({ data: { email: `${key}@monthly.test`, name: key, role, centerId: center, passwordHash: 'unusable-test-fixture', centerMemberships: { create: { centerId: center, role } } } });
      users[key] = user.id;
      const raw = `monthly-test-only-${key}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(raw).digest('hex'), userId: user.id, centerId: center, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[key] = `center_session=${raw}`;
    }
    for (const [id, center] of [[groupId, centerId], [foreignGroupId, foreignCenterId]] as const) {
      await prisma.teacher.create({ data: { id, centerId: center, name: `Teacher ${id}`, subject: 'رياضيات' } });
      await prisma.group.create({ data: { id, centerId: center, teacherId: id, grade: 'مجموعة رياضيات', days: 'Sunday', time: '10:00', price: 100 } });
    }
    branchId = (await prisma.branch.create({ data: { centerId, name: 'Report branch A' } })).id;
    const otherBranchId = (await prisma.branch.create({ data: { centerId, name: 'Report branch B' } })).id;
    await prisma.user.update({ where: { id: users.branchAdmin }, data: { branchId } });
    await prisma.group.update({ where: { id: groupId }, data: { branchId } });
    await prisma.group.create({ data: { id: 920003, centerId, branchId: otherBranchId, teacherId: groupId, grade: 'Other branch', days: 'Monday', time: '12:00', price: 100 } });
    await prisma.student.createMany({ data: [{ id: childId, centerId, name: 'Own child <test>' }, { id: otherChildId, centerId, name: 'Unrelated child' }, { id: foreignChildId, centerId: foreignCenterId, name: 'Foreign child' }] });
    guardianId = (await prisma.guardian.create({ data: { centerId, userId: users.parent, name: 'Own parent' } })).id;
    const otherGuardianId = (await prisma.guardian.create({ data: { centerId, userId: users.otherParent, name: 'Other parent' } })).id;
    await prisma.studentGuardian.createMany({ data: [{ guardianId, studentId: childId, relation: 'parent' }, { guardianId, studentId: foreignChildId, relation: 'bad-legacy-link' }, { guardianId: otherGuardianId, studentId: otherChildId, relation: 'parent' }] });
    await prisma.enrollment.createMany({ data: [{ studentId: childId, groupId }, { studentId: foreignChildId, groupId: foreignGroupId }, { studentId: otherChildId, groupId: 920003 }] });
    await prisma.attendance.createMany({ data: [
      ...['PRESENT', 'ABSENT', 'LATE', 'EXCUSED', 'p', 'unexpected'].map((status, index) => ({ studentId: childId, groupId, date: `2026-11-0${index + 1}`, status })),
      ...Array.from({ length: 15 }, (_, index) => ({ studentId: childId, groupId, date: `2026-11-${10 + index}`, status: 'PRESENT' })),
      { studentId: childId, groupId, date: '2026-10-31', status: 'PRESENT' },
      { studentId: childId, groupId, date: '2026-12-01', status: 'ABSENT' },
      { studentId: childId, groupId: foreignGroupId, date: '2026-11-07', status: 'ABSENT' },
    ] });
    await prisma.gradeRecord.createMany({ data: [
      { studentId: childId, groupId, title: 'اختبار أول', assessedOn: '2026-11-15', score: 0, maxScore: 10, recordedById: users.owner },
      { studentId: childId, groupId, title: 'اختبار ثان', assessedOn: '2026-11-20', score: 15, maxScore: 20, recordedById: users.owner },
      { studentId: childId, groupId, title: 'Outside month', assessedOn: '2026-12-01', score: 20, maxScore: 20, recordedById: users.owner },
      { studentId: childId, groupId: foreignGroupId, title: 'Bad tenant relation', assessedOn: '2026-11-15', score: 1, maxScore: 1, recordedById: users.foreignOwner },
    ] });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  const report = (studentId = childId, month = '2026-11', who = 'parent') => app.inject({ method: 'GET', url: `/api/portal/parent/monthly-report?studentId=${studentId}&month=${month}`, headers: { cookie: cookies[who] } });
  const payload = { studentId: childId, groupId, title: 'اختبار شهري', assessedOn: '2026-11-25', score: 8, maxScore: 10 };
  const createGrade = (data: unknown, who = 'owner') => app.inject({ method: 'POST', url: '/api/center/grades', headers: { cookie: cookies[who] }, payload: data as object });

  it('lists only own-center linked children with minimal fields', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/portal/parent', headers: { cookie: cookies.parent } });
    expect(result.statusCode).toBe(200);
    expect(result.json().children).toEqual([{ id: childId, name: 'Own child <test>' }]);
  });
  it('reports the whole month, legacy statuses, zero grades and weighted subject scores', async () => {
    const result = await report();
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.attendance.summary).toEqual({ recorded: 21, present: 17, absent: 1, late: 1, excused: 1, unknown: 1, attendanceRate: 95 });
    expect(body.attendance.records).toHaveLength(21);
    expect(body.grades).toHaveLength(2);
    expect(body.grades[0]).toMatchObject({ score: 0, percentage: 0 });
    expect(body.subjects).toHaveLength(1);
    expect(body.subjects[0]).toMatchObject({ subject: 'رياضيات', score: 15, maxScore: 30, percentage: 50, gradeCount: 2 });
    expect(JSON.stringify(body)).not.toContain('Bad tenant relation');
    expect(body.attendance.records.every((row: { groupId: number }) => row.groupId === groupId)).toBe(true);
  });
  it('uses exact month boundaries including December rollover', async () => {
    expect((await report(childId, '2026-10')).json().attendance.records).toHaveLength(1);
    const december = (await report(childId, '2026-12')).json();
    expect(december.attendance.summary.absent).toBe(1);
    expect(december.grades).toHaveLength(1);
  });
  it('does not invent attendance, absences or a success rate for an empty month', async () => {
    const body = (await report(childId, '2027-01')).json();
    expect(body.attendance.summary).toMatchObject({ recorded: 0, absent: 0, attendanceRate: null });
    expect(body.grades).toEqual([]); expect(body.subjects).toEqual([]);
  });
  it.each([otherChildId, foreignChildId, 99999999])('hides unlinked, cross-tenant and unknown child %i', async (id) => {
    const result = await report(id); expect(result.statusCode).toBe(404); expect(result.json()).toEqual({ error: 'CHILD_NOT_FOUND' });
  });
  it('does not let another guardian read this child', async () => { expect((await report(childId, '2026-11', 'otherParent')).statusCode).toBe(404); });
  it.each(['owner', 'teacher'])('does not treat the %s role as a parent', async (who) => { expect((await report(childId, '2026-11', who)).statusCode).toBe(403); });
  it('requires an active center membership', async () => {
    await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.parent, centerId } }, data: { active: false } });
    try { expect((await report()).statusCode).toBe(403); }
    finally { await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.parent, centerId } }, data: { active: true } }); }
  });
  it.each(['2026-00', '2026-13', '2026-1', 'wrong'])('rejects invalid month %s', async (month) => { expect((await report(childId, month)).statusCode).toBe(422); });
  it('requires authentication', async () => { expect((await app.inject({ method: 'GET', url: `/api/portal/parent/monthly-report?studentId=${childId}&month=2026-11` })).statusCode).toBe(401); });
  it.each(['parent', 'teacher'])('does not widen grade management to %s', async (who) => { expect((await createGrade(payload, who)).statusCode).toBe(403); });
  it.each([
    { ...payload, score: -1 }, { ...payload, score: 11 }, { ...payload, maxScore: 0 },
    { ...payload, assessedOn: '2026-02-30' }, { ...payload, assessedOn: '2026-13-01' },
    { ...payload, title: '' }, { ...payload, score: '8' },
  ])('validates grade input %#', async (data) => { expect((await createGrade(data)).statusCode).toBe(422); });
  it.each([
    { ...payload, studentId: otherChildId }, { ...payload, studentId: foreignChildId }, { ...payload, groupId: foreignGroupId },
  ])('rejects unenrolled or cross-center grade targets %# without side effects', async (data) => {
    const before = await prisma.gradeRecord.count();
    expect((await createGrade(data)).statusCode).toBe(422);
    expect(await prisma.gradeRecord.count()).toBe(before);
  });
  it('records an authorized grade and its audit, then exposes it only in the own-child report', async () => {
    const result = await createGrade(payload); expect(result.statusCode).toBe(201);
    const id = result.json().grade.id;
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'grades.record', centerId } })).toBe(1);
    expect((await report()).json().grades).toHaveLength(3);
    const foreignList = await app.inject({ method: 'GET', url: '/api/center/grades?month=2026-11', headers: { cookie: cookies.foreignOwner } });
    expect(foreignList.statusCode).toBe(200);
    expect(foreignList.json().items.some((row: { id: string }) => row.id === id)).toBe(false);
  });
  it('honors an explicit grade-management denial', async () => {
    const override = await prisma.userPermission.create({ data: { userId: users.owner, permissionKey: 'academic.manage_grades', allowed: false } });
    try { expect((await createGrade(payload)).statusCode).toBe(403); }
    finally { await prisma.userPermission.delete({ where: { userId_permissionKey: { userId: override.userId, permissionKey: override.permissionKey } } }); }
  });
  it('honors an explicit parent academic-view denial', async () => {
    const override = await prisma.userPermission.create({ data: { userId: users.parent, permissionKey: 'academic.view', allowed: false } });
    try { expect((await report()).statusCode).toBe(403); }
    finally { await prisma.userPermission.delete({ where: { userId_permissionKey: { userId: override.userId, permissionKey: override.permissionKey } } }); }
  });
  it('permits a branch admin only within their branch', async () => {
    expect((await createGrade({ ...payload, title: 'Branch assessment' }, 'branchAdmin')).statusCode).toBe(201);
    expect((await createGrade({ ...payload, studentId: otherChildId, groupId: 920003 }, 'branchAdmin')).statusCode).toBe(422);
    const enrollment = await app.inject({ method: 'GET', url: '/api/center/grades/enrollments?groupId=920003', headers: { cookie: cookies.branchAdmin } });
    expect(enrollment.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/center/grades?month=2026-11', headers: { cookie: cookies.branchAdmin } });
    expect(list.statusCode).toBe(200); expect(list.json().items.every((row: { groupId: number }) => row.groupId === groupId)).toBe(true);
  });
  it('does not give a branch admin without a branch center-wide fallback access', async () => {
    expect((await createGrade(payload, 'unassignedAdmin')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/center/grades?month=2026-11', headers: { cookie: cookies.unassignedAdmin } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/center/grades/enrollments?groupId=${groupId}`, headers: { cookie: cookies.unassignedAdmin } })).statusCode).toBe(403);
  });
  it('scopes the enrollment picker by center and denies parent access', async () => {
    const own = await app.inject({ method: 'GET', url: `/api/center/grades/enrollments?groupId=${groupId}`, headers: { cookie: cookies.owner } });
    expect(own.json().students).toEqual([{ id: childId, name: 'Own child <test>' }]);
    expect((await app.inject({ method: 'GET', url: `/api/center/grades/enrollments?groupId=${foreignGroupId}`, headers: { cookie: cookies.owner } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/center/grades/enrollments?groupId=${groupId}`, headers: { cookie: cookies.parent } })).statusCode).toBe(403);
  });
});
