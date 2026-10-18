---
id: email-search-keywords
title: Email search keywords
description: Filter recruitment emails with English, German, and custom keywords before AI classification.
sidebar_position: 9
---

## What it is

Tracking Inbox can search Gmail and IMAP using English and German keyword presets plus your own words or phrases. The keyword filter runs at the mail provider before messages are sent to AI for classification and job matching.

English and German presets are enabled by default. A message qualifies when **any** enabled keyword matches. Selecting a preset adds words in that language; it does not detect or restrict the email's language. AI classification remains multilingual.

## Why it exists

Newsletters and receipts can consume a sync's message limit and AI tokens before application updates are reached. Keyword searching narrows the candidate messages while allowing you to cover additional languages and unusual recruitment wording.

## How to use it

1. Open **Tracking Inbox** and choose your email account.
2. Under **Email search keywords**, leave **Filter by keywords** enabled.
3. Select **English**, **German**, or both. Expand **View preset keywords** to inspect the terms. You may deselect both if you supply custom keywords.
4. Add **Custom keywords**, one per line or separated by commas. For example:

   ```text
   candidature
   entretien
   sélection
   面接
   ```

   Up to 100 custom keywords are allowed, with 2–100 characters each. Use literal words or phrases, not Gmail search operators, quotes, braces, backslashes, or control characters.
5. Optionally expand **Suggest keywords with AI**, choose or type a language, and select **Suggest keywords**. Only the language name is sent to your configured AI provider; emails, profiles, and jobs are not sent for suggestions. This action uses AI tokens and, in hosted mode, one tailoring usage unit.
6. Review the suggestions, select **Add to custom keywords**, then edit the list if necessary. Suggestions are not saved automatically.
7. Select **Save filters**. Saved settings apply to all your email accounts and scheduled IMAP syncs within your current workspace/user scope. A sync already running keeps its original filter.
8. Set **Search Days** (default 90, range 1–365) and **Max Messages** (default 100, range 1–500), then select **Sync**. For IMAP, the last successful manual limits are saved per account and reused by Settings' **Sync Now** and scheduled syncs; initial defaults are 90 days and 100 messages. Max Messages caps matching candidates processed per run; saved duplicates can also count toward that cap.

When filtering is enabled, Gmail searches message text using literal phrases and also retains recruitment-sender, interview-scheduling, and recruitment-subject discovery signals (for example `talent@`, Calendly, and “book a time”). Those signals can retrieve mail without a selected keyword. Disabling filtering removes all keyword and discovery restrictions. IMAP uses the server's `TEXT` search over message headers and body. Matching details, accents, and word boundaries depend on the mail provider. IMAP searches the configured folder only. Within the date window IMAP processes matching UIDs oldest first. Each IMAP filter/date-window configuration keeps its own cursor (up to 20 recent configurations). A new configuration starts discovery; returning to a saved one resumes it. Saved messages are deduplicated and not reclassified.

To retrieve all messages in the date window regardless of language or wording, turn **Filter by keywords** off and save. Your preset selections and custom keywords are retained.

## Common problems

- **Missing rejection:** Its wording may not contain an enabled keyword. Add a phrase from the message, select another preset, or disable filtering and sync again. Check the configured IMAP folder and date window too.
- **AI suggestion is wrong or too broad:** Edit or remove it before saving. Suggestions are search hints, not proof that an email is relevant. Broad terms can retrieve unrelated mail.
- **No keyword selected:** An enabled filter requires at least one preset or custom keyword. Disable filtering to search without keywords.
- **Non-Latin searches fail:** The IMAP provider must support searching the requested character set. A failed search is reported as a sync error rather than a successful empty result.
- **Old ignored message stays ignored:** Saved messages are deduplicated and retain their prior classification; changing keywords does not reclassify them.
- **Not all updates appear in one run:** Increase Max Messages within its allowed range, narrow Search Days, or sync again. Application classification uses your configured AI model and needs review.

## Related pages

- [IMAP email accounts](/docs/next/getting-started/imap-email-setup)
- [Gmail OAuth setup](/docs/next/getting-started/gmail-oauth-setup)
