/**
 * Focus-session share card data.
 *
 * The backend `TripDetailDTO` is still growing its session aggregate fields, so
 * this module normalizes a *tolerant* view of it: every optional total is
 * guarded, every share is divided by a checked denominator, and the result is
 * safe to render for a brand-new (all-zero) session. No mock data is invented:
 * when a field is absent the card shows an honest dash.
 */
import { format, parseISO } from "date-fns";
import type { DailyDTO, ModelRowDTO, TripDetailDTO, TripDTO } from "../tauri";
import { getClientVisual } from "../client-color";
import { fmtDurationMs, fmtTokens } from "../format";
import { dayLabel, prettyModel } from "./data";

export interface SessionModelStat {
  key: string;
  model: string;
  short: string;
  client: string;
  clientLabel: string;
  hex: string;
  tokens: number;
  cost: number;
  messages: number;
  share: number;
}

export interface SessionClientStat {
  id: string;
  label: string;
  hex: string;
  tokens: number;
  cost: number;
  messages: number;
  share: number;
}

export interface SessionDayPoint {
  date: string;
  tokens: number;
  cost: number;
  messages: number;
}

export interface SessionCardData {
  name: string;
  isLive: boolean;
  statusLabel: string;
  stopReason: string;
  scopeLabel: string;

  dateLabel: string;
  timeRange: string;
  durationMs: number;
  durationLabel: string;

  tokens: number;
  cost: number;
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cacheHit: number;

  sessions: number | null;
  modelsUsed: number;
  clientsUsed: number;

  topModel: string | null;
  topModelLabel: string | null;
  topModelTokens: number;
  topModelShare: number;

  peakDay: { date: string; label: string; tokens: number; cost: number } | null;

  tokPerMin: number;
  costPerHour: number;

  models: SessionModelStat[];
  clients: SessionClientStat[];
  daily: SessionDayPoint[];

  hasUsage: boolean;
  exportDate: string;
  fileName: string;
  seed: string;
}

/**
 * Structural view of the DTO the card understands. `TripDetailDTO` is being
 * extended in parallel, so the extra aggregate fields are optional here and
 * the cast happens in one place (`asSessionDetail`).
 */
export interface SessionDetailLike {
  trip: TripDTO & { active?: boolean };
  baseline?: {
    totals?: { tokens?: number; cost?: number };
    by_model?: ModelRowDTO[];
  };
  deltas?: {
    tokens?: number;
    cost?: number;
    messages?: number;
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };
  models?: ModelRowDTO[];
  clients?: { client: string; tokens?: number; cost?: number; messages?: number }[];
  sessions?: number;
  duration_ms?: number;
  top_model?: string | null;
  peak_day?: DailyDTO | null;
  daily?: DailyDTO[];
}

