/**
 * Usage — period-scoped deep dive.
 *
 * One question, answered with the same snapshot the rest of the app already
 * fetches: *what did this stretch of time actually cost?* The period is the
 * protagonist — a Day / Week / Month segmented control (defaulting to today)
 * re-scopes two `useSnapshot` queries, current period and the equal-length
 * period immediately before it, so every figure carries an honest comparison.
 *
 * No backend commands: all aggregation happens here over the filtered
 * `UsageSnapshotDTO` rows (models, sessions, totals). Global client scope from
 * the ribbon applies on top of the local period.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import {
  ArrowsDownUp,
  CaretDown,
  CaretRight,
  CaretUp,
  ChartLine,
  Chats,
  ClockCounterClockwise,
  Cube,
  CurrencyDollar,
  Database,
  Funnel,
  MagnifyingGlass,
  Pulse,
  TerminalWindow,
  TrendDown,
  TrendUp,
  X,
} from "@phosphor-icons/react";
import {
  useSnapshot,
  type ModelRowDTO,
  type SessionRowDTO,
  type UsageSnapshotDTO,
} from "../lib/tauri";
import { useStore } from "../store";
import { cn } from "../lib/cn";
import { getClientVisual } from "../lib/client-color";
import {
  fmtCost,
  fmtCostPrecise,
  fmtPct,
  fmtTokens,
  splitTokens,
} from "../lib/format";

/* ── shared machined-control physics (parity with the rest of the app) ───── */
const EASE =
  "transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";
const PRESS = "active:scale-[0.97]";
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const INPUT =
  "h-9 rounded-lg border border-hairline bg-card py-1.5 pl-9 pr-8 text-[13px] text-ink shadow-[0_1px_2px_rgba(16,24,40,0.03)] placeholder:text-ink-3 hover:border-ink-3/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 motion-reduce:transition-none";
const PLATE =
  "rounded-2xl border border-hairline bg-card p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)]";
const PLATE_INNER =
  "rounded-[1.25rem] border border-hairline/70 bg-card";

/* ── period model ───────────────────────────────────────────────────────── */

type PeriodId = "today" | "week" | "month";

const DAY_MS = 86_400_000;

const PERIODS: { id: PeriodId; label: string; days: number; compare: string }[] = [
  { id: "today", label: "Today", days: 1, compare: "yesterday" },
  { id: "week", label: "Week", days: 7, compare: "the prior 7 days" },
  { id: "month", label: "Month", days: 30, compare: "the prior 30 days" },
];

/** Local-timezone YYYY-MM-DD — same helper pattern as App.tsx. */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Midnight-anchored local day. */
function dayStart(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function periodSpec(period: PeriodId) {
  return PERIODS.find((p) => p.id === period) ?? PERIODS[0];
}

interface PeriodRange {
  since: string;
  until: string;
  prevSince: string;
  prevUntil: string;
  days: number;
}

/** Current window + the immediately preceding equal-length window. */
function rangeFor(period: PeriodId, now = new Date()): PeriodRange {
  const { days } = periodSpec(period);
  const end = dayStart(now);
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const prevEnd = new Date(start.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * DAY_MS);
  return {
    since: ymd(start),
    until: ymd(end),
    prevSince: ymd(prevStart),
    prevUntil: ymd(prevEnd),
    days,
  };
}

function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 18, 2026" for a day, "Oct 12 – Oct 18, 2026" for a span. */
function prettyRange(since: string, until: string): string {
  const a = parseYmd(since);
  const b = parseYmd(until);
  if (!a || !b) return `${since} → ${until}`;
  const day: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const full: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  if (a.getTime() === b.getTime()) return a.toLocaleDateString(undefined, full);
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const left = a.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : day);
  return `${left} – ${b.toLocaleDateString(undefined, full)}`;
}

/* ── period-over-period comparison ──────────────────────────────────────── */

type DeltaDir = "up" | "down" | "flat";

