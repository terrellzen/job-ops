import { runWithRequestContext } from "@infra/request-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptImapCredentials,
  encryptImapCredentials,
  parseImapConfig,
  publicImapConfig,
} from "./imap-credentials";

const config = {
  email: "test@example.com",
  host: "imap.example.com",
  username: "test",
  password: "  ä-secret  ",
};
afterEach(() => vi.unstubAllEnvs());
describe("IMAP configuration and credential protection", () => {
  it("uses safe defaults and preserves password whitespace and Unicode", () => {
    expect(parseImapConfig(config)).toMatchObject({
      security: "tls",
      port: 993,
      mailbox: "INBOX",
      automaticSync: false,
      password: "  ä-secret  ",
    });
  });
  it("rejects plaintext transport, invalid ports, missing credentials and rapid polling", () => {
    for (const overrides of [
      { security: "none" },
      { port: 0 },
      { password: undefined },
      { syncIntervalMinutes: 1 },
      { host: "https://example.com" },
    ]) {
      expect(() => parseImapConfig({ ...config, ...overrides })).toThrow();
    }
    expect(
      parseImapConfig({
        ...config,
        password: undefined,
        authMethod: "oauth2",
        accessToken: "token",
      }).authMethod,
    ).toBe("oauth2");
  });
  it("requires an explicit persistent encryption key", () => {
    vi.stubEnv("EMAIL_CREDENTIALS_KEY", "");
    expect(() => encryptImapCredentials(config, "one")).toThrow(
      /EMAIL_CREDENTIALS_KEY/,
    );
  });
  it("encrypts at rest, authenticates tenant/account context, and detects tampering", () => {
    vi.stubEnv("EMAIL_CREDENTIALS_KEY", "ab".repeat(32));
    const encrypted = runWithRequestContext({ tenantId: "tenant-a" }, () =>
      encryptImapCredentials(config, "one"),
    );
    expect(JSON.stringify(encrypted)).not.toContain("secret");
    expect(
      runWithRequestContext({ tenantId: "tenant-a" }, () =>
        decryptImapCredentials(encrypted, "one"),
      ),
    ).toEqual(config);
    expect(() =>
      runWithRequestContext({ tenantId: "tenant-b" }, () =>
        decryptImapCredentials(encrypted, "one"),
      ),
    ).toThrow();
    expect(() =>
      runWithRequestContext({ tenantId: "tenant-a" }, () =>
        decryptImapCredentials(encrypted, "two"),
      ),
    ).toThrow();
    expect(() =>
      decryptImapCredentials({ ...encrypted, encrypted: "AAAA" }, "one"),
    ).toThrow();
  });
  it("never includes saved secrets in public settings", () => {
    const publicConfig = publicImapConfig({
      ...config,
      accessToken: "token",
      unexpected: "private",
    });
    expect(publicConfig).toMatchObject({
      hasPassword: true,
      hasAccessToken: true,
    });
    expect(publicConfig).not.toHaveProperty("password");
    expect(publicConfig).not.toHaveProperty("accessToken");
    expect(publicConfig).not.toHaveProperty("unexpected");
  });
});
