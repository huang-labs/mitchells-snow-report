import { snowfallIssues, usableSnowReport } from "../snowfall-quality";
import { RESORTS, regionById, type TimeZone } from "../catalog";
import { ensembleGuidance } from "../ensemble";
import { classify } from "../report";
import { SOURCE_BY_ID } from "../sources";
import { formatLocal, localDate, zonedParts } from "../time";
import type { Metric, PrimaryResortId, ResortReport, Snapshot } from "../types";

export { RESORTS };
export const denverDate = (d: Date, zone: string = "America/Denver") => localDate(d, zone);
export const localTime = (iso: string, now: Date, zone: string = "America/Denver") => formatLocal(iso, now, zone);
export function slrOf(snow: number | null, liquid: number | null) {
  if (snow === null || liquid === null || liquid < 0.05 || snow < 0.5) return null;
  const ratio = snow / liquid;
  return `${Math.round(ratio)}:1 ${ratio < 8 ? "dense/wet" : ratio < 12 ? "average density" : ratio < 16 ? "light" : "very light"}`;
}
const amount = (m: Metric | undefined) =>
  m?.state === "reported"
    ? `${m.value}${m.unit === "in" ? "″" : ` ${m.unit}`}`
    : m?.state === "not_reported"
      ? "not reported"
      : "unavailable";
export interface ResortDigest {
  id: PrimaryResortId;
  name: string;
  canyon: (typeof RESORTS)[number]["canyon"];
  inSeason: boolean;
  operatingNow: boolean;
  dataFreshness: string;
  reportTime: string | null;
  operatingStatus: string | null;
  lifts: string;
  snowfall: Record<string, string>;
  conditions: string | null;
  weatherNow: string | null;
  snowfallWarnings?: string[];
}
export function buildDigest(snapshot: Snapshot, lastOperating: Partial<Record<PrimaryResortId, string>>, now: Date) {
  const zone = regionById(snapshot.region ?? "utah")!.timeZone;
  const resorts: ResortDigest[] = RESORTS.filter((r) => snapshot.sources[r.id]).map((def) => {
    const record = snapshot.sources[def.id],
      raw = record?.payload as ResortReport | null,
      r = usableSnowReport(raw);
    const freshness = classify(SOURCE_BY_ID[def.id], record, now);
    const usable =
      record?.status === "ok" && (freshness.freshness === "current" || freshness.freshness === "time-unknown");
    const operatingNow =
      !!usable && ((r?.liftsOpen ?? 0) > 0 || !!r?.lifts?.some((l) => l.status === "open" || l.status === "hold"));
    const recent = !!lastOperating[def.id] && now.getTime() - Date.parse(lastOperating[def.id]!) < 4 * 86400000;
    const seasonClosed = /closed for (the )?season/i.test(r?.operatingStatus ?? "");
    const month = zonedParts(now, zone).month;
    const usualSkiSeason = month >= 11 || month <= 5;
    const inSeason =
      !!r &&
      !seasonClosed &&
      (operatingNow || recent || usualSkiSeason || (!!usable && !!r.lifts?.some((l) => l.status === "scheduled")));
    return {
      id: def.id,
      name: def.name,
      canyon: def.canyon,
      inSeason,
      operatingNow,
      dataFreshness: `${freshness.freshness}: ${freshness.note}`,
      reportTime: r?.reportTime ? localTime(r.reportTime, now, zone) : null,
      operatingStatus: r?.operatingStatus ?? null,
      lifts: r ? `${r.liftsOpen ?? "?"}/${r.liftsTotal ?? "?"} open` : "unavailable",
      snowfall: r
        ? Object.fromEntries(
            Object.entries(r.snowfall ?? {}).map(([k, m]) => [
              k,
              usable ? amount(m) : "old or failed report: amount withheld",
            ]),
          )
        : {},
      conditions: usable ? (r?.narrative?.slice(0, 1400) ?? null) : null,
      weatherNow: null,
      ...(raw ? { snowfallWarnings: snowfallIssues(raw.snowfall).map(issue => issue.message) } : {}),
    };
  });
  return {
    resorts,
    ensemble: snapshot.region && snapshot.region !== "utah" ? undefined : ensembleGuidance(snapshot, now),
  };
}
