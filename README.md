<div align="center">

# TokenTracker

**Know exactly what your AI agents cost you — down to the last token.**

Local-first desktop telemetry for AI coding-agent spend. No accounts. No cloud. No telemetry. Your logs never leave your machine.

![Windows](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

*Powered by [`tokscale-core`](https://github.com/junhoyeo/tokscale) — parsing engine by [Junho Yeo](https://github.com/junhoyeo). See [Attribution](#attribution).*

</div>

---

## Download

<a href="https://github.com/SUMANTHXT900/tokentracker/releases/latest">
  <img src="https://img.shields.io/badge/Download-Windows_Installer-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download TokenTracker for Windows" />
</a>

**Windows 10/11 64-bit** · Free · No account needed · Your logs never leave your PC

1. Click **Download** above — it opens the latest release page.
2. Download the `tokentracker_*_x64-setup.exe` installer.
3. Run it. Windows SmartScreen may ask on first install — click **More info → Run anyway**.
4. Launch TokenTracker — it picks up your existing agent logs automatically and starts tracking.

> Prefer manual updates? Every release also ships a signed bundle the in-app updater (Settings → Updates) installs on your click — nothing ever installs silently.

---

## What it does

Every AI coding session burns tokens — across OpenCode, Copilot, Codex, Gemini, and more — and that spend is invisible until the bill arrives. TokenTracker reads your agents' **local log files**, aggregates them with the battle-tested `tokscale-core` engine, and presents the truth in a calm, Apple-minimal cockpit:

| Screen | Answers |
|---|---|
| **Overview** | How much did I spend? Multi-series token chart (Total / Input / Cache / Output), top models, activity heatmap |
| **Usage** | What did *today* look like? Day / Week / Month deep dive with period-over-period comparison |
| **Sessions** | Which conversations cost the most? Searchable ledger with recency rails and inspectors |
| **Projects** | Where does the spend live? Per-workspace tokens, cost, and model mix |
| **Models** | Which models drink the budget? Cache efficiency, reasoning, cost telemetry |
| **Calendar** | Am I consistent? Coding-cadence heatmap |
| **Focus** | What did *this work block* cost? Trip-meter with live token ticker and auto-stop |
| **Share** | Flex it. Exportable PNG telemetry cards (1:1, 9:16, 16:9) |

Plus: a **collapsible sidebar**, live file-watching (numbers update the moment your agents write logs), and **notify-only auto-updates** — stable channel, nothing installs without your click.

## Privacy architecture

- **100% local parsing** — SQLite and JSONL logs are read straight from disk. Nothing ever leaves the machine.
- **No accounts, no analytics, no phone-home.** The only network the app ever touches is: Google Fonts (display), live pricing tables, and the GitHub Releases endpoint for update checks.
- Updates install **only** on your explicit click, and every bundle is signature-verified before install.

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
# 1. Bump version in package.json + tauri.conf.json + Cargo.toml (all three must match)
# 2. Commit, then:
git tag v0.1.0 && git push origin v0.1.0
```

Tag push triggers the `release` workflow: guard checks (no placeholder keys/endpoints) → Windows build → signed artifacts → published GitHub Release with `latest.json`. Every installed app offers the update on next launch — notify-only, always.

> The updater private key lives **outside this repo** (never committed — see `.gitignore`). Lose it and no future update will ever be trusted; leak it and anyone can ship "updates" your users trust. Back it up like a password.

## Attribution

TokenTracker's parsing and cost engine is [`tokscale-core`](https://github.com/junhoyeo/tokscale) by **Junho Yeo** (MIT) — used as a library for reading local agent logs and aggregating token/cost stats. Upstream TUI, submit, leaderboard, and telemetry modules are intentionally **not** used, keeping this app fully offline. Full license text in [`ATTRIBUTION.md`](./ATTRIBUTION.md).

All UI/UX, the Tauri shell, Focus metering, share-card studio, and update pipeline are original to this project.

## License

MIT — see [`LICENSE`](./LICENSE).
