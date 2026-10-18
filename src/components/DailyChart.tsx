import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import * as echarts from "echarts";
import { ChartLine } from "@phosphor-icons/react";
import type { DailyDTO } from "../lib/tauri";
import { fmtCompact, fmtCost, fmtTokens } from "../lib/format";
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
type TokenSeriesKey = "total" | "input" | "cache" | "output";

const TOKEN_SERIES: { key: TokenSeriesKey; label: string; color: string }[] = [
  { key: "total", label: "Total", color: "#0070eb" },
  { key: "input", label: "Input", color: "#009E73" },
  { key: "cache", label: "Cache read", color: "#E69F00" },
  { key: "output", label: "Output", color: "#D55E00" },
];

/**
 * Per-day breakdown value. DailyDTO only guarantees totals; input / output /
 * cache_read are read defensively so the multi-series UI lights up if a future
 * backend rollup ships per-day breakdowns (missing fields read as 0).
 */
function tokenSeriesValue(d: DailyDTO, key: TokenSeriesKey): number {
  if (key === "total") return d.tokens;
  const b = d as DailyDTO & Partial<Record<"input" | "output" | "cache_read", number>>;
  if (key === "input") return Math.max(0, b.input ?? 0);
  if (key === "cache") return Math.max(0, b.cache_read ?? 0);
  return Math.max(0, b.output ?? 0);
}

/** "2026-10-18" → "Oct 18" (parsed naively to dodge timezone drift). */
function fmtDayLabel(date: string): string {
  const parts = date.split("-");
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return `${MONTHS[(m - 1 + 12) % 12] ?? parts[1]} ${d}`;
}

function metricValue(d: DailyDTO, metric: Metric): number {
  return metric === "tokens" ? d.tokens : metric === "cost" ? d.cost : d.messages;
}

function fmtMetric(v: number, metric: Metric): string {
  return metric === "cost" ? fmtCost(v) : fmtTokens(v);
}

