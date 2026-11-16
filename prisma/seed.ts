import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma.js';
import { PERMISSIONS, permissionsFor } from '../src/permissions.js';

const passwordHash = await bcrypt.hash('ChangeMe123!', 12);
const center = await prisma.center.upsert({
  where: { slug: 'demo-center' },
  update: { name: 'سنتر تجريبي شامل' },
  create: { name: 'سنتر تجريبي شامل', slug: 'demo-center' },
});

const mainBranch = await prisma.branch.upsert({
  where: { centerId_name: { centerId: center.id, name: 'الفرع الرئيسي' } },
  update: {},
  create: { centerId: center.id, name: 'الفرع الرئيسي' },
});
const secondBranch = await prisma.branch.upsert({
  where: { centerId_name: { centerId: center.id, name: 'فرع مدينة نصر' } },
  update: {},
  create: { centerId: center.id, name: 'فرع مدينة نصر' },
});

for (const key of PERMISSIONS) {
  await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key.replace(/[._]/g, ' ') } });
}
for (const key of permissionsFor('CENTER_OWNER')) {
  await prisma.rolePermission.upsert({ where: { role_permissionKey: { role: 'CENTER_OWNER', permissionKey: key } }, update: {}, create: { role: 'CENTER_OWNER', permissionKey: key } });
}

const owner = await prisma.user.upsert({
  where: { email: 'owner@example.local' },
  update: { passwordHash, centerId: center.id, branchId: mainBranch.id, role: 'CENTER_OWNER', active: true },
  create: { email: 'owner@example.local', passwordHash, name: 'مالك السنتر', role: 'CENTER_OWNER', centerId: center.id, branchId: mainBranch.id },
});
await prisma.centerMembership.upsert({ where: { userId_centerId: { userId: owner.id, centerId: center.id } }, update: { role: 'CENTER_OWNER', active: true }, create: { userId: owner.id, centerId: center.id, role: 'CENTER_OWNER' } });
await prisma.branchMembership.upsert({ where: { userId_branchId: { userId: owner.id, branchId: mainBranch.id } }, update: { active: true }, create: { userId: owner.id, branchId: mainBranch.id } });

const teacherNames = ['محمد علي', 'سارة أحمد', 'أحمد سمير', 'منى خالد', 'خالد حسن', 'نورهان عادل', 'إبراهيم محمود', 'ريم مصطفى', 'يوسف طارق', 'هبة ممدوح', 'طارق جلال', 'مي عبدالرحمن', 'محمود رجب', 'بسمة فتحي', 'عمرو فؤاد', 'دينا سامح', 'حسام نبيل', 'آية وليد', 'شريف جمال', 'رانيا عاطف'];
const subjects = ['رياضيات', 'علوم', 'لغة عربية', 'لغة إنجليزية', 'فيزياء', 'كيمياء', 'أحياء', 'دراسات اجتماعية', 'حاسب آلي', 'فرنساوي', 'رياضيات', 'علوم', 'لغة عربية', 'لغة إنجليزية', 'فيزياء', 'كيمياء', 'أحياء', 'حاسب آلي', 'دراسات اجتماعية', 'فرنساوي'];
const teachers: Array<{ id: number; name: string; subject: string; branchId: string }> = [];

for (let index = 0; index < 20; index += 1) {
  const id = 101 + index;
  const branchId = index % 2 === 0 ? mainBranch.id : secondBranch.id;
  const email = `teacher${index + 1}@demo.local`;
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, name: `أ/ ${teacherNames[index]}`, role: 'TEACHER', centerId: center.id, branchId, active: true },
    create: { email, passwordHash, name: `أ/ ${teacherNames[index]}`, role: 'TEACHER', centerId: center.id, branchId },
  });
  await prisma.centerMembership.upsert({ where: { userId_centerId: { userId: user.id, centerId: center.id } }, update: { role: 'TEACHER', active: true }, create: { userId: user.id, centerId: center.id, role: 'TEACHER' } });
  await prisma.branchMembership.upsert({ where: { userId_branchId: { userId: user.id, branchId } }, update: { active: true }, create: { userId: user.id, branchId } });
  await prisma.teacher.upsert({ where: { id }, update: { centerId: center.id, branchId, userId: user.id, name: `أ/ ${teacherNames[index]}`, subject: subjects[index], phone: `010${String(10000000 + index * 731).slice(-8)}` }, create: { id, centerId: center.id, branchId, userId: user.id, name: `أ/ ${teacherNames[index]}`, subject: subjects[index], phone: `010${String(10000000 + index * 731).slice(-8)}` } });
  teachers.push({ id, name: `أ/ ${teacherNames[index]}`, subject: subjects[index], branchId });
}

