// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Figure } from "@/components/dailysnow/figures";
import type { DailySnowFigure } from "@/lib/types";

afterEach(cleanup);

const points = (ft: number) => [{ start: "2026-11-01T12:00:00Z", ft }, { start: "2026-11-01T18:00:00Z", ft: ft - 500 }];
const figure: DailySnowFigure = {
  id: "nws-snow-level",
  kind: "snow-level",
  caption: "NWS forecast snow level",
  series: (["LCC", "BCC", "park-city", "deer-valley", "snowbasin"] as const).map((canyon, i) => ({ canyon, points: points(8000 + i * 100) })),
};

it("gives every location its own color and dash, matched in the legend", () => {
  const { container } = render(<Figure figure={figure} postedAt="2026-11-01T15:00:00Z" />);
  const legend = [...container.querySelectorAll(".snow-level__key")];
  expect(legend.map((k) => k.textContent)).toEqual(["LCC", "BCC", "Park City", "Deer Valley", "Snowbasin"]);
  const swatches = legend.map((k) => k.querySelector("line") as SVGLineElement);
  const styles = swatches.map((l) => `${l.style.stroke}|${l.style.strokeDasharray}`);
  expect(new Set(swatches.map((l) => l.style.stroke)).size).toBe(5);
  expect(new Set(swatches.map((l) => l.style.strokeDasharray)).size).toBe(5);
  // Lines match their legend entries (the chart draws once it has measured a width).
  const lines = [...container.querySelectorAll<SVGPolylineElement>(".snow-level__line")];
  if (lines.length) expect(lines.map((l) => `${l.style.stroke}|${l.style.strokeDasharray}`)).toEqual(styles);
});
