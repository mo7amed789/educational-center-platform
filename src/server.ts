import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { registerMonthlyReportRoutes } from './monthlyReports.js';
import { createSession, destroySession, publicUser, requirePermission, requireUser, currentUser, generateMfaSecret, verifyMfaCode, SESSION_COOKIE } from './auth.js';
import { authorize } from './authorization.js';
import { migrateLegacyData } from './legacyMigration.js';
import ExcelJS from 'exceljs';
import QRCode from 'qrcode';

const startedAt = Date.now();
const requestMetrics = { total: 0, errors: 0, byStatus: new Map<number, number>() };

function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'replace-with-a-long-random-secret' || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be a strong production secret');
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('file:')) throw new Error('DATABASE_URL must point to PostgreSQL in production');
}

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : true, bodyLimit: 1024 * 1024 });
  app.register(cookie);
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.addHook('onResponse', async (request, reply) => {
    requestMetrics.total += 1;
    requestMetrics.byStatus.set(reply.statusCode, (requestMetrics.byStatus.get(reply.statusCode) || 0) + 1);
    if (reply.statusCode >= 500) requestMetrics.errors += 1;
  });

  app.get('/', async (_request, reply) => {
    const html = await readFile(path.join(process.cwd(), 'center-admin-v2.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/center-admin-v2.html', async (_request, reply) => {
    const html = await readFile(path.join(process.cwd(), 'center-admin-v2.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/healthz', async () => ({ ok: true, service: 'educational-center-platform' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, database: 'ready' };
    } catch {
      return reply.code(503).send({ ok: false, database: 'unavailable' });
    }
  });
  app.get('/metrics', async (_request, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    const lines = [
      '# HELP app_uptime_seconds Application uptime in seconds',
      '# TYPE app_uptime_seconds gauge',
      `app_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
      '# HELP http_requests_total Total HTTP responses',
      '# TYPE http_requests_total counter',
      `http_requests_total ${requestMetrics.total}`,
      '# HELP http_errors_total Total HTTP 5xx responses',
      '# TYPE http_errors_total counter',
      `http_errors_total ${requestMetrics.errors}`,
    ];
    for (const [status, count] of requestMetrics.byStatus) lines.push(`http_responses_total{status="${status}"} ${count}`);
    return lines.join('\n') + '\n';
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const parsed = z.object({ email: z.string().email().transform((v) => v.toLowerCase()), password: z.string().min(8).max(200), mfaCode: z.string().regex(/^\d{6}$/).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'INVALID_INPUT' });
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || !user.active || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    if (user.mfaEnabled && (!user.mfaSecret || !parsed.data.mfaCode || !verifyMfaCode(user.mfaSecret, parsed.data.mfaCode))) return reply.code(401).send({ error: 'MFA_REQUIRED' });
    await createSession(user, reply);
    await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id } });
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => { await destroySession(request, reply); return { ok: true }; });
  app.get('/api/auth/me', async (request, reply) => { const user = await currentUser(request); if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' }); return { user: publicUser(user) }; });

  app.post('/api/auth/mfa/setup', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const secret = generateMfaSecret();
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecret: secret, mfaEnabled: false } });
    const label = encodeURIComponent(`${user.centerId || 'platform'}:${user.email}`);
    const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=Educational%20Center`;
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
    return { secret, otpauthUrl, qrDataUrl };
  });

  app.post('/api/auth/mfa/enable', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    const record = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true } });
    if (!record?.mfaSecret || !verifyMfaCode(record.mfaSecret, input.code)) return reply.code(422).send({ error: 'INVALID_MFA_CODE' });
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'auth.mfa.enable', entity: 'User', entityId: user.id } });
    return { enabled: true };
  });

  app.post('/api/auth/mfa/disable', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    const record = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true } });
    if (!record?.mfaSecret || !verifyMfaCode(record.mfaSecret, input.code)) return reply.code(422).send({ error: 'INVALID_MFA_CODE' });
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecret: null } });
    await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'auth.mfa.disable', entity: 'User', entityId: user.id } });
    return { enabled: false };
  });

  app.post('/api/auth/password/change', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const input = z.object({ currentPassword: z.string().min(8).max(200), newPassword: z.string().min(12).max(200) }).parse(request.body);
    if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) return reply.code(422).send({ error: 'INVALID_CURRENT_PASSWORD' });
    if (input.currentPassword === input.newPassword) return reply.code(422).send({ error: 'PASSWORD_MUST_CHANGE' });
    const passwordHash = await bcrypt.hash(input.newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'auth.password.change', entity: 'User', entityId: user.id } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { changed: true, requiresLogin: true };
  });

  app.post('/api/legacy/import', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'settings.manage', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    try {
      const summary = await migrateLegacyData(request.body, user.centerId);
      await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'legacy.import', entity: 'LegacyData', metadata: JSON.stringify(summary) } });
      return { summary };
    } catch { return reply.code(422).send({ error: 'INVALID_LEGACY_DATA' }); }
  });

  app.post('/api/import/excel', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'settings.manage', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const upload = await request.file();
    if (!upload) return reply.code(422).send({ error: 'FILE_REQUIRED' });
    const extension = upload.filename.toLowerCase().split('.').pop();
    if (extension !== 'xlsx') return reply.code(422).send({ error: 'XLSX_FILE_REQUIRED' });
    const buffer = await upload.toBuffer();
    const isZipWorkbook = buffer.length >= 4 && buffer.subarray(0, 2).toString() === 'PK';
    if (!isZipWorkbook) return reply.code(422).send({ error: 'INVALID_XLSX_SIGNATURE' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheetRows = (names: string[]) => {
      const wanted = names.map((name) => name.toLowerCase());
      const sheet = workbook.worksheets.find((item) => wanted.includes(item.name.toLowerCase()) || wanted.some((wantedName) => item.name.toLowerCase().includes(wantedName)));
      if (!sheet) return [];
      const rows: Record<string, unknown>[] = [];
      const headers: string[] = [];
      sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, columnNumber) => { headers[columnNumber - 1] = String(cell.value ?? '').trim(); });
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const record: Record<string, unknown> = {};
        row.eachCell({ includeEmpty: true }, (cell, columnNumber) => { if (headers[columnNumber - 1]) record[headers[columnNumber - 1]] = typeof cell.value === 'object' && cell.value && 'text' in cell.value ? cell.value.text : cell.value ?? ''; });
        if (Object.values(record).some((item) => String(item).trim() !== '')) rows.push(record);
      });
      return rows;
    };
    const value = (row: Record<string, unknown>, keys: string[]) => {
      const entry = Object.entries(row).find(([key]) => keys.some((candidate) => key.trim().toLowerCase() === candidate.toLowerCase()));
      return entry ? entry[1] : '';
    };
    const textValue = (row: Record<string, unknown>, keys: string[]) => String(value(row, keys) ?? '').trim();
    const numberValue = (row: Record<string, unknown>, keys: string[]) => Number(value(row, keys) || 0);
    const splitIds = (raw: string) => raw.split(/[,،|]/).map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
    const statusValue = (raw: string) => ({ present: 'p', حاضر: 'p', absent: 'a', غائب: 'a', late: 'l', متأخر: 'l', excused: 'e', معذور: 'e' } as Record<string, string>)[raw.toLowerCase()] || raw.toLowerCase();
    const data = {
      teachers: sheetRows(['teachers', 'المدرسين', 'المدرسون']).map((row) => ({ id: numberValue(row, ['id', 'رقم المدرس', 'معرف المدرس']), name: textValue(row, ['name', 'الاسم', 'اسم المدرس']), subject: textValue(row, ['subject', 'المادة']), phone: textValue(row, ['phone', 'الهاتف', 'رقم الهاتف']) })).filter((row) => row.id && row.name && row.subject),
      groups: sheetRows(['groups', 'المجموعات']).map((row) => ({ id: numberValue(row, ['id', 'رقم المجموعة', 'معرف المجموعة']), t: numberValue(row, ['teacherId', 'teacher', 'معرف المدرس', 'رقم المدرس']), grade: textValue(row, ['grade', 'الصف']), days: textValue(row, ['days', 'الأيام']), time: textValue(row, ['time', 'الميعاد', 'الوقت']), price: numberValue(row, ['price', 'السعر', 'الاشتراك']) })).filter((row) => row.id && row.t && row.grade),
      students: sheetRows(['students', 'الطلاب']).map((row) => ({ id: numberValue(row, ['id', 'رقم الطالب', 'معرف الطالب']), name: textValue(row, ['name', 'الاسم', 'اسم الطالب']), phone: textValue(row, ['phone', 'الهاتف', 'رقم الهاتف']), parent: textValue(row, ['parent', 'ولي الأمر', 'هاتف ولي الأمر']), g: splitIds(textValue(row, ['groups', 'groupIds', 'المجموعات', 'أرقام المجموعات'])) })).filter((row) => row.id && row.name),
      att: Object.fromEntries(sheetRows(['attendance', 'الحضور']).map((row) => [`${numberValue(row, ['groupId', 'رقم المجموعة'])}|${textValue(row, ['date', 'التاريخ'])}`, { [numberValue(row, ['studentId', 'رقم الطالب'])]: statusValue(textValue(row, ['status', 'الحالة'])) }])),
      pay: {},
    };
    try {
      const summary = await migrateLegacyData(data, user.centerId);
      const subscriptions = sheetRows(['subscriptions', 'الاشتراكات']).map((row) => ({ studentId: numberValue(row, ['studentId', 'رقم الطالب']), groupId: numberValue(row, ['groupId', 'رقم المجموعة']), month: textValue(row, ['month', 'الشهر']), amount: numberValue(row, ['amount', 'المبلغ']), discount: numberValue(row, ['discount', 'الخصم']), dueOn: textValue(row, ['dueOn', 'dueDate', 'تاريخ الاستحقاق']), status: textValue(row, ['status', 'الحالة']) || 'pending' })).filter((row) => row.studentId && row.groupId && /^\d{4}-\d{2}$/.test(row.month));
      for (const item of subscriptions) {
        await prisma.subscription.upsert({ where: { studentId_groupId_month: { studentId: item.studentId, groupId: item.groupId, month: item.month } }, update: item, create: item });
      }
      await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'excel.import', entity: 'Workbook', metadata: JSON.stringify({ filename: upload.filename, subscriptions: subscriptions.length, summary }) } });
      return { summary: { ...summary, subscriptions: subscriptions.length }, sheets: workbook.worksheets.map((sheet) => sheet.name) };
    } catch {
      return reply.code(422).send({ error: 'INVALID_EXCEL_DATA', message: 'راجع أسماء الأوراق والأعمدة المطلوبة' });
    }
  });

  app.get('/api/export/excel', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'finance.export', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const [teachers, groups, students, attendance, subscriptions] = await prisma.$transaction([
      prisma.teacher.findMany({ where: { centerId: user.centerId }, orderBy: { id: 'asc' } }),
      prisma.group.findMany({ where: { centerId: user.centerId }, orderBy: { id: 'asc' } }),
      prisma.student.findMany({ where: { centerId: user.centerId }, include: { enrollments: { select: { groupId: true } } }, orderBy: { id: 'asc' } }),
      prisma.attendance.findMany({ where: { group: { centerId: user.centerId } }, orderBy: [{ date: 'asc' }, { groupId: 'asc' }, { studentId: 'asc' }] }),
      prisma.subscription.findMany({ where: { group: { centerId: user.centerId } }, orderBy: [{ month: 'desc' }, { studentId: 'asc' }] }),
    ]);
    const workbook = new ExcelJS.Workbook();
    const addSheet = (name: string, rows: Array<Record<string, unknown>>) => {
      const sheet = workbook.addWorksheet(name);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      sheet.columns = columns.map((key) => ({ header: key, key, width: Math.max(14, Math.min(36, key.length + 8)) }));
      rows.forEach((row) => sheet.addRow(row));
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    };
    addSheet('Teachers', teachers.map((item) => ({ id: item.id, name: item.name, subject: item.subject, phone: item.phone || '' })));
    addSheet('Groups', groups.map((item) => ({ id: item.id, teacherId: item.teacherId, grade: item.grade, days: item.days, time: item.time, price: item.price })));
    addSheet('Students', students.map((item) => ({ id: item.id, name: item.name, phone: item.phone || '', parent: item.parent || '', groups: item.enrollments.map((enrollment) => enrollment.groupId).join(',') })));
    addSheet('Attendance', attendance.map((item) => ({ studentId: item.studentId, groupId: item.groupId, date: item.date, status: item.status, note: item.note || '' })));
    addSheet('Subscriptions', subscriptions.map((item) => ({ studentId: item.studentId, groupId: item.groupId, month: item.month, amount: item.amount, discount: item.discount, dueOn: item.dueOn, status: item.status })));
    const output = Buffer.from(await workbook.xlsx.writeBuffer());
    await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'excel.export', entity: 'Workbook', metadata: JSON.stringify({ teachers: teachers.length, groups: groups.length, students: students.length, attendance: attendance.length, subscriptions: subscriptions.length }) } });
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="center-export-${new Date().toISOString().slice(0, 10)}.xlsx"`).send(output);
  });

  app.get('/api/students', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || (!(await authorize(user.id, 'students.view', { centerId: user.centerId })) && !(await authorize(user.id, 'students.view_assigned', { centerId: user.centerId })))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), search: z.string().trim().max(100).optional() }).parse(request.query);
    const canViewCenterStudents = ['SUPER_ADMIN', 'CENTER_OWNER', 'CENTER_ADMIN', 'BRANCH_ADMIN', 'RECEPTIONIST'].includes(user.role);
    const where = canViewCenterStudents
      ? { centerId: user.centerId, ...(query.search ? { name: { contains: query.search } } : {}) }
      : user.role === 'TEACHER'
        ? { centerId: user.centerId, enrollments: { some: { group: { teacher: { userId: user.id } } } }, ...(query.search ? { name: { contains: query.search } } : {}) }
      : user.role === 'STUDENT'
        ? { centerId: user.centerId, userId: user.id, ...(query.search ? { name: { contains: query.search } } : {}) }
        : null;
    if (!where) return reply.code(403).send({ error: 'RESOURCE_SCOPE_REQUIRED' });
    const [items, total] = await prisma.$transaction([prisma.student.findMany({ where, include: { enrollments: { select: { groupId: true } } }, orderBy: { name: 'asc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }), prisma.student.count({ where })]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  });

  app.get('/api/center/overview', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'groups.view', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (!['SUPER_ADMIN', 'CENTER_OWNER', 'CENTER_ADMIN', 'BRANCH_ADMIN', 'RECEPTIONIST', 'TEACHER'].includes(user.role)) return reply.code(403).send({ error: 'RESOURCE_SCOPE_REQUIRED' });
    let groupWhere: Record<string, unknown> = { centerId: user.centerId };
    if (user.role === 'TEACHER') {
      const teacher = await prisma.teacher.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!teacher) return reply.code(403).send({ error: 'TEACHER_PROFILE_REQUIRED' });
      groupWhere = { centerId: user.centerId, teacherId: teacher.id };
    }
    const [teachers, groups, courses, classrooms] = await prisma.$transaction([
      prisma.teacher.findMany({ where: { centerId: user.centerId }, orderBy: { name: 'asc' } }),
      prisma.group.findMany({ where: groupWhere, include: { schedules: true, lessons: { orderBy: { date: 'asc' }, take: 10 }, course: true }, orderBy: { id: 'asc' } }),
      prisma.course.findMany({ where: { centerId: user.centerId, active: true }, orderBy: { name: 'asc' } }),
      prisma.classroom.findMany({ where: { centerId: user.centerId }, orderBy: { name: 'asc' } }),
    ]);
    return { teachers, groups, courses, classrooms };
  });

  app.get('/api/center/reports/summary', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'reports.view', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(request.query);
    const month = query.month || new Date().toISOString().slice(0, 7);
    const [students, teachers, groups, attendance, subscriptions, revenue] = await prisma.$transaction([
      prisma.student.count({ where: { centerId: user.centerId } }),
      prisma.teacher.count({ where: { centerId: user.centerId } }),
      prisma.group.count({ where: { centerId: user.centerId } }),
      prisma.attendance.groupBy({ by: ['status'], where: { group: { centerId: user.centerId } }, orderBy: { status: 'asc' }, _count: { _all: true } }),
      prisma.subscription.groupBy({ by: ['status'], where: { group: { centerId: user.centerId }, month }, orderBy: { status: 'asc' }, _count: { _all: true } }),
      prisma.subscription.aggregate({ where: { group: { centerId: user.centerId }, month, status: { in: ['paid', 'partial'] } }, _sum: { amount: true, discount: true } }),
    ]);
    const countRows = (rows: Array<{ status: string; _count?: { _all?: number } }>) => Object.fromEntries(rows.map((item) => [item.status, item._count?._all || 0]));
    return { month, counts: { students, teachers, groups }, attendance: countRows(attendance as Array<{ status: string; _count?: { _all?: number } }>), subscriptions: countRows(subscriptions as Array<{ status: string; _count?: { _all?: number } }>), revenue: { amount: revenue._sum.amount || 0, discount: revenue._sum.discount || 0 } };
  });

  app.get('/api/center/audit-logs', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'audit.view', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const items = await prisma.auditLog.findMany({ where: { centerId: user.centerId }, orderBy: { createdAt: 'desc' }, take: query.limit, select: { id: true, action: true, entity: true, entityId: true, metadata: true, createdAt: true, userId: true } });
    return { items };
  });

  app.get('/api/center/sessions', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'groups.view', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(request.query);
    let groupScope: Record<string, unknown> = { centerId: user.centerId };
    if (user.role === 'TEACHER') {
      const teacher = await prisma.teacher.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!teacher) return reply.code(403).send({ error: 'TEACHER_PROFILE_REQUIRED' });
      groupScope = { centerId: user.centerId, teacherId: teacher.id };
    } else if (user.role === 'STUDENT') {
      groupScope = { centerId: user.centerId, enrollments: { some: { student: { userId: user.id } } } };
    } else if (user.role === 'GUARDIAN') {
      groupScope = { centerId: user.centerId, enrollments: { some: { student: { guardianLinks: { some: { guardian: { userId: user.id } } } } } } };
    }
    const items = await prisma.lessonSession.findMany({ where: { group: groupScope, ...(query.status ? { status: query.status } : {}), ...(query.date ? { date: query.date } : {}) }, include: { group: { include: { teacher: true, course: true } }, classroom: true }, orderBy: [{ date: 'asc' }, { startsAt: 'asc' }], take: 1000 });
    return { items };
  });

  app.get('/api/center/attendance', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'attendance.view', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), groupId: z.coerce.number().int().positive().optional() }).parse(request.query);
    let studentScope: Record<string, unknown> | undefined;
    let groupScope: Record<string, unknown> = { centerId: user.centerId };
    if (user.role === 'TEACHER') {
      const teacher = await prisma.teacher.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!teacher) return reply.code(403).send({ error: 'TEACHER_PROFILE_REQUIRED' });
      groupScope = { centerId: user.centerId, teacherId: teacher.id };
    } else if (user.role === 'STUDENT') {
      studentScope = { userId: user.id };
    } else if (user.role === 'GUARDIAN') {
      studentScope = { guardianLinks: { some: { guardian: { userId: user.id } } } };
    }
    const items = await prisma.attendance.findMany({ where: { group: groupScope, ...(studentScope ? { student: studentScope } : {}), ...(query.date ? { date: query.date } : {}), ...(query.groupId ? { groupId: query.groupId } : {}) }, include: { student: true, group: { include: { teacher: true } } }, orderBy: [{ date: 'desc' }, { student: { name: 'asc' } }], take: 500 });
    return { items };
  });

  app.post('/api/center/attendance', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'attendance.create', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({ studentId: z.coerce.number().int().positive(), groupId: z.coerce.number().int().positive(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']), note: z.string().trim().max(500).optional() }).parse(request.body);
    const group = await prisma.group.findFirst({ where: { id: input.groupId, centerId: user.centerId }, select: { id: true } });
    const enrollment = await prisma.enrollment.findUnique({ where: { studentId_groupId: { studentId: input.studentId, groupId: input.groupId } } });
    if (!group || !enrollment) return reply.code(422).send({ error: 'INVALID_ENROLLMENT' });
    if (user.role === 'TEACHER') {
      const teacher = await prisma.teacher.findUnique({ where: { userId: user.id }, select: { id: true } });
      const assigned = teacher ? await prisma.group.findFirst({ where: { id: input.groupId, teacherId: teacher.id }, select: { id: true } }) : null;
      if (!assigned) return reply.code(403).send({ error: 'GROUP_NOT_ASSIGNED' });
    }
    const attendance = await prisma.attendance.upsert({ where: { studentId_groupId_date: { studentId: input.studentId, groupId: input.groupId, date: input.date } }, update: { status: input.status, note: input.note }, create: input });
    await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'attendance.record', entity: 'Attendance', entityId: `${input.studentId}:${input.groupId}:${input.date}`, metadata: JSON.stringify({ status: input.status }) } });
    return { attendance };
  });

  app.get('/api/center/subscriptions', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'finance.view', { centerId: user.centerId })) || user.role === 'TEACHER') return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), status: z.enum(['paid', 'partial', 'pending', 'overdue']).optional() }).parse(request.query);
    let studentScope: Record<string, unknown> | undefined;
    if (user.role === 'STUDENT') studentScope = { userId: user.id };
    if (user.role === 'GUARDIAN') studentScope = { guardianLinks: { some: { guardian: { userId: user.id } } } };
    const items = await prisma.subscription.findMany({ where: { group: { centerId: user.centerId }, ...(studentScope ? { student: studentScope } : {}), ...(query.month ? { month: query.month } : {}), ...(query.status ? { status: query.status } : {}) }, include: { student: true, group: true }, orderBy: [{ month: 'desc' }, { status: 'asc' }], take: 1000 });
    return { items };
  });

  app.post('/api/center/subscriptions', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'finance.manage_fees', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({ studentId: z.coerce.number().int().positive(), groupId: z.coerce.number().int().positive(), month: z.string().regex(/^\d{4}-\d{2}$/), amount: z.coerce.number().int().nonnegative(), discount: z.coerce.number().int().nonnegative().default(0), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(['paid', 'partial', 'pending', 'overdue']) }).parse(request.body);
    const group = await prisma.group.findFirst({ where: { id: input.groupId, centerId: user.centerId }, select: { id: true } });
    const enrollment = await prisma.enrollment.findUnique({ where: { studentId_groupId: { studentId: input.studentId, groupId: input.groupId } } });
    if (!group || !enrollment) return reply.code(422).send({ error: 'INVALID_ENROLLMENT' });
    const subscription = await prisma.subscription.upsert({ where: { studentId_groupId_month: { studentId: input.studentId, groupId: input.groupId, month: input.month } }, update: { amount: input.amount, discount: input.discount, dueOn: input.dueOn, status: input.status }, create: input });
    await prisma.auditLog.create({ data: { centerId: user.centerId, userId: user.id, action: 'subscription.record', entity: 'Subscription', entityId: subscription.id, metadata: JSON.stringify({ studentId: input.studentId, groupId: input.groupId, month: input.month, status: input.status }) } });
    return { subscription };
  });

  // STUDENT CRUD
  app.post('/api/students', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'students.create', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({
      id: z.coerce.number().int().positive().optional(),
      name: z.string().trim().min(2).max(160),
      phone: z.string().trim().max(40).optional(),
      parent: z.string().trim().max(40).optional(),
      branchId: z.string().optional(),
      groupIds: z.array(z.coerce.number().int().positive()).default([]),
    }).parse(request.body);

    const studentId = input.id ?? ((await prisma.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id || 1000) + 1;
    const branch = input.branchId ? await prisma.branch.findFirst({ where: { id: input.branchId, centerId: user.centerId } }) : await prisma.branch.findFirst({ where: { centerId: user.centerId } });

    const student = await prisma.$transaction(async (tx) => {
      const created = await tx.student.create({
        data: {
          id: studentId,
          centerId: user.centerId!,
          branchId: branch?.id ?? null,
          name: input.name,
          phone: input.phone || null,
          parent: input.parent || null,
        },
      });
      for (const groupId of input.groupIds) {
        const group = await tx.group.findFirst({ where: { id: groupId, centerId: user.centerId! } });
        if (group) {
          await tx.enrollment.create({ data: { studentId, groupId } });
          const currentMonth = new Date().toISOString().slice(0, 7);
          await tx.subscription.upsert({
            where: { studentId_groupId_month: { studentId, groupId, month: currentMonth } },
            update: {},
            create: { studentId, groupId, month: currentMonth, amount: group.price, discount: 0, dueOn: `${currentMonth}-10`, status: 'pending' },
          });
        }
      }
      return created;
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'students.create', entity: 'Student', entityId: String(student.id), metadata: JSON.stringify({ name: student.name, groupIds: input.groupIds }) },
    });
    return { student };
  });

  app.put('/api/students/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'students.update', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const input = z.object({
      name: z.string().trim().min(2).max(160).optional(),
      phone: z.string().trim().max(40).optional(),
      parent: z.string().trim().max(40).optional(),
      branchId: z.string().optional(),
      groupIds: z.array(z.coerce.number().int().positive()).optional(),
    }).parse(request.body);

    const existing = await prisma.student.findFirst({ where: { id: params.id, centerId: user.centerId } });
    if (!existing) return reply.code(404).send({ error: 'STUDENT_NOT_FOUND' });

    const updated = await prisma.$transaction(async (tx) => {
      const student = await tx.student.update({
        where: { id: params.id },
        data: {
          name: input.name ?? existing.name,
          phone: input.phone !== undefined ? input.phone || null : existing.phone,
          parent: input.parent !== undefined ? input.parent || null : existing.parent,
          branchId: input.branchId !== undefined ? input.branchId || null : existing.branchId,
        },
      });
      if (input.groupIds) {
        await tx.enrollment.deleteMany({ where: { studentId: params.id } });
        for (const groupId of input.groupIds) {
          const group = await tx.group.findFirst({ where: { id: groupId, centerId: user.centerId! } });
          if (group) {
            await tx.enrollment.create({ data: { studentId: params.id, groupId } });
          }
        }
      }
      return student;
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'students.update', entity: 'Student', entityId: String(params.id) },
    });
    return { student: updated };
  });

  app.delete('/api/students/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'students.delete', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const existing = await prisma.student.findFirst({ where: { id: params.id, centerId: user.centerId } });
    if (!existing) return reply.code(404).send({ error: 'STUDENT_NOT_FOUND' });

    await prisma.$transaction(async (tx) => {
      await tx.enrollment.deleteMany({ where: { studentId: params.id } });
      await tx.attendance.deleteMany({ where: { studentId: params.id } });
      await tx.subscription.deleteMany({ where: { studentId: params.id } });
      await tx.payment.deleteMany({ where: { studentId: params.id } });
      await tx.studentGuardian.deleteMany({ where: { studentId: params.id } });
      await tx.student.delete({ where: { id: params.id } });
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'students.delete', entity: 'Student', entityId: String(params.id) },
    });
    return { ok: true };
  });

  app.get('/api/students/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'students.view', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    // Keep the generic detail route from bypassing the own-child portal boundary.
    const student = await prisma.student.findFirst({
      where: { id: params.id, centerId: user.centerId,
        ...(user.role === 'STUDENT' ? { userId: user.id } : {}),
        ...(user.role === 'GUARDIAN' ? { guardianLinks: { some: { guardian: { userId: user.id, centerId: user.centerId } } } } : {}),
      },
      include: {
        enrollments: { where: { group: { centerId: user.centerId } }, include: { group: { include: { teacher: true, course: true } } } },
        attendance: { where: { group: { centerId: user.centerId } }, orderBy: { date: 'desc' }, take: 30 },
        subscriptions: { where: { group: { centerId: user.centerId } }, orderBy: { month: 'desc' }, take: 12 },
        guardianLinks: { where: { guardian: { centerId: user.centerId } }, include: { guardian: true } },
      },
    });
    if (!student) return reply.code(404).send({ error: 'STUDENT_NOT_FOUND' });
    return { student };
  });

  // TEACHER CRUD
  app.post('/api/teachers', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'teachers.create', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({
      id: z.coerce.number().int().positive().optional(),
      name: z.string().trim().min(2).max(160),
      subject: z.string().trim().min(2).max(120),
      phone: z.string().trim().max(40).optional(),
      branchId: z.string().optional(),
      email: z.string().email().optional(),
      password: z.string().min(8).optional(),
    }).parse(request.body);

    const teacherId = input.id ?? ((await prisma.teacher.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id || 100) + 1;
    const branch = input.branchId ? await prisma.branch.findFirst({ where: { id: input.branchId, centerId: user.centerId } }) : await prisma.branch.findFirst({ where: { centerId: user.centerId } });

    let userId: string | null = null;
    if (input.email && input.password) {
      const email = input.email.toLowerCase();
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) return reply.code(422).send({ error: 'EMAIL_ALREADY_EXISTS' });
      const passwordHash = await bcrypt.hash(input.password, 12);
      const createdUser = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name: input.name,
          role: 'TEACHER',
          centerId: user.centerId,
          branchId: branch?.id ?? null,
        },
      });
      await prisma.centerMembership.create({ data: { userId: createdUser.id, centerId: user.centerId, role: 'TEACHER' } });
      userId = createdUser.id;
    }

    const teacher = await prisma.teacher.create({
      data: {
        id: teacherId,
        centerId: user.centerId,
        branchId: branch?.id ?? null,
        userId,
        name: input.name,
        subject: input.subject,
        phone: input.phone || null,
      },
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'teachers.create', entity: 'Teacher', entityId: String(teacher.id) },
    });
    return { teacher };
  });

  app.put('/api/teachers/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'teachers.update', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const input = z.object({
      name: z.string().trim().min(2).max(160).optional(),
      subject: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(40).optional(),
      branchId: z.string().optional(),
    }).parse(request.body);

    const existing = await prisma.teacher.findFirst({ where: { id: params.id, centerId: user.centerId } });
    if (!existing) return reply.code(404).send({ error: 'TEACHER_NOT_FOUND' });

    const teacher = await prisma.teacher.update({
      where: { id: params.id },
      data: {
        name: input.name ?? existing.name,
        subject: input.subject ?? existing.subject,
        phone: input.phone !== undefined ? input.phone || null : existing.phone,
        branchId: input.branchId !== undefined ? input.branchId || null : existing.branchId,
      },
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'teachers.update', entity: 'Teacher', entityId: String(params.id) },
    });
    return { teacher };
  });

  app.delete('/api/teachers/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'teachers.delete', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const groupCount = await prisma.group.count({ where: { teacherId: params.id, centerId: user.centerId } });
    if (groupCount > 0) return reply.code(422).send({ error: 'TEACHER_HAS_ACTIVE_GROUPS', message: 'لا يمكن حذف مدرس مرتبط بمجموعات دراسية نشطة' });

    await prisma.teacher.delete({ where: { id: params.id } });
    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'teachers.delete', entity: 'Teacher', entityId: String(params.id) },
    });
    return { ok: true };
  });

  // GROUP CRUD
  app.post('/api/groups', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'groups.create', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({
      id: z.coerce.number().int().positive().optional(),
      teacherId: z.coerce.number().int().positive(),
      grade: z.string().trim().min(2).max(120),
      days: z.union([z.array(z.string()), z.string()]).transform((v) => Array.isArray(v) ? v.join(', ') : v),
      time: z.string().trim().min(2).max(50),
      price: z.coerce.number().int().nonnegative(),
      courseId: z.string().optional().nullable(),
      branchId: z.string().optional().nullable(),
    }).parse(request.body);

    const teacher = await prisma.teacher.findFirst({ where: { id: input.teacherId, centerId: user.centerId } });
    if (!teacher) return reply.code(422).send({ error: 'INVALID_TEACHER' });

    const groupId = input.id ?? ((await prisma.group.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id || 100) + 1;
    const group = await prisma.group.create({
      data: {
        id: groupId,
        centerId: user.centerId,
        branchId: input.branchId || teacher.branchId || null,
        teacherId: input.teacherId,
        grade: input.grade,
        days: input.days,
        time: input.time,
        price: input.price,
        courseId: input.courseId || null,
      },
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'groups.create', entity: 'Group', entityId: String(group.id) },
    });
    return { group };
  });

  app.put('/api/groups/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'groups.update', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const input = z.object({
      teacherId: z.coerce.number().int().positive().optional(),
      grade: z.string().trim().min(2).max(120).optional(),
      days: z.union([z.array(z.string()), z.string()]).transform((v) => Array.isArray(v) ? v.join(', ') : v).optional(),
      time: z.string().trim().min(2).max(50).optional(),
      price: z.coerce.number().int().nonnegative().optional(),
      courseId: z.string().optional().nullable(),
    }).parse(request.body);

    const existing = await prisma.group.findFirst({ where: { id: params.id, centerId: user.centerId } });
    if (!existing) return reply.code(404).send({ error: 'GROUP_NOT_FOUND' });

    const group = await prisma.group.update({
      where: { id: params.id },
      data: {
        teacherId: input.teacherId ?? existing.teacherId,
        grade: input.grade ?? existing.grade,
        days: input.days ?? existing.days,
        time: input.time ?? existing.time,
        price: input.price ?? existing.price,
        courseId: input.courseId !== undefined ? input.courseId : existing.courseId,
      },
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'groups.update', entity: 'Group', entityId: String(params.id) },
    });
    return { group };
  });

  app.delete('/api/groups/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'groups.delete', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const existing = await prisma.group.findFirst({ where: { id: params.id, centerId: user.centerId } });
    if (!existing) return reply.code(404).send({ error: 'GROUP_NOT_FOUND' });

    await prisma.$transaction(async (tx) => {
      await tx.enrollment.deleteMany({ where: { groupId: params.id } });
      await tx.attendance.deleteMany({ where: { groupId: params.id } });
      await tx.subscription.deleteMany({ where: { groupId: params.id } });
      await tx.payment.deleteMany({ where: { groupId: params.id } });
      await tx.lessonSession.deleteMany({ where: { groupId: params.id } });
      await tx.schedule.deleteMany({ where: { groupId: params.id } });
      await tx.group.delete({ where: { id: params.id } });
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'groups.delete', entity: 'Group', entityId: String(params.id) },
    });
    return { ok: true };
  });

  // BRANCHES, CLASSROOMS, COURSES
  app.get('/api/center/branches', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId) return reply.code(403).send({ error: 'FORBIDDEN' });
    const branches = await prisma.branch.findMany({ where: { centerId: user.centerId }, orderBy: { name: 'asc' } });
    return { branches };
  });

  app.post('/api/center/classrooms', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'settings.manage', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({ name: z.string().trim().min(2).max(100), capacity: z.coerce.number().int().positive(), branchId: z.string().optional() }).parse(request.body);
    const classroom = await prisma.classroom.create({
      data: { centerId: user.centerId, name: input.name, capacity: input.capacity, branchId: input.branchId || null },
    });
    return { classroom };
  });

  app.post('/api/center/courses', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'academic.manage_courses', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({ name: z.string().trim().min(2).max(120), subject: z.string().trim().min(2).max(100), grade: z.string().trim().min(2).max(100) }).parse(request.body);
    const course = await prisma.course.create({
      data: { centerId: user.centerId, name: input.name, subject: input.subject, grade: input.grade, active: true },
    });
    return { course };
  });

  // FINTECH PAYMENTS & BILLING
  app.post('/api/center/payments', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'finance.record_payment', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({
      studentId: z.coerce.number().int().positive(),
      groupId: z.coerce.number().int().positive(),
      month: z.string().regex(/^\d{4}-\d{2}$/),
      amount: z.coerce.number().int().positive(),
      method: z.enum(['CASH', 'CARD', 'INSTAPAY', 'VODAFONE_CASH']).default('CASH'),
      reference: z.string().trim().max(100).optional(),
      note: z.string().trim().max(300).optional(),
    }).parse(request.body);

    const group = await prisma.group.findFirst({ where: { id: input.groupId, centerId: user.centerId }, select: { id: true, price: true } });
    if (!group) return reply.code(422).send({ error: 'GROUP_NOT_FOUND' });

    const ref = input.reference || `REC-${Date.now().toString().slice(-6)}-${input.studentId}`;
    const payment = await prisma.payment.upsert({
      where: { studentId_groupId_month: { studentId: input.studentId, groupId: input.groupId, month: input.month } },
      update: { amount: input.amount, status: 'paid', reference: `${ref} [${input.method}]` },
      create: { studentId: input.studentId, groupId: input.groupId, month: input.month, amount: input.amount, status: 'paid', reference: `${ref} [${input.method}]` },
    });

    const isFull = input.amount >= group.price;
    const status = isFull ? 'paid' : 'partial';
    const subscription = await prisma.subscription.upsert({
      where: { studentId_groupId_month: { studentId: input.studentId, groupId: input.groupId, month: input.month } },
      update: { status, amount: group.price, discount: isFull ? 0 : group.price - input.amount },
      create: { studentId: input.studentId, groupId: input.groupId, month: input.month, amount: group.price, discount: 0, dueOn: `${input.month}-10`, status },
    });

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'finance.payment', entity: 'Payment', entityId: payment.id, metadata: JSON.stringify({ amount: input.amount, method: input.method, studentId: input.studentId, groupId: input.groupId }) },
    });

    return { payment, subscription, receiptNumber: ref };
  });

  app.get('/api/center/payments', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'finance.view', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    const payments = await prisma.payment.findMany({
      where: { group: { centerId: user.centerId }, ...(query.month ? { month: query.month } : {}) },
      include: { student: true, group: { include: { teacher: true } } },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    return { payments };
  });

  // QUICK SCAN RECEPTION KIOSK
  app.post('/api/center/attendance/scan', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'attendance.create', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = z.object({
      code: z.string().trim().min(1).max(50),
    }).parse(request.body);

    const studentId = Number(input.code.replace(/^[A-Z0-9_-]+:/i, ''));
    if (!studentId || isNaN(studentId)) return reply.code(422).send({ error: 'INVALID_BARCODE', message: 'رمز أو رقم غير صالح' });

    const student = await prisma.student.findFirst({
      where: { id: studentId, centerId: user.centerId },
      include: { enrollments: { include: { group: { include: { teacher: true, course: true } } } } },
    });
    if (!student) return reply.code(404).send({ error: 'STUDENT_NOT_FOUND', message: 'الطالب غير مسجل في السنتر' });

    const today = new Date().toISOString().slice(0, 10);
    const currentMonth = today.slice(0, 7);

    const enrolledGroupIds = student.enrollments.map((e) => e.groupId);
    if (!enrolledGroupIds.length) return reply.code(422).send({ error: 'NO_ENROLLED_GROUPS', message: 'الطالب غير مسجل في أي مجموعة' });

    const todaySession = await prisma.lessonSession.findFirst({
      where: { groupId: { in: enrolledGroupIds }, date: today },
      include: { group: { include: { teacher: true } }, classroom: true },
    });

    const targetGroupId = todaySession ? todaySession.groupId : enrolledGroupIds[0];
    const targetGroup = student.enrollments.find((e) => e.groupId === targetGroupId)?.group;

    const attendance = await prisma.attendance.upsert({
      where: { studentId_groupId_date: { studentId: student.id, groupId: targetGroupId, date: today } },
      update: { status: 'PRESENT', note: 'تسجيل مسح الباركود السريع' },
      create: { studentId: student.id, groupId: targetGroupId, date: today, status: 'PRESENT', note: 'تسجيل مسح الباركود السريع' },
    });

    const subscription = await prisma.subscription.findUnique({
      where: { studentId_groupId_month: { studentId: student.id, groupId: targetGroupId, month: currentMonth } },
    });

    const isPaid = subscription?.status === 'paid';

    await prisma.auditLog.create({
      data: { centerId: user.centerId, userId: user.id, action: 'attendance.scan', entity: 'Attendance', entityId: `${student.id}:${targetGroupId}:${today}`, metadata: JSON.stringify({ isPaid, status: 'PRESENT' }) },
    });

    return {
      success: true,
      student: { id: student.id, name: student.name, phone: student.phone, parent: student.parent },
      group: targetGroup,
      session: todaySession,
      attendance,
      subscription: subscription || { status: 'pending', amount: targetGroup?.price || 0 },
      isPaid,
      message: `تم تسجيل حضور الطالب ${student.name} بنجاح`,
    };
  });

  // STUDENT & PARENT PORTALS
  app.get('/api/portal/student', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if ((user.role !== 'STUDENT' && user.role !== 'SUPER_ADMIN') || !user.centerId ||
        !(await authorize(user.id, 'attendance.view', { centerId: user.centerId })) ||
        !(await authorize(user.id, 'academic.view', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const student = await prisma.student.findFirst({
      where: { userId: user.id, centerId: user.centerId },
      include: {
        enrollments: { where: { group: { centerId: user.centerId } }, include: { group: { include: { teacher: true, course: true, schedules: true } } } },
        attendance: { where: { group: { centerId: user.centerId } }, orderBy: { date: 'desc' }, take: 25 },
        subscriptions: { where: { group: { centerId: user.centerId } }, orderBy: { month: 'desc' }, take: 6 },
      },
    });
    if (!student) return reply.code(404).send({ error: 'STUDENT_PROFILE_NOT_LINKED' });

    const totalAtt = student.attendance.length;
    const presentCount = student.attendance.filter((a) => a.status === 'PRESENT' || a.status === 'p').length;
    const attendanceRate = totalAtt > 0 ? Math.round((presentCount / totalAtt) * 100) : 100;

    return { student, attendanceRate };
  });

  registerMonthlyReportRoutes(app);

  // SESSIONS STATUS PATCH
  app.patch('/api/center/sessions/:id', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!user.centerId || !(await authorize(user.id, 'groups.manage_schedule', { centerId: user.centerId }))) return reply.code(403).send({ error: 'FORBIDDEN' });
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const input = z.object({
      status: z.enum(['scheduled', 'active', 'completed', 'cancelled']),
      topic: z.string().trim().max(200).optional(),
    }).safeParse(request.body);
    if (!params.success || !input.success) return reply.code(422).send({ error: 'INVALID_INPUT' });

    // Keep the tenant predicate on the write, not only on a preceding lookup.
    // The mutation and audit either both commit or both roll back.
    const session = await prisma.$transaction(async (tx) => {
      const updated = await tx.lessonSession.updateMany({
        where: { id: params.data.id, group: { centerId: user.centerId! } },
        data: {
          status: input.data.status,
          ...(input.data.topic ? { topic: input.data.topic } : {}),
        },
      });
      if (updated.count === 0) return null;
      const result = await tx.lessonSession.findUniqueOrThrow({
        where: { id: params.data.id }, include: { group: true },
      });
      await tx.auditLog.create({
        data: { centerId: user.centerId, userId: user.id, action: 'sessions.update', entity: 'LessonSession', entityId: result.id, metadata: JSON.stringify({ status: result.status }) },
      });
      return result;
    });
    if (!session) return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
    return { session };
  });

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  assertProductionConfig();
  const port = Number(process.env.PORT ?? 3000);
  buildApp().listen({ port, host: process.env.HOST ?? '127.0.0.1' }).catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
                                            }
