import Link from "next/link";
import type { RegionId } from "@/lib/catalog";
import { regionById } from "@/lib/catalog";
import { formatLocal } from "@/lib/time";
import type { ApiDailySnow } from "@/lib/types";
import { modelName } from "./labels";
import "./resort-teaser.css";

/**
 * The resort's regional Daily Snow on its resort page: the latest edition's title and
 * summary, dated, with a link to the full post. The summary covers the whole region,
 * not just this resort. Renders nothing when the region has no available edition.
 */
export function ResortDailySnowTeaser({ post, region, now }: { post: ApiDailySnow | null | undefined; region: RegionId; now: Date }) {
  if (!post) return null;
  const name = regionById(region)?.name ?? region;
  return (
    <section className="resort-dailysnow" aria-labelledby="resort-dailysnow-heading">
      <div className="resort-section-heading">
        <h2 id="resort-dailysnow-heading">
          Daily Snow<span className="badge badge--ai">AI</span>
        </h2>
        <Link href={`/daily-snow/${region}`}>Read the {name} Daily Snow →</Link>
      </div>
      <div className="resort-dailysnow__card">
        <p className="resort-dailysnow__meta">
          {name} · Posted {formatLocal(post.generatedAt, now, post.timeZone)}
        </p>
        <h3 className="resort-dailysnow__title">{post.title}</h3>
        <p className="resort-dailysnow__summary">{post.summary}</p>
        <p className="resort-dailysnow__footer">AI-generated regional forecast · {modelName(post.model)}</p>
      </div>
    </section>
  );
}
