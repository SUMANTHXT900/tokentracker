import { useEffect, useState } from "react";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import {
  ArrowClockwise,
  ArrowLeft,
  ChatCenteredText,
  CheckCircle,
  Coins,
  Cpu,
  Gauge,
  Lightning,
  ShareNetwork,
  ShieldCheck,
  StopCircle,
  Timer,
  TrendUp,
  WarningCircle,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  cmdStopTrip,
  useTripDetail,
  type DailyDTO,
  type ModelRowDTO,
  type TripDTO,
} from "../lib/tauri";
import { fmtCost, fmtCostPrecise, fmtDurationMs, fmtTokens, splitTokens } from "../lib/format";
import { getClientVisual } from "../lib/client-color";
import { cn } from "../lib/cn";

const EASE = [0.32, 0.72, 0, 1] as const;

/**
 * Local mirror of the detail contract. Fields beyond the original DTO are
 * optional so a partially-upgraded backend can never crash this view before
 * the full summary payload lands.
 */
type TripDetailView = {
  trip: TripDTO;
  baseline?:
    | {
        totals?: { tokens?: number; cost?: number } | null;
        by_model?: ModelRowDTO[] | null;
      }
    | null;
  deltas?:
    | {
        tokens?: number;
        cost?: number;
        messages?: number;
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
        reasoning?: number;
      }
    | null;
  models?: ModelRowDTO[] | null;
  clients?: { client: string; tokens: number; cost: number; messages: number }[] | null;
  sessions?: number | null;
  duration_ms?: number | null;
  top_model?: string | null;
  peak_day?: DailyDTO | null;
  daily?: DailyDTO[] | null;
};

type ClientRow = { client: string; tokens: number; cost: number; messages: number };

const isFiniteNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

const safeNumber = (n: unknown): number => (isFiniteNumber(n) ? n : 0);

