import { describe, expect, it } from "vitest";
import { emptyDailySnowState } from "@/lib/dailysnow";
import { dailySnowPublicationStatus } from "@/lib/dailysnow/publication";
import { CHANNELS } from "@/lib/catalog";
import { IN_FLIGHT_MS, shouldRunDailySnow } from "@/lib/dailysnow/schedule";
import { denverToUtc, zonedToUtc } from "@/lib/time";
import type { DailySnowState } from "@/lib/types";

const now = (hour: number, minute = 0) => denverToUtc(2026, 11, 3, hour, minute);
const status = (at: Date, state?: DailySnowState, expected = true, date = "2026-11-02") => dailySnowPublicationStatus(date, state, at, expected);
const failed = (): DailySnowState => ({
  ...emptyDailySnowState(),
  attempts: { date: "2026-11-03", count: 3, calls: 6 },
  lastAttemptAt: now(7, 30).toISOString(), lastFinishedAt: now(7, 31).toISOString(),
  lastError: "Model timeout", consecutiveFailures: 3,
});

describe("Daily Snow publication availability", () => {
  it("keeps yesterday's edition scheduled at midnight, then pending during the publication window", () => {
    expect(status(now(0))).toBe("scheduled");
    expect(status(now(6, 59))).toBe("scheduled");
    expect(status(now(7))).toBe("pending");
    expect(status(now(10, 59))).toBe("pending");
    expect(status(now(11))).toBe("delayed");
  });

  it.each([
    [3, 8], [7, 1], [11, 1], [12, 1],
  ])("keeps all channels' scheduling and publication windows aligned in local time (2026-%i-%i)", (month, day) => {
    for (const channel of CHANNELS) {
      const start = channel.id === "western-us" ? 8 : 7;
      const end = channel.id === "western-us" ? 12 : 11;
      for (const [hour, minute, trigger, publication] of [
        [start - 1, 59, null, "scheduled"],
        [start, 0, "morning", "pending"],
        [end - 1, 59, "morning", "pending"],
        [end, 0, null, "delayed"],
      ] as const) {
        const at = zonedToUtc(2026, month, day, hour, minute, 0, channel.timeZone);
        expect(shouldRunDailySnow(undefined, at, channel.id)).toBe(trigger);
        expect(dailySnowPublicationStatus(null, undefined, at, true, channel.id)).toBe(publication);
      }
    }
  });

  it("reports today's completed edition even when a manual rewrite failed", () => {
    expect(status(now(12), failed(), true, "2026-11-03")).toBe("current");
  });

  it("marks exhausted retries or the daily request cap delayed without waiting for 11 AM", () => {
    expect(status(now(7, 32), failed())).toBe("delayed");
    const capped = { ...failed(), attempts: { date: "2026-11-03", count: 1, calls: 12 } };
    expect(status(now(7, 32), capped)).toBe("delayed");
  });

  it("allows the final in-flight attempt to finish after the cutoff", () => {
    const state = { ...failed(), lastAttemptAt: now(10, 59).toISOString(), lastFinishedAt: now(7, 31).toISOString() };
    expect(status(now(11), state)).toBe("pending");
    expect(status(new Date(now(10, 59).getTime() + IN_FLIGHT_MS), state)).toBe("delayed");
  });

  it("does not turn yesterday's failed attempts into today's exhausted retries", () => {
    const state = { ...failed(), attempts: { date: "2026-11-02", count: 3, calls: 12 } };
    expect(status(now(7, 32), state)).toBe("pending");
    expect(status(now(0), state)).toBe("scheduled");
  });

  it("keeps a missed earlier edition visible as a delay overnight", () => {
    expect(status(now(0), undefined, true, "2026-11-01")).toBe("delayed");
  });

  it("does not warn when publication is intentionally paused for lack of season/snow activity", () => {
    expect(status(now(12), failed(), false)).toBe("paused");
    expect(status(now(0), undefined, false, "2026-09-01")).toBe("paused");
  });

  it.each([
    [2026, 3, 8, "2026-03-07"],
    [2026, 11, 1, "2026-10-31"],
  ])("uses Denver calendar dates and publication hours across DST (%i-%i-%i)", (year, month, day, yesterday) => {
    expect(dailySnowPublicationStatus(yesterday, undefined, denverToUtc(year, month, day, 0), true)).toBe("scheduled");
    expect(dailySnowPublicationStatus(yesterday, undefined, denverToUtc(year, month, day, 7), true)).toBe("pending");
    expect(dailySnowPublicationStatus(yesterday, undefined, denverToUtc(year, month, day, 11), true)).toBe("delayed");
  });
});
