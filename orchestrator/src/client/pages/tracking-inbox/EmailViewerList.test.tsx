import type { PostApplicationInboxItem } from "@shared/types";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "@/client/test/renderWithQueryClient";
import { EmailViewerList } from "./EmailViewerList";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const defaultAttempt = {
  id: "attempt-1",
  jobId: "job",
  sequence: 1,
  appliedAt: Date.now() - 86400000,
  stage: "applied",
  closedAt: null,
  outcome: null,
  current: true,
  applicationReference: null,
  requisitionId: null,
};
const item = {
  attempts: [defaultAttempt],
  message: {
    id: "email",
    matchedJobId: "job",
    processingStatus: "pending_user",
    matchConfidence: 95,
    applicationAttemptId: "attempt-1",
    senderName: "Recruiting",
    fromAddress: "jobs@example.com",
    subject: "Application confirmation",
    receivedAt: Date.now(),
  },
} as PostApplicationInboxItem;
function setup(message = item, selected: Record<string, string> = {}) {
  const onDecision = vi.fn();
  render(
    <EmailViewerList
      items={[message]}
      appliedJobs={[]}
      appliedJobByMessageId={selected}
      onAppliedJobChange={vi.fn()}
      onDecision={onDecision}
      isActionLoading={false}
      isAppliedJobsLoading={false}
    />,
  );
  return onDecision;
}
describe("linking an email without changing status", () => {
  it("offers an explicit Link only button separately from normal approval", () => {
    const onDecision = setup();
    fireEvent.click(screen.getByRole("button", { name: "Link only" }));
    expect(onDecision).toHaveBeenCalledWith(item, "link", {
      applicationAttemptId: "attempt-1",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm email-job match" }),
    );
    expect(onDecision).toHaveBeenCalledWith(item, "approve", {
      applicationAttemptId: "attempt-1",
    });
  });
  it("requires a selected job and disables linking for decided messages", () => {
    const unmatched = {
      ...item,
      message: { ...item.message, matchedJobId: null },
    };
    setup(unmatched);
    expect(screen.getByRole("button", { name: "Link only" })).toBeDisabled();
    cleanup();
    setup(
      {
        ...unmatched,
        message: { ...unmatched.message, matchedJobId: "selected-job" },
      },
      { email: "selected-job" },
    );
    expect(screen.getByRole("button", { name: "Link only" })).toBeEnabled();
    cleanup();
    setup({
      ...item,
      message: { ...item.message, processingStatus: "manual_linked" },
    });
    expect(screen.getByRole("button", { name: "Link only" })).toBeDisabled();
  });
});

describe("choosing an application attempt", () => {
  it("requires an explicit choice when previous and current attempts are both possible", () => {
    const previous = {
      ...defaultAttempt,
      id: "previous",
      closedAt: Date.now() - 86400000,
    };
    const current = { ...defaultAttempt, id: "current", sequence: 2 };
    const ambiguous = {
      ...item,
      attempts: [current, previous],
      message: { ...item.message, applicationAttemptId: null },
    };
    const onDecision = setup(ambiguous);
    expect(
      screen.getByRole("button", { name: "Confirm email-job match" }),
    ).toBeDisabled();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Application attempt" }),
      { target: { value: "previous" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep closed" }));
    expect(onDecision).toHaveBeenCalledWith(ambiguous, "link", {
      applicationAttemptId: "previous",
    });
  });
  it("offers explicit reopening separately from keeping an opportunity closed", () => {
    const closed = {
      ...item,
      reopeningEligible: true,
      attempts: [{ ...defaultAttempt, closedAt: Date.now() - 1000 }],
      message: {
        ...item.message,
        classificationPayload: {
          attemptReviewReason: "New opportunity on a closed application",
        },
      },
    };
    const onDecision = setup(closed);
    fireEvent.click(screen.getByRole("button", { name: "Reopen application" }));
    expect(onDecision).toHaveBeenCalledWith(closed, "reopen", {
      applicationAttemptId: "attempt-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "New application" }));
    expect(onDecision).toHaveBeenCalledWith(closed, "new_attempt", {
      applicationAttemptId: "attempt-1",
    });
  });
  it("offers reopening after selecting a closed job for an unmatched offer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              attempts: [{ ...defaultAttempt, closedAt: Date.now() - 1000 }],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const unmatched = {
      ...item,
      reopeningEligible: true,
      attempts: [],
      message: {
        ...item.message,
        matchedJobId: null,
        applicationAttemptId: null,
        stageTarget: "offer" as const,
        classificationPayload: {
          attemptReviewReason:
            "Choose the application attempt before linking this email.",
        },
      },
    };
    const decide = setup(unmatched, { email: "job" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reopen application" }),
    );
    expect(decide).toHaveBeenCalledWith(unmatched, "reopen", {
      applicationAttemptId: "attempt-1",
    });
  });
  it("shows a skip control for quarantined mail without allowing a status change", () => {
    const oversized = {
      ...item,
      message: {
        ...item.message,
        errorCode: "IMAP_MESSAGE_TOO_LARGE",
        errorMessage: "Review in your mail client.",
      },
    };
    const decide = setup(oversized);
    expect(
      screen.queryByRole("button", { name: "Confirm email-job match" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip email" }));
    expect(decide).toHaveBeenCalledWith(oversized, "deny", {
      applicationAttemptId: "attempt-1",
    });
  });
});
