import { useCallback, useEffect, useState } from "react";
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
  | { kind: "working"; bytes: number }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

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

  const applyResult = useCallback((update: Awaited<ReturnType<typeof check>>) => {
    if (update?.available) {
      setAvailable({ version: update.version, body: update.body });
      setDownload({ kind: "idle" });
      setHideWorking(false);
      setCheckState({ kind: "idle" });
    } else {
      setAvailable(null);
      setCheckState({ kind: "uptodate", at: new Date().toISOString() });
    }
  }, []);

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
    setCheckState({ kind: "checking" });
    try {
      const update = await check();
      applyResult(update);
    } catch {
      setCheckState({ kind: "failed", at: new Date().toISOString() });
    } finally {
      setChecked(true);
    }
  }, [applyResult]);

  const startDownload = useCallback(async () => {
    setDownload({ kind: "working", bytes: 0 });
    setHideWorking(false);
    try {
      const update = await check();
      if (!update?.available) {
        setAvailable(null);
        setDownload({ kind: "idle" });
        setCheckState({ kind: "uptodate", at: new Date().toISOString() });
        return;
      }
      let downloaded = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          downloaded = 0;
          setDownload({ kind: "working", bytes: 0 });
        } else if (ev.event === "Progress") {
          downloaded += ev.data.chunkLength;
          setDownload({ kind: "working", bytes: downloaded });
        }
      });
      setAvailable(null);
      setDownload({ kind: "ready" });
    } catch (e) {
      setDownload({ kind: "failed", message: String(e) });
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setAvailable(null);
    setDownload({ kind: "idle" });
    setHideWorking(false);
  }, []);

  const relaunchNow = useCallback(async () => {
    await relaunch();
  }, []);

  return {
    available,
    checked,
    checkState,
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
function fmtBytes(n: number): string {
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
 * available → [Download] [Later] · downloading (MB progress, hideable) ·
 * installed → [Restart now] [On next launch] · errors with retry.
 * Everything is user-gated; nothing downloads, installs, or restarts alone.
 */
export function UpdateToasts({ updater }: { updater: ReturnType<typeof useUpdater> }) {
  const { available, download, hideWorking } = updater;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex flex-col items-end gap-2"
    >
      {available && download.kind === "idle" && (
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

      {download.kind === "working" && !hideWorking && (
        <ToastShell
          title="Downloading update…"
          body={`${fmtBytes(download.bytes)} so far`}
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
