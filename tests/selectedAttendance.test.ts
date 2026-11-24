import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/server.js';
import { attendanceStudentId } from '../src/selectedAttendance.js';
import { prisma } from '../src/prisma.js';

describe('fixed pupil code in an explicitly selected class and day', () => {
  const app = buildApp();
  const pupil = 970001, ownOnly = 970002, foreignPupil = 970003, notEnrolled = 970004, siblingPupil = 970005;
  const groupA = 970101, groupA2 = 970102, groupB = 970103, groupForeign = 970104, corruptGroup = 970105;
  let center: string, foreignCenter: string, branchA: string, branchB: string, foreignBranch: string;
  const users: Record<string, string> = {}, cookies: Record<string, string> = {};
  let requestCount = 0;
  const request = (method: 'GET'|'POST', url: string, payload?: object, who = 'owner') => app.inject({ method, url, remoteAddress: `198.51.100.${++requestCount % 250 + 1}`, headers: { cookie: cookies[who] || '' }, ...(payload ? { payload } : {}) });
  const scan = (code = `STUDENT:${pupil}`, groupId = groupA, date = '2026-11-22', who = 'owner') => request('POST', '/api/center/attendance/selected/scan', { code, groupId, date }, who);
  const roster = (who = 'owner', groupId = groupA, date = '2026-11-22') => request('GET', `/api/center/attendance/selected?groupId=${groupId}&date=${date}`, undefined, who);
  const record = (who = 'owner', groupId = groupA, studentId = ownOnly) => request('POST', '/api/center/attendance/selected/record', { studentId, groupId, date: '2026-11-24', status: 'EXCUSED' }, who);
  beforeAll(async () => {
    center = (await prisma.center.create({ data: { slug: 'selected-attendance-a', name: 'Selected class A' } })).id;
    foreignCenter = (await prisma.center.create({ data: { slug: 'selected-attendance-b', name: 'Other center' } })).id;
    branchA = (await prisma.branch.create({ data: { centerId: center, name: 'A' } })).id;
    branchB = (await prisma.branch.create({ data: { centerId: center, name: 'B' } })).id;
    foreignBranch = (await prisma.branch.create({ data: { centerId: foreignCenter, name: 'Foreign' } })).id;
    for (const [key, role, branchId] of [['owner', 'CENTER_OWNER', branchA], ['manager', 'BRANCH_ADMIN', branchA], ['missingBranch', 'BRANCH_ADMIN', null], ['badBranch', 'BRANCH_ADMIN', foreignBranch], ['teacher', 'TEACHER', null], ['unlinkedTeacher', 'TEACHER', null], ['badTeacher', 'TEACHER', null], ['reception', 'RECEPTIONIST', branchA], ['student', 'STUDENT', null], ['guardian', 'GUARDIAN', null], ['accountant', 'ACCOUNTANT', null]] as const) {
      const user = await prisma.user.create({ data: { centerId: center, branchId, role, name: key, email: `${key}@selected-attendance.test`, passwordHash: 'unusable-test-fixture', centerMemberships: { create: { centerId: center, role } } } });
      users[key] = user.id; const token = `selected-attendance-${key}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId: center, expiresAt: new Date(Date.now() + 3600000) } }); cookies[key] = `center_session=${token}`;
    }
    for (const [id, centerId, branchId, userId] of [[970201, center, branchA, users.teacher], [970202, center, branchB, null], [970203, foreignCenter, foreignBranch, users.badTeacher]] as const) {
      await prisma.teacher.create({ data: { id, centerId, branchId, userId, name: `Teacher ${id}`, subject: 'Math' } });
    }
    for (const [id, centerId, branchId, teacherId] of [[groupA, center, branchA, 970201], [groupA2, center, branchA, 970201], [groupB, center, branchB, 970202], [groupForeign, foreignCenter, foreignBranch, 970203], [corruptGroup, center, branchA, 970203]] as const) {
      await prisma.group.create({ data: { id, centerId, branchId, teacherId, grade: `Class ${id}`, time: '15:00', days: 'Sunday', price: 100 } });
    }
    for (const [id, centerId, branchId] of [[pupil, center, branchB], [ownOnly, center, branchA], [foreignPupil, foreignCenter, foreignBranch], [notEnrolled, center, branchA], [siblingPupil, center, branchB]] as const) {
      await prisma.student.create({ data: { id, centerId, branchId, name: `Pupil ${id}`, ...(id === pupil ? { userId: users.student } : {}) } });
    }
    await prisma.enrollment.createMany({ data: [{ studentId: pupil, groupId: groupA }, { studentId: pupil, groupId: groupB }, { studentId: pupil, groupId: corruptGroup }, { studentId: ownOnly, groupId: groupA }, { studentId: foreignPupil, groupId: groupA }, { studentId: foreignPupil, groupId: groupForeign }, { studentId: siblingPupil, groupId: groupB }] });
    await prisma.guardian.create({ data: { centerId: center, userId: users.guardian, name: 'Linked guardian', children: { create: [{ studentId: pupil, relation: 'parent' }, { studentId: foreignPupil, relation: 'legacy' }] } } });
    // An automatic kiosk choice would prefer this other class. The new route must not.
    await prisma.lessonSession.create({ data: { groupId: groupB, date: '2026-11-22', startsAt: '09:00', endsAt: '10:00' } });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('loads the real group roster and never invents a present status', async () => {
    const result = await roster(); expect(result.statusCode).toBe(200);
    expect(result.json().students).toEqual([{ id: pupil, name: `Pupil ${pupil}`, code: `STUDENT:${pupil}`, status: null }, { id: ownOnly, name: `Pupil ${ownOnly}`, code: `STUDENT:${ownOnly}`, status: null }]);
  });
  it('uses the same code in two enrolled groups but only writes the explicitly chosen group/date', async () => {
    const first = await scan(); expect(first.statusCode).toBe(200); expect(first.json().group.id).toBe(groupA);
    expect(await prisma.attendance.findUnique({ where: { studentId_groupId_date: { studentId: pupil, groupId: groupB, date: '2026-11-22' } } })).toBeNull();
    const second = await scan(`STUDENT:${pupil}`, groupB, '2026-11-23'); expect(second.statusCode).toBe(200);
    expect(first.json().student.code).toBe(second.json().student.code);
    expect((await prisma.attendance.findMany({ where: { studentId: pupil } })).map(row => [row.groupId, row.date]).sort()).toEqual([[groupA, '2026-11-22'], [groupB, '2026-11-23']]);
  });
  it('keeps repeat scans to one attendance record and reports the repeated state', async () => {
    const result = await scan(); expect(result.json().repeated).toBe(true);
    expect(await prisma.attendance.count({ where: { studentId: pupil, groupId: groupA, date: '2026-11-22' } })).toBe(1);
  });
  it('returns the recorded date-specific status and no finance or contact data', async () => {
    const result = await roster(); expect(result.json().students[0].status).toBe('PRESENT');
    expect(result.json().students[1].status).toBeNull(); expect(JSON.stringify(result.json())).not.toMatch(/subscription|isPaid|phone|parent|price/);
    expect((await roster('owner', groupA, '2026-11-21')).json().students[0].status).toBeNull();
  });
  it('accepts numeric and canonical student code forms', () => {
    for (const code of ['970001', '#970001', 'STUDENT:970001', 'student:970001', ' STUDENT:970001 ']) expect(attendanceStudentId(code)).toBe(pupil);
  });
  it.each(['x:970001', '1e3', '970001.0', '-1', '0', 'STUDENT:', '9007199254740993', '2147483648', '970001 trailing', '970001:970101'])('rejects malformed code %s', async (code) => {
    expect((await scan(code)).statusCode).toBe(422);
  });
  it.each(['2026-02-30', '2026-13-01', '26-11-22', '2026-11-22T10:00:00Z'])('rejects invalid selected date %s', async (date) => { expect((await scan(undefined, undefined, date)).statusCode).toBe(422); expect((await roster('owner', groupA, date)).statusCode).toBe(422); });
  it('requires a selected group and date instead of falling back to a lesson or first enrollment', async () => {
    for (const payload of [{ code: String(pupil) }, { code: String(pupil), groupId: groupA }, { code: String(pupil), date: '2026-11-22' }, { code: String(pupil), groupId: 0, date: '2026-11-22' }]) expect((await request('POST', '/api/center/attendance/selected/scan', payload)).statusCode).toBe(422);
  });
  it.each([notEnrolled, foreignPupil])('rejects a non-enrolled or foreign-center pupil %s without adding enrollment', async (studentId) => {
    const before = await prisma.enrollment.count({ where: { studentId } });
    expect((await scan(String(studentId))).statusCode).toBe(404);
    expect(await prisma.enrollment.count({ where: { studentId } })).toBe(before);
    expect(await prisma.attendance.count({ where: { studentId } })).toBe(0);
  });
  it('does not fall back to the other class when the pupil is not enrolled in the selected class', async () => { expect((await scan(String(pupil), groupA2)).statusCode).toBe(404); });
  it('allows a cross-home-branch pupil in the primary branch class', async () => { expect((await scan(undefined, groupA, '2026-11-25', 'manager')).statusCode).toBe(200); expect((await roster('manager')).json().students.map((row: {id:number}) => row.id)).toContain(pupil); });
  it('does not narrow a center owner to the branch on their account', async () => { expect((await roster('owner', groupB)).statusCode).toBe(200); });
  it('rejects a sibling branch even with an additional active membership', async () => {
    await prisma.branchMembership.create({ data: { userId: users.manager, branchId: branchB } });
    try { expect((await roster('manager', groupB)).statusCode).toBe(404); expect((await scan(undefined, groupB, '2026-11-26', 'manager')).statusCode).toBe(404); expect((await record('manager', groupB, pupil)).statusCode).toBe(404); }
    finally { await prisma.branchMembership.delete({ where: { userId_branchId: { userId: users.manager, branchId: branchB } } }); }
  });
  it.each(['missingBranch', 'badBranch'])('never gives center-wide fallback to %s', async (who) => { expect([403, 404]).toContain((await roster(who)).statusCode); expect([403, 404]).toContain((await scan(undefined, undefined, undefined, who)).statusCode); });
  it('honors an explicitly inactive primary-branch membership', async () => {
    await prisma.branchMembership.create({ data: { userId: users.manager, branchId: branchA, active: false } });
    try { expect([403, 404]).toContain((await roster('manager')).statusCode); expect([403, 404]).toContain((await scan(undefined, undefined, undefined, 'manager')).statusCode); }
    finally { await prisma.branchMembership.delete({ where: { userId_branchId: { userId: users.manager, branchId: branchA } } }); }
  });
  it('keeps teacher reads assigned and denies all teacher recording', async () => {
    expect((await roster('teacher')).statusCode).toBe(200); expect((await scan(undefined, groupA, '2026-11-26', 'teacher')).statusCode).toBe(403);
    expect((await roster('teacher', groupB)).statusCode).toBe(404); expect((await scan(undefined, groupB, '2026-11-26', 'teacher')).statusCode).toBe(403);
    expect((await record('teacher', groupB, pupil)).statusCode).toBe(403);
  });
  it.each(['unlinkedTeacher', 'badTeacher'])('does not trust a missing or cross-center teacher profile for %s', async (who) => { expect((await roster(who, corruptGroup)).statusCode).toBe(404); expect((await scan(undefined, corruptGroup, '2026-11-26', who)).statusCode).toBe(403); });
  it.each(['student', 'guardian'])('exposes only self/linked pupils in the roster for %s and never enables self-marking', async (who) => {
    const result = await roster(who); expect(result.statusCode).toBe(200); expect(result.json().students.map((row: {id:number}) => row.id)).toEqual([pupil]);
    expect((await roster(who, groupA2)).statusCode).toBe(404);
    await prisma.userPermission.create({ data: { userId: users[who], permissionKey: 'attendance.create', allowed: true } });
    try { expect((await scan(undefined, undefined, undefined, who)).statusCode).toBe(403); expect((await record(who)).statusCode).toBe(403); }
    finally { await prisma.userPermission.delete({ where: { userId_permissionKey: { userId: users[who], permissionKey: 'attendance.create' } } }); }
  });
  it('requires active center membership for both reads and writes', async () => {
    await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.owner, centerId: center } }, data: { active: false } });
    try { expect((await roster()).statusCode).toBe(403); expect((await scan()).statusCode).toBe(403); }
    finally { await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.owner, centerId: center } }, data: { active: true } }); }
  });
  it.each([['owner', 'attendance.view', 'GET'], ['owner', 'groups.view', 'GET'], ['teacher', 'students.view_assigned', 'GET'], ['owner', 'attendance.create', 'POST']] as const)('honors explicit %s %s denial', async (who, permissionKey, method) => {
    await prisma.userPermission.create({ data: { userId: users[who], permissionKey, allowed: false } });
    try { expect((method === 'GET' ? await roster(who) : await scan(undefined, undefined, undefined, who)).statusCode).toBe(403); }
    finally { await prisma.userPermission.delete({ where: { userId_permissionKey: { userId: users[who], permissionKey } } }); }
  });
  it('does not let default accountant permissions or an unauthenticated visitor write attendance', async () => { expect((await scan(undefined, undefined, undefined, 'accountant')).statusCode).toBe(403); expect((await scan(undefined, undefined, undefined, 'nobody')).statusCode).toBe(401); });
  it('records manual corrections through the same scoped enrollment and audited route', async () => { const result = await record('reception'); expect(result.statusCode).toBe(200); expect(result.json().attendance.status).toBe('EXCUSED'); });
  it.each(['scan', 'record'])('rolls the %s write back when the audit fails', async (kind) => {
    const date = '2026-11-27';
    await prisma.attendance.upsert({ where: { studentId_groupId_date: { studentId: ownOnly, groupId: groupA, date } }, create: { studentId: ownOnly, groupId: groupA, date, status: 'ABSENT' }, update: { status: 'ABSENT' } });
    await prisma.$executeRawUnsafe("CREATE TRIGGER selected_attendance_audit_failure BEFORE INSERT ON AuditLog WHEN NEW.action LIKE 'attendance.selected_%' BEGIN SELECT RAISE(FAIL, 'selected audit failure'); END");
    try {
      const result = kind === 'scan' ? await scan(String(ownOnly), groupA, date) : await request('POST', '/api/center/attendance/selected/record', { studentId: ownOnly, groupId: groupA, date, status: 'LATE' });
      expect(result.statusCode).toBe(500); expect((await prisma.attendance.findUniqueOrThrow({ where: { studentId_groupId_date: { studentId: ownOnly, groupId: groupA, date } } })).status).toBe('ABSENT');
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER selected_attendance_audit_failure'); }
  });
  it('does not omit an enrolled pupil beyond the first global student page', async () => {
    await prisma.student.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ id: 971000 + index, name: `Unrelated ${index}`, centerId: center })) });
    await prisma.student.create({ data: { id: 979999, name: 'ZZ Last enrolled pupil', centerId: center, enrollments: { create: { groupId: groupA } } } });
    expect((await roster()).json().students.map((row: {id:number}) => row.id)).toContain(979999);
  });
  it('uses selected server roster/statuses rather than the first global cache or automatic kiosk', () => {
    const html = readFileSync('center-admin-v2.html', 'utf8'); const view = html.slice(html.indexOf('/* 7. ATTENDANCE MATRIX VIEW'), html.indexOf('/* 8. FINTECH'));
    expect(view).toContain('/api/center/attendance/selected?groupId='); expect(view).toContain("'/api/center/attendance/selected/'"); expect(view).not.toContain('STATE.students'); expect(view).not.toContain('/api/center/attendance/scan'); expect(view).toContain('لم يسجل بعد'); expect(view).toContain('Promise.allSettled');
  });
  it('rejects teacher writes through every attendance entry point, including import permission overrides', async () => {
    const permissions = ['attendance.create', 'attendance.update', 'settings.manage'];
    for (const permissionKey of permissions) await prisma.userPermission.create({ data: { userId: users.teacher, permissionKey, allowed: true } });
    const before = await prisma.attendance.count(), audits = await prisma.auditLog.count();
    try {
      for (const [url, body] of [
        ['/api/center/attendance', { studentId: pupil, groupId: groupA, date: '2026-12-02', status: 'ABSENT' }],
        ['/api/center/attendance/scan', { code: String(pupil) }],
        ['/api/center/attendance/selected/scan', { code: String(pupil), groupId: groupA, date: '2026-12-02' }],
        ['/api/center/attendance/selected/record', { studentId: pupil, groupId: groupA, date: '2026-12-02', status: 'PRESENT' }],
        ['/api/legacy/import', { att: { [groupA + '|2026-12-02']: { [pupil]: 'a' } } }],
        ['/api/import/excel', {}],
      ] as const) expect((await request('POST', url, body, 'teacher')).statusCode, url).toBe(403);
      expect(await prisma.attendance.count()).toBe(before); expect(await prisma.auditLog.count()).toBe(audits);
    } finally { await prisma.userPermission.deleteMany({ where: { userId: users.teacher, permissionKey: { in: permissions } } }); }
  });
  it('returns daily counts and only explicitly absent names in the current teacher roster', async () => {
    const day = '2026-12-01';
    for (const [offset, status] of ['PRESENT', 'LATE', 'EXCUSED', 'unrecognized', null].entries()) {
      const studentId = 979001 + offset; await prisma.student.create({ data: { id: studentId, centerId: center, name: 'Summary pupil ' + offset, phone: 'not-for-summary' } });
      await prisma.enrollment.create({ data: { studentId, groupId: groupA } });
      if (status) await prisma.attendance.create({ data: { studentId, groupId: groupA, date: day, status } });
    }
    for (const [studentId, groupId, status] of [[pupil, groupA, 'a'], [ownOnly, groupA, 'p'], [foreignPupil, groupA, 'ABSENT'], [siblingPupil, groupB, 'ABSENT'], [pupil, groupB, 'ABSENT']] as const) await prisma.attendance.create({ data: { studentId, groupId, date: day, status } });
    const res = await request('GET', '/api/center/attendance/teacher-summary?date=' + day, undefined, 'teacher'); expect(res.statusCode).toBe(200);
    const body = res.json(); expect(body.basis).toBe('CURRENT_ENROLLMENTS'); expect(body.availableGroups.map((group: { id: number }) => group.id)).toEqual([groupA, groupA2]);
    expect(body.summary).toEqual({ total: 8, present: 2, absent: 1, late: 1, excused: 1, unknown: 1, unrecorded: 2 });
    expect(body.absentees).toEqual([{ id: pupil, name: 'Pupil ' + pupil, groupId: groupA, group: 'Class ' + groupA }]); expect(JSON.stringify(body)).not.toMatch(/not-for-summary|phone|parent|price/);
    const filtered = await request('GET', '/api/center/attendance/teacher-summary?date=' + day + '&groupId=' + groupA2, undefined, 'teacher'); expect(filtered.json().summary.total).toBe(0); expect(filtered.json().absentees).toEqual([]);
    expect((await request('GET', '/api/center/attendance/teacher-summary?date=2026-12-03', undefined, 'teacher')).json().summary).toMatchObject({ total: 8, absent: 0, unrecorded: 8 });
  });
  it.each([groupB, groupForeign, corruptGroup])('does not expose an unassigned summary group %s', async groupId => { expect((await request('GET', '/api/center/attendance/teacher-summary?date=2026-12-01&groupId=' + groupId, undefined, 'teacher')).statusCode).toBe(404); });
  it.each(['student', 'guardian', 'owner', 'nobody'])('does not expose the teacher summary to %s', async who => { expect((await request('GET', '/api/center/attendance/teacher-summary?date=2026-12-01', undefined, who)).statusCode).toBe(who === 'nobody' ? 401 : 403); });
  it.each(['', '?date=2026-02-30', '?date=2026-13-01', '?date=2026-12-01&centerId=other'])('validates teacher summary selection %s', async query => { expect((await request('GET', '/api/center/attendance/teacher-summary' + query, undefined, 'teacher')).statusCode).toBe(422); });
  it('rechecks teacher assignment and active membership for every summary read', async () => {
    await prisma.group.update({ where: { id: groupA }, data: { teacherId: 970202 } });
    try { expect((await request('GET', '/api/center/attendance/teacher-summary?date=2026-12-01&groupId=' + groupA, undefined, 'teacher')).statusCode).toBe(404); }
    finally { await prisma.group.update({ where: { id: groupA }, data: { teacherId: 970201 } }); }
    await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.teacher, centerId: center } }, data: { active: false } });
    try { expect((await request('GET', '/api/center/attendance/teacher-summary?date=2026-12-01', undefined, 'teacher')).statusCode).toBe(403); }
    finally { await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.teacher, centerId: center } }, data: { active: true } }); }
  });

});
