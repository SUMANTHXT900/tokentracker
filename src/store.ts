import { create } from "zustand";

export type GroupBy = "day" | "model" | "project" | "client";
export type Page =
  | "overview"
  | "sessions"
  | "projects"
  | "models"
  | "calendar"
  | "usage"
  | "trips"
  | "cards"
  | "settings";

interface FilterState {
  page: Page;
  clients: string[];
  since: string | null;
  until: string | null;
  groupBy: GroupBy;
  /** Currently viewed focus session (running or closed). */
  focusTripId: string | null;
  heatmapDay: string | null;
  setPage: (p: Page) => void;
  setClients: (c: string[]) => void;
  setRange: (since: string | null, until: string | null) => void;
  setGroupBy: (g: GroupBy) => void;
  setFocusTripId: (id: string | null) => void;
  setHeatmapDay: (d: string | null) => void;
  reset: () => void;
}

export const useStore = create<FilterState>((set) => ({
  page: "overview",
  clients: [],
  since: null,
  until: null,
  groupBy: "day",
  focusTripId: null,
  heatmapDay: null,
  setPage: (page) => set({ page }),
  setClients: (clients) => set({ clients }),
  setRange: (since, until) => set({ since, until }),
  setGroupBy: (groupBy) => set({ groupBy }),
  setFocusTripId: (focusTripId) => set({ focusTripId }),
  setHeatmapDay: (heatmapDay) => set({ heatmapDay }),
  reset: () => set({ clients: [], since: null, until: null, heatmapDay: null }),
}));
