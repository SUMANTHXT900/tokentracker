/**
 * Real-data story derivation for the share cards. Everything the card renders
 * (hero, rhythm chart, dominance bars, bento, streak) is computed here from the
 * snapshot so the component stays a dumb renderer.
 */
import { eachDayOfInterval, format, parseISO } from "date-fns";
import type { DailyDTO, UsageSnapshotDTO } from "../tauri";
import { fmtCost, fmtPct, fmtTokens, splitCost, splitTokens } from "../format";
import { getClientVisual } from "../client-color";
import { estimateTextW } from "./geometry";
import type { HeroMetric } from "./types";

export interface SeriesPoint {
  date: string;
  tokens: number;
  cost: number;
  messages: number;
}

export interface ChartPoint {
  date: string;
  from: string;
  to: string;
  value: number;
  tokens: number;
  cost: number;
}

export interface ModelStat {
  key: string;
  model: string;
  short: string;
  client: string;
  clientLabel: string;
  hex: string;
  tokens: number;
  cost: number;
  messages: number;
  value: number;
  share: number;
}

export interface ClientStat {
  id: string;
  label: string;
  hex: string;
  tokens: number;
  cost: number;
  value: number;
  share: number;
}

export interface BentoCell {
  label: string;
  value: string;
  sub: string;
}

export interface CardData {
  hasData: boolean;
  seed: string;
  metric: HeroMetric;
  totalTokens: number;
  totalCost: number;
  totalMessages: number;
  heroNum: string;
  heroUnit: string;
  heroLabel: string;
  heroHint: string;
  secondary: string;
  rangeLabel: string;
  startLabel: string;
  endLabel: string;
  windowDays: number;
  activeDays: number;
  cacheHit: number;
  sessions: number;
  messages: number;
  clientCount: number;
  streak: number;
  bestStreak: number;
  avgPerDay: number;
  avgLabel: string;
  peak: { date: string; label: string; tokens: number; cost: number } | null;
  peakIndex: number;
  series: SeriesPoint[];
  chart: ChartPoint[];
  chartValues: number[];
  models: ModelStat[];
  clients: ClientStat[];
  bento: BentoCell[];
  footerParts: string[];
  exportDate: string;
}

const EMPTY_BENTO: BentoCell[] = [
  { label: "Active Days", value: "0d", sub: "no window" },
  { label: "Cache Hit", value: "0.0%", sub: "of all tokens" },
  { label: "Sessions", value: "0", sub: "0 messages" },
  { label: "Peak Day", value: "0", sub: "—" },
];

export function dayLabel(date: string): string {
  if (!date) return "—";
  try {
    return format(parseISO(date), "MMM d").toUpperCase();
  } catch {
    return date.slice(5);
  }
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

/** "provider/model" → "model", and drop trailing yyyymmdd build stamps. */
export function prettyModel(name: string): string {
  const raw = (name || "unknown").trim();
  const tail = raw.includes("/") ? (raw.split("/").pop() ?? raw) : raw;
  return tail.replace(/[-_]\d{6,8}$/, "");
}

/** Contiguous calendar days so gaps in the data read as real zero days. */
function contiguous(daily: DailyDTO[]): SeriesPoint[] {
  if (daily.length === 0) return [];
  const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : 1));
  const start = parseISO(sorted[0].date);
  const end = parseISO(sorted[sorted.length - 1].date);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return sorted.map((d) => ({
      date: d.date,
      tokens: d.tokens ?? 0,
      cost: d.cost ?? 0,
      messages: d.messages ?? 0,
    }));
  }
  const byDate = new Map(sorted.map((d) => [d.date, d]));
  const out: SeriesPoint[] = eachDayOfInterval({ start, end }).map((d) => {
    const key = format(d, "yyyy-MM-dd");
    const hit = byDate.get(key);
    return {
      date: key,
      tokens: hit?.tokens ?? 0,
      cost: hit?.cost ?? 0,
      messages: hit?.messages ?? 0,
    };
  });
  return out.length > 400 ? out.slice(out.length - 400) : out;
}

