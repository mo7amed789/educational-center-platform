import type { Role } from '@prisma/client';
import { prisma } from './prisma.js';
import { hasPermission, type Permission } from './permissions.js';

export type AuthorizationContext = {
  centerId?: string | null;
  branchId?: string | null;
};

export async function authorize(userId: string, permission: Permission, context: AuthorizationContext = {}): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { permissionOverrides: true, centerMemberships: true, branchMemberships: true },
  });
  if (!user || !user.active) return false;
  if (user.role !== 'SUPER_ADMIN' && context.centerId && user.centerId !== context.centerId) return false;
  if (context.branchId && user.role !== 'SUPER_ADMIN') {
    const hasBranch = user.branchId === context.branchId || user.branchMemberships.some((membership) => membership.branchId === context.branchId && membership.active);
    if (!hasBranch) return false;
  }
  if (context.centerId && user.role !== 'SUPER_ADMIN') {
    const membership = user.centerMemberships.find((entry) => entry.centerId === context.centerId && entry.active);
    if (!membership) return false;
  }
  const override = user.permissionOverrides.find((entry) => entry.permissionKey === permission);
  if (override) return override.allowed;
  return hasPermission(user.role as Role, permission);
}
