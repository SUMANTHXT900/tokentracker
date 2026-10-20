import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { endOfWeek, startOfWeek } from "date-fns";
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
type Quick = "all" | "90d" | "30d" | "7d";

interface Cell {
  date: string; // "" for future placeholders
  future: boolean;
  tokens: number;
  cost: number;
  messages: number;
  value: number; // intensity value for the active scale
  t: number; // 0..1 intensity
}

/** "2026-10-18" → "Oct 18" (or "Oct 18, 2026" with `withYear`). */
function fmtDayLabel(date: string, withYear = false): string {
  const parts = date.split("-");
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const label = `${MONTHS[(m - 1 + 12) % 12] ?? parts[1]} ${d}`;
  return withYear && parts[0] ? `${label}, ${parts[0]}` : label;
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

/** Monday 00:00 of the week containing `date` — local and DST-safe. */
function mondayOf(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d;
}

function parseIsoDay(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const out = new Date(y, m - 1, d);
  // Reject rolled-over dates such as 2026-02-30 as well as bad shapes.
  if (Number.isNaN(out.getTime()) || isoDate(out) !== s) return null;
  return out;
}

/** Strip-chart recorder of coding cadence. Click a day to filter (sets since/until). */
export default function Heatmap({ days }: { days: DailyDTO[] }) {
  const { setRange, setHeatmapDay, heatmapDay, since, until } = useStore();
  const [hovered, setHovered] = useState<Cell | null>(null);
  const [scale, setScale] = useState<Scale>("tokens");
  const [gridW, setGridW] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion() ?? false;

  const totalCost = days.reduce((a, d) => a + d.cost, 0);
  // Free-model usage has no cost — keep the matrix glowing via tokens.
  const effScale: Scale = totalCost === 0 ? "tokens" : scale;

  // One clock for every quick window and for the matrix end, so the pills and
  // the grid can never disagree at a day boundary.
  const todayIso = isoDate(new Date());
  const lastRange = (n: number) => {
    const end = parseIsoDay(todayIso);
    if (!end) return { start: todayIso, end: todayIso };
    const start = new Date(end);
    start.setDate(end.getDate() - (n - 1));
    return { start: isoDate(start), end: todayIso };
  };
  const q7 = lastRange(7);
  const q30 = lastRange(30);
  const q90 = lastRange(90);
  // Exact window equality (including "ends today") is what keeps a historical
  // custom range from falsely lighting a preset. Anything else is custom.
  const activeQuick: Quick | "custom" = !since && !until
    ? "all"
    : since === q7.start && until === q7.end
      ? "7d"
      : since === q30.start && until === q30.end
        ? "30d"
        : since === q90.start && until === q90.end
          ? "90d"
          : "custom";

  // A day scope only exists while the global range is exactly that day; the
  // header picker can change the range behind our back.
  const scopedDay =
    since && until && since === until && heatmapDay === since ? since : null;
  useEffect(() => {
    if (heatmapDay && (since !== heatmapDay || until !== heatmapDay)) {
      setHeatmapDay(null);
    }
  }, [heatmapDay, since, until, setHeatmapDay]);

  const { weeks, rangeLabel, stats } = useMemo(() => {
    const byDate = new Map<string, DailyDTO>();
    for (const d of days) byDate.set(d.date, d);
    const valueOf = (d: DailyDTO) => (effScale === "tokens" ? d.tokens : d.cost);

    const today = parseIsoDay(todayIso) ?? new Date();
    today.setHours(0, 0, 0, 0);

    // The window ends where the filter ends (clamped to today), so a
    // single-day or historical scope doesn't trail weeks of empty cells.
    const untilDay = until ? parseIsoDay(until) : null;
    let end = today;
    if (untilDay && untilDay < today) end = untilDay;
    const endIso = isoDate(end);
    const endMonday = mondayOf(end);

    // Start from the earliest day actually present (the API already applied
    // since/until); fall back to the filter start, then a modest empty window.
    let first: Date | null = null;
    for (const d of days) {
      const parsed = parseIsoDay(d.date);
      if (parsed && (!first || parsed < first)) first = parsed;
    }
    const sinceDay = since ? parseIsoDay(since) : null;
    // Ignore stale rows from a previous query that predate the new `since`;
    // when the fresh rows start later than `since`, start at the data instead
    // of padding the left edge with empty weeks.
    const anchor = sinceDay && (!first || first < sinceDay) ? sinceDay : first;
    let start: Date;
    if (anchor) {
      start = mondayOf(anchor);
    } else {
      const fallback = new Date(end);
      fallback.setDate(end.getDate() - 12 * 7);
      start = mondayOf(fallback);
    }

    // At most 53 columns: 52 weeks back from the end week's Monday. Anchoring
    // on the week (not 53*7-1 days) prevents a 54th column on some weekdays.
    const capStart = new Date(endMonday);
    capStart.setDate(endMonday.getDate() - 52 * 7);
    if (start < capStart) start = capStart;
    if (start > endMonday) start = endMonday;

    const startIso = isoDate(start);
    const weekCount = Math.max(
      1,
      Math.round((dayOrdinal(isoDate(endMonday)) - dayOrdinal(startIso)) / 7) + 1,
    );

    // Intensity is relative to the visible window, not data the cap just hid.
    let max = 0.01;
    for (const d of days) {
      if (d.date >= startIso && d.date <= endIso) max = Math.max(max, valueOf(d));
    }

    const cols: Cell[][] = [];
    for (let w = 0; w < weekCount; w++) {
      const col: Cell[] = [];
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(start.getDate() + w * 7 + d);
        const key = isoDate(dt);
        if (key > endIso) {
          col.push({ date: "", future: true, tokens: 0, cost: 0, messages: 0, value: 0, t: -1 });
          continue;
        }
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
    const peak = days.reduce<DailyDTO | null>((best, d) => {
      if (valueOf(d) <= 0) return best;
      return !best || valueOf(d) > valueOf(best) ? d : best;
    }, null);

    const startLabel = `${fmtDayLabel(startIso)}${
      start.getFullYear() !== end.getFullYear() ? `, ${start.getFullYear()}` : ""
    }`;
    const rangeLabel =
      startIso === endIso
        ? `${fmtDayLabel(endIso)}, ${end.getFullYear()}`
        : `${startLabel} – ${fmtDayLabel(endIso)}, ${end.getFullYear()}`;
    return {
      weeks: cols,
      rangeLabel,
      stats: { activeDays: activeDates.length, longest, peak },
    };
  }, [days, effScale, since, until, todayIso]);

  const animatedActive = useCountUp(stats.activeDays);
  const animatedLongest = useCountUp(stats.longest);

  // Measure the grid so 7d/30d scopes grow into legible calendar blocks while
  // a full year stays compact. Cells clamp at 38px to avoid giant tiles.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    setGridW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number" && w > 0) setGridW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const weekCount = Math.max(1, weeks.length);
  // Dense year views tighten the gutters so 53 columns still fit the card.
  const gridGap = weekCount >= 45 ? 2 : weekCount >= 26 ? 3 : 4;
  const railW = 24;
  // rail + N week columns produce exactly N column gaps.
  const available = Math.max(0, gridW - railW - gridGap * weekCount);
  // Short scopes deserve bigger calendar blocks; a 53-week year stays dense.
  const maxCell = weekCount <= 8 ? 56 : weekCount <= 16 ? 48 : weekCount <= 30 ? 28 : 18;
  const minCell = weekCount <= 8 ? 28 : weekCount <= 16 ? 16 : 12;
  const cellSize = gridW > 0
    ? Math.max(minCell, Math.min(maxCell, Math.floor(available / weekCount)))
    : 14;
  const gridWidth = railW + weekCount * cellSize + gridGap * weekCount;

  // One roving tab stop for the whole matrix; arrows move by day/week.
  const preferredFocusDate = useMemo(() => {
    const target = scopedDay ?? todayIso;
    if (weeks.some((col) => col.some((c) => c.date === target))) return target;
    const flat = weeks.flat().filter((c) => !c.future);
    return flat.length > 0 ? flat[flat.length - 1].date : target;
  }, [weeks, scopedDay, todayIso]);

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const iso = active?.dataset.date;
    const current = iso ? parseIsoDay(iso) : null;
    if (!current) return;
    let next: Date;
    if (e.key === "Home") next = startOfWeek(current, { weekStartsOn: 1 });
    else if (e.key === "End") next = endOfWeek(current, { weekStartsOn: 1 });
    else {
      next = new Date(current);
      const delta =
        e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -7 : 7;
      next.setDate(current.getDate() + delta);
    }
    const target = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-date="${isoDate(next)}"]`,
    );
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };

  // Month headers: label the first column by the month that owns most of its
  // tracked days (a window starting Mon Jun 29 for a Jul 1 dataset reads "Jul",
  // not "Jun"), then label month changes only where the real pixel pitch can
  // fit a 3-character label.
  const monthLabels = useMemo(() => {
    const labels = new Array<string>(weekCount).fill("");
    const firstMonday = weeks[0]?.[0]?.date;
    const startDate = firstMonday ? parseIsoDay(firstMonday) : null;
    if (!startDate) return labels;

    const monthCounts = new Map<number, number>();
    for (const cell of weeks[0] ?? []) {
      if (cell.future || (cell.tokens <= 0 && cell.cost <= 0)) continue;
      const m = parseIsoDay(cell.date)?.getMonth();
      if (m != null) monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
    }
    let prevMonth = startDate.getMonth();
    let bestCount = -1;
    for (const [m, count] of monthCounts) {
      if (count > bestCount || (count === bestCount && m > prevMonth)) {
        prevMonth = m;
        bestCount = count;
      }
    }

    let lastLabeled = -10;
    const minGap = cellSize + gridGap >= 26 ? 1 : 2;
    const cursor = new Date(startDate);
    for (let w = 0; w < weekCount; w++) {
      const m = w === 0 ? prevMonth : cursor.getMonth();
      const changed = w === 0 || m !== prevMonth;
      if (changed && w - lastLabeled >= (w === 0 ? 1 : minGap)) {
        labels[w] = MONTHS[m];
        lastLabeled = w;
      }
      prevMonth = m;
      cursor.setDate(cursor.getDate() + 7);
    }
    return labels;
  }, [weeks, weekCount, cellSize, gridGap]);

  const color = (t: number) =>
    t < 0
      ? "bg-transparent"
      : t <= 0
        ? "bg-[#D8D3E0] ring-1 ring-inset ring-[#C8C2D2]/70 hover:bg-[#CDC7D8]"
        : t < 0.25
          ? "bg-[#0070eb]/55 hover:bg-[#0070eb]/65"
          : t < 0.5
            ? "bg-[#0070eb]/70 hover:bg-[#0070eb]/80"
            : t < 0.75
              ? "bg-[#0070eb]/85 hover:bg-[#0058bc]"
              : "bg-[#0058bc] hover:bg-[#004a9e]";

  const applyQuick = (q: Quick) => {
    setHeatmapDay(null);
    if (q === "all") {
      setRange(null, null);
    } else {
      const range = q === "90d" ? q90 : q === "30d" ? q30 : q7;
      setRange(range.start, range.end);
    }
  };

  const filterPill = (
    label: string,
    onClick: () => void,
    active: boolean | undefined,
    danger?: boolean,
  ) => (
    <button
      type="button"
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
  const peakLabel = stats.peak
    ? fmtDayLabel(stats.peak.date, stats.peak.date.slice(0, 4) !== todayIso.slice(0, 4))
    : null;

  const prompt =
    days.length > 0
      ? "Hover a day to read tokens, spend and messages"
      : since || until
        ? "No tracked activity in this range"
        : "No tracked activity yet";

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
                    {peakLabel}
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
                    type="button"
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

            {filterPill("7d", () => applyQuick("7d"), activeQuick === "7d")}
            {filterPill("30d", () => applyQuick("30d"), activeQuick === "30d")}
            {filterPill("90d", () => applyQuick("90d"), activeQuick === "90d")}
            {filterPill("All", () => applyQuick("all"), activeQuick === "all")}
            {scopedDay &&
              filterPill(
                `Clear ${fmtDayLabel(
                  scopedDay,
                  scopedDay.slice(0, 4) !== todayIso.slice(0, 4),
                )}`,
                () => {
                  setHeatmapDay(null);
                  setRange(null, null);
                },
                undefined,
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
                {fmtDayLabel(hovered.date, true)}
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
              {prompt}
            </span>
          )}
        </div>

        {/* Variable-window matrix: 7d/30d grow into larger calendar blocks,
            all-time shrinks to a compact year. No empty Nov–Jun sea. */}
        <div ref={gridRef} className="mt-3 overflow-x-auto pb-1">
          <div style={{ width: gridWidth, margin: "0 auto" }}>
            <div
              role="group"
              aria-label={`Daily activity, ${rangeLabel}`}
              onKeyDown={onGridKeyDown}
              className="grid"
              style={{
                gridTemplateColumns: `${railW}px repeat(${weekCount}, ${cellSize}px)`,
                gridTemplateRows: `13px repeat(7, ${cellSize}px)`,
                gap: gridGap,
              }}
            >
              {monthLabels.map((label, wi) => {
                if (!label) return null;
                // Span a few week columns so a 3-letter month never bleeds into the
                // next label. Clamped to the grid so no implicit columns form.
                const span = Math.max(1, Math.min(4, weekCount - wi));
                return (
                  <span
                    key={`m-${wi}`}
                    style={{
                      gridColumn: `${wi + 2} / span ${span}`,
                      gridRow: 1,
                      // The final label has only one column; right-align it so a
                      // 3-letter month overflows into the empty label row, not
                      // past the right edge of the card.
                      justifySelf: wi + 1 >= weekCount ? "end" : "start",
                    }}
                    className="whitespace-nowrap font-mono text-[10px] leading-3 text-ink-3"
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
                      style={{ gridColumn: wi + 2, gridRow: di + 2, width: cellSize, height: cellSize }}
                    />
                  ) : (
                    <button
                      key={cell.date}
                      type="button"
                      style={{
                        gridColumn: wi + 2,
                        gridRow: di + 2,
                        width: cellSize,
                        height: cellSize,
                        borderRadius: cellSize >= 24 ? 6 : cellSize >= 16 ? 4 : 3,
                      }}
                      title={`${fmtDayLabel(cell.date, true)} · ${fmtTokens(cell.tokens)} tokens · ${fmtCost(cell.cost)}`}
                      aria-label={`${fmtDayLabel(cell.date, true)}: ${fmtTokens(cell.tokens)} tokens, ${fmtCost(cell.cost)}, ${cell.messages.toLocaleString()} messages`}
                      aria-pressed={scopedDay === cell.date}
                      aria-current={cell.date === todayIso ? "date" : undefined}
                      tabIndex={cell.date === preferredFocusDate ? 0 : -1}
                      data-date={cell.date}
                      onMouseEnter={() => setHovered(cell)}
                      onFocus={() => setHovered(cell)}
                      onMouseLeave={() => setHovered((h) => (h && h.date === cell.date ? null : h))}
                      onBlur={() => setHovered((h) => (h && h.date === cell.date ? null : h))}
                      onClick={() => {
                        setHeatmapDay(cell.date);
                        setRange(cell.date, cell.date);
                      }}
                      className={cn(
                        "cursor-pointer transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:z-10 hover:scale-[1.12] hover:ring-1 hover:ring-inset hover:ring-[#0058bc]/60 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0058bc] motion-reduce:hover:scale-100",
                        color(cell.t),
                        scopedDay === cell.date && "z-10 scale-[1.08] ring-2 ring-[#0058bc] motion-reduce:scale-100",
                      )}
                    />
                  ),
                ),
              )}
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-end gap-1.5 font-sans text-[10px] text-ink-3">
          <span>Less</span>
          <span className="h-2.5 w-2.5 rounded bg-[#D8D3E0] ring-1 ring-inset ring-[#C8C2D2]/70" aria-hidden />
          <span className="h-2.5 w-2.5 rounded bg-[#0070eb]/55" aria-hidden />
          <span className="h-2.5 w-2.5 rounded bg-[#0070eb]/70" aria-hidden />
          <span className="h-2.5 w-2.5 rounded bg-[#0070eb]/85" aria-hidden />
          <span className="h-2.5 w-2.5 rounded bg-[#0058bc]" aria-hidden />
          <span>More</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-[#F0EDEF] pt-3">
        <div className="min-w-0 rounded-xl border border-[#E4E1E8]/70 bg-[#F6F3F5] p-2.5">
          <span className="block font-sans text-[10px] text-ink-3">Peak coding day</span>
          <span
            className="tnum mt-0.5 block truncate font-mono text-[13px] font-semibold text-[#1b1b1d]"
            title={stats.peak ? `${peakLabel} · ${peakValue}` : "—"}
          >
            {stats.peak ? `${peakLabel} · ${peakValue}` : "—"}
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
