import { RESORTS, resortById, type ResortId } from "../catalog";
import { emptySnowfall, fromField, htmlToText, parseNumber, unavailable } from "../metric";
import { epochSecondsToIso, monthFromName, parseLocalDateTime, parseOffsetIso, zonedParts, zonedToUtc } from "../time";
import type { Lift, Metric, ResortReport, SnowfallSet } from "../types";
import { parseBrighton } from "./brighton";
import { fetchMtnPowder, parseMtnPowder } from "./mtnpowder";
import { liftStatusFrom } from "./snowbird";
import { assertValid, HOUR, type SourceDefinition } from "./types";

export const FAVORITE_PAGES = {
  snowbasin: "https://www.snowbasin.com/the-mountain/mountain-report/",
  "palisades-tahoe": "https://www.palisadestahoe.com/mountain-information/mountain-report",
  "mammoth-mountain": "https://www.mammothmountain.com/on-the-mountain/mountain-report",
  "jackson-hole": "https://www.jacksonhole.com/mountain-report",
  "big-sky": "https://www.bigskyresort.com/current-conditions",
  "winter-park": "https://www.winterparkresort.com/the-mountain/mountain-report",
  steamboat: "https://www.steamboat.com/the-mountain/mountain-report",
  telluride: "https://tellurideskiresort.com/snow-report/",
  "crystal-mountain": "https://www.crystalmountainresort.com/the-mountain/mountain-report-and-webcams",
  "mt-bachelor": "https://www.mtbachelor.com/the-mountain/mountain-report/",
} as const;
export const JACKSON_API = "https://jacksonhole-prod.zaneray.com/api/snow.json";
export const JACKSON_LIFTS_API = "https://jacksonhole-prod.zaneray.com/api/trail-lift.json";
export const BACHELOR_API = "https://api.mtbachelor.com/api/v1/dor/drupal/snow-reports?sort=date&direction=desc";
export const BACHELOR_LIFTS_API = "https://api.mtbachelor.com/api/v1/dor/drupal/lifts";
export const BIG_SKY_API = "https://www.bigskyresort.com/api/reportpal?resortName=bs&useReportPal=true";

function blank(id: keyof typeof FAVORITE_PAGES): ResortReport {
  const r = resortById(id)!;
  return {
    resort: r.name,
    sourceName: `${r.name} official mountain report`,
    sourceUrl: FAVORITE_PAGES[id],
    reportTimeLabel: "Snow report updated",
    reportTime: null,
    operatingStatus: null,
    snowfall: emptySnowfall(),
    base: unavailable("Base depth"),
    observations: [],
    liftsOpen: null,
    liftsTotal: null,
    lifts: null,
    terrain: null,
    notices: [],
    parking: [],
    narrative: null,
    reportingLocation: { name: r.station, elevationFt: r.elevationFt },
  };
}

interface JacksonAmount {
  value?: string;
  unit?: string;
}
interface JacksonFeed {
  lastModified?: string;
  snow?: { midMountain?: Record<string, JacksonAmount | string>; detail?: string; psa?: string };
}
export function parseJackson(feed: JacksonFeed): ResortReport {
  const r = blank("jackson-hole"),
    loc = feed.snow?.midMountain;
  assertValid(loc && feed.lastModified, "Jackson Hole missing Mid Mountain report/publication time");
  const amount = (key: string, label: string): Metric => {
    const v = loc[key];
    if (!v || typeof v === "string" || !Object.keys(v).length) return unavailable(label);
    assertValid(!v.unit || v.unit === "INCH", `Jackson Hole unexpected snow units ${v.unit}`);
    return fromField(v.value, "in", label, "Official Mid Mountain snow study plot");
  };
  r.reportTime = parseOffsetIso(feed.lastModified);
  r.snowfall = {
    ...r.snowfall,
    overnight: amount("newSnowSinceLiftsClosed", "Since lifts closed"),
    h24: amount("newSnowLast24H", "Past 24 hours"),
    h48: amount("newSnowLast48H", "Past 48 hours"),
    h72: amount("newSnowLast72H", "Past 72 hours"),
    d7: amount("newSnowLast7D", "Past 7 days"),
    season: amount("seasonTotalSnow", "Season total"),
  };
  r.base = amount("totalSnowDepth", "Mid Mountain snow depth");
  r.narrative = htmlToText(feed.snow?.detail);
  if (feed.snow?.psa) r.notices.push({ title: "Mountain update", text: htmlToText(feed.snow.psa), severity: "info" });
  // Feed altitude metadata is inconsistent; use independently verified plot elevation.
  return r;
}

