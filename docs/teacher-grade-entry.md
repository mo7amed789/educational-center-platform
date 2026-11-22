# Teacher grade entry

Teachers now have `academic.manage_grades` by default. This does not grant `academic.publish_results`.

## Workflows

- **Student grades:** choose an assigned group, a currently enrolled same-center student, the assessment, date, score and maximum. A genuine zero is valid. General assessments keep their existing immediate visibility in the student's and linked guardian's report. They are add-only in this release, with no edit or delete action.
- **Exams and results:** enter results as drafts and correct drafts with the existing reason, revision and audit history. Publication and corrections to published results still require the separate publication permission and explicit confirmation.

The grade page says which workflow is immediately visible and points to exams for drafts. The picker comes from the grade endpoint's scoped response, never the generic cached groups.

## Boundaries

Every request checks current authorization, active center membership, the teacher's current user-linked same-center profile, group assignment and same-center enrollment. Revoked assignments disappear on refresh and cannot be written through stale UI. Explicit grade-management denial wins over the new default.

Student and guardian permission overrides cannot make either role grade-entry staff. A grade and its audit save in one transaction. Late responses after account changes cannot repopulate the grade page.

## Verification

- Build and 385 tests pass, including teacher grade boundaries, zero/audit recording, revoked and corrupt assignments, learner override denial, inactive membership, audit rollback, and stale client responses.
- Existing exam tests verify assigned draft entry/correction and refusal to publish without the separate permission.
- Real disposable seeded desktop/mobile workflow: teacher's picker contains only groups 101 and 121, a zero saves, an exam draft saves, a draft correction retains history, and no publication control appears.
- Fixed the native form `title` property collision by reading named form elements. Saved grade fractions use explicit left-to-right numeric formatting. Narrow-screen grade rows show all values with labels.

No schema, dependency or database migration change. This does not certify the remaining broader production audit.
