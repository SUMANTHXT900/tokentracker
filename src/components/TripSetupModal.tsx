import { useEffect, useRef, useState } from "react";
import { motion, MotionConfig } from "motion/react";
import { Minus, Play, Plus, Timer, Users, WarningCircle } from "@phosphor-icons/react";
import { cmdStartTrip, type StopMode, type TripDTO, type TripScope } from "../lib/tauri";
import { cn } from "../lib/cn";
import { getClientVisual } from "../lib/client-color";

type ModeKind = "manual" | "after" | "idle";

const EASE = [0.32, 0.72, 0, 1] as const;
const MAX_NAME_LENGTH = 80;

/** Local calendar date — `toISOString()` would roll to the wrong day near UTC midnight. */
function localDateStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function defaultFocusName(): string {
  return `Focus ${localDateStamp()}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || "Couldn’t start the focus session.";
  if (typeof e === "string" && e.trim()) return e;
  if (e && typeof e === "object" && "message" in e) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Couldn’t start the focus session.";
}

export default function TripSetupModal({
  onClose,
  allClients = [],
  onStarted,
  running = false,
}: {
  onClose: () => void;
  allClients?: string[];
  onStarted?: (trip: TripDTO) => void;
  running?: boolean;
}) {
  // Client chips are driven exclusively by the explicit prop list. The global
  // filter store is intentionally not consulted here.
  const list = Array.from(new Set(allClients));
  const [name, setName] = useState("");
  const [defaultName] = useState(defaultFocusName);
  // `all` is the source of truth while it is true; `selected` only carries an
  // explicit subset. Starting `selected` empty avoids the old "all minus one"
  // ambiguity when the first chip is clicked.
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<ModeKind>("manual");
  const [hours, setHours] = useState(4);
  const [minutes, setMinutes] = useState(30);
  // String drafts so multi-digit typing ("12", "45") works naturally;
  // clamped only onBlur / stepper / submit.
  const [hoursDraft, setHoursDraft] = useState("4");
  const [minutesDraft, setMinutesDraft] = useState("30");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  // Mirrors for the focus/Escape closure so the effect can run exactly once.
  // App passes an inline `onClose`, so depending on it re-ran this effect on
  // every parent render — stealing focus back to the opener mid-submit.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Reconcile the explicit subset when the available client list changes.
  // Returning `prev` when nothing changed keeps a memo-less parent from
  // triggering a render loop through the array identity.
  useEffect(() => {
    const allowed = new Set(allClients);
    setSelected((prev) => {
      const next: string[] = [];
      for (const c of prev) {
        if (allowed.has(c) && !next.includes(c)) next.push(c);
      }
      const unchanged =
        next.length === prev.length && next.every((c, i) => c === prev[i]);
      return unchanged ? prev : next;
    });
  }, [allClients]);

  // Focus trap + Escape + return-focus + body scroll lock. The dialog owns Tab
  // while open and hands focus back to the opener on unmount (WCAG 2.4.3 /
  // 2.1.2). Empty deps are deliberate — see the ref mirrors above.
  useEffect(() => {
    prevFocusRef.current =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const previousOverflow =
      typeof document !== "undefined" ? document.body.style.overflow : "";
    if (typeof document !== "undefined") document.body.style.overflow = "hidden";
    nameRef.current?.focus();
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
        // getClientRects: offsetParent is null for fixed-position subtrees in
        // some browsers, which emptied the trap list and let Tab escape.
      );
      const visible = candidates.filter((el) => el.getClientRects().length > 0);
      // Some embedders (and jsdom) report no rects for an otherwise mounted
      // dialog; fall back to every candidate rather than dropping the trap.
      const items = visible.length > 0 ? visible : candidates;
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // If focus escaped the dialog (e.g. the opener was removed), pull it to
      // the first control instead of letting Tab walk the page behind.
      if (!active || !root.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", fn, true);
    return () => {
      window.removeEventListener("keydown", fn, true);
      if (typeof document !== "undefined") {
        document.body.style.overflow = previousOverflow;
      }
      const prev = prevFocusRef.current;
      if (prev && typeof document !== "undefined" && document.contains(prev)) {
        prev.focus?.();
      }
    };
  }, []);

  const clearError = () => setErr((prev) => (prev === null ? prev : null));

  const chooseAll = () => {
    clearError();
    setAll(true);
    setSelected([]);
  };

  const toggle = (c: string) => {
    clearError();
    // From "All", the first chip click expresses an explicit single-client
    // subset — not "all clients except this one".
    if (all) {
      setAll(false);
      setSelected([c]);
      return;
    }
    setSelected((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  };

  const chooseMode = (m: ModeKind) => {
    clearError();
    setMode(m);
  };

  const clampHours = (v: number) =>
    Number.isFinite(v) ? Math.min(168, Math.max(0.5, v)) : 4;
  const clampMinutes = (v: number) =>
    Number.isFinite(v) ? Math.min(480, Math.max(5, Math.round(v))) : 30;

  const commitHours = () => {
    const h = clampHours(Number(hoursDraft));
    setHours(h);
    setHoursDraft(String(h));
    return h;
  };
  const commitMinutes = () => {
    const m = clampMinutes(Number(minutesDraft));
    setMinutes(m);
    setMinutesDraft(String(m));
    return m;
  };

  const stepHours = (delta: number) => {
    clearError();
    const base = Number.isFinite(Number(hoursDraft)) ? Number(hoursDraft) : hours;
    const h = clampHours(Math.round((base + delta) * 10) / 10);
    setHours(h);
    setHoursDraft(String(h));
    setMode("after");
  };
  const stepMinutes = (delta: number) => {
    clearError();
    const base = Number.isFinite(Number(minutesDraft))
      ? Math.round(Number(minutesDraft))
      : minutes;
    const m = clampMinutes(base + delta);
    setMinutes(m);
    setMinutesDraft(String(m));
    setMode("idle");
  };

  const start = async () => {
    if (busy || running) return;
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    const finalName = trimmed || defaultName;
    if (!all && selected.length === 0) {
      setErr("Pick at least one client or use All.");
      return;
    }
    const h = clampHours(Number(hoursDraft));
    const m = clampMinutes(Number(minutesDraft));
    setHours(h);
    setHoursDraft(String(h));
    setMinutes(m);
    setMinutesDraft(String(m));
    const scope: TripScope = all ? { kind: "all" } : { kind: "clients", clients: selected };
    const stop: StopMode =
      mode === "manual"
        ? { kind: "manual" }
        : mode === "after"
          ? { kind: "after", hours: h }
          : { kind: "idle", minutes: m };
    setBusy(true);
    setErr(null);
    try {
      const trip = await cmdStartTrip(finalName, scope, stop);
      setBusy(false);
      // A failure inside the parent's callback must not leave the modal open
      // with Start re-armed after the session already started.
      try {
        onStarted?.(trip);
      } catch {
        // The session exists; closing is still the correct outcome.
      }
      onCloseRef.current();
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  const leverBase =
    "w-full rounded-[1.25rem] p-1 ring-1 transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#0070eb]/60 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-white active:scale-[0.99] motion-reduce:transition-none";
  const leverOn = "bg-[#0070eb]/[0.07] ring-[#0070eb]/35";
  const leverOff = "bg-white ring-[#e5e5ea] hover:ring-[#c9c9d2]";

  const stepperBtn =
    "rounded-full p-2 text-[#414755] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-black/[0.04] active:scale-90 disabled:opacity-40 disabled:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/50";
  const digitWell =
    "tnum w-20 rounded-xl border border-[#e5e5ea] bg-white px-2 py-1.5 text-center font-mono text-sm text-[#1a1b1f] shadow-[inset_0_1px_2px_rgba(16,24,40,0.06)] focus:border-[#0070eb]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/40 disabled:opacity-40";

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-[#1a1b1f]/45 p-4 backdrop-blur-xl"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) onClose();
        }}
      >
        <motion.div
          ref={dialogRef}
          initial={{ opacity: 0, scale: 0.96, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="trip-setup-title"
          aria-describedby={running ? "trip-setup-desc trip-setup-running" : "trip-setup-desc"}
          aria-busy={busy}
          className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-[2rem] bg-white p-1.5 shadow-[0_1px_3px_rgba(16,24,40,0.06),0_32px_64px_-24px_rgba(16,24,40,0.25)] ring-1 ring-[#e5e5ea]"
        >
          {/* Card frame is fixed; only the form scrolls inside it, so the
              Cancel / Start levers stay reachable at the 800×720 minimum
              window (form is ~880px tall, ~232px beyond the fold otherwise). */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[calc(2rem-0.375rem)] border border-[#e5e5ea]/70 bg-[#faf9fe] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
            <div
              aria-hidden
              className="pointer-events-none absolute -top-24 right-0 h-48 w-72 rounded-full bg-[#0070eb]/[0.07] blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#0070eb]/20 to-transparent"
            />

            <div className="relative min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
              <p className="inline-flex items-center rounded-full border border-[#e5e5ea] bg-white px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.2em] text-ink-3">
                Baseline capture
              </p>
              <h2
                id="trip-setup-title"
                className="font-display mt-2 text-xl font-semibold tracking-tight text-[#1a1b1f]"
              >
                New focus session
              </h2>
              <p id="trip-setup-desc" className="mt-1 text-[13px] leading-relaxed text-ink-3">
                Start from baseline — measure only what happens from the moment you start.
              </p>

              {running && (
                <div
                  id="trip-setup-running"
                  role="status"
                  className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900"
                >
                  <WarningCircle size={16} weight="light" className="mt-0.5 shrink-0" aria-hidden="true" />
                  <p>
                    A focus session is already running. Stop it or open it before starting
                    another.
                  </p>
                </div>
              )}

              <label className="mt-5 block text-[13px] text-[#414755]">
                Session name
                <input
                  ref={nameRef}
                  value={name}
                  maxLength={MAX_NAME_LENGTH}
                  onChange={(e) => {
                    setName(e.target.value);
                    clearError();
                  }}
                  className="tnum mt-1.5 w-full rounded-xl border border-[#e5e5ea] bg-white px-3 py-2.5 text-sm text-[#1a1b1f] shadow-[inset_0_1px_2px_rgba(16,24,40,0.06)] placeholder:text-ink-3 focus:border-[#0070eb]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/40"
                  placeholder={defaultName}
                />
              </label>

              <div className="mt-5 flex items-center gap-1.5 text-[13px] font-medium text-[#414755]">
                <Users size={14} weight="light" className="text-[#0058bc]/70" aria-hidden="true" />
                Session scope
              </div>
              <p id="trip-scope-hint" className="mt-0.5 text-xs text-ink-3">
                Which clients count toward this focus session.
              </p>
              <div
                className="mt-2 flex flex-wrap gap-1.5"
                role="group"
                aria-label="Clients in this focus session"
                aria-describedby="trip-scope-hint"
              >
                <button
                  type="button"
                  onClick={chooseAll}
                  aria-pressed={all}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/50",
                    all
                      ? "border-[#0070eb]/50 bg-[#0070eb]/[0.08] text-[#0058bc]"
                      : "border-[#e5e5ea] text-[#414755] hover:border-[#c9c9d2] hover:text-[#1a1b1f]",
                  )}
                >
                  All
                </button>
                {list.map((c) => {
                  const v = getClientVisual(c);
                  const on = !all && selected.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggle(c)}
                      aria-pressed={on}
                      title={v.label}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/50",
                        on
                          ? "border-[#0070eb]/50 bg-[#0070eb]/[0.08] text-[#0058bc]"
                          : "border-[#e5e5ea] text-[#414755] hover:border-[#c9c9d2] hover:text-[#1a1b1f]",
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", v.dot)} />
                      {v.label}
                    </button>
                  );
                })}
                {list.length === 0 && (
                  <span className="text-xs text-ink-3">
                    No clients yet — this focus session covers all.
                  </span>
                )}
              </div>

              <fieldset className="mt-5 min-w-0 border-0 p-0">
                <legend className="flex items-center gap-1.5 p-0 text-[13px] font-medium text-[#414755]">
                  <Timer size={14} weight="light" className="text-[#0058bc]/70" aria-hidden="true" />
                  Auto-stop condition
                </legend>
                <p id="trip-stop-hint" className="mt-0.5 text-xs text-ink-3">
                  A focus session can always be stopped by hand.
                </p>
                {/* Native radio group: same `name` gives free roving tabindex +
                    arrow-key support. Each card is a plain container — the
                    radio input is the only tab stop, steppers are siblings
                    (never nested inside the label) so no ARIA nesting breakage. */}
                <div className="mt-2 grid min-w-0 grid-cols-1 gap-2" aria-describedby="trip-stop-hint">
                  <motion.div
                    onClick={() => chooseMode("manual")}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: EASE, delay: 0.05 }}
                    className={cn(leverBase, "cursor-pointer", mode === "manual" ? leverOn : leverOff)}
                  >
                    <div className="rounded-[calc(1.25rem-0.25rem)] border border-[#e5e5ea]/70 bg-white px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="trip-stop-mode"
                          value="manual"
                          checked={mode === "manual"}
                          onChange={() => chooseMode("manual")}
                          className="sr-only"
                        />
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-300",
                            mode === "manual" ? "border-[#0070eb]" : "border-[#c9c9d2]",
                          )}
                        >
                          {mode === "manual" && <span className="h-2 w-2 rounded-full bg-[#0070eb]" />}
                        </span>
                        <span className="text-sm font-medium text-[#1a1b1f]">Manual</span>
                      </label>
                      <div className="mt-0.5 pl-6 text-xs text-ink-3">Runs until you stop it.</div>
                    </div>
                  </motion.div>

                  <motion.div
                    onClick={() => chooseMode("after")}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: EASE, delay: 0.12 }}
                    className={cn(leverBase, "cursor-pointer", mode === "after" ? leverOn : leverOff)}
                  >
                    <div className="rounded-[calc(1.25rem-0.25rem)] border border-[#e5e5ea]/70 bg-white px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="trip-stop-mode"
                          value="after"
                          checked={mode === "after"}
                          onChange={() => chooseMode("after")}
                          className="sr-only"
                        />
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-300",
                            mode === "after" ? "border-[#0070eb]" : "border-[#c9c9d2]",
                          )}
                        >
                          {mode === "after" && <span className="h-2 w-2 rounded-full bg-[#0070eb]" />}
                        </span>
                        <span className="text-sm font-medium text-[#1a1b1f]">After a fixed duration</span>
                      </label>
                      <div className="mt-0.5 pl-6 text-xs text-ink-3">Stops itself after the set hours.</div>
                      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 pl-6">
                        <button
                          type="button"
                          disabled={mode !== "after"}
                          onClick={() => stepHours(-0.5)}
                          aria-label="Decrease hours"
                          className={stepperBtn}
                        >
                          <Minus size={14} weight="light" />
                        </button>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={hoursDraft}
                          disabled={mode !== "after"}
                          onChange={(e) => {
                            setHoursDraft(e.target.value);
                            clearError();
                          }}
                          onBlur={commitHours}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                          onFocus={() => chooseMode("after")}
                          aria-label="Hours until auto-stop"
                          className={digitWell}
                        />
                        <span className="text-xs text-ink-3">hours</span>
                        <button
                          type="button"
                          disabled={mode !== "after"}
                          onClick={() => stepHours(0.5)}
                          aria-label="Increase hours"
                          className={stepperBtn}
                        >
                          <Plus size={14} weight="light" />
                        </button>
                      </div>
                    </div>
                  </motion.div>

                  <motion.div
                    onClick={() => chooseMode("idle")}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: EASE, delay: 0.19 }}
                    className={cn(leverBase, "cursor-pointer", mode === "idle" ? leverOn : leverOff)}
                  >
                    <div className="rounded-[calc(1.25rem-0.25rem)] border border-[#e5e5ea]/70 bg-white px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="trip-stop-mode"
                          value="idle"
                          checked={mode === "idle"}
                          onChange={() => chooseMode("idle")}
                          className="sr-only"
                        />
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-300",
                            mode === "idle" ? "border-[#0070eb]" : "border-[#c9c9d2]",
                          )}
                        >
                          {mode === "idle" && <span className="h-2 w-2 rounded-full bg-[#0070eb]" />}
                        </span>
                        <span className="text-sm font-medium text-[#1a1b1f]">When idle</span>
                      </label>
                      <div className="mt-0.5 pl-6 text-xs text-ink-3">
                        Stops after no new tokens arrive.
                      </div>
                      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 pl-6">
                        <button
                          type="button"
                          disabled={mode !== "idle"}
                          onClick={() => stepMinutes(-5)}
                          aria-label="Decrease idle minutes"
                          className={stepperBtn}
                        >
                          <Minus size={14} weight="light" />
                        </button>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={minutesDraft}
                          disabled={mode !== "idle"}
                          onChange={(e) => {
                            setMinutesDraft(e.target.value);
                            clearError();
                          }}
                          onBlur={commitMinutes}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                          onFocus={() => chooseMode("idle")}
                          aria-label="Idle minutes until auto-stop"
                          className={digitWell}
                        />
                        <span className="text-xs text-ink-3">min idle</span>
                        <button
                          type="button"
                          disabled={mode !== "idle"}
                          onClick={() => stepMinutes(5)}
                          aria-label="Increase idle minutes"
                          className={stepperBtn}
                        >
                          <Plus size={14} weight="light" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                </div>
              </fieldset>

              {err && (
                <p role="alert" className="mt-3 text-xs text-red-600">
                  {err}
                </p>
              )}
            </div>

            {/* Footer lives outside the scroll region — always visible even
                when the form itself overflows the dialog height. Wraps so
                Cancel / Start never collide at narrow widths. */}
            <div className="relative flex min-w-0 shrink-0 flex-wrap justify-end gap-2 border-t border-[#e5e5ea] bg-[#faf9fe] px-5 py-4 sm:px-6">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-full border border-[#e5e5ea] px-4 py-2 text-sm text-[#414755] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-[#c9c9d2] hover:text-[#1a1b1f] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb]/50 disabled:cursor-wait disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={start}
                disabled={busy || running}
                aria-busy={busy}
                aria-label={
                  running
                    ? "A focus session is already running"
                    : busy
                      ? "Starting focus session…"
                      : "Start focus session"
                }
                title={running ? "Stop or open the running focus session first" : undefined}
                className={cn(
                  "group inline-flex items-center gap-2 rounded-full bg-[#0058bc] py-2 pl-5 pr-2 text-sm font-semibold text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_12px_28px_-12px_rgba(0,88,188,0.55)] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#0067d6] active:scale-[0.97] active:bg-[#004da6] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0070eb] focus-visible:ring-offset-2 focus-visible:ring-offset-white",
                  running ? "disabled:cursor-not-allowed" : "disabled:cursor-wait",
                )}
              >
                {running ? "Session running" : busy ? "Starting…" : "Start focus session"}
                <span
                  aria-hidden
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-105 group-active:scale-90"
                >
                  <Play size={13} weight="light" />
                </span>
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </MotionConfig>
  );
}
