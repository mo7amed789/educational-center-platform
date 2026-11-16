import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role, User } from '@prisma/client';
import { prisma } from './prisma.js';
import { hasPermission, type Permission } from './permissions.js';

export const SESSION_COOKIE = 'center_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function generateMfaSecret(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

export function mfaCode(secret: string, timestamp = Date.now()): string {
  const counter = Math.floor(timestamp / 30000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1000000).padStart(6, '0');
}

export function verifyMfaCode(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((offset) => mfaCode(secret, Date.now() + offset * 30000) === code);
}

function hashSession(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

export async function createSession(user: Pick<User, 'id' | 'centerId'>, reply: FastifyReply): Promise<void> {
  const rawId = randomBytes(32).toString('hex');
  await prisma.session.create({
    data: { id: hashSession(rawId), userId: user.id, centerId: user.centerId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  reply.setCookie(SESSION_COOKIE, rawId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawId = request.cookies[SESSION_COOKIE];
  if (rawId) await prisma.session.deleteMany({ where: { id: hashSession(rawId) } });
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function currentUser(request: FastifyRequest): Promise<(User & { center: { id: string; name: string } | null }) | null> {
  const rawId = request.cookies[SESSION_COOKIE];
  if (!rawId) return null;
  const session = await prisma.session.findUnique({ where: { id: hashSession(rawId) }, include: { user: { include: { center: { select: { id: true, name: true } } } } } });
  if (!session || session.expiresAt <= new Date() || !session.user.active) return null;
  return session.user;
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await currentUser(request);
  if (!user) {
    await reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return null;
  }
  return user;
}

export function requirePermission(user: Pick<User, 'role'>, permission: Permission): boolean {
  return hasPermission(user.role as Role, permission);
}

export function publicUser(user: Pick<User, 'id' | 'email' | 'name' | 'role' | 'centerId' | 'branchId' | 'mfaEnabled'>) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, centerId: user.centerId, branchId: user.branchId, mfaEnabled: user.mfaEnabled };
}
