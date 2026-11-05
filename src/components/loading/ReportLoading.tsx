import { RESORTS,regionById,type RegionId } from "@/lib/catalog";
import { findSection } from "@/lib/sections";
import styles from "./loading.module.css";

function Lines() {
  return <div className={styles.lines}><div /><div /><div /></div>;
}

function Forecast() {
  return (
    <div className={styles.forecast}>
      <div className={styles.summary}><Lines /></div>
      <div className={styles.forecastTable}><Lines /><Lines /><Lines /></div>
      <div className={styles.chart} />
    </div>
  );
}

/** Decorative approximations of the first screen, not copies of each page's data UI. */
function Layout({ kind }: { kind: string }) {
  switch (kind) {
    case "regional":
      return (
        <div className={styles.snowfall}>
          {RESORTS.map(({name}) => (
            <div className={styles.snowRow} key={name}>
              <div className={styles.resortName}>{name}</div>
              <div className={styles.snowStrip}>
                {Array.from({ length: 15 }, (_, i) => <div key={i} className={i === 7 ? styles.snowToday : undefined} />)}
              </div>
            </div>
          ))}
        </div>
      );
    case "daily-snow":
      return (
        <div className={styles.article}>
          <div className={styles.articleSection}><div className={styles.shortLine} /><Lines /><Lines /></div>
        </div>
      );
    case "weather":
      return <div className={styles.columns}><Forecast /><Forecast /></div>;
    case "plumes":
      return (
        <div className={styles.columns}>
          {[0, 1, 2, 3].map((i) => (
            <div className={styles.figure} key={i}><div className={styles.shortLine} /><div className={styles.chart} /></div>
          ))}
        </div>
      );
    default:
      return (
        <div className={styles.resort}>
          <div className={styles.jumpLinks}><div /><div /><div /></div>
          <div className={styles.shortLine} />
          <div className={styles.metrics}><div /><div /></div>
          <div className={styles.history}>
            {[0, 1, 2, 3].map((i) => <div key={i}><Lines /></div>)}
          </div>
          <div className={styles.articleSection}><div className={styles.shortLine} /><Lines /></div>
        </div>
      );
  }
}

function pageTitle(id: string,region:RegionId="utah") {
  if (id === "weather") return `${regionById(region)!.name} mountain weather`;
  if (id === "plumes") return `${regionById(region)!.name} ensemble snow plumes`;
  return findSection(id)?.title ?? "Snow report";
}

/** One entry point for initial report loads and direct Daily Snow archive loads. */
export function ReportLoading({ sectionId,region }: { sectionId: string;region?:RegionId }) {
  const title = pageTitle(sectionId,region);
  return (
    <div className={`${styles.loading} ${sectionId === "daily-snow" ? styles.reading : ""}`}>
      <span className={styles.screenReader} role="status">Loading {title}…</span>
      <section aria-busy="true" aria-label={title}>
        {sectionId === "daily-snow" ? <header className={`dailysnow__header ${styles.articleHeader}`}>
          <h1 className={styles.screenReader}>{title}</h1>
          <p className="eyebrow">{region ? regionById(region)!.name : "United States West"}</p>
          <div className="dailysnow__meta">
            <span className="eyebrow">Daily Snow<span className="badge badge--ai">AI</span></span>
          </div>
          <div aria-hidden="true" className={`${styles.articleHeading} ${styles.shapes}`}>
            <div className={styles.articleTitle} /><div className={styles.articleTitle} />
          </div>
          <div aria-hidden="true" className={styles.shapes}><Lines /></div>
        </header> : <header className={styles.header}>
          <h1>{title}</h1>
          <div aria-hidden="true" className={styles.subtitle}><Lines /></div>
        </header>}
        <div aria-hidden="true" className={styles.shapes}><Layout kind={sectionId} /></div>
      </section>
    </div>
  );
}

/** A failed first request must not look like a request that is still pending. */
export function ReportLoadError({ error }: { error: string }) {
  return (
    <section className={styles.error} role="status">
      <h1>Could not load the report</h1>
      <p>We’ll retry automatically in a few seconds.</p>
      <p className={styles.errorDetail}>{error}</p>
    </section>
  );
}
