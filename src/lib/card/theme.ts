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
    name: "Obsidian Emerald",
    blurb: "Carbon canvas · emerald luminance",
    canvas: "#08090c",
    background: `radial-gradient(88% 66% at 100% 0%, ${rgba("#34d399", 0.2)} 0%, ${rgba("#059669", 0.07)} 36%, rgba(8,9,12,0) 70%), radial-gradient(70% 55% at -4% 104%, ${rgba("#0f766e", 0.13)} 0%, rgba(8,9,12,0) 66%), linear-gradient(180deg, #0a0c11 0%, #08090c 46%, #06070a 100%)`,
    ink: "#f4f5f7",
    dim: "#a7adba",
    faint: "#616874",
    accent: "#34d399",
    accent2: "#14b8a6",
    accentInk: "#04241a",
    heroColor: "#34d399",
    heroGlow: "0 0 34px rgba(52, 211, 153, 0.38)",
    heroWeight: 700,
    line: "rgba(255,255,255,0.07)",
    lineStrong: "rgba(255,255,255,0.14)",
    panel: "rgba(255,255,255,0.035)",
    panelBorder: "rgba(255,255,255,0.075)",
    panelShadow: "inset 0 1px 0 rgba(255,255,255,0.055)",
    track: "rgba(255,255,255,0.08)",
    barFrom: "#34d399",
    barTo: "#14b8a6",
    chrome: "grid",
    swatch: ["#08090c", "#34d399", "#14b8a6"],
    labelSpacing: 0.16,
    labelWeight: 600,
    ruleColor: rgba("#34d399", 0.5),
    ruleH: 1,
    separator: "·",
    brandBg: "#34d399",
    brandInk: "#04241a",
    radius: 18,
    gridStep: 24,
    gridColor: "rgba(255,255,255,0.042)",
    frame: null,
    barcode: null,
  },
  editorial: {
    id: "editorial",
    name: "Editorial Brutalist",
    blurb: "Bone paper · vermilion rules",
    canvas: "#eae5da",
    background:
      "radial-gradient(130% 110% at 50% -12%, #f1ece3 0%, #eae5da 46%, #ded7c7 100%)",
    ink: "#0f0f0e",
    dim: "rgba(15,15,14,0.68)",
    faint: "rgba(15,15,14,0.44)",
    accent: "#ef4b2a",
    accent2: "#0f0f0e",
    accentInk: "#fff7f3",
    heroColor: "#0f0f0e",
    heroGlow: "none",
    heroWeight: 800,
    line: "rgba(15,15,14,0.13)",
    lineStrong: "rgba(15,15,14,0.3)",
    panel: "rgba(15,15,14,0.04)",
    panelBorder: "rgba(15,15,14,0.15)",
    panelShadow: "none",
    track: "rgba(15,15,14,0.14)",
    barFrom: "#0f0f0e",
    barTo: "#ef4b2a",
    chrome: "brutalist",
    swatch: ["#eae5da", "#0f0f0e", "#ef4b2a"],
    labelSpacing: 0.22,
    labelWeight: 700,
    ruleColor: "#ef4b2a",
    ruleH: 4,
    separator: "/",
    brandBg: "#0f0f0e",
    brandInk: "#eae5da",
    radius: 4,
    gridStep: 0,
    gridColor: "transparent",
    frame: null,
    barcode: { bar: "rgba(15,15,14,0.82)", dim: "rgba(15,15,14,0.3)" },
  },
  aurora: {
    id: "aurora",
    name: "Midnight Aurora",
    blurb: "Cosmos mesh · frosted bento",
    canvas: "#05070d",
    background: `radial-gradient(56% 42% at 16% 6%, ${rgba("#22d3ee", 0.3)} 0%, rgba(5,7,13,0) 66%), radial-gradient(52% 40% at 88% 14%, ${rgba("#6366f1", 0.3)} 0%, rgba(5,7,13,0) 68%), radial-gradient(66% 46% at 58% 102%, ${rgba("#14b8a6", 0.26)} 0%, rgba(5,7,13,0) 70%), radial-gradient(122% 104% at 50% 42%, rgba(5,7,13,0) 38%, rgba(5,7,13,0.9) 100%), #05070d`,
    ink: "#eef8fc",
    dim: "#a3b9c8",
    faint: "#65808f",
    accent: "#22d3ee",
    accent2: "#14b8a6",
    accentInk: "#04252b",
    heroColor: "#eafcff",
    heroGlow: "0 0 36px rgba(34, 211, 238, 0.45)",
    heroWeight: 700,
    line: "rgba(255,255,255,0.08)",
    lineStrong: "rgba(255,255,255,0.16)",
    panel: "rgba(255,255,255,0.05)",
    panelBorder: "rgba(255,255,255,0.095)",
    panelShadow: "inset 0 1px 0 rgba(255,255,255,0.12)",
    track: "rgba(255,255,255,0.1)",
    barFrom: "#22d3ee",
    barTo: "#14b8a6",
    chrome: "starfield",
    swatch: ["#05070d", "#22d3ee", "#6366f1"],
    labelSpacing: 0.18,
    labelWeight: 600,
    ruleColor: rgba("#22d3ee", 0.4),
    ruleH: 1,
    separator: "·",
    brandBg: "#22d3ee",
    brandInk: "#04252b",
    radius: 20,
    gridStep: 0,
    gridColor: "transparent",
    frame: null,
    barcode: null,
  },
  monolith: {
    id: "monolith",
    name: "Monolith Gold",
    blurb: "Carbon · champagne hairlines",
    canvas: "#09090b",
    background: `radial-gradient(102% 62% at 50% -10%, ${rgba("#eab308", 0.14)} 0%, rgba(9,9,11,0) 62%), linear-gradient(168deg, ${rgba("#eab308", 0.06)} 0%, rgba(9,9,11,0) 38%), linear-gradient(180deg, #0b0b0d 0%, #09090b 52%, #070708 100%)`,
    ink: "#f8f4e9",
    dim: "#bdb297",
    faint: "#7d7259",
    accent: "#eab308",
    accent2: "#fbbf24",
    accentInk: "#241a02",
    heroColor: "#f8e9b0",
    heroGlow: "0 0 30px rgba(234, 179, 8, 0.26)",
    heroWeight: 700,
    line: "rgba(234,179,8,0.2)",
    lineStrong: "rgba(234,179,8,0.36)",
    panel: "rgba(234,179,8,0.05)",
    panelBorder: "rgba(234,179,8,0.17)",
    panelShadow: "inset 0 1px 0 rgba(234,179,8,0.12)",
    track: "rgba(234,179,8,0.15)",
    barFrom: "#b45309",
    barTo: "#fbbf24",
    chrome: "frame",
    swatch: ["#09090b", "#b45309", "#fbbf24"],
    labelSpacing: 0.2,
    labelWeight: 600,
    ruleColor: rgba("#eab308", 0.4),
    ruleH: 1,
    separator: "◆",
    brandBg: "linear-gradient(140deg, #b45309 0%, #eab308 52%, #fbbf24 100%)",
    brandInk: "#1a1204",
    radius: 14,
    gridStep: 0,
    gridColor: "transparent",
    frame: {
      outer: rgba("#eab308", 0.22),
      inner: rgba("#eab308", 0.12),
      tick: rgba("#eab308", 0.6),
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
