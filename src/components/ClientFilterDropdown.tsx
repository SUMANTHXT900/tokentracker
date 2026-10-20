import { useEffect, useId, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { CaretDown, Check, Funnel, X } from "@phosphor-icons/react";
import { getClientVisual } from "../lib/client-color";
import { fmtCostPrecise, fmtTokens } from "../lib/format";
import { cn } from "../lib/cn";

export interface ClientStat {
  tokens: number;
  sessions: number;
  cost: number;
}

/** Money label for a client: never `$0.00` when the client actually used tokens. */
function statMoney(stat?: ClientStat): { text: string; free: boolean } {
  const tokens = stat && Number.isFinite(stat.tokens) ? stat.tokens : 0;
  const cost = stat && Number.isFinite(stat.cost) ? stat.cost : 0;
  if (cost > 0) {
    // Sub-cent spend must not round down to a misleading "$0.00".
    return { text: cost < 0.00005 ? "<$0.01" : fmtCostPrecise(cost), free: false };
  }
  if (tokens > 0) return { text: "Free", free: true };
  return { text: "—", free: false };
}

/**
 * Compact client filter. Replaces the full-width ribbon: the trigger shows the
 * current scope, while the menu carries the per-client spend/volume context so
 * free clients never look inactive.
 */
export default function ClientFilterDropdown({
  clients,
  knownClients,
  stats,
  onChange,
}: {
  clients: string[];
  knownClients: string[];
  stats: Record<string, ClientStat>;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const panelId = useId();

  const menuClients = Array.from(new Set([...knownClients, ...clients]));
  const allSelected = clients.length === 0;
  const rovingIndex = Math.min(Math.max(activeIndex, 0), menuClients.length);

  const single = clients.length === 1 ? getClientVisual(clients[0]) : null;
  const singleStat = clients.length === 1 ? stats[clients[0]] : undefined;
  const singleMoney = singleStat ? statMoney(singleStat) : null;
  const triggerLabel = allSelected
    ? "All clients"
    : single
      ? single.label
      : `${clients.length} clients`;
  const triggerAria = allSelected
    ? `Filter by client: All clients (${menuClients.length} available)`
    : single
      ? `Filter by client: ${single.label}${singleMoney && singleMoney.text !== "—" ? `, ${singleMoney.text}` : ""}`
      : `Filter by client: ${clients.length} clients selected`;

  const footerLabel = allSelected
    ? menuClients.length === 0
      ? "No clients in range"
      : menuClients.length === 1
        ? "1 client"
        : `All ${menuClients.length} clients`
    : `${clients.length} of ${menuClients.length} selected`;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move focus into the panel when it opens: first selected client, else "All clients".
  useEffect(() => {
    if (!open) return;
    const selectedIndex = clients.length === 1 ? menuClients.indexOf(clients[0]) : -1;
    const index = selectedIndex >= 0 ? selectedIndex + 1 : 0;
    setActiveIndex(index);
    const options = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    options?.[index]?.focus();
    // Intentionally run only on open transition — toggling does not steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const onRootBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const next = e.relatedTarget;
    if (next == null) return; // focus fell to body (e.g. panel padding) — pointerdown handles true dismissals
    if (!(next instanceof Node)) return;
    if (rootRef.current?.contains(next)) return;
    setOpen(false);
  };

  const toggle = (client: string) => {
    if (clients.includes(client)) onChange(clients.filter((c) => c !== client));
    else onChange([...clients, client]);
  };

  // Clear is disabled once everything is selected, so park focus on the All
  // clients option first — otherwise the focused button would become disabled.
  const selectAll = () => {
    listRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
    setActiveIndex(0);
    onChange([]);
  };

  const focusOption = (index: number) => {
    const options = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (!options || options.length === 0) return;
    const next = (index + options.length) % options.length;
    setActiveIndex(next);
    options[next]?.focus();
  };

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    if (options.length === 0) return;
    e.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Home") focusOption(0);
    else if (e.key === "End") focusOption(options.length - 1);
    else if (e.key === "ArrowUp") focusOption(current <= 0 ? options.length - 1 : current - 1);
    else focusOption(current < 0 || current === options.length - 1 ? 0 : current + 1);
  };

  const rowClass = (selected: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-200 ease-[var(--ease-spring)]",
      selected ? "bg-primary/[0.07] hover:bg-primary/[0.11]" : "hover:bg-tray",
    );

  return (
    <div ref={rootRef} className="relative" onBlur={onRootBlur}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={triggerAria}
        title={triggerLabel}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-full border bg-card px-3 text-[12px] font-medium text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all duration-300 ease-[var(--ease-spring)] hover:border-primary/35 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas active:scale-[0.98] motion-reduce:transition-none",
          open ? "border-primary/40" : "border-hairline",
        )}
      >
        {single ? (
          <span className={cn("h-2 w-2 shrink-0 rounded-full", single.dot)} aria-hidden />
        ) : (
          <Funnel size={13} weight="bold" className="shrink-0 text-primary" aria-hidden />
        )}
        <span className="max-w-[150px] truncate">{triggerLabel}</span>
        {allSelected ? (
          <span className="tnum rounded-full bg-tray px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
            {menuClients.length}
          </span>
        ) : single ? (
          singleMoney && singleMoney.text !== "—" ? (
            <span
              className={cn(
                "tnum font-mono text-[10px]",
                singleMoney.free ? "font-semibold text-success" : "text-ink-3",
              )}
            >
              {singleMoney.text}
            </span>
          ) : null
        ) : (
          <span className="tnum rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
            {clients.length}
          </span>
        )}
        <CaretDown
          size={11}
          weight="bold"
          aria-hidden
          className={cn(
            "shrink-0 text-ink-3 transition-transform duration-300 ease-[var(--ease-spring)] motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          className="absolute left-0 top-full z-50 mt-2 w-[min(340px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-hairline bg-card shadow-[0_20px_48px_-24px_rgba(16,24,40,0.28)] sm:left-auto sm:right-0"
        >
          <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
            <p
              id={headingId}
              className="truncate font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3"
            >
              Client scope
            </p>
            <button
              type="button"
              onClick={selectAll}
              disabled={allSelected}
              className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[10px] text-ink-3 transition-colors hover:bg-tray hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-3"
            >
              <X size={10} weight="bold" aria-hidden /> Clear
            </button>
          </div>

          <div
            ref={listRef}
            role="listbox"
            aria-multiselectable="true"
            aria-labelledby={headingId}
            onKeyDown={onListKeyDown}
            className="max-h-[min(20rem,calc(100dvh-14rem))] overflow-y-auto p-1.5"
          >
            <button
              type="button"
              role="option"
              aria-selected={allSelected}
              tabIndex={rovingIndex === 0 ? 0 : -1}
              onFocus={() => setActiveIndex(0)}
              onClick={selectAll}
              className={cn(
                rowClass(allSelected),
                "text-[12px]",
                allSelected ? "font-semibold text-primary" : "text-ink",
              )}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {allSelected && <Check size={12} weight="bold" aria-hidden />}
              </span>
              <span className="h-2 w-2 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">All clients</span>
              <span className="tnum shrink-0 font-mono text-[10px] text-ink-3">
                {menuClients.length}
              </span>
            </button>

            {menuClients.map((client, i) => {
              const visual = getClientVisual(client);
              const stat = stats[client];
              const active = clients.includes(client);
              const money = statMoney(stat);
              const optionIndex = i + 1;
              const tokens = stat && Number.isFinite(stat.tokens) ? stat.tokens : 0;
              const sessions = stat && Number.isFinite(stat.sessions) ? stat.sessions : 0;
              const detail = [
                tokens > 0 ? `${fmtTokens(tokens)} tokens` : null,
                sessions > 0
                  ? `${sessions.toLocaleString()} ${sessions === 1 ? "session" : "sessions"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");

              return (
                <button
                  key={client}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={rovingIndex === optionIndex ? 0 : -1}
                  onFocus={() => setActiveIndex(optionIndex)}
                  onClick={() => toggle(client)}
                  className={rowClass(active)}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {active && <Check size={12} weight="bold" className="text-primary" aria-hidden />}
                  </span>
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", visual.dot)} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span
                      title={visual.label}
                      className="block truncate text-[12px] font-medium text-ink"
                    >
                      {visual.label}
                    </span>
                    <span className="tnum block truncate font-mono text-[10px] text-ink-3">
                      {detail || "No usage in range"}
                    </span>
                  </span>
                  <span
                    aria-hidden={money.text === "—" || undefined}
                    title={money.free ? "No metered cost in the selected range" : undefined}
                    className={cn(
                      "tnum shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold",
                      money.free
                        ? "bg-success/10 text-success"
                        : money.text === "—"
                          ? "bg-tray text-ink-3"
                          : "bg-tray text-ink-2",
                    )}
                  >
                    {money.text}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-hairline px-3 py-2">
            <span
              aria-live="polite"
              aria-atomic="true"
              className="tnum min-w-0 truncate font-mono text-[10px] text-ink-3"
            >
              {footerLabel}
            </span>
            <button
              type="button"
              onClick={() => closeMenu(true)}
              className="shrink-0 rounded-full border border-hairline bg-card px-3 py-1 text-[11px] font-semibold text-ink-2 transition-colors hover:border-primary/40 hover:text-primary"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
