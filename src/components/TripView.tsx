import { useEffect, useState } from "react";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import {
  ChatCenteredText,
  Coins,
  Cpu,
  Gauge,
  Lightning,
  ShieldCheck,
  StopCircle,
  Timer,
  TrendUp,
} from "@phosphor-icons/react";
import { cmdStopTrip, useTripDetail } from "../lib/tauri";
import { useStore } from "../store";
import { fmtCost, fmtTokens } from "../lib/format";
import { getClientVisual } from "../lib/client-color";
import { cn } from "../lib/cn";

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function stopSentence(stop: unknown): string {
  if (!stop || typeof stop !== "object") return "Manual stop";
  const s = stop as { kind?: string; hours?: number; minutes?: number };
  if (s.kind === "after" && typeof s.hours === "number") return `Stops after ${s.hours} h`;
  if (s.kind === "idle" && typeof s.minutes === "number")
    return `Stops after ${s.minutes} min idle`;
  return "Manual stop";
}

const EASE = [0.32, 0.72, 0, 1] as const;

/**
 * Calm animated figure: slides the new value in on change (spring bezier,
 * transform + opacity only — never a color flash). Reduced-motion renders
 * a plain tabular span with no animation.
 *
 * Odometer geometry (measured, not assumed): an `inline-block` whose
 * `overflow` is not `visible` falls back to its bottom margin edge as the
 * baseline (CSS 2.1 §10.8.1), which lifts the digits ~10px off the row
 * baseline in the `items-baseline` hero row — they collide with the label
 * above and misalign with the `+` / `tok` glyphs. `inline-flex` keeps the
 * real text baseline (0px delta) while still clipping the slide, and the
 * 1.2 line box leaves room so comma descenders are not shaved off at rest.
 */
function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}) {
  // Hooks always run before the reduced-motion early return below.
  const reduce = useReducedMotion();
  const text = format(value);
  if (reduce) return <span className={cn("tnum", className)}>{text}</span>;
  return (
    <span className={cn("tnum inline-flex overflow-hidden align-baseline", className)}>
      <motion.span
        key={text}
        initial={{ y: 10, opacity: 0.35 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.45, ease: EASE }}
        className="block leading-[1.2]"
      >
        {text}
      </motion.span>
    </span>
  );
}

const fullNum = (n: number) =>
  (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0).toLocaleString("en-US");

