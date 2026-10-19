//! Deterministic main-window geometry persistence.
//!
//! Replaces `tauri-plugin-window-state` for this app. The plugin persists the
//! *current* outer size, which while maximized is the monitor size, so the next
//! `unmaximize()` can restore to (almost) the full screen. Here the maximized
//! flag and the last genuinely windowed bounds are tracked separately, so
//! restore always lands on a sane windowed rect.
//!
//! State lives in `<app data dir>/window-state.json` and is written atomically
//! (temp file + rename) only on close, never on every resize event.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

pub const MIN_WIDTH: u32 = 800;
pub const MIN_HEIGHT: u32 = 500;
pub const DEFAULT_WIDTH: u32 = 1100;
pub const DEFAULT_HEIGHT: u32 = 720;

const STATE_FILE: &str = "window-state.json";

/// Persisted window preferences, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowPrefs {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowPrefs {
    /// First launch: a normal 1100x720 rect, opened maximized.
    fn default() -> Self {
        Self {
            // Only visible if maximizing fails; the first launch is maximized.
            x: 100,
            y: 100,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            maximized: true,
        }
    }
}

impl WindowPrefs {
    fn bounds(self) -> WindowBounds {
        WindowBounds {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

/// A physical monitor work area (excludes the taskbar/dock).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy)]
struct Rect {
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

impl Rect {
    fn new(x: i64, y: i64, width: i64, height: i64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn from_prefs(prefs: &WindowPrefs) -> Self {
        Self::new(
            prefs.x as i64,
            prefs.y as i64,
            prefs.width as i64,
            prefs.height as i64,
        )
    }

    fn from_monitor(area: MonitorArea) -> Self {
        Self::new(
            area.x as i64,
            area.y as i64,
            area.width as i64,
            area.height as i64,
        )
    }

    fn intersection_area(self, other: Rect) -> i64 {
        let left = self.x.max(other.x);
        let top = self.y.max(other.y);
        let right = (self.x + self.width).min(other.x + other.width);
        let bottom = (self.y + self.height).min(other.y + other.height);
        (right - left).max(0) * (bottom - top).max(0)
    }
}

/// Enforce the minimum size, clamp into the monitor work area holding most of
/// the saved rect, and center on the primary monitor when the saved position
/// does not intersect any monitor (unplugged display, corrupted state, ...).
///
/// Pure: no Tauri window is needed, which keeps the geometry rules unit-tested.
pub fn sanitize_prefs(prefs: WindowPrefs, monitors: &[MonitorArea]) -> WindowPrefs {
    let mut out = prefs;
    out.width = out.width.max(MIN_WIDTH);
    out.height = out.height.max(MIN_HEIGHT);

    // No monitor information: keep the fixed-size rect, only min is enforced.
    let Some(&primary) = monitors.first() else {
        return out;
    };

    let saved = Rect::from_prefs(&out);
    let mut target = None;
    let mut best_overlap = 0;
    for monitor in monitors {
        let overlap = saved.intersection_area(Rect::from_monitor(*monitor));
        if overlap > best_overlap {
            best_overlap = overlap;
            target = Some(*monitor);
        }
    }

    let area = match target {
        Some(area) => area,
        // Off-screen (or entirely on a disconnected display): center on the
        // primary monitor. `monitors[0]` is the primary by contract.
        None => {
            let area = primary;
            let area_width = area.width.max(1);
            let area_height = area.height.max(1);
            let width = out.width.min(area_width);
            let height = out.height.min(area_height);
            out.width = width;
            out.height = height;
            out.x = area.x + ((area_width - width) / 2) as i32;
            out.y = area.y + ((area_height - height) / 2) as i32;
            return out;
        }
    };

    // Shrink to the work area if the saved rect was larger (e.g. saved on a
    // bigger display). A monitor smaller than the minimum wins over the min.
    let area_width = area.width.max(1);
    let area_height = area.height.max(1);
    out.width = out.width.min(area_width);
    out.height = out.height.min(area_height);

    // Clamp the top-left so the whole window sits inside the work area.
    let max_x = area.x as i64 + area_width as i64 - out.width as i64;
    let max_y = area.y as i64 + area_height as i64 - out.height as i64;
    out.x = (out.x as i64).clamp(area.x as i64, max_x) as i32;
    out.y = (out.y as i64).clamp(area.y as i64, max_y) as i32;
    out
}

/// `<app data dir>/window-state.json`. `None` when the OS cannot resolve an
/// app data directory (the app still runs, just without persistence).
pub fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(STATE_FILE))
}

/// Missing/corrupt files fall back to [`WindowPrefs::default`]. A UTF-8 BOM
/// (e.g. the file was hand-edited in Notepad) is stripped before parsing.
pub fn load_prefs(path: &Path) -> WindowPrefs {
    let Ok(bytes) = fs::read(path) else {
        return WindowPrefs::default();
    };
    let bytes = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(&bytes);
    serde_json::from_slice(bytes).unwrap_or_default()
}

/// Atomically persist: write a sibling temp file, flush it, then rename over
/// the destination. A crash leaves either the old or the new file, never a
/// half-written JSON document.
pub fn save_prefs(path: &Path, prefs: &WindowPrefs) -> std::io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_vec_pretty(prefs).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");

    let mut file = fs::File::create(&tmp)?;
    file.write_all(&data)?;
    file.sync_all()?;
    drop(file);

    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

/// Last known non-maximized/non-minimized window bounds: outer position plus
/// inner (client) size, matching `set_position` + `set_size` on restore.
/// Also carries the last observed maximized flag (which is not readable while
/// minimized on Windows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
struct SessionInner {
    restoring: bool,
    last_normal: Option<WindowBounds>,
    last_maximized: bool,
    /// Set after a successful close-time write so a following
    /// `RunEvent::ExitRequested` cannot overwrite it from a dying window.
    saved: bool,
    /// Bumped on every geometry event and on explicit seed/reset. A delayed
    /// commit only lands when its generation is still current.
    generation: u64,
    /// Rate-limits the debounce task spawn during a continuous drag/resize.
    last_schedule: Option<Instant>,
}

/// Managed state shared by the window-event handler and the exit hook.
#[derive(Default)]
pub struct WindowSession {
    inner: Mutex<SessionInner>,
}

impl WindowSession {
    fn lock(&self) -> MutexGuard<'_, SessionInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Suppress geometry tracking while setup applies the persisted state.
    pub fn begin_restore(&self) {
        self.lock().restoring = true;
    }

    pub fn end_restore(&self) {
        self.lock().restoring = false;
    }

    /// Seed with the restored windowed bounds before max/min events arrive.
    pub fn seed(&self, bounds: WindowBounds, maximized: bool) {
        let mut inner = self.lock();
        inner.generation = inner.generation.wrapping_add(1);
        inner.last_normal = Some(bounds);
        inner.last_maximized = maximized;
        inner.saved = false;
    }

    /// Re-assert the known windowed bounds after the startup maximize. The
    /// maximize transition can emit resize events while `is_maximized()` is
    /// still false; bumping the generation invalidates any pending commit.
    pub fn set_normal(&self, bounds: WindowBounds, maximized: bool) {
        let mut inner = self.lock();
        inner.generation = inner.generation.wrapping_add(1);
        inner.last_normal = Some(bounds);
        inner.last_maximized = maximized;
        inner.saved = false;
    }

    /// Update tracked normal bounds from a Resized/Moved event.
    ///
    /// Only non-maximized, non-minimized geometry is recorded, so maximizing
    /// (and the monitor-sized resize it emits) can never clobber the windowed
    /// rect used for the next unmaximize.
    pub fn observe(&self, window: &WebviewWindow) {
        {
            let inner = self.lock();
            if inner.restoring {
                return;
            }
        }

        let minimized = window.is_minimized().unwrap_or(false);
        let maximized = window.is_maximized().unwrap_or(false);
        // While minimized Windows reports neither the normal geometry nor
        // reliably the zoomed state; keep the previous values untouched.
        if minimized {
            return;
        }

        {
            let mut inner = self.lock();
            if inner.restoring {
                return;
            }
            inner.last_maximized = maximized;
            inner.saved = false;
        }

        if maximized {
            return;
        }

        // Debounce: a maximize transition can emit Resized/Moved events while
        // `is_maximized()` is still false. Record geometry only after the
        // events settle, then re-check the live state. One task per ~250ms of
        // continuous dragging; stale generations no-op.
        let (generation, should_spawn) = {
            let mut inner = self.lock();
            inner.generation = inner.generation.wrapping_add(1);
            let should_spawn = inner
                .last_schedule
                .map_or(true, |at| at.elapsed() >= Duration::from_millis(250));
            if should_spawn {
                inner.last_schedule = Some(Instant::now());
            }
            (inner.generation, should_spawn)
        };
        if !should_spawn {
            return;
        }

        let win = window.clone();
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            app.state::<WindowSession>().commit_normal(&win, generation);
        });
    }

    /// Commit a settled normal-window rect, unless the window has since been
    /// maximized/minimized, moved to another generation, or resized to the
    /// current monitor's full work area (the maximize transition).
    fn commit_normal(&self, window: &WebviewWindow, generation: u64) {
        {
            let inner = self.lock();
            if inner.restoring || inner.generation != generation {
                return;
            }
        }
        if window.is_minimized().unwrap_or(true) || window.is_maximized().unwrap_or(true) {
            return;
        }
        // Outer position + inner size: `set_size` restores the client area, so
        // saving the outer size would grow the window by its borders each run.
        let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
            return;
        };
        if size.width == 0 || size.height == 0 {
            return;
        }

        let near_full = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| {
                let work = monitor.work_area();
                size.width.saturating_add(2) >= work.size.width
                    && size.height.saturating_add(2) >= work.size.height
            })
            .unwrap_or(false);
        if near_full {
            return;
        }

