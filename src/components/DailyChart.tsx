import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import * as echarts from "echarts";
import { ChartLine } from "@phosphor-icons/react";
import type { DailyDTO } from "../lib/tauri";
import { fmtCost, fmtCostPrecise, fmtTokens } from "../lib/format";
import { cn } from "../lib/cn";

type Metric = "tokens" | "cost" | "messages";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

/** Light Cupertino accents: blue tokens, amber spend, neutral messages. */
const METRIC_STYLE: Record<Metric, { color: string; fill: [string, string]; label: string }> = {
  tokens: {
    color: "#0070eb",
    fill: ["rgba(0,112,235,0.22)", "rgba(0,112,235,0.01)"],
    label: "Tokens",
  },
  cost: {
    color: "#D97706",
    fill: ["rgba(217,119,6,0.18)", "rgba(217,119,6,0.01)"],
    label: "Spend",
  },
  messages: {
    color: "#717786",
    fill: ["rgba(113,119,134,0.16)", "rgba(113,119,134,0.01)"],
    label: "Messages",
  },
};

const METRIC_ORDER: Metric[] = ["tokens", "cost", "messages"];

/** Token breakdown series (Tokens mode only). Colors follow an Okabe-Ito-style
 *  colorblind-safe set; Total keeps the existing blue. No purple. */
type TokenSeriesKey = "total" | "input" | "cache" | "cache_write" | "output" | "reasoning";

const TOKEN_SERIES: { key: TokenSeriesKey; label: string; color: string }[] = [
  { key: "total", label: "Total", color: "#0070eb" },
  { key: "input", label: "Input", color: "#009E73" },
  { key: "cache", label: "Cache read", color: "#E69F00" },
  { key: "cache_write", label: "Cache write", color: "#CC79A7" },
  { key: "output", label: "Output", color: "#D55E00" },
  { key: "reasoning", label: "Reasoning", color: "#56B4E9" },
];

/**
 * Per-day breakdown value. DailyDTO only guarantees totals; input / output /
 * cache_read are read defensively so the multi-series UI lights up if a future
 * backend rollup ships per-day breakdowns (missing fields read as 0).
 */
function tokenSeriesValue(d: DailyDTO, key: TokenSeriesKey): number {
  if (key === "total") return toFinite(d.tokens);
  if (key === "input") return Math.max(0, toFinite(d.input));
  if (key === "cache") return Math.max(0, toFinite(d.cache_read));
  if (key === "cache_write") return Math.max(0, toFinite(d.cache_write));
  if (key === "reasoning") return Math.max(0, toFinite(d.reasoning));
  return Math.max(0, toFinite(d.output));
}

/** "2026-10-18" → "Oct 18" (parsed naively to dodge timezone drift). */
function fmtDayLabel(date: unknown): string {
  if (typeof date !== "string") return "—";
  const parts = date.split("-");
  if (parts.length < 3) return date;
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return date;
  return `${MONTHS[((m - 1) % 12 + 12) % 12] ?? parts[1]} ${d}`;
}

