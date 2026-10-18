import { conflict } from "@infra/errors";
import {
  disconnectPostApplicationIntegration,
  getPostApplicationIntegration,
  listPostApplicationIntegrations,
  upsertConnectedPostApplicationIntegration,
} from "@server/repositories/post-application-integrations";
import type { PostApplicationIntegration } from "@shared/types";
import { withImapConnection } from "../ingestion/imap-client";
import { runImapSync, withImapAccountLock } from "../ingestion/imap-sync";
import {
  encryptImapCredentials,
  parseImapConfig,
  publicImapConfig,
} from "./imap-credentials";
import type { PostApplicationProviderAdapter } from "./types";

function status(
  accountKey: string,
  integration: PostApplicationIntegration | null,
  message?: string,
) {
  return {
    status: {
      provider: "imap" as const,
      accountKey,
      connected: integration?.status === "connected",
      integration: integration
        ? {
            ...integration,
            credentials: publicImapConfig(integration.credentials),
          }
        : null,
    },
    message,
  };
}
export async function assertMailboxAvailable(
  email: string,
  provider: string,
  accountKey: string,
): Promise<void> {
  const accounts = await listPostApplicationIntegrations();
  if (
    accounts.some(
      (account) =>
        account.status !== "disconnected" &&
        !(account.provider === provider && account.accountKey === accountKey) &&
        String(account.credentials?.email || "").toLowerCase() ===
          email.toLowerCase(),
    )
  ) {
    throw conflict(
      "This mailbox is already connected. Disconnect its existing integration before adding it again.",
    );
  }
}
export const imapProvider: PostApplicationProviderAdapter = {
  key: "imap",
  async connect(args) {
    return withImapAccountLock(args.accountKey, async () => {
      const previous = await getPostApplicationIntegration(
        "imap",
        args.accountKey,
      );
      const raw = args.payload?.payload ?? {};
      // Omitted secrets preserve saved credentials only for the same login/server.
      const sameLogin =
        Boolean(previous?.credentials) &&
        previous?.credentials?.host === raw.host &&
        previous?.credentials?.username === raw.username &&
        previous?.credentials?.authMethod === (raw.authMethod ?? "password");
      const config = parseImapConfig({
        ...(sameLogin ? previous?.credentials : {}),
        ...raw,
        uidValidity: undefined,
        lastUid: undefined,
        searchCheckpoints: undefined,
      });
      encryptImapCredentials(config, args.accountKey); // Fail before network access if encryption is not configured.
      await assertMailboxAvailable(config.email, "imap", args.accountKey);
      await withImapConnection(config, async (client) => {
        await client.mailboxOpen(config.mailbox, { readOnly: true });
      });
      if (sameLogin && previous?.credentials?.mailbox === config.mailbox) {
        config.uidValidity = previous.credentials.uidValidity as
          | string
          | undefined;
        config.lastUid = previous.credentials.lastUid as number | undefined;
        config.searchCheckpoints = parseImapConfig(
          previous.credentials,
        ).searchCheckpoints;
      }
      const integration = await upsertConnectedPostApplicationIntegration({
        provider: "imap",
        accountKey: args.accountKey,
        displayName: config.displayName || config.email,
        credentials: config,
      });
      return status(
        args.accountKey,
        integration,
        "IMAP connection tested and saved.",
      );
    });
  },
  async status(args) {
    return status(
      args.accountKey,
      await getPostApplicationIntegration("imap", args.accountKey),
    );
  },
  async sync(args) {
    const count = await runImapSync(
      args.accountKey,
      args.payload?.maxMessages,
      args.payload?.searchDays,
    );
    return status(
      args.accountKey,
      await getPostApplicationIntegration("imap", args.accountKey),
      `Sync complete: ${count} messages processed. Review suggestions in Tracking Inbox.`,
    );
  },
  async disconnect(args) {
    return withImapAccountLock(args.accountKey, async () =>
      status(
        args.accountKey,
        await disconnectPostApplicationIntegration("imap", args.accountKey),
        "IMAP disconnected and credentials removed. Email history is retained.",
      ),
    );
  },
};
