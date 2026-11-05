import { CRON_INTERVAL_MS, type SourceDefinition } from "./sources/types";
import type { Freshness, SourceRecord } from "./types";

export type StatusTone = "neutral" | "ok" | "warn" | "bad";

/** Public wording and visual meaning; API states and source thresholds stay independent. */
export const FRESHNESS_STATUS: Record<Freshness, { label: string; tone: StatusTone; description: string }> = {
  current: { label: "Current", tone: "ok", description: "Checked on schedule; report time is within this source’s expected window." },
  "old-report": { label: "Old report", tone: "warn", description: "Checked recently, but the upstream report is older than this source’s expected window." },
  "time-unknown": { label: "Time unknown", tone: "neutral", description: "Checked recently; the information’s publication time cannot be established." },
  stale: { label: "Updates delayed", tone: "warn", description: "No successful check within this source’s expected window; showing the last successful data." },
  unavailable: { label: "Unavailable", tone: "bad", description: "No usable collected data is available." },
};

/**
 * A source is stale when its last successful fetch is older than this. Four
 * missed five-minute runs plus KV propagation (up to ~60 s) and slack.
 */
export const STALE_AFTER_MS = 22 * 60_000;

/**
 * Stale threshold for a source: four missed runs plus KV propagation at the
 * 5-minute cadence, extended by a slower source's own collection interval.
 */
export function staleAfterMs(def: Pick<SourceDefinition, "intervalMs">): number {
  return STALE_AFTER_MS + Math.max(0, (def.intervalMs ?? CRON_INTERVAL_MS) - CRON_INTERVAL_MS);
}

export function classify(
  def: Pick<SourceDefinition, "reportMaxAgeMs" | "intervalMs">,
  rec: SourceRecord | undefined,
  now: Date,
): { freshness: Freshness; note: string } {
  if (!rec || !rec.lastSuccessfulFetchAt || rec.payload === null) {
    return {
      freshness: "unavailable",
      note: rec?.lastError ? `Never collected successfully (${rec.lastError})` : "Not collected yet",
    };
  }
  const sinceSuccess = now.getTime() - Date.parse(rec.lastSuccessfulFetchAt);
  if(!Number.isFinite(sinceSuccess)||sinceSuccess < -120000)return {freshness:"stale",note:"Invalid or future collection time"};
  if (sinceSuccess > staleAfterMs(def)) {
    return {
      freshness: "stale",
      note: "No successful check within the expected collection window; showing last successful data",
    };
  }
  if (def.reportMaxAgeMs === null) {
    return { freshness: "time-unknown", note: "Source does not publish an update time" };
  }
  if (!rec.sourceUpdatedAt) {
    return { freshness: "time-unknown", note: "Source report time unknown" };
  }
  const age = now.getTime() - Date.parse(rec.sourceUpdatedAt);
  if (!Number.isFinite(age) || age < -120000 || age > def.reportMaxAgeMs) {
    return { freshness: "old-report", note: "Fetched recently, but the upstream report itself is old" };
  }
  return { freshness: "current", note: "Collected on schedule; report within its normal update window" };
}
