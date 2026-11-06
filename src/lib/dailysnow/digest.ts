import { usableSnowReport } from "../snowfall-quality";
import { forecastPointFresh } from "../forecastFreshness";
import { regionalSnapshot } from "./regions";
import { RESORTS as CATALOG, FORECAST_AREAS, regionById } from "../catalog";
import type { ensembleGuidance } from "../ensemble";
import { plumePanelsLive } from "../plumePanels";
import { classify } from "../report";
import { buildDigest, denverDate, localTime, slrOf, RESORTS, type ResortDigest } from "./facts";
import { SOURCE_BY_ID } from "../sources";
import { HOUR } from "../sources/types";
import type {
  AfdPayload,
  CanyonId,
  DailySnowFigure,
  DailySnowHistoryEntry,
  DailySnowNumbers,
  DailySnowPhase,
  DailySnowPost,
  NwsPayload,
  PlumePayload,
  PointForecast,
  ResortCamsPayload,
  ResortReport,
  Snapshot,
} from "../types";
import { buildContinuity, type ContinuityDigest } from "./continuity";
import { stormDigest, stormForPost } from "./storms";
import { modelPlaceable, relevantFigures, significantStorm } from "./figure-plan";
import type { StormRecord } from "./storm-types";

/**
 * Facts for the Daily Snow post. Everything the model would otherwise have to
 * guess (storm phase, forecast totals, which figures exist) is computed here.
 */

/** Phase thresholds (inches; max over canyons / resorts). */
export const STORM_NEXT12_IN = 2;
export const HEAVY_NEXT12_IN = 4;
export const RECENT_IN = 2;
export const POST_STORM_RECENT_IN = 4;
export const PRE_STORM_NEXT72_IN = 3;
/** A forecast discussion older than this is labeled stale for the model. */
export const AFD_STALE_MS = 18 * HOUR;

export interface FigureCandidate {
  figure: DailySnowFigure;
  /** What the figure shows, for the model (it cannot see images). */
  describe: string;
  /** Image figures: where to copy the still from at posting time. */
  source?: { kind: "kv"; key: string } | { kind: "url"; url: string };
}

export interface DailyDigest extends ContinuityDigest {
  /** Historical observations for the same event; valid data even after live fields reset. */
  stormRecap?: ReturnType<typeof stormDigest> | null;
  ensemble?: ReturnType<typeof ensembleGuidance>;
  regionName?: string;
  timeZone?: string;
  areas?: Array<{ id: string; name: string; phase: DailySnowPhase; reason: string; forecastAvailable: boolean }>;
  areaStorms?: ReturnType<typeof stormDigest>[];
  observationCoverage?: { currentResorts: string[]; unavailableResorts: string[] };
  discussions?: Array<{ office: string; issued: string; stale: boolean; sections: AfdPayload["sections"] }>;
  nowLocal: string;
  date: string;
  weekday: string;
  phase: DailySnowPhase;
  phaseReason: string;
  resorts: Array<
    Pick<
      ResortDigest,
      | "name"
      | "canyon"
      | "dataFreshness"
      | "reportTime"
      | "operatingStatus"
      | "lifts"
      | "snowfall"
      | "snowfallWarnings"
      | "conditions"
      | "weatherNow"
    >
  >;
  forecast: Array<{
    canyon: CanyonId;
    point: string;
    elevationFt: number | null;
    dataFreshness: string;
    updated: string | null;
    windowBasis: string;
    totals: { next24In: number | null; next72In: number | null; next7dIn: number | null };
    nextStorm: string | null;
    blocks: Array<Record<string, string | number | null>>;
    sixHourSnow: string[];
    text: Array<{ period: string; forecast: string }>;
  }>;
  /** Issuance summary of the region's own offices; their text is in `discussions`. */
  discussion: { issued: string; stale: boolean } | null;
  figures: Array<{ id: string; caption: string; shows: string }>;
}

export interface DailyBuild {
  digest: DailyDigest;
  numbers: DailySnowNumbers;
  figures: FigureCandidate[];
  /** Any resort in season, or snow in the 7-day forecast. False = off-season, no post. */
  worthPosting: boolean;
  stormRecap: StormRecord | null;
}

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "long" });
const nowFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Denver",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const sixFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", hour: "numeric" });
const round1 = (v: number) => Math.round(v * 10) / 10;
const reported = (m: { state: string; value?: number } | undefined) =>
  m?.state === "reported" ? (m.value ?? null) : null;
