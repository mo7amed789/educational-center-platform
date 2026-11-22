# Response visibility and honest UI states

## Financial information is a separate permission

Attendance recording or a student-profile read is not permission to see a pupil's payment status.

- The scan response includes `financialVisible`. Without `finance.view`, it omits `subscription` and `isPaid`. Attendance can still be recorded within the caller's resource scope.
- Generic student detail and the student academic portal omit subscriptions without `finance.view` and include `financialVisible` alongside the student.
- Operational summaries require `reports.view`. Financial summary fields additionally require both `finance.view` and `finance.view_reports`. An explicit denial of either removes the revenue and subscription aggregates.
- Authorized guardian billing reads remain limited to their linked children. These changes do not grant teachers, receptionists or students finance access by default.
- Teacher summary counts and class data stay within the assigned-resource scope when a reporting action is explicitly granted.

The kiosk renders denied financial access as unavailable, not unpaid. A missing payment-status field must never be interpreted as a debt.

## What the summary measures

The existing `revenue` field is retained for compatibility, but `financialBasis` identifies it as `subscription_status_totals`. It sums the face values of subscriptions marked paid or partial. It is not a cash ledger or proof of money received. The UI labels this as a subscription indicator, with the billing review still open.

Attendance summaries now use the requested month. The report view calculates its percentage from recorded present, late and absent statuses. Missing attendance rows are not inferred absences.

Dashboard and report views no longer substitute invented revenue, collection rates, attendance percentages, room/status rows, active-session counts or backup-success claims. Zero stays zero. Session rows come from the recorded lessons for today. No available report means unavailable, not a demo value. Student totals use the scoped summary count, not the first page's length.

## Account changes and loading

Account changes clear cached center records and private modal contents. A session generation check discards responses from the previous account. The UI waits for the initial data load rather than rebuilding a scan form while someone submits it.

Bodyless requests, including logout, no longer declare an empty JSON body. Successful logout is checked by the server clearing the session cookie. A failed logout shows a retry action rather than claiming the server session ended. Login passwords and MFA entries are cleared after successful login.

The student page loads the own-student portal instead of trying to use the manager overview. A missing profile is shown as unavailable, not a made-up student. Its card shows a manual student code instead of a decorative fake QR. Generating scannable student cards and wallet passes remains separate work.

## Verification and remaining gates

Disposable fixtures cover reception, teacher, student, guardian and owner finance visibility, explicit finance denials, stale account responses, bodyless request headers, real zero values and calculated attendance percentages. Browser checks cover an owner-to-reception account change, a true zero report, a mobile scan, mobile student layout and removal of the logout cookie. Screenshots contain fake seeded records only.

This is not the end of the security or product audit. Still open: mixed-sheet export permissions, other nested relation fields and corrupted foreign references, all resource-specific permission-denial combinations, other staff-role policies, legacy HTML rendering/XSS review, shared-record archival/deletion rules, versioned production migrations and financial ledger correctness. Deployment remains gated by `ENTERPRISE_READINESS.md`.
