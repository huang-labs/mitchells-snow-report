import { describe, expect, it } from "vitest";
import { emptySnowfall, reported } from "@/lib/metric";
import { snowfallIssues, usableSnowReport } from "@/lib/snowfall-quality";
import { parseFavoriteHtml } from "@/lib/sources/favorites";
import { buildDigest } from "@/lib/dailysnow/facts";
import { buildDailyDigest, dailySnowActivity } from "@/lib/dailysnow/digest";
import { regionalSnapshot } from "@/lib/dailysnow/regions";
import { buildWesternInput } from "@/lib/dailysnow/western";
import { advanceStormTracking } from "@/lib/dailysnow/storms";
import { recordSnowLog } from "@/lib/snowlog/record";
import { buildSnowTimeline } from "@/components/timeline/model";
import type { DailySnowPost, ResortReport, Snapshot, SnowfallSet } from "@/lib/types";
import { fixture } from "./fixtureFetch";

const now = new Date("2026-11-06T15:00:00Z");
function telluride(): ResortReport {
  const report = parseFavoriteHtml("telluride", fixture("telluride-snow-report.html"), now);
  report.reportTime = now.toISOString(); // Reproduce the page timestamp advancing over unchanged fields.
  report.narrative = "We received 6″ overnight.";
  return report;
}
function snapshot(report = telluride()): Snapshot {
  return {
    schemaVersion: 1, writtenAt: now.toISOString(), region: "colorado",
    sources: { telluride: {
      id: "telluride", status: "ok", payload: report,
      sourceUpdatedAt: report.reportTime, lastAttemptAt: now.toISOString(), lastSuccessfulFetchAt: now.toISOString(),
      consecutiveFailures: 0, lastError: null, lastErrorAt: null, diagnostics: null,
    } },
  };
}
const snow = (values: Partial<Record<keyof SnowfallSet, number>>): SnowfallSet => {
  const fields = emptySnowfall();
  for (const [key, value] of Object.entries(values)) fields[key as keyof SnowfallSet] = reported(value, "in", key);
  return fields;
};

describe("source snowfall consistency", () => {
  it.each([
    ["overnight", "h24"], ["overnight", "h48"], ["h12", "h24"], ["h24", "h48"],
    ["h24", "h72"], ["h24", "d7"], ["h48", "h72"], ["h48", "d7"], ["h72", "d7"],
  ] as const)("withholds both sides when %s exceeds %s", (short, long) => {
    const raw = telluride();
    raw.snowfall = snow({ [short]: 6, [long]: 0 });
    const safe = usableSnowReport(raw)!;
    expect(safe.snowfall[short].state).toBe("unavailable");
    expect(safe.snowfall[long].state).toBe("unavailable");
    expect(raw.snowfall[short]).toMatchObject({ state: "reported", value: 6 });
    expect(raw.snowfall[long]).toMatchObject({ state: "reported", value: 0 });
  });

  it.each([-1, Infinity, NaN])("withholds invalid amounts (%s), preserving independent valid windows", value => {
    const raw = telluride();
    raw.snowfall = snow({ h24: value, h48: 2 });
    expect(usableSnowReport(raw)!.snowfall.h24.state).toBe("unavailable");
    expect(usableSnowReport(raw)!.snowfall.h48).toMatchObject({ state: "reported", value: 2 });
  });

  it("keeps real zeros, absent windows, repeated positives and independent counter resets usable", () => {
    for (const fields of [snow({ h24: 0, h48: 0 }), snow({ overnight: 6 }), snow({ h24: 6, h48: 6, d7: 6, storm: 0, season: 0 })]) {
      const raw = { ...telluride(), snowfall: fields };
      expect(snowfallIssues(fields)).toEqual([]);
      expect(usableSnowReport(raw)).toBe(raw);
      expect(usableSnowReport(structuredClone(raw))!.snowfall).toEqual(fields);
    }
  });

  it("does not compare overnight and fixed 12-hour windows to one another", () => {
    expect(snowfallIssues(snow({ overnight: 6, h12: 0, h24: 6 }))).toEqual([]);
  });

  it("preserves a source-specific since-lifts-closed counter even if it exceeds 24 hours", () => {
    const fields = snow({ overnight: 6, h24: 0, h48: 0 });
    fields.overnight.label = "Since lifts closed";
    expect(snowfallIssues(fields)).toEqual([]);
  });

  it("immediately recovers when the source corrects its report", () => {
    const raw = telluride();
    expect(usableSnowReport(raw)!.snowfall.overnight.state).toBe("unavailable");
    raw.snowfall.h24 = reported(6, "in", "Last 24 hours");
    raw.snowfall.h48 = reported(6, "in", "Last 48 hours");
    expect(usableSnowReport(raw)).toBe(raw);
  });
});

