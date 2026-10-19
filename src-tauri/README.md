# tokentracker — Tauri 2 backend

Local-first token usage tracker. The Rust backend scans local AI-coding-agent
transcripts via `tokscale-core` and exposes aggregated snapshots to the
frontend through Tauri commands.

## Layout

- `src/main.rs` — binary entry, calls `tokentracker_lib::run()`
- `src/lib.rs` — Tauri `Builder`, `AppState`, commands:
  `cmd_scan`, `cmd_trip_start`, `cmd_trip_stop`, `cmd_check_update`
- `src/adapter.rs` — **only** file allowed to `use tokscale_core::*`.
  Maps tokscale types onto owned DTOs (`UsageSnapshotDTO`, `UnifiedRowDTO`,
  `DailyDTO`, `ModelRowDTO`, `SessionRowDTO`, `ProjectRowDTO`).
  Never reuse tokscale TUI types outside this file.
- `src/trips.rs` — trip windows (`TripConfig`, `filter_rows_for_trip`,
  `check_auto_stop`, baseline hooks). Works on DTOs only.
- `tauri.conf.json` — app identifier `com.tokentracker.app`, updater config.
- `capabilities/default.json` — Tauri 2 permission grants.

## Pin policy for tokscale-core

```toml
tokscale-core = { git = "https://github.com/junhoyeo/tokscale.git", tag = "v4.19.1" }
```

- Pinned to git **tag** `v4.19.1` (immutable). Never track `main`.
- Bump only by changing the `tag` in `src-tauri/Cargo.toml` and running
  `cargo update -p tokscale-core` + `cargo check`, then recording the new tag
  and `Cargo.lock` rev in the release notes.
- If the tag disappears upstream (force-push), pin to the full commit SHA
  (`rev = "<sha>"`) and file an issue.
- `cargo check` must resolve the dep. If the network blocks git fetch, keep the
  dep line as-is and document the failure in `ADAPTER_TODO.md` — do not vendor
  or copy tokscale sources into this repo.

## Updater

`tauri.conf.json → plugins.updater`:

- `active: true`, real minisign pubkey, stable channel, notify-only toast flow
  (see `src/updater.tsx`): auto-check on launch, manual check in
  Settings → Updates, download/install/restart all user-gated. Native
  updater dialog disabled (`dialog: false`) so toasts own the flow.
- `endpoints: ["https://github.com/SUMANTHXT900/tokentracker/releases/latest/download/latest.json"]`
- Windows `stableOnly: true`.

## Attribution

Parsing engine: [tokscale](https://github.com/junhoyeo/tokscale) —
Copyright 2025 Junho Yeo, MIT License. See `LICENSE-THIRD-PARTY` (or upstream
`LICENSE`) for the full text. This project links `tokscale-core` as a library
dependency; no tokscale code is vendored here.
