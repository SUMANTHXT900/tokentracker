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
pub fn trip_stop_now(trip: TripConfig, reason: Option<String>) -> TripConfig {
    trip_stop_at(trip, Utc::now().timestamp_millis(), reason)
}

/// Stop a trip at an explicit end time (retroactive closes use the deadline,
/// not "now", so restarts and the worker agree on the end time).
/// Clamps `ended_at_ms` to `>= started_at_ms` so corrupt/negative inputs can
/// never produce an inverted window. No-op when already stopped (preserves
/// the original end time/reason).
pub fn trip_stop_at(mut trip: TripConfig, ended_at_ms: i64, reason: Option<String>) -> TripConfig {
    if trip.ended_at_ms.is_none() {
        trip.ended_at_ms = Some(ended_at_ms.max(trip.started_at_ms));
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
                // Non-positive durations are config errors; never fire instead
                // of instantly closing every trip.
                if after <= 0 {
                    return None;
                }
                if now_ms >= trip.started_at_ms.saturating_add(after) {
                    return Some("time-elapsed".to_string());
                }
            }
            None
        }
        "idle" => {
            if let Some(idle) = trip.idle_after_ms {
                if idle <= 0 {
                    return None;
                }
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
/// (`trips.json.corrupt-<millis>-<pid>`) and treated as empty, so one bad write can
/// never brick trip history. Successfully parsed stores are sanitized
/// (empty ids dropped, duplicate ids de-duplicated keeping the last write,
/// inverted `[start, end]` windows clamped) so bad data on disk can never
/// poison in-memory state.
pub fn load_trips_file(path: &std::path::Path) -> TripStoreFile {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TripStoreFile::default(),
        // Any other I/O error (permissions, etc.): do NOT quarantine — we
        // couldn't even read the file, so renaming it aside could destroy
        // data. Return empty; the caller only persists when reconcile reports
        // a change, so we won't overwrite the unreadable file blindly.
        Err(_) => return TripStoreFile::default(),
    };
    match serde_json::from_str::<TripStoreFile>(&raw) {
        Ok(store) => sanitize_store(store),
        Err(_) => {
            let backup = path.with_extension(format!(
                "json.corrupt-{}-{}",
                chrono::Utc::now().timestamp_millis(),
                std::process::id()
            ));
            // Best-effort quarantine; a failure here still returns empty
            // (the corrupt bytes are unparseable either way).
            let _ = std::fs::rename(path, &backup);
            // If rename failed (e.g. permissions), try copy-then-remove so a
            // retry doesn't spin on the same corrupt file; ignore errors.
            if path.exists() {
                let _ = std::fs::copy(path, &backup);
            }
            TripStoreFile::default()
        }
    }
}

/// Drop entries that can never be valid and heal inverted windows.
/// - empty `id` → dropped (unaddressable; commands look trips up by id).
/// - duplicate `id` → last occurrence wins (a re-save overwrites).
/// - `ended_at_ms < started_at_ms` → clamped to `started_at_ms`.
fn sanitize_store(store: TripStoreFile) -> TripStoreFile {
    // Dedupe keeping the LAST write, preserving the relative order of the
    // surviving entries.
    let mut seen = std::collections::HashSet::new();
    let mut deduped_rev: Vec<TripConfig> = Vec::with_capacity(store.trips.len());
    for trip in store.trips.into_iter().rev() {
        if trip.id.is_empty() || !seen.insert(trip.id.clone()) {
            continue;
        }
        deduped_rev.push(trip);
    }
    let mut trips: Vec<TripConfig> = deduped_rev.into_iter().rev().collect();
    for trip in trips.iter_mut() {
        if let Some(end) = trip.ended_at_ms {
            if end < trip.started_at_ms {
                trip.ended_at_ms = Some(trip.started_at_ms);
            }
        }
    }
    let active_trip_id = match store.active_trip_id {
        Some(id) if id.is_empty() => None,
        other => other,
    };
    TripStoreFile {
        trips,
        active_trip_id,
    }
}

/// Save the store atomically (unique temp file in the same directory +
/// rename, so concurrent saves never share a tmp path) with a read-back
/// verification: after rename the file is re-read and parsed, and a mismatch
/// is reported as an error instead of silently losing data.
pub fn save_trips_file(path: &std::path::Path, store: &TripStoreFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("trips dir: {e}"))?;
        }
    }
    let raw = serde_json::to_string_pretty(store).map_err(|e| format!("trips serialize: {e}"))?;
    // Unique tmp in the SAME directory (rename stays on one filesystem, so
    // it remains atomic). Includes pid + nanos to survive rapid succession.
    let tmp = path.with_extension(format!(
        "json.tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    {
        use std::io::Write;
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("trips write: {e}"))?;
        f.write_all(raw.as_bytes())
            .map_err(|e| format!("trips write: {e}"))?;
        f.sync_all().map_err(|e| format!("trips sync: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("trips commit: {e}"));
    }
    // Read-back verification: the committed bytes must parse to what we wrote.
    let verify_raw =
        std::fs::read_to_string(path).map_err(|e| format!("trips verify read: {e}"))?;
    let verify: TripStoreFile =
        serde_json::from_str(&verify_raw).map_err(|e| format!("trips verify parse: {e}"))?;
    if verify != *store {
        return Err("trips verify: mismatch after write".to_string());
    }
    Ok(())
}

/// Reconcile a freshly loaded store against `now_ms`.
///
/// - Active trips restored from disk and still running are marked
///   `resumed = true`. Trips closed retroactively below are NOT marked
///   resumed — they never ran in this session, so a "resumed" badge on them
///   would be a lie.
/// - Expired `after` trips are closed retroactively at their deadline
///   (`started_at_ms + stop_after_ms`, reason `time-elapsed`) so a trip whose
///   deadline passed while the app was closed shows the right end time.
///   Non-positive `stop_after_ms` values are config errors and never fire.
///   Trips with `started_at_ms` in the future (clock skew) are left running.
/// - `idle` trips are left to the trip worker, which recomputes last activity
///   from a fresh scan (needs I/O; reconcile stays pure).
/// - Stale `active_trip_id`s (missing or ended trip) are cleared; when no
///   active id remains but active trips exist, the newest active trip is
///   promoted so a legacy/edited file can't strand running trips.
/// - Inverted `[start, end]` windows on already-closed trips are clamped.
/// - Duplicate ids (shouldn't happen post-sanitize, but in-memory stores
///   bypass `load`) are de-duplicated, last write wins.
///
/// Returns true when anything changed (caller should persist).
pub fn reconcile_on_startup(store: &mut TripStoreFile, now_ms: i64) -> bool {
    let mut changed = false;

    // Defensive: same sanitize `load` applies (dedupe + clamp), but track
    // whether it changed anything so the caller persists the healed store.
    {
        let before = store.trips.len();
        let sanitized = sanitize_store(store.clone());
        if sanitized.trips.len() != before
            || sanitized.trips.iter().any(|t| {
                store
                    .trips
                    .iter()
                    .find(|o| o.id == t.id)
                    .map(|o| o != t)
                    .unwrap_or(true)
            })
        {
            changed = true;
        }
        // Heal inverted windows on already-closed trips too.
        for trip in sanitized.trips.iter() {
            if let Some(prev) = store.trips.iter().find(|o| o.id == trip.id) {
                if prev.ended_at_ms != trip.ended_at_ms {
                    changed = true;
                }
            }
        }
        *store = sanitized;
    }

    for trip in store.trips.iter_mut().filter(|t| t.ended_at_ms.is_none()) {
        if trip.stop_mode == "after" {
            if let Some(after) = trip.stop_after_ms {
                if after > 0 {
                    let deadline = trip.started_at_ms.saturating_add(after);
                    // `started <= now` guards clock skew (start in the
                    // future): a trip that hasn't started can't have expired.
                    if trip.started_at_ms <= now_ms && now_ms >= deadline {
                        let closed = trip_stop_at(
                            trip.clone(),
                            deadline,
                            Some("time-elapsed".to_string()),
                        );
                        // Retroactive close: keep `resumed` as-is (false for
                        // a freshly restored trip) — it never ran here.
                        trip.ended_at_ms = closed.ended_at_ms;
                        trip.stop_reason = closed.stop_reason;
                        changed = true;
                        continue;
                    }
                }
            }
        }
        if !trip.resumed {
            trip.resumed = true;
            changed = true;
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
    // Promote the newest running trip when no active id remains (stale id
    // cleared above, or legacy file with actives but no id).
    if store.active_trip_id.is_none() {
        if let Some(newest) = store
            .trips
            .iter()
            .filter(|t| t.ended_at_ms.is_none())
            .max_by_key(|t| t.started_at_ms)
        {
            store.active_trip_id = Some(newest.id.clone());
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
        // Retroactively closed trips never ran in this session: resumed stays false.
        assert!(!expired.resumed);
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

    #[test]
    fn trip_stop_at_clamps_inverted_window_and_preserves_existing() {
        let trip = active_trip("t", "manual", 1000, None);
        // Retroactive end before start clamps to start.
        let closed = trip_stop_at(trip, 500, Some("time-elapsed".into()));
        assert_eq!(closed.ended_at_ms, Some(1000));
        assert_eq!(closed.stop_reason.as_deref(), Some("time-elapsed"));
        // Already-stopped trips are untouched (no overwrite of end/reason).
        let mut stopped = closed.clone();
        stopped.stop_reason = Some("original".into());
        let again = trip_stop_at(stopped.clone(), 9999, Some("other".into()));
        assert_eq!(again.ended_at_ms, stopped.ended_at_ms);
        assert_eq!(again.stop_reason.as_deref(), Some("original"));
    }

    #[test]
    fn auto_stop_rejects_non_positive_durations() {
        let mut after = active_trip("a", "after", 1000, Some(0));
        assert_eq!(check_auto_stop(&after, 999_999, None), None);
        after.stop_after_ms = Some(-100);
        assert_eq!(check_auto_stop(&after, 999_999, None), None);
        let idle = TripConfig {
            idle_after_ms: Some(0),
            stop_mode: "idle".into(),
            ..active_trip("i", "idle", 1000, None)
        };
        assert_eq!(check_auto_stop(&idle, 999_999, Some(1000)), None);
        let idle_neg = TripConfig {
            idle_after_ms: Some(-5),
            ..idle.clone()
        };
        assert_eq!(check_auto_stop(&idle_neg, 999_999, Some(1000)), None);
    }

    #[test]
    fn auto_stop_idle_fires_from_anchor() {
        let idle = TripConfig {
            idle_after_ms: Some(1_000),
            ..active_trip("i", "idle", 1000, None)
        };
        assert_eq!(check_auto_stop(&idle, 1999, Some(1000)), None);
        assert_eq!(
            check_auto_stop(&idle, 2000, Some(1000)),
            Some("idle-timeout".to_string())
        );
        // No activity yet → measured from start.
        assert_eq!(
            check_auto_stop(&idle, 2000, None),
            Some("idle-timeout".to_string())
        );
    }

    #[test]
    fn reconcile_ignores_non_positive_after_but_marks_resumed() {
        let mut store = TripStoreFile {
            trips: vec![active_trip("z", "after", 1000, Some(0))],
            active_trip_id: Some("z".into()),
        };
        assert!(reconcile_on_startup(&mut store, 999_999));
        let t = store.trips.iter().find(|t| t.id == "z").unwrap();
        assert!(t.ended_at_ms.is_none());
        assert!(t.resumed);
        assert_eq!(store.active_trip_id.as_deref(), Some("z"));
    }

    #[test]
    fn reconcile_leaves_future_started_trips_running_on_clock_skew() {
        // `now` behind `started`: clock moved backwards. Must not close.
        let mut store = TripStoreFile {
            trips: vec![active_trip("f", "after", 10_000, Some(500))],
            active_trip_id: Some("f".into()),
        };
        assert!(reconcile_on_startup(&mut store, 5_000));
        let t = store.trips.iter().find(|t| t.id == "f").unwrap();
        assert!(t.ended_at_ms.is_none());
        assert!(t.resumed);
        assert_eq!(store.active_trip_id.as_deref(), Some("f"));
    }

    #[test]
    fn reconcile_promotes_newest_when_active_id_missing() {
        let mut store = TripStoreFile {
            trips: vec![
                active_trip("old", "manual", 1000, None),
                active_trip("new", "manual", 2000, None),
            ],
            active_trip_id: None,
        };
        assert!(reconcile_on_startup(&mut store, 3000));
        assert_eq!(store.active_trip_id.as_deref(), Some("new"));
        assert!(store.trips.iter().all(|t| t.resumed));
    }

    #[test]
    fn reconcile_promotes_survivor_when_active_id_stale() {
        let mut store = TripStoreFile {
            trips: vec![
                active_trip("gone", "after", 1000, Some(100)),
                active_trip("survivor", "manual", 2000, None),
            ],
            // Points at a trip that will be retroactively closed.
            active_trip_id: Some("gone".into()),
        };
        assert!(reconcile_on_startup(&mut store, 5000));
        let gone = store.trips.iter().find(|t| t.id == "gone").unwrap();
        assert!(gone.ended_at_ms.is_some());
        // Stale id is not left dangling: the surviving active trip is promoted.
        assert_eq!(store.active_trip_id.as_deref(), Some("survivor"));
    }

    #[test]
    fn reconcile_dedupes_and_clamps_inverted_windows() {
        let mut dupe = active_trip("d", "manual", 1000, None);
        dupe.name = "second-wins".into();
        let mut store = TripStoreFile {
            trips: vec![active_trip("d", "manual", 1000, None), dupe],
            active_trip_id: Some("d".into()),
        };
        assert!(reconcile_on_startup(&mut store, 1500));
        assert_eq!(store.trips.len(), 1);
        assert_eq!(store.trips[0].name, "second-wins");

        // Already-closed trip with end < start is clamped to start.
        let mut bad = TripStoreFile {
            trips: vec![TripConfig {
                ended_at_ms: Some(500),
                ..active_trip("bad", "manual", 1000, None)
            }],
            active_trip_id: None,
        };
        assert!(reconcile_on_startup(&mut bad, 2000));
        assert_eq!(
            bad.trips[0].ended_at_ms,
            Some(1000),
            "inverted window must clamp"
        );
    }

    #[test]
    fn load_sanitizes_duplicates_empty_ids_and_inverted_windows() {
        let dir = std::env::temp_dir().join(format!("tokentracker-test-sanitize-{}", line!()));
        let path = dir.join("trips.json");
        std::fs::create_dir_all(&dir).unwrap();
        let raw = serde_json::json!({
            "trips": [
                {"id": "", "name": "empty", "clients": null, "started_at_ms": 1,
                 "ended_at_ms": null, "stop_mode": "manual", "stop_after_ms": null,
                 "idle_after_ms": null, "stop_reason": null, "resumed": false},
                {"id": "d", "name": "first", "clients": null, "started_at_ms": 1,
                 "ended_at_ms": null, "stop_mode": "manual", "stop_after_ms": null,
                 "idle_after_ms": null, "stop_reason": null, "resumed": false},
                {"id": "d", "name": "last", "clients": null, "started_at_ms": 1,
                 "ended_at_ms": null, "stop_mode": "manual", "stop_after_ms": null,
                 "idle_after_ms": null, "stop_reason": null, "resumed": false},
                {"id": "bad", "name": "bad", "clients": null, "started_at_ms": 1000,
                 "ended_at_ms": 500, "stop_mode": "manual", "stop_after_ms": null,
                 "idle_after_ms": null, "stop_reason": null, "resumed": false}
            ],
            "active_trip_id": ""
        });
        std::fs::write(&path, serde_json::to_string_pretty(&raw).unwrap()).unwrap();
        let loaded = load_trips_file(&path);
        assert_eq!(loaded.trips.len(), 2, "empty id dropped, dupe collapsed");
        assert_eq!(
            loaded.trips.iter().find(|t| t.id == "d").unwrap().name,
            "last"
        );
        assert_eq!(
            loaded.trips.iter().find(|t| t.id == "bad").unwrap().ended_at_ms,
            Some(1000)
        );
        assert_eq!(loaded.active_trip_id, None, "empty active id → None");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_file_is_quarantined_with_backup() {
        let dir = std::env::temp_dir().join(format!("tokentracker-test-empty-{}", line!()));
        let path = dir.join("trips.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "").unwrap();
        let loaded = load_trips_file(&path);
        assert_eq!(loaded, TripStoreFile::default());
        let quarantined = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .any(|n| n.contains("corrupt-"));
        assert!(quarantined, "empty file must leave a corrupt backup");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_creates_parent_dirs_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("tokentracker-test-dirs-{}", line!()));
        let path = dir.join("nested").join("trips.json");
        let store = TripStoreFile {
            trips: vec![active_trip("a", "manual", 1000, None)],
            active_trip_id: Some("a".into()),
        };
        save_trips_file(&path, &store).expect("save creates dirs");
        assert_eq!(load_trips_file(&path), store);
        // Unique-tmp scheme must not leave debris behind.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "tmp leftovers: {leftovers:?}");
        // Rapid successive saves (same millis) must both succeed.
        save_trips_file(&path, &store).expect("second save");
        assert_eq!(load_trips_file(&path), store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
