import { createHash } from "node:crypto";
import { conflict } from "@infra/errors";
import { logger } from "@infra/logger";
import { getAllJobs } from "@server/repositories/jobs";
import {
  getPostApplicationIntegration,
  updatePostApplicationIntegrationSyncState,
} from "@server/repositories/post-application-integrations";
import {
  getPostApplicationMessageByExternalId,
  upsertPostApplicationMessage,
} from "@server/repositories/post-application-messages";
import {
  completePostApplicationSyncRun,
  startPostApplicationSyncRun,
} from "@server/repositories/post-application-sync-runs";
import { getPrivateDataScope } from "@server/tenancy/private-scope";
import { resolveEmailKeywords } from "@shared/email-keywords";
import { convert } from "html-to-text";
import { simpleParser } from "mailparser";
import {
  bindConfirmedMessage,
  extractApplicationIdentifiers,
  resolveEmailAttempt,
  routeExistingPendingMessages,
} from "../attempt-routing";
import { providerUpstreamError } from "../providers/errors";
import {
  imapEndpointIdentity,
  parseImapConfig,
} from "../providers/imap-credentials";
import { getEmailKeywordFilter } from "./email-keywords";
import { classifyWithSmartRouter, minifyActiveJobs } from "./email-router";
import { withImapConnection } from "./imap-client";

