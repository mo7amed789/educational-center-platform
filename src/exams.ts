import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma, User } from '@prisma/client';
import { z } from 'zod';
import { requireUser } from './auth.js';
import { authorize } from './authorization.js';
import { prisma } from './prisma.js';
import type { Permission } from './permissions.js';
import { groupLabel, learningGroupInclude } from './learningReports.js';

const day = z.string().regex(/^(19|20|21)\d{2}-\d{2}-\d{2}$/).refine(value => { const d = new Date(value + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value; });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().trim().min(1).max(80).refine(value => { try { if (value !== 'UTC' && !value.includes('/')) return false; new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
const createInput = z.object({ groupId: z.number().int().positive().max(2147483647), title: z.string().trim().min(1).max(160), date: day, startsAt: time, endsAt: time, timezone, maxScore: z.number().finite().positive().max(1000000) }).strict().refine(value => value.endsAt > value.startsAt);
const resultInput = z.object({ studentId: z.number().int().positive().max(2147483647), score: z.number().finite().nonnegative() }).strict();
const pathInput = z.object({ id: z.string().min(1).max(100) });

function groupScope(user: User): Prisma.GroupWhereInput {
  return { centerId: user.centerId || '', ...(user.role === 'BRANCH_ADMIN' ? { branchId: user.branchId || '__missing__' } : {}), ...(user.role === 'TEACHER' ? { teacher: { userId: user.id, centerId: user.centerId || '' } } : {}) };
}
async function actor(request: FastifyRequest, reply: FastifyReply, permission: Permission) {
  const user = await requireUser(request, reply); if (!user) return null;
  if (!user.centerId || ['STUDENT', 'GUARDIAN'].includes(user.role) || !(await authorize(user.id, permission, { centerId: user.centerId }))) { await reply.code(403).send({ error: 'FORBIDDEN' }); return null; }
  if (user.role === 'BRANCH_ADMIN') {
    const [branch, membership] = await Promise.all([
      prisma.branch.findFirst({ where: { id: user.branchId || '', centerId: user.centerId }, select: { id: true } }),
      prisma.branchMembership.findUnique({ where: { userId_branchId: { userId: user.id, branchId: user.branchId || '' } }, select: { active: true } }),
    ]);
    if (!branch || membership?.active === false) { await reply.code(403).send({ error: 'BRANCH_SCOPE_REQUIRED' }); return null; }
  }
  return user;
}
const examInclude = { group: { include: learningGroupInclude } } as const;
type ExamRow = Prisma.ExamGetPayload<{ include: typeof examInclude }>;
function examView(exam: ExamRow, centerId: string) { return { id: exam.id, title: exam.title, date: exam.date, startsAt: exam.startsAt, endsAt: exam.endsAt, timezone: exam.timezone, maxScore: exam.maxScore, publishedAt: exam.publishedAt, ...groupLabel(exam.group, centerId) }; }
async function findExam(client: Prisma.TransactionClient, user: User, id: string) { return client.exam.findFirst({ where: { id, group: groupScope(user) }, include: examInclude }); }

export function registerExamRoutes(app: FastifyInstance) {
  app.get('/api/center/exams', async (request, reply) => {
    const user = await actor(request, reply, 'academic.manage_exams'); if (!user) return;
    const query = z.object({ month: z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/) }).strict().safeParse(request.query);
    if (!query.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const [year, month] = query.data.month.split('-').map(Number);
    const lt = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const exams = await prisma.exam.findMany({ where: { group: groupScope(user), date: { gte: query.data.month + '-01', lt } }, include: examInclude, orderBy: [{ date: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }], take: 200 });
    const groups = await prisma.group.findMany({ where: groupScope(user), include: learningGroupInclude, orderBy: { id: 'asc' } });
    return { groups: groups.map(group => groupLabel(group, user.centerId!)), exams: exams.map(exam => examView(exam, user.centerId!)), limit: 200, capabilities: { recordResults: await authorize(user.id, 'academic.manage_grades', { centerId: user.centerId }), publishResults: await authorize(user.id, 'academic.publish_results', { centerId: user.centerId }) } };
  });
  app.post('/api/center/exams', async (request, reply) => {
    const user = await actor(request, reply, 'academic.manage_exams'); if (!user) return;
    const parsed = createInput.safeParse(request.body); if (!parsed.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const result = await prisma.$transaction(async tx => {
      const group = await tx.group.findFirst({ where: { id: parsed.data.groupId, ...groupScope(user) }, select: { id: true } });
      if (!group) return null;
      const exam = await tx.exam.create({ data: { ...parsed.data, createdById: user.id }, include: examInclude });
      await tx.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'exams.create', entity: 'Exam', entityId: exam.id, metadata: JSON.stringify({ groupId: exam.groupId, date: exam.date, timezone: exam.timezone }) } });
      return examView(exam, user.centerId!);
    });
    if (!result) return reply.code(404).send({ error: 'GROUP_NOT_FOUND' });
    return reply.code(201).send({ exam: result });
  });
  app.get('/api/center/exams/:id/results', async (request, reply) => {
    const user = await actor(request, reply, 'academic.manage_grades'); if (!user) return;
    const parsed = pathInput.safeParse(request.params); if (!parsed.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const result = await prisma.$transaction(async tx => {
      const exam = await findExam(tx, user, parsed.data.id); if (!exam) return null;
      const students = await tx.student.findMany({ where: { centerId: user.centerId!, OR: [{ enrollments: { some: { groupId: exam.groupId } } }, { gradeRecords: { some: { examId: exam.id, groupId: exam.groupId } } }] },
        select: { id: true, name: true, gradeRecords: { where: { examId: exam.id, groupId: exam.groupId }, select: { id: true, score: true, maxScore: true, revision: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      return { exam: examView(exam, user.centerId!), students: students.map(student => ({ id: student.id, name: student.name, result: student.gradeRecords[0] || null })) };
    });
    if (!result) return reply.code(404).send({ error: 'EXAM_NOT_FOUND' });
    return result;
  });
  app.post('/api/center/exams/:id/results', async (request, reply) => {
    const user = await actor(request, reply, 'academic.manage_grades'); if (!user) return;
    const path = pathInput.safeParse(request.params), input = resultInput.safeParse(request.body);
    if (!path.success || !input.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    try {
      const result = await prisma.$transaction(async tx => {
        const exam = await findExam(tx, user, path.data.id); if (!exam) return { error: 'EXAM_NOT_FOUND', status: 404 };
        if (exam.publishedAt) return { error: 'EXAM_RESULTS_PUBLISHED', status: 409 };
        if (input.data.score > exam.maxScore) return { error: 'SCORE_EXCEEDS_MAXIMUM', status: 422 };
        const enrolled = await tx.enrollment.findFirst({ where: { groupId: exam.groupId, studentId: input.data.studentId, student: { centerId: user.centerId! } }, select: { studentId: true } });
        if (!enrolled) return { error: 'STUDENT_NOT_ENROLLED', status: 404 };
        if (await tx.gradeRecord.findUnique({ where: { examId_studentId: { examId: exam.id, studentId: enrolled.studentId } } })) return { error: 'RESULT_ALREADY_RECORDED', status: 409 };
        const grade = await tx.gradeRecord.create({ data: { examId: exam.id, groupId: exam.groupId, studentId: enrolled.studentId, title: exam.title, assessedOn: exam.date, score: input.data.score, maxScore: exam.maxScore, recordedById: user.id }, select: { id: true, studentId: true, score: true, maxScore: true } });
        await tx.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'exams.result', entity: 'GradeRecord', entityId: grade.id, metadata: JSON.stringify({ examId: exam.id, studentId: grade.studentId, score: grade.score, maxScore: grade.maxScore }) } });
        return { grade };
      });
      if ('error' in result) return reply.code(result.status!).send({ error: result.error });
      return reply.code(201).send(result);
    } catch (error) { if ((error as { code?: string }).code === 'P2002') return reply.code(409).send({ error: 'RESULT_ALREADY_RECORDED' }); throw error; }
  });
  app.post('/api/center/exams/:id/publish', async (request, reply) => {
    const user = await actor(request, reply, 'academic.publish_results'); if (!user) return;
    const parsed = pathInput.safeParse(request.params); if (!parsed.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const result = await prisma.$transaction(async tx => {
      const exam = await findExam(tx, user, parsed.data.id); if (!exam) return { error: 'EXAM_NOT_FOUND', status: 404 };
      if (exam.publishedAt) return { exam: examView(exam, user.centerId!), repeated: true };
      if (!(await tx.gradeRecord.count({ where: { examId: exam.id, groupId: exam.groupId, student: { centerId: user.centerId! } } }))) return { error: 'NO_RESULTS', status: 422 };
      const published = await tx.exam.update({ where: { id: exam.id }, data: { publishedAt: new Date() }, include: examInclude });
      await tx.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'exams.publish', entity: 'Exam', entityId: exam.id } });
      return { exam: examView(published, user.centerId!), repeated: false };
    });
    if ('error' in result) return reply.code(result.status!).send({ error: result.error });
    return result;
  });

  const correctionPath = z.object({ id: z.string().min(1).max(100), studentId: z.coerce.number().int().positive().max(2147483647) });
  const correctionInput = z.object({ score: z.number().finite().nonnegative(), expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(5).max(500), confirmPublished: z.boolean().default(false) }).strict();
  app.get('/api/center/exams/:id/results/:studentId/history', async (request, reply) => {
    const user = await actor(request, reply, 'academic.manage_grades'); if (!user) return;
    const path = correctionPath.safeParse(request.params); if (!path.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const canPublish = await authorize(user.id, 'academic.publish_results', { centerId: user.centerId });
    const data = await prisma.$transaction(async tx => {
      const exam = await findExam(tx, user, path.data.id); if (!exam) return null;
      const grade = await tx.gradeRecord.findFirst({ where: { examId: exam.id, groupId: exam.groupId, studentId: path.data.studentId, student: { centerId: user.centerId! } },
        select: { id: true, score: true, maxScore: true, revision: true, student: { select: { id: true, name: true } }, corrections: { orderBy: { revision: 'desc' }, take: 50, select: { id: true, revision: true, previousScore: true, score: true, maxScore: true, reason: true, createdAt: true, correctedBy: { select: { name: true, centerId: true } } } } },
      });
      if (!grade) return null;
      return { exam: examView(exam, user.centerId!), student: grade.student, grade: { id: grade.id, score: grade.score, maxScore: grade.maxScore, revision: grade.revision }, limit: 50,
        canCorrect: !exam.publishedAt || canPublish,
        history: grade.corrections.map(row => ({ id: row.id, revision: row.revision, previousScore: row.previousScore, score: row.score, maxScore: row.maxScore, reason: row.reason, createdAt: row.createdAt, correctedBy: row.correctedBy.centerId === user.centerId ? row.correctedBy.name : 'موظف سابق' })),
      };
    });
    if (!data) return reply.code(404).send({ error: 'RESULT_NOT_FOUND' });
    return data;
  });
  app.post('/api/center/exams/:id/results/:studentId/corrections', async (request, reply) => {
    const user = await actor(request, reply, 'academic.manage_grades'); if (!user) return;
    const path = correctionPath.safeParse(request.params), input = correctionInput.safeParse(request.body);
    if (!path.success || !input.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const canPublish = await authorize(user.id, 'academic.publish_results', { centerId: user.centerId });
    try {
      const result = await prisma.$transaction(async tx => {
        const exam = await findExam(tx, user, path.data.id); if (!exam) return { error: 'RESULT_NOT_FOUND', status: 404 };
        const grade = await tx.gradeRecord.findFirst({ where: { examId: exam.id, groupId: exam.groupId, studentId: path.data.studentId, student: { centerId: user.centerId! } } });
        if (!grade) return { error: 'RESULT_NOT_FOUND', status: 404 };
        if (exam.publishedAt && !canPublish) return { error: 'PUBLISHED_CORRECTION_FORBIDDEN', status: 403 };
        if (exam.publishedAt && !input.data.confirmPublished) return { error: 'PUBLISHED_CORRECTION_CONFIRMATION_REQUIRED', status: 422 };
        if (grade.revision !== input.data.expectedRevision) return { error: 'GRADE_CHANGED', status: 409 };
        if (grade.maxScore <= 0 || grade.maxScore !== exam.maxScore) return { error: 'INVALID_GRADE_SNAPSHOT', status: 422 };
        if (input.data.score > grade.maxScore) return { error: 'SCORE_EXCEEDS_MAXIMUM', status: 422 };
        if (input.data.score === grade.score) return { error: 'NO_GRADE_CHANGE', status: 422 };
        const changed = await tx.gradeRecord.updateMany({ where: { id: grade.id, revision: input.data.expectedRevision }, data: { score: input.data.score, revision: { increment: 1 } } });
        if (changed.count !== 1) return { error: 'GRADE_CHANGED', status: 409 };
        const correction = await tx.gradeCorrection.create({ data: { gradeRecordId: grade.id, revision: grade.revision + 1, previousScore: grade.score, score: input.data.score, maxScore: grade.maxScore, reason: input.data.reason, correctedById: user.id }, select: { id: true } });
        await tx.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'exams.correct_result', entity: 'GradeRecord', entityId: grade.id, metadata: JSON.stringify({ examId: exam.id, correctionId: correction.id, revision: grade.revision + 1, previousScore: grade.score, score: input.data.score, published: Boolean(exam.publishedAt) }) } });
        return { grade: { id: grade.id, score: input.data.score, maxScore: grade.maxScore, revision: grade.revision + 1 }, published: Boolean(exam.publishedAt) };
      });
      if ('error' in result) return reply.code(result.status!).send({ error: result.error });
      return result;
    } catch (error) {
      if (['P2002', 'P2034', 'P2028'].includes((error as { code?: string }).code || '')) return reply.code(409).send({ error: 'GRADE_CHANGED' });
      throw error;
    }
  });
  }
