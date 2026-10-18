# Application attempts and late-email automation

- [x] Add tenant/user-scoped numbered attempts and safe legacy backfill.
- [x] Bind confirmed message, thread, and application references to attempts.
- [x] Match job and attempt independently; keep ambiguous/new-reference messages in review.
- [x] Automatically link routine closed-attempt emails without changing closure/status.
- [x] Flag opportunities on closed attempts; support explicit reopening and new attempts.
- [x] Add attempt selection/history to the existing UI.
- [x] Add migration, isolation, routing, idempotency, and UI regression coverage.
- [x] Update user docs and run all seven CI-parity checks.

Existing uncommitted IMAP/keyword features are preserved. Existing history will be assigned to one initial attempt per job; historical reapplications will not be invented. Live providers/AI are not part of automated verification.

Implementation decisions:
- Numbered attempts are separate rows; stage events and email records link to an attempt. Prior events are backfilled once, and the legacy private-table rebuild preserves attempt-aware tables on subsequent starts.
- Confirmed identities are hashed and scoped by tenant/user/provider/account; no new external service or profile payload is introduced.
- All automatic late-email actions preserve application status. A new unthreaded confirmation after closure, new/conflicting references, or repeated applications requires review.
- The existing active-application Gmail automation also validates current attempt, closure, and event chronology before changing a stage.
- Reopening is explicit and restricted to the latest closed attempt. Starting a new attempt preserves history and resets only the current job's active state.
- Local databases were snapshotted under `/home/fedora/job-ops-recovery/attempts-20261017T201606Z` before schema changes.

Verification so far:
- 121 focused tests passed across routing, ingestion, API review, migration, repositories, and inbox UI.
- Final display guards also passed focused JobPage, board, timeline, and shared current-attempt event tests.
- Initial full CI run: 2,214 tests passed, 6 skipped; final run includes additional current-attempt display regressions.
- Local migration succeeded with 406 jobs retained and zero foreign-key violations. Comparing pre-/post-migration job rows confirmed all statuses, outcomes, applied dates, and closure dates were unchanged.
- The development backend was restarted after migrating; no encryption keys were changed.

Review fixes: legacy private-table rebuilds preserve attempt links; stored job ownership is inherited in local mode; legacy closure/outcome snapshots survive starting a new attempt; edits/deletions of historical stage events cannot update the current application; terminal email associations remain immutable during resync. Board and job-page stage displays select the current attempt, and the timeline labels attempts.

Final verification (2026-10-18, Node 22.23.1): all seven required CI-parity checks passed. Full suite: 313 test files passed, 2,218 tests passed, 6 skipped. Documentation production build and `git diff --check` passed. The local database retains 406 jobs and 29 initial attempts with zero foreign-key violations. Development frontend (5173) and backend health (3001) both returned HTTP 200. Live IMAP/Gmail and AI classification were not retested.
