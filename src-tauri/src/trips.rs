//! Trip tracking: baseline handling + row filtering + auto-stop.
//!
//! A "trip" is a bounded observation window (e.g. one work session). Rows are
//! filtered by client allow-list and by the trip's time window. No
//! `tokscale_core` imports here — all usage data arrives as
//! [`crate::adapter::UnifiedRowDTO`].

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::adapter::UnifiedRowDTO;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TripConfig {
    pub id: String,
    pub name: String,
    pub clients: Option<Vec<String>>,
    /// Trip start as unix millis.
    pub started_at_ms: i64,
    /// Trip end as unix millis (None = still running).
    pub ended_at_ms: Option<i64>,
    /// Stop mode: "manual" | "after" | "idle".
    pub stop_mode: String,
    /// For stop_mode == "after": stop this many ms after start.
    pub stop_after_ms: Option<i64>,
    /// For stop_mode == "idle": stop after this many ms without activity.
    pub idle_after_ms: Option<i64>,
    pub stop_reason: Option<String>,
    /// True when this active trip was restored from disk after an app
    /// restart (rather than started in this session). Serialized so a
    /// second restart keeps the (correct) resumed state.
    #[serde(default)]
    pub resumed: bool,
}

impl TripConfig {
    pub fn is_active(&self) -> bool {
        self.ended_at_ms.is_none()
    }
}

/// Create a new running trip starting now.
pub fn trip_started_now(id: String, name: String, clients: Option<Vec<String>>) -> TripConfig {
    trip_started_now_with_mode(id, name, clients, "manual".to_string(), None, None)
}

pub fn trip_started_now_with_mode(
    id: String,
    name: String,
    clients: Option<Vec<String>>,
    stop_mode: String,
    stop_after_ms: Option<i64>,
    idle_after_ms: Option<i64>,
) -> TripConfig {
    TripConfig {
        id,
        name,
        clients,
        started_at_ms: Utc::now().timestamp_millis(),
        ended_at_ms: None,
        stop_mode,
        stop_after_ms,
        idle_after_ms,
        stop_reason: None,
        resumed: false,
    }
}

/// Stop a trip now with an optional reason.
pub fn trip_stop_now(mut trip: TripConfig, reason: Option<String>) -> TripConfig {
    if trip.ended_at_ms.is_none() {
        trip.ended_at_ms = Some(Utc::now().timestamp_millis());
        trip.stop_reason = reason.or_else(|| Some("manual".to_string()));
    }
    trip
}

/// Capture a baseline: for now the baseline is the trip itself (start time +
/// client filter). Returns the trip unchanged; kept as a named function so
/// future baseline snapshots (e.g. token counters) have a single hook.
pub fn capture_baseline(trip: &TripConfig) -> TripConfig {
    trip.clone()
}

