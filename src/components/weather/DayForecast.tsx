"use client";

import type { ReactNode } from "react";
import {
  COVERAGE_LABEL,
  dayFacts,
  daySeries,
  daySnowIn,
  isSkiHour,
  PRECIP_KINDS,
  type DaySeries,
  type ForecastDay,
} from "@/lib/hourlyWeather";
import { cachedDateFormat, formatLocalRelative } from "@/lib/time";
import type { PointForecast } from "@/lib/types";
import { Chart } from "../charts";
import { areaAnchor } from "./SnowByDay";

const GUTTER = 48; // y-axis or row labels
const RIGHT = 4;
const PLOT = 72;
const AXIS = 20;
const ARROWS = 16;
const ROW = 12;
const ROW_GAP = 4;
const SNOW_PLOT = 48;

type Values = Array<number | null> | undefined;
const has = (v: Values) => !!v?.some((x) => x !== null);
const nums = (...vs: Values[]) => vs.flatMap((v) => (v ?? []).filter((x): x is number => x !== null));
const dash = "—";
const deg = (v: number | null | undefined) => (v == null ? dash : `${v}°`);
const num = (v: number | null | undefined, unit = "") => (v == null ? dash : `${v}${unit}`);
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (d: number | null | undefined) => (d == null ? "" : COMPASS[Math.round(d / 22.5) % 16]);

/** x geometry shared by every chart of a day, so they line up hour for hour. */
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

const ticks = (lo: number, hi: number, step: number) => {
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};

interface Ctx { s: DaySeries; timeZone: string }

