import { z } from "zod";

export const EMAIL_KEYWORD_PRESETS = {
  en: [
    "application",
    "applying",
    "interview",
    "recruitment",
    "recruiter",
    "candidate",
    "candidacy",
    "assessment",
    "job offer",
    "offer letter",
    "not selected",
    "not moving forward",
    "unable to proceed",
    "other candidates",
    "position has been filled",
    "regret to inform",
  ],
  de: [
    "Bewerbung",
    "beworben",
    "Vorstellungsgespräch",
    "Bewerbungsgespräch",
    "Bewerber",
    "Kandidatur",
    "Kandidat",
    "Absage",
    "Zusage",
    "Stellenangebot",
    "Arbeitsvertrag",
    "Auswahlverfahren",
    "Auswahlprozess",
    "nicht berücksichtigen",
    "nicht weiterverfolgen",
    "anderweitig besetzen",
    "engere Wahl",
    "Einstellungstest",
    "Kennenlerngespräch",
  ],
} as const;

export const emailKeywordSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(
    /^[^"\\{}\p{Cc}]+$/u,
    "Use a word or phrase without quotes, braces, backslashes or control characters.",
  );
export const emailKeywordFilterSchema = z
  .object({
    enabled: z.boolean(),
    languages: z.array(z.enum(["en", "de"])).max(2),
    customKeywords: z.array(emailKeywordSchema).max(100),
  })
  .strict()
  .refine(
    (value) =>
      !value.enabled ||
      value.languages.length > 0 ||
      value.customKeywords.length > 0,
    "Select a preset or add a keyword before enabling filtering.",
  );
export type EmailKeywordFilter = z.infer<typeof emailKeywordFilterSchema>;
export function defaultEmailKeywordFilter(): EmailKeywordFilter {
  return { enabled: true, languages: ["en", "de"], customKeywords: [] };
}
export function resolveEmailKeywords(filter: EmailKeywordFilter): string[] {
  if (!filter.enabled) return [];
  return [
    ...new Set(
      [
        ...filter.languages.flatMap((language) => [
          ...EMAIL_KEYWORD_PRESETS[language],
        ]),
        ...filter.customKeywords,
      ].map((term) => term.normalize("NFC").trim().toLowerCase()),
    ),
  ];
}
