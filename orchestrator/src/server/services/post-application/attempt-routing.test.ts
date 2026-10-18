import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise real SQLite, repositories and transactions. Only analytics is external.
vi.mock("@infra/product-analytics", () => ({
  trackServerProductEvent: vi.fn().mockResolvedValue(false),
}));
let directory: string;
let db: typeof import("@server/db").db;
let schema: typeof import("@server/db").schema;
let repo: typeof import("@server/repositories/application-attempts");
let routing: typeof import("./attempt-routing");
let tracking: typeof import("@server/services/applicationTracking");
let review: typeof import("./review/service");
const old = Date.now() - 30 * 86400000;
beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp(join(tmpdir(), "jobops-attempts-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("JOBOPS_APP_MODE", "local");
  await import("@server/db/migrate");
  ({ db, schema } = await import("@server/db"));
  repo = await import("@server/repositories/application-attempts");
  routing = await import("./attempt-routing");
  tracking = await import("@server/services/applicationTracking");
  review = await import("./review/service");
});
afterEach(async () => {
  (await import("@server/db")).closeDb();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function job(closed = true) {
  const { createJob } = await import("@server/repositories/jobs");
  const created = await createJob({
    source: "manual",
    title: "Engineer",
    employer: "Acme",
    jobUrl: `https://example.com/${randomUUID()}`,
  });
  tracking.transitionStage(created.id, "applied", Math.floor(old / 1000), {
    actor: "user",
  });
  if (closed)
    tracking.transitionStage(
      created.id,
      "closed",
      Math.floor((old + 86400000) / 1000),
      { actor: "user" },
      "withdrawn",
    );
  return created;
}
async function seed(
  jobId: string,
  stageTarget:
    | "applied"
    | "rejected"
    | "offer"
    | "technical_interview" = "applied",
  identity = {},
) {
  const { upsertPostApplicationMessage } = await import(
    "@server/repositories/post-application-messages"
  );
  return (
    await upsertPostApplicationMessage({
      provider: "imap",
      accountKey: "account",
      integrationId: null,
      syncRunId: null,
      externalMessageId: randomUUID(),
      fromAddress: "jobs@acme.example",
      subject: "Application update",
      receivedAt: Date.now() - 1000,
      snippet: "Update",
      classificationLabel: stageTarget,
      stageTarget,
      classificationPayload: { emailIdentity: identity },
      relevanceDecision: "relevant",
      matchedJobId: jobId,
      matchConfidence: 99,
      messageType:
        stageTarget === "offer"
          ? "offer"
          : stageTarget === "technical_interview"
            ? "interview"
            : "update",
      processingStatus: "pending_user",
    })
  ).message;
}
const resolve = (
  jobId: string,
  identity = {},
  stageTarget: "applied" | "offer" = "applied",
) =>
  routing.resolveEmailAttempt({
    provider: "imap",
    accountKey: "account",
    suggestedJobId: jobId,
    confidence: 99,
    receivedAt: Date.now(),
    stageTarget,
    identity,
    isRelevant: true,
  });
describe.sequential("attempt-aware late email routing", () => {
  it("honors outcome-only closure despite an existing applied event and preserves it on reapplication", async () => {
    const created = await job(false);
    const closedAt = Math.floor((old + 86400000) / 1000);
    // This is the persistence operation used by PATCH /jobs/:id/outcome.
    await (await import("@server/repositories/jobs")).updateJob(created.id, {
      outcome: "withdrawn",
      closedAt,
    });
    expect(repo.listApplicationAttempts(created.id)[0]).toMatchObject({
      stage: "closed",
      closedAt: closedAt * 1000,
      outcome: "withdrawn",
    });
    expect(await resolve(created.id, {}, "offer")).toMatchObject({
      automaticClosedLink: false,
      attempt: { stage: "closed" },
    });
    const routine = await seed(created.id, "rejected");
    await review.listPostApplicationInbox({
      provider: "imap",
      accountKey: "account",
    });
    expect(
      await (await import("@server/repositories/jobs")).getJobById(created.id),
    ).toMatchObject({
      closedAt,
      outcome: "withdrawn",
    });
    expect(
      await (
        await import("@server/repositories/post-application-messages")
      ).getPostApplicationMessageById(routine.id),
    ).toMatchObject({ processingStatus: "auto_linked" });
    (await import("./application-attempts")).startNewApplicationAttempt(
      created.id,
      { appliedAt: Date.now() - 5000 },
    );
    expect(repo.listApplicationAttempts(created.id)[1]).toMatchObject({
      stage: "closed",
      closedAt: closedAt * 1000,
      outcome: "withdrawn",
    });
  });
  it("automatically links routine mail to a closed attempt without touching closure or outcome", async () => {
    const created = await job();
    const before = await (await import("@server/repositories/jobs")).getJobById(
      created.id,
    );
    const message = await seed(created.id, "rejected");
    expect(
      await review.listPostApplicationInbox({
        provider: "imap",
        accountKey: "account",
      }),
    ).toEqual([]);
    const saved = await (
      await import("@server/repositories/post-application-messages")
    ).getPostApplicationMessageById(message.id);
    expect(saved).toMatchObject({
      processingStatus: "auto_linked",
      applicationAttemptId: repo.listApplicationAttempts(created.id)[0].id,
    });
    const after = await (await import("@server/repositories/jobs")).getJobById(
      created.id,
    );
    expect(after).toEqual(before);
    await review.listPostApplicationInbox({
      provider: "imap",
      accountKey: "account",
    });
    expect(await tracking.getStageEvents(created.id)).toHaveLength(2);
  });
  it("keeps offers in review and reopens only after an explicit action", async () => {
    const created = await job();
    const message = await seed(created.id, "offer");
    const items = await review.listPostApplicationInbox({
      provider: "imap",
      accountKey: "account",
    });
    expect(items[0].message.classificationPayload?.attemptReviewReason).toBe(
      "New opportunity on a closed application",
    );
    await review.approvePostApplicationInboxItem({
      messageId: message.id,
      provider: "imap",
      accountKey: "account",
      reopen: true,
    });
    expect(repo.listApplicationAttempts(created.id)).toHaveLength(1);
    expect(repo.listApplicationAttempts(created.id)[0]).toMatchObject({
      stage: "offer",
      closedAt: null,
      outcome: null,
    });
    expect(
      (await (await import("@server/repositories/jobs")).getJobById(created.id))
        ?.closedAt,
    ).toBeNull();
  });
  it("can keep a closed offer attached without reopening", async () => {
    const created = await job();
    const message = await seed(created.id, "offer");
    await review.listPostApplicationInbox({
      provider: "imap",
      accountKey: "account",
    });
    await review.approvePostApplicationInboxItem({
      messageId: message.id,
      provider: "imap",
      accountKey: "account",
    });
    expect(repo.listApplicationAttempts(created.id)[0].stage).toBe("closed");
  });
  it("requires review for a new unthreaded confirmation even with only one closed attempt", async () => {
    const created = await job();
    expect(await resolve(created.id)).toMatchObject({
      attempt: null,
      automaticClosedLink: false,
      reviewReason: expect.stringContaining("after closure"),
    });
  });
  it("does not assign a new unthreaded email to the newest attempt", async () => {
    const created = await job();
    (await import("./application-attempts")).startNewApplicationAttempt(
      created.id,
      { appliedAt: Date.now() - 5000, applicationReference: "NEW-123" },
    );
    expect(await resolve(created.id)).toMatchObject({
      attempt: null,
      automaticClosedLink: false,
    });
  });
  it("keeps established threads on the old attempt after a reapplication", async () => {
    const created = await job();
    const original = repo.listApplicationAttempts(created.id)[0];
    repo.rememberAttemptIdentity("imap", "account", original.id, {
      messageId: "<old@acme>",
      threadId: "old-thread",
      applicationReference: "OLD-123",
    });
    const current = (
      await import("./application-attempts")
    ).startNewApplicationAttempt(created.id, {
      appliedAt: Date.now() - 5000,
      applicationReference: "NEW-123",
    })[0];
    expect(
      await resolve(created.id, {
        references: ["<old@acme>"],
        threadId: "old-thread",
      }),
    ).toMatchObject({
      attempt: { id: original.id },
      automaticClosedLink: true,
      preserveStatus: true,
    });
    expect(
      (await resolve(created.id, { applicationReference: "NEW-123" })).attempt
        ?.id,
    ).toBe(current.id);
    expect(
      await resolve(created.id, {
        applicationReference: "NEW-123",
        references: ["<old@acme>"],
      }),
    ).toMatchObject({ attempt: null });
  });
  it("requires review for a different reference even in an established thread", async () => {
    const created = await job();
    const original = repo.listApplicationAttempts(created.id)[0];
    repo.rememberAttemptIdentity("imap", "account", original.id, {
      threadId: "thread",
      applicationReference: "OLD-123",
    });
    expect(
      await resolve(created.id, {
        threadId: "thread",
        applicationReference: "NEW-456",
      }),
    ).toMatchObject({ attempt: null, automaticClosedLink: false });
  });
  it("creates a separate attempt only after the user confirms a new application", async () => {
    const created = await job();
    const original = repo.listApplicationAttempts(created.id)[0];
    const message = await seed(created.id, "applied", {
      messageId: "<new@acme>",
      applicationReference: "NEW-456",
    });
    const result = await review.approvePostApplicationInboxItem({
      messageId: message.id,
      provider: "imap",
      accountKey: "account",
      newAttempt: true,
    });
    const attempts = repo.listApplicationAttempts(created.id);
    expect(attempts.map((attempt) => attempt.sequence)).toEqual([2, 1]);
    expect(attempts[1]).toMatchObject({
      id: original.id,
      stage: "closed",
      outcome: "withdrawn",
    });
    expect(result.message.applicationAttemptId).toBe(attempts[0].id);
    expect(
      (await resolve(created.id, { references: ["<new@acme>"] })).attempt?.id,
    ).toBe(attempts[0].id);
    await expect(
      review.approvePostApplicationInboxItem({
        messageId: message.id,
        provider: "imap",
        accountKey: "account",
        newAttempt: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repo.listApplicationAttempts(created.id)).toHaveLength(2);
  });
  it("requires explicit attempt selection when more than one exists", async () => {
    const created = await job();
    (await import("./application-attempts")).startNewApplicationAttempt(
      created.id,
      { appliedAt: Date.now() - 5000 },
    );
    const message = await seed(created.id);
    await review.listPostApplicationInbox({
      provider: "imap",
      accountKey: "account",
    });
    await expect(
      review.approvePostApplicationInboxItem({
        messageId: message.id,
        provider: "imap",
        accountKey: "account",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const previous = repo.listApplicationAttempts(created.id)[1];
    await review.approvePostApplicationInboxItem({
      messageId: message.id,
      provider: "imap",
      accountKey: "account",
      applicationAttemptId: previous.id,
    });
    expect(repo.listApplicationAttempts(created.id)[0].stage).toBe("applied");
  });
  it("requires individual attempt selection for ambiguous sibling postings during bulk approval", async () => {
    const first = await job(false);
    await job(false);
    const message = await seed(first.id, "offer");
    const items = await review.listPostApplicationInbox({
      provider: "imap",
      accountKey: "account",
    });
    expect(
      items[0].message.classificationPayload?.explicitSelectionRequired,
    ).toBe(true);
    const result = await review.runPostApplicationInboxAction({
      provider: "imap",
      accountKey: "account",
      action: "approve",
    });
    expect(result).toMatchObject({ skipped: 1 });
    await expect(
      review.approvePostApplicationInboxItem({
        messageId: message.id,
        provider: "imap",
        accountKey: "account",
        jobId: first.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repo.listApplicationAttempts(first.id)[0].stage).toBe("applied");
    await review.approvePostApplicationInboxItem({
      messageId: message.id,
      provider: "imap",
      accountKey: "account",
      jobId: first.id,
      applicationAttemptId: repo.listApplicationAttempts(first.id)[0].id,
    });
    expect(repo.listApplicationAttempts(first.id)[0].stage).toBe("offer");
  });
  it("keeps oversized-email notices visible until explicitly skipped and never approves them", async () => {
    const created = await job(false);
    const message = await seed(created.id);
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.postApplicationMessages)
      .set({ errorCode: "IMAP_MESSAGE_TOO_LARGE" })
      .where(eq(schema.postApplicationMessages.id, message.id));
    expect(
      await review.listPostApplicationInbox({
        provider: "imap",
        accountKey: "account",
      }),
    ).toHaveLength(1);
    await expect(
      review.approvePostApplicationInboxItem({
        messageId: message.id,
        provider: "imap",
        accountKey: "account",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await review.runPostApplicationInboxAction({
        provider: "imap",
        accountKey: "account",
        action: "approve",
      }),
    ).toMatchObject({ skipped: 1 });
    await review.denyPostApplicationInboxItem({
      messageId: message.id,
      provider: "imap",
      accountKey: "account",
    });
    expect(
      await review.listPostApplicationInbox({
        provider: "imap",
        accountKey: "account",
      }),
    ).toEqual([]);
  });
  it("does not confuse separate postings with identical company and role names", async () => {
    const first = await job();
    await job(false);
    expect(await resolve(first.id)).toMatchObject({ attempt: null });
  });
  it("preserves legacy closure and outcome when no stage events existed", async () => {
    const { createJob } = await import("@server/repositories/jobs");
    const created = await createJob({
      source: "manual",
      title: "Legacy role",
      employer: "Acme",
      jobUrl: `https://example.com/${randomUUID()}`,
    });
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.jobs)
      .set({
        status: "in_progress",
        appliedAt: new Date(old).toISOString(),
        closedAt: Math.floor((old + 86400000) / 1000),
        outcome: "withdrawn",
      })
      .where(eq(schema.jobs.id, created.id));
    (await import("./application-attempts")).startNewApplicationAttempt(
      created.id,
      { appliedAt: Date.now() - 5000 },
    );
    expect(repo.listApplicationAttempts(created.id)[1]).toMatchObject({
      stage: "closed",
      outcome: "withdrawn",
      closedAt: Math.floor((old + 86400000) / 1000) * 1000,
    });
  });
  it("keeps decided email associations immutable during repeated ingestion", async () => {
    const created = await job();
    const message = await seed(created.id, "rejected");
    await review.listPostApplicationInbox({
      provider: "imap",
      accountKey: "account",
    });
    const messages = await import(
      "@server/repositories/post-application-messages"
    );
    const first = await messages.getPostApplicationMessageById(message.id);
    const next = (
      await import("./application-attempts")
    ).startNewApplicationAttempt(created.id, {
      appliedAt: Date.now() - 5000,
    })[0];
    const result = await messages.upsertPostApplicationMessage({
      ...message,
      applicationAttemptId: next.id,
      processingStatus: "pending_user",
    });
    expect(result.message).toMatchObject({
      applicationAttemptId: first?.applicationAttemptId,
      decidedAt: first?.decidedAt,
      processingStatus: "auto_linked",
    });
  });
  it("editing a historical attempt never changes the current application", async () => {
    const created = await job();
    const events = await tracking.getStageEvents(created.id);
    (await import("./application-attempts")).startNewApplicationAttempt(
      created.id,
      { appliedAt: Date.now() - 5000 },
    );
    tracking.updateStageEvent(events[1].id, {
      occurredAt: Math.floor(Date.now() / 1000),
      outcome: "rejected",
    });
    expect(
      (await (await import("@server/repositories/jobs")).getJobById(created.id))
        ?.outcome,
    ).toBeNull();
    expect(repo.listApplicationAttempts(created.id)[0]).toMatchObject({
      stage: "applied",
      closedAt: null,
    });
  });
  it("preserves outcome-only closure during historical deletion and metadata edits", async () => {
    const created = await job();
    const historical = await tracking.getStageEvents(created.id);
    (await import("./application-attempts")).startNewApplicationAttempt(
      created.id,
      { appliedAt: Date.now() - 5000 },
    );
    const jobs = await import("@server/repositories/jobs");
    await jobs.updateJob(created.id, {
      outcome: "rejected",
      closedAt: Math.floor(Date.now() / 1000),
    });
    const before = await jobs.getJobById(created.id);
    tracking.deleteStageEvent(historical[0].id);
    expect(await jobs.getJobById(created.id)).toEqual(before);
    const current = (await tracking.getStageEvents(created.id)).find(
      (event) => event.attemptSequence === 2,
    );
    if (!current) throw new Error("Missing current event");
    tracking.updateStageEvent(current.id, {
      metadata: { actor: "user", eventLabel: "Corrected label" },
    });
    expect(await jobs.getJobById(created.id)).toEqual(before);
    // Even deleting the last current non-closing event cannot erase an
    // independent closure recorded through the outcome endpoint.
    tracking.deleteStageEvent(current.id);
    expect(await jobs.getJobById(created.id)).toEqual(before);
  });
  it("does not reopen an old attempt after a later reapplication exists", async () => {
    const created = await job();
    const oldAttempt = repo.listApplicationAttempts(created.id)[0];
    (await import("./application-attempts")).startNewApplicationAttempt(
      created.id,
      { appliedAt: Date.now() - 5000 },
    );
    const message = await seed(created.id, "offer");
    await expect(
      review.approvePostApplicationInboxItem({
        messageId: message.id,
        provider: "imap",
        accountKey: "account",
        applicationAttemptId: oldAttempt.id,
        reopen: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("uses a unique confirmed requisition ID to distinguish identical job titles", async () => {
    const first = await job();
    const second = await job(false);
    const firstAttempt = repo.listApplicationAttempts(first.id)[0];
    const secondAttempt = repo.listApplicationAttempts(second.id)[0];
    repo.rememberAttemptIdentity("imap", "account", firstAttempt.id, {
      requisitionId: "REQ-ONE",
    });
    repo.rememberAttemptIdentity("imap", "account", secondAttempt.id, {
      requisitionId: "REQ-TWO",
    });
    expect(await resolve(first.id, { requisitionId: "REQ-TWO" })).toMatchObject(
      { jobId: second.id, attempt: { id: secondAttempt.id } },
    );
    expect(
      await resolve(first.id, { requisitionId: "REQ-UNKNOWN" }),
    ).toMatchObject({ attempt: null });
  });
  it("isolates identities and attempt access by tenant and hosted user", async () => {
    const { runWithRequestContext } = await import("@infra/request-context");
    await db
      .insert(schema.tenants)
      .values({ id: "other", name: "Other", slug: "other" });
    const created = await job();
    const attempt = repo.listApplicationAttempts(created.id)[0];
    repo.rememberAttemptIdentity("imap", "account", attempt.id, {
      threadId: "private",
    });
    await runWithRequestContext({ tenantId: "other" }, async () => {
      expect(
        repo.findIdentityAttempts("imap", "account", { threadId: "private" }),
      ).toEqual([]);
      expect(() => repo.listApplicationAttempts(created.id)).toThrow();
      const message = await seed((await job()).id);
      await expect(
        review.approvePostApplicationInboxItem({
          messageId: message.id,
          provider: "imap",
          accountKey: "account",
          applicationAttemptId: attempt.id,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
    await db.insert(schema.users).values([
      {
        id: "one",
        username: "one",
        passwordHash: "hash",
        passwordSalt: "salt",
      },
      {
        id: "two",
        username: "two",
        passwordHash: "hash",
        passwordSalt: "salt",
      },
    ]);
    vi.stubEnv("JOBOPS_APP_MODE", "hosted");
    vi.stubEnv("JOBOPS_HOSTED_TENANT_ID", "tenant_default");
    let privateJob = "";
    await runWithRequestContext(
      { tenantId: "tenant_default", userId: "one" },
      async () => {
        privateJob = (await job()).id;
        repo.rememberAttemptIdentity(
          "imap",
          "account",
          repo.listApplicationAttempts(privateJob)[0].id,
          { threadId: "user-thread" },
        );
      },
    );
    await runWithRequestContext(
      { tenantId: "tenant_default", userId: "two" },
      () => {
        expect(
          repo.findIdentityAttempts("imap", "account", {
            threadId: "user-thread",
          }),
        ).toEqual([]);
        expect(() => repo.listApplicationAttempts(privateJob)).toThrow();
      },
    );
  });
  it("extracts only explicit application and requisition identifiers", () => {
    expect(
      routing.extractApplicationIdentifiers(
        "Application reference: ABC-123. Job ID: REQ-456",
      ),
    ).toMatchObject({
      applicationReference: "ABC-123",
      requisitionId: "REQ-456",
    });
    expect(
      routing.extractApplicationIdentifiers("Bewerbungsnummer: DE-789"),
    ).toMatchObject({ applicationReference: "DE-789" });
    expect(
      routing.extractApplicationIdentifiers(
        "Thank you for your application. Engineer 2026.",
      ),
    ).toEqual({});
  });
});
