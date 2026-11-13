# Antigravity Session Monitor

A lightweight, strictly read-only VS Code extension that monitors Antigravity (`Google.google-antigravity`) per-session context usage, subagent telemetry, and live 5-hour / weekly quota pools without patching host extensions or mutating local files.

## Features

- **Status Bar & Rich Hover Tooltip**: Shows the active workspace session (or a user-pinned session), live context window usage, token-volume cache savings (`C:XX%`), running indicator, and live 5h/weekly quota pools.
- **Subagent Rollup & Individual Inspection**: Rolls up child subagents' token usage, LLM calls, compactions, and running state onto the parent session while keeping each subagent inspectable individually.
- **QuickPick Session Inspector & Pinning**: Filter between `Current Workspace` and `All Workspaces`, expand parent/subagent hierarchies, inspect any session in the Bottom Panel, or pin a specific session to the Status Bar.
- **Lazy Bottom Panel**: Lives in the bottom panel container (`Antigravity Monitor`) alongside Terminal/Output and renders only when opened, featuring a quota header, collapsible session tree, detail breakdown, and inline SVG call-by-call context growth chart.
- **Cross-Platform & Remote-Ready**: Supports Linux, Windows, macOS, VS Code Remote-SSH, and WSL using read-only `node:sqlite` (with async `sqlite3` / `python3` fallback) and Connect-RPC queries to `agy --hub`.

## Commands

- `antigravityMonitor.openQuickPick`: Select or Pin Session
- `antigravityMonitor.openPanel`: Open Bottom Panel
- `antigravityMonitor.pinSession`: Pin Session to Status Bar
- `antigravityMonitor.unpinSession`: Unpin Session (Auto-Track)
- `antigravityMonitor.toggleScope`: Toggle Workspace Scope
- `antigravityMonitor.refresh`: Refresh Telemetry

## Settings

- `antigravityMonitor.refreshIntervalMs` (default `10000`)
- `antigravityMonitor.unfocusedRefreshIntervalMs` (default `30000`)
- `antigravityMonitor.contextWarningPct` (default `75`)
- `antigravityMonitor.contextCriticalPct` (default `90`)
- `antigravityMonitor.defaultScope` (`"current"` | `"all"`, default `"current"`)
- `antigravityMonitor.dataRootOverride` (default `""`)
