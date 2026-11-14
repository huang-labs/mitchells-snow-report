/**
 * The page already shows the AI badge and the Daily Snow name beside every title,
 * so a model-written label prefix ("AI: …", "AI Daily Snow: …") only repeats them.
 * DeepSeek wrote these on the 2026-11-12 and 2026-11-13 Western editions. Stripping
 * in code keeps a cosmetic slip from costing a fallback request.
 */
const LABEL_PREFIX = /^\s*(?:(?:AI(?:-generated)?|Daily Snow|United States West)\s*)+[:|\-–—]\s*/i;

export function stripTitleLabel(title: unknown): unknown {
  if (typeof title !== "string") return title;
  const stripped = title.replace(LABEL_PREFIX, "");
  return stripped.trim() ? stripped : title;
}
