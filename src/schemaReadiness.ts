import type { PrismaClient } from '@prisma/client';

export const SCHEMA_REPAIR_MESSAGE = 'SCHEMA_UPDATE_REQUIRED: Stop the server and back up the database at DATABASE_URL. Run npm run db:generate, then npm run db:push, then restart. Never reset the database or accept data loss. أوقف السيرفر وخد نسخة احتياطية من قاعدة البيانات، ثم نفذ أوامر توليد العميل وتحديث المخطط وأعد التشغيل. لا تستخدم reset أو قبول فقدان البيانات.';
type ReportClient = Pick<PrismaClient, 'exam' | 'gradeRecord' | 'gradeCorrection' | 'learnerNotification'>;

// Read-only probes use an impossible generated CUID, select every scalar column,
// and work even when the tables are empty. They never repair or seed a database.
export async function assertLearningSchemaReady(client: ReportClient): Promise<void> {
  for (const name of ['exam', 'gradeRecord', 'gradeCorrection', 'learnerNotification'] as const) {
    if (typeof client[name]?.findFirst !== 'function') throw new Error(SCHEMA_REPAIR_MESSAGE);
  }
  const where = { id: '__schema_readiness_probe__' };
  try {
    await client.exam.findFirst({ where });
    await client.gradeRecord.findFirst({ where });
    await client.gradeCorrection.findFirst({ where });
    await client.learnerNotification.findFirst({ where });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'P2021' || code === 'P2022' || (error as { name?: unknown })?.name === 'PrismaClientValidationError') {
      throw new Error(SCHEMA_REPAIR_MESSAGE);
    }
    // A connection or access error is not an instruction to change the schema.
    throw new Error('STARTUP_DATABASE_UNAVAILABLE: Check DATABASE_URL, database access and the database service, then restart. تعذر الاتصال بقاعدة البيانات. راجع الإعدادات والصلاحيات ثم أعد التشغيل.');
  }
}
