import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CheckCircle, DownloadSimple, X } from "@phosphor-icons/react";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { cn } from "./lib/cn";

/** Notify-only updater: stable channel, everything user-gated via toasts. */
export type UpdateCheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; at: string }
  | { kind: "failed"; at: string };

export type UpdateDownloadState =
  | { kind: "idle" }
  | { kind: "working"; bytes: number; total: number | null; phase: "downloading" | "installing" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

/** No progress event for this long while downloading → treat as stalled. */
const STALL_TIMEOUT_MS = 60_000;
/** Hard ceiling for check + download + install before surfacing a timeout. */
const OVERALL_TIMEOUT_MS = 10 * 60_000;

/** Turn plugin/backend failures into actionable copy with a next step. */
function toUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const msg = raw.replace(/^Error:\s*/, "").trim();
  const lower = msg.toLowerCase();
  if (!msg || lower === "[object object]") {
    return "The update failed before any details arrived. Check your connection, then Retry.";
  }
  if (/(timeout|timed out|deadline)/.test(lower)) {
    return "The update timed out. Check your connection, then Retry.";
  }
  if (/(offline|network|econn|enotfound|failed to fetch|fetch failed|connection)/.test(lower)) {
    return `No connection to the update server (${msg}). Reconnect, then Retry.`;
  }
  if (/(signature|verify|verification|pubkey|hash|checksum|integrity)/.test(lower)) {
    return "Signature verification failed — the download was rejected and nothing was installed. Retry; if it repeats, reinstall from the latest release.";
  }
  if (/(404|not found|latest\.json)/.test(lower)) {
    return "The update manifest was not found on the release server. Retry; if it repeats, reinstall from the latest release.";
  }
  return `${msg} — nothing was installed. Retry, or reinstall from the latest release.`;
}

