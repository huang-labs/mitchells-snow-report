"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SECTIONS, sectionHref } from "@/lib/sections";
import { SectionNav } from "./SectionNav";
import { DashboardContext, DataBanners, type DashboardData } from "./dashboard-context";
import { useNow, useReport } from "./hooks";

/** Appearance override, stored in localStorage; absent means "follow the system". */
const APPEARANCE_KEY = "mitchells-snow-report.appearance";
type Appearance = "light" | "dark";

function readAppearance(storage: Pick<Storage, "getItem"> | undefined): Appearance | null {
  try {
    const saved = storage?.getItem(APPEARANCE_KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}

/** Sets the theme attribute on <html>; the layout's inline script does this before first paint. */
function applyAppearance(value: Appearance | null) {
  if (value) document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
}

/**
 * App frame: a masthead (brand, appearance control) and section tabs
 * over one routed section page. Data comes from a single shared poller.
 * Legacy `?slide=<id>` links redirect to that section's page.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { report, loadedAt, error } = useReport(60_000);
  const now = useNow(30_000);
  const pathname = usePathname();
  const router = useRouter();
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  const [systemDark, setSystemDark] = useState(false);

  // The pre-paint script already applied the stored choice; read it back after mount.
  useEffect(() => {
    setAppearance(readAppearance(window.localStorage));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Redirect legacy ?slide=<id> links to the section's page (old bookmarks).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const legacy = SECTIONS.findIndex((s) => s.id === params.get("slide"));
    if (legacy >= 0) router.replace(sectionHref(SECTIONS[legacy].id));
  }, [router]);

  function changeAppearance(mode: Appearance) {
    const next = appearance === mode ? null : mode;
    setAppearance(next);
    applyAppearance(next);
    try {
      if (next) window.localStorage.setItem(APPEARANCE_KEY, next);
      else window.localStorage.removeItem(APPEARANCE_KEY);
    } catch { /* Keep the session choice when storage is unavailable. */ }
  }

  const data: DashboardData = { report, loadedAt, error, now };
  const dark = appearance ? appearance === "dark" : systemDark;

  return (
    <DashboardContext.Provider value={data}>
      <div className="app">
        <header className="editorial-nav">
          <div className="editorial-nav__masthead">
            <Link href="/" className="editorial-nav__brand">Mitchell’s <span>Snow Report</span></Link>
            <div className="appearance-control" role="group" aria-label="Appearance">
              {(["light", "dark"] as const).map((mode) => (
                <button key={mode} type="button" aria-label={`${mode === "light" ? "Light" : "Dark"} appearance`}
                  aria-pressed={mode === "dark" ? dark : !dark}
                  title={appearance === mode ? "Use system appearance" : `${mode === "light" ? "Light" : "Dark"} appearance`}
                  onClick={() => changeAppearance(mode)}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {mode === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4L19 5" /></> : <path d="M20.5 14A8.6 8.6 0 0 1 10 3.5 8.6 8.6 0 1 0 20.5 14Z" />}
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </header>
        <SectionNav pathname={pathname} />
        <DataBanners data={data} />
        <main className="editorial-page">{children}</main>
      </div>
    </DashboardContext.Provider>
  );
}