const grades = ['الأول الإعدادي', 'الثاني الإعدادي', 'الثالث الإعدادي', 'الأول الثانوي', 'الثاني الثانوي', 'الثالث الثانوي'];
const days = ['السبت، الثلاثاء', 'الأحد، الأربعاء', 'الاثنين، الخميس'];
const times = ['3:00 م', '4:30 م', '6:00 م', '7:30 م'];
const academicYear = await prisma.academicYear.upsert({ where: { centerId_name: { centerId: center.id, name: '2026 / 2027' } }, update: { active: true }, create: { centerId: center.id, name: '2026 / 2027', startsOn: '2026-09-01', endsOn: '2027-06-30', active: true } });
const courseNames = ['الرياضيات العامة', 'العلوم المتكاملة', 'اللغة العربية', 'اللغة الإنجليزية', 'الفيزياء والكيمياء', 'الأحياء والدراسات'];
const courses: string[] = [];
for (let index = 0; index < courseNames.length; index += 1) {
  const course = await prisma.course.upsert({ where: { centerId_name_grade: { centerId: center.id, name: courseNames[index], grade: grades[index % grades.length] } }, update: { subject: subjects[index], active: true }, create: { centerId: center.id, name: courseNames[index], subject: subjects[index], grade: grades[index % grades.length] } });
  courses.push(course.id);
}
const classrooms: string[] = [];
for (let index = 0; index < 8; index += 1) {
  const branchId = index % 2 === 0 ? mainBranch.id : secondBranch.id;
  const room = await prisma.classroom.upsert({ where: { centerId_name: { centerId: center.id, name: `قاعة ${index + 1}` } }, update: { branchId, capacity: 24 + (index % 4) * 6 }, create: { centerId: center.id, branchId, name: `قاعة ${index + 1}`, capacity: 24 + (index % 4) * 6 } });
  classrooms.push(room.id);
}
const groups: Array<{ id: number; teacherId: number; branchId: string; price: number }> = [];

for (let index = 0; index < 40; index += 1) {
  const teacher = teachers[index % teachers.length];
  const id = 101 + index;
  const price = 150 + (index % 5) * 25;
  await prisma.group.upsert({
    where: { id },
    update: { centerId: center.id, branchId: teacher.branchId, teacherId: teacher.id, grade: grades[index % grades.length], days: days[index % days.length], time: times[index % times.length], price, courseId: courses[index % courses.length], academicYearId: academicYear.id },
    create: { id, centerId: center.id, branchId: teacher.branchId, teacherId: teacher.id, grade: grades[index % grades.length], days: days[index % days.length], time: times[index % times.length], price, courseId: courses[index % courses.length], academicYearId: academicYear.id },
  });
  groups.push({ id, teacherId: teacher.id, branchId: teacher.branchId, price });
}

