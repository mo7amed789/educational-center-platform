import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('browser API request content type', () => {
  const app = buildApp();
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  const html = readFileSync('center-admin-v2.html', 'utf8');
  const source = html.slice(html.indexOf('function api(endpoint, options)'), html.indexOf('\nfunction snack('));
  class FakeFormData {}
  function transport() {
    const calls: Array<{ endpoint: string; options: { method?: string; body?: unknown; headers: Record<string,string> } }> = [];
    const context = { API_BASE: '', FormData: FakeFormData, fetch: async (endpoint: string, options: { method?: string; body?: unknown; headers: Record<string,string> }) => { calls.push({ endpoint, options }); return { ok:true, json:async()=>({ok:true}) }; } };
    runInNewContext(source, context);
    return { calls, api: (context as typeof context & { api: (endpoint:string, options?:unknown)=>Promise<unknown> }).api };
  }
  it('does not mark a bodyless logout POST as empty JSON', async () => {
    const {calls,api}=transport(); await api('/api/auth/logout',{method:'POST'});
    expect(calls[0].options.headers['Content-Type']).toBeUndefined();
  });
  it('keeps JSON content type for actual JSON bodies', async () => {
    const {calls,api}=transport(); await api('/api/example',{method:'POST',body:JSON.stringify({value:0})});
    expect(calls[0].options.headers['Content-Type']).toBe('application/json');
  });
  it('lets the browser choose multipart boundaries and preserves explicit headers', async () => {
    const {calls,api}=transport(); await api('/api/example',{method:'POST',body:new FakeFormData(),headers:{'X-Test':'yes'}});
    expect(calls[0].options.headers['Content-Type']).toBeUndefined(); expect(calls[0].options.headers['X-Test']).toBe('yes');
  });
  it('bodyless browser logout revokes the authenticated server session', async () => {
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{email:'owner@example.local',password:'ChangeMe123!'},remoteAddress:'203.0.113.221'});
    expect(login.statusCode).toBe(200);
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const {calls,api}=transport(); await api('/api/auth/logout',{method:'POST'});
    const logout=await app.inject({method:'POST',url:calls[0].endpoint,headers:{...calls[0].options.headers,cookie},remoteAddress:'203.0.113.222'});
    expect(logout.statusCode).toBe(200); expect(logout.json()).toEqual({ok:true});
    expect((await app.inject({method:'GET',url:'/api/auth/me',headers:{cookie},remoteAddress:'203.0.113.223'})).statusCode).toBe(401);
  });
});
