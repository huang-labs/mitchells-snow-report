// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import { RESORTS } from "@/lib/catalog";
import { renderSection } from "@/components/SectionView";
import { ResortReportPage } from "@/components/sections/ResortReportPage";
import { runCollection } from "@/lib/collect";
import { buildReport } from "@/lib/report";
import { MemoryKV, readSnapshot } from "@/lib/store";
import type { ApiSource, ReportResponse, ResortCamsPayload, ResortReport } from "@/lib/types";
import { createFixtureFetch, FIXTURE_NOW } from "./fixtureFetch";

let report: ReportResponse;
beforeAll(async () => {
  const kv = new MemoryKV();
  await runCollection(
    { SNOW_KV: kv },
    { now: FIXTURE_NOW, fetchImpl: createFixtureFetch().fetchImpl },
  );
  report = buildReport(await readSnapshot(kv), FIXTURE_NOW);
});
afterEach(cleanup);

it("opens a resort's own forecast region regardless of the saved regional preference",()=>{
  render(renderSection("mammoth-mountain",report,FIXTURE_NOW,null));
  expect(screen.getByRole("link",{name:"Forecast ↗"}).getAttribute("href")).toBe("/weather/mammoth");
});

it.each(["alta", "snowbird", "solitude", "brighton"])(
  "renders %s as a long-form report page",
  (id) => {
    const { container } = render(
      renderSection(id, report, FIXTURE_NOW, null),
    );
    expect(container.querySelector(".resort-report")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Lifts" }),
    ).toBeTruthy();
    // Named terrain & gates is a sibling of Lifts, not a sub-heading.
    const terrain = screen.getByRole("heading", { name: "Named terrain & gates" });
    expect(terrain.tagName).toBe("H2");
    expect(
      screen.getByRole("heading", { name: "Lifts" }).tagName,
    ).toBe("H2");
    expect(screen.queryByRole("heading", { name: "Getting there" })).toBeNull();
  },
);

it("capitalizes every lift and terrain status regardless of source casing", () => {
  for (const id of ["alta", "snowbird", "solitude", "brighton"]) {
    const { container } = render(renderSection(id, report, FIXTURE_NOW, null));
    for (const span of container.querySelectorAll(".status-item__row span")) {
      const label = (span.textContent ?? "").trim();
      if (label) expect(label).toMatch(/^[A-Z]/);
    }
    cleanup();
  }
});

