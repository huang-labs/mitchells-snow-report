import { notFound } from "next/navigation";
import { SectionView } from "@/components/SectionView";
import { REGIONS, regionById } from "@/lib/catalog";
import { regionalMetadata } from "@/lib/metadata";
export const dynamicParams = false;
export function generateStaticParams() {
  return REGIONS.map((r) => ({ region: r.id }));
}
export async function generateMetadata({ params }: { params: Promise<{ region: string }> }) {
  const { region } = await params;
  return regionalMetadata("weather", region);
}
export default async function Page({ params }: { params: Promise<{ region: string }> }) {
  const { region } = await params;
  const r = regionById(region);
  if (!r) notFound();
  return <SectionView id="weather" region={r.id} />;
}
