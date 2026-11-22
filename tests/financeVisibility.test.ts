import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('finance permission boundaries on non-finance workflows', () => {
  const app = buildApp(); const id = 960001; const month = new Date().toISOString().slice(0, 7);
  let center: string; const cookies: Record<string, string> = {}, users: Record<string, string> = {};
  beforeAll(async () => {
    center = (await prisma.center.create({ data: { slug: 'finance-visibility', name: 'Finance visibility fixtures' } })).id;
    for (const [key, role] of [['owner', 'CENTER_OWNER'], ['reception', 'RECEPTIONIST'], ['teacher', 'TEACHER'], ['student', 'STUDENT'], ['parent', 'GUARDIAN']] as const) {
      const user = await prisma.user.create({ data: { centerId: center, name: key, email: `${key}@finance-visibility.test`, role, passwordHash: 'unusable-fixture', centerMemberships: { create: { centerId: center, role } } } });
      users[key] = user.id; const token = `finance-visibility-${key}`;
      await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId: center, expiresAt: new Date(Date.now() + 3600000) } }); cookies[key] = `center_session=${token}`;
    }
    await prisma.teacher.create({ data: { id, centerId: center, userId: users.teacher, name: 'Fixture teacher', subject: 'Math' } });
    await prisma.group.create({ data: { id, centerId: center, teacherId: id, grade: 'Fixture class', days: 'Sunday', time: '10:00', price: 100 } });
    await prisma.student.create({ data: { id, centerId: center, userId: users.student, name: 'Fixture pupil' } });
    await prisma.guardian.create({ data: { centerId: center, userId: users.parent, name: 'Fixture parent', children: { create: { studentId: id, relation: 'parent' } } } });
    await prisma.enrollment.create({ data: { studentId: id, groupId: id } });
    await prisma.subscription.create({ data: { studentId: id, groupId: id, month, amount: 100, discount: 0, dueOn: `${month}-10`, status: 'paid' } });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  let counter = 0;
  const request = (who: string, url: string, payload?: object) => app.inject({ method: payload ? 'POST' : 'GET', url, remoteAddress: `192.0.2.${++counter}`, headers: { cookie: cookies[who] }, ...(payload ? { payload } : {}) });
  it.each(['reception', 'teacher'])('keeps %s attendance actions within role and finance boundaries', async (who) => {
    const result = await request(who, '/api/center/attendance/scan', { code: String(id) }); if (who === 'teacher') { expect(result.statusCode).toBe(403); expect(result.json()).not.toHaveProperty('subscription'); return; } expect(result.statusCode).toBe(200);
    expect(result.json().financialVisible).toBe(false); expect(result.json()).not.toHaveProperty('isPaid'); expect(result.json()).not.toHaveProperty('subscription');
    expect(result.json().attendance.status).toBe('PRESENT');
  });
  it.each(['reception', 'teacher', 'student'])('does not leak subscriptions through %s student detail', async (who) => {
    const result = await request(who, `/api/students/${id}`); expect(result.statusCode).toBe(200);
    expect(result.json().financialVisible).toBe(false); expect(result.json().student).not.toHaveProperty('subscriptions');
  });
  it('does not treat the student academic portal as a finance grant', async () => {
    const result = await request('student', '/api/portal/student'); expect(result.statusCode).toBe(200);
    expect(result.json().financialVisible).toBe(false); expect(result.json().student).not.toHaveProperty('subscriptions');
  });
  it('preserves authorized parent and owner billing reads', async () => {
    const parent = await request('parent', `/api/students/${id}`); expect(parent.statusCode).toBe(200); expect(parent.json().financialVisible).toBe(true); expect(parent.json().student.subscriptions[0].amount).toBe(100);
    const scan = await request('owner', '/api/center/attendance/scan', { code: String(id) }); expect(scan.json().financialVisible).toBe(true); expect(scan.json().isPaid).toBe(true); expect(scan.json().subscription.amount).toBe(100);
  });
  it('returns only operational summary data to reception', async () => {
    const result = await request('reception', '/api/center/reports/summary'); expect(result.statusCode).toBe(200); expect(result.json().counts.students).toBe(1);
    expect(result.json().financialVisible).toBe(false); expect(result.json()).not.toHaveProperty('revenue'); expect(result.json()).not.toHaveProperty('subscriptions');
  });
  it.each(['finance.view', 'finance.view_reports'])('honors an explicit %s denial in the summary', async (permissionKey) => {
    await prisma.userPermission.create({ data: { userId: users.owner, permissionKey, allowed: false } });
    try {
      const result = await request('owner', '/api/center/reports/summary'); expect(result.statusCode).toBe(200); expect(result.json().financialVisible).toBe(false); expect(result.json()).not.toHaveProperty('revenue');
      if (permissionKey === 'finance.view') {
        expect((await request('owner', `/api/students/${id}`)).json().student).not.toHaveProperty('subscriptions');
        expect((await request('owner', '/api/center/attendance/scan', { code: String(id) })).json()).not.toHaveProperty('isPaid');
      }
    } finally { await prisma.userPermission.delete({ where: { userId_permissionKey: { userId: users.owner, permissionKey } } }); }
  });
  it('does not label bodyless logout requests as JSON', async () => {
    const html = readFileSync('center-admin-v2.html', 'utf8'), start = html.indexOf('function api(endpoint, options)'), end = html.indexOf('function snack(', start);
    const requests: Array<{ headers: Record<string, string> }> = [];
    const api = new Function('fetch', 'API_BASE', html.slice(start, end) + '; return api;')((_url: string, options: { headers: Record<string, string> }) => { requests.push(options); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); }, '');
    await api('/api/auth/logout', { method: 'POST' }); expect(requests[0].headers).not.toHaveProperty('Content-Type');
    await api('/api/example', { method: 'POST', body: '{}' }); expect(requests[1].headers['Content-Type']).toBe('application/json');
  });
  it('clears private account caches and discards older account responses', async () => {
    const html = readFileSync('center-admin-v2.html', 'utf8');
    const state = { currentRole: 'RECEPTIONIST', currentUser: {}, sessionEpoch: 3, reports: { financialVisible: true }, teachers: ['private'], groups: [], courses: [], classrooms: [], students: ['private'], sessions: [], subscriptions: ['private'], attendance: {}, searchQuery: '', sessionsAvailable: true };
    const start = html.indexOf('function clearCenterData()'), end = html.indexOf('function clearPrivateView()', start);
    new Function('STATE', html.slice(start, end) + '; clearCenterData();')(state);
    expect(state.sessionEpoch).toBe(4); expect(state.reports).toBeNull(); expect(state.students).toEqual([]); expect(state.subscriptions).toEqual([]);
    const pending: Array<(value: object) => void> = []; let renders = 0;
    const loadStart = html.indexOf('function loadAllCenterData()'), loadEnd = html.indexOf('/* ==========================================================================', loadStart);
    const load = new Function('STATE', 'api', 'renderActiveView', 'loadParentChildren', html.slice(loadStart, loadEnd) + '; return loadAllCenterData;');
    load(state, () => new Promise(resolve => pending.push(resolve)), () => { renders++; }, () => {})();
    state.sessionEpoch++;
    for (const resolve of pending) resolve({ items: ['old private data'], teachers: ['old teacher'], reports: {}, financialVisible: true, revenue: { amount: 123 } });
    await new Promise(resolve => setImmediate(resolve));
    expect(state.reports).toBeNull(); expect(state.students).toEqual([]); expect(renders).toBe(1);
  });
  it('renders recorded attendance instead of a fixed report percentage', () => {
    const html = readFileSync('center-admin-v2.html', 'utf8'), start = html.indexOf('function renderReportsView(c)'), end = html.indexOf('/* 10. STAFF', start);
    const output = { innerHTML: '' }; new Function('STATE', 'safeText', html.slice(start, end) + '; renderReportsView(arguments[2]);')({ reports: { month: '2026-11', financialVisible: true, revenue: { amount: 0, discount: 0 }, attendance: { PRESENT: 1, ABSENT: 1 } } }, String, output);
    expect(output.innerHTML).toContain('50%'); expect(output.innerHTML).not.toContain('91.4%'); expect(output.innerHTML).not.toContain('42,850');
  });
  it('retains a real zero rather than inventing demo revenue or active lessons', () => {
    const html = readFileSync('center-admin-v2.html', 'utf8'); const start = html.indexOf('function renderDashboardView(c)'); const end = html.indexOf('/* 2. STUDENTS VIEW */', start);
    const render = new Function('STATE', 'getSvgIcon', 'safeText', html.slice(start, end) + '; return renderDashboardView;');
    const state = { students: [], teachers: [], groups: [], sessions: [], reports: { financialVisible: true, revenue: { amount: 0 }, counts: { students: 0, teachers: 0, groups: 0 } } };
    const output = { innerHTML: '' }; render(state, () => '', String)(output);
    expect(output.innerHTML).not.toContain('42,850'); expect(output.innerHTML).not.toContain('آمن ومحدث'); expect(output.innerHTML).not.toContain('قاعة 1');
    expect(output.innerHTML).toContain('0');
    state.reports.financialVisible = false; render(state, () => '', String)(output); expect(output.innerHTML).toContain('غير متاح');
  });
  it('keeps the self-only learner loader and omits the superseded cached student branch', () => {
    const html = readFileSync('center-admin-v2.html', 'utf8');
    const loader = html.slice(html.indexOf('function loadAllCenterData()'), html.indexOf('function renderActiveView()'));
    expect(loader).toContain("if (STATE.currentRole === 'STUDENT') return STUDENT_REPORT.loading ? Promise.resolve() : loadStudentLearning()");
    expect(loader).not.toContain("api('/api/portal/student')");
  });

});
