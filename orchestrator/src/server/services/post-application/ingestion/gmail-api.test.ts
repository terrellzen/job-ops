import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGmailQuery, listMessageIds } from "./gmail-api";

afterEach(() => vi.unstubAllGlobals());

describe("language-independent Gmail retrieval", () => {
  it("searches literal English, German and custom phrases in subject or body", () => {
    expect(
      buildGmailQuery(14, [
        "application",
        "bewerbung",
        "拒否",
        "nicht berücksichtigen",
      ]),
    ).toBe(
      'newer_than:14d {"application" "bewerbung" "拒否" "nicht berücksichtigen"}',
    );
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
