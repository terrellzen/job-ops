import {
  defaultEmailKeywordFilter,
  resolveEmailKeywords,
} from "@shared/email-keywords";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGmailQuery, listMessageIds } from "./gmail-api";

afterEach(() => vi.unstubAllGlobals());

describe("language-independent Gmail retrieval", () => {
  it("searches literal English, German and custom phrases in subject or body", () => {
    const query = buildGmailQuery(14, [
      "application",
      "bewerbung",
      "拒否",
      "nicht berücksichtigen",
    ]);
    for (const term of [
      "application",
      "bewerbung",
      "拒否",
      "nicht berücksichtigen",
    ])
      expect(query).toContain(`"${term}"`);
  });
  it("retains recruiter and scheduling discovery when default keywords are enabled", () => {
    const query = buildGmailQuery(
      90,
      resolveEmailKeywords(defaultEmailKeywordFilter()),
    );
    for (const signal of [
      '"book a time"',
      '"calendly.com"',
      'from:"@calendly.com"',
      'from:"talent@"',
      'subject:"coding challenge"',
      'subject:"hiring freeze"',
    ])
      expect(query).toContain(signal);
    expect(buildGmailQuery(90, [])).toBe("newer_than:90d");
  });
  it("uses only the date window and preserves the message cap across pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [{ id: "french", threadId: "one" }],
            nextPageToken: "page-two",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [
              { id: "japanese", threadId: "two" },
              { id: "arabic", threadId: "three" },
            ],
            nextPageToken: "page-three",
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await listMessageIds("test-token", 7, 2)).toEqual([
      { id: "french", threadId: "one" },
      { id: "japanese", threadId: "two" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url] of fetch.mock.calls) {
      expect(new URL(url).searchParams.get("q")).toBe("newer_than:7d");
    }
  });
});
