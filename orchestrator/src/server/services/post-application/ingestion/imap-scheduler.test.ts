import { getRequestContext } from "@infra/request-context";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  owners: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("@server/repositories/post-application-integrations", () => ({
  getPostApplicationIntegration: mocks.get,
  listImapAccountOwners: mocks.owners,
}));
vi.mock("./imap-sync", () => ({ runImapSync: mocks.sync }));

import { startImapScheduler } from "./imap-scheduler";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("IMAP scheduler", () => {
  it("restores tenant/user context and skips disabled or recently synced accounts", async () => {
    vi.useFakeTimers();
    mocks.owners.mockResolvedValue([
      { tenantId: "a", userId: "u1", accountKey: "due" },
      { tenantId: "b", userId: "u2", accountKey: "disabled" },
      { tenantId: "c", userId: "u3", accountKey: "recent" },
    ]);
    mocks.get.mockImplementation(
      async (_provider: string, accountKey: string) => ({
        credentials: {
          automaticSync: accountKey !== "disabled",
          syncIntervalMinutes: 15,
        },
        lastSyncedAt: accountKey === "recent" ? Date.now() : null,
      }),
    );
    mocks.sync.mockImplementation(async () => {
      expect(getRequestContext()).toMatchObject({
        tenantId: "a",
        userId: "u1",
      });
      expect(getRequestContext()?.requestId).not.toBe("unknown");
    });
    const stop = startImapScheduler();
    await vi.advanceTimersByTimeAsync(1);
    stop();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.sync).toHaveBeenCalledWith("due");
  });
});
