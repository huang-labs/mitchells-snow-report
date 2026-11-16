import { describe, expect, it } from "vitest";
import { buildSnowTimeline } from "@/components/timeline/model";
import { newSnow } from "@/lib/snowlog/overlap";
import { recordSnowLog } from "@/lib/snowlog/record";
import type { MorningReading, SnowLogState } from "@/lib/snowlog/types";
import type { Metric, ResortReport, Snapshot, SourceRecord } from "@/lib/types";

const ZONE = "America/Denver";
const inches = (value: number, label: string): Metric => ({ state: "reported", value, unit: "in", label });
const reading = (valueIn: number, windowEnd: string, h48In?: number): MorningReading => ({
  state: "reported", valueIn, ...(h48In === undefined ? {} : { h48In }), label: "Snow 24 Hrs.", windowEnd, collectedAt: "2026-11-15T17:55:11.078Z",
});

describe("newSnow", () => {
  const sat = { valueIn: 4, windowEnd: "2026-11-14T14:09:12.000Z" };

  it("removes the part of a 24 h total that the previous morning already reported", () => {
    // Brighton, 2026-11-15: 24 h = 48 h = 5″ the morning after a 4″ report.
    expect(newSnow({ valueIn: 5, h48In: 5, windowEnd: "2026-11-15T14:00:00.000Z" }, sat)).toEqual({ kind: "new", valueIn: 1, publishedIn: 5, repeatedIn: 4 });
  });

  it("keeps the published figure when the 48 h total covers both mornings", () => {
    expect(newSnow({ valueIn: 5, h48In: 9, windowEnd: "2026-11-15T14:00:00.000Z" }, sat)).toMatchObject({ valueIn: 5, repeatedIn: 0 });
    expect(newSnow({ valueIn: 5, h48In: 12, windowEnd: "2026-11-15T14:00:00.000Z" }, sat)).toMatchObject({ valueIn: 5, repeatedIn: 0 });
  });

  it("can't check a resort without a 48 h total, or mornings that aren't about a day apart", () => {
    expect(newSnow({ valueIn: 5, windowEnd: "2026-11-15T14:00:00.000Z" }, sat)).toMatchObject({ valueIn: 5, repeatedIn: 0 });
    expect(newSnow({ valueIn: 5, h48In: 5, windowEnd: "2026-11-16T14:00:00.000Z" }, sat)).toMatchObject({ valueIn: 5, repeatedIn: 0 });
    expect(newSnow({ valueIn: 5, h48In: 5, windowEnd: "2026-11-15T14:00:00.000Z" }, null)).toMatchObject({ valueIn: 5, repeatedIn: 0 });
  });

  it("flags a 48 h total below the previous morning's 24 h as a conflict", () => {
    expect(newSnow({ valueIn: 2, h48In: 3, windowEnd: "2026-11-15T14:00:00.000Z" }, sat)).toEqual({ kind: "conflict", publishedIn: 2, h48In: 3, previousIn: 4 });
  });
});

describe("repeated 24 h reports on the timeline", () => {
  const now = new Date("2026-11-16T01:00:00Z"); // Sun Nov 15, 6 PM MST
  const brighton = (sun: MorningReading): SnowLogState => ({
    resorts: { brighton: { "2026-11-13": reading(0, "2026-11-13T14:00:00.000Z"), "2026-11-14": reading(4, "2026-11-14T14:09:12.000Z"), "2026-11-15": sun } },
    forecasts: {},
  });
  const report = (h48 = 5) => ({
    reportTime: "2026-11-15T14:00:00.000Z",
    snowfall: { h24: inches(5, "Snow 24 Hrs."), h48: inches(h48, "Snow 48 Hrs."), h72: inches(5, "Snow 72 Hrs."), d7: inches(5, "Snow 7 Days") },
  }) as unknown as ResortReport;
  const build = (log: SnowLogState, r: ResortReport | null) =>
    buildSnowTimeline({ resort: "brighton", name: "Brighton", canyon: "BCC", timeZone: ZONE, log, now, forecast: null, report: r });

  it("counts one 5″ storm once: 4″ then 1″, a 5″ week, and a 1″ last 24 h", () => {
    const model = build(brighton(reading(5, "2026-11-15T14:00:00.000Z", 5)), report());
    expect(model.past.slice(-2).map((d) => d.amountIn)).toEqual([4, 1]);
    expect(model.past.at(-1)!.detail).toBe("Sun, Nov 15 · 1″ new; Brighton’s 24 h total of 5″ repeats 4″ from the previous morning’s report (“Snow 24 Hrs.” at 7:00 AM)");
    expect(model.pastTotal?.amountIn).toBe(5);
    expect(model.last24.metric).toMatchObject({ state: "reported", value: 1 });
    expect(model.last24.detail).toMatch(/^Last 24 h · 1″ new; Brighton’s 24 h total of 5″ repeats 4″/);
  });

  it("uses the live report's 48 h total for a reading logged before 48 h totals were kept", () => {
    const model = build(brighton(reading(5, "2026-11-15T14:00:00.000Z")), report());
    expect(model.past.at(-1)!.amountIn).toBe(1);
    // A newer report can't vouch for an older reading.
    const later = { ...report(), reportTime: "2026-11-16T14:00:00.000Z" } as ResortReport;
    expect(build(brighton(reading(5, "2026-11-15T14:00:00.000Z")), later).past.at(-1)!.amountIn).toBe(5);
  });

  it("withholds a morning whose 48 h total contradicts the morning before", () => {
    const model = build(brighton(reading(2, "2026-11-15T14:00:00.000Z", 3)), { ...report(3), snowfall: { ...report(3).snowfall, h24: inches(2, "Snow 24 Hrs.") } } as ResortReport);
    expect(model.past.at(-1)).toMatchObject({ state: "unavailable", amountIn: null });
    expect(model.past.at(-1)!.detail).toMatch(/24 h total \(2″\) and 48 h total \(3″\) conflict with the previous morning’s 4″/);
    expect(model.pastTotal?.amountIn).toBe(4);
    expect(model.last24.metric).toMatchObject({ state: "unavailable" });
  });

  it("leaves a real second storm alone", () => {
    const model = build(brighton(reading(5, "2026-11-15T14:00:00.000Z", 9)), report(9));
    expect(model.past.slice(-2).map((d) => d.amountIn)).toEqual([4, 5]);
    expect(model.last24.metric).toMatchObject({ value: 5 });
    expect(model.last24.detail).toMatch(/5″ reported by Brighton/);
  });
});

it("records the morning report's 48 h total beside its 24 h total", () => {
  const collectedAt = "2026-11-15T15:00:00.000Z"; // 8 AM MST
  const payload = { resort: "brighton", reportTime: "2026-11-15T14:00:00.000Z", snowfall: { h24: inches(5, "Snow 24 Hrs."), h48: inches(5, "Snow 48 Hrs.") } } as unknown as ResortReport;
  const record: SourceRecord = { id: "brighton", lastAttemptAt: collectedAt, lastSuccessfulFetchAt: collectedAt, sourceUpdatedAt: payload.reportTime, status: "ok", lastError: null, lastErrorAt: null, consecutiveFailures: 0, diagnostics: null, payload };
  const snapshot: Snapshot = { schemaVersion: 1, writtenAt: collectedAt, sources: { brighton: record } };
  const log = recordSnowLog(undefined, snapshot, new Date(collectedAt));
  expect(log.resorts.brighton?.["2026-11-15"]).toMatchObject({ state: "reported", valueIn: 5, h48In: 5 });
});
