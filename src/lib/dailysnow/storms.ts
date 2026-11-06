import { usableSnowReport } from "../snowfall-quality";
import { RESORTS } from "../catalog";
import { forecastPointFresh } from "../forecastFreshness";
import { HOUR } from "../sources/types";
import { formatLocal } from "../time";
import type { DailySnowPost, Metric, NwsPayload, PrimaryResortId, ResortReport, Snapshot } from "../types";
import type { StormCursor, StormObservation, StormRecord, StormResort, StormTrackingState } from "./storm-types";

export const STORM_LULL_MS = 12 * HOUR;
export const STORM_CLOSE_MS = 24 * HOUR;
export const STORM_MAX_LULL_MS = 48 * HOUR;
export const STORM_RECAP_MS = 36 * HOUR;
const REPORT_MAX_AGE = 26 * HOUR;
const FETCH_MAX_AGE = 20 * 60_000;
const WORKING_EVENTS = 3;

const ms = (s: string | null | undefined) => s ? Date.parse(s) : -Infinity;
const value = (m: Metric | undefined) => m?.state === "reported" && Number.isFinite(m.value) && m.value >= 0 ? m.value : null;
const newer = <T extends { collectedAt: string }>(a: T | null | undefined, b: T | null | undefined): T | null =>
  !a ? b ?? null : !b ? a : ms(a.collectedAt) > ms(b.collectedAt) ? a : b;

/** Permanent, versioned event record. No TTL and no database migration. */
export const stormKey = (id: string) => `dailysnow-storm:v1:${id}`;

function rolling(a: StormObservation | null, b: StormObservation | null): StormObservation | null {
  if (!a) return b;
  if (!b) return a;
  // A 48-hour observation takes precedence over a 24-hour one; neither is a storm total.
  if (a.window !== b.window) return a.window === "48h" ? a : b;
  return a.amountIn >= b.amountIn ? a : b;
}

export function mergeStormRecord(a: StormRecord, b: StormRecord): StormRecord {
  const latest = ms(a.updatedAt) > ms(b.updatedAt) ? a : b;
  const lastSnowAt = ms(a.lastSnowAt) > ms(b.lastSnowAt) ? a.lastSnowAt : b.lastSnowAt;
  const invalidClosure = latest.closedAt !== null && ms(latest.closedAt) - ms(lastSnowAt) < STORM_CLOSE_MS;
  return {
    ...latest,
    firstObservedAt: ms(a.firstObservedAt) < ms(b.firstObservedAt) ? a.firstObservedAt : b.firstObservedAt,
    lastSnowAt,
    ...(invalidClosure ? { status: "active", closedAt: null, closureReason: null } as const : {}),
    resorts: RESORTS.filter(r=>a.resorts.some(x=>x.id===r.id)||b.resorts.some(x=>x.id===r.id)).map(({ id, name }) => {
      const ar = a.resorts.find((r) => r.id === id);
      const br = b.resorts.find((r) => r.id === id);
      const counterResetAt = [ar?.counterResetAt, br?.counterResetAt].filter((x): x is string => !!x).sort()[0];
      const totals = [ar?.total, br?.total].filter((x): x is StormObservation => !!x);
      const prior = counterResetAt ? totals.filter((x) => ms(x.collectedAt) < ms(counterResetAt)) : totals;
      const segments = [ar?.latestSegment, br?.latestSegment, ...(counterResetAt ? totals.filter((x) => ms(x.collectedAt) >= ms(counterResetAt)) : [])];
      const latestSegment = segments.reduce<StormObservation | null>((p, x) => newer(p, x), null);
      return {
        id, name, total: prior.reduce<StormObservation | null>((p, x) => newer(p, x), null), rolling: rolling(ar?.rolling ?? null, br?.rolling ?? null),
        ...(counterResetAt ? { counterResetAt } : {}), ...(latestSegment ? { latestSegment } : {}),
      };
    }),
  };
}

