/**
 * Shareable PNG Card Studio.
 *
 * Left: studio controls (aspect / theme / hero metric / handle / layers / export).
 * Right: a live preview of a card that is authored at exact integer capture
 * dimensions (540×540, 420×746, 680×382 CSS px) and only *visually* scaled by a
 * transform on the outer preview wrapper — so `cardRef` always renders a
 * pixel-exact node at 3× for a 1620×1620 / 1260×2238 / 2040×1146 PNG.
 *
 * The card interior is 100% inline CSS + inline SVG: no external images, no
 * backdrop-filter, no Tailwind class dependence, fully deterministic.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { toBlob, toPng } from "html-to-image";
import {
  ArrowClockwise,
  Check,
  Coins,
  Copy,
  CornersOut,
  Cpu,
  DownloadSimple,
  Fire,
  Lightning,
  Palette,
  ShareNetwork,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import type { UsageSnapshotDTO } from "../lib/tauri";
import { fmtCost, fmtPct, fmtTokens } from "../lib/format";
import {
  ASPECTS,
  ASPECT_ORDER,
  DEFAULT_LAYERS,
  FONT_DISPLAY,
  FONT_MONO,
  FONT_SANS,
  LAYOUTS,
  THEMES,
  THEME_ORDER,
  labelCss,
  numCss,
  panelCss,
  rightColumnWidth,
} from "../lib/card/theme";
import type {
  AspectId,
  CardLayout,
  CardTheme,
  HeroMetric,
  LayerFlags,
  ThemeId,
} from "../lib/card/types";
import {
  barcodeBars,
  barcodeWidth,
  clamp,
  estimateTextW,
  fitHero,
  rgba,
  sparkGeometry,
  starPoints,
} from "../lib/card/geometry";
import { buildCardData, dayLabel, packClients, prettyModel } from "../lib/card/data";
import type { CardData, ClientStat, ModelStat } from "../lib/card/data";

/* ------------------------------------------------------------------ */
/* Card building blocks                                                */
/* ------------------------------------------------------------------ */

function Label({
  theme,
  size,
  color,
  weight,
  children,
}: {
  theme: CardTheme;
  size: number;
  color?: string;
  weight?: number;
  children: ReactNode;
}) {
  return <span style={labelCss(theme, size, color, weight)}>{children}</span>;
}

