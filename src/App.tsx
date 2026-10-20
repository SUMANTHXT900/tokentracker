import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  ArrowsClockwise,
  ArrowsDownUp,
  Calendar,
  CalendarBlank,
  CaretDown,
  CaretRight,
  CaretUp,
  ChartLine,
  Check,
  Copy,
  Cube,
  Database,
  Folders,
  Funnel,
  GearSix,
  Lightning,
  ListMagnifyingGlass,
  MagnifyingGlass,
  Plus,
  ShareNetwork,
  ShieldCheck,
  Sparkle,
  SquaresFour,
  StopCircle,
  Timer,
  X,
} from "@phosphor-icons/react";
import {
  useSnapshot,
  useLiveStatus,
  useTrips,
  cmdRescan,
  cmdStopTrip,
  onUsageUpdated,
  onTripStopped,
  type ModelRowDTO,
  type ProjectRowDTO,
} from "./lib/tauri";
import { useQueryClient } from "@tanstack/react-query";
import { useStore, type Page } from "./store";
import { cn } from "./lib/cn";
import { getClientVisual } from "./lib/client-color";
import { fmtTokens, fmtCost, fmtCostPrecise, fmtPct, fmtDurationMs } from "./lib/format";
import KpiCards from "./components/KpiCards";
import DailyChart from "./components/DailyChart";
import ModelDonut from "./components/ModelDonut";
import Heatmap from "./components/Heatmap";
import SessionsTable from "./components/SessionsTable";
import TripSetupModal from "./components/TripSetupModal";
import TripView from "./components/TripView";
import SessionShareModal from "./components/SessionShareModal";
import Titlebar from "./components/Titlebar";
import PngCards from "./components/PngCards";
import UsageDetail from "./components/UsageDetail";
import { fmtBytes, useUpdater, UpdateToasts } from "./updater";

type NavIcon = typeof SquaresFour;

const NAV_GROUPS: { section: string; items: { id: Page; label: string; icon: NavIcon }[] }[] = [
  {
    section: "Analytics",
    items: [
      { id: "overview", label: "Overview", icon: SquaresFour },
      { id: "sessions", label: "Sessions", icon: ListMagnifyingGlass },
      { id: "projects", label: "Projects", icon: Folders },
      { id: "models", label: "Models", icon: Cube },
      { id: "calendar", label: "Calendar", icon: CalendarBlank },
      { id: "usage", label: "Usage", icon: ChartLine },
    ],
  },
  {
    section: "Studio & tools",
    items: [
      { id: "trips", label: "Focus", icon: Timer },
      { id: "cards", label: "Share", icon: ShareNetwork },
      { id: "settings", label: "Settings", icon: GearSix },
    ],
  },
];

const PAGE_META: Record<Page, { title: string; desc: string }> = {
  overview: {
    title: "Overview",
    desc: "Live telemetry across every agent client — tokens, cost, and velocity at a glance.",
  },
  sessions: {
    title: "Sessions",
    desc: "Every conversation stream, ranked by recency, tokens, and spend.",
  },
  projects: {
    title: "Projects",
    desc: "Workspaces mapped from local log paths — share, cost, and model mix per project.",
  },
  models: {
    title: "Models",
    desc: "Per-model token breakdown, cache efficiency, and reasoning spend.",
  },
  calendar: {
    title: "Calendar",
    desc: "Daily activity heatmap — your coding cadence at a glance.",
  },
  usage: {
    title: "Usage",
    desc: "Period-scoped deep dive — today, this week, or this month at a glance.",
  },
  trips: {
    title: "Focus",
    desc: "Focus sessions that measure the token delta while you work.",
  },
  cards: {
    title: "Share",
    desc: "Exportable PNG telemetry cards for decks, posts, and status updates.",
  },
  settings: {
    title: "Settings",
    desc: "Watcher status, supported clients, and privacy architecture.",
  },
};

const DATE_PRESETS: { label: string; days: number }[] = [
  { label: "All time", days: 0 },
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
];

/** Local-timezone YYYY-MM-DD (backend date keys are local days). */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "3h ago" / "2d ago" / absolute date when old. */
function relTime(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function fmtStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human labels for raw backend stop reasons (manual, time-elapsed, …). */
function stopReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Stopped";
  switch (reason) {
    case "manual":
      return "Stopped manually";
    case "after":
    case "time-elapsed":
      return "Time limit reached";
    case "idle":
    case "idle-timeout":
      return "Idle timeout";
    default:
      return reason
        .replace(/[-_]+/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase());
  }
}

const STOP_REASON_CLS: Record<string, string> = {
  manual: "whitespace-nowrap border-[#e5e5ea] bg-[#f4f3f8] text-[#414755]",
  after: "whitespace-nowrap border-amber-200 bg-amber-50 text-amber-700",
  "time-elapsed": "whitespace-nowrap border-amber-200 bg-amber-50 text-amber-700",
  idle: "whitespace-nowrap border-blue-200 bg-blue-50 text-[#0058bc]",
  "idle-timeout": "whitespace-nowrap border-blue-200 bg-blue-50 text-[#0058bc]",
};

interface ClientStat {
  tokens: number;
  sessions: number;
}

/** First-load overlay: branded animation until the first real snapshot lands.
 *  Refetches keep old data (placeholderData) so this shows exactly once. */
