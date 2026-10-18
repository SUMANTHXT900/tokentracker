import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import * as echarts from "echarts";
import { ArrowRight, Cube } from "@phosphor-icons/react";
import type { ModelRowDTO } from "../lib/tauri";
import { fmtCost, fmtPct, fmtTokens } from "../lib/format";
import { getClientVisual } from "../lib/client-color";
import { cn } from "../lib/cn";

/** Phosphor, amber, teal, rose, fog, slate. No purple or blue, by design. */
const PALETTE = ["#35D99A", "#E8A33D", "#4CC9C0", "#E26D7E", "#C2C8D1", "#5F6570"];

/** Bar opacities step down by rank, mirroring the Stitch reference. */
const BAR_OPACITY = [1, 0.8, 0.6, 0.4, 0.25];

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

type ViewMode = "auto" | "donut" | "bars";
type Metric = "cost" | "tokens";

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string }[];
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex rounded-lg border border-[#E4E1E8] bg-[#F6F3F5] p-0.5"
    >
      {options.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className={cn(
              "rounded-md px-2 py-1 font-sans text-[11px] font-medium transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0058bc] active:scale-[0.98]",
              active ? "bg-white font-semibold text-[#0058bc] shadow-sm" : "text-[#626267] hover:text-[#1b1b1d]",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function ModelDonut({ models }: { models: ModelRowDTO[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [view, setView] = useState<ViewMode>("auto");
  const [metric, setMetric] = useState<Metric>("cost");
  /** Measured ring box — keeps the centre readout inside the donut hole. */
  const [box, setBox] = useState({ w: 0, h: 0 });
  const reduceMotion = useReducedMotion();

  const totalCost = useMemo(() => models.reduce((a, m) => a + m.cost, 0), [models]);
  // Free / $0 contributor models: never render a blank chart — share by tokens.
  const effectiveMetric: Metric = totalCost === 0 ? "tokens" : metric;

  const { slices, total, otherShare, top10 } = useMemo(() => {
    const valueOf = (m: ModelRowDTO) =>
      effectiveMetric === "cost" ? m.cost : m.tokens;
    const sorted = [...models].sort((a, b) => valueOf(b) - valueOf(a));
    const totalValue = sorted.reduce((a, m) => a + valueOf(m), 0);

    const top = sorted.slice(0, 5);
    const rest = sorted.slice(5);
    const out = top.map((m) => ({
      name: shorten(m.model, 22),
      full: `${m.model} (${m.client})`,
      client: m.client,
      tokens: m.tokens,
      cost: m.cost,
      value: valueOf(m),
    }));
    if (rest.length > 0) {
      out.push({
        name: `Other (${rest.length})`,
        full: rest.map((r) => `${r.model} (${r.client})`).join(", "),
        client: "",
        tokens: rest.reduce((a, m) => a + m.tokens, 0),
        cost: rest.reduce((a, m) => a + m.cost, 0),
        value: rest.reduce((a, m) => a + valueOf(m), 0),
      });
    }
    const otherValue = rest.length > 0 ? out[out.length - 1].value : 0;
    return {
      slices: out,
      total: totalValue,
      otherShare: totalValue > 0 ? otherValue / totalValue : 0,
      top10: sorted.slice(0, 10),
    };
  }, [models, effectiveMetric]);

  // Auto: long tail dominates → the donut is unreadable, prefer ranked bars.
  const resolvedView: "donut" | "bars" =
    view === "auto" ? (otherShare > 0.3 ? "bars" : "donut") : view;
  const donutActive = resolvedView === "donut";

  useEffect(() => {
    const el = ref.current;
    if (!donutActive || !el) {
      // Clean disposal when switching to the HTML bars view (or emptying).
      chartRef.current?.dispose();
      chartRef.current = null;
      return;
    }
    if (chartRef.current && chartRef.current.getDom() !== el) {
      chartRef.current.dispose();
      chartRef.current = null;
    }
    if (!chartRef.current) chartRef.current = echarts.init(el);
    const chart = chartRef.current;

    chart.setOption(
      {
        backgroundColor: "transparent",
        animationDuration: reduceMotion ? 0 : 600,
        animationEasing: "cubicOut",
        color: PALETTE,
        tooltip: {
          trigger: "item",
          confine: true,
          backgroundColor: "#FFFFFF",
          borderColor: "#E4E1E8",
          borderWidth: 1,
          padding: [10, 12],
          extraCssText:
            "border-radius: 12px; box-shadow: 0 12px 32px -12px rgba(0,0,0,0.18);",
          textStyle: {
            color: "#1b1b1d",
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter: (params: any) => {
            const d = (params?.data ?? {}) as {
              name?: string;
              full?: string;
              tokens?: number;
              cost?: number;
              value?: number;
            };
            const share = total > 0 && typeof d.value === "number" ? d.value / total : 0;
            return `
              <div style="min-width:176px;font-family:'JetBrains Mono',monospace">
                <div style="font-size:11.5px;font-weight:600;color:#1b1b1d;margin-bottom:7px">${d.full ?? d.name ?? ""}</div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:20px;padding:2px 0">
                  <span style="color:#626267;font-size:11px;font-family:sans-serif">Share</span>
                  <span style="color:#1b1b1d;font-size:12px;font-weight:600">${fmtPct(share)}</span>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:20px;padding:2px 0">
                  <span style="color:#626267;font-size:11px;font-family:sans-serif">Tokens</span>
                  <span style="color:#1b1b1d;font-size:12px;font-weight:600">${fmtTokens(d.tokens ?? 0)}</span>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:20px;padding:2px 0">
                  <span style="color:#626267;font-size:11px;font-family:sans-serif">Cost</span>
                  <span style="color:#1b1b1d;font-size:12px;font-weight:600">${fmtCost(d.cost ?? 0)}</span>
                </div>
              </div>`;
          },
        },
        series: [
          {
            type: "pie",
            radius: ["62%", "78%"],
            center: ["50%", "48%"],
            avoidLabelOverlap: true,
            padAngle: 2,
            itemStyle: { borderColor: "#FFFFFF", borderWidth: 3, borderRadius: 3 },
            // No in-chart labels — the ledger below keeps the ring clean.
            label: { show: false },
            labelLine: { show: false },
            emphasis: { scale: true, scaleSize: 4 },
            data: slices.map((s) => ({
              name: s.name,
              value: s.value,
              full: s.full,
              tokens: s.tokens,
              cost: s.cost,
            })),
          },
        ],
      },
      { notMerge: true },
    );
  }, [slices, donutActive, total, reduceMotion]);

  // Container-driven resize so layout/sidebar changes reflow the ring, plus a
  // measured box so the centre readout scales to the hole instead of overlapping it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      chartRef.current?.resize();
      const r = el.getBoundingClientRect();
      setBox((b) => (b.w === r.width && b.h === r.height ? b : { w: r.width, h: r.height }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [donutActive]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  if (models.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E4E1E8] bg-white p-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">
        <div className="flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-[#E4E1E8] bg-[#FAFAFC]">
          <Cube size={20} className="text-[#717786]" aria-hidden />
          <p className="mt-2 font-sans text-[13px] text-[#414755]">No models in this range</p>
        </div>
      </div>
    );
  }

  const totalLabel = effectiveMetric === "cost" ? fmtCost(total) : fmtTokens(total);
  // Inner hole of the ring (radius 62% of the smaller edge) drives the centre type size,
  // so the total can never spill under the arc on a narrow card.
  const measured = box.w > 0 && box.h > 0;
  const hole = measured ? Math.min(box.w, box.h) * 0.62 : 0;
  const numSize = measured ? Math.max(12, Math.min(20, hole * 0.17)) : 20;
  const capSize = measured ? Math.max(9, Math.min(11, hole * 0.1)) : 11;
  const maxRowValue =
    top10.length > 0
      ? Math.max(
          ...top10.map((m) => (effectiveMetric === "cost" ? m.cost : m.tokens)),
          0.0001,
        )
      : 1;

  return (
    <motion.section
      aria-label="Model mix"
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-32px" }}
      transition={{ duration: 0.55, delay: 0.05, ease: EASE }}
      className="flex h-full flex-col justify-between rounded-2xl border border-[#E4E1E8] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]"
    >
      <div>
        <div className="flex items-center justify-between gap-2 border-b border-[#F0EDEF] pb-3">
          <div className="min-w-0">
            <h3 className="font-sans text-[16px] font-semibold tracking-[-0.015em] text-[#1b1b1d]">
              Top Models by Consumption
            </h3>
            <p className="mt-0.5 font-sans text-[12px] text-[#626267]">
              Ranked by gross USD spend &amp; context throughput
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-0.5 font-sans text-[12px] font-medium text-[#0058bc]">
            View Detailed Matrix
            <ArrowRight size={14} aria-hidden />
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <p className="tnum font-mono text-[10.5px] text-[#717786]">
            {resolvedView === "donut" ? "top 5 plus other" : `top 10 by ${effectiveMetric}`}
            {view === "auto" && <span> (auto)</span>}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Segmented<ViewMode>
              label="Layout"
              value={view}
              onChange={setView}
              options={[
                { key: "auto", label: "Auto" },
                { key: "donut", label: "Ring" },
                { key: "bars", label: "Rows" },
              ]}
            />
            <Segmented<Metric>
              label="Metric"
              value={effectiveMetric}
              onChange={setMetric}
              options={[
                { key: "cost", label: "Cost" },
                { key: "tokens", label: "Tokens" },
              ]}
            />
          </div>
        </div>

        {resolvedView === "donut" ? (
          <>
            <div className="relative mt-2">
              <div ref={ref} className="h-52 w-full" role="img" aria-label="Model share ring chart" />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div
                  className="flex flex-col items-center overflow-hidden text-center"
                  style={{
                    width: measured ? hole * 0.92 : undefined,
                    paddingBottom: measured ? box.h * 0.04 : 6,
                  }}
                >
                  <div
                    className="tnum w-full truncate font-mono font-semibold leading-none text-[#1b1b1d]"
                    style={{ fontSize: numSize }}
                  >
                    {totalLabel}
                  </div>
                  <div
                    className="mt-1 w-full truncate font-sans text-[#626267]"
                    style={{ fontSize: capSize }}
                  >
                    total {effectiveMetric}
                  </div>
                </div>
              </div>
            </div>
            <ul className="mt-2 divide-y divide-[#F0EDEF] px-1">
              {slices.map((s, i) => {
                const share = total > 0 ? s.value / total : 0;
                const visual = s.client ? getClientVisual(s.client) : null;
                return (
                  <li
                    key={s.name}
                    className="flex items-center gap-2 overflow-hidden py-1.5 text-[11px]"
                    title={s.full}
                  >
                    <span
                      className="h-2.5 w-1 shrink-0 rounded-full"
                      style={{ background: PALETTE[i % PALETTE.length] }}
                    />
                    {visual ? (
                      <span
                        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", visual.dot)}
                        title={visual.label}
                      />
                    ) : (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-sans text-[#414755]">{s.name}</span>
                    <span className="tnum min-w-[6ch] shrink-0 text-right font-mono text-[#717786]">
                      {fmtPct(share)}
                    </span>
                    <span className="tnum min-w-[7ch] shrink-0 text-right font-mono text-[#414755]">
                      {fmtTokens(s.tokens)}
                    </span>
                    <span className="tnum min-w-[9ch] shrink-0 text-right font-mono font-semibold text-[#1b1b1d]">
                      {fmtCost(s.cost)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <ul className="space-y-3.5 pt-4">
            {top10.map((m, i) => {
              const value = effectiveMetric === "cost" ? m.cost : m.tokens;
              const pct = maxRowValue > 0 ? (value / maxRowValue) * 100 : 0;
              const opacity = BAR_OPACITY[Math.min(i, BAR_OPACITY.length - 1)];
              const visual = getClientVisual(m.client);
              return (
                <motion.li
                  key={`${m.client}:${m.model}`}
                  title={`${m.model} (${m.client})`}
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.45, delay: reduceMotion ? 0 : i * 0.05, ease: EASE }}
                  className="space-y-1"
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 font-sans text-[13px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: PALETTE[i % PALETTE.length] }}
                      />
                      <span className="min-w-0 flex-auto truncate font-semibold text-[#1b1b1d]">
                        {shorten(m.model, 26)}
                      </span>
                      <span className="min-w-0 max-w-[8rem] truncate rounded bg-[#F6F3F5] px-1.5 py-0.5 font-sans text-[10px] text-[#626267]">
                        {visual.label}
                      </span>
                    </div>
                    <div className="tnum flex shrink-0 items-baseline justify-end gap-2 whitespace-nowrap">
                      <span className="font-bold text-[#1b1b1d]">{fmtCost(m.cost)}</span>
                      <span className="text-[11px] text-[#717786]">({fmtTokens(m.tokens)} tok)</span>
                    </div>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-[#F0EDEF]">
                    <motion.div
                      initial={reduceMotion ? false : { scaleX: 0 }}
                      whileInView={{ scaleX: 1 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.7, delay: reduceMotion ? 0 : i * 0.05, ease: EASE }}
                      className="h-full origin-left rounded-full bg-[#0070eb]"
                      style={{ width: `${Math.max(pct, 2)}%`, opacity }}
                    />
                  </div>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[#F0EDEF] pt-4 font-sans text-[11px] text-[#717786]">
        <span className="shrink-0">{models.length} models tracked</span>
        <span className="min-w-0 font-medium text-[#0058bc]">Automatic cache discounting applied</span>
      </div>
    </motion.section>
  );
}
