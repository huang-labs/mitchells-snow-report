"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { SECTIONS, sectionHref } from "@/lib/sections";
import { regionById, type ChannelId } from "@/lib/catalog";

// useLayoutEffect warns during server rendering; measuring only happens in the browser.
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface Bar { left: number; width: number }

/** The current page link, or the parent section's link on one of its child pages. */
function activeTab(tabs: HTMLElement | null): HTMLElement | null {
  return tabs?.querySelector<HTMLElement>(":scope > a[aria-current='page'], :scope > a[data-current]") ?? null;
}

/** Section links share scrolling hints, active-tab placement and underline motion. */
function NavRow({ label, pathname, children }: { label: string; pathname: string | null; children: ReactNode }) {
  const tabs = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const [animate, setAnimate] = useState(false);
  const [fade, setFade] = useState({ start: false, end: false });

  const updateFade = useCallback(() => {
    const el = tabs.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);

  const measure = useCallback(() => {
    const active = activeTab(tabs.current);
    setBar(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    updateFade();
  }, [updateFade]);

  // Place the bar under the current tab and scroll that tab into view.
  useBrowserLayoutEffect(() => {
    measure();
    const el = tabs.current;
    const active = activeTab(el);
    if (!el || !active) return;
    const { offsetLeft: left, offsetWidth: width } = active;
    if (left < el.scrollLeft || left + width > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = left - (el.clientWidth - width) / 2;
    }
  }, [pathname, measure]);

  // Turn on the slide only after the first placement, so the bar doesn't fly in on load.
  useEffect(() => {
    if (!bar || animate) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [bar, animate]);

  // Re-measure when tab widths change (web fonts loading, viewport resizes).
  useEffect(() => {
    const el = tabs.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <nav aria-label={label} className="section-nav__inner"
      data-fade-start={fade.start ? "" : undefined} data-fade-end={fade.end ? "" : undefined}>
      <span className="section-nav__divider" aria-hidden="true" />
      <div ref={tabs} className="section-nav__tabs" data-bar={bar ? "" : undefined} data-animate={animate ? "" : undefined}
        onScroll={updateFade}>
        {children}
        <span className="section-nav__bar" aria-hidden="true"
          style={bar ? { transform: `translateX(${bar.left}px)`, width: bar.width } : undefined} />
      </div>
    </nav>
  );
}

/** Only explicit regional URLs select a regional Daily Snow. Bare Weather/Plumes
 * show fallback Utah while keeping national Daily Snow selected. */
function channelFromPath(pathname: string | null): ChannelId | null {
  const [, section, region] = (pathname ?? "").split("/");
  if (!["daily-snow", "weather", "plumes"].includes(section)) return null;
  return regionById(region)?.id ?? "western-us";
}

/** Resort pages keep Resorts marked as their parent; the homepage lists resorts. */
export function SectionNav({ pathname }: { pathname: string | null }) {
  const routeChannel = channelFromPath(pathname);
  const [rememberedChannel, setRememberedChannel] = useState<ChannelId>("western-us");
  // Derive links from the current URL immediately. The effect only remembers the
  // selection for a detour through Resorts; it never redirects or changes content.
  const channel = routeChannel ?? rememberedChannel;
  useEffect(() => {
    if (routeChannel) setRememberedChannel(routeChannel);
  }, [routeChannel]);

  const home = sectionHref(SECTIONS[0].id);
  const resort = SECTIONS.find((s) => s.group && sectionHref(s.id) === pathname);

  return (
    <div className="section-nav">
      <NavRow label="Sections" pathname={pathname}>
        {SECTIONS.filter((s) => !s.group).map((s) => (
          <Link key={s.id} href={channel !== "western-us" && ["daily-snow", "weather", "plumes"].includes(s.id)
            ? `${sectionHref(s.id)}/${channel}` : sectionHref(s.id)}
            aria-current={(sectionHref(s.id) === pathname || pathname?.startsWith(`${sectionHref(s.id)}/`)) ? "page" : undefined}
            data-current={sectionHref(s.id) === home && resort ? "" : undefined}>{s.label}</Link>
        ))}
      </NavRow>
    </div>
  );
}
