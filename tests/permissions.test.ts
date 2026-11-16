import { describe, expect, it } from 'vitest';
import { hasPermission, permissionsFor } from '../src/permissions.js';

describe('RBAC permissions', () => {
  it('gives center owners management permissions', () => {
    expect(hasPermission('CENTER_OWNER', 'students.create')).toBe(true);
    expect(hasPermission('CENTER_OWNER', 'finance.refund')).toBe(true);
  });

  it('limits teachers to their operational scope', () => {
    expect(hasPermission('TEACHER', 'attendance.create')).toBe(true);
    expect(hasPermission('TEACHER', 'students.delete')).toBe(false);
    expect(hasPermission('TEACHER', 'finance.record_payment')).toBe(false);
  });

  it('does not grant student management permissions', () => {
    expect(permissionsFor('STUDENT')).toEqual(['students.view', 'groups.view', 'attendance.view', 'academic.view']);
    expect(hasPermission('STUDENT', 'students.update')).toBe(false);
  });

  it('keeps platform administration outside normal center roles', () => {
    expect(hasPermission('SUPER_ADMIN', 'users.assign_permissions')).toBe(true);
    expect(hasPermission('CENTER_OWNER', 'users.assign_permissions')).toBe(true);
    expect(hasPermission('TEACHER', 'users.assign_permissions')).toBe(false);
  });
});
