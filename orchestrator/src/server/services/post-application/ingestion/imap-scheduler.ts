import { randomUUID } from "node:crypto";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import {
  getPostApplicationIntegration,
  listImapAccountOwners,
} from "@server/repositories/post-application-integrations";
import { runImapSync } from "./imap-sync";

export function startImapScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const owner of await listImapAccountOwners()) {
        await runWithRequestContext(
          {
            requestId: randomUUID(),
            tenantId: owner.tenantId,
            userId: owner.userId ?? undefined,
          },
          async () => {
            try {
              const account = await getPostApplicationIntegration(
                "imap",
                owner.accountKey,
              );
              const settings = account?.credentials;
              if (!settings?.automaticSync) return;
              const interval =
                Math.max(5, Number(settings.syncIntervalMinutes) || 15) * 60000;
              if (
                account?.lastSyncedAt &&
                Date.now() - account.lastSyncedAt < interval
              )
                return;
              await runImapSync(owner.accountKey);
            } catch {
              logger.warn(
                "Scheduled IMAP sync failed; retry on next interval",
                { provider: "imap", accountKey: owner.accountKey },
              );
            }
          },
        );
      }
    } catch {
      logger.warn("IMAP scheduler could not enumerate accounts", {
        provider: "imap",
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 60000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
