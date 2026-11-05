import { CAM_PAGES,resortById,resortTimeZone } from "@/lib/catalog";
import type { ApiSource, ResortCam, ResortCamsPayload } from "@/lib/types";
import { formatAge, formatLocal } from "@/lib/time";

const CAM_STALE_MS = 3 * 3_600_000;

/** Same image URL each poll would be served from browser cache; bust it once a minute. */
function withBust(url: string, bust: number) {
  const u = new URL(url);
  u.searchParams.set("_", String(bust));
  return u.toString();
}

function Cam({ cam, now, bust }: { cam: ResortCam; now: Date; bust: number }) {
  if (cam.kind === "youtube") {
    return (
      <figure className="rcam">
        <div className="rcam__frame">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${cam.videoId}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0`}
            title={`${cam.title} live camera`}
            allow="autoplay; encrypted-media"
            loading="lazy"
          />
        </div>
        <figcaption>
          <strong>{cam.title}</strong>{" "}
          <span className="rcam__time">
            · live stream (player shows live/offline status)
          </span>
        </figcaption>
      </figure>
    );
  }
  if(cam.kind==="embed")return <figure className="rcam"><div className="rcam__frame"><iframe src={cam.embedUrl} title={cam.title} loading="lazy" allow="autoplay; encrypted-media"/></div><figcaption>{cam.title} · live player</figcaption></figure>;
  const age = cam.capturedAt
    ? now.getTime() - new Date(cam.capturedAt).getTime()
    : null;
  return (
    <figure className="rcam">
      <div className="rcam__frame">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBust(cam.imageUrl, bust)} alt={`${cam.title} webcam`} />
      </div>
      <figcaption>
        <strong>{cam.title}</strong>{" "}
        {cam.capturedAt === null ? (
          <span className="rcam__time">· capture time not published</span>
        ) : age !== null && age > CAM_STALE_MS ? (
          <span className="rcam__time rcam__time--stale">
            · not updating — last image {formatLocal(cam.capturedAt, now,resortTimeZone(cam.resort))}
          </span>
        ) : (
          <span className="rcam__time">
            · image {formatAge(cam.capturedAt, now)}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

export function ResortCams({
  resortId,
  cams,
  now,
  loadedAt,
}: {
  resortId: string;
  cams: ApiSource | undefined;
  now: Date;
  loadedAt: number | null;
}) {
  const p = cams?.payload as ResortCamsPayload | null | undefined;
  const mine = p?.cameras.filter((c) => c.resort === resortId) ?? [];
  const bust = Math.floor((loadedAt ?? now.getTime()) / 60_000) * 60_000;
  return (
    <div className="resort-cams">
      <h2>Webcams</h2>
      {CAM_PAGES[resortId as keyof typeof CAM_PAGES]&&<p><a href={CAM_PAGES[resortId as keyof typeof CAM_PAGES]} target="_blank" rel="noreferrer">All {resortById(resortId)?.name} webcams ↗</a></p>}
      {mine.length ? (
        mine.map((c) => (
          <Cam key={c.kind === "youtube" ? c.videoId : c.kind==="image"?c.imageUrl:c.embedUrl} cam={c} now={now} bust={bust} />
        ))
      ) : (
        <p className="muted">
          No {resortId === "alta" ? "Alta" : "resort"} webcam available right
          now
          {p?.failures.some((f) => f.startsWith(resortId))
            ? " (camera page check failed)"
            : ""}
          .
        </p>
      )}
    </div>
  );
}
