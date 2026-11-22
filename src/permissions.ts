import type { Role } from '@prisma/client';

export const PERMISSIONS = [
  'students.view', 'students.view_all', 'students.view_assigned', 'students.create', 'students.update', 'students.delete', 'students.enroll', 'students.transfer', 'students.export',
  'teachers.view', 'teachers.create', 'teachers.update', 'teachers.delete', 'teachers.assign_groups',
  'groups.view', 'groups.create', 'groups.update', 'groups.delete', 'groups.assign_students', 'groups.assign_teachers', 'groups.manage_schedule',
  'attendance.view', 'attendance.create', 'attendance.update', 'attendance.correct', 'attendance.delete', 'attendance.export',
  'finance.view', 'finance.view_reports', 'finance.manage_fees', 'finance.manage_invoices', 'finance.record_payment', 'finance.refund', 'finance.manage_expenses', 'finance.export',
  'academic.view', 'academic.manage_courses', 'academic.manage_exams', 'academic.manage_assignments', 'academic.manage_grades', 'academic.publish_results',
  'users.view', 'users.create', 'users.update', 'users.suspend', 'users.assign_roles', 'users.assign_permissions',
  'settings.view', 'settings.update', 'settings.manage_branches', 'settings.manage_integrations', 'settings.manage_security', 'settings.manage',
  'reports.view', 'reports.export', 'audit.view', 'backups.create', 'backups.restore', 'notifications.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const all = [...PERMISSIONS] as Permission[];
const without = (...blocked: Permission[]) => all.filter((permission) => !blocked.includes(permission));

const rolePermissions: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: all,
  CENTER_OWNER: all,
  CENTER_ADMIN: without('backups.restore', 'settings.manage_security', 'finance.refund'),
  BRANCH_ADMIN: without('backups.restore', 'settings.manage_security', 'finance.refund', 'settings.manage_integrations'),
  RECEPTIONIST: ['students.view', 'students.create', 'students.update', 'students.enroll', 'teachers.view', 'groups.view', 'attendance.view', 'attendance.create', 'reports.view', 'notifications.manage'],
  ACCOUNTANT: ['students.view', 'groups.view', 'finance.view', 'finance.view_reports', 'finance.manage_invoices', 'finance.record_payment', 'finance.refund', 'finance.manage_expenses', 'finance.export', 'reports.view', 'reports.export'],
  TEACHER: ['students.view_assigned', 'groups.view', 'attendance.view', 'attendance.create', 'attendance.update', 'academic.view', 'academic.manage_assignments', 'academic.manage_exams', 'academic.manage_grades'],
  STUDENT: ['students.view', 'groups.view', 'attendance.view', 'academic.view'],
  GUARDIAN: ['students.view', 'groups.view', 'attendance.view', 'finance.view', 'academic.view'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return rolePermissions[role];
}

export function permissionDescriptions(): Array<{ key: Permission; description: string }> {
  return PERMISSIONS.map((key) => ({ key, description: key.replace(/[._]/g, ' ') }));
               }
