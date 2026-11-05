// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clearArchivedPosts } from "@/components/dailysnow/archive";
import { DailySnowPage } from "@/components/dailysnow/DailySnow";
import { RegionalPage } from "@/components/sections/RegionalPage";
import { buildReport } from "@/lib/report";
import type { ApiDailySnow } from "@/lib/types";
import type { StormRecord } from "@/lib/dailysnow/storm-types";

const now = new Date("2026-11-01T15:00:00Z");
const post: ApiDailySnow = {
  date: "2026-11-01",
  phase: "storm",
  title: "Storm Underway",
  summary: "The main surge is here today with snow above 8,000 feet.",
  sections: [
    { id: "update", paragraphs: [{ text: "Snow levels fall through tonight:", figure: "nws-snow-level" }, { text: "Stakes are filling in:", figure: "stake-alta" }] },
    { id: "extended", paragraphs: [{ text: "A weak system arrives Wednesday.", figure: null }] },
  ],
  figures: {
    "nws-snow-level": { id: "nws-snow-level", kind: "snow-level", caption: "NWS forecast snow level", series: [{ canyon: "LCC", points: [{ start: "2026-11-01T12:00:00Z", ft: 8000 }, { start: "2026-11-01T18:00:00Z", ft: 7000 }] }] },
    "stake-alta": { id: "stake-alta", kind: "image", caption: "Alta snow stake · 5:55 AM today", url: "/api/daily-snow/figure/2026-11-01/stake-alta", originUrl: "https://example.com/stake.jpg", width: null, height: null },
  },
  numbers: {
    canyons: [{ canyon: "LCC", point: "Alta / Snowbird (LCC)", next24In: 12.3, next72In: 16.8, next7dIn: 17.1, nextStorm: null, forecastUpdatedAt: null }],
    resorts: [{ id: "alta", name: "Alta", h24: 9, storm: 11, reportTime: null }],
  },
  generatedAt: "2026-11-01T13:00:00Z",
  model: "@cf/zai-org/glm-5.3-flash",
  trigger: "morning",
  outdated: false,
  failing: false,
  archive: [{ date: "2026-11-01", title: "Storm Underway" }, { date: "2026-10-31", title: "Storm Arrives" }],
};
const report = (dailySnow: ApiDailySnow | null) => ({ ...buildReport(null, now), dailySnow });

it.each(["24h", "48h"] as const)("shows a compact frozen storm recap with qualified %s observations and missing totals", (window) => {
  const observation = { amountIn: 15, window: "storm" as const, reportTime: "2026-11-01T12:00:00Z", collectedAt: "2026-11-01T13:00:00Z", sourceUrl: "https://www.alta.com/" };
  const storm: StormRecord = {
    id: "storm", firstObservedAt: observation.reportTime, lastSnowAt: observation.reportTime, updatedAt: observation.collectedAt,
    status: "wrapping-up", closedAt: null, closureReason: null,
    resorts: [
      { id: "alta", name: "Alta", total: { ...observation, previousAmountIn: 16 }, rolling: null },
      { id: "snowbird", name: "Snowbird", total: null, rolling: { ...observation, window, reportTime: "2026-10-31T12:00:00Z", sourceUrl: "https://www.snowbird.com/" } },
      { id: "solitude", name: "Solitude", total: { ...observation, amountIn: 9, previousAmountIn: 8, reportTime: null }, rolling: null, counterResetAt: observation.collectedAt, latestSegment: { ...observation, amountIn: 2 } },
      { id: "brighton", name: "Brighton", total: null, rolling: null },
    ],
  };
  const caption = "Storm recap · tracked since Yesterday 6:00 AM";
  const withStorm = { ...post, stormRecap: storm, figures: { ...post.figures, "storm-recap": { id: "storm-recap", kind: "storm-recap" as const, caption, storm } } };
  render(<DailySnowPage report={report(withStorm)} now={now} />);
  const table = within(screen.getByRole("table", { name: "Observations for this storm" }));
  expect(table.getByRole("columnheader", { name: "Report time" })).toBeTruthy();
  expect(table.getByRole("row", { name: "Alta 15″ · Reported storm total Sun, Nov 1, 5:00 AM MST" })).toBeTruthy();
  expect(table.getByRole("row", { name: `Snowbird 15″ · Earlier ${window === "48h" ? "48 h" : "24 h"} observation Sat, Oct 31, 6:00 AM MDT` })).toBeTruthy();
  expect(table.getByText("Sat, Oct 31, 6:00 AM MDT").getAttribute("datetime")).toBe("2026-10-31T12:00:00Z");
  expect(table.getByRole("row", { name: "Solitude 9″ · Earlier reported storm total Time unavailable" })).toBeTruthy();
  expect(table.getByRole("row", { name: "Brighton — · Storm total unavailable —" })).toBeTruthy();
  expect(table.queryAllByRole("link")).toHaveLength(0);
  expect(table.queryByText(/Checked|Report Today|Previously reported|Source revised|Source counter reset|since reset|Full storm total unavailable/i)).toBeNull();
  expect(screen.getByText(caption, { selector: "figcaption" })).toBeTruthy();
  expect(document.querySelectorAll(".dailysnow-storm")).toHaveLength(1);
});

