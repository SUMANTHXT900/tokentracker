# Architecture — tokentracker

> Local-first token/cost tracker. Tauri v2 + React + SQLite sidecar model.
> Status: scaffold spec. Parallel workers own `package.json`, `src/`, `src-tauri/Cargo.toml` — do not duplicate here.

## 1. Engine

- **Engine crate: `tokscape-core v4.19.1` (pinned).**
  - Upstream: `tokscale-core` library from [github.com/junhoyeo/tokscale](https://github.com/junhoyeo/tokscale). See `ATTRIBUTION.md`.
  - Reuse scope: **core parsing/aggregation lib only**. No TUI code, no upstream frontend code, no submit/leaderboard modules.
  - Pin: exact `=4.19.1` in `src-tauri/Cargo.toml` (owned by another worker — do not edit here). Dependabot/renovate blocked for this crate; bumps are manual + reviewed.
  - License: MIT (attributed, see `ATTRIBUTION.md`).

### Adapter boundary

```
Frontend (React/TS, src/) 
  └─ invoke() ─> Tauri commands (src-tauri/src/commands.rs)
                    └─ Adapter layer (src-tauri/src/adapter.rs)
                         └─ tokscape-core v4.19.1 (pure lib: parse + aggregate)
                              └─ Local sources: Codex sessions (~/.codex/sessions/*.jsonl),
                                                Claude projects (~/.claude/projects/**/*.jsonl),
                                                SQLite WAL sidecars where present
```

Rules:

1. `tokscape-core` is never called from frontend. All access goes through `adapter.rs`.
2. Adapter responsibilities:
   - Resolve source paths per OS (macOS/Linux/Windows).
   - Normalize upstream row shape → local `UsageRecord { dedup_key, ts, model, input, output, cache_read, cache_write, cost_usd, source, session_id }`.
   - Own the **deferred cache** (`~/.tokentracker/cache.sqlite` or app-local-data): `file_cursor(path, mtime, offset, hash)` + `records(dedup_key PK, ...)`.
   - Compute pricing via `tokscale-core`'s public catalogs (auto-fetched, 1-hour disk cache; optional local `custom-pricing.json` overrides — see §4).
   - Expose trip-mode filtering (baseline watermark, see §6).
3. Upstream upgrades must not change `UsageRecord` schema without a migration + spec update here.

## 2. Tauri commands (stable API surface)

Defined in `src-tauri/src/commands.rs` (owned by backend worker). Frontend may only use these:

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_usage_overview` | `{ range: "7d" \| "30d" \| "all", trip_id?: string }` | `{ totals, by_model[], by_source[], daily[] }` | Reads deferred cache only, never re-parses inline. |
| `get_daily_breakdown` | `{ days: number, trip_id?: string }` | `DailyRow[]` | For bar chart. |
| `get_model_breakdown` | `{ range: string, trip_id?: string }` | `ModelRow[]` | Model-normalized names via adapter. |
| `get_live_status` | `{}` | `{ watching: bool, last_scan_at, pending_files, errors[] }` | Watcher heartbeat. |
| `rescan_now` | `{}` | `{ scanned_files, new_records, took_ms }` | Manual full/incremental scan trigger. Debounced 5s. |
| `list_trips` | `{}` | `Trip[]` | Trip history. |
| `start_trip` | `{ name: string, scope: TripScope, stop: StopMode }` | `Trip` | See §6. Captures `baseline dedup_key` watermark. |
| `stop_trip` | `{ trip_id: string }` | `Trip` | Manual stop. Computes deltas vs baseline. |
| `get_trip` | `{ trip_id: string }` | `TripDetail { baseline, deltas, daily[] }` | Delta = records with `rowid > baseline_watermark` + scope filter. |
| `get_settings` | `{}` | — | Not registered; there is no persisted settings command. |
| `save_settings` | `{ patch }` | — | Not registered. |
| `check_for_updates` | — | — | Frontend-only: `src/updater.tsx` calls `check()` from `@tauri-apps/plugin-updater`; no Tauri command. |

No `submit_*`, no `leaderboard_*`, no `telemetry_*` commands. Any PR adding one must update this doc + privacy section or be rejected.

Events emitted (backend → frontend):

| Event | Payload | When |
|---|---|---|
| `usage://updated` | `{ new_records: number, took_ms: number, at: ISO }` | After each incremental parse commits to cache. Frontend invalidates React Query `["usage"]`. |
| `trip://stopped` | `{ trip_id: string, reason: "manual" \| "after" \| "idle" }` | Auto/manual trip end. |
| `watcher://error` | `{ path: string, message: string }` | Non-fatal per-file parse failure. Toast only. |

## 3. Frontend routes

Owned by frontend worker (`src/`). Canonical routes — do not add telemetry-gated routes:

| Route | File (convention) | Purpose |
|---|---|---|
| `/` | `src/routes/Dashboard.tsx` | Overview totals, daily bar, model donut, live badge (`usage://updated` subscriber). |
| `/trips` | `src/routes/Trips.tsx` | Trip list + detail deltas. |
| `/trips/new` | `src/routes/TripSetup.tsx` (modal or page) | Setup wizard: All vs specific clients, stop mode picker. See §6. |
| `/settings` | `src/routes/Settings.tsx` | Watched dirs (read-only display), update status/check. No account/login UI. |

State:

- Data fetching via TanStack Query keyed `["usage", range]`, `["trip", id]`; invalidation only on `usage://updated` / `trip://stopped`.
- No router-level analytics, no pageview beacons.

## 4. Network / privacy guarantee

1. **No submit / leaderboard / telemetry.** Upstream `tokscale` TUI ships opt-in submit + leaderboard; we do **not** compile or expose those modules. `grep -r "submit\|leaderboard\|telemetry" src-tauri/src` must be empty in CI (add as lint step).
2. **Outbound network is limited to three functions:**
   - **(a) Pricing catalogs — automatic.** Cost lookup is delegated to `tokscale-core`, which loads three public datasets and caches each on disk for **1 hour** (`pricing/cache.rs`, `CACHE_TTL_SECS = 3600`): LiteLLM (`raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`), OpenRouter (`openrouter.ai/api/v1/models`, then `openrouter.ai/api/v1/models/{id}/endpoints` for catalog entries whose prefix is in a static author map), and models.dev (`models.dev/api.json`). A cache entry older than 1h triggers a refresh on the next process that needs prices; any failed source degrades to its stale cache, so offline use keeps the last catalog. The loaded service is then held in memory for the life of that process. There is no user-triggered pricing refresh button.
   - **(b) Update check — notify-only.** `tauri-plugin-updater` GETs `https://github.com/SUMANTHXT900/tokentracker/releases/latest/download/latest.json` once at launch and when the user clicks Settings → Updates → Check for updates. The URL has no `{{current_version}}` placeholder and no query parameters; the only client-derived value is the plugin's User-Agent (`tauri-plugin-updater/<plugin version>`). Downloads, installs, and restarts happen only after explicit user clicks; bundles are signature-verified.
   - **(c) Google Fonts.** `index.html` loads CSS from `fonts.googleapis.com/css2` and WOFF2 files from `fonts.gstatic.com` for the UI typefaces. Plain asset requests; no app data.
   - Nothing else: no analytics, crash reporting, telemetry, accounts, or other background calls.
3. **No usage data is sent.** Pricing requests are catalog-only: the OpenRouter per-model calls iterate the full public `/models` response filtered by a static author-prefix map (`pricing/openrouter.rs::get_author_provider_name`), not the user's used models. No request includes a token count, cost, model-usage list, session ID/title, workspace/project name, path, or identifier. **Never sent to any server:** prompt/message content, session titles, token counts, costs, model usage, workspace/project names, file paths, API keys/credentials, or any user identifier.
4. **Filesystem scope:** the backend reads known local agent-log roots (Codex, Claude, and the other supported `tokscale-core` clients) plus its own app-data/cache; optional `custom-pricing.json` is read from the config directory. No full-disk sweep, and file contents are never uploaded.
5. **Local data stays local:** parsed rows (model, tokens, cost, timestamps, session ID/title, workspace label) are written only to the local cache and returned over local IPC. Prompt/message bodies are not part of `UsageSnapshotDTO`.
6. **Updates:** stable-only GitHub Releases (see `.github/workflows/release.yml`). No beta/nightly auto-channel.

## 5. Live watcher design

Goal: dashboard feels live (<5s lag) without re-parsing GBs of JSONL.

```
notify (RecommendedWatcher, non-recursive per watched dir)
  │  create/modify/remove
  ▼
debounce 250ms ──coalesce──> scan_queue: Vec<PathBuf>
  │                              ▲
  │                              │ 3s fallback poll (covers SQLite WAL checkpoint + network-drive /
  │                              │  editors that don't emit notify, + missed events during sleep)
  ▼
incremental_parse(path):
  1. stat mtime+size; lookup file_cursor in cache.sqlite
  2. if unchanged → skip
  3. open, seek to cursor.offset, read only new lines (JSONL) /
     for SQLite WAL sidecars: query `WHERE rowid > cursor.rowid`
  4. adapter.normalize → batch insert with `INSERT OR IGNORE (dedup_key)`
  5. update cursor (offset/rowid, mtime, hash)
  6. commit; emit `usage://updated`
```

Details:

- **notify + 3s poll hybrid:** `notify` for immediacy; `tokio::time::interval(3s)` re-stats known files + discovers new `*.jsonl` / `*.db-wal` via lightweight directory mtime check. Poll never does full reads — stat-only unless cursor stale.
- **Deferred cache:** `cache.sqlite` (rusqlite, WAL mode) is the single source of truth for reads. Parsers never block `get_*` commands; commands read cache, watcher writes cache. `rescan_now` just forces queue drain.
- **SQLite WAL note:** some clients hold long write txns; reader opens with `immutable=0, journal_mode=WAL`, retries on `SQLITE_BUSY` with 50/100/200ms backoff, gives up → `watcher://error` toast, retried next tick. Never takes a write lock.
- **Backpressure:** queue cap 500 paths; overflow → coalesce to "full incremental sweep" (stat all cursors, no full re-read).
- **Emit:** `app.emit("usage://updated", payload)` from watcher task via `tauri::Emitter`. Frontend: single `listen` in `App.tsx`, invalidates queries. No polling from frontend.

## 6. Trip mode spec

Trips = scoped, time/watermark-bounded cost lenses (e.g. "weekend hack", "client X sprint").

### 6.1 Setup wizard (`/trips/new`)

Step 1 — Scope (required, radio):

- `All` — all clients/sources (default).
- `Specific clients` — multi-select checkboxes: `codex`, `claude` (+ future `opencode`, extensible enum). At least one required if not All. Stored as `TripScope { kind: "all" } | { kind: "clients", clients: ["codex","claude"] }`.

Step 2 — Stop mode (required, radio + conditional input):

- `manual` — runs until user clicks Stop. No timer.
- `after: N hours` — number input (0.5–168h). Scheduler stops at `started_at + N`, emits `trip://stopped { reason: "after" }`.
- `idle: M minutes` — number input (5–480m). Watcher tracks `last_new_record_at` within scope; if no new in-scope records for M minutes, auto-stop, emit `trip://stopped { reason: "idle" }`. Idle check runs on the 3s poll tick — zero extra timers.

Step 3 — Name (text, default `Trip <date>`), Review baseline (read-only preview: current totals), Confirm.

### 6.2 Baseline + persistence (as built)

- Trips are time-window lenses, not snapshots: `TripConfig { started_at_ms, ended_at_ms?, clients?, stop_mode }`. `get_trip` filters live snapshot rows to `[started_at, ended_at_or_now]` + client allow-list, so deltas always reflect current logs and pricing.
- Trips persist in `trips.json` (Tauri app-data dir), written atomically on every start/stop/auto-stop and loaded in `setup()`. Closing the app never loses a trip.
- On startup restore: active trips are flagged `resumed` (surfaced in the UI); expired `after` trips are closed retroactively at their deadline (`started_at + N`, reason `time-elapsed`); `idle` trips reconcile via the worker's next scan (≤60s). Usage from while the app was closed is included automatically — it lives in the agent logs on disk.
- Deltas are **not** copies — recomputed live from logs. This makes trips cheap and correct across restarts.

### 6.3 Edge cases

- Corrupt `trips.json` → quarantined aside (`trips.json.corrupt-<ts>`), history restarts empty — one bad write never bricks trips.
- Scope `clients` added in future: old trips with unknown client strings still filter by exact match, no migration needed.
- Restart with an active trip: manual trips resume live (delta covers the closed interval); `after` trips past deadline close at the deadline; `idle` trips close on the worker's next scan if quiet.

---

*Engine pin + reuse disclosed in `ATTRIBUTION.md`. Privacy deltas from upstream (removed submit/leaderboard) intentional.*
