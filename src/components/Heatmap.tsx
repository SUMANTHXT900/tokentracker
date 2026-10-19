import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CalendarDots } from "@phosphor-icons/react";
import { useStore } from "../store";
import type { DailyDTO } from "../lib/tauri";
import { fmtCost, fmtTokens } from "../lib/format";
import { cn } from "../lib/cn";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DOW_RAIL = ["Mon", "", "Wed", "", "Fri", "", ""];

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

type Scale = "tokens" | "cost";

interface Cell {
  date: string; // "" for future placeholders
  future: boolean;
  tokens: number;
  cost: number;
  messages: number;
  value: number; // intensity value for the active scale
  t: number; // 0..1 intensity
}

/** "2026-10-18" → "Oct 18" */
function fmtDayLabel(date: string): string {
  const parts = date.split("-");
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return `${MONTHS[(m - 1 + 12) % 12] ?? parts[1]} ${d}`;
}

function isoDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** UTC day ordinal — DST-proof consecutive-day maths for streaks. */
function dayOrdinal(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** Hairline divider between readout fragments — never a middle dot. */
function Rule() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-[#E4E1E8]" />;
}

/** rAF count-up from the previously displayed value (never flashes from 0
 *  on refetch), instant when the user prefers reduced motion. */
function useCountUp(target: number, duration = 900): number {
  const reduceMotion = useReducedMotion();
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

/** Strip-chart recorder of coding cadence. Click a day to filter (sets since/until). */
export default function Heatmap({ days }: { days: DailyDTO[] }) {
  const { setRange, setHeatmapDay, heatmapDay } = useStore();
  const [hovered, setHovered] = useState<Cell | null>(null);
  const [scale, setScale] = useState<Scale>("tokens");
  const [quick, setQuick] = useState<"all" | "30d" | "7d">("all");
  const reduceMotion = useReducedMotion() ?? false;

  const totalCost = days.reduce((a, d) => a + d.cost, 0);
  // Free-model usage has no cost — keep the matrix glowing via tokens.
  const effScale: Scale = totalCost === 0 ? "tokens" : scale;

  const { weeks, monthLabels, rangeLabel, stats } = useMemo(() => {
    const byDate = new Map<string, DailyDTO>();
    for (const d of days) byDate.set(d.date, d);
    const valueOf = (d: DailyDTO) => (effScale === "tokens" ? d.tokens : d.cost);

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - (53 * 7 - 1));
    const dow = (start.getDay() + 6) % 7; // align to Monday
    start.setDate(start.getDate() - dow);

    const max = Math.max(0.01, ...[...byDate.values()].map(valueOf));
    const cols: Cell[][] = [];
    for (let w = 0; w < 53; w++) {
      const col: Cell[] = [];
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(start.getDate() + w * 7 + d);
        if (dt > today) {
          col.push({ date: "", future: true, tokens: 0, cost: 0, messages: 0, value: 0, t: -1 });
          continue;
        }
        const key = isoDate(dt);
        const day = byDate.get(key);
        const value = day ? valueOf(day) : 0;
        col.push({
          date: key,
          future: false,
          tokens: day?.tokens ?? 0,
          cost: day?.cost ?? 0,
          messages: day?.messages ?? 0,
          value,
          t: value <= 0 ? 0 : Math.min(1, value / max),
        });
      }
      cols.push(col);
    }

    // Sparse 3-letter month headers, ≥4 weeks apart so labels never collide.
    const labels = new Array<string>(53).fill("");
    let lastLabeled = -10;
    for (let w = 0; w < 53; w++) {
      const monday = new Date(start);
      monday.setDate(start.getDate() + w * 7);
      if (monday > today) break;
      const m = monday.getMonth();
      const changed = w === 0 || new Date(start.getTime() + (w - 1) * 7 * 86400000).getMonth() !== m;
      if (changed && w - lastLabeled >= 4) {
        labels[w] = MONTHS[m];
        lastLabeled = w;
      }
    }

    // Streak / activity stats
    const activeDates = [
      ...new Set(
        days.filter((d) => d.tokens > 0 || d.cost > 0).map((d) => d.date),
      ),
    ].sort();
    let longest = 0;
    let run = 0;
    let prev = Number.NaN;
    for (const ds of activeDates) {
      const ord = dayOrdinal(ds);
      run = ord - prev === 1 ? run + 1 : 1;
      prev = ord;
      longest = Math.max(longest, run);
    }
    const peak = days.reduce<DailyDTO | null>(
      (best, d) => (!best || valueOf(d) > valueOf(best) ? d : best),
      null,
    );

    return {
      weeks: cols,
      monthLabels: labels,
      rangeLabel: days.length <= 45 ? `last ${days.length} days` : "last 12 months",
      stats: { activeDays: activeDates.length, longest, peak },
    };
  }, [days, effScale]);

  const animatedActive = useCountUp(stats.activeDays);
  const animatedLongest = useCountUp(stats.longest);

  const color = (t: number) =>
    t < 0
      ? "bg-transparent"
      : t <= 0
        ? "bg-[#ECE9EF] hover:bg-[#E0DCE5]"
        : t < 0.25
          ? "bg-[#0070eb]/25 hover:bg-[#0070eb]/40"
          : t < 0.5
            ? "bg-[#0070eb]/50 hover:bg-[#0070eb]/65"
            : t < 0.75
              ? "bg-[#0070eb]/75 hover:bg-[#0070eb]/90"
              : "bg-[#0070eb] hover:bg-[#0058bc]";

  const applyQuick = (q: "all" | "30d" | "7d") => {
    setQuick(q);
    setHeatmapDay(null);
    if (q === "all") {
      setRange(null, null);
    } else {
      const until = new Date();
      const since = new Date();
      since.setDate(since.getDate() - (q === "30d" ? 29 : 6));
      setRange(isoDate(since), isoDate(until));
    }
  };

  const filterPill = (label: string, onClick: () => void, active: boolean, danger?: boolean) => (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-2.5 py-1 font-sans text-[11px] font-medium transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0058bc] active:scale-[0.98]",
        active
          ? "border-[#0058bc]/30 bg-[#0058bc]/10 font-semibold text-[#0058bc]"
          : danger
            ? "border-red-300/60 bg-red-50 text-red-600 hover:border-red-400"
            : "border-[#E4E1E8] bg-white text-[#626267] hover:border-[#C9C4D6] hover:text-[#1b1b1d]",
      )}
    >
      {label}
    </button>
  );

  const peakValue =
    stats.peak != null
      ? effScale === "tokens"
        ? fmtTokens(stats.peak.tokens)
        : fmtCost(stats.peak.cost)
      : "none";

  return (
    <motion.section
      aria-label="Coding cadence"
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-32px" }}
      transition={{ duration: 0.55, delay: 0.1, ease: EASE }}
      className="flex h-full flex-col justify-between rounded-2xl border border-[#E4E1E8] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]"
    >
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#F0EDEF] pb-3">
          <div>
            <h3 className="flex items-center gap-1.5 font-sans text-[16px] font-semibold tracking-[-0.015em] text-[#1b1b1d]">
              <CalendarDots size={16} className="text-[#0058bc]" aria-hidden />
              Activity Intensity Heatmap
            </h3>
            <p className="mt-0.5 font-sans text-[12px] text-[#626267]">
              Daily agent velocity by active coding blocks
            </p>
          </div>
          <div className="flex items-center gap-1.5 font-sans text-[10px] text-ink-3">
            <span>Less</span>
            <span className="h-2.5 w-2.5 rounded bg-[#ECE9EF]" aria-hidden />
            <span className="h-2.5 w-2.5 rounded bg-[#0070eb]/25" aria-hidden />
            <span className="h-2.5 w-2.5 rounded bg-[#0070eb]/60" aria-hidden />
            <span className="h-2.5 w-2.5 rounded bg-[#0070eb]" aria-hidden />
            <span>More</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div className="tnum flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px]">
            <span>
              <span className="font-sans text-[#626267]">Active days </span>
              <span className="font-semibold text-[#1b1b1d]">
                {Math.round(reduceMotion ? stats.activeDays : animatedActive)}
              </span>
            </span>
            <Rule />
            <span>
              <span className="font-sans text-[#626267]">Longest streak </span>
              <span className="font-semibold text-[#1b1b1d]">
                {Math.round(reduceMotion ? stats.longest : animatedLongest)}d
              </span>
            </span>
            <Rule />
            <span>
              <span className="font-sans text-[#626267]">Peak </span>
              {stats.peak ? (
                <>
                  <span className="text-[#414755]">
                    {fmtDayLabel(stats.peak.date)}
                  </span>{" "}
                  <span className="font-semibold text-[#1b1b1d]">
                    {peakValue}
                  </span>
                </>
              ) : (
                <span className="text-ink-3">none</span>
              )}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div role="group" aria-label="Intensity scale" className="flex rounded-lg border border-[#E4E1E8] bg-[#F6F3F5] p-0.5">
              {(["tokens", "cost"] as Scale[]).map((s) => {
                const active = effScale === s;
                return (
                  <button
                    key={s}
                    onClick={() => setScale(s)}
                    disabled={s === "cost" && totalCost === 0}
                    aria-pressed={active}
                    className={cn(
                      "rounded-md px-2.5 py-1 font-sans text-[11px] font-medium capitalize transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0058bc] active:scale-[0.98]",
                      active ? "bg-white font-semibold text-[#0058bc] shadow-sm" : "text-[#626267] hover:text-[#1b1b1d]",
                      s === "cost" && totalCost === 0 && "cursor-not-allowed opacity-40 hover:text-[#626267]",
                    )}
                  >
                    {s}
                  </button>
                );
              })}
            </div>

            {filterPill("All", () => applyQuick("all"), quick === "all")}
            {filterPill("30d", () => applyQuick("30d"), quick === "30d")}
            {filterPill("7d", () => applyQuick("7d"), quick === "7d")}
            {heatmapDay &&
              filterPill(
                `Clear ${heatmapDay}`,
                () => {
                  setQuick("all");
                  setHeatmapDay(null);
                  setRange(null, null);
                },
                false,
                true,
              )}
          </div>
        </div>

        {/* Hover readout — plain text swap, no entrance motion. Wraps instead of
            clipping so long values never spill past the edges of the strip. */}
        <div className="mt-4 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[#E4E1E8] bg-[#FAFAFC] px-3 py-1.5">
          {hovered ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#0070eb]" />
              <span className="shrink-0 font-sans font-medium text-[#1b1b1d]">
                {fmtDayLabel(hovered.date)}
              </span>
              <Rule />
              <span className="tnum shrink-0 font-mono text-[#1b1b1d]">
                {fmtTokens(hovered.tokens)} <span className="font-sans text-[#626267]">tokens</span>
              </span>
              <Rule />
              <span className="tnum shrink-0 font-mono text-[#8a5a00]">
                {fmtCost(hovered.cost)}
              </span>
              <Rule />
              <span className="tnum shrink-0 font-mono text-[#414755]">
                {hovered.messages.toLocaleString()}{" "}
                <span className="font-sans text-[#626267]">msgs</span>
              </span>
              <span className="ml-auto hidden shrink-0 font-sans text-[10px] text-ink-3 xl:block">
                click a day to scope the dashboard
              </span>
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate font-sans text-xs text-ink-3">
              Hover a day to read tokens, spend and messages
            </span>
          )}
        </div>

        {/* 53-week matrix: day-of-week rail plus sparse month headers */}
        <div className="mt-3 overflow-x-auto pb-1 md:overflow-x-visible">
          <div className="min-w-[680px] md:min-w-0">
            <div
              className="grid gap-[3px]"
              style={{
                gridTemplateColumns: "24px repeat(53, minmax(0, 1fr))",
                gridTemplateRows: "13px repeat(7, auto)",
              }}
            >
              {monthLabels.map((label, wi) => {
                if (!label) return null;
                // Span a few week columns so a 3-letter month never bleeds into the
                // next label. Clamped to the grid so no implicit columns form.
                const span = Math.max(1, Math.min(4, 53 - wi));
                return (
                  <span
                    key={`m-${wi}`}
                    style={{ gridColumn: `${wi + 2} / span ${span}`, gridRow: 1 }}
                    className="truncate font-mono text-[10px] leading-3 text-ink-3"
                  >
                    {label}
                  </span>
                );
              })}

              {DOW_RAIL.map((label, di) => (
                <span
                  key={`dow-${di}`}
                  style={{ gridColumn: 1, gridRow: di + 2 }}
                  className="self-center pr-1 text-right font-mono text-[9px] leading-none text-ink-3"
                >
                  {label}
                </span>
              ))}

              {weeks.map((col, wi) =>
                col.map((cell, di) =>
                  cell.future ? (
                    <span
                      key={`f-${wi}-${di}`}
                      aria-hidden
                      style={{ gridColumn: wi + 2, gridRow: di + 2 }}
                      className="aspect-square w-full"
                    />
                  ) : (
                    <button
                      key={cell.date}
                      type="button"
                      style={{ gridColumn: wi + 2, gridRow: di + 2 }}
                      aria-label={`${fmtDayLabel(cell.date)} ${cell.date}: ${fmtTokens(cell.tokens)} tokens, ${fmtCost(cell.cost)}, ${cell.messages.toLocaleString()} messages`}
                      onMouseEnter={() => setHovered(cell)}
                      onFocus={() => setHovered(cell)}
                      onMouseLeave={() => setHovered((h) => (h && h.date === cell.date ? null : h))}
                      onBlur={() => setHovered((h) => (h && h.date === cell.date ? null : h))}
                      onClick={() => {
                        setQuick("all");
                        setHeatmapDay(cell.date);
                        setRange(cell.date, cell.date);
                      }}
                      className={cn(
                        "aspect-square w-full cursor-pointer rounded-[3px] transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:scale-[1.18] hover:ring-1 hover:ring-inset hover:ring-[#0058bc]/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0058bc]",
                        color(cell.t),
                        heatmapDay === cell.date && "scale-[1.12] ring-2 ring-[#0058bc]",
                      )}
                    />
                  ),
                ),
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-[#F0EDEF] pt-3">
        <div className="min-w-0 rounded-xl border border-[#E4E1E8]/70 bg-[#F6F3F5] p-2.5">
          <span className="block font-sans text-[10px] text-ink-3">Peak coding day</span>
          <span
            className="tnum mt-0.5 block truncate font-mono text-[13px] font-semibold text-[#1b1b1d]"
            title={stats.peak ? `${fmtDayLabel(stats.peak.date)} · ${peakValue}` : "—"}
          >
            {stats.peak ? `${fmtDayLabel(stats.peak.date)} · ${peakValue}` : "—"}
          </span>
        </div>
        <div className="min-w-0 rounded-xl border border-[#E4E1E8]/70 bg-[#F6F3F5] p-2.5">
          <span className="block font-sans text-[10px] text-ink-3">Cost efficiency</span>
          <span className="tnum mt-0.5 block truncate font-mono text-[13px] font-semibold text-[#006b27]">
            {stats.activeDays > 0 ? `Avg ${fmtCost(totalCost / stats.activeDays)}/day` : "—"}
          </span>
        </div>
      </div>

      <div className="tnum mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-ink-3">
        <span>{rangeLabel}</span>
        <Rule />
        <span>intensity by {effScale}</span>
        <Rule />
        <span>click any day to scope the dashboard</span>
        <span className="ml-auto">
          {days.length > 0
            ? `${days.length} tracked day${days.length === 1 ? "" : "s"}`
            : "no tracked days"}
        </span>
      </div>
    </motion.section>
  );
}