/// Filter snapshot rows to those belonging to the trip.
///
/// - client allow-list: if `trip.clients` is Some(non-empty), only rows whose
///   `client` (case-insensitive) is in the list are kept.
/// - time window: rows carry unix-millis `timestamp` (tokscale
///   `UnifiedMessage.timestamp` / `ParsedMessage.timestamp` are millis —
///   see `DateTime::from_timestamp_millis` in tokscale-core `lib.rs`).
///   Rows with `timestamp < started_at_ms` are dropped; when
///   `ended_at_ms` is set, rows with `timestamp > ended_at_ms` are dropped.
pub fn filter_rows_for_trip(rows: &[UnifiedRowDTO], trip: &TripConfig) -> Vec<UnifiedRowDTO> {
    rows.iter()
        .filter(|r| {
            if let Some(ref allow) = trip.clients {
                if !allow.is_empty()
                    && !allow.iter().any(|c| c.eq_ignore_ascii_case(&r.client))
                {
                    return false;
                }
            }
            if r.timestamp < trip.started_at_ms {
                return false;
            }
            if let Some(end) = trip.ended_at_ms {
                if r.timestamp > end {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect()
}

/// Decide whether a running trip should auto-stop.
///
/// - `now_ms`: current unix millis.
/// - `last_activity_ms`: unix millis of the last observed usage event
///   (None = no activity yet; idle mode then measures from start).
///
/// Returns Some(reason) when the trip should stop, else None. Pure function —
/// the caller is responsible for actually marking the trip stopped.
pub fn check_auto_stop(
    trip: &TripConfig,
    now_ms: i64,
    last_activity_ms: Option<i64>,
) -> Option<String> {
    if trip.ended_at_ms.is_some() {
        return None;
    }
    match trip.stop_mode.as_str() {
        "after" => {
            if let Some(after) = trip.stop_after_ms {
                if now_ms >= trip.started_at_ms.saturating_add(after) {
                    return Some("time-elapsed".to_string());
                }
            }
            None
        }
        "idle" => {
            if let Some(idle) = trip.idle_after_ms {
                let anchor = last_activity_ms.unwrap_or(trip.started_at_ms);
                if now_ms.saturating_sub(anchor) >= idle {
                    return Some("idle-timeout".to_string());
                }
            }
            None
        }
        _ => None, // "manual" or unknown: never auto-stop
    }
}

// ---------------------------------------------------------------------------
// Disk persistence: trips survive app restarts.
//
// The store is a single JSON file (`trips.json` in the Tauri app-data dir)
// written atomically (temp file + rename) on every mutation. Rows themselves
// live in the agent logs on disk, so a restored trip's delta automatically
// includes usage from while the app was closed — `filter_rows_for_trip`
// windows on `[started_at_ms, ended_at_ms-or-now]`.
// ---------------------------------------------------------------------------

/// On-disk shape: the trip list plus which trip (if any) was active.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TripStoreFile {
    #[serde(default)]
    pub trips: Vec<TripConfig>,
    #[serde(default)]
    pub active_trip_id: Option<String>,
}

/// Load the store. Missing file → empty store. Corrupt file → moved aside
/// (`trips.json.corrupt-<millis>`) and treated as empty, so one bad write can
/// never brick trip history.
pub fn load_trips_file(path: &std::path::Path) -> TripStoreFile {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TripStoreFile::default(),
        Err(_) => return TripStoreFile::default(),
    };
    match serde_json::from_str::<TripStoreFile>(&raw) {
        Ok(store) => store,
        Err(_) => {
            let backup = path.with_extension(format!(
                "json.corrupt-{}",
                chrono::Utc::now().timestamp_millis()
            ));
            let _ = std::fs::rename(path, backup);
            TripStoreFile::default()
        }
    }
}

/// Save the store atomically (temp file + rename).
pub fn save_trips_file(path: &std::path::Path, store: &TripStoreFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("trips dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(store).map_err(|e| format!("trips serialize: {e}"))?;
    std::fs::write(&tmp, raw).map_err(|e| format!("trips write: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("trips commit: {e}"))?;
    Ok(())
}

/// Reconcile a freshly loaded store against `now_ms`.
///
/// - Active trips restored from disk are marked `resumed = true`.
/// - Expired `after` trips are closed retroactively at their deadline
///   (`started_at_ms + stop_after_ms`, reason `time-elapsed`) so a trip whose
///   deadline passed while the app was closed shows the right end time.
/// - `idle` trips are left to the trip worker, which recomputes last activity
///   from a fresh scan (needs I/O; reconcile stays pure).
/// - If the active trip was closed, it is cleared.
///
/// Returns true when anything changed (caller should persist).
pub fn reconcile_on_startup(store: &mut TripStoreFile, now_ms: i64) -> bool {
    let mut changed = false;
    for trip in store.trips.iter_mut().filter(|t| t.ended_at_ms.is_none()) {
        if !trip.resumed {
            trip.resumed = true;
            changed = true;
        }
        if trip.stop_mode == "after" {
            if let Some(after) = trip.stop_after_ms {
                let deadline = trip.started_at_ms.saturating_add(after);
                if now_ms >= deadline {
                    trip.ended_at_ms = Some(deadline);
                    trip.stop_reason = Some("time-elapsed".to_string());
                    changed = true;
                }
            }
        }
    }
    if let Some(active_id) = store.active_trip_id.clone() {
        let still_active = store
            .trips
            .iter()
            .any(|t| t.id == active_id && t.ended_at_ms.is_none());
        if !still_active {
            store.active_trip_id = None;
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::UnifiedRowDTO;

    fn row(client: &str, ts: i64) -> UnifiedRowDTO {
        UnifiedRowDTO {
            client: client.to_string(),
            model: "m".to_string(),
            provider: "p".to_string(),
            session_id: "s".to_string(),
            workspace_key: None,
            workspace_label: None,
            session_title: None,
            agent: None,
            timestamp: ts,
            date: "2026-01-01".to_string(),
            input: 1,
            output: 1,
            cache_read: 0,
            cache_write: 0,
            reasoning: 0,
            cost: 0.0,
            message_count: 1,
        }
    }

    #[test]
    fn filter_by_client_and_window() {
        let trip = TripConfig {
            id: "t".into(),
            name: "t".into(),
            clients: Some(vec!["claude".into()]),
            started_at_ms: 1000,
            ended_at_ms: Some(2000),
            stop_mode: "manual".into(),
            stop_after_ms: None,
            idle_after_ms: None,
            stop_reason: None,
            resumed: false,
        };
        let rows = vec![
            row("claude", 1500),
            row("codex", 1500),
            row("claude", 500),
            row("claude", 2500),
        ];
        let out = filter_rows_for_trip(&rows, &trip);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn auto_stop_after() {
        let trip = TripConfig {
            id: "t".into(),
            name: "t".into(),
            clients: None,
            started_at_ms: 1000,
            ended_at_ms: None,
            stop_mode: "after".into(),
            stop_after_ms: Some(500),
            idle_after_ms: None,
            stop_reason: None,
            resumed: false,
        };
        assert_eq!(check_auto_stop(&trip, 1499, None), None);
        assert_eq!(
            check_auto_stop(&trip, 1500, None),
            Some("time-elapsed".to_string())
        );
    }

    fn active_trip(id: &str, mode: &str, started: i64, after: Option<i64>) -> TripConfig {
        TripConfig {
            id: id.into(),
            name: id.into(),
            clients: None,
            started_at_ms: started,
            ended_at_ms: None,
            stop_mode: mode.into(),
            stop_after_ms: after,
            idle_after_ms: None,
            stop_reason: None,
            resumed: false,
        }
    }

    #[test]
    fn store_roundtrip_preserves_trips_and_active() {
        let dir = std::env::temp_dir().join(format!("tokentracker-test-{}", line!()));
        let path = dir.join("trips.json");
        let store = TripStoreFile {
            trips: vec![active_trip("a", "manual", 1000, None)],
            active_trip_id: Some("a".into()),
        };
        save_trips_file(&path, &store).expect("save");
        let loaded = load_trips_file(&path);
        assert_eq!(loaded, store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reconcile_closes_expired_after_trip_and_marks_resumed() {
        let mut store = TripStoreFile {
            // started at 1000, 500ms limit, now well past the deadline.
            trips: vec![
                active_trip("expired", "after", 1000, Some(500)),
                active_trip("live", "manual", 1000, None),
            ],
            active_trip_id: Some("live".into()),
        };
        assert!(reconcile_on_startup(&mut store, 5000));
        let expired = store.trips.iter().find(|t| t.id == "expired").unwrap();
        assert_eq!(expired.ended_at_ms, Some(1500));
        assert_eq!(expired.stop_reason.as_deref(), Some("time-elapsed"));
        assert!(expired.resumed);
        let live = store.trips.iter().find(|t| t.id == "live").unwrap();
        assert!(live.ended_at_ms.is_none());
        assert!(live.resumed);
        assert_eq!(store.active_trip_id.as_deref(), Some("live"));
    }

    #[test]
    fn reconcile_clears_active_when_trip_ended() {
        let mut store = TripStoreFile {
            trips: vec![active_trip("x", "after", 1000, Some(500))],
            active_trip_id: Some("x".into()),
        };
        assert!(reconcile_on_startup(&mut store, 9000));
        assert_eq!(store.active_trip_id, None);
    }

    #[test]
    fn reconcile_noop_when_nothing_to_do() {
        let mut store = TripStoreFile::default();
        assert!(!reconcile_on_startup(&mut store, 5000));
    }

    #[test]
    fn corrupt_file_is_quarantined_not_fatal() {
        let dir = std::env::temp_dir().join(format!("tokentracker-test-corrupt-{}", line!()));
        let path = dir.join("trips.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        let loaded = load_trips_file(&path);
        assert_eq!(loaded, TripStoreFile::default());
        // Original moved aside; a fresh save works over it.
        save_trips_file(
            &path,
            &TripStoreFile {
                trips: vec![active_trip("a", "manual", 1, None)],
                active_trip_id: None,
            },
        )
        .expect("save after corrupt");
        assert_eq!(load_trips_file(&path).trips.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_file_loads_empty() {
        let path = std::env::temp_dir().join(format!("tokentracker-test-missing-{}-x.json", line!()));
        assert_eq!(load_trips_file(&path), TripStoreFile::default());
    }
}
