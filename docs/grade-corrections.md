# Audited exam-result corrections

This slice builds on the exam/publication review. It changes exam scores only, not legacy standalone assessments. It is a review branch, not a deployment or a production-readiness claim.

## Staff workflow

Open an exam's results, then choose "سجل الدرجة / تصحيح" beside a recorded result. Enter a different score and a reason of 5 to 500 trimmed characters. A correction saves the previous score, new score, immutable maximum, revision, actor and timestamp. The existing add-result route still rejects replacement writes.

Draft correction requires `academic.manage_grades`. Correcting a published result additionally requires `academic.publish_results` and explicit confirmation that the change becomes visible immediately. A grader without publication permission can read the history but cannot change a published score. Default teachers receive no new grade or publication permissions.

Every read and write uses the exam's same-center group and existing primary-branch/assigned-teacher scope. An existing result can be corrected after unenrollment. Student and guardian accounts cannot enter these staff endpoints, even with custom permission overrides.

The browser submits the revision it loaded. A stale revision returns HTTP 409 `GRADE_CHANGED`; reload the history before trying again. Score, history and audit writes are one transaction. Zero is valid; negative, over-maximum, unchanged and non-finite scores are rejected. Corrections have no update/delete API. The latest 50 are displayed, while all rows remain stored. A staff name is shown only while its user still belongs to the same center; otherwise the history labels it as former staff.

Students and linked guardians see the corrected current published score and a short correction/revision label. Private reasons and corrector names are not included in learner reports. Drafts remain hidden. Existing weighted monthly totals use the current score.

## API

- `GET /api/center/exams/:id/results/:studentId/history`: current grade/revision, publication state, correction capability and latest 50 history rows, newest revision first.
- `POST /api/center/exams/:id/results/:studentId/corrections`: strict JSON `{score, expectedRevision, reason, confirmPublished?}`. The confirmation defaults to false.

Audit action: `exams.correct_result`. A student with correction history cannot be hard-deleted through the student route; it returns HTTP 409 `STUDENT_HAS_GRADE_HISTORY` without removing related rows. Database foreign keys also protect correction rows and their actor. A broader archival/retention policy remains separate work.

## Local upgrade

Back up the database named by the actual `DATABASE_URL`, stop the server, then run `npm run db:generate` and `npm run db:push` before restarting. Preserve the existing `.env`. This adds `GradeCorrection` and `GradeRecord.revision`. Do not reset, seed an existing database, or use `--accept-data-loss`. Stop on any destructive-change prompt. Production migration and deployment approval remain separate.

## Validation

API checks cover zero, invalid/no-op corrections, stale revisions, explicit published confirmation, separate permissions, learner privacy, center/branch/teacher scope, former enrollment, latest-50 retention, protected student deletion and rollback on audit failure. A disposable seeded browser workflow verifies publication followed by a correction, staff desktop/mobile history, and the revised own-student/linked-guardian result without leaking the reason. Inline JavaScript is parsed and actual dark-theme pixels inspected. Integration test files run serially because they share one SQLite fixture database and make global snapshot assertions.

No external email, WhatsApp or calendar messages are sent. In-platform notifications remain the next slice.
