//! tokentracker Tauri 2 backend.
//!
//! Thin command layer over [`adapter`] (tokscale parsing) and [`trips`]
//! (trip windows). No `tokscale_core` imports here — see `adapter.rs`.

pub mod adapter;
pub mod trip_worker;
pub mod trips;
pub mod watcher;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

use adapter::{UsageSnapshotDTO, parse_to_snapshot_async};
use trips::{TripConfig, capture_baseline, filter_rows_for_trip, trip_stop_now, trip_started_now_with_mode};

pub struct AppState {
    pub active_trip: Mutex<Option<TripConfig>>,
    pub trips: Mutex<Vec<TripConfig>>,
    pub last_scan_at: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
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
    }
}

// ---------------------------------------------------------------------------
// Commands (names must match src/lib/tauri.ts)
// ---------------------------------------------------------------------------

/// Scan local clients and return a usage snapshot.
#[tauri::command]
async fn cmd_scan(
    home: Option<String>,
    clients: Option<Vec<String>>,
    since: Option<String>,
    until: Option<String>,
) -> Result<UsageSnapshotDTO, String> {
    parse_to_snapshot_async(home, clients, since, until).await
}

/// Frontend alias: get_usage_snapshot
#[tauri::command]
async fn get_usage_snapshot(
    state: State<'_, AppState>,
    clients: Option<Vec<String>>,
    since: Option<String>,
    until: Option<String>,
) -> Result<UsageSnapshotDTO, String> {
    let mut snap = parse_to_snapshot_async(None, clients, since, until).await?;
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
    let snap = parse_to_snapshot_async(None, None, None, None).await?;
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
    Ok(stopped)
}

/// Placeholder updater check. Wired to real `tauri-plugin-updater` later;
/// currently always reports no update available.
#[tauri::command]
fn cmd_check_update() -> Result<UpdateStatus, String> {
    Ok(UpdateStatus {
        available: false,
        version: None,
        notes: None,
    })
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
    Ok(dto)
}

#[tauri::command]
fn stop_trip(state: State<'_, AppState>, trip_id: String) -> Result<TripDTO, String> {
    let mut trips = state
        .trips
        .lock()
        .map_err(|e| format!("trip state poisoned: {e}"))?;
    let trip = trips
        .iter_mut()
        .find(|t| t.id == trip_id)
        .ok_or_else(|| format!("trip not found: {trip_id}"))?;
    *trip = trip_stop_now(trip.clone(), None);
    let dto = config_to_dto(trip);
    // Clear active if it matches
    if let Ok(mut active) = state.active_trip.lock() {
        if active.as_ref().map(|a| a.id.as_str()) == Some(trip_id.as_str()) {
            *active = None;
        }
    }
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
    let snap = parse_to_snapshot_async(None, trip.clients.clone(), None, None).await?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            active_trip: Mutex::new(None),
            trips: Mutex::new(Vec::new()),
            last_scan_at: Mutex::new(None),
        })
        .manage(watcher::WatcherState::default())
        .setup(|app| {
            watcher::start_watcher(app.handle().clone());
            trip_worker::start_trip_worker(app.handle().clone());
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
            cmd_check_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tokentracker");
}
