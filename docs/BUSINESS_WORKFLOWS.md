# Business Workflows

## Enrollment

`DRAFT → PENDING_REVIEW → PENDING_PAYMENT → ACTIVE → SUSPENDED / TRANSFERRED / WITHDRAWN / COMPLETED`

The service validates duplicates, center/branch scope, group capacity,
schedule conflicts, fees, and required approvals inside a transaction. It then
creates an audit event and queues notification work only after commit.

## Attendance

An authenticated teacher or authorized employee must be assigned to the group
before loading the session. The transaction validates `PRESENT`, `ABSENT`,
`LATE`, or `EXCUSED`, writes the record, records corrections with a reason,
and emits an absence notification event after commit.

## Payments

Invoices and payment allocations are append-oriented. A payment receives an
idempotency key, validates the invoice and amount, updates balances in one
transaction, creates a receipt, and never overwrites historical financial
records. Refunds require a separate permission and audit event.

## Guardian access

Every child query is scoped through an explicit guardian-child relation. A
frontend-supplied student ID is never sufficient to authorize access.

## Notifications

Business transactions create outbox events. A worker selects a configured
template/channel, records queued/sent/failed status, retries transient errors,
and never reports delivery merely because a WhatsApp URL was generated.
