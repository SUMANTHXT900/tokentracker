/**
 * Focus session share card.
 *
 * A self-contained card surface (inline CSS only) authored at the exact
 * integer dimensions in `ASPECTS`, rendered inside a preview-only scale
 * wrapper. The capture node never carries a transform or backdrop-filter, so
 * `html-to-image` produces a 3× PNG that matches the preview.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { toBlob, toPng } from "html-to-image";
import {
  ArrowClockwise,
  Check,
  Copy,
  DownloadSimple,
  ShareNetwork,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useTripDetail } from "../lib/tauri";
import { fmtCost, fmtPct, fmtTokens, splitTokens } from "../lib/format";
import {
  ASPECTS,
  ASPECT_ORDER,
  FONT_DISPLAY,
  FONT_MONO,
  FONT_SANS,
  THEMES,
  THEME_ORDER,
  labelCss,
  numCss,
  panelCss,
} from "../lib/card/theme";
import type { AspectDef, AspectId, CardTheme, ThemeId } from "../lib/card/types";
import { catmullRomPath, clamp, fitHero, rgba, starPoints } from "../lib/card/geometry";
import {
  asSessionDetail,
  buildSessionCardData,
  formatTokenRate,
} from "../lib/card/session";
import type {
  SessionCardData,
  SessionDetailLike,
} from "../lib/card/session";
import { dayLabel, fmtCount } from "../lib/card/data";

/* ------------------------------------------------------------------ */
/* Card layout scale                                                   */
/* ------------------------------------------------------------------ */

interface SessionLayout {
  pad: number;
  gap: number;
  headerH: number;
  identityH: number;
  bodyGap: number;
  twoCol: boolean;
  leftPct: number;
  heroCap: number;
  flowCellH: number;
  factCellH: number;
  factCols: 3 | 6;
  modelRowH: number;
  sparkH: number;
  footerH: number;

  nameFont: number;
  metaFont: number;
  stopFont: number;
  labelFont: number;
  tinyFont: number;
  valueFont: number;
  modelFont: number;
  modelValueFont: number;
  clientFont: number;
  footerFont: number;
  brandMark: number;
  brandFont: number;
  statusFont: number;
}

const SESSION_LAYOUTS: Record<AspectId, SessionLayout> = {
  "1:1": {
    pad: 24,
    gap: 8,
    headerH: 34,
    identityH: 50,
    bodyGap: 12,
    twoCol: true,
    leftPct: 0.5,
    heroCap: 78,
    flowCellH: 44,
    factCellH: 46,
    factCols: 3,
    modelRowH: 24,
    sparkH: 40,
    footerH: 18,
    nameFont: 20,
    metaFont: 8.5,
    stopFont: 7.5,
    labelFont: 7.5,
    tinyFont: 6.5,
    valueFont: 14,
    modelFont: 8.5,
    modelValueFont: 9,
    clientFont: 7.5,
    footerFont: 7,
    brandMark: 24,
    brandFont: 10.5,
    statusFont: 7.2,
  },
  "9:16": {
    pad: 24,
    gap: 5,
    headerH: 34,
    identityH: 54,
    bodyGap: 8,
    twoCol: false,
    leftPct: 1,
    heroCap: 80,
    flowCellH: 40,
    factCellH: 47,
    factCols: 3,
    modelRowH: 24,
    sparkH: 44,
    footerH: 20,
    nameFont: 23,
    metaFont: 9,
    stopFont: 8,
    labelFont: 8.5,
    tinyFont: 7,
    valueFont: 16,
    modelFont: 9.5,
    modelValueFont: 10,
    clientFont: 8.5,
    footerFont: 7.5,
    brandMark: 26,
    brandFont: 11.5,
    statusFont: 7.8,
  },
  "16:9": {
    pad: 20,
    gap: 6,
    headerH: 30,
    identityH: 41,
    bodyGap: 10,
    twoCol: true,
    leftPct: 0.5,
    heroCap: 44,
    flowCellH: 32,
    factCellH: 38,
    factCols: 6,
    modelRowH: 16,
    sparkH: 30,
    footerH: 18,
    nameFont: 17,
    metaFont: 7.5,
    stopFont: 6.8,
    labelFont: 6.5,
    tinyFont: 5.8,
    valueFont: 11.5,
    modelFont: 8,
    modelValueFont: 8,
    clientFont: 6.8,
    footerFont: 6,
    brandMark: 20,
    brandFont: 9.5,
    statusFont: 6.5,
  },
};

/* ------------------------------------------------------------------ */
/* Small card primitives                                               */
/* ------------------------------------------------------------------ */

function Label({
  theme,
  size,
  color,
  weight,
  children,
  style,
}: {
  theme: CardTheme;
  size: number;
  color?: string;
  weight?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return <span style={{ ...labelCss(theme, size, color, weight), ...style }}>{children}</span>;
}

function SectionLabel({
  theme,
  size,
  title,
  right,
}: {
  theme: CardTheme;
  size: number;
  title: string;
  right?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 6,
        minWidth: 0,
      }}
    >
      <Label theme={theme} size={size} color={theme.dim}>
        {title}
      </Label>
      {right ? (
        <Label
          theme={theme}
          size={Math.max(5.5, size - 0.5)}
          style={{ maxWidth: "58%", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {right}
        </Label>
      ) : null}
    </div>
  );
}

function StatusPill({
  data,
  theme,
  font,
}: {
  data: SessionCardData;
  theme: CardTheme;
  font: number;
}) {
  const live = data.isLive;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: `${Math.round(font * 0.3)}px ${Math.round(font * 0.72)}px`,
        borderRadius: 999,
        background: live ? theme.accent : theme.panel,
        border: `1px solid ${live ? rgba(theme.accent, 0.2) : theme.panelBorder}`,
        color: live ? theme.accentInk : theme.dim,
        fontFamily: FONT_MONO,
        fontSize: font,
        fontWeight: 700,
        lineHeight: 1.05,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 4,
          height: 4,
          borderRadius: 999,
          background: live ? theme.accentInk : theme.accent,
          flexShrink: 0,
        }}
      />
      {data.statusLabel}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

