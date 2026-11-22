# Exam-selected grade entry

## Teacher workflow

The teacher sidebar has one `الدرجات` entry. Its default mode is an existing exam, not an immediately visible general assessment.

1. Choose the exam month, then an unpublished exam from an assigned group. No exam is selected automatically.
2. The exam's title, group, date and maximum fill from its authoritative record and are read-only.
3. Pick a pupil by name or search the exact fixed code. Numeric, `#ID`, `STUDENT:ID`, Arabic digits and Persian digits are supported. Lookup refreshes only the selected exam's authorized roster. Enter searches and never saves.
4. Enter a score and explicitly save the draft. Zero is valid; blank is not zero. The pupil and score clear after success, but the exam stays selected for the next pupil.
5. Existing results are read-only here. Corrections use the existing reason/revision/audit workflow instead of creating or overwriting another result.

The old general-assessment form remains an explicit secondary mode, labeled as immediately visible after saving. It does not fall back automatically when an exam is unavailable. Previous general assessments are not converted or linked to exams by matching their titles.

Teacher exam scheduling and correction tools are secondary navigation from the grade page, with a return button. Owner and other staff sidebar entries remain separate. Publication remains in the existing exam management workflow and requires its separate permission. No publication control or permission is added to the grade page.

The existing Exams & Results draft form also retains direct name selection and gains exact code lookup. It selects only pupils without a recorded result. Typing another code clears the previous pupil and unsaved score immediately. Existing-result codes point to correction instead.

## API and boundaries

`GET /api/center/grades/exams?month=YYYY-MM` requires `academic.manage_grades` and an authorized staff role. It returns up to 200 unpublished exams in that month, scoped by center, primary branch or the teacher's current same-center assignment. Scheduling permission is not needed to choose an existing exam. `canManageExams` only controls the secondary scheduling link and does not grant permission.

Detail and saves reuse `GET/POST /api/center/exams/:id/results`. Saves send only `studentId` and `score`. The existing transaction reloads the authorized exam, derives its metadata, validates current enrollment and maximum, rejects duplicates and published exams, and writes the existing result audit atomically. Draft results stay hidden from pupils and guardians. No new write path, schema migration, dependency or publication grant is introduced. The new exam UI helpers live in a same-origin JavaScript asset served by a fixed route.

Month, exam, mode and account changes invalidate pending lookups. Inputs are locked during a save. A successful save remains acknowledged if the following refresh fails; the form then blocks until detail can be reloaded. Conflicts refresh the current exam state without retrying the POST.

## Verification

- Build and the full automated suite.
- Grade-only access without scheduling permission, explicit grade denial, learner/guardian overrides, branch and assignment scope, unpublished/month filtering and strict query validation.
- Client tests for controlled metadata, true zero, blank/range rejection, read-only duplicates, no search writes, late responses, account/exam switching, failed post-save refresh, publication conflicts, name/code selection and one teacher sidebar entry.
- Actual desktop and 390px mobile UI with fresh non-seeded fixture data: two pupils saved to one selected exam, audits checked, true zero retained, draft privacy checked through the pupil report, duplicate and out-of-group code refusal, next-exam metadata reset and the separate general-assessment form preserved.
- Readable score fractions use explicit left-to-right direction in both result lists.

Native Windows execution and the previously reported laptop-specific load failure are not verified by this feature. Do not reset an existing database to use it.
