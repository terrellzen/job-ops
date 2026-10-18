import {
  getTenantId,
  getUserId,
  runWithRequestContext,
} from "@infra/request-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  callJson: vi.fn(),
}));
vi.mock("@server/repositories/settings", () => ({
  getSetting: mocks.get,
  setSetting: mocks.set,
}));
vi.mock("@server/services/hosted-usage", () => ({
  withHostedUsageReservation: async (
    _input: unknown,
    operation: () => Promise<{ result: unknown }>,
  ) => (await operation()).result,
}));
vi.mock("@server/services/modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("test"),
  createConfiguredLlmService: vi
    .fn()
    .mockResolvedValue({ callJson: mocks.callJson }),
}));

import {
  getEmailKeywordFilter,
  saveEmailKeywordFilter,
  suggestEmailKeywords,
} from "./email-keywords";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReset();
  mocks.set.mockReset();
  mocks.callJson.mockReset();
});
describe("email keyword settings and suggestions", () => {
  it("loads each tenant and user's own settings without shared cached values", async () => {
    const values = new Map<string, string>();
    const scope = () => `${getTenantId()}:${getUserId()}`;
    mocks.get.mockImplementation(async () => values.get(scope()) ?? null);
    mocks.set.mockImplementation(async (_key, value) => {
      values.set(scope(), value);
    });
    for (const [tenantId, userId, term] of [
      ["a", "one", "candidature"],
      ["a", "two", "面接"],
      ["b", "one", "entrevista"],
    ]) {
      await runWithRequestContext({ tenantId, userId }, () =>
        saveEmailKeywordFilter({
          enabled: true,
          languages: [],
          customKeywords: [term],
        }),
      );
    }
    for (const [tenantId, userId, term] of [
      ["a", "one", "candidature"],
      ["a", "two", "面接"],
      ["b", "one", "entrevista"],
    ]) {
      const filter = await runWithRequestContext(
        { tenantId, userId },
        getEmailKeywordFilter,
      );
      expect(filter.customKeywords).toEqual([term]);
    }
  });
  it("sends only the selected language to AI and never saves suggestions automatically", async () => {
    mocks.callJson.mockResolvedValue({
      success: true,
      data: { keywords: ["candidature", "entretien"] },
    });
    expect(await suggestEmailKeywords("French")).toEqual([
      "candidature",
      "entretien",
    ]);
    const request = mocks.callJson.mock.calls[0][0];
    expect(JSON.parse(request.messages[1].content)).toEqual({
      language: "French",
    });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("sanitizes AI failures and validates AI suggestions", async () => {
    mocks.callJson.mockRejectedValue(new Error("raw private upstream body"));
    await expect(suggestEmailKeywords("Japanese")).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_ERROR",
      message: expect.not.stringContaining("raw private"),
    });
    mocks.callJson.mockResolvedValue({
      success: true,
      data: { keywords: ['"} OR secret'] },
    });
    await expect(suggestEmailKeywords("Japanese")).rejects.toMatchObject({
      status: 502,
    });
  });
});