const weekDays = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
for (let index = 0; index < groups.length; index += 1) {
  const group = groups[index];
  const firstDay = weekDays[index % weekDays.length];
  const secondDay = weekDays[(index + 3) % weekDays.length];
  const scheduleRows = [
    { dayOfWeek: firstDay, startsAt: times[index % times.length], endsAt: times[(index + 1) % times.length], classroomId: classrooms[index % classrooms.length] },
    { dayOfWeek: secondDay, startsAt: times[(index + 1) % times.length], endsAt: times[(index + 2) % times.length], classroomId: classrooms[(index + 1) % classrooms.length] },
  ];
  for (const row of scheduleRows) {
    const schedule = await prisma.schedule.upsert({ where: { groupId_dayOfWeek_startsAt: { groupId: group.id, dayOfWeek: row.dayOfWeek, startsAt: row.startsAt } }, update: { endsAt: row.endsAt, classroomId: row.classroomId }, create: { groupId: group.id, dayOfWeek: row.dayOfWeek, startsAt: row.startsAt, endsAt: row.endsAt, classroomId: row.classroomId } });
    for (let occurrence = -2; occurrence < 10; occurrence += 1) {
      const dateValue = new Date();
      dateValue.setDate(dateValue.getDate() + (occurrence * 7) + (index % 6));
      const date = dateValue.toISOString().slice(0, 10);
      const status = occurrence < 0 ? 'completed' : occurrence === 0 ? 'active' : occurrence === 7 ? 'cancelled' : 'scheduled';
      await prisma.lessonSession.upsert({ where: { groupId_date_startsAt: { groupId: group.id, date, startsAt: row.startsAt } }, update: { scheduleId: schedule.id, classroomId: row.classroomId, endsAt: row.endsAt, status, topic: `${courseNames[index % courseNames.length]} · محاضرة ${occurrence + 1}` }, create: { groupId: group.id, scheduleId: schedule.id, classroomId: row.classroomId, date, startsAt: row.startsAt, endsAt: row.endsAt, status, topic: `${courseNames[index % courseNames.length]} · محاضرة ${occurrence + 1}` } });
    }
  }
}

const firstNames = ['أحمد', 'يوسف', 'مريم', 'نور', 'سيف', 'ملك', 'عمر', 'ليان', 'علي', 'جنى', 'حمزة', 'تاليا', 'كريم', 'سلمى', 'زياد', 'فرح', 'آدم', 'لارا', 'مازن', 'هدى'];
const lastNames = ['محمود', 'إبراهيم', 'حسن', 'خالد', 'مصطفى', 'عادل', 'طارق', 'سمير', 'ممدوح', 'فتحي', 'سعيد', 'عاطف', 'رجب', 'كمال', 'مجدي'];
const students: Array<{ id: number; name: string; branchId: string; groupIds: number[] }> = [];

for (let index = 0; index < 125; index += 1) {
  const id = 1001 + index;
  const branchId = index % 2 === 0 ? mainBranch.id : secondBranch.id;
  const name = `${firstNames[index % firstNames.length]} ${lastNames[(index * 7) % lastNames.length]}`;
  const groupIds = [groups[index % groups.length].id];
  if (index % 4 === 0) groupIds.push(groups[(index + 7) % groups.length].id);
  const phone = `011${String(20000000 + index * 137).slice(-8)}`;
  const parent = `012${String(30000000 + index * 173).slice(-8)}`;
  const studentUser = index < 10 ? await prisma.user.upsert({ where: { email: `student${index + 1}@demo.local` }, update: { passwordHash, name, role: 'STUDENT', centerId: center.id, branchId, active: true }, create: { email: `student${index + 1}@demo.local`, passwordHash, name, role: 'STUDENT', centerId: center.id, branchId } }) : null;
  if (studentUser) await prisma.centerMembership.upsert({ where: { userId_centerId: { userId: studentUser.id, centerId: center.id } }, update: { role: 'STUDENT', active: true }, create: { userId: studentUser.id, centerId: center.id, role: 'STUDENT' } });
  await prisma.student.upsert({ where: { id }, update: { centerId: center.id, branchId, userId: studentUser?.id, name, phone, parent }, create: { id, centerId: center.id, branchId, userId: studentUser?.id, name, phone, parent } });
  for (const groupId of groupIds) await prisma.enrollment.upsert({ where: { studentId_groupId: { studentId: id, groupId } }, update: {}, create: { studentId: id, groupId } });
  students.push({ id, name, branchId, groupIds });
}

