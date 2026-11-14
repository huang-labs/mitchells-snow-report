import { describe, expect, it } from "vitest";
import { stripTitleLabel } from "@/lib/dailysnow/title";
import { validateWestern, type buildWesternInput } from "@/lib/dailysnow/western";

describe("Daily Snow titles", () => {
  it("drops a label prefix the page already shows (2026-11-12 and 11-13 Western titles)", () => {
    expect(stripTitleLabel("AI: Pacific Storms Line Up for the West")).toBe("Pacific Storms Line Up for the West");
    expect(stripTitleLabel("AI Daily Snow: Western Storm Train")).toBe("Western Storm Train");
    expect(stripTitleLabel("Daily Snow — Storm Underway")).toBe("Storm Underway");
    expect(stripTitleLabel("AI-generated | Dry Start")).toBe("Dry Start");
  });

  it("leaves ordinary titles alone, including ones that only start with a similar word", () => {
    for (const t of ["Western Snow Outlook: Friday Storms", "Storm Underway", "Aiming for Powder: Tuesday", "Daily Dose of Snow", "AI"])
      expect(stripTitleLabel(t)).toBe(t);
  });

  it("is applied when validating a Western article", () => {
    const now = new Date("2026-11-13T15:15:00Z");
    const input = { asOf: now.toISOString(), asOfLocal: "", timeZone: "America/Los_Angeles", coverage: "", patternOutlook: null, regions: [] } satisfies ReturnType<typeof buildWesternInput>;
    const out = validateWestern({
      title: "AI: Pacific Storms Line Up for the West", summary: "A wetter pattern builds across the West.",
      sections: [
        { id: "update", paragraphs: [{ text: "A trough deepens off the coast." }] },
        { id: "short-term", paragraphs: [{ text: "Showers spread inland this week." }] },
        { id: "extended", paragraphs: [{ text: "Longer-range guidance is unavailable." }] },
      ],
    }, input);
    expect(out.title).toBe("Pacific Storms Line Up for the West");
  });
});
