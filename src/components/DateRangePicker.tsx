import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  addMonths,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isBefore,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { Calendar, CaretDown, CaretLeft, CaretRight, Check, X } from "@phosphor-icons/react";
import { cn } from "../lib/cn";

/**
 * Unified time-range control.
 *
 * One trigger, one popover: quick presets on the left, a dual-month calendar on
 * the right, Apply / Clear at the bottom. Every page uses the same store-backed
 * since/until values, so a range selected here applies everywhere.
 */

const PRESETS: { label: string; days: number }[] = [
  { label: "Today", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Year to date", days: -1 },
  { label: "All time", days: 0 },
];

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a backend YYYY-MM-DD as a local calendar day, never UTC midnight. */
function parseDay(s: string | null | undefined): Date | null {
  if (!s) return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  // Reject rolled-over values such as 2026-02-31 instead of silently accepting them.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return startOfDay(date);
}

function fmtRange(since: string | null, until: string | null): string {
  const a = parseDay(since);
  const b = parseDay(until);
  if (!a && !b) return "All time";
  if (a && b) {
    const from = isAfter(a, b) ? b : a;
    const to = isAfter(a, b) ? a : b;
    if (isSameDay(from, to)) {
      return `${MONTHS_SHORT[from.getMonth()]} ${from.getDate()}, ${from.getFullYear()}`;
    }
    const sameYear = from.getFullYear() === to.getFullYear();
    const left = `${MONTHS_SHORT[from.getMonth()]} ${from.getDate()}${
      sameYear ? "" : `, ${from.getFullYear()}`
    }`;
    return `${left} – ${MONTHS_SHORT[to.getMonth()]} ${to.getDate()}, ${to.getFullYear()}`;
  }
  const only = a ?? b;
  if (!only) return "All time";
  const prefix = a ? "Since" : "Until";
  return `${prefix} ${MONTHS_SHORT[only.getMonth()]} ${only.getDate()}, ${only.getFullYear()}`;
}

function presetLabel(days: number | null): string | null {
  if (days == null) return null;
  return PRESETS.find((preset) => preset.days === days)?.label ?? null;
}

/** Infer which preset (if any) the live range still represents. */
function presetDaysFor(since: string | null, until: string | null): number | null {
  const a = parseDay(since);
  const b = parseDay(until);
  if (!a || !b) return null;
  const today = startOfDay(new Date());
  // Presets are anchored to today, so an old 7-day window must stay a custom range.
  if (!isSameDay(b, today)) return null;
  const span = differenceInCalendarDays(b, a) + 1;
  if (span === 1) return 1;
  if (span === 7) return 7;
  if (span === 30) return 30;
  if (span === 90) return 90;
  if (
    span > 1 &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === 0 &&
    a.getDate() === 1
  ) {
    return -1;
  }
  return null;
}

export default function DateRangePicker({
  since,
  until,
  presetDays,
  onPreset,
  onCustom,
  onClear,
}: {
  since: string | null;
  until: string | null;
  presetDays: number | null;
  onPreset: (days: number) => void;
  onCustom: (since: string, until: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState<Date | null>(null);
  const [draftEnd, setDraftEnd] = useState<Date | null>(null);
  const [viewMonth, setViewMonth] = useState(() => subMonths(startOfMonth(new Date()), 1));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const titleId = useId();
  const today = startOfDay(new Date());

  const activePreset = useMemo(() => {
    if (presetDays != null) return presetDays;
    if (since == null && until == null) return 0; // All time
    return presetDaysFor(since, until);
  }, [presetDays, since, until]);

  const label = presetLabel(activePreset) ?? fmtRange(since, until);

  /** Close the popover and hand focus back to the trigger. */
  const closePicker = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      // Tabbing (or clicking) outside the popover should dismiss it.
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move focus to the active preset (or the first preset for a custom range)
  // so the quick ranges are reachable before the calendar's roving tab stop.
  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => {
      const node = dialogRef.current;
      if (!node) return;
      const preferred =
        node.querySelector<HTMLButtonElement>("[data-picker-initial='true']") ??
        node.querySelector<HTMLButtonElement>("[data-picker-initial-fallback='true']") ??
        node.querySelector<HTMLButtonElement>("button:not([disabled])");
      preferred?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  const openPicker = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const a = parseDay(since);
    const b = parseDay(until);
    // Telemetry cannot be in the future — clamp stale/future values on open.
    const rawStart = a && isAfter(a, today) ? today : a;
    const rawEnd = b && isAfter(b, today) ? today : b;
    const reversed = rawStart != null && rawEnd != null && isAfter(rawStart, rawEnd);
    const start = reversed ? rawEnd : rawStart;
    const end = reversed ? rawStart : rawEnd;
    setDraftStart(start);
    setDraftEnd(end);

    // Anchor on the range end when it reaches the current month or spans many
    // months; otherwise on the start. The anchor is the right-hand (and on narrow
    // screens, only) month, so back the state up by one month.
    const spansManyMonths =
      start != null && end != null && differenceInCalendarDays(end, start) > 31;
    const anchor =
      end && (isSameMonth(end, today) || spansManyMonths) ? end : (start ?? end ?? today);
    const anchorMonth = startOfMonth(isAfter(anchor, today) ? today : anchor);
    setViewMonth(subMonths(anchorMonth, 1));
    setOpen(true);
  };

  const choosePreset = (days: number) => {
    onPreset(days);
    closePicker();
  };

  const chooseDay = (day: Date) => {
    const d = startOfDay(day);
    if (isAfter(d, today)) return;
    if (!draftStart || draftEnd) {
      setDraftStart(d);
      setDraftEnd(null);
      return;
    }
    if (isBefore(d, draftStart)) {
      setDraftEnd(draftStart);
      setDraftStart(d);
    } else {
      setDraftEnd(d);
    }
  };

  const applyCustom = () => {
    if (!draftStart) return;
    const start = isAfter(draftStart, today) ? today : draftStart;
    const rawEnd = draftEnd ?? start;
    const end = isAfter(rawEnd, today) ? today : rawEnd;
    const swap = isAfter(start, end);
    onCustom(ymd(swap ? end : start), ymd(swap ? start : end));
    closePicker();
  };

  const reset = () => {
    setDraftStart(null);
    setDraftEnd(null);
    onClear();
    closePicker();
  };

  const rangePreview = draftStart
    ? draftEnd
      ? isSameDay(draftStart, draftEnd)
        ? format(draftStart, "MMM d, yyyy")
        : `${format(
            draftStart,
            draftStart.getFullYear() === draftEnd.getFullYear() ? "MMM d" : "MMM d, yyyy",
          )} – ${format(draftEnd, "MMM d, yyyy")}`
      : `${format(draftStart, "MMM d, yyyy")} · pick an end or apply`
    : draftEnd
      ? `${format(draftEnd, "MMM d, yyyy")} · pick a start date`
      : "Pick a start and end date";

  // The right-hand month is the furthest visible one; never page past the current month.
  const nextDisabled = !isBefore(addMonths(viewMonth, 1), startOfMonth(today));

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={openPicker}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={`Time range: ${label}. ${open ? "Close" : "Open"} date range picker`}
        className={cn(
          "group inline-flex h-9 items-center gap-2 rounded-full border bg-card px-3 text-[12px] font-medium text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-primary/35 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas active:scale-[0.98] motion-reduce:transition-none",
          open ? "border-primary/40 text-primary" : "border-hairline",
        )}
      >
        <Calendar size={14} weight="bold" className="shrink-0 text-primary" aria-hidden />
        <span className="max-w-[190px] truncate" title={label}>{label}</span>
        <CaretDown
          size={11}
          weight="bold"
          aria-hidden
          className={cn(
            "shrink-0 text-ink-3 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            open ? "rotate-180 text-primary" : "rotate-0",
          )}
        />
      </button>

      {open && (
        <div
          ref={dialogRef}
          id={dialogId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className="fixed left-3 right-3 top-20 z-50 flex max-h-[calc(100dvh-6rem)] flex-col overflow-hidden rounded-2xl border border-hairline bg-card shadow-[0_24px_64px_-20px_rgba(16,24,40,0.35)] sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-[min(46rem,calc(100dvh-7rem))] sm:w-[min(680px,calc(100vw-2rem))]"
        >
          <h2 id={titleId} className="sr-only">
            Choose a time range
          </h2>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain sm:flex-row">
            {/* Presets */}
            <div className="shrink-0 border-b border-hairline bg-tray/60 p-3 sm:w-44 sm:border-b-0 sm:border-r">
              <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3">
                  Quick range
                </p>
                <button
                  type="button"
                  onClick={() => closePicker()}
                  aria-label="Close date range picker"
                  className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-card hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-1 focus-visible:ring-offset-tray active:scale-95 motion-reduce:transition-none"
                >
                  <X size={12} weight="bold" aria-hidden />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-1" role="group" aria-label="Quick ranges">
                {PRESETS.map((p) => {
                  const active = activePreset === p.days;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => choosePreset(p.days)}
                      aria-pressed={active}
                      data-picker-initial={active ? "true" : undefined}
                      data-picker-initial-fallback={p.days === 1 ? "true" : undefined}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] sm:py-1.5",
                        active
                          ? "bg-primary/[0.08] font-semibold text-primary"
                          : "text-ink-2 hover:bg-card hover:text-ink",
                      )}
                    >
                      {p.label}
                      {active && <Check size={12} weight="bold" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Calendar */}
            <div className="min-w-0 flex-1 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setViewMonth((m) => subMonths(m, 1))}
                  aria-label="Previous month"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-ink-2 transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-tray hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 active:scale-95 motion-reduce:transition-none"
                >
                  <CaretLeft size={13} weight="bold" aria-hidden />
                </button>
                <p className="tnum min-w-0 truncate text-center text-[12px] font-semibold text-ink" aria-live="polite">
                  <span className="sm:hidden">{format(addMonths(viewMonth, 1), "MMMM yyyy")}</span>
                  <span className="hidden sm:inline">
                    {format(viewMonth, "MMMM yyyy")} – {format(addMonths(viewMonth, 1), "MMMM yyyy")}
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => setViewMonth((m) => addMonths(m, 1))}
                  aria-label="Next month"
                  disabled={nextDisabled}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-ink-2 transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-tray hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:active:scale-100 motion-reduce:transition-none"
                >
                  <CaretRight size={13} weight="bold" aria-hidden />
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="hidden sm:block">
                  <MonthGrid
                    month={viewMonth}
                    start={draftStart}
                    end={draftEnd}
                    today={today}
                    onPick={chooseDay}
                  />
                </div>
                <MonthGrid
                  month={addMonths(viewMonth, 1)}
                  start={draftStart}
                  end={draftEnd}
                  today={today}
                  onPick={chooseDay}
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                <p
                  role="status"
                  aria-live="polite"
                  className="tnum w-full min-w-0 truncate font-mono text-[10px] text-ink-3 sm:w-auto"
                >
                  {rangePreview}
                </p>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={reset}
                    className="rounded-full border border-hairline bg-card px-3 py-1.5 text-[12px] font-semibold text-ink-2 transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 active:scale-[0.98] motion-reduce:transition-none"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={applyCustom}
                    disabled={!draftStart}
                    className="rounded-full bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#004a9e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none"
                  >
                    Apply
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MonthGrid({
  month,
  start,
  end,
  today,
  onPick,
}: {
  month: Date;
  start: Date | null;
  end: Date | null;
  today: Date;
  onPick: (d: Date) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  });
  const multiDay = !!start && !!end && !isSameDay(start, end);
  const monthDays = days.filter((d) => isSameMonth(d, month) && !isAfter(d, today));
  const hasSelectedInMonth =
    (!!start && isSameMonth(start, month)) || (!!end && isSameMonth(end, month));
  const defaultFocusDay =
    monthDays.find((d) => isSameDay(d, today)) ?? monthDays[monthDays.length - 1];

  // Roving tab stop: the calendar contributes one day to the tab order, then
  // arrow keys move by day/week. Without this, a double-month grid added ~84
  // stops between the presets and Apply.
  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const iso = active?.dataset.date;
    const current = parseDay(iso);
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
      `[data-date="${ymd(next)}"]`,
    );
    if (target && !target.disabled) {
      e.preventDefault();
      target.focus();
    }
  };

  return (
    <div role="group" aria-label={format(month, "MMMM yyyy")}>
      <p className="mb-1 hidden text-center text-[12px] font-semibold text-ink sm:block">
        {format(month, "MMMM")}
      </p>
      <div ref={gridRef} onKeyDown={onGridKeyDown} className="grid grid-cols-7 gap-y-0.5 text-center">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={`${d}-${i}`} className="py-0.5 font-mono text-[9px] text-ink-3" aria-hidden>
            {d}
          </span>
        ))}
        {days.map((d) => {
          const outside = !isSameMonth(d, month);
          const isStart = !!start && isSameDay(d, start);
          const isEnd = !!end && isSameDay(d, end);
          const selected = isStart || isEnd;
          const inBand = !!start && !!end && isAfter(d, start) && isBefore(d, end);
          const isToday = isSameDay(d, today);
          const disabled = isAfter(d, today);
          const unavailable = disabled || outside;
          const focusable =
            selected ||
            (!hasSelectedInMonth && !!defaultFocusDay && isSameDay(d, defaultFocusDay));
          const rangeHint =
            isStart && isEnd
              ? ", selected day"
              : `${isStart ? ", range start" : ""}${isEnd ? ", range end" : ""}${
                  inBand ? ", in selected range" : ""
                }`;
          const dayLabel = `${format(d, "MMMM d, yyyy")}${isToday ? ", today" : ""}${rangeHint}`;
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onPick(d)}
              disabled={unavailable}
              tabIndex={focusable && !unavailable ? 0 : -1}
              aria-label={dayLabel}
              aria-pressed={selected}
              aria-current={isToday ? "date" : undefined}
              data-date={ymd(d)}
              className={cn(
                "flex h-8 items-center justify-center text-[12px] transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] sm:h-7",
                unavailable
                  ? "cursor-not-allowed text-ink-3/30"
                  : outside
                    ? "rounded-md text-ink-3 hover:bg-tray"
                    : "rounded-md text-ink-2 hover:bg-tray hover:text-ink",
                inBand && !unavailable && "rounded-none bg-primary/[0.08] text-primary hover:bg-primary/[0.14]",
                selected && !unavailable && "rounded-md bg-primary font-semibold text-white hover:bg-primary",
                selected && multiDay && isStart && "rounded-r-none",
                selected && multiDay && isEnd && "rounded-l-none",
                isToday && !selected && "font-semibold text-primary ring-1 ring-inset ring-primary/40",
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