it("keeps the real Telluride contradiction out of AI facts, phase, storm memory, history and timeline", () => {
  const s = snapshot();
  const raw = structuredClone(s);
  const facts = buildDigest(s, {}, now).resorts[0];
  expect(facts.snowfall.overnight).toBe("unavailable");
  expect(facts.snowfall.h24).toBe("unavailable");
  expect(facts.conditions).toBeNull();
  expect(facts.snowfallWarnings?.length).toBeGreaterThan(0);
  const { digest, numbers } = buildDailyDigest(s, null, [], now);
  expect(numbers.resorts[0].h24).toBeNull();
  expect(numbers.resorts[0].h48).toBeNull();
  expect(numbers.resorts[0].snowfall?.overnight.state).toBe("unavailable");
  // Independent seven-day/season measurements remain available with their own windows.
  expect(numbers.resorts[0].snowfall?.d7).toMatchObject({ state: "reported", value: 6 });
  expect(digest.resorts[0].snowfallWarnings?.length).toBeGreaterThan(0);
  expect(dailySnowActivity(s, now).recent).toBe(0);
  expect(advanceStormTracking(undefined, s, now).events).toEqual([]);
  const log = recordSnowLog(undefined, s, now);
  expect(log.resorts.telluride?.["2026-11-06"]).toMatchObject({ state: "unavailable", qualityNote: expect.stringContaining("Withheld") });
  const model = buildSnowTimeline({ resort: "telluride", name: "Telluride", canyon: "telluride", timeZone: "America/Denver", report: telluride(), log, forecast: null, now });
  expect(model.last24.metric?.state).toBe("unavailable");
  expect(model.last24.detail).toContain("Withheld");
  expect(model.past.at(-1)?.detail).toContain("Withheld");
  expect(s).toEqual(raw);
});

it("protects the Western overview from a previously generated regional edition with conflicting frozen inputs", () => {
  const s = regionalSnapshot(snapshot(), "colorado");
  const { numbers } = buildDailyDigest(s, null, [], now);
  // Old editions retain raw fields. Recreate the pre-fix artifact without mutating it.
  numbers.resorts[0].snowfall = telluride().snowfall;
  numbers.resorts[0].h24 = 0;
  numbers.resorts[0].h48 = 0;
  const post: DailySnowPost = {
    channel: "colorado", date: "2026-11-06", generatedAt: now.toISOString(), phase: "post-storm",
    title: "Fresh overnight snowfall", summary: "Telluride received 6″ overnight.",
    sections: [{ id: "update", paragraphs: [{ text: "Telluride received 6″ overnight.", figure: null }] }],
    numbers, figures: {}, model: "test", trigger: "morning",
  };
  const before = structuredClone(post);
  const region = buildWesternInput(s, { colorado: post }, now).regions[0];
  expect(region.edition.paragraphs).toEqual([]);
  expect(region.edition.title).toContain("withheld");
  expect(region.observations[0].h24In).toBeNull();
  expect(region.observations[0].windows.find(w => w.window === "overnight")?.amountIn).toBeNull();
  expect(post).toEqual(before);
});
