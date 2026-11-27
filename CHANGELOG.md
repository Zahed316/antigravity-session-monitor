# Changelog

All notable changes to GravityWatch for Antigravity will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-27

### Added

- **Accounts tab** in the bottom panel with four sections: Saved Accounts (search and group filter, label/group/color edit, Switch / Save Current / Re-auth / Remove), a Multi-Account Quota Matrix (5h and weekly remaining percentages per Account with reset times, and an explicit `Reset passed · stale` badge — never an optimistic 100% — for inactive Accounts whose reset time has passed), 30-Day Quota History & Backups (Export CSV/JSON, Export/Import Account metadata), and Runtime & Hub Diagnostics (editor, OS, keyring backend, Hub PID/port/source, Reconnect Hub, Restart Backend, Inspect Bridge).
- **Active Account header bar** on the Overview tab: email, plan, auth badge, and Switch / Save / Sign In actions. When the identity of the quota snapshot cannot be confirmed, the bar shows an explicit "Identity unknown" state instead of a possibly stale email.
- **12 new commands**: `switchAccount`, `saveCurrentAccount`, `addAccount`, `editAccountLabel`, `removeSavedAccount`, `exportAccounts`, `importAccounts`, `exportQuotaAnalytics`, `reconnectHub`, `restartBackend`, `inspectBridge`, and `clearTokenVault`.
- **QuickPick** gains a `Switch / Manage Accounts...` entry alongside Open Monitor Panel, Scope, and the session list.
- **Status bar** tooltip now shows the active Account email and plan, and the badge background tints warning/error when a quota pool falls to or below `antigravityMonitor.lowQuotaThresholdPct` (or hits 0%) while `antigravityMonitor.quotaAlertBackground` is enabled.
- Low-quota and exhausted-pool notifications with a one-click Switch Account call-to-action when another saved Account has cached quota remaining, plus optional quota-reset notifications.
- Five new settings: `enableLowQuotaAlerts`, `lowQuotaThresholdPct`, `notifyQuotaReset`, `quotaAlertBackground`, and `autoCaptureVault`.

### Security & Privacy

- Telemetry stays strictly local and read-only. Account switching is **opt-in** and uses locally captured official credentials from VS Code `SecretStorage` or the official Antigravity sign-in flow over the local loopback hub. There is **no Direct Google OAuth** flow: no OAuth loopback server, no direct Google token exchange.

### Changed

- Panel layouts persisted before this release keep their saved tab order; the new Accounts tab is appended automatically (never hidden).

## [0.1.9] - 2026-11-26

### Added

- A settings button (`⚙`) in the panel's top bar opens the VS Code settings filtered to this extension. Every setting stays native to VS Code, so there is one source of truth and no second validation layer.
- `GravityWatch: Reset Panel Layout` command restores the default tab and section order after dragging.

### Changed

- The reset is persisted immediately, so a reset survives a window reload.

## [0.1.8] - 2026-11-26

### Fixed

- Switching away to the terminal and back no longer repaints an old quota reading. Hiding the panel drops state updates, so the panel could show whatever the quota was when you left. It now fetches fresh quota when the view becomes visible.

### Changed

- Model Usage Forecast shows the 5 most-used models with a `More (N)` / `Less` toggle. It is ordered by calibration then token volume, not recency.
- List toggles are worded `More (N)` / `Less` everywhere; the Sessions and Unattached Subagents lists drop the older `Show all N` / `Show fewer` wording.
- A pinned or active entry is never hidden by a list cap.

## [0.1.7] - 2026-11-26

### Changed

- The Sessions and Unattached Subagents sections show the 5 most recently used entries, with a `Show all N` / `Show fewer` toggle. Both toggles are independent.
- Overview order now puts Sessions directly under the quota pools; Model Usage Forecast moves below it. An existing saved panel layout keeps its own order.

## [0.1.6] - 2026-11-26

### Fixed

- Quota is fetched at activation instead of waiting a full `quotaRefreshIntervalMs` for the first tick, so the status bar is populated immediately after a window reload.
- A quota poll landing while the heavier telemetry pass is in flight is no longer overwritten when that pass commits its state.

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
