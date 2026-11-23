import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { mfaCode } from '../src/auth.js';

describe('security hardening', () => {
  const app = buildApp();
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  it('cannot replace or disable an active authenticator via setup', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.local', password: 'ChangeMe123!' }, remoteAddress:'203.0.113.80' });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'owner@example.local' } });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/auth/mfa/setup', headers: { cookie } });
      expect(setup.statusCode).toBe(200);
      const secret = setup.json().secret;
      const enable = await app.inject({ method: 'POST', url: '/api/auth/mfa/enable', headers: { cookie }, payload: { code: mfaCode(secret) } });
      expect(enable.statusCode).toBe(200);
      const replace = await app.inject({ method: 'POST', url: '/api/auth/mfa/setup', headers: { cookie } });
      expect(replace.statusCode).toBe(409);
      expect(replace.json()).toEqual({ error: 'MFA_ALREADY_ENABLED' });
      const current = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
      expect(current.mfaEnabled).toBe(true); expect(current.mfaSecret).toBe(secret);
    } finally { await prisma.user.update({ where: { id: owner.id }, data: { mfaEnabled: false, mfaSecret: null } }); }
  });
  it('never caches authenticated identity or validation responses', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.headers['cache-control']).toBe('no-store');
  });
  it('does not reflect validation details or malicious input in errors', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.local', password: 'ChangeMe123!' }, remoteAddress:'203.0.113.81' });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const invalid = await app.inject({ method: 'POST', url: '/api/students', headers: { cookie }, payload: { name: '<img src=x onerror=alert(1)>', id: '<img src=x onerror=alert(1)>' } });
    expect(invalid.statusCode).toBe(422); expect(invalid.json()).toEqual({ error: 'INVALID_INPUT' });
  });
});
