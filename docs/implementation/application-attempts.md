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

## Audit follow-up (2026-10-18)

- Current closure reads the canonical job outcome/closure state, and archived attempts retain that closure when reapplying.
- Oversized IMAP emails persist metadata-only review notices before advancing the cursor; users inspect the original in their mail client and explicitly skip the notice. No body or attachment is downloaded.
- IMAP retains manual date/message limits per account for scheduled/default syncs and keeps up to 20 independent keyword/date-window cursors. Legacy cursors are retained, and mailbox changes clear them.
- Structured explicit-selection requirements are enforced by individual and bulk approval, including ambiguity across separate postings.
- Gmail keyword-enabled searches retain prior recruitment-sender, recruitment-subject, and scheduling discovery signals. Disabling filtering remains a date-only search.
- Inbox responses expose structured reopening eligibility; choosing a current closed attempt for an initially unmatched offer exposes reopening, with server validation unchanged.
- Repeat-safe migration repairs missing initial posting identifiers without overwriting existing references or assigning initial references to later attempts.

Focused validation: 66 tests passed across six files; after preserving the existing no-suggested-match bulk error contract, 35 API/routing tests passed. Final CI-parity verification passed on Node 22.23.1: Biome CI, all four type checks, client production build, and the full suite (313 files; 2,226 tests passed, 6 skipped). Documentation production build and whitespace checks also passed. Local health endpoints returned HTTP 200; the database retains 406 jobs and zero foreign-key violations. Live provider/AI behavior was not retested.

## Second audit follow-up (2026-10-18)

- Historical event deletion returns after removing the event, without recomputing the current application. Metadata-only edits preserve job state; unrelated event changes/deletions cannot discard independent outcome-only closure.
- Cursor restoration requires the same normalized host, port, transport security, username and mailbox, with the existing authentication-method check retained.
- Oversized notices use the envelope RFC Message-ID when available. Rescans preserve terminal decisions; old location-based notices are promoted within the same scoped account without replacing their row or dismissal. Missing historical Message-IDs cannot be reconstructed reliably after a move/UID reset.
- Added real encrypted-repository/SQLite coverage with only the IMAP network boundary mocked, including endpoint changes, persisted dismissal across resets/moves, legacy promotion, and tenant/user/account isolation. All fixtures use isolated temporary databases.

Verification on Node 22.23.1: all seven required CI-parity checks passed. Full suite: 314 files passed, 2,238 tests passed, 6 skipped. Documentation build and whitespace checks passed. Focused checks included 11 real-persistence IMAP cases and the tracking/approval regressions. The active database retains 406 jobs and zero foreign-key violations; live email providers were not contacted by the tests.

## Third audit follow-up (2026-10-18)

- Replaced timestamp/outcome closure-ownership inference with an internal current-attempt `closure_event_id`. Event transitions and recomputations write it; explicit job outcome/closure updates clear it in the same transaction. Unknown pre-upgrade origins remain independent rather than being guessed.
- Event edits compare the submitted lifecycle values with the stored event. An actual client-generated label-edit request resubmitting unchanged stage/date/null outcome preserves independent closure.
- Generic Closed events with a manual reason code and null outcome can be deleted through their recorded provenance; reason codes no longer invent rejected outcomes for Closed events.
- One normalized endpoint identity is shared by checkpoint restoration and no-Message-ID notice identity. Changing endpoints disables legacy location-only promotion, including subsequent display-only reconnects. Existing history remains intact.
- Regression coverage exercises the actual client formatter, real SQLite/encrypted IMAP storage, endpoint collisions with/without RFC IDs, tenant isolation, and repeat migration preservation of provenance.
- Local database backup preceded migration. All 406 job status/outcome/applied/closure fields were unchanged afterward, with zero foreign-key violations.

Final verification on Node 22.23.1: all seven CI-parity checks passed; 314 test files passed, 2,242 tests passed, 6 skipped. Documentation production build, local backend health, and whitespace checks passed. Focused lifecycle/IMAP tests passed (62 tests), followed by migration/client-payload/endpoint boundary coverage (44 tests). Live providers and container deployment were not exercised.

## Closing-event edits and notes follow-up (2026-10-18)

- Generic Closed edits no longer submit a synthetic null outcome. The editor initializes rejected/withdrawn events with their outcome and initializes notes as notes.
- Editing history cannot acquire an independent current closure, regardless of submitted stage/outcome differences. Current-state changes remain explicit through outcome/status/reopen actions.
- A shared lifecycle predicate excludes notes in tracking, attempt display, email chronology, and client current-stage selection. Edit/delete recomputation is centralized; notes remain visible in history and cannot become the source of a closure.
- Regressions use the actual client formatter and real SQLite for closing-label edits, explicit history corrections, deletion with later notes (including a note carrying an outcome), subsequent stage edits, and note deletion. Focused suite: 51 tests passed.

Final verification on Node 22.23.1: all seven CI-parity checks passed. Full suite: 314 files passed, 2,246 tests passed, 6 skipped. Documentation production build and whitespace checks passed. No migration was required; live providers and container deployment were not exercised.
