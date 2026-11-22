# Grade student-code search and loading diagnostics

## Code search

On Student grades, choose a group, then enter the student's fixed code and click Search or press Enter. Accepted formats are the numeric ID, `#ID`, and `STUDENT:ID`. Arabic and Persian digits are normalized to the same numeric ID. Matching is exact, not a partial code or name search.

Each search refreshes the selected group's authorized enrollment roster. It does not search the first global student page, other groups, or other centers. A miss does not confirm whether the code exists elsewhere. The existing group/center/teacher authorization also remains on the final grade write.

Enter searches without submitting the assessment. Editing the code immediately clears the old pupil selection and disables Save until a pupil is selected again. Group/account changes and later manual selections invalidate old search responses. Messages and values are HTML-escaped.

## Loading behavior

The group picker now has its own scoped read endpoint, `/api/center/grades/groups`, independent of grade history. A failing history query therefore does not silently empty both pickers. Group refresh, history retry and distinct session, permission, missing-profile and HTTP server-error messages are provided. Raw SQL and server stacks are not displayed in the page.

A teacher still needs an active center membership, grade-management permission, a same-center profile linked to that user's ID, and assigned groups. The new endpoint rejects learner roles even if a custom staff permission was added. It never matches a teacher by display name or silently changes assignments.

## Verification

- Build and 429 tests pass, including current group boundaries, exact code formats, old-selection clearing, late-response guards, permission/session messages and escaped feedback.
- Actual desktop/mobile checks used a new non-seeded center, a newly linked teacher, arbitrary group IDs, and more than 150 pupils. The searched pupil was beyond the first 100 global cached pupils.
- Number/prefixed/Arabic-digit searches selected the right pupil. Unassigned-group, other-group and foreign-center codes selected nobody. Enter did not issue a grade POST. A later explicit Save recorded a real zero with the teacher's atomic audit.
- A temporary schema fault in this disposable database reproduced a history HTTP 500. Scoped groups and their rosters still loaded, the page showed the server status, and retry recovered when the temporary fault was removed.
- Desktop/mobile before/after views and the history-error state were visually inspected, with no page errors or horizontal overflow in checked views.

The reported laptop failure was not reproduced with normal non-seeded data. Its exact cause remains unverified without that server's error at refresh time. This change improves failure isolation and diagnostics; it does not claim to repair an unknown local database or permission issue. Do not reset a user's database to fix a generic loading message.

No schema or dependency change. Existing exam publication and correction permissions are unchanged.
