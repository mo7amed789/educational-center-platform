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
- Full modern Apple/Fintech UI design system with Obsidian Dark and Porcelain Light themes, glassmorphism, and responsive navigation.
- Apple-style scroll-driven video frame scrubbing engine on the login screen with 3D device teardown, laser scanner sweep, Apple Wallet pass ejection, and narrative slides.
- Spotlight Command Palette (Cmd+K / Ctrl+K) for instant fuzzy search across students, teachers, pages, and actions.
- Interactive Kiosk Reception Barcode / QR Scanner with Web Audio chime, real-time student verification, fee status alerts, and WhatsApp parent messaging.
- Complete Student CRUD, Teacher CRUD, and Group CRUD APIs with center isolation and audit logs.
- Fintech Subscriptions & Payments API with payment methods (Cash, Card, InstaPay, Vodafone Cash) and printable electronic receipts.
- Dedicated role-based portals for Teacher, Student (with Apple Wallet ID pass), and Parent (with live child status).
- End-to-end integration test suite covering all student lifecycle operations, scanning, payments, and portals.
- Guardian and student linked-child portals with unified learning reports (`docs/LEARNING_REPORTS.md`), monthly parent report, exams with publish/correction history, teacher-scoped grade entry and learner notifications.
- TOTP MFA (setup, enable, disable, login challenge); setup is refused while MFA is enabled.
- Route scope release gate (`tests/routeScopeAudit.test.ts`): every `/api` route must answer 401 without a session, and another center's sessions, exams, students, teachers, groups and kiosk scans stay hidden and unchanged.

## In progress

- PostgreSQL production migration and durable background jobs.

## Not complete yet

- Self-service guardian/teacher/student account activation (linked-child models exist).
- Employee permission management UI.
- Full attendance corrections, schedules, invoices, refunds, academic module,
  notifications/outbox, backups, and background jobs.
- PostgreSQL production migration, deployment environments, browser E2E testing,
  durable monitoring/tracing, and provider integrations.

No production-readiness or legal-compliance claim should be made until the
remaining items are implemented and verified.
