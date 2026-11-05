import { dailySnowActivity } from "./dailysnow/digest";
import { dailySnowPublicationStatus } from "./dailysnow/publication";
import { SOURCES } from "./sources";
import type { SourceDefinition } from "./sources/types";
import { denverDate } from "./dailysnow/facts";
import type { ApiDailySnow, ApiSource, DailySnowPost, DailySnowState, Freshness, ReportResponse, Snapshot, SourceId, SourceRecord } from "./types";

export const COLLECTION_INTERVAL_MIN = 5;
export { classify, staleAfterMs, STALE_AFTER_MS } from "./freshness";
import { classify } from "./freshness";

/** Strip operational detail that should not be public (e.g. upstream URLs with tokens are already redacted). */
function publicRecord(rec: SourceRecord): SourceRecord {
  return {
    ...rec,
    diagnostics: rec.diagnostics
      ? {
          durationMs: rec.diagnostics.durationMs,
          upstream: rec.diagnostics.upstream.map((u) => ({ url: u.url.split("?")[0], status: u.status, ms: u.ms })),
        }
      : null,
  };
}

/** Consecutive failed Daily Snow attempts before the post says updates are failing. */
export const DAILY_SNOW_FAILING_AFTER = 2;

/** Recent posts indexed in the snapshot and listed in every response's `archive`. Navigation
    doesn't depend on it: each post links its neighbors, within the retention window below. */
export const DAILY_SNOW_ARCHIVE_POSTS = 10;

/** Daily Snow posts, their figure stills and storm records expire from KV after this many days. */
export const DAILY_SNOW_RETENTION_DAYS = 30;
const RETENTION_MS = DAILY_SNOW_RETENTION_DAYS * 24 * 3_600_000;
/** A post is posted around 6 AM Denver (12:00Z or 13:00Z); its archive expires 30 days after noon UTC that day. */
const dailySnowExpiresAt = (date: string) => Date.parse(`${date}T12:00:00Z`) + RETENTION_MS;

/** Seconds until the archive of the post on `date` expires (KV's minimum TTL is 60 s). */
export function dailySnowArchiveTtlS(date: string, now: Date): number {
  return Math.max(60, Math.ceil((dailySnowExpiresAt(date) - now.getTime()) / 1000));
}

/** A Daily Snow post (current or archived) as the API serves it. */
export function publicDailySnow(post: DailySnowPost | null | undefined, state: DailySnowState | undefined, now: Date, expected?: boolean): ApiDailySnow | null {
  // Past retention its figure stills are gone too; an off-season gap shows no post rather than a broken one.
  if (!post || dailySnowExpiresAt(post.date) <= now.getTime()) return null;
  const today = denverDate(now,post.timeZone??"America/Denver");
  // Don't link back to a post that has already expired from the archive.
  const { older, ...rest } = post;
  return {
    ...rest,
    ...(older && dailySnowExpiresAt(older.date) > now.getTime() ? { older } : {}),
    outdated: post.date !== today,
    publicationStatus: expected !== undefined && state?.current?.date === post.date ? dailySnowPublicationStatus(post.date, state, now, expected,post.channel) : undefined,
    failing: post.date !== today && (state?.consecutiveFailures ?? 0) >= DAILY_SNOW_FAILING_AFTER,
    archive: (state?.history ?? []).slice(0, DAILY_SNOW_ARCHIVE_POSTS).filter((h) => dailySnowExpiresAt(h.date) > now.getTime()).map((h) => ({ date: h.date, title: h.title })),
  };
}

export function buildReport(snapshot: Snapshot | null, now: Date = new Date(), defs: SourceDefinition[] = SOURCES): ReportResponse {
  const sources = {} as Record<SourceId, ApiSource>;
  const requiredMissing: SourceId[] = [];
  for (const def of defs) {
    const rec = snapshot?.sources[def.id];
    const { freshness, note } = classify(def, rec, now);
    const base: SourceRecord = rec ? publicRecord(rec) : {
      id: def.id,
      lastAttemptAt: null,
      lastSuccessfulFetchAt: null,
      sourceUpdatedAt: null,
      status: "never",
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      diagnostics: null,
      payload: null,
    };
    sources[def.id] = {
      ...base,
      label: def.label,
      category: def.category,
      reportMaxAgeMs:def.reportMaxAgeMs, intervalMs:def.intervalMs,
      required: def.required,
      attribution: def.attribution,
      sourceUrl: def.sourceUrl,
      freshness,
      freshnessNote: note,
    };
    if (def.required && (freshness === "unavailable" || freshness === "stale")) requiredMissing.push(def.id);
  }
  return {
    generatedAt: now.toISOString(),
    snapshotWrittenAt: snapshot?.writtenAt ?? null,
    collectionIntervalMinutes: COLLECTION_INTERVAL_MIN,
    sources,
    requiredMissing,
    snowLog: snapshot?.snowLog ?? null,
    dailySnow: publicDailySnow(snapshot?.dailySnow?.current, snapshot?.dailySnow, now, snapshot?.dailySnow?.current ? dailySnowActivity(snapshot, now).publicationExpected : false),
  };
}
