import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SectionView } from "@/components/SectionView";
import { findSection, SECTIONS } from "@/lib/sections";
import { sectionMetadata } from "@/lib/metadata";

// Every section except the first (served at `/`) gets a static page; anything else 404s.
export const dynamicParams = false;

export function generateStaticParams() {
  return SECTIONS.slice(1).filter((s) => !["daily-snow","weather","plumes"].includes(s.id)).map((s) => ({ section: s.id }));
}

export async function generateMetadata({ params }: PageProps<"/[section]">): Promise<Metadata> {
  const section = findSection((await params).section);
  return section ? sectionMetadata(section) : {};
}

export default async function Page({ params }: PageProps<"/[section]">) {
  const { section } = await params;
  if (!findSection(section)) notFound();
  return <SectionView id={section} />;
}