        let mut inner = self.lock();
        if inner.restoring || inner.generation != generation {
            return;
        }
        inner.last_normal = Some(WindowBounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        });
        inner.saved = false;
    }

    fn snapshot(&self, window: &WebviewWindow) -> WindowPrefs {
        let minimized = window.is_minimized().unwrap_or(false);
        let (last_maximized, last_normal) = {
            let inner = self.lock();
            (inner.last_maximized, inner.last_normal)
        };
        // A destroyed HWND can make this query fail or lie; the last observed
        // flag is the trustworthy fallback during shutdown.
        let maximized_now = window.is_maximized().unwrap_or(last_maximized);
        let maximized = if minimized {
            last_maximized
        } else {
            maximized_now
        };

        // If we are windowed and readable, trust the live rect; otherwise fall
        // back to the last normal bounds captured before maximizing/minimizing.
        let live = if !maximized && !minimized {
            match (window.outer_position(), window.inner_size()) {
                (Ok(position), Ok(size)) if size.width > 0 && size.height > 0 => {
                    Some(WindowBounds {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                    })
                }
                _ => None,
            }
        } else {
            None
        };
        let bounds = live
            .or(last_normal)
            .unwrap_or_else(|| WindowPrefs::default().bounds());

        WindowPrefs {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            maximized,
        }
    }
}

