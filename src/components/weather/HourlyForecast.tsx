"use client";

import type { ReactNode } from "react";
import {
  COVERAGE_LABEL,
  COVERAGE_RANK,
  hourlyFromNow,
  isSkiHour,
  PRECIP_KINDS,
  SKI_HOURS,
  skiDaySummary,
  type HourlyWeather,
  type PrecipCoverage,
} from "@/lib/hourlyWeather";
import { cachedDateFormat } from "@/lib/time";
import { Chart } from "../charts";
import "./hourly.css";

const HOUR = 3_600_000;
const GUTTER = 56; // y-axis or row labels
const RIGHT = 4;
const PLOT = 76;
const AXIS = 20;
const ARROWS = 18;
const ROW = 14;
const ROW_GAP = 5;

type Values = Array<number | null> | undefined;
const has = (v: Values) => !!v?.some((x) => x !== null);
const nums = (...vs: Values[]) => vs.flatMap((v) => (v ?? []).filter((x): x is number => x !== null));
const dash = "—";
const deg = (v: number | null | undefined) => (v === null || v === undefined ? dash : `${v}°`);
const mph = (v: number | null | undefined) => (v === null || v === undefined ? dash : `${v}`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? dash : `${v}%`);
const span = (a: number | null, b: number | null, f: (v: number | null) => string) =>
  a === null || b === null ? dash : a === b ? f(a) : `${f(a)} to ${f(b)}`;
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (d: number | null | undefined) => (d === null || d === undefined ? "" : COMPASS[Math.round(d / 22.5) % 16]);

/** x geometry shared by every chart, so the four line up hour for hour. */
function frame(w: number, n: number) {
  const step = (w - GUTTER - RIGHT) / Math.max(1, n);
  return { step, edge: (i: number) => GUTTER + i * step, mid: (i: number) => GUTTER + (i + 0.5) * step };
}