/** rAF count-up, instant when the user prefers reduced motion. */
function useCountUp(target: number, duration = 900): number {
  const reduceMotion = useReducedMotion();
  const [value, setValue] = useState(() => (reduceMotion ? target : 0));
  useEffect(() => {
    if (reduceMotion) {
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduceMotion]);
  return value;
}

function ChartSkeleton() {
  return (
    <div aria-hidden className="rounded-2xl border border-[#E4E1E8] bg-white p-5">
      <div className="h-4 w-32 animate-pulse rounded bg-zinc-100" />
      <div className="mt-3 h-64 w-full animate-pulse rounded-xl bg-zinc-100" />
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
  const reduceMotion = useReducedMotion();
  const hasData = days.length > 0;
  // Hooks must run unconditionally (Rules of Hooks): compute + animate
  // before any early return so hook order never shifts between renders.
  const totalValue = days.reduce((a, d) => a + metricValue(d, metric), 0);
  const animatedTotal = useCountUp(totalValue);

  useEffect(() => {
    const el = ref.current;
    if (!el || days.length === 0) {
      // Detached-DOM fix: always tear the instance down when the series goes
      // empty so a later mount re-initializes cleanly on the fresh element.
      chartRef.current?.dispose();
      chartRef.current = null;
      return;
    }
    // If the container element was remounted, drop the stale instance.
    if (chartRef.current && chartRef.current.getDom() !== el) {
      chartRef.current.dispose();
      chartRef.current = null;
    }
    if (!chartRef.current) chartRef.current = echarts.init(el);
    const chart = chartRef.current;
    const style = METRIC_STYLE[metric];

    const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
    const values = sorted.map((d) => metricValue(d, metric));
    const total = values.reduce((a, v) => a + v, 0);
    const avg = values.length > 0 ? total / values.length : 0;

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
      ? shown.map((s, i) => {
          const vals = sorted.map((d) => tokenSeriesValue(d, s.key));
          const seriesAvg = vals.length > 0 ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
          return {
            name: s.label,
            type: "line",
            smooth: 0.3,
            showSymbol: false,
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
            // Avg reference keeps the dashed line but drops the in-chart label
            // (the stats strip already shows avg): with no label there is no
            // overlap or grid-edge clipping, even when avg sits near data max.
            ...(i === 0
              ? {
                  markLine: {
                    silent: true,
                    symbol: "none",
                    data: [{ yAxis: seriesAvg }],
                    lineStyle: { color: "#C9C4D6", type: "dashed", width: 1 },
                    label: { show: false },
                  },
                }
              : {}),
          };
        })
      : [
          {
            name: style.label,
            type: "line",
            smooth: 0.3,
            showSymbol: false,
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
            markLine: {
              silent: true,
              symbol: "none",
              data: [{ yAxis: avg }],
              lineStyle: { color: "#C9C4D6", type: "dashed", width: 1 },
              label: { show: false },
            },
          },
        ];

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
          backgroundColor: "#FFFFFF",
          borderColor: "#E4E1E8",
          borderWidth: 1,
          padding: [10, 12],
          extraCssText:
            "border-radius: 12px; box-shadow: 0 12px 32px -12px rgba(0,0,0,0.18);",
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
                    ["Spend", fmtCost(day.cost), "#D97706"],
                    ["Messages", `${day.messages.toLocaleString()}`, "#717786"],
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
        grid: { left: 12, right: 16, top: 36, bottom: 8, containLabel: true },
        xAxis: {
          type: "category",
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
          splitLine: { lineStyle: { color: "#EFEDF1", type: "dashed" } },
          axisLabel: {
            color: "#717786",
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            hideOverlap: true,
            margin: 8,
            formatter: (v: number) =>
              metric === "cost" ? `$${fmtCompact(v)}` : fmtCompact(v),
          },
        },
        series: lineSeries,
      },
      { notMerge: true },
    );
  }, [days, metric, reduceMotion, activeSeries]);

  // Container-driven resize: sidebar / layout changes flow to the chart.
  // ResizeObserver covers container shifts; window listener covers viewport
  // zoom / scrollbar changes ECharts can't observe on the div alone.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    ro.observe(el);
    const onWindowResize = () => chartRef.current?.resize();
    window.addEventListener("resize", onWindowResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWindowResize);
    };
  }, [hasData]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  if (loading && days.length === 0) return <ChartSkeleton />;
  if (days.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E4E1E8] bg-white p-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">
        <div className="flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-[#E4E1E8] bg-[#FAFAFC]">
          <p className="font-sans text-[13px] text-[#414755]">No activity in this range</p>
          <p className="mt-1 font-sans text-[12px] text-[#717786]">Try clearing filters or scanning again</p>
        </div>
      </div>
    );
  }

  const avgValue = totalValue / days.length;
  const peak = days.reduce<DailyDTO | null>(
    (best, d) => (!best || metricValue(d, metric) > metricValue(best, metric) ? d : best),
    null,
  );
  const style = METRIC_STYLE[metric];
  const displayTotal = reduceMotion ? totalValue : animatedTotal;
  // A toggle is usable only when at least one day carries that breakdown.
  const tokenAvailability: Record<TokenSeriesKey, boolean> = {
    total: true,
    input: days.some((d) => tokenSeriesValue(d, "input") > 0),
    cache: days.some((d) => tokenSeriesValue(d, "cache") > 0),
    output: days.some((d) => tokenSeriesValue(d, "output") > 0),
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
                        : "border-[#E4E1E8] bg-transparent text-[#717786] hover:text-[#1b1b1d]",
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
          <span className="font-sans text-[#717786]"> per day</span>
        </span>
        {peak && (
          <>
            <span aria-hidden className="h-3 w-px bg-[#E4E1E8]" />
            <span>
              <span className="font-sans text-[#626267]">peak </span>
              <span className="text-[#414755]">{fmtDayLabel(peak.date)}</span>{" "}
              <span className="font-semibold text-[#1b1b1d]">
                {metric === "cost"
                  ? fmtCost(peak.cost)
                  : metric === "tokens"
                    ? fmtTokens(peak.tokens)
                    : peak.messages.toLocaleString()}
              </span>
            </span>
          </>
        )}
      </div>

      <div ref={ref} className="mt-2 h-72 w-full" role="img" aria-label={`Daily ${style.label.toLowerCase()} chart`} />
    </motion.section>
  );
}
