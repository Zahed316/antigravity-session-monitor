# Changelog

All notable changes to GravityWatch for Antigravity will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-11-26

### Fixed

- Quota now polls on `quotaRefreshIntervalMs` (x `quotaUnfocusedMultiplier` when unfocused, paused at `0`). Previously the setting was read but never used and quota only refreshed with the telemetry loop. A manual refresh always polls.
- With several Antigravity hubs running, a stale hub can no longer win: the snapshot whose buckets rolled most recently is selected instead of the first hub in process order, and the freshness rank no longer ties on a long shared weekly window.
- An explicit `remainingFraction: 0` is no longer clamped to 100% when its `resetTime` has passed, and an exhausted window no longer reads "Ready".
- The refresh button re-fetches and shows quota before the heavier session telemetry pass completes.
- When the hub is unreachable, the last good quota stays visible and is marked stale with a clock glyph, a tooltip line, and a panel note. Windows under 1% render as `<1%`.

## [0.1.4] - 2026-11-26

### Changed

- Quota model consolidated to two pools: `gemini` (Gemini + Argon) and `nonGoogle`. Removed the separate Argon pool, card, status bar segment and tooltip row.
- Quota estimator tracks per-session token deltas and buffers pending tokens between quota drops (`CALIBRATION_VERSION = 2`).

### Added

- Bottom panel tabs and sections are collapsible and drag-and-drop reorderable, with layout persisted in `globalState` (`antigravityMonitor.panelLayout.v1`).

## [0.1.3] - 2026-11-15

### Fixed

- Quota estimator calibration fix:
  - Per-session delta tracking on model switch.
  - Pending token accumulation between quota drops.
  - `CALIBRATION_VERSION = 2` cache reset.

## [0.1.2] - 2026-11-15

### Added

- Interactive `?` help buttons across bottom panel sections (Quota Pools, Model Forecasts, Sessions list, Session KPIs, Token Breakdown, Subagents, and Context Growth) offering plain-language explanations for metrics, token calibration, prompt caching, and quota pool dynamics.
- Next reset date and time display (`MMM DD, HH:MM`) for each quota pool in both bottom panel quota cards and status bar hover tooltips, presenting the exact upcoming reset timestamp alongside countdown timers.

## [0.1.1] - 2026-11-15

### Added

- GravityWatch branding, application logo icon (`logo.png`), and vector assets.
- VS Code Marketplace metadata, categories, repository links, and status badges.

### Changed

- Expanded README with complete settings documentation, command reference, and privacy architecture overview.

## [0.1.0] - 2025-11-14

### Added

- Status bar item for the active (or pinned) session with live context window usage, token-volume cache savings, running indicator, and a rich hover tooltip.
- QuickPick session inspector with `Current Workspace` / `All Workspaces` scoping, parent/subagent hierarchy expansion, and pinning a specific session to the status bar.
- Lazy bottom panel ("Antigravity Monitor") with quota header, collapsible session tree, detail breakdown, and an inline SVG call-by-call context growth chart.
- Subagent rollups: child token usage, LLM calls, compactions, and running state aggregated onto the parent session, with subagents still inspectable individually.
- 5-hour and weekly quota pool monitoring with model usage breakdowns.
- Quota refresh settings: `antigravityMonitor.quotaRefreshIntervalMs` and `antigravityMonitor.quotaUnfocusedMultiplier`, decoupled from local session telemetry polling.
- Read-only SQLite telemetry via `node:sqlite` (with async `sqlite3` / `python3` fallback): local Antigravity data is opened in read-only mode and never modified.

### Changed

- Skip no-op webview posts and gate hidden-panel work to avoid redundant UI updates.
