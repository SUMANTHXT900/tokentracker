// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless pricing refresh helper used by the in-session 3-hour timer.
    // A fresh process is required because tokscale-core caches the pricing
    // service in a process-lifetime OnceCell; a new process re-checks the
    // 1-hour disk TTL, fetches if stale, and exits without creating a window.
    if std::env::args().any(|arg| arg == "--refresh-pricing") {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        if let Ok(runtime) = runtime {
            let _ = runtime.block_on(
                tokscale_core::pricing::PricingService::get_or_init(),
            );
        }
        return;
    }
    tokentracker_lib::run();
}
