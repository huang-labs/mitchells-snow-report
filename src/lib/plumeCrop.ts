import { decode, encode } from "fast-png";

/**
 * Crops the "Accumulated Snow" and "Snow-to-Liquid Ratio" panels out of a
 * University of Utah plume chart (a 3×2 matplotlib grid; snow panels are the
 * right column, top and bottom).
 *
 * Panels are located from the image itself — the black axes frames — rather
 * than hard-coded pixel offsets, so a resized figure still crops correctly; an
 * unexpected layout throws instead of producing a wrong crop. Y tick labels are
 * kept whole, including the ones overhanging the frame's top and bottom edges.
 * The UTC tick labels under each frame are cut off (the web app draws Mountain Time ones),
 * and the frame position inside each crop is returned so the time axis can be
 * mapped: the frame's left edge is the model init time, the right edge init +
 * forecast length.
 */

export type PlumePanelId = "snow" | "slr";

export interface CroppedPanel {
  id: PlumePanelId;
  png: Uint8Array;
  width: number;
  height: number;
  /** Axes frame inside the crop, in crop pixels. */
  plot: { left: number; right: number; top: number; bottom: number };
}

interface Raster {
  width: number;
  height: number;
  /** RGBA, 8-bit. */
  rgba: Uint8Array;
}

function toRaster(png: Uint8Array): Raster {
  const img = decode(png);
  if (img.depth !== 8) throw new Error(`Unsupported PNG bit depth ${img.depth}`);
  const { width, height } = img;
  const src = img.data as Uint8Array;
  const rgba = new Uint8Array(width * height * 4);
  if (img.palette) {
    for (let i = 0; i < width * height; i++) {
      const p = img.palette[src[i]];
      rgba.set([p[0], p[1], p[2], p.length > 3 ? p[3] : 255], i * 4);
    }
  } else if (img.channels === 4) {
    rgba.set(src);
  } else if (img.channels === 3) {
    for (let i = 0; i < width * height; i++) rgba.set([src[i * 3], src[i * 3 + 1], src[i * 3 + 2], 255], i * 4);
  } else {
    throw new Error(`Unsupported PNG channel count ${img.channels}`);
  }
  return { width, height, rgba };
}

function lum(r: Raster, x: number, y: number) {
  const i = (y * r.width + x) * 4;
  // Transparent pixels render on a white page.
  const a = r.rgba[i + 3] / 255;
  const l = 0.299 * r.rgba[i] + 0.587 * r.rgba[i + 1] + 0.114 * r.rgba[i + 2];
  return l * a + 255 * (1 - a);
}
const isDark = (r: Raster, x: number, y: number) => lum(r, x, y) < 60;
const isInk = (r: Raster, x: number, y: number) => lum(r, x, y) < 235;
/** Width left of the axis searched for y tick labels (right-aligned, at most ~4 digits). */
const TICK_LABEL_STRIP = 60;

interface Segment {
  x: number;
  y0: number;
  y1: number;
}

/** Long vertical runs of black pixels: matplotlib axes frame edges. */
function verticalFrameEdges(r: Raster): Segment[] {
  const minLen = Math.round(r.height * 0.12);
  const segs: Segment[] = [];
  for (let x = 0; x < r.width; x++) {
    let start = -1;
    for (let y = 0; y <= r.height; y++) {
      const dark = y < r.height && isDark(r, x, y);
      if (dark && start < 0) start = y;
      if (!dark && start >= 0) {
        if (y - start >= minLen) segs.push({ x, y0: start, y1: y - 1 });
        start = -1;
      }
    }
  }
  return segs;
}

/** Merge adjacent-column duplicates (frames are 1–3 px wide); keep the outer edge. */
function clusterX(xs: number[], gap = 4): number[][] {
  const sorted = [...new Set(xs)].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const x of sorted) {
    const g = groups[groups.length - 1];
    if (g && x - g[g.length - 1] <= gap) g.push(x);
    else groups.push([x]);
  }
  return groups;
}

interface Frame {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Find the axes frames of the right-hand column, top to bottom. */
export function findRightColumnFrames(r: Raster): { frames: Frame[]; leftColumnRight: number } {
  const segs = verticalFrameEdges(r);
  // A frame edge column carries one long segment per panel (3 rows of panels);
  // other long dark lines (e.g. the station-elevation arrow) carry fewer.
  const columns = clusterX(segs.map((s) => s.x)).filter(
    (xs) => new Set(segs.filter((s) => xs.includes(s.x)).map((s) => Math.round(s.y0 / 20))).size >= 3,
  );
  if (columns.length !== 4) throw new Error(`Expected 4 frame edge columns (2×2 sides), found ${columns.length}`);
  const [, lRight, rLeft, rRight] = columns;
  const leftX = rLeft[0];
  const rightX = rRight[rRight.length - 1];
  // Distinct panels along the right column's left edge.
  const spans = segs
    .filter((s) => rLeft.includes(s.x))
    .sort((a, b) => a.y0 - b.y0)
    .reduce<Array<{ y0: number; y1: number }>>((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && s.y0 <= last.y1 + 4) {
        last.y0 = Math.min(last.y0, s.y0);
        last.y1 = Math.max(last.y1, s.y1);
      } else acc.push({ y0: s.y0, y1: s.y1 });
      return acc;
    }, []);
  if (spans.length !== 3) throw new Error(`Expected 3 panels in the right column, found ${spans.length}`);
  // The vertical edge can run on into an outward tick mark at the corner, so
  // snap top/bottom to the nearest solid horizontal frame line.
  const solid = (y: number) => {
    let dark = 0;
    for (let x = leftX; x <= rightX; x++) if (isDark(r, x, y)) dark++;
    return dark >= (rightX - leftX) * 0.9;
  };
  const frames = spans.map((s) => {
    let top = s.y0;
    while (top < s.y0 + 25 && !solid(top)) top++;
    let bottom = s.y1;
    while (bottom > s.y1 - 25 && !solid(bottom)) bottom--;
    if (!solid(top) || !solid(bottom)) throw new Error(`Panel frame at y=${s.y0}–${s.y1} has no solid top/bottom edge`);
    return { left: leftX, right: rightX, top, bottom };
  });
  return { frames, leftColumnRight: lRight[lRight.length - 1] };
}

