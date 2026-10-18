import {
  AppError,
  conflict,
  notFound,
  unprocessableEntity,
} from "@infra/errors";
import { trackServerProductEvent } from "@infra/product-analytics";
import { db, schema } from "@server/db";
import {
  createApplicationAttempt,
  getScopedAttempt,
  listApplicationAttempts,
} from "@server/repositories/application-attempts";
import { getJobById, listJobSummariesByIds } from "@server/repositories/jobs";
import {
  getPostApplicationMessageById,
  listPostApplicationMessagesByProcessingStatus,
  listPostApplicationMessagesBySyncRun,
} from "@server/repositories/post-application-messages";
import {
  getPostApplicationSyncRunById,
  listPostApplicationSyncRuns,
} from "@server/repositories/post-application-sync-runs";
import { transitionStage } from "@server/services/applicationTracking";
import {
  resolveStageTransitionForTarget,
  stageTargetFromMessageType,
} from "@server/services/post-application/stage-target";
import { privateDataScopeFilter } from "@server/tenancy/private-scope";
import type {
  ApplicationStage,
  PostApplicationActionRequest,
  PostApplicationActionResponse,
  PostApplicationActionResult,
  PostApplicationInboxItem,
  PostApplicationMessage,
  PostApplicationProvider,
  PostApplicationRouterStageTarget,
  PostApplicationSyncRun,
} from "@shared/types";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  bindConfirmedMessage,
  isClosedAttemptOpportunity,
  messageIdentity,
  routeExistingPendingMessages,
} from "../attempt-routing";

const { postApplicationMessages, postApplicationSyncRuns } = schema;

function messagesScopeFilter() {
  return privateDataScopeFilter(postApplicationMessages);
}

function syncRunsScopeFilter() {
  return privateDataScopeFilter(postApplicationSyncRuns);
}

function buildMatchedJobMap(
  items: PostApplicationMessage[],
  jobs: Awaited<ReturnType<typeof listJobSummariesByIds>>,
): PostApplicationInboxItem[] {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  return items.map((message) => ({
    message,
    reopeningEligible: isClosedAttemptOpportunity(
      message.stageTarget ?? stageTargetFromMessageType(message.messageType),
      message.stageEventPayload,
    ),
    attempts: message.matchedJobId
      ? listApplicationAttempts(message.matchedJobId)
      : [],
    matchedJob: message.matchedJobId
      ? (jobById.get(message.matchedJobId) ?? null)
      : null,
  }));
}

export async function listPostApplicationInbox(args: {
  provider: PostApplicationProvider;
  accountKey: string;
  limit?: number;
}): Promise<PostApplicationInboxItem[]> {
  await routeExistingPendingMessages(args.provider, args.accountKey);
  const limit = args.limit ?? 50;
  const messages = await listPostApplicationMessagesByProcessingStatus(
    args.provider,
    args.accountKey,
    "pending_user",
    limit,
  );

  const jobIds = Array.from(
    new Set(messages.map((message) => message.matchedJobId).filter(Boolean)),
  ) as string[];
  const jobs = await listJobSummariesByIds(jobIds);
  return buildMatchedJobMap(messages, jobs);
}