/** Per-resort observations survive an older overlapping collector or a slow AI completion. */
export function mergeStormTracking(a: StormTrackingState | undefined, b: StormTrackingState | undefined): StormTrackingState | undefined {
  if (!a) return b;
  if (!b) return a;
  const events = new Map(a.events.map((e) => [e.id, e]));
  for (const e of b.events) events.set(e.id, events.has(e.id) ? mergeStormRecord(events.get(e.id)!, e) : e);
  // Two overlapping first collections can independently discover the same
  // storm. Coalesce only near-simultaneous starts without a closure boundary.
  const coalesced: StormRecord[] = [];
  for (const e of [...events.values()].sort((x, y) => ms(x.firstObservedAt) - ms(y.firstObservedAt))) {
    const prior = coalesced.at(-1);
    if (prior && ms(e.firstObservedAt) - ms(prior.firstObservedAt) <= FETCH_MAX_AGE
      && (!prior.closedAt || ms(e.firstObservedAt) <= ms(prior.closedAt))) {
      coalesced[coalesced.length - 1] = { ...mergeStormRecord(prior, e), id: prior.id };
    } else coalesced.push(e);
  }
  const cursors: StormTrackingState["cursors"] = {};
  for (const { id } of RESORTS) {
    const c = newer(a.cursors[id], b.cursors[id]);
    if (c) cursors[id] = c;
  }
  return {
    checkedAt: ms(a.checkedAt) > ms(b.checkedAt) ? a.checkedAt : b.checkedAt,
    cursors,
    events: coalesced.reverse().slice(0, WORKING_EVENTS),
  };
}

function blankEvent(at: string, ids:PrimaryResortId[]): StormRecord {
  return {
    id: at, firstObservedAt: at, lastSnowAt: at, updatedAt: at,
    status: "active", closedAt: null, closureReason: null,
    resorts: RESORTS.filter(r=>ids.includes(r.id)).map(({ id, name }) => ({ id, name, total: null, rolling: null })),
  };
}

function capture(r: StormResort, c: StormCursor, sourceUrl: string, notBefore?: string | null): StormResort {
  const observation = (amountIn: number, window: StormObservation["window"]): StormObservation => ({
    amountIn, window, reportTime: c.reportTime, collectedAt: c.collectedAt, sourceUrl,
  });
  let total = r.total;
  const counterResetAt = r.counterResetAt ?? (c.stormIn === 0 && total ? c.collectedAt : undefined);
  let latestSegment = r.latestSegment;
  // Zero is preserved in the live source, but cannot erase a previous storm observation.
  if ((c.stormIn ?? 0) > 0 && counterResetAt && ms(c.collectedAt) >= ms(counterResetAt)) {
    latestSegment = observation(c.stormIn!, "storm");
  } else if ((c.stormIn ?? 0) > 0 && (!total || ms(c.reportTime) > ms(total.reportTime))) {
    total = observation(c.stormIn!, "storm");
    if (r.total && r.total.amountIn !== total.amountIn) total.previousAmountIn = r.total.amountIn;
  }
  const candidate = (c.h48In ?? 0) > 0 && (!notBefore || ms(c.collectedAt) - 48 * HOUR >= ms(notBefore)) ? observation(c.h48In!, "48h")
    : (c.h24In ?? 0) > 0 && (!notBefore || ms(c.collectedAt) - 24 * HOUR >= ms(notBefore)) ? observation(c.h24In!, "24h") : null;
  return { ...r, total, rolling: rolling(r.rolling, candidate), ...(counterResetAt ? { counterResetAt } : {}), ...(latestSegment ? { latestSegment } : {}) };
}

/** Require a current forecast covering the whole near-term window before calling it dry. */
function dryAhead(snapshot: Snapshot, now: Date): boolean {
  const s = snapshot.sources.nws;
  if (s?.status !== "ok" || now.getTime() - ms(s.lastSuccessfulFetchAt) > 47 * 60_000) return false;
  const points = (s.payload as NwsPayload | null)?.points ?? [];
  if (!points.length) return false;
  return points.every((p) => {
    if (!forecastPointFresh(p,now)) return false;
    const bars = p.sixHourSnow.filter((b) => ms(b.start) + 6 * HOUR > now.getTime() && ms(b.start) < now.getTime() + 18 * HOUR);
    const coverage = [...bars].sort((a, b) => ms(a.start) - ms(b.start));
    let end = now.getTime();
    for (const b of coverage) {
      if (ms(b.start) > end) return false;
      end = ms(b.start) + 6 * HOUR;
    }
    return end >= now.getTime() + 18 * HOUR && bars.reduce((sum, b) => sum + b.snowIn, 0) < 0.5;
  });
}

/**
 * Pure collection-time reducer. Never sums rolling values. A positive increase
 * is evidence of more snow, not an amount to add. Identical/older observations
 * cannot refresh lastSnowAt, create another event or reopen a closed one.
 */
