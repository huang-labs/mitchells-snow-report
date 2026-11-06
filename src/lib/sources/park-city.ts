import { emptySnowfall, fromField, htmlToText, unavailable } from "../metric";
import { monthFromName, parseOffsetIso } from "../time";
import type { ResortReport, SnowfallSet } from "../types";
import { assertValid, HOUR, type SourceDefinition } from "./types";

export const PARK_CITY_PAGE = "https://www.parkcitymountain.com/the-mountain/mountain-conditions/weather-report.aspx";

/** Parse the measured report embedded by the official page, never its forecast. */
export function parseParkCity(html: string): ResortReport {
  const read = (name: string) => {
    const match = new RegExp(`FR\\.${name}\\s*=\\s*([^\\n]+?);\\s*(?:\\r?\\n|</script>)`).exec(html);
    assertValid(match, `Park City official ${name} missing; upstream may be blocked`);
    return JSON.parse(match[1]);
  };
  const settings = read("snowReportSettings");
  const snow = read("snowReportData");
  assertValid(settings.HideSnowReport === false, "Park City snow report is hidden");
  const date = /^Updated (\w+) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM) (MST|MDT)$/.exec(snow.LastUpdatedText ?? "");
  assertValid(date && monthFromName(date[1]), "Park City publication time missing");
  const pad = (n: number) => String(n).padStart(2, "0");
  const hour = (+date[4] % 12) + (date[6] === "PM" ? 12 : 0);
  const reportTime = parseOffsetIso(`${date[3]}-${pad(monthFromName(date[1])!)}-${pad(+date[2])}T${pad(hour)}:${date[5]}:00${date[7] === "MST" ? "-07:00" : "-06:00"}`);
  assertValid(reportTime, "Park City publication time invalid");
  const snowfall = emptySnowfall();
  const fields: Array<[keyof SnowfallSet, string, string, string]> = [
    ["h12", "OvernightSnowfall", "Show12Hr", "12-hour snowfall"],
    ["h24", "TwentyFourHourSnowfall", "Show24Hr", "24-hour snowfall"],
    ["h48", "FortyEightHourSnowfall", "Show48Hr", "48-hour snowfall"],
    ["d7", "SevenDaySnowfall", "Show7Day", "7-day snowfall"],
    ["season", "CurrentSeason", "ShowTotalSeasonSnowfall", "Season total"],
  ];
  for (const [key, field, visible, label] of fields) {
    if (settings[visible] === true && snow[field] && "Inches" in snow[field])
      snowfall[key] = fromField(snow[field].Inches, "in", label);
  }
  assertValid(snowfall.h24.state !== "unavailable", "Park City 24-hour report missing");
  return {
    resort: "Park City", sourceName: "Park City official snow report", sourceUrl: PARK_CITY_PAGE,
    reportTimeLabel: "Snow report updated", reportTime, operatingStatus: null, snowfall,
    base: settings.BaseDepth === true && snow.BaseDepth && "Inches" in snow.BaseDepth
      ? fromField(snow.BaseDepth.Inches, "in", "Base depth") : unavailable("Base depth"),
    observations: [], liftsOpen: null, liftsTotal: null, lifts: null, terrain: null,
    notices: [], parking: [], narrative: htmlToText(snow.OverallSnowConditions) || null,
    reportingLocation: { name: "Official resort snow report", elevationFt: null },
  };
}

export const parkCitySource: SourceDefinition<ResortReport> = {
  id: "park-city", label: "Park City", category: "resort", required: true,
  sourceUrl: PARK_CITY_PAGE, attribution: "Park City Mountain — official snow report",
  reportMaxAgeMs: 26 * HOUR,
  async collect(ctx) {
    // This CDN serves an error document for the shared browser-like headers.
    const options = { headers: { Accept: "text/html" } };
    const html = await ctx.fetchText(PARK_CITY_PAGE, options);
    // The CDN can cache an HTTP 200 error document at the canonical URL.
    const page = /FR\.snowReportData\s*=/.test(html) ? html
      : await ctx.fetchText(`${PARK_CITY_PAGE}?snowreport=1`, options);
    const payload = parseParkCity(page);
    return { payload, sourceUpdatedAt: payload.reportTime };
  },
};
