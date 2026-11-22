# Private in-platform result notifications

This slice builds on the exam/publication and correction/history work in review #10. It does not send email, WhatsApp, browser push or phone messages. It does not backfill events for results published before the feature is installed.

## Behavior

Publishing recorded exam results creates one notification per eligible student account and currently linked guardian account. Correcting a published result creates a separate revision-specific notification. Scheduling an exam, entering a draft score or correcting a draft creates none. Publication repeats do not duplicate the original event.

Events are created in the same database transaction as the publication/correction and audit/history. If notification writing fails, the whole change rolls back. An event copies no score, contact information, staff identity or private correction reason. The inbox shows the result title, student name, event type, event revision and creation time. "عرض النتائج الحالية" opens the current published-results section, not a stale score snapshot.

The student and guardian each have a separate read receipt. Marking the student's event as read does not mark a guardian's copy. Mark-read is idempotent and preserves the first timestamp.

The shared learner report loads notifications when opened or refreshed. There is no background polling or real-time delivery guarantee. The guardian's selected child filters the inbox. The latest 50 currently visible events are shown, with an unread count explicitly limited to that displayed window. It is not an all-time unread count. Notification failure does not hide the independent learning report and is shown as unavailable, not as an empty successful inbox.

## Live privacy checks

Every list and mark-read request checks the authenticated account's current role, center, academic/attendance permissions, student binding or guardian linkage, and the exam/result's same-center consistency. A stored recipient ID alone never authorizes disclosure. Unlinking a guardian, changing a student binding or center, disabling a membership, or revoking permission takes effect on the next request. Corrupt grade/exam group references are excluded.

Staff and owner roles do not get a learner inbox through custom permission overrides. A changed recipient role is not allowed to read old learner events. Creation also excludes inactive student accounts and guardians whose profile/account does not belong to the same center. Linking an account later does not retroactively create old notifications.

## API

- `GET /api/portal/notifications?studentId=...`: latest 50 visible events. Optional student filter, still own/link scoped. Response `{items, limit:50, unreadInPage}`.
- `POST /api/portal/notifications/:id/read`: strict empty JSON object. Marks only this recipient's currently visible notification. Missing, other-recipient and no-longer-linked events return the same 404.

## Local upgrade

Stop the server and back up the database named by the actual DATABASE_URL. Preserve the existing `.env`. Run `npm run db:generate`, then `npm run db:push`, then restart. This adds LearnerNotification and indexes; no seed/reset or accept-data-loss is needed. Stop on any destructive-change prompt. Production migration/deployment approval remains separate.

## Verification

The branch builds and passes 270 tests: the 246 synchronized exam/correction/main baseline plus 16 notification API checks and 8 UI identity/receipt checks. Tests cover recipient separation, current links/bindings/center/permissions, draft silence, exact latest-50 semantics, immutable first receipt, transaction rollback and delayed old-account/old-role/old-child responses. A fresh disposable seeded browser workflow verifies publication, correction, matching private recipient events and an independent student receipt. Actual dark student-mobile and guardian-desktop pixels are inspected, with no page errors or document overflow. No user's live database or contacts were used.