fn monitor_area(monitor: &tauri::Monitor) -> MonitorArea {
    let work_area = monitor.work_area();
    MonitorArea {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
    }
}

/// Monitor work areas with the primary first (the sanitize fallback centers
/// there); the remaining monitors follow in the OS order.
fn monitor_areas(window: &WebviewWindow) -> Vec<MonitorArea> {
    let mut areas = Vec::new();
    if let Ok(Some(primary)) = window.primary_monitor() {
        areas.push(monitor_area(&primary));
    }
    if let Ok(monitors) = window.available_monitors() {
        for monitor in monitors {
            let area = monitor_area(&monitor);
            if !areas.contains(&area) {
                areas.push(area);
            }
        }
    }
    areas
}

/// Apply persisted geometry to the (hidden) main window, then show it.
///
/// Call from `setup`; the window is created with `visible: false` so the
/// default-sized rect never paints before the restored state is applied.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let session = app.state::<WindowSession>();
    session.begin_restore();

    let monitors = monitor_areas(&window);
    let prefs = state_path(app)
        .map(|path| load_prefs(&path))
        .unwrap_or_default();
    let prefs = sanitize_prefs(prefs, &monitors);
    session.seed(prefs.bounds(), prefs.maximized);

    let event_window = window.clone();
    let event_app = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            event_app.state::<WindowSession>().observe(&event_window);
        }
        WindowEvent::CloseRequested { .. } => {
            save_window_state(&event_app, &event_window);
        }
        _ => {}
    });

    // Physical units: outer position + inner (client) size, matching the
    // saved values, so a mixed-DPI setup restores exactly what was saved.
    if let Err(err) = window.set_size(PhysicalSize::new(prefs.width, prefs.height)) {
        eprintln!("tokentracker: window set_size failed: {err}");
    }
    if let Err(err) = window.set_position(PhysicalPosition::new(prefs.x, prefs.y)) {
        eprintln!("tokentracker: window set_position failed: {err}");
    }

    // Show first, then maximize. Maximizing a hidden Win32 window is
    // nondeterministic (observed: it sticks on one launch, not the next);
    // showing first makes the maximized state reliable. The window is still
    // positioned/sized before its first paint, so this does not flash a
    // default-sized frame.
    let shown = window.show();
    if shown.is_ok() && prefs.maximized {
        if let Err(err) = window.maximize() {
            eprintln!("tokentracker: window maximize failed: {err}");
        }
    }
    // The maximize transition can emit a monitor-sized Resized while
    // `is_maximized()` still reads false. Re-assert the pre-maximize bounds
    // and invalidate any commit scheduled by that transition.
    session.set_normal(prefs.bounds(), prefs.maximized);
    session.end_restore();
    if shown.is_ok() {
        let _ = window.set_focus();
    }
    shown
}

