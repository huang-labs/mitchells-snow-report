import { FORECAST_AREAS, PLUME_LOCATIONS, RESORTS, type RegionId, type ForecastAreaId } from "../catalog";
import type { AfdPayload, NwsPayload, PlumePayload, ResortCamsPayload, Snapshot, SourceId } from "../types";
import type { KVLike } from "../store";

export function regionalSnapshot(snapshot: Snapshot, region: RegionId, area?: ForecastAreaId): Snapshot {
  const sources: Snapshot["sources"] = {};
  for (const r of RESORTS.filter((r) => r.region === region && (!area || r.canyon === area)))
    if (snapshot.sources[r.id]) sources[r.id] = snapshot.sources[r.id];
  const ids = FORECAST_AREAS.filter((a) => a.region === region && (!area || a.id === area)).map((a) => a.id);
  const nws = snapshot.sources.nws;
  const points = ((nws?.payload as NwsPayload | null)?.points ?? []).filter((p) =>
    ids.includes(p.id ?? (/BCC/.test(p.name) ? "BCC" : "LCC")),
  );
  if (nws)
    sources.nws = {
      ...nws,
      payload: { points },
      sourceUpdatedAt:
        points
          .map((p) => p.gridUpdatedAt)
          .filter((s): s is string => !!s)
          .sort()[0] ?? null,
    };
  const plumes = snapshot.sources.plumes;
  if (plumes)
    sources.plumes = {
      ...plumes,
      payload: {
        ...(plumes.payload as PlumePayload),
        charts: ((plumes.payload as PlumePayload | null)?.charts ?? []).filter(
          (c) => PLUME_LOCATIONS.find((s) => s.code === c.stationCode)?.region === region,
        ),
      },
    };
  const afd = snapshot.sources.nwsafd;
  const discussions =
    (afd?.payload as AfdPayload | null)?.discussions ?? (afd?.payload ? [afd.payload as AfdPayload] : []);
  const offices = new Set(points.map((p) => p.gridId));
  const selected = discussions.filter((d) => offices.has(d.office.replace(/^K/, "")));
  if (afd && selected.length) sources.nwsafd = { ...afd, payload: { ...selected[0], discussions: selected } };
  const cams = snapshot.sources.resortcams;
  if (cams)
    sources.resortcams = {
      ...cams,
      payload: {
        ...(cams.payload as ResortCamsPayload),
        cameras: ((cams.payload as ResortCamsPayload | null)?.cameras ?? []).filter(
          (c) => RESORTS.find((r) => r.id === c.resort)?.region === region,
        ),
      },
    };
  if (region === "utah" && snapshot.sources.ensemble) sources.ensemble = snapshot.sources.ensemble;
  return {
    ...snapshot,
    region,
    sources,
    stormTracking: area ? snapshot.areaStorms?.[area] : snapshot.stormTracking,
    areaStorms: Object.fromEntries(
      Object.entries(snapshot.areaStorms ?? {}).filter(([key]) => ids.includes(key as ForecastAreaId)),
    ),
  };
}

/** Independent per-channel keys keep slow publications out of source snapshot writes. */
export function channelKV(kv: KVLike, channel: string): KVLike {
  const key = (k: string) => (k.startsWith("plume-panel:") ? k : `channel:v1:${channel}:${k}`);
  return {
    get: ((k: string, type: "text" | "arrayBuffer") =>
      type === "text" ? kv.get(key(k), "text") : kv.get(key(k), "arrayBuffer")) as KVLike["get"],
    put: (k, v, o) => kv.put(key(k), v, o),
  };
}
export const channelStateKey = (channel: string) => `daily-state:v2:${channel}`;
