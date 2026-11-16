# Project Audit

## Snapshot

Audited on 2026-11-13. The repository contains a single legacy RTL HTML
application plus a newly introduced TypeScript/Fastify/Prisma foundation.

## Existing frontend

- `center-admin-v2.html` contains the working legacy business UI for students,
  teachers, groups, attendance, subscriptions, WhatsApp links, themes, and
  JSON backup/import.
- The current visible role entry is a local preview only. It must not be used
  as authentication or as a security boundary.
- Legacy data is stored under `localStorage` keys for teachers, groups,
  students, attendance, payments, and the next ID.
- Several screens still read and write local state directly and are not yet
  backed by API transactions.

## Existing backend

- Fastify server with `/healthz`, authentication session endpoints, legacy
  import, and a paginated students endpoint.
- Prisma schema currently models centers, branches, users, sessions, teachers,
  students, groups, enrollments, attendance, payments, and audit logs.
- Passwords are hashed with bcryptjs; sessions use hashed opaque IDs in an
  `httpOnly` cookie; Helmet and rate limiting are registered.
- Database development target is SQLite. Production PostgreSQL migration is
  still required before a production claim.

## Critical gaps

1. Backend roles are currently a single enum field; role memberships and
   per-user permission overrides are not yet modeled.
2. Teacher and guardian ownership scopes are not yet enforced on resource APIs.
3. Parent/student portals, employee management, branches, courses, exams,
   invoices, receipts, notifications, background jobs, and reports are not yet
   implemented end-to-end.
4. The frontend still has local-only flows for most legacy operations.
5. Automated coverage currently focuses on permission definitions and legacy
   validation; API integration, tenant-isolation, financial, and E2E tests are
   pending.

## Preserved functionality

The legacy HTML file and local JSON data format remain intact. Migration is
additive and must be verified before local data is retired.
