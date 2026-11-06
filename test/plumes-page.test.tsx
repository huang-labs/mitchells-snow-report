// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PlumesPage } from "@/components/sections/PlumesPage";
import { runCollection } from "@/lib/collect";
import { PLUME_PANEL_TTL_S } from "@/lib/plumePanels";
import { buildReport } from "@/lib/report";
import { MemoryKV, readSnapshot } from "@/lib/store";
import { createFixtureFetch, FIXTURE_NOW } from "./fixtureFetch";

afterEach(cleanup);

it.each([
  ["2026-07-01T12:00:00Z", "utah", "6:00 AM MDT"],
  ["2026-11-05T12:00:00Z", "utah", "5:00 AM MST"],
  ["2026-07-01T12:00:00Z", "tahoe", "5:00 AM PDT"],
  ["2026-11-05T12:00:00Z", "tahoe", "4:00 AM PST"],
] as const)("identifies the local model initialization and UTC cycle (%s, %s)", (initTime, region, localTime) => {
  const now = new Date(initTime);
  const source = {
    ...buildReport(null, now).sources.plumes,
    payload: { product: "Utah Snow Ensemble", runCode: initTime.slice(0, 10).replaceAll("-", "") + "12", initTime, charts: [] },
  };
  const { container } = render(<PlumesPage source={source} now={now} region={region} />);
  const header = container.querySelector(".page__sub")!.textContent;
  expect(header).toContain("Model initialized");
  expect(header).toContain(localTime);
  expect(header).toContain("12Z cycle (UTC)");
  expect(header).toContain(initTime.includes("07-01") ? "Jul 1" : "Nov 5");
});

it("shows the original chart instead of stored panels that have expired", async () => {
  const kv = new MemoryKV();
  await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl: createFixtureFetch().fetchImpl, only: ["plumes"] });
  const snapshot = (await readSnapshot(kv))!;
  const live = buildReport(snapshot, FIXTURE_NOW).sources.plumes;
  const { unmount } = render(<PlumesPage source={live} now={FIXTURE_NOW} />);
  expect(screen.queryAllByText(/showing the original chart/)).toHaveLength(0);
  unmount();
  // Collection stalled: the last-good payload outlives its panels.
  const later = new Date(FIXTURE_NOW.getTime() + PLUME_PANEL_TTL_S * 1000);
  render(<PlumesPage source={buildReport(snapshot, later).sources.plumes} now={later} />);
  expect(screen.getAllByText(/cropped panels unavailable, showing the original chart/)).toHaveLength(12);
  expect(screen.getAllByRole("img").filter((i) => i.getAttribute("src")?.startsWith("https://weather.utah.edu/"))).toHaveLength(12);
});