const canyonOf = (p: PointForecast): CanyonId => p.id ?? (/BCC/.test(p.name) ? "BCC" : "LCC");

/**
 * Bounded rolling estimate from the adapter's unrounded hourly allocation of
 * NWS interval accumulations. Partial hours use that same uniform allocation.
 * Every intersecting hour must exist; gaps and legacy six-hour-only snapshots
 * cannot establish coverage and return unknown rather than a partial total.
 */
export function snowNext(p: PointForecast, now: Date, hours: number): number | null {
  const start = now.getTime();
  const end = start + hours * HOUR;
  if (!p.hourlySnow || !Number.isFinite(start) || !Number.isFinite(end) || hours <= 0) return null;
  const first = Math.floor(start / HOUR) * HOUR;
  const bars = p.hourlySnow
    .filter((b) => Date.parse(b.start) >= first && Date.parse(b.start) < end)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (bars.length !== Math.ceil((end - first) / HOUR)) return null;
  let sum = 0;
  for (const [i, bar] of bars.entries()) {
    const t = Date.parse(bar.start);
    if (t !== first + i * HOUR || !Number.isFinite(bar.snowIn) || bar.snowIn < 0) return null;
    sum += (bar.snowIn * (Math.min(t + HOUR, end) - Math.max(t, start))) / HOUR;
  }
  return round1(sum);
}

export function phaseOf(
  recentIn: number,
  recent48In: number,
  next12In: number | null,
  next72In: number | null,
): { phase: DailySnowPhase; reason: string } {
  const facts = `${recentIn}″ reported in the last 24 h, ${recent48In}″ in 48 h/storm (max across resorts); ${next12In === null ? "unavailable snowfall forecast" : `${next12In}″ forecast`} in the next 12 h, ${next72In === null ? "unavailable snowfall forecast" : `${next72In}″ forecast`} in 72 h (max across canyons)`;
  if ((next12In ?? 0) >= HEAVY_NEXT12_IN || ((next12In ?? 0) >= STORM_NEXT12_IN && recentIn >= RECENT_IN))
    return { phase: "storm", reason: `Storm underway: ${facts}` };
  if (recent48In >= POST_STORM_RECENT_IN || recentIn >= RECENT_IN)
    return { phase: "post-storm", reason: `Storm ending or just ended: ${facts}` };
  if ((next72In ?? 0) >= PRE_STORM_NEXT72_IN) return { phase: "pre-storm", reason: `Storm on the way: ${facts}` };
  return { phase: "quiet", reason: `Quiet weather: ${facts}` };
}

