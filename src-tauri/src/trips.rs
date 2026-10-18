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
        };
        assert_eq!(check_auto_stop(&trip, 1499, None), None);
        assert_eq!(
            check_auto_stop(&trip, 1500, None),
            Some("time-elapsed".to_string())
        );
    }
}
