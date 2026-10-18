import type { ApplicationAttempt } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchApi } from "@/client/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ApplicationAttemptsPanel({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["application-attempts", jobId],
    queryFn: () =>
      fetchApi<{ attempts: ApplicationAttempt[] }>(
        `/post-application/jobs/${encodeURIComponent(jobId)}/attempts`,
      ),
  });
  const [adding, setAdding] = useState(false);
  const [reference, setReference] = useState("");
  const [requisitionId, setRequisitionId] = useState("");
  const [date, setDate] = useState(() =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await fetchApi(
        `/post-application/jobs/${encodeURIComponent(jobId)}/attempts`,
        {
          method: "POST",
          body: JSON.stringify({
            appliedAt: new Date(date).getTime(),
            ...(reference.trim()
              ? { applicationReference: reference.trim() }
              : {}),
            ...(requisitionId.trim()
              ? { requisitionId: requisitionId.trim() }
              : {}),
          }),
        },
      );
      setAdding(false);
      setReference("");
      setRequisitionId("");
      await queryClient.invalidateQueries();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not start an application attempt.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-label="Application attempts"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Application attempts</h3>
        {query.data?.attempts[0]?.closedAt && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdding(!adding)}
          >
            Start new application
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Reapplying to this posting starts a separate attempt. Previous emails
        and closed outcomes stay with their original attempt.
      </p>
      {query.isPending && <output>Loading attempts…</output>}
      {query.error && <p role="alert">Could not load application attempts.</p>}
      <ol className="divide-y">
        {query.data?.attempts.map((attempt) => (
          <li className="py-2 text-sm" key={attempt.id}>
            <span className="font-medium">Attempt {attempt.sequence}</span> ·{" "}
            {new Date(attempt.appliedAt).toLocaleDateString()} ·{" "}
            {attempt.closedAt
              ? `Closed${attempt.outcome ? ` (${attempt.outcome})` : ""}`
              : attempt.stage.replaceAll("_", " ")}
            {attempt.current && " · Current"}
            {attempt.applicationReference && (
              <p className="text-xs text-muted-foreground">
                Application reference: {attempt.applicationReference}
              </p>
            )}
            {attempt.requisitionId && (
              <p className="text-xs text-muted-foreground">
                Posting reference: {attempt.requisitionId}
              </p>
            )}
          </li>
        ))}
      </ol>
      {adding && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor="attempt-date" className="text-sm">
            Application date
            <Input
              id="attempt-date"
              type="datetime-local"
              step={1}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <label htmlFor="attempt-reference" className="text-sm">
            Application reference (optional)
            <Input
              id="attempt-reference"
              maxLength={80}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
          <label htmlFor="attempt-posting" className="text-sm">
            Posting / requisition ID (optional)
            <Input
              id="attempt-posting"
              maxLength={80}
              value={requisitionId}
              onChange={(event) => setRequisitionId(event.target.value)}
            />
          </label>
          <div className="flex items-end gap-2">
            <Button
              type="button"
              disabled={busy || !date}
              onClick={() => void start()}
            >
              {busy ? "Starting…" : "Start attempt"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
