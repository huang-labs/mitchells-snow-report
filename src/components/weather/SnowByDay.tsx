"use client";

import type { CSSProperties } from "react";
import { daySnowIn, type ForecastDay } from "@/lib/hourlyWeather";
import type { PointForecast } from "@/lib/types";

export const areaAnchor = (p: PointForecast) => `wx-${(p.id ?? p.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/**
 * Forecast snow per area and local day, on one shared scale so areas compare
 * honestly. Day headers choose the day every area below shows hour by hour.
 */
export function SnowByDay({ points, days, selected, onSelect, now }: {
  points: PointForecast[];
  days: ForecastDay[];
  selected: number;
  onSelect: (i: number) => void;
  now: Date;
}) {
  const rows = points.map(p => ({ p, snow: days.map(d => daySnowIn(p.hourlySnow, d, now)) }));
  const max = Math.max(2, ...rows.flatMap(r => r.snow.filter((v): v is number => v !== null)));
  return (
    <section className="wxdays" aria-labelledby="wxdays-title">
      <div className="wxdays__head">
        <h2 id="wxdays-title">Snow by day</h2>
        <p>NWS forecast, inches. Pick a day for the hour-by-hour.</p>
      </div>
      <table className="wxdays__table" style={{ "--days": days.length } as CSSProperties}>
        <thead>
          <tr>
            <th scope="col" className="wxdays__corner"><span className="wx-sr">Area</span></th>
            {days.map((d, i) => (
              <th key={d.key} scope="col" className={i === selected ? "wxdays__col--on" : undefined}>
                <button type="button" className="wxdays__pick" aria-pressed={i === selected} onClick={() => onSelect(i)}>
                  <span className="wxdays__weekday">{d.weekday}</span>
                  <span className="wxdays__date">{d.date}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, snow }) => (
            <tr key={p.name}>
              <th scope="row"><a href={`#${areaAnchor(p)}`}>{p.name}</a></th>
              {snow.map((v, i) => (
                <td key={days[i].key} className={i === selected ? "wxdays__col--on" : undefined} style={v === null ? undefined : ({ "--r": v / max } as CSSProperties)} onClick={() => onSelect(i)}>
                  {v === null ? (
                    <span className="wxdays__amount metric__na" title={days[i].today ? "Not in this NWS grid update" : "Beyond the NWS grid for this day"} aria-label="no data">—</span>
                  ) : (
                    <>
                      <span className={v < 0.05 ? "wxdays__amount wxdays__amount--zero" : "wxdays__amount"}>{v.toFixed(v >= 10 ? 0 : 1)}″</span>
                      {v >= 0.05 && <span className="wxdays__bar" aria-hidden="true" />}
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {days[0] && <p className="wxdays__note">Today counts from now.</p>}
    </section>
  );
}