interface BachelorRow {
  location?: { name: string };
  unit_of_measurement?: string;
  updated?: number;
  date?: string;
  report?: string;
  overnight_amount?: number | null;
  base_depth?: number | null;
  computed?: Record<string, number | null>;
}
export function parseBachelor(rows: BachelorRow[]): ResortReport {
  assertValid(Array.isArray(rows), "Bachelor snow report must be a list");
  const row = rows.filter((r) => r.location?.name === "Primary").sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
  assertValid(row && row.computed && row.updated, "Bachelor missing published Primary report");
  assertValid(row.unit_of_measurement === "in", "Bachelor snow report units are not inches");
  const r = blank("mt-bachelor");
  r.reportTime = epochSecondsToIso(row.updated); // Explicit epoch; the timezone-free `date` is not freshness.
  const note =
    "Rolling amount computed by Mt. Bachelor at fetch time from published reports; publication time is shown separately";
  const keys: Array<[keyof SnowfallSet, string, string]> = [
    ["h24", "24_hour", "Rolling 24 hours"],
    ["h48", "48_hour", "Rolling 48 hours"],
    ["h72", "72_hour", "Rolling 72 hours"],
    ["d7", "7_day", "Rolling 7 days"],
    ["season", "total", "Season total"],
  ];
  for (const [key, field, label] of keys)
    r.snowfall[key] = field in row.computed ? fromField(row.computed[field], "in", label, note) : unavailable(label);
  r.snowfall.overnight = fromField(row.overnight_amount, "in", "Overnight (latest Primary report)");
  r.base = fromField(row.base_depth, "in", "Primary report base depth");
  r.narrative = htmlToText(row.report);
  return r;
}

interface JacksonLifts {
  lastModified?: string;
  liftStatus?: { openLifts: number; totalLifts: number };
  lifts?: Record<string, { name: string; openingStatus: string; message?: string }>;
}
export function parseJacksonLifts(
  feed: JacksonLifts,
): Pick<ResortReport, "lifts" | "liftsOpen" | "liftsTotal" | "operationsUpdatedAt"> {
  assertValid(feed.lifts && feed.liftStatus, "Jackson Hole lift feed missing");
  return {
    lifts: Object.values(feed.lifts).map((l) => ({
      name: l.name,
      status: l.openingStatus === "OUT_OF_PERIOD" ? "closed" : liftStatusFrom(l.openingStatus),
      rawStatus: l.openingStatus.replaceAll("_", " "),
      note: l.message ?? null,
    })),
    liftsOpen: feed.liftStatus.openLifts,
    liftsTotal: feed.liftStatus.totalLifts,
    operationsUpdatedAt: parseOffsetIso(feed.lastModified),
  };
}
interface BachelorLift {
  id: string;
  name: string;
  season: string;
  status: string;
  updated?: number;
  hours?: string;
  notes?: string;
}
export function parseBachelorLifts(
  rows: BachelorLift[],
): Pick<ResortReport, "lifts" | "liftsOpen" | "liftsTotal" | "operationsUpdatedAt"> {
  assertValid(Array.isArray(rows), "Bachelor lift feed is not a list");
  const winter = [...new Map(rows.filter((l) => l.season === "winter").map((l) => [l.id, l])).values()];
  assertValid(winter.length, "Bachelor has no winter lift rows");
  const lifts = winter.map((l) => ({
    name: l.name,
    status: liftStatusFrom(l.status),
    rawStatus: l.status,
    hours: l.hours ?? null,
    note: htmlToText(l.notes) || null,
  }));
  return {
    lifts,
    liftsOpen: lifts.filter((l) => l.status === "open").length,
    liftsTotal: lifts.length,
    operationsUpdatedAt: epochSecondsToIso(Math.max(...winter.map((l) => l.updated ?? 0))),
  };
}

