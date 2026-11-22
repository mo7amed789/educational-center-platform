# Resource scopes

Permissions answer whether an action is available. They do not grant access to every row with a guessed ID. A route must also apply center, branch, linked-child, self or assigned-resource predicates.

## Primary-branch administration

A `BRANCH_ADMIN` acts in the primary branch on their user record. Before business API handlers run, the server checks that the branch belongs to the current center, the center membership is active, and any explicit primary-branch membership is not inactive. A missing or foreign primary branch returns 403. Additional branch memberships do not widen the acting scope.

`CENTER_OWNER` and `CENTER_ADMIN` remain center-wide even if their user record contains a branch ID. This change does not redefine the scope of other staff roles. Their role-specific and assigned-resource audit remains a separate release gate.

| Resource/action | Branch-admin boundary |
| --- | --- |
| Student and teacher list/detail/create/update | Home branch in the current center |
| Groups, classrooms, sessions and summary counts | Current center and primary branch |
| Attendance, subscriptions, payments and assessment grades | Acting-branch group and same-center pupil |
| Attendance scan | Select only acting-branch enrollments; never fall back to a sibling group |
| Replace a home pupil's enrollment list | Replace only acting-branch links; preserve sibling links |
| Branch list | Primary branch only, with active authorization |
| Course catalog | Shared center catalog remains readable through overview; creation requires center-level authority |

A pupil whose home branch differs can legitimately attend an acting-branch class. Recording class attendance, subscriptions, payments, assessment grades or a scan is allowed for that same-center enrolled pupil. This does not grant branch admins general access to the pupil's home-branch profile. The existing general student list remains a home-branch list, not a complete cross-branch class roster.

## Related IDs and writes

- Student enrollment groups must all be in scope. One invalid group rejects the request rather than silently dropping that group. Duplicate group IDs are normalized.
- Teacher, course and branch assignments must belong to the current center. Branch admins cannot assign sibling-branch teachers or move resources out of the acting branch.
- Student, teacher and group create/update operations include their audits in the transaction. Related IDs are checked again inside those transactions. A failed audit rolls back related account, enrollment and subscription creation too.
- Attendance and subscription recording check the same-center enrollment inside the write transaction, with their audits. Classroom creation checks the branch and writes its audit in the transaction.
- Payment recording keeps enrollment validation, payment, subscription and audit in one transaction. No gateway charge is made.
- Session status changes keep the center/branch predicate on the actual write.
- Foreign and sibling resource mutation targets return 404; invalid related assignments return 422. An invalid scope does not fall back to the whole center.

## Deliberately unavailable to branch admins

Current JSON import, Excel import/export and audit-log workflows describe the whole center. They return 403 for branch admins until a properly scoped workflow exists. Course creation also requires center-level authority.

Student hard deletion returns 403 for branch admins, including alternate URL encodings of the numeric ID. A home-branch pupil can have academic or financial records in another branch, so a branch admin must not destroy that shared history. This is not an archival/deactivation workflow.

## Remaining audit and production gates

This is not a platform-wide security approval. Remaining work includes assigned-teacher reads and scan behavior, nested relation disclosure, per-permission response fields and denial overrides, export semantics for other roles, and staff roles other than the primary-branch admin. The old partial-payment/upsert accounting model still needs a separate billing review. Production migrations, deployment controls and role-by-role browser tests remain required in `ENTERPRISE_READINESS.md`.

The branch regression suite uses disposable two-center, three-branch fixtures. It checks both denials and legitimate owner/cross-home-branch behavior, including forced audit failures. No real student or financial database is reset by the test setup.
