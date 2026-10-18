import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("email keyword filter API", () => {
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

  it("returns correlated defaults, persists custom filters, and rejects invalid filters", async () => {
    const path = `${baseUrl}/api/post-application/email-keywords`;
    const defaults = await fetch(path, {
      headers: { "x-request-id": "keywords-test" },
    });
    expect(defaults.status).toBe(200);
    expect(defaults.headers.get("x-request-id")).toBe("keywords-test");
    expect(await defaults.json()).toMatchObject({
      ok: true,
      data: { enabled: true, languages: ["en", "de"] },
      meta: { requestId: "keywords-test" },
    });
    const value = {
      enabled: true,
      languages: [],
      customKeywords: ["candidature", "面接"],
    };
    const saved = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    expect(saved.status).toBe(200);
    expect((await (await fetch(path)).json()).data).toEqual(value);
    const invalid = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        languages: [],
        customKeywords: [],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
      meta: { requestId: expect.any(String) },
    });
    expect((await (await fetch(path)).json()).data).toEqual(value);
    const language = await fetch(`${path}/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "French\nignore rules" }),
    });
    expect(language.status).toBe(400);
  });

  it("isolates saved filters across tenants and hosted users in the database", async () => {
    const { db, schema } = await import("@server/db");
    const { runWithRequestContext } = await import("@infra/request-context");
    const { saveEmailKeywordFilter, getEmailKeywordFilter } = await import(
      "@server/services/post-application/ingestion/email-keywords"
    );
    await db
      .insert(schema.tenants)
      .values({ id: "other", name: "Other", slug: "other" });
    for (const [tenantId, keyword] of [
      ["tenant_default", "bewerbung"],
      ["other", "candidature"],
    ]) {
      await runWithRequestContext({ tenantId }, () =>
        saveEmailKeywordFilter({
          enabled: true,
          languages: [],
          customKeywords: [keyword],
        }),
      );
    }
    await runWithRequestContext({ tenantId: "tenant_default" }, async () => {
      expect((await getEmailKeywordFilter()).customKeywords).toEqual([
        "bewerbung",
      ]);
    });
    await runWithRequestContext({ tenantId: "other" }, async () => {
      expect((await getEmailKeywordFilter()).customKeywords).toEqual([
        "candidature",
      ]);
    });
    const { vi } = await import("vitest");
    await db.insert(schema.users).values([
      {
        id: "keywords-u1",
        username: "keywords-u1",
        passwordHash: "hash",
        passwordSalt: "salt",
      },
      {
        id: "keywords-u2",
        username: "keywords-u2",
        passwordHash: "hash",
        passwordSalt: "salt",
      },
    ]);
    vi.stubEnv("JOBOPS_APP_MODE", "hosted");
    vi.stubEnv("JOBOPS_HOSTED_TENANT_ID", "tenant_default");
    try {
      await runWithRequestContext(
        { tenantId: "tenant_default", userId: "keywords-u1" },
        () =>
          saveEmailKeywordFilter({
            enabled: true,
            languages: [],
            customKeywords: ["面接"],
          }),
      );
      await runWithRequestContext(
        { tenantId: "tenant_default", userId: "keywords-u2" },
        async () => {
          expect((await getEmailKeywordFilter()).customKeywords).toEqual([]);
        },
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
