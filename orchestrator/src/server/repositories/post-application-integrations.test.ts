import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("encrypted IMAP integration repository", () => {
  let directory: string;
  beforeEach(async () => {
    vi.resetModules();
    directory = await mkdtemp(join(tmpdir(), "jobops-imap-"));
    vi.stubEnv("DATA_DIR", directory);
    vi.stubEnv("EMAIL_CREDENTIALS_KEY", "ab".repeat(32));
    vi.stubEnv("JOBOPS_APP_MODE", "local");
    await import("../db/migrate");
  });
  afterEach(async () => {
    const { closeDb } = await import("../db");
    closeDb();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it("encrypts database rows and isolates reads, updates and disconnects across tenants and hosted users", async () => {
    const { db, schema } = await import("../db");
    const { runWithRequestContext } = await import("@infra/request-context");
    const repo = await import("./post-application-integrations");
    await db
      .insert(schema.tenants)
      .values({ id: "other", name: "Other", slug: "other" });
    const create = () =>
      repo.upsertConnectedPostApplicationIntegration({
        provider: "imap",
        accountKey: "same",
        credentials: {
          email: "test@example.com",
          password: "private-password",
        },
      });
    const first = await create();
    const second = await runWithRequestContext({ tenantId: "other" }, create);
    expect(first.id).not.toBe(second.id);
    const raw = await db.select().from(schema.postApplicationIntegrations);
    expect(JSON.stringify(raw)).not.toContain("private-password");
    await runWithRequestContext({ tenantId: "other" }, () =>
      repo.disconnectPostApplicationIntegration("imap", "same"),
    );
    expect(
      (await repo.getPostApplicationIntegration("imap", "same"))?.credentials
        ?.password,
    ).toBe("private-password");
    await db.insert(schema.users).values([
      { id: "u1", username: "u1", passwordHash: "hash", passwordSalt: "salt" },
      { id: "u2", username: "u2", passwordHash: "hash", passwordSalt: "salt" },
    ]);
    vi.stubEnv("JOBOPS_APP_MODE", "hosted");
    vi.stubEnv("JOBOPS_HOSTED_TENANT_ID", "tenant_default");
    await runWithRequestContext(
      { tenantId: "tenant_default", userId: "u1" },
      create,
    );
    await runWithRequestContext(
      { tenantId: "tenant_default", userId: "u2" },
      async () => {
        expect(
          await repo.getPostApplicationIntegration("imap", "same"),
        ).toBeNull();
        expect(
          await repo.updatePostApplicationIntegrationSyncState({
            provider: "imap",
            accountKey: "same",
            lastError: "other",
          }),
        ).toBeNull();
        expect(await repo.listPostApplicationIntegrations()).toEqual([]);
      },
    );
  });
});
