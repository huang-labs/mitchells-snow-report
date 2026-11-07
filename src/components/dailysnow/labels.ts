/** Shared Daily Snow display labels and dates, used by the page and the history rail. */

import type { DailySnowPhase } from "@/lib/types";

export const PHASE_LABEL: Record<DailySnowPhase, string> = { "pre-storm": "Storm ahead", storm: "Storm", "post-storm": "Storm ending", quiet: "Quiet" };

const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/** "Sun Nov 1" for a YYYY-MM-DD date (no time zone shift). */
export const postDate = (date: string) => dateFmt.format(new Date(`${date}T12:00:00Z`));

/** Display names by Workers AI model id suffix. */
const MODEL_NAME: Record<string, string> = { "glm-5.3-flash": "GLM 5.3 Flash", "gpt-oss-120b": "gpt-oss-120b" };
/** "GLM 5.3 Flash" for "@cf/zai-org/glm-5.3-flash"; unknown ids are shown as given. */
export const modelName = (id: string) => MODEL_NAME[id.split("/").pop() ?? ""] ?? id;
