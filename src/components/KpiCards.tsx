import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CurrencyDollar, Database, Flame, TerminalWindow } from "@phosphor-icons/react";
import type { DailyDTO, UsageSnapshotDTO } from "../lib/tauri";
import { fmtCost, fmtPct, fmtTokens, splitTokens } from "../lib/format";
import { getClientVisual } from "../lib/client-color";
import { cn } from "../lib/cn";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

function toFiniteTotal(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
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
    <div
      aria-hidden
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-2xl border border-[#E4E1E8] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]"
        >
          <div className="h-3 w-24 animate-pulse rounded bg-zinc-100" />
          <div className="mt-3 h-8 w-28 animate-pulse rounded bg-zinc-100" />
          <div className="mt-3 h-3 w-32 animate-pulse rounded bg-zinc-100" />
        </div>
      ))}
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
      transition={{ duration: 0.55, delay: reduceMotion ? 0 : index * 0.07, ease: EASE }}
      className="flex flex-col justify-between rounded-2xl border border-[#E4E1E8] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)] transition-colors duration-200 hover:border-[#C9C4D6] focus-within:border-[#0058bc]"
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-sans text-[12px] font-medium text-[#414755]">{label}</span>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#0058bc]/10 text-[#0058bc]">
            {icon}
          </span>
        </div>
        <div className="flex items-baseline gap-2 pt-1">{figure}</div>
      </div>
      <div className="mt-3 space-y-2 border-t border-[#F0EDEF] pt-3">{children}</div>
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

  // ── Data logic (verbatim from previous implementation) ──
  // Defensive array defaults: a partial backend payload must render zeros,
  // never throw (thrown render errors blank the whole app).
  const daily: DailyDTO[] = Array.isArray(snap.daily) ? snap.daily : [];
  const models = Array.isArray(snap.models) ? snap.models : [];
  const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
  const projects = Array.isArray(snap.projects) ? snap.projects : [];
  const clients: string[] = Array.isArray(snap.clients) ? snap.clients : [];
  const totalCost = toFiniteTotal(snap.total_cost);
  const totalTokens = toFiniteTotal(snap.total_tokens);
  const totalMessages = toFiniteTotal(snap.total_messages);
  const activeDays = daily.filter((d) => (d?.tokens ?? 0) > 0).length;
  const totalDays = daily.length;
  const avgPerDay = activeDays > 0 ? totalCost / activeDays : 0;
  const peak = daily.reduce<DailyDTO | null>(
    (best, d) => (!best || (d?.cost ?? 0) > (best?.cost ?? 0) ? d : best),
    null,
  );

  const cacheRead = models.reduce((a, m) => a + (m?.cache_read ?? 0), 0);
  const plainInput = models.reduce((a, m) => a + (m?.input ?? 0), 0);
  const cacheDenom = cacheRead + plainInput;
  const cacheHit = cacheDenom > 0 ? cacheRead / cacheDenom : 0;

  const totalIn = models.reduce((a, m) => a + (m?.input ?? 0) + (m?.cache_read ?? 0), 0);
  const totalOut = models.reduce((a, m) => a + (m?.output ?? 0), 0);

  const realProjectsCount = projects.filter(
    (p) =>
      !!p?.workspace_key &&
      p.workspace_key !== "(unknown)" &&
      p.workspace_label !== "(unknown)" &&
      ((p?.sessions ?? 0) > 0 || (p?.tokens ?? 0) > 0),
  ).length;
  const avgTokensPerSession =
    sessions.length > 0 ? totalTokens / sessions.length : 0;
  const avgCostPerSession =
    sessions.length > 0 ? totalCost / sessions.length : 0;

  const tok = splitTokens(reduceMotion ? totalTokens : animatedTokens);
  const costLabel = fmtCost(reduceMotion ? totalCost : animatedCost);
  const sessionLabel = Math.round(reduceMotion ? sessions.length : animatedSessions).toLocaleString();
  const activeLabel = Math.round(reduceMotion ? activeDays : animatedActiveDays);
  const msgLabel = Math.round(reduceMotion ? totalMessages : animatedMessages).toLocaleString();

  const uptime = totalDays > 0 ? activeDays / totalDays : 0;
  const peakShare = totalCost > 0 && peak ? (peak?.cost ?? 0) / totalCost : 0;
  const visibleClients = clients.slice(0, 4).map((c) => getClientVisual(c));
  const overflowClients = Math.max(0, clients.length - 4);

  return (
    <section aria-label="Totals">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Tile 1 — Hero spend */}
        <Card
          index={0}
          reduceMotion={reduceMotion}
          label="Total Spend (Past 30 Days)"
          icon={<CurrencyDollar size={17} aria-hidden />}
          figure={
            <>
              <span className="tnum font-mono text-[28px] font-semibold leading-[34px] tracking-[-0.02em] text-[#1b1b1d]">
                {costLabel}
              </span>
              <span className="font-sans text-[12px] text-ink-3">USD</span>
              {isFetching && (
                <span
                  title="Syncing"
                  className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#0070eb]"
                />
              )}
            </>
          }
        >
          <div className="flex items-center justify-between font-sans text-[11px]">
            <span className="tnum rounded-full bg-[#34C759]/[0.12] px-2 py-0.5 font-semibold text-[#006b27]">
              {activeDays > 0 ? `${fmtCost(avgPerDay)} / active day` : "no activity yet"}
            </span>
            {peak && (peak?.cost ?? 0) > 0 && (
              <span className="tnum text-ink-3">Peak {fmtCost(peak.cost)}</span>
            )}
          </div>
          <div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#F0EDEF]">
              <motion.div
                initial={reduceMotion ? false : { scaleX: 0 }}
                whileInView={{ scaleX: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, ease: EASE }}
                style={{ width: `${Math.min(100, Math.max(0, peakShare * 100))}%` }}
                className="h-full origin-left rounded-full bg-gradient-to-r from-[#0058bc] to-[#007AFF]"
              />
            </div>
            <div className="tnum flex items-center justify-between pt-1 font-mono text-[10px] text-ink-3">
              <span>{fmtPct(peakShare)} peak-day share</span>
              <span>{totalDays > 0 ? `${activeDays}/${totalDays} days` : "—"}</span>
            </div>
          </div>
        </Card>

        {/* Tile 2 — Total tokens */}
        <Card
          index={1}
          reduceMotion={reduceMotion}
          label="Total Tokens"
          icon={<Database size={17} aria-hidden />}
          figure={
            <>
              <span className="tnum font-mono text-[28px] font-semibold leading-[34px] tracking-[-0.02em] text-[#1b1b1d]">
                {tok.num}
                {tok.unit}
              </span>
              <span className="font-sans text-[12px] text-ink-3">aggregated stream</span>
            </>
          }
        >
          <div className="tnum flex items-center justify-between font-mono text-[11px] text-[#414755]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#0070eb]" aria-hidden />
              In: {fmtTokens(totalIn)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#AF52DE]" aria-hidden />
              Out: {fmtTokens(totalOut)}
            </span>
          </div>
          <div className="tnum flex items-center justify-between rounded-md bg-[#F6F3F5] px-2 py-1 font-mono text-[11px]">
            <span className="font-sans text-[#414755]">Cache Hit Rate</span>
            <span className="font-semibold text-[#006b27]">{fmtTokens(cacheRead)} cached · {fmtPct(cacheHit)} hit</span>
          </div>
          <p className="tnum font-mono text-[10px] text-ink-3">{msgLabel} messages</p>
        </Card>

        {/* Tile 3 — Sessions */}
        <Card
          index={2}
          reduceMotion={reduceMotion}
          label="Agent Sessions"
          icon={<TerminalWindow size={17} aria-hidden />}
          figure={
            <>
              <span className="tnum font-mono text-[28px] font-semibold leading-[34px] tracking-[-0.02em] text-[#1b1b1d]">
                {sessionLabel}
              </span>
              <span className="font-sans text-[12px] text-ink-3">invocations</span>
            </>
          }
        >
          <div className="flex items-center justify-between font-sans text-[11px]">
            <span className="text-[#414755]">Avg / Session</span>
            <span className="tnum font-mono text-[12px] font-semibold text-[#1b1b1d]">
              {fmtTokens(avgTokensPerSession)} tokens
            </span>
          </div>
          <div className="flex items-center justify-between font-sans text-[11px]">
            <span className="text-[#414755]">Avg Cost / Turn</span>
            <span className="tnum font-mono text-[12px] font-semibold text-[#1b1b1d]">
              {fmtCost(avgCostPerSession)} USD
            </span>
          </div>
          <p className="tnum font-mono text-[10px] text-ink-3">
            {realProjectsCount} active workspace{realProjectsCount === 1 ? "" : "s"}
          </p>
        </Card>

        {/* Tile 4 — Active days */}
        <Card
          index={3}
          reduceMotion={reduceMotion}
          label="Active Coding Days"
          icon={<Flame size={17} aria-hidden />}
          figure={
            <>
              <span className="tnum font-mono text-[28px] font-semibold leading-[34px] tracking-[-0.02em] text-[#1b1b1d]">
                {activeLabel} / {totalDays || "—"}
              </span>
              <span className="font-sans text-[12px] text-ink-3">{fmtPct(uptime)} uptime</span>
            </>
          }
        >
          <div className="flex items-center justify-between font-sans text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-2 py-0.5 font-semibold text-orange-700">
              <Flame size={12} aria-hidden />
              {visibleClients.length > 0
                ? `${visibleClients[0].label}${overflowClients > 0 ? ` +${overflowClients}` : ""}`
                : "no clients"}
            </span>
            {peak && peak?.date && (
              <span className="tnum text-ink-3">
                Peak:{" "}
                {(() => {
                  if (typeof peak.date !== "string") return "—";
                  const parts = peak.date.split("-");
                  if (parts.length < 3 || !parts[1] || !parts[2]) return peak.date;
                  return `${parts[1]}/${parts[2]}`;
                })()}
              </span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#F0EDEF]">
            <motion.div
              initial={reduceMotion ? false : { scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: EASE }}
              style={{ width: `${Math.min(100, Math.max(0, uptime * 100))}%` }}
              className="h-full origin-left rounded-full bg-orange-500"
            />
          </div>
        </Card>
      </div>
    </section>
  );
}