/** Always returns a clock face — never "NaN:NaN:NaN". */
function fmtClock(ms: unknown): string {
  if (!isFiniteNumber(ms) || ms < 0) return "--:--:--";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fmtTime(value: string | null | undefined): string {
  const ms = parseTimestamp(value);
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDateTime(value: string | null | undefined): string {
  const ms = parseTimestamp(value);
  if (ms == null) return "—";
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDay(value: string | null | undefined): string {
  if (!value) return "—";
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  const ms = new Date(normalized).getTime();
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return "—";
  return Number.isInteger(h) ? String(h) : h.toFixed(1).replace(/\.0$/, "");
}

function stopSentence(stop: unknown): string {
  if (!stop || typeof stop !== "object") return "Manual stop";
  const s = stop as { kind?: unknown; hours?: unknown; minutes?: unknown };
  if (s.kind === "after" && isFiniteNumber(s.hours) && s.hours > 0) {
    return `Stops after ${fmtHours(s.hours)} h`;
  }
  if (s.kind === "idle" && isFiniteNumber(s.minutes) && s.minutes > 0) {
    return `Stops after ${Math.round(s.minutes)} min idle`;
  }
  return "Manual stop";
}

const STOP_REASON_LABELS: Record<string, string> = {
  manual: "Stopped manually",
  "time-elapsed": "Time limit reached",
  "idle-timeout": "Idle timeout",
  after: "Time limit reached",
  idle: "Idle timeout",
};

function stopReasonLabel(reason: string | null | undefined): string {
  const key = (reason ?? "").trim().toLowerCase();
  if (!key) return "Stopped";
  const known = STOP_REASON_LABELS[key];
  if (known) return known;
  const humanized = key.replace(/[-_]+/g, " ");
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

function normalizeError(
  e: unknown,
  fallback = "Couldn’t load this focus session.",
): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === "string" && e.trim()) return e;
  if (e && typeof e === "object" && "message" in e) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

const fullNum = (n: number) =>
  (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0).toLocaleString("en-US");

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

const CARD_OUTER =
  "rounded-[2rem] bg-white p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)] ring-1 ring-[#e5e5ea]";
const CARD_INNER =
  "relative overflow-hidden rounded-[calc(2rem-0.375rem)] border border-[#e5e5ea]/70 bg-[#faf9fe] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]";

function TripViewSkeleton() {
  return (
    <section aria-busy="true" aria-label="Loading focus session" className={CARD_OUTER}>
      <div className={CARD_INNER}>
        <div role="status" className="p-5 sm:p-6">
          <span className="sr-only">Loading focus session…</span>
          <div aria-hidden="true" className="space-y-6">
            <div className="flex flex-col gap-4 border-b border-[#e5e5ea] pb-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2.5">
                <div className="h-3 w-40 animate-pulse rounded bg-[#eeedf3] motion-reduce:animate-none" />
                <div className="h-7 w-56 animate-pulse rounded bg-[#eeedf3] motion-reduce:animate-none" />
                <div className="h-3 w-64 animate-pulse rounded bg-[#f2f1f7] motion-reduce:animate-none" />
              </div>
              <div className="h-9 w-36 animate-pulse rounded-full bg-[#eeedf3] motion-reduce:animate-none" />
            </div>
            <div className="grid grid-cols-1 gap-8 py-2 lg:grid-cols-12">
              <div className="space-y-3 lg:col-span-7">
                <div className="h-3 w-48 animate-pulse rounded bg-[#eeedf3] motion-reduce:animate-none" />
                <div className="h-12 w-72 max-w-full animate-pulse rounded bg-[#eeedf3] motion-reduce:animate-none" />
                <div className="flex flex-wrap gap-2">
                  <div className="h-7 w-28 animate-pulse rounded-lg bg-[#f2f1f7] motion-reduce:animate-none" />
                  <div className="h-7 w-24 animate-pulse rounded-lg bg-[#f2f1f7] motion-reduce:animate-none" />
                  <div className="h-7 w-24 animate-pulse rounded-lg bg-[#f2f1f7] motion-reduce:animate-none" />
                </div>
              </div>
              <div className="space-y-3 lg:col-span-4">
                <div className="h-3 w-32 animate-pulse rounded bg-[#eeedf3] motion-reduce:animate-none" />
                <div className="h-12 w-48 max-w-full animate-pulse rounded bg-[#eeedf3] motion-reduce:animate-none" />
                <div className="h-3 w-40 animate-pulse rounded bg-[#f2f1f7] motion-reduce:animate-none" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 border-t border-[#e5e5ea] pt-5 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-32 animate-pulse rounded-2xl border border-[#e5e5ea] bg-white motion-reduce:animate-none"
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function TripView({
  tripId,
  live,
  onBack,
  onShare,
  summary,
}: {
  tripId: string;
  live: boolean;
  onBack?: () => void;
  onShare?: () => void;
  /** Fresh list-row metadata (stopped_at/reason), even while the detail scan runs. */
  summary?: TripDTO;
}) {
  const queryClient = useQueryClient();
  const {
    data: rawDetail,
    isPending,
    isError,
    error,
    refetch,
    isFetching,
  } = useTripDetail(tripId, live);
  const detail = rawDetail as TripDetailView | undefined;

  const [stopErr, setStopErr] = useState<string | null>(null);
  const [stopOk, setStopOk] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // The list row is updated immediately by the stop mutation, while the detail
  // query re-scans the whole corpus. Prefer the fresh summary for metadata so
  // the closed header shows its real stop time instead of “—”.
  const trip = summary
    ? { ...(detail?.trip ?? summary), ...summary }
    : detail?.trip;
  const isLive = live && !trip?.stopped_at;
  const isComplete = !!trip && !isLive;

  // 1s ticker so the live elapsed stopwatch ticks each second in real time
  // (the query itself refreshes less often). Calm by design: plain text swap,
  // tabular figures, never announced, never animated. Closed sessions freeze
  // at `stopped_at`, so the interval is not mounted at all.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [isLive]);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setStopErr(null);
    setStopOk(null);
    try {
      await cmdStopTrip(tripId);
    } catch (e) {
      setStopErr(normalizeError(e, "Couldn’t stop the focus session."));
      setStopping(false);
      return;
    }
    setStopOk("Focus session stopped. Final summary below.");
    // Cache refresh is best-effort: the stop already succeeded, so a failed
    // invalidation must not be reported as a failed stop.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["trips"] }),
      queryClient.invalidateQueries({ queryKey: ["trip", tripId] }),
    ]).catch(() => {});
    setStopping(false);
  };

  if (isError && !detail) {
    return (
      <section aria-label="Focus session" className={CARD_OUTER}>
        <div className={CARD_INNER}>
          <div className="p-5 sm:p-6">
            <div
              role="alert"
              className="rounded-2xl border border-red-200 bg-red-50/80 px-4 py-4 text-red-800"
            >
              <div className="flex items-start gap-2.5">
                <WarningCircle size={18} weight="light" className="mt-0.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Couldn’t load this focus session</p>
                  <p className="mt-1 break-words text-xs leading-relaxed text-red-700">
                    {normalizeError(error)}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void refetch()}
                  disabled={isFetching}
                  aria-busy={isFetching}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full bg-[#0058bc] px-4 py-1.5 text-sm font-semibold text-white transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#0067d6] active:scale-[0.97] disabled:cursor-wait disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                >
                  <ArrowClockwise
                    size={14}
                    weight="bold"
                    aria-hidden="true"
                    className={cn(isFetching && "animate-spin motion-reduce:animate-none")}
                  />
                  {isFetching ? "Retrying…" : "Retry"}
                </button>
                {onBack && (
                  <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-white px-4 py-1.5 text-sm font-medium text-[#414755] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-[#c9c9d2] hover:text-[#1a1b1f] active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/50"
                  >
                    <ArrowLeft size={14} weight="light" aria-hidden="true" />
                    Back
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (isPending || !detail || !trip) return <TripViewSkeleton />;
  const d = detail.deltas;
  const tokens = safeNumber(d?.tokens);
  const tokenSplit = splitTokens(tokens);
  const cost = safeNumber(d?.cost);
  const messages = safeNumber(d?.messages);
  const inputTokens = d?.input;
  const outputTokens = d?.output;
  const hasInputOutput =
    (isFiniteNumber(inputTokens) && inputTokens > 0) ||
    (isFiniteNumber(outputTokens) && outputTokens > 0);
  const sessions = safeNumber(detail.sessions);

  const startedMs = parseTimestamp(trip.started_at);
  const stoppedMs = parseTimestamp(trip.stopped_at);
  const endMs = stoppedMs ?? (isLive ? now : startedMs);
  const elapsedMs =
    startedMs != null && endMs != null ? Math.max(0, endMs - startedMs) : 0;
  const durationRaw = detail.duration_ms;
  const backendDurationMs =
    isFiniteNumber(durationRaw) && durationRaw >= 0 ? durationRaw : null;
  // Closed sessions trust the backend duration (the timestamps can be missing
  // on legacy rows); live sessions use the timestamp clock + 1s ticker.
  const displayDurationMs = isLive
    ? elapsedMs
    : stoppedMs != null && startedMs != null
      ? elapsedMs
      : backendDurationMs ?? elapsedMs;
  const elapsed = fmtClock(displayDurationMs);
  const startedLabel = fmtTime(trip.started_at);
  const stoppedLabel = fmtDateTime(trip.stopped_at);

  const elapsedMin = displayDurationMs / 60_000;
  const elapsedHrs = displayDurationMs / 3_600_000;
  const avgTokMin = elapsedMin > 0 ? tokens / elapsedMin : 0;
  const burnRate = elapsedHrs > 0 ? cost / elapsedHrs : 0;

  const scope = trip.scope;
  const scopedClients = scope?.kind === "clients" ? scope.clients ?? [] : [];
  const allClientsScope =
    !scope || scope.kind === "all" || scopedClients.length === 0;

  const stopMode = trip.stop;
  const stopKind =
    stopMode && typeof stopMode === "object" && "kind" in stopMode
      ? (stopMode as { kind: string }).kind
      : "manual";

  // Auto-stop progress (time-based only — the one guardrail with a real deadline).
  const afterHours =
    stopMode && typeof stopMode === "object" && (stopMode as { kind: string }).kind === "after"
      ? (stopMode as { kind: string; hours: number }).hours
      : null;
  const validAfterHours =
    isFiniteNumber(afterHours) && afterHours > 0 ? afterHours : null;
  const deadlineMs = validAfterHours != null ? validAfterHours * 3_600_000 : null;
  const remainingMs = deadlineMs != null ? Math.max(0, deadlineMs - elapsedMs) : null;
  const progressPct =
    deadlineMs != null && deadlineMs > 0
      ? Math.min(100, (elapsedMs / deadlineMs) * 100)
      : null;
  const projectedCost =
    deadlineMs != null && remainingMs != null
      ? cost + burnRate * (remainingMs / 3_600_000)
      : cost + burnRate; // manual / idle: pace for one more hour

  // Session models — per-model delta attribution over the session window.
  const models = [...(detail.models ?? [])]
    .filter((m): m is ModelRowDTO => !!m && typeof m === "object")
    .sort((a, b) => safeNumber(b.tokens) - safeNumber(a.tokens));
  const topModels = models.slice(0, 5);
  const modelTotal = models.reduce((sum, m) => sum + safeNumber(m.tokens), 0);
  const topModel =
    detail.top_model?.trim() || models[0]?.model || null;

  const clients: ClientRow[] = [...(detail.clients ?? [])]
    .filter((c): c is ClientRow => !!c && typeof c === "object" && typeof c.client === "string")
    .sort((a, b) => safeNumber(b.tokens) - safeNumber(a.tokens));

  // Baseline at session start. Per-model baseline attribution is honest here:
  // these are the totals that existed before the session began.
  const baselineByModel = detail.baseline?.by_model ?? [];
  const baselineTotal = safeNumber(detail.baseline?.totals?.tokens);
  const baselineCost = safeNumber(detail.baseline?.totals?.cost);
  const showBaseline = baselineTotal > 0 || baselineByModel.length > 0;
  const baselineModels = [...baselineByModel]
    .filter((m): m is ModelRowDTO => !!m && typeof m === "object")
    .sort((a, b) => safeNumber(b.tokens) - safeNumber(a.tokens))
    .slice(0, 3);
  const baselineModelTotal =
    baselineTotal > 0
      ? baselineTotal
      : baselineModels.reduce((sum, m) => sum + safeNumber(m.tokens), 0);

  // Peak day: explicit backend field first, then the daily series as fallback.
  let peakDay: DailyDTO | null = detail.peak_day ?? null;
  if (!peakDay && detail.daily && detail.daily.length > 0) {
    peakDay = detail.daily.reduce(
      (best, day) => (safeNumber(day.tokens) > safeNumber(best.tokens) ? day : best),
      detail.daily[0],
    );
  }

  const reasonLabel = stopReasonLabel(trip.stop_reason);
  const sessionStamp = trip.name?.trim() || (isLive ? "Focus session" : "Completed focus session");

  return (
    <MotionConfig reducedMotion="user">
      <motion.section
        aria-label={
          isLive ? `Live focus session ${sessionStamp}` : `Focus session summary ${sessionStamp}`
        }
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: EASE }}
        className={CARD_OUTER}
      >
        <div className={CARD_INNER}>
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
            {/* Instrument head: identity, actions, scope pills */}
            <div className="flex flex-col gap-3 border-b border-[#e5e5ea] pb-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 whitespace-nowrap">
                    {isLive ? (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0058bc]">
                        <span className="breathe h-2 w-2 rounded-full bg-[#0070eb]" aria-hidden="true" />
                        Active focus session
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#006b27]">
                        <CheckCircle size={13} weight="fill" aria-hidden="true" />
                        Session complete
                      </span>
                    )}
                    {trip.resumed && (
                      <span
                        title="Restored after an app restart — totals include usage from while the app was closed"
                        className="rounded bg-[#006b27]/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#006b27]"
                      >
                        resumed
                      </span>
                    )}
                  </div>
                  <h3 className="font-display mt-1.5 truncate text-xl font-semibold tracking-tight text-[#1a1b1f]">
                    {sessionStamp}
                  </h3>
                  <p className="mt-0.5 text-[13px] text-ink-3">
                    {isLive
                      ? "Local proxy focus session · recording token flow"
                      : "Local proxy focus session · final summary"}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 self-start">
                  {onBack && (
                    <button
                      type="button"
                      onClick={onBack}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-white px-3.5 py-1.5 text-sm font-medium text-[#414755] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-[#c9c9d2] hover:text-[#1a1b1f] active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/50"
                    >
                      <ArrowLeft size={14} weight="light" aria-hidden="true" />
                      Back
                    </button>
                  )}
                  {onShare && (
                    <button
                      type="button"
                      onClick={onShare}
                      aria-label={`Share ${trip.name || "focus session"}`}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-[#0070eb]/30 bg-[#0070eb]/[0.06] px-3.5 py-1.5 text-sm font-semibold text-[#0058bc] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#0070eb]/[0.12] active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/50"
                    >
                      <ShareNetwork size={14} weight="light" aria-hidden="true" />
                      Share
                    </button>
                  )}
                </div>
              </div>

              {/* Scope pills — read-only mirror of the setup scope. */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">
                  Session scope
                </span>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-label="Session scope"
                >
                  {allClientsScope ? (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#0070eb]/30 bg-[#0070eb]/[0.08] px-3 py-1.5 text-xs font-semibold text-[#0058bc]">
                      {isLive ? (
                        <span
                          className="breathe h-2 w-2 rounded-full bg-[#0070eb]"
                          aria-hidden="true"
                        />
                      ) : (
                        <span
                          className="h-2 w-2 rounded-full bg-[#0058bc]/40"
                          aria-hidden="true"
                        />
                      )}
                      All clients
                    </span>
                  ) : (
                    scopedClients.map((c) => {
                      const v = getClientVisual(c);
                      return (
                        <span
                          key={c}
                          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#e5e5ea] bg-white px-2.5 py-1.5 text-xs font-medium text-[#414755]"
                        >
                          <span
                            className={cn("h-1.5 w-1.5 rounded-full", v.dot)}
                            aria-hidden="true"
                          />
                          {v.label}
                        </span>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Closed-session completion summary: stopped time, duration and
                the humanized stop reason. `role=status` so the final state is
                announced once assistive tech settles. */}
            {isComplete && (
              <div
                role="status"
                aria-live="polite"
                className="mt-4 flex flex-col gap-2 rounded-2xl border border-[#006b27]/20 bg-[#006b27]/[0.05] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <CheckCircle
                    size={17}
                    weight="fill"
                    className="mt-0.5 shrink-0 text-[#006b27]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[#0b4d1f]">
                      {stopOk ? "Focus session stopped" : "Session complete"}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-[#414755]">
                      {reasonLabel} · {stoppedLabel} · Duration{" "}
                      {fmtDurationMs(displayDurationMs)}
                    </p>
                  </div>
                </div>
                <p className="shrink-0 text-xs text-ink-3">
                  Started <strong className="font-medium text-[#414755]">{startedLabel}</strong>
                </p>
              </div>
            )}

            {stopOk && isLive && (
              <div
                role="status"
                className="mt-4 rounded-xl border border-[#006b27]/20 bg-[#006b27]/[0.05] px-3 py-2 text-xs font-medium text-[#0b4d1f]"
              >
                {stopOk}
              </div>
            )}

            {stopErr && (
              <div
                role="alert"
                className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
              >
                Couldn’t stop the focus session: {stopErr}
              </div>
            )}

            {/* Hero metric matrix: token odometer + elapsed clock. */}
            <div className="grid grid-cols-1 items-center gap-8 py-7 lg:grid-cols-12">
              <div className="min-w-0 space-y-3 lg:col-span-7">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-ink-3">
                  <Gauge size={15} weight="light" className="text-[#0058bc]/70" aria-hidden="true" />
                  <span>Session delta · tokens consumed</span>
                </div>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-mono text-3xl font-semibold text-[#0058bc]" aria-hidden="true">
                    +
                  </span>
                  <span
                    className="max-w-full font-mono text-4xl font-bold tracking-tight text-[#1a1b1f] sm:text-5xl xl:text-6xl"
                    aria-live="off"
                    aria-label={`${fullNum(tokens)} tokens consumed this session`}
                    title={`${fullNum(tokens)} tokens consumed this session`}
                  >
                    <AnimatedNumber value={tokens} format={(n) => splitTokens(n).num} />
                  </span>
                  <span
                    className="shrink-0 font-mono text-lg font-medium text-ink-3"
                    title={`${fullNum(tokens)} tokens consumed this session`}
                  >
                    {tokenSplit.unit ? `${tokenSplit.unit} tok` : "tok"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5ea] bg-white px-2.5 py-1 font-mono text-xs text-[#414755]">
                    <Coins size={14} weight="light" className="text-ink-3" aria-hidden="true" />
                    Session spend:&nbsp;
                    <strong className="font-semibold text-[#1a1b1f]">
                      <AnimatedNumber value={cost} format={fmtCost} />
                    </strong>
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#0070eb]/25 bg-[#0070eb]/[0.08] px-2.5 py-1 font-mono text-xs text-[#0058bc]">
                    <Lightning size={14} weight="light" className="text-[#0058bc]" aria-hidden="true" />
                    Avg:&nbsp;
                    <strong className="tnum font-semibold">{fullNum(avgTokMin)} tok/min</strong>
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5ea] bg-white px-2.5 py-1 font-mono text-xs text-[#414755]">
                    <ChatCenteredText
                      size={14}
                      weight="light"
                      className="text-ink-3"
                      aria-hidden="true"
                    />
                    <strong className="tnum font-semibold text-[#1a1b1f]">{fullNum(messages)}</strong>
                    &nbsp;messages
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5ea] bg-white px-2.5 py-1 font-mono text-xs text-[#414755]">
                    <Timer size={14} weight="light" className="text-ink-3" aria-hidden="true" />
                    <strong className="tnum font-semibold text-[#1a1b1f]">{fullNum(sessions)}</strong>
                    &nbsp;sessions
                  </span>
                </div>
              </div>

              <div className="hidden h-24 w-px justify-self-center bg-[#e5e5ea] lg:block" aria-hidden="true" />

              <div className="min-w-0 space-y-3 lg:col-span-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-ink-3">
                    {isLive ? (
                      <span className="breathe h-2 w-2 rounded-full bg-[#34c759]" aria-hidden="true" />
                    ) : (
                      <span className="h-2 w-2 rounded-full bg-[#0058bc]/40" aria-hidden="true" />
                    )}
                    <span>{isLive ? "Elapsed focus time" : "Session duration"}</span>
                  </div>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase",
                      isLive
                        ? "bg-[#0070eb]/[0.08] text-[#0058bc]"
                        : "bg-[#006b27]/[0.08] text-[#006b27]",
                    )}
                  >
                    {isLive ? "Live clock" : "Final"}
                  </span>
                </div>
                <div
                  className="tnum max-w-full font-mono text-4xl font-semibold tracking-tight text-[#1a1b1f] sm:text-5xl"
                  aria-live="off"
                  aria-label={`${isLive ? "Elapsed" : "Duration"} ${elapsed}`}
                >
                  {elapsed}
                </div>
                <div className="flex flex-col gap-0.5 text-[13px] text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <span>
                    Started:{" "}
                    <strong className="font-medium text-[#414755]">{startedLabel}</strong>
                  </span>
                  <span className="text-xs text-ink-3">
                    {isLive ? "· Continuous flow" : `Stopped: ${stoppedLabel}`}
                  </span>
                </div>
              </div>
            </div>

            {/* Action bar: stop lever + auto-stop condition. Hidden entirely for
                closed sessions so no live control is ever offered. */}
            {isLive && (
              <div className="flex flex-col gap-4 border-t border-[#e5e5ea] py-5 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={stop}
                    disabled={stopping}
                    aria-busy={stopping}
                    aria-label={stopping ? "Stopping focus session…" : "Stop focus session"}
                    className={cn(
                      "group flex min-h-[52px] shrink-0 items-center justify-between gap-3 rounded-full",
                      // Deepened endpoint pair (5.7:1 / 8.2:1 on white) so the
                      // white label passes WCAG AA across the whole gradient.
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
                      {stopping ? "Stopping…" : "Stop session"}
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
                      <p className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">
                        Auto-stop condition
                      </p>
                      <p
                        className="mt-0.5 truncate text-[13px] font-medium text-[#414755]"
                        title={stopSentence(trip.stop)}
                      >
                        {stopSentence(trip.stop)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Guardrails: auto-stop readout + deadline progress. Live only —
                a closed session has no remaining budget to track. */}
            {isLive && (
              <div className="space-y-4 border-t border-[#e5e5ea] pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 text-ink-3">
                    <Timer size={15} weight="light" className="text-ink-3" aria-hidden="true" />
                    <span className="font-medium">Auto-stop condition:</span>
                  </div>
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
                            stopKind === "after" && validAfterHours != null
                              ? `After ${fmtHours(validAfterHours)}h${remainingMs != null ? ` (${fmtClock(remainingMs)} left)` : ""}`
                              : "After duration",
                        },
                        { id: "idle", label: "When idle" },
                      ] as const
                    ).map((o) => {
                      const on = stopKind === o.id;
                      return (
                        <span
                          key={o.id}
                          className={cn(
                            "tnum inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono",
                            on
                              ? "bg-[#0070eb]/10 font-semibold text-[#0058bc] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]"
                              : "font-medium text-ink-3",
                          )}
                        >
                          {on && (
                            <>
                              <span className="sr-only">Current:</span>
                              <span
                                className="h-1.5 w-1.5 rounded-full bg-[#0070eb]"
                                aria-hidden="true"
                              />
                            </>
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
                        <ShieldCheck
                          size={15}
                          weight="light"
                          className="text-[#0058bc]/70"
                          aria-hidden="true"
                        />
                        Session time budget
                      </span>
                      <span className="tnum font-mono text-ink-3">
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
                        className="h-full w-full origin-left rounded-full bg-gradient-to-r from-[#0058bc] via-[#0070eb] to-[#4da3ff]"
                        initial={false}
                        animate={{ scaleX: Math.max(0, Math.min(1, progressPct / 100)) }}
                        transition={{ duration: 0.7, ease: EASE }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-ink-3">
                      <span>
                        Remaining before auto-stop:{" "}
                        <strong className="tnum font-mono text-[#414755]">
                          {remainingMs != null ? fmtClock(remainingMs) : "—"}
                        </strong>
                      </span>
                      <span className="font-medium text-[#0058bc]">
                        {remainingMs != null && remainingMs > 0
                          ? "Within budget"
                          : "Budget reached"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-ink-3">
                    {stopKind === "idle"
                      ? "Stops itself after token flow goes quiet — no deadline to track."
                      : "Manual stop — this focus session runs until you stop it by hand."}
                  </p>
                )}
              </div>
            )}

            {/* Mid-level telemetry bento */}
            <div
              className={cn(
                "grid grid-cols-1 gap-3 pt-5",
                topModels.length > 0 ? "xl:grid-cols-3" : "xl:grid-cols-2",
              )}
            >
              <div className="rounded-2xl border border-[#e5e5ea] bg-white p-4">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-[#1a1b1f]">
                  <TrendUp
                    size={15}
                    weight="light"
                    className="text-[#0058bc]/70"
                    aria-hidden="true"
                  />
                  {isLive ? "Velocity & cost pace" : "Session pace"}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="min-w-0 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-2">
                    <p className="text-[11px] text-ink-3">Burn rate</p>
                    <p className="tnum mt-0.5 break-words font-mono text-lg font-bold leading-tight text-[#1a1b1f]">
                      {fmtCost(burnRate)}
                      <span className="text-xs font-normal text-ink-3"> /hr</span>
                    </p>
                  </div>
                  <div className="min-w-0 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-2">
                    <p className="text-[11px] text-ink-3">
                      {isLive ? "Projected spend" : "Session spend"}
                    </p>
                    <p className="tnum mt-0.5 break-words font-mono text-lg font-bold leading-tight text-[#1a1b1f]">
                      {fmtCost(isLive ? projectedCost : cost)}
                    </p>
                  </div>
                </div>
                <p className="tnum mt-3 border-t border-[#e5e5ea] pt-2.5 font-mono text-[11px] text-ink-3">
                  {fullNum(avgTokMin)} tok/min average
                </p>
              </div>

              <div className="rounded-2xl border border-[#e5e5ea] bg-white p-4">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-[#1a1b1f]">
                  <ChatCenteredText
                    size={15}
                    weight="light"
                    className="text-[#0058bc]/70"
                    aria-hidden="true"
                  />
                  Session flow
                </p>
                <div className="mt-3 space-y-1.5 font-mono text-xs">
                  <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-ink-3">
                    <span className="min-w-0 truncate">Messages</span>
                    <span className="tnum shrink-0 font-medium text-[#1a1b1f]">
                      {fullNum(messages)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-ink-3">
                    <span className="min-w-0 truncate">Sessions</span>
                    <span className="tnum shrink-0 font-medium text-[#1a1b1f]">
                      {fullNum(sessions)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-ink-3">
                    <span className="min-w-0 truncate">Tokens / message</span>
                    <span className="tnum shrink-0 font-medium text-[#1a1b1f]">
                      {messages > 0 ? fullNum(tokens / messages) : "—"}
                    </span>
                  </div>
                  {hasInputOutput && (
                    <>
                      <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-ink-3">
                        <span className="min-w-0 truncate">Input tokens</span>
                        <span
                          className="tnum shrink-0 font-medium text-[#1a1b1f]"
                          title={`${fullNum(safeNumber(inputTokens))} tokens`}
                        >
                          {fmtTokens(safeNumber(inputTokens))} tok
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-ink-3">
                        <span className="min-w-0 truncate">Output tokens</span>
                        <span
                          className="tnum shrink-0 font-medium text-[#1a1b1f]"
                          title={`${fullNum(safeNumber(outputTokens))} tokens`}
                        >
                          {fmtTokens(safeNumber(outputTokens))} tok
                        </span>
                      </div>
                    </>
                  )}
                  <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-ink-3">
                    <span className="min-w-0 truncate">Cost / message</span>
                    <span className="tnum shrink-0 font-medium text-[#0058bc]">
                      {messages > 0 ? fmtCostPrecise(cost / messages) : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] py-1 text-ink-3">
                    <span className="min-w-0 truncate">Top model</span>
                    <span
                      className="max-w-[62%] truncate font-medium text-[#1a1b1f]"
                      title={topModel ?? undefined}
                    >
                      {topModel ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 py-1 text-ink-3">
                    <span className="min-w-0 truncate">Peak day</span>
                    <span
                      className="tnum max-w-[62%] truncate font-medium text-[#1a1b1f]"
                      title={peakDay?.date}
                    >
                      {peakDay
                        ? `${fmtDay(peakDay.date)} · ${fmtTokens(peakDay.tokens)} tok`
                        : "—"}
                    </span>
                  </div>
                </div>
                <p className="mt-2.5 border-t border-[#e5e5ea] pt-2.5 text-[11px] text-ink-3">
                  {isLive
                    ? "Telemetry refreshes automatically."
                    : "Final telemetry — no further updates."}
                </p>
              </div>

              {topModels.length > 0 && (
                <div className="rounded-2xl border border-[#e5e5ea] bg-white p-4">
                  <p className="flex items-center gap-2 text-[13px] font-semibold text-[#1a1b1f]">
                    <Cpu
                      size={15}
                      weight="light"
                      className="text-[#0058bc]/70"
                      aria-hidden="true"
                    />
                    Session models
                  </p>
                  <div className="mt-3 space-y-3">
                    {topModels.map((m, i) => {
                      const share = modelTotal > 0 ? safeNumber(m.tokens) / modelTotal : 0;
                      return (
                        <div key={`${m.client}-${m.model}-${m.provider}-${i}`} className="space-y-1">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="max-w-[60%] truncate font-medium text-[#414755]">
                              {m.model}
                            </span>
                            <span className="tnum shrink-0 font-mono text-ink-3">
                              {fmtTokens(m.tokens)} ({(share * 100).toFixed(0)}%)
                            </span>
                          </div>
                          <div
                            className="h-2 w-full overflow-hidden rounded-full bg-[#eeedf3]"
                            role="progressbar"
                            aria-label={`${m.model} share of session tokens`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(share * 100)}
                          >
                            <motion.div
                              className="h-full w-full origin-left rounded-full bg-[#0070eb]"
                              initial={false}
                              animate={{ scaleX: Math.max(0, Math.min(1, share)) }}
                              transition={{ duration: 0.7, ease: EASE }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-3 border-t border-[#e5e5ea] pt-2.5 font-mono text-[11px] text-ink-3">
                    Mix during this session — dashboard totals unaffected.
                  </p>
                </div>
              )}
            </div>

            {/* Compact client breakdown for the session window. */}
            {clients.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-[#e5e5ea] bg-white px-4 py-3">
                <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">
                  Clients in this session
                </span>
                {clients.map((c) => {
                  const v = getClientVisual(c.client);
                  return (
                    <span
                      key={c.client}
                      title={`${fullNum(safeNumber(c.messages))} messages`}
                      className="tnum inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-[#faf9fe] px-2.5 py-1 font-mono text-[11px] text-[#414755]"
                    >
                      <span
                        className={cn("h-1.5 w-1.5 rounded-full", v.dot)}
                        aria-hidden="true"
                      />
                      <span className="font-medium">{v.label}</span>
                      <span className="text-ink-3">{fmtTokens(c.tokens)}</span>
                      <span className="text-ink-3">· {fmtCost(c.cost)}</span>
                    </span>
                  );
                })}
              </div>
            )}

            {/* Baseline snapshot — only rendered when there is something real
                to show (no empty "collecting…" card). */}
            {showBaseline && (
              <section
                aria-label="Baseline at session start"
                className="mt-3 rounded-2xl border border-[#e5e5ea] bg-white p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-[13px] font-semibold text-[#1a1b1f]">
                    <Cpu
                      size={15}
                      weight="light"
                      className="text-[#0058bc]/70"
                      aria-hidden="true"
                    />
                    Baseline at session start
                  </p>
                  <p className="tnum font-mono text-xs text-ink-3">
                    {fmtTokens(baselineTotal > 0 ? baselineTotal : baselineModelTotal)} tok ·{" "}
                    {fmtCost(baselineCost)}
                  </p>
                </div>
                {baselineModels.length > 0 ? (
                  <div className="mt-3 space-y-2.5">
                    {baselineModels.map((m, i) => {
                      const share =
                        baselineModelTotal > 0
                          ? safeNumber(m.tokens) / baselineModelTotal
                          : 0;
                      return (
                        <div
                          key={`${m.client}-${m.model}-${m.provider}-${i}`}
                          className="space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="max-w-[60%] truncate font-medium text-[#414755]">
                              {m.model}
                            </span>
                            <span className="tnum shrink-0 font-mono text-ink-3">
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
                              className="h-full w-full origin-left rounded-full bg-[#0058bc]/60"
                              initial={false}
                              animate={{ scaleX: Math.max(0, Math.min(1, share)) }}
                              transition={{ duration: 0.7, ease: EASE }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-ink-3">
                    No model-level baseline was recorded for this session.
                  </p>
                )}
                <p className="mt-3 border-t border-[#e5e5ea] pt-2.5 font-mono text-[11px] text-ink-3">
                  Models at start — captured before the session began; dashboard totals unaffected.
                </p>
              </section>
            )}

            {/* Footer microcopy */}
            <div className="mt-5 space-y-1 border-t border-[#e5e5ea] pt-3">
              <p className="text-[11px] leading-relaxed text-ink-3">
                {isFetching && isLive
                  ? "Syncing live telemetry…"
                  : isLive
                    ? "Elapsed clock ticks each second."
                    : "Session closed — final totals are frozen."}
              </p>
              <p className="tnum font-mono text-[11px] leading-relaxed text-ink-3">
                {allClientsScope
                  ? "Session scope: all clients"
                  : `Session scope: ${scopedClients.length} ${
                      scopedClients.length === 1 ? "client" : "clients"
                    }`}
              </p>
            </div>
          </div>
        </div>
      </motion.section>
    </MotionConfig>
  );
}
