import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getPrivateDataScope } from "@server/tenancy/private-scope";
import { z } from "zod";
import { providerInvalidRequest, providerServiceUnavailable } from "./errors";

export const imapConfigSchema = z.object({
  email: z
    .string()
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  displayName: z.string().trim().max(120).optional(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/),
  port: z.number().int().min(1).max(65535).default(993),
  security: z.enum(["tls", "starttls"]).default("tls"),
  username: z.string().min(1).max(254),
  authMethod: z.enum(["password", "oauth2"]).default("password"),
  password: z.string().min(1).max(4096).optional(),
  accessToken: z.string().min(1).max(8192).optional(),
  mailbox: z.string().min(1).max(255).default("INBOX"),
  automaticSync: z.boolean().default(false),
  syncIntervalMinutes: z.number().int().min(5).max(1440).default(15),
  legacyNoticePromotionAllowed: z.boolean().optional(),
  uidValidity: z.string().optional(),
  lastUid: z.number().int().nonnegative().optional(),
  keywordFilterFingerprint: z.string().optional(),
  syncSearchDays: z.number().int().min(1).max(365).optional(),
  syncMaxMessages: z.number().int().min(1).max(500).optional(),
  searchCheckpoints: z
    .array(
      z.object({
        fingerprint: z.string(),
        searchDays: z.number().int(),
        uidValidity: z.string(),
        lastUid: z.number().int().nonnegative(),
      }),
    )
    .max(20)
    .optional(),
});
export type ImapConfig = z.infer<typeof imapConfigSchema>;
export function imapEndpointIdentity(config: ImapConfig): string {
  return JSON.stringify([
    config.host.toLowerCase().replace(/\.$/, ""),
    config.port,
    config.security,
    config.username,
    config.mailbox,
  ]);
}

export function parseImapConfig(value: unknown): ImapConfig {
  const parsed = imapConfigSchema.safeParse(value);
  if (!parsed.success)
    throw providerInvalidRequest(
      "Invalid IMAP settings. Check email, hostname, port, TLS, mailbox and sync frequency (5–1440 minutes).",
    );
  const config = parsed.data;
  if (
    !(config.authMethod === "password" ? config.password : config.accessToken)
  ) {
    throw providerInvalidRequest(
      "IMAP requires a password/app password or an OAuth2 access token for the selected authentication method.",
    );
  }
  return config;
}

function key(): Buffer {
  const raw = process.env.EMAIL_CREDENTIALS_KEY;
  if (!raw || !/^[a-fA-F0-9]{64}$/.test(raw))
    throw providerServiceUnavailable(
      "Set EMAIL_CREDENTIALS_KEY to a persistent 32-byte hexadecimal encryption key before connecting IMAP accounts.",
    );
  return Buffer.from(raw, "hex");
}
function aad(accountKey: string): Buffer {
  return Buffer.from(
    JSON.stringify([getPrivateDataScope().scopeKey, "imap", accountKey]),
  );
}
export function encryptImapCredentials(
  value: Record<string, unknown>,
  accountKey: string,
): Record<string, unknown> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(accountKey));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    encrypted: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
export function decryptImapCredentials(
  value: Record<string, unknown>,
  accountKey: string,
): Record<string, unknown> {
  const encryptionKey = key();
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(String(value.iv), "base64"),
    );
    decipher.setAAD(aad(accountKey));
    decipher.setAuthTag(Buffer.from(String(value.tag), "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(String(value.encrypted), "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw providerServiceUnavailable(
      "Cannot decrypt IMAP credentials. Restore the original EMAIL_CREDENTIALS_KEY.",
    );
  }
}
export function publicImapConfig(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) return null;
  const {
    email,
    host,
    port,
    security,
    username,
    authMethod,
    mailbox,
    automaticSync,
    syncIntervalMinutes,
  } = value;
  return {
    email,
    host,
    port,
    security,
    username,
    authMethod,
    mailbox,
    automaticSync,
    syncIntervalMinutes,
    hasPassword: Boolean(value.password),
    hasAccessToken: Boolean(value.accessToken),
  };
}
