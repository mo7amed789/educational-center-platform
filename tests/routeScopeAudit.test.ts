import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

// Release gate: every API route must be listed here with its access class.
// Adding a route without classifying it fails this test on purpose.
const PUBLIC = new Set(['POST /api/auth/login']);
// logout and me answer without a session by design (me returns 401, logout is idempotent).
const SESSION_OPTIONAL = new Set(['POST /api/auth/logout']);

function listRoutes(app: ReturnType<typeof buildApp>) {
  const out: string[] = []; const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = line.match(/^([│ ]*)(?:├── |└── )(\S+) \(([^)]+)\)/); if (!m) continue;
    const depth = m[1].replace(/│/g, ' ').length / 4; stack.length = depth; stack[depth] = m[2];
    const path = '/' + stack.join('').replace(/^\//, '').replace(/\/\//g, '/');
    for (const method of m[3].split(', ')) if (method !== 'HEAD') out.push(`${method} ${path}`);
  }
  return out;
}

describe('API route scope audit', () => {
  const app = buildApp();
  const ids = { a: 951001, b: 951002 };
  let centerA = '', centerB = '', sessionB = '', examB = '';
  const cookies: Record<string, string> = {};
  beforeAll(async () => {
    centerA = (await prisma.center.create({ data: { slug: 'scope-a', name: 'Scope A' } })).id;
    centerB = (await prisma.center.create({ data: { slug: 'scope-b', name: 'Scope B' } })).id;
    for (const [key, centerId] of [['ownerA', centerA], ['ownerB', centerB]] as const) {
      const user = await prisma.user.create({ data: { centerId, role: 'CENTER_OWNER', name: key, email: `${key}@scope.test`, passwordHash: 'unusable-test-only', centerMemberships: { create: { centerId, role: 'CENTER_OWNER' } } } });
      const token = `scope-session-${key}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId, expiresAt: new Date(Date.now() + 3600000) } });
      cookies[key] = `center_session=${token}`;
      if (key === 'ownerB') (cookies as Record<string, string>).ownerBId = user.id;
    }
    await prisma.teacher.create({ data: { id: ids.b, centerId: centerB, name: 'Teacher B', subject: 'Math' } });
    await prisma.group.create({ data: { id: ids.b, centerId: centerB, teacherId: ids.b, grade: 'Group B', days: 'Sunday', time: '10:00', price: 100 } });
    await prisma.student.create({ data: { id: ids.b, centerId: centerB, name: 'Student B' } });
    await prisma.enrollment.create({ data: { studentId: ids.b, groupId: ids.b } });
    sessionB = (await prisma.lessonSession.create({ data: { groupId: ids.b, date: '2026-11-24', startsAt: '10:00', endsAt: '11:00' } })).id;
    examB = (await prisma.exam.create({ data: { groupId: ids.b, title: 'Exam B', date: '2026-11-24', startsAt: '10:00', endsAt: '11:00', timezone: 'Africa/Cairo', maxScore: 10, createdById: cookies.ownerBId } })).id;
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('answers every API route without a session with 401, except classified public ones', async () => {
    await app.ready();
    const routes = listRoutes(app).filter(r => r.split(' ')[1].startsWith('/api/'));
    expect(routes.length).toBeGreaterThanOrEqual(40);
    const failures: string[] = [];
    for (const route of routes) {
      if (PUBLIC.has(route) || SESSION_OPTIONAL.has(route)) continue;
      const [method, path] = route.split(' ');
      const res = await app.inject({ method: method as 'GET', url: path.replace(/:[A-Za-z]+/g, 'x'), payload: method === 'GET' ? undefined : {} });
      if (res.statusCode !== 401) failures.push(`${route} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it.each([
    ['PATCH', () => `/api/center/sessions/${sessionB}`, { status: 'cancelled' }],
    ['GET', () => `/api/center/exams/${examB}/results`, undefined],
    ['POST', () => `/api/center/exams/${examB}/publish`, {}],
    ['GET', () => `/api/center/kiosk/students/${ids.b}`, undefined],
    ['GET', () => `/api/students/${ids.b}`, undefined],
    ['PUT', () => `/api/students/${ids.b}`, { name: 'Hijack' }],
    ['DELETE', () => `/api/students/${ids.b}`, undefined],
    ['PUT', () => `/api/teachers/${ids.b}`, { name: 'Hijack' }],
    ['PUT', () => `/api/groups/${ids.b}`, { grade: 'Hijack' }],
    ['DELETE', () => `/api/groups/${ids.b}`, undefined],
  ] as const)('hides another center\'s record from %s %#', async (method, url, payload) => {
    const res = await app.inject({ method, url: url(), payload: payload as object | undefined, headers: { cookie: cookies.ownerA } });
    expect([403, 404, 422]).toContain(res.statusCode);
    expect(await prisma.lessonSession.findUnique({ where: { id: sessionB } })).toMatchObject({ status: 'scheduled' });
    expect(await prisma.student.findUnique({ where: { id: ids.b } })).toMatchObject({ name: 'Student B' });
    expect(await prisma.group.findUnique({ where: { id: ids.b } })).toMatchObject({ grade: 'Group B' });
    expect(await prisma.exam.findUnique({ where: { id: examB } })).toMatchObject({ publishedAt: null });
  });

  it('does not let one center scan another center\'s student code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/center/attendance/scan', payload: { code: `STUDENT:${ids.b}` }, headers: { cookie: cookies.ownerA } });
    expect([403, 404, 422]).toContain(res.statusCode);
    expect(await prisma.attendance.count({ where: { studentId: ids.b } })).toBe(0);
  });
});