function SessionChrome({
  theme,
  w,
  h,
  pad,
  seed,
}: {
  theme: CardTheme;
  w: number;
  h: number;
  pad: number;
  seed: string;
}) {
  if (theme.chrome === "grid" && theme.gridStep > 0) {
    const step = theme.gridStep;
    const o = 10;
    const len = 15;
    return (
      <svg
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        aria-hidden
        focusable="false"
      >
        <defs>
          <pattern id="ssm-grid" width={step} height={step} patternUnits="userSpaceOnUse">
            <path
              d={`M ${step} 0 L 0 0 0 ${step}`}
              fill="none"
              stroke={theme.gridColor}
              strokeWidth={1}
            />
          </pattern>
          <linearGradient id="ssm-grid-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.8" />
            <stop offset="0.62" stopColor="#ffffff" stopOpacity="0.34" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0.06" />
          </linearGradient>
          <mask id="ssm-grid-mask">
            <rect x="0" y="0" width={w} height={h} fill="url(#ssm-grid-fade)" />
          </mask>
        </defs>
        <rect x="0" y="0" width={w} height={h} fill="url(#ssm-grid)" mask="url(#ssm-grid-mask)" />
        <g
          stroke={rgba(theme.accent, 0.45)}
          strokeWidth={1.5}
          fill="none"
          strokeLinecap="square"
        >
          <path d={`M ${o} ${o + len} L ${o} ${o} L ${o + len} ${o}`} />
          <path d={`M ${w - o - len} ${o} L ${w - o} ${o} L ${w - o} ${o + len}`} />
          <path d={`M ${o} ${h - o - len} L ${o} ${h - o} L ${o + len} ${h - o}`} />
          <path
            d={`M ${w - o - len} ${h - o} L ${w - o} ${h - o} L ${w - o} ${h - o - len}`}
          />
        </g>
      </svg>
    );
  }

  if (theme.chrome === "brutalist") {
    const p = pad;
    const iw = w - p * 2;
    const ih = h - p * 2;
    const verts = [1, 2, 3].map((i) => p + (iw * i) / 4);
    const hors = [1, 2].map((i) => p + (ih * i) / 3);
    const mark = 6;
    const off = 8;
    return (
      <svg
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        aria-hidden
        focusable="false"
      >
        <g stroke="rgba(15,15,14,0.07)" strokeWidth={1}>
          {verts.map((x, i) => (
            <line key={`v${i}`} x1={x} y1={p * 0.5} x2={x} y2={h - p * 0.5} />
          ))}
          {hors.map((y, i) => (
            <line key={`h${i}`} x1={p * 0.45} y1={y} x2={w - p * 0.45} y2={y} />
          ))}
        </g>
        <g stroke="rgba(15,15,14,0.5)" strokeWidth={1} strokeLinecap="butt">
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
    const stars = starPoints(seed, Math.round((w * h) / 5200), w, h);
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
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }} aria-hidden>
      <div
        style={{
          position: "absolute",
          inset: 9,
          border: `1px solid ${frame.outer}`,
          borderRadius: Math.max(2, theme.radius - 8),
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 14,
          border: `1px solid ${frame.inner}`,
          borderRadius: Math.max(2, theme.radius - 12),
        }}
      />
      {[
        [9, 9],
        [w - 9, 9],
        [9, h - 9],
        [w - 9, h - 9],
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

/* ------------------------------------------------------------------ */
/* Card sections                                                       */
/* ------------------------------------------------------------------ */

function CardHeader({
  data,
  theme,
  layout,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
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
            <Label theme={theme} size={Math.max(5.5, layout.labelFont - 1)}>
              FOCUS SESSION
            </Label>
          </span>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 2,
            flexShrink: 0,
          }}
        >
          <span style={numCss(layout.metaFont - 0.5, theme.dim, 500)}>{data.dateLabel}</span>
          <StatusPill data={data} theme={theme} font={layout.statusFont} />
        </div>
      </div>
      <div style={{ height: theme.ruleH, background: theme.ruleColor, flexShrink: 0 }} />
    </div>
  );
}

function SessionIdentity({
  data,
  theme,
  layout,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
}) {
  return (
    <div
      style={{
        height: layout.identityH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 3,
        minWidth: 0,
      }}
    >
      <span
        title={data.name}
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: layout.nameFont,
          fontWeight: 700,
          lineHeight: 1.06,
          letterSpacing: "-0.02em",
          color: theme.ink,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {data.name}
      </span>
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: layout.metaFont,
          lineHeight: 1.15,
          color: theme.dim,
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {data.dateLabel} · {data.timeRange} · {data.durationLabel}
      </span>
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: layout.stopFont,
          lineHeight: 1.1,
          color: theme.faint,
          letterSpacing: "0.03em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        <span style={{ color: data.isLive ? theme.accent : theme.dim }}>{data.stopReason}</span>
        <span> · {data.scopeLabel}</span>
      </span>
    </div>
  );
}

function HeroBlock({
  data,
  theme,
  layout,
  width,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
  width: number;
}) {
  const split = splitTokens(data.tokens);
  const fit = fitHero({
    num: split.num,
    unit: split.unit,
    availW: width - 4,
    availH: layout.heroCap,
    cap: layout.heroCap,
    floor: 16,
  });
  const hasDuration = data.durationMs > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 6,
          minWidth: 0,
        }}
      >
        <Label theme={theme} size={layout.labelFont + 0.5} color={theme.dim}>
          TOTAL TOKENS
        </Label>
        <Label theme={theme} size={Math.max(5.5, layout.labelFont - 0.5)}>
          {data.isLive ? "LIVE DELTA" : "SESSION DELTA"}
        </Label>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", minWidth: 0 }}>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: fit.size,
            lineHeight: 1.02,
            fontWeight: theme.heroWeight,
            color: theme.heroColor,
            textShadow: theme.heroGlow,
            letterSpacing: "-0.03em",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {split.num}
          {split.unit ? (
            <span
              style={{
                fontSize: fit.unitSize,
                fontWeight: 600,
                color: theme.accent,
                marginLeft: Math.round(fit.size * 0.07),
                letterSpacing: "0",
              }}
            >
              {split.unit}
            </span>
          ) : null}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 5,
          minWidth: 0,
        }}
      >
        <span style={numCss(layout.valueFont, theme.ink, 700)}>{fmtCost(data.cost)}</span>
        <Label theme={theme} size={layout.tinyFont}>
          EST. SPEND
        </Label>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: layout.tinyFont,
            color: theme.lineStrong,
            lineHeight: 1,
          }}
        >
          ·
        </span>
        <span style={numCss(layout.valueFont, theme.ink, 700)}>{fmtCount(data.messages)}</span>
        <Label theme={theme} size={layout.tinyFont}>
          MESSAGES
        </Label>
      </div>
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: Math.max(5.5, layout.tinyFont + 0.2),
          lineHeight: 1.1,
          color: theme.faint,
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {hasDuration
          ? `${formatTokenRate(data.tokPerMin)} · ${fmtCost(data.costPerHour)}/hr`
          : "duration not reported"}
      </span>
    </div>
  );
}

