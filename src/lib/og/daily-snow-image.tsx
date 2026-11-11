import { channelById, type ChannelId } from "../catalog";
import { clipText } from "../clip";
import { DAILY_SNOW_DESCRIPTION } from "../metadata";
import type { DailySnowPost } from "../types";
import { SHARE_COLORS as C, SHARE_FRAME, ShareBrand, ShareFooter } from "./style";

type PreviewPost = Pick<DailySnowPost, "date" | "title" | "summary" | "model" | "channel">;
const MODEL_NAME: Record<string, string> = { "deepseek-v4.1-flash-1017": "DeepSeek V4.1 Flash", "glm-5.3-flash": "GLM 5.3 Flash", "gpt-oss-120b": "gpt-oss-120b" };

/** Bounded copy keeps unusually long generated posts inside the image. */
export function DailySnowShareCard({ post,channel="western-us" }: { post: PreviewPost | null;channel?:ChannelId }) {
  const channelName = channelById(post?.channel ?? channel)!.name;
  const date = post ? new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "long", day: "numeric", year: "numeric",
  }).format(new Date(`${post.date}T12:00:00Z`)) : "A fresh forecast every morning";
  const model = post ? (MODEL_NAME[post.model.split("/").pop() ?? ""] ?? clipText(post.model, 42)) : null;
  return (
    <div style={{ ...SHARE_FRAME }}>
      <ShareBrand />
      <div style={{ display: "flex", flexShrink: 0, alignItems: "center", justifyContent: "space-between", marginTop: 28, fontSize: 22, color: C.muted }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, color: C.accent, fontWeight: 700 }}>
          <span>DAILY SNOW · {channelName}</span>
          {post && <span style={{ background: C.panel, borderRadius: 4, padding: "4px 8px", fontSize: 18 }}>AI</span>}
        </div>
        <span>{date}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
        <div style={{ fontSize: 54, lineHeight: 1.12, letterSpacing: -1.5, fontWeight: 700 }}>{clipText(post?.title ?? `Your ${channelName} snow forecast`, 100)}</div>
        <div style={{ marginTop: 20, fontSize: 27, lineHeight: 1.35, color: C.muted }}>{clipText(post?.summary ?? DAILY_SNOW_DESCRIPTION, 180)}</div>
      </div>
      <ShareFooter>{model ? `AI-generated forecast · ${model}` : channelName}</ShareFooter>
    </div>
  );
}
