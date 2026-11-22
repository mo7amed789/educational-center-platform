# Exams and explicit result publication

This review slice adds real exam schedules and links their scores to the existing GradeRecord ledger. It is not a claim that the platform is production-ready.

## Local upgrade after merging

Stop the development server first. Back up the database named by your actual DATABASE_URL. With the unchanged example configuration, the SQLite file is `prisma/dev.db`. Keep any existing `.env`; do not replace it with the example.

```powershell
npm install
npm run db:generate
npm run db:push
npm run dev
```

Generating the Prisma client is required as well as updating the database. Restart the server after generation. This prevents an older client from missing model delegates such as `gradeRecord` or `exam`.

Do not run `migrate reset`, do not add `--accept-data-loss`, and stop if Prisma requests destructive changes. `db:seed` is only for a disposable demo database, not an existing user's repair. Production migrations, restore drills and deployment approval remain separate open work.

## Staff workflow

1. Open "الامتحانات والنتائج".
2. Choose a group from the endpoint's scoped group list. Enter the title, date, start/end, explicit IANA timezone and maximum score. The browser's timezone is a visible editable default, not a silent center-wide assumption.
3. Saving the schedule immediately shows it to currently enrolled students and their linked guardians. There is no draft schedule stage in this slice.
4. Staff with `academic.manage_grades` may enter a result for an enrolled same-center student. Zero is a real score. Missing results are not zero or inferred absence. Scores above the maximum and duplicate results are rejected.
5. Staff with `academic.publish_results` explicitly publish recorded results after a confirmation. Until then, exam grades are hidden from all learner monthly/recent/exam-result views. Legacy assessment entry remains separate and cannot list exam drafts.

The existing default teacher role may schedule its own assigned groups, but is not silently granted grade-entry or publication permission. Branch managers need a valid same-center primary branch and cannot access another branch's exams. Student/guardian custom overrides do not turn the learner into exam staff.

Schedules and result records are add-only in this first slice. There is no exam edit/delete, result overwrite, unpublish or post-publication entry. Publication requires at least one result, not a complete roster. Only students with recorded results receive a result; other students are not assigned zero. Publication does not automatically wait until the scheduled time. The separate correction-history slice is described in [grade-corrections.md](grade-corrections.md).

## Learner workflow

The shared parent/student report adds the next 20 exams from the selected follow-up date for current same-center enrollments, and the latest 20 own published exam results. Historical published results remain visible after unenrollment. Every result is limited to the student or the guardian's selected linked child. Published exam scores also join the existing weighted monthly score totals.

## API

- `GET /api/center/exams?month=YYYY-MM`: scoped schedules, scoped group picker and explicit grade/publication capabilities, at most 200 exams.
- `POST /api/center/exams`: create a schedule and audit atomically.
- `GET /api/center/exams/:id/results`: scoped current enrollment roster plus former students with recorded results.
- `POST /api/center/exams/:id/results`: add one immutable draft score and audit atomically.
- `POST /api/center/exams/:id/publish`: publish once and audit atomically; repeats are idempotent.

Date/time/timezone validation rejects impossible dates, unknown zones and end times no later than the start. Overnight exams are not supported in this slice. Times remain explicit local wall-clock values with their zone; this does not create external calendar events.

No email, WhatsApp or external account messages are sent. In-platform notifications remain separate follow-up work. Audited corrections are described in [grade-corrections.md](grade-corrections.md).

## Validation

32 new API checks cover schedule input, center/branch/teacher scope, explicit permission denial, inactive memberships, zero and invalid scores, enrollment checks, hidden drafts, own-only publication and atomic audit rollback for all three write routes. The merged-main baseline of 153 checks becomes 185 checks in this slice. A fresh disposable seeded browser run covers schedule creation, zero-score draft entry, draft privacy, explicit publication and matching own-student/linked-guardian result views, with dark mobile/desktop inspection.
