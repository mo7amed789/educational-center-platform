# Teacher attendance is read-only

Teachers can view daily statistics for all their currently assigned groups or one selected group, and the names of pupils explicitly recorded absent. They cannot scan, manually record/correct or mark a whole group present. The teacher portal and role matrix describe follow-up rather than recording.

The default TEACHER role no longer grants `attendance.create` or `attendance.update`. All four attendance write APIs explicitly reject TEACHER actors even with custom permissions. Legacy JSON and Excel imports can contain attendance, so these two import APIs also reject teachers rather than offering an indirect recording path. Student and guardian actors cannot use these write paths either. Authorized staff/owner recording is unchanged.

`GET /api/center/attendance/teacher-summary?date=YYYY-MM-DD&groupId=optional` is teacher-only, requires the existing attendance/group/assigned-student read permissions, and rechecks active authorization and current same-center assignments. It returns minimal group labels, counts and absent pupil names/IDs, without contact, finance or private notes. Invalid dates and extra scope parameters are rejected. Unassigned, cross-center and corrupt teacher-profile groups are unavailable.

The basis is `CURRENT_ENROLLMENTS`: current group rosters for the selected date, not reconstructed historical enrollments or a monthly total. A pupil in two groups counts once per group. Present, explicitly absent, late, excused, unknown and unrecorded remain separate. Missing attendance never becomes an absence or an invented attendance rate. Historical records are not deleted or changed.

Verification covers role defaults, every write entry point with overrides, current assignment and membership, date/group validation, tenant boundaries, legacy status values, absence-only names and no contact/finance disclosure. Client tests cover read-only controls, no write calls, date/group/account response guards and failure clearing. The full existing parent/student reporting suite remains green. Staff audit rollback coverage is retained with an authorized staff actor rather than the now-read-only teacher.

Actual desktop and 390px mobile checks use a fresh disposable non-seeded database. They verify scoped counts, absent-only names, no teacher write controls, direct API 403s, unrecorded/excused distinctions and a successful staff code scan. No schema or dependency changes.
