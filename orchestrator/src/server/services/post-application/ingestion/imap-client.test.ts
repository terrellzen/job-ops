import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  connect: vi.fn(),
  close: vi.fn(),
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(options: Record<string, unknown>) {
      mocks.options.push(options);
    }
    on() {}
    connect = mocks.connect;
    close = mocks.close;
  },
}));

import { parseImapConfig } from "../providers/imap-credentials";
import { createImapClient, withImapConnection } from "./imap-client";

const config = parseImapConfig({
  email: "test@example.com",
  host: "imap.example.com",
  username: "test",
  password: "secret",
});
afterEach(() => {
  vi.clearAllMocks();
  mocks.options.length = 0;
  vi.useRealTimers();
});
describe("IMAP transport", () => {
  it("enforces validated TLS and disables protocol logging", () => {
    createImapClient(config);
    expect(mocks.options[0]).toMatchObject({
      secure: true,
      logger: false,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
    createImapClient({ ...config, security: "starttls", port: 143 });
    expect(mocks.options[1]).toMatchObject({ secure: false, doSTARTTLS: true });
  });
  it("does not retry authentication failures or expose upstream text", async () => {
    mocks.connect.mockRejectedValue({
      authenticationFailed: true,
      message: "secret credential",
    });
    await expect(withImapConnection(config, async () => null)).rejects.toThrow(
      /authentication failed/,
    );
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("reconnects with a new client after transient failures", async () => {
    vi.useFakeTimers();
    mocks.connect
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const pending = withImapConnection(config, async () => "done");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("done");
    expect(mocks.options).toHaveLength(2);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
