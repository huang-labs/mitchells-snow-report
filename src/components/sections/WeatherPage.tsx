import type { ReactNode } from "react";
import { regionById, type RegionId } from "@/lib/catalog";
import type { ApiSource, NwsPayload, PointForecast } from "@/lib/types";
import { formatLocal } from "@/lib/time";
import { SNOWFALL_UNITS, SnowfallChart } from "../snowfall/SnowfallChart";
import { SourceLine, Unavailable } from "../ui";

const fmt = (v: number | null, suffix = "") => (v === null ? "—" : `${v}${suffix}`);
const range = (a: number | null, b: number | null, suffix = "") =>
  a === null || b === null ? "—" : a === b ? `${a}${suffix}` : `${a}–${b}${suffix}`;
const ft = (v: number | null) => (v === null ? null : Math.round(v / 100) / 10);

function Point({ p, now }: { p: PointForecast; now: Date }) {
  return (
    <div className="weather-point">
      <header>
        <h2>{p.name}</h2>
        <p className="weather-point__grid">NWS grid {p.gridId} {p.gridX},{p.gridY}{p.elevationFt ? ` · grid elev ${p.elevationFt.toLocaleString()} ft` : ""}</p>
      </header>
      <p className="muted">Grid updated {formatLocal(p.gridUpdatedAt,now,p.timeZone)}</p>
      {p.lastError && <p className="source-line__error">Forecast updates failing; showing last successful data. {p.lastError}</p>}
      <div className="next-storm">
        {p.nextStorm ? (
          <>
            <span className="eyebrow">Next storm (≥1″ in NWS grid)</span>
            <span className="next-storm__value">{p.nextStorm.totalSnowIn.toFixed(1)}″</span>
            <span>
              {formatLocal(p.nextStorm.start,now,p.timeZone)} → {formatLocal(p.nextStorm.end,now,p.timeZone)}
              {p.nextStorm.minSnowLevelFt !== null && <> · snow level down to {p.nextStorm.minSnowLevelFt.toLocaleString()} ft</>}
            </span>
          </>
        ) : (
          <span className="muted">{p.sixHourSnow.length ? "No ≥1″ snow episode in the available NWS grid." : "Snowfall forecast unavailable."}</span>
        )}
      </div>
      <div className="table-scroll">
        <table className="wx-table">
          <thead>
            <tr>
              <th></th>
              {p.blocks.map((b) => (
                <th key={b.start} scope="col">{b.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="wx-table__snow">
              <th scope="row">Snow</th>
              {p.blocks.map((b) => <td key={b.start}>{b.snowIn === null ? "—" : `${b.snowIn.toFixed(1)}″`}</td>)}
            </tr>
            <tr>
              <th scope="row">Snow level (k ft)</th>
              {p.blocks.map((b) => <td key={b.start}>{range(ft(b.snowLevelMinFt), ft(b.snowLevelMaxFt))}</td>)}
            </tr>
            <tr>
              <th scope="row">Temp °F</th>
              {p.blocks.map((b) => <td key={b.start}>{range(b.tempMinF, b.tempMaxF)}</td>)}
            </tr>
            <tr>
              <th scope="row">Wind / gust mph</th>
              {p.blocks.map((b) => <td key={b.start}>{fmt(b.windMaxMph)} / {fmt(b.gustMaxMph)}</td>)}
            </tr>
            <tr>
              <th scope="row">PoP max</th>
              {p.blocks.map((b) => <td key={b.start}>{fmt(b.popMax, "%")}</td>)}
            </tr>
            <tr>
              <th scope="row">Liquid</th>
              {p.blocks.map((b) => <td key={b.start}>{b.qpfIn === null ? "—" : `${b.qpfIn.toFixed(2)}″`}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
      {p.sixHourSnow.length > 0 && (
        <figure className="weather-point__chart">
          <figcaption>
            <span>Snowfall forecast, next 7 days</span>
            <span>{SNOWFALL_UNITS}</span>
          </figcaption>
          <SnowfallChart bars={p.sixHourSnow} label={`NWS snowfall, ${p.name}`} units={false} timeZone={p.timeZone} />
        </figure>
      )}
      <dl className="periods">
        {p.periods.slice(0, 2).map((per) => (
          <div key={per.start}>
            <dt>{per.name}</dt>
            <dd>{per.detailedForecast}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function WeatherPage({ source, now,region="utah",selector }: { source: ApiSource; now: Date;region?:RegionId;selector?:ReactNode }) {
  const payload = source.payload as NwsPayload | null;
  return (
    <section className="page page--weather">
      {selector}
      <header className="page__header">
        <h1>{regionById(region)!.name} mountain weather</h1>
        <p className="page__sub">NWS mountain gridpoint forecasts. Day = 6 AM–6 PM, night = 6 PM–6 AM destination local time; maxima/minima within each block.</p>
      </header>
      {payload?.failures?.filter(f=>!payload.points.some(p=>p.lastError===f)).map(f=><p key={f} className="source-line__error">Forecast unavailable · {f}</p>)}
      {payload?.points.length ? (
        <div className="weather-grid">
          {payload.points.map((p) => (
            <Point key={p.name} p={p} now={now} />
          ))}
        </div>
      ) : (
        <Unavailable source={source} what="Mountain forecast" />
      )}
      <SourceLine source={source} now={now} reportLabel="Forecast grid updated" timeZone={regionById(region)!.timeZone} />
    </section>
  );
}