function CardHeader({
  data,
  theme,
  layout,
  handle,
  platform,
}: {
  data: CardData;
  theme: CardTheme;
  layout: CardLayout;
  handle: string;
  platform: string;
}) {
  return (
    <div
      style={{
        height: layout.headerH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            style={{
              width: layout.brandMark,
              height: layout.brandMark,
              borderRadius: theme.id === "editorial" ? 3 : Math.round(layout.brandMark * 0.3),
              background: theme.brandBg,
              color: theme.brandInk,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: FONT_DISPLAY,
              fontWeight: 800,
              fontSize: Math.round(layout.brandMark * 0.56),
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            T
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span
              style={{
                fontFamily: FONT_SANS,
                fontWeight: 700,
                fontSize: layout.brandFont,
                letterSpacing: "0.2em",
                color: theme.ink,
                lineHeight: 1,
                whiteSpace: "nowrap",
              }}
            >
              TOKENTRACKER
            </span>
            <Label theme={theme} size={Math.max(6.5, layout.labelFont - 1)}>
              AI usage telemetry
            </Label>
          </span>
          {handle ? (
            <span
              style={{
                marginLeft: 2,
                padding: `${Math.round(layout.pillFont * 0.3)}px ${Math.round(layout.pillFont * 0.7)}px`,
                borderRadius: 999,
                border: `1px solid ${theme.lineStrong}`,
                background: theme.panel,
                color: theme.ink,
                fontFamily: FONT_MONO,
                fontSize: layout.pillFont,
                lineHeight: 1.1,
                letterSpacing: "0.04em",
                whiteSpace: "nowrap",
                maxWidth: (layout.twoCol ? 120 : 190),
                overflow: "hidden",
                textOverflow: "ellipsis",
                flexShrink: 1,
              }}
            >
              {handle}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
          <span style={numCss(layout.dateFont, theme.dim, 500)}>{data.rangeLabel}</span>
          <Label theme={theme} size={Math.max(6.5, layout.labelFont - 1)}>
            {layout.twoCol ? platform : `${data.activeDays} active days`}
          </Label>
        </div>
      </div>
      <div style={{ height: theme.ruleH, background: theme.ruleColor, flexShrink: 0 }} />
    </div>
  );
}

function CardHero({
  data,
  theme,
  layout,
  width,
}: {
  data: CardData;
  theme: CardTheme;
  layout: CardLayout;
  width: number;
}) {
  const fit = fitHero({
    num: data.hasData ? data.heroNum : "$0.00",
    unit: data.hasData ? data.heroUnit : "",
    availW: width - 4,
    availH: layout.heroH,
    cap: layout.heroCap,
  });
  const num = data.hasData ? data.heroNum : "—";
  const unit = data.hasData ? data.heroUnit : "";
  return (
    <div
      style={{
        height: layout.heroLabelH + layout.heroH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: layout.heroLabelH,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          overflow: "hidden",
        }}
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, overflow: "hidden" }}>
          <Label theme={theme} size={layout.heroLabelFont} color={theme.dim}>
            {data.heroLabel}
          </Label>
          <Label theme={theme} size={Math.max(6.5, layout.heroLabelFont - 0.5)}>
            {data.heroHint}
          </Label>
        </span>
        <span
          style={{
            padding: `${Math.round(layout.pillFont * 0.36)}px ${Math.round(layout.pillFont * 0.78)}px`,
            borderRadius: 999,
            background: theme.accent,
            color: theme.accentInk,
            fontFamily: FONT_MONO,
            fontSize: layout.pillFont,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            lineHeight: 1.15,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {data.secondary}
        </span>
      </div>
      {/* glow must be able to bleed past the numeral box — no overflow clipping here */}
      <div style={{ height: layout.heroH, display: "flex", alignItems: "flex-end" }}>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: fit.size,
            lineHeight: 1.02,
            fontWeight: theme.heroWeight,
            color: theme.heroColor,
            textShadow: theme.heroGlow,
            letterSpacing: "-0.025em",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {num}
          {unit ? (
            <span
              style={{
                fontSize: fit.unitSize,
                fontWeight: 600,
                color: theme.accent,
                marginLeft: Math.round(fit.size * 0.07),
                letterSpacing: "0",
              }}
            >
              {unit}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function SparkBlock({
  data,
  theme,
  layout,
  width,
  metric,
  uid,
}: {
  data: CardData;
  theme: CardTheme;
  layout: CardLayout;
  width: number;
  metric: HeroMetric;
  uid: string;
}) {
  const geom = useMemo(() => {
    const isTokens = metric === "tokens";
    return sparkGeometry({
      values: data.chartValues,
      dates: data.chart.map((c) => c.to),
      width,
      height: layout.sparkH,
      labelFont: layout.sparkFont,
      peakIndex: data.peakIndex,
      peakDate: data.peak?.date ?? null,
      fmtValue: (n) => (isTokens ? fmtTokens(n) : fmtCost(n)),
      fmtDate: (d) => dayLabel(d),
    });
  }, [data, layout.sparkH, layout.sparkFont, metric, width]);

  const hasSeries = data.chartValues.length > 1;

  return (
    <div
      style={{
        height: layout.sparkLabelH + layout.sparkH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: layout.sparkLabelH,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Label theme={theme} size={layout.labelFont} color={theme.dim}>
          Activity rhythm
        </Label>
        <Label theme={theme} size={Math.max(6.5, layout.labelFont - 0.5)}>
          {`${data.windowDays}d · ${data.activeDays} active`}
        </Label>
      </div>
      {hasSeries ? (
        <svg
          width={width}
          height={layout.sparkH}
          viewBox={`0 0 ${width} ${layout.sparkH}`}
          style={{ display: "block" }}
          aria-hidden
          focusable="false"
        >
          <defs>
            <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.accent} stopOpacity={0.36} />
              <stop offset="100%" stopColor={theme.accent} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={`${uid}-line`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={theme.accent} />
              <stop offset="100%" stopColor={theme.accent2} />
            </linearGradient>
          </defs>

          <line
            x1={0}
            y1={geom.avgY}
            x2={width}
            y2={geom.avgY}
            stroke={theme.dim}
            strokeOpacity={0.42}
            strokeWidth={1}
            strokeDasharray="3 4"
          />
          <text
            x={1}
            y={Math.max(geom.avgY - 4, 6)}
            fill="none"
            stroke={theme.canvas}
            strokeWidth={2.6}
            strokeLinejoin="round"
            fontSize={layout.sparkFont - 0.5}
            fontFamily={FONT_MONO}
            letterSpacing="0.08em"
          >
            {`AVG ${geom.avgLabel}`}
          </text>
          <text
            x={1}
            y={Math.max(geom.avgY - 4, 6)}
            fill={theme.faint}
            fontSize={layout.sparkFont - 0.5}
            fontFamily={FONT_MONO}
            letterSpacing="0.08em"
          >
            {`AVG ${geom.avgLabel}`}
          </text>

          <path d={geom.areaPath} fill={`url(#${uid}-area)`} />
          <path
            d={geom.linePath}
            fill="none"
            stroke={`url(#${uid}-line)`}
            strokeWidth={layout.sparkStroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {geom.peak ? (
            <>
              <line
                x1={geom.peak.x}
                y1={geom.peak.y}
                x2={geom.peak.x}
                y2={geom.curveBottom}
                stroke={theme.accent}
                strokeOpacity={0.3}
                strokeWidth={1}
                strokeDasharray="2 3"
              />
              <circle
                cx={geom.peak.x}
                cy={geom.peak.y}
                r={6}
                fill="none"
                stroke={theme.accent}
                strokeOpacity={0.3}
                strokeWidth={1}
              />
              <circle cx={geom.peak.x} cy={geom.peak.y} r={2.9} fill={theme.accent} />
              <text
                x={geom.peak.tx}
                y={geom.peak.ty}
                textAnchor={geom.peak.anchor}
                fill="none"
                stroke={theme.canvas}
                strokeWidth={2.6}
                strokeLinejoin="round"
                fontSize={layout.sparkFont}
                fontWeight={600}
                fontFamily={FONT_MONO}
                letterSpacing="0.1em"
              >
                {geom.peak.label}
              </text>
              <text
                x={geom.peak.tx}
                y={geom.peak.ty}
                textAnchor={geom.peak.anchor}
                fill={theme.accent}
                fontSize={layout.sparkFont}
                fontWeight={600}
                fontFamily={FONT_MONO}
                letterSpacing="0.1em"
              >
                {geom.peak.label}
              </text>
            </>
          ) : null}

          {geom.bars.map((b, i) => (
            <rect
              key={i}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={1}
              fill={b.peak ? theme.accent : theme.accent2}
              opacity={b.active ? (b.peak ? 0.95 : 0.5) : 0.16}
            />
          ))}

          <text
            x={0}
            y={layout.sparkH - 0.5}
            fill="none"
            stroke={theme.canvas}
            strokeWidth={2.4}
            strokeLinejoin="round"
            fontSize={layout.sparkFont - 0.5}
            fontFamily={FONT_MONO}
            letterSpacing="0.08em"
          >
            {geom.startLabel}
          </text>
          <text
            x={0}
            y={layout.sparkH - 0.5}
            fill={theme.faint}
            fontSize={layout.sparkFont - 0.5}
            fontFamily={FONT_MONO}
            letterSpacing="0.08em"
          >
            {geom.startLabel}
          </text>
          <text
            x={width}
            y={layout.sparkH - 0.5}
            textAnchor="end"
            fill="none"
            stroke={theme.canvas}
            strokeWidth={2.4}
            strokeLinejoin="round"
            fontSize={layout.sparkFont - 0.5}
            fontFamily={FONT_MONO}
            letterSpacing="0.08em"
          >
            {geom.endLabel}
          </text>
          <text
            x={width}
            y={layout.sparkH - 0.5}
            textAnchor="end"
            fill={theme.faint}
            fontSize={layout.sparkFont - 0.5}
            fontFamily={FONT_MONO}
            letterSpacing="0.08em"
          >
            {geom.endLabel}
          </text>
        </svg>
      ) : (
        <div
          style={{
            height: layout.sparkH,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderTop: `1px dashed ${theme.line}`,
            borderBottom: `1px dashed ${theme.line}`,
          }}
        >
          <Label theme={theme} size={layout.labelFont}>
            no daily series in range
          </Label>
        </div>
      )}
    </div>
  );
}

function ClientsRow({
  data,
  theme,
  layout,
  width,
}: {
  data: CardData;
  theme: CardTheme;
  layout: CardLayout;
  width: number;
}) {
  const compact = width < 320;
  const labelText = compact ? "Mix" : "Client mix";
  const labelW = estimateTextW(labelText, layout.labelFont, theme.labelSpacing) + 6;
  const { shown, rest } = compact
    ? packClients(data.clients, width, layout.clientFont, labelW, 9, "plain")
    : packClients(data.clients, width, layout.clientFont, labelW, 5, "pill");

  const pill = (key: string, children: ReactNode) => (
    <span
      key={key}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: layout.clientsH - 4,
        padding: `0 ${Math.round(layout.clientFont * 0.6)}px`,
        ...panelCss(theme, 999),
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );

  const dot = (hex: string) => (
    <span style={{ width: 5, height: 5, borderRadius: 999, background: hex, flexShrink: 0 }} />
  );

  const sep = (
    <span style={{ fontFamily: FONT_MONO, fontSize: layout.clientFont - 1, color: theme.lineStrong }}>
      {theme.separator}
    </span>
  );

  return (
    <div
      style={{
        height: layout.clientsH,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: compact ? 9 : 6,
        overflow: "hidden",
      }}
    >
      <Label theme={theme} size={layout.labelFont} color={theme.dim}>
        {labelText}
      </Label>
      {shown.map((c: ClientStat, i: number) =>
        compact ? (
          <span
            key={c.id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {i > 0 ? sep : null}
            {dot(c.hex)}
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: layout.clientFont,
                color: theme.dim,
                letterSpacing: "0.03em",
              }}
            >
              {c.label}
            </span>
            <span style={{ ...numCss(layout.clientFont, theme.ink, 600) }}>{fmtPct(c.share)}</span>
          </span>
        ) : (
          pill(
            c.id,
            <>
              {dot(c.hex)}
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: layout.clientFont,
                  color: theme.dim,
                  letterSpacing: "0.03em",
                }}
              >
                {c.label}
              </span>
              <span style={{ ...numCss(layout.clientFont, theme.ink, 600) }}>{fmtPct(c.share)}</span>
            </>,
          )
        ),
      )}
      {rest > 0 ? (
        compact ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {sep}
            <span style={{ ...numCss(layout.clientFont, theme.faint, 600) }}>{`+${rest}`}</span>
          </span>
        ) : (
          pill(
            "__rest",
            <>
              <span style={{ ...numCss(layout.clientFont, theme.faint, 600) }}>{`+${rest}`}</span>
            </>,
          )
        )
      ) : null}
    </div>
  );
}

function ModelRows({
  data,
  theme,
  layout,
  width,
}: {
  data: CardData;
  theme: CardTheme;
  layout: CardLayout;
  width: number;
}) {
  const rows: ModelStat[] = data.models.slice(0, layout.modelRows);
  const labelW = 34;

  return (
    <div
      style={{
        height: layout.modelLabelH + layout.modelRows * layout.modelRowH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: layout.modelLabelH,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Label theme={theme} size={layout.labelFont} color={theme.dim}>
          {data.metric === "tokens" ? "Model dominance" : "Spend by model"}
        </Label>
        <Label theme={theme} size={Math.max(6.5, layout.labelFont - 0.5)}>
          {`top ${rows.length} of ${data.models.length}`}
        </Label>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        {rows.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center" }}>
            <Label theme={theme} size={layout.labelFont}>
              no model rows in range
            </Label>
          </div>
        ) : null}
        {rows.map((m) => (
          <div
            key={m.key}
            style={{
              height: layout.modelRowH,
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-start",
              gap: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0 }}>
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  background: m.hex,
                  flexShrink: 0,
                  transform: "translateY(-1px)",
                }}
              />
              <span
                style={{
                  fontFamily: FONT_SANS,
                  fontSize: layout.nameFont,
                  fontWeight: 500,
                  color: theme.ink,
                  lineHeight: 1.2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                  flex: "1 1 auto",
                }}
                title={m.model}
              >
                {prettyModel(m.short)}
              </span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: Math.max(6.5, layout.clientFont - 0.5),
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: theme.dim,
                  border: `1px solid ${theme.panelBorder}`,
                  borderRadius: 999,
                  padding: `1px ${Math.round(layout.clientFont * 0.5)}px`,
                  flexShrink: 0,
                  lineHeight: 1.2,
                }}
              >
                {m.clientLabel}
              </span>
              <span style={{ ...numCss(layout.valueFont, theme.ink, 600), flexShrink: 0 }}>
                {fmtTokens(m.tokens)}
              </span>
              <span style={{ ...numCss(layout.valueFont - 0.5, theme.faint, 500), flexShrink: 0 }}>
                {fmtCost(m.cost)}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  flex: "1 1 auto",
                  height: 3.5,
                  borderRadius: 999,
                  background: theme.track,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.max(1.5, Math.min(100, m.share * 100))}%`,
                    height: "100%",
                    borderRadius: 999,
                    background: `linear-gradient(90deg, ${theme.barFrom}, ${theme.barTo})`,
                  }}
                />
              </div>
              <span
                style={{
                  ...numCss(layout.valueFont - 0.5, theme.accent, 600),
                  width: labelW,
                  textAlign: "right",
                  flexShrink: 0,
                }}
              >
                {fmtPct(m.share)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BentoGrid({
  data,
  theme,
  layout,
  width,
  stretch,
}: {
  data: CardData;
  theme: CardTheme;
  layout: CardLayout;
  width: number;
  stretch: boolean;
}) {
  const cols = layout.bentoRows === 1 ? 4 : 2;
  const rows = Math.ceil(data.bento.length / cols);
  const height = stretch ? undefined : rows * layout.bentoCellH + (rows - 1) * layout.bentoGap;

  return (
    <div
      style={{
        width,
        height,
        flex: stretch ? "1 1 auto" : "0 0 auto",
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: "minmax(0, 1fr)",
        gap: layout.bentoGap,
      }}
    >
      {data.bento.map((cell) => (
        <div
          key={cell.label}
          style={{
            ...panelCss(theme, Math.max(6, theme.radius - 8)),
            padding: `${Math.round(layout.bentoLabelFont * 0.78)}px ${Math.round(layout.bentoLabelFont * 1.05)}px`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <Label theme={theme} size={layout.bentoLabelFont} color={theme.faint}>
            {cell.label}
          </Label>
          <span
            style={{
              ...numCss(layout.bentoValueFont, theme.ink, 600),
              letterSpacing: "-0.02em",
            }}
          >
            {cell.value}
          </span>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: layout.bentoSubFont,
              lineHeight: 1.05,
              color: theme.faint,
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {cell.sub}
          </span>
        </div>
      ))}
    </div>
  );
}

function CardFooter({
  data,
  theme,
  layout,
  width,
}: {
  data: CardData;
  theme: CardTheme;
  layout: CardLayout;
  width: number;
}) {
  const bars = useMemo(
    () => barcodeBars(data.seed, 26, 1, 1.6, layout.footerH - 11),
    [data.seed, layout.footerH],
  );
  const smallBars = useMemo(
    () => barcodeBars(`${data.seed}-mini`, 14, 1, 1.5, layout.footerH - 13),
    [data.seed, layout.footerH],
  );

  // Adaptive footer: reserve the streak badge + signature, then fit the ticker
  // or the spec stamp into whatever is actually left over.
  const streakLabel = `${data.streak}D STREAK`;
  const sigLabel = "tokentracker";
  const streakW = estimateTextW(streakLabel, layout.footerFont, 0.08) + layout.footerFont * 2.6 + 5;
  const rightW =
    estimateTextW(data.exportDate, layout.footerFont, 0) +
    estimateTextW(sigLabel, layout.footerFont, 0.06) +
    layout.footerFont * 1.2;
  const centerW = Math.max(40, width - streakW - rightW - 16);

  const showStamp = theme.chrome === "brutalist";
  const stampFull = "TOKENTRACKER // TELEMETRY SPEC";
  const stampShort = "TELEMETRY SPEC";
  const stampFullW = estimateTextW(stampFull, layout.stampFont, theme.labelSpacing);
  const stampShortW = estimateTextW(stampShort, layout.stampFont, theme.labelSpacing);

  const barsW = barcodeWidth(bars, 1.6);
  const smallBarsW = barcodeWidth(smallBars, 1.5);
  const stamp =
    barsW + 7 + stampFullW <= centerW
      ? { bars, w: barsW, text: stampFull }
      : smallBarsW + 6 + stampShortW <= centerW
        ? { bars: smallBars, w: smallBarsW, text: stampShort }
        : null;

  const parts = useMemo(() => {
    const out: string[] = [];
    let used = 0;
    for (const p of data.footerParts) {
      const w = estimateTextW(p, layout.footerFont, 0.05) + (out.length > 0 ? layout.footerFont * 1.6 : 0);
      if (out.length > 0 && used + w > centerW) break;
      out.push(p);
      used += w;
    }
    return out;
  }, [data.footerParts, layout.footerFont, centerW]);

  return (
    <div
      style={{
        height: layout.footerH,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: `${Math.round(layout.footerFont * 0.36)}px ${Math.round(layout.footerFont * 0.78)}px`,
          borderRadius: 999,
          background: rgba(theme.accent, 0.12),
          border: `1px solid ${rgba(theme.accent, 0.34)}`,
          flexShrink: 0,
        }}
      >
        <Fire size={layout.footerFont + 1.5} weight="fill" color={theme.accent} />
        <span
          style={{
            ...numCss(layout.footerFont, theme.accent, 700),
            letterSpacing: "0.08em",
          }}
        >
          {`${data.streak}D STREAK`}
        </span>
      </span>

      {showStamp ? (
        stamp ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0, overflow: "hidden" }}>
            <svg width={stamp.w} height={layout.footerH - 11} style={{ display: "block", flexShrink: 0 }} aria-hidden>
              {stamp.bars.map((b, i) => (
                <rect
                  key={i}
                  x={b.x}
                  y={(layout.footerH - 11 - b.h) / 2}
                  width={b.w}
                  height={b.h}
                  fill={i % 4 === 0 ? theme.barcode?.bar : theme.barcode?.dim}
                />
              ))}
            </svg>
            <span style={labelCss(theme, layout.stampFont, theme.ink, 700)}>{stamp.text}</span>
          </span>
        ) : (
          <span />
        )
      ) : (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {parts.map((part, i) => (
            <span key={part} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {i > 0 ? (
                <span style={{ fontFamily: FONT_MONO, fontSize: layout.footerFont - 1, color: theme.accent }}>
                  {theme.separator}
                </span>
              ) : null}
              <span
                style={{
                  ...numCss(layout.footerFont, theme.faint, 500),
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                }}
              >
                {part}
              </span>
            </span>
          ))}
        </span>
      )}

      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
        <span style={{ ...numCss(layout.footerFont, theme.faint, 500) }}>{data.exportDate}</span>
        <span style={{ fontFamily: FONT_MONO, fontSize: layout.footerFont - 1, color: theme.lineStrong }}>
          ·
        </span>
        <span
          style={{
            fontFamily: FONT_SANS,
            fontSize: layout.footerFont,
            fontWeight: 600,
            letterSpacing: "0.06em",
            color: theme.dim,
          }}
        >
          tokentracker
        </span>
      </span>
    </div>
  );
}

function Chrome({
  theme,
  layout,
  w,
  h,
  seed,
}: {
  theme: CardTheme;
  layout: CardLayout;
  w: number;
  h: number;
  seed: string;
}) {
  if (theme.chrome === "grid") {
    const step = theme.gridStep;
    const o = 11;
    const len = 16;
    return (
      <svg
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        aria-hidden
        focusable="false"
      >
        <defs>
          <pattern id="ttc-grid" width={step} height={step} patternUnits="userSpaceOnUse">
            <path
              d={`M ${step} 0 L 0 0 0 ${step}`}
              fill="none"
              stroke={theme.gridColor}
              strokeWidth={1}
            />
          </pattern>
          <linearGradient id="ttc-grid-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="0.6" stopColor="#ffffff" stopOpacity="0.4" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0.08" />
          </linearGradient>
          <mask id="ttc-grid-mask">
            <rect x="0" y="0" width={w} height={h} fill="url(#ttc-grid-fade)" />
          </mask>
        </defs>
        <rect x="0" y="0" width={w} height={h} fill="url(#ttc-grid)" mask="url(#ttc-grid-mask)" />
        <g stroke={rgba(theme.accent, 0.5)} strokeWidth={1.5} fill="none" strokeLinecap="square">
          <path d={`M ${o} ${o + len} L ${o} ${o} L ${o + len} ${o}`} />
          <path d={`M ${w - o - len} ${o} L ${w - o} ${o} L ${w - o} ${o + len}`} />
          <path d={`M ${o} ${h - o - len} L ${o} ${h - o} L ${o + len} ${h - o}`} />
          <path d={`M ${w - o - len} ${h - o} L ${w - o} ${h - o} L ${w - o} ${h - o - len}`} />
        </g>
      </svg>
    );
  }

  if (theme.chrome === "brutalist") {
    const p = layout.pad;
    const iw = w - p * 2;
    const ih = h - p * 2;
    const verts = [1, 2, 3].map((i) => p + (iw * i) / 4);
    const hors = [1, 2].map((i) => p + (ih * i) / 3);
    const mark = 7;
    const off = 9;
    return (
      <svg
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        aria-hidden
        focusable="false"
      >
        <g stroke="rgba(15,15,14,0.075)" strokeWidth={1}>
          {verts.map((x, i) => (
            <line key={`v${i}`} x1={x} y1={p * 0.5} x2={x} y2={h - p * 0.5} />
          ))}
          {hors.map((y, i) => (
            <line key={`h${i}`} x1={p * 0.45} y1={y} x2={w - p * 0.45} y2={y} />
          ))}
        </g>
        <g stroke="rgba(15,15,14,0.55)" strokeWidth={1} strokeLinecap="butt">
          {[
            [off, off],
            [w - off, off],
            [off, h - off],
            [w - off, h - off],
          ].map(([x, y], i) => (
            <g key={i}>
              <line x1={x - mark} y1={y} x2={x + mark} y2={y} />
              <line x1={x} y1={y - mark} x2={x} y2={y + mark} />
            </g>
          ))}
        </g>
      </svg>
    );
  }

  if (theme.chrome === "starfield") {
    const stars = starPoints(seed, Math.round((w * h) / 5000), w, h);
    return (
      <svg
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        aria-hidden
        focusable="false"
      >
        {stars.map((s, i) => (
          <circle
            key={i}
            cx={s.x}
            cy={s.y}
            r={s.r}
            fill={i % 3 === 0 ? theme.accent : "#ffffff"}
            opacity={s.o}
          />
        ))}
      </svg>
    );
  }

  const frame = theme.frame;
  if (!frame) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          inset: 10,
          border: `1px solid ${frame.outer}`,
          borderRadius: Math.max(2, theme.radius - 8),
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 15,
          border: `1px solid ${frame.inner}`,
          borderRadius: Math.max(2, theme.radius - 12),
        }}
      />
      {[
        [10, 10],
        [w - 10, 10],
        [10, h - 10],
        [w - 10, h - 10],
      ].map(([x, y], i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            left: x - 3,
            top: y - 3,
            width: 6,
            height: 6,
            background: frame.tick,
            transform: "rotate(45deg)",
          }}
        />
      ))}
    </div>
  );
}

function EmptyState({ theme, layout }: { theme: CardTheme; layout: CardLayout }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        border: `1px dashed ${theme.lineStrong}`,
        borderRadius: Math.max(6, theme.radius - 8),
      }}
    >
      <Label theme={theme} size={layout.labelFont} color={theme.dim}>
        no activity in this range
      </Label>
      <span style={{ fontFamily: FONT_SANS, fontSize: layout.nameFont, color: theme.faint }}>
        Clear the filters or run a scan to fill this card
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Studio controls                                                     */
/* ------------------------------------------------------------------ */

function Group({
  icon,
  title,
  hint,
  children,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[#1a1b1f]">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#f4f3f8] text-[#0058bc] ring-1 ring-[#e5e5ea]">
            {icon}
          </span>
          {title}
        </span>
        {hint ? (
          <span className="tnum max-w-[45%] truncate text-right font-mono text-[11px] text-ink-3">
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Toggle({
  on,
  onClick,
  children,
  label,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={label ?? (typeof children === "string" ? children : undefined)}
      className="group flex w-full items-center justify-between gap-2 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-2 text-[12px] font-medium text-[#1a1b1f] transition-[transform,opacity,border-color,background-color,color,box-shadow] duration-300 ease-out hover:bg-[#e9e7ed] active:scale-[0.99] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
    >
      <span className="flex items-center gap-2">
        <Cpu size={12} weight="bold" className={on ? "text-[#0070eb]" : "text-[#8e8e93]"} aria-hidden />
        {children}
      </span>
      <span
        aria-hidden
        className={`relative h-[20px] w-9 shrink-0 rounded-full transition-colors duration-300 ease-out motion-reduce:transition-none ${
          on ? "bg-[#0070eb]" : "bg-[#d9d9de]"
        }`}
      >
        <span
          className={`absolute left-[2px] top-[2px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 ease-out motion-reduce:transition-none ${
            on ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

export default function PngCards({ snap }: { snap?: UsageSnapshotDTO }) {
  const [aspectId, setAspectId] = useState<AspectId>("1:1");
  const [themeId, setThemeId] = useState<ThemeId>("obsidian");
  const [metric, setMetric] = useState<HeroMetric>("tokens");
  const [handle, setHandle] = useState("");
  const [layers, setLayers] = useState<LayerFlags>(DEFAULT_LAYERS);
  const [zoom, setZoom] = useState<"fit" | 50 | 100>("fit");
  const [busy, setBusy] = useState<null | "copy" | "download">(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // Which control produced the current status, so the success check only
  // lights the button that actually ran (never both export buttons at once).
  const [lastAction, setLastAction] = useState<null | "copy" | "download">(null);
  const [availW, setAvailW] = useState(0);

  const cardRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  const aspect = ASPECTS[aspectId];
  const layout = LAYOUTS[aspectId];
  const theme = THEMES[themeId];
  const innerW = aspect.w - layout.pad * 2;
  const colRight = rightColumnWidth(aspectId);

  const data = useMemo(
    () => buildCardData(snap, metric, aspect.maxBuckets),
    [snap, metric, aspect.maxBuckets],
  );
  // Sanitized for SVG IRI refs (`url(#…)`) — a raw "1:1" colon in the
  // gradient id failed to resolve under some renderers and dropped the
  // sparkline fill/stroke. Pixel output unchanged: ids are never painted.
  const sparkUid = `ttc-${aspectId.replace(":", "x")}-${themeId}`;

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    // Content-box width: `clientWidth` includes the p-5 gutter, which made the
    // first measurement ~40px too wide and pushed the fitted card past the
    // checker (horizontal squeeze). ResizeObserver already reports the
    // content rect — this only aligns the pre-observer value with it.
    const contentW = () => {
      const cs = getComputedStyle(el);
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    };
    setAvailW(contentW());
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number" && w > 0) setAvailW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const flash = (ok: boolean, text: string) => {
    setStatus({ ok, text });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setStatus(null), 3200);
  };

  /** Click router: remembers which export control fired (for its busy /
   *  success state) and then runs the untouched export routine. */
  const runAction = (action: "copy" | "download", run: () => Promise<void>) => {
    if (busy) return;
    setLastAction(action);
    void run();
  };

  const maxPreviewH = aspectId === "9:16" ? 880 : aspectId === "1:1" ? 620 : 540;
  const fitScale =
    availW > 0 ? clamp(Math.min(availW / aspect.w, maxPreviewH / aspect.h), 0.18, 1) : 0.4;
  const scale = zoom === "fit" ? fitScale : zoom / 100;

  // Capture overrides: neutralize only layout-scale leaks (transform /
  // max-width from the preview scaler). Radius + background stay untouched
  // so the 3× PNG matches the on-screen card — the old `borderRadius: "0"`
  // exported square corners while the preview showed rounded ones.
  const captureStyle: Partial<CSSStyleDeclaration> = {
    transform: "none",
    maxWidth: "none",
  };

  const renderOpts = (skipFonts: boolean) => ({
    pixelRatio: 3,
    backgroundColor: theme.canvas,
    style: captureStyle,
    skipFonts,
  });

  const renderPng = async (node: HTMLElement): Promise<string> => {
    try {
      return await toPng(node, renderOpts(false));
    } catch {
      return await toPng(node, renderOpts(true));
    }
  };

  const renderBlob = async (node: HTMLElement): Promise<Blob> => {
    let blob: Blob | null = null;
    try {
      blob = await toBlob(node, renderOpts(false));
    } catch {
      blob = null;
    }
    if (!blob) blob = await toBlob(node, renderOpts(true));
    if (!blob) throw new Error("renderer returned an empty image");
    return blob;
  };

  const errText = (e: unknown) => {
    const raw = e instanceof Error ? e.message : String(e);
    return raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
  };

  const downloadPng = async () => {
    const node = cardRef.current;
    if (!node || busy) return;
    setBusy("download");
    try {
      const url = await renderPng(node);
      const a = document.createElement("a");
      a.download = `tokentracker-${aspectId.replace(":", "x")}-${data.exportDate}.png`;
      a.href = url;
      a.click();
      flash(true, `${aspect.outW} × ${aspect.outH} PNG exported`);
    } catch (e) {
      flash(false, `Export failed — ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const copyPng = async () => {
    const node = cardRef.current;
    if (!node || busy) return;
    setBusy("copy");
    let blob: Blob | null = null;
    try {
      blob = await renderBlob(node);
      const CI = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      const clip = navigator.clipboard;
      if (!CI || !clip || typeof clip.write !== "function") {
        throw new Error("image clipboard unavailable in this webview");
      }
      await clip.write([new CI({ "image/png": blob })]);
      flash(true, "PNG copied — paste it straight into Instagram or X");
    } catch (e) {
      if (blob) {
        // Same 3× PNG, handed over as a file instead of silently failing.
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.download = `tokentracker-${aspectId.replace(":", "x")}-${data.exportDate}.png`;
        a.href = url;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
        flash(false, `Clipboard blocked (${errText(e)}) — saved the PNG instead`);
      } else {
        flash(false, `Copy failed — ${errText(e)}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const cardStyle: CSSProperties = {
    width: aspect.w,
    height: aspect.h,
    minWidth: aspect.w,
    minHeight: aspect.h,
    maxWidth: "none",
    position: "relative",
    overflow: "hidden",
    borderRadius: theme.radius,
    background: theme.background,
    color: theme.ink,
    fontFamily: FONT_SANS,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: layout.pad,
    boxSizing: "border-box",
    fontVariantNumeric: "tabular-nums",
    WebkitFontSmoothing: "antialiased",
  };

  const content: ReactNode = data.hasData ? (
    <>
      {layers.sparkline ? (
        <SparkBlock
          data={data}
          theme={theme}
          layout={layout}
          width={layout.twoCol ? colRight : innerW}
          metric={metric}
          uid={sparkUid}
        />
      ) : null}
      {layers.models ? (
        <ModelRows data={data} theme={theme} layout={layout} width={layout.twoCol ? colRight : innerW} />
      ) : null}
    </>
  ) : null;

  return (
    <div className="space-y-4 rounded-[24px] border border-[#e5e5ea] bg-[#faf9fe] p-4 text-[#1a1b1f] sm:p-5">
      <style>{`.tt-rise{animation:tt-rise .7s cubic-bezier(0.22,1,0.36,1) both}@keyframes tt-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}.tt-checker{background-image:linear-gradient(to right, rgba(0,0,0,0.035) 1px, transparent 1px),linear-gradient(to bottom, rgba(0,0,0,0.035) 1px, transparent 1px);background-size:16px 16px}@media (prefers-reduced-motion: reduce){.tt-rise{animation:none}}`}</style>
      {/* studio top bar — breadcrumb + resolution + export (mirrors Stitch Share).
          Stacked below lg so the export cluster keeps one row at the 800px
          minimum width (title + cluster side-by-side need ~610px). */}
      <div
        className="tt-rise flex flex-col gap-3 rounded-2xl border border-[#e5e5ea] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)] lg:flex-row lg:items-center lg:justify-between"
        style={{ animationDelay: "0ms" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#0070eb] to-[#0058bc] text-white shadow-sm">
            <ShareNetwork size={16} weight="bold" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-bold tracking-tight text-[#1c1c1e]">
                Share Studio
              </h3>
              <span className="rounded bg-[#0070eb]/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#0058bc]">
                v2.4 EXPORT
              </span>
            </div>
            <p className="mt-0.5 max-w-md truncate text-[12px] leading-relaxed text-ink-3">
              Configure the snapshot, then pull a pixel-exact PNG — rendered locally.
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 lg:gap-2">
          <div
            className="tnum flex items-center gap-0.5 rounded-lg border border-[#e5e5ea] bg-[#f4f3f8] p-0.5 font-mono text-[11px] text-[#414755]"
            role="status"
            aria-label={`Export resolution ${aspect.outW} by ${aspect.outH} pixels`}
          >
            <span className="hidden rounded-md bg-white px-2 py-1 font-semibold text-[#0058bc] shadow-sm ring-1 ring-[#e5e5ea] lg:inline-flex">
              3× PNG
            </span>
            <span className="px-2">
              {aspect.outW} × {aspect.outH}
            </span>
          </div>
          {/* Hierarchy: Download is the primary file action (solid), Copy is
              the secondary convenience (outline) — matches the rail below. */}
          <button
            type="button"
            onClick={() => runAction("copy", copyPng)}
            disabled={busy !== null}
            aria-busy={busy === "copy"}
            aria-label="Copy high-resolution PNG to clipboard"
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[#e5e5ea] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#1c1c1e] transition-all duration-300 ease-out hover:bg-[#f4f3f8] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            {busy === "copy" ? (
              <ArrowClockwise
                size={15}
                weight="bold"
                className="animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : lastAction === "copy" && status?.ok ? (
              <Check size={15} weight="bold" className="text-emerald-600" aria-hidden />
            ) : (
              <Copy size={15} weight="bold" aria-hidden />
            )}
            <span>{busy === "copy" ? "Rendering…" : "Copy PNG"}</span>
          </button>
          <button
            type="button"
            onClick={() => runAction("download", downloadPng)}
            disabled={busy !== null}
            aria-busy={busy === "download"}
            aria-label={`Export PNG bundle at ${aspect.outW} by ${aspect.outH} pixels`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[#0070eb] px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-all duration-300 ease-out hover:bg-[#0058bc] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            {busy === "download" ? (
              <ArrowClockwise
                size={15}
                weight="bold"
                className="animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : lastAction === "download" && status?.ok ? (
              <Check size={15} weight="bold" aria-hidden />
            ) : (
              <DownloadSimple size={15} weight="bold" aria-hidden />
            )}
            <span>{busy === "download" ? "Rendering…" : "Download 3×"}</span>
          </button>
        </div>
      </div>
      {status ? (
        <p
          role="status"
          className={`tt-rise flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px] leading-snug motion-reduce:transition-none ${
            status.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.ok ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          {status.text}
        </p>
      ) : null}
      {/* Below xl the rail stacks full-width; at the 800–1279px window sizes
          that column runs ~950px tall and pushed the preview entirely out of
          view ("rail squeezing the preview"). Preview leads when stacked;
          the 372px rail + preview pairing returns at xl. */}
      <div className="grid items-start gap-4 xl:grid-cols-[372px_minmax(0,1fr)]">
        {/* ---------------- control rail ---------------- */}
        <aside
          aria-label="Card studio controls"
          className="tt-rise order-2 rounded-[20px] border border-[#e5e5ea] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] xl:order-1"
          style={{ animationDelay: "60ms" }}
        >
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-2 border-b border-[#f2f2f7] pb-3">
              <div>
                <h4 className="text-[15px] font-semibold tracking-tight text-[#1c1c1e]">
                  Card Styler
                </h4>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  Configure preview snapshot parameters
                </p>
              </div>
              <span className="rounded bg-[#f4f3f8] px-2 py-0.5 font-mono text-[10px] font-medium text-[#414755]">
                {aspect.label}
              </span>
            </div>

          <Group
            icon={<CornersOut size={12} weight="bold" />}
            title="Aspect ratio"
            hint={`${aspect.w} by ${aspect.h} px`}
          >
            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] p-1 min-[420px]:grid-cols-3" role="group" aria-label="Aspect ratio">
              {ASPECT_ORDER.map((id) => {
                const a = ASPECTS[id];
                const on = aspectId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setAspectId(id)}
                    aria-pressed={on}
                    className={`tnum min-w-0 rounded-lg border px-2 py-2 text-left transition-all duration-300 ease-out active:scale-[0.98] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
                      on
                        ? "border-[#0070eb]/30 bg-white text-[#0058bc] shadow-sm"
                        : "border-transparent text-[#414755] hover:bg-white hover:text-[#1a1b1f]"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className="block min-w-0 truncate text-[11.5px] font-semibold leading-tight">
                        {a.label}
                      </span>
                      <span
                        aria-hidden
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          on ? "bg-[#0070eb]" : "bg-[#d9d9de]"
                        }`}
                      />
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[9px] opacity-70">
                      {a.w} by {a.h}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[9px] opacity-60">
                      {a.outW} by {a.outH}
                    </span>
                  </button>
                );
              })}
            </div>
          </Group>

          <Group
            icon={<Palette size={12} weight="bold" />}
            title="Visual Appearance"
            hint={theme.name}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2" role="group" aria-label="Card theme">
              {THEME_ORDER.map((id) => {
                const t = THEMES[id];
                const on = themeId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setThemeId(id)}
                    aria-pressed={on}
                    className={`min-w-0 rounded-xl border p-2 text-left transition-all duration-300 ease-out active:scale-[0.98] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
                      on
                        ? "border-[#0070eb] bg-white shadow-sm ring-2 ring-[#0070eb]/25"
                        : "border-[#e5e5ea] bg-[#f4f3f8] hover:bg-[#e9e7ed]"
                    }`}
                  >
                    <span className="flex gap-[3px]">
                      {t.swatch.map((c, i) => (
                        <span
                          key={`${c}-${i}`}
                          className="h-4 w-4 rounded-[4px] border border-black/10"
                          style={{ background: c }}
                        />
                      ))}
                    </span>
                    <span className="mt-1.5 block text-[11px] font-semibold text-[#1c1c1e]">
                      {t.name}
                    </span>
                    <span className="block text-[9.5px] leading-tight text-ink-3">{t.blurb}</span>
                  </button>
                );
              })}
            </div>
          </Group>

          <Group
            icon={<SlidersHorizontal size={12} weight="bold" />}
            title="Primary Hero Metric"
            hint={data.hasData ? `${fmtTokens(data.totalTokens)}, ${fmtCost(data.totalCost)}` : "no data"}
          >
            <div
              className="flex min-w-0 flex-wrap gap-1.5"
              role="group"
              aria-label="Hero metric"
            >
              {(["tokens", "spend"] as HeroMetric[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMetric(m)}
                  aria-pressed={metric === m}
                  className={`inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-all duration-300 ease-out active:scale-[0.98] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
                    metric === m
                      ? "border-[#0070eb] bg-[#0070eb] font-semibold text-white shadow-sm"
                      : "border-[#e5e5ea] bg-[#f4f3f8] text-[#414755] hover:bg-[#e9e7ed] hover:text-[#1a1b1f]"
                  }`}
                >
                  {m === "tokens" ? (
                    <Lightning size={12} weight="fill" aria-hidden />
                  ) : (
                    <Coins size={12} weight="fill" aria-hidden />
                  )}
                  {m === "tokens" ? "Total Tokens" : "Total Spend ($)"}
                </button>
              ))}
            </div>
          </Group>

          <Group icon={<span className="font-mono text-[11px] leading-none" aria-hidden>@</span>} title="Attribution & Workspace Tag">
            <div className="flex items-center gap-1 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] px-2.5 py-1.5 transition-all duration-300 ease-out focus-within:border-[#0070eb] focus-within:bg-white focus-within:ring-2 focus-within:ring-[#0070eb]/20 motion-reduce:transition-none">
              <span className="font-mono text-[12px] font-medium text-ink-3" aria-hidden>@</span>
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value.replace(/\s+/g, " ").slice(0, 28))}
                maxLength={28}
                placeholder="alex_dev"
                aria-label="Card handle or custom title"
                className="tnum w-full border-0 bg-transparent p-0 pl-1 font-mono text-[12px] text-[#1c1c1e] placeholder:text-[#8e8e93] focus:outline-none focus:ring-0"
              />
              <span className="shrink-0 rounded bg-[#e9e7ed] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700">
                VERIFIED
              </span>
            </div>
            <span className="tnum block px-1 font-mono text-[10px] text-[#8e8e93]">
              {handle.length}/28 characters
            </span>
          </Group>

          <Group icon={<Cpu size={12} weight="bold" />} title="Layers" hint="in the card">
            <div className="space-y-1.5 border-t border-[#f2f2f7] pt-3">
              <Toggle label="Activity sparkline layer" on={layers.sparkline} onClick={() => setLayers((l) => ({ ...l, sparkline: !l.sparkline }))}>
                Activity Sparkline
              </Toggle>
              <Toggle label="Top models layer" on={layers.models} onClick={() => setLayers((l) => ({ ...l, models: !l.models }))}>
                Top Model Distribution
              </Toggle>
              <Toggle label="Bento stats layer" on={layers.bento} onClick={() => setLayers((l) => ({ ...l, bento: !l.bento }))}>
                Bento Stats
              </Toggle>
            </div>
          </Group>

          <Group
            icon={<DownloadSimple size={12} weight="bold" />}
            title="Export"
            hint={`${aspect.outW} by ${aspect.outH} px`}
          >
            <div className="grid min-w-0 grid-cols-1 gap-2 min-[420px]:grid-cols-2">
              <button
                type="button"
                onClick={() => runAction("copy", copyPng)}
                disabled={busy !== null}
                aria-busy={busy === "copy"}
                aria-label="Copy PNG to clipboard"
                className="group flex w-full min-w-0 items-center justify-center gap-2 rounded-xl border border-[#e5e5ea] bg-white px-3 py-2 text-[12px] font-semibold text-[#1c1c1e] transition-all duration-300 ease-out hover:bg-[#f4f3f8] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <span>{busy === "copy" ? "Rendering…" : "Copy PNG"}</span>
                <span
                  aria-hidden
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors duration-300 ease-out motion-reduce:transition-none ${
                    lastAction === "copy" && status?.ok
                      ? "bg-emerald-500 text-white"
                      : busy === "copy"
                        ? "bg-[#0070eb]/10 text-[#0058bc]"
                        : "bg-[#f4f3f8] text-[#1c1c1e]"
                  }`}
                >
                  {busy === "copy" ? (
                    <ArrowClockwise size={14} weight="bold" className="animate-spin motion-reduce:animate-none" />
                  ) : lastAction === "copy" && status?.ok ? (
                    <Check size={14} weight="bold" />
                  ) : (
                    <Copy size={14} weight="bold" />
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => runAction("download", downloadPng)}
                disabled={busy !== null}
                aria-busy={busy === "download"}
                aria-label={`Download PNG at ${aspect.outW} by ${aspect.outH} pixels`}
                className="group flex w-full min-w-0 items-center justify-center gap-2 rounded-xl bg-[#0070eb] px-3 py-2 text-[12px] font-semibold text-white shadow-sm transition-all duration-300 ease-out hover:bg-[#0058bc] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <span>{busy === "download" ? "Rendering…" : "Download 3×"}</span>
                <span
                  aria-hidden
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors duration-300 ease-out motion-reduce:transition-none ${
                    lastAction === "download" && status?.ok ? "bg-emerald-500 text-white" : "bg-white/20 text-white"
                  }`}
                >
                  {busy === "download" ? (
                    <ArrowClockwise size={14} weight="bold" className="animate-spin motion-reduce:animate-none" />
                  ) : lastAction === "download" && status?.ok ? (
                    <Check size={14} weight="bold" />
                  ) : (
                    <DownloadSimple size={14} weight="bold" />
                  )}
                </span>
              </button>
            </div>
            {status ? (
              <p
                role="status"
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] leading-snug motion-reduce:transition-none ${
                  status.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-800"
                }`}
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    status.ok ? "bg-emerald-500" : "bg-amber-500"
                  }`}
                />
                {status.text}
              </p>
            ) : (
              <p className="px-1 text-[11px] leading-snug text-ink-3">
                Copy uses the system clipboard. Download writes a {aspect.outW} by {aspect.outH}{" "}
                PNG.
              </p>
            )}
          </Group>
          </div>
        </aside>

        {/* ---------------- hero preview canvas ---------------- */}
        <section
          aria-label="Card preview"
          className="tt-rise order-1 min-w-0 rounded-[20px] border border-[#e5e5ea] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] xl:order-2"
          style={{ animationDelay: "120ms" }}
        >
          <div className="p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold text-[#1c1c1e]">{aspect.label}</span>
              <span className="tnum rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-2 py-0.5 font-mono text-[11px] text-[#414755]">
                {aspect.outW} by {aspect.outH} at 3×
              </span>
              <span className="text-[11px] text-ink-3">
                {aspect.platform.replace(" · ", ", ")}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1 rounded-full border border-[#e5e5ea] bg-[#f4f3f8] p-1" role="group" aria-label="Preview zoom">
              <CornersOut size={13} weight="bold" className="ml-1.5 mr-0.5 shrink-0 text-ink-3" aria-hidden />
              {(["fit", 100, 50] as const).map((z) => (
                <button
                  key={String(z)}
                  type="button"
                  onClick={() => setZoom(z)}
                  aria-pressed={zoom === z}
                  aria-label={z === "fit" ? "Fit preview to canvas" : `Preview at ${z} percent`}
                  className={`tnum rounded-full border px-2.5 py-1 font-mono text-[11px] transition-all duration-300 ease-out active:scale-[0.97] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
                    zoom === z
                      ? "border-[#0070eb]/30 bg-white font-semibold text-[#0058bc] shadow-sm"
                      : "border-transparent text-ink-3 hover:text-[#1a1b1f]"
                  }`}
                >
                  {z === "fit" ? "Fit" : `${z}%`}
                </button>
              ))}
            </div>
          </div>

          <div
            ref={previewRef}
            className="tt-checker relative overflow-auto rounded-2xl border border-[#e5e5ea] bg-[#faf9fe] p-5"
          >
            {/* outer preview wrapper: sizing box only — carries the preview-only
                shadow + canvas fill so rounded corners match the export
                (`backgroundColor: theme.canvas`). The capture node itself
                stays shadow-free: shadows leak into the 3× PNG otherwise. */}
            <div
              className="mx-auto"
              style={{
                width: Math.round(aspect.w * scale),
                height: Math.round(aspect.h * scale),
                background: theme.canvas,
                borderRadius: Math.max(2, theme.radius * scale),
                overflow: "hidden",
                boxShadow:
                  theme.id === "editorial"
                    ? "0 18px 40px -26px rgba(0,0,0,0.55)"
                    : "0 26px 60px -30px rgba(0,0,0,0.55)",
              }}
            >
              {/* scale lives on this wrapper so cardRef keeps exact integer pixels */}
              <div
                style={{
                  width: aspect.w,
                  height: aspect.h,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                }}
              >
                <div
                  ref={cardRef}
                  data-capture="share-card"
                  data-capture-size={`${aspect.w}x${aspect.h}`}
                  style={cardStyle}
                >
                  <Chrome theme={theme} layout={layout} w={aspect.w} h={aspect.h} seed={data.seed} />
                  <div
                    style={{
                      position: "relative",
                      zIndex: 1,
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                    }}
                  >
                    <CardHeader
                      data={data}
                      theme={theme}
                      layout={layout}
                      handle={handle}
                      platform={aspect.platform}
                    />

                    {layout.twoCol ? (
                      <div
                        style={{
                          display: "flex",
                          height: aspect.h - layout.pad * 2 - layout.headerH - layout.footerH,
                          gap: layout.colGap,
                        }}
                      >
                        <div
                          style={{
                            width: layout.leftW,
                            display: "flex",
                            flexDirection: "column",
                            gap: layout.colGap,
                          }}
                        >
                          {data.hasData ? (
                            <>
                              <CardHero data={data} theme={theme} layout={layout} width={layout.leftW} />
                              <ClientsRow data={data} theme={theme} layout={layout} width={layout.leftW} />
                              {layers.bento ? (
                                <BentoGrid
                                  data={data}
                                  theme={theme}
                                  layout={layout}
                                  width={layout.leftW}
                                  stretch
                                />
                              ) : null}
                            </>
                          ) : (
                            <EmptyState theme={theme} layout={layout} />
                          )}
                        </div>
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "space-between",
                          }}
                        >
                          {content}
                        </div>
                      </div>
                    ) : (
                      <>
                        {data.hasData ? (
                          <>
                            <CardHero data={data} theme={theme} layout={layout} width={innerW} />
                            {content}
                            <ClientsRow data={data} theme={theme} layout={layout} width={innerW} />
                            {layers.bento ? (
                              <BentoGrid
                                data={data}
                                theme={theme}
                                layout={layout}
                                width={innerW}
                                stretch={false}
                              />
                            ) : null}
                          </>
                        ) : (
                          <EmptyState theme={theme} layout={layout} />
                        )}
                      </>
                    )}

                    <CardFooter data={data} theme={theme} layout={layout} width={innerW} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="tnum mt-3 flex flex-wrap items-center gap-1.5 px-1 font-mono text-[11px] leading-relaxed text-ink-3" role="status">
            <span className="rounded-full border border-[#e5e5ea] bg-white px-2 py-0.5">
              Capture {aspect.w} × {aspect.h} px
            </span>
            <span className="rounded-full border border-[#e5e5ea] bg-white px-2 py-0.5">
              Preview {scale.toFixed(2)}×
            </span>
            <span className="rounded-full border border-[#0070eb]/25 bg-[#0070eb]/[0.06] px-2 py-0.5 font-semibold text-[#0058bc]">
              Exports {aspect.outW} × {aspect.outH}
            </span>
            <span className="rounded-full border border-[#e5e5ea] bg-white px-2 py-0.5">
              {data.hasData ? "live data" : "empty range"} · {theme.name}
            </span>
          </p>
          </div>
        </section>
      </div>
    </div>
  );
}
