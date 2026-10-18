import type { StageEvent } from "../types/jobs";

/** Current status is determined by the latest attempt, not by edits to old dates. */
export function currentAttemptEvents(events: StageEvent[]): StageEvent[] {
  const sequence = events.reduce(
    (latest, event) => Math.max(latest, event.attemptSequence ?? 1),
    1,
  );
  return events.filter(
    (event) =>
      (event.attemptSequence ?? 1) === sequence && isLifecycleEvent(event),
  );
}

/** Notes remain visible in history but never determine application lifecycle. */
export function isLifecycleEvent(event: { metadata?: unknown }): boolean {
  return (
    (event.metadata as { eventType?: string } | null)?.eventType !== "note"
  );
}
