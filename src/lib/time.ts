export const TZ = "America/Denver";

const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Wall-clock parts of an instant in America/Denver. */
export function denverParts(date: Date) {
  const parts = Object.fromEntries(
    offsetFormatter.formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Convert an America/Denver wall-clock time to a UTC instant.
 * Uses two offset passes so DST transitions resolve correctly.
 */
export function denverToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = denverParts(new Date(guess));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += asUtc - shown;
  }
  return new Date(guess);
}

/** Parse "YYYY-MM-DD HH:MM[:SS]" as America/Denver local time. */
export function parseDenverDateTime(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  return denverToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0).toISOString();
}

/** Parse an ISO string with explicit offset (e.g. 2026-10-30T18:53:53-0600). */
export function parseOffsetIso(text: string | null | undefined): string | null {
  if (!text || text === "--") return null;
  const normalized = text.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function epochSecondsToIso(sec: number | null | undefined): string | null {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return null;
  return new Date(sec * 1000).toISOString();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12,
};

export function monthFromName(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\.$/, "")] ?? null;
}

/**
 * Resolve a year-less Denver date ("Oct 21, 10:20 AM") to the most recent
 * occurrence not more than one day in the future relative to `now`.
 */
export function inferYearDenver(
  month: number,
  day: number,
  hour: number,
  minute: number,
  now: Date,
): string {
  const { year } = denverParts(now);
  for (const y of [year, year - 1]) {
    const candidate = denverToUtc(y, month, day, hour, minute);
    if (candidate.getTime() <= now.getTime() + 24 * 3600_000) return candidate.toISOString();
  }
  return denverToUtc(year - 1, month, day, hour, minute).toISOString();
}

/** Convert "4:24 PM" style to 24h. */
export function to24h(hour: number, ampm: string | undefined): number {
  if (!ampm) return hour;
  const pm = ampm.toUpperCase().startsWith("P");
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

// ---------- Display formatting (client & server) ----------

const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "Today 5:00 PM", "Yesterday 7:00 AM", or "Mon, Oct 26, 9:00 AM" — always Denver time. */
export function formatDenver(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const key = dayKeyFmt.format(d);
  if (key === dayKeyFmt.format(now)) return `Today ${timeFmt.format(d)}`;
  if (key === dayKeyFmt.format(new Date(now.getTime() - 86_400_000))) return `Yesterday ${timeFmt.format(d)}`;
  if (key === dayKeyFmt.format(new Date(now.getTime() + 86_400_000))) return `Tomorrow ${timeFmt.format(d)}`;
  return dateTimeFmt.format(d);
}

export function formatAge(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** America/Denver midnights strictly after `start` and up to `end` (DST-aware). */
export function denverMidnightsBetween(start: Date, end: Date): Date[] {
  const p = denverParts(start);
  const out: Date[] = [];
  // Date.UTC normalizes day overflow, so day + i walks across month ends.
  for (let i = 0; i < 400; i++) {
    const m = denverToUtc(p.year, p.month, p.day + i);
    if (m > end) break;
    if (m > start) out.push(m);
  }
  return out;
}

// Destination-local calendar helpers. Denver wrappers remain for Utah source timestamps.

const formatters = new Map<string, Intl.DateTimeFormat>();
/** A shared formatter per locale and options: construction is costly and only a few zones exist. */
export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(locale, options)));
  return f;
}

export function zonedParts(date: Date, timeZone: string = TZ) {
  const parts = Object.fromEntries(dateFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date).map(p => [p.type,p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}
export function zonedToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, timeZone: string = TZ): Date {
  const wall = Date.UTC(year, month-1, day, hour, minute, second);
  let guess = wall;
  for (let i=0;i<3;i++) { const p=zonedParts(new Date(guess),timeZone); guess += wall-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second); }
  return new Date(guess);
}
export function localDate(date: Date, timeZone: string = TZ): string {
  const p=zonedParts(date,timeZone); return `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;
}
export function formatLocal(iso: string | null | undefined, now = new Date(), timeZone: string = TZ): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "unknown";
  const d=new Date(iso);
  return dateFormat("en-US", { timeZone, weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZoneName:"short" }).format(d);
}
/** "Today 5:00 PM", "Yesterday 7:00 AM" or "Mon, Oct 26, 9:00 AM" in a destination's time zone. */
export function formatLocalRelative(iso: string | null | undefined, now = new Date(), timeZone: string = TZ): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "unknown";
  const d = new Date(iso);
  const day = (t: Date) => localDate(t, timeZone);
  const time = dateFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
  if (day(d) === day(now)) return `Today ${time}`;
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return `Yesterday ${time}`;
  if (day(d) === day(new Date(now.getTime() + 86_400_000))) return `Tomorrow ${time}`;
  return dateFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}
export function parseLocalDateTime(text: string | null | undefined, timeZone: string = TZ): string | null {
  const m=text?.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m ? zonedToUtc(+m[1],+m[2],+m[3],+m[4],+m[5],+(m[6]??0),timeZone).toISOString() : null;
}

export function localMidnightsBetween(start:Date,end:Date,timeZone:string=TZ):Date[]{
 const p=zonedParts(start,timeZone),out:Date[]=[];
 for(let i=0;i<400;i++){const d=zonedToUtc(p.year,p.month,p.day+i,0,0,0,timeZone);if(d>end)break;if(d>start)out.push(d);}
 return out;
}
