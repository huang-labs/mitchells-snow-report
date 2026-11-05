import type { PointForecast } from "./types";
export const GRID_MAX_AGE_MS = 12 * 3600000;
export const FORECAST_FETCH_MAX_AGE_MS = 47 * 60000;
const ageValid = (iso: string | null | undefined, now: Date, max: number) => {
  if (!iso) return false;
  const age = now.getTime() - Date.parse(iso);
  return Number.isFinite(age) && age >= -120000 && age < max;
};
/** A healthy neighboring point cannot make failed, old or future guidance usable. */
export function forecastPointFresh(point: PointForecast, now: Date) {
  return (
    !point.lastError &&
    ageValid(point.gridUpdatedAt, now, GRID_MAX_AGE_MS) &&
    (!point.lastCheckedAt || ageValid(point.lastCheckedAt, now, FORECAST_FETCH_MAX_AGE_MS))
  );
}
