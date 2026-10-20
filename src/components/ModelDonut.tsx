import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import * as echarts from "echarts";
import { ArrowRight, Cube } from "@phosphor-icons/react";
import type { ModelRowDTO } from "../lib/tauri";
import { fmtCost, fmtCostPrecise, fmtPct, fmtTokens } from "../lib/format";
import { getClientVisual } from "../lib/client-color";
import { cn } from "../lib/cn";

/** Phosphor, amber, teal, rose, fog, slate. No purple or blue, by design. */
const PALETTE = ["#35D99A", "#E8A33D", "#4CC9C0", "#E26D7E", "#C2C8D1", "#5F6570"];

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

/** Sub-cent spend must never collapse to a misleading "$0.00". */
function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.005) return "<$0.01";
  if (n < 1) return fmtCostPrecise(n);
  return fmtCost(n);
}

type ViewMode = "auto" | "donut" | "bars";
type Metric = "cost" | "tokens";

/**
 * Model ids are identifiers, not prose: the tail carries the payload
 * ("muse-spark-1.3-contributor" vs "muse-spark-1.3-contributor-free").
 * So we never cut the end. When a pathologically long id must be shortened,
 * the middle is stripped instead and the suffix always survives.
 */
function elideMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Long ids still get room to breathe; only absurd lengths get middle-stripped. */
const NAME_MAX = 64;

