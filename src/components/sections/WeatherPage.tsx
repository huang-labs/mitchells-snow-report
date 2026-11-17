"use client";

import { useState, type ReactNode } from "react";
import { regionById, type RegionId } from "@/lib/catalog";
import { defaultDayIndex, forecastDays } from "@/lib/hourlyWeather";
import type { ApiSource, NwsPayload } from "@/lib/types";
import { SourceLine, Unavailable } from "../ui";
import { DayForecast } from "../weather/DayForecast";
import { SnowByDay } from "../weather/SnowByDay";
import "../weather/weather.css";

/**
 * Organized by day: snow per area and day on top, then every area's chosen day
 * hour by hour. One selected day drives the whole page.
 */
export function WeatherPage({ source, now, region = "utah", selector }: { source: ApiSource; now: Date; region?: RegionId; selector?: ReactNode }) {
  const payload = source.payload as NwsPayload | null;
  const timeZone = regionById(region)!.timeZone;
  const days = forecastDays(now, timeZone, 7);
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked ?? defaultDayIndex(now, timeZone);
  const day = days[selected];
  const points = payload?.points ?? [];
  return (
    <section className="page page--weather">
      {selector}
      <header className="page__header">
        <h1>{regionById(region)!.name} mountain weather</h1>
        <p className="page__sub">National Weather Service mountain forecasts for each area: snow by day, then any day hour by hour.</p>
      </header>
      {payload?.failures?.filter((f) => !points.some((p) => p.lastError === f)).map((f) => <p key={f} className="source-line__error">Forecast unavailable · {f}</p>)}
      {points.length ? (
        <>
          <SnowByDay points={points} days={days} selected={selected} onSelect={setPicked} now={now} />
          <div className="wxday-bar">
            <button type="button" className="wxday-bar__step" aria-label="Previous day" disabled={selected === 0} onClick={() => setPicked(selected - 1)}>‹</button>
            <h2 className="wxday-bar__title" aria-live="polite">{day.long}</h2>
            <button type="button" className="wxday-bar__step" aria-label="Next day" disabled={selected === days.length - 1} onClick={() => setPicked(selected + 1)}>›</button>
          </div>
          <div className="weather-grid">
            {points.map((p) => <DayForecast key={p.name} p={p} day={day} now={now} />)}
          </div>
          <p className="wxnote">
            Temperature and wind in each area’s summary cover 9 AM–4 PM, shaded on the charts. Arrows point where the wind blows.
            Each area is one NWS grid cell at the elevation shown; summits run colder and windier.
          </p>
        </>
      ) : (
        <Unavailable source={source} what="Mountain forecast" />
      )}
      <SourceLine source={source} now={now} reportLabel="Forecast grid updated" timeZone={timeZone} />
    </section>
  );
}
