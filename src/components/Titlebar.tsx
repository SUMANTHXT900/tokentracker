import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "@phosphor-icons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "../lib/cn";

function hasTauriIpc(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Custom window chrome (Tauri-only; browsers keep their native chrome).
 * Rendered because the app sets `decorations: false` — the OS title bar is
 * gone, so this light strip carries drag, minimize, maximize/restore, close.
 * All motion is transform/opacity-only and reduced-motion safe.
 */
export default function Titlebar() {
  const [maximized, setMaximized] = useState(false);
  const isTauri = hasTauriIpc();

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    let dead = false;
    let unlisten: (() => void) | undefined;
    const report = (e: unknown) => {
      // Never silent: a denied invoke means a missing capability entry.
      if (process.env.NODE_ENV !== "production") console.error("[titlebar]", e);
    };
    win
      .isMaximized()
      .then((m) => {
        if (!dead) setMaximized(m);
      })
      .catch(report);
    win
      .onResized(() => {
        win
          .isMaximized()
          .then((m) => {
            if (!dead) setMaximized(m);
          })
          .catch(report);
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(report);
    return () => {
      dead = true;
      unlisten?.();
    };
  }, [isTauri]);

  if (!isTauri) return null;

  const win = () => getCurrentWindow();
  const fail = (e: unknown) => {
    if (process.env.NODE_ENV !== "production") console.error("[titlebar]", e);
  };
  const toggleMaximize = async () => {
    try {
      const w = getCurrentWindow();
      const m = await w.isMaximized();
      // The backend tracks the windowed bounds separately from the maximized
      // state, so native maximize/unmaximize always restores a sane rect.
      if (m) {
        await w.unmaximize();
      } else {
        await w.maximize();
      }
      setMaximized(await w.isMaximized().catch(() => !m));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <header
      aria-label="Window controls"
      className="sticky top-0 z-50 flex h-10 w-full shrink-0 items-stretch bg-card/80 backdrop-blur-xl"
    >
      {/* Drag region + brand ("deep" keeps logo/text draggable; Tauri's
          native handler also toggles maximize on double-click). */}
      <div
        data-tauri-drag-region="deep"
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 pl-3"
      >
        <svg viewBox="0 0 32 32" className="h-[18px] w-[18px] shrink-0" aria-hidden>
          <rect width="32" height="32" rx="8" fill="#0070eb" />
          <path
            d="M16 6.5 24.5 11.2 V20.8 L16 25.5 7.5 20.8 V11.2 Z"
            fill="none"
            stroke="white"
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <path d="M16 12.2 20.4 14.7 V19.3 L16 21.8 11.6 19.3 V14.7 Z" fill="white" />
        </svg>
        <span className="truncate font-display text-[12px] font-semibold tracking-[0.08em] text-ink">
          TOKENTRACKER
        </span>
      </div>

      {/* Caption buttons — outside the drag region so clicks always land. */}
      <div className="flex shrink-0 items-stretch" role="group" aria-label="Window">
        <button
          onClick={() => void win().minimize().catch(fail)}
          aria-label="Minimize"
          title="Minimize"
          className="flex w-12 items-center justify-center text-ink-2 transition-colors duration-150 hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none"
        >
          <Minus size={15} aria-hidden />
        </button>
        <button
          onClick={() => void toggleMaximize()}
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
          className="flex w-12 items-center justify-center text-ink-2 transition-colors duration-150 hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none"
        >
          {maximized ? (
            <Copy size={13} aria-hidden />
          ) : (
            <Square size={13} aria-hidden />
          )}
        </button>
        <button
          onClick={() => void win().close().catch(fail)}
          aria-label="Close"
          title="Close"
          className={cn(
            "flex w-12 items-center justify-center text-ink-2 transition-colors duration-150",
            "hover:bg-[#E81123] hover:text-white focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none",
          )}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div aria-hidden className="absolute inset-x-0 top-10 h-px bg-hairline" />
    </header>
  );
}
