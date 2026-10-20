import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

/**
 * Frontend mirrors of backend DTOs.
 * Source of truth: src-tauri/src/adapter.rs (tokscale-core).
 * Always uses real tokscale-core data: via Tauri IPC inside the desktop app,
 * or via the Vite real-data bridge (`/__tokentracker/*`) when opened in a browser.
 */

export interface UnifiedRowDTO {
  client: string;
  model: string;
  provider: string;
  session_id: string;
  workspace_key: string | null;
  workspace_label: string | null;
  timestamp: number;
  date: string; // YYYY-MM-DD
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cost: number;
  message_count: number;
}

export interface DailyDTO {
  date: string;
  tokens: number;
  cost: number;
  messages: number;
  input: number;
  output: number;
  cache_read: number;
}

export interface ModelRowDTO {
  model: string;
  provider: string;
  client: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  tokens: number;
  cost: number;
  messages: number;
}

export interface SessionRowDTO {
  session_id: string;
  client: string;
  model: string;
  models?: string[];
  session_title?: string | null;
  workspace_key?: string | null;
  workspace_label?: string | null;
  agent?: string | null;
  tokens: number;
  input?: number;
  output?: number;
  cache_read?: number;
  reasoning?: number;
  cost: number;
  messages: number;
  first_seen: number;
  last_seen: number;
}

export interface ProjectRowDTO {
  workspace_key: string;
  workspace_label: string;
  tokens: number;
  cost: number;
  messages: number;
  sessions: number;
  last_seen?: number;
  clients?: string[];
  top_model?: string;
}

export interface UsageSnapshotDTO {
  rows: UnifiedRowDTO[];
  daily: DailyDTO[];
  models: ModelRowDTO[];
  sessions: SessionRowDTO[];
  projects: ProjectRowDTO[];
  total_tokens: number;
  total_cost: number;
  total_messages: number;
  clients: string[];
}

export interface RescanResultDTO {
  scanned_files: number;
  new_records: number;
  took_ms: number;
}

export interface LiveStatusDTO {
  watching: boolean;
  last_scan_at: string | null;
  pending_files: number;
  errors: string[];
}

export type TripScope = { kind: "all" } | { kind: "clients"; clients: string[] };
export type StopMode =
  | { kind: "manual" }
  | { kind: "after"; hours: number }
  | { kind: "idle"; minutes: number };

export interface TripDTO {
  trip_id: string;
  name: string;
  scope: TripScope;
  stop: StopMode;
  started_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
  resumed?: boolean;
  /** True while the backend has this trip as the running session. */
  active: boolean;
}

export interface TripDeltaDTO {
  tokens: number;
  cost: number;
  messages: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
}

export interface TripClientDTO {
  client: string;
  tokens: number;
  cost: number;
  messages: number;
}

export interface TripDetailDTO {
  trip: TripDTO;
  baseline: { totals: { tokens: number; cost: number }; by_model: ModelRowDTO[] };
  deltas: TripDeltaDTO;
  models: ModelRowDTO[];
  clients: TripClientDTO[];
  sessions: number;
  duration_ms: number;
  top_model: string | null;
  peak_day: DailyDTO | null;
  daily: DailyDTO[];
}

export interface Filters {
  clients: string[];
  since: string | null; // YYYY-MM-DD
  until: string | null; // YYYY-MM-DD
}

const EMPTY_SNAPSHOT: UsageSnapshotDTO = {
  rows: [],
  daily: [],
  models: [],
  sessions: [],
  projects: [],
  total_tokens: 0,
  total_cost: 0,
  total_messages: 0,
  clients: [],
};