export async function approvePostApplicationInboxItem(args: {
  messageId: string;
  provider: PostApplicationProvider;
  accountKey: string;
  jobId?: string;
  applicationAttemptId?: string;
  newAttempt?: boolean;
  reopen?: boolean;
  appliedAt?: number;
  stageTarget?: PostApplicationRouterStageTarget;
  toStage?: ApplicationStage;
  note?: string;
  decidedBy?: string | null;
}): Promise<{ message: PostApplicationMessage; stageEventId: string | null }> {
  const message = await getPostApplicationMessageById(args.messageId);
  if (!message) {
    throw notFound(`Post-application message '${args.messageId}' not found.`);
  }
  if (
    message.provider !== args.provider ||
    message.accountKey !== args.accountKey
  ) {
    throw notFound(`Post-application message '${args.messageId}' not found.`);
  }
  if (message.processingStatus !== "pending_user") {
    throw conflict(
      `Message '${args.messageId}' is already decided with status '${message.processingStatus}'.`,
    );
  }

  if (message.errorCode === "IMAP_MESSAGE_TOO_LARGE")
    throw conflict(
      "This email was not downloaded. Review it in your mail client, then skip it here.",
    );
  if (
    message.classificationPayload?.explicitSelectionRequired === true &&
    !args.applicationAttemptId &&
    !args.newAttempt
  )
    throw conflict(
      "Choose the correct application attempt explicitly before approving this email.",
    );

  const resolvedJobId = args.jobId ?? message.matchedJobId;
  if (!resolvedJobId) {
    throw unprocessableEntity(
      "Approval requires a resolved jobId from payload or message suggestion.",
    );
  }

  const targetJob = await getJobById(resolvedJobId);
  if (!targetJob) {
    throw notFound(`Job '${resolvedJobId}' not found.`);
  }

  const decidedAt = Date.now();
  const updated = db.transaction((tx) => {
    let stageEventId: string | null = null;
    const decidedAtIso = new Date(decidedAt).toISOString();

    let selectedAttempt =
      args.applicationAttemptId ?? message.applicationAttemptId;
    const attempts = listApplicationAttempts(resolvedJobId);
    if (args.newAttempt) {
      const identity = messageIdentity(message);
      const created = createApplicationAttempt(resolvedJobId, {
        appliedAt: args.appliedAt ?? Date.now(),
        applicationReference: identity.applicationReference,
        requisitionId: identity.requisitionId,
      });
      selectedAttempt = created.id;
      tx.update(schema.jobs)
        .set({
          outcome: null,
          closedAt: null,
          appliedAt: new Date(created.appliedAt).toISOString(),
        })
        .where(
          and(
            privateDataScopeFilter(schema.jobs),
            eq(schema.jobs.id, resolvedJobId),
          ),
        )
        .run();
      transitionStage(
        resolvedJobId,
        "applied",
        Math.floor(created.appliedAt / 1000),
        {
          actor: "user",
          eventType: "status_update",
          eventLabel: `Application attempt ${created.sequence} started`,
        },
      );
    } else if (!selectedAttempt) {
      if (attempts.length !== 1)
        throw conflict(
          "Select the previous or current application attempt before approving this email.",
        );
      selectedAttempt = attempts[0].id;
    }
    if (!selectedAttempt) throw notFound("Application attempt not found.");
    const attemptRow = getScopedAttempt(selectedAttempt);
    if (!attemptRow || attemptRow.jobId !== resolvedJobId)
      throw notFound("Application attempt not found for this job.");
    const selected = listApplicationAttempts(resolvedJobId).find(
      (item) => item.id === selectedAttempt,
    );
    if (!selected) throw notFound("Application attempt not found.");
    if (args.reopen && (!selected.current || !selected.closedAt))
      throw conflict(
        "Only the current closed application attempt can be reopened. Link older attempts without changing status.",
      );

    const messageUpdateResult = tx
      .update(postApplicationMessages)
      .set({
        processingStatus: "manual_linked",
        matchedJobId: resolvedJobId,
        applicationAttemptId: selectedAttempt,
        classificationPayload: {
          ...message.classificationPayload,
          attemptSequence: selected.sequence,
          attemptReviewReason: null,
          linkDecision:
            selected.closedAt && !args.reopen
              ? "Email linked; application remains closed."
              : null,
        },
        decidedAt,
        decidedBy: args.decidedBy ?? null,
        updatedAt: decidedAtIso,
      })
      .where(
        and(
          messagesScopeFilter(),
          eq(postApplicationMessages.id, message.id),
          eq(postApplicationMessages.processingStatus, "pending_user"),
        ),
      )
      .run();
    if (messageUpdateResult.changes === 0) {
      throw conflict(
        `Message '${message.id}' was already decided by another request.`,
      );
    }

    const resolvedTarget =
      args.stageTarget ??
      (args.toStage as PostApplicationRouterStageTarget | undefined) ??
      message.stageTarget ??
      stageTargetFromMessageType(message.messageType);
    const transition = resolveStageTransitionForTarget(resolvedTarget);
    if (
      args.reopen &&
      !isClosedAttemptOpportunity(resolvedTarget, message.stageEventPayload)
    )
      throw conflict(
        "Reopening requires an invitation, offer, or explicit request to resume the application.",
      );

    let shouldTransition =
      transition.toStage !== "no_change" &&
      selected.current &&
      !selected.closedAt;
    if (args.newAttempt && transition.toStage === "applied")
      shouldTransition = false;
    if (args.reopen) {
      tx.update(schema.jobs)
        .set({ outcome: null, closedAt: null })
        .where(
          and(
            privateDataScopeFilter(schema.jobs),
            eq(schema.jobs.id, resolvedJobId),
          ),
        )
        .run();
      shouldTransition = true;
    }
    // Old active-attempt messages link without rewriting a newer confirmed stage.
    const latest = tx
      .select()
      .from(schema.stageEvents)
      .where(
        and(
          privateDataScopeFilter(schema.stageEvents),
          eq(schema.stageEvents.applicationAttemptId, selectedAttempt),
        ),
      )
      .orderBy(desc(schema.stageEvents.occurredAt))
      .all()
      .find(
        (event) =>
          (event.metadata as { eventType?: string } | null)?.eventType !==
          "note",
      );
    if (
      !args.reopen &&
      !args.newAttempt &&
      latest &&
      latest.occurredAt * 1000 >= message.receivedAt
    ) {
      if (
        shouldTransition &&
        (latest.toStage !== transition.toStage ||
          (targetJob.outcome ?? null) !== transition.outcome)
      )
        throw conflict(
          "This email predates a confirmed application update. Use Link only to preserve the current stage.",
        );
      shouldTransition = false;
    }
    bindConfirmedMessage({
      ...message,
      matchedJobId: resolvedJobId,
      applicationAttemptId: selectedAttempt,
    });

    if (shouldTransition) {
      const event = transitionStage(
        resolvedJobId,
        args.reopen && transition.toStage === "no_change"
          ? "recruiter_screen"
          : transition.toStage,
        Math.floor(
          args.reopen || args.newAttempt
            ? Date.now() / 1000
            : Number.isFinite(message.receivedAt)
              ? message.receivedAt / 1000
              : decidedAt / 1000,
        ),
        {
          actor: "user",
          eventType: "status_update",
          eventLabel: args.reopen
            ? "Reopened from email"
            : `Post-application: ${resolvedTarget}`,
          note: args.note ?? null,
          reasonCode: transition.reasonCode ?? "post_application_manual_linked",
        },
        transition.outcome,
      );
      stageEventId = event.id;
    }

    if (message.syncRunId) {
      tx.update(postApplicationSyncRuns)
        .set({
          messagesApproved: sql`${postApplicationSyncRuns.messagesApproved} + 1`,
          updatedAt: decidedAtIso,
        })
        .where(
          and(
            syncRunsScopeFilter(),
            eq(postApplicationSyncRuns.id, message.syncRunId),
          ),
        )
        .run();
    }

    return { stageEventId, resolvedTarget };
  });

  const updatedMessage = await getPostApplicationMessageById(message.id);

  if (!updatedMessage) {
    throw notFound(
      `Post-application message '${message.id}' not found after approval.`,
    );
  }

  void trackServerProductEvent(
    "tracking_email_matched",
    {
      provider: args.provider,
      match_mode: "manual_review",
      stage_target: updated.resolvedTarget,
      result: "success",
    },
    { urlPath: "/tracking-inbox" },
  );

  return { message: updatedMessage, stageEventId: updated.stageEventId };
}

