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
                let reason = if trip.stop_mode == "after" {
                    crate::trips::check_auto_stop(&trip, now_ms(), None)
                } else if trip.stop_mode == "idle" {
                    // Idle needs last activity: scan trip-scoped rows, take max ts.
                    // One priced scan per idle trip per minute (only while active).
                    let last = match crate::adapter::parse_to_snapshot_async(
                        None,
                        trip.clients.clone(),
                        None,
                        None,
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
                    crate::trips::check_auto_stop(&trip, now_ms(), last)
                } else {
                    None
                };

                if let Some(reason) = reason {
                    // Mark stopped.
                    let stopped_id = {
                        let state = match app.try_state::<crate::AppState>() {
                            Some(s) => s,
                            None => continue,
                        };
                        let mut trips = match state.trips.lock() {
                            Ok(g) => g,
                            Err(_) => continue,
                        };
                        match trips.iter_mut().find(|t| t.id == trip.id) {
                            Some(t) => {
                                *t = crate::trips::trip_stop_now(t.clone(), Some(reason.clone()));
                                t.id.clone()
                            }
                            None => continue,
                        }
                    };
                    // Clear active if it matches.
                    if let Some(state) = app.try_state::<crate::AppState>() {
                        if let Ok(mut active) = state.active_trip.lock() {
                            if active.as_ref().map(|a| a.id.as_str()) == Some(stopped_id.as_str()) {
                                *active = None;
                            }
                        }
                    }
                    let _ = app.emit(
                        "trip://stopped",
                        serde_json::json!({ "trip_id": stopped_id, "reason": reason }),
                    );
                    // Persist the auto-stop so restarts see the closed trip.
                    if let Some(state) = app.try_state::<crate::AppState>() {
                        crate::persist_trips(&state);
                    }
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