function toFinite(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function metricValue(d: DailyDTO, metric: Metric): number {
  const v = metric === "tokens" ? d.tokens : metric === "cost" ? d.cost : d.messages;
  return toFinite(v);
}

/** Card-level money: normal two-decimal currency, but keep sub-cent spend
 *  visible instead of rounding real activity down to $0.00. */
function fmtSpend(v: number): string {
  return Math.abs(v) >= 0.01 ? fmtCost(v) : fmtCostPrecise(v);
}

function fmtMetric(v: number, metric: Metric): string {
  return metric === "cost" ? fmtSpend(v) : fmtTokens(v);
}

/** Trim trailing zeroes without collapsing meaningful decimals. */
function trimNum(n: number, decimals: number): string {
  return n.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

/** Y-axis ticks: 800M / 1.5B / 250K, never 800.0M. */
function fmtTokenAxis(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1e9) return `${trimNum(v / 1e9, v >= 1e11 ? 0 : 2)}B`;
  if (v >= 1e6) return `${trimNum(v / 1e6, v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `${trimNum(v / 1e3, v >= 1e5 ? 0 : 1)}K`;
  return `${Math.round(v)}`;
}

/** One precision per cost axis keeps neighboring ticks consistent and stops
 *  cent-scale ticks collapsing: whole dollars at scale, cents for dollar
 *  ranges, extra precision below $0.10 for sub-cent values. */
function costAxisDecimals(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 2;
  if (scale >= 20) return 0;
  if (scale >= 0.1) return 2;
  if (scale >= 0.001) return 4;
  return 6;
}

/** Currency ticks: $25 / $2.50 — consistent precision across the axis, and
 *  every label (including $0) keeps the dollar sign. */
function fmtCostAxis(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return "$0";
  if (v === 0) return "$0";
  return `$${decimals > 2 ? trimNum(v, decimals) : v.toFixed(decimals)}`;
}

/** Message ticks: half-thousands stay 1.5K instead of rounding into duplicates. */
function fmtCountAxis(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1e6) return `${trimNum(v / 1e6, 1)}M`;
  if (v >= 1e3) {
    const k = v / 1e3;
    return `${Number.isInteger(k) ? k : trimNum(k, k * 10 === Math.round(k * 10) ? 1 : 2)}K`;
  }
  return `${Math.round(v)}`;
}

/** rAF count-up from the previously displayed value (never flashes from 0
 *  on refetch or metric switch), instant when the user prefers reduced motion. */
function useCountUp(target: number, duration = 900): number {
  const reduceMotion = useReducedMotion() ?? false;
  const safeTarget = typeof target === "number" && Number.isFinite(target) ? target : 0;
  const [value, setValue] = useState(() => (reduceMotion ? safeTarget : 0));
  const shownRef = useRef<number | null>(null);
  useEffect(() => {
    if (reduceMotion) {
      shownRef.current = safeTarget;
      setValue(safeTarget);
      return;
    }
    const from = shownRef.current ?? 0;
    if (from === safeTarget) {
      setValue(safeTarget);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (safeTarget - from) * eased;
      shownRef.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [safeTarget, duration, reduceMotion]);
  return value;
}

function ChartSkeleton() {
  return (
    <div aria-hidden className="rounded-2xl border border-[#E4E1E8] bg-white p-5">
      <div className="h-4 w-32 animate-pulse rounded bg-zinc-100" />
      <div className="mt-3 h-[360px] w-full animate-pulse rounded-xl bg-zinc-100" />
    </div>
  );
}

export default function DailyChart({
  days,
  loading,
}: {
  days: DailyDTO[];
  loading?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [metric, setMetric] = useState<Metric>("tokens");
  // Multi-series selection (Tokens mode). Hooks stay above every early return.
  const [activeSeries, setActiveSeries] = useState<TokenSeriesKey[]>(["total"]);
  const reduceMotion = useReducedMotion() ?? false;
  // Defensive: parent may pass undefined/null mid-fetch; never let .length throw.
  const safeDays: DailyDTO[] = Array.isArray(days) ? days : [];
  const hasData = safeDays.length > 0;
  // Hooks must run unconditionally (Rules of Hooks): compute + animate
  // before any early return so hook order never shifts between renders.
  const totalValue = safeDays.reduce((a, d) => a + metricValue(d, metric), 0);
  const animatedTotal = useCountUp(totalValue);

  useEffect(() => {
    const el = ref.current;
    if (!el || safeDays.length === 0) {
      // Detached-DOM fix: always tear the instance down when the series goes
      // empty so a later mount re-initializes cleanly on the fresh element.
      try {
        chartRef.current?.dispose();
      } catch {
        // ECharts may throw on double-dispose; safe to ignore.
      }
      chartRef.current = null;
      return;
    }
    // If the container element was remounted, drop the stale instance.
    if (chartRef.current && chartRef.current.getDom() !== el) {
      try {
        chartRef.current.dispose();
      } catch {
        // ignore stale-instance teardown errors
      }
      chartRef.current = null;
    }
    try {
      if (!chartRef.current) chartRef.current = echarts.init(el);
    } catch {
      chartRef.current = null;
      return;
    }
    const chart = chartRef.current;
    if (!chart || chart.isDisposed?.()) return;
    const style = METRIC_STYLE[metric];

    const sorted = [...safeDays].sort((a, b) => (a.date < b.date ? -1 : 1));
    const values = sorted.map((d) => metricValue(d, metric));
    const costScale = values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    const costDecimals = costAxisDecimals(costScale);
    // One day would draw a zero-width line with symbols hidden; force the dot.
    const onePoint = sorted.length === 1;

    // Multi-series model (Tokens mode): visible = toggled ON and carrying data.
    // Falls back to Total so the chart never renders an empty series list.
    const isTokens = metric === "tokens";
    const shown = isTokens
      ? (() => {
          const vis = TOKEN_SERIES.filter(
            (s) =>
              activeSeries.includes(s.key) &&
              (s.key === "total" || sorted.some((d) => tokenSeriesValue(d, s.key) > 0)),
          );
          return vis.length > 0 ? vis : [TOKEN_SERIES[0]];
        })()
      : [];

    const lineSeries: echarts.LineSeriesOption[] = isTokens
      ? shown.map((s) => {
          const vals = sorted.map((d) => tokenSeriesValue(d, s.key));
          return {
            name: s.label,
            type: "line",
            smooth: 0.3,
            showSymbol: onePoint,
            clip: true,
            lineStyle: { width: s.key === "total" ? 2.5 : 2, color: s.color },
            ...(s.key === "total"
              ? {
                  areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                      { offset: 0, color: "rgba(0,112,235,0.22)" },
                      { offset: 1, color: "rgba(0,112,235,0.01)" },
                    ]),
                  },
                }
              : {}),
            emphasis: { focus: "series" },
            data: vals,
          };
        })
      : [
          {
            name: style.label,
            type: "line",
            smooth: 0.3,
            showSymbol: onePoint,
            clip: true,
            lineStyle: { width: 2.5, color: style.color },
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: style.fill[0] },
                { offset: 1, color: style.fill[1] },
              ]),
            },
            emphasis: { focus: "series" },
            data: values,
          },
        ];

    try {
      chart.setOption(
      {
        backgroundColor: "transparent",
        animation: !reduceMotion,
        animationDuration: reduceMotion ? 0 : 900,
        animationDurationUpdate: reduceMotion ? 0 : 600,
        animationEasing: "cubicOut",
        animationEasingUpdate: "cubicOut",
        animationDelay: (idx: number) => (reduceMotion ? 0 : idx * 4),
        animationDelayUpdate: () => 0,
        tooltip: {
          trigger: "axis",
          confine: true,
          appendToBody: false,
          backgroundColor: "#FFFFFF",
          borderColor: "#E4E1E8",
          borderWidth: 1,
          padding: [10, 12],
          extraCssText:
            "border-radius: 12px; box-shadow: 0 12px 32px -12px rgba(0,0,0,0.18);max-width:280px;white-space:normal;",
          textStyle: { color: "#1b1b1d", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" },
          axisPointer: { lineStyle: { color: "rgba(0,88,188,0.35)" }, type: "line" },
          formatter: (params: unknown) => {
            const p = (Array.isArray(params) ? params[0] : params) as
              | { dataIndex?: number }
              | undefined;
            const day = p && typeof p.dataIndex === "number" ? sorted[p.dataIndex] : undefined;
            if (!day) return "";
            const rows: [string, string, string][] =
              metric === "tokens"
                ? shown.map(
                    (s): [string, string, string] => [
                      s.label,
                      fmtTokens(tokenSeriesValue(day, s.key)),
                      s.color,
                    ],
                  )
                : [
                    ["Tokens", fmtTokens(day.tokens), "#0070eb"],
                    ["Spend", fmtSpend(day.cost), "#D97706"],
                    ["Messages", `${toFinite(day.messages).toLocaleString()}`, "#717786"],
                  ];
            return `
              <div style="min-width:168px;font-family:'JetBrains Mono',monospace">
                <div style="font-size:11px;font-weight:600;color:#1b1b1d;margin-bottom:7px">${fmtDayLabel(day.date)}</div>
                ${rows
                  .map(
                    ([label, value, color]) => `
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:20px;padding:2px 0">
                    <span style="display:flex;align-items:center;gap:7px;color:#626267;font-size:11px;font-family:sans-serif">
                      <span style="width:6px;height:6px;border-radius:999px;background:${color}"></span>
                      ${label}
                    </span>
                    <span style="color:#1b1b1d;font-size:12px;font-weight:600">${value}</span>
                  </div>`,
                  )
                  .join("")}
              </div>`;
          },
        },
        // Fixed left gutter: currency labels need real room, and containLabel
        // alone still clipped them at the card edge in the old 3/5 layout.
        grid: { left: 62, right: 24, top: 30, bottom: 26 },
        xAxis: {
          type: "category",
          boundaryGap: false,
          data: sorted.map((d) => fmtDayLabel(d.date)),
          axisLine: { lineStyle: { color: "#E4E1E8" } },
          axisTick: { show: false },
          axisLabel: {
            color: "#717786",
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            interval: "auto",
            hideOverlap: true,
            margin: 8,
          },
        },
        yAxis: {
          type: "value",
          splitNumber: 4,
          // Counts must not land on fractional ticks (0.5 messages would round
          // into duplicate labels); callback formatters can't dedupe.
          minInterval: metric === "cost" ? 0 : 1,
          splitLine: { lineStyle: { color: "#EFEDF1", type: "dashed" } },
          axisLabel: {
            color: "#717786",
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            hideOverlap: true,
            margin: 10,
            formatter: (v: number) =>
              metric === "cost"
                ? fmtCostAxis(v, costDecimals)
                : metric === "messages"
                  ? fmtCountAxis(v)
                  : fmtTokenAxis(v),
          },
        },
        series: lineSeries,
      },
      { notMerge: true },
    );
    } catch {
      // Never let a chart option error blank the page; empty state covers it.
    }
  }, [safeDays, metric, reduceMotion, activeSeries]);

  // Container-driven resize: sidebar / layout changes flow to the chart.
  // ResizeObserver covers container shifts; window listener covers viewport
  // zoom / scrollbar changes ECharts can't observe on the div alone.
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasData) return;
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(() => {
        try {
          if (chartRef.current && !chartRef.current.isDisposed?.()) {
            chartRef.current.resize();
          }
        } catch {
          // resize on a torn-down instance must not crash the page
        }
      });
      ro.observe(el);
    } catch {
      ro = null;
    }
    const onWindowResize = () => {
      try {
        if (chartRef.current && !chartRef.current.isDisposed?.()) {
          chartRef.current.resize();
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      try {
        ro?.disconnect();
      } catch {
        // ignore
      }
      window.removeEventListener("resize", onWindowResize);
    };
  }, [hasData]);

  useEffect(() => {
    return () => {
      try {
        chartRef.current?.dispose();
      } catch {
        // ignore double-dispose races (StrictMode / fast remount)
      }
      chartRef.current = null;
    };
  }, []);

  if (loading && safeDays.length === 0) return <ChartSkeleton />;
  if (safeDays.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E4E1E8] bg-white p-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">
        <div className="flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-[#E4E1E8] bg-[#FAFAFC]">
          <p className="font-sans text-[13px] text-[#414755]">No activity in this range</p>
          <p className="mt-1 font-sans text-[12px] text-ink-3">Try clearing filters or scanning again</p>
        </div>
      </div>
    );
  }

  const avgValue = safeDays.length > 0 ? totalValue / safeDays.length : 0;
  const peak = safeDays.reduce<DailyDTO | null>(
    (best, d) => (!best || metricValue(d, metric) > metricValue(best, metric) ? d : best),
    null,
  );
  const style = METRIC_STYLE[metric];
  const displayTotal = reduceMotion ? totalValue : animatedTotal;
  // A toggle is usable only when at least one day carries that breakdown.
  const tokenAvailability: Record<TokenSeriesKey, boolean> = {
    total: true,
    input: safeDays.some((d) => tokenSeriesValue(d, "input") > 0),
    cache: safeDays.some((d) => tokenSeriesValue(d, "cache") > 0),
    cache_write: safeDays.some((d) => tokenSeriesValue(d, "cache_write") > 0),
    output: safeDays.some((d) => tokenSeriesValue(d, "output") > 0),
    reasoning: safeDays.some((d) => tokenSeriesValue(d, "reasoning") > 0),
  };

  return (
    <motion.section
      aria-label="Daily throughput"
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-32px" }}
      transition={{ duration: 0.55, ease: EASE }}
      className="rounded-2xl border border-[#E4E1E8] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]"
    >
      <div className="flex flex-col gap-3 border-b border-[#F0EDEF] pb-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 font-sans text-[16px] font-semibold tracking-[-0.015em] text-[#1b1b1d]">
            <ChartLine size={16} className="shrink-0 text-[#0058bc]" aria-hidden />
            Token Velocity &amp; Spend Trends
          </h2>
          <p className="mt-0.5 font-sans text-[12px] text-[#626267]">
            Telemetry log across all active local proxies
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {metric === "tokens" && (
            <div role="group" aria-label="Token series" className="flex items-center gap-1.5">
              {TOKEN_SERIES.map((s) => {
                const on = activeSeries.includes(s.key);
                const avail = tokenAvailability[s.key];
                return (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={on}
                    disabled={!avail}
                    title={
                      !avail
                        ? `${s.label}: no per-day breakdown in this range`
                        : `${on ? "Hide" : "Show"} ${s.label} series`
                    }
                    onClick={() => {
                      if (!avail) return;
                      setActiveSeries((prev) => {
                        if (prev.includes(s.key)) {
                          // Minimum 1 active: refuse to switch the last one off.
                          return prev.length <= 1 ? prev : prev.filter((k) => k !== s.key);
                        }
                        return [...prev, s.key];
                      });
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11px] font-medium transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0058bc] active:scale-[0.97] disabled:cursor-not-allowed",
                      on && avail
                        ? "border-[#D8D3E0] bg-white text-[#1b1b1d] shadow-sm"
                        : "border-[#E4E1E8] bg-transparent text-ink-3 hover:text-[#1b1b1d]",
                      !avail && "opacity-40",
                    )}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-[3px]"
                      style={{ background: s.color, opacity: on && avail ? 1 : 0.35 }}
                      aria-hidden
                    />
                    {s.label}
                  </button>
                );
              })}
            </div>
          )}
          <div
            role="group"
            aria-label="Metric"
            className="flex shrink-0 rounded-lg border border-[#E4E1E8] bg-[#F6F3F5] p-0.5"
          >
            {METRIC_ORDER.map((m) => {
              const active = metric === m;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setMetric(m)}
                  className={cn(
                    "rounded-md px-3 py-1 font-sans text-[12px] font-medium transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0058bc] active:scale-[0.98]",
                    active
                      ? "bg-white font-semibold text-[#0058bc] shadow-sm"
                      : "text-[#626267] hover:text-[#1b1b1d]",
                  )}
                >
                  {METRIC_STYLE[m].label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="tnum mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px]">
        <span>
          <span className="font-sans text-[#626267]">total </span>
          <span className="font-semibold" style={{ color: style.color }}>
            {fmtMetric(displayTotal, metric)}
          </span>
        </span>
        <span aria-hidden className="h-3 w-px bg-[#E4E1E8]" />
        <span>
          <span className="font-sans text-[#626267]">avg </span>
          <span className="text-[#414755]">{fmtMetric(avgValue, metric)}</span>
          <span className="font-sans text-ink-3"> per day</span>
        </span>
        {peak && (
          <>
            <span aria-hidden className="h-3 w-px bg-[#E4E1E8]" />
            <span>
              <span className="font-sans text-[#626267]">peak </span>
              <span className="text-[#414755]">{fmtDayLabel(peak.date)}</span>{" "}
              <span className="font-semibold text-[#1b1b1d]">
                {metric === "cost"
                  ? fmtSpend(peak.cost)
                  : metric === "tokens"
                    ? fmtTokens(peak.tokens)
                    : toFinite(peak.messages).toLocaleString()}
              </span>
            </span>
          </>
        )}
      </div>

      <div ref={ref} className="mt-3 h-[360px] w-full" role="img" aria-label={`Daily ${style.label.toLowerCase()} chart`} />
    </motion.section>
  );
}
