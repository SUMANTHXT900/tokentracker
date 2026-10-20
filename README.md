<div align="center">

# TokenTracker

**Know exactly what your AI agents cost you — down to the last token.**

Local-first desktop telemetry for AI coding-agent spend. No accounts. No cloud. No telemetry. Your logs never leave your machine.

[![Download](https://img.shields.io/badge/Download-Windows_Installer-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/SUMANTHXT900/tokentracker/releases/latest/download/tokentracker-setup-x64.exe)
<br />
![Windows](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

*Powered by [`tokscale-core`](https://github.com/junhoyeo/tokscale) — parsing engine by [Junho Yeo](https://github.com/junhoyeo). See [Attribution](#attribution).*

</div>

---

## Download

**Windows 10/11 64-bit** · Free · No account needed · Your logs never leave your PC

1. Click **Download** above — the latest installer downloads immediately. (No version hunting: the button always serves the newest release.)
2. Run it. Windows SmartScreen may ask on first install — click **More info → Run anyway**.
3. Launch TokenTracker — it picks up your existing agent logs automatically and starts tracking.

> Prefer to look first? Every version lives on the [latest release page](https://github.com/SUMANTHXT900/tokentracker/releases/latest), with the versioned `tokentracker_*_x64-setup.exe`, the `.msi` alternative, and full release notes. Prefer manual updates? The in-app updater (Settings → Updates) installs signed bundles on your click — nothing ever installs silently.

---

## What it does

Every AI coding session burns tokens — across OpenCode, Copilot, Codex, Gemini, and more — and that spend is invisible until the bill arrives. TokenTracker reads your agents' **local log files**, aggregates them with the battle-tested `tokscale-core` engine, and presents the truth in a calm, Apple-minimal cockpit:

| Screen | Answers |
|---|---|
| **Overview** | How much did I spend? Hero totals, multi-series token chart (Total / Input / Cache / Output), top models, activity heatmap — sliceable by client and date |
| **Usage** | What did *today* look like? Day / Week / Month deep dive with period-over-period comparison |
| **Sessions** | Which conversations cost the most? Searchable ledger; any row pops out into a full inspector card |
| **Projects** | Where does the spend live? Per-workspace tokens, cost, and model mix |
| **Models** | Which models drink the budget? Cache efficiency, reasoning, cost telemetry — rows pop out too |
| **Calendar** | Am I consistent? Coding-cadence heatmap |
| **Focus** | What did *this session* cost? Focus sessions with a live token ticker and auto-stop |
| **Share** | Flex it. Exportable PNG telemetry cards (1:1, 9:16, 16:9) |

Plus: a **collapsible sidebar**, live file-watching (numbers update the moment your agents write logs), cursor-following tooltips on every data cell, and **notify-only auto-updates** — stable channel, nothing installs without your click.

## Privacy architecture

- **100% local parsing** — SQLite and JSONL logs are read straight from disk. Your usage rows are never uploaded.
- **No accounts, no analytics, no phone-home.** The only network the app ever touches is: Google Fonts (display), live pricing tables, and the GitHub Releases endpoint for update checks.
- Updates install **only** on your explicit click, and every bundle is signature-verified before install.

### Network

TokenTracker makes a small, fixed set of outbound requests. None of them carry your usage data.

| Destination | Trigger | Data sent |
|---|---|---|
| `raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` (LiteLLM) | Automatic pricing refresh when the local catalog copy is older than 1 hour | Plain GET; no body, query, or user data |
| `openrouter.ai/api/v1/models` and `/models/{id}/endpoints` (OpenRouter) | Same pricing refresh; per-model calls walk the public model catalog | Plain GETs; model IDs come from OpenRouter's catalog, not your logs |
| `models.dev/api.json` | Same pricing refresh | Plain GET; no user data |
| `github.com/SUMANTHXT900/tokentracker/releases/latest/download/latest.json` | Once at launch, and when you click **Check for updates** | Plain GET; no version or query parameters; only the `tauri-plugin-updater/<version>` User-Agent |
| GitHub Releases asset URL from `latest.json` | Only when you click **Download** or **Install** | Request for the signed update bundle; no usage data |
| `fonts.googleapis.com`, `fonts.gstatic.com` | Window load, for the UI typefaces | Standard font CSS/WOFF2 GETs; no user data |

**Never sent:** prompts or message content, session titles, token counts, costs, model usage, workspace/project names, file paths, API keys/credentials, or any user identifier.

Pricing is cached on disk for 1 hour. At launch, if the cached catalog is older than that, it is refreshed automatically — no "refresh" click needed — so an online launch starts from data at most about an hour old, comfortably inside the 3-hour target. While the app stays open, a 3-hour timer refreshes the catalog in a short-lived helper process, swaps the rebuilt catalog into the running app, and refreshes the dashboard so costs are recalculated — no restart or "refresh" click needed. Offline, the last cached catalog (which may be older) is used instead of failing. Update checks are notify-only: nothing downloads, installs, or restarts without your click. During `npm run dev` only, a local Vite bridge on `localhost:1420` serves snapshot data to the browser; it is not part of the packaged app and never leaves the machine.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust backend, WebView2 frontend) |
| UI | React 18 + TypeScript + Tailwind CSS v4 + ECharts |
| Motion | Spring-physics micro-interactions, fully `prefers-reduced-motion` aware |
| Engine | `tokscale-core v4.19.1` (pinned) — local log parsing + LiteLLM cost math |
| Releases | GitHub Releases + signed Tauri updater (Windows) |

## Run it locally

**Prerequisites:** Node.js 20+, Rust stable, WebView2 (preinstalled on Windows 10/11).

```bash
npm install        # frontend deps
npm run dev        # Vite only — http://localhost:1420 (real local data via bridge)
npm run tauri dev  # full desktop app with file watcher + IPC
```

**Verify the engine:**

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # unit + real-home scan
npx tsc --noEmit   # frontend types
npm run build      # production bundle
```

## Releasing

Windows-only, stable channel, tag-driven:

```bash
# 1. Bump version in package.json + package-lock.json + tauri.conf.json + Cargo.toml (all four must match)
# 2. Commit, then:
git tag v0.1.0 && git push origin v0.1.0
```

Tag push triggers the `release` workflow: guard checks (no placeholder keys/endpoints, tag matches all four version files) → Windows build → signed artifacts → published GitHub Release with `latest.json`. Every release also uploads `tokentracker-setup-x64.exe` (a stable-name copy of the signed installer) so the README download button never needs a per-release edit. Every installed app offers the update on next launch — notify-only, always.

> The updater private key lives **outside this repo** (never committed — see `.gitignore`). Lose it and no future update will ever be trusted; leak it and anyone can ship "updates" your users trust. Back it up like a password.

## Attribution

TokenTracker's parsing and cost engine is [`tokscale-core`](https://github.com/junhoyeo/tokscale) by **Junho Yeo** (MIT) — used as a library for reading local agent logs and aggregating token/cost stats. Upstream TUI, submit, leaderboard, and telemetry modules are intentionally **not** used, keeping this app fully offline. Full license text in [`ATTRIBUTION.md`](./ATTRIBUTION.md).

All UI/UX, the Tauri shell, Focus sessions, share-card studio, and update pipeline are original to this project.

## License

MIT — see [`LICENSE`](./LICENSE).
