/**
 * Deterministic geometry for the card studio: seeded starfields, SVG barcodes,
 * Catmull-Rom sparkline paths and the mathematical hero-numeral auto-fit.
 * Everything here is pure and side-effect free.
 */

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** #rrggbb → rgba(r,g,b,a) */
export function rgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "").trim();
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = Number.parseInt(full.slice(0, 6) || "000000", 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Stable 32-bit string hash (FNV-1a flavoured). */
export function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic PRNG — same seed, same card, every single render. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Monospace advance estimate for layout packing decisions. */
export function estimateTextW(text: string, fontSize: number, trackingEm = 0): number {
  const chars = Math.max(1, text.length);
  return chars * fontSize * 0.6 + Math.max(0, chars - 1) * fontSize * trackingEm;
}

export interface HeroFit {
  size: number;
  unitSize: number;
}

/**
 * Auto-fit the hero numeral so any length (5.90 / $237.80 / 1,204.55) fills the
 * available box without clipping or wrapping.
 */
export function fitHero(opts: {
  num: string;
  unit: string;
  availW: number;
  availH: number;
  cap: number;
  floor?: number;
}): HeroFit {
  const { num, unit, availW, availH, cap, floor = 16 } = opts;
  const glyph = 0.62; // em advance per tabular mono glyph
  const unitScale = 0.46;
  const em =
    num.length * glyph + (unit ? unit.length * glyph * unitScale + 0.06 : 0);
  const byW = availW / Math.max(0.5, em);
  const byH = availH / 1.06;
  const raw = Math.min(cap, byW, byH);
  const size = Math.floor(Math.max(floor, Math.min(raw, cap)) * 2) / 2;
  return { size, unitSize: Math.round(size * unitScale) };
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * Catmull-Rom → cubic bézier. Control points are clamped into the plot box so
 * spiky telemetry never dips below the baseline.
 */
export function catmullRomPath(
  pts: Pt[],
  opts?: { tension?: number; minY?: number; maxY?: number },
): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  const t = opts?.tension ?? 1;
  const minY = opts?.minY ?? Number.NEGATIVE_INFINITY;
  const maxY = opts?.maxY ?? Number.POSITIVE_INFINITY;
  const at = (i: number) => pts[clamp(i, 0, n - 1)];
  const cy = (v: number) => clamp(v, minY, maxY);

  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1.x + ((p2.x - p0.x) / 6) * t;
    const c1y = cy(p1.y + ((p2.y - p0.y) / 6) * t);
    const c2x = p2.x - ((p3.x - p1.x) / 6) * t;
    const c2y = cy(p2.y - ((p3.y - p1.y) / 6) * t);
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export interface SparkBar {
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
  peak: boolean;
}

export interface SparkGeom {
  linePath: string;
  areaPath: string;
  bars: SparkBar[];
  curveTop: number;
  curveBottom: number;
  avgY: number;
  avgLabel: string;
  avgValue: number;
  peak: {
    x: number;
    y: number;
    tx: number;
    ty: number;
    anchor: "start" | "end";
    label: string;
  } | null;
  startLabel: string;
  endLabel: string;
}

/**
 * Activity rhythm: a smooth area curve over the daily series plus a bar strip
 * for every day/bucket, an average guide line and a peak callout.
 */
export function sparkGeometry(input: {
  values: number[];
  dates: string[];
  width: number;
  height: number;
  labelFont: number;
  fmtValue: (n: number) => string;
  fmtDate: (d: string) => string;
  peakDate: string | null;
  peakIndex?: number;
}): SparkGeom {
  const { values, dates, width, height, labelFont, fmtValue, fmtDate } = input;
  const n = Math.max(1, values.length);
  const labelH = labelFont + 3;
  const barH = Math.max(8, Math.round(height * 0.1));
  const gapAboveBars = 5;
  const top = Math.max(10, labelFont + 4);
  const barBottom = height - labelH;
  const barTop = barBottom - barH;
  const bottom = barTop - gapAboveBars;
  // Inset the curve enough that the peak dot + its halo ring never clip.
  const pad = 7;
  const usable = Math.max(1, width - pad * 2);
  const max = Math.max(...values, 0);
  const scaleMax = max > 0 ? max : 1;

  const xAt = (i: number) => (n === 1 ? pad + usable / 2 : pad + (usable * i) / (n - 1));
  const yAt = (v: number) => bottom - (v / scaleMax) * (bottom - top);

  const pts: Pt[] = values.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
  const linePath = catmullRomPath(pts, { minY: top, maxY: bottom });
  const first = pts[0];
  const last = pts[pts.length - 1];
  const areaPath = `${linePath} L ${last.x.toFixed(2)} ${bottom.toFixed(2)} L ${first.x.toFixed(2)} ${bottom.toFixed(2)} Z`;

  const slot = width / n;
  const bw = clamp(slot * 0.62, 1.4, 6);
  const autoPeak = values.reduce((best, v, i) => (v > (values[best] ?? 0) ? i : best), 0);
  const peakIdx =
    input.peakIndex != null && input.peakIndex >= 0 && input.peakIndex < values.length
      ? input.peakIndex
      : autoPeak;
  const bars: SparkBar[] = values.map((v, i) => {
    const h = v > 0 ? Math.max(2, (v / scaleMax) * barH) : 1.2;
    return {
      x: slot * i + (slot - bw) / 2,
      y: barBottom - h,
      w: bw,
      h,
      active: v > 0,
      peak: i === peakIdx && v > 0,
    };
  });

  const total = values.reduce((a, v) => a + v, 0);
  const avgValue = total / n;
  const avgY = yAt(avgValue);

  let peak: SparkGeom["peak"] = null;
  if (max > 0 && pts.length > 0) {
    const p = pts[peakIdx] ?? pts[pts.length - 1];
    const anchor: "start" | "end" = p.x < width * 0.55 ? "start" : "end";
    const label = `PEAK · ${fmtDate(input.peakDate ?? dates[peakIdx] ?? dates[dates.length - 1] ?? "")}`;
    peak = {
      x: p.x,
      y: p.y,
      tx: anchor === "start" ? Math.min(p.x + 6, width - 2) : Math.max(p.x - 6, 2),
      ty: p.y - 7 < top - 1 ? p.y + labelFont + 7 : p.y - 7,
      anchor,
      label,
    };
  }

  return {
    linePath,
    areaPath,
    bars,
    curveTop: top,
    curveBottom: bottom,
    avgY,
    avgValue,
    avgLabel: fmtValue(avgValue),
    peak,
    startLabel: fmtDate(dates[0] ?? ""),
    endLabel: fmtDate(dates[dates.length - 1] ?? ""),
  };
}

/** Deterministic starfield for the aurora canvas. */
export function starPoints(
  seed: string,
  count: number,
  w: number,
  h: number,
): { x: number; y: number; r: number; o: number }[] {
  const rand = mulberry32(hashSeed(seed));
  const out: { x: number; y: number; r: number; o: number }[] = [];
  for (let i = 0; i < count; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const big = rand() > 0.88;
    out.push({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      r: big ? 1.5 : 0.55 + rand() * 0.7,
      o: big ? 0.55 + rand() * 0.35 : 0.14 + rand() * 0.42,
    });
  }
  return out;
}

/** Deterministic SVG barcode (editorial spec stamp). */
export function barcodeBars(
  seed: string,
  count: number,
  unit: number,
  gap: number,
  maxH: number,
): { x: number; w: number; h: number }[] {
  const rand = mulberry32(hashSeed(seed));
  const bars: { x: number; w: number; h: number }[] = [];
  let x = 0;
  for (let i = 0; i < count; i++) {
    const w = (rand() > 0.72 ? 3 : rand() > 0.45 ? 2 : 1) * unit;
    const h = Math.max(unit * 2, maxH * (0.42 + rand() * 0.58));
    bars.push({ x, w, h: Math.round(h * 10) / 10 });
    x += w + gap;
  }
  return bars;
}

/** Total rendered width of a barcode produced by `barcodeBars`. */
export function barcodeWidth(bars: { x: number; w: number }[], gap: number): number {
  const last = bars[bars.length - 1];
  return last ? last.x + last.w + gap : 0;
}
