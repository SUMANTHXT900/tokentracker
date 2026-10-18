import { useCallback, useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";

/** Notify-only updater: stable channel, user-gated download/install/relaunch. */
export type UpdateCheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; at: string }
  | { kind: "failed"; at: string };

export function useUpdater() {
  const [available, setAvailable] = useState<null | {
    version: string;
    body: string | undefined;
  }>(null);
  const [checked, setChecked] = useState(false);
  const [checkState, setCheckState] = useState<UpdateCheckState>({ kind: "idle" });
  const [appVersion, setAppVersion] = useState<string | null>(null);

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
      // UpdateModal takes over from here.
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

  return { available, checked, checkState, appVersion, checkNow, dismiss: () => setAvailable(null) };
}

export async function installUpdateAndRelaunch(onProgress?: (pct: number) => void) {
  const update = await check();
  if (!update?.available) return;
  let downloaded = 0;
  await update.downloadAndInstall((ev) => {
    if (ev.event === "Started") onProgress?.(0);
    else if (ev.event === "Progress") {
      downloaded += ev.data.chunkLength;
      onProgress?.(downloaded);
    } else if (ev.event === "Finished") onProgress?.(100);
  });
  // Relaunch only on explicit user action — caller shows its own confirm button.
}

export async function relaunchApp() {
  await relaunch();
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

export function UpdateModal({
  version,
  body,
  onClose,
}: {
  version: string;
  body: string | undefined;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      await installUpdateAndRelaunch((p) => setPct(p));
      setDone(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const primary = panelRef.current?.querySelector<HTMLButtonElement>("[data-primary]");
    primary?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"),
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);

  const progressLabel =
    pct === null ? null : pct >= 100 && done ? "Download complete" : `Downloading… ${fmtBytes(pct)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Update available, version ${version}`}
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5"
      >
        <h2 className="text-lg font-semibold">Update available: v{version}</h2>
        <p className="mt-1 text-xs text-zinc-500">Stable channel · notify-only · nothing installed yet</p>
        {body && (
          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-900 p-3 text-xs text-zinc-300">
            {body}
          </pre>
        )}
        {err && (
          <p role="alert" className="mt-2 text-xs text-red-400">
            Update failed: {err}
          </p>
        )}
        {progressLabel && !done && (
          <p role="status" className="tnum mt-2 font-mono text-xs text-zinc-400">
            {progressLabel}
          </p>
        )}
        {done && <p className="mt-2 text-xs text-emerald-400">Installed — relaunch to apply it.</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
          >
            Later
          </button>
          {!done ? (
            <button
              onClick={download}
              disabled={busy}
              data-primary
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Downloading…" : "Download + install"}
            </button>
          ) : (
            <button
              onClick={relaunchApp}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
            >
              Relaunch now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
