# Changelog

All notable changes to GravityWatch for Antigravity will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
