/** Shared number & date formatting — handles token counts into the billions. */

function safeNum(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return n;
}

/** e.g. 5.86B, 12.40M, 3.2k, 999 — rounds then re-tiers so 999950 never prints as "1000.0k". */
export function fmtTokens(n: number): string {
  const v = safeNum(n);
  if (v >= 999995000) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 999950) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${Math.floor(v)}`;
}

/** Split number and unit for display typography e.g. { num: "5.86", unit: "B" } */
export function splitTokens(n: number): { num: string; unit: "" | "k" | "M" | "B" } {
  const v = safeNum(n);
  if (v >= 999995000) return { num: (v / 1e9).toFixed(2), unit: "B" };
  if (v >= 1e6) return { num: (v / 1e6).toFixed(2), unit: "M" };
  if (v >= 999950) return { num: (v / 1e6).toFixed(2), unit: "M" };
  if (v >= 1e3) return { num: (v / 1e3).toFixed(1), unit: "k" };
  return { num: `${Math.floor(v)}`, unit: "" };
}

/** e.g. $1,234.56 or $97.79 */
export function fmtCost(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "$0.00";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** High-precision cost for session/message rows: $0.0042 when < $0.10, else $1.24 */
export function fmtCostPrecise(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.00005) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return fmtCost(n);
}

export function splitCost(n: number): { num: string; unit: "" } {
  return { num: fmtCost(n), unit: "" };
}

/** frac is 0..1 → e.g. 12.3% */
export function fmtPct(frac: number): string {
  if (typeof frac !== "number" || !Number.isFinite(frac)) return "0.0%";
  return `${(frac * 100).toFixed(1)}%`;
}

/** Format duration in ms into e.g. "24m", "2h 14m", "<1m" */
export function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "<1m";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}