export async function denyPostApplicationInboxItem(args: {
  messageId: string;
  provider: PostApplicationProvider;
  accountKey: string;
  decidedBy?: string | null;
}): Promise<{ message: PostApplicationMessage }> {
  const message = await getPostApplicationMessageById(args.messageId);
  if (!message) {
    throw notFound(`Post-application message '${args.messageId}' not found.`);
  }
  if (
    message.provider !== args.provider ||
    message.accountKey !== args.accountKey
  ) {
    throw notFound(`Post-application message '${args.messageId}' not found.`);
  }
  if (message.processingStatus !== "pending_user") {
    throw conflict(
      `Message '${args.messageId}' is already decided with status '${message.processingStatus}'.`,
    );
  }

  const decidedAt = Date.now();
  db.transaction((tx) => {
    const decidedAtIso = new Date(decidedAt).toISOString();
    const messageUpdateResult = tx
      .update(postApplicationMessages)
      .set({
        processingStatus: "ignored",
        matchedJobId: null,
        applicationAttemptId: null,
        decidedAt,
        decidedBy: args.decidedBy ?? null,
        updatedAt: decidedAtIso,
      })
      .where(
        and(
          messagesScopeFilter(),
          eq(postApplicationMessages.id, message.id),
          eq(postApplicationMessages.processingStatus, "pending_user"),
        ),
      )
      .run();
    if (messageUpdateResult.changes === 0) {
      throw conflict(
        `Message '${message.id}' was already decided by another request.`,
      );
    }

    if (message.syncRunId) {
      tx.update(postApplicationSyncRuns)
        .set({
          messagesDenied: sql`${postApplicationSyncRuns.messagesDenied} + 1`,
          updatedAt: decidedAtIso,
        })
        .where(
          and(
            syncRunsScopeFilter(),
            eq(postApplicationSyncRuns.id, message.syncRunId),
          ),
        )
        .run();
    }
  });

  const updatedMessage = await getPostApplicationMessageById(message.id);
  if (!updatedMessage) {
    throw notFound(
      `Post-application message '${message.id}' not found after denial.`,
    );
  }

  return { message: updatedMessage };
}

