import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { requireUser } from './auth.js';
import { authorize } from './authorization.js';
import { assignedGroupScope, isBranchBound } from './resourceScopes.js';
import { readMonthlyLearningReport, readLearningReport, learningGroupInclude, groupLabel } from './learningReports.js';

const monthSchema = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);
const dateSchema = z.string().regex(/^(19|20|21)\d{2}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const reportQuery = z.object({ month: monthSchema, studentId: z.coerce.number().int().positive() });
const gradeInput = z.object({
  studentId: z.coerce.number().int().positive(), groupId: z.coerce.number().int().positive(),
  title: z.string().trim().min(1).max(160), assessedOn: dateSchema,
  score: z.number().finite().nonnegative(), maxScore: z.number().finite().positive(),
}).refine((value) => value.score <= value.maxScore);


function monthRange(month: string) { const [year, number] = month.split('-').map(Number); return { gte: month + '-01', lt: number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, '0')}-01` }; }

async function parentUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(request, reply);
  if (!user) return null;
  if (user.role !== 'GUARDIAN' || !user.centerId ||
      !(await authorize(user.id, 'attendance.view', { centerId: user.centerId })) ||
      !(await authorize(user.id, 'academic.view', { centerId: user.centerId }))) {
    await reply.code(403).send({ error: 'FORBIDDEN' });
    return null;
  }
  return user;
}

export function registerMonthlyReportRoutes(app: FastifyInstance) {
  // Minimal linked-child list. Never return another tenant through a bad legacy link.
  app.get('/api/portal/parent', async (request, reply) => {
    const user = await parentUser(request, reply); if (!user) return;
    const guardian = await prisma.guardian.findFirst({ where: { userId: user.id, centerId: user.centerId! }, select: { id: true, name: true } });
    if (!guardian) return reply.code(404).send({ error: 'GUARDIAN_PROFILE_NOT_LINKED' });
    const children = await prisma.student.findMany({
      where: { centerId: user.centerId!, guardianLinks: { some: { guardianId: guardian.id } } },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    });
    return { guardian, children };
  });

  app.get('/api/portal/parent/monthly-report', async (request, reply) => {
    const user = await parentUser(request, reply); if (!user) return;
    const query = reportQuery.safeParse(request.query);
    if (!query.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const { studentId, month } = query.data;
    const centerId = user.centerId!;
    // The requested child must be linked to THIS guardian in THIS center.
    const student = await prisma.student.findFirst({
      where: { id: studentId, centerId, guardianLinks: { some: { guardian: { userId: user.id, centerId } } } },
      select: { id: true, name: true },
    });
    if (!student) return reply.code(404).send({ error: 'CHILD_NOT_FOUND' });
    return prisma.$transaction((tx) => readMonthlyLearningReport(tx, student, centerId, month));
  });

  for (const parent of [true, false]) {
    app.get(parent ? '/api/portal/parent/learning-report' : '/api/portal/student/learning-report', async (request, reply) => {
      const user = parent ? await parentUser(request, reply) : await requireUser(request, reply); if (!user) return;
      if (!parent && (user.role !== 'STUDENT' || !user.centerId ||
          !(await authorize(user.id, 'attendance.view', { centerId: user.centerId })) ||
          !(await authorize(user.id, 'academic.view', { centerId: user.centerId })))) return reply.code(403).send({ error: 'FORBIDDEN' });
      const query = (parent ? z.object({ month: monthSchema, date: dateSchema, studentId: z.coerce.number().int().positive().max(2147483647) }).strict() : z.object({ month: monthSchema, date: dateSchema }).strict()).safeParse(request.query);
      if (!query.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
      const centerId = user.centerId!;
      const student = await prisma.student.findFirst({ where: { centerId,
        ...(parent && 'studentId' in query.data ? { id: Number(query.data.studentId), guardianLinks: { some: { guardian: { userId: user.id, centerId } } } } : { userId: user.id }),
      }, select: { id: true, name: true } });
      if (!student) return reply.code(404).send({ error: parent ? 'CHILD_NOT_FOUND' : 'STUDENT_PROFILE_NOT_LINKED' });
      return prisma.$transaction(tx => readLearningReport(tx, student, centerId, query.data.month, query.data.date));
    });
  }

  // Choosing an exam for grading requires grade permission, not scheduling permission.
  app.get('/api/center/grades/exams', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || ['STUDENT', 'GUARDIAN'].includes(user.role) || !(await authorize(user.id, 'academic.manage_grades', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ month: monthSchema }).strict().safeParse(request.query);
    if (!query.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const exams = await prisma.exam.findMany({ where: { publishedAt: null, date: monthRange(query.data.month), group: assignedGroupScope(user) }, include: { group: { include: learningGroupInclude } }, orderBy: [{ date: 'desc' }, { id: 'asc' }], take: 200 });
    return { exams: exams.map(exam => ({ id: exam.id, title: exam.title, date: exam.date, maxScore: exam.maxScore, ...groupLabel(exam.group, user.centerId!) })), limit: 200, canManageExams: await authorize(user.id, 'academic.manage_exams', { centerId: user.centerId }) };
  });

  // The group picker must not depend on a successful grade-history read.
  app.get('/api/center/grades/groups', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || ['STUDENT', 'GUARDIAN'].includes(user.role) || !(await authorize(user.id, 'academic.manage_grades', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (user.role === 'TEACHER' && !(await prisma.teacher.findFirst({ where: { userId: user.id, centerId: user.centerId }, select: { id: true } }))) return reply.code(403).send({ error: 'TEACHER_PROFILE_REQUIRED' });
    const groups = await prisma.group.findMany({ where: assignedGroupScope(user), include: learningGroupInclude, orderBy: { id: 'asc' } });
    return { groups: groups.map(group => groupLabel(group, user.centerId!)) };
  });

  app.get('/api/center/grades/enrollments', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || ['STUDENT', 'GUARDIAN'].includes(user.role) || !(await authorize(user.id, 'academic.manage_grades', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ groupId: z.coerce.number().int().positive() }).safeParse(request.query);
    if (!query.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    if (isBranchBound(user.role) && !user.branchId) return reply.code(403).send({ error: 'FORBIDDEN' });
    const group = await prisma.group.findFirst({ where: { id: query.data.groupId, ...assignedGroupScope(user) }, select: { id: true } });
    if (!group) return reply.code(404).send({ error: 'GROUP_NOT_FOUND' });
    const students = await prisma.student.findMany({ where: { centerId: user.centerId, enrollments: { some: { groupId: group.id } } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return { students };
  });

  app.get('/api/center/grades', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || ['STUDENT', 'GUARDIAN'].includes(user.role) || !(await authorize(user.id, 'academic.manage_grades', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ month: monthSchema, studentId: z.coerce.number().int().positive().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    if (isBranchBound(user.role) && !user.branchId) return reply.code(403).send({ error: 'FORBIDDEN' });
    const items = await prisma.gradeRecord.findMany({
      where: { examId: null, student: { centerId: user.centerId }, group: assignedGroupScope(user), assessedOn: monthRange(query.data.month), ...(query.data.studentId ? { studentId: query.data.studentId } : {}) },
      include: { student: { select: { id: true, name: true } }, group: { include: learningGroupInclude } },
      orderBy: [{ assessedOn: 'desc' }, { createdAt: 'desc' }], take: 500,
    });
    const groups = await prisma.group.findMany({ where: assignedGroupScope(user), include: learningGroupInclude, orderBy: { id: 'asc' } });
    return { groups: groups.map(group => groupLabel(group, user.centerId!)), items: items.map((row) => ({ id: row.id, student: row.student, title: row.title, assessedOn: row.assessedOn, score: row.score, maxScore: row.maxScore, ...groupLabel(row.group, user.centerId!) })), limit: 500 };
  });

  app.post('/api/center/grades', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || ['STUDENT', 'GUARDIAN'].includes(user.role) || !(await authorize(user.id, 'academic.manage_grades', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = gradeInput.safeParse(request.body);
    if (!input.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    if (isBranchBound(user.role) && !user.branchId) return reply.code(403).send({ error: 'FORBIDDEN' });
    const result = await prisma.$transaction(async (tx) => {
      const enrollment = await tx.enrollment.findFirst({ where: {
        studentId: input.data.studentId, groupId: input.data.groupId,
        student: { centerId: user.centerId! }, group: assignedGroupScope(user),
      } });
      if (!enrollment) return null;
      const grade = await tx.gradeRecord.create({ data: { ...input.data, recordedById: user.id } });
      await tx.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'grades.record', entity: 'GradeRecord', entityId: grade.id, metadata: JSON.stringify({ studentId: grade.studentId, groupId: grade.groupId, assessedOn: grade.assessedOn }) } });
      return grade;
    });
    if (!result) return reply.code(422).send({ error: 'INVALID_ENROLLMENT' });
    return reply.code(201).send({ grade: { id: result.id, studentId: result.studentId, groupId: result.groupId, title: result.title, assessedOn: result.assessedOn, score: result.score, maxScore: result.maxScore } });
  });
}
