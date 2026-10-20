import { Fragment, useEffect, useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import {
  CaretDown,
  CaretUp,
  Check,
  Clock,
  Copy,
  FolderOpen,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import type { SessionRowDTO } from "../lib/tauri";
import { cn } from "../lib/cn";
import TooltipCard from "./TooltipCard";
import { getClientVisual } from "../lib/client-color";
import { fmtCostPrecise, fmtDurationMs, fmtPct, fmtTokens } from "../lib/format";

function fmtTs(ms: number): string {
  // Backend timestamp is unix MILLIS (tokscale UnifiedMessage). Do not *1000.
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtFull(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function fmtRelative(ms: number): string {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return "";
  }
}

/**
 * Compact session token for dense rows: `#287c07…`, built from the first six
 * characters after an optional `ses_` prefix. The full ID stays in titles and
 * copy actions.
 */
function shortSessionId(id: string): string {
  const raw = id.trim();
  if (!raw) return "—";
  const body = raw.startsWith("ses_") ? raw.slice(4) : raw;
  const visible = body.slice(0, 6);
  return `#${visible}${body.length > 6 ? "…" : ""}`;
}

/**
 * Workspace badge text. Friendly labels stay as-is; raw paths (from either the
 * label or the key) collapse to their last folder name. Falls back to whichever
 * value is present.
 */
function displayWorkspace(label?: string | null, key?: string | null): string {
  const source = label?.trim() || key?.trim() || "";
  if (!source) return "";
  if (!/[\\/]/.test(source)) return source;
  const segments = source.split(/[\\/]+/).filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : source;
}

/** Display-only recency rail color for the row's age. No effect on filtering or sort. */
function recencyRail(lastSeen: number): string {
  const age = Date.now() - lastSeen;
  if (age <= 3_600_000) return "bg-blue-500";
  if (age <= 24 * 3_600_000) return "bg-amber-400";
  if (age <= 7 * 24 * 3_600_000) return "bg-slate-300";
  return "bg-slate-200";
}

/** Display-only bucket label used for the rail tooltip. */
function recencyBucket(lastSeen: number): string {
  const age = Date.now() - lastSeen;
  if (age <= 3_600_000) return "Active within the last hour";
  if (age <= 24 * 3_600_000) return "Active within the last day";
  if (age <= 7 * 24 * 3_600_000) return "Active within the last week";
  return "Older than a week";
}

type SortKey =
  | "last_seen"
  | "duration"
  | "messages"
  | "tokens"
  | "cost"
  | "client"
  | "model";
type SortDir = "asc" | "desc";
type Recency = "all" | "24h" | "7d" | "30d";

const RECENCY_OPTIONS: { id: Recency; label: string; ms: number | null }[] = [
  { id: "all", label: "All", ms: null },
  { id: "24h", label: "Last 24h", ms: 24 * 3600_000 },
  { id: "7d", label: "Last 7d", ms: 7 * 24 * 3600_000 },
  { id: "30d", label: "Last 30d", ms: 30 * 24 * 3600_000 },
];

const PAGE_SIZES = [25, 50, 100];

/** Shared machined control physics: custom bezier, magnetic group press, GPU-safe. */
const CONTROL_EASE =
  "transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";
const MAGNETIC_PRESS = "active:scale-[0.97]";
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

function defaultDir(key: SortKey): SortDir {
  return key === "client" || key === "model" ? "asc" : "desc";
}

function SortTh({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
  className,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = activeKey === sortKey;
  return (
    <th
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "px-4 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em]",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
        className={cn(
          "group/sort inline-flex items-center gap-1",
          CONTROL_EASE,
          MAGNETIC_PRESS,
          FOCUS_RING,
          "rounded-md hover:text-slate-900",
          active ? "text-slate-900" : "text-ink-3",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
          {active ? (
            dir === "asc" ? (
              <CaretUp size={12} weight="bold" className="text-blue-600" />
            ) : (
              <CaretDown size={12} weight="bold" className="text-blue-600" />
            )
          ) : (
            <span className="text-ink-3 opacity-0 transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover/sort:opacity-100">
              <CaretDown size={12} />
            </span>
          )}
        </span>
      </button>
    </th>
  );
}

/** Stitch filter chip: pill with hairline, blue active state, magnetic press. */
function FilterPill({
  on,
  onClick,
  label,
  pressedLabel,
  title,
  dotClass,
  count,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  pressedLabel?: string;
  title?: string;
  dotClass?: string;
  count?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={pressedLabel ?? label}
      title={title ?? label}
      className={cn(
        "group/pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        CONTROL_EASE,
        MAGNETIC_PRESS,
        FOCUS_RING,
        on
          ? "border-blue-600 bg-blue-600 text-white shadow-[0_1px_2px_rgba(37,99,235,0.4)]"
          : "border-slate-900/[0.08] bg-white text-slate-600 shadow-sm hover:border-slate-900/[0.16] hover:text-slate-900",
      )}
    >
      {dotClass && (
        <span
          aria-hidden="true"
          className={cn(
            "h-1.5 w-1.5 rounded-full transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover/pill:scale-125",
            dotClass,
            on && "ring-2 ring-white/40",
          )}
        />
      )}
      {label}
      {count && (
        <span
          className={cn(
            "tnum font-mono font-normal",
            on ? "text-white/80" : "text-ink-3",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export default function SessionsTable({
  rows,
  loading,
}: {
  rows: SessionRowDTO[] | undefined;
  loading?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [query, setQuery] = useState("");
  const [clientFilter, setClientFilter] = useState<string>("All");
  const [recency, setRecency] = useState<Recency>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "last_seen",
    dir: "desc",
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Reset to first page whenever the result set definition changes.
  useEffect(() => {
    setPage(0);
  }, [rows, query, clientFilter, recency, sort, pageSize]);
  // Collapse the inspector only when its row actually disappears from the
  // result set (e.g. date-range change). A blind null on every `rows`
  // identity change wiped the open inspector on each background refetch.
  useEffect(() => {
    setSelected((prev) => {
      if (!prev) return prev;
      const keys = new Set((rows ?? []).map((r) => `${r.client}:${r.session_id}`));
      return keys.has(prev) ? prev : null;
    });
  }, [rows]);

  // Escape collapses the open inspector — keyboard parity for the row toggle.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const clientCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.client, (m.get(r.client) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = useMemo(() => {
    const list = rows ?? [];
    const now = Date.now();
    const rec = RECENCY_OPTIONS.find((o) => o.id === recency);
    const cutoff = rec?.ms != null ? now - rec.ms : null;
    const q = query.trim().toLowerCase();
    return list.filter((r) => {
      if (clientFilter !== "All" && r.client !== clientFilter) return false;
      if (cutoff != null && r.last_seen < cutoff) return false;
      if (!q) return true;
      const hay = [
        r.session_title ?? "",
        r.session_id,
        r.client,
        r.model,
        (r.models ?? []).join(" "),
        r.workspace_label ?? "",
        r.workspace_key ?? "",
        r.agent ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, clientFilter, recency]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const mult = sort.dir === "asc" ? 1 : -1;
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    const dur = (r: (typeof arr)[number]): number =>
      r.last_seen > 0 && r.first_seen > 0 ? Math.max(0, r.last_seen - r.first_seen) : 0;
    arr.sort((a, b) => {
      let primary = 0;
      switch (sort.key) {
        case "last_seen":
          primary = (num(a.last_seen) - num(b.last_seen)) * mult;
          break;
        case "duration":
          primary = (dur(a) - dur(b)) * mult;
          break;
        case "messages":
          primary = (num(a.messages) - num(b.messages)) * mult;
          break;
        case "tokens":
          primary = (num(a.tokens) - num(b.tokens)) * mult;
          break;
        case "cost":
          primary = (num(a.cost) - num(b.cost)) * mult;
          break;
        case "client":
          primary = (a.client ?? "").localeCompare(b.client ?? "") * mult;
          break;
        case "model":
          primary = (a.model ?? "").localeCompare(b.model ?? "") * mult;
          break;
        default:
          primary = 0;
      }
      // Deterministic tiebreak so equal keys never reshuffle between renders.
      if (primary === 0) primary = (a.session_id ?? "").localeCompare(b.session_id ?? "");
      return primary;
    });
    return arr;
  }, [filtered, sort]);

  const onSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: defaultDir(key) },
    );
  };

  const quickSort = (key: SortKey, dir: SortDir) => setSort({ key, dir });

  const copyText = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable — still show feedback */
    }
    setCopied(tag);
    window.setTimeout(() => {
      setCopied((c) => (c === tag ? null : c));
    }, 1500);
  };

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  // Keep the stored page in range when the result set shrinks underneath it
  // (background refetch with no filter change). Display already uses
  // `safePage`, but without this the Prev control walks down from the stale
  // out-of-range value one click at a time.
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);
  const visible = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const rangeStart = sorted.length === 0 ? 0 : safePage * pageSize + 1;
  const rangeEnd = Math.min(sorted.length, safePage * pageSize + pageSize);

  if (loading && !rows) {
    return (
      <div className="rounded-3xl bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.12)] ring-1 ring-slate-900/[0.06]">
        <div
          className="overflow-hidden rounded-3xl"
          role="status"
          aria-label="Loading sessions"
        >
          <span className="sr-only">Loading sessions</span>
          <div className="space-y-2 p-4" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-8 w-full animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none"
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (!rows) return <div className="text-sm text-slate-500">Loading…</div>;
  if (rows.length === 0) {
    return (
      <div className="rounded-3xl bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.12)] ring-1 ring-slate-900/[0.06]">
        <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-3xl border border-dashed border-slate-200 bg-white px-4 text-center">
          <p className="text-sm font-medium text-slate-700">No sessions in this range</p>
          <p className="text-xs text-ink-3">
            New runs land here as they are recorded.
          </p>
        </div>
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      {/* Stitch ledger card: white surface on canvas, hairline ring, soft lift */}
      <div className="overflow-hidden rounded-3xl bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.12)] ring-1 ring-slate-900/[0.06]">
        {/* Toolbar: nested control deck on a faint slate wash */}
        <div className="border-b border-slate-900/[0.06] px-3 py-3">
          <div className="rounded-2xl bg-slate-50/80 px-4 py-3 ring-1 ring-slate-900/[0.05]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2.5 text-sm font-semibold text-slate-900">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-900/[0.08] bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 shadow-sm">
                  <span
                    aria-hidden="true"
                    className="breathe h-1.5 w-1.5 rounded-full bg-blue-600"
                  />
                  Ledger
                </span>
                <span>
                  Sessions{" "}
                  <span
                    className="tnum font-mono text-xs font-normal text-ink-3"
                    aria-live="polite"
                  >
                    ({sorted.length.toLocaleString()})
                  </span>
                </span>
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                {/* Quick sorts */}
                <div
                  className="flex items-center gap-1.5"
                  role="group"
                  aria-label="Quick sorts"
                >
                  {(
                    [
                      { label: "Latest", key: "last_seen", dir: "desc" },
                      { label: "Most tokens", key: "tokens", dir: "desc" },
                      { label: "Highest cost", key: "cost", dir: "desc" },
                    ] as const
                  ).map((p) => {
                    const on = sort.key === p.key && sort.dir === p.dir;
                    return (
                      <FilterPill
                        key={p.label}
                        on={on}
                        onClick={() => quickSort(p.key, p.dir)}
                        label={p.label}
                        pressedLabel={`Sort by ${p.label.toLowerCase()}${on ? " (active)" : ""}`}
                      />
                    );
                  })}
                </div>
                {/* Search */}
                <div className="relative" role="search">
                  <MagnifyingGlass
                    size={14}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
                  />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter title, id, client, model, project, agent…"
                    aria-label="Filter sessions"
                    className={cn(
                      "w-64 rounded-full border border-slate-900/[0.1] bg-white py-1.5 pl-9 pr-8 text-xs text-slate-900 shadow-sm placeholder:text-ink-3",
                      CONTROL_EASE,
                      FOCUS_RING,
                      "hover:border-slate-900/[0.2] focus:border-blue-600",
                    )}
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className={cn(
                        "group/clear absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-3 hover:bg-slate-100 hover:text-slate-700",
                        CONTROL_EASE,
                        MAGNETIC_PRESS,
                        FOCUS_RING,
                      )}
                    >
                      <X
                        size={13}
                        className="transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover/clear:translate-x-px group-hover/clear:-translate-y-px"
                      />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Recency filter chips */}
            <div
              className="mt-2.5 flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Filter by recency"
            >
              <span className="mr-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3">
                Recency
              </span>
              {RECENCY_OPTIONS.map((o) => (
                <FilterPill
                  key={o.id}
                  on={recency === o.id}
                  onClick={() => setRecency(o.id)}
                  label={o.label}
                  pressedLabel={`Show ${o.label.toLowerCase()} sessions`}
                />
              ))}
              <span
                className="ml-2 hidden items-center gap-2 font-mono text-[10px] text-ink-3 sm:inline-flex"
                aria-hidden="true"
              >
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500" /> 1h
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> 24h
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-300" /> 7d
                </span>
              </span>
            </div>

            {/* Client filter chips */}
            <div
              className="mt-2 flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Filter by client"
            >
              <span className="mr-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3">
                Client
              </span>
              <FilterPill
                on={clientFilter === "All"}
                onClick={() => setClientFilter("All")}
                label="All"
                pressedLabel="Show all clients"
                count={rows.length.toLocaleString()}
              />
              {clientCounts.map(([c, n]) => {
                const v = getClientVisual(c);
                const on = clientFilter === c;
                return (
                  <FilterPill
                    key={c}
                    on={on}
                    onClick={() => setClientFilter(on ? "All" : c)}
                    label={v.label}
                    pressedLabel={`Filter by ${v.label}`}
                    title={`${v.label} (${n} session${n === 1 ? "" : "s"})`}
                    dotClass={v.dot}
                    count={n.toLocaleString()}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Table — quiet dense rows; boldness lives in toolbar + inspector */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-white/90 backdrop-blur-md">
              <tr className="border-b border-slate-900/[0.06]">
                <th
                  scope="col"
                  className="min-w-56 px-4 py-2.5 pl-5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3"
                >
                  Session
                </th>
                <SortTh label="Client" sortKey="client" activeKey={sort.key} dir={sort.dir} onSort={onSort} />
                <SortTh label="Model" sortKey="model" activeKey={sort.key} dir={sort.dir} onSort={onSort} />
                <th
                  scope="col"
                  aria-sort={
                    sort.key === "last_seen" || sort.key === "duration"
                      ? sort.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em]"
                >
                  <span className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onSort("last_seen")}
                      title="Sort by last active"
                      className={cn(
                        "group/sort inline-flex items-center gap-1 rounded-md",
                        CONTROL_EASE,
                        MAGNETIC_PRESS,
                        FOCUS_RING,
                        "hover:text-slate-900",
                        sort.key === "last_seen" ? "text-slate-900" : "text-ink-3",
                      )}
                    >
                      Last active
                      <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
                        {sort.key === "last_seen" ? (
                          sort.dir === "asc" ? (
                            <CaretUp size={12} weight="bold" className="text-blue-600" />
                          ) : (
                            <CaretDown size={12} weight="bold" className="text-blue-600" />
                          )
                        ) : (
                          <span className="text-ink-3 opacity-0 transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover/sort:opacity-100">
                            <CaretDown size={12} />
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onSort("duration")}
                      title="Sort by active session duration"
                      aria-label="Sort by session duration"
                      className={cn(
                        "group/dur rounded-full p-1",
                        CONTROL_EASE,
                        MAGNETIC_PRESS,
                        FOCUS_RING,
                        sort.key === "duration"
                          ? "text-blue-600"
                          : "text-ink-3 hover:text-slate-600",
                      )}
                    >
                      <Clock
                        size={12}
                        className="transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover/dur:scale-110"
                      />
                    </button>
                  </span>
                </th>
                <SortTh label="Msgs" sortKey="messages" activeKey={sort.key} dir={sort.dir} onSort={onSort} align="right" className="whitespace-nowrap" />
                <SortTh label="Tokens" sortKey="tokens" activeKey={sort.key} dir={sort.dir} onSort={onSort} align="right" className="min-w-20 whitespace-nowrap" />
                <SortTh label="Cost" sortKey="cost" activeKey={sort.key} dir={sort.dir} onSort={onSort} align="right" className="min-w-20 whitespace-nowrap" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900/[0.05] text-xs">
              {visible.map((r) => {
                const key = `${r.client}:${r.session_id}`;
                const v = getClientVisual(r.client);
                const title = r.session_title?.trim() ? r.session_title.trim() : null;
                const expanded = selected === key;
                const detailId = `${key}-detail`;
                const extraModels = r.models && r.models.length > 1 ? r.models.length - 1 : 0;
                const workspaceName = displayWorkspace(r.workspace_label, r.workspace_key);
                const showWorkspace =
                  !!workspaceName && workspaceName !== "(unknown)";
                const isFree = r.cost === 0 && r.tokens > 0;
                const copyTag = `id:${key}`;
                const copiedNow = copied === copyTag;
                return (
                  <Fragment key={key}>
                    <tr
                      onClick={() => setSelected(expanded ? null : key)}
                      className={cn(
                        "cursor-pointer transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none hover:bg-slate-50",
                        expanded && "bg-blue-50/50",
                      )}
                    >
                      {/* Session / context */}
                      <td className="relative max-w-72 px-4 py-2.5 pl-5 align-top">
                        <span
                          aria-hidden="true"
                          title={recencyBucket(r.last_seen)}
                          className={cn(
                            "absolute bottom-3 left-2.5 top-3 w-0.5 rounded-full",
                            recencyRail(r.last_seen),
                          )}
                        />
                        <div className="flex items-start gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(expanded ? null : key);
                            }}
                            aria-expanded={expanded}
                            aria-controls={detailId}
                            aria-label={
                              expanded
                                ? `Collapse details for ${title ?? r.session_id}`
                                : `Expand details for ${title ?? r.session_id}`
                            }
                            title={expanded ? "Collapse details" : "Expand details"}
                            className={cn(
                              "group/expand mt-0.5 shrink-0 rounded-full border p-1",
                              CONTROL_EASE,
                              "active:scale-90",
                              FOCUS_RING,
                              expanded
                                ? "border-blue-200 bg-blue-50 text-blue-600"
                                : "border-transparent text-ink-3 hover:border-slate-200 hover:bg-slate-100 hover:text-slate-700",
                            )}
                          >
                            <CaretDown
                              size={12}
                              weight="bold"
                              className={cn(
                                "transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                                expanded && "rotate-180",
                              )}
                            />
                          </button>
                          <div className="min-w-0 flex-1">
                            <TooltipCard
                              content={title ?? r.session_id}
                              containerClassName="block"
                            >
                              <div
                                className={cn(
                                  "truncate",
                                  title
                                    ? "font-semibold text-slate-900"
                                    : "font-mono text-slate-700",
                                )}
                              >
                                {title ?? shortSessionId(r.session_id)}
                              </div>
                            </TooltipCard>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {showWorkspace && (
                                <TooltipCard
                                  content={
                                    <span className="break-all">
                                      {r.workspace_key || r.workspace_label}
                                    </span>
                                  }
                                >
                                  <span className="inline-flex max-w-40 items-center gap-1 truncate rounded bg-slate-100 px-1.5 py-px text-[10px] text-slate-500">
                                    <FolderOpen size={11} className="shrink-0 text-ink-3" />
                                    <span className="truncate">{workspaceName}</span>
                                  </span>
                                </TooltipCard>
                              )}
                              {!!r.agent && (
                                <span
                                  className="inline-flex max-w-32 items-center rounded border border-blue-200 bg-blue-50 px-1.5 py-px text-[10px] font-medium text-blue-700"
                                  title={r.agent}
                                >
                                  <span className="truncate">{r.agent}</span>
                                </span>
                              )}
                              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-ink-3">
                                <span title={r.session_id}>{shortSessionId(r.session_id)}</span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void copyText(r.session_id, copyTag);
                                  }}
                                  title="Copy full session ID"
                                  aria-label="Copy session ID"
                                  className={cn(
                                    "group/copy rounded p-0.5 text-ink-3 hover:bg-slate-100 hover:text-slate-600",
                                    CONTROL_EASE,
                                    "active:scale-90",
                                    FOCUS_RING,
                                  )}
                                >
                                  {copiedNow ? (
                                    <Check size={11} className="text-blue-600" />
                                  ) : (
                                    <Copy
                                      size={11}
                                      className="transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover/copy:translate-x-px group-hover/copy:-translate-y-px"
                                    />
                                  )}
                                </button>
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>
                      {/* Client */}
                      <td className="px-4 py-2.5 align-top">
                        <span
                          className="inline-flex max-w-36 items-center gap-1.5 rounded-md border border-slate-900/[0.08] bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700"
                          title={v.label}
                        >
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", v.dot)} />
                          <span className="truncate">{v.label}</span>
                        </span>
                      </td>
                      {/* Model */}
                      <td className="max-w-44 px-4 py-2.5 align-top">
                        <TooltipCard
                          content={
                            <span className="break-words">
                              {[r.model, ...(r.models ?? []).filter((m) => m !== r.model)].join(", ")}
                            </span>
                          }
                          containerClassName="block"
                        >
                          <div className="truncate font-mono text-slate-700">{r.model}</div>
                        </TooltipCard>
                        {extraModels > 0 && (
                          <span
                            className="tnum mt-1 inline-block rounded-full border border-slate-200 bg-slate-50 px-1.5 py-px font-mono text-[10px] text-slate-500"
                            title={(r.models ?? []).join(", ")}
                          >
                            +{extraModels} more
                          </span>
                        )}
                      </td>
                      {/* Last active */}
                      <td className="min-w-28 px-4 py-2.5 align-top" title={fmtFull(r.last_seen)}>
                        <div className="whitespace-nowrap font-medium text-slate-700">
                          {fmtRelative(r.last_seen)}
                        </div>
                        <div className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap text-[11px] text-ink-3">
                          <span className="min-w-0 truncate">{fmtTs(r.last_seen)}</span>
                          <span className="tnum shrink-0 rounded bg-slate-100 px-1 py-px font-mono text-[10px] text-slate-500">
                            {fmtDurationMs(r.last_seen - r.first_seen)}
                          </span>
                        </div>
                      </td>
                      {/* Messages */}
                      <td className="tnum whitespace-nowrap px-4 py-2.5 text-right align-top font-mono text-slate-500">
                        {r.messages.toLocaleString()}
                      </td>
                      {/* Tokens */}
                      <td
                        className="tnum min-w-20 whitespace-nowrap px-4 py-2.5 text-right align-top font-mono font-semibold text-slate-900"
                        title={r.tokens.toLocaleString()}
                      >
                        {fmtTokens(r.tokens)}
                      </td>
                      {/* Cost */}
                      <td
                        className="tnum min-w-20 whitespace-nowrap px-4 py-2.5 text-right align-top font-mono font-semibold text-blue-600"
                        title={fmtCostPrecise(r.cost)}
                      >
                        {isFree ? (
                          <span
                            className="inline-block rounded-full border border-blue-200 bg-blue-50 px-2 py-px text-[10px] font-semibold text-blue-700"
                            title="Tokens recorded at no cost"
                          >
                            Free
                          </span>
                        ) : (
                          fmtCostPrecise(r.cost)
                        )}
                      </td>
                    </tr>

                    {/* Detail inspector */}
                    <AnimatePresence initial={false}>
                      {expanded && (
                        <tr key={`${key}:detail`} className="bg-slate-50/70">
                          <td colSpan={7} className="px-3 py-3 sm:px-4">
                            <motion.div
                              initial={{ opacity: 0, y: -10, scale: 0.995 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -10, scale: 0.995 }}
                              transition={{ type: "spring", stiffness: 380, damping: 34 }}
                              id={detailId}
                              role="region"
                              aria-label={`Session details for ${title ?? r.session_id}`}
                              className="rounded-2xl bg-white p-1 shadow-sm ring-1 ring-slate-900/[0.06]"
                            >
                              <div className="rounded-[calc(1rem-0.25rem)] bg-white px-3.5 py-3.5 sm:px-4">
                                <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-slate-900/[0.08] bg-slate-50 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink-3">
                                  <span aria-hidden="true" className="h-1 w-1 rounded-full bg-blue-600" />
                                  Telemetry diagnostics
                                </p>
                                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.15fr_1fr_1.2fr]">
                                  <motion.div
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ type: "spring", stiffness: 380, damping: 34, delay: 0.04 }}
                                    className="min-w-0"
                                  >
                                    <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink-3">
                                      Identity
                                    </div>
                                    {title && (
                                      <div className="mt-1.5 truncate text-sm font-semibold text-slate-900" title={title}>
                                        {title}
                                      </div>
                                    )}
                                    <div className="mt-1.5 flex items-center gap-1.5">
                                      <code className="tnum min-w-0 flex-1 truncate rounded-lg border border-slate-900/[0.08] bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-700" title={r.session_id}>
                                        {r.session_id}
                                      </code>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void copyText(r.session_id, copyTag);
                                        }}
                                        className={cn(
                                          "group/copybtn shrink-0 rounded-full border border-slate-200 bg-white p-2 text-ink-3 shadow-sm hover:border-slate-300 hover:text-slate-700",
                                          CONTROL_EASE,
                                          MAGNETIC_PRESS,
                                          FOCUS_RING,
                                        )}
                                        title="Copy session ID"
                                        aria-label="Copy full session ID"
                                      >
                                        {copiedNow ? (
                                          <Check size={13} className="text-blue-600" />
                                        ) : (
                                          <Copy
                                            size={13}
                                            className="transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover/copybtn:translate-x-px group-hover/copybtn:-translate-y-px group-hover/copybtn:scale-105"
                                          />
                                        )}
                                      </button>
                                    </div>
                                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                      <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-900/[0.08] bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">
                                        <span className={cn("h-1.5 w-1.5 rounded-full", v.dot)} />
                                        {v.label}
                                      </span>
                                      {!!r.agent && (
                                        <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">
                                          {r.agent}
                                        </span>
                                      )}
                                    </div>
                                    {!!r.workspace_key && (
                                      <div className="mt-2 flex items-center gap-1.5">
                                        <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-900/[0.08] bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-500" title={r.workspace_key}>
                                          {r.workspace_key}
                                        </code>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void copyText(r.workspace_key ?? "", `ws:${key}`);
                                          }}
                                          className={cn(
                                            "group/copybtn shrink-0 rounded-full border border-slate-200 bg-white p-2 text-ink-3 shadow-sm hover:border-slate-300 hover:text-slate-700",
                                            CONTROL_EASE,
                                            MAGNETIC_PRESS,
                                            FOCUS_RING,
                                          )}
                                          title="Copy workspace path"
                                          aria-label="Copy workspace path"
                                        >
                                          {copied === `ws:${key}` ? (
                                            <Check size={13} className="text-blue-600" />
                                          ) : (
                                            <Copy
                                              size={13}
                                              className="transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover/copybtn:translate-x-px group-hover/copybtn:-translate-y-px group-hover/copybtn:scale-105"
                                            />
                                          )}
                                        </button>
                                      </div>
                                    )}
                                  </motion.div>
                                  <motion.div
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ type: "spring", stiffness: 380, damping: 34, delay: 0.09 }}
                                    className="min-w-0"
                                  >
                                    <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink-3">
                                      Time window
                                    </div>
                                    <div className="mt-1.5 space-y-1 text-[11px]">
                                      <div className="flex items-baseline justify-between gap-2">
                                        <span className="shrink-0 text-ink-3">Started</span>
                                        <span className="tnum min-w-0 truncate font-mono text-slate-700" title={fmtFull(r.first_seen)}>
                                          {fmtFull(r.first_seen)}
                                        </span>
                                      </div>
                                      <div className="flex items-baseline justify-between gap-2">
                                        <span className="shrink-0 text-ink-3">Last active</span>
                                        <span className="tnum min-w-0 truncate font-mono text-slate-700" title={fmtFull(r.last_seen)}>
                                          {fmtFull(r.last_seen)}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="mt-2 text-xs text-slate-500">
                                      Active span{" "}
                                      <span className="tnum rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-700">
                                        {fmtDurationMs(r.last_seen - r.first_seen)}
                                      </span>
                                    </div>
                                    <div className="tnum mt-1 font-mono text-[11px] text-slate-500">
                                      {r.messages.toLocaleString()} messages
                                    </div>
                                    <div className="mt-1 text-[11px] text-ink-3">
                                      {fmtRelative(r.last_seen)}
                                    </div>
                                    <div className="mt-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink-3">
                                      Models ({(r.models ?? [r.model]).length})
                                    </div>
                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                      {(r.models && r.models.length > 0 ? r.models : [r.model]).map(
                                        (m) => (
                                          <span
                                            key={m}
                                            className="max-w-48 truncate rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
                                            title={m}
                                          >
                                            {m}
                                          </span>
                                        ),
                                      )}
                                    </div>
                                  </motion.div>
                                  <motion.div
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ type: "spring", stiffness: 380, damping: 34, delay: 0.14 }}
                                    className="min-w-0"
                                  >
                                    <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink-3">
                                      Token breakdown
                                    </div>
                                    <TokenBreakdown row={r} />
                                  </motion.div>
                                </div>
                              </div>
                            </motion.div>
                          </td>
                        </tr>
                      )}
                    </AnimatePresence>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {sorted.length === 0 && (
            <div className="flex flex-col items-center gap-2 border-t border-slate-900/[0.06] px-4 py-10">
              <p className="text-sm font-medium text-slate-700">No sessions match these filters</p>
              <p className="text-xs text-ink-3">
                Showing {rows.length.toLocaleString()} sessions in total. Loosen a filter to get rows back.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setClientFilter("All");
                  setRecency("all");
                }}
                className={cn(
                  "group mt-1 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-1.5 text-xs font-medium text-slate-600 shadow-sm hover:border-slate-300 hover:text-slate-900",
                  CONTROL_EASE,
                  MAGNETIC_PRESS,
                  FOCUS_RING,
                )}
              >
                Clear filters
                <X
                  size={12}
                  className="transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none group-hover:translate-x-px group-hover:-translate-y-px"
                />
              </button>
            </div>
          )}
        </div>

        {/* Pagination footer */}
        {sorted.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-slate-900/[0.06] bg-slate-50/60 px-4 py-2.5">
            <span className="tnum min-w-0 font-mono text-xs text-ink-3" aria-live="polite" role="status">
              Showing {rangeStart} to {rangeEnd} of {sorted.length.toLocaleString()} sessions
            </span>
            <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Rows per page">
              {PAGE_SIZES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPageSize(s)}
                  aria-pressed={pageSize === s}
                  aria-label={`Show ${s} rows per page`}
                  className={cn(
                    "tnum rounded-full border px-2 py-1 font-mono text-[11px] font-medium",
                    CONTROL_EASE,
                    MAGNETIC_PRESS,
                    FOCUS_RING,
                    pageSize === s
                      ? "border-blue-600 bg-blue-600 text-white shadow-[0_1px_2px_rgba(37,99,235,0.4)]"
                      : "border-slate-900/[0.08] bg-white text-slate-500 shadow-sm hover:border-slate-900/[0.16] hover:text-slate-900",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage(Math.max(0, safePage - 1))}
                aria-label="Previous page"
                className={cn(
                  "group shrink-0 whitespace-nowrap rounded-full border border-slate-900/[0.08] bg-white px-3.5 py-1 text-xs font-medium text-slate-600 shadow-sm hover:border-slate-900/[0.16] hover:text-slate-900 disabled:opacity-40",
                  CONTROL_EASE,
                  MAGNETIC_PRESS,
                  FOCUS_RING,
                )}
              >
                Prev
              </button>
              <span className="tnum shrink-0 whitespace-nowrap px-1 py-1 font-mono text-xs text-ink-3" aria-live="polite">
                {safePage + 1} of {pages}
              </span>
              <button
                type="button"
                disabled={safePage >= pages - 1}
                onClick={() => setPage(Math.min(pages - 1, safePage + 1))}
                aria-label="Next page"
                className={cn(
                  "group shrink-0 whitespace-nowrap rounded-full border border-slate-900/[0.08] bg-white px-3.5 py-1 text-xs font-medium text-slate-600 shadow-sm hover:border-slate-900/[0.16] hover:text-slate-900 disabled:opacity-40",
                  CONTROL_EASE,
                  MAGNETIC_PRESS,
                  FOCUS_RING,
                )}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}

function TokenBreakdown({ row: r }: { row: SessionRowDTO }) {
  const input = r.input ?? 0;
  const output = r.output ?? 0;
  const cacheRead = r.cache_read ?? 0;
  const cacheWrite = r.cache_write ?? 0;
  const reasoning = r.reasoning ?? 0;
  const total = r.tokens > 0 ? r.tokens : input + output + cacheRead + cacheWrite + reasoning;
  const segs = [
    { label: "Input", value: input, cls: "bg-blue-500" },
    { label: "Output", value: output, cls: "bg-sky-400" },
    { label: "Cache read", value: cacheRead, cls: "bg-amber-400" },
    { label: "Cache write", value: cacheWrite, cls: "bg-orange-300" },
    { label: "Reasoning", value: reasoning, cls: "bg-slate-300" },
  ].filter((s) => s.value > 0);
  const cacheHit =
    r.input !== undefined &&
    r.input !== null &&
    input + cacheRead > 0
      ? cacheRead / (input + cacheRead)
      : null;

  const stats: { label: string; value: number }[] = [
    { label: "Input", value: input },
    { label: "Output", value: output },
    { label: "Cache read", value: cacheRead },
    { label: "Cache write", value: cacheWrite },
    { label: "Reasoning", value: reasoning },
    { label: "Total", value: total },
  ];

  return (
    <div className="mt-1.5">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full border border-slate-900/[0.06] bg-slate-100"
        role="img"
        aria-label={`Token split: ${segs.map((s) => `${s.label} ${s.value.toLocaleString()}`).join(", ") || "none"}`}
      >
        {total > 0 &&
          segs.map((s) => (
            <div
              key={s.label}
              className={s.cls}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value.toLocaleString()}`}
            />
          ))}
      </div>
      <div className="tnum mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {stats.map((s) => (
          <div
            key={s.label}
            className="min-w-0 rounded-xl border border-slate-900/[0.06] bg-slate-50 px-2 py-1.5"
            title={s.value.toLocaleString()}
          >
            <div className="truncate font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-ink-3">
              {s.label}
            </div>
            <div className="mt-0.5 font-mono text-xs font-semibold text-slate-900">
              {fmtTokens(s.value)}
            </div>
          </div>
        ))}
        {cacheHit !== null && (
          <div className="min-w-0 rounded-xl border border-blue-200 bg-blue-50 px-2 py-1.5">
            <div className="truncate font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-blue-600">
              Cache hit
            </div>
            <div className="tnum mt-0.5 font-mono text-xs font-semibold text-blue-700">
              {fmtPct(cacheHit)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
