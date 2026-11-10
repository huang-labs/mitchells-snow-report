
import type { ApiDailySnow, DailySnowPhase } from "@/lib/types";
import { PHASE_LABEL, postDate } from "./labels";

/** How many posts the rail shows: the live post plus the archive before it. */
const HISTORY_COUNT = 4;

type Entry = { date: string; title: string; phase?: DailySnowPhase; live: boolean };
/** Picks a post by date; null = the live post. */
type Pick = (date: string | null) => void;

/** The live post first, then the archived posts before it, newest first. */
function entriesFor(live: ApiDailySnow): Entry[] {
  return [
    { date: live.date, title: live.title, phase: live.phase, live: true },
    ...live.archive.filter((a) => a.date !== live.date).slice(0, HISTORY_COUNT - 1).map((a) => ({ ...a, live: false })),
  ];
}

/** One clickable past post. `active` marks the post on screen: it gets the
    accent bar and the panel fill; "Latest" names the live entry regardless of its date. */
function HistoryEntry({ entry, active, onPick, onIntent }: { entry: Entry; active: boolean; onPick: Pick; onIntent?: Pick }) {
  const date = entry.live ? null : entry.date;
  return (
    <button
      type="button"
      className="dailysnow__history-entry"
      data-active={active || undefined}
      onClick={() => onPick(date)}
      onPointerEnter={() => onIntent?.(date)}
      onFocus={() => onIntent?.(date)}
    >
      <span className="dailysnow__history-entry-top">
        <span className="dailysnow__history-entry-date">{entry.live ? `Latest · ${postDate(entry.date)}` : postDate(entry.date)}</span>
        {entry.phase && <span className="dailysnow__history-entry-phase">{PHASE_LABEL[entry.phase]}</span>}
      </span>
      <span className="dailysnow__history-entry-title">{entry.title}</span>
    </button>
  );
}

/**
 * Recent posts in a left rail beside the article on wide screens. Phones render
 * nothing here: they navigate with the archive links below the post. Hidden
 * while the live post is the only one there is.
 */
export function HistoryRail({ live, viewed, onPick, onIntent }: { live: ApiDailySnow | null; viewed: string | null; onPick: Pick; onIntent?: Pick }) {
  if (!live) return null;
  const entries = entriesFor(live);
  if (entries.length < 2) return null;
  return (
    <aside className="dailysnow__history" aria-label="Recent Daily Snow posts">
      <p className="dailysnow__history-heading">Recent posts</p>
      <div className="dailysnow__history-list">
        {entries.map((e) => (
          <HistoryEntry key={e.date} entry={e} active={viewed ? e.date === viewed : e.live} onPick={onPick} onIntent={onIntent} />
        ))}
      </div>
    </aside>
  );
}
