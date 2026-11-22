# Fixed student code in selected attendance

The attendance log page now uses one stable identifier for a student: `STUDENT:<studentId>`. The same code works in every group the student is already enrolled in. Numeric IDs and `#<studentId>` are also accepted. It is an identifier, not a password or a self-check-in credential.

## Scope

- Staff select the group and date on the attendance log page, then use a keyboard-style barcode reader or type the code and press Enter.
- `POST /api/center/attendance/selected/scan` requires `code`, `groupId` and `date`. It never chooses today's lesson, the first enrollment, another group or another date.
- `GET /api/center/attendance/selected?groupId=...&date=...` loads the actual class roster and recorded statuses. It does not filter the first 100 global students. No record is shown as "not recorded", never as an invented presence or absence.
- Manual status changes use `POST /api/center/attendance/selected/record` with `studentId`, `groupId`, `date` and `status` through the same class/enrollment checks. The existing `attendance.create` requirement is preserved for staff writes.
- A repeated scan updates the same student/group/date attendance row. Scanning sets PRESENT, including when an earlier manual status differs. The audit stores the previous status. Staff can explicitly correct the status with the manual buttons.
- Bulk marking uses only the loaded selected roster. Partial failures are reported and the actual roster is fetched again; the UI does not claim that failed writes succeeded.

## Access and integrity

All new routes require an active authenticated user and the existing center permission checks. The group and pupil must belong to that center. Branch administrators are restricted to their valid primary branch and cannot use an explicitly inactive branch membership. Teachers are restricted to a group assigned to their same-center teacher profile. A pupil's home branch may differ from the selected group's branch if they are legitimately enrolled there.

Student and guardian roster reads are restricted to the student themself or linked same-center children, not classmates. Those roles cannot use the staff write endpoints, even with a custom attendance-create grant. Roster reads also require the relevant pupil/group view permissions. No finance or contact fields are returned by these new routes.

The selected group lookup, enrollment check, attendance write and audit are in one transaction. A rejected code never creates enrollment. Audit failure rolls the attendance write back. Late roster responses and responses from an earlier account are discarded by the page.

## Explicit limits

The existing database identity is **student + group + calendar date**. Two separately timed lessons in the same group on the same day still share that record. This change does not add timed-lesson attendance, exam attendance, camera decoding, wallet passes or generated QR cards. It accepts a reader that types the canonical code.

The older quick-scan kiosk remains a separate workflow with automatic group selection. This page does not call it. Its wider assigned-teacher/finance fixes are separate security reviews. This feature is not production approval and does not close the wider access, billing, export, migration or deployment audit.

## Verification

45 new checks cover code/date validation, explicit target selection, shared pupils, cross-home-branch enrollment, tenant and assignment boundaries, self/linked-child roster access, permission denials, duplicate attendance prevention, audit rollback and pupils beyond the first global list page. The standalone branch builds and passes 126 tests.

The disposable-data browser check covers the same code in two groups, no cross-group write, a rejected unknown code, restored input focus and an out-of-order roster response. Desktop dark and mobile light layouts were inspected. Mobile rows show status and manual controls without horizontal scrolling.
