import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type {
  PostApplicationMessage,
  PostApplicationRouterStageTarget,
} from "@shared/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("Post-Application Review Workflow API", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function seedPendingMessage(input?: {
    provider?: "gmail" | "imap";
    receivedAt?: number;
    syncRunId?: string | null;
    matchedJobId?: string | null;
    stageTarget?: PostApplicationRouterStageTarget;
  }): Promise<{
    message: PostApplicationMessage;
    jobId: string;
  }> {
    const { createJob } = await import("@server/repositories/jobs");
    const { upsertPostApplicationMessage } = await import(
      "@server/repositories/post-application-messages"
    );

    const job = await createJob({
      source: "manual",
      title: "Front End JavaScript Developer",
      employer: "Roku Interactive",
      jobUrl: `https://example.com/jobs/${randomUUID()}`,
    });

    const { message } = await upsertPostApplicationMessage({
      provider: input?.provider ?? "gmail",
      accountKey: "default",
      integrationId: null,
      syncRunId: input?.syncRunId ?? null,
      externalMessageId: randomUUID(),
      fromAddress: "roku@smartrecruiters.com",
      fromDomain: "smartrecruiters.com",
      senderName: "Roku",
      subject: "Interview invitation",
      receivedAt: input?.receivedAt ?? Date.now(),
      snippet: "Please schedule an interview.",
      classificationLabel: "interview",
      classificationConfidence: 0.97,
      classificationPayload: {
        reason: "High confidence",
      },
      relevanceLlmScore: 97,
      relevanceDecision: "relevant",
      matchConfidence: 97,
      stageTarget: input?.stageTarget ?? "technical_interview",
      messageType:
        input?.stageTarget === "rejected" || input?.stageTarget === "withdrawn"
          ? "rejection"
          : "interview",
      stageEventPayload: { note: "from test" },
      processingStatus: "pending_user",
      matchedJobId:
        input?.matchedJobId === undefined ? job.id : input.matchedJobId,
    });

    return { message, jobId: job.id };
  }

  it("blocks older IMAP suggestions from overwriting newer confirmed stages", async () => {
    const { message, jobId } = await seedPendingMessage({
      provider: "imap",
      receivedAt: Date.now() - 60000,
    });
    const { transitionStage } = await import(
      "@server/services/applicationTracking"
    );
    transitionStage(jobId, "offer", Math.floor(Date.now() / 1000), {
      actor: "user",
    });
    const res = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "imap", accountKey: "default" }),
      },
    );
    expect(res.status).toBe(409);
    const { getPostApplicationMessageById } = await import(
      "@server/repositories/post-application-messages"
    );
    expect(
      (await getPostApplicationMessageById(message.id))?.processingStatus,
    ).toBe("pending_user");
    const link = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "imap",
          accountKey: "default",
          stageTarget: "no_change",
        }),
      },
    );
    expect(link.status).toBe(200);
  });

  it("links an older confirmation of the current stage without rewriting its date", async () => {
    const receivedAt = Date.now() - 13000;
    const { message, jobId } = await seedPendingMessage({
      provider: "imap",
      receivedAt,
      stageTarget: "applied",
    });
    const { transitionStage, getStageEvents } = await import(
      "@server/services/applicationTracking"
    );
    const event = transitionStage(
      jobId,
      "applied",
      Math.floor(Date.now() / 1000),
      { actor: "system" },
    );
    const res = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "imap", accountKey: "default" }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.message.processingStatus).toBe("manual_linked");
    expect(body.data.stageEventId).toBeNull();
    expect(await getStageEvents(jobId)).toEqual([event]);
  });

  it("does not mistake a newer note for a confirmed stage update", async () => {
    const receivedAt = Date.now() - 60000;
    const { message, jobId } = await seedPendingMessage({
      provider: "imap",
      receivedAt,
      stageTarget: "rejected",
    });
    const { transitionStage } = await import(
      "@server/services/applicationTracking"
    );
    transitionStage(jobId, "applied", Math.floor(receivedAt / 1000) - 100, {
      actor: "user",
    });
    transitionStage(jobId, "no_change", Math.floor(Date.now() / 1000), {
      actor: "user",
      eventType: "note",
      note: "Reviewed tracking",
    });
    const res = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "imap", accountKey: "default" }),
      },
    );
    expect(res.status).toBe(200);
    const { getJobById } = await import("@server/repositories/jobs");
    expect((await getJobById(jobId))?.outcome).toBe("rejected");
  });

  it("links a historical rejection without changing a closed withdrawal outcome", async () => {
    const { message, jobId } = await seedPendingMessage({
      provider: "imap",
      receivedAt: Date.now() - 60000,
      stageTarget: "rejected",
    });
    const { transitionStage } = await import(
      "@server/services/applicationTracking"
    );
    transitionStage(
      jobId,
      "closed",
      Math.floor(Date.now() / 1000),
      { actor: "user" },
      "withdrawn",
    );
    const res = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "imap", accountKey: "default" }),
      },
    );
    expect(res.status).toBe(200);
    const { getJobById } = await import("@server/repositories/jobs");
    expect((await getJobById(jobId))?.outcome).toBe("withdrawn");
  });

  it("ignores newer events belonging to a different tenant when reviewing an email", async () => {
    const { message, jobId } = await seedPendingMessage({
      provider: "imap",
      receivedAt: Date.now() - 60000,
    });
    const { db, schema } = await import("@server/db");
    await db
      .insert(schema.tenants)
      .values({ id: "review-other", name: "Other", slug: "review-other" });
    await db.insert(schema.stageEvents).values({
      id: randomUUID(),
      tenantId: "review-other",
      applicationId: jobId,
      title: "Other tenant update",
      toStage: "offer",
      occurredAt: Math.floor(Date.now() / 1000),
    });
    const res = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "imap", accountKey: "default" }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("starts a new application attempt through the scoped API and preserves previous history", async () => {
    const { jobId } = await seedPendingMessage();
    const { transitionStage } = await import(
      "@server/services/applicationTracking"
    );
    transitionStage(jobId, "applied", Math.floor(Date.now() / 1000) - 1000, {
      actor: "user",
    });
    transitionStage(
      jobId,
      "closed",
      Math.floor(Date.now() / 1000) - 500,
      { actor: "user" },
      "withdrawn",
    );
    const response = await fetch(
      `${baseUrl}/api/post-application/jobs/${jobId}/attempts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "attempt-correlation",
        },
        body: JSON.stringify({
          appliedAt: Date.now(),
          applicationReference: "APP-NEW",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("attempt-correlation");
    const body = await response.json();
    expect(body.meta.requestId).toBe("attempt-correlation");
    expect(body.data.attempts).toHaveLength(2);
    expect(body.data.attempts[0]).toMatchObject({
      sequence: 2,
      stage: "applied",
      applicationReference: "APP-NEW",
      outcome: null,
    });
    expect(body.data.attempts[1]).toMatchObject({
      sequence: 1,
      stage: "closed",
      outcome: "withdrawn",
    });
    const again = await fetch(
      `${baseUrl}/api/post-application/jobs/${jobId}/attempts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appliedAt: Date.now() }),
      },
    );
    expect(again.status).toBe(409);
  });
  it("validates attempt dates and keeps other tenants' attempts private", async () => {
    const { jobId } = await seedPendingMessage();
    const future = await fetch(
      `${baseUrl}/api/post-application/jobs/${jobId}/attempts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appliedAt: Date.now() + 86400000 }),
      },
    );
    expect(future.status).toBe(400);
    const { db, schema } = await import("@server/db");
    const { runWithRequestContext } = await import("@infra/request-context");
    const { createJob } = await import("@server/repositories/jobs");
    await db
      .insert(schema.tenants)
      .values({ id: "private-other", name: "Other", slug: "private-other" });
    const other = await runWithRequestContext(
      { tenantId: "private-other" },
      () =>
        createJob({
          source: "manual",
          title: "Engineer",
          employer: "Other",
          jobUrl: `https://example.com/${randomUUID()}`,
        }),
    );
    const response = await fetch(
      `${baseUrl}/api/post-application/jobs/${other.id}/attempts`,
    );
    expect(response.status).toBe(404);
  });

  it("lists pending inbox items", async () => {
    const { message } = await seedPendingMessage();

    const res = await fetch(
      `${baseUrl}/api/post-application/inbox?provider=gmail&accountKey=default`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.items[0].message.id).toBe(message.id);
    expect(body.data.items[0].message.processingStatus).toBe("pending_user");
    expect(typeof body.meta.requestId).toBe("string");
  });

  it("approves an inbox item and writes stage event", async () => {
    const { message, jobId } = await seedPendingMessage();
    const { db, schema } = await import("@server/db");

    const res = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "gmail",
          accountKey: "default",
          jobId,
          decidedBy: "tester",
        }),
      },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.message.processingStatus).toBe("manual_linked");
    expect(body.data.message.matchedJobId).toBe(jobId);

    const stageRows = await db.select().from(schema.stageEvents);
    expect(stageRows.length).toBeGreaterThan(0);
  });

  it("returns conflict on second approve and increments sync-run approval once", async () => {
    const { startPostApplicationSyncRun, getPostApplicationSyncRunById } =
      await import("@server/repositories/post-application-sync-runs");
    const run = await startPostApplicationSyncRun({
      provider: "gmail",
      accountKey: "default",
      integrationId: null,
    });
    const { message, jobId } = await seedPendingMessage({ syncRunId: run.id });

    const firstRes = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "gmail",
          accountKey: "default",
          jobId,
          decidedBy: "tester",
        }),
      },
    );
    expect(firstRes.status).toBe(200);

    const secondRes = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "gmail",
          accountKey: "default",
          jobId,
          decidedBy: "tester",
        }),
      },
    );
    const secondBody = await secondRes.json();

    expect(secondRes.status).toBe(409);
    expect(secondBody.ok).toBe(false);
    expect(secondBody.error.code).toBe("CONFLICT");

    const updatedRun = await getPostApplicationSyncRunById(run.id);
    expect(updatedRun?.messagesApproved).toBe(1);
    expect(updatedRun?.messagesDenied).toBe(0);
  });

  it("denies an inbox item as ignored", async () => {
    const { message } = await seedPendingMessage();

    const denyRes = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/deny`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "gmail",
          accountKey: "default",
          decidedBy: "tester",
        }),
      },
    );
    const denyBody = await denyRes.json();

    expect(denyRes.status).toBe(200);
    expect(denyBody.ok).toBe(true);
    expect(denyBody.data.message.processingStatus).toBe("ignored");
    expect(denyBody.data.message.matchedJobId).toBeNull();
  });

  it("counts no-suggested-match approve items as skipped, not failed", async () => {
    await seedPendingMessage({ matchedJobId: null });

    const res = await fetch(`${baseUrl}/api/post-application/inbox/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        provider: "gmail",
        accountKey: "default",
        decidedBy: "tester",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.requested).toBe(1);
    expect(body.data.succeeded).toBe(0);
    expect(body.data.skipped).toBe(1);
    expect(body.data.failed).toBe(0);
    expect(body.data.results[0].ok).toBe(false);
    expect(body.data.results[0].error.code).toBe("NO_SUGGESTED_MATCH");
  });

  it("lists messages for a sync run", async () => {
    const { startPostApplicationSyncRun } = await import(
      "@server/repositories/post-application-sync-runs"
    );
    const run = await startPostApplicationSyncRun({
      provider: "gmail",
      accountKey: "default",
      integrationId: null,
    });
    const { message } = await seedPendingMessage({ syncRunId: run.id });

    const res = await fetch(
      `${baseUrl}/api/post-application/runs/${run.id}/messages?provider=gmail&accountKey=default`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.run.id).toBe(run.id);
    expect(body.data.total).toBe(1);
    expect(body.data.items[0].message.id).toBe(message.id);
  });

  it("approves rejected target and sets closed stage with rejected outcome", async () => {
    const { message, jobId } = await seedPendingMessage({
      stageTarget: "rejected",
    });
    const { db, schema } = await import("@server/db");

    const res = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "gmail",
          accountKey: "default",
          jobId,
        }),
      },
    );

    expect(res.status).toBe(200);

    const stageRows = await db.select().from(schema.stageEvents);
    expect(stageRows.at(-1)?.toStage).toBe("closed");
    expect(stageRows.at(-1)?.outcome).toBe("rejected");

    const jobRow = (await db.select().from(schema.jobs)).find(
      (job) => job.id === jobId,
    );
    expect(jobRow?.outcome).toBe("rejected");
  });

  it("approves withdrawn target and sets closed stage with withdrawn outcome", async () => {
    const { message, jobId } = await seedPendingMessage({
      stageTarget: "withdrawn",
    });
    const { db, schema } = await import("@server/db");

    const res = await fetch(
      `${baseUrl}/api/post-application/inbox/${message.id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "gmail",
          accountKey: "default",
          jobId,
        }),
      },
    );

    expect(res.status).toBe(200);

    const stageRows = await db.select().from(schema.stageEvents);
    expect(stageRows.at(-1)?.toStage).toBe("closed");
    expect(stageRows.at(-1)?.outcome).toBe("withdrawn");

    const jobRow = (await db.select().from(schema.jobs)).find(
      (job) => job.id === jobId,
    );
    expect(jobRow?.outcome).toBe("withdrawn");
  });
});
