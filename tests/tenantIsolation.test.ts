import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

// Fixtures are created only inside the disposable database from global setup.
describe('two-center lesson session isolation', () => {
  const app = buildApp();
  const cookies: string[] = [];
  const centers: string[] = [];
  const sessions: string[] = [];

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('FixtureOnly123!', 4);
    for (let index = 0; index < 2; index += 1) {
      const center = await prisma.center.create({ data: { slug: `isolation-${index}`, name: `Isolation ${index}` } });
      centers.push(center.id);
      const email = `isolation-${index}@test.local`;
      await prisma.user.create({ data: {
        centerId: center.id, email, name: 'Fixture owner', role: 'CENTER_OWNER', passwordHash,
        centerMemberships: { create: { centerId: center.id, role: 'CENTER_OWNER' } },
      } });
      const teacher = await prisma.teacher.create({ data: { id: 900001 + index, centerId: center.id, name: 'Fixture teacher', subject: 'Math' } });
      const group = await prisma.group.create({ data: { id: 900001 + index, centerId: center.id, teacherId: teacher.id, grade: 'One', days: 'Sunday', time: '10:00', price: 100 } });
      const session = await prisma.lessonSession.create({ data: { groupId: group.id, date: '2026-11-22', startsAt: '10:00', endsAt: '11:00', topic: 'Original topic' } });
      sessions.push(session.id);
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'FixtureOnly123!' } });
      expect(login.statusCode).toBe(200);
      const header = login.headers['set-cookie'];
      cookies.push((Array.isArray(header) ? header[0] : String(header)).split(';')[0]);
    }
  });

  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it.each([0, 1])('allows owner %i to update their own center and records the audit', async (index) => {
    const result = await app.inject({ method: 'PATCH', url: `/api/center/sessions/${sessions[index]}`, headers: { cookie: cookies[index] }, payload: { status: 'active', topic: 'Authorized update' } });
    expect(result.statusCode).toBe(200);
    expect(result.json().session.group.centerId).toBe(centers[index]);
    expect(result.json().session.status).toBe('active');
    const audit = await prisma.auditLog.findFirst({ where: { centerId: centers[index], entityId: sessions[index], action: 'sessions.update' } });
    expect(audit).not.toBeNull();
  });

  it.each([0, 1])('denies owner %i access to the other center without writes or audit', async (index) => {
    const foreignId = sessions[1 - index];
    const before = await prisma.lessonSession.findUniqueOrThrow({ where: { id: foreignId } });
    const auditBefore = await prisma.auditLog.count({ where: { action: 'sessions.update' } });
    const result = await app.inject({ method: 'PATCH', url: `/api/center/sessions/${foreignId}`, headers: { cookie: cookies[index] }, payload: { status: 'cancelled', topic: 'Unauthorized update' } });
    expect(result.statusCode).toBe(404);
    expect(result.json()).toEqual({ error: 'SESSION_NOT_FOUND' });
    expect(await prisma.lessonSession.findUniqueOrThrow({ where: { id: foreignId } })).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: 'sessions.update' } })).toBe(auditBefore);
  });

  it('does not reveal whether a foreign or unknown session exists', async () => {
    const result = await app.inject({ method: 'PATCH', url: '/api/center/sessions/nonexistent-session', headers: { cookie: cookies[0] }, payload: { status: 'active' } });
    expect(result.statusCode).toBe(404);
    expect(result.json()).toEqual({ error: 'SESSION_NOT_FOUND' });
  });

  it('rejects invalid input without a mutation', async () => {
    const before = await prisma.lessonSession.findUniqueOrThrow({ where: { id: sessions[0] } });
    const result = await app.inject({ method: 'PATCH', url: `/api/center/sessions/${sessions[0]}`, headers: { cookie: cookies[0] }, payload: { status: 'invalid-status' } });
    expect(result.statusCode).toBe(422);
    expect(result.json()).toEqual({ error: 'INVALID_INPUT' });
    expect(await prisma.lessonSession.findUniqueOrThrow({ where: { id: sessions[0] } })).toEqual(before);
  });

  it('denies an authenticated role without schedule permission', async () => {
    const email = 'isolation-0@test.local';
    await prisma.user.update({ where: { email }, data: { role: 'STUDENT' } });
    try {
      const result = await app.inject({ method: 'PATCH', url: `/api/center/sessions/${sessions[0]}`, headers: { cookie: cookies[0] }, payload: { status: 'cancelled' } });
      expect(result.statusCode).toBe(403);
    } finally {
      await prisma.user.update({ where: { email }, data: { role: 'CENTER_OWNER' } });
    }
  });

  it('requires a session cookie', async () => {
    const result = await app.inject({ method: 'PATCH', url: `/api/center/sessions/${sessions[0]}`, payload: { status: 'active' } });
    expect(result.statusCode).toBe(401);
  });
});