/** Fallback series when the backend sends rows but no daily rollup. */
function seriesFromRows(rows: UsageSnapshotDTO["rows"]): SeriesPoint[] {
  const map = new Map<string, SeriesPoint>();
  for (const r of rows) {
    const key = r.date || format(new Date(r.timestamp), "yyyy-MM-dd");
    const hit = map.get(key) ?? { date: key, tokens: 0, cost: 0, messages: 0 };
    hit.tokens += r.input + r.output + r.cache_read + r.cache_write + r.reasoning;
    hit.cost += r.cost;
    hit.messages += r.message_count;
    map.set(key, hit);
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function bucketize(series: SeriesPoint[], metric: HeroMetric, maxBuckets: number) {
  const take = (p: SeriesPoint, from: string, to: string): ChartPoint => ({
    date: to,
    from,
    to,
    value: metric === "tokens" ? p.tokens : p.cost,
    tokens: p.tokens,
    cost: p.cost,
  });
  if (series.length === 0) return [];
  if (series.length <= maxBuckets) {
    return series.map((p) => take(p, p.date, p.date));
  }
  const size = Math.ceil(series.length / maxBuckets);
  const out: ChartPoint[] = [];
  for (let i = 0; i < series.length; i += size) {
    const chunk = series.slice(i, i + size);
    const acc = chunk.reduce(
      (a, p) => ({
        tokens: a.tokens + p.tokens,
        cost: a.cost + p.cost,
        messages: a.messages + p.messages,
      }),
      { tokens: 0, cost: 0, messages: 0 },
    );
    out.push(
      take(
        { date: chunk[chunk.length - 1].date, ...acc },
        chunk[0].date,
        chunk[chunk.length - 1].date,
      ),
    );
  }
  return out;
}

function streakInfo(series: SeriesPoint[]): { current: number; best: number } {
  let best = 0;
  let run = 0;
  for (const p of series) {
    if (p.tokens > 0 || p.cost > 0) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  let current = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const p = series[i];
    if (p.tokens > 0 || p.cost > 0) current += 1;
    else break;
  }
  return { current, best };
}

function cacheHitOf(fields: {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
}[]): number {
  let read = 0;
  let total = 0;
  for (const f of fields) {
    read += f.cache_read ?? 0;
    total += (f.input ?? 0) + (f.output ?? 0) + (f.cache_read ?? 0) + (f.cache_write ?? 0) + (f.reasoning ?? 0);
  }
  return total > 0 ? read / total : 0;
}

export function buildCardData(
  snap: UsageSnapshotDTO | undefined,
  metric: HeroMetric,
  maxBuckets: number,
): CardData {
  const exportDate = format(new Date(), "yyyy-MM-dd");
  const modelRows = snap?.models ?? [];
  const totalTokens = Math.max(
    0,
    snap?.total_tokens ?? modelRows.reduce((a, m) => a + (m.tokens ?? 0), 0),
  );
  const totalCost = Math.max(
    0,
    snap?.total_cost ?? modelRows.reduce((a, m) => a + (m.cost ?? 0), 0),
  );
  const sessions = snap?.sessions.length ?? 0;
  const clientCount = new Set(
    [...modelRows.map((m) => m.client), ...(snap?.clients ?? [])].filter(Boolean),
  ).size;

  const daily = snap?.daily ?? [];
  const series = daily.length > 0 ? contiguous(daily) : seriesFromRows(snap?.rows ?? []);

  const barValue = (p: { tokens: number; cost: number }) =>
    metric === "tokens" ? p.tokens : p.cost;

  const windowDays = series.length;
  const activeDays = series.filter((p) => p.tokens > 0 || p.cost > 0).length;
  const messages =
    snap?.total_messages && snap.total_messages > 0
      ? snap.total_messages
      : series.reduce((a, p) => a + p.messages, 0);
  const { current, best } = streakInfo(series);
  const avgPerDay = activeDays > 0 ? (metric === "tokens" ? totalTokens : totalCost) / activeDays : 0;

  const peakPoint = series.reduce<SeriesPoint | null>((best, p) => {
    if (!best) return p.tokens > 0 ? p : null;
    return p.tokens > best.tokens ? p : best;
  }, null);
  const peak = peakPoint
    ? {
        date: peakPoint.date,
        label: dayLabel(peakPoint.date),
        tokens: peakPoint.tokens,
        cost: peakPoint.cost,
      }
    : null;

  const chart = bucketize(series, metric, Math.max(12, maxBuckets));
  const chartValues = chart.map((p) => p.value);
  const peakIndex = peak
    ? chart.findIndex((p) => p.from <= peak.date && peak.date <= p.to)
    : -1;

  const split = metric === "tokens" ? splitTokens(totalTokens) : splitCost(totalCost);
  const heroNum = split.num;
  const heroUnit = split.unit;
  const heroLabel = metric === "tokens" ? "Tokens tracked" : "Total spend";
  const heroHint =
    metric === "tokens"
      ? `${windowDays}D window`
      : activeDays > 0
        ? `${fmtCost(avgPerDay)}/day`
        : "no active days";
  const secondary =
    metric === "tokens"
      ? `${fmtCost(totalCost)} spend`
      : `${fmtTokens(totalTokens)} tokens`;

  /* ---- model dominance ---- */
  const costTotal = modelRows.reduce((a, m) => a + (m.cost ?? 0), 0);
  const metricKey: HeroMetric = metric === "spend" && costTotal <= 0 ? "tokens" : metric;
  const modelStats: ModelStat[] = [...modelRows]
    .map((m) => {
      const visual = getClientVisual(m.client);
      return {
        key: `${m.client}:${m.model}`,
        model: m.model,
        short: prettyModel(m.model),
        client: m.client,
        clientLabel: visual.label,
        hex: visual.hex,
        tokens: m.tokens ?? 0,
        cost: m.cost ?? 0,
        messages: m.messages ?? 0,
        value: metricKey === "tokens" ? (m.tokens ?? 0) : (m.cost ?? 0),
        share: 0,
      };
    })
    .sort((a, b) => b.value - a.value);
  const modelTotal = modelStats.reduce((a, m) => a + m.value, 0);
  for (const m of modelStats) m.share = modelTotal > 0 ? m.value / modelTotal : 0;

  /* ---- client mix ---- */
  const clientMap = new Map<string, ClientStat>();
  for (const m of modelStats) {
    const visual = getClientVisual(m.client);
    const hit =
      clientMap.get(m.client) ??
      ({
        id: m.client,
        label: visual.label,
        hex: visual.hex,
        tokens: 0,
        cost: 0,
        value: 0,
        share: 0,
      } satisfies ClientStat);
    hit.tokens += m.tokens;
    hit.cost += m.cost;
    hit.value += m.value;
    clientMap.set(m.client, hit);
  }
  const clients = [...clientMap.values()].sort((a, b) => b.value - a.value);
  const clientTotal = clients.reduce((a, c) => a + c.value, 0);
  for (const c of clients) c.share = clientTotal > 0 ? c.value / clientTotal : 0;

  const cacheHit = cacheHitOf(
    modelRows.length > 0 ? modelRows : (snap?.rows ?? []),
  );

  const bento: BentoCell[] =
    totalTokens > 0 || totalCost > 0 || sessions > 0
      ? [
          {
            label: "Active Days",
            value: `${activeDays}d`,
            sub: windowDays > 0 ? `of ${windowDays}d window` : "no window",
          },
          {
            label: "Cache Hit",
            value: fmtPct(cacheHit),
            sub: "of all tokens",
          },
          {
            label: "Sessions",
            value: fmtCount(sessions),
            sub: `${fmtCount(messages)} msgs`,
          },
          {
            label: "Peak Day",
            value: peak ? fmtTokens(peak.tokens) : "0",
            sub: peak ? peak.label : "—",
          },
        ]
      : EMPTY_BENTO;

  const rangeLabel =
    series.length > 0
      ? `${dayLabel(series[0].date)} — ${dayLabel(series[series.length - 1].date)}, ${format(parseISO(series[series.length - 1].date), "yyyy")}`
      : "NO RANGE";

  const hasData = totalTokens > 0 || totalCost > 0 || sessions > 0;

  return {
    hasData,
    seed: `${totalTokens}:${totalCost}:${series.length}:${sessions}:${metricKey}`,
    metric: metricKey,
    totalTokens,
    totalCost,
    totalMessages: messages,
    heroNum,
    heroUnit,
    heroLabel,
    heroHint,
    secondary,
    rangeLabel,
    startLabel: series.length > 0 ? dayLabel(series[0].date) : "—",
    endLabel: series.length > 0 ? dayLabel(series[series.length - 1].date) : "—",
    windowDays,
    activeDays,
    cacheHit,
    sessions,
    messages,
    clientCount,
    streak: Math.max(current, best),
    bestStreak: best,
    avgPerDay,
    avgLabel: metricKey === "tokens" ? fmtTokens(avgPerDay) : fmtCost(avgPerDay),
    peak,
    peakIndex: peakIndex < 0 ? Math.max(0, chartValues.indexOf(Math.max(...chartValues, 0))) : peakIndex,
    series,
    chart,
    chartValues,
    models: modelStats,
    clients,
    bento,
    footerParts: [
      `${fmtTokens(totalTokens)} tokens`,
      fmtCost(totalCost),
      `${fmtCount(sessions)} sessions`,
    ],
    exportDate,
  };
}

/**
 * Packed clients for the mix strip — returns what actually fits.
 * `pill` renders chip chrome (single-column cards), `plain` renders a compact
 * dot + label + share run for the narrow wide-layout column.
 */
export function packClients(
  clients: ClientStat[],
  width: number,
  fontSize: number,
  labelWidth: number,
  gap: number,
  variant: "pill" | "plain" = "pill",
): { shown: ClientStat[]; rest: number } {
  const itemW = (c: ClientStat) =>
    estimateTextW(`${c.label} ${fmtPct(c.share)}`, fontSize, 0.03) +
    (variant === "pill" ? 23 : 9);
  let avail = width - labelWidth - gap;
  const shown: ClientStat[] = [];
  for (const c of clients) {
    const w = itemW(c) + (shown.length > 0 ? gap : 0);
    if (w > avail) break;
    shown.push(c);
    avail -= w;
  }
  let rest = clients.length - shown.length;
  if (rest > 0) {
    const restW = estimateTextW(`+${rest}`, fontSize, 0) + (variant === "pill" ? 14 : 2);
    if (avail < restW) {
      const popped = shown.pop();
      if (popped) {
        avail += itemW(popped) + (shown.length > 0 ? gap : 0);
        rest += 1;
      }
    }
  }
  return { shown, rest };
}

export { fmtCount };
