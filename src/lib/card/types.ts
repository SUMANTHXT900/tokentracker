/**
 * Shared types for the Shareable PNG Card Studio.
 * No React / JSX here — pure data contracts so the card geometry and the
 * snapshot derivation stay testable in isolation.
 */

export type AspectId = "1:1" | "9:16" | "16:9";
export type ThemeId = "obsidian" | "editorial" | "aurora" | "monolith";
export type HeroMetric = "tokens" | "spend";
export type ChromeKind = "grid" | "brutalist" | "starfield" | "frame";

export interface AspectDef {
  id: AspectId;
  /** "1:1 Square" */
  label: string;
  /** "Square" */
  short: string;
  /** "Instagram Post · X Square" */
  platform: string;
  /** Exact capture-node CSS pixels — never scaled, never maxWidth'd. */
  w: number;
  h: number;
  /** w/h × 3 → the exported PNG raster size. */
  outW: number;
  outH: number;
  /** How many buckets the activity chart is allowed to use. */
  maxBuckets: number;
}

export interface CardLayout {
  pad: number;
  headerH: number;
  heroLabelH: number;
  heroH: number;
  /** Hard cap for the auto-fitted hero numeral. */
  heroCap: number;
  sparkLabelH: number;
  sparkH: number;
  clientsH: number;
  modelLabelH: number;
  modelRowH: number;
  modelRows: number;
  bentoRows: 1 | 2;
  bentoCellH: number;
  bentoGap: number;
  footerH: number;
  /** Wide layout: two content columns under the header. */
  twoCol: boolean;
  leftW: number;
  colGap: number;
  /* ---- type scale (px) ---- */
  brandMark: number;
  brandFont: number;
  dateFont: number;
  labelFont: number;
  nameFont: number;
  valueFont: number;
  bentoLabelFont: number;
  bentoValueFont: number;
  bentoSubFont: number;
  footerFont: number;
  heroLabelFont: number;
  pillFont: number;
  clientFont: number;
  stampFont: number;
  sparkFont: number;
  sparkStroke: number;
}

export interface CardTheme {
  id: ThemeId;
  name: string;
  blurb: string;
  /** Solid color passed to html-to-image as `backgroundColor`. */
  canvas: string;
  /** Layered CSS gradients for the capture node. */
  background: string;
  ink: string;
  dim: string;
  faint: string;
  accent: string;
  accent2: string;
  accentInk: string;
  heroColor: string;
  heroGlow: string;
  heroWeight: number;
  line: string;
  lineStrong: string;
  panel: string;
  panelBorder: string;
  panelShadow: string;
  track: string;
  barFrom: string;
  barTo: string;
  chrome: ChromeKind;
  /** 3 colors shown on the theme pill swatch. */
  swatch: [string, string, string];
  labelSpacing: number;
  labelWeight: number;
  /** Header underline (editorial only uses a visible vermilion rule). */
  ruleColor: string;
  ruleH: number;
  separator: string;
  brandBg: string;
  brandInk: string;
  radius: number;
  gridStep: number;
  gridColor: string;
  frame: { outer: string; inner: string; tick: string } | null;
  barcode: { bar: string; dim: string } | null;
}

export interface LayerFlags {
  sparkline: boolean;
  models: boolean;
  bento: boolean;
}
