---
id: application-attempts
title: Application attempts and late emails
description: Keep reapplications separate and attach late emails without reopening closed applications.
sidebar_position: 15
---

## What it is

A job can have multiple numbered application attempts. Each attempt has its own application date, stage history, application reference and posting/requisition reference. Email associations identify both the job and its attempt.

Existing installations receive one initial attempt for each tracked job. Existing events and matched emails remain associated with that initial attempt. Initial attempts inherit the existing posting identifier when available; rerunning migration repairs missing identifiers without replacing confirmed ones. JobOps does not invent historical reapplications from incomplete data.

## Why it exists

A late rejection or confirmation should not reopen a closed application. A new application for the same company and role should not inherit the previous application's email thread or outcome.

## How to use it

1. Upgrade using the normal database migration command before starting the server:

   ```sh
   npm --workspace orchestrator run db:migrate
   ```

   Docker's normal entrypoint runs migrations automatically. The migration is additive and safe to rerun. Keep your database backup and existing IMAP encryption key.
2. Open a job's **Emails** view to see **Application attempts**. The list shows dates, attempt numbers, references, and which attempt is current.
3. When reapplying to the same posting, close the current attempt, then select **Start new application**. Enter the application date and any application or requisition reference. The date must be after the previous closure; the server allows up to five minutes of clock skew. The job moves to Applied, while the previous attempt's closure, outcome, events and emails remain intact. For a separate posting, add it as a separate job.
4. Sync your email accounts normally. Confidently matched routine emails for a closed attempt attach automatically, without changing its stage, closure date, or outcome. This also applies to older pending messages when the inbox is refreshed. History records **Email linked automatically; application remains closed.**
5. In Tracking Inbox, an uncertain message asks you to select **Application attempt**. Choose the previous or current application using its number, date and reference, then confirm. Ambiguous matches across separate postings also require an explicit attempt selection; **Approve all** skips them. JobOps remembers confirmed message/thread/reference associations for subsequent replies. **Link only** attaches an email without applying a suggested stage.
6. A new unthreaded confirmation received after closure, a different application reference, or multiple possible attempts stays in review. Select the existing attempt, or select **New application** to explicitly start a separate attempt today and attach that email. Use the job's Emails view when you need to enter a different application date or reference manually.
7. Offers, interview invitations and explicit requests to resume an application on a closed attempt stay in review with **New opportunity on a closed application**. Select **Keep closed** to attach the email, or **Reopen application** to explicitly resume the current attempt. An initially unmatched offer also exposes **Reopen application** after you select the current closed attempt. Reopening keeps the same attempt number; it does not create a new application. An older attempt cannot reopen over a later application.

Matching uses confirmed reply/message references, provider conversation IDs, application references, posting references, application dates, and the configured AI's company/role match. Company and title alone do not select the newest attempt when several attempts or identical postings could match. Conflicting references require review. Routine automatic linking requires at least 95% confidence or an established, unambiguous conversation, plus a relevant-email classification. Offers and invitations always need review on a closed attempt.

Closing through the job outcome control also closes the current attempt, even when no stage event was recorded. Only one attempt on a given job is current. Starting another requires closing the current one. Concurrent applications to different postings should be represented by separate jobs. Manual and scheduled Gmail/IMAP syncs use the same attempt routing and tenant/user isolation.

## Common problems

- **A late confirmation still needs review:** A new, unthreaded confirmation after closure could be a reapplication. Confirm the previous attempt or start a new one. An old email discovered during sync is different from a genuinely new confirmation.
- **The newest application was not selected:** This is intentional when more than one attempt is possible. Select the correct attempt once; subsequent replies can follow that confirmed association.
- **The reference disagrees with the thread:** The email stays in review. Check the application number and posting before linking it. Providers sometimes reuse conversation IDs or candidate numbers across applications.
- **Reopen is unavailable:** Only the current closed attempt can be reopened. Attach messages for older attempts to their own history; they cannot replace the current application.
- **An old event was edited:** Editing or deleting historical attempt events does not change the current attempt's job status or outcome. Label edits also preserve closure recorded through the outcome control, including when the editor resubmits unchanged stage/date/outcome fields. Event-created closures record their owning event, so deleting that closing event can undo it. Closures predating this provenance record are treated as independent; deleting old history preserves them. Clear those closures explicitly through the job outcome control. The board and job header use the current attempt; the timeline labels previous attempts separately.
- **The application was already linked:** Repeated syncs preserve decisions and do not create duplicate attempts or stage events. To correct a historical association, review the existing job/email history; syncing again does not reclassify decided messages.

Email classification depends on your configured AI model. Automated tests use mocked provider/AI responses; live provider accuracy is not guaranteed.

## Related pages

- [IMAP email accounts](/docs/next/getting-started/imap-email-setup)
- [Email search keywords](/docs/next/getting-started/email-search-keywords)
- [Post-application tracking](/docs/next/features/post-application-tracking)