export function useUpdater() {
  const [available, setAvailable] = useState<null | {
    version: string;
    body: string | undefined;
  }>(null);
  const [checked, setChecked] = useState(false);
  const [checkState, setCheckState] = useState<UpdateCheckState>({ kind: "idle" });
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [download, setDownload] = useState<UpdateDownloadState>({ kind: "idle" });
  const [hideWorking, setHideWorking] = useState(false);
  /** Version successfully installed this session but not yet restarted into. */
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const installedVersionRef = useRef<string | null>(null);
  /** True when the installed payload is waiting on a restart (survives dismiss). */
  const [restartPending, setRestartPending] = useState(false);
  /** Last completed check (any outcome) — drives Settings "last checked". */
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  /** Last check failure, human-readable — drives Settings error copy. */
  const [checkError, setCheckError] = useState<string | null>(null);
  /** True while a downloadAndInstall flight is outstanding (re-entry guard). */
  const activeDownloadRef = useRef(false);
  /** Generation counter: stale flights (e.g. after a timeout) may not touch state. */
  const downloadRunRef = useRef(0);
  /** Re-entry guard for manual update checks. */
  const checkingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {
        /* browser dev — no app version */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyResult = useCallback(
    (update: Awaited<ReturnType<typeof check>>) => {
      const at = new Date().toISOString();
      setLastCheckedAt(at);
      if (update?.available) {
        setAvailable({ version: update.version, body: update.body });
        // Metadata-only handle: the real download re-checks on click, so
        // release this backend resource instead of leaking it.
        update.close().catch(() => {
          /* release-only */
        });
        if (!activeDownloadRef.current) {
          setDownload({ kind: "idle" });
          setHideWorking(false);
        }
        // Re-offered version we already installed this session = the binary
        // is simply still old until restart — pending, not a fresh offer.
        // (Feed has no update at all → definitely not pending.)
        setRestartPending(
          installedVersionRef.current != null && update.version === installedVersionRef.current,
        );
        setCheckState({ kind: "idle" });
      } else {
        setAvailable(null);
        setRestartPending(false);
        setCheckState({ kind: "uptodate", at });
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (cancelled) return;
        applyResult(update);
      } catch {
        // offline or no updater configured — stay silent
      } finally {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyResult]);

  const checkNow = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setCheckState({ kind: "checking" });
    setCheckError(null);
    try {
      const update = await check();
      applyResult(update);
    } catch (e) {
      setCheckState({ kind: "failed", at: new Date().toISOString() });
      setCheckError(toUpdateError(e));
    } finally {
      checkingRef.current = false;
      setChecked(true);
    }
  }, [applyResult]);

  const startDownload = useCallback(async () => {
    // Re-entry guard: concurrent downloadAndInstall calls race on a single
    // backend update resource and the loser never settles (stuck toast).
    if (activeDownloadRef.current) return;
    activeDownloadRef.current = true;
    const run = ++downloadRunRef.current;
    const isCurrent = () => downloadRunRef.current === run;
    setDownload({ kind: "working", bytes: 0, total: null, phase: "downloading" });
    setHideWorking(false);

    let update: Awaited<ReturnType<typeof check>> | null = null;
    let lastActivityAt = Date.now();
    let stallTimer: number | null = null;
    let overallTimer: number | null = null;
    const clearTimers = () => {
      if (stallTimer !== null) window.clearInterval(stallTimer);
      if (overallTimer !== null) window.clearTimeout(overallTimer);
      stallTimer = null;
      overallTimer = null;
    };
    const fail = async (message: string) => {
      // Invalidate this run so a late-settling download promise cannot
      // clobber the surfaced error with a stale transition.
      downloadRunRef.current += 1;
      clearTimers();
      if (update) {
        try {
          await update.close();
        } catch {
          /* release-only */
        }
        update = null;
      }
      activeDownloadRef.current = false;
      setHideWorking(false);
      setDownload({ kind: "failed", message });
    };

    // Watchdogs arm before check() so a hung manifest fetch stalls loudly too.
    stallTimer = window.setInterval(() => {
      if (!isCurrent()) return;
      if (Date.now() - lastActivityAt > STALL_TIMEOUT_MS) {
        void fail("The download stalled — no data for a while. Check your connection, then Retry.");
      }
    }, 10_000);
    overallTimer = window.setTimeout(() => {
      if (!isCurrent()) return;
      void fail("The download timed out. Check your connection, then Retry.");
    }, OVERALL_TIMEOUT_MS);

    try {
      update = await check();
      if (!isCurrent()) return;
      if (!update?.available) {
        clearTimers();
        activeDownloadRef.current = false;
        setAvailable(null);
        setDownload({ kind: "idle" });
        setCheckState({ kind: "uptodate", at: new Date().toISOString() });
        return;
      }
      let downloaded = 0;
      lastActivityAt = Date.now();
      const targetVersion = update.version;
      await update.downloadAndInstall((ev) => {
        if (!isCurrent()) return;
        lastActivityAt = Date.now();
        if (ev.event === "Started") {
          downloaded = 0;
          setDownload({
            kind: "working",
            bytes: 0,
            total: ev.data.contentLength ?? null,
            phase: "downloading",
          });
        } else if (ev.event === "Progress") {
          downloaded += ev.data.chunkLength;
          setDownload((prev) =>
            prev.kind === "working" ? { ...prev, bytes: downloaded, phase: "downloading" } : prev,
          );
        } else if (ev.event === "Finished") {
          // Bytes are all here; the awaited promise now finalizes the install.
          setDownload((prev) =>
            prev.kind === "working" ? { ...prev, bytes: downloaded, phase: "installing" } : prev,
          );
        }
      });
      if (!isCurrent()) return;
      clearTimers();
      activeDownloadRef.current = false;
      setAvailable(null);
      setInstalledVersion(targetVersion);
      installedVersionRef.current = targetVersion;
      setRestartPending(true);
      setDownload({ kind: "ready" });
    } catch (e) {
      if (!isCurrent()) return;
      await fail(toUpdateError(e));
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    // Dismissing never clears a pending restart: the payload is installed,
    // only the reboot is deferred. A later re-check re-offers the same
    // version, which applyResult recognizes as pending (not fresh).
    setAvailable(null);
    setDownload({ kind: "idle" });
    setHideWorking(false);
  }, []);

  const relaunchNow = useCallback(async () => {
    try {
      await relaunch();
    } catch (e) {
      setDownload({ kind: "failed", message: toUpdateError(e) });
    }
  }, []);

  return {
    available,
    checked,
    checkState,
    checkError,
    lastCheckedAt,
    restartPending,
    installedVersion,
    appVersion,
    checkNow,
    download,
    hideWorking,
    setHideWorking,
    startDownload,
    dismissUpdate,
    relaunchNow,
  };
}

/** Humanize a byte count (progress events report chunk bytes, not a total). */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function ToastShell({
  title,
  body,
  icon,
  actions,
  tone = "info",
}: {
  title: string;
  body?: string;
  icon: React.ReactNode;
  actions: React.ReactNode;
  tone?: "info" | "ready" | "error";
}) {
  return (
    <div
      role="status"
      className="pointer-events-auto w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-[#e5e5ea] bg-white/95 p-4 shadow-[0_12px_32px_-12px_rgba(16,24,40,0.25)] backdrop-blur-xl"
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
            tone === "error"
              ? "bg-red-50 text-red-600"
              : tone === "ready"
                ? "bg-[#006b27]/10 text-[#006b27]"
                : "bg-[#0070eb]/10 text-[#0058bc]",
          )}
          aria-hidden
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-[#1c1c1e]">{title}</p>
          {body && <p className="mt-0.5 text-[12px] leading-relaxed text-[#717786]">{body}</p>}
          <div className="mt-2.5 flex flex-wrap gap-1.5">{actions}</div>
        </div>
      </div>
    </div>
  );
}

