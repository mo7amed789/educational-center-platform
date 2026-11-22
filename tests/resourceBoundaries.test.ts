import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('tenant boundaries for import, finance and teacher deletion', () => {
  const app = buildApp();
  const teacherA = 930001, teacherB = 930003, deletableA = 930002, deletableB = 930004;
  const childA = 930001, unrelatedA = 930002, childB = 930003, unenrolledA = 930004;
  const groupA = 930001, groupB = 930003;
  let centerA: string, centerB: string;
  const users: Record<string, string> = {}, cookies: Record<string, string> = {};
  beforeAll(async () => {
    centerA = (await prisma.center.create({ data: { slug: 'audit-a', name: 'Audit A' } })).id;
    centerB = (await prisma.center.create({ data: { slug: 'audit-b', name: 'Audit B' } })).id;
    for (const [key, role, centerId] of [['ownerA', 'CENTER_OWNER', centerA], ['ownerB', 'CENTER_OWNER', centerB], ['parentA', 'GUARDIAN', centerA]] as const) {
      const user = await prisma.user.create({ data: { centerId, role, name: key, email: `${key}@audit.test`, passwordHash: 'unusable-test-only', centerMemberships: { create: { centerId, role } } } });
      users[key] = user.id;
      const token = `audit-session-test-${key}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[key] = `center_session=${token}`;
    }
    await prisma.teacher.createMany({ data: [{ id: teacherA, centerId: centerA, name: 'Teacher A', subject: 'Math' }, { id: teacherB, centerId: centerB, name: 'Teacher B', subject: 'Science' }, { id: deletableA, centerId: centerA, name: 'Deletable A', subject: 'Math' }, { id: deletableB, centerId: centerB, name: 'Deletable B', subject: 'Science' }] });
    await prisma.group.createMany({ data: [{ id: groupA, centerId: centerA, teacherId: teacherA, grade: 'Group A', days: 'Sunday', time: '10:00', price: 100 }, { id: groupB, centerId: centerB, teacherId: teacherB, grade: 'Group B', days: 'Monday', time: '12:00', price: 200 }] });
    await prisma.student.createMany({ data: [{ id: childA, centerId: centerA, name: 'Own child' }, { id: unrelatedA, centerId: centerA, name: 'Other child' }, { id: childB, centerId: centerB, name: 'Foreign child' }, { id: unenrolledA, centerId: centerA, name: 'Unenrolled child' }] });
    await prisma.enrollment.createMany({ data: [{ studentId: childA, groupId: groupA }, { studentId: unrelatedA, groupId: groupA }, { studentId: childB, groupId: groupB }] });
    const guardian = await prisma.guardian.create({ data: { centerId: centerA, userId: users.parentA, name: 'Parent A' } });
    await prisma.studentGuardian.createMany({ data: [{ guardianId: guardian.id, studentId: childA, relation: 'parent' }, { guardianId: guardian.id, studentId: childB, relation: 'invalid-legacy-link' }] });
    await prisma.payment.createMany({ data: [{ studentId: childA, groupId: groupA, month: '2026-11', amount: 10, status: 'paid' }, { studentId: unrelatedA, groupId: groupA, month: '2026-11', amount: 20, status: 'paid' }, { studentId: childB, groupId: groupB, month: '2026-11', amount: 30, status: 'paid' }, { studentId: childB, groupId: groupA, month: '2026-11', amount: 40, status: 'paid' }] });
    await prisma.subscription.create({ data: { studentId: childB, groupId: groupB, month: '2026-11', amount: 200, dueOn: '2026-11-10', status: 'paid' } });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  const post = (url: string, payload: object, who = 'ownerA') => app.inject({ method: 'POST', url, payload, headers: { cookie: cookies[who] } });
  const legacy = (payload: object) => post('/api/legacy/import', payload);
  const getPayments = (who: string) => app.inject({ method: 'GET', url: '/api/center/payments?month=2026-11', headers: { cookie: cookies[who] } });
  const payment = { studentId: childA, groupId: groupA, month: '2026-11', amount: 100, method: 'CASH' };
  async function workbookImport(subscriptions: object[], teachers: object[] = []) {
    const workbook = new ExcelJS.Workbook();
    for (const [name, rows] of [['Subscriptions', subscriptions], ['Teachers', teachers]] as const) {
      if (!rows.length) continue;
      const sheet = workbook.addWorksheet(name), keys = Object.keys(rows[0]);
      sheet.addRow(keys); rows.forEach(row => sheet.addRow(keys.map(key => (row as Record<string, unknown>)[key])));
    }
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const boundary = 'audit-multipart-boundary';
    return app.inject({ method: 'POST', url: '/api/import/excel', headers: { cookie: cookies.ownerA, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audit.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), buffer, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
  }
  it('returns only own-child payments to a guardian, even with corrupt cross-center links', async () => {
    const result = await getPayments('parentA'); expect(result.statusCode).toBe(200);
    expect(result.json().payments.map((row: { studentId: number }) => row.studentId)).toEqual([childA]);
  });
  it('keeps staff payment reads inside both student and group centers', async () => {
    const result = await getPayments('ownerA'); expect(result.statusCode).toBe(200);
    expect(result.json().payments.map((row: { studentId: number }) => row.studentId).sort()).toEqual([childA, unrelatedA]);
  });
  it.each([deletableB, 99999999])('hides foreign/unknown teacher %i without deleting or auditing', async (id) => {
    const before = await prisma.teacher.findUnique({ where: { id } });
    const auditCount = await prisma.auditLog.count({ where: { action: 'teachers.delete' } });
    const result = await app.inject({ method: 'DELETE', url: `/api/teachers/${id}`, headers: { cookie: cookies.ownerA } });
    expect(result.statusCode).toBe(404); expect(result.json()).toEqual({ error: 'TEACHER_NOT_FOUND' });
    expect(await prisma.teacher.findUnique({ where: { id } })).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: 'teachers.delete' } })).toBe(auditCount);
  });
  it('preserves linked teachers and deletes only an unassigned own-center teacher', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/teachers/${teacherA}`, headers: { cookie: cookies.ownerA } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url: `/api/teachers/${deletableA}`, headers: { cookie: cookies.ownerA } })).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'teachers.delete', centerId: centerA, entityId: String(deletableA) } })).toBe(1);
  });
  it.each([['teacher', teacherB], ['group', groupB], ['student', childB]] as const)('does not reassign a foreign %s through a legacy ID collision', async (kind, id) => {
    const before = { teacher: await prisma.teacher.findUnique({ where: { id: teacherB } }), group: await prisma.group.findUnique({ where: { id: groupB } }), student: await prisma.student.findUnique({ where: { id: childB } }) };
    const payload = kind === 'teacher' ? { teachers: [{ id, name: 'Unauthorized replacement', subject: 'Changed' }] } : kind === 'group' ? { teachers: [{ id: teacherA, name: 'Must roll back too', subject: 'Math' }], groups: [{ id, t: teacherA, grade: 'Changed', time: '10:00', price: 1 }] } : { students: [{ id, name: 'Unauthorized replacement' }] };
    const ownTeacher = await prisma.teacher.findUnique({ where: { id: teacherA } });
    expect((await legacy(payload)).statusCode).toBe(422);
    expect(await prisma.teacher.findUnique({ where: { id: teacherB } })).toEqual(before.teacher);
    expect(await prisma.group.findUnique({ where: { id: groupB } })).toEqual(before.group);
    expect(await prisma.student.findUnique({ where: { id: childB } })).toEqual(before.student);
    expect(await prisma.teacher.findUnique({ where: { id: teacherA } })).toEqual(ownTeacher);
  });
  it('still supports idempotent same-center legacy import', async () => {
    const data = { teachers: [{ id: teacherA, name: 'Teacher A updated', subject: 'Math' }], groups: [{ id: groupA, t: teacherA, grade: 'Group A', time: '10:00', price: 100 }], students: [{ id: childA, name: 'Own child', g: [groupA] }] };
    expect((await legacy(data)).statusCode).toBe(200); expect((await legacy(data)).statusCode).toBe(200);
    expect(await prisma.enrollment.count({ where: { studentId: childA, groupId: groupA } })).toBe(1);
  });
  it('rejects an Excel subscription for another tenant and rolls back earlier sheets', async () => {
    const original = await prisma.subscription.findUniqueOrThrow({ where: { studentId_groupId_month: { studentId: childB, groupId: groupB, month: '2026-11' } } });
    const result = await workbookImport([{ studentId: childB, groupId: groupB, month: '2026-11', amount: 9999, discount: 0, dueOn: '2026-11-10', status: 'paid' }], [{ id: 930010, name: 'Must not remain', subject: 'Math' }]);
    expect(result.statusCode).toBe(422);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await prisma.teacher.findUnique({ where: { id: 930010 } })).toBeNull();
  });
  it('rejects an unenrolled Excel subscription instead of creating it', async () => {
    const result = await workbookImport([{ studentId: unenrolledA, groupId: groupA, month: '2026-11', amount: 100, discount: 0, dueOn: '2026-11-10', status: 'pending' }]);
    expect(result.statusCode).toBe(422); expect(await prisma.subscription.count({ where: { studentId: unenrolledA } })).toBe(0);
  });
  it('rolls a valid earlier Excel subscription back when a later row targets another center', async () => {
    const result = await workbookImport([
      { studentId: childA, groupId: groupA, month: '2026-09', amount: 100, discount: 0, dueOn: '2026-09-10', status: 'pending' },
      { studentId: childB, groupId: groupB, month: '2026-09', amount: 200, discount: 0, dueOn: '2026-09-10', status: 'pending' },
    ]);
    expect(result.statusCode).toBe(422);
    expect(await prisma.subscription.count({ where: { month: '2026-09', studentId: childA } })).toBe(0);
  });
  it('rejects malformed subscription rows rather than silently skipping them', async () => {
    expect((await workbookImport([{ studentId: childA, groupId: groupA, month: 'invalid', amount: 100, discount: 0, dueOn: '2026-11-10', status: 'pending' }])).statusCode).toBe(422);
  });
  it('rolls legacy data back when its audit write fails', async () => {
    await prisma.$executeRawUnsafe("CREATE TRIGGER audit_legacy_fail BEFORE INSERT ON AuditLog WHEN NEW.action = 'legacy.import' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    try { expect((await legacy({ teachers: [{ id: 930011, name: 'Rollback teacher', subject: 'Math' }] })).statusCode).toBe(422); }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER audit_legacy_fail'); }
    expect(await prisma.teacher.findUnique({ where: { id: 930011 } })).toBeNull();
  });
  it('imports a valid own-center subscription', async () => {
    expect((await workbookImport([{ studentId: childA, groupId: groupA, month: '2026-10', amount: 100, discount: 0, dueOn: '2026-10-10', status: 'pending' }])).statusCode).toBe(200);
  });
  it.each([childB, unenrolledA])('rejects payment for foreign or unenrolled student %i without writes', async (studentId) => {
    const beforePayments = await prisma.payment.findMany({ orderBy: { id: 'asc' } });
    const beforeSubscriptions = await prisma.subscription.findMany({ orderBy: { id: 'asc' } });
    expect((await post('/api/center/payments', { ...payment, studentId })).statusCode).toBe(422);
    expect(await prisma.payment.findMany({ orderBy: { id: 'asc' } })).toEqual(beforePayments);
    expect(await prisma.subscription.findMany({ orderBy: { id: 'asc' } })).toEqual(beforeSubscriptions);
  });
  it('records a valid same-center enrolled payment with its audit', async () => {
    const result = await post('/api/center/payments', payment); expect(result.statusCode).toBe(200);
    expect(result.json().subscription.status).toBe('paid');
    expect(await prisma.auditLog.count({ where: { action: 'finance.payment', entityId: result.json().payment.id, centerId: centerA } })).toBe(1);
  });
  it('rolls payment and subscription changes back when the audit write fails', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { studentId_groupId_month: { studentId: childA, groupId: groupA, month: '2026-11' } } });
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { studentId_groupId_month: { studentId: childA, groupId: groupA, month: '2026-11' } } });
    await prisma.$executeRawUnsafe("CREATE TRIGGER audit_payment_fail BEFORE INSERT ON AuditLog WHEN NEW.action = 'finance.payment' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    try { expect((await post('/api/center/payments', { ...payment, amount: 150 })).statusCode).toBe(500); }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER audit_payment_fail'); }
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).toEqual(subscription);
  });
});