export function advanceStormTracking(previous: StormTrackingState | undefined, snapshot: Snapshot, now: Date): StormTrackingState {
  const state: StormTrackingState = structuredClone(previous ?? { checkedAt: now.toISOString(), cursors: {}, events: [] });
  if (ms(state.checkedAt) > now.getTime()) return state;
  state.checkedAt = now.toISOString();
  const observations: Array<{ id: PrimaryResortId; cursor: StormCursor; sourceUrl: string; increased: boolean; first: boolean; lateReport: boolean }> = [];
  for (const { id } of RESORTS) {
    const s = snapshot.sources[id];
    const r = usableSnowReport(s?.payload as ResortReport | null);
    if (s?.status !== "ok" || !r?.snowfall || !s.lastSuccessfulFetchAt || !r.reportTime) continue;
    if (now.getTime() - ms(s.lastSuccessfulFetchAt) > FETCH_MAX_AGE || now.getTime() - ms(r.reportTime) > REPORT_MAX_AGE || ms(r.reportTime) > now.getTime() + 5 * 60_000) continue;
    const c: StormCursor = {
      collectedAt: s.lastSuccessfulFetchAt, reportTime: r.reportTime, seasonIn: value(r.snowfall.season),
      stormIn: value(r.snowfall.storm), h24In: value(r.snowfall.h24), h48In: value(r.snowfall.h48),
    };
    const old = state.cursors[id];
    if (old && (ms(c.collectedAt) <= ms(old.collectedAt) || ms(c.reportTime) < ms(old.reportTime))) continue;
    const first = !old;
    const positiveSnow = Math.max(c.stormIn ?? 0, c.h24In ?? 0, c.h48In ?? 0) > 0;
    const increased = !!old && positiveSnow && (["seasonIn", "stormIn", "h24In", "h48In"] as const).some((k) => c[k] !== null && old[k] !== null && c[k]! > old[k]!);
    // Re-fetches update the cursor so rolling windows can shrink without being replayed.
    state.cursors[id] = c;
    const closed = state.events[0];
    // A still-running source storm counter can receive the final inch after
    // our dry-weather closure. Its season total may legitimately rise too.
    const lateReport = !!closed?.closedAt && now.getTime() - ms(closed.closedAt) < STORM_RECAP_MS
      && (first || ((old?.stormIn ?? 0) > 0 && (c.stormIn ?? 0) > 0
      && (c.stormIn !== old?.stormIn || c.seasonIn !== old?.seasonIn) && ms(c.reportTime) > ms(old?.reportTime)));
    observations.push({ id, cursor: c, sourceUrl: r.sourceUrl, increased, first, lateReport });
  }

  let event = state.events.find((e) => e.status !== "closed");
  const lastClosed = state.events.find((e) => e.status === "closed")?.closedAt;
  const newSnow = observations.filter((o) => !o.lateReport && (o.increased || (o.first && Math.max(o.cursor.stormIn ?? 0, o.cursor.h24In ?? 0, o.cursor.h48In ?? 0) > 0
    && (!lastClosed || ms(o.cursor.reportTime) > ms(lastClosed)))));
  if (!event && newSnow.length) {
    event = blankEvent(now.toISOString(),RESORTS.filter(r=>snapshot.sources[r.id]).map(r=>r.id));
    state.events.unshift(event);
    state.events = state.events.slice(0, WORKING_EVENTS);
  }
  if (!event) {
    const closed = state.events[0];
    if (closed) for (const o of observations.filter((o) => o.lateReport)) {
      if (!closed.resorts.some(r => r.id === o.id)) closed.resorts.push({ id: o.id, name: RESORTS.find(r => r.id === o.id)!.name, total: null, rolling: null });
      closed.resorts = closed.resorts.map((r) => r.id === o.id ? capture(r, o.cursor, o.sourceUrl) : r);
      closed.updatedAt = now.toISOString();
    }
    return state;
  }
  const before = JSON.stringify(event);
  if (newSnow.length) {
    event.lastSnowAt = now.toISOString();
    event.status = "active";
  }
  for (const o of observations) {
    // An old report from another resort cannot get assigned to a new storm.
    if (lastClosed && ms(o.cursor.reportTime) <= ms(lastClosed) && !o.increased) continue;
    const member = event.resorts.find((r) => r.id === o.id);
    if (lastClosed && !member?.total && !member?.rolling && !newSnow.includes(o)) continue;
    if (!member) event.resorts.push({ id: o.id, name: RESORTS.find(r => r.id === o.id)!.name, total: null, rolling: null });
    event.resorts = event.resorts.map((r) => r.id === o.id ? capture(r, o.cursor, o.sourceUrl, lastClosed) : r);
  }
  const lull = now.getTime() - ms(event.lastSnowAt);
  const dry = dryAhead(snapshot, now);
  if (lull >= STORM_MAX_LULL_MS || (lull >= STORM_CLOSE_MS && dry)) {
    event.status = "closed";
    event.closedAt = now.toISOString();
    event.closureReason = dry ? "dry-forecast" : "no-new-evidence";
  } else if (lull >= STORM_LULL_MS && dry) event.status = "wrapping-up";
  if (JSON.stringify(event) !== before) event.updatedAt = now.toISOString();
  return state;
}

