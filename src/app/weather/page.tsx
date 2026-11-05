import { SectionView } from "@/components/SectionView";
import { sectionMetadata } from "@/lib/metadata";
import { SECTIONS } from "@/lib/sections";
export const metadata = sectionMetadata(SECTIONS.find((s) => s.id === "weather")!);
export default function Page() {
  return <SectionView id="weather" />;
}
