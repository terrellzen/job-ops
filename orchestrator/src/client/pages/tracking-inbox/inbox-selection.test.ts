import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetApiClientAuthForTests,
  setAuthenticatedSession,
} from "@/client/api/auth-session";
import { loadInboxSelection, saveInboxSelection } from "./inbox-selection";

function signIn(tenantId: string, userId: string) {
  setAuthenticatedSession(
    `header.${btoa(JSON.stringify({ tenantId, userId }))}.signature`,
  );
}
beforeEach(() => {
  localStorage.clear();
  __resetApiClientAuthForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __resetApiClientAuthForTests();
});
describe("Tracking Inbox last-used account", () => {
  it("remembers provider and separate accounts across visits, while explicit links take precedence", () => {
    signIn("workspace-a", "user-one");
    saveInboxSelection("gmail", "google-account");
    saveInboxSelection("imap", "imap-account");
    expect(loadInboxSelection("")).toEqual({
      provider: "imap",
      accountKey: "imap-account",
    });
    expect(loadInboxSelection("?provider=gmail")).toEqual({
      provider: "gmail",
      accountKey: "google-account",
    });
    expect(
      loadInboxSelection("?provider=imap&accountKey=linked-account"),
    ).toEqual({ provider: "imap", accountKey: "linked-account" });
  });
  it("isolates selections between users and workspaces and avoids anonymous persistence", () => {
    signIn("workspace-a", "user-one");
    saveInboxSelection("imap", "private-account");
    signIn("workspace-a", "user-two");
    expect(loadInboxSelection("")).toEqual({
      provider: "gmail",
      accountKey: "default",
    });
    signIn("workspace-b", "user-one");
    expect(loadInboxSelection("")).toEqual({
      provider: "gmail",
      accountKey: "default",
    });
    signIn("workspace-a", "user-one");
    expect(loadInboxSelection("").accountKey).toBe("private-account");
    __resetApiClientAuthForTests();
    saveInboxSelection("imap", "anonymous");
    expect(loadInboxSelection("")).toEqual({
      provider: "gmail",
      accountKey: "default",
    });
  });
  it("falls back safely when browser storage is unavailable", () => {
    signIn("workspace-a", "user-one");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(loadInboxSelection("?provider=imap")).toEqual({
      provider: "imap",
      accountKey: "default",
    });
    expect(() => saveInboxSelection("imap", "account")).not.toThrow();
  });
});
