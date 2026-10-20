/**
 * Studio design system: aspect ratios, capture layouts and the four curated
 * themes. All colors are literal so the capture node never depends on Tailwind.
 */
import type { CSSProperties } from "react";
import { rgba } from "./geometry";
import type {
  AspectDef,
  AspectId,
  CardLayout,
  CardTheme,
  LayerFlags,
  ThemeId,
} from "./types";

export const FONT_SANS =
  '"Plus Jakarta Sans", "Outfit", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const FONT_DISPLAY = '"Outfit", "Plus Jakarta Sans", sans-serif';
export const FONT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/* ------------------------------------------------------------------ */
/* Aspect ratios — exact integer capture sizes                         */
/* ------------------------------------------------------------------ */

export const ASPECT_ORDER: AspectId[] = ["1:1", "9:16", "16:9"];

export const ASPECTS: Record<AspectId, AspectDef> = {
  "1:1": {
    id: "1:1",
    label: "1:1 Square",
    short: "Square",
    platform: "Instagram Post · X Square",
    w: 540,
    h: 540,
    outW: 1620,
    outH: 1620,
    maxBuckets: 45,
  },
  "9:16": {
    id: "9:16",
    label: "9:16 Story",
    short: "Story",
    platform: "Instagram Story · Reel Cover",
    w: 420,
    h: 746,
    outW: 1260,
    outH: 2238,
    maxBuckets: 40,
  },
  "16:9": {
    id: "16:9",
    label: "16:9 Wide",
    short: "Wide",
    platform: "X · LinkedIn · Desktop Flex",
    w: 680,
    h: 382,
    outW: 2040,
    outH: 1146,
    maxBuckets: 64,
  },
};

/* ------------------------------------------------------------------ */
/* Layouts — fixed pixel rhythm per aspect                             */
/* ------------------------------------------------------------------ */

export const LAYOUTS: Record<AspectId, CardLayout> = {
  "1:1": {
    pad: 28,
    headerH: 36,
    heroLabelH: 16,
    heroH: 84,
    heroCap: 82,
    sparkLabelH: 12,
    sparkH: 82,
    clientsH: 22,
    modelLabelH: 12,
    modelRowH: 30,
    modelRows: 3,
    bentoRows: 1,
    bentoCellH: 48,
    bentoGap: 8,
    footerH: 26,
    twoCol: false,
    leftW: 0,
    colGap: 0,
    brandMark: 22,
    brandFont: 12,
    dateFont: 10.5,
    labelFont: 8.5,
    nameFont: 11,
    valueFont: 10,
    bentoLabelFont: 8,
    bentoValueFont: 17,
    bentoSubFont: 8,
    footerFont: 8.5,
    heroLabelFont: 8.5,
    pillFont: 8.5,
    clientFont: 8.5,
    stampFont: 7.5,
    sparkFont: 8,
    sparkStroke: 1.75,
  },
  "9:16": {
    pad: 26,
    headerH: 40,
    heroLabelH: 17,
    heroH: 108,
    heroCap: 104,
    sparkLabelH: 13,
    sparkH: 136,
    clientsH: 24,
    modelLabelH: 13,
    modelRowH: 36,
    modelRows: 4,
    bentoRows: 2,
    bentoCellH: 58,
    bentoGap: 8,
    footerH: 28,
    twoCol: false,
    leftW: 0,
    colGap: 0,
    brandMark: 26,
    brandFont: 13,
    dateFont: 11,
    labelFont: 9,
    nameFont: 12,
    valueFont: 11,
    bentoLabelFont: 8.5,
    bentoValueFont: 20,
    bentoSubFont: 8.5,
    footerFont: 9,
    heroLabelFont: 9,
    pillFont: 9.5,
    clientFont: 9,
    stampFont: 8,
    sparkFont: 8.5,
    sparkStroke: 2,
  },
  "16:9": {
    pad: 22,
    headerH: 30,
    heroLabelH: 16,
    heroH: 70,
    heroCap: 62,
    sparkLabelH: 12,
    sparkH: 120,
    clientsH: 24,
    modelLabelH: 12,
    modelRowH: 36,
    modelRows: 3,
    bentoRows: 2,
    bentoCellH: 0,
    bentoGap: 8,
    footerH: 26,
    twoCol: true,
    leftW: 268,
    colGap: 12,
    brandMark: 18,
    brandFont: 10.5,
    dateFont: 9.5,
    labelFont: 8,
    nameFont: 10,
    valueFont: 9.5,
    bentoLabelFont: 7.5,
    bentoValueFont: 15,
    bentoSubFont: 7.5,
    footerFont: 8,
    heroLabelFont: 8,
    pillFont: 8.5,
    clientFont: 8,
    stampFont: 7.5,
    sparkFont: 7.5,
    sparkStroke: 1.5,
  },
};

