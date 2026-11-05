"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CHANNELS, REGIONS, regionById, type ChannelId } from "@/lib/catalog";
const KEY = "mitchells-snow-report.region";
export function RegionSelector({
  section,
  selected,
  explicit = false,
}: {
  section: "daily-snow" | "weather" | "plumes";
  selected: ChannelId;
  explicit?: boolean;
}) {
  const router = useRouter();
  useEffect(() => {
    try {
      if (explicit && selected !== "western-us") localStorage.setItem(KEY, selected);
      else if (!explicit && section !== "daily-snow") {
        const saved = localStorage.getItem(KEY);
        if (saved && regionById(saved)) router.replace(`/${section}/${saved}`);
      }
    } catch {}
  }, [explicit, section, selected, router]);
  return (
    <div className="region-selector">
      <select
        id={`region-${section}`}
        aria-label="Region"
        value={selected}
        onChange={(e) => {
          const value = e.target.value;
          try {
            if (value !== "western-us") localStorage.setItem(KEY, value);
          } catch {}
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
