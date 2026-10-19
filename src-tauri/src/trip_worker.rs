//! Trip auto-stop worker: enforces `after` / `idle` stop modes.
//!
//! Pure decision logic lives in `trips::check_auto_stop`. This worker only
//! schedules checks (every 60s, only when an auto trip is active), marks the
//! trip stopped, clears `active_trip` if it matches, and emits
//! `trip://stopped { trip_id, reason }`. Frontend refetches trips.

use tauri::{AppHandle, Emitter, Manager};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn start_trip_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tokio::time::{sleep, Duration};
        loop {
            sleep(Duration::from_secs(60)).await;

            // Collect auto trips needing a check (clone to avoid holding lock).
            let candidates: Vec<crate::trips::TripConfig> = app
                .try_state::<crate::AppState>()
                .and_then(|s| s.trips.lock().map(|t| t.clone()).ok())
                .unwrap_or_default()
                .into_iter()
                .filter(|t| t.ended_at_ms.is_none() && t.stop_mode != "manual")
                .collect();

            if candidates.is_empty() {
                continue;
            }

            for trip in candidates {
                // Single clock read per trip so the check and the close agree.
                let now = now_ms();
                let (reason, ended_at) = if trip.stop_mode == "after" {
                    match crate::trips::check_auto_stop(&trip, now, None) {
                        Some(reason) => {
                            // Retroactive close at the deadline (matches
                            // `reconcile_on_startup`), not at the 60s tick.
                            let deadline = trip
                                .started_at_ms
                                .saturating_add(trip.stop_after_ms.unwrap_or(0).max(0));
                            (Some(reason), deadline)
                        }
                        None => (None, 0),
                    }
                } else if trip.stop_mode == "idle" {
                    // Idle needs last activity: scan trip-scoped rows, take max ts.
                    // One priced scan per idle trip per minute (only while active).
                    let pricing = app
                        .try_state::<crate::AppState>()
                        .and_then(|state| state.pricing());
                    let last = match crate::adapter::parse_to_snapshot_async(
                        None,
                        trip.clients.clone(),
                        None,
                        None,
                        pricing,
                    )
                    .await
                    {
                        Ok(snap) => snap
                            .rows
                            .iter()
                            .filter(|r| r.timestamp >= trip.started_at_ms)
                            .map(|r| r.timestamp)
                            .max(),
                        Err(_) => None,
                    };
                    match crate::trips::check_auto_stop(&trip, now, last) {
                        Some(reason) => {
                            let anchor = last.unwrap_or(trip.started_at_ms);
                            let deadline =
                                anchor.saturating_add(trip.idle_after_ms.unwrap_or(0).max(0));
                            (Some(reason), deadline.min(now))
                        }
                        None => (None, 0),
                    }
                } else {
                    (None, 0)
                };

                if let Some(reason) = reason {
                    // Mark stopped. Each mutex is locked in its own scope and
                    // released before the next is acquired (trips → active →
                    // persist's internal trips → active), matching the order
                    // in `persist_trips`, so no lock inversion is possible.
                    // Skip trips that raced us (e.g. manual stop won): never
                    // overwrite an existing end time or emit a duplicate event.
                    let stopped_id = {
                        let state = match app.try_state::<crate::AppState>() {
                            Some(s) => s,
                            None => continue,
                        };
                        let mut trips = state
                            .trips
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        match trips.iter_mut().find(|t| t.id == trip.id) {
                            Some(t) => {
                                if t.ended_at_ms.is_some() {
                                    None
                                } else {
                                    *t = crate::trips::trip_stop_at(
                                        t.clone(),
                                        ended_at,
                                        Some(reason.clone()),
                                    );
                                    Some(t.id.clone())
                                }
                            }
                            None => None,
                        }
                    };
                    let stopped_id = match stopped_id {
                        Some(id) => id,
                        None => continue,
                    };
                    // Clear active if it matches.
                    if let Some(state) = app.try_state::<crate::AppState>() {
                        let mut active = state
                            .active_trip
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        if active.as_ref().map(|a| a.id.as_str()) == Some(stopped_id.as_str()) {
                            *active = None;
                        }
                    }
                    // Persist BEFORE emitting: a crash between emit and
                    // persist previously left disk still "active", resurrecting
                    // the trip on restart after the UI already showed stopped.
                    if let Some(state) = app.try_state::<crate::AppState>() {
                        crate::persist_trips(&state);
                    }
                    let _ = app.emit(
                        "trip://stopped",
                        serde_json::json!({ "trip_id": stopped_id, "reason": reason }),
                    );
                    // Best-effort OS notification (silent fail in browser/dev).
                    #[cfg(desktop)]
                    {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app
                            .notification()
                            .builder()
                            .title("Trip stopped")
                            .body(format!("{} · {}", trip.name, reason))
                            .show();
                    }
                }
            }
        }
    });
}
