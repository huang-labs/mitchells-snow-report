// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import { renderSection } from "@/components/SectionView";
import { runCollection } from "@/lib/collect";
import { buildReport } from "@/lib/report";
import { MemoryKV, readSnapshot } from "@/lib/store";
import type { ApiDailySnow, ReportResponse } from "@/lib/types";
import { createFixtureFetch, FIXTURE_NOW } from "./fixtureFetch";

let report: ReportResponse;
beforeAll(async () => {
  const kv = new MemoryKV();
  await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl: createFixtureFetch().fetchImpl });
  report = buildReport(await readSnapshot(kv), FIXTURE_NOW);
});
afterEach(cleanup);

const edition = (over: Partial<ApiDailySnow>): ApiDailySnow => ({
  channel: "utah",
  timeZone: "America/Denver",
  date: "2026-11-06",
  phase: "quiet",
  title: "Dry and Clear",
  summary: "No new snow across the region, and the forecast stays dry through the weekend.",
  sections: [{ id: "short-term", paragraphs: [{ text: "Full forecast text.", figure: null }] }],
  figures: {},
  numbers: { canyons: [], resorts: [] },
  generatedAt: "2026-11-06T14:12:00Z",
  model: "@cf/zai-org/glm-5.3-flash",
  trigger: "morning",
  outdated: false,
  failing: false,
  archive: [],
  ...over,
});
const withEditions = (editions: ReportResponse["dailySnows"]) => ({ ...report, dailySnows: editions });

it("shows the resort's regional Daily Snow below Snowfall, labeled as AI with its model and dated", () => {
  const { container } = render(renderSection("alta", withEditions({ utah: edition({}) }), FIXTURE_NOW, null));
  const teaser = container.querySelector(".resort-dailysnow")!;
  expect(teaser.previousElementSibling?.classList.contains("resort-snow")).toBe(true);
  expect(teaser.nextElementSibling?.classList.contains("resort-weather")).toBe(true);
  expect(teaser.querySelector(".badge--ai")?.textContent).toBe("AI");
  expect(screen.getByRole("heading", { name: "Dry and Clear" })).toBeTruthy();
  expect(teaser.textContent).toContain("No new snow across the region");
  expect(teaser.querySelector(".resort-dailysnow__meta")!.textContent).toMatch(/^Utah · Posted .*7:12 AM MST$/);
  expect(teaser.querySelector(".resort-dailysnow__footer")!.textContent).toBe("AI-generated regional forecast · GLM 5.3 Flash");
  // The teaser carries only the summary, not the post's sections.
  expect(teaser.textContent).not.toContain("Full forecast text.");
  const link = screen.getByRole("link", { name: "Read the Utah Daily Snow →" });
  expect(link.getAttribute("href")).toBe("/daily-snow/utah");
  const jumps = [...container.querySelectorAll(".resort-report__jump a")].map((a) => a.textContent);
  expect(jumps.slice(0, 3)).toEqual(["Snowfall", "Daily Snow", "Weather"]);
});

it("uses each resort's own region and its time zone", () => {
  const editions = {
    utah: edition({ title: "Utah edition" }),
    colorado: edition({ channel: "colorado", title: "Six Inches, Then Sunshine" }),
    tahoe: edition({ channel: "tahoe", timeZone: "America/Los_Angeles", title: "Tahoe edition" }),
  };
  const { container, unmount } = render(renderSection("telluride", withEditions(editions), FIXTURE_NOW, null));
  expect(container.querySelector(".resort-dailysnow__title")!.textContent).toBe("Six Inches, Then Sunshine");
  expect(screen.getByRole("link", { name: "Read the Colorado Daily Snow →" }).getAttribute("href")).toBe("/daily-snow/colorado");
  unmount();
  const tahoe = render(renderSection("palisades-tahoe", withEditions(editions), FIXTURE_NOW, null));
  expect(tahoe.container.querySelector(".resort-dailysnow__meta")!.textContent).toMatch(/6:12 AM PST$/);
});

it("keeps showing an older edition under its own date", () => {
  const { container } = render(renderSection("alta", withEditions({ utah: edition({ date: "2026-11-04", generatedAt: "2026-11-04T14:00:00Z", outdated: true }) }), FIXTURE_NOW, null));
  expect(container.querySelector(".resort-dailysnow__meta")!.textContent).toMatch(/Posted Wed, Nov 4, 7:00 AM/);
});

it("shows no teaser when the region has no available edition", () => {
  for (const editions of [undefined, {}, { utah: null }, { colorado: edition({ channel: "colorado" }) }]) {
    const { container, unmount } = render(renderSection("alta", withEditions(editions), FIXTURE_NOW, null));
    expect(container.querySelector(".resort-dailysnow")).toBeNull();
    expect(container.querySelector('.resort-report__jump a[href="#resort-dailysnow-heading"]')).toBeNull();
    expect(container.querySelector(".resort-snow")?.nextElementSibling?.classList.contains("resort-weather")).toBe(true);
    unmount();
  }
});
