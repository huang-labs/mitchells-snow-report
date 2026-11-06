import type { CSSProperties, ReactNode } from "react";
import { formatLocalRelative } from "@/lib/time";
import { MetricValue } from "../ui";
import { barLabel, type SnowTimelineModel, type TimelineDay } from "./model";
import "./timeline.css";

const ratio = (v: number, scale: number) => Math.min(v, scale) / scale;

/** A day's plot: the bar, the forecast outline behind it, and the amount just above the taller of them. */
function Plot({ amountIn, forecastIn = null, label, scale }: { amountIn: number | null; forecastIn?: number | null; label: string; scale: number }) {
  const bar = amountIn !== null && amountIn > 0 ? ratio(amountIn, scale) : 0;
  // Sub-inch historical forecasts add clutter at the baseline; retain them in day.detail.
  const showGhost = forecastIn !== null && forecastIn >= 1;
  const ghost = showGhost ? ratio(forecastIn, scale) : 0;
  return (
    <span className="snowtl__plot">
      {showGhost && <span className="snowtl__ghost" style={{ "--r": ghost } as CSSProperties} />}
      {bar > 0 && <span className={`snowtl__bar${amountIn! > scale ? " snowtl__bar--over" : ""}`} style={{ "--r": bar } as CSSProperties} />}
      {label && (
        <span className={`snowtl__amount${amountIn === 0 ? " snowtl__amount--zero" : ""}`} style={{ "--r": Math.max(bar, ghost) } as CSSProperties}>{label}</span>
      )}
    </span>
  );
}

function amountText(day: TimelineDay): string {
  if (day.amountIn !== null) return barLabel(day.amountIn);
  return day.state === "not_recorded" || day.state === "no_forecast" ? "" : "–";
}

function Day({ day, scale }: { day: TimelineDay; scale: number }) {
  return (
    <li className={`snowtl__day snowtl__day--${day.kind} snowtl__day--${day.state}${day.weekend ? " snowtl__day--weekend" : ""}`}>
      <span className="snowtl__sr">{day.detail}</span>
      <span className="snowtl__visual" aria-hidden="true">
        <Plot amountIn={day.amountIn} forecastIn={day.forecastIn} label={amountText(day)} scale={scale} />
        <span className="snowtl__weekday">{day.weekday[0]}</span>
        <span className="snowtl__date">{day.dayOfMonth}</span>
      </span>
    </li>
  );
}

/**
 * Daily snowfall around now: 7 past snow days (each resort's morning report), the
 * latest 24 h figure, and 7 days of NWS forecast. The page supplies the heading and
 * a line shown beside it, an optional footer beneath the strip, and a shared `scale`
 * when several timelines are shown together. Each day carries a full description for screen readers; the drawing is
 * hidden from them.
 */
export function SnowTimeline({
  model,
  scale,
  label,
  heading,
  meta,
  footer,
  now,
}: {
  model: SnowTimelineModel;
  scale: number;
  /** Plain-text name for screen readers ("Alta"). */
  label: string;
  heading: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  now: Date;
}) {
  const m = model.last24.metric;
  // A figure without a report time is "Time unknown"; "No report" means no figure at all.
  const reportTime = model.last24.reportTime ? formatLocalRelative(model.last24.reportTime, now, model.timeZone) : m ? "Time unknown" : null;
  return (
    <div className="snowtl">
      <div className="snowtl__head">
        <div className="snowtl__heading">
          {heading}
          {meta && <div className="snowtl__meta">{meta}</div>}
        </div>
        {reportTime && (
          <span className="snowtl__reported" aria-hidden="true">
            <span className="snowtl__reported-label">Reported</span>
            <span className="snowtl__reported-time">{reportTime}</span>
          </span>
        )}
      </div>
      <ol className="snowtl__strip" aria-label={`${label} snowfall by day: past 7 days, last 24 hours, next 7 days`}>
        <li className="snowtl__span snowtl__span--past" aria-hidden="true">Past 7 days</li>
        <li className="snowtl__span snowtl__span--now" aria-hidden="true">Last 24 h</li>
        <li className="snowtl__span snowtl__span--next" aria-hidden="true">Next 7 days</li>
        {model.past.map((day) => <Day key={day.key} day={day} scale={scale} />)}
        <li className="snowtl__day snowtl__day--today">
          <span className="snowtl__sr">{model.last24.detail}</span>
          <span className="snowtl__compact" aria-hidden="true">
            <Plot amountIn={m?.state === "reported" ? m.value : null} label={m?.state === "reported" ? barLabel(m.value) : "–"} scale={scale} />
            <span className="snowtl__weekday">24h</span>
            <span className="snowtl__date">now</span>
          </span>
          <span className="snowtl__hero" aria-hidden="true">
            {m ? <MetricValue m={m} size="xl" /> : <span className="metric__na">—</span>}
            <span className="snowtl__hero-time">{reportTime ?? "No report"}</span>
          </span>
        </li>
        {model.future.map((day) => <Day key={day.key} day={day} scale={scale} />)}
      </ol>
      {model.last24.warning && <p className="snowtl__footer" role="note">{model.last24.warning}</p>}
      {footer && <div className="snowtl__footer">{footer}</div>}
    </div>
  );
}