/** Polyline path that breaks at hours the grid left empty. */
function linePath(values: Values, x: (i: number) => number, y: (v: number) => number) {
  let d = "";
  let pen = false;
  (values ?? []).forEach((v, i) => {
    if (v === null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Consecutive hours sharing one value, drawn as one shape so no seams show between hours. */
function runs<T>(values: T[]) {
  const out: Array<{ value: T; from: number; to: number }> = [];
  values.forEach((value, i) => {
    const last = out[out.length - 1];
    if (last && last.value === value) last.to = i + 1;
    else out.push({ value, from: i, to: i + 1 });
  });
  return out;
}

/** Hour-wide steps filled down to zero, one closed shape per run of reported hours. */
function stepArea(values: Values, edge: (i: number) => number, y: (v: number) => number) {
  let d = "";
  let open = -1;
  const close = (i: number) => { if (open >= 0) d += `L${edge(i).toFixed(1)},${y(0)}Z`; open = -1; };
  (values ?? []).forEach((v, i) => {
    if (v === null) { close(i); return; }
    if (open < 0) { d += `M${edge(i).toFixed(1)},${y(0)}`; open = i; }
    d += `L${edge(i).toFixed(1)},${y(v).toFixed(1)}L${edge(i + 1).toFixed(1)},${y(v).toFixed(1)}`;
  });
  close(values?.length ?? 0);
  return d;
}

function ticks(lo: number, hi: number, step: number) {
  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

interface Ctx { h: HourlyWeather; timeZone: string; times: number[] }

/** Ski-hour bands, hour ticks and day names, and a hover title per hour. */
function Backdrop({ ctx, w, top, height, axis = true, title }: { ctx: Ctx; w: number; top: number; height: number; axis?: boolean; title?: (i: number) => string }) {
  const { edge, step } = frame(w, ctx.h.hours);
  const hourFmt = cachedDateFormat("en-US", { timeZone: ctx.timeZone, hourCycle: "h23", hour: "2-digit" });
  const dayFmt = cachedDateFormat("en-US", { timeZone: ctx.timeZone, weekday: "short" });
  const bands: Array<[number, number]> = [];
  ctx.times.forEach((t, i) => {
    if (!isSkiHour(t, ctx.timeZone)) return;
    const last = bands[bands.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else bands.push([i, i + 1]);
  });
  return (
    <>
      {bands.map(([a, b]) => <rect key={a} x={edge(a)} y={top} width={edge(b) - edge(a)} height={height} className="hourly__ski" />)}
      {axis && ctx.times.map((t, i) => {
        const hr = +hourFmt.format(new Date(t)) % 24;
        if (hr % 6) return null;
        const x = edge(i);
        const text = hr === 0 ? dayFmt.format(new Date(t)) : hr === 12 ? "12p" : hr < 12 ? `${hr}a` : `${hr - 12}p`;
        return (
          <g key={t}>
            <line x1={x} x2={x} y1={top + height} y2={top + height + 4} className="chart__axis" />
            {x + 24 <= w && <text x={x + 2} y={top + height + 16} className={hr === 0 ? "chart__label hourly__day" : "chart__label"}>{text}</text>}
          </g>
        );
      })}
      {title && ctx.times.map((t, i) => (
        <rect key={`hit${t}`} x={edge(i)} y={top} width={step} height={height} className="hourly__hit"><title>{title(i)}</title></rect>
      ))}
    </>
  );
}

function YTicks({ w, values, y, unit }: { w: number; values: number[]; y: (v: number) => number; unit: string }) {
  return (
    <>
      {values.map((v) => (
        <g key={v}>
          <line x1={GUTTER} x2={w - RIGHT} y1={y(v)} y2={y(v)} className="chart__grid" />
          <text x={GUTTER - 8} y={y(v) + 4} className="chart__label" textAnchor="end">{v}{unit}</text>
        </g>
      ))}
    </>
  );
}

function Legend({ items }: { items: Array<{ label: string; className: string; area?: boolean }> }) {
  return (
    <span className="hourly__legend">
      {items.map((it) => (
        <span key={it.label}>
          <svg width="18" height="10" aria-hidden="true">
            {it.area ? <rect x="0" y="1" width="18" height="8" className={it.className} /> : <line x1="0" x2="18" y1="5" y2="5" className={it.className} />}
          </svg>
          {it.label}
        </span>
      ))}
    </span>
  );
}

function Panel({ title, legend, children, empty }: { title: string; legend?: ReactNode; children: ReactNode; empty: boolean }) {
  return (
    <figure className="hourly__panel">
      <figcaption><span className="hourly__title">{title}</span>{!empty && legend}</figcaption>
      {empty ? <p className="hourly__none"><span className="metric__na" title="Not in this NWS grid update" aria-label="no data">{dash}</span></p> : children}
    </figure>
  );
}

function TempChart({ ctx, label }: { ctx: Ctx; label: string }) {
  const { tempF, windChillF } = ctx.h;
  const all = nums(tempF, windChillF);
  const lo = Math.floor(Math.min(...all) / 10) * 10;
  let hi = Math.ceil(Math.max(...all) / 10) * 10;
  if (hi === lo) hi += 10;
  const y = (v: number) => 4 + PLOT - ((v - lo) / (hi - lo)) * PLOT;
  return (
    <Chart label={label} height={4 + PLOT + AXIS}>
      {(w) => {
        const { mid } = frame(w, ctx.h.hours);
        return (
          <>
            <Backdrop ctx={ctx} w={w} top={4} height={PLOT} title={(i) => `${timeTitle(ctx, i)}: ${deg(tempF?.[i])}F, wind chill ${deg(windChillF?.[i])}F`} />
            <YTicks w={w} values={ticks(lo, hi, hi - lo > 40 ? 20 : 10)} y={y} unit="°" />
            {has(windChillF) && <path d={linePath(windChillF, mid, y)} className="hourly__line hourly__line--chill" />}
            {has(tempF) && <path d={linePath(tempF, mid, y)} className="hourly__line hourly__line--temp" />}
          </>
        );
      }}
    </Chart>
  );
}

function WindChart({ ctx, label }: { ctx: Ctx; label: string }) {
  const { windMph, gustMph, windFromDeg } = ctx.h;
  const top = ARROWS;
  const hi = Math.max(10, Math.ceil(Math.max(...nums(windMph, gustMph)) / 10) * 10);
  const y = (v: number) => top + PLOT - (v / hi) * PLOT;
  return (
    <Chart label={label} height={top + PLOT + AXIS}>
      {(w) => {
        const { mid, step } = frame(w, ctx.h.hours);
        const every = Math.max(1, Math.ceil(18 / step));
        return (
          <>
            <Backdrop ctx={ctx} w={w} top={top} height={PLOT} title={(i) => `${timeTitle(ctx, i)}: wind ${mph(windMph?.[i])} mph${windFromDeg?.[i] != null ? ` from ${compass(windFromDeg[i])}` : ""}, gusts ${mph(gustMph?.[i])} mph`} />
            <YTicks w={w} values={ticks(0, hi, hi > 40 ? 20 : 10)} y={y} unit="" />
            {has(gustMph) && <path d={linePath(gustMph, mid, y)} className="hourly__line hourly__line--gust" />}
            {has(windMph) && <path d={linePath(windMph, mid, y)} className="hourly__line hourly__line--wind" />}
            {windFromDeg?.map((d, i) => d !== null && i % every === 0 && (
              // Arrow points where the wind blows to (NWS direction is where it comes from).
              <path key={i} d="M0,-6 L3.5,3 L0,1 L-3.5,3 Z" transform={`translate(${mid(i).toFixed(1)},${ARROWS / 2 - 1}) rotate(${(d + 180) % 360})`} className="hourly__arrow" />
            ))}
          </>
        );
      }}
    </Chart>
  );
}

function SkyChart({ ctx, label }: { ctx: Ctx; label: string }) {
  const { skyPct, popPct } = ctx.h;
  const y = (v: number) => 4 + PLOT - (v / 100) * PLOT;
  return (
    <Chart label={label} height={4 + PLOT + AXIS}>
      {(w) => {
        const { mid, edge } = frame(w, ctx.h.hours);
        return (
          <>
            <Backdrop ctx={ctx} w={w} top={4} height={PLOT} title={(i) => `${timeTitle(ctx, i)}: sky cover ${pct(skyPct?.[i])}, precipitation chance ${pct(popPct?.[i])}`} />
            {has(skyPct) && <path d={stepArea(skyPct, edge, y)} className="hourly__sky" />}
            <YTicks w={w} values={[0, 50, 100]} y={y} unit="%" />
            {has(popPct) && <path d={linePath(popPct, mid, y)} className="hourly__line hourly__line--pop" />}
          </>
        );
      }}
    </Chart>
  );
}

function PrecipChart({ ctx, label }: { ctx: Ctx; label: string }) {
  const precip = ctx.h.precip!;
  // Freezing rain and sleet get a row only when the grid forecasts them.
  const rows = PRECIP_KINDS.filter((r) => r.kind !== "ice" || precip.ice.some((c) => c && c !== "none"));
  const height = rows.length * (ROW + ROW_GAP);
  return (
    <Chart label={label} height={4 + height + AXIS}>
      {(w) => {
        const { edge } = frame(w, ctx.h.hours);
        return (
          <>
            <Backdrop ctx={ctx} w={w} top={4} height={height} title={(i) => `${timeTitle(ctx, i)}: ${rows.map((r) => `${r.label.toLowerCase()} ${coverageText(precip[r.kind][i])}`).join(", ")}`} />
            {rows.map((r, row) => {
              const top = 4 + row * (ROW + ROW_GAP) + ROW_GAP / 2;
              return (
                <g key={r.kind}>
                  <text x={GUTTER - 8} y={top + ROW - 3} className="chart__label" textAnchor="end">{r.label}</text>
                  {runs(precip[r.kind]).map(({ value: c, from, to }) => c === null ? null : (
                    <g key={from}>
                      <line x1={edge(from)} x2={edge(to)} y1={top + ROW - 0.5} y2={top + ROW - 0.5} className="hourly__base" />
                      {c !== "none" && <rect x={edge(from)} y={top} width={edge(to) - edge(from)} height={ROW} className={`hourly__cov hourly__cov--${r.kind}`} style={{ opacity: COVERAGE_RANK[c] / 4 }} />}
                    </g>
                  ))}
                </g>
              );
            })}
          </>
        );
      }}
    </Chart>
  );
}

const coverageText = (c: PrecipCoverage | null) => (c === null ? "no data" : c === "none" ? "none" : COVERAGE_LABEL[c]);

function timeTitle(ctx: Ctx, i: number) {
  return cachedDateFormat("en-US", { timeZone: ctx.timeZone, weekday: "short", hour: "numeric" }).format(new Date(ctx.times[i]));
}

const hourLabel = (h: number) => (h === 12 ? "noon" : h < 12 ? `${h} AM` : `${h - 12} PM`);

/**
 * The NWS grid's next 48 hours as four stacked charts on one time axis, like the
 * first four panels of the weather.gov hourly graph, with ski hours shaded and a
 * one-line read of the coming ski day.
 */
export function HourlyForecast({ hourly, now, timeZone, name, elevationFt }: { hourly: HourlyWeather; now: Date; timeZone: string; name: string; elevationFt: number | null }) {
  const h = hourlyFromNow(hourly, now);
  if (h.hours < 2) return null;
  const ctx: Ctx = { h, timeZone, times: Array.from({ length: h.hours }, (_, i) => Date.parse(h.start) + i * HOUR) };
  const day = skiDaySummary(h, now, timeZone);
  const skiHours = `${hourLabel(SKI_HOURS.from)}–${hourLabel(SKI_HOURS.to)}`;
  const precipKnown = !!h.precip && PRECIP_KINDS.some((r) => h.precip![r.kind].some((c) => c !== null));
  return (
    <section className="hourly" aria-label={`Hourly forecast, ${name}`}>
      <header className="hourly__header">
        <h3>Next {h.hours} hours</h3>
        {day && (
          <p className="hourly__summary">
            <strong>{day.day}, {skiHours}</strong>
            <span>Temp {span(day.tempMinF, day.tempMaxF, deg)}F</span>
            <span>Wind chill {span(day.windChillMinF, day.windChillMaxF, deg)}F</span>
            <span>Wind to {mph(day.windMaxMph)} mph, gusts {mph(day.gustMaxMph)}</span>
          </p>
        )}
      </header>
      <Panel title="Temperature · °F" empty={!has(h.tempF) && !has(h.windChillF)}
        legend={<Legend items={[{ label: "Temperature", className: "hourly__line hourly__line--temp" }, { label: "Wind chill", className: "hourly__line hourly__line--chill" }]} />}>
        <TempChart ctx={ctx} label={`Hourly temperature and wind chill, ${name}`} />
      </Panel>
      <Panel title="Wind · mph" empty={!has(h.windMph) && !has(h.gustMph)}
        legend={<Legend items={[{ label: "Sustained", className: "hourly__line hourly__line--wind" }, { label: "Gusts", className: "hourly__line hourly__line--gust" }]} />}>
        <WindChart ctx={ctx} label={`Hourly wind speed, gusts and direction, ${name}`} />
      </Panel>
      <Panel title="Sky and precipitation chance · %" empty={!has(h.skyPct) && !has(h.popPct)}
        legend={<Legend items={[{ label: "Sky cover", className: "hourly__sky", area: true }, { label: "Precip chance", className: "hourly__line hourly__line--pop" }]} />}>
        <SkyChart ctx={ctx} label={`Hourly sky cover and chance of precipitation, ${name}`} />
      </Panel>
      <Panel title="Precipitation type" empty={!precipKnown}
        legend={<span className="hourly__legend hourly__legend--steps">Slight chance{[1, 2, 3, 4].map((r) => <i key={r} style={{ opacity: r / 4 }} aria-hidden="true" />)}Definite</span>}>
        <PrecipChart ctx={ctx} label={`Hourly chance of snow, rain and thunder, ${name}`} />
      </Panel>
      <p className="hourly__note">
        Shaded: {skiHours} ski hours. Arrows point where the wind blows.
        {elevationFt ? ` NWS grid cell at ${elevationFt.toLocaleString()} ft; summits run colder.` : " Summits run colder than the NWS grid cell."}
      </p>
    </section>
  );
}
