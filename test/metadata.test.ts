import { afterEach, describe, expect, it, vi } from "vitest";
import { sectionMetadata, SITE_TITLE } from "@/lib/metadata";
import { metadata as rootMetadata } from "@/app/layout";
import { SECTIONS, sectionHref } from "@/lib/sections";

describe("deployment metadata base", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves share images against the preview deployment when configured", async () => {
    const origin = "https://pr-7-cottonwoods-snow-report.huang-inc.workers.dev";
    vi.stubEnv("SITE_URL", origin);
    vi.resetModules();
    const metadata = await import("@/lib/metadata");
    const base = metadata.metadataBase;
    expect(new URL("/daily-snow/opengraph-image", base).href).toBe(`${origin}/daily-snow/opengraph-image`);
  });

  it("defaults to the production origin", async () => {
    vi.stubEnv("SITE_URL", undefined);
    vi.resetModules();
    const metadata = await import("@/lib/metadata");
    expect(metadata.metadataBase.origin).toBe("https://mitchells-snow-report.huang.mx");
  });
});

describe("section share metadata", () => {
  it("uses the shared static brand image on the homepage", () => {
    expect(rootMetadata.openGraph).toHaveProperty("images", [expect.objectContaining({ url: "/share-brand-v3.png" })]);
    expect(rootMetadata.twitter).toHaveProperty("images", ["/share-brand-v3.png"]);
  });
  it.each(SECTIONS.slice(1))("matches the document title and URL for $id", (section) => {
    const metadata = sectionMetadata(section);
    const title = `${metadata.title} · ${SITE_TITLE}`;
    expect(metadata.openGraph).toMatchObject({ title, url: sectionHref(section.id), siteName: SITE_TITLE });
    expect(metadata.twitter).toMatchObject({ title, card: "summary_large_image" });
    const url = section.id === "daily-snow" ? "/daily-snow/opengraph-image" : "/share-brand-v3.png";
    expect(metadata.openGraph).toHaveProperty("images", [expect.objectContaining({ url })]);
    expect(metadata.twitter).toHaveProperty("images", [expect.objectContaining({ url })]);
  });

  it("describes the daily forecast on Daily Snow", () => {
    const metadata = sectionMetadata(SECTIONS.find((s) => s.id === "daily-snow")!);
    expect(metadata.description).toContain("Daily Snow forecasts");
    expect(metadata.openGraph).toHaveProperty("description", metadata.description);
    expect(metadata.twitter).toHaveProperty("description", metadata.description);
  });
});
