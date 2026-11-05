import { SectionView } from "@/components/SectionView";
import { sectionMetadata } from "@/lib/metadata";
import { SECTIONS } from "@/lib/sections";
export const metadata = sectionMetadata(SECTIONS.find((s) => s.id === "plumes")!);
export default function Page() {
  return <SectionView id="plumes" />;
}
