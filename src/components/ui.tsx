import type { ReactNode } from "react";
import type { ApiSource, Freshness, LiftStatus, Metric, Notice } from "@/lib/types";
import { formatAge, formatDenver, formatLocal } from "@/lib/time";
import { FRESHNESS_STATUS, type StatusTone } from "@/lib/freshness";

export const FRESHNESS_TEXT = Object.fromEntries(Object.entries(FRESHNESS_STATUS).map(([key, status]) => [key, status.label])) as Record<Freshness, string>;

export function StatusBadge({ children, tone, title, className = "" }: { children: ReactNode; tone: StatusTone; title?: string; className?: string }) {
  return <span className={`badge badge--${tone} ${className}`.trim()} title={title}>{children}</span>;
}

export function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  const status = FRESHNESS_STATUS[freshness];
  return <StatusBadge tone={status.tone} title={status.description} className={`badge--${freshness}`}>{status.label}</StatusBadge>;
}

/** Large metric value. Zero, not-reported and unavailable look different. */
export function MetricValue({ m, size = "lg" }: { m: Metric; size?: "xl" | "lg" | "md" | "sm" }) {
  let body;
  if (m.state === "reported") {
    const unit = m.unit === "in" ? "″" : m.unit === "°F" ? "°" : m.unit === "count" ? "" : ` ${m.unit}`;
    body = (
      <span className={`metric__value ${m.value === 0 ? "metric__value--zero" : ""}`}>
        {formatNumber(m.value)}
        <span className={`metric__unit${m.unit === "in" || m.unit === "°F" ? " metric__unit--mark" : ""}`}>{unit}</span>
      </span>
    );
  } else {
    // One "no data" mark for a field left empty and a window the source doesn't publish;
    // the metric's state (and its class) still tells them apart.
    const why = m.state === "not_reported" ? "Not reported in this update" : "Not provided by this source";
    body = <span className="metric__na" title={m.note ?? why} aria-label="no data">—</span>;
  }
  return (
    <span className={`metric metric--${size} metric--${m.state}`}>
      {body}
    </span>
  );
}

function formatNumber(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function SourceLine({ source, now, reportLabel, timeZone }: { source: ApiSource; now: Date; reportLabel?: string;timeZone?:string }) {
  return (
    <div className="source-line">
      <FreshnessBadge freshness={source.freshness} />
      <span>
        {reportLabel ?? "Source time"}: <strong>{source.sourceUpdatedAt ? formatLocal(source.sourceUpdatedAt,now,timeZone) : "unknown"}</strong>
      </span>
      <span>
        Last successful check: <strong>{formatAge(source.lastSuccessfulFetchAt, now)}</strong>
      </span>
      {source.status === "error" && source.lastError && (
        <span className="source-line__error" title={source.lastError}>
          Last attempt failed {formatAge(source.lastAttemptAt, now)}
        </span>
      )}
      <span className="source-line__attr">{source.attribution}</span>
    </div>
  );
}

export function StatusDot({ status }: { status: LiftStatus }) {
  return <span className={`dot dot--${status}`} aria-hidden="true" />;
}

export function Unavailable({ source, what }: { source: ApiSource; what: string }) {
  return (
    <div className="unavailable">
      <h2>{what} unavailable</h2>
      <p>{source.freshnessNote}</p>
      {source.lastError && <p className="muted">Last error: {source.lastError}</p>}
    </div>
  );
}

const SEVERITY = { critical: 0, warning: 1, info: 2 } as const;

/**
 * Resort alerts and road notices, most severe first: the title and text read as
 * one sentence, with the source and time on a quiet line below.
 */
export function NoticeList({ notices, now, label,timeZone }: { notices: Array<Notice & { source?: string }>; now: Date; label?: string;timeZone?:string }) {
  return (
    <ul className="notices" aria-label={label}>
      {[...notices].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]).map((n, i) => {
        const meta = [n.source, n.updatedAt ? formatLocal(n.updatedAt,now,timeZone) : null].filter(Boolean).join(" · ");
        return (
          <li key={i} className={`notice notice--${n.severity}`}>
            <strong>{n.title}</strong> {n.text}
            {meta && <span className="notice__meta">{meta}</span>}
          </li>
        );
      })}
    </ul>
  );
}
