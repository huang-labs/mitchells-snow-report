import { SHARE_COLORS as C, SHARE_FRAME, ShareBrand, ShareFooter } from "./style";

/** Data-independent preview, rendered once into a bundled PNG. */
export function BrandedShareCard() {
  return (
    <div style={{ ...SHARE_FRAME }}>
      <div style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "center" }}>
        <ShareBrand large />
        <div style={{ fontSize: 30, color: C.muted, marginTop: 32 }}>Western United States</div>
      </div>
      <ShareFooter>Snowfall · Forecasts · Plumes · Mountain weather</ShareFooter>
    </div>
  );
}
