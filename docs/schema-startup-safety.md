# Safe startup after updating

The learning-report transaction now awaits each database read before starting another. A synchronous missing generated model cannot leave an earlier monthly-report promise running without a rejection handler. A report failure returns an error through the normal request handler; it does not suppress errors or return invented records.

Before opening the listening port, normal `dev`, `start` and managed startup check the generated Exam, GradeRecord, GradeCorrection and LearnerNotification delegates and their scalar columns using read-only queries. This is a focused report/exam schema check, not a complete database integrity audit. Empty tables are checked too. No data is inserted, changed, seeded or migrated by the check.

A stale client, missing table or missing column stops startup with `SCHEMA_UPDATE_REQUIRED` and English/Arabic instructions. Connection/access failures instead say `STARTUP_DATABASE_UNAVAILABLE`; they do not tell you to change the schema.

## Recovery

1. Stop the running server.
2. Back up the actual database selected by `DATABASE_URL`. For local SQLite, stop all writers before copying its file. Preserve the existing `.env`.
3. From the application directory, run `npm run db:generate`.
4. Run `npm run db:push`. Stop if Prisma asks for destructive changes. Do not use `--accept-data-loss`, reset, or seed an existing database.
5. Restart the server. For `npm run start`, rebuild with `npm run build` before starting. The managed updater already generates, updates non-destructively and builds before its readiness check.

The startup check does not replace a backup, a supported migration plan or the separate permission/security reviews. The error is deliberately not hidden by a global unhandled-rejection handler.
