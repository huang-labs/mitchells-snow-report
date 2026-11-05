// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RegionalPage } from "@/components/sections/RegionalPage";
import { summarizeFreshness } from "@/components/sections/freshness-summary";
import { buildReport } from "@/lib/report";
import type { Freshness, ReportResponse } from "@/lib/types";

const now = new Date("2026-12-01T15:00:00Z");
afterEach(cleanup);

function withFreshness(states: Record<"alta" | "snowbird" | "solitude" | "brighton", Freshness>): ReportResponse {
  const report = buildReport(null, now);
  for (const [id, f] of Object.entries(states)) report.sources[id as keyof typeof states].freshness = f;
  return report;
}

it("shows no resort freshness badges or resort source line, whatever their state", () => {
  const report = withFreshness({ alta: "current", snowbird: "old-report", solitude: "stale", brighton: "unavailable" });
  report.sources.snowbird.status = "error";
  render(<RegionalPage now={now} report={report} />);
  expect(document.querySelectorAll(".resort-timeline .badge")).toHaveLength(0);
  expect(document.body.textContent).not.toMatch(/Old report|Updates delayed|Latest check failed|snow reports \(resort websites\)/);
});

it("ends with the legend explaining missing data and local days", () => {
  render(<RegionalPage now={now} report={withFreshness({ alta: "current", snowbird: "current", solitude: "current", brighton: "current" })} />);
  const page = document.querySelector(".page--regional")!;
  expect([...page.children].map((e) => e.className).slice(-2)).toEqual(["resort-timelines", "legend"]);
  expect(page.querySelector(".legend")?.textContent).toContain("reported zero");
  expect(page.querySelector(".legend")?.textContent).not.toMatch(/tap a day/);
  expect(page.querySelectorAll(".source-line")).toHaveLength(0);
  expect(page.querySelector(".legend")?.textContent).toContain("local time");
});

it("titles the page Resorts, with its subtitle", () => {
  render(<RegionalPage now={now} report={buildReport(null, now)} />);
  expect(document.querySelector("h1")?.textContent).toBe("Resorts");
  expect(document.querySelector(".page__sub")?.textContent).toBe("Your Western US favorites: the past week, the last 24 h, and the NWS forecast for the week ahead.");
});

describe("summarizeFreshness", () => {
  const src = (label: string, freshness: Freshness, lastSuccessfulFetchAt: string | null = "2026-12-01T14:58:00Z") => ({ label, freshness, lastSuccessfulFetchAt });

  it("reports current with no groups beyond Current when every source is current", () => {
    const s = summarizeFreshness([src("A", "current", "2026-12-01T14:58:00Z"), src("B", "current", "2026-12-01T14:51:00Z")]);
    expect(s.worst).toBe("current");
    expect(s.groups).toEqual([{ freshness: "current", labels: ["A", "B"] }]);
    expect(s.oldestCheck).toBe("2026-12-01T14:51:00Z");
  });

  it("orders groups worst first and keeps source order within a group", () => {
    const s = summarizeFreshness([src("A", "time-unknown"), src("B", "old-report"), src("C", "stale"), src("D", "old-report")]);
    expect(s.worst).toBe("stale");
    expect(s.groups.map((g) => [g.freshness, g.labels])).toEqual([["stale", ["C"]], ["old-report", ["B", "D"]], ["time-unknown", ["A"]]]);
  });

  it("has no oldest check when a source was never collected", () => {
    expect(summarizeFreshness([src("A", "current"), src("B", "unavailable", null)]).oldestCheck).toBeNull();
  });
});
