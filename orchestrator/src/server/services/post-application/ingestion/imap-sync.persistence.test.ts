import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the network boundary is mocked: credentials, checkpoints, messages and
// skip decisions use real encrypted repositories and an isolated SQLite DB.
const client = vi.hoisted(() => ({
  mailboxOpen: vi.fn(),
  search: vi.fn(),
  fetchOne: vi.fn(),
}));
vi.mock("./imap-client", () => ({
  withImapConnection: async (
    _config: unknown,
    operation: (value: typeof client) => Promise<unknown>,
  ) => operation(client),
}));
let directory: string;
const config = {
  email: "test@example.com",
  host: "imap.example.com",
  port: 993,
  security: "tls",
  username: "test",
  password: "secret",
  mailbox: "INBOX",
  authMethod: "password",
  uidValidity: "7",
  lastUid: 900,
  keywordFilterFingerprint: "old-filter",
  syncSearchDays: 90,
  searchCheckpoints: [
    {
      fingerprint: "old-filter",
      searchDays: 90,
      uidValidity: "7",
      lastUid: 900,
    },
  ],
};
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "jobops-imap-persistence-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("JOBOPS_APP_MODE", "local");
  vi.stubEnv("EMAIL_CREDENTIALS_KEY", "ab".repeat(32));
  await import("@server/db/migrate");
  await (
    await import("@server/repositories/post-application-integrations")
  ).upsertConnectedPostApplicationIntegration({
    provider: "imap",
    accountKey: "one",
    displayName: "Mail",
    credentials: config,
  });
  client.mailboxOpen.mockResolvedValue({ uidValidity: 7n, uidNext: 2 });
  client.search.mockResolvedValue([1]);
  client.fetchOne.mockResolvedValue({
    size: 6 * 1024 * 1024,
    envelope: {
      messageId: "<stable@example.com>",
      subject: "Large application email",
    },
    internalDate: new Date("2026-10-01"),
  });
});
afterEach(async () => {
  (await import("@server/db")).closeDb();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function credentials() {
  return (
    await (
      await import("@server/repositories/post-application-integrations")
    ).getPostApplicationIntegration("imap", "one")
  )?.credentials;
}
async function connect(changes: Record<string, unknown>) {
  return (await import("../providers/imap")).imapProvider.connect({
    accountKey: "one",
    payload: { payload: { ...config, ...changes } },
  });
}
describe.sequential("durable IMAP identities", () => {
  it.each([
    { port: 1993 },
    { security: "starttls" },
    { mailbox: "Archive" },
    { host: "other.example.com" },
    { username: "other" },
  ])("clears persisted cursors after endpoint change %j", async (change) => {
    await connect(change);
    expect(await credentials()).toMatchObject(change);
    expect((await credentials())?.lastUid).toBeUndefined();
    expect((await credentials())?.uidValidity).toBeUndefined();
    expect((await credentials())?.searchCheckpoints).toBeUndefined();
  });
  it("retains cursors when only display settings change", async () => {
    await connect({ displayName: "Renamed" });
    expect(await credentials()).toMatchObject({
      lastUid: 900,
      uidValidity: "7",
      searchCheckpoints: config.searchCheckpoints,
    });
  });
  it("promotes an existing location-based dismissal without losing its row or decision", async () => {
    const { runImapSync, imapMessageIdentity } = await import("./imap-sync");
    const repository = await import(
      "@server/repositories/post-application-messages"
    );
    const oldNotice = (
      await repository.upsertPostApplicationMessage({
        provider: "imap",
        accountKey: "one",
        integrationId: null,
        syncRunId: null,
        externalMessageId: `oversized:${imapMessageIdentity("INBOX", "7", 1)}`,
        fromAddress: "",
        subject: "Legacy notice",
        receivedAt: Date.now(),
        snippet: "",
        relevanceDecision: "needs_llm",
        messageType: "other",
        processingStatus: "ignored",
        decidedAt: 1234,
        decidedBy: "user",
        errorCode: "IMAP_MESSAGE_TOO_LARGE",
      })
    ).message;
    await runImapSync("one");
    const { db, schema } = await import("@server/db");
    expect(
      db.select().from(schema.postApplicationMessages).all(),
    ).toMatchObject([
      {
        id: oldNotice.id,
        externalMessageId: `oversized:${imapMessageIdentity("INBOX", "7", 1, "<stable@example.com>")}`,
        processingStatus: "ignored",
        decidedAt: 1234,
        decidedBy: "user",
      },
    ]);
  });
  it.each([
    "tenant",
    "user",
    "account",
  ])("scopes legacy identity promotion by %s", async (boundary) => {
    const { db, schema } = await import("@server/db");
    const { runWithRequestContext } = await import("@infra/request-context");
    const repository = await import(
      "@server/repositories/post-application-messages"
    );
    await db
      .insert(schema.tenants)
      .values({ id: "other", name: "Other", slug: "other" });
    await db.insert(schema.users).values(
      ["one", "two"].map((id) => ({
        id,
        username: id,
        passwordHash: "hash",
        passwordSalt: "salt",
      })),
    );
    vi.stubEnv("JOBOPS_APP_MODE", "hosted");
    vi.stubEnv("JOBOPS_HOSTED_TENANT_ID", "tenant_default");
    const input = {
      provider: "imap" as const,
      accountKey: "one",
      integrationId: null,
      syncRunId: null,
      externalMessageId: "old-location",
      fromAddress: "",
      subject: "Private",
      receivedAt: Date.now(),
      snippet: "",
      relevanceDecision: "needs_llm" as const,
      messageType: "other" as const,
      processingStatus: "ignored" as const,
    };
    const owner = { tenantId: "tenant_default", userId: "one" };
    const first = await runWithRequestContext(owner, () =>
      repository.upsertPostApplicationMessage(input),
    );
    const context = {
      tenantId: boundary === "tenant" ? "other" : "tenant_default",
      userId: boundary === "user" ? "two" : "one",
    };
    const second = await runWithRequestContext(context, () =>
      repository.upsertPostApplicationMessage({
        ...input,
        accountKey: boundary === "account" ? "two" : "one",
        externalMessageId: "new-stable",
        previousExternalMessageId: "old-location",
        processingStatus: "pending_user",
      }),
    );
    expect(second.message.id).not.toBe(first.message.id);
    expect(second.message.processingStatus).toBe("pending_user");
    await runWithRequestContext(owner, async () => {
      expect(
        await repository.getPostApplicationMessageByExternalId(
          "imap",
          "one",
          "old-location",
        ),
      ).toMatchObject({ id: first.message.id, processingStatus: "ignored" });
    });
  });
  it("preserves a real skip decision across UIDVALIDITY resets and mailbox moves", async () => {
    const { runImapSync } = await import("./imap-sync");
    const review = await import("../review/service");
    await runImapSync("one");
    const pending = await review.listPostApplicationInbox({
      provider: "imap",
      accountKey: "one",
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].message.matchedJobId).toBeNull();
    await review.denyPostApplicationInboxItem({
      provider: "imap",
      accountKey: "one",
      messageId: pending[0].message.id,
    });
    client.mailboxOpen.mockResolvedValue({ uidValidity: 8n, uidNext: 3 });
    client.search.mockResolvedValue([2]);
    await runImapSync("one");
    await connect({ mailbox: "Archive" });
    client.mailboxOpen.mockResolvedValue({ uidValidity: 9n, uidNext: 4 });
    client.search.mockResolvedValue([3]);
    await runImapSync("one");
    const { db, schema } = await import("@server/db");
    const messages = db.select().from(schema.postApplicationMessages).all();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: pending[0].message.id,
      processingStatus: "ignored",
    });
    expect(
      await review.listPostApplicationInbox({
        provider: "imap",
        accountKey: "one",
      }),
    ).toEqual([]);
    expect(client.fetchOne.mock.calls.every(([, query]) => !query.source)).toBe(
      true,
    );
  });
});