it("keeps critical notices above snow and retains the full narrative, lift hours and terrain notes", () => {
  const base = report.sources.alta.payload as ResortReport;
  const narrative = "Detailed mountain report. ".repeat(40);
  const source: ApiSource<ResortReport> = {
    ...report.sources.alta,
    payload: {
      ...base,
      narrative,
      notices: [
        {
          title: "Opening update",
          text: "Delayed opening",
          severity: "critical",
        },
      ],
      lifts: [
        {
          name: "Collins",
          status: "hold",
          rawStatus: "Wind hold",
          hours: "9:15 AM–4 PM",
          note: "Reassessing at 10 AM",
        },
      ],
      terrain: [
        {
          name: "Ballroom",
          status: "scheduled",
          rawStatus: "Expected later",
          kind: "area",
          note: "Patrol work in progress",
        },
      ],
    },
  };
  const { container } = render(
    <ResortReportPage source={source} now={FIXTURE_NOW} />,
  );
  expect(
    screen
      .getByText("Opening update")
      .compareDocumentPosition(
        screen.getByRole("heading", { name: "Snowfall" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    container.querySelector(".resort-narrative details > p")?.textContent,
  ).toBe(narrative);
  const disclosure = container.querySelector<HTMLDetailsElement>(
    ".resort-narrative details",
  )!;
  expect(disclosure.open).toBe(false);
  expect(
    container.querySelector(".resort-narrative__preview")?.textContent?.length,
  ).toBeLessThanOrEqual(241);
  fireEvent.click(disclosure.querySelector("summary")!);
  expect(disclosure.open).toBe(true);
  fireEvent.click(disclosure.querySelector("summary")!);
  expect(disclosure.open).toBe(false);
  expect(
    container
      .querySelector(".resort-weather")
      ?.nextElementSibling?.classList.contains("resort-narrative"),
  ).toBe(true);
  expect(
    container
      .querySelector(".resort-narrative")
      ?.nextElementSibling?.classList.contains("resort-operations"),
  ).toBe(true);
  expect(screen.getByText("9:15 AM–4 PM")).toBeTruthy();
  expect(screen.getByText("Patrol work in progress")).toBeTruthy();
});

it("preserves Alta's own snow windows and distinguishes zero, empty and unsupported fields", () => {
  const base = report.sources.alta.payload as ResortReport;
  const source: ApiSource<ResortReport> = {
    ...report.sources.alta,
    payload: {
      ...base,
      snowfall: {
        ...base.snowfall,
        h24: { state: "not_reported", label: "24-hour snow" },
      },
    },
  };
  const { container } = render(
    <ResortReportPage source={source} now={FIXTURE_NOW} />,
  );
  expect(
    container.querySelector(".resort-snow__headline .resort-metric__qualifier")?.textContent,
  ).toMatch(/12/);
  // An empty field and an unpublished window share one "no data" mark.
  const empty = container.querySelector(".resort-snow__headline .metric--not_reported")!;
  expect(empty.textContent).toBe("—");
  expect(empty.querySelector("[aria-label='no data']")!.getAttribute("title")).toBe("Not reported in this update");
  expect(container.querySelector(".resort-snow__history .metric--unavailable")!.textContent).toBe("—");
  expect(container.textContent).not.toContain("not reported");
  expect(
    container.querySelector(".resort-snow__headline .metric__value--zero")
      ?.textContent,
  ).toContain("0");
  // One line names every missing value, empty or unpublished.
  const missing = container.querySelector(".resort-snow__unavailable")!.textContent!;
  expect(missing).toMatch(/^No data from Alta: /);
  expect(missing).toContain("24 h");
  expect(missing).toContain("48 h");
  // Alta's Overnight tile holds its 12 h total, so overnight isn't missing.
  expect(missing).not.toContain("Overnight");
});

it("explains Brighton's missing observations and handles a completely unavailable resort", () => {
  const { rerender } = render(
    renderSection("brighton", report, FIXTURE_NOW, null),
  );
  expect(
    screen.getByText(/observations aren’t provided in Brighton/),
  ).toBeTruthy();
  rerender(
    <ResortReportPage
      source={{ ...report.sources.brighton, payload: null }}
      now={FIXTURE_NOW}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Brighton report unavailable" }),
  ).toBeTruthy();
});

it("removes routine road status and shows Alta's Base, Mid and Top temperatures without the unsited Wind block", () => {
  const { container } = render(
    renderSection("alta", report, FIXTURE_NOW, null),
  );
  expect(screen.queryByText("Road Status")).toBeNull();
  expect(
    [...container.querySelectorAll(".resort-observation h3")].map(
      (heading) => heading.textContent,
    ),
  ).toEqual(["Base", "Mid", "Top"]);
  expect(
    [...container.querySelectorAll(".resort-observation dt")].map(
      (label) => label.textContent,
    ),
  ).toEqual(["Temperature", "Temperature", "Temperature"]);
});

it("shows every collected webcam on its resort page, featured ones first", () => {
  const cams = report.sources.resortcams?.payload as ResortCamsPayload | undefined;
  for (const id of ["alta", "snowbird", "solitude", "brighton"]) {
    const { container, unmount } = render(renderSection(id, report, FIXTURE_NOW, null));
    const shown = [...container.querySelectorAll(".resort-cams .rcam figcaption strong")].map((t) => t.textContent);
    expect(shown).toEqual(cams!.cameras.filter((c) => c.resort === id).map((c) => c.title));
    unmount();
  }
  // The featured cameras lead each section in WANTED order.
  const first = (id: string) => {
    const { container, unmount } = render(renderSection(id, report, FIXTURE_NOW, null));
    const title = container.querySelector(".resort-cams .rcam figcaption strong")!.textContent;
    unmount();
    return title;
  };
  expect(first("alta")).toBe("Snow Stake");
  expect(first("snowbird")).toBe("Snowstake");
  expect(first("solitude")).toBe("Solitude Snowstake");
  expect(first("brighton")).toBe("Parking Lot");
});

it("shows the same snowfall slots in the same order for every resort", () => {
  const slots = (id: string) => {
    const { container, unmount } = render(renderSection(id, report, FIXTURE_NOW, null));
    const labels = [...container.querySelectorAll(".resort-snow .resort-metric__label")].map((l) => l.textContent);
    unmount();
    return labels;
  };
  // Alta's Overnight tile holds its 12 h total; no resort shows a separate 12 h slot.
  for (const { id } of RESORTS) {
    expect(slots(id)).toEqual(["Overnight", "24 h", "Base depth", "48 h", "72 h", "7 days", "Storm", "Season"]);
  }
});

it("captions Alta's Overnight tile with its 12-hour window and doesn't list overnight as unsupported", () => {
  const { container } = render(renderSection("alta", report, FIXTURE_NOW, null));
  const first = container.querySelector(".resort-snow__headline .resort-metric")!;
  expect(first.querySelector(".resort-metric__label")!.textContent).toBe("Overnight");
  expect(first.querySelector(".resort-metric__qualifier")!.textContent).toMatch(/12/);
  expect(container.querySelector(".resort-snow__unavailable")?.textContent ?? "").not.toMatch(/Overnight|12 h/);
});

it("fills the Overnight tile with a published 12 h figure when overnight is empty", () => {
  const base = report.sources.brighton.payload as ResortReport;
  const source: ApiSource<ResortReport> = {
    ...report.sources.brighton,
    payload: {
      ...base,
      snowfall: {
        ...base.snowfall,
        overnight: { state: "not_reported", label: "Snow Overnight" },
        h12: { state: "reported", value: 4, unit: "in", label: "Snow 12 Hrs." },
      },
    },
  };
  const { container, unmount } = render(<ResortReportPage source={source} now={FIXTURE_NOW} />);
  const first = container.querySelector(".resort-snow__headline .resort-metric")!;
  expect(first.querySelector(".resort-metric__label")!.textContent).toBe("Overnight");
  expect(first.querySelector(".metric__value")!.textContent).toBe("4″");
  expect(first.querySelector(".resort-metric__qualifier")!.textContent).toBe("Snow 12 Hrs.");
  unmount();
  // With overnight published, the tile keeps it.
  const both = structuredClone(source);
  (both.payload as ResortReport).snowfall.overnight = { state: "reported", value: 2, unit: "in", label: "Snow Overnight" };
  const view = render(<ResortReportPage source={both} now={FIXTURE_NOW} />);
  expect(view.container.querySelector(".resort-snow__headline .metric__value")!.textContent).toBe("2″");
});

it("keeps a resort's wording only where its window differs, and lists shared source notes once", () => {
  const base = report.sources.solitude.payload as ResortReport;
  const note = "Mid-Mountain measurement location";
  const source: ApiSource<ResortReport> = {
    ...report.sources.solitude,
    payload: {
      ...base,
      snowfall: {
        ...base.snowfall,
        overnight: { state: "reported", value: 2, unit: "in", label: "Since lifts closed", note },
        h24: { state: "reported", value: 5, unit: "in", label: "Last 24 hours", note },
      },
    },
  };
  const { container } = render(<ResortReportPage source={source} now={FIXTURE_NOW} />);
  const qualifiers = [...container.querySelectorAll(".resort-metric__qualifier")].map((q) => q.textContent);
  expect(qualifiers).toEqual(["Since lifts closed"]);
  const notes = container.querySelector(".resort-snow__notes")!.textContent!;
  expect(notes.split(note)).toHaveLength(2);
  expect(notes).toContain("Overnight, 24 h");
});

it("shows each resort as a snowfall timeline: 7 recorded days, the last 24 h, 7 NWS forecast days", () => {
  const { container } = render(renderSection("regional", report, FIXTURE_NOW, null));
  const blocks = [...container.querySelectorAll(".resort-timeline")];
  expect(blocks.map((b) => b.querySelector(".resort-name")?.textContent)).toEqual(["Alta", "Snowbird", "Solitude", "Brighton", "Park City", "Deer Valley", "Snowbasin", "Palisades Tahoe", "Mammoth Mountain", "Jackson Hole", "Big Sky", "Winter Park", "Steamboat", "Telluride", "Crystal Mountain", "Mt. Bachelor"]);
  const alta = blocks[0];
  expect(alta.querySelectorAll(".snowtl__day--past")).toHaveLength(7);
  expect(alta.querySelectorAll(".snowtl__day--today")).toHaveLength(1);
  // The fixture NWS grid covers the whole week: no day is missing its forecast.
  expect(alta.querySelectorAll(".snowtl__day--forecast.snowtl__day--forecast")).toHaveLength(7);
  expect(alta.querySelectorAll(".snowtl__day--no_forecast")).toHaveLength(0);
  // "Next 7 days" carries the week's forecast total, the sum of the day bars.
  const next = alta.querySelector(".snowtl__span--next")!;
  expect(next.querySelector(".snowtl__span-label")!.textContent).toBe("Next 7 days");
  expect(next.querySelector(".snowtl__total")!.textContent).toMatch(/^(<1|\d+)″$/);
  expect(next.querySelector(".snowtl__sr")!.textContent).toMatch(/^Next 7 days · [\d.]+″ NWS forecast total, now to 6 AM .* \(LCC grid point\)$/);
  // The first forecast day is the snow day under way, ending at 6 AM (MDT).
  expect(alta.querySelector(".snowtl__day--forecast .snowtl__sr")!.textContent).toMatch(/now to 6 AM \(LCC grid point\)/);
  // BCC resorts use the BCC grid point; the strip carries no source captions.
  expect(blocks[2].querySelector(".snowtl__day--forecast .snowtl__sr")!.textContent).toMatch(/\(BCC grid point\)/);
  expect(alta.textContent).not.toMatch(/Morning reports|NWS forecast ·/);
  // One collection outside a morning window records no history yet.
  expect(alta.querySelectorAll(".snowtl__day--not_recorded")).toHaveLength(7);
  // No reported days: the past total is the no-data mark, never 0″.
  const past = alta.querySelector(".snowtl__span--past")!;
  expect(past.querySelector(".snowtl__span-label")!.textContent).toBe("Past 7 days");
  expect(past.querySelector(".snowtl__total")!.textContent).toBe("—");
  expect(past.querySelector(".snowtl__sr")!.textContent).toBe("Past 7 days · No reported total");
  // The header is the name and region only; the report time sits at its right on phones.
  expect(alta.querySelector(".snowtl__meta")!.textContent).toBe("Utah · United States");
  expect(alta.querySelector(".snowtl__reported-label")!.textContent).toBe("Reported");
  expect(alta.querySelector(".snowtl__reported-time")!.textContent).toMatch(/(Today|Yesterday|, )/);
  expect(alta.querySelector(".snowtl__hero")!.textContent).not.toMatch(/Last 24 hrs/);
  expect(alta.querySelectorAll(".badge")).toHaveLength(0);
  expect(container.querySelector("table")).toBeNull();
});

it("makes each resort's timeline one link to its page, named by the resort", () => {
  const { container } = render(renderSection("regional", report, FIXTURE_NOW, null));
  for (const block of container.querySelectorAll(".resort-timeline")) {
    const links = block.querySelectorAll(".snowtl a");
    expect(links).toHaveLength(1);
    expect(links[0].classList.contains("resort-name__link")).toBe(true);
    expect(links[0].getAttribute("href")).toBe(`/${RESORTS.find(r=>r.name===links[0].textContent)!.id}`);
    expect(block.textContent).not.toContain("View more");
  }
});

it("labels a 24 h figure without a report time as Time unknown, and no figure as No report", () => {
  const base = report.sources.alta;
  const payload = base.payload as ResortReport;
  const withNoTime = { ...report, sources: { ...report.sources, alta: { ...base, payload: { ...payload, reportTime: null } } } };
  const { container, unmount } = render(renderSection("regional", withNoTime, FIXTURE_NOW, null));
  const alta = container.querySelector(".resort-timeline")!;
  expect(alta.querySelector(".snowtl__hero-time")!.textContent).toBe("Time unknown");
  expect(alta.querySelector(".snowtl__reported-time")!.textContent).toBe("Time unknown");
  unmount();
  const noPayload = { ...report, sources: { ...report.sources, alta: { ...base, payload: null } } };
  const view = render(renderSection("regional", noPayload, FIXTURE_NOW, null));
  const empty = view.container.querySelector(".resort-timeline")!;
  expect(empty.querySelector(".snowtl__hero-time")!.textContent).toBe("No report");
  expect(empty.querySelector(".snowtl__reported")).toBeNull();
});

it("describes every day for screen readers, with no interactive controls", () => {
  const { container } = render(renderSection("regional", report, FIXTURE_NOW, null));
  const alta = container.querySelector(".resort-timeline")!;
  const days = [...alta.querySelectorAll(".snowtl__day")];
  expect(days).toHaveLength(15);
  expect(days[7].querySelector(".snowtl__sr")!.textContent).toMatch(/^Last 24 h · .*Alta/);
  expect(days[8].querySelector(".snowtl__sr")!.textContent).toMatch(/NWS forecast, now to 6 AM/);
  expect(days[0].querySelector(".snowtl__sr")!.textContent).toMatch(/Not recorded$/);
  expect(alta.querySelectorAll("button, [tabindex]")).toHaveLength(0);
  expect(alta.querySelector(".snowtl__detail")).toBeNull();
});

it("discloses conflicting source snowfall while retaining the published amounts", () => {
  const source = structuredClone(report.sources.telluride);
  const payload = source.payload as ResortReport;
  payload.snowfall.overnight = { state: "reported", value: 6, unit: "in", label: "Snow overnight" };
  payload.snowfall.h24 = { state: "reported", value: 0, unit: "in", label: "Last 24 hours" };
  const { container } = render(<ResortReportPage source={source} now={FIXTURE_NOW} />);
  expect(screen.getByRole("note").textContent).toContain("Snowfall data warning");
  expect(screen.getByRole("note").textContent).toBe("Snowfall data warning: the resort publishes conflicting or invalid amounts.");
  expect(container.querySelector(".resort-snow__headline")?.textContent).toContain("6");
  expect(payload.snowfall.overnight).toMatchObject({ state: "reported", value: 6 });
});
