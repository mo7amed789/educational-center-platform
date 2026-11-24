# Enterprise readiness checklist

This document separates implemented controls from deployment-dependent work. The local application is not declared production-ready until every deployment-dependent item has evidence.

## Implemented and verified locally

- [x] Cookie sessions with server-side expiry and hashed session IDs
- [x] TOTP MFA setup, enable, disable, and login challenge
- [x] Manager UI for MFA setup, verification, and disable flow
- [x] Authenticated password rotation with session revocation
- [x] Role and permission checks on protected API routes
- [ ] Complete API-wide center, branch and role resource-scope audit. Route inventory, unauthenticated access and cross-center ID access are now release-gated by `tests/routeScopeAudit.test.ts`. Still open: per-role (not only per-center) matrix for every route, Receptionists are now branch-bound like branch admins (`isBranchBound` in `src/resourceScopes.ts`); a receptionist account with no branch is refused. Role-by-route denial matrix: `tests/roleRouteMatrix.test.ts` (tested roles: receptionist, accountant, teacher, student, guardian). Accountant export is intended policy (owner decision Nov 24 2026): `GET /api/export/excel` keeps exporting teachers, groups, student and parent contacts, attendance and subscriptions for the whole center (covered by `roleRouteMatrix`). Open: the branch list visible to every role. This is not a full API-wide isolation certification.
- [x] Helmet security headers and rate limiting
- [x] Input schemas for authentication, attendance, subscriptions, and legacy import
- [x] Upload size limit, XLSX extension allowlist, and ZIP signature check
- [x] JSON and Excel import/export with audit events
- [x] Health, readiness, and Prometheus-style basic metrics endpoints
- [x] Build, unit tests, and local API flow checks
- [x] CI workflow for install, Prisma generation, build, tests, and dependency audit
- [x] Operational summary reports and manager-only audit-log API

## Still required before production

- [ ] PostgreSQL schema migration and versioned production migrations
- [ ] Managed secret storage and rotation for `SESSION_SECRET`
- [ ] HTTPS termination, explicit trusted origins, and a strict CSP
- [ ] Account recovery flow with a verified email/SMS provider
- [ ] Shared rate-limit storage when running more than one instance
- [ ] Managed backups with restore drills and a documented RPO/RTO
- [ ] External object storage for uploaded files
- [ ] Notifications provider and an outbox/worker with retry and dead-letter handling
- [ ] Payment gateway integration with webhook signature verification
- [ ] Full invoice/receipt/refund accounting workflow
- [ ] E2E browser tests for each role and critical flow
- [ ] Error tracking, durable metrics storage, tracing, alert rules, and runbooks
- [ ] Privacy retention/deletion policy and legal review

## Current release gate

The project uses SQLite for local development. Production deployment must stop until PostgreSQL migrations, HTTPS, secret management, backups, and the remaining security controls are configured in a real staging environment. The local production-dependency audit (`npm audit --omit=dev --audit-level=high`) reports zero vulnerabilities in this slice. Keep the CI dependency audit enabled. A passing audit is not proof of production readiness, and development-tool dependencies need their own review.

## Tenant audit, import and finance slice

Verified against disposable two-center fixtures:

- Legacy teacher/group/student imports cannot take over an ID belonging to another center. The current schema uses global numeric IDs. A collision rejects and rolls back the import instead of remapping or moving existing data.
- JSON import includes its audit in the same transaction. Excel import includes legacy sheets, validated subscription rows and the audit in one transaction. Subscription rows require a same-center student, group and enrollment. An invalid later row rolls back earlier sheets and rows.
- Teacher deletion checks the target center and keeps the center predicate on the delete. Deletion and its audit are atomic. Foreign and missing IDs both return 404.
- Payment reads check both student and group centers. Guardian reads are restricted to linked own-center children; new responses omit unrelated contact fields.
- Payment recording requires a same-center enrollment. Payment, subscription update and audit are atomic. This records internal bookkeeping only, not a gateway charge.
- Regression tests reproduce the former failures on the baseline and verify rollback with a forced audit failure.

This slice is not the whole security audit. Branch and assigned-teacher scopes are documented in [RESOURCE_SCOPES.md](RESOURCE_SCOPES.md); finance response fields and UI state checks are in [RESPONSE_VISIBILITY.md](RESPONSE_VISIBILITY.md). Still to review: mixed-sheet export permissions, other nested disclosures and corrupted references, all resource-specific permission-denial combinations, staff-role policies and legacy HTML rendering. The old payment upsert/partial-payment accounting model also needs the separate billing review before real financial use.