/** Restrict parsing to the resort's measured report, excluding forecast/editorial embeds. */
export function parseFavoriteHtml(id: "snowbasin" | "telluride", html: string, now: Date): ResortReport {
  const r = blank(id),
    text = htmlToText(html),
    zone = "America/Denver";
  const p = zonedParts(now, zone);
  if (id === "snowbasin") {
    assertValid(/Snow Report/.test(text) && /24 hours/.test(text), "Snowbasin snow report not found");
    const section = text.slice(text.indexOf("Snow Report"), text.indexOf("Snow Report") + 1800);
    const snow = (label: string) =>
      fromField(new RegExp(`${label}\\s*([\\d.]+|--)\\s*[”″"]`, "i").exec(section)?.[1], "in", label);
    r.snowfall.overnight = snow("Overnight");
    r.snowfall.h24 = snow("24 hours");
    r.snowfall.d7 = snow("7 days");
    r.snowfall.season = snow("Season");
    r.base = snow("Base");
    const m = [...text.matchAll(/Last Updated:?\s*([A-Z][a-z]+)\s+(\d+),?\s+(\d+):(\d+)\s*(AM|PM)\s*MT/g)].at(-1);
    if (m) {
      const month = monthFromName(m[1])!;
      const year = month > p.month + 1 ? p.year - 1 : p.year;
      r.reportTime = zonedToUtc(
        year,
        month,
        +m[2],
        (+m[3] % 12) + (m[5] === "PM" ? 12 : 0),
        +m[4],
        0,
        zone,
      ).toISOString();
    }
    const liftSection = text.slice(text.indexOf("Lift Name"), text.indexOf("Trails\n", text.indexOf("Lift Name")));
    r.lifts = [
      ...liftSection.matchAll(
        /\n([^\n]+)\n(?:Tram|Gondola|Detachable Chairlift|Chair|Conveyor Lift|Rope Tow)\nLift (Closed|Open|On Hold|Scheduled)/g,
      ),
    ].map((m) => ({ name: m[1].trim(), status: liftStatusFrom(m[2]), rawStatus: m[2] }));
    const counts = /Lifts Open\s*(\d+)\s*\/\s*(\d+)/.exec(text);
    if (counts) {
      r.liftsOpen = +counts[1];
      r.liftsTotal = +counts[2];
    }
  } else {
    const section = text.slice(text.indexOf("Last Updated:"), text.indexOf("TERRAIN"));
    assertValid(/Last 24 hours/.test(section), "Telluride measured snow report not found");
    const snow = (label: string) =>
      fromField(new RegExp(`${label}\\s*([\\d.]+|--)\\s*[”″"]`, "i").exec(section)?.[1], "in", label);
    r.snowfall.overnight = snow("Snow overnight");
    r.snowfall.h24 = snow("Last 24 hours");
    r.snowfall.h48 = snow("Last 48 hours");
    r.snowfall.d7 = snow("Last 7 days");
    r.snowfall.season = snow("Season total");
    r.base = snow("Snow depth");
    const m = /Last Updated:\s*([A-Z][a-z]+)\s+(\d+),\s*(\d{4})\s+at\s+(\d+):(\d+)(am|pm)/i.exec(section);
    if (m)
      r.reportTime = zonedToUtc(
        +m[3],
        monthFromName(m[1])!,
        +m[2],
        (+m[4] % 12) + (m[6].toLowerCase() === "pm" ? 12 : 0),
        +m[5],
        0,
        zone,
      ).toISOString();
    const c = /Lifts Status\s*(\d+)\s*\/\s*(\d+)/.exec(section);
    if (c) {
      r.liftsOpen = +c[1];
      r.liftsTotal = +c[2];
    }
    // Named rows retain the source status; no forecast or third-party editorial text is used.
    const table = /<table[^>]*>[\s\S]*?<\/table>/gi;
    const lifts: Lift[] = [];
    for (const match of html.matchAll(table))
      for (const row of match[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => htmlToText(c[1]));
        if (cells.length >= 3 && /open|closed|hold/i.test(cells.join(" "))) {
          const name = cells.find((c) => c && !/^(open|closed|on hold)$/i.test(c));
          const status = cells.find((c) => /^(open|closed|on hold)$/i.test(c));
          if (name && status) lifts.push({ name, status: liftStatusFrom(status), rawStatus: status });
        }
      }
    if (lifts.length) r.lifts = lifts;
  }
  assertValid(r.reportTime && r.snowfall.h24.state !== "unavailable", "Resort publication time or snow field missing");
  return r;
}

