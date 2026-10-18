import { describe, expect, it } from "vitest";
import {
  defaultEmailKeywordFilter,
  emailKeywordFilterSchema,
  resolveEmailKeywords,
} from "./email-keywords";

describe("email keyword filters", () => {
  it("combines English, German and Unicode custom terms without duplicates", () => {
    const filter = {
      ...defaultEmailKeywordFilter(),
      customKeywords: ["Bewerbung", "candidature", "رفض الطلب"],
    };
    const terms = resolveEmailKeywords(filter);
    expect(terms).toEqual(
      expect.arrayContaining([
        "application",
        "bewerbung",
        "candidature",
        "رفض الطلب",
      ]),
    );
    expect(terms.filter((term) => term === "bewerbung")).toHaveLength(1);
  });
  it("allows custom-only searches and turning filtering off", () => {
    const filter = { enabled: true, languages: [], customKeywords: ["面接"] };
    expect(emailKeywordFilterSchema.parse(filter)).toEqual(filter);
    expect(resolveEmailKeywords(filter)).toEqual(["面接"]);
    expect(resolveEmailKeywords({ ...filter, enabled: false })).toEqual([]);
  });
  it("rejects empty enabled filters, search syntax injection and oversized inputs", () => {
    for (const customKeywords of [
      [],
      ['"} OR newer_than:365d {"'],
      ["x".repeat(101)],
      ["hello\u0000world"],
      Array(101).fill("term"),
    ]) {
      expect(
        emailKeywordFilterSchema.safeParse({
          enabled: true,
          languages: [],
          customKeywords,
        }).success,
      ).toBe(false);
    }
  });
});