const guardianNames = ['محمد محمود', 'سارة إبراهيم', 'خالد حسن', 'منى عادل', 'أحمد طارق', 'هبة مصطفى', 'عمر سعيد', 'ريم كمال'];
for (let index = 0; index < guardianNames.length; index += 1) {
  const email = `parent${index + 1}@demo.local`;
  const user = await prisma.user.upsert({ where: { email }, update: { passwordHash, name: guardianNames[index], role: 'GUARDIAN', centerId: center.id, branchId: index % 2 === 0 ? mainBranch.id : secondBranch.id, active: true }, create: { email, passwordHash, name: guardianNames[index], role: 'GUARDIAN', centerId: center.id, branchId: index % 2 === 0 ? mainBranch.id : secondBranch.id } });
  await prisma.centerMembership.upsert({ where: { userId_centerId: { userId: user.id, centerId: center.id } }, update: { role: 'GUARDIAN', active: true }, create: { userId: user.id, centerId: center.id, role: 'GUARDIAN' } });
  const guardian = await prisma.guardian.upsert({ where: { userId: user.id }, update: { centerId: center.id, name: guardianNames[index], phone: `010${String(40000000 + index * 991).slice(-8)}` }, create: { centerId: center.id, userId: user.id, name: guardianNames[index], phone: `010${String(40000000 + index * 991).slice(-8)}` } });
  const children = students.filter((_, studentIndex) => studentIndex % guardianNames.length === index).slice(0, 4);
  for (const child of children) await prisma.studentGuardian.upsert({ where: { guardianId_studentId: { guardianId: guardian.id, studentId: child.id } }, update: { relation: 'ولي أمر' }, create: { guardianId: guardian.id, studentId: child.id, relation: 'ولي أمر' } });
}

const attendanceStatuses = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'];
for (const student of students) {
  for (const groupId of student.groupIds) {
    const group = groups.find((item) => item.id === groupId)!;
    for (let offset = 0; offset < 12; offset += 1) {
      const date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
      const status = attendanceStatuses[(student.id + groupId + offset) % attendanceStatuses.length];
      await prisma.attendance.upsert({ where: { studentId_groupId_date: { studentId: student.id, groupId, date } }, update: { status, note: status === 'ABSENT' ? 'غياب تجريبي يحتاج متابعة' : null }, create: { studentId: student.id, groupId, date, status, note: status === 'ABSENT' ? 'غياب تجريبي يحتاج متابعة' : null } });
    }
    for (const month of ['2026-09', '2026-10', '2026-11']) {
      const paid = (student.id + groupId + month.length) % 5 !== 0;
      await prisma.payment.upsert({ where: { studentId_groupId_month: { studentId: student.id, groupId, month } }, update: { amount: paid ? group.price : 0, status: paid ? 'paid' : 'pending', reference: paid ? `SEED-${student.id}-${groupId}-${month}` : null }, create: { studentId: student.id, groupId, month, amount: paid ? group.price : 0, status: paid ? 'paid' : 'pending', reference: paid ? `SEED-${student.id}-${groupId}-${month}` : null } });
      const subscriptionStatus = paid ? ((student.id + groupId) % 7 === 0 ? 'partial' : 'paid') : ((student.id + groupId) % 3 === 0 ? 'overdue' : 'pending');
      await prisma.subscription.upsert({ where: { studentId_groupId_month: { studentId: student.id, groupId, month } }, update: { amount: group.price, discount: subscriptionStatus === 'partial' ? 25 : 0, dueOn: `${month}-10`, status: subscriptionStatus }, create: { studentId: student.id, groupId, month, amount: group.price, discount: subscriptionStatus === 'partial' ? 25 : 0, dueOn: `${month}-10`, status: subscriptionStatus } });
    }
  }
}

console.log(`Seeded demo dataset: 125 students, 20 teachers, 40 groups, 8 classrooms, weekly lesson sessions, subscriptions, attendance history, and 3 months of payments.`);
console.log('Owner: owner@example.local / ChangeMe123!');
console.log('Teacher example: teacher1@demo.local / ChangeMe123!');
console.log('Student example: student1@demo.local / ChangeMe123!');
console.log('Parent example: parent1@demo.local / ChangeMe123!');
await prisma.$disconnect();
