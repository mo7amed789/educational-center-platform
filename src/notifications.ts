import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma, User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { requireUser } from './auth.js';
import { authorize } from './authorization.js';

function visibleWhere(user: User, studentId?: number): Prisma.LearnerNotificationWhereInput {
  const centerId = user.centerId || '__missing__';
  return { recipientUserId: user.id, kind: { in: ['RESULT_PUBLISHED', 'RESULT_CORRECTED'] }, gradeRecord: {
    ...(studentId ? { studentId } : {}), group: { centerId },
    exam: { publishedAt: { not: null }, group: { centerId } },
    student: { centerId, ...(user.role === 'STUDENT' ? { userId: user.id } : { guardianLinks: { some: { guardian: { userId: user.id, centerId } } } }) },
  } };
}
const notificationSelect = { id: true, kind: true, revision: true, createdAt: true, readAt: true, gradeRecord: { select: { groupId: true, studentId: true, title: true, student: { select: { name: true } }, exam: { select: { groupId: true } } } } } as const;
export async function readLearnerNotifications(client: Prisma.TransactionClient, user: User, studentId?: number) {
  const raw = await client.learnerNotification.findMany({ where: visibleWhere(user, studentId), select: notificationSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
  const items = raw.filter(row => row.gradeRecord.exam?.groupId === row.gradeRecord.groupId).map(row => ({ id: row.id, kind: row.kind, revision: row.revision, createdAt: row.createdAt, readAt: row.readAt, studentId: row.gradeRecord.studentId, studentName: row.gradeRecord.student.name, title: row.gradeRecord.title }));
  return { items, limit: 50, unreadInPage: items.filter(row => !row.readAt).length };
}

// Called inside the score/publication transaction. No reason, staff identity, score or contact data is copied.
export async function notifyExamResults(client: Prisma.TransactionClient, centerId: string, examId: string, groupId: number, kind: 'RESULT_PUBLISHED' | 'RESULT_CORRECTED', gradeRecordId?: string) {
  const grades = await client.gradeRecord.findMany({ where: { examId, groupId, ...(gradeRecordId ? { id: gradeRecordId } : {}), student: { centerId } },
    select: { id: true, revision: true, student: { select: { user: { select: { id: true, role: true, centerId: true, active: true } }, guardianLinks: { where: { guardian: { centerId } }, select: { guardian: { select: { user: { select: { id: true, role: true, centerId: true, active: true } } } } } } } } },
  });
  const rows: Prisma.LearnerNotificationCreateManyInput[] = [];
  for (const grade of grades) {
    const recipients = new Set<string>(), student = grade.student.user;
    if (student?.active && student.centerId === centerId && student.role === 'STUDENT') recipients.add(student.id);
    for (const link of grade.student.guardianLinks) { const guardian = link.guardian.user; if (guardian.active && guardian.centerId === centerId && guardian.role === 'GUARDIAN') recipients.add(guardian.id); }
    const eventKey = kind === 'RESULT_PUBLISHED' ? `grade:${grade.id}:published` : `grade:${grade.id}:revision:${grade.revision}`;
    for (const recipientUserId of recipients) rows.push({ recipientUserId, gradeRecordId: grade.id, eventKey, kind, revision: grade.revision });
  }
  if (rows.length) await client.learnerNotification.createMany({ data: rows });
}
async function learner(request: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(request, reply); if (!user) return null;
  if (!user.centerId || !['STUDENT', 'GUARDIAN'].includes(user.role) || !(await authorize(user.id, 'academic.view', { centerId: user.centerId })) || !(await authorize(user.id, 'attendance.view', { centerId: user.centerId }))) { await reply.code(403).send({ error: 'FORBIDDEN' }); return null; }
  return user;
}
export function registerNotificationRoutes(app: FastifyInstance) {
  app.get('/api/portal/notifications', async (request, reply) => {
    const user = await learner(request, reply); if (!user) return;
    const query = z.object({ studentId: z.coerce.number().int().positive().max(2147483647).optional() }).strict().safeParse(request.query);
    if (!query.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    return prisma.$transaction(tx => readLearnerNotifications(tx, user, query.data.studentId));
  });
  app.post('/api/portal/notifications/:id/read', async (request, reply) => {
    const user = await learner(request, reply); if (!user) return;
    const path = z.object({ id: z.string().min(1).max(100) }).safeParse(request.params);
    if (!path.success || !z.object({}).strict().safeParse(request.body).success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const result = await prisma.$transaction(async tx => {
      const notification = await tx.learnerNotification.findFirst({ where: { id: path.data.id, ...visibleWhere(user) }, select: notificationSelect });
      if (!notification || notification.gradeRecord.exam?.groupId !== notification.gradeRecord.groupId) return false;
      await tx.learnerNotification.updateMany({ where: { id: notification.id, recipientUserId: user.id, readAt: null }, data: { readAt: new Date() } });
      return true;
    });
    if (!result) return reply.code(404).send({ error: 'NOTIFICATION_NOT_FOUND' });
    return { read: true };
  });
      }
