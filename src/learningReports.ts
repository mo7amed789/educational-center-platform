import type { Prisma } from '@prisma/client';

function visibleGrades(centerId: string): Prisma.GradeRecordWhereInput { return { OR: [{ examId: null }, { exam: { publishedAt: { not: null }, group: { centerId } } }] }; }
const gradeExam = { select: { groupId: true } } as const;
function consistentExam(row: { groupId: number; exam: { groupId: number } | null }) { return !row.exam || row.exam.groupId === row.groupId; }

type StudentLabel = { id: number; name: string };
function monthRange(month: string) {
  const [year, number] = month.split('-').map(Number);
  return { gte: month + '-01', lt: number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, '0')}-01` };
}

export function attendanceStatus(status: string) {
  const normalized = status.toUpperCase();
  return ({ P: 'PRESENT', A: 'ABSENT', L: 'LATE', E: 'EXCUSED' } as Record<string, string>)[normalized]
    || (['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'].includes(normalized) ? normalized : 'UNKNOWN');
}

function summary(records: Array<{ status: string }>) {
  const result = { recorded: records.length, present: 0, absent: 0, late: 0, excused: 0, unknown: 0, attendanceRate: null as number | null };
  for (const row of records) {
    const status = attendanceStatus(row.status);
    if (status === 'PRESENT') result.present += 1;
    else if (status === 'ABSENT') result.absent += 1;
    else if (status === 'LATE') result.late += 1;
    else if (status === 'EXCUSED') result.excused += 1;
    else result.unknown += 1;
  }
  const denominator = result.present + result.late + result.absent;
  if (denominator > 0) result.attendanceRate = Math.round(100 * (result.present + result.late) / denominator);
  return result;
}

type SubjectGroup = {
  id: number; grade: string; centerId: string;
  teacher: { name: string; subject: string; centerId: string };
  course: { name: string; subject: string; centerId: string } | null;
};
export function groupLabel(group: SubjectGroup, centerId: string) {
  return {
    groupId: group.id, group: group.grade,
    subject: group.course?.centerId === centerId ? group.course.subject : group.teacher.centerId === centerId ? group.teacher.subject : 'مادة غير محددة',
    teacher: group.teacher.centerId === centerId ? group.teacher.name : '',
  };
}
export const learningGroupInclude = { teacher: { select: { name: true, subject: true, centerId: true } }, course: { select: { name: true, subject: true, centerId: true } } } as const;


export async function readMonthlyLearningReport(client: Prisma.TransactionClient, student: StudentLabel, centerId: string, month: string) {
  const studentId = student.id;
  const range = monthRange(month);
  // Await each query before starting the next. A stale client can throw synchronously.
  const attendance = await client.attendance.findMany({ where: { studentId, student: { centerId }, group: { centerId }, date: range }, include: { group: { include: learningGroupInclude } }, orderBy: [{ date: 'asc' }, { groupId: 'asc' }] });
  const rawGrades = await client.gradeRecord.findMany({ where: { ...visibleGrades(centerId), studentId, student: { centerId }, group: { centerId }, assessedOn: range }, include: { group: { include: learningGroupInclude }, exam: gradeExam }, orderBy: [{ assessedOn: 'asc' }, { createdAt: 'asc' }] });
  const grades = rawGrades.filter(consistentExam);
  const attendanceRows = attendance.map((row) => ({ date: row.date, status: attendanceStatus(row.status), ...groupLabel(row.group, centerId) }));
  const gradeRows = grades.map((row) => ({ id: row.id, title: row.title, assessedOn: row.assessedOn, score: row.score, maxScore: row.maxScore, percentage: Math.round(row.score / row.maxScore * 1000) / 10, ...groupLabel(row.group, centerId) }));
  const groupIds = [...new Set([...attendance.map((row) => row.groupId), ...grades.map((row) => row.groupId)])];
  const subjects = groupIds.map((groupId) => {
    const group = attendance.find((row) => row.groupId === groupId)?.group || grades.find((row) => row.groupId === groupId)!.group;
    const marks = grades.filter((row) => row.groupId === groupId);
    const score = marks.reduce((total, row) => total + row.score, 0);
    const maxScore = marks.reduce((total, row) => total + row.maxScore, 0);
    return { ...groupLabel(group, centerId), attendance: summary(attendanceRows.filter((row) => row.groupId === groupId)), gradeCount: marks.length, score, maxScore, percentage: maxScore ? Math.round(score / maxScore * 1000) / 10 : null };
  });
  return { student, month, attendance: { summary: summary(attendanceRows), records: attendanceRows }, grades: gradeRows, subjects };
}

export async function readLearningReport(client: Prisma.TransactionClient, student: StudentLabel, centerId: string, month: string, date: string) {
  const studentId = student.id;
  // Do not start sibling work that could outlive a failed interactive transaction.
  const report = await readMonthlyLearningReport(client, student, centerId, month);
  const enrollments = await client.enrollment.findMany({ where: { studentId, student: { centerId }, group: { centerId } }, include: { group: { include: learningGroupInclude } }, orderBy: { groupId: 'asc' } });
  const lessons = await client.lessonSession.findMany({ where: { date, group: { centerId, enrollments: { some: { studentId, student: { centerId } } } } }, include: { group: { include: learningGroupInclude } }, orderBy: [{ startsAt: 'asc' }, { groupId: 'asc' }] });
  const attendance = await client.attendance.findMany({ where: { studentId, student: { centerId }, group: { centerId }, date }, include: { group: { include: learningGroupInclude } }, orderBy: { groupId: 'asc' } });
  const rawRecentGrades = await client.gradeRecord.findMany({ where: { ...visibleGrades(centerId), studentId, student: { centerId }, group: { centerId }, assessedOn: { lte: date } }, include: { group: { include: learningGroupInclude }, exam: gradeExam }, orderBy: [{ assessedOn: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], take: 5 });
  const examSchedule = await client.exam.findMany({ where: { date: { gte: date }, group: { centerId, enrollments: { some: { studentId } } } }, include: { group: { include: learningGroupInclude } }, orderBy: [{ date: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }], take: 20 });
  const rawExamResults = await client.gradeRecord.findMany({ where: { ...visibleGrades(centerId), examId: { not: null }, studentId, student: { centerId }, group: { centerId } }, include: { group: { include: learningGroupInclude }, exam: gradeExam }, orderBy: [{ assessedOn: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], take: 20 });
  const recentGrades = rawRecentGrades.filter(consistentExam), examResults = rawExamResults.filter(consistentExam);
  const groups = new Map<number, (typeof lessons)[number]['group']>();
  for (const row of lessons) groups.set(row.groupId, row.group);
  for (const row of attendance) groups.set(row.groupId, row.group);
  const today = [...groups.values()].map(group => {
    const record = attendance.find(row => row.groupId === group.id);
    return { ...groupLabel(group, centerId), status: record ? attendanceStatus(record.status) : null,
      lessons: lessons.filter(row => row.groupId === group.id).map(row => ({ id: row.id, startsAt: row.startsAt, endsAt: row.endsAt, status: row.status, topic: row.topic })),
    };
  });
  // Keep the old monthly endpoint's shape; the new unified view also lists unrecorded enrolled subjects.
  const subjects = [...report.subjects];
  for (const { group } of enrollments) if (!subjects.some(row => row.groupId === group.id)) subjects.push({ ...groupLabel(group, centerId), attendance: summary([]), gradeCount: 0, score: 0, maxScore: 0, percentage: null });
  return { student, date, month, today, examSchedule: examSchedule.map(exam => ({ id: exam.id, title: exam.title, date: exam.date, startsAt: exam.startsAt, endsAt: exam.endsAt, timezone: exam.timezone, maxScore: exam.maxScore, ...groupLabel(exam.group, centerId) })), examResults: examResults.map(row => ({ examId: row.examId, revision: row.revision, title: row.title, assessedOn: row.assessedOn, score: row.score, maxScore: row.maxScore, ...groupLabel(row.group, centerId) })), recentGrades: recentGrades.map(row => ({ id: row.id, ...groupLabel(row.group, centerId), title: row.title, assessedOn: row.assessedOn, score: row.score, maxScore: row.maxScore, percentage: Math.round(row.score / row.maxScore * 1000) / 10 })), report: { ...report, subjects }, code: `STUDENT:${studentId}` };
                                                                                                                                                                                                        }
