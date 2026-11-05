import { emptySnowfall, fromField, htmlToText, unavailable } from "../metric";
import { parseOffsetIso } from "../time";
import type { Lift, NamedTerrain, Notice, ResortReport, WeatherObservation } from "../types";
import type { FetchContext } from "../http";
import { liftStatusFrom } from "./snowbird";
import { assertValid } from "./types";

/**
 * Mountain Powder ("mtnpowder") v3 feed used by Alterra resorts' own sites.
 * The site widget loads a public per-resort config (resort ids + public bearer
 * token) from v4.mtnfeed.com; we read that config each run so token rotation
 * does not require a redeploy. The token is never exposed by our API.
 */
export const MTNFEED_CONFIG = (slug: string) => `https://v4.mtnfeed.com/resorts/${slug}.json`;

type Str = string | number | null | undefined;

interface AreaSnow {
  Name?: string;
  SinceLiftsClosedIn?: Str;
  BaseIn?: Str;
  Last24HoursIn?: Str;
  Last48HoursIn?: Str;
  Last72HoursIn?: Str;
  Last7DaysIn?: Str;
}

interface Conditions {
  Name?: string;
  FeedSavedTime?: string;
  TemperatureF?: Str;
  WindDirection?: string;
  WindStrengthMph?: Str;
  WindGustsMph?: Str;
  Skies?: string;
}

export interface MtnPowderResort {
  Name: string;
  LastUpdate?: string;
  OperatingStatus?: string;
  SnowReport: {
    LastUpdate?: string;
    Report?: string;
    Alert?: string;
    News?: string;
    LiftNotification?: string;
    StormTotalIn?: Str;
    SnowBaseRangeIn?: Str;
    SeasonTotalIn?: Str;
    PreferredBaseReporting?: string;
    TotalOpenLifts?: number;
    TotalLifts?: number;
    BaseArea?: AreaSnow;
    MidMountainArea?: AreaSnow;
    SummitArea?: AreaSnow;
  };
  CurrentConditions?: { Base?: Conditions; MidMountain?: Conditions; Summit?: Conditions };
  MountainAreas?: Array<{
    Name: string;
    Lifts?: Array<{ Name: string; Status: string; StatusEnglish?: string; Hours?: unknown }>;
    Trails?: Array<{ Name: string; Status: string; StatusEnglish?: string }>;
  }>;
  ParkingLots?: Array<{ Name: string; Status: string; Message?: string }>;
}

export interface MtnPowderOptions {
  resort: string;
  sourceUrl: string;
  /** Mountain areas whose trails are listed individually as named terrain. */
  namedTerrainAreas?: string[];
  reportingArea?: "mid" | "base" | "summit";
}

function preferredArea(r: MtnPowderResort, selected?: string): { area: AreaSnow | undefined; label: string } {
  const pref = (selected ?? r.SnowReport.PreferredBaseReporting ?? "").toLowerCase();
  const map: Record<string, [AreaSnow | undefined, string]> = {
    base: [r.SnowReport.BaseArea, "Base"],
    mid: [r.SnowReport.MidMountainArea, "Mid-Mountain"],
    summit: [r.SnowReport.SummitArea, "Summit"],
  };
  const [area, label] = map[pref] ?? map.mid;
  return { area, label: area?.Name && area.Name !== "--" ? area.Name : label };
}

function observation(c: Conditions | undefined, fallbackName: string): WeatherObservation | null {
  if (!c || !c.FeedSavedTime || c.FeedSavedTime === "--") return null;
  const name = c.Name && c.Name !== "--" ? c.Name : fallbackName;
  return {
    location: name,
    observedAt: parseOffsetIso(c.FeedSavedTime),
    temperature: fromField(c.TemperatureF, "°F", `${name} temp`),
    wind: fromField(c.WindStrengthMph, "mph", "Wind"),
    gust: fromField(c.WindGustsMph, "mph", "Gusts"),
    direction: c.WindDirection && c.WindDirection !== "--" ? c.WindDirection : null,
    sky: c.Skies && c.Skies !== "--" ? c.Skies : null,
  };
}

function textField(s: string | undefined): string | null {
  if (!s || s.trim() === "--") return null;
  return htmlToText(s) || null;
}