export function innerWidth(id: AspectId): number {
  const a = ASPECTS[id];
  return a.w - LAYOUTS[id].pad * 2;
}

export function innerHeight(id: AspectId): number {
  const a = ASPECTS[id];
  return a.h - LAYOUTS[id].pad * 2;
}

export function rightColumnWidth(id: AspectId): number {
  const l = LAYOUTS[id];
  return innerWidth(id) - l.leftW - l.colGap;
}

/* ------------------------------------------------------------------ */
/* Themes                                                              */
/* ------------------------------------------------------------------ */

export const THEME_ORDER: ThemeId[] = ["obsidian", "editorial", "aurora", "monolith"];

export const THEMES: Record<ThemeId, CardTheme> = {
  obsidian: {
    id: "obsidian",
    name: "Obsidian Pro",
    blurb: "Carbon obsidian · emerald aurora",
    canvas: "#090a0f",
    background: `radial-gradient(72% 54% at 104% -8%, ${rgba("#34d399", 0.28)} 0%, ${rgba("#22d3ee", 0.1)} 42%, ${rgba("#090a0f", 0)} 72%), radial-gradient(46% 36% at 86% 30%, ${rgba("#22d3ee", 0.09)} 0%, ${rgba("#090a0f", 0)} 68%), radial-gradient(70% 56% at -8% 108%, ${rgba("#10b981", 0.08)} 0%, ${rgba("#090a0f", 0)} 64%), linear-gradient(180deg, #0b0d13 0%, #090a0f 54%, #07080c 100%)`,
    ink: "#f3f5f8",
    dim: "#a9b1be",
    faint: "#67707e",
    accent: "#34d399",
    accent2: "#22d3ee",
    accentInk: "#041a14",
    heroColor: "#f4fffb",
    heroGlow: "0 0 36px rgba(52, 211, 153, 0.26)",
    heroWeight: 700,
    line: "rgba(255,255,255,0.075)",
    lineStrong: "rgba(255,255,255,0.16)",
    panel: "rgba(255,255,255,0.04)",
    panelBorder: "rgba(255,255,255,0.09)",
    panelShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
    track: "rgba(255,255,255,0.09)",
    barFrom: "#34d399",
    barTo: "#22d3ee",
    chrome: "grid",
    swatch: ["#090a0f", "#34d399", "#22d3ee"],
    labelSpacing: 0.16,
    labelWeight: 600,
    ruleColor: rgba("#34d399", 0.45),
    ruleH: 1,
    separator: "·",
    brandBg: "#34d399",
    brandInk: "#041a14",
    radius: 18,
    gridStep: 24,
    gridColor: "rgba(255,255,255,0.038)",
    frame: null,
    barcode: null,
  },
  editorial: {
    id: "editorial",
    name: "Swiss Editorial",
    blurb: "Alabaster paper · vermilion ink",
    canvas: "#f7f6f2",
    background:
      "radial-gradient(120% 96% at 50% -14%, #fcfbf8 0%, #f7f6f2 52%, #efede6 100%)",
    ink: "#111111",
    dim: "rgba(17,17,17,0.68)",
    faint: "rgba(17,17,17,0.46)",
    accent: "#ef4b2a",
    accent2: "#111111",
    accentInk: "#fff7f3",
    heroColor: "#111111",
    heroGlow: "none",
    heroWeight: 800,
    line: "rgba(17,17,17,0.12)",
    lineStrong: "rgba(17,17,17,0.26)",
    panel: "rgba(17,17,17,0.035)",
    panelBorder: "rgba(17,17,17,0.14)",
    panelShadow: "none",
    track: "rgba(17,17,17,0.12)",
    barFrom: "#111111",
    barTo: "#ef4b2a",
    chrome: "brutalist",
    swatch: ["#f7f6f2", "#111111", "#ef4b2a"],
    labelSpacing: 0.22,
    labelWeight: 700,
    ruleColor: "#ef4b2a",
    ruleH: 3,
    separator: "/",
    brandBg: "#111111",
    brandInk: "#f7f6f2",
    radius: 4,
    gridStep: 0,
    gridColor: "transparent",
    frame: null,
    barcode: { bar: "rgba(17,17,17,0.82)", dim: "rgba(17,17,17,0.28)" },
  },
  aurora: {
    id: "aurora",
    name: "Midnight Aurora",
    blurb: "Cobalt night · frosted glass",
    canvas: "#0b1021",
    background: `radial-gradient(58% 44% at 10% 2%, ${rgba("#22d3ee", 0.28)} 0%, ${rgba("#0b1021", 0)} 66%), radial-gradient(54% 42% at 92% 8%, ${rgba("#8b5cf6", 0.3)} 0%, ${rgba("#0b1021", 0)} 68%), radial-gradient(72% 50% at 54% 104%, ${rgba("#6366f1", 0.18)} 0%, ${rgba("#0b1021", 0)} 72%), radial-gradient(122% 108% at 50% 42%, rgba(11,16,33,0) 34%, rgba(7,10,22,0.92) 100%), #0b1021`,
    ink: "#eef2ff",
    dim: "#a7b4d6",
    faint: "#65729a",
    accent: "#22d3ee",
    accent2: "#8b5cf6",
    accentInk: "#041c25",
    heroColor: "#f7fbff",
    heroGlow: "0 0 38px rgba(34, 211, 238, 0.3), 0 0 70px rgba(139, 92, 246, 0.16)",
    heroWeight: 700,
    line: "rgba(255,255,255,0.085)",
    lineStrong: "rgba(255,255,255,0.17)",
    panel: "rgba(255,255,255,0.055)",
    panelBorder: "rgba(255,255,255,0.105)",
    panelShadow: "inset 0 1px 0 rgba(255,255,255,0.12)",
    track: "rgba(255,255,255,0.1)",
    barFrom: "#22d3ee",
    barTo: "#8b5cf6",
    chrome: "starfield",
    swatch: ["#0b1021", "#22d3ee", "#8b5cf6"],
    labelSpacing: 0.18,
    labelWeight: 600,
    ruleColor: rgba("#22d3ee", 0.4),
    ruleH: 1,
    separator: "·",
    brandBg: "#22d3ee",
    brandInk: "#061224",
    radius: 20,
    gridStep: 0,
    gridColor: "transparent",
    frame: null,
    barcode: null,
  },
  monolith: {
    id: "monolith",
    name: "Carbon Gold",
    blurb: "Matte carbon · champagne gold",
    canvas: "#0a0a0a",
    background: `radial-gradient(104% 64% at 50% -12%, ${rgba("#e5c158", 0.13)} 0%, ${rgba("#0a0a0a", 0)} 64%), linear-gradient(164deg, ${rgba("#e5c158", 0.055)} 0%, ${rgba("#0a0a0a", 0)} 38%), linear-gradient(180deg, #0d0d0d 0%, #0a0a0a 54%, #070707 100%)`,
    ink: "#f6f0e2",
    dim: "#c0b393",
    faint: "#7f745a",
    accent: "#e5c158",
    accent2: "#d9a441",
    accentInk: "#211a05",
    heroColor: "#f4e6b8",
    heroGlow: "0 0 30px rgba(229, 193, 88, 0.22)",
    heroWeight: 700,
    line: "rgba(229,193,88,0.16)",
    lineStrong: "rgba(229,193,88,0.32)",
    panel: "rgba(229,193,88,0.045)",
    panelBorder: "rgba(229,193,88,0.15)",
    panelShadow: "inset 0 1px 0 rgba(229,193,88,0.1)",
    track: "rgba(229,193,88,0.14)",
    barFrom: "#b8862e",
    barTo: "#e5c158",
    chrome: "frame",
    swatch: ["#0a0a0a", "#e5c158", "#d9a441"],
    labelSpacing: 0.2,
    labelWeight: 600,
    ruleColor: rgba("#e5c158", 0.38),
    ruleH: 1,
    separator: "·",
    brandBg: "#e5c158",
    brandInk: "#1a1405",
    radius: 14,
    gridStep: 0,
    gridColor: "transparent",
    frame: {
      outer: rgba("#e5c158", 0.2),
      inner: rgba("#e5c158", 0.08),
      tick: rgba("#e5c158", 0.55),
    },
    barcode: null,
  },
};

/* ------------------------------------------------------------------ */
/* Style helpers                                                       */
/* ------------------------------------------------------------------ */

export const DEFAULT_LAYERS: LayerFlags = {
  sparkline: true,
  models: true,
  bento: true,
};

/** Frosted panel cell — inset highlight only, never `backdrop-filter`. */
export function panelCss(theme: CardTheme, radius: number): CSSProperties {
  return {
    background: theme.panel,
    border: `1px solid ${theme.panelBorder}`,
    boxShadow: theme.panelShadow,
    borderRadius: radius,
  };
}

export function labelCss(
  theme: CardTheme,
  fontSize: number,
  color?: string,
  weight?: number,
): CSSProperties {
  return {
    fontFamily: FONT_MONO,
    fontSize,
    lineHeight: 1,
    letterSpacing: `${theme.labelSpacing}em`,
    textTransform: "uppercase",
    fontWeight: weight ?? theme.labelWeight,
    color: color ?? theme.faint,
    whiteSpace: "nowrap",
  };
}

export function numCss(fontSize: number, color: string, weight = 500): CSSProperties {
  return {
    fontFamily: FONT_MONO,
    fontSize,
    lineHeight: 1,
    color,
    fontWeight: weight,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  };
}
