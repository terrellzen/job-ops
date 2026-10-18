import { ImapFlow } from "imapflow";
import { providerUpstreamError } from "../providers/errors";
import type { ImapConfig } from "../providers/imap-credentials";

export function createImapClient(config: ImapConfig): ImapFlow {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    ...(config.security === "starttls" ? { doSTARTTLS: true } : {}),
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth:
      config.authMethod === "oauth2"
        ? { user: config.username, accessToken: config.accessToken }
        : { user: config.username, pass: config.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    maxLiteralSize: 5 * 1024 * 1024,
    maxResponseSize: 6 * 1024 * 1024,
    maxLineLength: 64 * 1024,
  });
  // Never expose protocol errors: servers can echo credentials and message contents.
  client.on("error", () => {});
  return client;
}
export function imapFailure(error: unknown): Error {
  if (
    error &&
    typeof error === "object" &&
    "authenticationFailed" in error &&
    error.authenticationFailed
  ) {
    return providerUpstreamError(
      "IMAP authentication failed. Check the username, app password or OAuth2 token and enable IMAP at your provider.",
    );
  }
  return providerUpstreamError(
    "IMAP connection or synchronization failed. Check hostname, port, TLS certificate, mailbox and provider availability, then retry.",
  );
}
export async function withImapConnection<T>(
  config: ImapConfig,
  operation: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = createImapClient(config);
    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      const authenticationFailed =
        error &&
        typeof error === "object" &&
        "authenticationFailed" in error &&
        error.authenticationFailed;
      if (authenticationFailed || attempt === 2) throw imapFailure(error);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    } finally {
      client.close();
    }
  }
  throw imapFailure(null);
}