export function parseMtnPowder(
  feed: { Resorts?: MtnPowderResort[] },
  opts: MtnPowderOptions,
): { report: ResortReport; sourceUpdatedAt: string | null } {
  const r = feed.Resorts?.[0];
  assertValid(r && r.SnowReport, `${opts.resort}: mtnpowder feed has no resort/snow report`);
  const reportTime = parseOffsetIso(r.SnowReport.LastUpdate);
  const { area, label } = preferredArea(r, opts.reportingArea);
  assertValid(area, `${opts.resort}: no snow area for preferred reporting location`);

  const where = `${label} measurement location`;
  const snowfall = emptySnowfall();
  snowfall.overnight = fromField(area.SinceLiftsClosedIn, "in", "Since lifts closed", where);
  snowfall.h24 = fromField(area.Last24HoursIn, "in", "Last 24 hours", where);
  snowfall.h48 = fromField(area.Last48HoursIn, "in", "Last 48 hours", where);
  snowfall.h72 = fromField(area.Last72HoursIn, "in", "Last 72 hours", where);
  snowfall.d7 = fromField(area.Last7DaysIn, "in", "Last 7 days", where);
  snowfall.storm = fromField(r.SnowReport.StormTotalIn, "in", "Storm total");
  snowfall.season = fromField(r.SnowReport.SeasonTotalIn, "in", "Season total");
  snowfall.h12 = unavailable("12 h");

  const observations = [
    observation(r.CurrentConditions?.Base, "Base"),
    observation(r.CurrentConditions?.MidMountain, "Mid-Mountain"),
    observation(r.CurrentConditions?.Summit, "Summit"),
  ].filter((o): o is WeatherObservation => o !== null);

  const lifts: Lift[] | null = r.MountainAreas
    ? r.MountainAreas.flatMap((a) =>
        (a.Lifts ?? []).map((l) => ({
          name: l.Name,
          status: liftStatusFrom(l.StatusEnglish ?? l.Status),
          rawStatus: l.Status,
        })),
      )
    : null;

  const namedAreas = new Set(opts.namedTerrainAreas ?? []);
  const terrain: NamedTerrain[] | null =
    r.MountainAreas && namedAreas.size
      ? r.MountainAreas.filter((a) => namedAreas.has(a.Name)).flatMap((a) =>
          (a.Trails ?? []).map((t) => ({
            name: t.Name,
            kind: a.Name,
            status: liftStatusFrom(t.StatusEnglish ?? t.Status),
            rawStatus: t.Status,
          })),
        )
      : null;

  const notices: Notice[] = [];
  const alert = textField(r.SnowReport.Alert);
  if (alert) notices.push({ title: "Alert", text: alert, severity: "warning", updatedAt: reportTime });
  const liftNote = textField(r.SnowReport.LiftNotification);
  if (liftNote) notices.push({ title: "Lift notification", text: liftNote, severity: "info", updatedAt: reportTime });
  const news = textField(r.SnowReport.News);
  if (news) notices.push({ title: "News", text: news, severity: "info", updatedAt: reportTime });

  const range=/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/.exec(String(r.SnowReport.SnowBaseRangeIn??"").trim());
  const report: ResortReport = {
    resort: opts.resort,
    sourceName: `${r.Name} snow report (Mountain Powder feed)`,
    sourceUrl: opts.sourceUrl,
    reportTimeLabel: "Snow report last updated",
    reportTime,
    operatingStatus: r.OperatingStatus ?? null,
    snowfall,
    base: fromField(opts.reportingArea || range ? area.BaseIn : r.SnowReport.SnowBaseRangeIn, "in", "Base depth", where),
    reportingLocation: { name: label, elevationFt: null },
    ...(range?{mountainBaseRange:{minIn:+range[1],maxIn:+range[2]}}:{}),
    observations,
    liftsOpen: r.SnowReport.TotalOpenLifts ?? null,
    liftsTotal: r.SnowReport.TotalLifts ?? null,
    lifts,
    terrain,
    notices,
    parking: (r.ParkingLots ?? []).map((p) => ({ name: p.Name, status: p.Status, note: textField(p.Message) })),
    narrative: textField(r.SnowReport.Report),
  };
  return { report, sourceUpdatedAt: reportTime };
}

export async function fetchMtnPowder(ctx: FetchContext, slug: string) {
  const cfg = await ctx.fetchJson<{ resortIds?: number[]; bearerToken?: string }>(MTNFEED_CONFIG(slug));
  assertValid(cfg.bearerToken && cfg.resortIds?.length, `mtnfeed config for ${slug} lacks token/resort id`);
  const url = new URL("https://mtnpowder.com/feed/v3.json");
  url.searchParams.set("bearer_token", cfg.bearerToken);
  for (const id of cfg.resortIds) url.searchParams.append("resortId[]", String(id));
  return ctx.fetchJson<{ Resorts?: MtnPowderResort[] }>(url.toString());
}
