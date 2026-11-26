<div align="center">

<img src="https://raw.githubusercontent.com/Zahed316/antigravity-session-monitor/main/logo.png" alt="GravityWatch logo: orbit rings around a cyan heartbeat pulse with an amber satellite dot, on a navy rounded square" width="160"/>

# GravityWatch for Antigravity

Read-only live status bar and bottom panel for Antigravity session context windows, subagent token rollups, and 5h/weekly quota pools.

[![Marketplace](https://img.shields.io/badge/VS_Code_Marketplace-v0.1.8-007ACC?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Zahed-r.antigravity-session-monitor)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Zahed316/antigravity-session-monitor/blob/main/LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/Zahed316/antigravity-session-monitor?style=flat)](https://github.com/Zahed316/antigravity-session-monitor/stargazers)

</div>

## Why this exists

Every Antigravity session burns context, and Antigravity gives you no built-in way to watch it fill up. Until now, checking meant manually opening Antigravity's local SQLite databases in a database browser, or relying on generic token counters that know nothing about subagent rollups or quota pools.

GravityWatch is a dedicated viewer for Antigravity internals:

- **Status bar + rich hover** for the active or pinned session: live context window usage, token-volume cache savings, running indicator, and live 5h/weekly quota pools.
- **Subagent rollups**: child subagent token usage, LLM calls, compactions, and running state roll up onto the parent session — while each subagent stays inspectable individually.
- **QuickPick session inspector** with workspace scoping, so you can pin any session to the status bar.
- **Lazy bottom panel** ("Antigravity Monitor") with a quota header, collapsible session tree, detail breakdown, and an inline SVG call-by-call context growth chart — rendered only when opened.

It is strictly read-only and 100% local: it never patches the host extension, never writes to Antigravity's data, and never sends anything anywhere.

## Install

From the VS Code Marketplace, search for **GravityWatch for Antigravity** (publisher `Zahed-r`), or install a packaged VSIX directly:

```sh
code --install-extension antigravity-session-monitor-0.1.8.vsix
```

Requires VS Code 1.99+.

## Commands

All commands live under the **Antigravity Monitor** category and are available from the Command Palette.

| Command ID | Title |
| --- | --- |
| `antigravityMonitor.openQuickPick` | Select or Pin Session |
| `antigravityMonitor.openPanel` | Open Bottom Panel |
| `antigravityMonitor.pinSession` | Pin Session to Status Bar |
| `antigravityMonitor.unpinSession` | Unpin Session (Auto-Track) |
| `antigravityMonitor.toggleScope` | Toggle Workspace Scope |
| `antigravityMonitor.refresh` | Refresh Telemetry |

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `antigravityMonitor.refreshIntervalMs` | number | `10000` | Telemetry and quota refresh interval in milliseconds while VS Code is focused. |
| `antigravityMonitor.unfocusedRefreshIntervalMs` | number | `30000` | Telemetry and quota refresh interval in milliseconds while VS Code is unfocused. |
| `antigravityMonitor.quotaRefreshIntervalMs` | number | `30000` | Interval (ms) for polling quota and model usage from the local Antigravity hub (minimum 5000ms). Decoupled from local session telemetry polling. |
| `antigravityMonitor.quotaUnfocusedMultiplier` | number | `2` | Multiplier applied to `quotaRefreshIntervalMs` while VS Code is unfocused (e.g., 2 = 2x slower; 0 pauses quota polling while unfocused). |
| `antigravityMonitor.autoFollowActiveSession` | boolean | `true` | Automatically switch the Details tab to follow the active Antigravity conversation when switching conversations. |
| `antigravityMonitor.contextWarningPct` | number | `75` | Context window usage percentage threshold for warning Status Bar highlight. |
| `antigravityMonitor.contextCriticalPct` | number | `90` | Context window usage percentage threshold for critical Status Bar highlight. |
| `antigravityMonitor.defaultScope` | string (`"current"` \| `"all"`) | `"current"` | Default session scope in QuickPick and the Bottom Panel. |
| `antigravityMonitor.dataRootOverride` | string | `""` | Optional override directory for Antigravity local data (defaults to `~/.gemini/antigravity`). |

## Privacy: how it works

- **Reads Antigravity's local SQLite databases read-only** (SQL `?mode=ro` / `immutable` connections, via `node:sqlite` with an async `sqlite3`/`python3` fallback). Nothing is ever written back.
- **Queries the local Antigravity hub**: quota and model usage come from Connect-RPC calls to your locally running `agy --hub` endpoint, auto-discovered on your machine.
- **Nothing leaves your machine.** GravityWatch collects no telemetry, makes no network calls of its own, and has no accounts or analytics.

## Status

**0.1.8 — experimental.** One maintainer, early days. Antigravity's data layouts are undocumented and may change between its releases, which can break parsing until GravityWatch catches up. File an issue if it does.

## Trademark

Not affiliated with or endorsed by Google. Antigravity is a product of Google.

## License

[MIT](LICENSE)
