import { createHash, randomUUID } from "node:crypto";
import { conflict, notFound } from "@infra/errors";
import { db, schema } from "@server/db";
import { privateDataScopeFilter } from "@server/tenancy/private-scope";
import type {
  ApplicationAttempt,
  PostApplicationProvider,
} from "@shared/types";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

const {
  applicationAttempts: attempts,
  applicationEmailIdentities: identities,
  jobs,
  stageEvents,
  postApplicationMessages: messages,
} = schema;
export type EmailAttemptIdentity = {
  messageId?: string;
  threadId?: string;
  references?: string[];
  applicationReference?: string;
  requisitionId?: string;
};
const hash = (value: string) =>
  createHash("sha256").update(value.trim()).digest("hex");
export function normalizeApplicationReference(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .toUpperCase();
}
export function getScopedAttempt(id: string) {
  return db
    .select()
    .from(attempts)
    .where(and(privateDataScopeFilter(attempts), eq(attempts.id, id)))
    .get();
}
export function ensureInitialApplicationAttempt(
  jobId: string,
  startedAt?: number,
): string {
  const job = db
    .select()
    .from(jobs)
    .where(and(privateDataScopeFilter(jobs), eq(jobs.id, jobId)))
    .get();
  if (!job) throw notFound("Application not found.");
  const latest = db
    .select()
    .from(attempts)
    .where(and(privateDataScopeFilter(attempts), eq(attempts.jobId, jobId)))
    .orderBy(desc(attempts.sequence))
    .get();
  if (latest) return latest.id;
  const id = `initial:${jobId}`;
  const date = Date.parse(job.appliedAt || job.discoveredAt);
  db.insert(attempts)
    .values({
      id,
      jobId,
      tenantId: job.tenantId,
      userId: job.userId,
      sequence: 1,
      appliedAt:
        job.appliedAt && Number.isFinite(date)
          ? date
          : (startedAt ?? (Number.isFinite(date) ? date : Date.now())),
      requisitionId: job.sourceJobId,
      stageSnapshot: job.closedAt !== null ? "closed" : "applied",
      outcomeSnapshot: job.outcome,
      closedAtSnapshot: job.closedAt !== null ? job.closedAt * 1000 : null,
    })
    .onConflictDoNothing()
    .run();
  db.update(stageEvents)
    .set({ applicationAttemptId: id })
    .where(
      and(
        privateDataScopeFilter(stageEvents),
        eq(stageEvents.applicationId, jobId),
        sql`${stageEvents.applicationAttemptId} IS NULL`,
      ),
    )
    .run();
  db.update(messages)
    .set({ applicationAttemptId: id })
    .where(
      and(
        privateDataScopeFilter(messages),
        eq(messages.matchedJobId, jobId),
        sql`${messages.applicationAttemptId} IS NULL`,
      ),
    )
    .run();
  return id;
}
export function listApplicationAttempts(jobId: string): ApplicationAttempt[] {
  ensureInitialApplicationAttempt(jobId);
  const job = db
    .select()
    .from(jobs)
    .where(and(privateDataScopeFilter(jobs), eq(jobs.id, jobId)))
    .get();
  if (!job) throw notFound("Application not found.");
  const rows = db
    .select()
    .from(attempts)
    .where(and(privateDataScopeFilter(attempts), eq(attempts.jobId, jobId)))
    .orderBy(desc(attempts.sequence))
    .all();
  const events = db
    .select()
    .from(stageEvents)
    .where(
      and(
        privateDataScopeFilter(stageEvents),
        eq(stageEvents.applicationId, jobId),
      ),
    )
    .orderBy(desc(stageEvents.occurredAt), sql`stage_events.rowid DESC`)
    .all();
  return rows.map((row, index) => {
    const event = events.find(
      (item) =>
        item.applicationAttemptId === row.id &&
        (item.metadata as { eventType?: string } | null)?.eventType !== "note",
    );
    // The outcome API can close a job without writing a stage event. Current
    // closure is canonical on the job; archived closure is captured at reapply.
    const canonicalClosedAt =
      index === 0
        ? job.closedAt === null
          ? null
          : job.closedAt * 1000
        : row.closedAtSnapshot;
    const stage =
      canonicalClosedAt !== null
        ? "closed"
        : (event?.toStage ?? row.stageSnapshot);
    const closedAt =
      canonicalClosedAt ??
      (stage === "closed" && event ? event.occurredAt * 1000 : null);
    return {
      id: row.id,
      jobId: row.jobId,
      sequence: row.sequence,
      appliedAt: row.appliedAt,
      applicationReference: row.applicationReference,
      requisitionId: row.requisitionId,
      current: index === 0,
      stage,
      closedAt,
      outcome:
        index === 0
          ? job.outcome
          : stage === "closed"
            ? (row.outcomeSnapshot ?? event?.outcome ?? null)
            : (event?.outcome ?? null),
    };
  });
}
export function createApplicationAttempt(
  jobId: string,
  input: {
    appliedAt: number;
    applicationReference?: string;
    requisitionId?: string;
  },
): ApplicationAttempt {
  return db.transaction(() => {
    const previous = listApplicationAttempts(jobId)[0];
    if (!previous.closedAt)
      throw conflict(
        "Close the current attempt before starting a new application for this posting.",
      );
    if (input.appliedAt <= previous.closedAt)
      throw conflict(
        "The new attempt must start after the previous attempt closed.",
      );
    const owner = getScopedAttempt(previous.id);
    if (!owner) throw notFound("Application attempt not found.");
    db.update(attempts)
      .set({
        stageSnapshot: previous.stage,
        outcomeSnapshot: previous.outcome,
        closedAtSnapshot: previous.closedAt,
      })
      .where(
        and(privateDataScopeFilter(attempts), eq(attempts.id, previous.id)),
      )
      .run();
    const id = randomUUID();
    db.insert(attempts)
      .values({
        id,
        jobId,
        sequence: previous.sequence + 1,
        appliedAt: input.appliedAt,
        applicationReference: input.applicationReference
          ? normalizeApplicationReference(input.applicationReference)
          : null,
        requisitionId: input.requisitionId ?? null,
        tenantId: owner.tenantId,
        userId: owner.userId,
      })
      .run();
    return {
      id,
      jobId,
      sequence: previous.sequence + 1,
      appliedAt: input.appliedAt,
      applicationReference: input.applicationReference
        ? normalizeApplicationReference(input.applicationReference)
        : null,
      requisitionId: input.requisitionId ?? null,
      closedAt: null,
      stage: "applied",
      outcome: null,
      current: true,
    };
  });
}
function identityEntries(
  identity: EmailAttemptIdentity,
  includeReferences = false,
): Array<[string, string]> {
  return [
    ...(identity.messageId
      ? [["message", identity.messageId] as [string, string]]
      : []),
    ...(identity.threadId
      ? [["thread", identity.threadId] as [string, string]]
      : []),
    ...(identity.applicationReference
      ? [
          [
            "reference",
            normalizeApplicationReference(identity.applicationReference),
          ] as [string, string],
        ]
      : []),
    ...(includeReferences
      ? (identity.references ?? [])
          .slice(-20)
          .map((value): [string, string] => ["message", value])
      : []),
  ].filter(([, value]) => value.length > 0 && value.length <= 500);
}
export function findIdentityAttempts(
  provider: PostApplicationProvider,
  accountKey: string,
  identity: EmailAttemptIdentity,
): string[] {
  const entries = identityEntries({ ...identity, messageId: undefined }, true);
  // Explicit references are stronger than a provider's broad conversation ID.
  const lookup = (values: Array<[string, string]>) =>
    values.flatMap(([kind, value]) =>
      db
        .select({ attemptId: identities.attemptId })
        .from(identities)
        .where(
          and(
            privateDataScopeFilter(identities),
            eq(identities.provider, provider),
            eq(identities.accountKey, accountKey),
            eq(identities.kind, kind),
            eq(identities.identityHash, hash(value)),
          ),
        )
        .all()
        .map((row) => row.attemptId),
    );
  const legacy = (kind: string, value: string) =>
    db
      .select({ attemptId: messages.applicationAttemptId })
      .from(messages)
      .where(
        and(
          privateDataScopeFilter(messages),
          eq(messages.provider, provider),
          eq(messages.accountKey, accountKey),
          inArray(messages.processingStatus, ["auto_linked", "manual_linked"]),
          kind === "thread"
            ? eq(messages.externalThreadId, value)
            : eq(messages.externalMessageId, hash(value)),
        ),
      )
      .all()
      .flatMap((row) => (row.attemptId ? [row.attemptId] : []));
  const strongEntries = entries.filter(([kind]) => kind !== "thread");
  const strong = [
    ...lookup(strongEntries),
    ...strongEntries
      .filter(([kind]) => kind === "message" && provider === "imap")
      .flatMap(([kind, value]) => legacy(kind, value)),
  ];
  const threadEntries = entries.filter(([kind]) => kind === "thread");
  const threadMatches = [
    ...lookup(threadEntries),
    ...threadEntries.flatMap(([kind, value]) => legacy(kind, value)),
  ];
  return [...new Set(strong.length ? strong : threadMatches)];
}
export function rememberAttemptIdentity(
  provider: PostApplicationProvider,
  accountKey: string,
  attemptId: string,
  identity: EmailAttemptIdentity,
): void {
  const attempt = getScopedAttempt(attemptId);
  if (!attempt) throw notFound("Application attempt not found.");
  for (const [kind, value] of identityEntries(identity)) {
    // Never silently move a previously confirmed thread/reference to another attempt.
    db.insert(identities)
      .values({
        id: randomUUID(),
        tenantId: attempt.tenantId,
        userId: attempt.userId,
        provider,
        accountKey,
        kind,
        identityHash: hash(value),
        attemptId,
      })
      .onConflictDoNothing()
      .run();
  }
  if (identity.requisitionId && !attempt.requisitionId) {
    db.update(attempts)
      .set({
        requisitionId: normalizeApplicationReference(identity.requisitionId),
      })
      .where(and(privateDataScopeFilter(attempts), eq(attempts.id, attemptId)))
      .run();
  }
  if (identity.applicationReference && !attempt.applicationReference) {
    db.update(attempts)
      .set({
        applicationReference: normalizeApplicationReference(
          identity.applicationReference,
        ),
      })
      .where(and(privateDataScopeFilter(attempts), eq(attempts.id, attemptId)))
      .run();
  }
}
export function findAttemptsByReference(
  provider: PostApplicationProvider,
  accountKey: string,
  reference: string,
): string[] {
  const normalized = normalizeApplicationReference(reference);
  // Direct user-entered references are valid too. Restrict to jobs in the private scope.
  const rows = db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        privateDataScopeFilter(attempts),
        eq(attempts.applicationReference, normalized),
      ),
    )
    .all();
  return [
    ...new Set([
      ...rows.map((row) => row.id),
      ...findIdentityAttempts(provider, accountKey, {
        applicationReference: reference,
      }),
    ]),
  ];
}
export function listSiblingApplicationJobs(jobId: string) {
  const job = db
    .select()
    .from(jobs)
    .where(and(privateDataScopeFilter(jobs), eq(jobs.id, jobId)))
    .get();
  if (!job) return [];
  const normalize = (text: string) =>
    text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  return db
    .select()
    .from(jobs)
    .where(
      and(
        privateDataScopeFilter(jobs),
        inArray(jobs.status, ["applied", "in_progress", "processing"]),
      ),
    )
    .all()
    .filter(
      (other) =>
        normalize(other.employer) === normalize(job.employer) &&
        normalize(other.title) === normalize(job.title),
    );
}

// Null records an independent outcome/API closure, rather than an inferred
// association with an event that happens to have the same timestamp.
export function setCurrentAttemptClosureEvent(
  jobId: string,
  eventId: string | null,
): void {
  const current = db
    .select()
    .from(attempts)
    .where(and(privateDataScopeFilter(attempts), eq(attempts.jobId, jobId)))
    .orderBy(desc(attempts.sequence))
    .get();
  if (current)
    db.update(attempts)
      .set({ closureEventId: eventId })
      .where(and(privateDataScopeFilter(attempts), eq(attempts.id, current.id)))
      .run();
}
