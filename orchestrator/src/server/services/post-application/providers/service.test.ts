import type { PostApplicationIntegration } from "@shared/types";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ingestion/imap-client", () => ({
  withImapConnection: vi
    .fn()
    .mockImplementation(
      async (
        _config: unknown,
        operation: (client: unknown) => Promise<unknown>,
      ) => operation({ mailboxOpen: vi.fn().mockResolvedValue({}) }),
    ),
}));

vi.mock("@server/repositories/post-application-integrations", () => ({
  listPostApplicationIntegrations: vi.fn().mockResolvedValue([]),
  getPostApplicationIntegration: vi.fn().mockResolvedValue(null),
  upsertConnectedPostApplicationIntegration: vi.fn().mockImplementation(
    async ({
      provider,
      accountKey,
      displayName,
      credentials,
    }: {
      provider: "gmail";
      accountKey: string;
      displayName: string;
      credentials: Record<string, unknown>;
    }) =>
      ({
        id: "integration-test",
        provider,
        accountKey,
        displayName,
        status: "connected",
        credentials,
        lastConnectedAt: Date.now(),
        lastSyncedAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) satisfies PostApplicationIntegration,
  ),
  disconnectPostApplicationIntegration: vi.fn().mockImplementation(
    async (provider: "gmail", accountKey: string) =>
      ({
        id: "integration-test",
        provider,
        accountKey,
        displayName: "Gmail (default)",
        status: "disconnected",
        credentials: null,
        lastConnectedAt: Date.now(),
        lastSyncedAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) satisfies PostApplicationIntegration,
  ),
}));

const integrationRepo = await import(
  "@server/repositories/post-application-integrations"
);

import {
  PostApplicationProviderError,
  providerUpstreamError,
  toProviderAppError,
} from "./errors";
import {
  listPostApplicationProviders,
  resolvePostApplicationProvider,
} from "./registry";
import { executePostApplicationProviderAction } from "./service";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(integrationRepo.getPostApplicationIntegration).mockResolvedValue(
    null,
  );
  vi.mocked(integrationRepo.listPostApplicationIntegrations).mockResolvedValue(
    [],
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("post-application provider registry", () => {
  it("lists registered providers", () => {
    expect(listPostApplicationProviders()).toEqual(["gmail", "imap"]);
  });

  it("resolves a known provider", () => {
    const provider = resolvePostApplicationProvider("gmail");
    expect(provider.key).toBe("gmail");
  });

  it("throws explicit invalid-request error for unknown provider", () => {
    expect(() => resolvePostApplicationProvider("exchange")).toThrowError(
      PostApplicationProviderError,
    );

    try {
      resolvePostApplicationProvider("exchange");
      throw new Error("expected resolve to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PostApplicationProviderError);
      expect((error as PostApplicationProviderError).kind).toBe(
        "invalid_request",
      );
    }
  });
});

describe("post-application provider action dispatcher", () => {
  it("connects gmail and persists credentials in the integrations store", async () => {
    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "connect",
      accountKey: "account:gmail:test",
      connectPayload: {
        payload: {
          refreshToken: "refresh-token",
          accessToken: "access-token",
          email: "candidate@example.com",
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        },
      },
    });

    expect(
      integrationRepo.upsertConnectedPostApplicationIntegration,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gmail",
        accountKey: "account:gmail:test",
      }),
    );
    expect(response.status.connected).toBe(true);
    expect(response.message).toBe("Gmail integration connected.");
    expect(response.status.integration?.credentials).toEqual(
      expect.objectContaining({
        hasRefreshToken: true,
        hasAccessToken: true,
        email: "candidate@example.com",
      }),
    );
  });

  it("dispatches status action to gmail provider", async () => {
    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "status",
      accountKey: "account:gmail:test",
    });

    expect(response).toEqual({
      provider: "gmail",
      action: "status",
      accountKey: "account:gmail:test",
      status: {
        provider: "gmail",
        accountKey: "account:gmail:test",
        connected: false,
        integration: null,
      },
      message: "Gmail provider is not connected.",
    });
  });

  it("disconnects gmail and clears credentials from integration store", async () => {
    const getIntegrationMock =
      integrationRepo.getPostApplicationIntegration as Mock;
    getIntegrationMock.mockResolvedValueOnce({
      id: "integration-test",
      provider: "gmail",
      accountKey: "account:gmail:test",
      displayName: "Gmail (default)",
      status: "connected",
      credentials: {
        refreshToken: "refresh-token",
      },
      lastConnectedAt: Date.now(),
      lastSyncedAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies PostApplicationIntegration);

    const response = await executePostApplicationProviderAction({
      provider: "gmail",
      action: "disconnect",
      accountKey: "account:gmail:test",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(
      integrationRepo.disconnectPostApplicationIntegration,
    ).toHaveBeenCalledWith("gmail", "account:gmail:test");
    expect(response.status.connected).toBe(false);
    expect(response.message).toBe("Gmail integration disconnected.");
    expect(response.status.integration?.credentials).toEqual(
      expect.objectContaining({
        hasRefreshToken: false,
        hasAccessToken: false,
      }),
    );
  });

  it("returns invalid request when gmail connect payload is missing refresh token", async () => {
    await expect(
      executePostApplicationProviderAction({
        provider: "gmail",
        action: "connect",
        accountKey: "account:gmail:test",
        connectPayload: { payload: {} },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
  });

  it("rejects IMAP connections without valid settings", async () => {
    await expect(
      executePostApplicationProviderAction({
        provider: "imap",
        action: "connect",
        accountKey: "account:imap:test",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
  });

  it("tests and saves IMAP configuration without returning the saved password", async () => {
    vi.stubEnv("EMAIL_CREDENTIALS_KEY", "ab".repeat(32));
    const response = await executePostApplicationProviderAction({
      provider: "imap",
      action: "connect",
      accountKey: "work",
      connectPayload: {
        payload: {
          email: "test@example.com",
          host: "imap.example.com",
          username: "test@example.com",
          password: "private-password",
        },
      },
    });
    expect(response.status.connected).toBe(true);
    expect(response.status.integration?.credentials).toMatchObject({
      hasPassword: true,
      host: "imap.example.com",
    });
    expect(JSON.stringify(response)).not.toContain("private-password");
  });

  it("prevents connecting a Gmail mailbox already configured through IMAP", async () => {
    vi.mocked(
      integrationRepo.listPostApplicationIntegrations,
    ).mockResolvedValue([
      {
        id: "imap",
        provider: "imap",
        accountKey: "one",
        status: "connected",
        credentials: { email: "test@example.com" },
        displayName: null,
        lastConnectedAt: null,
        lastSyncedAt: null,
        lastError: null,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ]);
    await expect(
      executePostApplicationProviderAction({
        provider: "gmail",
        action: "connect",
        accountKey: "two",
        connectPayload: {
          payload: { refreshToken: "secret", email: "test@example.com" },
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(
      integrationRepo.upsertConnectedPostApplicationIntegration,
    ).not.toHaveBeenCalled();
  });

  it("maps upstream provider errors to upstream app errors", () => {
    const appError = toProviderAppError(
      providerUpstreamError("Provider API timed out"),
    );

    expect(appError.status).toBe(502);
    expect(appError.code).toBe("UPSTREAM_ERROR");
    expect(appError.message).toBe("Provider API timed out");
  });
});
