import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { hasPermission } from '../src/permissions.js';

describe('teacher default grade entry', () => {
  const app = buildApp(), users: Record<string, string> = {}, cookies: Record<string, string> = {};
  const own = 996101, unrelated = 996102, foreign = 996103, pupil = 996201, otherPupil = 996202, foreignPupil = 996203;
  let center: string, outside: string, requestNumber = 0;
  const payload = { groupId: own, studentId: pupil, title: 'Teacher assessment', assessedOn: '2026-11-22', score: 0, maxScore: 20 };
  const request = (method: 'GET' | 'POST', url: string, body?: object, who = 'teacher') => app.inject({ method, url, payload: body, remoteAddress: `203.0.113.${++requestNumber}`, headers: { cookie: cookies[who] || '' } });
  const save = (body: object = payload, who = 'teacher') => request('POST', '/api/center/grades', body, who);
  const list = () => request('GET', '/api/center/grades?month=2026-11');
  beforeAll(async () => {
    center = (await prisma.center.create({ data: { slug: 'teacher-grade-entry', name: 'Teaching' } })).id;
    outside = (await prisma.center.create({ data: { slug: 'teacher-grade-outside', name: 'Outside' } })).id;
    for (const [key, role] of [['teacher', 'TEACHER'], ['student', 'STUDENT'], ['parent', 'GUARDIAN']] as const) {
      const user = await prisma.user.create({ data: { centerId: center, role, email: key + '@teacher-grades.test', name: key, passwordHash: 'unusable-fixture', centerMemberships: { create: { centerId: center, role } } } });
      users[key] = user.id;
      const token = 'teacher-grade-fixture-' + key;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId: center, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[key] = 'center_session=' + token;
    }
    for (const id of [own, unrelated, foreign]) {
      const centerId = id === foreign ? outside : center;
      await prisma.teacher.create({ data: { id, centerId, userId: id === own ? users.teacher : null, name: 'Teacher ' + id, subject: 'Math' } });
      await prisma.group.create({ data: { id, centerId, teacherId: id, grade: 'Class ' + id, days: 'Sunday', time: '10:00', price: 100 } });
    }
    for (const id of [pupil, otherPupil, foreignPupil]) await prisma.student.create({ data: { id, centerId: id === foreignPupil ? outside : center, userId: id === pupil ? users.student : null, name: 'Student ' + id } });
    await prisma.enrollment.createMany({ data: [{ studentId: pupil, groupId: own }, { studentId: pupil, groupId: unrelated }, { studentId: pupil, groupId: foreign }, { studentId: otherPupil, groupId: unrelated }, { studentId: foreignPupil, groupId: own }] });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  it('grants entry but not result publication by default', () => {
    expect(hasPermission('TEACHER', 'academic.manage_grades')).toBe(true);
    expect(hasPermission('TEACHER', 'academic.publish_results')).toBe(false);
  });
  it('returns a dedicated scoped group picker and enrolled same-center pupils', async () => {
    const result = await list(); expect(result.statusCode).toBe(200);
    expect(result.json().groups.map((g: { groupId: number }) => g.groupId)).toEqual([own]);
    const enrolled = await request('GET', `/api/center/grades/enrollments?groupId=${own}`);
    expect(enrolled.json().students.map((s: { id: number }) => s.id)).toEqual([pupil]);
    for (const id of [unrelated, foreign]) expect((await request('GET', `/api/center/grades/enrollments?groupId=${id}`)).statusCode).toBe(404);
  });
  it('records a real zero with the teacher identity and an atomic audit', async () => {
    const result = await save(); expect(result.statusCode).toBe(201);
    const id = result.json().grade.id;
    expect(await prisma.gradeRecord.findUnique({ where: { id } })).toMatchObject({ score: 0, recordedById: users.teacher, examId: null });
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'grades.record', userId: users.teacher } })).toBe(1);
    expect((await list()).json().items).toEqual([expect.objectContaining({ id, score: 0, groupId: own })]);
  });
  it.each([{ groupId: unrelated }, { groupId: foreign }, { studentId: otherPupil }, { studentId: foreignPupil }])('rejects unrelated or corrupt targets %j without writes', async change => {
    const before = await prisma.gradeRecord.count();
    expect((await save({ ...payload, ...change })).statusCode).toBe(422);
    expect(await prisma.gradeRecord.count()).toBe(before);
  });
  it('does not expose unrelated grade records for the same shared pupil', async () => {
    const record = await prisma.gradeRecord.create({ data: { ...payload, groupId: unrelated, recordedById: users.teacher, title: 'Other teacher private assessment' } });
    try { expect(JSON.stringify((await list()).json())).not.toContain(record.id); }
    finally { await prisma.gradeRecord.delete({ where: { id: record.id } }); }
  });
  it('rechecks group assignment on each read and write', async () => {
    await prisma.group.update({ where: { id: own }, data: { teacherId: unrelated } });
    try { expect((await list()).json()).toMatchObject({ groups: [], items: [] }); expect((await save()).statusCode).toBe(422); }
    finally { await prisma.group.update({ where: { id: own }, data: { teacherId: own } }); }
  });
  it('fails closed for a teacher profile in the wrong center or no linked profile', async () => {
    for (const data of [{ centerId: outside }, { centerId: center, userId: null }]) {
      await prisma.teacher.update({ where: { id: own }, data });
      try { expect((await list()).json()).toMatchObject({ groups: [], items: [] }); expect((await save()).statusCode).toBe(422); }
      finally { await prisma.teacher.update({ where: { id: own }, data: { centerId: center, userId: users.teacher } }); }
    }
  });
  it('honors an explicit grade denial and inactive center membership', async () => {
    await prisma.userPermission.create({ data: { userId: users.teacher, permissionKey: 'academic.manage_grades', allowed: false } });
    try { expect((await list()).statusCode).toBe(403); expect((await save()).statusCode).toBe(403); }
    finally { await prisma.userPermission.deleteMany({ where: { userId: users.teacher } }); }
    await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.teacher, centerId: center } }, data: { active: false } });
    try { expect((await list()).statusCode).toBe(403); expect((await save()).statusCode).toBe(403); }
    finally { await prisma.centerMembership.update({ where: { userId_centerId: { userId: users.teacher, centerId: center } }, data: { active: true } }); }
  });
  it.each(['student', 'parent'])('does not turn a %s permission override into staff access', async who => {
    await prisma.userPermission.create({ data: { userId: users[who], permissionKey: 'academic.manage_grades', allowed: true } });
    try {
      expect((await request('GET', '/api/center/grades?month=2026-11', undefined, who)).statusCode).toBe(403);
      expect((await request('GET', `/api/center/grades/enrollments?groupId=${own}`, undefined, who)).statusCode).toBe(403);
      expect((await save(payload, who)).statusCode).toBe(403);
    } finally { await prisma.userPermission.deleteMany({ where: { userId: users[who] } }); }
  });
  it('rolls the grade back if its audit cannot be saved', async () => {
    const before = await prisma.gradeRecord.count();
    await prisma.$executeRawUnsafe("CREATE TRIGGER teacher_grade_audit_failure BEFORE INSERT ON AuditLog WHEN NEW.action = 'grades.record' BEGIN SELECT RAISE(FAIL, 'fixture failure'); END");
    try { expect((await save()).statusCode).toBe(500); expect(await prisma.gradeRecord.count()).toBe(before); }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER teacher_grade_audit_failure'); }
  });
});

describe('teacher grade client state', () => {
  const html = readFileSync('center-admin-v2.html', 'utf8');
  const code = html.slice(html.indexOf('function gradeEntryCurrent('), html.indexOf('function renderGradesView('));
  it.each(['loadGradeRecords', 'gradeGroupChanged'])('ignores a stale %s response after account change', async method => {
    let resolve!: (data: unknown) => void;
    const old = { sequence: 0, enrollmentSequence: 0, draft: {}, items: [], groups: [], students: [] };
    const context: any = { GRADE_ENTRY: old, STATE: { currentUser: { id: 'old' } }, refreshMonthlyView() {}, api: () => new Promise(r => { resolve = r; }) };
    runInNewContext(code, context); context[method]('1');
    context.GRADE_ENTRY = {}; context.STATE.currentUser = { id: 'new' };
    resolve({ items: ['private'], groups: ['private'], students: ['private'] });
    await new Promise(r => setImmediate(r));
    expect(old.items).toEqual([]); expect(old.groups).toEqual([]); expect(old.students).toEqual([]);
  });
  it('uses named form elements rather than the native form title property', () => {
    expect(code).toContain("form.namedItem('title').value.trim()");
    expect(code).not.toContain('form.title.value');
  });
});
