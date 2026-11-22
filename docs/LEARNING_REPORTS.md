# Unified parent and student learning report

## What is available

The parent's linked-child portal and the student's own portal now use the same learning-report calculation:

- Explicit-date lesson cards with the actual recorded attendance status for each group.
- Present, absent, late, excused, unknown and not-recorded states remain distinct.
- The latest five recorded assessments up to the selected follow-up date, including zero scores. These may be from an earlier month.
- A separately selected month with recorded attendance totals, weighted scores and a card for each subject/group. Current enrolled subjects with no records are also listed without invented grades or attendance.
- Expandable attendance and assessment detail. Mobile detail rows show their labels without horizontal scrolling.
- The student's real linked identity and fixed manual code, never the first cached student or a fake wallet/QR card.

The day selection and month selection are independent. Changing the day does not silently change the chosen monthly report. The first child is selected from the linked-child list sorted by name; parents can choose another child.

## Endpoints and boundaries

- `GET /api/portal/parent/learning-report?studentId=...&date=YYYY-MM-DD&month=YYYY-MM`
- `GET /api/portal/student/learning-report?date=YYYY-MM-DD&month=YYYY-MM`

Both require authentication, active center membership and the existing attendance/academic view permissions. The parent endpoint requires the guardian role and a child linked to that guardian in the same center. The student endpoint requires the student role and resolves the profile from the authenticated account. It rejects a supplied `studentId` rather than using it. Missing profiles return an explicit error, not another pupil.

All attendance, grades, enrollments and lessons are scoped to that student and center, including when legacy data contains bad cross-center links. Responses expose no finance, phone, parent-contact or classmate data. Teacher/course lookup fetches only the label fields needed. The old monthly endpoint keeps its response semantics and uses the shared calculation. Its empty-month subjects list remains unchanged.

The student page no longer loads the generic center overview or first pupil page. Old responses from a prior account or report selection are discarded. Changing the child clears the previous child's result while loading.

## Explicit limits

- Attendance is still one record per student/group/date. Multiple timed lessons in a group on the same date share that status. The UI says this.
- No record means not recorded, not absence. No attendance denominator means no rate, not 100 percent.
- The day cards use stored dated lessons and actual attendance. An empty day means no dated lessons/records were found, not proof that no lesson was planned outside the system.
- The portal updates on load, selection change or manual refresh. This is not a push notification or an automatic WhatsApp alert.
- Existing GradeRecord entries are recorded assessments, not an exam timetable or a draft/published exam workflow. Exam scheduling/publication, grade correction/history and parent notifications are separate work.
- No schema change or deployment is included. The wider access/export/finance/session/migration audit remains open; this is not production approval.

## Verification

The standalone branch builds and passes 108 tests, including 27 new learning-report checks. The tests cover parent/student equality, explicit daily records, multiple lesson times sharing one group/day record, missing/cancelled lesson states, zero and weighted scores, current unrecorded subjects, tenant/child/self boundaries, query tampering, permission denials, missing profiles, recent-grade limits and compatibility with the old monthly route.

A fresh disposable-data browser run verifies matching parent and student records, no generic pupil cache load for the student, zero-score display and removal of a previous child's grades on child switch. Desktop light/dark and mobile layouts were inspected with no page errors or document overflow.
