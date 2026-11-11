"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cachedDateFormat } from "@/lib/time";

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short" });
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
/** First point of each Mountain Time calendar day (robust across DST). */
const newDay = (xs: Array<{ start: string }>, i: number) =>
  i === 0 || dayKeyFmt.format(new Date(xs[i].start)) !== dayKeyFmt.format(new Date(xs[i - 1].start));

/**
 * Draws its chart at the container's measured width, so one SVG unit is one CSS
 * pixel: text stays 12px and bars stay proportionate on phones and desktops, with
 * no horizontal scrolling. Before the first measurement it assumes a desktop width.
 */
function Chart({ label, height, children }: { label: string; height: number; children: (width: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label}>
        {children(width)}
      </svg>
    </div>
  );
}

const TOP = 20; // room for value labels above the tallest bar
const AXIS = 24; // day labels under the axis

/** One color and one dash per line, in fixed order (never cycled within eight), so every location
 * stays distinct by color and again by dash where lines cross or the reader can't tell hues apart. */
export const SNOW_LEVEL_STYLES: ReadonlyArray<{ color: string; dash?: string }> = [
  { color: "var(--series-1)" },
  { color: "var(--series-2)", dash: "8 4" },
  { color: "var(--series-3)", dash: "2 3" },
  { color: "var(--series-4)", dash: "12 3 2 3" },
  { color: "var(--series-5)", dash: "4 4" },
  { color: "var(--series-6)", dash: "12 4" },
  { color: "var(--series-7)", dash: "1 4" },
  { color: "var(--series-8)", dash: "6 2 2 2 2 2" },
];
export const snowLevelStyle = (i: number) => SNOW_LEVEL_STYLES[i % SNOW_LEVEL_STYLES.length];
export interface SnowLevelSeries {
  canyon: string;
  points: Array<{ start: string; ft: number }>;
}

/** Forecast snow level, one line per point, styled by its position (see SNOW_LEVEL_STYLES). */
export function SnowLevel({ series, label,timeZone="America/Denver" }: { series: SnowLevelSeries[]; label: string;timeZone?:string }) {
  const dayFmt=cachedDateFormat("en-US",{timeZone,weekday:"short"});
  const keyFmt=cachedDateFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"});
  const newDay=(xs:Array<{start:string}>,i:number)=>i===0||keyFmt.format(new Date(xs[i].start))!==keyFmt.format(new Date(xs[i-1].start));
  const h = 120;
  const gutter = 44; // "8k ft" labels
  const all = series.flatMap((s) => s.points);
  const t0 = Math.min(...all.map((p) => Date.parse(p.start)));
  const t1 = Math.max(...all.map((p) => Date.parse(p.start)));
  const lo = Math.floor(Math.min(...all.map((p) => p.ft)) / 1000) * 1000;
  const hi = Math.ceil(Math.max(...all.map((p) => p.ft)) / 1000) * 1000 || lo + 1000;
  const y = (ft: number) => TOP + h - ((ft - lo) / Math.max(1, hi - lo)) * h;
  const ticks: number[] = [];
  for (let ft = lo; ft <= hi; ft += hi - lo > 4000 ? 2000 : 1000) ticks.push(ft);
  const ref = series[0]?.points ?? [];
  return (
    <Chart label={label} height={TOP + h + AXIS}>
      {(w) => {
        const x = (iso: string) => (t1 === t0 ? gutter : ((Date.parse(iso) - t0) / (t1 - t0)) * (w - gutter - 4) + gutter);
        return (
          <>
            {ticks.map((ft) => (
              <g key={ft}>
                <line x1={gutter} x2={w} y1={y(ft)} y2={y(ft)} className="chart__grid" />
                <text x={0} y={y(ft) + 4} className="chart__label">{(ft / 1000).toFixed(0)}k ft</text>
              </g>
            ))}
            {ref.map((p, i) => newDay(ref, i) && x(p.start) + 30 <= w && (
              <text key={p.start} x={x(p.start) + 4} y={TOP + h + 17} className="chart__label">{dayFmt.format(new Date(p.start))}</text>
            ))}
            {series.map((s,i) => (
              <polyline key={s.canyon} style={{ stroke: snowLevelStyle(i).color, strokeDasharray: snowLevelStyle(i).dash }} className="snow-level__line" points={s.points.map((p) => `${x(p.start)},${y(p.ft)}`).join(" ")} />
            ))}
          </>
        );
      }}
    </Chart>
  );
}