const MTN_SLUGS: Partial<Record<ResortId, string>> = {
  "palisades-tahoe": "palisades-tahoe",
  "mammoth-mountain": "mammoth",
  "winter-park": "winter-park",
  steamboat: "steamboat",
  "crystal-mountain": "crystal-mountain",
};
export const favoriteSources: SourceDefinition<ResortReport>[] = RESORTS.filter((r) => r.id in FAVORITE_PAGES).map(
  (def) => ({
    id: def.id,
    label: def.name,
    category: "resort",
    required: true,
    sourceUrl: FAVORITE_PAGES[def.id as keyof typeof FAVORITE_PAGES],
    attribution: `${def.name} — official snow report`,
    reportMaxAgeMs: 26 * HOUR,
    async collect(ctx) {
      const id = def.id as keyof typeof FAVORITE_PAGES;
      let report: ResortReport;
      const slug = MTN_SLUGS[id];
      if (slug) {
        const parsed = parseMtnPowder(await fetchMtnPowder(ctx, slug), {
          resort: def.name,
          sourceUrl: FAVORITE_PAGES[id],
          reportingArea: "mid",
        });
        report = parsed.report;
        report.reportingLocation = {
          name: report.reportingLocation?.name ?? def.station,
          elevationFt: def.elevationFt,
        };
      } else if (id === "jackson-hole") {
        const [snow, lifts] = await Promise.all([
          ctx.fetchJson<JacksonFeed>(JACKSON_API),
          ctx
            .fetchJson<JacksonLifts>(JACKSON_LIFTS_API)
            .then(parseJacksonLifts)
            .catch(() => null),
        ]);
        report = { ...parseJackson(snow), ...(lifts ?? { missingSections: ["lifts"] }) };
      } else if (id === "mt-bachelor") {
        const [snow, lifts] = await Promise.all([
          ctx.fetchJson<BachelorRow[]>(BACHELOR_API),
          ctx
            .fetchJson<BachelorLift[]>(BACHELOR_LIFTS_API)
            .then(parseBachelorLifts)
            .catch(() => null),
        ]);
        report = { ...parseBachelor(snow), ...(lifts ?? { missingSections: ["lifts"] }) };
      } else if (id === "big-sky") {
        report = parseBrighton(
          await ctx.fetchJson<Parameters<typeof parseBrighton>[0]>(BIG_SKY_API, { browserLike: true }),
        ).report;
        report = {
          ...report,
          resort: def.name,
          sourceName: "Big Sky official ReportPal",
          sourceUrl: FAVORITE_PAGES[id],
          reportingLocation: {
            name: def.station,
            elevationFt: null,
            note: "Official composite; not a single mid-mountain station",
          },
        };
      } else
        report = parseFavoriteHtml(
          id as "snowbasin" | "telluride",
          await ctx.fetchText(FAVORITE_PAGES[id], { browserLike: true }),
          ctx.now,
        );
      return { payload: report, sourceUpdatedAt: report.reportTime };
    },
  }),
);
