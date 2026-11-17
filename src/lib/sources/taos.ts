import { resortById } from "../catalog";
import { emptySnowfall, fromField, unavailable } from "../metric";
import type { Metric, ResortReport, SnowfallSet } from "../types";
import { assertValid, HOUR, type SourceDefinition } from "./types";

/**
 * Taos's official weather page loads its snow report from the site's
 * own JSON route. The route publishes snowfall windows, base depth, season total
 * and lift counts, but no report time. Its current-weather and forecast blocks
 * come from a third-party forecast service and are not used.
 */
export const TAOS_PAGE = "https://www.skitaos.com/weather";
export const TAOS_API = "https://www.skitaos.com/api/conditions?season=winter";

type Num = number | string | null | undefined;
export interface TaosConditions {
  snowData?: {
    overnight?: Num;
    last24Hours?: Num;
    last48Hours?: Num;
    last72Hours?: Num;
    last7Days?: Num;
    seasonTotal?: Num;
    base?: Num;
  } | null;
  liftsOpen?: number | null;
  liftsTotal?: number | null;
}

export const TAOS_TIME_NOTE = "No report time is published; Updated shows when these figures last changed";

/** The figures whose change marks a new report. */
function signature(r: Pick<ResortReport, "snowfall" | "base">): string {
  const v = (m: Metric) => (m.state === "reported" ? m.value : m.state);
  const s = r.snowfall;
  return JSON.stringify([s.overnight, s.h24, s.h48, s.h72, s.d7, s.season, r.base].map(v));
}

/**
 * The feed carries no publication time, so the report time is when collection
 * first saw the published figures change. Unchanged figures keep the previous
 * time; without a previous run the time is unknown rather than the fetch time,
 * since an unchanged report may be yesterday's.
 */
export function parseTaos(feed: TaosConditions, previous: ResortReport | null, now: Date): ResortReport {
  const snow = feed.snowData;
  assertValid(snow && typeof snow === "object", "Taos conditions missing snowData");
  const def = resortById("taos-ski-valley")!;
  // An absent field is not published; a null one is published but not reported.
  const field = (key: keyof typeof snow, label: string) =>
    key in snow ? fromField(snow[key], "in", label) : unavailable(label);
  const snowfall: SnowfallSet = {
    ...emptySnowfall(),
    overnight: field("overnight", "Overnight"),
    h24: field("last24Hours", "Last 24 hours"),
    h48: field("last48Hours", "Last 48 hours"),
    h72: field("last72Hours", "Last 72 hours"),
    d7: field("last7Days", "Last 7 days"),
    season: field("seasonTotal", "Season total"),
  };
  assertValid(snowfall.h24.state !== "unavailable", "Taos 24 h field missing");
  const base = field("base", "Base depth");
  const report: ResortReport = {
    resort: def.name,
    sourceName: "Taos official conditions",
    sourceUrl: TAOS_PAGE,
    reportTimeLabel: "Figures last changed",
    reportTime: null,
    operatingStatus: null,
    snowfall,
    base,
    observations: [],
    liftsOpen: typeof feed.liftsOpen === "number" ? feed.liftsOpen : null,
    liftsTotal: typeof feed.liftsTotal === "number" ? feed.liftsTotal : null,
    lifts: null,
    terrain: null,
    notices: [],
    parking: [],
    narrative: null,
    reportingLocation: { name: def.station, elevationFt: def.elevationFt, note: TAOS_TIME_NOTE },
  };
  const prior = previous?.snowfall ? previous : null;
  report.reportTime = !prior ? null : signature(prior) === signature(report) ? prior.reportTime : now.toISOString();
  return report;
}

export const taosSource: SourceDefinition<ResortReport> = {
  id: "taos-ski-valley",
  label: "Taos",
  category: "resort",
  required: true,
  sourceUrl: TAOS_PAGE,
  attribution: "Taos — official snow report",
  reportMaxAgeMs: 26 * HOUR,
  async collect(ctx) {
    const report = parseTaos(
      await ctx.fetchJson<TaosConditions>(TAOS_API, { browserLike: true }),
      ctx.previous as ResortReport | null,
      ctx.now,
    );
    return { payload: report, sourceUpdatedAt: report.reportTime };
  },
};
