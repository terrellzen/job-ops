import { createHash } from "node:crypto";
import { runWithRequestContext } from "@infra/request-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../attempt-routing", () => ({
  bindConfirmedMessage: vi.fn(),
  routeExistingPendingMessages: vi.fn(),
  extractApplicationIdentifiers: vi.fn().mockReturnValue({}),
  resolveEmailAttempt: vi
    .fn()
    .mockImplementation(async (args: { suggestedJobId: string | null }) => ({
      jobId: args.suggestedJobId,
      attempt: null,
      confidence: 0,
      automaticClosedLink: false,
      preserveStatus: true,
      reviewReason: null,
    })),
}));

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  filters: vi.fn(),
  update: vi.fn(),
  existing: vi.fn(),
  save: vi.fn(),
  classify: vi.fn(),
  mailboxOpen: vi.fn(),
  search: vi.fn(),
  fetchOne: vi.fn(),
}));
vi.mock("@server/repositories/post-application-integrations", () => ({
  getPostApplicationIntegration: mocks.get,
  updatePostApplicationIntegrationSyncState: mocks.update,
}));
vi.mock("@server/repositories/post-application-messages", () => ({
  getPostApplicationMessageByExternalId: mocks.existing,
  upsertPostApplicationMessage: mocks.save,
}));
vi.mock("@server/repositories/jobs", () => ({
  getAllJobs: vi
    .fn()
    .mockResolvedValue([
      { id: "job", employer: "Beispiel", title: "Engineer" },
    ]),
}));
vi.mock("@server/repositories/post-application-sync-runs", () => ({
  startPostApplicationSyncRun: vi.fn().mockResolvedValue({ id: "run" }),
  completePostApplicationSyncRun: vi.fn(),
}));
vi.mock("./email-keywords", () => ({ getEmailKeywordFilter: mocks.filters }));
vi.mock("./email-router", () => ({
  minifyActiveJobs: (
    jobs: Array<{ id: string; employer: string; title: string }>,
  ) =>
    jobs.map((job) => ({
      id: job.id,
      company: job.employer,
      title: job.title,
    })),
  classifyWithSmartRouter: mocks.classify,
}));
vi.mock("./imap-client", () => ({
  withImapConnection: async (
    _config: unknown,
    fn: (client: unknown) => Promise<unknown>,
  ) => fn(mocks),
}));

import {
  imapMessageIdentity,
  runImapSync,
  withImapAccountLock,
} from "./imap-sync";

