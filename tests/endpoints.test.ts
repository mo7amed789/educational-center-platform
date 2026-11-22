import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('Server & Endpoints test suite', () => {
  const app = buildApp();
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('responds with health check status', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'educational-center-platform' });
  });

  it('serves the main HTML application on root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns 401 when accessing protected endpoints without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects invalid login credentials gracefully', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unknown@example.local', password: 'WrongPassword123!' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('INVALID_CREDENTIALS');
  });

  it('authenticates valid seed owner and creates session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.local', password: 'ChangeMe123!' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe('owner@example.local');
    expect(body.user.role).toBe('CENTER_OWNER');

    const cookieHeader = res.headers['set-cookie'];
    expect(cookieHeader).toBeDefined();

    // Verify /api/auth/me using the session cookie
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : String(cookieHeader);
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.email).toBe('owner@example.local');
  });

  it('allows authenticated owner to fetch overview, students, and reports', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.local', password: 'ChangeMe123!' },
    });
    const cookie = Array.isArray(loginRes.headers['set-cookie']) ? loginRes.headers['set-cookie'][0] : String(loginRes.headers['set-cookie']);

    const overviewRes = await app.inject({
      method: 'GET',
      url: '/api/center/overview',
      headers: { cookie },
    });
    expect(overviewRes.statusCode).toBe(200);
    const overview = overviewRes.json();
    expect(overview.teachers.length).toBeGreaterThan(0);
    expect(overview.groups.length).toBeGreaterThan(0);

    const studentsRes = await app.inject({
      method: 'GET',
      url: '/api/students?page=1&pageSize=10',
      headers: { cookie },
    });
    expect(studentsRes.statusCode).toBe(200);
    const studentsData = studentsRes.json();
    expect(studentsData.items.length).toBeGreaterThan(0);
    expect(studentsData.total).toBeGreaterThan(0);

    const reportsRes = await app.inject({
      method: 'GET',
      url: '/api/center/reports/summary',
      headers: { cookie },
    });
    expect(reportsRes.statusCode).toBe(200);
    expect(reportsRes.json().counts.students).toBeGreaterThan(0);
  });

  it('supports student lifecycle: create, update, barcode scan check-in, payment, and deletion', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.local', password: 'ChangeMe123!' },
    });
    const cookie = Array.isArray(loginRes.headers['set-cookie']) ? loginRes.headers['set-cookie'][0] : String(loginRes.headers['set-cookie']);

    // 1. Create a student
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/students',
      headers: { cookie },
      payload: {
        name: 'طالب اختبار جديد',
        phone: '01099998888',
        parent: '01299998888',
        groupIds: [101],
      },
    });
    expect(createRes.statusCode).toBe(200);
    const newStudent = createRes.json().student;
    expect(newStudent.id).toBeDefined();
    expect(newStudent.name).toBe('طالب اختبار جديد');

    // 2. Update the student
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/students/${newStudent.id}`,
      headers: { cookie },
      payload: {
        name: 'طالب اختبار معدل',
        phone: '01011112222',
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().student.name).toBe('طالب اختبار معدل');

    // 3. Scan student code via Kiosk Attendance Scanner
    const scanRes = await app.inject({
      method: 'POST',
      url: '/api/center/attendance/scan',
      headers: { cookie },
      payload: { code: `STUDENT:${newStudent.id}` },
    });
    expect(scanRes.statusCode).toBe(200);
    const scanData = scanRes.json();
    expect(scanData.success).toBe(true);
    expect(scanData.student.id).toBe(newStudent.id);

    // 4. Record a fintech payment for student
    const currentMonth = new Date().toISOString().slice(0, 7);
    const payRes = await app.inject({
      method: 'POST',
      url: '/api/center/payments',
      headers: { cookie },
      payload: {
        studentId: newStudent.id,
        groupId: 101,
        month: currentMonth,
        amount: 150,
        method: 'INSTAPAY',
        reference: 'INSTA-TEST-1234',
      },
    });
    expect(payRes.statusCode).toBe(200);
    const payData = payRes.json();
    expect(payData.payment.status).toBe('paid');
    expect(payData.subscription.status).toBe('paid');
    expect(payData.receiptNumber).toBeDefined();

    // 5. Delete the student
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/students/${newStudent.id}`,
      headers: { cookie },
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);
  });

  it('provides dedicated portal endpoints for students and parents', async () => {
    // Test Student Portal login & endpoint
    const studentLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'student1@demo.local', password: 'ChangeMe123!' },
    });
    expect(studentLogin.statusCode).toBe(200);
    const studentCookie = Array.isArray(studentLogin.headers['set-cookie']) ? studentLogin.headers['set-cookie'][0] : String(studentLogin.headers['set-cookie']);

    const studentPortalRes = await app.inject({
      method: 'GET',
      url: '/api/portal/student',
      headers: { cookie: studentCookie },
    });
    expect(studentPortalRes.statusCode).toBe(200);
    expect(studentPortalRes.json().student).toBeDefined();
    expect(studentPortalRes.json().attendanceRate).toBeDefined();

    // Test Parent Portal login & endpoint
    const parentLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'parent1@demo.local', password: 'ChangeMe123!' },
    });
    expect(parentLogin.statusCode).toBe(200);
    const parentCookie = Array.isArray(parentLogin.headers['set-cookie']) ? parentLogin.headers['set-cookie'][0] : String(parentLogin.headers['set-cookie']);

    const parentPortalRes = await app.inject({
      method: 'GET',
      url: '/api/portal/parent',
      headers: { cookie: parentCookie },
    });
    expect(parentPortalRes.statusCode).toBe(200);
    expect(parentPortalRes.json().guardian).toBeDefined();
    expect(parentPortalRes.json().children.length).toBeGreaterThan(0);
  });
});
