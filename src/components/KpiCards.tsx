import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CurrencyDollar, Database, Flame, TerminalWindow } from "@phosphor-icons/react";
import type { DailyDTO, UsageSnapshotDTO } from "../lib/tauri";
import { fmtCost, fmtCostPrecise, fmtPct, fmtTokens, splitTokens } from "../lib/format";
import { getClientVisual } from "../lib/client-color";
import { cn } from "../lib/cn";
import { useStore } from "../store";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];
const DAY_MS = 86_400_000;
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function toFiniteTotal(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** UTC day index for an ISO YYYY-MM-DD date. UTC avoids DST hour drift; null for junk. */
function dayIndexOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const iso = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
}

function isoDay(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

/** Local "today" as a UTC day index, matching the ISO dates the backend sends. */
function todayDayIndex(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
}

/** "Oct 19" — unambiguous month/day in 10px mono rows. */
function fmtDayLabel(value: unknown): string {
  if (typeof value !== "string" || value.length < 10) return "—";
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return "—";
  }
  return `${MONTH_LABELS[month - 1]} ${day}`;
}

/** rAF count-up from the previously displayed value (never flashes from 0
 *  on refetch), instant when the user prefers reduced motion. */
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

function Skeleton() {
  return (
    <div aria-hidden className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex min-h-[228px] flex-col rounded-[22px] border border-[#E4E1E8] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 motion-reduce:animate-none" />
            <div className="h-7 w-7 animate-pulse rounded-full bg-zinc-100 motion-reduce:animate-none" />
          </div>
          <div className="mt-5 h-11 w-36 animate-pulse rounded bg-zinc-100 motion-reduce:animate-none" />
          <div className="mt-auto border-t border-[#F0EDEF] pt-3">
            <div className="flex min-h-[76px] flex-col justify-between gap-2">
              <div className="h-2.5 w-full animate-pulse rounded bg-zinc-100 motion-reduce:animate-none" />
              <div className="h-3 w-32 animate-pulse rounded bg-zinc-100 motion-reduce:animate-none" />
              <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 motion-reduce:animate-none" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const UNIT_WORD: Record<string, string> = {
  "": "Tokens",
  k: "Thousand",
  M: "Million",
  B: "Billion",
};

/** Footer money: keep sub-cent values visible instead of rounding to $0.00. */
function fmtSpend(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "$0.00";
  return n > 0 && n < 0.01 ? fmtCostPrecise(n) : fmtCost(n);
}

function HeroFigure({
  num,
  fraction,
  unit,
  unitClass,
  badge,
}: {
  num: string;
  fraction?: string;
  unit: string;
  unitClass?: string;
  badge?: React.ReactNode;
}) {
  // Four-digit day totals are the only realistic 4-up overflow; shave the
  // numeral a little rather than letting it run under the card edge.
  const dense = num.length + (fraction?.length ?? 0) >= 10;
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-x-2 gap-y-1.5">
      <span
        className={cn(
          "tnum whitespace-nowrap font-display font-extrabold leading-[0.9] tracking-[-0.05em] text-[#111217] 2xl:text-[48px]",
          dense ? "text-[40px]" : "text-[44px]",
        )}
      >
        {num}
        {fraction ? <span className="text-[0.6em] tracking-[-0.02em]">{fraction}</span> : null}
      </span>
      <span
        className={cn(
          "whitespace-nowrap font-display text-[19px] font-bold leading-none tracking-[-0.02em]",
          unitClass ?? "text-[#414755]",
        )}
      >
        {unit}
      </span>
      {badge}
    </div>
  );
}

function Card({
  index,
  label,
  icon,
  figure,
  children,
  reduceMotion,
}: {
  index: number;
  label: string;
  icon: React.ReactNode;
  figure: React.ReactNode;
  children: React.ReactNode;
  reduceMotion: boolean;
}) {
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-32px" }}
      transition={{ duration: 0.55, delay: reduceMotion ? 0 : index * 0.06, ease: EASE }}
      className="flex min-h-[184px] flex-col justify-between rounded-2xl border border-[#E4E1E8] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_8px_24px_-18px_rgba(16,24,40,0.28)] transition-colors duration-200 hover:border-[#CFCBD8]"
    >
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-ink-2">
            {label}
          </h3>
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#F6F3F5] text-[#414755]"
          >
            {icon}
          </span>
        </div>
        <div className="mt-4">{figure}</div>
      </div>
      {/* Fixed footer band keeps the hairline and the bottom row on one
          baseline across all four cards, regardless of figure wrapping. */}
      <div className="mt-4 border-t border-[#F0EDEF] pt-3">
        <div className="flex min-h-[76px] flex-col justify-between gap-2">{children}</div>
      </div>
    </motion.div>
  );
}

