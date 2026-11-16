import { describe, expect, it } from 'vitest';
import { legacySchema } from '../src/legacyMigration.js';

describe('legacy data validation', () => {
  it('accepts the existing localStorage backup shape', () => {
    const result = legacySchema.safeParse({
      teachers: [{ id: 1, name: 'أ/ مدرس', subject: 'رياضيات', phone: '01000000000' }],
      groups: [{ id: 1, t: 1, grade: 'الأول الثانوي', days: ['السبت'], time: '4:00 م', price: 150 }],
      students: [{ id: 1, name: 'طالب', phone: '01000000001', parent: '01000000002', g: [1] }],
      att: { '1|2026-11-13': { '1': 'p' } },
      pay: { '1|1|2026-11': true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed records instead of importing them', () => {
    expect(legacySchema.safeParse({ students: [{ id: 'not-a-number', name: '' }] }).success).toBe(false);
  });
});