function rowHasInk(r: Raster, y: number, x0: number, x1: number) {
  for (let x = x0; x <= x1; x++) if (isInk(r, x, y)) return true;
  return false;
}
function colHasInk(r: Raster, x: number, y0: number, y1: number) {
  for (let y = y0; y <= y1; y++) if (isInk(r, x, y)) return true;
  return false;
}

function crop(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  blank: (x: number, y: number) => boolean,
): Uint8Array {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * r.width + x0) * 4;
    out.set(r.rgba.subarray(from, from + w * 4), y * w * 4);
    for (let x = 0; x < w; x++) if (blank(x0 + x, y0 + y)) out.fill(255, (y * w + x) * 4, (y * w + x + 1) * 4);
  }
  return encode({ width: w, height: h, data: out, channels: 4, depth: 8 });
}

export function cropSnowPanels(png: Uint8Array): CroppedPanel[] {
  const r = toRaster(png);
  const { frames, leftColumnRight } = findRightColumnFrames(r);
  const picks: Array<[PlumePanelId, Frame]> = [
    ["snow", frames[0]],
    ["slr", frames[2]],
  ];
  return picks.map(([id, f]) => {
    // Horizontal extent: from just right of the left column's frame (the gap
    // holds this panel's y-axis label) to the image edge, trimmed to ink.
    let x0 = leftColumnRight + 3;
    let x1 = r.width - 1;
    // Top: walk up from the frame past the gap and the panel title. Only the
    // middle of the frame is checked: the title is centred there, while the
    // figure-level credit line above the top row extends in from the left.
    const mid = Math.round((f.left + f.right) / 2);
    const titleBand = (yy: number) => rowHasInk(r, yy, mid - 60, mid + 60);
    let y = f.top;
    while (y > 0 && rowHasInk(r, y, f.left, f.right)) y--; // frame line thickness
    while (y > 0 && !titleBand(y)) y--;
    while (y > 0 && titleBand(y)) y--;
    const y0 = y + 1;
    // Horizontal extent of the title (centre outward to a 25 px gap); anything
    // else in the title band is figure-level text and gets blanked.
    const gap = (dir: 1 | -1) => {
      let x = mid;
      let blank = 0;
      while (blank < 25 && x > 0 && x < r.width - 1) {
        blank = colHasInk(r, x, y0, f.top - 2) ? 0 : blank + 1;
        x += dir;
      }
      return x - dir * 25;
    };
    const titleX0 = gap(-1);
    const titleX1 = gap(1);
    // Y-axis tick labels are centred on their ticks, so the labels at the
    // frame's top and bottom edges (e.g. "25" and "0") overhang the frame by
    // half a text height. Find that overhang in the label strip left of the
    // axis: ink contiguous with the frame edge.
    const stripX0 = Math.max(x0, f.left - TICK_LABEL_STRIP);
    const stripX1 = f.left - 3;
    let labelTop = f.top;
    while (labelTop > y0 && rowHasInk(r, labelTop - 1, stripX0, stripX1)) labelTop--;
    let labelBottom = f.bottom;
    while (labelBottom < r.height - 1 && rowHasInk(r, labelBottom + 1, stripX0, stripX1)) labelBottom++;
    // Bottom: keep the frame, its tick marks and the bottom y tick label; the
    // UTC tick labels start below the first blank row inside the plot's width.
    y = f.bottom + 1;
    while (y < r.height - 1 && rowHasInk(r, y, f.left + 40, f.right - 40)) y++;
    const tickBottom = y - 1;
    const y1 = Math.max(tickBottom, labelBottom);
    while (x0 < f.left && !colHasInk(r, x0, f.top - 1, y1)) x0++;
    while (x1 > f.right && !colHasInk(r, x1, f.top - 1, y1)) x1--;
    if (y1 - y0 < 100 || x1 - x0 < 200) throw new Error(`Implausible ${id} crop ${x1 - x0}×${y1 - y0}`);
    return {
      id,
      png: crop(r, x0, y0, x1, y1, (x, yy) => {
        // Above the frame keep only the title and the top y tick label;
        // below the tick marks keep only the bottom y tick label.
        if (yy < f.top - 1) return (x < titleX0 || x > titleX1) && !(yy >= labelTop && x >= stripX0 && x <= stripX1);
        return yy > tickBottom && x > stripX1;
      }),
      width: x1 - x0 + 1,
      height: y1 - y0 + 1,
      plot: { left: f.left - x0, right: f.right - x0, top: f.top - y0, bottom: f.bottom - y0 },
    };
  });
}