/// Snapshot the live window and persist it. Called from `CloseRequested` and
/// `RunEvent::ExitRequested`; deliberately never from resize/move events.
pub fn save_window_state(app: &AppHandle, window: &WebviewWindow) {
    let Some(path) = state_path(app) else {
        return;
    };
    let session = app.state::<WindowSession>();
    if session.lock().saved {
        return;
    }

    let prefs = session.snapshot(window);
    match save_prefs(&path, &prefs) {
        Ok(()) => session.lock().saved = true,
        Err(err) => eprintln!("tokentracker: window state save failed: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: i32, y: i32, width: u32, height: u32) -> MonitorArea {
        MonitorArea {
            x,
            y,
            width,
            height,
        }
    }

    fn prefs(x: i32, y: i32, width: u32, height: u32, maximized: bool) -> WindowPrefs {
        WindowPrefs {
            x,
            y,
            width,
            height,
            maximized,
        }
    }

    #[test]
    fn default_is_maximized_with_sane_windowed_size() {
        let default = WindowPrefs::default();
        assert_eq!(default.width, 1100);
        assert_eq!(default.height, 720);
        assert!(default.maximized);
    }

    #[test]
    fn sanitize_enforces_minimum_size() {
        let monitors = [monitor(0, 0, 1920, 1040)];
        let out = sanitize_prefs(prefs(100, 100, 640, 400, false), &monitors);
        assert_eq!(out.width, MIN_WIDTH);
        assert_eq!(out.height, MIN_HEIGHT);
        assert_eq!(out.x, 100);
        assert_eq!(out.y, 100);
        assert!(!out.maximized);
    }

    #[test]
    fn sanitize_shrinks_oversized_rect_to_work_area() {
        let monitors = [monitor(0, 0, 1920, 1040)];
        let out = sanitize_prefs(prefs(0, 0, 3000, 2000, false), &monitors);
        assert_eq!((out.width, out.height), (1920, 1040));
        assert_eq!((out.x, out.y), (0, 0));
    }

    #[test]
    fn sanitize_centers_off_screen_position_on_primary() {
        let monitors = [monitor(0, 0, 1920, 1040), monitor(1920, 0, 1080, 1040)];
        let out = sanitize_prefs(prefs(5000, 5000, 1100, 720, false), &monitors);
        // Primary (first) is 1920x1040: (1920-1100)/2, (1040-720)/2.
        assert_eq!((out.x, out.y), (410, 160));
        assert_eq!((out.width, out.height), (1100, 720));
    }

    #[test]
    fn sanitize_uses_monitor_with_most_overlap_and_clamps_into_it() {
        // Straddling the seam; 420px on the left screen, 980px on the right.
        let monitors = [monitor(0, 0, 1920, 1040), monitor(1920, 0, 1080, 1040)];
        let out = sanitize_prefs(prefs(1500, 100, 1400, 800, false), &monitors);
        assert_eq!(out.x, 1920);
        assert_eq!(out.y, 100);
        assert_eq!((out.width, out.height), (1080, 800));
    }

    #[test]
    fn sanitize_keeps_maximized_flag() {
        let monitors = [monitor(0, 0, 1920, 1040)];
        let out = sanitize_prefs(prefs(200, 200, 1000, 700, true), &monitors);
        assert!(out.maximized);
        assert_eq!((out.x, out.y), (200, 200));
    }

    #[test]
    fn max_state_survives_save_load_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "tokentracker-window-state-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join(STATE_FILE);
        let saved = prefs(304, 121, 1366, 768, true);

        save_prefs(&path, &saved).expect("save prefs");
        assert_eq!(load_prefs(&path), saved);

        // Overwriting an existing file must also succeed (rename replaces).
        let windowed = prefs(320, 140, 1200, 700, false);
        save_prefs(&path, &windowed).expect("overwrite prefs");
        assert_eq!(load_prefs(&path), windowed);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_or_corrupt_file_falls_back_to_default() {
        let dir = std::env::temp_dir().join(format!(
            "tokentracker-window-state-corrupt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join(STATE_FILE);
        assert_eq!(load_prefs(&path), WindowPrefs::default());

        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, b"{not json").unwrap();
        assert_eq!(load_prefs(&path), WindowPrefs::default());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sanitize_with_no_monitors_only_enforces_minimum() {
        let out = sanitize_prefs(prefs(10, 20, 300, 200, false), &[]);
        assert_eq!((out.x, out.y), (10, 20));
        assert_eq!((out.width, out.height), (MIN_WIDTH, MIN_HEIGHT));
    }
}