function BootOverlay() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const t1 = window.setTimeout(() => setStage(1), 8000);
    const t2 = window.setTimeout(() => setStage(2), 25000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);
  return (
    <motion.div
      className="fixed inset-x-0 bottom-0 top-10 z-40 flex overflow-y-auto bg-canvas/95"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      role="status"
      aria-label="Loading TokenTracker data"
    >
      {/* `m-auto` centers against the fixed layer itself (not the tall
          document) and collapses to 0 when the content is taller, so short
          windows scroll instead of clipping the logo. */}
      <div className="m-auto flex w-full max-w-sm flex-col items-center gap-4 px-6 py-8 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-[1.25rem] bg-gradient-to-br from-[#2f8bff] to-[#00459e] shadow-[0_12px_32px_-12px_rgba(0,112,235,0.5)]">
            <Cube size={30} weight="duotone" className="text-white" aria-hidden />
          </span>
          <div>
            <p className="font-display text-lg font-semibold tracking-tight text-ink">TokenTracker</p>
            <p className="tnum mt-1 font-mono text-[11px] text-ink-3">
              {stage === 0
                ? "Reading local logs…"
                : stage === 1
                  ? "Still reading — large log history…"
                  : "Taking longer than usual — retrying quietly…"}
            </p>
          </div>
          <div
            className="h-1 w-44 overflow-hidden rounded-full bg-tray-deep"
            aria-hidden
          >
            <motion.div
              className="h-full w-1/2 rounded-full bg-primary"
              animate={{ x: ["-100%", "300%"] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>
        <p className="max-w-xs text-[11px] leading-relaxed text-ink-3">
          Parsing ~60 agent formats on this machine. Your usage data never leaves this PC.
        </p>
      </div>
    </motion.div>
  );
}

export default function App() {
  const {
    page,
    setPage,
    clients,
    setClients,
    since,
    until,
    setRange,
    focusTripId,
    setFocusTripId,
  } = useStore();
  const filters = { clients, since, until };
  const { data: snap, refetch, isFetching, isPending } = useSnapshot(filters);
  const { data: live } = useLiveStatus();
  const {
    data: tripsData,
    isPending: tripsPending,
    isError: tripsError,
    isFetching: tripsFetching,
    refetch: refetchTrips,
  } = useTrips();
  const trips = tripsData ?? [];
  // `active` is the backend's restored running trip; fall back to "not stopped"
  // for older payloads (or the moment before the list refreshes).
  const runningTrip = trips.find((t) => t.active) ?? trips.find((t) => !t.stopped_at) ?? null;
  const runningTripId = runningTrip?.trip_id ?? null;
  const focusTrip = focusTripId
    ? (trips.find((t) => t.trip_id === focusTripId) ?? null)
    : null;
  const [tripModal, setTripModal] = useState(false);
  const [shareTripId, setShareTripId] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [focusMsg, setFocusMsg] = useState<{
    text: string;
    tone: "info" | "error";
  } | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [presetDays, setPresetDays] = useState<number | null>(null);
  const updater = useUpdater();
  const queryClient = useQueryClient();

  // One-second clock only while a session runs: resume card / banner elapsed.
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (!runningTripId) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningTripId]);
  const runningElapsed = runningTrip
    ? fmtDurationMs(clockNow - new Date(runningTrip.started_at).getTime())
    : "";

  // Collapsible rail: pinned preference + transient hover/focus reveal.
  // App-local only (store.ts untouched); preference persists in localStorage.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("tokentracker.sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [railHover, setRailHover] = useState(false);
  const railExpanded = !sidebarCollapsed || railHover;
  useEffect(() => {
    try {
      localStorage.setItem("tokentracker.sidebar-collapsed", sidebarCollapsed ? "1" : "0");
    } catch {
      /* storage unavailable — preference stays in memory */
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (!sidebarCollapsed) setRailHover(false);
  }, [sidebarCollapsed]);

  // Stable client ribbon: backend returns only filtered clients in snap.clients,
  // so accumulate the union while filtered — selecting one client must not
  // hide the rest. On unfiltered snapshots the backend returns the full set,
  // so adopt it directly (evicts renamed/removed clients).
  // Ordering follows snap.clients recency (active first), never alphabetical:
  // current backend order leads, historical clients trail.
  const [seenClients, setSeenClients] = useState<string[]>([]);
  useEffect(() => {
    if (!snap) return;
    setSeenClients((prev) => {
      if (clients.length === 0) return [...snap.clients];
      const ordered: string[] = [];
      for (const c of snap.clients) if (!ordered.includes(c)) ordered.push(c);
      for (const c of prev) if (!ordered.includes(c)) ordered.push(c);
      return ordered;
    });
  }, [snap, clients]);
  const knownClients = seenClients.length > 0 ? seenClients : (snap?.clients ?? []);

  // Per-client stats for ribbon badges. Stable while filtered so pills keep
  // their numbers after a client is selected; refreshed on unfiltered snaps,
  // and seeded from the first snap even if the app loads already filtered.
  const [clientStats, setClientStats] = useState<Record<string, ClientStat>>({});
  const unfiltered = clients.length === 0;
  const hasStats = Object.keys(clientStats).length > 0;
  useEffect(() => {
    if (!snap) return;
    if (!unfiltered && hasStats) return;
    const m: Record<string, ClientStat> = {};
    const stat = (c: string): ClientStat => {
      if (!m[c]) m[c] = { tokens: 0, sessions: 0 };
      return m[c];
    };
    for (const s of snap.sessions) stat(s.client).sessions += 1;
    if (snap.models.length > 0) {
      for (const mo of snap.models) stat(mo.client).tokens += mo.tokens;
    } else {
      for (const s of snap.sessions) stat(s.client).tokens += s.tokens;
    }
    setClientStats(m);
  }, [snap, unfiltered, hasStats]);

  // Live watcher: Tauri emits usage://updated on fs change → refetch snapshot
  // (placeholderData keeps old UI, no flash). Browser dev: no-op.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onUsageUpdated(() => {
      queryClient.invalidateQueries({ queryKey: ["usage"] });
      queryClient.invalidateQueries({ queryKey: ["live-status"] });
      // Keep the open/running session summary in step with the watcher even
      // between its own 15s polls.
      if (runningTripId) {
        queryClient.invalidateQueries({ queryKey: ["trip", runningTripId] });
      }
      // Static text: identical value dedupes in React, so screen readers
      // are not re-announced on every background watcher tick.
      setScanMsg("Auto-updated");
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [queryClient, runningTripId]);

  // Focus auto-stop: backend emits trip://stopped → refresh list/detail and
  // announce a human label. Never clear focusTripId: the final summary stays
  // open (or the closed row stays selected).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onTripStopped(({ trip_id, reason }) => {
      queryClient.invalidateQueries({ queryKey: ["trips"] });
      queryClient.invalidateQueries({ queryKey: ["trip", trip_id] });
      const label = stopReasonLabel(reason);
      setFocusMsg({ text: `Focus session closed — ${label}.`, tone: "info" });
      setScanMsg(`Focus session closed · ${label}`);
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [queryClient]);

  const scan = async () => {
    setScanning(true);
    setScanMsg(null);
    try {
      const r = await cmdRescan();
      setScanMsg(`${r.scanned_files.toLocaleString()} records · ${r.took_ms}ms`);
      refetch();
    } catch (e) {
      setScanMsg(`Scan failed: ${String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  // Opening a session is a fresh context: drop any previous stop notice.
  const openFocusTrip = (tripId: string) => {
    setFocusMsg(null);
    setFocusTripId(tripId);
  };

  // Manual stop emits no backend event, so invalidate both caches here and
  // surface the result on the Focus page itself.
  const stopRunningTrip = async (tripId: string, name: string, fromBanner = false) => {
    setStoppingId(tripId);
    setFocusMsg(null);
    try {
      await cmdStopTrip(tripId);
    } catch (e) {
      setStoppingId(null);
      const text = `Couldn't stop the focus session: ${e instanceof Error ? e.message : String(e)}`;
      setFocusMsg({ text, tone: "error" });
      if (fromBanner) setScanMsg(text);
      return;
    }
    // Cache refresh is best-effort: the stop already succeeded, so a failed
    // refetch must not be reported as a failed stop.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["trips"] }),
      queryClient.invalidateQueries({ queryKey: ["trip", tripId] }),
    ]).catch(() => {});
    setStoppingId(null);
    const text = `Focus session closed. The final summary is ready.`;
    setFocusMsg({ text, tone: "info" });
    if (fromBanner) setScanMsg(text);
  };

  const applyPreset = (days: number) => {
    setPresetDays(days === 0 ? null : days);
    if (days === 0) {
      setRange(null, null);
      return;
    }
    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 86_400_000);
    setRange(ymd(start), ymd(end));
  };

  const clearRange = () => {
    setPresetDays(null);
    setRange(null, null);
  };

  // A preset pill is honest only while the live range still equals the window
  // it produced. Other surfaces (Heatmap day scope) call setRange directly,
  // so reconcile here instead of trusting local state.
  useEffect(() => {
    if (presetDays === null) return;
    const end = new Date();
    const start = new Date(end.getTime() - (presetDays - 1) * 86_400_000);
    if (ymd(start) !== since || ymd(end) !== until) setPresetDays(null);
  }, [since, until, presetDays]);

  // Overview bug fix: sessions arrive cost-sorted from the backend — recency-sort
  // a copy so the "Recent Sessions" panel actually shows recent work.
  const recentSessions = useMemo(
    () => [...(snap?.sessions ?? [])].sort((a, b) => b.last_seen - a.last_seen),
    [snap],
  );

  const loading = isPending && !snap;
  const syncStamp = live?.last_scan_at
    ? new Date(live.last_scan_at).toLocaleTimeString([], { hour12: false })
    : null;
  const meta = PAGE_META[page];
  const counts = {
    sessions: snap?.sessions.length ?? 0,
    projects: snap?.projects.length ?? 0,
    models: snap?.models.length ?? 0,
  };

  // Focus-local status line: manual stops never emit a backend event, so this
  // is the only visible confirmation that the stop landed.
  const focusStatus = focusMsg ? (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-2xl border px-4 py-2.5 text-[13px]",
        focusMsg.tone === "error"
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-[#0070eb]/25 bg-[#0070eb]/[0.06] text-[#0058bc]",
      )}
    >
      {focusMsg.text}
    </p>
  ) : null;

  return (
    <MotionConfig reducedMotion="user">
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[80] focus:rounded-full focus:border focus:border-primary/40 focus:bg-white focus:px-4 focus:py-2 focus:text-[13px] focus:font-semibold focus:text-primary"
      >
        Skip to content
      </a>
      <Titlebar />
      <div className="flex min-h-0 flex-1">
      {/* ── Cupertino telemetry rail (fixed chrome) ─────────────────────── */}
      <div
        className={cn(
          "sticky top-10 z-30 h-[calc(100dvh-2.5rem)] shrink-0 p-3 pr-0 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          railExpanded ? "w-[268px]" : "w-[88px]",
        )}
        onMouseEnter={() => {
          if (sidebarCollapsed) setRailHover(true);
        }}
        onMouseLeave={() => setRailHover(false)}
        onFocusCapture={() => {
          if (sidebarCollapsed) setRailHover(true);
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setRailHover(false);
        }}
      >
      <aside aria-label="Primary" className="flex h-full flex-col overflow-hidden rounded-[1.75rem] border border-hairline bg-card/90 p-2 shadow-[0_24px_60px_-32px_rgba(16,24,40,0.28)] backdrop-blur-xl">
        {/* Brand medallion — light instrument plate */}
        <div className="rounded-[1.25rem] border border-hairline bg-tray p-1.5">
        <div className={cn("flex items-center gap-2.5 rounded-[0.9rem] border border-hairline bg-card px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]", !railExpanded && "justify-center gap-0 px-0")}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#0070eb] to-[#004493] shadow-[0_6px_16px_-6px_rgba(0,88,188,0.6)]">
            <Cube size={20} weight="bold" className="text-white" aria-hidden="true" />
          </span>
          <div
            aria-hidden={!railExpanded}
            className={cn(
              "min-w-0 whitespace-nowrap transition-[max-width,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              railExpanded ? "max-w-[160px] opacity-100" : "max-w-0 overflow-hidden opacity-0",
            )}
          >
            <h1 className="font-display truncate whitespace-nowrap text-[15px] font-bold leading-none tracking-[0.14em] text-ink">
              TOKENTRACKER
            </h1>
            <p className="mt-1.5" role="status" aria-live="polite">
              {live?.watching ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-600/25 bg-emerald-500/10 px-2 py-0.5 font-mono text-[9px] tracking-[0.14em] text-success">
                  <span className="breathe inline-flex h-1.5 w-1.5 rounded-full bg-success-dot shadow-[0_0_10px_rgba(52,199,89,0.8)]" aria-hidden="true" />
                  LIVE WATCHER
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-tray px-2 py-0.5 font-mono text-[9px] tracking-[0.14em] text-ink-3">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-ink-3/60" aria-hidden="true" />
                  STANDBY
                </span>
              )}
            </p>
          </div>
        </div>
        </div>

        {/* Navigation */}
        <nav aria-label="Sections" className="mt-4 flex-1 space-y-5 overflow-y-auto px-1 py-1 pr-1">
          {NAV_GROUPS.map((group) => (
            <div key={group.section}>
              <p
                aria-hidden={!railExpanded}
                className={cn(
                  "whitespace-nowrap px-3 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3 transition-[max-height,opacity,padding] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                  railExpanded ? "max-h-8 pb-1.5 opacity-100" : "max-h-0 overflow-hidden pb-0 opacity-0",
                )}
              >
                {group.section}
              </p>
              <div className="space-y-0.5">
                {group.items.map((n) => {
                  const active = page === n.id;
                  const Icon = n.icon;
                  const badge =
                    n.id === "sessions" && counts.sessions > 0
                      ? String(counts.sessions)
                      : n.id === "projects" && counts.projects > 0
                        ? String(counts.projects)
                        : n.id === "models" && counts.models > 0
                          ? String(counts.models)
                          : n.id === "trips" && runningTripId
                            ? "LIVE"
                            : null;
                  return (
                    <button
                      key={n.id}
                      onClick={() => setPage(n.id)}
                      aria-current={active ? "page" : undefined}
                      aria-label={!railExpanded ? n.label : undefined}
                      title={!railExpanded ? n.label : undefined}
                      className={cn(
                        "group relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] motion-reduce:transition-none",
                        active ? "text-primary" : "text-ink-2 hover:bg-tray hover:text-ink",
                        !railExpanded && "justify-center gap-0 px-2",
                      )}
                    >
                      {active && (
                        <motion.span
                          layoutId="sidebar-active"
                          transition={{ type: "spring", stiffness: 420, damping: 34 }}
                          className="absolute inset-0 rounded-xl border border-primary/15 bg-primary/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
                        />
                      )}
                      {active && (
                        <motion.span
                          layoutId="sidebar-accent"
                          transition={{ type: "spring", stiffness: 420, damping: 34 }}
                          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary shadow-[0_0_12px_rgba(0,88,188,0.5)]"
                        />
                      )}
                      <Icon
                        size={17}
                        weight={active ? "bold" : "regular"}
                        className={cn("relative shrink-0 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-active:scale-95 motion-reduce:transition-none", active ? "text-primary" : "text-ink-3 group-hover:scale-105")}
                      />
                      <span
                        aria-hidden={!railExpanded}
                        className={cn(
                          "relative min-w-0 flex-1 truncate whitespace-nowrap transition-[max-width,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                          active && "font-medium",
                          railExpanded ? "max-w-[140px] opacity-100" : "max-w-0 flex-none overflow-hidden opacity-0",
                        )}
                      >
                        {n.label}
                      </span>
                      {badge && railExpanded && (
                        <span
                          className={cn(
                            "tnum relative shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 font-mono text-[9px] tracking-wider",
                            badge === "LIVE"
                              ? "bg-primary/[0.08] text-primary"
                              : "bg-tray-deep text-ink-2",
                          )}
                        >
                          {badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Collapse toggle: pins the rail to icon-only */}
        <div className="px-1 pt-1">
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[12px] font-medium text-ink-3 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-tray hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 active:scale-[0.98] motion-reduce:transition-none",
              !railExpanded && "justify-center gap-0 px-2",
            )}
          >
            <CaretRight
              size={15}
              weight="bold"
              aria-hidden="true"
              className={cn(
                "shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                !sidebarCollapsed && "rotate-180",
              )}
            />
            <span
              aria-hidden={!railExpanded}
              className={cn(
                "truncate whitespace-nowrap transition-[max-width,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                railExpanded ? "max-w-[140px] opacity-100" : "max-w-0 overflow-hidden opacity-0",
              )}
            >
              {sidebarCollapsed ? "Expand" : "Collapse"}
            </span>
          </button>
        </div>

        {/* Footer: scan module + ambient sync readout */}
        <div className="mt-auto pt-2">
          <div className="rounded-2xl border border-hairline bg-tray p-1.5">
          <div className="rounded-[0.9rem] border border-hairline bg-card px-2 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
          <button
            onClick={scan}
            disabled={scanning}
            aria-busy={scanning}
            aria-label={!railExpanded ? (scanning ? "Scanning…" : "Scan now") : undefined}
            title={!railExpanded ? (scanning ? "Scanning…" : "Scan now") : undefined}
            className={cn(
              "group flex w-full items-center justify-between gap-2 rounded-full bg-primary py-1.5 pl-4 pr-1.5 text-[13px] font-semibold text-white shadow-[0_8px_20px_-8px_rgba(0,88,188,0.7)] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#004a9e] active:scale-[0.98] disabled:cursor-wait disabled:bg-primary/60 motion-reduce:transition-none",
              !railExpanded && "justify-center px-0 pl-0",
            )}
          >
            <span
              aria-hidden={!railExpanded}
              className={cn(
                "whitespace-nowrap transition-[max-width,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                railExpanded ? "max-w-[120px] opacity-100" : "max-w-0 overflow-hidden opacity-0",
              )}
            >
              {scanning ? "Scanning…" : "Scan now"}
            </span>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/20 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-active:scale-95 motion-reduce:transition-none" aria-hidden="true">
            <ArrowsClockwise size={14} weight="bold" className={scanning ? "animate-spin motion-reduce:animate-none" : undefined} />
            </span>
          </button>
          <div
            aria-hidden={!railExpanded}
            className={cn(
              "transition-[max-height,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              railExpanded ? "max-h-24 opacity-100" : "max-h-0 overflow-hidden opacity-0",
            )}
          >
          <p className="sync-line tnum truncate px-1 pt-1.5 font-mono text-[10px] text-ink-3" role="status" aria-live="polite">
            {scanMsg ?? ""}
          </p>
          <div className="tnum flex min-w-0 items-center justify-between gap-2 px-1 font-mono text-[10px] text-ink-2">
            <span className="min-w-0 truncate">{fmtTokens(snap?.total_tokens ?? 0)} tokens</span>
            <span aria-hidden="true" className="h-3 w-px shrink-0 bg-hairline" />
            <span className="min-w-0 truncate">{fmtCost(snap?.total_cost ?? 0)}</span>
          </div>
          <p className="tnum flex min-w-0 items-center gap-1.5 px-1 pt-1 font-mono text-[9px] tracking-[0.08em] text-ink-3">
            {live?.watching ? (
              <span className="breathe inline-block h-1 w-1 shrink-0 rounded-full bg-success-dot shadow-[0_0_8px_rgba(52,199,89,0.8)]" aria-hidden="true" />
            ) : (
              <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-ink-3/60" aria-hidden="true" />
            )}
            <span className="min-w-0 truncate">
            {syncStamp ? `SYNCED ${syncStamp}` : "SYNCED —"}
            {(live?.pending_files ?? 0) > 0 && (
              <span className="text-amber-700"> ({(live?.pending_files ?? 0)} queued)</span>
            )}
            </span>
          </p>
          </div>
          </div>
          </div>
        </div>
      </aside>
      </div>

      {/* ── Main cockpit column ────────────────────────────────────────── */}
      <main id="main-content" className="relative min-w-0 flex-1">
        <AnimatePresence>{loading && <BootOverlay />}</AnimatePresence>
        <div className="mx-auto min-w-0 w-full max-w-[1600px] space-y-5 px-4 py-6 sm:px-6">
          {/* Top instrument readout: page title + date range island */}
          <header className="rounded-[1.75rem] border border-hairline bg-card p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)]">
          <div className="rounded-[1.25rem] border border-hairline/70 bg-card px-5 py-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-tray px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3">
                  Local telemetry
                </p>
                <h2 className="font-display mt-2 text-[22px] font-semibold tracking-tight text-ink">
                  {meta.title}
                </h2>
                <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-2">{meta.desc}</p>
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-0.5 rounded-2xl border border-hairline bg-tray p-1 lg:rounded-full" role="group" aria-label="Date range">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card" aria-hidden="true">
                <Calendar size={14} className="text-ink-3" />
                </span>
                {DATE_PRESETS.map((p) => {
                  const on = p.days === 0 ? presetDays === null && !since && !until : presetDays === p.days;
                  return (
                    <button
                      key={p.label}
                      onClick={() => applyPreset(p.days)}
                      aria-pressed={on}
                      className={cn(
                        "whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] motion-reduce:transition-none",
                        on
                          ? "border-primary/20 bg-primary/[0.08] text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
                          : "border-transparent text-ink-2 hover:bg-card hover:text-ink",
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
                {(since || until) && (
                  <span className="tnum ml-1 inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-primary/25 bg-primary/[0.08] px-2.5 py-1 font-mono text-[11px] text-primary">
                    {since ?? "…"} → {until ?? "…"}
                    <button
                      onClick={clearRange}
                      title="Clear date range"
                      aria-label="Clear date range"
                      className="rounded-full p-0.5 text-primary/70 transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-primary/10 hover:text-primary motion-reduce:transition-none"
                    >
                      <X size={11} weight="bold" aria-hidden="true" />
                    </button>
                  </span>
                )}
              </div>
            </div>
          </div>
          </header>

          {/* Client filter ribbon — light instrument tray */}
          <div className="rounded-2xl border border-hairline bg-card p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)]">
          <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-[0.8rem] border border-hairline/70 bg-tray px-2 py-1.5" role="group" aria-label="Filter by client">
            <span className="mr-1 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3">
              <Funnel size={11} aria-hidden="true" /> Clients
            </span>
            <button
              onClick={() => setClients([])}
              aria-pressed={clients.length === 0}
              className={cn(
                "whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] motion-reduce:transition-none",
                clients.length === 0
                  ? "border-primary/20 bg-primary/[0.08] font-medium text-primary"
                  : "border-transparent text-ink-2 hover:bg-card hover:text-ink",
              )}
            >
              All clients
            </button>
            {knownClients.map((c) => {
              const on = clients.includes(c);
              const visual = getClientVisual(c);
              const stat = clientStats[c];
              const badge =
                stat && stat.tokens > 0
                  ? fmtTokens(stat.tokens)
                  : stat && stat.sessions > 0
                    ? `${stat.sessions}×`
                    : null;
              return (
                <button
                  key={c}
                  onClick={() =>
                    setClients(on ? clients.filter((x) => x !== c) : [...clients, c])
                  }
                  title={stat ? `${stat.sessions} sessions, ${fmtTokens(stat.tokens)} tokens` : c}
                  aria-pressed={on}
                  style={on ? { borderColor: `${visual.hex}66`, backgroundColor: `${visual.hex}14` } : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] motion-reduce:transition-none",
                    on
                      ? "font-medium text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
                      : "border-transparent text-ink-2 hover:bg-card hover:text-ink",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", visual.dot)} />
                  <span className="font-medium">{visual.label}</span>
                  {badge && (
                    <span
                      className={cn(
                        "tnum rounded-full px-1.5 py-0.5 font-mono text-[9px]",
                        on ? "bg-black/[0.07] text-ink-2" : "bg-tray-deep text-ink-3",
                      )}
                    >
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
            {clients.length > 0 && (
              <button
                onClick={() => setClients([])}
                className="ml-1 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-ink-2 transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-ink motion-reduce:transition-none"
              >
                <X size={11} /> Clear filter
              </button>
            )}
          </div>
          </div>

          {/* Compact live spotlight — never a full TripView on other pages */}
          {runningTrip && page !== "trips" && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
            >
              <div className="rounded-2xl border border-hairline bg-card p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)]">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[0.8rem] border border-primary/15 bg-primary/[0.06] px-3 py-2">
                  <span
                    aria-hidden="true"
                    className="breathe h-2 w-2 shrink-0 rounded-full bg-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
                      Focus session running
                    </p>
                    <p className="truncate text-[13px] font-semibold text-ink">
                      {runningTrip.name}
                    </p>
                  </div>
                  <span className="tnum shrink-0 whitespace-nowrap font-mono text-[11px] text-ink-2">
                    {runningElapsed}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      openFocusTrip(runningTrip.trip_id);
                      setPage("trips");
                    }}
                    className="inline-flex min-h-[32px] shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-card px-3 py-1 text-[12px] font-semibold text-primary transition-colors hover:bg-primary/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.97] motion-reduce:transition-none"
                  >
                    Open
                    <CaretRight size={12} weight="bold" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void stopRunningTrip(runningTrip.trip_id, runningTrip.name, true)}
                    disabled={stoppingId === runningTrip.trip_id}
                    className="inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-full border border-[#C81E1E]/30 bg-[#C81E1E]/[0.07] px-3 py-1 text-[12px] font-semibold text-[#9B1C1C] transition-colors hover:bg-[#C81E1E]/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C81E1E]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.97] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none"
                  >
                    <StopCircle size={13} weight="bold" aria-hidden="true" />
                    {stoppingId === runningTrip.trip_id ? "Stopping…" : "Stop"}
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Page body — spring crossfade on navigation (transform/opacity only) */}
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
              className="min-w-0 space-y-4"
            >
              {page === "overview" && (
                <>
                  <KpiCards snap={snap} isFetching={isFetching} />
                  <div className="grid gap-4 lg:grid-cols-5">
                    <div className="lg:col-span-3">
                      <DailyChart days={snap?.daily ?? []} loading={loading} />
                    </div>
                    <div className="lg:col-span-2">
                      <ModelDonut models={snap?.models ?? []} />
                    </div>
                  </div>
                  <Heatmap days={snap?.daily ?? []} />
                  <div className="rounded-2xl border border-[#e5e5ea] bg-white shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f2f2f7] px-4 py-3">
                      <h3 className="font-display text-sm font-semibold tracking-tight text-ink">
                        Recent Sessions
                      </h3>
                      <button
                        onClick={() => setPage("sessions")}
                        className="inline-flex items-center gap-1 rounded-full border border-[#e5e5ea] bg-white px-3 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        View all sessions <CaretRight size={11} weight="bold" aria-hidden />
                      </button>
                    </div>
                    <div className="p-2">
                      <SessionsTable rows={recentSessions} loading={loading} />
                    </div>
                  </div>
                </>
              )}

              {page === "sessions" && <SessionsTable rows={snap?.sessions} loading={loading} />}

              {page === "projects" && <ProjectsView snap={snap} loading={loading} />}

              {page === "models" && (
                <div className="min-w-0 space-y-4">
                  <ModelDonut models={snap?.models ?? []} />
                  <ModelTelemetryTable models={snap?.models ?? []} loading={loading} />
                </div>
              )}

              {page === "calendar" && <Heatmap days={snap?.daily ?? []} />}

              {page === "usage" && <UsageDetail clients={clients} />}

              {page === "trips" && (
                <div className="space-y-4">
                  {focusTrip ? (
                    <>
                      {focusStatus}
                      <TripView
                        tripId={focusTrip.trip_id}
                        live={!focusTrip.stopped_at}
                        summary={focusTrip}
                        onBack={() => setFocusTripId(null)}
                        onShare={() => setShareTripId(focusTrip.trip_id)}
                      />
                    </>
                  ) : (
                    <>
                  {focusStatus}
                  {/* Focus hero: the workspace where a session starts */}
                  <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1] }}
                    className="rounded-[2rem] bg-white p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)] ring-1 ring-[#e5e5ea]"
                  >
                    <div className="relative overflow-hidden rounded-[calc(2rem-0.375rem)] border border-[#e5e5ea]/70 bg-[#faf9fe] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                      <div
                        aria-hidden
                        className="pointer-events-none absolute -top-28 right-8 h-56 w-96 rounded-full bg-[#0070eb]/[0.06] blur-3xl"
                      />
                      <div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#0070eb]/20 to-transparent"
                      />
                      <div className="relative flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
                        <div className="flex min-w-0 items-center gap-4">
                          <span className="rounded-[1.25rem] bg-[#f4f3f8] p-1 ring-1 ring-[#e5e5ea]">
                            <span className="flex h-11 w-11 items-center justify-center rounded-[calc(1.25rem-0.25rem)] bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] ring-1 ring-[#e5e5ea]/70">
                              <Timer size={22} weight="light" className="text-[#0058bc]" />
                            </span>
                          </span>
                          <div className="min-w-0">
                            <p className="inline-flex items-center whitespace-nowrap rounded-full border border-[#e5e5ea] bg-white px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.2em] text-ink-3">
                              Focus session
                            </p>
                            <h3 className="font-display mt-1.5 text-xl font-semibold tracking-tight text-[#1a1b1f]">
                              Focus workspace
                            </h3>
                            <p className="mt-0.5 max-w-md text-[13px] leading-relaxed text-ink-3">
                              Start from baseline, work the session, read the exact delta.
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            if (runningTrip) {
                              openFocusTrip(runningTrip.trip_id);
                              setPage("trips");
                            } else {
                              setTripModal(true);
                            }
                          }}
                          className="group inline-flex min-h-[40px] items-center gap-2 rounded-full bg-[#0058bc] py-2 pl-5 pr-2 text-sm font-semibold text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_12px_28px_-12px_rgba(0,88,188,0.55)] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#0067d6] active:scale-[0.97] active:bg-[#004da6] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                        >
                          {runningTrip ? "Open running session" : "New focus session"}
                          <span
                            aria-hidden
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-105 group-active:scale-90"
                          >
                            {runningTrip ? (
                              <CaretRight size={14} weight="bold" />
                            ) : (
                              <Plus size={14} weight="light" />
                            )}
                          </span>
                        </button>
                      </div>
                    </div>
                  </motion.div>

                  {/* Live resume strip + composed empty state */}
                  {runningTrip ? (
                    <div className="rounded-[2rem] bg-white p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)] ring-1 ring-[#e5e5ea]">
                      <div className="relative overflow-hidden rounded-[calc(2rem-0.375rem)] border border-[#0070eb]/20 bg-[#faf9fe] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                        <div
                          aria-hidden
                          className="pointer-events-none absolute -top-20 right-6 h-40 w-64 rounded-full bg-[#0070eb]/[0.08] blur-3xl"
                        />
                        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-3 p-4 sm:p-5">
                          <span
                            aria-hidden="true"
                            className="breathe h-2.5 w-2.5 shrink-0 rounded-full bg-[#0070eb]"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#0058bc]">
                              Focus session running
                            </p>
                            <p className="mt-0.5 truncate text-sm font-semibold text-[#1a1b1f]">
                              {runningTrip.name}
                            </p>
                          </div>
                          <span
                            className="tnum shrink-0 whitespace-nowrap rounded-full border border-[#e5e5ea] bg-white px-2.5 py-1 font-mono text-[11px] text-[#414755]"
                            title="Elapsed focus time"
                          >
                            {runningElapsed}
                          </span>
                          <button
                            type="button"
                            onClick={() => openFocusTrip(runningTrip.trip_id)}
                            className="inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-full border border-[#0070eb]/40 bg-[#0070eb]/[0.08] px-4 py-1.5 text-[13px] font-semibold text-[#0058bc] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#0070eb]/[0.14] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:scale-[0.97] motion-reduce:transition-none"
                          >
                            Open
                            <CaretRight size={12} weight="bold" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void stopRunningTrip(runningTrip.trip_id, runningTrip.name)}
                            disabled={stoppingId === runningTrip.trip_id}
                            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full border border-[#C81E1E]/35 bg-[#C81E1E]/[0.07] px-4 py-1.5 text-[13px] font-semibold text-[#9B1C1C] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#C81E1E]/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C81E1E]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:scale-[0.97] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none"
                          >
                            <StopCircle size={14} weight="bold" aria-hidden="true" />
                            {stoppingId === runningTrip.trip_id ? "Stopping…" : "Stop"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-[2rem] bg-white p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)] ring-1 ring-[#e5e5ea]">
                      <div className="flex flex-col items-center rounded-[calc(2rem-0.375rem)] border border-dashed border-[#d4d4dc] bg-[#faf9fe] p-10 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                        <span className="rounded-[1.25rem] bg-[#f4f3f8] p-1 ring-1 ring-[#e5e5ea]">
                          <span className="flex h-12 w-12 items-center justify-center rounded-[calc(1.25rem-0.25rem)] bg-white ring-1 ring-[#e5e5ea]/70">
                            <Timer size={22} weight="light" className="text-ink-3" />
                          </span>
                        </span>
                        <p className="mt-3 text-sm font-medium text-[#414755]">No active focus session</p>
                        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-ink-3">
                          Start one to watch the token delta accumulate while you
                          work. Scope it to every client or a few, then stop it by
                          hand or with an auto-stop.
                        </p>
                        <button
                          onClick={() => setTripModal(true)}
                          className="group mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-full border border-[#0070eb]/40 bg-[#0070eb]/[0.08] py-2 pl-5 pr-2 text-sm font-semibold text-[#0058bc] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#0070eb]/[0.14] active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                        >
                          Start a focus session
                          <span
                            aria-hidden
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-[#0070eb]/10 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-105 group-active:scale-90"
                          >
                            <Plus size={14} weight="light" />
                          </span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Focus history as a ruled logbook */}
                  <motion.section
                    aria-label="Focus logbook"
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1], delay: 0.08 }}
                    className="rounded-[2rem] bg-white p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.04),0_12px_32px_-16px_rgba(16,24,40,0.12)] ring-1 ring-[#e5e5ea]"
                  >
                    <div className="overflow-hidden rounded-[calc(2rem-0.375rem)] border border-[#e5e5ea]/70 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                      <div className="flex items-center justify-between gap-2 border-b border-[#e5e5ea] px-4 py-3 sm:px-5">
                        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-[#1a1b1f]">
                          <Timer size={14} weight="light" className="shrink-0 text-[#0058bc]/70" aria-hidden />
                          Focus logbook
                        </h3>
                        <span className="tnum shrink-0 whitespace-nowrap rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-2 py-0.5 font-mono text-[11px] text-[#414755]">
                          {trips.length} recorded
                        </span>
                      </div>
                    {tripsPending && trips.length === 0 ? (
                      <div
                        className="space-y-2 p-4"
                        aria-busy="true"
                        aria-label="Loading focus logbook"
                      >
                        {Array.from({ length: 3 }).map((_, i) => (
                          <div key={i} className="skeleton h-14 w-full rounded-xl" />
                        ))}
                      </div>
                    ) : tripsError && trips.length === 0 ? (
                      <div className="flex min-h-28 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
                        <p className="text-sm font-medium text-[#414755]">
                          Couldn&apos;t load the focus logbook.
                        </p>
                        <p className="max-w-sm text-[12px] leading-relaxed text-ink-3">
                          Focus sessions couldn&apos;t be read. Retry to load them again.
                        </p>
                        <button
                          type="button"
                          onClick={() => void refetchTrips()}
                          disabled={tripsFetching}
                          className="mt-1 inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-[#0070eb]/40 bg-[#0070eb]/[0.08] px-4 py-1.5 text-[12px] font-semibold text-[#0058bc] transition-colors hover:bg-[#0070eb]/[0.14] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:scale-[0.97] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none"
                        >
                          <ArrowsClockwise
                            size={13}
                            weight="bold"
                            className={tripsFetching ? "animate-spin motion-reduce:animate-none" : undefined}
                            aria-hidden="true"
                          />
                          Retry
                        </button>
                      </div>
                    ) : trips.length === 0 ? (
                      <div className="flex h-28 items-center justify-center px-4 text-sm text-ink-3">
                        Nothing logged yet. Finished focus sessions land here.
                      </div>
                    ) : (
                      <ol className="divide-y divide-[#e5e5ea]">
                        {[...trips]
                          .sort(
                            (a, b) =>
                              new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
                          )
                          .map((t, i) => {
                            const live = t.active || !t.stopped_at;
                            const dur = t.stopped_at
                              ? fmtDurationMs(
                                  new Date(t.stopped_at).getTime() -
                                    new Date(t.started_at).getTime(),
                                )
                              : fmtDurationMs(clockNow - new Date(t.started_at).getTime());
                            const reason = t.stop_reason
                              ? {
                                  label: stopReasonLabel(t.stop_reason),
                                  cls: STOP_REASON_CLS[t.stop_reason] ?? STOP_REASON_CLS.manual,
                                }
                              : null;
                            const scopeText =
                              t.scope.kind === "all"
                                ? "All clients"
                                : t.scope.clients.join(", ");
                            const stopText =
                              t.stop.kind === "after"
                                ? `Stops after ${t.stop.hours} h`
                                : t.stop.kind === "idle"
                                  ? `Stops after ${t.stop.minutes} min idle`
                                  : "Manual stop";
                            return (
                              <motion.li
                                key={t.trip_id}
                                initial={{ opacity: 0, y: 12 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{
                                  duration: 0.5,
                                  ease: [0.32, 0.72, 0, 1],
                                  delay: Math.min(i * 0.05, 0.3),
                                }}
                                className="group flex flex-col gap-2.5 px-4 py-3.5 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#0070eb]/[0.03] sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-6 sm:gap-y-2 sm:px-5"
                              >
                                <div className="min-w-0 sm:min-w-[14rem] sm:flex-1">
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => openFocusTrip(t.trip_id)}
                                      title={`Open ${t.name}`}
                                      aria-label={`Open focus session ${t.name}`}
                                      className="min-w-[6rem] flex-1 truncate rounded-md text-left text-sm font-semibold text-[#1a1b1f] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[#0058bc] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white motion-reduce:transition-none"
                                    >
                                      {t.name}
                                    </button>
                                    {live ? (
                                      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[#0070eb]/30 bg-[#0070eb]/[0.08] px-2 py-0.5 font-mono text-[11px] text-[#0058bc]">
                                        <span className="breathe h-1.5 w-1.5 shrink-0 rounded-full bg-[#0070eb]" aria-hidden="true" />
                                        Live
                                      </span>
                                    ) : reason ? (
                                      <span
                                        className={cn(
                                          "shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px]",
                                          reason.cls,
                                        )}
                                      >
                                        {reason.label}
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="mt-1 truncate text-xs text-ink-3">{scopeText}</p>
                                  <p className="mt-0.5 text-xs text-ink-3">{stopText}</p>
                                </div>
                                <dl className="tnum grid min-w-0 grid-cols-3 gap-x-3 gap-y-1 font-mono text-[11px] sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-5 sm:text-right">
                                  <div className="min-w-0">
                                    <dt className="text-ink-3">Started</dt>
                                    <dd className="mt-0.5 whitespace-nowrap text-[#414755]">
                                      {fmtStamp(t.started_at)}
                                    </dd>
                                  </div>
                                  <div className="min-w-0">
                                    <dt className="text-ink-3">Stopped</dt>
                                    <dd className="mt-0.5 whitespace-nowrap text-[#414755]">
                                      {fmtStamp(t.stopped_at)}
                                    </dd>
                                  </div>
                                  <div className="min-w-0">
                                    <dt className="text-ink-3">Length</dt>
                                    <dd className="mt-0.5 whitespace-nowrap text-[#1a1b1f]">{dur}</dd>
                                  </div>
                                </dl>
                                <div className="flex shrink-0 items-center gap-1 sm:ml-auto sm:justify-end">
                                  <button
                                    type="button"
                                    title="Open focus session"
                                    aria-label={`Open ${t.name}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openFocusTrip(t.trip_id);
                                    }}
                                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-semibold text-[#0058bc] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#0070eb]/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:scale-[0.97] motion-reduce:transition-none"
                                  >
                                    Open
                                    <CaretRight size={12} weight="bold" aria-hidden="true" />
                                  </button>
                                  <button
                                    type="button"
                                    title="Share focus session"
                                    aria-label={`Share ${t.name}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setShareTripId(t.trip_id);
                                    }}
                                    className="rounded-md p-1.5 text-ink-3 opacity-80 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-black/[0.04] hover:text-[#1a1b1f] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#0070eb]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white motion-reduce:transition-none"
                                  >
                                    <ShareNetwork size={14} weight="light" aria-hidden="true" />
                                  </button>
                                </div>
                              </motion.li>
                            );
                          })}
                      </ol>
                    )}
                    {trips.length > 0 && (
                      <div className="border-t border-[#e5e5ea] px-4 py-3 sm:px-5">
                        <p className="text-xs text-ink-3" role="status">
                          {trips.length} recorded focus{" "}
                          {trips.length === 1 ? "session" : "sessions"}
                        </p>
                      </div>
                    )}
                    </div>
                  </motion.section>
                    </>
                  )}
                </div>
              )}

              {page === "cards" && <PngCards snap={snap} />}

              {page === "settings" && (
                <SettingsView
                  live={live}
                  scanning={scanning}
                  scanMsg={scanMsg}
                  onScan={scan}
                  knownClients={knownClients}
                  clientStats={clientStats}
                  filters={{ clients, since, until }}
                  updater={updater}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      </div>

      {tripModal && (
        <TripSetupModal
          onClose={() => setTripModal(false)}
          allClients={knownClients}
          running={!!runningTrip}
          onStarted={(trip) => {
            openFocusTrip(trip.trip_id);
            setPage("trips");
            queryClient.invalidateQueries({ queryKey: ["trips"] });
          }}
        />
      )}
      {shareTripId && (
        <SessionShareModal tripId={shareTripId} onClose={() => setShareTripId(null)} />
      )}
      <UpdateToasts updater={updater} />
    </div>
    </MotionConfig>
  );
}

/* ───────────────────────── Projects / Workspaces view ───────────────────── */

type ProjSort = "last" | "tokens" | "cost" | "sessions" | "messages";

const PROJ_SORTS: { id: ProjSort; label: string }[] = [
  { id: "last", label: "Last Active" },
  { id: "tokens", label: "Tokens" },
  { id: "cost", label: "Cost" },
  { id: "sessions", label: "Sessions" },
  { id: "messages", label: "Messages" },
];

function ProjectsView({
  snap,
  loading,
}: {
  snap: import("./lib/tauri").UsageSnapshotDTO | undefined;
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjSort>("last");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const rows = useMemo(() => {
    const list = snap?.projects ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter((p) =>
          [p.workspace_label, p.workspace_key, p.top_model ?? "", (p.clients ?? []).join(" ")]
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : list;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case "tokens":
          return b.tokens - a.tokens;
        case "cost":
          return b.cost - a.cost;
        case "sessions":
          return b.sessions - a.sessions;
        case "messages":
          return b.messages - a.messages;
        default:
          return (b.last_seen ?? 0) - (a.last_seen ?? 0);
      }
    });
    return sorted;
  }, [snap, query, sort]);

  const totalTokens = rows.reduce((a, p) => a + p.tokens, 0) || 1;
  const totalCount = (snap?.projects ?? []).length;
  const totalSessions = (snap?.projects ?? []).reduce((a, p) => a + p.sessions, 0);
  const topWorkspace = [...(snap?.projects ?? [])].sort((a, b) => b.tokens - a.tokens)[0];
  const activeSortLabel =
    PROJ_SORTS.find((s) => s.id === sort)?.label ?? "Last active";

  const copyPath = async (p: ProjectRowDTO) => {
    try {
      await navigator.clipboard.writeText(p.workspace_key);
      setCopiedKey(p.workspace_key);
      window.setTimeout(() => setCopiedKey((k) => (k === p.workspace_key ? null : k)), 1600);
    } catch {
      /* clipboard unavailable — fail silently */
    }
  };

  if (loading && !snap)
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-10 w-full rounded-xl" />
        ))}
      </div>
    );

  return (
    <div className="min-w-0 space-y-4">
      {/* Workspace ledger — Stitch Cupertino Telemetry LIGHT: white card, hairlines */}
      <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">
        <div>
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-outline-variant/30 bg-surface-container-low px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
            Workspace ledger
          </p>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch sm:divide-x sm:divide-outline-variant/30">
          <div className="min-w-0 sm:flex-1 sm:pr-5">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-on-surface-variant">
              <Folders size={13} className="shrink-0 text-outline" aria-hidden="true" /> Workspaces
            </p>
            <p className="tnum mt-1.5 font-mono text-[28px] font-semibold leading-none tracking-tight whitespace-nowrap text-on-surface">
              {totalCount.toLocaleString()}
            </p>
            <p className="tnum mt-1.5 font-mono text-[11px] leading-relaxed whitespace-nowrap text-outline">
              {rows.length === totalCount
                ? `${totalCount.toLocaleString()} shown`
                : `${rows.length.toLocaleString()} of ${totalCount.toLocaleString()} shown`}
            </p>
          </div>
          <div className="min-w-0 border-t border-outline-variant/30 pt-4 sm:flex-[1.4] sm:border-t-0 sm:px-5 sm:pt-0">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-on-surface-variant">
              <Cube size={13} className="shrink-0 text-outline" aria-hidden="true" /> Top workspace by tokens
            </p>
            {topWorkspace ? (
              <>
                <p
                  className="mt-1.5 truncate text-[15px] font-semibold leading-snug text-on-surface"
                  title={topWorkspace.workspace_key}
                >
                  {topWorkspace.workspace_label}
                </p>
                <p className="tnum mt-1 font-mono text-[12px] whitespace-nowrap text-primary">
                  {fmtTokens(topWorkspace.tokens)}
                  <span className="ml-1.5 text-outline">
                    {fmtPct(topWorkspace.tokens / totalTokens)}
                  </span>
                </p>
              </>
            ) : (
              <p className="mt-1.5 text-[15px] text-outline">No workspaces yet</p>
            )}
          </div>
          <div className="min-w-0 border-t border-outline-variant/30 pt-4 sm:flex-1 sm:border-t-0 sm:pl-5 sm:pt-0">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-on-surface-variant">
              <ListMagnifyingGlass size={13} className="shrink-0 text-outline" aria-hidden="true" /> Sessions mapped
            </p>
            <p className="tnum mt-1.5 font-mono text-[28px] font-semibold leading-none tracking-tight whitespace-nowrap text-on-surface">
              {totalSessions.toLocaleString()}
            </p>
            <p className="tnum mt-1.5 font-mono text-[11px] leading-relaxed whitespace-nowrap text-outline">
              across {totalCount.toLocaleString()}{" "}
              {totalCount === 1 ? "workspace" : "workspaces"}
            </p>
          </div>
          </div>
        </div>
      </div>

      {/* Search + sort controls — Cupertino pill controls */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="relative w-full shrink-0 sm:w-64">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-outline"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by path, model, client…"
            aria-label="Filter workspaces"
            className="h-9 w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest py-1.5 pl-9 pr-8 text-[13px] text-on-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors placeholder:text-outline hover:border-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 motion-reduce:transition-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="Clear filter"
              aria-label="Clear workspace filter"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.98] motion-reduce:transition-none"
            >
              <X size={12} weight="bold" />
            </button>
          )}
        </div>
        <span
          className="tnum shrink-0 font-mono text-[11px] whitespace-nowrap text-outline"
          role="status"
          aria-live="polite"
        >
          {rows.length.toLocaleString()} shown · {activeSortLabel.toLowerCase()}
        </span>
        <span className="mx-0.5 hidden h-4 w-px bg-outline-variant/40 sm:inline-block" aria-hidden="true" />
        <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Sort workspaces">
          <span className="mr-0.5 inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium text-on-surface-variant">
            <ArrowsDownUp size={11} aria-hidden="true" /> Sort
          </span>
          {PROJ_SORTS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSort(s.id)}
              aria-pressed={sort === s.id}
              className={cn(
                "whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.98] motion-reduce:transition-none",
                sort === s.id
                  ? "border-transparent bg-on-surface font-semibold text-surface-container-lowest shadow-sm"
                  : "border-outline-variant/30 bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container hover:text-on-surface",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Workspaces table — white card, hairline rows, blue accent */}
      {!snap ? (
        <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest p-6 text-[13px] text-on-surface-variant shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest p-6 shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">
          <div className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low px-6 py-10 text-center">
            <p className="text-sm font-semibold text-on-surface">
              {query ? "No workspaces match this filter" : "No projects yet"}
            </p>
            <p className="max-w-sm text-[12px] leading-relaxed text-on-surface-variant">
              {query
                ? "Clear the filter or try a shorter path fragment, model name, or client."
                : "Run a session in a workspace and rescan — projects appear here once local logs are parsed."}
            </p>
            {query && (
              <button
                onClick={() => setQuery("")}
                className="mt-3 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3 py-1 text-[11px] font-medium text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.98] motion-reduce:transition-none"
              >
                Clear filter
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-outline-variant/30 bg-surface-container-lowest shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">
          <div className="flex items-center justify-between gap-2 border-b border-outline-variant/30 px-5 py-3">
            <div className="min-w-0">
              <h3 className="truncate text-[14px] font-semibold tracking-tight text-on-surface">Workspaces</h3>
              <p className="truncate text-[12px] text-on-surface-variant">Ranked by token share across every mapped project</p>
            </div>
            <p className="tnum hidden shrink-0 rounded-full border border-outline-variant/30 bg-surface-container-low px-2 py-0.5 font-mono text-[11px] whitespace-nowrap text-on-surface-variant sm:inline" role="status">
              {rows.length.toLocaleString()} rows · {activeSortLabel.toLowerCase()}
            </p>
          </div>
          <div className="min-w-0 max-w-full overflow-x-auto">
          <table className="w-full min-w-[720px] table-auto border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-outline-variant/30 bg-surface-container-low text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                <th scope="col" className="w-8 px-2 py-2.5 pl-4 font-mono font-medium text-outline">
                  #
                </th>
                <th scope="col" className="min-w-[140px] px-2.5 py-2.5 font-semibold">
                  Workspace
                </th>
                <th scope="col" className="w-[130px] px-2.5 py-2.5 font-semibold">
                  Clients
                </th>
                <th scope="col" className="w-[140px] px-2.5 py-2.5 font-semibold">
                  Top model
                </th>
                <th scope="col" className="whitespace-nowrap px-2.5 py-2.5 font-semibold">
                  Last active
                </th>
                <th scope="col" className="w-[110px] whitespace-nowrap px-2.5 py-2.5 font-semibold">
                  Share
                </th>
                <th scope="col" className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
                  Sessions
                </th>
                <th scope="col" className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
                  Messages
                </th>
                <th scope="col" className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
                  Tokens
                </th>
                <th scope="col" className="whitespace-nowrap px-2 py-2.5 pr-4 text-right font-semibold">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20">
              {rows.map((p, idx) => {
                const share = Math.max(0, Math.min(1, p.tokens / totalTokens));
                const clients = p.clients ?? [];
                const visibleClients = clients.slice(0, 2);
                const hiddenCount = clients.length - visibleClients.length;
                const copied = copiedKey === p.workspace_key;
                return (
                  <tr
                    key={p.workspace_key}
                    className="group align-middle transition-colors hover:bg-surface-container-low/70 motion-reduce:transition-none"
                  >
                    <td className="tnum whitespace-nowrap px-2 py-2.5 pl-4 font-mono text-[11px] text-outline transition-colors group-hover:text-on-surface-variant motion-reduce:transition-none">
                      {String(idx + 1).padStart(2, "0")}
                    </td>
                    <td className="min-w-[140px] max-w-[240px] px-2.5 py-2.5">
                      <div className="min-w-0">
                        <p
                          className="line-clamp-2 break-words text-[13px] font-semibold leading-snug text-on-surface"
                          title={p.workspace_label}
                        >
                          {p.workspace_label}
                        </p>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1">
                          <p
                            className="tnum min-w-0 flex-1 truncate font-mono text-[11px] leading-relaxed text-on-surface-variant"
                            title={p.workspace_key}
                          >
                            {p.workspace_key}
                          </p>
                          <button
                            onClick={() => copyPath(p)}
                            title={copied ? "Copied" : "Copy workspace path"}
                            aria-label={copied ? "Path copied" : `Copy path ${p.workspace_key}`}
                            className="shrink-0 rounded-md p-1 text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.95] motion-reduce:transition-none sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100"
                          >
                            {copied ? (
                              <Check size={12} className="text-emerald-600" aria-hidden="true" />
                            ) : (
                              <Copy size={12} aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[150px] px-2.5 py-2.5">
                      {clients.length > 0 ? (
                        <div
                          className="flex min-w-0 items-center gap-1 overflow-hidden"
                          title={clients.join(", ")}
                        >
                          {visibleClients.map((c) => {
                            const v = getClientVisual(c);
                            return (
                              <span
                                key={c}
                                title={v.label}
                                className="inline-flex min-w-0 max-w-[88px] items-center gap-1 truncate rounded-full border border-outline-variant/40 bg-surface-container-low px-1.5 py-0.5 text-[11px] font-medium leading-tight text-on-surface-variant"
                              >
                                <span
                                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: v.hex }}
                                  aria-hidden="true"
                                />
                                <span className="truncate">{v.label}</span>
                              </span>
                            );
                          })}
                          {hiddenCount > 0 && (
                            <span
                              className="tnum shrink-0 rounded-full border border-outline-variant/30 bg-surface-container-low px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-on-surface-variant"
                              title={clients.join(", ")}
                            >
                              +{hiddenCount}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-outline">—</span>
                      )}
                    </td>
                    <td className="max-w-[160px] px-2.5 py-2.5">
                      {p.top_model ? (
                        <span
                          title={p.top_model}
                          className="tnum inline-block max-w-full truncate break-words rounded-md border border-outline-variant/30 bg-surface-container-low px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-on-surface-variant"
                        >
                          {p.top_model}
                        </span>
                      ) : (
                        <span className="text-[11px] text-outline">—</span>
                      )}
                    </td>
                    <td
                      className="tnum whitespace-nowrap px-2.5 py-2.5 font-mono text-[11px] text-on-surface-variant"
                      title={
                        p.last_seen ? new Date(p.last_seen).toLocaleString() : undefined
                      }
                    >
                      {relTime(p.last_seen)}
                    </td>
                    <td className="px-2.5 py-2.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <div
                          className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-surface-container-high"
                          role="img"
                          aria-label={`Share ${fmtPct(share)} of workspace tokens`}
                          title={`Share ${fmtPct(share)}`}
                        >
                          <div
                            className="h-full w-full origin-left rounded-full bg-primary transition-transform motion-reduce:transition-none"
                            style={{ transform: `scaleX(${p.tokens > 0 ? Math.max(share, 0.02) : 0})` }}
                          />
                        </div>
                        <span className="tnum w-10 shrink-0 whitespace-nowrap font-mono text-[11px] text-on-surface-variant">
                          {fmtPct(share)}
                        </span>
                      </div>
                    </td>
                    <td className="tnum whitespace-nowrap px-2 py-2.5 text-right font-mono text-[12px] text-on-surface-variant">
                      {p.sessions.toLocaleString()}
                    </td>
                    <td className="tnum whitespace-nowrap px-2 py-2.5 text-right font-mono text-[12px] text-on-surface-variant">
                      {p.messages.toLocaleString()}
                    </td>
                    <td className="tnum whitespace-nowrap px-2 py-2.5 text-right font-mono text-[12px] font-semibold text-on-surface">
                      {fmtTokens(p.tokens)}
                    </td>
                    <td
                      className="tnum whitespace-nowrap px-2 py-2.5 pr-4 text-right font-mono text-[12px] font-medium text-on-surface"
                      title={`Exact: ${fmtCostPrecise(p.cost)}`}
                    >
                      {fmtCostPrecise(p.cost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Model telemetry table ────────────────────────── */

type ModelSort = "model" | "client" | "input" | "output" | "cache_read" | "reasoning" | "tokens" | "cost";

function ModelTelemetryTable({
  models,
  loading,
}: {
  models: ModelRowDTO[];
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: ModelSort; dir: "asc" | "desc" }>({
    key: "tokens",
    dir: "desc",
  });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? models.filter((m) =>
          [m.model, m.provider, m.client].join(" ").toLowerCase().includes(q),
        )
      : models;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      const dir = sort.dir === "asc" ? 1 : -1;
      switch (sort.key) {
        case "model":
          return dir * a.model.localeCompare(b.model);
        case "client":
          return dir * a.client.localeCompare(b.client);
        case "input":
          return dir * (a.input - b.input);
        case "output":
          return dir * (a.output - b.output);
        case "cache_read":
          return dir * (a.cache_read - b.cache_read);
        case "reasoning":
          return dir * (a.reasoning - b.reasoning);
        case "cost":
          return dir * (a.cost - b.cost);
        default:
          return dir * (a.tokens - b.tokens);
      }
    });
    return sorted;
  }, [models, query, sort]);

  const toggleSort = (key: ModelSort) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "model" || key === "client" ? "asc" : "desc" },
    );

  const Th = ({
    label,
    k,
    align = "right",
  }: {
    label: string;
    k: ModelSort;
    align?: "left" | "right";
  }) => {
    const active = sort.key === k;
    const ariaSort: "ascending" | "descending" | "none" =
      sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
    return (
      <th
        aria-sort={ariaSort}
        className={cn("whitespace-nowrap px-2 py-2.5 font-sans text-[11px] font-semibold uppercase tracking-wider", align === "right" ? "text-right" : "text-left")}
      >
        <button
          type="button"
          onClick={() => toggleSort(k)}
          title={`Sort by ${label}`}
          aria-label={`Sort by ${label}, ${active ? (sort.dir === "asc" ? "ascending" : "descending") : "not sorted"}`}
          className={cn(
            "group inline-flex items-center gap-1 rounded-md transition-colors hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.97] motion-reduce:transition-none",
            active ? "font-semibold text-on-surface" : "text-on-surface-variant",
            align === "right" && "flex-row-reverse",
          )}
        >
          {label}
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
            {active ? (
              sort.dir === "asc" ? (
                <CaretUp size={12} weight="bold" className="text-primary" aria-hidden="true" />
              ) : (
                <CaretDown size={12} weight="bold" className="text-primary" aria-hidden="true" />
              )
            ) : (
              <span className="text-outline opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                <ArrowsDownUp size={11} aria-hidden="true" />
              </span>
            )}
          </span>
        </button>
      </th>
    );
  };

  const totalModelTokens = models.reduce((a, m) => a + m.tokens, 0) || 1;

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-outline-variant/30 bg-surface-container-lowest shadow-[0_1px_3px_rgba(0,0,0,0.02),0_4px_12px_rgba(0,0,0,0.03)]">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-outline-variant/30 px-5 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
            <Cube size={15} />
          </span>
          <h3 className="truncate text-[14px] font-semibold tracking-tight text-on-surface">
            Model telemetry
          </h3>
          <span className="tnum shrink-0 rounded-full border border-outline-variant/30 bg-surface-container-low px-2 py-0.5 font-mono text-[11px] whitespace-nowrap text-on-surface-variant">
            {rows.length} of {models.length}
          </span>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
          <span className="tnum hidden whitespace-nowrap font-mono text-[11px] text-outline md:inline" role="status">
            {fmtTokens(totalModelTokens)} total
          </span>
          <div className="relative min-w-0 flex-1 sm:w-60 sm:flex-none">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-outline"
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by model, provider, client…"
              aria-label="Filter models"
              className="h-9 w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest py-1.5 pl-9 pr-8 text-[13px] text-on-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors placeholder:text-outline hover:border-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 motion-reduce:transition-none"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                title="Clear filter"
                aria-label="Clear model filter"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.98] motion-reduce:transition-none"
              >
                <X size={12} weight="bold" />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="min-w-0 max-w-full overflow-x-auto">
      {loading && models.length === 0 ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-9 w-full rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-1 px-6 py-10 text-center">
          <p className="text-sm font-semibold text-on-surface">
            {query ? "No models match this filter" : "No model telemetry yet"}
          </p>
          <p className="max-w-sm text-[12px] leading-relaxed text-on-surface-variant">
            {query
              ? "Clear the filter or try a shorter model or provider fragment."
              : "Run a session and rescan — per-model tokens, cache, and reasoning appear here."}
          </p>
          {query && (
            <button
              onClick={() => setQuery("")}
              className="mt-3 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3 py-1 text-[11px] font-medium text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.98] motion-reduce:transition-none"
            >
              Clear filter
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="sr-only" role="status" aria-live="polite">
            {rows.length} models shown, sorted by {sort.key} {sort.dir === "asc" ? "ascending" : "descending"}
          </p>
          <table className="w-full min-w-[720px] table-auto border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-outline-variant/30 bg-surface-container-low text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
              <th scope="col" className="w-8 px-2 py-2.5 pl-4 font-mono font-medium text-outline">
                #
              </th>
              <Th label="Model" k="model" align="left" />
              <th scope="col" className="whitespace-nowrap px-2.5 py-2.5 text-left font-sans text-[11px] font-semibold uppercase tracking-wider">
                Client &amp; provider
              </th>
              <Th label="Input" k="input" />
              <Th label="Output" k="output" />
              <Th label="Cache read" k="cache_read" />
              <Th label="Reasoning" k="reasoning" />
              <Th label="Total tokens" k="tokens" />
              <Th label="Total cost" k="cost" />
            </tr>
          </thead>
          <tbody className="tnum divide-y divide-outline-variant/20">
            {rows.map((m, i) => {
              const v = getClientVisual(m.client);
              const hit = m.cache_read / Math.max(1, m.cache_read + m.input);
              const share = Math.max(0, Math.min(1, m.tokens / totalModelTokens));
              return (
                <tr key={`${m.client}-${m.model}-${m.provider}-${i}`} className="group transition-colors hover:bg-surface-container-low/70 motion-reduce:transition-none">
                  <td className="whitespace-nowrap px-2 py-2.5 pl-4 font-mono text-[11px] text-outline transition-colors group-hover:text-on-surface-variant motion-reduce:transition-none">
                    {String(i + 1).padStart(2, "0")}
                  </td>
                  <td className="min-w-[120px] max-w-[180px] px-2.5 py-2.5">
                    <p className="line-clamp-2 break-words font-mono text-[13px] leading-snug text-on-surface" title={m.model}>
                      {m.model}
                    </p>
                    <p
                      className="tnum mt-0.5 truncate font-mono text-[11px] whitespace-nowrap text-outline"
                      title={`${m.messages.toLocaleString()} messages`}
                    >
                      {m.messages.toLocaleString()} msgs
                    </p>
                  </td>
                  <td className="max-w-[160px] px-2.5 py-2.5">
                    <div className="flex min-w-0 items-center gap-1">
                      <span
                        title={v.label}
                        className="inline-flex min-w-0 max-w-[84px] items-center gap-1 truncate rounded-full border border-outline-variant/40 bg-surface-container-low px-1.5 py-0.5 text-[11px] font-medium leading-tight text-on-surface-variant"
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: v.hex }}
                          aria-hidden="true"
                        />
                        <span className="truncate">{v.label}</span>
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[11px] text-on-surface-variant"
                        title={m.provider}
                      >
                        {m.provider}
                      </span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right font-mono text-[12px] text-on-surface-variant">
                    {fmtTokens(m.input)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right font-mono text-[12px] text-on-surface-variant">
                    {fmtTokens(m.output)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5">
                    <div className="flex min-w-0 items-center justify-end gap-1">
                      <span className="tnum shrink-0 font-mono text-[12px] whitespace-nowrap text-on-surface-variant">{fmtTokens(m.cache_read)}</span>
                      <span
                        className={cn(
                          "tnum whitespace-nowrap rounded-full border px-1.5 py-0.5 font-mono text-[10px]",
                          hit >= 0.5
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : hit > 0
                              ? "border-outline-variant/30 bg-surface-container-low text-on-surface-variant"
                              : "border-outline-variant/20 bg-surface-container-low text-outline",
                        )}
                        title={`Cache hit ${fmtPct(hit)} of input + cache read`}
                      >
                        {fmtPct(hit)}
                      </span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right font-mono text-[12px] text-on-surface-variant">
                    {fmtTokens(m.reasoning)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right">
                    <span className="tnum font-mono text-[12px] font-semibold whitespace-nowrap text-on-surface">
                      {fmtTokens(m.tokens)}
                    </span>
                    <span
                      className="mx-auto mt-1 block h-1 w-12 overflow-hidden rounded-full bg-surface-container-high"
                      role="img"
                      aria-label={`Share ${fmtPct(share)} of model tokens`}
                      title={`Share ${fmtPct(share)}`}
                    >
                      <span
                        className="block h-full w-full origin-left rounded-full bg-primary transition-transform motion-reduce:transition-none"
                        style={{ transform: `scaleX(${m.tokens > 0 ? Math.max(share, 0.02) : 0})` }}
                      />
                    </span>
                  </td>
                  <td
                    className="tnum whitespace-nowrap px-2 py-2.5 pr-4 text-right font-mono text-[12px] font-medium text-on-surface"
                    title={`Exact: ${fmtCostPrecise(m.cost)}`}
                  >
                    {fmtCostPrecise(m.cost)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          </table>
          </>
      )}
      </div>
    </div>
  );
}

/* ───────────────────────────── Settings page ────────────────────────────── */

function SettingsView({
  live,
  scanning,
  scanMsg,
  onScan,
  knownClients,
  clientStats,
  filters,
  updater,
}: {
  live: { watching: boolean; last_scan_at: string | null; pending_files: number; errors: string[] } | undefined;
  scanning: boolean;
  scanMsg: string | null;
  onScan: () => void;
  knownClients: string[];
  clientStats: Record<string, ClientStat>;
  filters: { clients: string[]; since: string | null; until: string | null };
  updater: ReturnType<typeof useUpdater>;
}) {
  return (
    <div className="space-y-4 rounded-[24px] border border-[#e5e5ea] bg-[#faf9fe] p-4 text-[#1a1b1f] sm:p-5">
      <style>{`.tt-rise{animation:tt-rise .7s cubic-bezier(0.22,1,0.36,1) both}@keyframes tt-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@media (prefers-reduced-motion: reduce){.tt-rise{animation:none}}`}</style>
      {/* telemetry masthead */}
      <div
        className="tt-rise flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e5e5ea] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        style={{ animationDelay: "0ms" }}
      >
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#414755]">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#0070eb]" />
            System ledger
          </span>
          <p className="mt-2 max-w-md text-[12px] leading-relaxed text-ink-3">
            Watcher state, supported clients, and privacy architecture — everything below happens
            on this machine.
          </p>
        </div>
        {live?.watching ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#0070eb]/25 bg-[#0070eb]/10 px-3 py-1 font-mono text-[10px] font-semibold tracking-[0.14em] text-[#0058bc]" role="status">
            <span aria-hidden className="breathe inline-flex h-1.5 w-1.5 rounded-full bg-[#0070eb]" />
            WATCHING
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-1 font-mono text-[10px] tracking-[0.14em] text-ink-3" role="status">
            <span aria-hidden className="inline-flex h-1.5 w-1.5 rounded-full bg-[#8e8e93]" />
            STANDBY
          </span>
        )}
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-12">
      {/* Live watcher & scanner */}
      <div
        className="tt-rise lg:col-span-7"
        style={{ animationDelay: "60ms" }}
      >
      <section
        aria-label="Watcher and scanner"
        className="rounded-[20px] border border-[#e5e5ea] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#414755]">
          <Lightning size={11} weight="bold" className="text-[#0070eb]" aria-hidden />
          Watcher
        </span>
        <h3 className="mt-2 text-[15px] font-semibold tracking-tight text-[#1c1c1e]">
          Watcher and scanner
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
          TokenTracker reads agent logs on this machine and refreshes the moment they change.
        </p>
        <div className="mt-4 divide-y divide-[#f2f2f7] border-y border-[#f2f2f7]">
          <div className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
            <span className="text-ink-3">File watcher</span>
            {live?.watching ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#0070eb]/25 bg-[#0070eb]/10 px-2.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-[#0058bc]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#0070eb] motion-reduce:animate-none" aria-hidden />
                WATCHING
              </span>
            ) : (
              <span className="rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-2.5 py-0.5 font-mono text-[10px] tracking-wider text-ink-3">
                STANDBY
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
            <span className="text-ink-3">Last scan</span>
            <span className="tnum font-mono text-xs text-[#1c1c1e]">
              {live?.last_scan_at
                ? `${new Date(live.last_scan_at).toLocaleTimeString()} (${relTime(new Date(live.last_scan_at).getTime())})`
                : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
            <span className="text-ink-3">Pending files</span>
            <span className="tnum font-mono text-xs text-[#1c1c1e]">
              {(live?.pending_files ?? 0).toLocaleString()}
            </span>
          </div>
        </div>
        <div className="mt-4 space-y-2.5">
          {scanMsg && (
            <p role="status" className="tnum px-1 font-mono text-[11px] text-ink-3">
              {scanMsg}
            </p>
          )}
          <button
            onClick={onScan}
            disabled={scanning}
            aria-busy={scanning}
            aria-label={scanning ? "Rescanning logs" : "Rescan logs now"}
            className="group flex w-full items-center justify-between gap-3 rounded-xl bg-[#0070eb] py-1.5 pl-4 pr-1.5 text-[13px] font-semibold text-white shadow-sm transition-all duration-300 ease-out hover:bg-[#0058bc] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none"
          >
            <span className="flex items-center gap-2">
              <ArrowsClockwise
                size={14}
                weight="bold"
                className={scanning ? "animate-spin motion-reduce:animate-none" : undefined}
                aria-hidden
              />
              {scanning ? "Rescanning…" : "Rescan now"}
            </span>
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-white transition-transform duration-300 ease-out group-active:scale-95 motion-reduce:transition-none"
            >
              <ArrowsClockwise
                size={14}
                weight="bold"
                className={scanning ? "animate-spin motion-reduce:animate-none" : undefined}
              />
            </span>
          </button>
          {(live?.errors ?? []).length > 0 && (
            <ul className="space-y-1 rounded-xl border border-red-200 bg-red-50 p-2.5 text-[11px] text-red-700">
              {(live?.errors ?? []).map((e, i) => (
                <li key={i} className="font-mono">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      </div>

      {/* Supported clients */}
      <div
        className="tt-rise lg:col-span-5"
        style={{ animationDelay: "110ms" }}
      >
      <section
        aria-label="Supported agent clients"
        className="rounded-[20px] border border-[#e5e5ea] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#414755]">
          <ShareNetwork size={11} weight="bold" className="text-[#0070eb]" aria-hidden />
          Clients
        </span>
        <h3 className="mt-2 text-[15px] font-semibold tracking-tight text-[#1c1c1e]">
          Supported agent clients
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
          Each client found in your local logs appears here with its session and token share.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {knownClients.length > 0 ? (
            knownClients.map((c) => {
              const v = getClientVisual(c);
              const stat = clientStats[c];
              return (
                <div
                  key={c}
                  className="flex items-center gap-2 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] px-2.5 py-2 transition-colors duration-300 ease-out motion-reduce:transition-none"
                >
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", v.dot)} aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-[#1c1c1e]">{v.label}</p>
                    {stat && (
                      <p className="tnum truncate font-mono text-[9px] text-ink-3">
                        {stat.sessions} sessions, {fmtTokens(stat.tokens)}
                      </p>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="col-span-2 text-xs text-ink-3">No clients detected yet.</p>
          )}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
          ~60 local agent log formats are parsed automatically via{" "}
          <span className="font-mono font-semibold text-[#0058bc]">tokscale-core v4.19.1</span> — detected
          clients appear here as their logs are discovered.
        </p>
      </section>
      </div>

      {/* Privacy & architecture */}
      <div
        className="tt-rise lg:col-span-5"
        style={{ animationDelay: "160ms" }}
      >
      <section
        aria-label="Privacy and architecture"
        className="rounded-[20px] border border-[#e5e5ea] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#414755]">
          <ShieldCheck size={11} weight="bold" className="text-[#0070eb]" aria-hidden />
          Privacy
        </span>
        <h3 className="mt-2 text-[15px] font-semibold tracking-tight text-[#1c1c1e]">
          Privacy and architecture
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
          Everything below happens on this machine. There is no account and no analytics.
        </p>
        <div className="mt-4 space-y-2.5">
          <div className="flex items-start gap-3 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] p-3">
            <Database size={16} className="mt-0.5 shrink-0 text-[#0070eb]" aria-hidden />
            <div>
              <p className="text-[13px] font-semibold text-[#1c1c1e]">100% local log parsing</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
                SQLite &amp; JSONL agent logs are read straight from disk and aggregated locally.
                Nothing ever leaves this machine.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] p-3">
            <Sparkle size={16} className="mt-0.5 shrink-0 text-[#0070eb]" aria-hidden />
            <div>
              <p className="text-[13px] font-semibold text-[#1c1c1e]">LiteLLM pricing math</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
                Costs are computed with LiteLLM's per-model price tables — input, output, cache
                read/write, and reasoning tokens priced separately.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl border border-[#e5e5ea] bg-[#f4f3f8] p-3">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[#0070eb]" aria-hidden />
            <div>
              <p className="text-[13px] font-semibold text-[#1c1c1e]">Zero telemetry</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
                No analytics, no phone-home, no accounts. Updates are stable-channel only and never
                install without your click.
              </p>
            </div>
          </div>
        </div>
      </section>
      </div>

      {/* Active filters */}
      <div
        className="tt-rise lg:col-span-7"
        style={{ animationDelay: "210ms" }}
      >
      <section
        aria-label="Active filters"
        className="rounded-[20px] border border-[#e5e5ea] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#414755]">
          <Funnel size={11} weight="bold" className="text-[#0070eb]" aria-hidden />
          Scope
        </span>
        <h3 className="mt-2 text-[15px] font-semibold tracking-tight text-[#1c1c1e]">
          Active filters
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
          These filters shape every telemetry view, export card, and focus baseline.
        </p>
        <div className="tnum mt-4 divide-y divide-[#f2f2f7] border-y border-[#f2f2f7] font-mono text-[11px] text-[#414755]">
          <div className="flex items-center justify-between gap-3 py-2.5">
            <span className="shrink-0 text-ink-3">clients</span>
            <span className="min-w-0 truncate text-[#1c1c1e]" title={filters.clients.join(", ") || "all"}>
              [{filters.clients.join(", ") || "all"}]
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5">
            <span className="text-ink-3">since</span>
            <span className="text-[#1c1c1e]">{filters.since ?? "—"}</span>
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5">
            <span className="text-ink-3">until</span>
            <span className="text-[#1c1c1e]">{filters.until ?? "—"}</span>
          </div>
        </div>
      </section>
      </div>

      {/* App updates */}
      <div
        className="tt-rise lg:col-span-12"
        style={{ animationDelay: "260ms" }}
      >
      <section
        aria-label="App updates"
        className="rounded-[20px] border border-[#e5e5ea] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-[#f4f3f8] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#414755]">
          <ArrowsClockwise size={11} weight="bold" className="text-[#0070eb]" aria-hidden />
          Updates
        </span>
        <h3 className="mt-2 text-[15px] font-semibold tracking-tight text-[#1c1c1e]">
          App updates
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
          Stable channel only. Nothing downloads or installs without your click.
        </p>
        <div className="tnum mt-4 divide-y divide-[#f2f2f7] border-y border-[#f2f2f7] font-mono text-[11px] text-[#414755]">
          <div className="flex items-center justify-between gap-3 py-2.5">
            <span className="shrink-0 text-ink-3">installed</span>
            <span className="text-[#1c1c1e]">{updater.appVersion ? `v${updater.appVersion}` : "dev build"}</span>
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5">
            <span className="shrink-0 text-ink-3">last checked</span>
            <span className="text-[#1c1c1e]">
              {updater.lastCheckedAt
                ? new Date(updater.lastCheckedAt).toLocaleString()
                : updater.checkState.kind === "checking"
                  ? "checking…"
                  : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5">
            <span className="shrink-0 text-ink-3">status</span>
            <span className="text-[#1c1c1e]">
              {updater.restartPending
                ? "installed — restart pending"
                : updater.available
                  ? `v${updater.available.version} ready`
                  : updater.download.kind === "working"
                    ? updater.download.phase === "installing"
                      ? "installing…"
                      : "downloading…"
                    : updater.download.kind === "failed"
                      ? "download failed"
                      : updater.checkState.kind === "uptodate"
                        ? "up to date"
                        : updater.checkState.kind === "failed"
                          ? "check failed"
                          : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5">
            <span className="shrink-0 text-ink-3">download</span>
            <span className="tnum text-right font-mono text-[11px] text-[#1c1c1e]">
              {updater.download.kind === "working"
                ? updater.download.total != null
                  ? `${fmtBytes(updater.download.bytes)} of ${fmtBytes(updater.download.total)}`
                  : `${fmtBytes(updater.download.bytes)} so far`
                : updater.download.kind === "ready" || updater.restartPending
                  ? "installed — restart pending"
                  : updater.download.kind === "failed"
                    ? "failed — retry below"
                    : "—"}
            </span>
          </div>
        </div>
        <div className="mt-4 space-y-2.5">
          {updater.checkState.kind === "failed" && (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-2.5 text-[11px] text-red-700">
              {updater.checkError ?? "Couldn't reach the update server. Check your connection and try again."}
            </p>
          )}
          {updater.checkState.kind === "uptodate" && (
            <p role="status" className="tnum px-1 font-mono text-[11px] text-ink-3">
              You&apos;re up to date.
            </p>
          )}
          {updater.available && (
            <p role="status" className="rounded-xl border border-[#0070eb]/25 bg-[#0070eb]/10 p-2.5 text-[11px] text-[#0058bc]">
              v{updater.available.version} is ready — use the update notification to download and install it.
            </p>
          )}
          <p className="px-1 text-[11px] leading-relaxed text-ink-3">
            Icons look stale after updating? Unpin and re-pin the taskbar icon, or run{" "}
            <code className="tnum font-mono">ie4uinit.exe -show</code> and restart Explorer —
            Windows caches icons separately from the app.
          </p>
          <button
            onClick={() => void updater.checkNow()}
            disabled={updater.checkState.kind === "checking"}
            aria-busy={updater.checkState.kind === "checking"}
            aria-label={updater.checkState.kind === "checking" ? "Checking for updates" : "Check for updates now"}
            className="group flex w-full items-center justify-between gap-3 rounded-xl border border-[#e5e5ea] bg-white py-1.5 pl-4 pr-1.5 text-[13px] font-semibold text-[#1c1c1e] shadow-sm transition-all duration-300 ease-out hover:border-[#0070eb]/40 hover:text-[#0058bc] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none"
          >
            <span className="flex items-center gap-2">
              <ArrowsClockwise
                size={14}
                weight="bold"
                className={updater.checkState.kind === "checking" ? "animate-spin motion-reduce:animate-none" : undefined}
                aria-hidden
              />
              {updater.checkState.kind === "checking" ? "Checking…" : "Check for updates"}
            </span>
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0070eb]/10 text-[#0058bc] transition-transform duration-300 ease-out group-active:scale-95 motion-reduce:transition-none"
            >
              <ArrowsClockwise
                size={14}
                weight="bold"
                className={updater.checkState.kind === "checking" ? "animate-spin motion-reduce:animate-none" : undefined}
              />
            </span>
          </button>
          {updater.available && !updater.restartPending && updater.download.kind === "idle" && (
            <button
              onClick={() => void updater.startDownload()}
              aria-label={`Download update v${updater.available.version}`}
              className="w-full rounded-xl bg-[#0070eb] py-2 text-[13px] font-semibold text-white shadow-sm transition-all duration-300 ease-out hover:bg-[#0058bc] active:scale-[0.98] motion-reduce:transition-none"
            >
              Download update
            </button>
          )}
          {(updater.restartPending || updater.download.kind === "ready") && (
            <button
              onClick={() => void updater.relaunchNow()}
              aria-label="Restart now to apply the installed update"
              className="w-full rounded-xl bg-[#0070eb] py-2 text-[13px] font-semibold text-white shadow-sm transition-all duration-300 ease-out hover:bg-[#0058bc] active:scale-[0.98] motion-reduce:transition-none"
            >
              Restart now
            </button>
          )}
        </div>
      </section>
      </div>
      </div>
    </div>
  );
}
