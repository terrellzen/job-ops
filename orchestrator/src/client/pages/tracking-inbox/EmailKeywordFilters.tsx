import {
  defaultEmailKeywordFilter,
  EMAIL_KEYWORD_PRESETS,
  type EmailKeywordFilter,
  emailKeywordFilterSchema,
} from "@shared/email-keywords";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { fetchApi } from "@/client/api/core";
import { showErrorToast } from "@/client/lib/error-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function EmailKeywordFilters({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["email-keywords"],
    queryFn: () =>
      fetchApi<EmailKeywordFilter>("/post-application/email-keywords"),
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState(defaultEmailKeywordFilter);
  const [customText, setCustomText] = useState("");
  const [language, setLanguage] = useState("French");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    setDraft(query.data);
    setCustomText(query.data.customKeywords.join("\n"));
  }, [query.data]);
  const value = {
    ...draft,
    customKeywords: [
      ...new Set(
        customText
          .split(/[,\n]/)
          .map((term) => term.trim())
          .filter(Boolean),
      ),
    ],
  };
  const validation = emailKeywordFilterSchema.safeParse(value);
  const busy = disabled || saving || query.isPending || Boolean(query.error);
  const dirty = JSON.stringify(value) !== JSON.stringify(query.data);
  const save = async () => {
    if (!validation.success) return;
    setSaving(true);
    try {
      const saved = await fetchApi<EmailKeywordFilter>(
        "/post-application/email-keywords",
        {
          method: "PATCH",
          body: JSON.stringify(validation.data),
        },
      );
      queryClient.setQueryData(["email-keywords"], saved);
      toast.success("Email search filters saved. They apply to the next sync.");
    } catch (error) {
      showErrorToast(error, "Could not save email filters");
    } finally {
      setSaving(false);
    }
  };
  const suggest = async () => {
    setSuggesting(true);
    setSuggestions([]);
    try {
      const result = await fetchApi<{ keywords: string[] }>(
        "/post-application/email-keywords/suggest",
        {
          method: "POST",
          body: JSON.stringify({ language }),
        },
      );
      setSuggestions(result.keywords);
    } catch (error) {
      showErrorToast(error, "Could not suggest keywords");
    } finally {
      setSuggesting(false);
    }
  };
  return (
    <section
      className="space-y-4 border-y py-4"
      aria-labelledby="email-keywords-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="email-keywords-title" className="text-sm font-medium">
            Email search keywords
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Find application updates before AI classification. Saved filters
            apply to all your accounts and automatic syncs.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, enabled: event.target.checked })
            }
          />
          Filter by keywords
        </label>
      </div>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load email filters.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      <div className="flex flex-wrap gap-5">
        {(["en", "de"] as const).map((code) => (
          <label key={code} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.languages.includes(code)}
              disabled={busy || !draft.enabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  languages: event.target.checked
                    ? [...draft.languages, code]
                    : draft.languages.filter((item) => item !== code),
                })
              }
            />
            {code === "en" ? "English" : "German"}
          </label>
        ))}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">View preset keywords</summary>
        <div className="mt-2 space-y-2">
          <p>
            <strong>English:</strong> {EMAIL_KEYWORD_PRESETS.en.join(", ")}
          </p>
          <p>
            <strong>German:</strong> {EMAIL_KEYWORD_PRESETS.de.join(", ")}
          </p>
        </div>
      </details>
      <div className="space-y-2">
        <Label htmlFor="email-custom-keywords">Custom keywords</Label>
        <Textarea
          id="email-custom-keywords"
          value={customText}
          disabled={busy}
          rows={3}
          placeholder="candidature, entretien, رفض الطلب"
          onChange={(event) => setCustomText(event.target.value)}
          aria-describedby="email-keywords-help"
        />
        <p id="email-keywords-help" className="text-xs text-muted-foreground">
          One word or phrase per line, or separated by commas. Any matching
          keyword in the subject or body qualifies. Up to 100 custom keywords,
          2–100 characters each.
        </p>
      </div>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">
          Suggest keywords with AI
        </summary>
        <p className="text-xs text-muted-foreground mt-3">
          Choose a language to get editable suggestions. Uses your configured AI
          and sends only the language name.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-2 flex-1 min-w-40">
            <Label htmlFor="email-keyword-language">Language</Label>
            <Input
              id="email-keyword-language"
              list="email-keyword-languages"
              value={language}
              maxLength={80}
              onChange={(event) => {
                setLanguage(event.target.value);
                setSuggestions([]);
              }}
              disabled={busy || suggesting}
            />
            <datalist id="email-keyword-languages">
              {[
                "English",
                "German",
                "French",
                "Spanish",
                "Italian",
                "Portuguese",
                "Dutch",
                "Polish",
                "Arabic",
                "Japanese",
                "Chinese",
                "Ukrainian",
                "Turkish",
              ].map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy || suggesting || language.trim().length < 2}
            onClick={() => void suggest()}
          >
            {suggesting ? "Suggesting…" : "Suggest keywords"}
          </Button>
        </div>
        {suggestions.length > 0 && (
          <div className="space-y-2 text-sm">
            <p>{suggestions.join(", ")}</p>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setCustomText(
                  [...value.customKeywords, ...suggestions].join("\n"),
                );
                setSuggestions([]);
              }}
            >
              Add to custom keywords
            </Button>
            <p className="text-xs text-muted-foreground">
              Edit the list above, then save your filters.
            </p>
          </div>
        )}
      </details>
      {!validation.success && (
        <p role="alert" className="text-sm text-destructive">
          {validation.error.issues[0]?.message}
        </p>
      )}
      {!draft.enabled && (
        <p className="text-xs text-muted-foreground">
          All emails in the date window are eligible. Your keywords are
          retained.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !dirty || !validation.success}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save filters"}
        </Button>
        {dirty && !query.isPending && (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        )}
        <p className="text-xs text-muted-foreground">
          Keywords can miss unusual wording. Disable filtering to search all
          languages. Changing filters starts a new IMAP search in the date
          window; saved emails stay deduplicated.
        </p>
      </div>
    </section>
  );
}