/** Escape data-derived strings before interpolating into tooltip HTML. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  options: { key: T; label: string; disabled?: boolean; title?: string }[];
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
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.key)}
            className={cn(
              "rounded-md px-2 py-1 font-sans text-[11px] font-medium transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0058bc] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
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

interface Slice {
  id: string;
  name: string;
  full: string;
  client: string;
  tokens: number;
  cost: number;
  value: number;
}

function DonutPanel({
  chartRef,
  compact,
  totalLabel,
  effectiveMetric,
  measured,
  hole,
  numSize,
  capSize,
  boxH,
  slices,
  total,
}: {
  chartRef: React.RefObject<HTMLDivElement>;
  compact: boolean;
  totalLabel: string;
  effectiveMetric: Metric;
  measured: boolean;
  hole: number;
  numSize: number;
  capSize: number;
  boxH: number;
  slices: Slice[];
  total: number;
}) {
  return (
    <div className={compact ? "" : "mt-2"}>
      <div className="relative">
        <div
          ref={chartRef}
          className={compact ? "h-56 w-full" : "h-60 w-full"}
          role="img"
          aria-label="Model share ring chart"
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className="flex flex-col items-center overflow-hidden text-center"
            style={{
              width: measured ? hole * 0.92 : undefined,
              paddingBottom: measured ? boxH * 0.04 : 6,
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

      {compact ? (
        <p className="mt-1 text-center font-mono text-[10px] text-ink-3">
          top 5 + other
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-[#F0EDEF] px-1">
          {slices.map((s, i) => {
            const share = total > 0 ? s.value / total : 0;
            const visual = s.client ? getClientVisual(s.client) : null;
            return (
              <li
                key={`${s.client}:${s.id}`}
                className="flex items-start gap-2 overflow-hidden py-1.5 text-[11px]"
                title={s.full}
              >
                <span
                  className="mt-[3px] h-2.5 w-1 shrink-0 rounded-full"
                  style={{ background: PALETTE[i % PALETTE.length] }}
                />
                {visual ? (
                  <span
                    className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", visual.dot)}
                    title={visual.label}
                  />
                ) : (
                  <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300" />
                )}
                {/* Middle-elided only when absurdly long; the tail ("-free") always survives. */}
                <span className="min-w-0 flex-1 break-words font-sans text-[#414755]" title={s.full}>
                  {elideMiddle(s.name, NAME_MAX)}
                </span>
                <span className="tnum min-w-[6ch] shrink-0 text-right font-mono text-ink-3">
                  {fmtPct(share)}
                </span>
                <span className="tnum min-w-[7ch] shrink-0 text-right font-mono text-[#414755]">
                  {fmtTokens(s.tokens)}
                </span>
                <span className="tnum min-w-[9ch] shrink-0 text-right font-mono font-semibold text-[#1b1b1d]">
                  {fmtMoney(s.cost)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RankedRows({
  top10,
  effectiveMetric,
  total,
  maxRowValue,
  reduceMotion,
}: {
  top10: ModelRowDTO[];
  effectiveMetric: Metric;
  total: number;
  maxRowValue: number;
  reduceMotion: boolean;
}) {
  return (
    <ol className="space-y-2.5 pt-2">
      {top10.map((m, i) => {
        const value = effectiveMetric === "cost" ? m.cost : m.tokens;
        const pct = maxRowValue > 0 ? (value / maxRowValue) * 100 : 0;
        const share = total > 0 ? value / total : 0;
        const visual = getClientVisual(m.client);
        const color = PALETTE[i % PALETTE.length];
        return (
          <motion.li
            key={`${m.client}:${m.model}`}
            title={`${m.model} (${m.client})`}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: reduceMotion ? 0 : i * 0.04, ease: EASE }}
            className="space-y-1"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="tnum w-3 shrink-0 text-right font-mono text-[10px] text-ink-3">
                {i + 1}
              </span>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: color }}
                aria-hidden
              />
              <span
                className="min-w-0 flex-1 break-words font-sans text-[12px] font-semibold text-[#1b1b1d]"
                title={`${m.model} (${m.client})`}
              >
                {elideMiddle(m.model, NAME_MAX)}
              </span>
              <span className="hidden max-w-[7rem] shrink-0 truncate rounded bg-[#F6F3F5] px-1.5 py-0.5 font-sans text-[10px] text-[#626267] sm:inline">
                {visual.label}
              </span>
              <span className="tnum w-[9ch] shrink-0 text-right font-mono text-[12px] font-bold text-[#1b1b1d]">
                {effectiveMetric === "cost" ? fmtMoney(m.cost) : fmtTokens(m.tokens)}
              </span>
            </div>
            <div className="ml-5 flex items-center gap-2">
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[#F0EDEF]">
                <div
                  className="h-full rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
                  style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%`, background: color }}
                />
              </div>
              <span className="tnum w-[6ch] shrink-0 text-right font-mono text-[10px] text-ink-3">
                {fmtPct(share)}
              </span>
              <span className="tnum hidden w-[9ch] shrink-0 text-right font-mono text-[10px] text-ink-3 sm:inline">
                {effectiveMetric === "cost" ? `${fmtTokens(m.tokens)} tok` : fmtMoney(m.cost)}
              </span>
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

export default function ModelDonut({
  models,
  onViewDetailedMatrix,
}: {
  models: ModelRowDTO[];
  onViewDetailedMatrix?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [view, setView] = useState<ViewMode>("auto");
  const [metric, setMetric] = useState<Metric>("cost");
  /** Measured ring box — keeps the centre readout inside the donut hole. */
  const [box, setBox] = useState({ w: 0, h: 0 });
  const reduceMotion = useReducedMotion() ?? false;

  const totalCost = useMemo(() => models.reduce((a, m) => a + m.cost, 0), [models]);
  // Free / $0 contributor models: never render a blank chart — share by tokens.
  const effectiveMetric: Metric = totalCost === 0 ? "tokens" : metric;

  const { slices, total, top10 } = useMemo(() => {
    const valueOf = (m: ModelRowDTO) =>
      effectiveMetric === "cost" ? m.cost : m.tokens;
    const sorted = [...models].sort((a, b) => valueOf(b) - valueOf(a));
    const totalValue = sorted.reduce((a, m) => a + valueOf(m), 0);

    const top = sorted.slice(0, 5);
    const rest = sorted.slice(5);
    const out = top.map((m) => ({
      id: m.model,
      // Full model id, never shortened — the tail ("-free") is the payload.
      name: m.model,
      models: [`${m.model} (${m.client})`],
      full: `${m.model} (${m.client})`,
      client: m.client,
      tokens: m.tokens,
      cost: m.cost,
      value: valueOf(m),
    }));
    if (rest.length > 0) {
      const restModels = rest.map((r) => `${r.model} (${r.client})`);
      out.push({
        id: `Other (${rest.length})`,
        name: `Other (${rest.length})`,
        models: restModels,
        full: restModels.join(", "),
        client: "",
        tokens: rest.reduce((a, m) => a + m.tokens, 0),
        cost: rest.reduce((a, m) => a + m.cost, 0),
        value: rest.reduce((a, m) => a + valueOf(m), 0),
      });
    }
    return {
      slices: out,
      total: totalValue,
      top10: sorted.slice(0, 10),
    };
  }, [models, effectiveMetric]);

  // Auto is a deliberate composition: ring + full ranked list together.
  const resolvedView: "split" | "donut" | "bars" = view === "auto" ? "split" : view;
  const hasUsage = models.length > 0 && total > 0;

  useEffect(() => {
    const el = ref.current;
    if (resolvedView === "bars" || !el) {
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
              models?: string[];
              tokens?: number;
              cost?: number;
              value?: number;
            };
            const share = total > 0 && typeof d.value === "number" ? d.value / total : 0;
            // Every model is listed in full — names wrap, they never get cut.
            const models = d.models?.length ? d.models : [String(d.name ?? "")];
            const heading = models
              .map(
                (m) =>
                  `<div style="overflow-wrap:anywhere">${esc(m)}</div>`,
              )
              .join("");
            return `
              <div style="min-width:176px;max-width:320px;font-family:'JetBrains Mono',monospace">
                <div style="font-size:11.5px;font-weight:600;color:#1b1b1d;margin-bottom:7px;max-height:220px;overflow-y:auto">${heading}</div>
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
                  <span style="color:#1b1b1d;font-size:12px;font-weight:600">${esc(fmtMoney(d.cost ?? 0))}</span>
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
              models: s.models,
              tokens: s.tokens,
              cost: s.cost,
            })),
          },
        ],
      },
      { notMerge: true },
    );
  }, [slices, resolvedView, total, reduceMotion]);

  // Container-driven resize so layout/sidebar changes reflow the ring, plus a
  // measured box so the centre readout scales to the hole instead of overlapping it.
  useEffect(() => {
    const el = ref.current;
    // The observed node only exists when the ring is actually rendered.
    if (!el || resolvedView === "bars" || !hasUsage) return;
    const measure = () => {
      chartRef.current?.resize();
      const r = el.getBoundingClientRect();
      setBox((b) => (b.w === r.width && b.h === r.height ? b : { w: r.width, h: r.height }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [resolvedView, hasUsage]);

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
          <Cube size={20} className="text-ink-3" aria-hidden />
          <p className="mt-2 font-sans text-[13px] text-[#414755]">No models in this range</p>
        </div>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="rounded-2xl border border-[#E4E1E8] bg-white p-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">
        <div className="flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-[#E4E1E8] bg-[#FAFAFC]">
          <Cube size={20} className="text-ink-3" aria-hidden />
          <p className="mt-2 font-sans text-[13px] text-[#414755]">Models found, but no usage recorded yet</p>
        </div>
      </div>
    );
  }

  const totalLabel = effectiveMetric === "cost" ? fmtMoney(total) : fmtTokens(total);
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
              Ranked by {effectiveMetric === "cost" ? "gross spend" : "token volume"}
            </p>
          </div>
          <button
            type="button"
            onClick={onViewDetailedMatrix}
            disabled={!onViewDetailedMatrix}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-sans text-[12px] font-medium text-[#0058bc] transition-colors hover:bg-primary/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0058bc] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
          >
            View Detailed Matrix
            <ArrowRight size={14} aria-hidden />
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <p className="tnum font-mono text-[10.5px] text-ink-3">
            {resolvedView === "donut"
              ? `top 5 + other by ${effectiveMetric}`
              : `top 10 by ${effectiveMetric}`}
            {view === "auto" && <span> · ring + rows</span>}
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
                { key: "cost", label: "Cost", disabled: totalCost === 0, title: totalCost === 0 ? "No cost data — every model here is free" : undefined },
                { key: "tokens", label: "Tokens" },
              ]}
            />
          </div>
        </div>

        {resolvedView === "bars" ? (
          <>
            <RankedRows
              top10={top10}
              effectiveMetric={effectiveMetric}
              total={total}
              maxRowValue={maxRowValue}
              reduceMotion={reduceMotion}
            />
          </>
        ) : resolvedView === "donut" ? (
          <DonutPanel
            chartRef={ref}
            compact={false}
            totalLabel={totalLabel}
            effectiveMetric={effectiveMetric}
            measured={measured}
            hole={hole}
            numSize={numSize}
            capSize={capSize}
            boxH={box.h}
            slices={slices}
            total={total}
          />
        ) : (
          <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-[minmax(220px,0.72fr)_minmax(0,1.65fr)]">
            <div className="min-w-0">
              <DonutPanel
                chartRef={ref}
                compact
                totalLabel={totalLabel}
                effectiveMetric={effectiveMetric}
                measured={measured}
                hole={hole}
                numSize={numSize}
                capSize={capSize}
                boxH={box.h}
                slices={slices}
                total={total}
              />
            </div>
            <div className="min-w-0 border-t border-[#F0EDEF] pt-3 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <RankedRows
                top10={top10}
                effectiveMetric={effectiveMetric}
                total={total}
                maxRowValue={maxRowValue}
                reduceMotion={reduceMotion}
              />
            </div>
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[#F0EDEF] pt-4 font-sans text-[11px] text-ink-3">
        <span className="shrink-0">{models.length} models tracked</span>
        <span className="min-w-0 font-medium text-[#0058bc]">Automatic cache discounting applied</span>
      </div>
    </motion.section>
  );
}