function hasTauriIpc(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function safeInvoke<T>(cmd: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch {
    return fallback;
  }
}

export async function cmdSnapshot(f: Filters): Promise<UsageSnapshotDTO> {
  if (hasTauriIpc()) {
    return safeInvoke<UsageSnapshotDTO>(
      "get_usage_snapshot",
      {
        clients: f.clients.length > 0 ? f.clients : null,
        since: f.since,
        until: f.until,
      },
      EMPTY_SNAPSHOT,
    );
  }

  // Browser dev mode: fetch real tokscale-core snapshot from Vite bridge
  try {
    const params = new URLSearchParams();
    if (f.clients.length > 0) params.set("clients", f.clients.join(","));
    if (f.since) params.set("since", f.since);
    if (f.until) params.set("until", f.until);
    const qs = params.toString();
    const res = await fetch(`/__tokentracker/snapshot${qs ? `?${qs}` : ""}`);
    if (res.ok) {
      return (await res.json()) as UsageSnapshotDTO;
    }
  } catch {
    // ignore
  }
  return EMPTY_SNAPSHOT;
}

export async function cmdRescan(): Promise<RescanResultDTO> {
  if (hasTauriIpc()) {
    return safeInvoke<RescanResultDTO>(
      "rescan_now",
      {},
      { scanned_files: 0, new_records: 0, took_ms: 0 },
    );
  }
  try {
    const res = await fetch("/__tokentracker/rescan");
    if (res.ok) return (await res.json()) as RescanResultDTO;
  } catch {
    // ignore
  }
  return { scanned_files: 0, new_records: 0, took_ms: 0 };
}

export async function cmdLiveStatus(): Promise<LiveStatusDTO> {
  if (hasTauriIpc()) {
    return safeInvoke<LiveStatusDTO>(
      "get_live_status",
      {},
      { watching: false, last_scan_at: null, pending_files: 0, errors: [] },
    );
  }
  try {
    const res = await fetch("/__tokentracker/live-status");
    if (res.ok) return (await res.json()) as LiveStatusDTO;
  } catch {
    // ignore
  }
  return { watching: false, last_scan_at: null, pending_files: 0, errors: [] };
}

export async function cmdListTrips(): Promise<TripDTO[]> {
  // Browser dev bridge has no trip store; desktop must surface IPC errors so
  // the logbook can show a retry state instead of a false empty list.
  if (!hasTauriIpc()) return [];
  return invoke<TripDTO[]>("list_trips");
}

export async function cmdStartTrip(
  name: string,
  scope: TripScope,
  stop: StopMode,
): Promise<TripDTO> {
  return invoke<TripDTO>("start_trip", { name, scope, stop });
}

export async function cmdStopTrip(tripId: string): Promise<TripDTO> {
  // Tauri v2 camelCases command arguments; the Rust parameter is `trip_id`,
  // so it must arrive as `tripId`.
  return invoke<TripDTO>("stop_trip", { tripId });
}

export async function cmdGetTrip(tripId: string): Promise<TripDetailDTO> {
  // Same Tauri v2 argument mapping as stop_trip.
  return invoke<TripDetailDTO>("get_trip", { tripId });
}

export async function onUsageUpdated(cb: (payload?: unknown) => void): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<unknown>("usage://updated", (e) => {
      cb(e.payload);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

export async function onTripStopped(
  cb: (info: { trip_id: string; reason: string }) => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<{ trip_id: string; reason: string }>("trip://stopped", (e) => {
      cb(e.payload);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

export function useSnapshot(f: Filters) {
  return useQuery({
    queryKey: ["usage", f.clients, f.since, f.until],
    queryFn: () => cmdSnapshot(f),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    placeholderData: (prev) => prev,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useLiveStatus() {
  return useQuery({
    queryKey: ["live-status"],
    queryFn: cmdLiveStatus,
    staleTime: 5_000,
    placeholderData: (prev) => prev,
    refetchOnWindowFocus: false,
  });
}

export function useTrips() {
  return useQuery({
    queryKey: ["trips"],
    queryFn: cmdListTrips,
    staleTime: 5_000,
    // Keep the live session / logbook fresh while a session is running.
    refetchInterval: (query) => {
      const trips = query.state.data;
      return trips?.some((t) => t.active || !t.stopped_at) ? 15_000 : false;
    },
  });
}

export function useTripDetail(tripId: string | null, live: boolean) {
  return useQuery({
    queryKey: ["trip", tripId],
    queryFn: () => cmdGetTrip(tripId as string),
    enabled: !!tripId,
    staleTime: 5_000,
    placeholderData: (prev) => prev,
    retry: 1,
    refetchInterval: live ? 15_000 : false,
  });
}
