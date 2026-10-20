import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "../lib/cn";

/**
 * Cursor-following tooltip card.
 *
 * Hand-vendored equivalent of the Aceternity tooltip-card pattern, built on
 * deps we already ship (`motion/react` + Tailwind) instead of pulling the
 * shadcn registry into this Vite + Tauri repo. Shows `content` in a small
 * card pinned near the pointer while hovering or keyboard-focusing the
 * trigger child. Used on truncated table cells (model ids, paths) so the
 * full value is one hover away instead of hidden behind `truncate`.
 */
export default function TooltipCard({
  content,
  children,
  containerClassName,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  containerClassName?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const rootRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const reduceMotion = useReducedMotion() ?? false;

  // Dismiss on Escape and on scroll (a scrolling page orphans a fixed tip).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVisible(false);
    };
    const onScroll = () => setVisible(false);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [visible]);

  if (!content) {
    return <span className={containerClassName}>{children}</span>;
  }

  const OFFSET = 14;
  const TIP_W = 300;
  const TIP_H = 120;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.min(Math.max(8, pos.x + OFFSET), Math.max(8, vw - TIP_W - 8));
  const flipUp = pos.y + OFFSET + TIP_H > vh;
  const top = flipUp ? Math.max(8, pos.y - TIP_H - 10) : pos.y + OFFSET;

  return (
    <span
      ref={rootRef}
      className={cn("inline-block min-w-0", containerClassName)}
      aria-describedby={tipId}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onFocus={() => {
        const r = rootRef.current?.getBoundingClientRect();
        if (r) setPos({ x: r.left + r.width / 2, y: r.bottom });
        setVisible(true);
      }}
      onBlur={() => setVisible(false)}
    >
      {children}
      <AnimatePresence>
        {visible && (
          <motion.span
            key="tip"
            id={tipId}
            role="tooltip"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: flipUp ? 4 : -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
            className="tnum pointer-events-none fixed z-[90] block max-w-[300px] rounded-xl border border-hairline bg-card px-3 py-2 text-[11px] leading-relaxed text-ink shadow-[0_16px_40px_-16px_rgba(16,24,40,0.35)]"
            style={{ left, top }}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
