import { describe, expect, it } from "vitest";
import type { StageEvent } from "../types/jobs";
import { currentAttemptEvents } from "./application-attempts";

const event = (sequence: number, occurredAt: number): StageEvent => ({
  id: `${sequence}-${occurredAt}`,
  applicationId: "job",
  attemptSequence: sequence,
  title: "Stage",
  fromStage: null,
  toStage: sequence === 1 ? "closed" : "applied",
  occurredAt,
  metadata: null,
  outcome: null,
  groupId: null,
});
describe("current application attempt events", () => {
  it("ignores a newer historical edit when showing the current application stage", () => {
    const current = event(2, 10);
    const previous = event(1, 20);
    expect(currentAttemptEvents([current, previous])).toEqual([current]);
  });
  it("preserves backward compatibility for legacy event responses", () => {
    const legacy = { ...event(1, 10), attemptSequence: undefined };
    expect(currentAttemptEvents([legacy])).toEqual([legacy]);
    expect(currentAttemptEvents([])).toEqual([]);
  });
  it("excludes notes from lifecycle display without falling back to a previous attempt", () => {
    const current = event(2, 10);
    const note = {
      ...event(2, 20),
      metadata: { eventType: "note" as const },
      toStage: "closed",
    };
    expect(currentAttemptEvents([event(1, 30), current, note])).toEqual([
      current,
    ]);
    expect(currentAttemptEvents([event(1, 30), note])).toEqual([]);
  });
});