it("attributes the NWS clearly in older saved prose and summaries", () => {
  const old = { ...post, summary: "The discussion expects snow.", sections: [{ id: "update" as const, paragraphs: [{ text: "According to the discussion, snow ends today.", figure: null }] }] };
  render(<DailySnowPage report={report(old)} now={now} />);
  expect(screen.getAllByText("The NWS expects snow.")).toHaveLength(1);
  expect(screen.getByText("According to the NWS, snow ends today.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/discussion/i);
});
afterEach(() => {
  cleanup();
  clearArchivedPosts();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("shows the post as page content with the AI badge, sections and figures", () => {
  render(<DailySnowPage report={report(post)} now={now} />);
  expect(screen.getByRole("heading", { level: 1, name: "Storm Underway" })).toBeTruthy();
  expect(screen.getByText(/Daily Snow/, { selector: ".eyebrow" }).querySelector(".badge--ai")?.textContent).toBe("AI");
  expect(screen.getByText(/Storm$/, { selector: ".eyebrow" })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Today", "Extended Forecast"]);
  // Page content, not a card like the resort pick.
  expect(document.querySelector(".page--dailysnow .dailysnow-teaser")).toBeNull();
  const article = within(document.querySelector<HTMLElement>(".dailysnow__article")!);
  expect(article.getByRole("img", { name: "NWS forecast snow level" })).toBeTruthy();
  expect(article.getByRole("img", { name: "Alta snow stake · 5:55 AM today" }).getAttribute("src")).toBe("/api/daily-snow/figure/2026-11-01/stake-alta");
  expect(screen.getByText(/AI-generated from NWS forecasts.*GLM 5\.3 Flash/)).toBeTruthy();
});

it("labels a delayed replacement on the latest article", () => {
  const delayed: ApiDailySnow = { ...post, outdated: true, failing: true, publicationStatus: "delayed" };
  render(<DailySnowPage report={report(delayed)} now={now} />);
  const badges = screen.getAllByText("Latest edition delayed");
  expect(badges).toHaveLength(1);
  expect(badges.every((b) => b.className === "badge badge--warn")).toBe(true);
  expect(screen.queryByText(/Outdated|Today's post failed/)).toBeNull();
});

it.each(["scheduled", "pending", "paused"] as const)("dates the latest edition without a warning when publication is %s", (publicationStatus) => {
  const older = { ...post, outdated: true, publicationStatus };
  render(<DailySnowPage report={report(older)} now={now} />);
  expect(screen.queryByText("Latest edition delayed")).toBeNull();
  expect(screen.getAllByText(/Posted Sun, Nov 1, 6:00 AM MST/)).toHaveLength(1);
});

it("waits for the first post", () => {
  render(<DailySnowPage report={report(null)} now={now} />);
  expect(screen.getByRole("heading", { level: 1, name: "Waiting for the first post" })).toBeTruthy();
});

it("opens an archived post and returns to the latest", async () => {
  const older: ApiDailySnow = { ...post, date: "2026-10-31", title: "Storm Arrives", outdated: true, publicationStatus: "delayed" };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(older), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<DailySnowPage report={report(post)} now={now} />);
  const nav = within(document.querySelector<HTMLElement>(".dailysnow__nav")!);
  fireEvent.click(nav.getByRole("button", { name: /Storm Arrives/ }));
  expect(await screen.findByRole("heading", { level: 1, name: "Storm Arrives" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/daily-snow?channel=western-us&date=2026-10-31");
  expect(window.location.search).toBe("?date=2026-10-31");
  expect(screen.getByText(/· Archive/)).toBeTruthy();
  expect(screen.queryByText("Latest edition delayed")).toBeNull();
  // Re-query: the nav re-renders (older link becomes the return link) with the archived post.
  const navAfter = within(document.querySelector<HTMLElement>(".dailysnow__nav")!);
  fireEvent.click(navAfter.getByRole("button", { name: /Storm Underway/ }));
  await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Storm Underway" })).toBeTruthy());
  expect(window.location.search).toBe("");
});

it("offers date navigation only after the article", () => {
  const edition: ApiDailySnow = { ...post,
    older: { date: "2026-10-31", title: "Storm Arrives" },
    newer: { date: "2026-11-02", title: "Storm Exits" },
  };
  render(<DailySnowPage report={report(edition)} now={now} />);
  expect(screen.queryByRole("navigation", { name: "Daily Snow archive" })).toBeNull();
  expect(screen.getAllByRole("navigation")).toHaveLength(1);
  const bottom = screen.getByRole("navigation", { name: "Daily Snow archive (end of article)" });
  expect(document.querySelector(".dailysnow__footer")!.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const previous = within(bottom).getByRole("button", { name: "Previous post: Sat, Oct 31: Storm Arrives" });
  const next = within(bottom).getByRole("button", { name: "Next post: Mon, Nov 2: Storm Exits" });
  expect(previous.textContent).toBe("← Sat, Oct 31");
  expect(next.textContent).toBe("Mon, Nov 2 →");
});

it("omits empty navigation and only shows the available direction at archive ends", () => {
  const { rerender } = render(<DailySnowPage report={report({ ...post, archive: [] })} now={now} />);
  expect(screen.queryByRole("navigation")).toBeNull();
  rerender(<DailySnowPage report={report({ ...post, archive: [], newer: { date: "2026-11-02", title: "Storm Exits" } })} now={now} />);
  const nav = within(screen.getByRole("navigation", { name: "Daily Snow archive (end of article)" }));
  expect(nav.queryByRole("button", { name: /Previous post/ })).toBeNull();
  expect(nav.getByRole("button", { name: /Next post/ })).toBeTruthy();
});

it("walks the archive through each post's neighbor links, past the recent-posts list", async () => {
  // The live post's older neighbor isn't in the archive list; only its own link reaches it.
  const live: ApiDailySnow = { ...post, archive: [{ date: "2026-11-01", title: "Storm Underway" }], older: { date: "2026-09-15", title: "Early Season Dusting" } };
  const old: ApiDailySnow = { ...post, date: "2026-09-15", title: "Early Season Dusting", outdated: true, archive: live.archive, older: { date: "2026-09-10", title: "First Flakes" }, newer: { date: "2026-11-01", title: "Storm Underway" } };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(old), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<DailySnowPage report={report(live)} now={now} />);
  const nav = () => within(document.querySelector<HTMLElement>(".dailysnow__nav")!);
  fireEvent.click(nav().getByRole("button", { name: /Early Season Dusting/ }));
  expect(await screen.findByRole("heading", { level: 1, name: "Early Season Dusting" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/daily-snow?channel=western-us&date=2026-09-15");
  expect(nav().getByRole("button", { name: /First Flakes/ })).toBeTruthy();
  // The newer link back to the live post drops ?date= rather than linking today's date.
  fireEvent.click(nav().getByRole("button", { name: /Storm Underway/ }));
  await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Storm Underway" })).toBeTruthy());
  expect(window.location.search).toBe("");
});

it("shows the recent posts in a left rail beside the article, latest first, at most five", () => {
  const history = [
    { date: "2026-11-01", title: "Storm Underway" },
    { date: "2026-10-31", title: "Storm Arrives" },
    { date: "2026-10-30", title: "Snow Showers Return" },
    { date: "2026-10-29", title: "A Quiet Stretch" },
    { date: "2026-10-28", title: "Storm Exiting" },
    { date: "2026-10-27", title: "Upslope Snow Continues" },
  ];
  render(<DailySnowPage report={report({ ...post, archive: history })} now={now} />);
  const rail = document.querySelector<HTMLElement>(".dailysnow__history")!;
  expect(rail.getAttribute("aria-label")).toBe("Recent Daily Snow posts");
  // Counts posts, not days: a day without a post must not make the heading wrong.
  expect(rail.querySelector(".dailysnow__history-heading")?.textContent).toBe("Recent posts");
  const entries = [...rail.querySelectorAll(".dailysnow__history-entry")];
  expect(entries.map((e) => e.querySelector(".dailysnow__history-entry-date")?.textContent)).toEqual(["Latest · Sun, Nov 1", "Sat, Oct 31", "Fri, Oct 30", "Thu, Oct 29", "Wed, Oct 28"]);
  // The live post is today's entry — marked active at rest — and not repeated from the archive.
  expect(entries[0].getAttribute("data-active")).toBe("true");
  expect(entries.map((e) => e.querySelector(".dailysnow__history-entry-title")?.textContent)).toEqual(["Storm Underway", "Storm Arrives", "Snow Showers Return", "A Quiet Stretch", "Storm Exiting"]);
  expect(entries[0].querySelector(".dailysnow__history-entry-phase")?.textContent).toBe("Storm");
});

it("hides the rail while the live post is the only one, but keeps the archive links", () => {
  render(<DailySnowPage report={report({ ...post, archive: [{ date: "2026-11-01", title: "Storm Underway" }], older: { date: "2026-10-31", title: "Storm Arrives" } })} now={now} />);
  expect(document.querySelector(".dailysnow__history")).toBeNull();
  expect(document.querySelector(".dailysnow__nav")).not.toBeNull();
});

it("highlights the viewed post in the rail and keeps the archive links for phones", async () => {
  const older: ApiDailySnow = { ...post, date: "2026-10-31", title: "Storm Arrives", outdated: true };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(older), { headers: { "content-type": "application/json" } })));
  render(<DailySnowPage report={report(post)} now={now} />);
  const rail = document.querySelector<HTMLElement>(".dailysnow__history")!;
  fireEvent.click(rail.querySelectorAll<HTMLElement>(".dailysnow__history-entry")[1]!);
  expect(await screen.findByRole("heading", { level: 1, name: "Storm Arrives" })).toBeTruthy();
  // Re-query: the rail re-renders with the archived post loaded.
  const active = document.querySelector(".dailysnow__history-entry[data-active]");
  expect(active?.querySelector(".dailysnow__history-entry-title")?.textContent).toBe("Storm Arrives");
  // The bar and fill follow the viewed post: exactly one entry is highlighted.
  expect(document.querySelectorAll(".dailysnow__history-entry[data-active]").length).toBe(1);
  // The bottom archive links stay on every view: phones navigate with them.
  expect(document.querySelector(".dailysnow__nav")).not.toBeNull();
});

it("keeps the shown post and rail on screen while the next post loads, then caches it", async () => {
  const older: ApiDailySnow = { ...post, date: "2026-10-31", title: "Storm Arrives", outdated: true };
  let respond!: (r: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((r) => (respond = r)));
  vi.stubGlobal("fetch", fetchMock);
  render(<DailySnowPage report={report(post)} now={now} />);
  const entries = () => [...document.querySelectorAll<HTMLElement>(".dailysnow__history-entry")];
  fireEvent.click(entries()[1]!);
  // In flight: no "Loading…" swap. The live post, rail and archive links stay; the clicked entry is already active.
  expect(screen.getByRole("heading", { level: 1, name: "Storm Underway" })).toBeTruthy();
  expect(screen.queryByText("Loading…")).toBeNull();
  expect(entries()[1]!.getAttribute("data-active")).toBe("true");
  expect(document.querySelectorAll(".dailysnow__history-entry[data-active]").length).toBe(1);
  expect(screen.getByRole("article", { name: "Daily Snow" }).getAttribute("aria-busy")).toBe("true");
  // The label follows the post on screen, not the pick: the live post isn't marked as archive.
  expect(screen.queryByText(/· Archive/)).toBeNull();
  respond(new Response(JSON.stringify(older), { headers: { "content-type": "application/json" } }));
  expect(await screen.findByRole("heading", { level: 1, name: "Storm Arrives" })).toBeTruthy();
  expect(screen.getByRole("article", { name: "Daily Snow" }).getAttribute("aria-busy")).toBeNull();
  // Back and forth again: the archived post comes from memory, swapped in the same render.
  fireEvent.click(entries()[0]!);
  expect(screen.getByRole("heading", { level: 1, name: "Storm Underway" })).toBeTruthy();
  fireEvent.click(entries()[1]!);
  expect(screen.getByRole("heading", { level: 1, name: "Storm Arrives" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("opens a ?date= link on the archived post without showing the live post first", async () => {
  const older: ApiDailySnow = { ...post, date: "2026-10-31", title: "Storm Arrives", outdated: true };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(older), { headers: { "content-type": "application/json" } })));
  window.history.replaceState(null, "", "/daily-snow?date=2026-10-31");
  render(<DailySnowPage report={report(post)} now={now} />);
  expect(screen.queryByRole("heading", { level: 1, name: "Storm Underway" })).toBeNull();
  expect(await screen.findByRole("heading", { level: 1, name: "Storm Arrives" })).toBeTruthy();
});

it("prefetches a post on hover so the pick shares the request", async () => {
  const older: ApiDailySnow = { ...post, date: "2026-10-31", title: "Storm Arrives", outdated: true };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(older), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<DailySnowPage report={report(post)} now={now} />);
  const entry = document.querySelectorAll<HTMLElement>(".dailysnow__history-entry")[1]!;
  fireEvent.pointerEnter(entry);
  fireEvent.click(entry);
  expect(await screen.findByRole("heading", { level: 1, name: "Storm Arrives" })).toBeTruthy();
  // Hovering the live entry fetches nothing: it comes with the report.
  fireEvent.pointerEnter(document.querySelectorAll<HTMLElement>(".dailysnow__history-entry")[0]!);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retries an archived post that failed to load", async () => {
  const older: ApiDailySnow = { ...post, date: "2026-10-31", title: "Storm Arrives", outdated: true };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("{}", { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(older), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<DailySnowPage report={report(post)} now={now} />);
  fireEvent.click(document.querySelectorAll<HTMLElement>(".dailysnow__history-entry")[1]!);
  expect(await screen.findByText("HTTP 503")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to the latest post" }));
  fireEvent.click(document.querySelectorAll<HTMLElement>(".dailysnow__history-entry")[1]!);
  expect(await screen.findByRole("heading", { level: 1, name: "Storm Arrives" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps the homepage focused on resort timelines", () => {
  render(<RegionalPage report={report(post)} now={now} />);
  expect(screen.queryByRole("link", { name: "Daily Snow: Storm Underway" })).toBeNull();
  expect(document.querySelector("aside.recommendation")).toBeNull();
  expect(document.querySelectorAll(".resort-timeline")).toHaveLength(14);
});

it("draws plume figures like the plumes page: padded, Mountain Time axis, posting-time marker", () => {
  const plume = {
    id: "plume-snow-cln",
    kind: "image" as const,
    caption: "University of Utah ensemble plume · Accumulated Snow · Alta-Collins, UT · 00Z run",
    url: "/api/daily-snow/figure/2026-11-01/plume-snow-cln",
    originUrl: "/api/plume/CLN/2026110100/snow",
    width: 922,
    height: 533,
    axis: { plot: { left: 66, right: 920, top: 30, bottom: 525 }, initTime: "2026-11-01T00:00:00Z", forecastHours: 240 },
  };
  const withPlume: ApiDailySnow = {
    ...post,
    sections: [{ id: "update", paragraphs: [{ text: "The plume:", figure: "plume-snow-cln" }] }],
    figures: { "plume-snow-cln": plume },
  };
  const { unmount } = render(<DailySnowPage report={report(withPlume)} now={now} />);
  const svg = screen.getByRole("img", { name: /Accumulated Snow.*times in America\/Denver/ });
  // White margin around the crop (the shared plumes-page drawing).
  expect(svg.getAttribute("viewBox")).toBe("-20 -20 962 639");
  expect(svg.querySelector("image")?.getAttribute("href")).toBe(plume.url);
  // Mountain Time day labels in place of the cropped UTC ones; init is Sat 6 PM MDT.
  expect([...svg.querySelectorAll(".plume__day")].map((t) => t.textContent).slice(0, 3)).toEqual(["Sun", "Mon", "Tue"]);
  expect(svg.querySelector(".plume__nowlabel")?.textContent).toBe("posted");
  unmount();

  // Posts written before the axis was stored keep the bare still, padded.
  const { axis: _axis, ...legacy } = plume;
  const { unmount: unmountLegacy } = render(<DailySnowPage report={report({ ...withPlume, figures: { "plume-snow-cln": legacy } })} now={now} />);
  const img = screen.getByRole("img", { name: plume.caption });
  expect(img.tagName).toBe("IMG");
  expect(img.closest("figure")?.className).toContain("dailysnow-figure--plume");
  unmountLegacy();

  // Code-added required figures render after the prose, without invented introductions.
  render(<DailySnowPage report={report({ ...withPlume, sections: [{ id: "update", paragraphs: [{ text: "A quiet day.", figure: null }] }] })} now={now} />);
  expect(screen.getAllByRole("img", { name: /Accumulated Snow.*times in America\/Denver/ })).toHaveLength(1);
  expect(screen.getByText("A quiet day.")).toBeTruthy();
});

it("uses the article skeleton for a pending direct archive link, then shows its failure", async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
  window.history.replaceState(null, "", "/daily-snow?date=2026-10-31");
  render(<DailySnowPage report={report(post)} now={now} />);
  expect(screen.getByRole("status").textContent).toBe("Loading Daily Snows…");
  expect(document.querySelector("[aria-busy=true]")).toBeTruthy();
  expect(screen.queryByText(/posted every morning/)).toBeNull();
  await act(async () => { respond(new Response("unavailable", { status: 503 })); });
  expect(screen.getByRole("heading", { name: "Post not available" })).toBeTruthy();
  expect(screen.getByText("HTTP 503")).toBeTruthy();
  expect(document.querySelector("[aria-busy=true]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to the latest post" }));
  expect(screen.getByRole("heading", { name: "Storm Underway" })).toBeTruthy();
});

it("shows the West selector before the article and renders forecast zeros separately from missing values", () => {
  const west: ApiDailySnow = {
    ...post, channel: "western-us", timeZone: "America/Los_Angeles",
    figures: { "west-week": { id: "west-week", kind: "forecast-comparison", caption: "NWS this week", windows: [
      { label: "Days 1–3", days: "Thu–Sun", start: now.toISOString(), end: now.toISOString() },
      { label: "Days 4–7", days: "Sun–Thu", start: now.toISOString(), end: now.toISOString() },
    ], rows: [
      { region: "Utah", point: "Alta", snowIn: [0, 4.5], issuedAt: now.toISOString() },
      { region: "Utah", point: "Brighton", snowIn: [null, 2], issuedAt: null },
    ] } },
    sections: [
      { id: "update", paragraphs: [{ text: "The broad weather pattern follows.", figure: null }] },
      { id: "short-term", paragraphs: [{ text: "This week's pattern follows.", figure: "west-week" }] },
      { id: "extended", paragraphs: [{ text: "Week two follows.", figure: null }] },
    ],
    regionalHighlights: [{ region: "utah", text: "A retained older edition's highlight." }],
  };
  render(<DailySnowPage report={report(west)} now={now} selector={<select aria-label="Region"><option>United States West</option></select>} />);
  const article = screen.getByRole("article");
  expect(article.firstElementChild).toBe(screen.getByRole("combobox", { name: "Region" }));
  expect(screen.getByRole("heading", { name: "The Big Picture" })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(expect.arrayContaining(["The Big Picture", "This Week", "Week Two"]));
  const table = within(screen.getByRole("table", { name: "NWS this week" }));
  expect(table.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Mountain forecast point", "Days 1–3Thu–Sun", "Days 4–7Sun–Thu"]);
  expect(table.getByText("4.5″")).toBeTruthy();
  expect(table.getByText("0.0″")).toBeTruthy();
  expect(table.getByText("—")).toBeTruthy();
  // A row without an NWS issue time says so rather than formatting a missing timestamp.
  expect(table.getByText("Utah · issue time not published")).toBeTruthy();
  expect(table.getAllByText(/^Utah · issued /)).toHaveLength(1);
  expect(within(article).queryAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/daily-snow/"))).toHaveLength(0);
});