function ToastButton({
  children,
  onClick,
  primary,
  disabled,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none",
        primary
          ? "bg-[#0070eb] text-white shadow-sm hover:bg-[#0058bc]"
          : "border border-[#e5e5ea] bg-white text-[#414755] hover:border-[#0070eb]/40 hover:text-[#0058bc]",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Toast-driven update flow (replaces the old modal):
 * available → [Download] [Later] · downloading (byte progress, hideable via a
 * re-showable pill so it can never stall silently) · installing (after the
 * Finished event, while the installer finalizes) · installed → [Restart now]
 * [On next launch] · errors with actionable copy + Retry.
 * Everything is user-gated; nothing downloads, installs, or restarts alone.
 */
export function UpdateToasts({ updater }: { updater: ReturnType<typeof useUpdater> }) {
  const { available, download, hideWorking, restartPending } = updater;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex flex-col items-end gap-2"
    >
      {available && download.kind === "idle" && !restartPending && (
        <ToastShell
          title={`Update available — v${available.version}`}
          body="Stable channel. Downloads and installs only on your click."
          icon={<DownloadSimple size={18} weight="bold" />}
          actions={
            <>
              <ToastButton primary onClick={() => void updater.startDownload()}>
                Download
              </ToastButton>
              <ToastButton onClick={updater.dismissUpdate} ariaLabel="Later">
                Later
              </ToastButton>
            </>
          }
        />
      )}

      {available && download.kind === "idle" && restartPending && (
        <ToastShell
          title={`Restart to apply v${available.version}`}
          body="Already installed and waiting — restart whenever you quit."
          tone="ready"
          icon={<CheckCircle size={18} weight="bold" />}
          actions={
            <>
              <ToastButton primary onClick={() => void updater.relaunchNow()}>
                Restart now
              </ToastButton>
              <ToastButton onClick={updater.dismissUpdate} ariaLabel="On next launch">
                On next launch
              </ToastButton>
            </>
          }
        />
      )}

      {download.kind === "working" && !hideWorking && (
        <ToastShell
          title={download.phase === "installing" ? "Finishing install…" : "Downloading update…"}
          body={
            download.phase === "installing"
              ? "Download complete — finalizing the install."
              : download.total != null
                ? `${fmtBytes(download.bytes)} of ${fmtBytes(download.total)}`
                : `${fmtBytes(download.bytes)} so far`
          }
          icon={
            <ArrowsClockwise size={18} weight="bold" className="animate-spin motion-reduce:animate-none" />
          }
          actions={
            <ToastButton onClick={() => updater.setHideWorking(true)} ariaLabel="Hide download progress">
              <span className="inline-flex items-center gap-1">
                <X size={12} weight="bold" aria-hidden /> Hide
              </span>
            </ToastButton>
          }
        />
      )}

      {/* Hidden-but-live: hiding progress must never strand the update with no UI. */}
      {download.kind === "working" && hideWorking && (
        <ToastShell
          title={download.phase === "installing" ? "Finishing install…" : "Downloading update…"}
          body="Running in the background — select Show to watch it."
          icon={
            <ArrowsClockwise size={18} weight="bold" className="animate-spin motion-reduce:animate-none" />
          }
          actions={
            <ToastButton onClick={() => updater.setHideWorking(false)} ariaLabel="Show download progress">
              Show
            </ToastButton>
          }
        />
      )}

      {download.kind === "ready" && (
        <ToastShell
          title="Update installed"
          body="Restart the app to start using it — now or whenever you quit."
          tone="ready"
          icon={<CheckCircle size={18} weight="bold" />}
          actions={
            <>
              <ToastButton primary onClick={() => void updater.relaunchNow()}>
                Restart now
              </ToastButton>
              <ToastButton onClick={updater.dismissUpdate} ariaLabel="Install on next launch">
                On next launch
              </ToastButton>
            </>
          }
        />
      )}

      {download.kind === "failed" && (
        <ToastShell
          title="Update failed"
          body={download.message}
          tone="error"
          icon={<X size={18} weight="bold" />}
          actions={
            <>
              <ToastButton primary onClick={() => void updater.startDownload()}>
                Retry
              </ToastButton>
              <ToastButton onClick={updater.dismissUpdate} ariaLabel="Dismiss update error">
                Dismiss
              </ToastButton>
            </>
          }
        />
      )}
    </div>
  );
}
