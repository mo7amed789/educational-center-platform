# Enterprise readiness checklist

This document separates implemented controls from deployment-dependent work. The local application is not declared production-ready until every deployment-dependent item has evidence.

## Implemented and verified locally

- [x] Cookie sessions with server-side expiry and hashed session IDs
- [x] TOTP MFA setup, enable, disable, and login challenge
- [x] Manager UI for MFA setup, verification, and disable flow
- [x] Authenticated password rotation with session revocation
- [x] Role and permission checks on protected API routes
- [x] Center-scoped resource queries and teacher/student/guardian scopes
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

The project uses SQLite for local development. Production deployment must stop until PostgreSQL migrations, HTTPS, secret management, backups, and the remaining security controls are configured in a real staging environment. The current dependency audit still reports Prisma 6 high-severity advisories; upgrade and compatibility verification are required before release. The CI audit is intentionally a release gate and should remain failing while those advisories are unresolved.