function figureCandidates(
  snapshot: Snapshot,
  nws: NwsPayload | null,
  numbers: DailySnowNumbers,
  now: Date,
  storm: StormRecord | null,
): FigureCandidate[] {
  const out: FigureCandidate[] = [];
  const zone = regionById(snapshot.region ?? "utah")!.timeZone;
  const t = now.getTime();
  for (const p of nws?.points ?? []) {
    const canyon = canyonOf(p);
    const bars = p.sixHourSnow.filter((b) => Date.parse(b.start) + 6 * HOUR > t);
    if (!bars.some((b) => b.snowIn > 0)) continue;
    out.push({
      figure: {
        id: `nws-snow-${canyon.toLowerCase()}`,
        kind: "snow-bars",
        canyon,
        bars,
        caption: `NWS 6-hour snowfall forecast · ${p.name}`,
      },
      describe: `Bar chart of NWS forecast snowfall per 6 hours for the next 7 days, ${p.name}`,
    });
  }
  const series = (nws?.points ?? [])
    .map((p) => ({
      canyon: canyonOf(p),
      points: p.sixHourSnow
        .filter((b) => Date.parse(b.start) + 6 * HOUR > t && b.snowLevelFt !== null)
        .map((b) => ({ start: b.start, ft: b.snowLevelFt! })),
    }))
    .filter((s) => s.points.length >= 2);
  if (series.length) {
    out.push({
      figure: { id: "nws-snow-level", kind: "snow-level", series, caption: "NWS forecast snow level" },
      describe: "Line chart of the NWS forecast snow level (feet) for the next 7 days, both canyons",
    });
  }
  const rows = numbers.resorts.map((r) => {
    const rep = snapshot.sources[r.id]?.payload as ResortReport | null;
    return { name: r.name, h24: r.h24, h48: r.h48 ?? null, storm: r.storm };
  });
  if (storm) {
    out.push({
      figure: {
        id: "storm-recap",
        kind: "storm-recap",
        storm,
        caption: `Storm recap · tracked since ${localTime(storm.firstObservedAt, now, zone)}`,
      },
      describe:
        "Retained observations for this storm, with source report times. Reported storm totals and rolling-window observations are explicitly distinguished. Missing means unavailable, never zero. Not a live 24/48-hour table.",
    });
  } else if (rows.some((r) => r.h24 !== null || r.h48 !== null || r.storm !== null)) {
    out.push({
      figure: { id: "resort-totals", kind: "totals", rows, caption: "Resort-reported snowfall" },
      describe: "Bar chart of resort-reported 24 h, 48 h and storm totals",
    });
  }
  const plumes = snapshot.sources.plumes?.payload as PlumePayload | null;
  for (const c of plumes?.charts ?? []) {
    // Expired panels cannot be frozen into a post; don't offer them as figures.
    for (const panel of plumePanelsLive(c, now) ? (c.panels ?? []) : []) {
      const id = `plume-${panel.id}-${c.stationCode.toLowerCase()}`;
      const what = panel.id === "snow" ? "accumulated snowfall" : "snow-to-liquid ratio";
      out.push({
        figure: {
          id,
          kind: "image",
          url: "",
          originUrl: panel.url,
          width: panel.width,
          height: panel.height,
          axis: {
            plot: panel.plot,
            initTime: c.initTime,
            forecastHours: c.forecastHours,
            timeZone: regionById(snapshot.region ?? "utah")!.timeZone,
          },
          caption: `University of Utah ensemble plume · ${panel.title} · ${c.stationName} · ${c.runCode.slice(8)}Z run`,
        },
        describe: `Supporting image of ${what} at ${c.stationName}. You cannot see it. No numerical data or description of this run's spread or outcomes is supplied; do not characterize them.`,
        source: { kind: "kv", key: `plume-panel:v1:${c.stationCode}:${c.runCode}:${panel.id}` },
      });
    }
  }
  const cams = snapshot.sources.resortcams?.payload as ResortCamsPayload | null;
  for (const cam of cams?.cameras ?? []) {
    if (cam.kind !== "image" || !/snow ?stake/i.test(cam.title)) continue;
    // A still more than 3 hours old is not this morning's stake.
    if (!cam.capturedAt || t - Date.parse(cam.capturedAt) > 3 * HOUR) continue;
    const name = RESORTS.find((r) => r.id === cam.resort)?.name ?? cam.resort;
    out.push({
      figure: {
        id: `stake-${cam.resort}`,
        kind: "image",
        url: "",
        originUrl: cam.imageUrl,
        width: null,
        height: null,
        caption: `${name} snow stake · ${localTime(cam.capturedAt, now, zone)}`,
      },
      describe: `Photo of the ${name} snow stake at posting time. You cannot see it; do not describe what it shows.`,
      source: { kind: "url", url: cam.imageUrl },
    });
  }
  return out;
}