export async function runPostApplicationInboxAction(
  args: PostApplicationActionRequest & { decidedBy?: string | null },
): Promise<PostApplicationActionResponse> {
  const { provider, accountKey, action, decidedBy } = args;

  const pendingItems = await listPostApplicationInbox({
    provider,
    accountKey,
    limit: 1000,
  });

  const results: PostApplicationActionResult[] = [];
  let skipped = 0;
  let failed = 0;

  for (const item of pendingItems) {
    const { message, matchedJob } = item;

    if (action === "approve") {
      if (!matchedJob) {
        skipped++;
        results.push({
          messageId: message.id,
          ok: false,
          error: {
            code: "NO_SUGGESTED_MATCH",
            message: "Message has no suggested job match",
          },
        });
        continue;
      }
      if (
        message.errorCode === "IMAP_MESSAGE_TOO_LARGE" ||
        message.classificationPayload?.explicitSelectionRequired === true ||
        (!message.applicationAttemptId && (item.attempts?.length ?? 0) > 1)
      ) {
        skipped++;
        results.push({
          messageId: message.id,
          ok: false,
          error: {
            code: "ATTEMPT_REQUIRED",
            message: "Choose the correct application attempt individually.",
          },
        });
        continue;
      }

      try {
        const result = await approvePostApplicationInboxItem({
          messageId: message.id,
          provider,
          accountKey,
          jobId: matchedJob.id,
          decidedBy,
        });
        results.push({
          messageId: message.id,
          ok: true,
          message: result.message,
          stageEventId: result.stageEventId,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "CONFLICT") {
          skipped++;
          results.push({
            messageId: message.id,
            ok: false,
            error: {
              code: "ALREADY_DECIDED",
              message: error.message,
            },
          });
          continue;
        }
        failed++;
        results.push({
          messageId: message.id,
          ok: false,
          error: {
            code: "APPROVE_FAILED",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        });
      }
    } else {
      try {
        const result = await denyPostApplicationInboxItem({
          messageId: message.id,
          provider,
          accountKey,
          decidedBy,
        });
        results.push({
          messageId: message.id,
          ok: true,
          message: result.message,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "CONFLICT") {
          skipped++;
          results.push({
            messageId: message.id,
            ok: false,
            error: {
              code: "ALREADY_DECIDED",
              message: error.message,
            },
          });
          continue;
        }
        failed++;
        results.push({
          messageId: message.id,
          ok: false,
          error: {
            code: "DENY_FAILED",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        });
      }
    }
  }

  const succeeded = results.filter((r) => r.ok).length;

  return {
    action,
    requested: pendingItems.length,
    succeeded,
    failed,
    skipped,
    results,
  };
}

export async function listPostApplicationReviewRuns(args: {
  provider: PostApplicationProvider;
  accountKey: string;
  limit?: number;
}): Promise<PostApplicationSyncRun[]> {
  return listPostApplicationSyncRuns(
    args.provider,
    args.accountKey,
    args.limit ?? 20,
  );
}

export async function listPostApplicationRunMessages(args: {
  provider: PostApplicationProvider;
  accountKey: string;
  runId: string;
  limit?: number;
}): Promise<{
  run: PostApplicationSyncRun;
  items: PostApplicationInboxItem[];
}> {
  const run = await getPostApplicationSyncRunById(args.runId);
  if (
    !run ||
    run.provider !== args.provider ||
    run.accountKey !== args.accountKey
  ) {
    throw notFound(`Post-application sync run '${args.runId}' not found.`);
  }

  const messages = await listPostApplicationMessagesBySyncRun(
    args.provider,
    args.accountKey,
    args.runId,
    args.limit ?? 300,
  );

  const jobIds = Array.from(
    new Set(messages.map((message) => message.matchedJobId).filter(Boolean)),
  ) as string[];
  const jobs = await listJobSummariesByIds(jobIds);

  return { run, items: buildMatchedJobMap(messages, jobs) };
}
