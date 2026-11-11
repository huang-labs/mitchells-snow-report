// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RegionalPage } from "@/components/sections/RegionalPage";
import { summarizeFreshness } from "@/components/sections/freshness-summary";
import { buildReport } from "@/lib/report";
import type { Freshness, NwsPayload, ReportResponse, ResortReport } from "@/lib/types";

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

it("titles the page Resorts with snowfall windows above the timelines", () => {
  render(<RegionalPage now={now} report={buildReport(null, now)} />);
  expect(document.querySelector("h1")?.textContent).toBe("Resorts");
  expect(document.querySelector(".page__sub")?.textContent).toBe("Reported snowfall: past 7 days and last 24 hours · NWS forecast: next 7 days.");
  expect(document.querySelector(".page__header")?.nextElementSibling?.className).toBe("resort-timelines");
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

describe("destination forecasts and report times", () => {
  const tahoe = () => document.querySelector('[aria-label="Palisades Tahoe"]')!;
  function withTahoe(lastError: string | null): ReportResponse {
    const report = buildReport(null, now);
    const hourlySnow = Array.from({ length: 24 * 8 }, (_, i) => ({
      start: new Date(Date.parse("2026-12-01T15:00:00Z") + i * 3_600_000).toISOString(),
      snowIn: 0.5,
    }));
    report.sources.nws.payload = {
      points: [{ id: "palisades-tahoe", name: "Palisades Tahoe", hourlySnow, lastError }],
    } as unknown as NwsPayload;
    report.sources["palisades-tahoe"].payload = {
      reportTime: "2026-12-01T13:30:00Z",
      snowfall: { h24: { state: "reported", value: 3, unit: "in", label: "Past 24 hours" } },
    } as unknown as ResortReport;
    return report;
  }

  it("does not present a failing forecast point's last payload as the current forecast", () => {
    render(<RegionalPage now={now} report={withTahoe(null)} />);
    expect(tahoe().querySelectorAll(".snowtl__day--forecast:not(.snowtl__day--no_forecast)").length).toBeGreaterThan(0);
    cleanup();
    render(<RegionalPage now={now} report={withTahoe("Palisades Tahoe: HTTP 503")} />);
    expect(tahoe().querySelectorAll(".snowtl__day--no_forecast")).toHaveLength(7);
    // No forecast: the total is the "no data" mark, never 0″.
    expect(tahoe().querySelector(".snowtl__span--next .snowtl__total")!.textContent).toBe("—");
  });

  it("shows a Pacific resort's report time in Pacific time", () => {
    render(<RegionalPage now={now} report={withTahoe(null)} />);
    // 13:30 UTC is 5:30 AM PST (6:30 AM in Denver).
    expect(tahoe().querySelector(".snowtl__reported-time")?.textContent).toBe("Today 5:30 AM");
  });
});