/** The same activity gate serves publication and its public availability notice. */
export function dailySnowActivity(snapshot: Snapshot, now: Date, base?: ReturnType<typeof buildDigest>) {
  if (!snapshot.region) snapshot = regionalSnapshot(snapshot, "utah");
  base ??= buildDigest(snapshot, snapshot.resortLastOperatingAt ?? {}, now);
  const rawNws = (snapshot.sources.nws?.payload ?? null) as NwsPayload | null;
  const nws = rawNws ? { ...rawNws, points: rawNws.points.filter((p) => forecastPointFresh(p, now)) } : null;
  const maxOf = (xs: Array<number | null>) => Math.max(0, ...xs.map((x) => x ?? 0));
  const selected = RESORTS.filter((r) => snapshot.sources[r.id]);
  const reports = selected.map((r) => {
    const source = snapshot.sources[r.id];
    return source?.status === "ok" && classify(SOURCE_BY_ID[r.id], source, now).freshness === "current"
      ? usableSnowReport(source.payload as ResortReport)
      : null;
  });
  const recent = maxOf(
    reports.flatMap((r) =>
      r ? [reported(r.snowfall.overnight), reported(r.snowfall.h12), reported(r.snowfall.h24)] : [],
    ),
  );
  const recent48 = Math.max(
    recent,
    maxOf(reports.flatMap((r) => (r ? [reported(r.snowfall.h48), reported(r.snowfall.storm)] : []))),
  );
  const anyInSeason = base.resorts.some((r) => r.inSeason);
  // Partial future coverage can establish activity, but cannot establish a total.
  // The bar covering `now` counts in full: snow still falling is activity.
  const t = now.getTime();
  const snowAhead = (nws?.points ?? []).some((p) => {
    const [bars, span] = p.hourlySnow ? [p.hourlySnow, HOUR] : [p.sixHourSnow, 6 * HOUR];
    return (
      bars
        .filter((b) => Date.parse(b.start) + span > t && Date.parse(b.start) < t + 7 * 24 * HOUR)
        .reduce((sum, b) => sum + b.snowIn, 0) >= 1
    );
  });
  const expectedActivity = anyInSeason || snowAhead || recent48 > 0;
  const usableFacts =
    !!nws?.points.length || reports.some((r) => r && Object.values(r.snowfall).some((m) => m.state === "reported"));
  const worthPosting = expectedActivity && usableFacts;
  // Missing/delayed inputs cannot establish an intentional quiet-day skip. This
  // affects the public notice only; model eligibility keeps the original gate.
  const forecastComplete = FORECAST_AREAS.filter((a) => a.region === snapshot.region).every((a) =>
    nws?.points.some((p) => canyonOf(p) === a.id),
  );
  const inputsUsable =
    forecastComplete &&
    [...selected.map((r) => r.id), "nws" as const].every((id) => {
      const freshness = classify(SOURCE_BY_ID[id], snapshot.sources[id], now).freshness;
      if (snapshot.sources[id]?.status !== "ok") return false;
      return freshness === "current" || freshness === "time-unknown";
    });
  return { recent, recent48, worthPosting, publicationExpected: expectedActivity || !inputsUsable };
}

