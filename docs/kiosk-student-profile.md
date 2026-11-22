# Student profile on the scan kiosk

The kiosk keeps two distinct actions:

1. The existing code box and Enter/button check-in still POST to the original attendance scan route. That route's group/date choice and attendance behavior are unchanged. A successful scan then loads the student's profile with an attendance-confirmed notice. A profile-load failure does not undo that recorded attendance.
2. The separate name/code search is read-only. Names return explicit choices, even for one name result. Exact numeric, `#123` or `STUDENT:123` codes may open the exact profile directly. Search, selection and month changes do not create attendance or other student records.

The profile is below the scanning controls at full width. Sections cover identity, fixed code, student and parent contact fields, linked guardians, linked student account email/status, current enrollments and schedules, and the selected month's attendance, grades, subscriptions and payments. No credentials, MFA details, sessions or audit data are returned. Missing information is labeled rather than invented.

## Access boundaries

- These new routes allow only the staff roles already offered the kiosk: super admin, owner, center admin, branch admin and receptionist, with active `students.view` authority.
- Student search and identity use the existing center/branch student scope. Nested groups, records and histories use the same center/branch group scope. Cross-center corrupt relations are filtered, including teacher, course, branch, year and room labels.
- Group, attendance, academic and finance sections each require their own current permission. Unavailable sections are omitted on the server, not only hidden in the browser. Group prices are not included in the operational group response.
- Academic data includes general assessments and published exam results only. Drafts and inconsistent exam/group links do not appear.
- Financial data uses `finance.view`, as the existing individual student detail does. Payment rows and subscription status are shown separately. No inferred debt or unsupported paid-in-full calculation is added.
- Both GET responses use `Cache-Control: no-store`.
- Pending responses cannot repopulate the screen after a newer selection, navigation away or a session/account change. Errors and no-match results clear the previous profile.

## Scope and limits

Current groups are not a historical enrollment reconstruction. Records use a selected month. Each section is limited to 200 rows and clearly marks truncation. Search returns at most 20 matching names and asks for a more specific name/code when more exist. Attendance history is collapsed initially, with the other sections open. Mobile tables become labeled cards so scores, states and payment fields remain visible.

No database schema/dependency change. No change to the existing scan POST endpoint. No messages are sent to students or guardians.

## Verification

Build and 558 tests passed, including new API and UI tests for role, membership, branch/center scope, permission overrides/revocation, draft privacy, zero scores, duplicate names, escaping and stale requests. A real browser with a disposable database confirmed name/code read-only lookup, explicit duplicate-name selection, monthly filtering, published zero scores, hidden exam drafts, restricted reception data, preserved one-scan/one-check-in behavior and cleared no-match results. Desktop and 390px mobile screenshots were inspected in both themes, with no page errors or page-wide horizontal overflow.