export default function KpiCards({
  snap,
  isFetching,
}: {
  snap?: UsageSnapshotDTO;
  isFetching?: boolean;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  // The selected range lives in the app store; reading it keeps the strip and
  // denominator tied to the filter without changing this component's props.
  const rangeSince = useStore((s) => s.since);
  const rangeUntil = useStore((s) => s.until);
  // All hooks run before the `if (!snap)` return (Rules of Hooks). Targets
  // use double optional-chaining: `snap?.sessions.length` would still throw
  // when snap exists but sessions is undefined.
  const totalCostTarget =
    typeof snap?.total_cost === "number" && Number.isFinite(snap.total_cost)
      ? snap.total_cost
      : 0;
  const totalTokensTarget =
    typeof snap?.total_tokens === "number" && Number.isFinite(snap.total_tokens)
      ? snap.total_tokens
      : 0;
  const sessionsTarget = snap?.sessions?.length ?? 0;
  const messagesTarget =
    typeof snap?.total_messages === "number" && Number.isFinite(snap.total_messages)
      ? snap.total_messages
      : 0;
  const activeDaysTarget = snap?.daily?.filter((d) => (d?.tokens ?? 0) > 0).length ?? 0;
  const animatedCost = useCountUp(totalCostTarget);
  const animatedTokens = useCountUp(totalTokensTarget);
  const animatedSessions = useCountUp(sessionsTarget);
  const animatedMessages = useCountUp(messagesTarget);
  const animatedActiveDays = useCountUp(activeDaysTarget);

  if (!snap) return <Skeleton />;

  // ── Data logic ──
  // Defensive array defaults: a partial backend payload must render zeros,
  // never throw (thrown render errors blank the whole app).
  const daily: DailyDTO[] = Array.isArray(snap.daily) ? snap.daily : [];
  const models = Array.isArray(snap.models) ? snap.models : [];
  const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
  const projects = Array.isArray(snap.projects) ? snap.projects : [];
  const totalCost = toFiniteTotal(snap.total_cost);
  const totalTokens = toFiniteTotal(snap.total_tokens);
  const totalMessages = toFiniteTotal(snap.total_messages);
  const sortedDaily = [...daily].sort((a, b) => (a.date < b.date ? -1 : 1));
  const activeDays = sortedDaily.filter((d) => (d?.tokens ?? 0) > 0).length;
  const avgPerDay = activeDays > 0 ? totalCost / activeDays : 0;
  const peak = sortedDaily.reduce<DailyDTO | null>(
    (best, d) => (!best || (d?.cost ?? 0) > (best?.cost ?? 0) ? d : best),
    null,
  );

  const cacheRead = models.reduce((a, m) => a + (m?.cache_read ?? 0), 0);
  const cacheWrite = models.reduce((a, m) => a + (m?.cache_write ?? 0), 0);
  const plainInput = models.reduce((a, m) => a + (m?.input ?? 0), 0);
  const cacheDenom = cacheRead + plainInput;
  const cacheHit = cacheDenom > 0 ? cacheRead / cacheDenom : 0;

  // Five additive buckets: plain input, output, cache read, cache write,
  // reasoning. Cache is listed separately so nothing is double-counted.
  const totalIn = plainInput;
  const totalOut = models.reduce((a, m) => a + (m?.output ?? 0), 0);
  const totalReasoning = models.reduce((a, m) => a + (m?.reasoning ?? 0), 0);

  const realProjectsCount = projects.filter(
    (p) =>
      !!p?.workspace_key &&
      p.workspace_key !== "(unknown)" &&
      p.workspace_label !== "(unknown)" &&
      ((p?.sessions ?? 0) > 0 || (p?.tokens ?? 0) > 0),
  ).length;
  // Session averages use the session population, not global totals: the
  // backend totals include recovery-floor rows that intentionally have no
  // session entry, so total/session would be inflated.
  const sessionTokens = sessions.reduce((a, s) => a + s.tokens, 0);
  const sessionCost = sessions.reduce((a, s) => a + (s.cost ?? 0), 0);
  const avgTokensPerSession = sessions.length > 0 ? sessionTokens / sessions.length : 0;
  const avgCostPerSession = sessions.length > 0 ? sessionCost / sessions.length : 0;
  const freeSpend = totalCost <= 0 && totalTokens > 0;

  const tok = splitTokens(reduceMotion ? totalTokens : animatedTokens);
  const unitWord = UNIT_WORD[tok.unit] ?? "Tokens";
  const sessionLabel = Math.round(reduceMotion ? sessions.length : animatedSessions).toLocaleString();
  const activeLabel = Math.round(reduceMotion ? activeDays : animatedActiveDays);
  const msgLabel = Math.round(reduceMotion ? totalMessages : animatedMessages).toLocaleString();

  // Hero cost is split so cents can ride smaller. Above $9,999 we round to
  // whole dollars: it keeps the 44px numeral inside a 1280px 4-up card.
  const displayCost = reduceMotion ? totalCost : animatedCost;
  // Sub-cent spend must not collapse to "$0.00" while the client menu says Free.
  const costLabel =
    displayCost > 0 && displayCost < 0.01
      ? fmtCostPrecise(displayCost)
      : fmtCost(displayCost);
  const subCent = displayCost > 0 && displayCost < 0.01;
  const costParts = costLabel.match(/^(.*?)([.,]\d{2})$/);
  const costWholeLabel = costParts ? costParts[1] : costLabel;
  const costCents = costParts ? costParts[2] : "";
  const showCostCents = !subCent && costWholeLabel.length <= 6;
  const costWhole = subCent
    ? costLabel
    : showCostCents
      ? costWholeLabel
      : `$${Math.round(displayCost).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const costFraction = showCostCents ? costCents : "";

  const peakShare = totalCost > 0 && peak ? (peak?.cost ?? 0) / totalCost : 0;
  const peakDay = totalCost > 0 && peak ? fmtDayLabel(peak.date) : "—";

  // Top client by session count — separate, labelled context for the
  // active-days card so the orange strip below can never read as a share bar.
  const perClient = new Map<string, number>();
  for (const s of sessions) perClient.set(s.client, (perClient.get(s.client) ?? 0) + 1);
  const topClientEntry = [...perClient.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];
  const topClientVisual = topClientEntry ? getClientVisual(topClientEntry[0]) : null;
  const topClient =
    topClientEntry && topClientVisual
      ? {
          label: topClientVisual.label || "Unknown",
          hex: topClientVisual.hex,
          sessions: topClientEntry[1],
        }
      : null;

  // `daily` is sparse (one row per recorded day). Build a real calendar grid
  // from the selected range so gaps are empty days, not compressed rows.
  const tokensByDay = new Map<number, number>();
  let earliestDay: number | null = null;
  for (const d of sortedDaily) {
    const day = dayIndexOf(d?.date);
    if (day === null) continue;
    const tokens =
      typeof d?.tokens === "number" && Number.isFinite(d.tokens) ? Math.max(0, d.tokens) : 0;
    tokensByDay.set(day, (tokensByDay.get(day) ?? 0) + tokens);
    earliestDay = earliestDay === null ? day : Math.min(earliestDay, day);
  }

  // The selected range is authoritative for the denominator and the strip;
  // data-derived dates are only the all-time fallback. Future days are not
  // "inactive" yet, so the window never runs past today.
  const today = todayDayIndex();
  const sinceDay = dayIndexOf(rangeSince ?? "");
  const untilDay = dayIndexOf(rangeUntil ?? "");
  const rangeEnd = untilDay !== null ? Math.min(untilDay, today) : today;
  const rangeStartRaw = sinceDay !== null ? sinceDay : earliestDay;
  const rangeStart = rangeStartRaw !== null ? Math.min(rangeStartRaw, rangeEnd) : null;
  const rangeDays = rangeStart !== null ? Math.max(1, rangeEnd - rangeStart + 1) : 0;
  const totalDays = Math.max(rangeDays, activeDays);

  // Last 30 calendar days of that range (fewer when the range is shorter).
  const windowStart = Math.min(
    rangeEnd,
    sinceDay !== null ? Math.max(sinceDay, rangeEnd - 29) : rangeEnd - 29,
  );
  const windowDays = rangeEnd - windowStart + 1;
  const activityDays: Array<{ date: string; tokens: number }> = [];
  for (let i = 0; i < windowDays; i++) {
    const day = windowStart + i;
    const date = isoDay(day);
    activityDays.push({ date, tokens: tokensByDay.get(day) ?? 0 });
  }
  const windowActive = activityDays.reduce(
    (count, day) => (day.tokens > 0 ? count + 1 : count),
    0,
  );
  const windowLabel = windowDays === 1 ? "Last 1 day" : `Last ${windowDays} days`;
  const uptime = totalDays > 0 ? activeDays / totalDays : 0;

  return (
    <section aria-label="Totals">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {/* Tile 1 — Hero spend */}
        <Card
          index={0}
          reduceMotion={reduceMotion}
          label="Total spend"
          icon={<CurrencyDollar size={16} weight="bold" />}
          figure={
            <HeroFigure
              num={costWhole}
              fraction={costFraction}
              unit="USD"
              badge={
                freeSpend ? (
                  <span className="ml-1 text-[13px] font-semibold text-[#006b27]">
                    Free
                  </span>
                ) : isFetching ? (
                  <span
                    role="status"
                    aria-label="Syncing latest data"
                    title="Syncing"
                    className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#0070eb] motion-reduce:animate-none"
                  />
                ) : null
              }
            />
          }
        >
          <div className="tnum flex items-center justify-between gap-2 text-[11px]">
            <span className="text-ink-2">Per active day</span>
            <span className="font-semibold text-ink">
              {freeSpend
                ? "No metered spend"
                : activeDays > 0
                  ? `${fmtSpend(avgPerDay)} / active day`
                  : "no activity yet"}
            </span>
          </div>
          <div
            aria-hidden
            className="h-1.5 w-full overflow-hidden rounded-full bg-[#F0EDEF]"
          >
            <motion.div
              initial={reduceMotion ? false : { scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: EASE }}
              style={{ width: `${Math.min(100, Math.max(0, peakShare * 100))}%` }}
              className="h-full origin-left rounded-full bg-[#059669]"
            />
          </div>
          <div
            className="tnum flex items-center justify-between gap-2 text-[11px]"
            title="Peak day cost and its share of total spend"
          >
            <span className="text-ink-2">
              {peak && (peak?.cost ?? 0) > 0 ? `Peak ${fmtSpend(peak.cost)}` : "No spend peak"}
            </span>
            <span className="font-semibold text-ink">{peakShare > 0 ? `${fmtPct(peakShare)} of spend` : "—"}</span>
          </div>
        </Card>

        {/* Tile 2 — Total tokens */}
        <Card
          index={1}
          reduceMotion={reduceMotion}
          label="Total tokens"
          icon={<Database size={16} weight="bold" />}
          figure={
            <HeroFigure
              num={tok.num}
              unit={unitWord}
            />
          }
        >
          <div className="tnum flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px]">
            <span
              className="inline-flex items-center gap-1.5 font-medium text-ink"
              title="Plain input tokens — cache is listed separately"
            >
              <span className="h-2 w-2 rounded-full bg-[#0070eb]" aria-hidden />
              In {fmtTokens(totalIn)}
            </span>
            <span className="inline-flex items-center gap-1.5 font-medium text-ink">
              <span className="h-2 w-2 rounded-full bg-[#AF52DE]" aria-hidden />
              Out {fmtTokens(totalOut)}
            </span>
          </div>
          <div className="tnum flex flex-wrap items-center justify-between gap-1 text-[11px]">
            <span className="text-ink-2">
              Cache {fmtTokens(cacheRead)} read
            </span>
            <span className="font-semibold text-ink">
              {fmtTokens(cacheWrite)} write · {fmtPct(cacheHit)}
            </span>
          </div>
          <div className="tnum flex items-center justify-between text-[11px]">
            <span className="text-ink-2">Reasoning {fmtTokens(totalReasoning)}</span>
            <span className="font-semibold text-ink">{msgLabel} messages</span>
          </div>
        </Card>

        {/* Tile 3 — Sessions */}
        <Card
          index={2}
          reduceMotion={reduceMotion}
          label="Agent sessions"
          icon={<TerminalWindow size={16} weight="bold" />}
          figure={<HeroFigure num={sessionLabel} unit="Sessions" />}
        >
          <div className="tnum flex items-center justify-between text-[11px]">
            <span className="text-ink-2">Avg / session</span>
            <span className="font-semibold text-ink">
              {fmtTokens(avgTokensPerSession)} tok
            </span>
          </div>
          <div className="tnum flex items-center justify-between text-[11px]">
            <span className="text-ink-2">Avg cost / session</span>
            <span className="font-semibold text-ink">
              {fmtSpend(avgCostPerSession)}
            </span>
          </div>
          <div className="tnum flex items-center justify-between text-[11px]">
            <span className="text-ink-2">Active workspaces</span>
            <span className="font-semibold text-ink">{realProjectsCount}</span>
          </div>
        </Card>

        {/* Tile 4 — Active days */}
        <Card
          index={3}
          reduceMotion={reduceMotion}
          label="Active coding days"
          icon={<Flame size={16} weight="bold" />}
          figure={
            <HeroFigure
              num={`${activeLabel}${totalDays ? ` / ${totalDays}` : ""}`}
              unit="Days Active"
              badge={
                <span
                  className="tnum ml-1 whitespace-nowrap text-[12px] font-semibold text-ink-2"
                  title="Active days / calendar days in the selected range"
                >
                  {totalDays > 0 ? `${fmtPct(uptime)} uptime` : "no data"}
                </span>
              }
            />
          }
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] text-ink-2">
                Top client
              </div>
              <div
                className="tnum mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-ink"
                title={
                  topClient
                    ? `Top client: ${topClient.label} · ${topClient.sessions} sessions`
                    : "No client sessions"
                }
              >
                {topClient ? (
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-black/5"
                    style={{ background: topClient.hex }}
                  />
                ) : null}
                <span className="truncate">{topClient ? topClient.label : "No sessions"}</span>
                {topClient ? (
                  <span className="shrink-0 text-[11px] font-semibold text-ink-2">
                    · {topClient.sessions}
                    <span className="hidden 2xl:inline">
                      {topClient.sessions === 1 ? " session" : " sessions"}
                    </span>
                  </span>
                ) : null}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[11px] text-ink-2">
                Peak spend
              </div>
              <div className="tnum mt-0.5 text-[11px] font-semibold text-ink">
                {peakDay}
              </div>
            </div>
          </div>
          <div>
            <div
              role="img"
              aria-label={`Daily activity, ${windowLabel.toLowerCase()}: ${windowActive} active ${
                windowActive === 1 ? "day" : "days"
              }`}
              className="ml-auto grid h-2.5 items-end gap-[2px]"
              style={{
                width: `min(100%, ${windowDays * 24}px)`,
                gridTemplateColumns: `repeat(${windowDays}, minmax(0, 1fr))`,
              }}
            >
              {activityDays.map((day) => (
                <span
                  key={day.date}
                  title={`${fmtDayLabel(day.date)} · ${
                    day.tokens > 0 ? `${fmtTokens(day.tokens)} tokens` : "no activity"
                  }`}
                  className={cn(
                    "min-w-0 rounded-[2px]",
                    day.tokens > 0 ? "bg-orange-600" : "bg-[#E4E1E8]",
                  )}
                  style={{ height: day.tokens > 0 ? "100%" : "30%" }}
                />
              ))}
            </div>
            <div className="tnum flex items-center justify-between pt-1 text-[11px]">
              <span className="text-ink-2">{windowLabel}</span>
              <span className="font-semibold text-ink">
                {windowActive}/{windowDays} active
              </span>
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}
