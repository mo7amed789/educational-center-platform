# Implementation Status

## Complete

- Legacy HTML preserved with Arabic RTL role preview for owner, employee,
  teacher, student, and guardian.
- TypeScript/Fastify server and Prisma development schema.
- Cookie session login/logout/me endpoints.
- Basic center-scoped student API and legacy import endpoint.
- Password hashing, Helmet, rate limiting, input validation, and initial audit
  records for login/import.
- Initial permission tests and legacy validation tests.
- Permission catalog, center/branch memberships, user permission overrides, and
  an authorization service with deny-by-default tenant/branch checks.
- Seeded permission catalog and Center Owner membership.
- XLSX import/export with manager-only access, file-size/signature validation, and audit events.
- `/readyz`, `/metrics`, production configuration guards, and CI verification workflow.
- Center operational summary reports and manager-only audit-log API.

## In progress

- Backend resource-level authorization and tenant-isolation tests.
- API-backed frontend portals.

## Not complete yet

- Guardian/teacher/student account activation and linked-child models.
- Employee permission management UI.
- Full attendance corrections, schedules, invoices, refunds, academic module,
  notifications/outbox, backups, and background jobs.
- PostgreSQL production migration, deployment environments, MFA, E2E testing,
  durable monitoring/tracing, and provider integrations.

No production-readiness or legal-compliance claim should be made until the
remaining items are implemented and verified.
