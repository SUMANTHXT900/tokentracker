//! Live file watcher: notify-based with debounce.
//!
//! No `tokscale_core` parsing here — this only observes the filesystem and
//! emits `usage://updated`. The frontend refetches via `get_usage_snapshot`
//! (which keeps previous data, so UI never flashes).

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct UsageUpdatedPayload {
    pub at: String,
    pub kind: String,
}

pub struct WatcherState {
    pub running: AtomicBool,
    pub errors: Mutex<Vec<String>>,
    pub pending: Mutex<i32>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            errors: Mutex::new(Vec::new()),
            pending: Mutex::new(0),
        }
    }
}

/// Candidate roots to watch. Only existing dirs are watched (max ~12 to
/// avoid handle exhaustion). SQLite parents are watched (not files) so WAL
/// commits surface as dir events.
fn candidate_roots() -> Vec<PathBuf> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return vec![],
    };
    let rels = [
        ".claude/projects",
        ".codex/sessions",
        ".local/share/opencode",
        ".config/tokscale",
        ".gemini",
        ".opencode",
        ".config/Code",
        ".cursor",
    ];
    rels
        .into_iter()
        .map(|rel| {
            let mut p = home.clone();
            for part in rel.split('/') {
                p.push(part);
            }
            p
        })
        .filter(|p| p.is_dir())
        .take(12)
        .collect()
}

/// Start watcher once per process. Safe to call from `.setup()`.
pub fn start_watcher(app: AppHandle) {
    let already = app
        .try_state::<WatcherState>()
        .map(|s| s.running.swap(true, Ordering::SeqCst))
        .unwrap_or(true);
    if already {
        return;
    }

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let roots = candidate_roots();

    if roots.is_empty() {
        if let Some(state) = app.try_state::<WatcherState>() {
            if let Ok(mut errs) = state.errors.lock() {
                errs.push("watcher: no session dirs found".to_string());
            }
        }
        // Still mark running so we don't retry every setup; polling covers it.
    }

    std::thread::spawn(move || {
        let tx_clone = tx.clone();
        let mut watcher: RecommendedWatcher = match Watcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if res.is_ok() {
                    let _ = tx_clone.send(());
                }
            },
            notify::Config::default().with_poll_interval(Duration::from_secs(2)),
        ) {
            Ok(w) => w,
            Err(_) => return,
        };
        for root in roots {
            let _ = watcher.watch(&root, RecursiveMode::Recursive);
        }
        // Park forever; events flow via channel. Keep watcher alive.
        loop {
            std::thread::park();
        }
    });

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::time::{sleep, Duration as TDuration};
        let mut last_emit = std::time::Instant::now()
            .checked_sub(Duration::from_secs(60))
            .unwrap();

        loop {
            // Block up to 1s for an event (cheap, no rescan here).
            let got = rx.recv_timeout(Duration::from_secs(1)).is_ok();
            if got {
                if let Some(state) = app_clone.try_state::<WatcherState>() {
                    if let Ok(mut p) = state.pending.lock() {
                        *p += 1;
                    }
                }
                // Debounce: wait 3s quiet, draining bursts.
                sleep(TDuration::from_secs(3)).await;
                while rx.try_recv().is_ok() {}
                if last_emit.elapsed() < Duration::from_secs(5) {
                    continue;
                }
                last_emit = std::time::Instant::now();
                if let Some(state) = app_clone.try_state::<WatcherState>() {
                    if let Ok(mut p) = state.pending.lock() {
                        *p = 0;
                    }
                }
                let _ = app_clone.emit(
                    "usage://updated",
                    UsageUpdatedPayload {
                        at: chrono::Utc::now().to_rfc3339(),
                        kind: "fs".to_string(),
                    },
                );
            }
            // Idle: loop back to recv_timeout (covers SQLite WAL via notify
            // poll_interval; no timer rescan to avoid useless 200ms scans).
        }
    });
}
