import { useEffect, useId, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "@phosphor-icons/react";
import { useOutsideClick } from "../hooks/use-outside-click";
import { cn } from "../lib/cn";

/**
 * Pop-out detail modal in the Aceternity expandable-card spirit: dimmed
 * backdrop, spring-pop panel, Escape and outside-click to dismiss.
 *
 * Hand-vendored on `motion/react` (already shipped) rather than the shadcn
 * registry, which targets Next.js projects and would fight this Vite +
 * Tauri codebase. Table rows open their full inspector here instead of
 * expanding inline, so the grid never jumps and long values get real room.
 */
export default function ExpandableModal({
  open,
  onClose,
  label,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const reduceMotion = useReducedMotion() ?? false;

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase so row-level Escape handlers don't fire first.
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  useOutsideClick(panelRef, () => {
    if (open) onClose();
  });

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            aria-hidden
            className="fixed inset-0 z-[100] h-full w-full bg-[#1a1b1f]/30 backdrop-blur-[2px]"
          />
          <div className="fixed inset-0 z-[101] grid place-items-center overflow-y-auto p-4 sm:p-6">
            <motion.div
              key="panel"
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={headingId}
              initial={
                reduceMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.96, y: 16 }
              }
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={
                reduceMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.97, y: 8 }
              }
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
              className={cn(
                "relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-3xl border border-hairline bg-card shadow-[0_32px_80px_-24px_rgba(16,24,40,0.4)]",
                wide ? "max-w-[720px]" : "max-w-[560px]",
              )}
            >
              <span id={headingId} className="sr-only">
                {label}
              </span>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label={`Close ${label}`}
                className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-card text-ink-2 shadow-sm transition-all duration-200 hover:bg-tray hover:text-ink active:scale-95 motion-reduce:transition-none"
              >
                <X size={14} weight="bold" aria-hidden />
              </button>
              <div className="min-h-0 overflow-y-auto">{children}</div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
