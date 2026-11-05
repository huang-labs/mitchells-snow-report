import { localMidnightsBetween } from "@/lib/time";
import type { PlumePanel } from "@/lib/types";

const HOUR = 3_600_000;
const AXIS_H = 66;
/** White margin around each panel, in chart pixels. */
const PAD = 20;
const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", month: "numeric", day: "numeric" });

export interface PlumePanelSvgProps {
  /** URL of the cropped panel PNG. */
  src: string;
  width: number;
  height: number;
  plot: PlumePanel["plot"];
  /** Model initialization (the frame's left edge) and forecast length (its right edge). */
  initTime: string;
  forecastHours: number;
  /** Optional vertical marker, e.g. the current time on the plumes page. */
  marker?: { time: Date; label: string };
  label: string;
  timeZone?:string;
}

/**
 * One cropped University of Utah panel on a white margin, with a Mountain Time
 * axis drawn in place of the original UTC labels (cut off by plumeCrop). The
 * plot frame spans init to init + forecastHours, so any instant maps linearly to x.
 */
export function PlumePanelSvg({ src, width, height, plot, initTime, forecastHours, marker, label, timeZone="America/Denver" }: PlumePanelSvgProps) {
  const dowFmt=new Intl.DateTimeFormat("en-US",{timeZone,weekday:"short"});
  const dateFmt=new Intl.DateTimeFormat("en-US",{timeZone,month:"numeric",day:"numeric"});
  const start = new Date(initTime);
  const end = new Date(start.getTime() + forecastHours * HOUR);
  const x = (t: Date) => plot.left + ((t.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * (plot.right - plot.left);
  const midnights = localMidnightsBetween(start, end,timeZone);
  // Day labels centred in each Mountain Time day (partial days at the edges included when wide enough).
  const bounds = [start, ...midnights, end];
  const days = bounds.slice(0, -1).map((d, i) => ({ from: d, to: bounds[i + 1] }));
  const markerVisible = marker && marker.time > start && marker.time < end;
  return (
    <svg className="plume__svg" viewBox={`${-PAD} ${-PAD} ${width + 2 * PAD} ${height + AXIS_H + 2 * PAD}`} role="img" aria-label={label}>
      <rect x={-PAD} y={-PAD} width={width + 2 * PAD} height={height + AXIS_H + 2 * PAD} fill="#fff" />
      <image href={src} x={0} y={0} width={width} height={height} />
      {midnights.map((m) => (
        <g key={m.getTime()}>
          <line x1={x(m)} x2={x(m)} y1={plot.top} y2={plot.bottom} className="plume__midnight" />
          <line x1={x(m)} x2={x(m)} y1={plot.bottom} y2={plot.bottom + 14} className="plume__tick" />
        </g>
      ))}
      {days.map(({ from, to }) => {
        const w = x(to) - x(from);
        if (w < 50) return null;
        const mid = new Date((from.getTime() + to.getTime()) / 2);
        return (
          <g key={from.getTime()}>
            <text x={(x(from) + x(to)) / 2} y={plot.bottom + 34} className="plume__day">{dowFmt.format(mid)}</text>
            {w >= 70 && (
              <text x={(x(from) + x(to)) / 2} y={plot.bottom + 58} className="plume__date">{dateFmt.format(mid)}</text>
            )}
          </g>
        );
      })}
      {markerVisible && (
        <g>
          <line x1={x(marker.time)} x2={x(marker.time)} y1={plot.top} y2={plot.bottom} className="plume__now" />
          {/* Above the frame, clear of the legend; runs are recent, so the marker sits left of the centred title. */}
          <text x={x(marker.time)} y={plot.top - 6} className="plume__nowlabel">{marker.label}</text>
        </g>
      )}
    </svg>
  );
}
