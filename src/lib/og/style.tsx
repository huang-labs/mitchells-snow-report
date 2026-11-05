import type { CSSProperties, ReactNode } from "react";

/** Explicit dark palette: link crawlers have no reliable appearance preference. */
export const SHARE_COLORS = {
  bg: "#101c2a", panel: "#192b3f", line: "#304257",
  text: "#edf4fb", muted: "#a7b9cc", accent: "#82c5f5",
};

/** Spread into a fresh object per render: Satori mutates style objects. */
export const SHARE_FRAME: CSSProperties = {
  width: "100%", height: "100%", display: "flex", flexDirection: "column",
  padding: "48px 56px", fontFamily: "Geist", fontWeight: 500,
  background: SHARE_COLORS.bg, color: SHARE_COLORS.text,
};

export function ShareBrand({ large = false }: { large?: boolean }) {
  return (
    <div style={{ display: "flex", flexShrink: 0, flexDirection: large ? "column" : "row", fontSize: large ? 88 : 36, lineHeight: 1.08, letterSpacing: large ? -3 : -1, fontWeight: 700 }}>
      <span>Mitchell’s</span>
      <span style={{ color: SHARE_COLORS.accent, marginLeft: large ? 0 : 10 }}>Snow Report</span>
    </div>
  );
}

export function ShareFooter({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexShrink: 0, borderTop: `1px solid ${SHARE_COLORS.line}`, paddingTop: 22, color: SHARE_COLORS.muted, fontSize: 22 }}>{children}</div>;
}
