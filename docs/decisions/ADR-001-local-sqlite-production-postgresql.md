# ADR-001: SQLite for local development and PostgreSQL for production

## Status

Accepted for the current prototype; production migration pending

## Context

The project needs a zero-configuration local database for demo data while preserving a relational model suitable for multiple centers, branches, enrollments, attendance, and finance.

## Decision

Keep SQLite for local development only. Use PostgreSQL with versioned Prisma migrations for staging and production.

## Consequences

Local setup remains fast and reproducible. Production work must include a PostgreSQL schema migration, connection pooling, backup policy, restore testing, and a staged data migration. The application must reject a file-based `DATABASE_URL` when `NODE_ENV=production`.
