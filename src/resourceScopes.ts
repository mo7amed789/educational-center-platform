import type { Prisma, User } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { currentUser } from './auth.js';
import { prisma } from './prisma.js';

type ScopedUser = Pick<User, 'role' | 'centerId' | 'branchId'>;

// A primary branch is an acting scope, not a fallback to center-wide access.
export function branchScope(user: ScopedUser) {
  return { centerId: user.centerId || '', ...(user.role === 'BRANCH_ADMIN' ? { branchId: user.branchId || '__missing_branch__' } : {}) };
}

export function assignedGroupScope(user: ScopedUser & Pick<User, 'id'>): Prisma.GroupWhereInput {
  return { ...branchScope(user), ...(user.role === 'TEACHER' ? { teacher: { userId: user.id, centerId: user.centerId || '' } } : {}) };
}

export function studentScope(user: ScopedUser & Pick<User, 'id'>): Prisma.StudentWhereInput {
  return { ...branchScope(user),
    ...(user.role === 'TEACHER' ? { enrollments: { some: { group: assignedGroupScope(user) } } } : {}),
    ...(user.role === 'STUDENT' ? { userId: user.id } : {}),
    ...(user.role === 'GUARDIAN' ? { guardianLinks: { some: { guardian: { userId: user.id, centerId: user.centerId || '' } } } } : {}),
  };
}

export function teacherScope(user: ScopedUser & Pick<User, 'id'>): Prisma.TeacherWhereInput {
  return { ...branchScope(user), ...(user.role === 'TEACHER' ? { userId: user.id } : {}) };
}

export async function branchForWrite(user: ScopedUser, requested: string | null | undefined, fallback: string | null, client: Pick<Prisma.TransactionClient, 'branch'> = prisma) {
  const id = requested === undefined ? (user.role === 'BRANCH_ADMIN' ? user.branchId : fallback) : requested || null;
  if (user.role === 'BRANCH_ADMIN' && (!id || id !== user.branchId)) return { ok: false as const };
  if (id && !(await client.branch.findFirst({ where: { id, centerId: user.centerId || '' }, select: { id: true } }))) return { ok: false as const };
  return { ok: true as const, id };
}

export function registerBranchScopeGuard(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.routeOptions.url || request.url.split('?')[0];
    if (!path.startsWith('/api/') || path.startsWith('/api/auth/')) return;
    const user = await currentUser(request);
    if (!user || user.role !== 'BRANCH_ADMIN') return;
    if (!user.centerId || !user.branchId) return reply.code(403).send({ error: 'BRANCH_SCOPE_REQUIRED' });
    const [branch, membership, branchMembership] = await Promise.all([
      prisma.branch.findFirst({ where: { id: user.branchId, centerId: user.centerId }, select: { id: true } }),
      prisma.centerMembership.findUnique({ where: { userId_centerId: { userId: user.id, centerId: user.centerId } }, select: { active: true } }),
      prisma.branchMembership.findUnique({ where: { userId_branchId: { userId: user.id, branchId: user.branchId } }, select: { active: true } }),
    ]);
    if (!branch || !membership?.active || branchMembership?.active === false) return reply.code(403).send({ error: 'BRANCH_SCOPE_REQUIRED' });
    // These schemas currently describe the whole center, not one branch.
    const centerWide = ['/api/legacy/import', '/api/import/excel', '/api/export/excel', '/api/center/audit-logs', '/api/center/courses'];
    if (centerWide.includes(path) || (request.method === 'DELETE' && path === '/api/students/:id')) {
      return reply.code(403).send({ error: 'CENTER_ADMIN_REQUIRED' });
    }
  });
}
