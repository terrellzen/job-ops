import type { PostApplicationIntegration } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { fetchApi } from "@/client/api/core";
import {
  postApplicationProviderConnect,
  postApplicationProviderDisconnect,
  postApplicationProviderSync,
} from "@/client/api/post-application";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const presets: Record<string, string> = {
  Manual: "",
  Gmail: "imap.gmail.com",
  Outlook: "outlook.office365.com",
  GMX: "imap.gmx.net",
  "WEB.DE": "imap.web.de",
  IONOS: "imap.ionos.de",
};
const defaults = {
  email: "",
  displayName: "",
  host: "",
  port: 993,
  security: "tls",
  username: "",
  authMethod: "password",
  mailbox: "INBOX",
  automaticSync: false,
  syncIntervalMinutes: 15,
};
export function EmailAccountsSection() {
  const query = useQuery({
    queryKey: ["email-accounts"],
    queryFn: () =>
      fetchApi<{ accounts: PostApplicationIntegration[] }>(
        "/post-application/accounts",
      ),
  });
  const [draft, setDraft] = useState(defaults);
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [mailboxes, setMailboxes] = useState<string[]>([]);
  const stableAccountKey = async () => {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(draft.email.trim().toLowerCase()),
    );
    return Array.from(new Uint8Array(bytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };
  const payload = {
    ...draft,
    ...(secret
      ? {
          [draft.authMethod === "password" ? "password" : "accessToken"]:
            secret,
        }
      : {}),
  };
  const action = async (operation: () => Promise<string>) => {
    setBusy(true);
    setFeedback("");
    try {
      setFeedback(await operation());
      await query.refetch();
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "Email operation failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  const edit = (account: PostApplicationIntegration) => {
    setAccountKey(account.accountKey);
    setDraft({
      ...defaults,
      ...account.credentials,
      displayName: account.displayName || "",
    } as typeof defaults);
    setSecret("");
    setMailboxes([]);
    setFeedback("");
  };
  return (
    <section className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Connect an IMAP mailbox to find application updates. Suggestions appear
        in Tracking Inbox for your review. Gmail OAuth is also available there.
      </p>
      {query.isPending && <output>Loading accounts…</output>}
      {query.error && <p role="alert">Could not load email accounts.</p>}
      <div className="divide-y">
        {(query.data?.accounts || []).map((account) => (
          <article key={account.id} className="py-4 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">
                  {account.displayName || account.accountKey}
                </p>
                <p className="text-sm text-muted-foreground">
                  {account.provider.toUpperCase()} · {account.status} ·{" "}
                  {account.credentials?.email as string}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {account.provider === "imap" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => edit(account)}
                  >
                    Edit
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(
                      async () =>
                        (
                          await postApplicationProviderSync({
                            provider: account.provider,
                            accountKey: account.accountKey,
                          })
                        ).message || "Sync complete.",
                    )
                  }
                >
                  Sync Now
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await postApplicationProviderDisconnect({
                        provider: account.provider,
                        accountKey: account.accountKey,
                      });
                      if (accountKey === account.accountKey) {
                        setAccountKey(null);
                        setDraft(defaults);
                        setSecret("");
                      }
                      return "Account removed. History retained.";
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Last sync:{" "}
              {account.lastSyncedAt
                ? new Date(account.lastSyncedAt).toLocaleString()
                : "Never"}
            </p>
            {account.lastError && (
              <p className="text-sm text-destructive">{account.lastError}</p>
            )}
            <Link
              className="text-sm underline"
              to={`/tracking-inbox?provider=${account.provider}&accountKey=${encodeURIComponent(account.accountKey)}`}
            >
              Review messages and update history
            </Link>
          </article>
        ))}
      </div>
      <div className="border-t pt-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">
            {accountKey ? "Edit email account" : "Add email account"}
          </h3>
          {accountKey && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setAccountKey(null);
                setDraft(defaults);
                setSecret("");
              }}
            >
              Add another account
            </Button>
          )}
        </div>
        <label className="block text-sm space-y-2">
          Provider preset
          <select
            className="block w-full rounded-md border bg-background p-2"
            defaultValue="Manual"
            onChange={(event) =>
              setDraft({
                ...draft,
                host: presets[event.target.value],
                port: 993,
                security: "tls",
              })
            }
          >
            {Object.keys(presets).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["email", "Email address"],
              ["displayName", "Display name"],
              ["host", "IMAP hostname"],
              ["username", "Username"],
              ["mailbox", "Mailbox"],
            ] as const
          ).map(([key, label]) => (
            <label
              className="text-sm space-y-2"
              key={key}
              htmlFor={`imap-${key}`}
            >
              {label}
              <Input
                id={`imap-${key}`}
                value={draft[key]}
                list={key === "mailbox" ? "imap-mailboxes" : undefined}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    [key]: event.target.value,
                    ...(key === "email" &&
                    (!draft.username || draft.username === draft.email)
                      ? { username: event.target.value }
                      : {}),
                  })
                }
              />
            </label>
          ))}
          <datalist id="imap-mailboxes">
            {mailboxes.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <label className="text-sm space-y-2" htmlFor="imap-port">
            Port
            <Input
              type="number"
              id="imap-port"
              value={draft.port}
              onChange={(event) =>
                setDraft({ ...draft, port: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-sm space-y-2">
            Security
            <select
              className="block w-full rounded-md border bg-background p-2"
              value={draft.security}
              onChange={(event) =>
                setDraft({ ...draft, security: event.target.value })
              }
            >
              <option value="tls">TLS / SSL</option>
              <option value="starttls">Required STARTTLS</option>
            </select>
          </label>
          <label className="text-sm space-y-2">
            Authentication
            <select
              className="block w-full rounded-md border bg-background p-2"
              value={draft.authMethod}
              onChange={(event) => {
                setDraft({ ...draft, authMethod: event.target.value });
                setSecret("");
              }}
            >
              <option value="password">Password / app password</option>
              <option value="oauth2">OAuth2 / XOAUTH2 access token</option>
            </select>
          </label>
          <label className="text-sm space-y-2" htmlFor="imap-secret">
            {draft.authMethod === "password"
              ? "Password / app password"
              : "OAuth2 access token"}
            <Input
              id="imap-secret"
              type="password"
              autoComplete="new-password"
              value={secret}
              placeholder={
                accountKey ? "Leave blank to keep saved credential" : ""
              }
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <label className="text-sm space-y-2" htmlFor="imap-frequency">
            Sync frequency (minutes)
            <Input
              type="number"
              min={5}
              max={1440}
              id="imap-frequency"
              value={draft.syncIntervalMinutes}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  syncIntervalMinutes: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.automaticSync}
            onChange={(event) =>
              setDraft({ ...draft, automaticSync: event.target.checked })
            }
          />
          Enable automatic synchronization
        </label>
        <p className="text-xs text-muted-foreground">
          TLS is required. OAuth2 tokens must be supplied and renewed manually;
          use Gmail OAuth in Tracking Inbox for managed Gmail authorization.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await fetchApi<{
                  message: string;
                  mailboxes: string[];
                }>("/post-application/providers/imap/test", {
                  method: "POST",
                  body: JSON.stringify({ payload, accountKey }),
                });
                setMailboxes(result.mailboxes);
                return result.message;
              })
            }
          >
            Test Connection
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await postApplicationProviderConnect({
                  provider: "imap",
                  accountKey: accountKey || (await stableAccountKey()),
                  payload,
                });
                setSecret("");
                setAccountKey(result.accountKey);
                return result.message || "Account saved.";
              })
            }
          >
            {busy ? "Working…" : "Save account"}
          </Button>
        </div>
        {feedback && (
          <output className="block text-sm break-words">{feedback}</output>
        )}
      </div>
    </section>
  );
}
