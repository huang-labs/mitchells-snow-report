import { RESORTS } from "./catalog";
/**
 * Web app sections. Each is a page, routed from the navbar. The first section
 * (`/`, "Resorts") is also the parent of the resort pages: the navbar shows their
 * row beneath it on `/` and on each resort page.
 */
export interface SectionDef {
  id: string;
  /** Full heading-style title (page title). */
  title: string;
  /** Short label for the navbar tabs. */
  label: string;
  /** Sections sharing a group appear in a secondary navbar row. */
  group?: SectionGroup;
}

export type SectionGroup = "resorts";
export const GROUP_LABELS: Record<SectionGroup, string> = { resorts: "Resorts" };

export const SECTIONS: SectionDef[] = [
  { id: "regional", title: "Resorts", label: "Resorts" },
  { id: "daily-snow", title: "Daily Snow", label: "Daily Snow" },
  { id: "weather", title: "Mountain weather", label: "Weather" },
  { id: "plumes", title: "Ensemble plumes", label: "Plumes" },
  ...RESORTS.map(r => ({ id:r.id, title:r.name, label:r.name, group:"resorts" as const })),
];

/** The first section lives at `/`; the others at `/<id>`. */
export function sectionHref(id: string): string {
  return id === SECTIONS[0].id ? "/" : `/${id}`;
}

/** Index of the section a pathname shows (0 for `/`), or -1 for other paths. */
export function sectionIndexFromPath(pathname: string | null): number {
  const id = (pathname ?? "/").replace(/^\/+|\/+$/g, "").split("/")[0];
  if (id === "") return 0;
  return SECTIONS.findIndex((s) => s.id === id);
}

export function findSection(id: string): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}
