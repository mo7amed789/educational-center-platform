import type { FastifyInstance } from 'fastify';
import type { Prisma, User } from '@prisma/client';
import { z } from 'zod';
import { requireUser } from './auth.js';
import { authorize } from './authorization.js';
import { prisma } from './prisma.js';

// The existing attendance identity is student + group + date, not a timed lesson.
const id = z.number().int().positive().max(2147483647);
const date = z.string().regex(/^(19|20|21)\d{2}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const selection = z.object({ groupId: z.coerce.number().pipe(id), date });
const scanInput = selection.extend({ code: z.string().trim().min(1).max(50) });
const manualInput = selection.extend({ studentId: id, status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']) });

export function attendanceStudentId(code: string): number | null {
  const match = /^(?:STUDENT:|#)?([1-9]\d*)$/i.exec(code.trim());
  if (!match) return null;
  const parsed = id.safeParse(Number(match[1]));
  return parsed.success ? parsed.data : null;
}

function pupilScope(user: User): Prisma.StudentWhereInput {
  return { centerId: user.centerId || '',
    ...(user.role === 'STUDENT' ? { userId: user.id } : {}),
    ...(user.role === 'GUARDIAN' ? { guardianLinks: { some: { guardian: { userId: user.id, centerId: user.centerId || '' } } } } : {}),
  };
}

async function selectedGroup(client: Prisma.TransactionClient, user: User, groupId: number) {
  if (!user.centerId) return null;
  if (user.role === 'BRANCH_ADMIN') {
    if (!user.branchId) return null;
    const [branch, membership] = await Promise.all([
      client.branch.findFirst({ where: { id: user.branchId, centerId: user.centerId }, select: { id: true } }),
      client.branchMembership.findUnique({ where: { userId_branchId: { userId: user.id, branchId: user.branchId } }, select: { active: true } }),
    ]);
    if (!branch || membership?.active === false) return null;
  }
  return client.group.findFirst({ where: {
    id: groupId, centerId: user.centerId,
    ...(user.role === 'BRANCH_ADMIN' ? { branchId: user.branchId } : {}),
    ...(user.role === 'TEACHER' ? { teacher: { userId: user.id, centerId: user.centerId } } : {}),
    ...(['STUDENT', 'GUARDIAN'].includes(user.role) ? { enrollments: { some: { student: pupilScope(user) } } } : {}),
  }, select: { id: true, grade: true, time: true } });
}

export function registerSelectedAttendanceRoutes(app: FastifyInstance) {
  // A fresh, scoped class roster, not a filter over the first global pupil page.
  app.get('/api/center/attendance/selected', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const context = { centerId: user.centerId };
    if (!user.centerId || !(await authorize(user.id, 'attendance.view', context)) || !(await authorize(user.id, 'groups.view', context)) ||
        !(await authorize(user.id, user.role === 'TEACHER' ? 'students.view_assigned' : 'students.view', context))) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    const parsed = selection.safeParse(request.query);
    if (!parsed.success) return reply.code(422).send({ error: 'INVALID_SELECTION' });
    const { groupId, date } = parsed.data;
    const result = await prisma.$transaction(async (tx) => {
      const group = await selectedGroup(tx, user, groupId);
      if (!group) return null;
      const students = await tx.student.findMany({ where: { ...pupilScope(user), enrollments: { some: { groupId } } },
        select: { id: true, name: true, attendance: { where: { groupId, date }, select: { status: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      return { group, date, students: students.map((student) => ({ id: student.id, name: student.name, code: `STUDENT:${student.id}`, status: student.attendance[0]?.status || null })) };
    });
    if (!result) return reply.code(404).send({ error: 'GROUP_NOT_FOUND' });
    return result;
  });

  for (const scan of [true, false]) {
    app.post(scan ? '/api/center/attendance/selected/scan' : '/api/center/attendance/selected/record', async (request, reply) => {
      const user = await requireUser(request, reply); if (!user) return;
      if (!user.centerId || ['STUDENT', 'GUARDIAN'].includes(user.role) || !(await authorize(user.id, 'attendance.create', { centerId: user.centerId }))) {
        return reply.code(403).send({ error: 'FORBIDDEN' });
      }
      const input = scan ? scanInput.safeParse(request.body) : manualInput.safeParse(request.body);
      if (!input.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
      const data = input.data;
      const studentId = 'code' in data ? attendanceStudentId(data.code) : data.studentId;
      if (studentId === null) return reply.code(422).send({ error: 'INVALID_STUDENT_CODE' });
      const status = 'status' in data ? data.status : 'PRESENT';
      const result = await prisma.$transaction(async (tx) => {
        const group = await selectedGroup(tx, user, data.groupId);
        if (!group) return { error: 'GROUP_NOT_FOUND' as const };
        // The pupil's home branch may differ. Enrollment in the acting class is what matters.
        const enrollment = await tx.enrollment.findFirst({ where: { studentId, groupId: group.id, student: { centerId: user.centerId! } }, select: { student: { select: { id: true, name: true } } } });
        if (!enrollment) return { error: 'STUDENT_NOT_ENROLLED' as const };
        const key = { studentId, groupId: group.id, date: data.date };
        const existing = await tx.attendance.findUnique({ where: { studentId_groupId_date: key }, select: { status: true } });
        const attendance = await tx.attendance.upsert({ where: { studentId_groupId_date: key }, update: { status }, create: { ...key, status } });
        await tx.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: scan ? 'attendance.selected_scan' : 'attendance.selected_record', entity: 'Attendance',
          entityId: `${studentId}:${group.id}:${data.date}`, metadata: JSON.stringify({ ...key, status, previousStatus: existing?.status || null }),
        } });
        return { student: { ...enrollment.student, code: `STUDENT:${studentId}` }, group, date: data.date, attendance, repeated: existing?.status === status };
      });
      if ('error' in result) return reply.code(404).send({ error: result.error });
      return { success: true, ...result };
    });
  }
                                           }
