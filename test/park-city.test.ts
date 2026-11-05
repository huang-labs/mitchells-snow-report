import { describe, expect, it } from "vitest";
import { parseParkCity, parkCitySource } from "@/lib/sources/park-city";
import { RESORTS, FORECAST_AREAS } from "@/lib/catalog";
import { SOURCES } from "@/lib/sources";
import { collectSource } from "@/lib/collect";
import { parseMtnPowder } from "@/lib/sources/mtnpowder";
import { createFixtureFetch, fixture } from "./fixtureFetch";

describe("Park City official snow report", () => {
  const html = fixture("park-city-snow-report.html");
  it("keeps measured zeros, hidden windows and the explicit publication offset", () => {
    const report = parseParkCity(html);
    expect(report.reportTime).toBe("2026-11-04T23:08:00.000Z");
    expect(report.snowfall.h24).toMatchObject({ state: "reported", value: 0 });
    expect(report.snowfall.d7).toMatchObject({ state: "reported", value: 5 });
    expect(report.snowfall.h12.state).toBe("unavailable");
    expect(report.snowfall.overnight.state).toBe("unavailable");
    expect(report.snowfall.storm.state).toBe("unavailable");
    expect(report.liftsOpen).toBeNull();
    expect(report.reportingLocation?.elevationFt).toBeNull();
    expect(parseParkCity(html.replace("MST", "MDT")).reportTime).toBe("2026-11-04T22:08:00.000Z");
  });
  it("keeps an empty field distinct from a reported zero", () => {
    const missing = html.replace('"TwentyFourHourSnowfall":{"Inches":"0"', '"TwentyFourHourSnowfall":{"Inches":"--"');
    expect(parseParkCity(missing).snowfall.h24.state).toBe("not_reported");
  });
  it("rejects a hidden report, missing publication date and HTTP 200 error pages", () => {
    expect(() => parseParkCity(html.replace('"HideSnowReport":false', '"HideSnowReport":true'))).toThrow(/hidden/);
    expect(() => parseParkCity(html.replace("Updated November", "Unknown November"))).toThrow(/publication/);
    expect(() => parseParkCity("The system cannot process your request")).toThrow(/blocked/);
  });
  it("retries the CDN error document once and retains the previous report if both pages fail", async () => {
    const now = new Date("2026-11-05T15:00:00Z");
    const retry = createFixtureFetch([
      [/weather-report\.aspx$/, () => new Response("The system cannot process your request")],
    ]);
    const good = await collectSource(parkCitySource, undefined, {}, now, retry.fetchImpl);
    expect(good.status).toBe("ok");
    expect(retry.calls).toHaveLength(2);
    const failed = createFixtureFetch([
      [/weather-report\.aspx/, () => new Response("The system cannot process your request")],
    ]);
    const bad = await collectSource(parkCitySource, good, {}, now, failed.fetchImpl);
    expect(bad.status).toBe("error");
    expect(bad.payload).toEqual(good.payload);
    expect(failed.calls).toHaveLength(2);
  });
});

it("uses Deer Valley's Mid-Mountain report time rather than the newer resort-wide update", () => {
  const report = parseMtnPowder(JSON.parse(fixture("mtnpowder-deer-valley.json")), {
    resort: "Deer Valley", sourceUrl: "https://www.deervalley.com/explore-the-mountain/mountain-report", reportingArea: "mid",
  }).report;
  expect(report.reportTime).toBe("2026-10-13T18:58:30.000Z");
  expect(report.reportingLocation?.name).toBe("Mid-Mountain");
  expect(report.snowfall.h24).toMatchObject({ state: "reported", value: 0 });
});

it("preserves catalog order for resort collection and distinct Utah forecast areas", () => {
  expect(SOURCES.filter(s => s.category === "resort").map(s => s.id)).toEqual(RESORTS.map(r => r.id));
  expect(FORECAST_AREAS.filter(a => a.region === "utah").map(a => a.id)).toEqual(["LCC", "BCC", "park-city", "deer-valley", "snowbasin"]);
});