/** Only the latest event is editorial context; old totals cannot hold sunny days in storm mode. */
export function stormForPost(state: StormTrackingState | undefined, now: Date): StormRecord | null {
  const e = state?.events[0];
  if (!e || (e.closedAt && now.getTime() - ms(e.closedAt) >= STORM_RECAP_MS)) return null;
  return structuredClone(e);
}

/** Model-facing projection: all time conversion and observation attribution happen in code. */
export function stormDigest(storm: StormRecord, now: Date, zone="America/Denver") {
  const observation = (o: StormObservation | null | undefined) => o ? {
    amountIn: o.amountIn, window: o.window, sourceUrl: o.sourceUrl,
    reportLocal: o.reportTime ? formatLocal(o.reportTime, now,zone) : "unknown",
    checkedLocal: formatLocal(o.collectedAt, now,zone),
    ...(o.previousAmountIn !== undefined ? { previousAmountIn: o.previousAmountIn } : {}),
  } : null;
  return {
    status: storm.status, closureReason: storm.closureReason,
    trackedSinceLocal: formatLocal(storm.firstObservedAt, now,zone),
    lastSnowEvidenceLocal: formatLocal(storm.lastSnowAt, now,zone),
    closedLocal: storm.closedAt ? formatLocal(storm.closedAt, now,zone) : null,
    resorts: storm.resorts.map((r) => ({
      id: r.id, name: r.name, total: observation(r.total), rolling: observation(r.rolling),
      ...(r.counterResetAt ? { counterResetLocal: formatLocal(r.counterResetAt, now,zone) } : {}),
      ...(r.latestSegment ? { latestSegment: observation(r.latestSegment) } : {}),
    })),
  };
}

/** Bootstrap once from structured archived observations, never historical AI prose. */
export function seedStormTracking(posts: DailySnowPost[], now: Date): StormTrackingState | undefined {
  let state: StormTrackingState | undefined;
  const recent = posts.filter((p) => ms(p.generatedAt) <= now.getTime() && now.getTime() - ms(p.generatedAt) < 72 * HOUR)
    .sort((a, b) => ms(a.generatedAt) - ms(b.generatedAt));
  for (const p of recent) {
    if (p.stormRecap) {
      state = mergeStormTracking(state, { checkedAt: p.generatedAt, events: [p.stormRecap], cursors: {} });
      for (const r of p.numbers.resorts) {
        if (ms(state?.cursors[r.id]?.collectedAt) > ms(p.generatedAt)) continue;
        state!.cursors[r.id] = {
          collectedAt: p.generatedAt, reportTime: r.reportTime, stormIn: r.storm,
          h24In: r.h24, h48In: r.h48 ?? null, seasonIn: r.seasonIn ?? null,
        };
      }
      continue;
    }
    if (p.phase !== "storm" && p.phase !== "post-storm") continue;
    const snapshot: Snapshot = { schemaVersion: 1, writtenAt: p.generatedAt, sources: {} };
    const figure = p.figures["resort-totals"];
    for (const r of p.numbers.resorts) {
      const row = figure?.kind === "totals" ? figure.rows.find((x) => x.name === r.name) : null;
      const metric = (v: number | null): Metric => v === null ? { state: "unavailable", label: "Archived" } : { state: "reported", value: v, unit: "in", label: "Archived" };
      snapshot.sources[r.id] = {
        id: r.id, status: "ok", lastSuccessfulFetchAt: p.generatedAt, lastAttemptAt: p.generatedAt,
        sourceUpdatedAt: r.reportTime, lastError: null, lastErrorAt: null, consecutiveFailures: 0, diagnostics: null,
        payload: { reportTime: r.reportTime, sourceUrl: `https://${r.id === "alta" ? "www.alta.com" : r.id === "snowbird" ? "www.snowbird.com" : r.id === "solitude" ? "www.solitudemountain.com" : "www.brightonresort.com"}/`, snowfall: {
          h24: metric(r.h24), h48: metric(row?.h48 ?? null), storm: metric(r.storm),
        } },
      };
    }
    state = advanceStormTracking(state, snapshot, new Date(p.generatedAt));
  }
  return state;
}