// Locks contain identities only and include tenant + hosted user scope.
const syncing = new Set<string>();
export async function withImapAccountLock<T>(
  accountKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([getPrivateDataScope().scopeKey, accountKey]);
  if (syncing.has(key))
    throw conflict("An IMAP operation is already running for this account.");
  syncing.add(key);
  try {
    return await operation();
  } finally {
    syncing.delete(key);
  }
}
export function imapMessageIdentity(
  mailbox: string,
  validity: string,
  uid: number,
  messageId?: string,
  source?: Buffer,
): string {
  // RFC Message-ID survives moves and UIDVALIDITY resets. UIDs are fallback only.
  return createHash("sha256")
    .update(
      messageId?.trim() || source || JSON.stringify([mailbox, validity, uid]),
    )
    .digest("hex");
}
export async function runImapSync(
  accountKey: string,
  requestedMaxMessages?: number,
  requestedSearchDays?: number,
): Promise<number> {
  return withImapAccountLock(accountKey, async () => {
    const integration = await getPostApplicationIntegration("imap", accountKey);
    const config = parseImapConfig(integration?.credentials);
    const maxMessages = Math.min(
      500,
      Math.max(1, requestedMaxMessages ?? config.syncMaxMessages ?? 100),
    );
    const searchDays = Math.min(
      365,
      Math.max(1, requestedSearchDays ?? config.syncSearchDays ?? 90),
    );
    const keywords = resolveEmailKeywords(await getEmailKeywordFilter());
    const filterFingerprint = createHash("sha256")
      .update(JSON.stringify(keywords.slice().sort()))
      .digest("hex");
    if (!integration || integration.status === "disconnected")
      throw new Error("IMAP account is disconnected.");
    const run = await startPostApplicationSyncRun({
      provider: "imap",
      accountKey,
      integrationId: integration.id,
    });
    let processed = 0;
    let relevant = 0;
    let classified = 0;
    let matched = 0;
    try {
      const jobs = minifyActiveJobs(
        await getAllJobs(["applied", "in_progress", "processing"]),
      );
      await withImapConnection(config, async (client) => {
        const mailbox = await client.mailboxOpen(config.mailbox, {
          readOnly: true,
        });
        const validity = String(mailbox.uidValidity);
        // Retain the pre-upgrade cursor when the first new search uses a
        // different window, rather than forcing a duplicate historical scan.
        if (
          !config.searchCheckpoints &&
          config.keywordFilterFingerprint &&
          config.uidValidity &&
          config.syncSearchDays !== undefined
        ) {
          config.searchCheckpoints = [
            {
              fingerprint: config.keywordFilterFingerprint,
              searchDays: config.syncSearchDays,
              uidValidity: config.uidValidity,
              lastUid: config.lastUid ?? 0,
            },
          ];
        }
        const savedCheckpoint = config.searchCheckpoints?.find(
          (checkpoint) =>
            checkpoint.fingerprint === filterFingerprint &&
            checkpoint.searchDays === searchDays &&
            checkpoint.uidValidity === validity,
        );
        let lastUid =
          savedCheckpoint?.lastUid ??
          (config.uidValidity === validity &&
          config.keywordFilterFingerprint === filterFingerprint &&
          config.syncSearchDays === searchDays
            ? (config.lastUid ?? 0)
            : 0);

        // Bound SEARCH responses for large mailboxes; an unbounded UID list can
        // exceed transport limits. A failed SEARCH must never mean an empty inbox.
        const limit = Math.min(500, Math.max(1, maxMessages));
        const since = new Date(
          Date.now() - Math.min(365, Math.max(1, searchDays)) * 86_400_000,
        );
        const saveCheckpoint = async (uid: number) => {
          config.lastUid = uid;
          config.uidValidity = validity;
          config.keywordFilterFingerprint = filterFingerprint;
          config.syncSearchDays = searchDays;
          config.syncMaxMessages = maxMessages;
          config.searchCheckpoints = [
            ...(config.searchCheckpoints ?? []).filter(
              (checkpoint) =>
                !(
                  checkpoint.fingerprint === filterFingerprint &&
                  checkpoint.searchDays === searchDays
                ),
            ),
            {
              fingerprint: filterFingerprint,
              searchDays,
              uidValidity: validity,
              lastUid: uid,
            },
          ].slice(-20);
          await updatePostApplicationIntegrationSyncState({
            provider: "imap",
            accountKey,
            credentials: config,
          });
          lastUid = uid;
        };
        if (lastUid >= mailbox.uidNext - 1) {
          await saveCheckpoint(lastUid);
          return;
        }
        const uids: number[] = [];
        let searchedThroughUid = lastUid;
        for (
          let start = lastUid + 1;
          start < mailbox.uidNext && uids.length < limit;
          start += 500
        ) {
          const end = Math.min(start + 499, mailbox.uidNext - 1);
          const found = await client.search(
            {
              uid: `${start}:${end}`,
              since,
              ...(keywords.length
                ? { or: keywords.map((text) => ({ text })) }
                : {}),
            },
            { uid: true },
          );
          if (!found) throw new Error("IMAP search failed.");
          const matches = found
            .filter((uid) => uid >= start && uid <= end)
            .sort((a, b) => a - b);
          const selected = matches.slice(0, limit - uids.length);
          uids.push(...selected);
          // Only advance past a range when every matching UID was selected.
          // When the cap splits a range, preserve its unprocessed candidates.
          searchedThroughUid =
            selected.length < matches.length
              ? selected[selected.length - 1]
              : end;
        }
        for (const uid of uids) {
          const metadata = await client.fetchOne(
            uid,
            { size: true, envelope: true, internalDate: true },
            { uid: true },
          );
          // Quarantine metadata only; never download an oversized source. Persist
          // before advancing so later emails can proceed without hiding failure.
          if (metadata && (metadata.size ?? 0) > 5 * 1024 * 1024) {
            await upsertPostApplicationMessage({
              provider: "imap",
              accountKey,
              integrationId: integration.id,
              syncRunId: run.id,
              externalMessageId: metadata.envelope?.messageId?.trim()
                ? `oversized:${imapMessageIdentity(config.mailbox, validity, uid, metadata.envelope.messageId)}`
                : `oversized-endpoint:${createHash("sha256")
                    .update(
                      JSON.stringify([
                        imapEndpointIdentity(config),
                        validity,
                        uid,
                      ]),
                    )
                    .digest("hex")}`,
              previousExternalMessageId:
                config.legacyNoticePromotionAllowed !== false
                  ? `oversized:${imapMessageIdentity(config.mailbox, validity, uid)}`
                  : undefined,
              fromAddress: metadata.envelope?.from?.[0]?.address ?? "",
              subject:
                metadata.envelope?.subject ??
                `Email exceeds size limit (UID ${uid})`,
              receivedAt:
                metadata.internalDate instanceof Date
                  ? metadata.internalDate.getTime()
                  : Date.now(),
              snippet: "",
              relevanceDecision: "needs_llm",
              messageType: "other",
              processingStatus: "pending_user",
              errorCode: "IMAP_MESSAGE_TOO_LARGE",
              errorMessage:
                "Email exceeds the 5 MiB download limit. Review it in your mail client, then choose Skip email. Later emails continue syncing.",
              classificationPayload: {
                mailbox: config.mailbox,
                uidValidity: validity,
                uid,
                size: metadata.size,
              },
            });
            processed++;
            await saveCheckpoint(uid);
            continue;
          }
          const fetched = await client.fetchOne(
            uid,
            { source: true, internalDate: true },
            { uid: true },
          );
          if (!fetched || !fetched.source) continue; // deleted between SEARCH and FETCH
          const mail = await simpleParser(fetched.source, {
            skipHtmlToText: true,
            skipTextToHtml: true,
            skipImageLinks: true,
          });
          const externalMessageId = imapMessageIdentity(
            config.mailbox,
            validity,
            uid,
            mail.messageId,
            fetched.source,
          );
          const existing = await getPostApplicationMessageByExternalId(
            "imap",
            accountKey,
            externalMessageId,
          );
          if (!existing) {
            const body = (
              mail.text ||
              convert(mail.html || "", {
                selectors: [
                  { selector: "script", format: "skip" },
                  { selector: "style", format: "skip" },
                ],
              })
            ).slice(0, 12000);
            const from = mail.from?.value[0];
            const fromAddress = (from?.address || "").toLowerCase();
            const referenced =
              typeof mail.inReplyTo === "string"
                ? await getPostApplicationMessageByExternalId(
                    "imap",
                    accountKey,
                    imapMessageIdentity(
                      config.mailbox,
                      validity,
                      uid,
                      mail.inReplyTo,
                    ),
                  )
                : null;
            const referencedJob = jobs.find(
              (job) => job.id === referenced?.matchedJobId,
            );
            const referenceHint = referencedJob
              ? `Prior message in this thread was linked to ${referencedJob.company}: ${referencedJob.title}. Verify this match independently.\n`
              : "";
            const result = await classifyWithSmartRouter({
              emailText: `${referenceHint}From: ${fromAddress}\nSubject: ${mail.subject || ""}\n\n${body}`,
              activeJobs: jobs,
            });
            const matchedJobId = jobs.some(
              (job) => job.id === result.bestMatchId,
            )
              ? result.bestMatchId
              : null;
            const references = [
              ...(Array.isArray(mail.references)
                ? mail.references
                : mail.references
                  ? [mail.references]
                  : []),
              ...(mail.inReplyTo ? [mail.inReplyTo] : []),
            ].slice(-20);
            const emailIdentity = {
              messageId: mail.messageId,
              threadId: references[0] || mail.messageId,
              references,
              ...extractApplicationIdentifiers(
                `${mail.subject || ""}\n${body}`,
              ),
            };
            const routing = await resolveEmailAttempt({
              provider: "imap",
              accountKey,
              suggestedJobId: matchedJobId,
              confidence: result.confidence,
              receivedAt:
                fetched.internalDate instanceof Date
                  ? fetched.internalDate.getTime()
                  : mail.date?.getTime() || Date.now(),
              stageTarget: result.stageTarget,
              identity: emailIdentity,
              isRelevant: result.isRelevant,
              stageEventPayload: result.stageEventPayload,
            });
            const { message: savedMessage } =
              await upsertPostApplicationMessage({
                applicationAttemptId: routing.attempt?.id ?? null,
                decidedAt: routing.automaticClosedLink ? Date.now() : null,
                decidedBy: routing.automaticClosedLink ? "system" : null,
                provider: "imap",
                accountKey,
                integrationId: integration.id,
                syncRunId: run.id,
                externalMessageId,
                externalThreadId:
                  typeof mail.inReplyTo === "string" ? mail.inReplyTo : null,
                fromAddress,
                fromDomain: fromAddress.split("@")[1] || null,
                senderName: from?.name || null,
                subject: (mail.subject || "").slice(0, 1000),
                receivedAt:
                  fetched.internalDate instanceof Date
                    ? fetched.internalDate.getTime()
                    : mail.date?.getTime() || Date.now(),
                snippet: body.slice(0, 2000),
                classificationLabel: result.stageTarget,
                classificationConfidence: result.confidence / 100,
                classificationPayload: {
                  method: "smart_router",
                  emailIdentity,
                  attemptMatchConfidence: routing.confidence,
                  attemptSequence: routing.attempt?.sequence ?? null,
                  attemptReviewReason: routing.reviewReason,
                  explicitSelectionRequired: !routing.attempt,
                  linkDecision: routing.automaticClosedLink
                    ? "Email linked automatically; application remains closed."
                    : null,
                  mailbox: config.mailbox,
                  uidValidity: validity,
                  uid,
                  reason: result.reason.slice(0, 1000),
                },
                relevanceLlmScore: result.confidence,
                relevanceDecision: result.isRelevant
                  ? "relevant"
                  : "not_relevant",
                matchedJobId: routing.jobId,
                matchConfidence: result.confidence,
                stageTarget: result.stageTarget,
                messageType: result.messageType,
                stageEventPayload: result.stageEventPayload,
                // Explicit review protects newer confirmed statuses even for high-confidence matches.
                processingStatus: routing.automaticClosedLink
                  ? "auto_linked"
                  : result.isRelevant || matchedJobId
                    ? "pending_user"
                    : "ignored",
              });
            if (routing.automaticClosedLink) bindConfirmedMessage(savedMessage);
            classified++;
            if (matchedJobId) matched++;
            if (result.isRelevant) relevant++;
          }
          processed++;
          await saveCheckpoint(uid);
        }
        // Persist successfully scanned empty/nonmatching ranges as well. Do this
        // only after all selected messages succeed, so failures cannot skip mail.
        if (searchedThroughUid > lastUid)
          await saveCheckpoint(searchedThroughUid);
      });
      await routeExistingPendingMessages("imap", accountKey);
      await completePostApplicationSyncRun({
        id: run.id,
        status: "completed",
        messagesDiscovered: processed,
        messagesClassified: classified,
        messagesMatched: matched,
        messagesRelevant: relevant,
        messagesErrored: 0,
      });
      await updatePostApplicationIntegrationSyncState({
        provider: "imap",
        accountKey,
        lastSyncedAt: Date.now(),
        lastError: null,
        status: "connected",
      });
      logger.info("IMAP sync completed", {
        provider: "imap",
        accountKey,
        syncRunId: run.id,
        processed,
        relevant,
      });
      return processed;
    } catch {
      const message =
        "IMAP sync failed. Verify connection settings and AI configuration, then retry. Successfully processed messages will not be repeated.";
      await completePostApplicationSyncRun({
        id: run.id,
        status: "failed",
        messagesDiscovered: processed,
        messagesRelevant: relevant,
        messagesClassified: classified,
        messagesMatched: matched,
        messagesErrored: 1,
        errorCode: "IMAP_SYNC_FAILED",
        errorMessage: message,
      });
      // Keep connected so automatic polling retries after the configured interval.
      await updatePostApplicationIntegrationSyncState({
        provider: "imap",
        accountKey,
        lastError: message,
        lastSyncedAt: Date.now(),
      });
      throw providerUpstreamError(message);
    }
  });
}