export function asSessionDetail(detail: TripDetailDTO): SessionDetailLike {
  return detail as unknown as SessionDetailLike;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? parseISO(value).getTime()
      : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function clock(ms: number): string {
  try {
    return format(new Date(ms), "HH:mm");
  } catch {
    return "—";
  }
}

function dayStamp(ms: number): string {
  try {
    return format(new Date(ms), "MMM d, yyyy").toUpperCase();
  } catch {
    return "—";
  }
}

export function slugifyName(name: string): string {
  const slug = (name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "session";
}

function stopReasonOf(trip: TripDTO & { active?: boolean }, isLive: boolean): string {
  if (isLive) return "in progress";

  const stop = trip.stop as unknown;
  const detail =
    stop && typeof stop === "object"
      ? (stop as { kind?: string; hours?: number; minutes?: number })
      : null;
  const hours = detail && typeof detail.hours === "number" ? detail.hours : null;
  const minutes = detail && typeof detail.minutes === "number" ? detail.minutes : null;
  const reason = (trip.stop_reason ?? "").toLowerCase().trim();

  if (!reason) return "session complete";
  if (reason === "manual" || reason === "stopped") return "stopped manually";
  if (
    reason === "after" ||
    reason === "time-elapsed" ||
    reason === "duration" ||
    reason === "timer"
  ) {
    return hours ? `auto-stopped after ${hours}h` : "auto-stopped when time elapsed";
  }
  if (reason === "idle" || reason === "idle-timeout") {
    return minutes ? `auto-stopped after ${minutes} min idle` : "auto-stopped when idle";
  }
  if (reason === "superseded") return "superseded by a newer focus";
  return `stopped · ${reason.replace(/[-_]+/g, " ")}`;
}

function scopeLabelOf(trip: TripDTO): string {
  const scope = trip.scope;
  if (!scope || scope.kind === "all") return "all clients";
  const n = Array.isArray(scope.clients) ? scope.clients.length : 0;
  return `${n} ${n === 1 ? "client" : "clients"}`;
}

function buildModels(rows: ModelRowDTO[]): SessionModelStat[] {
  const stats = rows
    .map((m) => {
      const visual = getClientVisual(m.client);
      return {
        key: `${m.client}:${m.model}`,
        model: m.model || "unknown",
        short: prettyModel(m.model),
        client: m.client || "unknown",
        clientLabel: visual.label,
        hex: visual.hex,
        tokens: num(m.tokens),
        cost: num(m.cost),
        messages: count(m.messages),
        share: 0,
      } satisfies SessionModelStat;
    })
    .filter((m) => m.tokens > 0 || m.cost > 0 || m.messages > 0)
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);

  const total = stats.reduce((sum, m) => sum + m.tokens, 0);
  for (const m of stats) m.share = total > 0 ? m.tokens / total : 0;
  return stats;
}

function buildClients(
  rows: { client?: string; id?: string; tokens?: number; cost?: number; messages?: number }[],
): SessionClientStat[] {
  const stats = rows
    .map((c) => {
      const id = c.client ?? c.id ?? "unknown";
      const visual = getClientVisual(id);
      return {
        id,
        label: visual.label,
        hex: visual.hex,
        tokens: num(c.tokens),
        cost: num(c.cost),
        messages: count(c.messages),
        share: 0,
      } satisfies SessionClientStat;
    })
    .filter((c) => c.tokens > 0 || c.cost > 0 || c.messages > 0)
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);

  const total = stats.reduce((sum, c) => sum + c.tokens, 0);
  for (const c of stats) c.share = total > 0 ? c.tokens / total : 0;
  return stats;
}

function clientsFromModels(models: SessionModelStat[]): SessionClientStat[] {
  const map = new Map<string, SessionClientStat>();
  for (const m of models) {
    const hit =
      map.get(m.client) ??
      ({
        id: m.client,
        label: m.clientLabel,
        hex: m.hex,
        tokens: 0,
        cost: 0,
        messages: 0,
        share: 0,
      } satisfies SessionClientStat);
    hit.tokens += m.tokens;
    hit.cost += m.cost;
    hit.messages += m.messages;
    map.set(m.client, hit);
  }
  const stats = [...map.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);
  const total = stats.reduce((sum, c) => sum + c.tokens, 0);
  for (const c of stats) c.share = total > 0 ? c.tokens / total : 0;
  return stats;
}