interface Delta {
  dir: DeltaDir;
  /** Signed magnitude text, e.g. "+12.4%" / "−3.1%" / "new activity". */
  label: string;
}

function computeDelta(current: number, previous: number): Delta {
  if (previous <= 0) {
    return current > 0
      ? { dir: "up", label: "new activity" }
      : { dir: "flat", label: "no change" };
  }
  const pct = (current - previous) / previous;
  if (Math.abs(pct) < 0.005) return { dir: "flat", label: "0.0%" };
  return {
    dir: pct > 0 ? "up" : "down",
    label: `${pct > 0 ? "+" : "−"}${fmtPct(Math.abs(pct))}`,
  };
}

function DeltaValue({ delta }: { delta: Delta }) {
  const Icon = delta.dir === "up" ? TrendUp : delta.dir === "down" ? TrendDown : null;
  return (
    <span className="tnum inline-flex items-baseline gap-1 font-mono font-semibold text-ink">
      {Icon && (
        <Icon
          size={12}
          weight="bold"
          aria-hidden="true"
          className={cn(
            "relative top-px shrink-0",
            delta.dir === "up" ? "text-emerald-600" : "text-red-500",
          )}
        />
      )}
      {delta.label}
    </span>
  );
}

/* ── animated count-up (rAF, instant under reduced motion) ─────────────── */

function useCountUp(target: number, duration = 900): number {
  const reduceMotion = useReducedMotion();
  const fromRef = useRef(0);
  const [value, setValue] = useState(() => (reduceMotion ? target : 0));

  useEffect(() => {
    if (reduceMotion) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const from = fromRef.current;
    fromRef.current = target;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduceMotion]);

  return value;
}

/* ── small building blocks ─────────────────────────────────────────────── */

/** Outer white instrument plate with a nested hairline card interior. */
function Plate({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(PLATE, className)}>
      <div className={PLATE_INNER}>{children}</div>
    </div>
  );
}

function PanelHead({
  eyebrow,
  title,
  detail,
  icon,
  right,
}: {
  eyebrow: string;
  title: string;
  detail?: string;
  icon: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/[0.08] text-primary"
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3">{eyebrow}</p>
          <h3 className="truncate text-[14px] font-semibold tracking-tight text-ink">{title}</h3>
          {detail && <p className="mt-0.5 truncate text-[12px] text-ink-2">{detail}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-9 w-full rounded-xl" />
      ))}
    </div>
  );
}

function EmptyNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-1 px-6 py-10 text-center">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="max-w-sm text-[12px] leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

/* ── sortable header cell (aria-sort + keyboard-reachable button) ──────── */

