// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DataBanners } from "@/components/dashboard-context";
import { SourceLine } from "@/components/ui";
import { buildReport } from "@/lib/report";

const now = new Date("2026-11-03T15:00:00Z");
afterEach(cleanup);

it("shows no banner for delayed or unavailable required feeds", () => {
  const report = buildReport(null, now);
  report.requiredMissing = ["alta", "snowbird"];
  report.sources.alta.freshness = "stale";
  const { container } = render(<DataBanners data={{ report, now, loadedAt: now.getTime(), error: null }} />);
  expect(container.textContent).toBe("");
});

it("shows a confirmed failed check separately while recently collected information remains current", () => {
  const report = buildReport(null, now);
  const source = { ...report.sources.alta, freshness: "current" as const, status: "error" as const, lastError: "HTTP 503", lastAttemptAt: now.toISOString() };
  render(<SourceLine source={source} now={now} />);
  expect(screen.getByText("Current")).toBeTruthy();
  expect(screen.getByText("Last attempt failed just now")).toBeTruthy();
  expect(screen.queryByText("Updates delayed")).toBeNull();
});

it("presents an unknown publication time as neutral rather than a failed update", () => {
  const source = { ...buildReport(null, now).sources.nws, freshness: "time-unknown" as const };
  render(<SourceLine source={source} now={now} />);
  expect(screen.getByText("Time unknown").className).toContain("badge--neutral");
});