export function buildDailyDigest(
  snapshot: Snapshot,
  previous: DailySnowPost | null,
  history: DailySnowHistoryEntry[],
  now: Date,
): DailyBuild {
  if (!snapshot.region) snapshot = regionalSnapshot(snapshot, "utah");
  const zone = regionById(snapshot.region ?? "utah")!.timeZone;
  const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" });
  const nowFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const sixFmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric" });
  const date = denverDate(now, zone);
  const base = buildDigest(snapshot, snapshot.resortLastOperatingAt ?? {}, now);
  const rawNws = (snapshot.sources.nws?.payload ?? null) as NwsPayload | null;
  const nws = rawNws ? { ...rawNws, points: rawNws.points.filter((p) => forecastPointFresh(p, now)) } : null;
  const afd = (snapshot.sources.nwsafd?.payload ?? null) as AfdPayload | null;
  const offices = afd?.discussions ?? (afd ? [afd] : []);
  const nwsFreshness = classify(SOURCE_BY_ID.nws, snapshot.sources.nws, now);

  const numbers: DailySnowNumbers = {
    canyons: (nws?.points ?? []).map((p) => ({
      canyon: canyonOf(p),
      point: p.name,
      next24In: snowNext(p, now, 24),
      next72In: snowNext(p, now, 72),
      next7dIn: snowNext(p, now, 7 * 24),
      nextStorm: p.nextStorm,
      forecastUpdatedAt: p.gridUpdatedAt,
    })),
    resorts: RESORTS.filter((r) => snapshot.sources[r.id]).map((r) => {
      const record = snapshot.sources[r.id];
      const rep =
        record?.status === "ok" && classify(SOURCE_BY_ID[r.id], record, now).freshness === "current"
          ? usableSnowReport(record.payload as ResortReport)
          : null;
      return {
        id: r.id,
        name: r.name,
        h24: rep ? reported(rep.snowfall.h24) : null,
        h48: rep ? reported(rep.snowfall.h48) : null,
        seasonIn: rep ? reported(rep.snowfall.season) : null,
        storm: rep ? reported(rep.snowfall.storm) : null,
        reportTime: rep?.reportTime ?? null,
        ...(rep?{snowfall:structuredClone(rep.snowfall)}:{}),
        reportingLocation:rep?.reportingLocation??{name:r.station,elevationFt:r.elevationFt},
      };
    }),
  };

  const { recent, recent48, worthPosting } = dailySnowActivity(snapshot, now, base);
  const maxForecast = (xs: Array<number | null>) => {
    const known = xs.filter((x): x is number => x !== null);
    return known.length ? Math.max(...known) : null;
  };
  const next12 = maxForecast((nws?.points ?? []).map((p) => snowNext(p, now, 12)));
  const next72 = maxForecast(numbers.canyons.map((c) => c.next72In));
  const tracked = stormForPost(snapshot.stormTracking, now);
  // A dusting is tracked like any event but isn't written up as a storm.
  const stormRecap = significantStorm(tracked) ? tracked : null;
  // Expired event memory must not keep sunny-day editions in post-storm mode
  // merely because a source continues publishing yesterday's rolling totals.
  const expired = !!snapshot.stormTracking?.events.length && !tracked;
  const { phase, reason } = phaseOf(expired ? 0 : recent, expired ? 0 : recent48, next12, next72);
  const t = now.getTime();

  const candidates = figureCandidates(snapshot, nws, numbers, now, stormRecap);
  for (const [area, state] of Object.entries(snapshot.areaStorms ?? {})) {
    const event = stormForPost(state, now);
    if (!significantStorm(event)) continue;
    // Readers and the model see the forecast area's display name, never its internal id.
    const name = FORECAST_AREAS.find((a) => a.id === area)?.name ?? area;
    candidates.push({
      figure: {
        id: `storm-recap-${area.toLowerCase()}`,
        kind: "storm-recap",
        storm: event,
        caption: `Storm observations · ${name}`,
      },
      describe: `Retained source observations for ${name} only. Rolling observations are not storm totals; do not add them.`,
    });
  }
  const figures = relevantFigures(candidates, {
    phase,
    recentIn: expired ? 0 : recent,
    next72In: next72,
    points: (nws?.points ?? []).map((p) => ({
      id: canyonOf(p).toLowerCase(),
      // Rounded six-hour bars can understate light snow; the hourly 7-day total is the better gauge.
      chartSnowIn: Math.max(
        snowNext(p, now, 7 * 24) ?? 0,
        p.sixHourSnow.filter((b) => Date.parse(b.start) + 6 * HOUR > t).reduce((sum, b) => sum + b.snowIn, 0),
      ),
      liquid72In: p.blocks
        .filter((b) => Date.parse(b.end) > t && Date.parse(b.start) < t + 72 * HOUR)
        .reduce((sum, b) => sum + (b.qpfIn ?? 0), 0),
    })),
  });
  const digest: DailyDigest = {
    regionName: regionById(snapshot.region ?? "utah")!.name,
    timeZone: zone,
    areas: FORECAST_AREAS.filter((a) => a.region === snapshot.region).map((a) => {
      const p = nws?.points.find((p) => canyonOf(p) === a.id);
      const areaResorts = numbers.resorts.filter((r) => CATALOG.find((x) => x.id === r.id)?.canyon === a.id);
      const recent = Math.max(0, ...areaResorts.flatMap((r) => [r.h24 ?? 0, reported(r.snowfall?.overnight)??0, reported(r.snowfall?.h12)??0]));
      const result = phaseOf(
        recent,
        Math.max(recent, ...areaResorts.map((r) => r.h48 ?? r.storm ?? 0)),
        p ? snowNext(p, now, 12) : null,
        p ? snowNext(p, now, 72) : null,
      );
      return {
        id: a.id,
        name: a.name,
        phase: result.phase,
        reason: p ? result.reason : `Current forecast unavailable. ${result.reason}`,
        forecastAvailable: !!p,
      };
    }),
    observationCoverage: {
      currentResorts: numbers.resorts
        .filter((r) => Object.values(r.snowfall??{}).some(m=>m.state==="reported"))
        .map((r) => r.name),
      unavailableResorts: numbers.resorts
        .filter((r) => !Object.values(r.snowfall??{}).some(m=>m.state==="reported"))
        .map((r) => r.name),
    },
    areaStorms: Object.values(snapshot.areaStorms ?? {}).flatMap((state) => {
      const event = stormForPost(state, now);
      return significantStorm(event) ? [stormDigest(event, now, zone)] : [];
    }),
    discussions: offices.map((a) => ({
      office: a.office,
      issued: localTime(a.issuedAt, now, zone),
      stale: t - Date.parse(a.issuedAt) > AFD_STALE_MS,
      sections: a.sections,
    })),
    stormRecap: stormRecap ? stormDigest(stormRecap, now, zone) : null,
    ensemble: base.ensemble,
    nowLocal: nowFmt.format(now),
    date,
    weekday: weekdayFmt.format(now),
    phase,
    phaseReason: reason,
    resorts: base.resorts.map((r) => ({
      name: r.name,
      canyon: r.canyon,
      dataFreshness: r.dataFreshness,
      reportTime: r.reportTime,
      operatingStatus: r.operatingStatus,
      lifts: r.lifts,
      snowfall: r.snowfall,
      snowfallWarnings: r.snowfallWarnings,
      conditions: r.conditions,
      weatherNow: r.weatherNow,
    })),
    forecast: (nws?.points ?? []).map((p, i) => ({
      canyon: canyonOf(p),
      point: p.name,
      elevationFt: p.elevationFt,
      dataFreshness: nwsFreshness.freshness,
      updated: p.gridUpdatedAt ? localTime(p.gridUpdatedAt, now, zone) : null,
      windowBasis: `Rolling windows start at ${now.toISOString()}; NWS interval accumulations are distributed uniformly over hours, including fractional boundary hours. Incomplete coverage is unavailable.`,
      totals: {
        next24In: numbers.canyons[i].next24In,
        next72In: numbers.canyons[i].next72In,
        next7dIn: numbers.canyons[i].next7dIn,
      },
      nextStorm: p.nextStorm
        ? `Next round of snow: ${p.nextStorm.totalSnowIn}″ from ${localTime(p.nextStorm.start, now, zone)} to ${localTime(p.nextStorm.end, now, zone)}${p.nextStorm.minSnowLevelFt ? `, snow level down to ${p.nextStorm.minSnowLevelFt} ft` : ""}${Date.parse(p.nextStorm.end) > t + 7 * 24 * HOUR ? "; it runs past the 7-day window, so it is not part of next7dIn and may exceed it" : ""}`
        : null,
      blocks: p.blocks
        .filter((b) => Date.parse(b.end) > t)
        .map((b) => ({
          period: b.label,
          snowIn: b.snowIn,
          liquidIn: b.qpfIn,
          snowToLiquid: slrOf(b.snowIn, b.qpfIn),
          snowLevelFt: b.snowLevelMinFt === null ? null : `${b.snowLevelMinFt}–${b.snowLevelMaxFt}`,
          tempF: b.tempMinF === null ? null : `${b.tempMinF}–${b.tempMaxF}`,
          windMph: b.windMaxMph === null ? null : `${b.windMaxMph} gust ${b.gustMaxMph ?? "?"}`,
          precipChancePct: b.popMax,
        })),
      sixHourSnow: p.sixHourSnow
        .filter((b) => Date.parse(b.start) + 6 * HOUR > t && b.snowIn > 0)
        .map(
          (b) =>
            `${sixFmt.format(new Date(b.start))}: ${b.snowIn}″${b.snowLevelFt ? ` (snow level ${Math.round(b.snowLevelFt / 100) * 100} ft)` : ""}`,
        ),
      text: p.periods.map((x) => ({ period: x.name, forecast: x.detailedForecast })),
    })),
    // One summary over the region's own offices; each office's text appears once, in `discussions`.
    discussion: offices.length
      ? {
          issued: offices.map((a) => `${a.office.replace(/^K/, "")} ${localTime(a.issuedAt, now, zone)}`).join("; "),
          stale: offices.every((a) => t - Date.parse(a.issuedAt) > AFD_STALE_MS),
        }
      : null,
    ...buildContinuity(previous, history, numbers, phase, date, now, zone),
    figures: figures
      .filter((f) => modelPlaceable(f.figure.id))
      .map((f) => ({ id: f.figure.id, caption: f.figure.caption, shows: f.describe })),
  };
  return { digest, numbers, figures, worthPosting, stormRecap };
}
