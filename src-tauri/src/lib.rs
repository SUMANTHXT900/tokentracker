//! tokentracker Tauri 2 backend.
//!
//! Thin command layer over [`adapter`] (tokscale parsing) and [`trips`]
//! (trip windows). `tokscale_core` is used here only for the shared pricing
//! service; parsing stays in `adapter.rs`.

pub mod adapter;
pub mod trip_worker;
pub mod trips;
pub mod watcher;
pub mod window_state;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tokscale_core::pricing::PricingService;

use adapter::{UsageSnapshotDTO, parse_to_snapshot_async};
use trips::{TripConfig, capture_baseline, filter_rows_for_trip, trip_stop_now, trip_started_now_with_mode};

pub struct AppState {
    pub active_trip: Mutex<Option<TripConfig>>,
    pub trips: Mutex<Vec<TripConfig>>,
    pub last_scan_at: Mutex<Option<String>>,
    /// Resolved in `setup()`; None in unit-test contexts without an app dir.
    pub trips_file: Mutex<Option<PathBuf>>,
    /// Current pricing catalog. The 3-hour refresh swaps this for a catalog
    /// rebuilt from the freshly refreshed disk cache.
    pub pricing: Mutex<Option<Arc<PricingService>>>,
}

impl AppState {
    pub fn pricing(&self) -> Option<Arc<PricingService>> {
        self.pricing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_pricing(&self, service: Arc<PricingService>) {
        *self
            .pricing
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(service);
    }

    /// First use loads/initializes the catalog (network if the cache is stale);
    /// later calls reuse the in-session service.
    pub async fn ensure_pricing(&self) -> Option<Arc<PricingService>> {
        if let Some(service) = self.pricing() {
            return Some(service);
        }
        match PricingService::get_or_init().await {
            Ok(service) => {
                self.set_pricing(service.clone());
                Some(service)
            }
            Err(err) => {
                eprintln!("tokentracker: pricing init failed: {err}");
                None
            }
        }
    }
}

/// Snapshot the in-memory trip state to disk (best-effort; logs on failure,
/// never fails the calling command). Active trips are healed into the list
/// so the legacy `cmd_trip_start` path (active-only) survives restarts too.
///
/// Locking: snapshots `trips` and `active_trip` in SEPARATE scopes (never
/// nested) and heals with a re-checked short lock, always in the order
/// trips → active. All other code paths take these mutexes one at a time in
/// the same order, so no lock inversion (deadlock) is possible. Poisoned
/// mutexes are recovered via `into_inner` instead of skipping the persist
/// (skipping would silently lose data).
pub fn persist_trips(state: &State<'_, AppState>) {
    let path = match state
        .trips_file
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        Some(p) => p,
        None => return,
    };
    // Snapshot without nesting: each lock is released before the next.
    let trips_snapshot = state
        .trips
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let active_snapshot = state
        .active_trip
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    // Heal a legacy active-only trip into the in-memory list (re-check under
    // the lock: two concurrent persists must not push duplicates).
    if let Some(ref a) = active_snapshot {
        if !trips_snapshot.iter().any(|t| t.id == a.id) {
            let mut trips = state
                .trips
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !trips.iter().any(|t| t.id == a.id) {
                trips.push(a.clone());
            }
        }
    }
    // Re-read the (possibly healed) list for the store so disk and memory agree.
    let trips_for_store = state
        .trips
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let store = trips::TripStoreFile {
        trips: trips_for_store,
        active_trip_id: active_snapshot.map(|a| a.id),
    };
    if let Err(e) = trips::save_trips_file(&path, &store) {
        eprintln!("tokentracker: persist trips failed: {e}");
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RescanResultDTO {
    pub scanned_files: i32,
    pub new_records: i32,
    pub took_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveStatusDTO {
    pub watching: bool,
    pub last_scan_at: Option<String>,
    pub pending_files: i32,
    pub errors: Vec<String>,
}

// Frontend trip shapes (src/lib/tauri.ts). Backend stores TripConfig.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TripScopeDTO {
    All,
    Clients { clients: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StopModeDTO {
    Manual,
    After { hours: f64 },
    Idle { minutes: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TripDTO {
    pub trip_id: String,
    pub name: String,
    pub scope: TripScopeDTO,
    pub stop: StopModeDTO,
    pub started_at: String,
    pub stopped_at: Option<String>,
    pub stop_reason: Option<String>,
    pub resumed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TripDetailDTO {
    pub trip: TripDTO,
    pub baseline: serde_json::Value,
    pub deltas: serde_json::Value,
    pub daily: Vec<adapter::DailyDTO>,
}

fn ms_to_rfc3339(ms: i64) -> String {
    use chrono::{DateTime, Utc};
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

fn config_to_dto(t: &TripConfig) -> TripDTO {
    let scope = match &t.clients {
        None => TripScopeDTO::All,
        Some(c) if c.is_empty() => TripScopeDTO::All,
        Some(c) => TripScopeDTO::Clients {
            clients: c.clone(),
        },
    };
    let stop_mode: StopModeDTO = match t.stop_mode.as_str() {
        "after" => StopModeDTO::After {
            hours: t.stop_after_ms.unwrap_or(0) as f64 / 3_600_000.0,
        },
        "idle" => StopModeDTO::Idle {
            minutes: t.idle_after_ms.unwrap_or(0) as f64 / 60_000.0,
        },
        _ => StopModeDTO::Manual,
    };
    TripDTO {
        trip_id: t.id.clone(),
        name: t.name.clone(),
        scope,
        stop: stop_mode,
        started_at: ms_to_rfc3339(t.started_at_ms),
        stopped_at: t.ended_at_ms.map(ms_to_rfc3339),
        stop_reason: t.stop_reason.clone(),
        resumed: t.resumed,
    }
}

// ---------------------------------------------------------------------------
// Commands (names must match src/lib/tauri.ts)
// ---------------------------------------------------------------------------

/// Scan local clients and return a usage snapshot.
#[tauri::command]
async fn cmd_scan(
    state: State<'_, AppState>,
    home: Option<String>,
    clients: Option<Vec<String>>,
    since: Option<String>,
    until: Option<String>,
) -> Result<UsageSnapshotDTO, String> {
    let pricing = state.ensure_pricing().await;
    parse_to_snapshot_async(home, clients, since, until, pricing).await
}

/// Frontend alias: get_usage_snapshot
#[tauri::command]
async fn get_usage_snapshot(
    state: State<'_, AppState>,
    clients: Option<Vec<String>>,
    since: Option<String>,
    until: Option<String>,
) -> Result<UsageSnapshotDTO, String> {
    let pricing = state.ensure_pricing().await;
    let mut snap = parse_to_snapshot_async(None, clients, since, until, pricing).await?;
    // Frontend uses daily/models/sessions/projects rollups; omit the 30k+ raw rows over IPC.
    snap.rows.clear();
    if let Ok(mut l) = state.last_scan_at.lock() {
        *l = Some(chrono::Utc::now().to_rfc3339());
    }
    Ok(snap)
}

#[tauri::command]
async fn rescan_now(state: State<'_, AppState>) -> Result<RescanResultDTO, String> {
    let t0 = std::time::Instant::now();
    let pricing = state.ensure_pricing().await;
    let snap = parse_to_snapshot_async(None, None, None, None, pricing).await?;
    if let Ok(mut l) = state.last_scan_at.lock() {
        *l = Some(chrono::Utc::now().to_rfc3339());
    }
    Ok(RescanResultDTO {
        scanned_files: snap.rows.len() as i32,
        new_records: snap.rows.len() as i32,
        took_ms: t0.elapsed().as_millis() as i64,
    })
}

#[tauri::command]
async fn get_live_status(
    state: State<'_, AppState>,
    watcher: State<'_, watcher::WatcherState>,
) -> Result<LiveStatusDTO, String> {
    let last = state
        .last_scan_at
        .lock()
        .map(|g| g.clone())
        .unwrap_or(None);
    use std::sync::atomic::Ordering;
    Ok(LiveStatusDTO {
        watching: watcher.running.load(Ordering::SeqCst),
        last_scan_at: last,
        pending_files: watcher.pending.lock().map(|p| *p).unwrap_or(0),
        errors: watcher.errors.lock().map(|e| e.clone()).unwrap_or_default(),
    })
}

/// Start a trip (bounded observation window). Stores it as the active trip.
#[tauri::command]
fn cmd_trip_start(
    state: State<'_, AppState>,
    id: String,
    name: String,
    clients: Option<Vec<String>>,
    stop_mode: Option<String>,
    stop_after_ms: Option<i64>,
    idle_after_ms: Option<i64>,
) -> Result<TripConfig, String> {
    let trip = trip_started_now_with_mode(
        id,
        name,
        clients,
        stop_mode.unwrap_or_else(|| "manual".to_string()),
        stop_after_ms,
        idle_after_ms,
    );
    let _baseline = capture_baseline(&trip);
    *state
        .active_trip
        .lock()
        .map_err(|e| format!("trip state poisoned: {e}"))? = Some(trip.clone());
    persist_trips(&state);
    Ok(trip)
}

/// Stop the active trip, if any.
#[tauri::command]
fn cmd_trip_stop(
    state: State<'_, AppState>,
    reason: Option<String>,
) -> Result<Option<TripConfig>, String> {
    let mut guard = state
        .active_trip
        .lock()
        .map_err(|e| format!("trip state poisoned: {e}"))?;
    let stopped = guard.take().map(|t| trip_stop_now(t, reason));
    drop(guard);
    persist_trips(&state);
    Ok(stopped)
}

// --- Frontend trip API (src/lib/tauri.ts) ---

#[tauri::command]
fn list_trips(state: State<'_, AppState>) -> Result<Vec<TripDTO>, String> {
    let trips = state
        .trips
        .lock()
        .map_err(|e| format!("trip state poisoned: {e}"))?;
    Ok(trips.iter().map(config_to_dto).collect())
}

#[tauri::command]
fn start_trip(
    state: State<'_, AppState>,
    name: String,
    scope: TripScopeDTO,
    stop: StopModeDTO,
) -> Result<TripDTO, String> {
    let clients = match scope {
        TripScopeDTO::All => None,
        TripScopeDTO::Clients { clients } => Some(clients),
    };
    let (stop_mode, stop_after_ms, idle_after_ms) = match stop {
        StopModeDTO::Manual => ("manual".to_string(), None, None),
        StopModeDTO::After { hours } => (
            "after".to_string(),
            Some((hours * 3_600_000.0) as i64),
            None,
        ),
        StopModeDTO::Idle { minutes } => (
            "idle".to_string(),
            None,
            Some((minutes * 60_000.0) as i64),
        ),
    };
    let id = format!("trip-{}", chrono::Utc::now().timestamp_millis());
    let trip = trip_started_now_with_mode(id, name, clients, stop_mode, stop_after_ms, idle_after_ms);
    let dto = config_to_dto(&trip);
    state
        .active_trip
        .lock()
        .map_err(|e| format!("trip state poisoned: {e}"))?
        .replace(trip.clone());
    state
        .trips
        .lock()
        .map_err(|e| format!("trip state poisoned: {e}"))?
        .push(trip);
    persist_trips(&state);
    Ok(dto)
}

#[tauri::command]
fn stop_trip(state: State<'_, AppState>, trip_id: String) -> Result<TripDTO, String> {
    let dto = {
        let mut trips = state
            .trips
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        let trip = trips
            .iter_mut()
            .find(|t| t.id == trip_id)
            .ok_or_else(|| format!("trip not found: {trip_id}"))?;
        *trip = trip_stop_now(trip.clone(), None);
        config_to_dto(trip)
    };
    // Clear active if it matches
    if let Ok(mut active) = state.active_trip.lock() {
        if active.as_ref().map(|a| a.id.as_str()) == Some(trip_id.as_str()) {
            *active = None;
        }
    }
    persist_trips(&state);
    Ok(dto)
}

#[tauri::command]
async fn get_trip(state: State<'_, AppState>, trip_id: String) -> Result<TripDetailDTO, String> {
    let trip = {
        let trips = state
            .trips
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        trips
            .iter()
            .find(|t| t.id == trip_id)
            .cloned()
            .ok_or_else(|| format!("trip not found: {trip_id}"))?
    };
    let dto = config_to_dto(&trip);
    // Live delta: scan now and filter to trip window
    let pricing = state.ensure_pricing().await;
    let snap = parse_to_snapshot_async(None, trip.clients.clone(), None, None, pricing).await?;
    let rows = filter_rows_for_trip(&snap.rows, &trip);
    let tokens: i64 = rows
        .iter()
        .map(|r| r.input + r.output + r.cache_read + r.cache_write + r.reasoning)
        .sum();
    let cost: f64 = rows.iter().map(|r| r.cost).sum();
    let messages: i32 = rows.iter().map(|r| r.message_count).sum();
    // Daily rollup of trip rows
    use std::collections::BTreeMap;
    let mut daily_map: BTreeMap<String, (i64, f64, i32, i64, i64, i64)> = BTreeMap::new();
    for r in &rows {
        let e = daily_map.entry(r.date.clone()).or_insert((0, 0.0, 0, 0, 0, 0));
        e.0 += r.input + r.output + r.cache_read + r.cache_write + r.reasoning;
        e.1 += r.cost;
        e.2 += r.message_count;
        e.3 += r.input;
        e.4 += r.output;
        e.5 += r.cache_read;
    }
    let daily: Vec<adapter::DailyDTO> = daily_map
        .into_iter()
        .map(|(date, (t, c, m, input, output, cache_read))| adapter::DailyDTO {
            date,
            tokens: t,
            cost: c,
            messages: m,
            input,
            output,
            cache_read,
        })
        .collect();
    Ok(TripDetailDTO {
        trip: dto,
        baseline: serde_json::json!({"tokens": 0, "cost": 0.0}),
        deltas: serde_json::json!({"tokens": tokens, "cost": cost, "messages": messages}),
        daily,
    })
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

const PRICING_REFRESH_SECS: u64 = 3 * 60 * 60;

fn pricing_refresh_interval() -> std::time::Duration {
    // Test hook: a short interval lets the integration test exercise the swap
    // without waiting three hours.
    std::env::var("TOKENTRACKER_PRICING_REFRESH_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(std::time::Duration::from_secs)
        .unwrap_or(std::time::Duration::from_secs(PRICING_REFRESH_SECS))
}

/// Refresh pricing while the app stays open. The helper is a fresh process, so
/// `tokscale-core` re-checks its 1-hour on-disk TTL instead of the in-process
/// `OnceCell` pinning the startup catalog forever.
fn start_pricing_refresh(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(pricing_refresh_interval()).await;
            if let Err(err) = refresh_pricing(&app).await {
                eprintln!("tokentracker: pricing refresh failed: {err}");
                tokio::time::sleep(std::time::Duration::from_secs(30 * 60)).await;
            }
        }
    });
}

async fn refresh_pricing(app: &tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let status = tokio::task::spawn_blocking(move || {
        std::process::Command::new(exe)
            .arg("--refresh-pricing")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
    })
    .await
    .map_err(|e| format!("refresh task: {e}"))?
    .map_err(|e| format!("refresh helper: {e}"))?;

    if !status.success() {
        return Err(format!("refresh helper exited with {status}"));
    }

    let service = PricingService::load_cached_any_age()
        .ok_or_else(|| "refresh produced no cached pricing".to_string())?;
    let has_data = service.has_pricing_data();
    app.state::<AppState>().set_pricing(Arc::new(service));
    // Reuse the watcher channel: the dashboard refetches and recomputes costs
    // with the new catalog.
    let _ = app.emit("usage://updated", ());
    eprintln!("tokentracker: pricing catalog refreshed (has_data={has_data})");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .manage(window_state::WindowSession::default())
        .manage(AppState {
            active_trip: Mutex::new(None),
            trips: Mutex::new(Vec::new()),
            last_scan_at: Mutex::new(None),
            trips_file: Mutex::new(None),
            pricing: Mutex::new(None),
        })
        .manage(watcher::WatcherState::default())
        .setup(|app| {
            // Restore geometry while the window is still hidden (`visible:
            // false` in tauri.conf.json), then show it already in its final
            // state. Failure here must not leave the app invisible.
            if let Err(err) = window_state::init(app.handle()) {
                eprintln!("tokentracker: window state init failed: {err}");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }

            // Resolve + seed persisted trips BEFORE the worker starts, so a
            // trip left running across a restart resumes with its full window
            // (rows live in agent logs on disk; deltas recompute over them).
            // Idle trips reconcile via the worker's first scan (~60s).
            // `reconcile_on_startup` heals stale active ids (clears dangling
            // ids, promotes the newest survivor) and retroactively closes
            // `after` trips at their deadline, so the in-memory seed below
            // never resurrects a trip that already expired while closed.
            if let Ok(dir) = app.path().app_data_dir() {
                let path = dir.join("trips.json");
                // Recover (don't skip) on poisoned mutex: skipping would boot
                // with empty trips while valid data sits on disk.
                // NOTE: `app.state()` returns a temporary guard, so bind it
                // first — locking through the temporary directly drops it
                // while the `MutexGuard` still borrows from it (E0716).
                let app_state = app.state::<AppState>();
                {
                    let mut slot = app_state
                        .trips_file
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    *slot = Some(path.clone());
                }
                let mut store = trips::load_trips_file(&path);
                if trips::reconcile_on_startup(&mut store, chrono::Utc::now().timestamp_millis()) {
                    let _ = trips::save_trips_file(&path, &store);
                }
                // `reconcile` guarantees `active_trip_id` (when Some) points
                // at a still-running trip, so this lookup can't resurrect a
                // closed/stale id.
                let active = store
                    .active_trip_id
                    .as_ref()
                    .and_then(|id| store.trips.iter().find(|t| t.id == *id).cloned());
                {
                    let mut trips = app_state
                        .trips
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    *trips = store.trips;
                }
                {
                    let mut slot = app_state
                        .active_trip
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    *slot = active;
                }
            }
            watcher::start_watcher(app.handle().clone());
            trip_worker::start_trip_worker(app.handle().clone());
            start_pricing_refresh(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_scan,
            get_usage_snapshot,
            rescan_now,
            get_live_status,
            cmd_trip_start,
            cmd_trip_stop,
            list_trips,
            start_trip,
            stop_trip,
            get_trip,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tokentracker")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Some(window) = app.get_webview_window("main") {
                    window_state::save_window_state(app, &window);
                }
            }
        });
}