export default function TripView({ tripId }: { tripId: string }) {
  const { data: detail, isFetching } = useTripDetail(tripId, true);
  const { setActiveTripId } = useStore();
  const [stopErr, setStopErr] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // 1s ticker so the live elapsed stopwatch ticks each second in real time
  // (the trip query itself only refetches every 15s). Calm by design: plain
  // text swap, tabular figures, never announced, never animated — no flash,
  // no pulse, no color shift on tick (vestibular-safe).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const stop = async () => {
    setStopping(true);
    setStopErr(null);
    try {
      await cmdStopTrip(tripId);
      setActiveTripId(null);
    } catch (e) {
      setStopErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  };

  const trip = detail?.trip;
  const d = detail?.deltas;
  const startedMs = trip?.started_at ? new Date(trip.started_at).getTime() : now;
  const elapsedMs = Math.max(0, now - startedMs);
  const elapsed = fmtClock(elapsedMs);
  const startedLabel = trip?.started_at
    ? new Date(trip.started_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

  const tokens = d?.tokens ?? 0;
  const cost = d?.cost ?? 0;
  const messages = d?.messages ?? 0;
  const elapsedMin = elapsedMs / 60_000;
  const elapsedHrs = elapsedMs / 3_600_000;
  const avgTokMin = elapsedMin > 0 ? tokens / elapsedMin : 0;
  const burnRate = elapsedHrs > 0 ? cost / elapsedHrs : 0;

  const scope = trip?.scope;
  const stopMode = trip?.stop;
  const stopKind =
    stopMode && typeof stopMode === "object" && "kind" in stopMode
      ? (stopMode as { kind: string }).kind
      : "manual";

  // Auto-stop progress (time-based only — the one guardrail with a real deadline).
  const afterHours =
    stopMode && typeof stopMode === "object" && (stopMode as { kind: string }).kind === "after"
      ? (stopMode as { kind: string; hours: number }).hours
      : null;
  const deadlineMs = afterHours ? afterHours * 3_600_000 : null;
  const remainingMs = deadlineMs != null ? Math.max(0, deadlineMs - elapsedMs) : null;
  const progressPct =
    deadlineMs != null && deadlineMs > 0
      ? Math.min(100, (elapsedMs / deadlineMs) * 100)
      : null;
  const projectedCost =
    deadlineMs != null && remainingMs != null
      ? cost + burnRate * (remainingMs / 3_600_000)
      : cost + burnRate; // manual / idle: pace for one more hour

  // Baseline model mix at trip start (honest label — per-model delta attribution
  // is not reported by the backend, so this card reads the start baseline).
  const baselineModels = [...(detail?.baseline.by_model ?? [])]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);
  const baselineTotal = detail?.baseline.totals.tokens ?? 0;
  const streams = baselineModels.map((m) => ({
    model: m.model,
    client: m.client,
    tokens: m.tokens,
  }));

  return (
    <MotionConfig reducedMotion="user">
      <motion.section
        aria-label={trip?.name ? `Live focus ${trip.name}` : "Live focus"}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: EASE }}
      className="rounded-[2rem] bg-white p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)] ring-1 ring-[#e5e5ea]"
    >
      <div className="relative overflow-hidden rounded-[calc(2rem-0.375rem)] border border-[#e5e5ea]/70 bg-[#faf9fe] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
        {/* Signal wash — static ambience, GPU-safe, decorative only */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-1/4 h-64 w-[36rem] rounded-full bg-[#0070eb]/[0.06] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#0070eb]/20 to-transparent"
        />

        <div className="relative p-5 sm:p-6">
          {/* Instrument head: identity + scope pills */}
          <div className="flex flex-col gap-3 border-b border-[#e5e5ea] pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {/* Eyebrow: never break mid-phrase — the badge may drop to its
                  own line when the title block is squeezed at the 800px
                  minimum window width. */}
              <div className="flex flex-wrap items-center gap-2 whitespace-nowrap">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0058bc]">
                  High-precision telemetry
                </span>
                <span className="rounded bg-[#0070eb]/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#414755]">
                  15s tick
                </span>
              </div>
              <h3 className="font-display mt-1.5 truncate text-xl font-semibold tracking-tight text-[#1a1b1f]">
                {trip?.name ?? "Live focus"}
              </h3>
              <p className="mt-0.5 text-[13px] text-[#717786]">
                Local proxy trip meter · recording token flow
              </p>
            </div>
            {/* Scope pills — read-only mirror of the setup scope.
                `whitespace-nowrap` keeps each pill on one line: when the
                title block squeezes the group at the 800px minimum width,
                the group wraps pills to new rows instead of breaking pill
                text mid-phrase. */}
            <div
              className="flex flex-wrap items-center gap-1.5 self-start sm:self-auto"
              role="group"
              aria-label="Trip scope"
            >
              {!scope || scope.kind === "all" ? (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#0070eb]/30 bg-[#0070eb]/[0.08] px-3 py-1.5 text-xs font-semibold text-[#0058bc]">
                  <span
                    className="breathe h-2 w-2 rounded-full bg-[#0070eb]"
                    aria-hidden="true"
                  />
                  All clients (Active)
                </span>
              ) : (
                scope.clients.map((c) => {
                  const v = getClientVisual(c);
                  return (
                    <span
                      key={c}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#e5e5ea] bg-white px-2.5 py-1.5 text-xs font-medium text-[#414755]"
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", v.dot)} aria-hidden="true" />
                      {v.label}
                    </span>
                  );
                })
              )}
            </div>
          </div>

          {/* Hero metric matrix: token odometer + elapsed clock.
              Single column below lg so the 800–1024px window never squeezes
              the odometer against the clock. Fluid display type
              (4xl → 5xl → 6xl at xl) keeps long comma-grouped numerals inside
              a ~420px card column instead of colliding with the unit glyph. */}
          <div className="grid grid-cols-1 items-center gap-8 py-7 lg:grid-cols-12">
            <div className="min-w-0 space-y-3 lg:col-span-7">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-[#717786]">
                <Gauge size={15} weight="light" className="text-[#0058bc]/70" aria-hidden="true" />
                <span>Tokens consumed this session</span>
              </div>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-3xl font-semibold text-[#0058bc]" aria-hidden="true">
                  +
                </span>
                <span
                  className="max-w-full font-mono text-4xl font-bold tracking-tight text-[#1a1b1f] sm:text-5xl xl:text-6xl"
                  aria-live="off"
                  aria-label={`${fullNum(tokens)} tokens consumed this session`}
                >
                  <AnimatedNumber value={tokens} format={fullNum} />
                </span>
                <span className="shrink-0 font-mono text-lg font-medium text-[#717786]">tok</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5ea] bg-white px-2.5 py-1 font-mono text-xs text-[#414755]">
                  <Coins size={14} weight="light" className="text-[#717786]" aria-hidden="true" />
                  Est. spend:&nbsp;
                  <strong className="font-semibold text-[#1a1b1f]">
                    <AnimatedNumber value={cost} format={fmtCost} />
                  </strong>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#0070eb]/25 bg-[#0070eb]/[0.08] px-2.5 py-1 font-mono text-xs text-[#0058bc]">
                  <Lightning size={14} weight="light" className="text-[#0058bc]" aria-hidden="true" />
                  Avg:&nbsp;
                  <strong className="tnum font-semibold">
                    {fullNum(avgTokMin)} tok/min
                  </strong>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5ea] bg-white px-2.5 py-1 font-mono text-xs text-[#414755]">
                  <ChatCenteredText size={14} weight="light" className="text-[#717786]" aria-hidden="true" />
                  <strong className="tnum font-semibold text-[#1a1b1f]">
                    {fullNum(messages)}
                  </strong>
                  &nbsp;messages
                </span>
              </div>
            </div>

            <div className="hidden h-24 w-px justify-self-center bg-[#e5e5ea] lg:block" aria-hidden="true" />

            <div className="min-w-0 space-y-3 lg:col-span-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-[#717786]">
                  <span
                    className="breathe h-2 w-2 rounded-full bg-[#34c759]"
                    aria-hidden="true"
                  />
                  <span>Elapsed focus time</span>
                </div>
                <span className="rounded bg-[#0070eb]/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-[#0058bc]">
                  Live clock
                </span>
              </div>
              <div
                className="tnum max-w-full font-mono text-4xl font-semibold tracking-tight text-[#1a1b1f] sm:text-5xl"
                aria-live="off"
                aria-label={`Elapsed ${elapsed}`}
              >
                {elapsed}
              </div>
              <div className="flex items-center justify-between text-[13px] text-[#717786]">
                <span>
                  Started: <strong className="font-medium text-[#414755]">{startedLabel}</strong>
                </span>
                <span className="text-xs text-[#717786]">· Continuous flow</span>
              </div>
            </div>
          </div>

          {/* Action bar: stop lever + active streams.
              Below lg the card column is only ~420px wide (800px window minus
              the268px rail), so the lever row stacks instead of fighting the
              streams for one line, and the stop sentence truncates rather
              than pushing the condition panel past the card edge. */}
          <div className="flex flex-col gap-4 border-t border-[#e5e5ea] py-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={stop}
                disabled={stopping}
                aria-label="Stop focus session"
                className={cn(
                  "group flex min-h-[52px] shrink-0 items-center justify-between gap-3 rounded-full",
                  // Deepened endpoint pair (5.7:1 / 8.2:1 on white) so the
                  // white label passes WCAG AA across the whole gradient —
                  // the old #F2555A stop washed to 3.4:1 at the top edge.
                  "bg-gradient-to-b from-[#C81E1E] to-[#9B1C1C] py-2 pl-5 pr-2",
                  "text-sm font-semibold text-white",
                  "shadow-[inset_0_1px_1px_rgba(255,255,255,0.35),0_12px_28px_-12px_rgba(200,30,30,0.55)]",
                  "transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                  "hover:brightness-110 active:scale-[0.97] active:brightness-95",
                  "disabled:cursor-wait disabled:opacity-50",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C81E1E]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
                )}
              >
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 rounded-[3px] bg-white" aria-hidden="true" />
                  {stopping ? "Stopping" : "Stop session"}
                </span>
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-black/25 shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-105 group-active:scale-90"
                >
                  <StopCircle size={17} weight="light" />
                </span>
              </button>
              <div className="min-w-0 flex-auto rounded-[1.25rem] bg-[#f4f3f8] p-1 ring-1 ring-[#e5e5ea]">
                <div className="rounded-[calc(1.25rem-0.25rem)] bg-white px-4 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                  <p className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-[#717786]">
                    Stop condition
                  </p>
                  <p
                    className="mt-0.5 truncate text-[13px] font-medium text-[#414755]"
                    title={trip ? stopSentence(trip.stop) : "Manual stop"}
                  >
                    {trip ? stopSentence(trip.stop) : "Manual stop"}
                  </p>
                </div>
              </div>
            </div>
            {streams.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span className="mr-1 text-[11px] font-medium text-[#717786]">Active streams:</span>
                {streams.map((s) => {
                  const v = getClientVisual(s.client);
                  return (
                    <span
                      key={`${s.client}-${s.model}`}
                      title={`${s.model} via ${v.label}`}
                      className="tnum inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-white px-2.5 py-1 font-mono text-[#414755]"
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", v.dot)} aria-hidden="true" />
                      <span className="max-w-[10rem] truncate font-medium">{s.model}</span>
                      <span className="text-[#717786]">{fmtTokens(s.tokens)}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {stopErr && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              Couldn&apos;t stop the focus: {stopErr}
            </div>
          )}

          {/* Guardrails: auto-stop readout + deadline progress */}
          <div className="space-y-4 border-t border-[#e5e5ea] pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 text-[#717786]">
                <Timer size={15} weight="light" className="text-[#717786]" aria-hidden="true" />
                <span className="font-medium">Trip auto-stop condition:</span>
              </div>
              {/* Segmented readout: wraps its own chips instead of running the
                  long "After … (… left)" label past the card edge. */}
              <div
                className="flex min-w-0 flex-wrap items-center gap-1 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] p-1"
                role="group"
                aria-label="Auto-stop condition"
              >
                {(
                  [
                    { id: "manual", label: "Manual only" },
                    {
                      id: "after",
                      label:
                        stopKind === "after" && afterHours
                          ? `After ${afterHours}h${remainingMs != null ? ` (${fmtClock(remainingMs)} left)` : ""}`
                          : "After duration",
                    },
                    { id: "idle", label: "When idle" },
                  ] as const
                ).map((o) => {
                  const on = stopKind === o.id;
                  return (
                    <span
                      key={o.id}
                      aria-current={on ? "true" : undefined}
                      className={cn(
                        "tnum inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono",
                        on
                          ? "bg-[#0070eb]/10 font-semibold text-[#0058bc] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]"
                          : "font-medium text-[#717786]",
                      )}
                    >
                      {on && (
                        <span className="h-1.5 w-1.5 rounded-full bg-[#0070eb]" aria-hidden="true" />
                      )}
                      {o.label}
                    </span>
                  );
                })}
              </div>
            </div>
            {progressPct != null && deadlineMs != null ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="flex items-center gap-1.5 text-[#414755]">
                    <ShieldCheck size={15} weight="light" className="text-[#0058bc]/70" aria-hidden="true" />
                    Session time budget
                  </span>
                  <span className="tnum font-mono text-[#717786]">
                    <strong className="text-[#1a1b1f]">{elapsed}</strong>
                    {" / "}
                    {fmtClock(deadlineMs)}
                    <span className="ml-1 font-bold text-[#0058bc]">
                      ({progressPct.toFixed(1)}%)
                    </span>
                  </span>
                </div>
                <div
                  className="h-2.5 w-full overflow-hidden rounded-full border border-[#e5e5ea] bg-[#eeedf3]"
                  role="progressbar"
                  aria-label="Session time budget used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progressPct)}
                >
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-[#0058bc] via-[#0070eb] to-[#4da3ff]"
                    initial={false}
                    animate={{ width: `${progressPct}%` }}
                    transition={{ duration: 0.7, ease: EASE }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-[#717786]">
                  <span>
                    Remaining before auto-stop:{" "}
                    <strong className="tnum font-mono text-[#414755]">
                      {remainingMs != null ? fmtClock(remainingMs) : "—"}
                    </strong>
                  </span>
                  <span className="font-medium text-[#0058bc]">Within budget</span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-[#717786]">
                {stopKind === "idle"
                  ? "Stops itself after token flow goes quiet — no deadline to track."
                  : "Manual stop — this trip runs until you stop it by hand."}
              </p>
            )}
          </div>

          {/* Mid-level telemetry bento — three columns only once the card
              column can actually hold them (xl+). At md–lg the column is
              420–640px, which squeezed each stat cell to ~45–60px and made
              the burn-rate / projected figures collide. */}
          <div className="grid grid-cols-1 gap-3 pt-5 xl:grid-cols-3">
            <div className="rounded-2xl border border-[#e5e5ea] bg-white p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-[#1a1b1f]">
                <TrendUp size={15} weight="light" className="text-[#0058bc]/70" aria-hidden="true" />
                Velocity &amp; cost pace
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="min-w-0 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-2">
                  <p className="text-[11px] text-[#717786]">Burn rate</p>
                  <p className="tnum mt-0.5 break-words font-mono text-lg font-bold leading-tight text-[#1a1b1f]">
                    {fmtCost(burnRate)}
                    <span className="text-xs font-normal text-[#717786]"> /hr</span>
                  </p>
                </div>
                <div className="min-w-0 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-2">
                  <p className="text-[11px] text-[#717786]">Trip projected</p>
                  <p className="tnum mt-0.5 break-words font-mono text-lg font-bold leading-tight text-[#1a1b1f]">
                    {fmtCost(projectedCost)}
                  </p>
                </div>
              </div>
              <p className="tnum mt-3 border-t border-[#e5e5ea] pt-2.5 font-mono text-[11px] text-[#717786]">
                {fullNum(avgTokMin)} tok/min average
              </p>
            </div>

            <div className="rounded-2xl border border-[#e5e5ea] bg-white p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-[#1a1b1f]">
                <ChatCenteredText size={15} weight="light" className="text-[#0058bc]/70" aria-hidden="true" />
                Session flow
              </p>
              <div className="mt-3 space-y-1.5 font-mono text-xs">
                <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-[#717786]">
                  <span className="min-w-0 truncate">Messages</span>
                  <span className="tnum shrink-0 font-medium text-[#1a1b1f]">{fullNum(messages)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-[#717786]">
                  <span className="min-w-0 truncate">Tokens / message</span>
                  <span className="tnum shrink-0 font-medium text-[#1a1b1f]">
                    {messages > 0 ? fullNum(tokens / messages) : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 py-1 text-[#717786]">
                  <span className="min-w-0 truncate">Cost / message</span>
                  <span className="tnum shrink-0 font-medium text-[#0058bc]">
                    {messages > 0 ? fmtCost(cost / messages) : "—"}
                  </span>
                </div>
              </div>
              <p className="mt-2.5 border-t border-[#e5e5ea] pt-2.5 text-[11px] text-[#717786]">
                Telemetry refreshes every 15 seconds.
              </p>
            </div>

            <div className="rounded-2xl border border-[#e5e5ea] bg-white p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-[#1a1b1f]">
                <Cpu size={15} weight="light" className="text-[#0058bc]/70" aria-hidden="true" />
                Baseline model mix
              </p>
              {baselineModels.length > 0 ? (
                <div className="mt-3 space-y-3">
                  {baselineModels.map((m) => {
                    const share = baselineTotal > 0 ? m.tokens / baselineTotal : 0;
                    return (
                      <div key={`${m.client}-${m.model}`} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="max-w-[60%] truncate font-medium text-[#414755]">
                            {m.model}
                          </span>
                          <span className="tnum font-mono text-[#717786]">
                            {fmtTokens(m.tokens)} ({(share * 100).toFixed(0)}%)
                          </span>
                        </div>
                        <div
                          className="h-2 w-full overflow-hidden rounded-full bg-[#eeedf3]"
                          role="progressbar"
                          aria-label={`${m.model} share of baseline`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(share * 100)}
                        >
                          <motion.div
                            className="h-full rounded-full bg-[#0070eb]"
                            initial={false}
                            animate={{ width: `${Math.min(100, share * 100)}%` }}
                            transition={{ duration: 0.7, ease: EASE }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-3 text-xs text-[#717786]">Collecting the start baseline…</p>
              )}
              <p className="mt-3 border-t border-[#e5e5ea] pt-2.5 font-mono text-[11px] text-[#717786]">
                Mix at trip start — dashboard totals unaffected.
              </p>
            </div>
          </div>

          {/* Bench plate microcopy */}
          <div className="mt-5 space-y-1 border-t border-[#e5e5ea] pt-3">
            <p className="text-[11px] leading-relaxed text-[#717786]">
              {isFetching ? "Syncing live telemetry…" : "Stopwatch ticks each second"}
            </p>
            <p className="tnum font-mono text-[11px] leading-relaxed text-[#717786]">
              {scope?.kind === "clients"
                ? `Scoped to ${scope.clients.length} ${scope.clients.length === 1 ? "client" : "clients"}`
                : "Scoped to all clients"}
            </p>
          </div>
        </div>
      </div>
      </motion.section>
    </MotionConfig>
  );
}
