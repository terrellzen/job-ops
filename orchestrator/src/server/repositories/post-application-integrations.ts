import { randomUUID } from "node:crypto";
import {
  decryptImapCredentials,
  encryptImapCredentials,
} from "@server/services/post-application/providers/imap-credentials";
import type {
  PostApplicationIntegration,
  PostApplicationIntegrationStatus,
  PostApplicationProvider,
} from "@shared/types";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import {
  getPrivateDataScope,
  privateDataScopeFilter,
} from "../tenancy/private-scope";

const { postApplicationIntegrations } = schema;

function integrationsScopeFilter() {
  return privateDataScopeFilter(postApplicationIntegrations);
}

type IntegrationCredentials = Record<string, unknown>;

type UpsertConnectedIntegrationInput = {
  provider: PostApplicationProvider;
  accountKey: string;
  displayName?: string | null;
  credentials: IntegrationCredentials;
};

type UpdatePostApplicationIntegrationSyncStateInput = {
  provider: PostApplicationProvider;
  accountKey: string;
  lastSyncedAt?: number | null;
  lastError?: string | null;
  credentials?: IntegrationCredentials | null;
  status?: PostApplicationIntegrationStatus;
};

function asCredentials(value: unknown): IntegrationCredentials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as IntegrationCredentials;
}

function mapRowToIntegration(
  row: typeof postApplicationIntegrations.$inferSelect,
): PostApplicationIntegration {
  return {
    id: row.id,
    provider: row.provider,
    accountKey: row.accountKey,
    displayName: row.displayName,
    status: row.status as PostApplicationIntegrationStatus,
    credentials:
      row.provider === "imap" && row.credentials
        ? decryptImapCredentials(
            asCredentials(row.credentials) ?? {},
            row.accountKey,
          )
        : asCredentials(row.credentials),
    lastConnectedAt: row.lastConnectedAt,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getPostApplicationIntegration(
  provider: PostApplicationProvider,
  accountKey: string,
): Promise<PostApplicationIntegration | null> {
  const [row] = await db
    .select()
    .from(postApplicationIntegrations)
    .where(
      and(
        eq(postApplicationIntegrations.provider, provider),
        eq(postApplicationIntegrations.accountKey, accountKey),
        integrationsScopeFilter(),
      ),
    );

  return row ? mapRowToIntegration(row) : null;
}

export async function upsertConnectedPostApplicationIntegration(
  input: UpsertConnectedIntegrationInput,
): Promise<PostApplicationIntegration> {
  const nowEpoch = Date.now();
  const nowIso = new Date(nowEpoch).toISOString();
  const scope = getPrivateDataScope();
  const existing = await getPostApplicationIntegration(
    input.provider,
    input.accountKey,
  );

  if (existing) {
    await db
      .update(postApplicationIntegrations)
      .set({
        displayName: input.displayName ?? existing.displayName,
        status: "connected",
        credentials:
          input.provider === "imap"
            ? encryptImapCredentials(input.credentials, input.accountKey)
            : input.credentials,
        lastConnectedAt: nowEpoch,
        lastError: null,
        updatedAt: nowIso,
      })
      .where(
        and(
          integrationsScopeFilter(),
          eq(postApplicationIntegrations.id, existing.id),
        ),
      );

    const updated = await getPostApplicationIntegration(
      input.provider,
      input.accountKey,
    );
    if (!updated) {
      throw new Error(
        `Failed to load updated integration ${input.provider}/${input.accountKey}.`,
      );
    }
    return updated;
  }

  const id = randomUUID();
  await db.insert(postApplicationIntegrations).values({
    id,
    tenantId: scope.tenantId,
    userId: scope.userId,
    provider: input.provider,
    accountKey: input.accountKey,
    displayName: input.displayName ?? null,
    status: "connected",
    credentials:
      input.provider === "imap"
        ? encryptImapCredentials(input.credentials, input.accountKey)
        : input.credentials,
    lastConnectedAt: nowEpoch,
    lastError: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const created = await getPostApplicationIntegration(
    input.provider,
    input.accountKey,
  );
  if (!created) {
    throw new Error(
      `Failed to load created integration ${input.provider}/${input.accountKey}.`,
    );
  }
  return created;
}

export async function disconnectPostApplicationIntegration(
  provider: PostApplicationProvider,
  accountKey: string,
): Promise<PostApplicationIntegration | null> {
  const [existing] = await db
    .select()
    .from(postApplicationIntegrations)
    .where(
      and(
        integrationsScopeFilter(),
        eq(postApplicationIntegrations.provider, provider),
        eq(postApplicationIntegrations.accountKey, accountKey),
      ),
    );
  if (!existing) return null;

  const nowIso = new Date().toISOString();
  await db
    .update(postApplicationIntegrations)
    .set({
      status: "disconnected",
      credentials: null,
      lastError: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        integrationsScopeFilter(),
        eq(postApplicationIntegrations.id, existing.id),
      ),
    );

  return getPostApplicationIntegration(provider, accountKey);
}

export async function updatePostApplicationIntegrationSyncState(
  input: UpdatePostApplicationIntegrationSyncStateInput,
): Promise<PostApplicationIntegration | null> {
  const existing = await getPostApplicationIntegration(
    input.provider,
    input.accountKey,
  );
  if (!existing) return null;

  const nowIso = new Date().toISOString();
  await db
    .update(postApplicationIntegrations)
    .set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.lastSyncedAt !== undefined
        ? { lastSyncedAt: input.lastSyncedAt }
        : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      ...(input.credentials !== undefined
        ? {
            credentials:
              input.provider === "imap" && input.credentials
                ? encryptImapCredentials(input.credentials, input.accountKey)
                : input.credentials,
          }
        : {}),
      updatedAt: nowIso,
    })
    .where(
      and(
        integrationsScopeFilter(),
        eq(postApplicationIntegrations.id, existing.id),
      ),
    );

  return getPostApplicationIntegration(input.provider, input.accountKey);
}

export async function listPostApplicationIntegrations(): Promise<
  PostApplicationIntegration[]
> {
  const rows = await db
    .select()
    .from(postApplicationIntegrations)
    .where(integrationsScopeFilter());
  return rows.map((row) => {
    try {
      return mapRowToIntegration(row);
    } catch (error) {
      if (row.provider !== "imap") throw error;
      return {
        ...mapRowToIntegration({ ...row, credentials: null }),
        status: "error" as const,
        lastError:
          "IMAP credentials could not be decrypted. Restore EMAIL_CREDENTIALS_KEY, or remove and reconnect this account.",
      };
    }
  });
}

// System scheduler enumerates identities only; private data is loaded within restored scope.
export async function listImapAccountOwners() {
  return db
    .select({
      tenantId: postApplicationIntegrations.tenantId,
      userId: postApplicationIntegrations.userId,
      accountKey: postApplicationIntegrations.accountKey,
    })
    .from(postApplicationIntegrations)
    .where(
      and(
        eq(postApplicationIntegrations.provider, "imap"),
        eq(postApplicationIntegrations.status, "connected"),
      ),
    );
}