function hourText(t: number, timeZone: string) {
  const h = +cachedDateFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit" }).format(new Date(t)) % 24;
  return { h, label: h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p` };
}

/** Ski-hour bands, 3-hour ticks, and a hover title per hour. */
function Backdrop({ ctx, w, top, height, title }: { ctx: Ctx; w: number; top: number; height: number; title: (i: number) => string }) {
  const { edge, step } = frame(w, ctx.s.times.length);
  return (
    <>
      {runs(ctx.s.times.map((t) => isSkiHour(t, ctx.timeZone))).filter((r) => r.value).map((r) => (
        <rect key={r.from} x={edge(r.from)} y={top} width={edge(r.to) - edge(r.from)} height={height} className="wxchart__ski" />
      ))}
      {ctx.s.times.map((t, i) => {
        const { h, label } = hourText(t, ctx.timeZone);
        if (h % 3) return null;
        const x = edge(i);
        return (
          <g key={t}>
            <line x1={x} x2={x} y1={top + height} y2={top + height + 4} className="chart__axis" />
            {x + 22 <= w && <text x={x} y={top + height + 16} className="chart__label" textAnchor={i === 0 ? "start" : "middle"}>{label}</text>}
          </g>
        );
      })}
      {ctx.s.times.map((t, i) => (
        <rect key={`hit${t}`} x={edge(i)} y={top} width={step} height={height} className="wxchart__hit"><title>{title(i)}</title></rect>
      ))}
    </>
  );
}

function YTicks({ w, values, y, format }: { w: number; values: number[]; y: (v: number) => number; format: (v: number) => string }) {
  return (
    <>
      {values.map((v) => (
        <g key={v}>
          <line x1={GUTTER} x2={w - RIGHT} y1={y(v)} y2={y(v)} className="chart__grid" />
          <text x={GUTTER - 6} y={y(v) + 4} className="chart__label" textAnchor="end">{format(v)}</text>
        </g>
      ))}
    </>
  );
}

function Key({ items }: { items: Array<{ label: string; className: string; area?: boolean }> }) {
  return (
    <span className="wxchart__key">
      {items.map((it) => (
        <span key={it.label}>
          <svg width="16" height="10" aria-hidden="true">
            {it.area ? <rect x="0" y="1" width="16" height="8" className={it.className} /> : <line x1="0" x2="16" y1="5" y2="5" className={it.className} />}
          </svg>
          {it.label}
        </span>
      ))}
    </span>
  );
}

function Panel({ title, keyItems, children, empty }: { title: string; keyItems?: ReactNode; children: ReactNode; empty: boolean }) {
  return (
    <figure className="wxchart">
      <figcaption><span className="wxchart__title">{title}</span>{!empty && keyItems}</figcaption>
      {empty ? <p className="wxchart__none"><span className="metric__na" title="Not in this NWS grid update" aria-label="no data">{dash}</span></p> : children}
    </figure>
  );
}

const when = (ctx: Ctx, i: number) =>
  cachedDateFormat("en-US", { timeZone: ctx.timeZone, weekday: "short", hour: "numeric" }).format(new Date(ctx.s.times[i]));

function TempChart({ ctx, label }: { ctx: Ctx; label: string }) {
  const { tempF, windChillF } = ctx.s;
  const all = nums(tempF, windChillF);
  const lo = Math.floor(Math.min(...all) / 10) * 10;
  let hi = Math.ceil(Math.max(...all) / 10) * 10;
  if (hi === lo) hi += 10;
  const y = (v: number) => 6 + PLOT - ((v - lo) / (hi - lo)) * PLOT;
  return (
    <Chart label={label} height={6 + PLOT + AXIS}>
      {(w) => {
        const { mid } = frame(w, ctx.s.times.length);
        return (
          <>
            <Backdrop ctx={ctx} w={w} top={6} height={PLOT} title={(i) => `${when(ctx, i)}: ${deg(tempF?.[i])}F, wind chill ${deg(windChillF?.[i])}F`} />
            <YTicks w={w} values={ticks(lo, hi, hi - lo > 40 ? 20 : 10)} y={y} format={(v) => `${v}°`} />
            {has(windChillF) && <path d={linePath(windChillF, mid, y)} className="wxchart__line wxchart__line--chill" />}
            {has(tempF) && <path d={linePath(tempF, mid, y)} className="wxchart__line wxchart__line--temp" />}
          </>
        );
      }}
    </Chart>
  );
}

function WindChart({ ctx, label }: { ctx: Ctx; label: string }) {
  const { windMph, gustMph, windFromDeg } = ctx.s;
  const top = ARROWS;
  const hi = Math.max(10, Math.ceil(Math.max(...nums(windMph, gustMph)) / 10) * 10);
  const y = (v: number) => top + PLOT - (v / hi) * PLOT;
  return (
    <Chart label={label} height={top + PLOT + AXIS}>
      {(w) => {
        const { mid, step } = frame(w, ctx.s.times.length);
        const every = Math.max(1, Math.ceil(16 / step));
        return (
          <>
            <Backdrop ctx={ctx} w={w} top={top} height={PLOT} title={(i) => `${when(ctx, i)}: wind ${num(windMph?.[i])} mph${windFromDeg?.[i] != null ? ` from ${compass(windFromDeg[i])}` : ""}, gusts ${num(gustMph?.[i])} mph`} />
            <YTicks w={w} values={ticks(0, hi, hi > 40 ? 20 : 10)} y={y} format={String} />
            {has(gustMph) && <path d={linePath(gustMph, mid, y)} className="wxchart__line wxchart__line--gust" />}
            {has(windMph) && <path d={linePath(windMph, mid, y)} className="wxchart__line wxchart__line--wind" />}
            {windFromDeg?.map((d, i) => d !== null && i % every === 0 && (
              // Arrow points where the wind blows to (NWS direction is where it comes from).
              <path key={i} d="M0,-5.5 L3.5,3 L0,1 L-3.5,3 Z" transform={`translate(${mid(i).toFixed(1)},${ARROWS / 2}) rotate(${(d + 180) % 360})`} className="wxchart__arrow" />
            ))}
          </>
        );
      }}
    </Chart>
  );
}

/** Hourly snow bars over strips for sky cover, precipitation chance and any non-snow precipitation. */
function SkyChart({ ctx, label }: { ctx: Ctx; label: string }) {
  const { snowIn, skyPct, popPct, precip } = ctx.s;
  const hasSnow = has(snowIn);
  const top = hasSnow ? 6 + SNOW_PLOT + 8 : 4;
  const maxSnow = Math.max(0.5, Math.ceil(Math.max(0, ...nums(snowIn)) * 2) / 2);
  const ys = (v: number) => 6 + SNOW_PLOT - (v / maxSnow) * SNOW_PLOT;
  const strips: Array<{ key: string; label: string; values: Array<number | null>; className: string; text: (v: number | null) => string }> = [];
  if (has(skyPct)) strips.push({ key: "sky", label: "Sky", values: skyPct!.map((v) => (v === null ? null : v / 100)), className: "wxchart__strip--sky", text: (v) => `sky cover ${v === null ? dash : `${Math.round(v * 100)}%`}` });
  if (has(popPct)) strips.push({ key: "pop", label: "Precip", values: popPct!.map((v) => (v === null ? null : v / 100)), className: "wxchart__strip--pop", text: (v) => `precipitation chance ${v === null ? dash : `${Math.round(v * 100)}%`}` });
  // Snow shows as bars; other precipitation types get a strip only on days they're forecast.
  for (const { kind, label: name } of PRECIP_KINDS) {
    if (kind === "snow" || !precip?.[kind].some((c) => c)) continue;
    strips.push({ key: kind, label: name, values: precip[kind].map((c) => (c === null ? null : c / 4)), className: `wxchart__strip--${kind}`, text: (v) => `${name.toLowerCase()} ${v === null ? "no data" : COVERAGE_LABEL[Math.round(v * 4) as 0]}` });
  }
  const height = top + strips.length * (ROW + ROW_GAP) - (hasSnow ? 6 : 4);
  return (
    <Chart label={label} height={6 + height + AXIS}>
      {(w) => {
        const { edge, step } = frame(w, ctx.s.times.length);
        return (
          <>
            <Backdrop ctx={ctx} w={w} top={6} height={height} title={(i) => [`${when(ctx, i)}: snow ${snowIn[i] === null ? dash : `${snowIn[i]!.toFixed(2)}″`}`, ...strips.map((s) => s.text(s.values[i]))].join(", ")} />
            {hasSnow && (
              <>
                <YTicks w={w} values={[0, maxSnow]} y={ys} format={(v) => `${v}″`} />
                {snowIn.map((v, i) => v !== null && v >= 0.005 && (
                  <rect key={i} x={edge(i) + Math.min(1, step * 0.1)} y={ys(v)} width={Math.max(1, step - Math.min(2, step * 0.2))} height={ys(0) - ys(v)} className="wxchart__snow" />
                ))}
              </>
            )}
            {strips.map((s, row) => {
              const y = 6 + top + row * (ROW + ROW_GAP) - (hasSnow ? 6 : 4) + ROW_GAP / 2;
              return (
                <g key={s.key}>
                  <text x={GUTTER - 6} y={y + ROW - 2} className="chart__label" textAnchor="end">{s.label}</text>
                  {runs(s.values).map(({ value, from, to }) => value === null ? null : (
                    <g key={from}>
                      <rect x={edge(from)} y={y} width={edge(to) - edge(from)} height={ROW} className="wxchart__strip-bg" />
                      {value > 0 && <rect x={edge(from)} y={y} width={edge(to) - edge(from)} height={ROW} className={`wxchart__strip ${s.className}`} style={{ opacity: value }} />}
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

const range = (a: number | null, b: number | null, f: (v: number) => string) =>
  a === null || b === null ? dash : a === b ? f(a) : `${f(a)}–${f(b)}`;

/** One area on the selected day: the day's numbers, then its hours. */
export function DayForecast({ p, day, now }: { p: PointForecast; day: ForecastDay; now: Date }) {
  const timeZone = p.timeZone ?? "America/Denver";
  const s = daySeries(p.hourly, p.hourlySnow, day, now);
  const f = dayFacts(s, daySnowIn(p.hourlySnow, day, now), timeZone);
  const ctx: Ctx = { s, timeZone };
  const periods = p.periods.filter((x) => {
    const t = Date.parse(x.start);
    return t >= day.start && t < day.end;
  });
  const window = f.skiHoursAhead ? "9 AM–4 PM" : "rest of today";
  return (
    <article className="weather-point wxarea" id={areaAnchor(p)}>
      <header className="wxarea__head">
        <h2>{p.name}</h2>
        <p className="wxarea__meta">
          {p.elevationFt ? `NWS grid at ${p.elevationFt.toLocaleString()} ft · ` : ""}updated {formatLocalRelative(p.gridUpdatedAt, now, timeZone)}
        </p>
      </header>
      {p.lastError && <p className="source-line__error">Forecast updates failing; showing last successful data. {p.lastError}</p>}
      <dl className="wxfacts" aria-label={`${p.name}, ${day.long}`}>
        <div className="wxfacts__snow"><dt>Snow</dt><dd>{f.snowIn === null ? <span className="metric__na" aria-label="no data">{dash}</span> : <span className={f.snowIn < 0.05 ? "wxfacts__zero" : undefined}>{f.snowIn.toFixed(1)}″</span>}</dd></div>
        <div><dt>Temp <small>{window}</small></dt><dd>{range(f.tempMinF, f.tempMaxF, (v) => `${v}°`)}</dd></div>
        <div><dt>Wind chill</dt><dd>{range(f.windChillMinF, f.windChillMaxF, (v) => `${v}°`)}</dd></div>
        <div><dt>Wind <small>mph</small></dt><dd>{num(f.windMaxMph)}<span className="wxfacts__gust"> gusts {num(f.gustMaxMph)}</span></dd></div>
        <div><dt>Snow level <small>ft</small></dt><dd>{range(f.snowLevelMinFt, f.snowLevelMaxFt, (v) => `${(v / 1000).toFixed(1)}k`)}</dd></div>
      </dl>
      {s.times.length < 2 ? (
        <p className="muted">No hours left in this day.</p>
      ) : !p.hourly ? (
        <p className="muted">Hourly forecast arrives with the next NWS collection.</p>
      ) : (
        <div className="wxarea__charts">
          <Panel title="Temperature · °F" empty={!has(s.tempF) && !has(s.windChillF)}
            keyItems={<Key items={[{ label: "Temp", className: "wxchart__line wxchart__line--temp" }, { label: "Wind chill", className: "wxchart__line wxchart__line--chill" }]} />}>
            <TempChart ctx={ctx} label={`Hourly temperature and wind chill, ${p.name}, ${day.long}`} />
          </Panel>
          <Panel title="Wind · mph" empty={!has(s.windMph) && !has(s.gustMph)}
            keyItems={<Key items={[{ label: "Sustained", className: "wxchart__line wxchart__line--wind" }, { label: "Gusts", className: "wxchart__line wxchart__line--gust" }]} />}>
            <WindChart ctx={ctx} label={`Hourly wind, gusts and direction, ${p.name}, ${day.long}`} />
          </Panel>
          <Panel title="Snow and sky" empty={!has(s.snowIn) && !has(s.skyPct) && !has(s.popPct)}
            keyItems={<span className="wxchart__key"><span>Snow, in/hr · darker = cloudier, likelier</span></span>}>
            <SkyChart ctx={ctx} label={`Hourly snowfall, sky cover and chance of precipitation, ${p.name}, ${day.long}`} />
          </Panel>
        </div>
      )}
      {periods.length > 0 && (
        <dl className="periods">
          {periods.map((per) => (
            <div key={per.start}>
              <dt>{per.name}</dt>
              <dd>{per.detailedForecast}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
