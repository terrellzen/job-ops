import type { PostApplicationProvider } from "@shared/types";
import { getCurrentAuthUserStorageScope } from "@/client/api/auth-session";

type SavedSelection = {
  provider: PostApplicationProvider;
  accounts: Partial<Record<PostApplicationProvider, string>>;
};
function storageKey(): string | null {
  const scope = getCurrentAuthUserStorageScope();
  return scope ? `jobops.trackingInbox.selection:${scope}` : null;
}
function readSelection(): SavedSelection {
  const fallback: SavedSelection = { provider: "gmail", accounts: {} };
  try {
    const key = storageKey();
    const raw = key ? localStorage.getItem(key) : null;
    if (!raw || raw.length > 2048) return fallback;
    const value = JSON.parse(raw);
    if (!value || !["gmail", "imap"].includes(value.provider)) return fallback;
    const accounts: SavedSelection["accounts"] = {};
    for (const provider of ["gmail", "imap"] as const) {
      const account = value.accounts?.[provider];
      if (
        typeof account === "string" &&
        account.trim() &&
        account.length <= 255
      )
        accounts[provider] = account;
    }
    return { provider: value.provider, accounts };
  } catch {
    return fallback;
  }
}
export function loadInboxSelection(search: string): {
  provider: PostApplicationProvider;
  accountKey: string;
} {
  const saved = readSelection();
  const params = new URLSearchParams(search);
  const requested = params.get("provider");
  const provider =
    requested === "imap" || requested === "gmail" ? requested : saved.provider;
  const requestedAccount = params.get("accountKey");
  return {
    provider,
    accountKey:
      requestedAccount?.trim() && requestedAccount.length <= 255
        ? requestedAccount
        : (saved.accounts[provider] ?? "default"),
  };
}
export function saveInboxSelection(
  provider: PostApplicationProvider,
  accountKey: string,
): void {
  if (!accountKey.trim() || accountKey.length > 255) return;
  try {
    const key = storageKey();
    if (!key) return;
    const saved = readSelection();
    localStorage.setItem(
      key,
      JSON.stringify({
        provider,
        accounts: { ...saved.accounts, [provider]: accountKey },
      }),
    );
  } catch {
    /* Storage may be disabled; selection still works for this visit. */
  }
}
