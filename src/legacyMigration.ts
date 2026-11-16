import { z } from 'zod';
import { prisma } from './prisma.js';

const legacySchema = z.object({
  teachers: z.array(z.object({ id: z.coerce.number().int().positive(), name: z.string().trim().min(1).max(160), subject: z.string().trim().min(1).max(120), phone: z.string().trim().max(40).optional().nullable() })).default([]),
  groups: z.array(z.object({ id: z.coerce.number().int().positive(), t: z.coerce.number().int().positive(), grade: z.string().trim().min(1).max(120), days: z.union([z.array(z.string()), z.string()]).optional(), time: z.string().trim().min(1).max(50), price: z.coerce.number().int().nonnegative() })).default([]),
  students: z.array(z.object({ id: z.coerce.number().int().positive(), name: z.string().trim().min(1).max(160), phone: z.string().trim().max(40).optional().nullable(), parent: z.string().trim().max(40).optional().nullable(), g: z.array(z.coerce.number().int().positive()).default([]) })).default([]),
  att: z.record(z.string(), z.record(z.string(), z.enum(['p', 'a', 'l', 'e'])).default({})).default({}),
  pay: z.record(z.string(), z.boolean()).default({}),
}).strict();

export type LegacyData = z.infer<typeof legacySchema>;

function daysToText(days: string[] | string | undefined): string {
  return Array.isArray(days) ? days.join(',') : String(days ?? '');
}

export async function migrateLegacyData(input: unknown, centerId: string) {
  const data = legacySchema.parse(input);
  const summary = { teachers: 0, groups: 0, students: 0, enrollments: 0, attendance: 0, payments: 0, skipped: [] as string[] };
  await prisma.$transaction(async (tx) => {
    const teacherIds = new Set<number>();
    for (const teacher of data.teachers) {
      await tx.teacher.upsert({ where: { id: teacher.id }, update: { centerId, name: teacher.name, subject: teacher.subject, phone: teacher.phone || null }, create: { id: teacher.id, centerId, name: teacher.name, subject: teacher.subject, phone: teacher.phone || null } });
      teacherIds.add(teacher.id); summary.teachers++;
    }
    const groupIds = new Set<number>();
    for (const group of data.groups) {
      if (!teacherIds.has(group.t)) { summary.skipped.push(`group:${group.id}:teacher:${group.t}`); continue; }
      await tx.group.upsert({ where: { id: group.id }, update: { centerId, teacherId: group.t, grade: group.grade, days: daysToText(group.days), time: group.time, price: group.price }, create: { id: group.id, centerId, teacherId: group.t, grade: group.grade, days: daysToText(group.days), time: group.time, price: group.price } });
      groupIds.add(group.id); summary.groups++;
    }
    const studentIds = new Set<number>();
    for (const student of data.students) {
      await tx.student.upsert({ where: { id: student.id }, update: { centerId, name: student.name, phone: student.phone || null, parent: student.parent || null }, create: { id: student.id, centerId, name: student.name, phone: student.phone || null, parent: student.parent || null } });
      studentIds.add(student.id); summary.students++;
      for (const groupId of student.g) {
        if (!groupIds.has(groupId)) { summary.skipped.push(`enrollment:${student.id}:${groupId}`); continue; }
        await tx.enrollment.upsert({ where: { studentId_groupId: { studentId: student.id, groupId } }, update: {}, create: { studentId: student.id, groupId } });
        summary.enrollments++;
      }
    }
    for (const [key, record] of Object.entries(data.att)) {
      const [groupPart, date] = key.split('|'); const groupId = Number(groupPart);
      if (!groupIds.has(groupId) || !date) { summary.skipped.push(`attendance:${key}`); continue; }
      for (const [studentPart, status] of Object.entries(record)) {
        const studentId = Number(studentPart);
        if (!studentIds.has(studentId)) { summary.skipped.push(`attendance:${key}:${studentPart}`); continue; }
        await tx.attendance.upsert({ where: { studentId_groupId_date: { studentId, groupId, date } }, update: { status }, create: { studentId, groupId, date, status } });
        summary.attendance++;
      }
    }
    for (const [key, paid] of Object.entries(data.pay)) {
      if (!paid) continue;
      const [studentPart, groupPart, month] = key.split('|'); const studentId = Number(studentPart); const groupId = Number(groupPart);
      if (!studentIds.has(studentId) || !groupIds.has(groupId) || !month) { summary.skipped.push(`payment:${key}`); continue; }
      const group = await tx.group.findUnique({ where: { id: groupId }, select: { price: true } });
      await tx.payment.upsert({ where: { studentId_groupId_month: { studentId, groupId, month } }, update: { status: 'paid', amount: group?.price ?? 0 }, create: { studentId, groupId, month, amount: group?.price ?? 0, status: 'paid' } });
      summary.payments++;
    }
  });
  return summary;
}

export { legacySchema };
