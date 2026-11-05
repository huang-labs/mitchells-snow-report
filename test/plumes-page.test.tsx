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
