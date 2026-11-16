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

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  assertProductionConfig();
  const port = Number(process.env.PORT ?? 3000);
  buildApp().listen({ port, host: process.env.HOST ?? '127.0.0.1' }).catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
}
