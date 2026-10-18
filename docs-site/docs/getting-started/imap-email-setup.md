---
id: imap-email-setup
title: IMAP email accounts
description: Connect email accounts and review application updates from any compatible IMAP provider.
sidebar_position: 8
---

## What it is

IMAP integration connects multiple mailboxes to application tracking. Gmail OAuth remains available in Tracking Inbox. IMAP uses the same AI routing, review inbox, sync history, and job email history.

## Why it exists

Application updates can arrive in Gmail, Outlook, GMX, WEB.DE, IONOS, or a self-hosted mailbox. IMAP provides a common read-only transport without moving, deleting, or marking messages read.

## How to use it

1. Generate a persistent encryption key on the server:

   ```sh
   openssl rand -hex 32
   ```

2. Set `EMAIL_CREDENTIALS_KEY` to that value in the server environment and restart JobOps. Back up the key separately from the database. Keep it unchanged across restarts and restores. If using Docker Compose, pass it to the application container.
3. Configure an AI model in Settings. Incoming email text (at most 12,000 characters), sender, subject, and active job company/title fields are sent to that configured AI provider. Attachments are not sent. Email content is treated as untrusted data.
4. Open **Settings → Email Accounts**. Choose a preset or enter your provider's hostname manually. Presets are starting points; check settings for your region/account.
5. Enter email address, display name, username, and password/app password. Choose **TLS / SSL** (default: port 993) or **Required STARTTLS** (usually port 143). Certificate validation is always enabled; plaintext authentication is unavailable.
6. Select **Test Connection**. The mailbox field initially uses `INBOX`; after testing, it offers discovered mailbox paths. Enter an exact path for another folder.
7. Select **Save account**. Stored passwords and tokens are never returned to the browser. When editing, leave the credential blank to keep it for the same host, username, and authentication method.
8. In Tracking Inbox, configure [Email search keywords](/docs/next/getting-started/email-search-keywords) (English and German enabled by default; custom keywords and optional AI language suggestions are available), then set **Search Days** and **Max Messages**, then select **Sync**, or select **Sync Now** in Settings (defaults: 90 days, 100 messages), or enable automatic synchronization. Default frequency is 15 minutes; allowed range is 5–1440 minutes. Automatic sync is disabled initially. The server checks due accounts once per minute while running.
9. Follow **Review messages and update history** to Tracking Inbox, or select **imap** as the provider there and choose your saved **Email account**. Tracking Inbox remembers the last provider and each provider’s account in this browser, scoped to your signed-in user and workspace. An explicit account link takes precedence. On the first visit, the first saved IMAP account is selected automatically when no account is specified. Use **Sync** to fetch messages; **Manage accounts** opens Settings when no connected account is selected. Relevant IMAP messages require approval before changing a job. Confidently matched routine emails on closed application attempts attach automatically while preserving closure; see [Application attempts and late emails](/docs/next/features/application-attempts). Check the suggested company, position, confidence, and event. Select **Link only** (or **Keep closed** for a closed attempt) to link communication without changing status. Older messages cannot overwrite newer confirmed stage or outcome changes. If an older message confirms the same current stage and outcome, approval links it without adding a duplicate stage event or changing the confirmed date. Notes do not count as stage changes.
10. Repeat for additional accounts. **Remove** erases credentials and stops sync while retaining application/email history.

Incremental sync records account, mailbox, UIDVALIDITY and last processed UID. Each run processes up to 100 messages by default (manual limit up to 500). Initial sync starts with the oldest available messages; repeated runs continue the backlog. A changed UIDVALIDITY restarts discovery; RFC Message-ID (or a content hash when absent) prevents reclassification of already processed messages. Search Days applies to both Gmail and IMAP. Successfully searched UID ranges with no matches are checkpointed, so unchanged large inboxes are not searched repeatedly.

Do not connect the same email address through Gmail OAuth and IMAP simultaneously. JobOps rejects a second active integration with the same address within your private workspace/user scope. Aliases that identify the same mailbox cannot be detected reliably; configure only one integration for them.

### OAuth2

IMAP supports XOAUTH2 with a supplied access token. Token acquisition and renewal are manual; this does not add a Microsoft OAuth registration/consent flow. Outlook.com requires modern authentication; see [Microsoft's IMAP settings](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com?ad=us&rs=en-us&ui=en-us). For managed Gmail authorization and token refresh, use the existing [Gmail OAuth setup](/docs/next/getting-started/gmail-oauth-setup).

## Common problems

- **“This email predates a confirmed application update”:** The email suggests a different stage or outcome from a newer confirmed event. Select **Link only** to attach it without changing the current status. Routine closed-attempt emails link automatically; ambiguous attempt matches and new opportunities need review. Older confirmations of the same current stage and outcome can be approved normally and only link the email.

- **Missing encryption key:** Set a 64-character hexadecimal `EMAIL_CREDENTIALS_KEY`. Changing or losing it makes existing IMAP credentials unreadable. Restore the original key, or disconnect and reconnect accounts.
- **Authentication fails:** Enable IMAP with the provider, check the full username, and use an app password if required. Expired OAuth2 access tokens must be replaced.
- **Certificate fails:** Use the provider's correct hostname and a valid trusted certificate. There is no option to disable validation.
- **Large inbox:** Sync searches only within Search Days (default 90, allowed 1–365), up to Max Messages (default 100, allowed 1–500) per run. IMAP date searches use calendar-day precision. Within that window, the oldest unprocessed messages are handled first. Repeat Sync to process more matching candidates in the window. Changing keyword filters or Search Days restarts the search within that window, while saved messages are deduplicated. Searches use bounded UID ranges so large inboxes do not exceed response limits. Failed searches report an error rather than a successful empty sync.
- **No suggestions:** Configure AI access, check the selected folder, and continue syncing the initial backlog. Keyword presets and custom phrases narrow retrieval before AI classification. Disable keyword filtering to search all wording. The configured AI model interprets application updates in any language, including mixed-language emails; accuracy depends on the model, so review suggestions.
- **Network/rate-limit errors:** Connections retry up to three times with bounded backoff. Automatic sync retries on the next configured interval. Credentials and raw protocol responses are not logged.
- **Large message:** Messages above 5 MiB stop the batch before its checkpoint advances. Select another application folder or address the oversized message in your mail client, then retry. JobOps never modifies it.
- **Multiple server processes:** Run one JobOps server per database. Sync/configuration locks and polling coordination are process-local.

Live synchronization and provider-specific authentication must be verified with your own provider credentials. Automated tests use mocked transport and AI responses.

## Related pages

- [Application attempts and late emails](/docs/next/features/application-attempts)
- [Email search keywords](/docs/next/getting-started/email-search-keywords)

- [Gmail OAuth setup](/docs/next/getting-started/gmail-oauth-setup)