const config = {
  email: "test@example.com",
  host: "imap.example.com",
  username: "test",
  password: "secret",
  uidValidity: "5",
  lastUid: 10,
  keywordFilterFingerprint: createHash("sha256").update("[]").digest("hex"),
  syncSearchDays: 90,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockReset();
  mocks.update.mockResolvedValue(null);
  mocks.filters.mockResolvedValue({
    enabled: false,
    languages: [],
    customKeywords: [],
  });
  mocks.get.mockResolvedValue({
    id: "account",
    status: "connected",
    credentials: config,
  });
  mocks.mailboxOpen.mockResolvedValue({ uidValidity: 5n, uidNext: 13 });
  mocks.search.mockResolvedValue([10, 12, 11]);
  mocks.existing.mockResolvedValue(null);
  mocks.save.mockResolvedValue({ message: { id: "saved" } });
  mocks.fetchOne.mockImplementation(
    async (uid: number, query: { size?: boolean }) =>
      query.size
        ? { size: 500 }
        : {
            source: Buffer.from(
              `Message-ID: <${uid}@example.com>\r\nFrom: Hiring <hiring@example.com>\r\nSubject: Bewerbung\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nVielen Dank für Ihre Bewerbung. Wir möchten Sie zu einem Vorstellungsgespräch einladen.`,
            ),
            internalDate: new Date("2026-01-01"),
          },
  );
  mocks.classify.mockResolvedValue({
    bestMatchId: "job",
    confidence: 98,
    stageTarget: "recruiter_screen",
    isRelevant: true,
    messageType: "interview",
    stageEventPayload: null,
    reason: "Invitation",
  });
});
describe("incremental IMAP ingestion", () => {
  it("fetches only new UIDs in order, parses Unicode, and requires review even at high confidence", async () => {
    await expect(runImapSync("one", 1)).resolves.toBe(1);
    expect(mocks.mailboxOpen).toHaveBeenCalledWith("INBOX", { readOnly: true });
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "11:12", since: expect.any(Date) }),
      { uid: true },
    );
    expect(mocks.classify.mock.calls[0][0].emailText).toContain("möchten");
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        accountKey: "one",
        processingStatus: "pending_user",
        matchedJobId: "job",
      }),
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({ lastUid: 11, uidValidity: "5" }),
      }),
    );
  });
  it("resets UIDs after UIDVALIDITY changes and skips previously processed messages", async () => {
    mocks.mailboxOpen.mockResolvedValue({ uidValidity: 6n, uidNext: 13 });
    mocks.existing.mockResolvedValue({ id: "saved" });
    await runImapSync("two");
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "1:12" }),
      { uid: true },
    );
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("does not advance the UID when classification or persistence fails", async () => {
    mocks.classify.mockRejectedValue(new Error("private upstream response"));
    await expect(runImapSync("one")).rejects.toThrow(/IMAP sync failed/);
    expect(mocks.update.mock.calls.some(([input]) => input.credentials)).toBe(
      false,
    );
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain(
      "private upstream",
    );
  });
  it("rejects nonexistent job suggestions", async () => {
    mocks.classify.mockResolvedValue({
      bestMatchId: "other-tenant-job",
      confidence: 99,
      stageTarget: "offer",
      isRelevant: true,
      messageType: "offer",
      reason: "Offer",
    });
    await runImapSync("one", 1);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        matchedJobId: null,
        processingStatus: "pending_user",
      }),
    );
  });
  it("uses a previously matched message reference as a scoped routing hint", async () => {
    mocks.fetchOne.mockImplementation(
      async (_uid: number, query: { size?: boolean }) =>
        query.size
          ? { size: 500 }
          : {
              source: Buffer.from(
                "Message-ID: <new@example.com>\r\nIn-Reply-To: <old@example.com>\r\nFrom: Hiring <hiring@example.com>\r\nSubject: Follow up\r\n\r\nPlease send additional information.",
              ),
              internalDate: new Date(),
            },
    );
    mocks.existing
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ matchedJobId: "job" });
    await runImapSync("one", 1);
    expect(mocks.classify.mock.calls[0][0].emailText).toContain(
      "Prior message in this thread was linked to Beispiel: Engineer",
    );
  });

  it("applies the requested day window and caps the number of retrieved messages", async () => {
    const now = Date.now();
    await expect(runImapSync("one", 1, 7)).resolves.toBe(1);
    const since = mocks.search.mock.calls[0][0].since as Date;
    expect(since.getTime()).toBeGreaterThanOrEqual(now - 7 * 86_400_000);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.fetchOne).toHaveBeenCalledTimes(2);
  });
  it("bounds searches in large mailboxes and continues through UID gaps", async () => {
    mocks.mailboxOpen.mockResolvedValue({ uidValidity: 5n, uidNext: 81415 });
    mocks.search.mockResolvedValueOnce([]).mockResolvedValueOnce([511, 512]);
    await expect(runImapSync("one", 1)).resolves.toBe(1);
    expect(mocks.search.mock.calls).toEqual([
      [expect.objectContaining({ uid: "11:510" }), { uid: true }],
      [expect.objectContaining({ uid: "511:1010" }), { uid: true }],
    ]);
    expect(mocks.fetchOne).toHaveBeenCalledWith(
      511,
      expect.objectContaining({ size: true }),
      { uid: true },
    );
  });
  it("reports failed SEARCH instead of completing with zero messages", async () => {
    mocks.search.mockResolvedValue(false);
    await expect(runImapSync("one")).rejects.toThrow(/IMAP sync failed/);
    expect(mocks.update.mock.calls.some(([input]) => input.credentials)).toBe(
      false,
    );
    expect(mocks.classify).not.toHaveBeenCalled();
  });
  it("searches English, German and custom terms before applying the message cap", async () => {
    mocks.filters.mockResolvedValue({
      enabled: true,
      languages: ["en", "de"],
      customKeywords: ["candidature"],
    });
    await runImapSync("one", 1);
    const query = mocks.search.mock.calls[0][0];
    expect(query.or).toEqual(
      expect.arrayContaining([
        { text: "application" },
        { text: "bewerbung" },
        { text: "candidature" },
      ]),
    );
    // Changing the filter must reconsider older UIDs, not skip earlier matches.
    expect(query.uid).toBe("1:12");
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it("reconsiders the date window when Search Days increases", async () => {
    await runImapSync("one", 1, 180);
    expect(mocks.search.mock.calls[0][0].uid).toBe("1:12");
  });
  it("checkpoints an empty matching search so large inboxes are not rescanned", async () => {
    mocks.mailboxOpen.mockResolvedValue({ uidValidity: 5n, uidNext: 1200 });
    mocks.search.mockResolvedValue([]);
    await expect(runImapSync("one")).resolves.toBe(0);
    expect(mocks.search).toHaveBeenCalledTimes(3);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          lastUid: 1199,
          uidValidity: "5",
        }),
      }),
    );
    const saved = mocks.update.mock.calls.find(
      ([input]) => input.credentials,
    )?.[0].credentials;
    mocks.get.mockResolvedValue({
      id: "account",
      status: "connected",
      credentials: saved,
    });
    mocks.search.mockClear();
    await runImapSync("one");
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("does not checkpoint beyond messages excluded by the message cap", async () => {
    mocks.mailboxOpen.mockResolvedValue({ uidValidity: 5n, uidNext: 1000 });
    const checkpoints: number[] = [];
    mocks.update.mockImplementation(async (input) => {
      if (input.credentials) checkpoints.push(input.credentials.lastUid);
      return null;
    });
    mocks.search.mockResolvedValue([11, 12, 13]);
    await runImapSync("one", 2);
    expect(checkpoints).toEqual([11, 12]);
  });
  it("does not checkpoint empty ranges if a subsequent search fails", async () => {
    mocks.mailboxOpen.mockResolvedValue({ uidValidity: 5n, uidNext: 1200 });
    mocks.search.mockResolvedValueOnce([]).mockResolvedValueOnce(false);
    await expect(runImapSync("one")).rejects.toThrow(/IMAP sync failed/);
    expect(mocks.update.mock.calls.some(([input]) => input.credentials)).toBe(
      false,
    );
  });
  it("does not search an unchanged mailbox", async () => {
    mocks.mailboxOpen.mockResolvedValue({ uidValidity: 5n, uidNext: 11 });
    await runImapSync("one");
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("quarantines oversized mail without downloading it or blocking later UIDs", async () => {
    const normalFetch = mocks.fetchOne.getMockImplementation();
    if (!normalFetch) throw new Error("Missing fetch fixture");
    mocks.fetchOne.mockImplementation(async (uid, query, options) =>
      uid === 11 ? { size: 6 * 1024 * 1024 } : normalFetch(uid, query, options),
    );
    await expect(runImapSync("one")).resolves.toBe(2);
    expect(mocks.fetchOne).not.toHaveBeenCalledWith(
      11,
      expect.objectContaining({ source: true }),
      expect.anything(),
    );
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "IMAP_MESSAGE_TOO_LARGE",
        processingStatus: "pending_user",
      }),
    );
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({ lastUid: 12 }),
      }),
    );
  });
  it("persists manual limits for automatic polling and resumes checkpoints independently per window", async () => {
    mocks.update.mockImplementation(async (input) => {
      if (input.credentials)
        mocks.get.mockResolvedValue({
          id: "account",
          status: "connected",
          credentials: structuredClone(input.credentials),
        });
      return null;
    });
    mocks.search.mockResolvedValue([1, 2, 3, 4, 5]);
    await runImapSync("one", 2, 7);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          syncSearchDays: 7,
          syncMaxMessages: 2,
          lastUid: 2,
        }),
      }),
    );
    mocks.search.mockClear();
    await runImapSync("one");
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "3:12" }),
      { uid: true },
    );
    // A deliberate historical scan uses its own original checkpoint (UID 10).
    mocks.search.mockClear();
    mocks.search.mockResolvedValue([11, 12]);
    await runImapSync("one", 1, 90);
    // Preserve the pre-upgrade checkpoint when switching search windows.
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "11:12" }),
      { uid: true },
    );
    mocks.search.mockClear();
    await runImapSync("one", 2, 7);
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "5:12" }),
      { uid: true },
    );
  });
  it("deduplicates RFC Message-ID across folders and UID resets", () => {
    expect(imapMessageIdentity("INBOX", "1", 1, "<id@example.com>")).toBe(
      imapMessageIdentity("Archive", "2", 9, "<id@example.com>"),
    );
    expect(imapMessageIdentity("INBOX", "1", 1)).not.toBe(
      imapMessageIdentity("INBOX", "2", 1),
    );
  });
  it("isolates concurrent account locks by tenant and account", async () => {
    await runWithRequestContext({ tenantId: "tenant-a" }, () =>
      withImapAccountLock("one", async () => {
        await expect(
          withImapAccountLock("one", async () => null),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
          withImapAccountLock("two", async () => "two"),
        ).resolves.toBe("two");
        await expect(
          runWithRequestContext({ tenantId: "tenant-b" }, () =>
            withImapAccountLock("one", async () => "other"),
          ),
        ).resolves.toBe("other");
      }),
    );
  });
});
