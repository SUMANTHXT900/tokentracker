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
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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
    /// True only for the one trip currently held in `active_trip`.
    pub active: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TripDeltaDTO {
    pub tokens: i64,
    pub cost: f64,
    pub messages: i32,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TripClientDTO {
    pub client: String,
    pub tokens: i64,
    pub cost: f64,
    pub messages: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TripTotalsDTO {
    pub tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TripBaselineDTO {
    pub totals: TripTotalsDTO,
    pub by_model: Vec<adapter::ModelRowDTO>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TripDetailDTO {
    pub trip: TripDTO,
    pub baseline: TripBaselineDTO,
    pub deltas: TripDeltaDTO,
    pub models: Vec<adapter::ModelRowDTO>,
    pub clients: Vec<TripClientDTO>,
    pub sessions: i32,
    pub duration_ms: i64,
    pub top_model: Option<String>,
    pub peak_day: Option<adapter::DailyDTO>,
    pub daily: Vec<adapter::DailyDTO>,
}

fn ms_to_rfc3339(ms: i64) -> String {
    use chrono::{DateTime, Utc};
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

fn config_to_dto(t: &TripConfig, active: bool) -> TripDTO {
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
        active,
    }
}

/// Error returned whenever a second focus session is attempted.
const ACTIVE_TRIP_ERR: &str = "A focus session is already running. Stop it first.";

/// Monotonic suffix, so two starts in the same millisecond never collide.
static TRIP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Unique `trip-<millis>-<seq>` id, checked against existing ids (a restart can
/// reset the process-local sequence, so a disk id could theoretically match).
fn generate_trip_id(trips: &[TripConfig], now_ms: i64) -> String {
    loop {
        let seq = TRIP_SEQ.fetch_add(1, Ordering::Relaxed);
        let id = format!("trip-{now_ms}-{seq}");
        if !trips.iter().any(|t| t.id == id) {
            return id;
        }
    }
}

/// Validate + append a new running trip. Rejects when any trip is already
/// running (`active` or an orphan in the list), enforcing one session at a time.
/// The caller owns the trips lock, so the list check and push are atomic.
fn begin_trip(
    trips: &mut Vec<TripConfig>,
    active: &Option<TripConfig>,
    name: String,
    scope: TripScopeDTO,
    stop: StopModeDTO,
) -> Result<TripConfig, String> {
    if active.is_some() || trips.iter().any(|t| t.ended_at_ms.is_none()) {
        return Err(ACTIVE_TRIP_ERR.to_string());
    }
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
    let now_ms = chrono::Utc::now().timestamp_millis();
    let id = generate_trip_id(trips, now_ms);
    let trip = trip_started_now_with_mode(id, name, clients, stop_mode, stop_after_ms, idle_after_ms);
    trips.push(trip.clone());
    Ok(trip)
}

/// Mark `trip_id` stopped in the list. Returns the DTO (always `active: false`)
/// and whether the trip actually transitioned from running to stopped.
/// Re-stopping an already-closed trip is a no-op: the original end time and
/// reason are preserved and no duplicate event should be emitted.
fn stop_trip_in_list(
    trips: &mut [TripConfig],
    trip_id: &str,
    reason: Option<String>,
) -> Result<(TripDTO, bool), String> {
    let trip = trips
        .iter_mut()
        .find(|t| t.id == trip_id)
        .ok_or_else(|| format!("trip not found: {trip_id}"))?;
    let was_running = trip.ended_at_ms.is_none();
    if was_running {
        *trip = trip_stop_now(trip.clone(), reason);
    }
    Ok((config_to_dto(trip, false), was_running))
}

/// Build the full detail payload from already-parsed rows. Pure apart from
/// `now_ms`, so stats aggregation is unit-testable without a Tauri app.
fn build_trip_detail(
    trip: &TripConfig,
    active: bool,
    rows: &[adapter::UnifiedRowDTO],
    now_ms: i64,
) -> TripDetailDTO {
    let filtered = filter_rows_for_trip(rows, trip);
    let session_snapshot = adapter::build_snapshot(filtered.clone());

    // Baseline: everything for the same client scope strictly before the trip
    // start. `started_at_ms = i64::MIN` keeps the client filter but removes the
    // lower time bound; the upper bound is the millisecond before `started_at`.
    let mut baseline_trip = trip.clone();
    baseline_trip.started_at_ms = i64::MIN;
    baseline_trip.ended_at_ms = Some(trip.started_at_ms.saturating_sub(1));
    let baseline_snapshot =
        adapter::build_snapshot(filter_rows_for_trip(rows, &baseline_trip));
    let baseline = TripBaselineDTO {
        totals: TripTotalsDTO {
            tokens: baseline_snapshot.total_tokens,
            cost: baseline_snapshot.total_cost,
        },
        by_model: baseline_snapshot.models,
    };

    // Per-stream sums over the trip window. Saturating adds keep corrupt rows
    // from wrapping; non-finite/negative costs contribute zero.
    let mut deltas = TripDeltaDTO::default();
    let mut client_map: BTreeMap<String, TripClientDTO> = BTreeMap::new();
    let mut session_keys: HashSet<(String, String)> = HashSet::new();
    for r in &filtered {
        let row_tokens = r
            .input
            .saturating_add(r.output)
            .saturating_add(r.cache_read)
            .saturating_add(r.cache_write)
            .saturating_add(r.reasoning);
        let row_cost = if r.cost.is_finite() && r.cost >= 0.0 {
            r.cost
        } else {
            0.0
        };
        let row_messages = r.message_count.max(0);

        deltas.tokens = deltas.tokens.saturating_add(row_tokens);
        deltas.cost += row_cost;
        deltas.messages = deltas.messages.saturating_add(row_messages);
        deltas.input = deltas.input.saturating_add(r.input);
        deltas.output = deltas.output.saturating_add(r.output);
        deltas.cache_read = deltas.cache_read.saturating_add(r.cache_read);
        deltas.cache_write = deltas.cache_write.saturating_add(r.cache_write);
        deltas.reasoning = deltas.reasoning.saturating_add(r.reasoning);

        let entry = client_map
            .entry(r.client.clone())
            .or_insert_with(|| TripClientDTO {
                client: r.client.clone(),
                tokens: 0,
                cost: 0.0,
                messages: 0,
            });
        entry.tokens = entry.tokens.saturating_add(row_tokens);
        entry.cost += row_cost;
        entry.messages = entry.messages.saturating_add(row_messages);

        if !r.session_id.is_empty() {
            session_keys.insert((r.client.clone(), r.session_id.clone()));
        }
    }
    let mut clients: Vec<TripClientDTO> = client_map.into_values().collect();
    clients.sort_by(|a, b| {
        b.tokens
            .cmp(&a.tokens)
            .then_with(|| b.cost.total_cmp(&a.cost))
            .then_with(|| a.client.cmp(&b.client))
    });

    // `build_snapshot` sorts models by cost desc (ties by model/provider), so
    // the first row is the dominant model. Keep the daily rollup from the same
    // aggregation so daily/peak agree with models.
    let models = session_snapshot.models;
    let top_model = models.first().map(|m| m.model.clone());
    let daily = session_snapshot.daily;
    // Max tokens, earliest date wins ties (daily is BTreeMap-ordered by date).
    let peak_day = daily
        .iter()
        .max_by(|a, b| a.tokens.cmp(&b.tokens).then_with(|| b.date.cmp(&a.date)))
        .cloned();

    let end_ms = trip.ended_at_ms.unwrap_or(now_ms);
    let duration_ms = end_ms.saturating_sub(trip.started_at_ms).max(0);

    TripDetailDTO {
        trip: config_to_dto(trip, active),
        baseline,
        deltas,
        models,
        clients,
        sessions: session_keys.len() as i32,
        duration_ms,
        top_model,
        peak_day,
        daily,
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
/// Rejects when another trip is already running.
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
    {
        let active = state
            .active_trip
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        if active.is_some() {
            return Err(ACTIVE_TRIP_ERR.to_string());
        }
    }
    {
        let trips = state
            .trips
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        if trips.iter().any(|t| t.ended_at_ms.is_none()) {
            return Err(ACTIVE_TRIP_ERR.to_string());
        }
        if trips.iter().any(|t| t.id == id) {
            return Err(format!("trip id already exists: {id}"));
        }
    }
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

/// Stop the active trip, if any. Also closes the matching `trips` entry so a
/// restart can't resurrect it, persists, and emits `trip://stopped`.
#[tauri::command]
fn cmd_trip_stop(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    reason: Option<String>,
) -> Result<Option<TripConfig>, String> {
    let stopped = {
        let mut active = state
            .active_trip
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        active.take().map(|t| trip_stop_now(t, reason))
    };
    let stopped = match stopped {
        Some(t) => t,
        None => return Ok(None),
    };
    // Mirror the final state into the trip list (separate lock scope: never
    // nested with `active_trip`). Legacy active-only entries are pushed so the
    // stopped trip is persisted instead of disappearing.
    {
        let mut trips = state
            .trips
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        match trips.iter_mut().find(|t| t.id == stopped.id) {
            Some(t) => {
                // Preserve an end time that won a race (e.g. worker/manual).
                if t.ended_at_ms.is_none() {
                    *t = stopped.clone();
                }
            }
            None => trips.push(stopped.clone()),
        }
    }
    persist_trips(&state);
    let event_reason = stopped
        .stop_reason
        .clone()
        .unwrap_or_else(|| "manual".to_string());
    let _ = app.emit(
        "trip://stopped",
        serde_json::json!({ "trip_id": stopped.id, "reason": event_reason }),
    );
    Ok(Some(stopped))
}

// --- Frontend trip API (src/lib/tauri.ts) ---

#[tauri::command]
fn list_trips(state: State<'_, AppState>) -> Result<Vec<TripDTO>, String> {
    // Snapshot the active id in its own scope, then the list: locks are never
    // nested and the flag reflects exactly the id held in `active_trip`.
    let active_id = {
        let active = state
            .active_trip
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        active.as_ref().map(|t| t.id.clone())
    };
    let trips = state
        .trips
        .lock()
        .map_err(|e| format!("trip state poisoned: {e}"))?;
    Ok(trips
        .iter()
        .map(|t| config_to_dto(t, active_id.as_deref() == Some(t.id.as_str())))
        .collect())
}

#[tauri::command]
fn start_trip(
    state: State<'_, AppState>,
    name: String,
    scope: TripScopeDTO,
    stop: StopModeDTO,
) -> Result<TripDTO, String> {
    // Read the active slot first (separate scope). `begin_trip` then performs
    // the running-trip check + push under the trips lock, so concurrent starts
    // serialize on that list: the second one sees the first trip and errors.
    let active_snapshot = {
        let active = state
            .active_trip
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        active.clone()
    };
    let trip = {
        let mut trips = state
            .trips
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        begin_trip(&mut trips, &active_snapshot, name, scope, stop)?
    };
    {
        let mut active = state
            .active_trip
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        *active = Some(trip.clone());
    }
    persist_trips(&state);
    Ok(config_to_dto(&trip, true))
}

#[tauri::command]
fn stop_trip(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    trip_id: String,
) -> Result<TripDTO, String> {
    // Mutate the trip entry under the trips lock, then release it before
    // touching `active_trip` (non-nested lock scopes).
    let (dto, newly_stopped) = {
        let mut trips = state
            .trips
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        stop_trip_in_list(&mut trips, &trip_id, Some("manual".to_string()))?
    };
    // Clear active if it matches.
    {
        let mut active = state
            .active_trip
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        if active.as_ref().map(|a| a.id.as_str()) == Some(trip_id.as_str()) {
            *active = None;
        }
    }
    persist_trips(&state);
    // Only emit on a running → stopped transition so a repeated stop is
    // idempotent and does not duplicate toasts/refetches.
    if newly_stopped {
        let _ = app.emit(
            "trip://stopped",
            serde_json::json!({ "trip_id": trip_id, "reason": "manual" }),
        );
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
    let is_active = {
        let active = state
            .active_trip
            .lock()
            .map_err(|e| format!("trip state poisoned: {e}"))?;
        active.as_ref().map(|a| a.id.as_str()) == Some(trip_id.as_str())
    };
    // Live delta: scan now and filter to trip window.
    let pricing = state.ensure_pricing().await;
    let snap = parse_to_snapshot_async(None, trip.clients.clone(), None, None, pricing).await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    Ok(build_trip_detail(&trip, is_active, &snap.rows, now_ms))
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

#[cfg(test)]
mod tests {
    use super::*;
    use adapter::UnifiedRowDTO;

    fn trip(started: i64, ended: Option<i64>) -> TripConfig {
        TripConfig {
            id: "t".into(),
            name: "Test".into(),
            clients: None,
            started_at_ms: started,
            ended_at_ms: ended,
            stop_mode: "manual".into(),
            stop_after_ms: None,
            idle_after_ms: None,
            stop_reason: None,
            resumed: false,
        }
    }

    fn row(ts: i64) -> UnifiedRowDTO {
        UnifiedRowDTO {
            client: "claude".into(),
            model: "opus".into(),
            provider: "anthropic".into(),
            session_id: "s".into(),
            workspace_key: None,
            workspace_label: None,
            session_title: None,
            agent: None,
            timestamp: ts,
            date: "2026-01-02".into(),
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            reasoning: 0,
            cost: 0.0,
            message_count: 0,
        }
    }

    #[test]
    fn second_start_errors_while_one_is_running() {
        let mut trips = Vec::new();
        let active: Option<TripConfig> = None;
        let first = begin_trip(
            &mut trips,
            &active,
            "first".into(),
            TripScopeDTO::All,
            StopModeDTO::Manual,
        )
        .expect("first start succeeds");
        assert!(first.ended_at_ms.is_none());
        assert_eq!(trips.len(), 1);

        let err = begin_trip(
            &mut trips,
            &active,
            "second".into(),
            TripScopeDTO::All,
            StopModeDTO::Manual,
        )
        .unwrap_err();
        assert_eq!(err, "A focus session is already running. Stop it first.");
        assert_eq!(trips.len(), 1, "rejected start must not append");

        // An active slot alone (e.g. a legacy active-only trip) also rejects.
        let active_some = Some(first.clone());
        let mut empty = Vec::new();
        let err = begin_trip(
            &mut empty,
            &active_some,
            "third".into(),
            TripScopeDTO::All,
            StopModeDTO::Manual,
        )
        .unwrap_err();
        assert_eq!(err, "A focus session is already running. Stop it first.");
        assert!(empty.is_empty());

        // Ids are unique even within the same millisecond.
        let a = generate_trip_id(&[], 42);
        let b = generate_trip_id(&[], 42);
        assert_ne!(a, b);
    }

    #[test]
    fn dto_reports_active_and_stop_reason() {
        let running = trip(1_000, None);
        assert!(config_to_dto(&running, true).active);
        assert!(!config_to_dto(&running, false).active);

        let closed = trip_stop_now(trip(1_000, None), Some("superseded".into()));
        let dto = config_to_dto(&closed, false);
        assert!(!dto.active);
        assert_eq!(dto.stop_reason.as_deref(), Some("superseded"));
        assert!(dto.stopped_at.is_some());
    }

    #[test]
    fn stopping_a_closed_trip_is_idempotent() {
        let mut trips = vec![trip(1_000, Some(1_234))];
        trips[0].stop_reason = Some("original".into());
        let (dto, changed) =
            stop_trip_in_list(&mut trips, "t", Some("manual".into())).expect("found");
        assert!(!changed, "already-closed trip must not transition");
        assert!(!dto.active);
        assert_eq!(trips[0].ended_at_ms, Some(1_234));
        assert_eq!(trips[0].stop_reason.as_deref(), Some("original"));
        assert_eq!(dto.stop_reason.as_deref(), Some("original"));

        let (dto2, changed2) =
            stop_trip_in_list(&mut trips, "t", Some("manual".into())).expect("found");
        assert!(!changed2);
        assert_eq!(dto2.stopped_at, dto.stopped_at);
        assert_eq!(trips[0].ended_at_ms, Some(1_234));

        assert!(stop_trip_in_list(&mut trips, "missing", None).is_err());
    }

    #[test]
    fn detail_aggregates_scoped_stats() {
        let trip = trip(1_000, Some(10_000));
        let mut rows = Vec::new();

        // Baseline row before the window.
        let mut r = row(500);
        r.model = "m-base".into();
        r.session_id = "pre".into();
        r.date = "2026-01-01".into();
        r.input = 100;
        r.cost = 1.0;
        r.message_count = 2;
        rows.push(r);

        // 21 tokens, claude.
        let mut r = row(2_000);
        r.input = 10;
        r.output = 5;
        r.cache_read = 3;
        r.cache_write = 2;
        r.reasoning = 1;
        r.cost = 0.5;
        r.message_count = 2;
        r.session_id = "s1".into();
        rows.push(r);
        // 2 tokens, same client/model/session/date.
        let mut r = row(3_000);
        r.input = 1;
        r.output = 1;
        r.cost = 0.25;
        r.message_count = 1;
        r.session_id = "s1".into();
        rows.push(r);
        // 100 tokens, codex.
        let mut r = row(4_000);
        r.client = "codex".into();
        r.model = "gpt".into();
        r.input = 100;
        r.cost = 2.0;
        r.message_count = 3;
        r.session_id = "s2".into();
        r.date = "2026-01-03".into();
        rows.push(r);
        // 50 tokens, empty session id must not count as a session.
        let mut r = row(5_000);
        r.input = 50;
        r.cost = 1.0;
        r.message_count = 1;
        r.session_id = String::new();
        r.date = "2026-01-04".into();
        rows.push(r);
        // 7 tokens, NaN cost contributes zero.
        let mut r = row(6_000);
        r.client = "codex".into();
        r.model = "gpt".into();
        r.input = 7;
        r.cost = f64::NAN;
        r.message_count = 1;
        r.session_id = "s2".into();
        r.date = "2026-01-03".into();
        rows.push(r);
        // 100 tokens, extra session.
        let mut r = row(7_000);
        r.input = 100;
        r.session_id = "s3".into();
        r.date = "2026-01-05".into();
        rows.push(r);
        // Outside the window: must be ignored everywhere below.
        let mut r = row(20_000);
        r.input = 999;
        r.cost = 9.0;
        r.session_id = "late".into();
        rows.push(r);

        let detail = build_trip_detail(&trip, true, &rows, 50_000);
        assert!(detail.trip.active);
        assert_eq!(detail.duration_ms, 9_000);
        assert_eq!(detail.deltas.tokens, 280);
        assert_eq!(detail.deltas.input, 268);
        assert_eq!(detail.deltas.output, 6);
        assert_eq!(detail.deltas.cache_read, 3);
        assert_eq!(detail.deltas.cache_write, 2);
        assert_eq!(detail.deltas.reasoning, 1);
        assert_eq!(detail.deltas.messages, 8);
        assert!((detail.deltas.cost - 3.75).abs() < 1e-9, "cost {}", detail.deltas.cost);
        assert_eq!(detail.sessions, 3, "claude:s1, codex:s2, claude:s3");
        assert_eq!(detail.models.len(), 2);
        assert_eq!(
            detail.models.iter().map(|m| m.tokens).sum::<i64>(),
            280,
            "models are session-scoped"
        );
        // build_snapshot sorts by cost: codex (2.0) before claude (1.75).
        assert_eq!(detail.models[0].tokens, 107);
        assert_eq!(detail.models[1].tokens, 173);
        assert_eq!(
            detail.top_model.as_deref(),
            Some(detail.models[0].model.as_str())
        );

        assert_eq!(detail.clients.len(), 2);
        assert_eq!(detail.clients[0].client, "claude");
        assert_eq!(detail.clients[0].tokens, 173);
        assert_eq!(detail.clients[0].messages, 4);
        assert!((detail.clients[0].cost - 1.75).abs() < 1e-9);
        assert_eq!(detail.clients[1].client, "codex");
        assert_eq!(detail.clients[1].tokens, 107);
        assert_eq!(detail.clients[1].messages, 4);
        assert!((detail.clients[1].cost - 2.0).abs() < 1e-9);

        assert_eq!(detail.baseline.totals.tokens, 100);
        assert!((detail.baseline.totals.cost - 1.0).abs() < 1e-9);
        assert_eq!(detail.baseline.by_model.len(), 1);
        assert_eq!(
            detail.baseline.by_model.iter().map(|m| m.tokens).sum::<i64>(),
            100
        );

        assert_eq!(detail.daily.len(), 4);
        assert_eq!(detail.daily[0].date, "2026-01-02");
        let peak = detail.peak_day.as_ref().expect("peak day");
        assert_eq!(peak.date, "2026-01-03");
        assert_eq!(peak.tokens, 107);
    }

    #[test]
    fn peak_day_prefers_earliest_on_tie() {
        let trip = trip(1_000, Some(5_000));
        let mut a = row(2_000);
        a.date = "2026-01-02".into();
        a.input = 10;
        let mut b = row(3_000);
        b.date = "2026-01-03".into();
        b.input = 10;
        let detail = build_trip_detail(&trip, false, &[a, b], 9_000);
        assert_eq!(detail.peak_day.expect("peak").date, "2026-01-02");
    }
}