function normalizeDaily(rows: DailyDTO[] | undefined): SessionDayPoint[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((d) => ({
      date: d.date || "",
      tokens: num(d.tokens),
      cost: num(d.cost),
      messages: count(d.messages),
    }))
    .filter((d) => d.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Build the immutable card model. `now` is the modal's open-time snapshot so a
 * live session's elapsed time, rates and export date do not drift between the
 * preview and the 3× render.
 */
export function buildSessionCardData(
  detail: SessionDetailLike,
  now: number,
): SessionCardData {
  const snapshotAt = Number.isFinite(now) ? now : Date.now();
  const trip = detail.trip ?? ({} as TripDTO);
  const deltas = detail.deltas ?? {};
  const rawModels = Array.isArray(detail.models) ? detail.models : [];
  const models = buildModels(rawModels);

  const startMs = parseMs(trip.started_at);
  const stopMs = parseMs(trip.stopped_at);
  // `active` is authoritative when present; the stopped_at fallback keeps an
  // older backend (before the flag existed) working.
  const isLive = trip.active === true || (!trip.stopped_at && trip.active !== false);

  const reportedDuration = num(detail.duration_ms);
  const computedDuration =
    startMs != null
      ? Math.max(0, (stopMs ?? (isLive ? snapshotAt : startMs)) - startMs)
      : 0;
  const durationMs = reportedDuration > 0 ? reportedDuration : computedDuration;

  const modelTokens = models.reduce((sum, m) => sum + m.tokens, 0);
  const modelCost = models.reduce((sum, m) => sum + m.cost, 0);
  const modelMessages = models.reduce((sum, m) => sum + m.messages, 0);

  const input = num(deltas.input);
  const output = num(deltas.output);
  const cacheRead = num(deltas.cache_read);
  const cacheWrite = num(deltas.cache_write);
  const reasoning = num(deltas.reasoning);
  const streamTotal = input + output + cacheRead + cacheWrite + reasoning;

  const tokens = num(deltas.tokens) || streamTotal || modelTokens;
  const cost = num(deltas.cost) || modelCost;
  const messages = count(deltas.messages) || modelMessages;
  const cacheHit = streamTotal > 0 ? cacheRead / streamTotal : 0;

  let clients = Array.isArray(detail.clients) ? buildClients(detail.clients) : [];
  if (clients.length === 0 && models.length > 0) clients = clientsFromModels(models);

  const daily = normalizeDaily(detail.daily);

  const reportedPeak = detail.peak_day;
  const reportedPeakTokens = reportedPeak ? num(reportedPeak.tokens) : 0;
  const derivedPeak = daily.reduce<SessionDayPoint | null>(
    (best, d) => (!best || d.tokens > best.tokens ? d : best),
    null,
  );
  const peakDay =
    reportedPeak && reportedPeakTokens > 0
      ? {
          date: reportedPeak.date,
          label: dayLabel(reportedPeak.date),
          tokens: reportedPeakTokens,
          cost: num(reportedPeak.cost),
        }
      : derivedPeak && derivedPeak.tokens > 0
        ? {
            date: derivedPeak.date,
            label: dayLabel(derivedPeak.date),
            tokens: derivedPeak.tokens,
            cost: derivedPeak.cost,
          }
        : null;

  const requestedTop = detail.top_model?.trim() || null;
  const matchedTop = requestedTop
    ? models.find((m) => m.model === requestedTop || m.short === requestedTop) ?? null
    : null;
  const topEntry = matchedTop ?? models[0] ?? null;
  const topModel = matchedTop?.model ?? topEntry?.model ?? requestedTop;

  const elapsedMin = durationMs / 60_000;
  const tokPerMin = elapsedMin > 0 ? tokens / elapsedMin : 0;
  const costPerHour = durationMs > 0 ? cost / (durationMs / 3_600_000) : 0;

  const name = (trip.name || "Untitled focus").trim() || "Untitled focus";
  const exportDate = format(new Date(snapshotAt), "yyyy-MM-dd");
  const timeRange = startMs != null
    ? `${clock(startMs)}–${stopMs != null ? clock(stopMs) : isLive ? "LIVE" : "—"}`
    : "—";
  const dateLabel = startMs != null ? dayStamp(startMs) : "—";

  return {
    name,
    isLive,
    statusLabel: isLive ? "Live snapshot" : "Complete",
    stopReason: stopReasonOf(trip, isLive),
    scopeLabel: scopeLabelOf(trip),

    dateLabel,
    timeRange,
    durationMs,
    durationLabel: durationMs > 0 ? fmtDurationMs(durationMs) : isLive ? "<1m" : "—",

    tokens,
    cost,
    messages,
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    cacheHit,

    sessions:
      typeof detail.sessions === "number" && Number.isFinite(detail.sessions)
        ? Math.max(0, Math.round(detail.sessions))
        : null,
    modelsUsed: models.length,
    clientsUsed: clients.length,

    topModel,
    topModelLabel: topModel ? prettyModel(topModel) : null,
    topModelTokens: topEntry?.tokens ?? 0,
    topModelShare: topEntry?.share ?? 0,

    peakDay,

    tokPerMin,
    costPerHour,

    models,
    clients,
    daily,

    hasUsage: tokens > 0 || cost > 0 || messages > 0,
    exportDate,
    fileName: `tokentracker-focus-${slugifyName(name)}-${exportDate}.png`,
    seed: `${tokens}:${cost}:${messages}:${daily.length}:${models.length}:${name}`,
  };
}

/** Compact token rate for the facts strip. */
export function formatTokenRate(tokensPerMinute: number): string {
  if (!Number.isFinite(tokensPerMinute) || tokensPerMinute <= 0) return "—";
  if (tokensPerMinute < 1) return `${tokensPerMinute.toFixed(2)}/min`;
  return `${fmtTokens(tokensPerMinute)}/min`;
}
