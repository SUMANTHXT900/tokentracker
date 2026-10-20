//! Real-filesystem smoke test: scans the actual $HOME with pinned tokscale-core.
//! Run: cargo test --test real_scan -- --nocapture
//! Asserts the priced async path works end-to-end (no panic, valid DTO).

use tokentracker_lib::adapter::parse_to_snapshot_async;

#[tokio::test]
async fn real_home_scan_smoke() {
    let snap = parse_to_snapshot_async(None, None, None, None, None)
        .await
        .expect("real scan should not error");
    println!(
        "REAL SCAN: rows={} daily={} models={} sessions={} projects={} total_tokens={} total_cost={:.2} clients={:?}",
        snap.rows.len(),
        snap.daily.len(),
        snap.models.len(),
        snap.sessions.len(),
        snap.projects.len(),
        snap.total_tokens,
        snap.total_cost,
        snap.clients,
    );
    // Totals must be internally consistent (same rows feed all rollups).
    let model_cost: f64 = snap.models.iter().map(|m| m.cost).sum();
    assert!(
        (model_cost - snap.total_cost).abs() < 0.02,
        "models sum {model_cost} vs total {}",
        snap.total_cost
    );
    let model_tokens: i64 = snap.models.iter().map(|m| m.tokens).sum();
    assert_eq!(model_tokens, snap.total_tokens);
}
