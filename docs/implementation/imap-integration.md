# IMAP integration implementation checklist

- [x] Inspect provider abstraction, Gmail ingestion, AI router, review inbox, tenancy, and SQLite repositories.
- [x] Add encrypted IMAP account configuration and safe public settings.
- [x] Implement read-only TLS IMAP transport, MIME parsing, and incremental UID checkpoints.
- [x] Reuse classification and review pipeline; prevent unsafe automatic status changes.
- [x] Add account management, presets, connection testing, and manual sync to Settings.
- [x] Add automatic sync with tenant/user context and retry behavior.
- [x] Add regression tests and user configuration documentation.
- [x] Rerun all repository CI-parity checks for the reconstructed implementation.
- [ ] Live provider verification (requires provider credentials; never assume verified).

Architecture: React/Vite client, Express API, Drizzle/SQLite integration/message/sync-run tables. Existing provider actions and review/history APIs are reused. Private data is scoped by tenant and, in hosted mode, user. Gmail OAuth remains supported.

Implementation notes:
- Reuse existing integration credentials JSON (AES-256-GCM envelope for IMAP), messages, sync runs, inbox review, and job history. No migration or Gmail data rewrite is necessary.
- New dependencies: ImapFlow and mailparser; existing html-to-text removes HTML before classification/display.
- Required environment: `EMAIL_CREDENTIALS_KEY` (64 hexadecimal characters). See `/docs/getting-started/imap-email-setup`.
- Password/app-password and supplied XOAUTH2 tokens supported. Non-Gmail OAuth token acquisition/renewal remains manual because there is no existing general OAuth broker.
- Conservative behavior: all relevant IMAP suggestions require confirmation, including high-confidence results. Older suggestions cannot overwrite newer confirmed stage events; link with no_change instead.
- Single server process per database: in-process locks coordinate sync/configuration. Alias-equivalent mailboxes cannot be identified reliably; configure one integration per actual mailbox.
- Messages above 5 MiB fail the batch without advancing beyond the failure. Initial backlog is processed oldest-first in bounded batches within Search Days. Empty matching ranges are checkpointed without skipping candidates excluded by Max Messages.
- Transport/AI tests use mocks; bilingual routing tests verify prompt/output contracts rather than live model accuracy.

Original validation on Node 22.23.1 (historical; the rebuild is verified separately below):
- `./orchestrator/node_modules/.bin/biome ci .` — passed.
- `npm run check:types:shared` — passed.
- `npm --workspace orchestrator run check:types` — passed.
- `npm --workspace gradcracker-extractor run check:types` — passed.
- `npm --workspace ukvisajobs-extractor run check:types` — passed.
- `npm --workspace orchestrator run build:client` — passed (existing bundle-size warning).
- `npm --workspace orchestrator run test:run` — 304 files passed; 2,158 tests passed, 6 skipped, no failures.
- Focused thread-reference ingestion regression — 8 tests passed after the final matching update.
- `git diff --check` — passed.

Missing extractor dependencies were restored with root `npm install`; the initial dependency failures and transient Settings test failure passed on rerun. No failures were ignored.

Live provider credentials are unavailable, so live authentication/sync, provider rate-limit behavior, and live AI accuracy remain unverified. These results describe the initial implementation, before the combined rebuild below.

Modified areas:
- Server: existing provider dispatcher/Gmail adapter, new IMAP adapter/configuration/transport/sync/scheduler, integration repository, provider API routes, review safety, and shared AI router prompt.
- Client: Settings email accounts component/navigation and Tracking Inbox account links/IMAP setup navigation.
- Tests: encrypted repository isolation, configuration/security, transport retries, incremental sync/deduplication/reference matching, bilingual AI contract, scheduler context, provider actions, and older-message review protection.
- Configuration/documentation: orchestrator dependencies and root lockfile, `.env.example`, IMAP setup guide, Gmail setup cross-link, and this checklist.


## Rebuild from the original clone (2026-10-17)

- [x] Preserve the tracked diff, 25 untracked feature files, existing environment files, and consistent SQLite backups outside the repository.
- [x] Restore tracked source to clone commit `cb8803c` and verify an empty tracked diff before reapplying the combined implementation.
- [x] Reconstruct original IMAP integration plus saved account selection, user/workspace browser preferences, bounded date/keyword searches, multilingual AI instructions, and safe email approval.
- [x] Verify both existing databases contain 406 jobs and preserve the persistent encryption key.
- [x] Review incremental search checkpoints; add coverage for empty ranges, capped results, and search failures.
- [x] Start frontend/backend and verify local health (frontend 5173 and backend /health on 3001 both return HTTP 200).
- [x] Complete current CI-parity checks and record fresh results below.

Recovery snapshot: `/home/fedora/job-ops-recovery/20261017T195313Z` (contains private configuration/database backups; do not commit it).

Reconstructed feature coverage:
- Saved IMAP account selector and browser selection memory scoped by signed-in user and workspace.
- Date-window and maximum-candidate limits; bounded SEARCH ranges; explicit failed-search handling; safe checkpoints for empty ranges.
- English/German preset keywords, custom terms, optional AI language suggestions, and tenant/user-scoped saved filters used by manual and scheduled syncs.
- Classification instructions for any language and mixed-language communication; external content remains untrusted.
- Older confirmations of the same stage/outcome link without false conflicts; a visible No change action links messages without changing status.
- Updated setup/search guides and navigation in the documentation sidebar.

Local runtime verification: preserved 406 jobs in both restored SQLite copies, preserved the existing `.env` byte-for-byte (persistent key present, mode 0600), backend health and frontend HTTP 200. Database files are excluded locally via `.git/info/exclude`.

### Fresh rebuild validation (2026-10-17, Node 22.23.1)

All seven required checks passed: Biome CI, shared types, orchestrator types, Gradcracker types, UKVisaJobs types, client production build, and full orchestrator tests.

- Full suite: **311 files passed; 2,193 tests passed, 6 skipped, no failures**.
- Focused suite: **20 files / 108 tests passed**.
- Documentation production build: **passed**, including the new sidebar pages.
- `git diff --check`: **passed**.
- Local backend health and frontend: **HTTP 200**; persistent key unchanged; restored databases retain **406 jobs**.
- Client build retains the existing bundle-size warning; documentation build warns that new files lack Git update dates.

Live IMAP provider behavior and live AI accuracy were not tested during this rebuild. All transport/classification regression tests use mocks. No source changes were committed or published.
