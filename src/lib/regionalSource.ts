import { FORECAST_AREAS, PLUME_LOCATIONS, type RegionId } from "./catalog";
import { classify } from "./freshness";
import type { ApiSource, NwsPayload, PlumePayload } from "./types";

/** A region's footer and missing-data notices describe only its own sources. */
export function regionalSource(source: ApiSource, region: RegionId, now: Date): ApiSource {
  if (!source.payload) return source;
  let updated: string | null = null,
    checked: string | null = null,
    payload: unknown = null;
  const oldest = (dates: Array<string | null | undefined>) => dates.filter((x): x is string => !!x).sort()[0] ?? null;
  if (source.id === "nws") {
    const original = source.payload as NwsPayload;
    const areas = FORECAST_AREAS.filter((a) => a.region === region);
    const points = original.points.filter((p) =>
      areas.some((a) => a.id === (p.id ?? (/BCC/.test(p.name) ? "BCC" : "LCC"))),
    );
    updated = oldest(points.map((p) => p.gridUpdatedAt));
    checked = oldest(points.map((p) => p.lastCheckedAt ?? source.lastSuccessfulFetchAt));
    if (points.length)
      payload = {
        points,
        failures: original.failures?.filter((f) => areas.some((a) => f.startsWith(a.name + ":"))),
      } satisfies NwsPayload;
  } else if (source.id === "plumes") {
    const original = source.payload as PlumePayload;
    const stations = PLUME_LOCATIONS.filter((s) => s.region === region);
    const charts = original.charts.filter((c) => stations.some((s) => s.code === c.stationCode));
    updated = oldest(charts.map((c) => c.initTime));
    checked = oldest(charts.map((c) => c.lastCheckedAt ?? source.lastSuccessfulFetchAt));
    if (charts.length) {
      const first = [...charts].sort((a, b) => a.runCode.localeCompare(b.runCode))[0];
      payload = {
        ...original,
        charts,
        runCode: first.runCode,
        initTime: first.initTime,
        failures: original.failures?.filter((f) => stations.some((s) => f.startsWith(s.name + ":"))),
      } satisfies PlumePayload;
    }
  } else return source;
  const scoped = { ...source, payload, sourceUpdatedAt: updated, lastSuccessfulFetchAt: checked };
  const status = classify(
    { reportMaxAgeMs: source.reportMaxAgeMs ?? null, intervalMs: source.intervalMs },
    scoped,
    now,
  );
  return { ...scoped, freshness: status.freshness, freshnessNote: status.note };
}
