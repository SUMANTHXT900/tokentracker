import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CurrencyDollar, Database, Flame, TerminalWindow } from "@phosphor-icons/react";
import type { DailyDTO, UsageSnapshotDTO } from "../lib/tauri";
import { fmtCost, fmtPct, fmtTokens, splitTokens } from "../lib/format";
import { getClientVisual } from "../lib/client-color";
import { cn } from "../lib/cn";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

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
  const animatedCost = useCountUp(snap?.total_cost ?? 0);
  const animatedTokens = useCountUp(snap?.total_tokens ?? 0);
  const animatedSessions = useCountUp(snap?.sessions.length ?? 0);
  const animatedMessages = useCountUp(snap?.total_messages ?? 0);
  const animatedActiveDays = useCountUp(
    snap ? snap.daily.filter((d) => d.tokens > 0).length : 0,
  );

  if (!snap) return <Skeleton />;

  // ── Data logic (verbatim from previous implementation) ──
  const daily: DailyDTO[] = snap.daily;
  const activeDays = daily.filter((d) => d.tokens > 0).length;
  const totalDays = daily.length;
  const avgPerDay = activeDays > 0 ? snap.total_cost / activeDays : 0;
  const peak = daily.reduce<DailyDTO | null>(
    (best, d) => (!best || d.cost > best.cost ? d : best),
    null,
  );

  const cacheRead = snap.models.reduce((a, m) => a + (m.cache_read ?? 0), 0);
  const plainInput = snap.models.reduce((a, m) => a + (m.input ?? 0), 0);
  const cacheDenom = cacheRead + plainInput;
  const cacheHit = cacheDenom > 0 ? cacheRead / cacheDenom : 0;

  const totalIn = snap.models.reduce((a, m) => a + (m.input ?? 0) + (m.cache_read ?? 0), 0);
  const totalOut = snap.models.reduce((a, m) => a + (m.output ?? 0), 0);

  const realProjectsCount = snap.projects.filter(
    (p) =>
      !!p.workspace_key &&
      p.workspace_key !== "(unknown)" &&
      p.workspace_label !== "(unknown)" &&
      (p.sessions > 0 || p.tokens > 0),
  ).length;
  const avgTokensPerSession =
    snap.sessions.length > 0 ? snap.total_tokens / snap.sessions.length : 0;
  const avgCostPerSession =
    snap.sessions.length > 0 ? snap.total_cost / snap.sessions.length : 0;

  const tok = splitTokens(reduceMotion ? snap.total_tokens : animatedTokens);
  const costLabel = fmtCost(reduceMotion ? snap.total_cost : animatedCost);
  const sessionLabel = Math.round(reduceMotion ? snap.sessions.length : animatedSessions).toLocaleString();
  const activeLabel = Math.round(reduceMotion ? activeDays : animatedActiveDays);
  const msgLabel = Math.round(reduceMotion ? snap.total_messages : animatedMessages).toLocaleString();

  const uptime = totalDays > 0 ? activeDays / totalDays : 0;
  const peakShare = snap.total_cost > 0 && peak ? peak.cost / snap.total_cost : 0;
  const visibleClients = snap.clients.slice(0, 4).map((c) => getClientVisual(c));
  const overflowClients = Math.max(0, snap.clients.length - 4);

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
              <span className="font-sans text-[12px] text-[#717786]">USD</span>
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
            {peak && peak.cost > 0 && (
              <span className="tnum text-[#717786]">Peak {fmtCost(peak.cost)}</span>
            )}
          </div>
          <div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#F0EDEF]">
              <motion.div
                initial={reduceMotion ? false : { width: 0 }}
                whileInView={{ width: `${Math.min(100, Math.max(0, peakShare * 100))}%` }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, ease: EASE }}
                className="h-full rounded-full bg-gradient-to-r from-[#0058bc] to-[#007AFF]"
              />
            </div>
            <div className="tnum flex items-center justify-between pt-1 font-mono text-[10px] text-[#717786]">
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
              <span className="font-sans text-[12px] text-[#717786]">aggregated stream</span>
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
            <span className="font-semibold text-[#006b27]">{fmtPct(cacheHit)} cached</span>
          </div>
          <p className="tnum font-mono text-[10px] text-[#717786]">{msgLabel} messages</p>
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
              <span className="font-sans text-[12px] text-[#717786]">invocations</span>
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
          <p className="tnum font-mono text-[10px] text-[#717786]">
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
              <span className="font-sans text-[12px] text-[#717786]">{fmtPct(uptime)} uptime</span>
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
            {peak && (
              <span className="tnum text-[#717786]">
                Peak:{" "}
                {(() => {
                  const parts = peak.date.split("-");
                  return `${parts[1]}/${parts[2]}`;
                })()}
              </span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#F0EDEF]">
            <motion.div
              initial={reduceMotion ? false : { width: 0 }}
              whileInView={{ width: `${Math.min(100, Math.max(0, uptime * 100))}%` }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: EASE }}
              className="h-full rounded-full bg-orange-500"
            />
          </div>
        </Card>
      </div>
    </section>
  );
}
