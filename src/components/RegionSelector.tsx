"use client";
import { useRouter } from "next/navigation";
import { CHANNELS, REGIONS, type ChannelId } from "@/lib/catalog";
export function RegionSelector({
  section,
  selected,
}: {
  section: "daily-snow" | "weather" | "plumes";
  selected: ChannelId;
}) {
  const router = useRouter();
  return (
    <div className="region-selector">
      <select
        id={`region-${section}`}
        aria-label="Region"
        value={selected}
        onChange={(e) => {
          const value = e.target.value;
          router.push(value === "western-us" ? "/daily-snow" : `/${section}/${value}`);
        }}
      >
        {(section === "daily-snow" ? CHANNELS : REGIONS).map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </div>
  );
}
