import { db, schema } from "@server/db";
import {
  type EmailAttemptIdentity,
  findAttemptsByReference,
  findIdentityAttempts,
  getScopedAttempt,
  listApplicationAttempts,
  listSiblingApplicationJobs,
  normalizeApplicationReference,
  rememberAttemptIdentity,
} from "@server/repositories/application-attempts";
import { getJobById } from "@server/repositories/jobs";
import { privateDataScopeFilter } from "@server/tenancy/private-scope";
import type {
  ApplicationAttempt,
  PostApplicationMessage,
  PostApplicationProvider,
  PostApplicationRouterStageTarget,
} from "@shared/types";
import { and, eq } from "drizzle-orm";

export function extractApplicationIdentifiers(
  text: string,
): Pick<EmailAttemptIdentity, "applicationReference" | "requisitionId"> {
  const reference = text.match(
    /(?:application\s*(?:id|number|reference|ref)|bewerbungs(?:nummer|referenz)|application\s*#)\s*[:#=-]?\s*([\p{L}\p{N}][\p{L}\p{N}._/-]{2,79})/iu,
  )?.[1];
  const requisitionId = text.match(
    /(?:requisition\s*(?:id|number)|job\s*(?:id|reference)|stellen(?:nummer|referenz))\s*[:#=-]?\s*([\p{L}\p{N}][\p{L}\p{N}._/-]{2,79})/iu,
  )?.[1];
  return {
    ...(reference
      ? { applicationReference: normalizeApplicationReference(reference) }
      : {}),
    ...(requisitionId
      ? { requisitionId: normalizeApplicationReference(requisitionId) }
      : {}),
  };
}
export function messageIdentity(
  message: PostApplicationMessage,
): EmailAttemptIdentity {
  const raw = message.classificationPayload?.emailIdentity;
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const string = (key: string) =>
    typeof value[key] === "string" && value[key].length <= 500
      ? (value[key] as string)
      : undefined;
  return {
    messageId: string("messageId"),
    threadId: string("threadId"),
    applicationReference: string("applicationReference"),
    requisitionId: string("requisitionId"),
    references: Array.isArray(value.references)
      ? value.references
          .filter((v): v is string => typeof v === "string" && v.length <= 500)
          .slice(-20)
      : [],
  };
}
export function isClosedAttemptOpportunity(
  target: PostApplicationRouterStageTarget,
  payload?: Record<string, unknown> | null,
): boolean {
  return (
    [
      "recruiter_screen",
      "assessment",
      "hiring_manager_screen",
      "technical_interview",
      "onsite",
      "offer",
    ].includes(target) || payload?.reopeningSuggested === true
  );
}
export type AttemptRouting = {
  jobId: string | null;
  attempt: ApplicationAttempt | null;
  confidence: number;
  automaticClosedLink: boolean;
  preserveStatus: boolean;
  reviewReason: string | null;
};
export async function resolveEmailAttempt(args: {
  provider: PostApplicationProvider;
  accountKey: string;
  suggestedJobId: string | null;
  confidence: number;
  receivedAt: number;
  stageTarget: PostApplicationRouterStageTarget;
  identity: EmailAttemptIdentity;
  isRelevant: boolean;
  stageEventPayload?: Record<string, unknown> | null;
}): Promise<AttemptRouting> {
  const fallback: AttemptRouting = {
    jobId: args.suggestedJobId,
    attempt: null,
    confidence: 0,
    automaticClosedLink: false,
    preserveStatus: true,
    reviewReason: "Choose the application attempt before linking this email.",
  };
  const identityMatches = findIdentityAttempts(
    args.provider,
    args.accountKey,
    args.identity,
  );
  const referenceMatches = args.identity.applicationReference
    ? findAttemptsByReference(
        args.provider,
        args.accountKey,
        args.identity.applicationReference,
      )
    : [];
  const matches = [...new Set([...identityMatches, ...referenceMatches])];
  if (matches.length > 1)
    return {
      ...fallback,
      reviewReason:
        "The email references multiple application attempts. Choose the correct attempt.",
    };
  let attempt: ApplicationAttempt | undefined;
  let confidence = 0;
  if (matches.length === 1) {
    const row = getScopedAttempt(matches[0]);
    if (row)
      attempt = listApplicationAttempts(row.jobId).find(
        (candidate) => candidate.id === row.id,
      );
    confidence = 100;
  } else if (args.suggestedJobId && args.confidence >= 50) {
    let candidates = listSiblingApplicationJobs(args.suggestedJobId).flatMap(
      (job) => listApplicationAttempts(job.id),
    );
    if (args.identity.requisitionId) {
      const postingMatches = candidates.filter(
        (candidate) =>
          candidate.requisitionId &&
          normalizeApplicationReference(candidate.requisitionId) ===
            normalizeApplicationReference(args.identity.requisitionId ?? ""),
      );
      if (postingMatches.length) candidates = postingMatches;
    }
    if (candidates.length === 1) {
      attempt = candidates[0];
      confidence = args.confidence;
      // A newly received application reference is evidence of a new attempt,
      // especially when a previous application has already closed.
      if (
        args.identity.applicationReference &&
        attempt.closedAt &&
        !attempt.applicationReference
      )
        return {
          ...fallback,
          reviewReason:
            "A new application reference arrived for a closed application. Choose the previous attempt or start a new one.",
        };
    }
  }
  if (!attempt) return fallback;
  const job = await getJobById(attempt.jobId);
  if (!job) return { ...fallback, jobId: null };
  const confirmedConversation = findIdentityAttempts(
    args.provider,
    args.accountKey,
    { threadId: args.identity.threadId, references: args.identity.references },
  ).includes(attempt.id);
  if (
    args.identity.requisitionId &&
    !attempt.requisitionId &&
    attempt.closedAt &&
    !confirmedConversation
  )
    return {
      ...fallback,
      reviewReason:
        "An unconfirmed posting reference arrived for a closed attempt. Confirm the previous posting or select a new application.",
    };
  if (
    !confirmedConversation &&
    args.suggestedJobId &&
    !listSiblingApplicationJobs(attempt.jobId).some(
      (candidate) => candidate.id === args.suggestedJobId,
    )
  )
    return {
      ...fallback,
      reviewReason:
        "The reference and suggested company or role disagree. Confirm the application attempt.",
    };
  if (
    args.identity.applicationReference &&
    attempt.closedAt &&
    !attempt.applicationReference &&
    !referenceMatches.includes(attempt.id)
  )
    return {
      ...fallback,
      reviewReason:
        "A new application reference arrived for a closed application. Confirm the previous attempt or start a new one.",
    };

  if (
    args.identity.applicationReference &&
    attempt.applicationReference &&
    normalizeApplicationReference(args.identity.applicationReference) !==
      normalizeApplicationReference(attempt.applicationReference) &&
    !referenceMatches.includes(attempt.id)
  ) {
    return {
      ...fallback,
      reviewReason:
        "This application reference differs from the established attempt. Select an attempt or start a new application.",
    };
  }
  if (
    args.identity.requisitionId &&
    attempt.requisitionId &&
    normalizeApplicationReference(args.identity.requisitionId) !==
      normalizeApplicationReference(attempt.requisitionId)
  )
    return {
      ...fallback,
      reviewReason:
        "The posting reference differs from the established attempt.",
    };
  if (confidence < 100 && args.receivedAt < attempt.appliedAt - 86400000)
    return {
      ...fallback,
      reviewReason:
        "This email predates the application attempt. Confirm which attempt it belongs to.",
    };
  if (
    attempt.closedAt &&
    args.stageTarget === "applied" &&
    args.receivedAt > attempt.closedAt &&
    matches.length === 0
  ) {
    return {
      ...fallback,
      reviewReason:
        "A new unthreaded confirmation arrived after closure. Choose the previous attempt or start a new application.",
    };
  }
  const latestEvent = db
    .select()
    .from(schema.stageEvents)
    .where(
      and(
        privateDataScopeFilter(schema.stageEvents),
        eq(schema.stageEvents.applicationAttemptId, attempt.id),
      ),
    )
    .all()
    .filter(
      (event) =>
        (event.metadata as { eventType?: string } | null)?.eventType !== "note",
    )
    .sort((a, b) => b.occurredAt - a.occurredAt)[0];
  const predatesLatest = Boolean(
    latestEvent && args.receivedAt <= latestEvent.occurredAt * 1000,
  );
  const opportunity =
    Boolean(attempt.closedAt) &&
    isClosedAttemptOpportunity(args.stageTarget, args.stageEventPayload);
  return {
    jobId: attempt.jobId,
    attempt,
    confidence,
    automaticClosedLink:
      Boolean(attempt.closedAt) &&
      confidence >= 95 &&
      (confirmedConversation || args.confidence >= 95) &&
      args.isRelevant &&
      !opportunity,
    preserveStatus:
      Boolean(attempt.closedAt) || !attempt.current || predatesLatest,
    reviewReason: opportunity
      ? "New opportunity on a closed application"
      : null,
  };
}
export function bindConfirmedMessage(message: PostApplicationMessage): void {
  if (!message.applicationAttemptId) return;
  rememberAttemptIdentity(
    message.provider,
    message.accountKey,
    message.applicationAttemptId,
    messageIdentity(message),
  );
}
export async function routeExistingPendingMessages(
  provider: PostApplicationProvider,
  accountKey: string,
): Promise<void> {
  // Reconcile old pending rows as well as newly synced mail; no AI calls or status transitions.
  const rows = db
    .select({ id: schema.postApplicationMessages.id })
    .from(schema.postApplicationMessages)
    .where(
      and(
        privateDataScopeFilter(schema.postApplicationMessages),
        eq(schema.postApplicationMessages.provider, provider),
        eq(schema.postApplicationMessages.accountKey, accountKey),
        eq(schema.postApplicationMessages.processingStatus, "pending_user"),
      ),
    )
    .all();
  const { getPostApplicationMessageById } = await import(
    "@server/repositories/post-application-messages"
  );
  for (const row of rows) {
    const message = await getPostApplicationMessageById(row.id);
    if (!message) continue;
    const routing = await resolveEmailAttempt({
      provider,
      accountKey,
      suggestedJobId: message.matchedJobId,
      confidence: message.matchConfidence ?? 0,
      receivedAt: message.receivedAt,
      stageTarget: message.stageTarget ?? "no_change",
      identity: messageIdentity(message),
      isRelevant: message.relevanceDecision === "relevant",
      stageEventPayload: message.stageEventPayload,
    });
    if (!routing.attempt) {
      db.update(schema.postApplicationMessages)
        .set({
          applicationAttemptId: null,
          classificationPayload: {
            ...message.classificationPayload,
            attemptReviewReason: routing.reviewReason,
            attemptMatchConfidence: 0,
          },
        })
        .where(
          and(
            privateDataScopeFilter(schema.postApplicationMessages),
            eq(schema.postApplicationMessages.id, message.id),
            eq(schema.postApplicationMessages.processingStatus, "pending_user"),
          ),
        )
        .run();
      continue;
    }
    db.transaction(() => {
      const result = db
        .update(schema.postApplicationMessages)
        .set({
          applicationAttemptId: routing.attempt?.id,
          matchedJobId: routing.jobId,
          ...(routing.automaticClosedLink
            ? {
                processingStatus: "auto_linked" as const,
                decidedAt: Date.now(),
                decidedBy: "system",
              }
            : {}),
          classificationPayload: {
            ...message.classificationPayload,
            attemptMatchConfidence: routing.confidence,
            attemptSequence: routing.attempt?.sequence ?? null,
            attemptReviewReason: routing.reviewReason,
            linkDecision: routing.automaticClosedLink
              ? "Email linked automatically; application remains closed."
              : null,
          },
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            privateDataScopeFilter(schema.postApplicationMessages),
            eq(schema.postApplicationMessages.id, message.id),
            eq(schema.postApplicationMessages.processingStatus, "pending_user"),
          ),
        )
        .run();
      if (result.changes && routing.automaticClosedLink)
        bindConfirmedMessage({
          ...message,
          applicationAttemptId: routing.attempt?.id,
        });
    });
  }
}
