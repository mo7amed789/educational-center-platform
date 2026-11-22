import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from './auth.js';
import { authorize } from './authorization.js';
import { prisma } from './prisma.js';
import { assignedGroupScope, studentScope } from './resourceScopes.js';
import { attendanceStudentId } from './selectedAttendance.js';
import { attendanceStatus } from './learningReports.js';

const staff = ['SUPER_ADMIN', 'CENTER_OWNER', 'CENTER_ADMIN', 'BRANCH_ADMIN', 'RECEPTIONIST'];
const id = z.coerce.number().int().positive().max(2147483647);
const month = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);
const limit = 200;
const page = <T>(rows: T[]) => ({ items: rows.slice(0, limit), truncated: rows.length > limit, limit });
export function registerKioskStudentRoutes(app: FastifyInstance) {
  app.get('/api/center/kiosk/students', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !staff.includes(user.role) || !await authorize(user.id, 'students.view', { centerId: user.centerId })) return reply.code(403).send({ error: 'FORBIDDEN' });
    const parsed = z.object({ search: z.string().trim().min(1).max(100) }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(422).send({ error: 'INVALID_SEARCH' });
    const search = parsed.data.search, studentId = attendanceStudentId(search);
    if (studentId === null && /^(?:STUDENT:|#|[-+]?\d|[-+]$)/i.test(search)) return reply.code(422).send({ error: 'INVALID_STUDENT_CODE' });
    const items = await prisma.student.findMany({ where: { ...studentScope(user), ...(studentId ? { id: studentId } : { name: { contains: search } }) }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 21 });
    return reply.header('Cache-Control', 'no-store').send({ items: items.slice(0, 20), hasMore: items.length > 20, limit: 20, exactCode: studentId !== null });
  });
  app.get('/api/center/kiosk/students/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !staff.includes(user.role) || !await authorize(user.id, 'students.view', { centerId: user.centerId })) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id }).strict().safeParse(request.params), query = z.object({ month }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(422).send({ error: 'INVALID_SELECTION' });
    const centerId = user.centerId, studentId = params.data.id;
    const can = (permission: Parameters<typeof authorize>[1]) => authorize(user.id, permission, { centerId });
    const capabilities = { groups: await can('groups.view'), attendance: await can('attendance.view'), academic: await can('academic.view'), finance: await can('finance.view') };
    const [year, number] = query.data.month.split('-').map(Number), range = { gte: query.data.month + '-01', lt: number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, '0')}-01` };
    const result = await prisma.$transaction(async tx => {
      const student = await tx.student.findFirst({ where: { id: studentId, ...studentScope(user) }, select: { id: true, name: true, phone: true, parent: true, branch: { select: { name: true, centerId: true } }, user: { select: { email: true, active: true, centerId: true, role: true } }, guardianLinks: { where: { guardian: { centerId } }, select: { relation: true, guardian: { select: { name: true, phone: true } } } } } });
      if (!student) return null;
      const group = assignedGroupScope(user), scope = { studentId, student: { centerId }, group };
      const groups = capabilities.groups ? await tx.enrollment.findMany({ where: scope, select: { createdAt: true, group: { select: { id: true, grade: true, days: true, time: true, branch: { select: { name: true, centerId: true } }, teacher: { select: { name: true, subject: true, centerId: true } }, course: { select: { name: true, subject: true, centerId: true } }, academicYear: { select: { name: true, centerId: true } }, schedules: { select: { dayOfWeek: true, startsAt: true, endsAt: true, classroom: { select: { name: true, centerId: true } } } } } } }, orderBy: { groupId: 'asc' }, take: limit + 1 }) : undefined;
      const attendance = capabilities.attendance ? await tx.attendance.findMany({ where: { ...scope, date: range }, select: { date: true, status: true, note: true, groupId: true, group: { select: { grade: true } } }, orderBy: [{ date: 'desc' }, { groupId: 'asc' }], take: limit + 1 }) : undefined;
      const grades = capabilities.academic ? await tx.gradeRecord.findMany({ where: { ...scope, assessedOn: range, OR: [{ examId: null }, { exam: { publishedAt: { not: null }, group } }] }, select: { title: true, score: true, maxScore: true, assessedOn: true, revision: true, groupId: true, group: { select: { grade: true } }, exam: { select: { groupId: true } } }, orderBy: [{ assessedOn: 'desc' }, { id: 'asc' }], take: limit + 1 }) : undefined;
      const subscriptions = capabilities.finance ? await tx.subscription.findMany({ where: { ...scope, month: query.data.month }, select: { groupId: true, month: true, amount: true, discount: true, dueOn: true, status: true, group: { select: { grade: true } } }, orderBy: { groupId: 'asc' }, take: limit + 1 }) : undefined;
      const payments = capabilities.finance ? await tx.payment.findMany({ where: { ...scope, month: query.data.month }, select: { groupId: true, month: true, amount: true, status: true, reference: true, createdAt: true, group: { select: { grade: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limit + 1 }) : undefined;
      const label = (row: { name: string; centerId: string } | null) => row?.centerId === centerId ? row.name : null;
      return { student: { id: student.id, name: student.name, phone: student.phone, parentPhone: student.parent, branch: label(student.branch), code: `STUDENT:${student.id}`, account: student.user?.centerId === centerId && student.user.role === 'STUDENT' ? { email: student.user.email, active: student.user.active } : null, guardians: student.guardianLinks.map(row => ({ relation: row.relation, ...row.guardian })) }, month: query.data.month, capabilities,
        ...(groups ? { groups: page(groups.map(({ group: g, createdAt }) => ({ id: g.id, grade: g.grade, days: g.days, time: g.time, enrolledAt: createdAt, branch: label(g.branch), teacher: label(g.teacher), subject: g.course?.centerId === centerId ? g.course.subject : g.teacher.centerId === centerId ? g.teacher.subject : null, course: label(g.course), academicYear: label(g.academicYear), schedules: g.schedules.map(s => ({ dayOfWeek: s.dayOfWeek, startsAt: s.startsAt, endsAt: s.endsAt, classroom: label(s.classroom) })) }))) } : {}),
        ...(attendance ? { attendance: page(attendance.map(row => ({ ...row, status: attendanceStatus(row.status) }))) } : {}),
        ...(grades ? { grades: { ...page(grades.filter(row => !row.exam || row.exam.groupId === row.groupId).map(({ exam, ...row }) => ({ ...row, kind: exam ? 'PUBLISHED_EXAM' : 'GENERAL_ASSESSMENT', percentage: row.maxScore > 0 ? Math.round(row.score / row.maxScore * 1000) / 10 : null }))), truncated: grades.length > limit } } : {}),
        ...(subscriptions ? { subscriptions: page(subscriptions) } : {}), ...(payments ? { payments: page(payments) } : {}),
      };
    });
    if (!result) return reply.code(404).send({ error: 'STUDENT_NOT_FOUND' });
    return reply.header('Cache-Control', 'no-store').send(result);
  });
              }