function SortTh({
  label,
  k,
  activeKey,
  dir,
  onSort,
  align = "right",
  className,
}: {
  label: string;
  k: string;
  activeKey: string;
  dir: "asc" | "desc";
  onSort: (k: string) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = activeKey === k;
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "whitespace-nowrap px-3 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em]",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        title={`Sort by ${label}`}
        aria-label={`Sort by ${label}, ${
          active ? (dir === "asc" ? "ascending" : "descending") : "not sorted"
        }`}
        className={cn(
          "group/sort inline-flex items-center gap-1 rounded-md",
          EASE,
          PRESS,
          FOCUS,
          active ? "text-ink" : "text-ink-3 hover:text-ink",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
          {active ? (
            dir === "asc" ? (
              <CaretUp size={12} weight="bold" className="text-primary" aria-hidden="true" />
            ) : (
              <CaretDown size={12} weight="bold" className="text-primary" aria-hidden="true" />
            )
          ) : (
            <span className="text-ink-3 opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100 motion-reduce:transition-none">
              <ArrowsDownUp size={11} aria-hidden="true" />
            </span>
          )}
        </span>
      </button>
    </th>
  );
}

/* ── per-model breakdown ───────────────────────────────────────────────── */

type ModelSortKey = "model" | "messages" | "tokens" | "cost" | "share";

function modelDir(key: ModelSortKey): "asc" | "desc" {
  return key === "model" ? "asc" : "desc";
}

function ModelBreakdown({
  models,
  loading,
}: {
  models: ModelRowDTO[] | undefined;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: ModelSortKey; dir: "asc" | "desc" }>({
    key: "tokens",
    dir: "desc",
  });

  const list = useMemo(() => models ?? [], [models]);
  const total = useMemo(() => list.reduce((a, m) => a + m.tokens, 0), [list]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter((m) =>
          [m.model, m.provider, m.client].join(" ").toLowerCase().includes(q),
        )
      : list;
    const mult = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case "model":
          return a.model.localeCompare(b.model) * mult;
        case "messages":
          return (a.messages - b.messages) * mult;
        case "cost":
          return (a.cost - b.cost) * mult;
        case "share":
        case "tokens":
        default:
          return (a.tokens - b.tokens) * mult;
      }
    });
  }, [list, query, sort]);

  const onSort = (k: string) =>
    setSort((s) =>
      s.key === k
        ? { key: s.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: k as ModelSortKey, dir: modelDir(k as ModelSortKey) },
    );

  return (
    <Plate className="min-w-0">
      <PanelHead
        eyebrow="Breakdown"
        title="Per-model usage"
        detail={
          list.length > 0
            ? `${rows.length} of ${list.length} model rows in this period`
            : "Model rows for the selected period"
        }
        icon={<Cube size={16} />}
        right={
          <div className="relative w-full min-w-0 sm:w-64" role="search">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              aria-hidden="true"
            />
            <input
              id="usage-model-filter"
              name="usage-model-filter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter model, provider, client…"
              aria-label="Filter models in this period"
              className={cn(INPUT, "w-full")}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="Clear filter"
                aria-label="Clear model filter"
                className={cn(
                  "absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-3 hover:bg-tray-deep hover:text-ink",
                  EASE,
                  PRESS,
                  FOCUS,
                )}
              >
                <X size={12} weight="bold" />
              </button>
            )}
          </div>
        }
      />

      {loading ? (
        <PanelSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyNote
          title={query ? "No models match this filter" : "No model activity in this period"}
          body={
            query
              ? "Clear the filter or try a shorter model or provider fragment."
              : "Nothing was recorded in this window. Switch the period or run a session, then rescan."
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <p className="sr-only" role="status" aria-live="polite">
            {rows.length} models shown, sorted by {sort.key} {sort.dir === "asc" ? "ascending" : "descending"}
          </p>
          <table className="w-full min-w-[660px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-hairline bg-tray text-ink-2">
                <th
                  scope="col"
                  className="w-10 px-3 py-2.5 pl-4 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3"
                >
                  #
                </th>
                <SortTh label="Model" k="model" activeKey={sort.key} dir={sort.dir} onSort={onSort} align="left" />
                <th
                  scope="col"
                  className="whitespace-nowrap px-3 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3"
                >
                  Client
                </th>
                <SortTh label="Messages" k="messages" activeKey={sort.key} dir={sort.dir} onSort={onSort} />
                <SortTh label="Tokens" k="tokens" activeKey={sort.key} dir={sort.dir} onSort={onSort} />
                <SortTh label="Share" k="share" activeKey={sort.key} dir={sort.dir} onSort={onSort} />
                <SortTh label="Cost" k="cost" activeKey={sort.key} dir={sort.dir} onSort={onSort} className="pr-4" />
              </tr>
            </thead>
            <tbody className="tnum divide-y divide-hairline/70">
              {rows.map((m, i) => {
                const v = getClientVisual(m.client);
                const share = total > 0 ? m.tokens / total : 0;
                return (
                  <tr
                    key={`${m.client}-${m.model}-${m.provider}-${i}`}
                    className="align-middle transition-colors hover:bg-tray/60 motion-reduce:transition-none"
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 pl-4 font-mono text-[11px] text-ink-3">
                      {String(i + 1).padStart(2, "0")}
                    </td>
                    <td className="max-w-[200px] px-3 py-2.5">
                      <p className="truncate font-mono text-[12px] text-ink" title={m.model}>
                        {m.model}
                      </p>
                      <p className="truncate font-mono text-[11px] text-ink-3" title={m.provider}>
                        {m.provider}
                      </p>
                    </td>
                    <td className="max-w-[130px] px-3 py-2.5">
                      <span
                        className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate rounded-full border border-hairline bg-tray px-2 py-0.5 text-[11px] font-medium text-ink-2"
                        title={v.label}
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: v.hex }}
                          aria-hidden="true"
                        />
                        <span className="truncate">{v.label}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[12px] text-ink-2">
                      {m.messages.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[12px] font-semibold text-ink">
                      {fmtTokens(m.tokens)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex min-w-0 items-center justify-end gap-2">
                        <span
                          className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-tray-deep"
                          role="img"
                          aria-label={`Share ${fmtPct(share)} of period tokens`}
                          title={`Share ${fmtPct(share)}`}
                        >
                          <span
                            className="block h-full w-full origin-left rounded-full bg-primary transition-transform motion-reduce:transition-none"
                            style={{ transform: `scaleX(${m.tokens > 0 ? Math.max(share, 0.02) : 0})` }}
                          />
                        </span>
                        <span className="w-11 shrink-0 whitespace-nowrap text-right font-mono text-[11px] text-ink-2">
                          {fmtPct(share)}
                        </span>
                      </div>
                    </td>
                    <td
                      className="whitespace-nowrap px-3 py-2.5 pr-4 text-right font-mono text-[12px] font-medium text-ink"
                      title={`Exact: ${fmtCostPrecise(m.cost)}`}
                    >
                      {fmtCostPrecise(m.cost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Plate>
  );
}

/* ── per-client split ─────────────────────────────────────────────────── */

interface ClientSplitRow {
  client: string;
  tokens: number;
  cost: number;
  messages: number;
  sessions: number;
}

function ClientSplit({
  snap,
  loading,
}: {
  snap: UsageSnapshotDTO | undefined;
  loading: boolean;
}) {
  const rows = useMemo<ClientSplitRow[]>(() => {
    const models = snap?.models ?? [];
    const sessions = snap?.sessions ?? [];
    const map = new Map<string, ClientSplitRow>();
    const get = (client: string) => {
      let r = map.get(client);
      if (!r) {
        r = { client, tokens: 0, cost: 0, messages: 0, sessions: 0 };
        map.set(client, r);
      }
      return r;
    };
    if (models.length > 0) {
      for (const m of models) {
        const r = get(m.client);
        r.tokens += m.tokens;
        r.cost += m.cost;
        r.messages += m.messages;
      }
    } else {
      for (const s of sessions) {
        const r = get(s.client);
        r.tokens += s.tokens;
        r.cost += s.cost;
        r.messages += s.messages;
      }
    }
    for (const s of sessions) get(s.client).sessions += 1;
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }, [snap]);

  const total = rows.reduce((a, r) => a + r.tokens, 0);

  return (
    <Plate className="min-w-0">
      <PanelHead
        eyebrow="Split"
        title="By client"
        detail={rows.length > 0 ? `${rows.length} client${rows.length === 1 ? "" : "s"} active` : "Token share per agent client"}
        icon={<ChartLine size={16} />}
      />
      {loading ? (
        <PanelSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <EmptyNote
          title="No clients in this period"
          body="Client shares appear once a session lands in the window."
        />
      ) : (
        <ul className="divide-y divide-hairline/70">
          {rows.map((r) => {
            const v = getClientVisual(r.client);
            const share = total > 0 ? r.tokens / total : 0;
            return (
              <li key={r.client} className="px-4 py-3 sm:px-5">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: v.hex }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-[13px] font-medium text-ink" title={v.label}>
                      {v.label}
                    </span>
                  </span>
                  <span className="tnum shrink-0 font-mono text-[12px] font-semibold text-ink">
                    {fmtTokens(r.tokens)}
                  </span>
                </div>
                <div
                  className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-tray-deep"
                  role="img"
                  aria-label={`${v.label} holds ${fmtPct(share)} of period tokens`}
                  title={`${fmtPct(share)} share`}
                >
                  <span
                    className="block h-full w-full origin-left rounded-full transition-transform motion-reduce:transition-none"
                    style={{
                      backgroundColor: v.hex,
                      transform: `scaleX(${r.tokens > 0 ? Math.max(share, 0.02) : 0})`,
                    }}
                  />
                </div>
                <p className="tnum mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-3">
                  <span>{fmtPct(share)} of tokens</span>
                  <span>{r.sessions.toLocaleString()} session{r.sessions === 1 ? "" : "s"}</span>
                  <span>{fmtCostPrecise(r.cost)}</span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Plate>
  );
}

/* ── top sessions for the period ──────────────────────────────────────── */

type SessionSortKey = "tokens" | "cost" | "messages";

function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 18)}…` : id;
}

function TopSessions({
  sessions,
  loading,
}: {
  sessions: SessionRowDTO[] | undefined;
  loading: boolean;
}) {
  const setPage = useStore((s) => s.setPage);
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [sort, setSort] = useState<{ key: SessionSortKey; dir: "asc" | "desc" }>({
    key: "tokens",
    dir: "desc",
  });

  const list = useMemo(() => sessions ?? [], [sessions]);

  const clientCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of list) m.set(s.client, (m.get(s.client) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);

  const onSort = (k: string) =>
    setSort((s) =>
      s.key === k
        ? { ...s, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: k as SessionSortKey, dir: "desc" },
    );

  const rows = useMemo(() => {
    const filtered =
      clientFilter === "all" ? list : list.filter((s) => s.client === clientFilter);
    const mult = sort.dir === "asc" ? 1 : -1;
    return [...filtered]
      .sort((a, b) =>
        sort.key === "cost"
          ? (a.cost - b.cost) * mult
          : sort.key === "messages"
            ? (a.messages - b.messages) * mult
            : (a.tokens - b.tokens) * mult,
      )
      .slice(0, 8);
  }, [list, clientFilter, sort]);

  return (
    <Plate>
      <PanelHead
        eyebrow="Sessions"
        title="Top sessions in this period"
        detail={
          list.length > 0
            ? `Ranked by ${sort.key} · showing ${rows.length} of ${list.length}`
            : "The heaviest conversation streams in the window"
        }
        icon={<Pulse size={16} />}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPage("sessions")}
              className={cn(
                "group inline-flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-card px-3 py-1 text-[11px] font-medium text-ink-2 hover:border-primary/30 hover:text-primary",
                EASE,
                PRESS,
                FOCUS,
              )}
            >
              Open Sessions
              <CaretRight
                size={11}
                weight="bold"
                aria-hidden="true"
                className="transition-transform motion-reduce:transition-none group-hover:translate-x-0.5"
              />
            </button>
          </div>
        }
      />

      {loading ? (
        <PanelSkeleton rows={4} />
      ) : list.length === 0 ? (
        <EmptyNote
          title="No sessions in this period"
          body="Pick a wider period, or run something and rescan — streams are ranked here by size."
        />
      ) : (
        <>
          <div
            className="flex flex-wrap items-center gap-1.5 border-b border-hairline px-4 py-2.5 sm:px-5"
            role="group"
            aria-label="Filter sessions by client"
          >
            <span className="mr-0.5 inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
              <Funnel size={11} aria-hidden="true" /> Client
            </span>
            <button
              type="button"
              onClick={() => setClientFilter("all")}
              aria-pressed={clientFilter === "all"}
              className={cn(
                "whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px]",
                EASE,
                PRESS,
                FOCUS,
                clientFilter === "all"
                  ? "border-primary/25 bg-primary/[0.08] font-medium text-primary"
                  : "border-transparent text-ink-2 hover:bg-tray hover:text-ink",
              )}
            >
              All
            </button>
            {clientCounts.map(([c, n]) => {
              const v = getClientVisual(c);
              const on = clientFilter === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setClientFilter(on ? "all" : c)}
                  aria-pressed={on}
                  title={`${v.label} · ${n} session${n === 1 ? "" : "s"}`}
                  style={on ? { borderColor: `${v.hex}66`, backgroundColor: `${v.hex}14` } : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px]",
                    EASE,
                    PRESS,
                    FOCUS,
                    on
                      ? "font-medium text-ink"
                      : "border-transparent text-ink-2 hover:bg-tray hover:text-ink",
                  )}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: v.hex }} aria-hidden="true" />
                  {v.label}
                  <span className="tnum font-mono text-[10px] text-ink-3">{n}</span>
                </button>
              );
            })}
          </div>

          {rows.length === 0 ? (
            <EmptyNote
              title="No sessions for this client"
              body="This client recorded nothing in the window. Pick another client or widen the period."
            />
          ) : (
            <div className="overflow-x-auto">
              <p className="sr-only" role="status" aria-live="polite">
                {rows.length} sessions listed, ranked by {sort.key}
              </p>
              <table className="w-full min-w-[420px] table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-hairline bg-tray text-ink-2">
                    <th
                      scope="col"
                      className="w-10 px-3 py-2.5 pl-4 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3"
                    >
                      #
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3"
                    >
                      Session
                    </th>
                    <SortTh label="Msgs" k="messages" activeKey={sort.key} dir={sort.dir} onSort={onSort} className="w-[68px]" />
                    <SortTh label="Tokens" k="tokens" activeKey={sort.key} dir={sort.dir} onSort={onSort} className="w-[86px]" />
                    <SortTh label="Cost" k="cost" activeKey={sort.key} dir={sort.dir} onSort={onSort} className="w-[84px] pr-4" />
                  </tr>
                </thead>
                <tbody className="tnum divide-y divide-hairline/70">
                  {rows.map((s, i) => {
                    const v = getClientVisual(s.client);
                    const title = s.session_title?.trim();
                    return (
                      <tr
                        key={`${s.client}:${s.session_id}`}
                        className="transition-colors hover:bg-tray/60 motion-reduce:transition-none"
                      >
                        <td className="px-3 py-2.5 pl-4 font-mono text-[11px] text-ink-3">
                          {String(i + 1).padStart(2, "0")}
                        </td>
                        <td className="max-w-[320px] px-3 py-2.5">
                          <button
                            type="button"
                            onClick={() => setPage("sessions")}
                            title="Open the Sessions ledger"
                            aria-label={`Open the Sessions page — ${title ?? s.session_id}`}
                            className="group block max-w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          >
                            <span
                              className={cn(
                                "block truncate text-[13px] group-hover:text-primary motion-reduce:transition-none",
                                title ? "font-semibold text-ink" : "font-mono text-ink-2",
                              )}
                              title={title ?? s.session_id}
                            >
                              {title ?? shortId(s.session_id)}
                            </span>
                            <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                              <span
                                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-tray px-1.5 py-0.5 text-[10px] font-medium text-ink-2"
                                title={v.label}
                              >
                                <span
                                  className="h-1.5 w-1.5 rounded-full"
                                  style={{ backgroundColor: v.hex }}
                                  aria-hidden="true"
                                />
                                {v.label}
                              </span>
                              <span
                                className="min-w-0 truncate font-mono text-[11px] text-ink-3"
                                title={s.model}
                              >
                                {s.model}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[12px] text-ink-2">
                          {s.messages.toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[12px] font-semibold text-ink">
                          {fmtTokens(s.tokens)}
                        </td>
                        <td
                          className="whitespace-nowrap px-3 py-2.5 pr-4 text-right font-mono text-[12px] font-medium text-ink"
                          title={`Exact: ${fmtCostPrecise(s.cost)}`}
                        >
                          {fmtCostPrecise(s.cost)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Plate>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function UsageDetail({ clients }: { clients: string[] }) {
  const [period, setPeriod] = useState<PeriodId>("today");
  const range = useMemo(() => rangeFor(period), [period]);

  const current = useSnapshot({ clients, since: range.since, until: range.until });
  const previous = useSnapshot({
    clients,
    since: range.prevSince,
    until: range.prevUntil,
  });

  const snap = current.data;
  const prev = previous.data;
  const loading = current.isPending && !snap;

  const tokens = snap?.total_tokens ?? 0;
  const cost = snap?.total_cost ?? 0;
  const messages = snap?.total_messages ?? 0;
  const modelsCount = snap?.models.length ?? 0;
  const sessionsCount = snap?.sessions.length ?? 0;

  const aTokens = useCountUp(tokens);
  const aCost = useCountUp(cost);
  const aMessages = useCountUp(messages);
  const aModels = useCountUp(modelsCount);
  const aSessions = useCountUp(sessionsCount);

  const spec = periodSpec(period);
  const rangeLabel = prettyRange(range.since, range.until);
  const prevRangeLabel = prettyRange(range.prevSince, range.prevUntil);

  const topModel = useMemo(
    () => [...(snap?.models ?? [])].sort((a, b) => b.tokens - a.tokens)[0],
    [snap],
  );

  const avgTokens = sessionsCount > 0 ? tokens / sessionsCount : 0;
  const avgMessages = sessionsCount > 0 ? messages / sessionsCount : 0;

  const deltas: { label: string; delta: Delta }[] = [
    { label: "tokens", delta: computeDelta(tokens, prev?.total_tokens ?? 0) },
    { label: "cost", delta: computeDelta(cost, prev?.total_cost ?? 0) },
    { label: "messages", delta: computeDelta(messages, prev?.total_messages ?? 0) },
    { label: "sessions", delta: computeDelta(sessionsCount, prev?.sessions.length ?? 0) },
    { label: "models", delta: computeDelta(modelsCount, prev?.models.length ?? 0) },
  ];

  const tok = splitTokens(aTokens);
  const syncing = (current.isFetching || previous.isFetching) && !loading;

  return (
    <div className="space-y-4">
      <p className="sr-only" role="status" aria-live="polite">
        {loading
          ? `Loading usage for ${rangeLabel}`
          : `${spec.label} · ${rangeLabel}: ${fmtTokens(tokens)} tokens, ${fmtCost(cost)}, ${messages.toLocaleString()} messages across ${sessionsCount} sessions and ${modelsCount} models.`}
      </p>

      {/* Period command bar — the segmented scope control is the protagonist. */}
      <Plate>
        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#0070eb] to-[#004493] text-white shadow-[0_6px_16px_-8px_rgba(0,88,188,0.7)]"
              aria-hidden="true"
            >
              <ChartLine size={19} weight="bold" />
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3">
                Period scope
              </p>
              <p className="truncate text-[15px] font-semibold tracking-tight text-ink" title={rangeLabel}>
                {rangeLabel}
              </p>
              <p className="truncate text-[12px] text-ink-2">
                {spec.label} · compared with {spec.compare}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div
              className="flex items-center gap-0.5 rounded-full border border-hairline bg-tray p-0.5"
              role="group"
              aria-label="Usage period"
            >
              {PERIODS.map((p) => {
                const on = period === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPeriod(p.id)}
                    aria-pressed={on}
                    className={cn(
                      "min-w-[64px] whitespace-nowrap rounded-full px-3 py-1.5 text-[12px]",
                      EASE,
                      PRESS,
                      FOCUS,
                      on
                        ? "bg-primary font-semibold text-white shadow-[0_6px_16px_-8px_rgba(0,88,188,0.7)]"
                        : "text-ink-2 hover:bg-card hover:text-ink",
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <span
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline bg-tray px-2.5 py-1 text-[11px] text-ink-2"
              title={clients.length > 0 ? clients.join(", ") : "All agent clients"}
            >
              <Funnel size={11} aria-hidden="true" />
              {clients.length === 0
                ? "All clients"
                : `${clients.length} client${clients.length === 1 ? "" : "s"}`}
            </span>
            {syncing && (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-3" role="status">
                <span className="breathe h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                syncing
              </span>
            )}
          </div>
        </div>
      </Plate>

      {/* Hero period totals + period-over-period rail. */}
      <Plate>
        <div className="px-4 pt-4 sm:px-5">
          {loading ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-3 lg:grid-cols-5" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <div className="skeleton h-3 w-20 rounded" />
                  <div className="skeleton h-7 w-24 rounded" />
                  <div className="skeleton h-3 w-28 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
              {[
                {
                  label: "Tokens",
                  icon: <Database size={13} weight="bold" />,
                  value: tok.num,
                  unit: tok.unit,
                  sub: sessionsCount > 0 ? `${fmtTokens(avgTokens)} avg / session` : "no sessions",
                },
                {
                  label: "Cost",
                  icon: <CurrencyDollar size={13} weight="bold" />,
                  value: fmtCost(aCost),
                  unit: "USD",
                  sub: sessionsCount > 0 ? `${fmtCost(cost / sessionsCount)} avg / session` : "no sessions",
                },
                {
                  label: "Messages",
                  icon: <Chats size={13} weight="bold" />,
                  value: Math.round(aMessages).toLocaleString(),
                  unit: "msgs",
                  sub: sessionsCount > 0 ? `${Math.round(avgMessages).toLocaleString()} avg / session` : "no sessions",
                },
                {
                  label: "Models",
                  icon: <Cube size={13} weight="bold" />,
                  value: Math.round(aModels).toLocaleString(),
                  unit: "active",
                  sub: topModel ? `top ${topModel.model}` : "none recorded",
                },
                {
                  label: "Sessions",
                  icon: <TerminalWindow size={13} weight="bold" />,
                  value: Math.round(aSessions).toLocaleString(),
                  unit: "streams",
                  sub: `${snap?.clients.length ?? 0} client${(snap?.clients.length ?? 0) === 1 ? "" : "s"} active`,
                },
              ].map((f) => (
                <div key={f.label} className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                    <span className="text-primary" aria-hidden="true">
                      {f.icon}
                    </span>
                    {f.label}
                  </p>
                  <p className="tnum mt-2 flex items-baseline gap-1.5 font-mono text-[27px] font-semibold leading-none tracking-tight text-ink">
                    <span className="truncate" title={String(f.value)}>
                      {f.value}
                    </span>
                    <span className="shrink-0 text-[12px] font-medium text-ink-3">{f.unit}</span>
                  </p>
                  <p className="tnum mt-2 truncate font-mono text-[11px] text-ink-3" title={f.sub}>
                    {f.sub}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Comparison rail — vs the equal-length window immediately before. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline px-4 py-3 sm:px-5">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
            vs {spec.compare}
          </span>
          {loading ? (
            <div className="skeleton h-4 w-64 rounded" aria-hidden="true" />
          ) : (
            deltas.map((d) => (
              <span key={d.label} className="inline-flex items-baseline gap-1.5 text-[11px]">
                <span className="text-ink-2">{d.label}</span>
                <DeltaValue delta={d.delta} />
              </span>
            ))
          )}
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-ink-3">
            <ClockCounterClockwise size={12} aria-hidden="true" />
            {prevRangeLabel}
          </span>
        </div>
      </Plate>

      {/* Breakdown grid — model ledger (wide) beside client split (narrow). */}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <ModelBreakdown models={snap?.models} loading={loading} />
        <ClientSplit snap={snap} loading={loading} />
      </div>

      <TopSessions sessions={snap?.sessions} loading={loading} />
    </div>
  );
}
