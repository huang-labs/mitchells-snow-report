// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ReportLoading } from "@/components/loading/ReportLoading";
import { REGIONS, RESORTS } from "@/lib/catalog";

afterEach(cleanup);

it.each(REGIONS)("uses the weather page's single-column layout for $name", ({ id }) => {
  const { container } = render(<ReportLoading sectionId="weather" region={id} />);
  expect(container.querySelector(".weather-grid")).not.toBeNull();
  expect(container.querySelectorAll(".weather-point")).toHaveLength(2);
  expect(container.querySelector(".region-selector select")?.textContent).toBe(REGIONS.find(r => r.id === id)!.name);
});

it("groups plume panels by station using the page's responsive grids", () => {
  const { container } = render(<ReportLoading sectionId="plumes" />);
  expect(container.querySelectorAll(".plume-grid > .plume-station")).toHaveLength(2);
  for (const station of container.querySelectorAll(".plume-station")) expect(station.children).toHaveLength(2);
});

it.each(RESORTS)("keeps the snowfall slots for $name while loading", ({ id }) => {
  const { container } = render(<ReportLoading sectionId={id} />);
  expect(container.querySelector(".resort-snow__headline")?.children).toHaveLength(3);
  expect(container.querySelector(".resort-snow__history")?.children).toHaveLength(5);
});

it("reserves Daily Snow's desktop rail beside the reading-width article", () => {
  const { container } = render(<ReportLoading sectionId="daily-snow" />);
  expect(container.querySelector(".dailysnow-layout > .dailysnow__history[aria-hidden=true]")).not.toBeNull();
  expect(container.querySelector(".dailysnow-layout > .dailysnow .region-selector")).not.toBeNull();
});