function StatCell({
  theme,
  layout,
  label,
  value,
  sub,
  title,
}: {
  theme: CardTheme;
  layout: SessionLayout;
  label: string;
  value: string;
  sub?: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      style={{
        ...panelCss(theme, Math.max(5, theme.radius - 8)),
        height: "100%",
        boxSizing: "border-box",
        padding: `${Math.round(layout.labelFont * 0.62)}px ${Math.round(layout.labelFont * 0.9)}px`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 2,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <Label theme={theme} size={layout.labelFont} color={theme.faint}>
        {label}
      </Label>
      <span
        style={{
          ...numCss(layout.valueFont, theme.ink, 600),
          display: "block",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </span>
      {sub ? (
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: layout.tinyFont,
            lineHeight: 1,
            color: theme.faint,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "block",
          }}
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}

function Streams({
  data,
  theme,
  layout,
  width,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
  width: number;
}) {
  const cells = [
    { label: "INPUT", value: fmtTokens(data.input) },
    { label: "OUTPUT", value: fmtTokens(data.output) },
    { label: "CACHE READ", value: fmtTokens(data.cacheRead) },
    { label: "CACHE WRITE", value: fmtTokens(data.cacheWrite) },
    { label: "REASONING", value: fmtTokens(data.reasoning) },
    { label: "CACHE HIT", value: fmtPct(data.cacheHit) },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <SectionLabel
        theme={theme}
        size={layout.labelFont}
        title="Token streams"
        right={width > 300 ? `${fmtTokens(data.tokens)} total` : undefined}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gridAutoRows: `${layout.flowCellH}px`,
          gap: 4,
        }}
      >
        {cells.map((cell) => (
          <StatCell
            key={cell.label}
            theme={theme}
            layout={layout}
            label={cell.label}
            value={cell.value}
          />
        ))}
      </div>
    </div>
  );
}

function Facts({
  data,
  theme,
  layout,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
}) {
  const peak = data.peakDay;
  const topModel = data.topModelLabel;
  const cells = [
    {
      label: "SESSIONS",
      value: data.sessions == null ? "—" : fmtCount(data.sessions),
      sub: data.sessions == null ? "not reported" : "recorded",
    },
    { label: "MODELS", value: fmtCount(data.modelsUsed), sub: "used" },
    { label: "CLIENTS", value: fmtCount(data.clientsUsed), sub: data.isLive ? "active" : "used" },
    {
      label: "TOP MODEL",
      value: topModel ?? "—",
      sub: topModel
        ? data.topModelTokens > 0
          ? `${fmtTokens(data.topModelTokens)} · ${fmtPct(data.topModelShare)}`
          : "no token share"
        : "not reported",
      title: data.topModel ?? undefined,
    },
    {
      label: "PEAK DAY",
      value: peak ? fmtTokens(peak.tokens) : "—",
      sub: peak ? peak.label : "no daily peak",
    },
    {
      label: "VELOCITY",
      value: data.durationMs > 0 ? formatTokenRate(data.tokPerMin) : "—",
      sub: data.durationMs > 0 ? `${fmtCost(data.costPerHour)}/hr` : "no duration",
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${layout.factCols}, minmax(0, 1fr))`,
        gridAutoRows: `${layout.factCellH}px`,
        gap: 4,
        flexShrink: 0,
      }}
    >
      {cells.map((cell) => (
        <StatCell
          key={cell.label}
          theme={theme}
          layout={layout}
          label={cell.label}
          value={cell.value}
          sub={cell.sub}
          title={"title" in cell ? cell.title : undefined}
        />
      ))}
    </div>
  );
}

function ModelRows({
  data,
  theme,
  layout,
  width,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
  width: number;
}) {
  const rows = data.models.slice(0, 5);
  const showCost = width >= 280;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <SectionLabel
        theme={theme}
        size={layout.labelFont}
        title="Model mix"
        right={rows.length > 0 ? `top ${rows.length} of ${data.models.length}` : "no rows"}
      />
      {rows.length === 0 ? (
        <div
          style={{
            ...panelCss(theme, Math.max(4, theme.radius - 10)),
            borderStyle: "dashed",
            padding: "6px 8px",
          }}
        >
          <Label theme={theme} size={layout.labelFont}>
            No model breakdown reported
          </Label>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {rows.map((m) => (
            <div
              key={m.key}
              style={{
                height: layout.modelRowH,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 2,
                minWidth: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 4, minWidth: 0 }}>
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 999,
                    background: m.hex,
                    flexShrink: 0,
                    transform: "translateY(-1px)",
                  }}
                />
                <span
                  title={m.model}
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: layout.modelFont,
                    fontWeight: 500,
                    lineHeight: 1.1,
                    color: theme.ink,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    flex: "1 1 auto",
                    minWidth: 0,
                  }}
                >
                  {m.short}
                </span>
                <span style={{ ...numCss(layout.modelValueFont, theme.ink, 600), flexShrink: 0 }}>
                  {fmtTokens(m.tokens)}
                </span>
                {showCost ? (
                  <span
                    style={{ ...numCss(layout.modelValueFont - 0.5, theme.faint, 500), flexShrink: 0 }}
                  >
                    {fmtCost(m.cost)}
                  </span>
                ) : null}
                <span
                  style={{
                    ...numCss(layout.modelValueFont - 0.5, theme.accent, 600),
                    width: Math.round(layout.modelValueFont * 3.4),
                    textAlign: "right",
                    flexShrink: 0,
                  }}
                >
                  {fmtPct(m.share)}
                </span>
              </div>
              <div
                style={{
                  height: layout.modelRowH <= 18 ? 2 : 2.5,
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ClientMix({
  data,
  theme,
  layout,
  width,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
  width: number;
}) {
  const compact = width < 260;
  const shown = data.clients.slice(0, compact ? 2 : width < 340 ? 2 : 3);
  const rest = data.clients.length - shown.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <SectionLabel
        theme={theme}
        size={layout.labelFont}
        title="Client mix"
        right={
          data.clientsUsed > 0
            ? `${data.clientsUsed} ${data.isLive ? "active" : "used"}`
            : undefined
        }
      />
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: compact ? 8 : 4,
          minHeight: 14,
          maxHeight: 34,
          overflow: "hidden",
        }}
      >
        {shown.length === 0 ? (
          <Label theme={theme} size={layout.labelFont} color={theme.faint}>
            No client rows
          </Label>
        ) : null}
        {shown.map((c) =>
          compact ? (
            <span
              key={c.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              <span
                style={{ width: 4, height: 4, borderRadius: 999, background: c.hex, flexShrink: 0 }}
              />
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: layout.clientFont,
                  color: theme.dim,
                  letterSpacing: "0.02em",
                }}
              >
                {c.label}
              </span>
              <span style={numCss(layout.clientFont, theme.ink, 600)}>{fmtPct(c.share)}</span>
            </span>
          ) : (
            <span
              key={c.id}
              style={{
                ...panelCss(theme, 999),
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                padding: `2px ${Math.round(layout.clientFont * 0.55)}px`,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              <span
                style={{ width: 4, height: 4, borderRadius: 999, background: c.hex, flexShrink: 0 }}
              />
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: layout.clientFont,
                  color: theme.dim,
                  letterSpacing: "0.02em",
                }}
              >
                {c.label}
              </span>
              <span style={numCss(layout.clientFont, theme.ink, 600)}>{fmtPct(c.share)}</span>
            </span>
          ),
        )}
        {rest > 0 ? (
          <span style={{ ...numCss(layout.clientFont, theme.faint, 600), flexShrink: 0 }}>
            +{rest}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Sparkline({
  data,
  theme,
  layout,
  width,
  uid,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
  width: number;
  uid: string;
}) {
  if (data.daily.length < 2) return null;

  const values = data.daily.map((d) => d.tokens);
  const n = values.length;
  const h = layout.sparkH;
  const pad = 5;
  const max = Math.max(...values, 1);
  const points = values.map((v, i) => ({
    x: pad + ((width - pad * 2) * i) / Math.max(1, n - 1),
    y: h - pad - (v / max) * (h - pad * 2),
  }));
  const line = catmullRomPath(points, { minY: pad, maxY: h - pad });
  const area = `${line} L ${points[n - 1].x.toFixed(2)} ${h} L ${points[0].x.toFixed(2)} ${h} Z`;
  const peakIndex = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
  const peak = values[peakIndex] > 0 ? points[peakIndex] : null;
  const areaId = `${uid}-area`;
  const lineId = `${uid}-line`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <SectionLabel
        theme={theme}
        size={layout.labelFont}
        title="Daily rhythm"
        right={`${dayLabel(data.daily[0].date)}–${dayLabel(data.daily[n - 1].date)}`}
      />
      <svg
        width={width}
        height={h}
        viewBox={`0 0 ${width} ${h}`}
        style={{ display: "block", overflow: "visible" }}
        aria-hidden
        focusable="false"
      >
        <defs>
          <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={theme.accent} stopOpacity={0.34} />
            <stop offset="100%" stopColor={theme.accent} stopOpacity={0.01} />
          </linearGradient>
          <linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={theme.accent} />
            <stop offset="100%" stopColor={theme.accent2} />
          </linearGradient>
        </defs>
        <line
          x1={0}
          y1={h - 0.5}
          x2={width}
          y2={h - 0.5}
          stroke={theme.line}
          strokeWidth={1}
        />
        <path d={area} fill={`url(#${areaId})`} />
        <path
          d={line}
          fill="none"
          stroke={`url(#${lineId})`}
          strokeWidth={layout.modelRowH <= 18 ? 1.4 : 1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {peak ? (
          <>
            <circle
              cx={peak.x}
              cy={peak.y}
              r={4.5}
              fill={rgba(theme.accent, 0.14)}
              stroke={rgba(theme.accent, 0.36)}
              strokeWidth={1}
            />
            <circle cx={peak.x} cy={peak.y} r={2} fill={theme.accent} />
          </>
        ) : null}
      </svg>
    </div>
  );
}

function CardFooter({
  data,
  theme,
  layout,
  aspect,
}: {
  data: SessionCardData;
  theme: CardTheme;
  layout: SessionLayout;
  aspect: AspectDef;
}) {
  return (
    <div
      style={{
        height: layout.footerH,
        flexShrink: 0,
        borderTop: `1px solid ${theme.line}`,
        paddingTop: 4,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: layout.footerFont,
          lineHeight: 1.1,
          color: theme.faint,
          letterSpacing: "0.03em",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        Measured locally · tokentracker
      </span>
      <span style={{ ...numCss(layout.footerFont, theme.faint, 500), flexShrink: 0 }}>
        {aspect.outW} × {aspect.outH}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

function SessionCard({
  data,
  aspect,
  aspectId,
  theme,
  cardRef,
  uid,
}: {
  data: SessionCardData;
  aspect: AspectDef;
  aspectId: AspectId;
  theme: CardTheme;
  cardRef: RefObject<HTMLDivElement>;
  uid: string;
}) {
  const layout = SESSION_LAYOUTS[aspectId];
  const innerW = aspect.w - layout.pad * 2;
  const leftW = layout.twoCol ? Math.floor((innerW - layout.bodyGap) * layout.leftPct) : innerW;
  const rightW = layout.twoCol ? innerW - leftW - layout.bodyGap : innerW;
  const stacked = !layout.twoCol;
  const hasSpark = data.daily.length > 1;

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
    padding: layout.pad,
    boxSizing: "border-box",
    fontVariantNumeric: "tabular-nums",
    WebkitFontSmoothing: "antialiased",
  };

  return (
    <div
      ref={cardRef}
      data-capture="focus-session-card"
      data-capture-size={`${aspect.w}x${aspect.h}`}
      role="img"
      aria-label={`${data.name} focus session card. ${data.statusLabel}. ${fmtTokens(
        data.tokens,
      )} tokens, ${fmtCost(data.cost)}, ${fmtCount(data.messages)} messages, ${data.durationLabel}.`}
      style={cardStyle}
    >
      <SessionChrome
        theme={theme}
        w={aspect.w}
        h={aspect.h}
        pad={layout.pad}
        seed={data.seed}
      />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: layout.gap,
        }}
      >
        <CardHeader data={data} theme={theme} layout={layout} />
        <SessionIdentity data={data} theme={theme} layout={layout} />

        {stacked ? (
          <>
            <HeroBlock data={data} theme={theme} layout={layout} width={innerW} />
            <Streams data={data} theme={theme} layout={layout} width={innerW} />
            <Facts data={data} theme={theme} layout={layout} />
            <ModelRows data={data} theme={theme} layout={layout} width={innerW} />
            <ClientMix data={data} theme={theme} layout={layout} width={innerW} />
            <Sparkline
              data={data}
              theme={theme}
              layout={layout}
              width={innerW}
              uid={uid}
            />
          </>
        ) : (
          <>
            <div
              style={{
                flex: "1 1 auto",
                minHeight: 0,
                display: "flex",
                gap: layout.bodyGap,
              }}
            >
              <div
                style={{
                  width: leftW,
                  flexShrink: 0,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <HeroBlock data={data} theme={theme} layout={layout} width={leftW} />
                <Streams data={data} theme={theme} layout={layout} width={leftW} />
              </div>
              <div
                style={{
                  flex: "1 1 auto",
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 9,
                }}
              >
                <ModelRows data={data} theme={theme} layout={layout} width={rightW} />
                <ClientMix data={data} theme={theme} layout={layout} width={rightW} />
                {hasSpark ? (
                  <div style={{ marginTop: "auto" }}>
                    <Sparkline
                      data={data}
                      theme={theme}
                      layout={layout}
                      width={rightW}
                      uid={uid}
                    />
                  </div>
                ) : null}
              </div>
            </div>
            <Facts data={data} theme={theme} layout={layout} />
          </>
        )}

        <CardFooter data={data} theme={theme} layout={layout} aspect={aspect} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal helpers                                                       */
/* ------------------------------------------------------------------ */

type Notice = { kind: "ok" | "warn" | "error"; text: string };
type Busy = null | "copy" | "download";

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : error ? String(error) : "Unknown error";
  return raw.length > 150 ? `${raw.slice(0, 150)}…` : raw;
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export default function SessionShareModal({
  tripId,
  onClose,
}: {
  tripId: string;
  onClose: () => void;
}) {
  const [aspectId, setAspectId] = useState<AspectId>("1:1");
  const [themeId, setThemeId] = useState<ThemeId>("obsidian");
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastAction, setLastAction] = useState<Busy>(null);
  const [frozen, setFrozen] = useState<{ detail: SessionDetailLike; now: number } | null>(null);
  const [availW, setAvailW] = useState(0);
  const [viewportH, setViewportH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 800,
  );

  const openedAtRef = useRef(Date.now());
  const frozenRef = useRef<{ detail: SessionDetailLike; now: number } | null>(null);
  const busyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const { data, isError, error, refetch, isFetching } = useTripDetail(tripId, false);

  const aspect = ASPECTS[aspectId];
  const theme = THEMES[themeId];
  const uid = `ssm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const session = useMemo(
    () => (frozen ? buildSessionCardData(frozen.detail, frozen.now) : null),
    [frozen],
  );

  /* Reset the frozen snapshot when a different trip is opened. */
  useEffect(() => {
    openedAtRef.current = Date.now();
    frozenRef.current = null;
    setFrozen(null);
    setNotice(null);
  }, [tripId]);

  /* Freeze the first successful payload + open time. Never re-freeze on a
     background refetch, so preview and export always match. */
  useEffect(() => {
    if (!data || frozenRef.current) return;
    const snapshot = { detail: asSessionDetail(data), now: openedAtRef.current };
    frozenRef.current = snapshot;
    setFrozen(snapshot);
  }, [data]);

  /* Body scroll lock. */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /* Focus: enter the dialog, trap Tab, close on Escape, restore the trigger. */
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const raf = window.requestAnimationFrame(() => dialog?.focus());

    const focusables = () => {
      const node = dialogRef.current;
      if (!node) return [] as HTMLElement[];
      return Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (el) =>
          el.getAttribute("aria-hidden") !== "true" &&
          (el.offsetParent !== null || el === document.activeElement),
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const list = focusables();
      if (list.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;

      if (!dialog?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (active === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  /* Preview sizing: content-box width + a viewport-aware height cap. */
  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const width =
        el.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
      if (width > 0) setAvailW(width);
    };
    measure();
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number" && width > 0) setAvailW(width);
    });
    ro.observe(el);
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => clearTimer(), []);

  const flash = (kind: Notice["kind"], text: string) => {
    clearTimer();
    setNotice({ kind, text });
    timerRef.current = window.setTimeout(
      () => {
        setNotice(null);
        timerRef.current = null;
      },
      kind === "ok" ? 4200 : 6500,
    );
  };

  const requestClose = useCallback(() => {
    if (!busyRef.current) onCloseRef.current();
  }, []);

  const begin = (kind: Exclude<Busy, null>) => {
    if (busyRef.current || !session || !cardRef.current) return false;
    busyRef.current = true;
    setBusy(kind);
    setLastAction(kind);
    setNotice(null);
    clearTimer();
    return true;
  };

  const end = () => {
    busyRef.current = false;
    setBusy(null);
  };

  const triggerDownload = (href: string, filename: string) => {
    const anchor = document.createElement("a");
    anchor.download = filename;
    anchor.href = href;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const waitForFonts = async () => {
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => window.setTimeout(resolve, 2000)),
      ]);
    } catch {
      /* font loading is best-effort */
    }
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
  };

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

  const downloadPng = async () => {
    if (!session || !begin("download")) return;
    try {
      await waitForFonts();
      const node = cardRef.current;
      if (!node) throw new Error("card node unavailable");
      const url = await renderPng(node);
      triggerDownload(url, session.fileName);
      flash("ok", `${aspect.outW} × ${aspect.outH} PNG exported`);
    } catch (e) {
      flash("error", `Export failed — ${errorText(e)}`);
    } finally {
      end();
    }
  };

  const copyPng = async () => {
    if (!session || !begin("copy")) return;
    let blob: Blob | null = null;
    try {
      await waitForFonts();
      const node = cardRef.current;
      if (!node) throw new Error("card node unavailable");
      blob = await renderBlob(node);
      const ClipboardItemCtor = (
        window as unknown as { ClipboardItem?: typeof ClipboardItem }
      ).ClipboardItem;
      const clipboard = navigator.clipboard;
      if (!ClipboardItemCtor || !clipboard || typeof clipboard.write !== "function") {
        throw new Error("image clipboard unavailable in this webview");
      }
      await clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
      flash("ok", "PNG copied — paste it into a doc or chat");
    } catch (e) {
      if (blob) {
        const url = URL.createObjectURL(blob);
        triggerDownload(url, session.fileName);
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
        flash("warn", `Clipboard blocked — downloaded the 3× PNG instead (${errorText(e)})`);
      } else {
        flash("error", `Copy failed — ${errorText(e)}`);
      }
    } finally {
      end();
    }
  };

  const maxPreviewH = clamp(viewportH * 0.46, 190, 470);
  const scale = clamp(
    Math.min(
      (availW > 0 ? availW : aspect.w * 0.55) / aspect.w,
      maxPreviewH / aspect.h,
    ),
    0.12,
    1,
  );
  const controlsDisabled = busy !== null;
  const actionsDisabled = !session || busy !== null;

  const setAspect = (id: AspectId) => {
    if (busyRef.current) return;
    setAspectId(id);
    setNotice(null);
    clearTimer();
  };

  const setTheme = (id: ThemeId) => {
    if (busyRef.current) return;
    setThemeId(id);
    setNotice(null);
    clearTimer();
  };

  const retry = () => {
    if (isFetching) return;
    openedAtRef.current = Date.now();
    frozenRef.current = null;
    setFrozen(null);
    setNotice(null);
    clearTimer();
    void refetch();
  };

  const aspectNote = `${aspect.w} × ${aspect.h} CSS px · ${aspect.outW} × ${aspect.outH} export`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1a1b1f]/45 p-4 backdrop-blur-xl"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onCloseRef.current();
      }}
    >
      <style>{`.ssm-fade{animation:ssm-fade .24s ease-out both}@keyframes ssm-fade{from{opacity:0}to{opacity:1}}@media (prefers-reduced-motion: reduce){.ssm-fade{animation:none}}`}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-share-title"
        aria-describedby="session-share-desc"
        aria-busy={!session || busy !== null}
        tabIndex={-1}
        className="ssm-fade flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-[2rem] bg-white p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.06),0_32px_64px_-24px_rgba(16,24,40,0.3)] ring-1 ring-[#e5e5ea] focus:outline-none"
      >
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[calc(2rem-0.375rem)] border border-[#e5e5ea]/70 bg-[#faf9fe] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-28 right-4 h-52 w-80 rounded-full bg-[#0070eb]/[0.07] blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#0070eb]/20 to-transparent"
          />

          <header className="relative shrink-0 px-5 pb-3 pt-4 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#0070eb] to-[#0058bc] text-white shadow-sm">
                  <ShareNetwork size={17} weight="bold" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#0058bc]">
                    Share Studio · Focus
                  </p>
                  <h2
                    id="session-share-title"
                    className="font-display truncate text-[19px] font-semibold tracking-tight text-[#1a1b1f]"
                  >
                    Share this focus session
                  </h2>
                  <p
                    id="session-share-desc"
                    className="mt-0.5 max-w-xl text-[12px] leading-relaxed text-ink-3"
                  >
                    A complete session card, rendered locally. Nothing is uploaded.
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="tnum hidden items-center rounded-lg border border-[#e5e5ea] bg-[#f4f3f8] px-2.5 py-1.5 font-mono text-[10.5px] text-[#414755] sm:inline-flex">
                  3× PNG · {aspect.outW} × {aspect.outH}
                </span>
                <button
                  type="button"
                  onClick={requestClose}
                  disabled={busy !== null}
                  aria-label="Close share dialog"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[#e5e5ea] bg-white text-[#414755] transition-all duration-200 hover:bg-[#f4f3f8] hover:text-[#1a1b1f] active:scale-95 disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                >
                  <X size={15} weight="bold" aria-hidden />
                </button>
              </div>
            </div>
          </header>

          <div className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-4 sm:px-6">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_260px] md:items-start">
              <section aria-label="Session card preview" className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-[#1a1b1f]">Card preview</span>
                    <span className="tnum rounded-full border border-[#e5e5ea] bg-white px-2 py-0.5 font-mono text-[10px] text-[#414755]">
                      {aspect.label}
                    </span>
                    {session ? (
                      <span className="text-[11px] text-ink-3">
                        Preview at {Math.round(scale * 100)}% · export at 3×
                      </span>
                    ) : null}
                  </div>
                </div>

                <div
                  ref={previewBoxRef}
                  className="relative flex min-h-[190px] w-full items-center justify-center overflow-auto rounded-[20px] border border-[#e5e5ea] bg-[#f4f3f8] p-4"
                >
                  {!session ? (
                    isError ? (
                      <div
                        role="alert"
                        className="flex w-full max-w-[360px] flex-col items-center rounded-[22px] border border-[#e5e5ea] bg-white px-5 py-6 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                      >
                        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                          <WarningCircle size={20} weight="bold" aria-hidden />
                        </span>
                        <h3 className="mt-3 text-[14px] font-semibold text-[#1a1b1f]">
                          Couldn&apos;t load this session
                        </h3>
                        <p className="mt-1 break-words text-[11.5px] leading-relaxed text-ink-3">
                          {errorText(error)}
                        </p>
                        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={retry}
                            disabled={isFetching}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#0070eb] px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-all duration-200 hover:bg-[#0058bc] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                          >
                            {isFetching ? (
                              <ArrowClockwise
                                size={13}
                                weight="bold"
                                className="animate-spin motion-reduce:animate-none"
                                aria-hidden
                              />
                            ) : null}
                            {isFetching ? "Retrying…" : "Retry"}
                          </button>
                          <button
                            type="button"
                            onClick={requestClose}
                            disabled={busy !== null}
                            className="inline-flex items-center rounded-lg border border-[#e5e5ea] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#1a1b1f] transition-all duration-200 hover:bg-[#f4f3f8] active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        role="status"
                        aria-live="polite"
                        className="flex w-full max-w-[300px] flex-col justify-between rounded-[22px] border border-[#e5e5ea] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                        style={{ aspectRatio: "1 / 1" }}
                      >
                        <div className="flex items-center gap-2 text-[12.5px] font-medium text-[#414755]">
                          <ArrowClockwise
                            size={15}
                            weight="bold"
                            className="animate-spin text-[#0058bc] motion-reduce:animate-none"
                            aria-hidden
                          />
                          Preparing session card…
                        </div>
                        <div className="animate-pulse space-y-2 motion-reduce:animate-none" aria-hidden>
                          <div className="h-2.5 w-24 rounded bg-[#f0eff5]" />
                          <div className="h-10 w-3/4 rounded-lg bg-[#f0eff5]" />
                          <div className="grid grid-cols-3 gap-1.5">
                            {Array.from({ length: 6 }).map((_, i) => (
                              <div key={i} className="h-7 rounded-md bg-[#f6f5fa]" />
                            ))}
                          </div>
                        </div>
                        <div className="space-y-1.5" aria-hidden>
                          <div className="h-2 w-full rounded bg-[#f6f5fa]" />
                          <div className="h-2 w-2/3 rounded bg-[#f6f5fa]" />
                        </div>
                      </div>
                    )
                  ) : (
                    <div
                      className="mx-auto shrink-0"
                      style={{
                        width: Math.round(aspect.w * scale),
                        height: Math.round(aspect.h * scale),
                        background: theme.canvas,
                        borderRadius: Math.max(2, theme.radius * scale),
                        overflow: "hidden",
                        boxShadow:
                          theme.id === "editorial"
                            ? "0 18px 40px -26px rgba(0,0,0,0.55)"
                            : "0 26px 60px -30px rgba(0,0,0,0.6)",
                      }}
                    >
                      <div
                        style={{
                          width: aspect.w,
                          height: aspect.h,
                          transform: `scale(${scale})`,
                          transformOrigin: "top left",
                        }}
                      >
                        <SessionCard
                          data={session}
                          aspect={aspect}
                          aspectId={aspectId}
                          theme={theme}
                          cardRef={cardRef}
                          uid={uid}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] leading-snug text-ink-3">
                  <span>
                    Card art is authored at {aspect.w} × {aspect.h} CSS px.
                  </span>
                  <span className="tnum font-mono">{aspectNote}</span>
                </p>
                {session ? (
                  <p className="sr-only">
                    {session.name}. {session.statusLabel}. {session.stopReason}.{" "}
                    {session.dateLabel}, {session.timeRange}, {session.durationLabel}.{" "}
                    {fmtTokens(session.tokens)} total tokens, {fmtCost(session.cost)},{" "}
                    {fmtCount(session.messages)} messages. Input {fmtTokens(session.input)},
                    output {fmtTokens(session.output)}, cache read{" "}
                    {fmtTokens(session.cacheRead)}, cache write {fmtTokens(session.cacheWrite)},
                    reasoning {fmtTokens(session.reasoning)}, cache hit{" "}
                    {fmtPct(session.cacheHit)}. {session.modelsUsed} models,{" "}
                    {session.clientsUsed} clients. Top model{" "}
                    {session.topModelLabel ?? "not reported"}. Peak day{" "}
                    {session.peakDay
                      ? `${session.peakDay.label}, ${fmtTokens(session.peakDay.tokens)} tokens`
                      : "not reported"}
                    .
                  </p>
                ) : null}
              </section>

              <aside
                aria-label="Session card appearance"
                className="min-w-0 rounded-[20px] border border-[#e5e5ea] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
              >
                <div className="mb-3 flex items-center justify-between gap-2 border-b border-[#f2f2f7] pb-2.5">
                  <div className="min-w-0">
                    <h3 className="text-[13.5px] font-semibold tracking-tight text-[#1a1b1f]">
                      Card options
                    </h3>
                    <p className="mt-0.5 text-[11px] text-ink-3">Aspect &amp; palette</p>
                  </div>
                  <span className="shrink-0 rounded bg-[#f4f3f8] px-2 py-0.5 font-mono text-[10px] text-[#414755]">
                    {aspect.short}
                  </span>
                </div>

                <div role="group" aria-label="Aspect ratio">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-3">
                    Aspect ratio
                  </p>
                  <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] p-1">
                    {ASPECT_ORDER.map((id) => {
                      const a = ASPECTS[id];
                      const on = aspectId === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setAspect(id)}
                          disabled={controlsDisabled}
                          aria-pressed={on}
                          aria-label={`${a.label}, exports at ${a.outW} by ${a.outH} pixels`}
                          className={`min-w-0 rounded-lg border px-1.5 py-1.5 text-left transition-all duration-200 ease-out active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
                            on
                              ? "border-[#0070eb]/30 bg-white text-[#0058bc] shadow-sm"
                              : "border-transparent text-[#414755] hover:bg-white hover:text-[#1a1b1f]"
                          }`}
                        >
                          <span className="flex items-center justify-between gap-1">
                            <span className="block truncate font-mono text-[11px] font-semibold">
                              {id}
                            </span>
                            <span
                              aria-hidden
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                on ? "bg-[#0070eb]" : "bg-[#d9d9de]"
                              }`}
                            />
                          </span>
                          <span className="mt-0.5 block truncate text-[10px] font-medium">
                            {a.short}
                          </span>
                          <span className="tnum mt-0.5 block truncate font-mono text-[8.5px] opacity-60">
                            {a.w}×{a.h}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div role="group" aria-label="Card theme" className="mt-4">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-3">
                    Theme
                  </p>
                  <div className="space-y-1.5">
                    {THEME_ORDER.map((id) => {
                      const t = THEMES[id];
                      const on = themeId === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setTheme(id)}
                          disabled={controlsDisabled}
                          aria-pressed={on}
                          aria-label={`${t.name}, ${t.blurb}`}
                          className={`flex w-full min-w-0 items-center gap-2.5 rounded-xl border p-2 text-left transition-all duration-200 ease-out active:scale-[0.99] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
                            on
                              ? "border-[#0070eb] bg-white shadow-sm ring-2 ring-[#0070eb]/20"
                              : "border-[#e5e5ea] bg-[#f4f3f8] hover:bg-[#e9e7ed]"
                          }`}
                        >
                          <span className="flex h-7 w-8 shrink-0 gap-0.5 overflow-hidden rounded-[4px] border border-black/10">
                            {t.swatch.map((color, i) => (
                              <span
                                key={`${color}-${i}`}
                                className="h-full flex-1"
                                style={{ background: color }}
                              />
                            ))}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11.5px] font-semibold text-[#1a1b1f]">
                              {t.name}
                            </span>
                            <span className="block truncate text-[9.5px] leading-tight text-ink-3">
                              {t.blurb}
                            </span>
                          </span>
                          <span
                            aria-hidden
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                              on ? "bg-[#0070eb] text-white" : "bg-transparent text-transparent"
                            }`}
                          >
                            <Check size={10} weight="bold" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <p className="mt-3 border-t border-[#f2f2f7] pt-2.5 text-[10px] leading-snug text-ink-3">
                  The capture node stays at exact integer pixels. Only the preview wrapper is
                  scaled, so the 3× PNG matches the card.
                </p>
              </aside>
            </div>
          </div>

          <footer className="relative shrink-0 border-t border-[#e5e5ea] bg-[#faf9fe] px-5 py-3 sm:px-6">
            <div className="flex flex-col gap-2">
              {notice ? (
                <p
                  role={notice.kind === "ok" ? "status" : "alert"}
                  className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[11.5px] leading-snug ${
                    notice.kind === "ok"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : notice.kind === "warn"
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : "border-red-200 bg-red-50 text-red-700"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                      notice.kind === "ok"
                        ? "bg-emerald-500"
                        : notice.kind === "warn"
                          ? "bg-amber-500"
                          : "bg-red-500"
                    }`}
                  />
                  <span className="min-w-0 break-words">{notice.text}</span>
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="tnum flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                  />
                  Rendered locally · {aspect.outW} × {aspect.outH} px
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copyPng()}
                    disabled={actionsDisabled}
                    aria-busy={busy === "copy"}
                    aria-label={`Copy focus session card as a ${aspect.outW} by ${aspect.outH} pixel PNG`}
                    className="inline-flex min-h-[38px] items-center gap-2 rounded-xl border border-[#e5e5ea] bg-white px-3.5 py-2 text-[12px] font-semibold text-[#1c1c1e] transition-all duration-200 ease-out hover:bg-[#f4f3f8] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                  >
                    {busy === "copy" ? (
                      <ArrowClockwise
                        size={15}
                        weight="bold"
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                    ) : lastAction === "copy" && notice?.kind === "ok" ? (
                      <Check size={15} weight="bold" className="text-emerald-600" aria-hidden />
                    ) : (
                      <Copy size={15} weight="bold" aria-hidden />
                    )}
                    <span>{busy === "copy" ? "Rendering…" : "Copy PNG"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadPng()}
                    disabled={actionsDisabled}
                    aria-busy={busy === "download"}
                    aria-label={`Download focus session card at 3×, ${aspect.outW} by ${aspect.outH} pixels`}
                    className="inline-flex min-h-[38px] items-center gap-2 rounded-xl bg-[#0070eb] px-3.5 py-2 text-[12px] font-semibold text-white shadow-sm transition-all duration-200 ease-out hover:bg-[#0058bc] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                  >
                    {busy === "download" ? (
                      <ArrowClockwise
                        size={15}
                        weight="bold"
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                    ) : lastAction === "download" && notice?.kind === "ok" ? (
                      <Check size={15} weight="bold" aria-hidden />
                    ) : (
                      <DownloadSimple size={15} weight="bold" aria-hidden />
                    )}
                    <span>{busy === "download" ? "Rendering…" : "Download 3×"}</span>
                  </button>
                </div>
              </div>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
