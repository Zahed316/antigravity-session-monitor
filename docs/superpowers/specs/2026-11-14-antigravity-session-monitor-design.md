# Antigravity Session Monitor — Design Specification

Date: 2026-11-14
Repository: `/home/zahedrastgar/Documents/_Projects/antigravity-session-monitor`

---

## 1. Intent & Why

Users running `Google.google-antigravity` inside VS Code currently have to combine multiple separate extensions to get an accurate picture of their sessions and quota:

- **`HarshMann.antigravity-telemetry`** reads local per-session SQLite databases (per-turn context growth, compactions, subagent trees) but has **no account quota visibility**, stalls the Extension Host with synchronous `execSync` calls to the `sqlite3` CLI without `-readonly`, wipes its cache on view focus, contains a `256000` -> `255000` ceiling overwrite bug, shows call-hit ratio instead of token-volume cache savings in the status bar, and runs Windows-only delete scripts.
- **`n2ns.antigravity-panel`** queries the local `agy --hub` RPC server for live 5-hour/weekly quota and active context tokens, but only tracks **one globally most-recent session** (ignoring the current VS Code workspace), places context inside an Activity Bar sidebar (which hides Antigravity itself when Antigravity is docked in the sidebar), omits context from the Status Bar, and points its disk path at `~/.gemini/antigravity-ide/` instead of `~/.gemini/antigravity/`.

**Goal:** Deliver a single, lightweight, strictly read-only, non-invasive VS Code extension that gives accurate **per-session status** (context window, rolled-up & individual subagent telemetry, token breakdown, cache savings, compactions) alongside **live 5-hour & weekly quota**, placed in the **VS Code Status Bar** (+ **Hover Tooltip** + **QuickPick** with session pinning) and a lazy **Bottom Panel** beside Terminal, across **Linux, Windows, macOS, and Remote-SSH / WSL** without modifying `Google.google-antigravity`.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
1. **Zero patching of host extensions:** Never modify `extension.js`, assets, or private storage of `Google.google-antigravity`; remain resilient across updates.
2. **Accurate workspace-scoped session tracking + pinning:** Automatically track the active session of the current VS Code workspace, while allowing users to **pin** any chosen session (main or subagent, current or any workspace) onto the Status Bar.
3. **Subagent rollup + drill-down:** Aggregate child subagents' token usage, calls, compactions, and `Running` state onto the parent session, while preserving the ability to expand and inspect every child subagent individually.
4. **Hybrid live + offline telemetry:** Combine `agy --hub` Connect-RPCs (live 5h/weekly quota pools, reset timers, live call context & token breakdown) with non-blocking, read-only local SQLite telemetry (`~/.gemini/antigravity/`).
5. **Two-layer lightweight UI:**
   - **Layer 1 (always active, near-zero overhead):** Compact Status Bar item(s), rich Markdown Hover Tooltip, and QuickPick session inspector/pinner.
   - **Layer 2 (lazy, zero webview memory until opened):** Compact Bottom Panel (`viewsContainers.panel`, alongside Terminal/Output).
6. **Cross-platform & Remote-first in v1:** Full support for Linux, Windows, macOS, VS Code Remote-SSH, and WSL.

### Non-Goals (Explicitly Excluded from v1)
- Deleting, recycling, or mutating conversations, brain artifacts, or cache directories on disk.
- Multi-day/14-day historical quota storage charts, complex regression forecasting, or account/sign-in management UI.
- Injecting HTML/DOM inside Antigravity's own isolated `#jetski-frame` webview or custom editor tabs.
- Heavy configuration surfaces or bloated analytics dashboards.

### Anti-Goals (Failure Conditions Even If Code Works)
- Synchronous child-process spawning (`execSync`) or full-DB re-parsing on every window/panel focus.
- Occupying the Activity Bar Sidebar as the primary detail view (hiding Antigravity's own sidebar when opened) or opening unsolicited Editor tabs.
- Misleading metrics: `255000` ceiling bugs, conflating call-hit ratio with token-volume cache savings, mislabeling `thinking`/`response` protobuf tags, misclassifying top-level sessions with `agent_name` as subagents, or summing separate context windows above 100%.

---

## 3. Verified Technical Constraints & Wire Contracts

All integration contracts below were verified directly against `Google.google-antigravity` v1.12.0, VS Code 1.146.0 (Node 24.22.1 / Electron 43.8.6), `~/.gemini/bin/agy`, a live `agy --hub`, and `~/.gemini/antigravity/`.

### 3.1 Antigravity UI Isolation & Extension Host Co-location
- `Google.google-antigravity` renders all conversations inside a single `<iframe id="jetski-frame">` (`antigravity.panel` sidebar WebviewView or at most one `"jetski-web.editor"` WebviewPanel titled `"Antigravity"`). Switching conversations does **not** create separate VS Code tabs or expose the active `cascadeId` via `vscode.window.tabGroups`.
- `vscode.extensions.getExtension("google.google-antigravity")?.exports` exposes `{ csrfToken, get port() }`.
- Because `google.google-antigravity` runs in the workspace Extension Host in Remote-SSH/WSL (and accessing `exports`, `127.0.0.1:<port>`, `~/.gemini/antigravity/`, and `state.vscdb` requires co-location), this extension sets `"extensionKind": ["workspace"]` in `package.json`.

### 3.2 `agy --hub` Connect-RPC Contracts
Base URL: `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>` (also supports `https://` with localhost self-signed cert fallback).
Headers: `Content-Type: application/json`, `Connect-Protocol-Version: 1`, `x-codeium-csrf-token: <csrfToken>`.
Common request metadata: `{ metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } }`.

1. **`RetrieveUserQuotaSummary`** (request: `{ metadata }`) -> `response.groups[]` (`displayName`, `buckets[]`):
   - `buckets[]` entries contain `bucketId` (`"gemini-5h"`, `"gemini-weekly"`, `"3p-5h"`, `"3p-weekly"`), `window` (`"5h" | "weekly"`), `remainingFraction` (0..1 float, omitted if proto3 zero!), `resetTime` (ISO UTC string).
2. **`GetUserStatus`** (fallback if `RetrieveUserQuotaSummary` returns no buckets; request: `{ metadata }`):
   - `userStatus.cascadeModelConfigData.clientModelConfigs[]`: `label`, `modelOrAlias.model`, `quotaInfo: { remainingFraction?, resetTime? }`.
   - **Proto3 zero/unlimited disambiguation:**
     - If `quotaInfo` has `resetTime` and `remainingFraction` is omitted (`undefined`) -> **`0%` exhausted**.
     - If `quotaInfo` has neither `remainingFraction` nor `resetTime` (e.g. `{}` for `Gemini 4 Carbon`) -> **unlimited / unquoted** (excluded from pool minimums).
     - If `resetTime <= now`, clamp remaining percentage to **`100%` (`Ready`)**.
   - Pool mapping when falling back to `clientModelConfigs`: group Gemini configs vs 3P (`Claude` / `GPT` / non-Google) configs and take minimum `remainingFraction` per pool.
3. **`GetAllCascadeTrajectories`** (request: `{ metadata }`) -> `trajectorySummaries` map (`cascadeId -> summary`):
   - Fields: `stepCount`, `lastModifiedTime`, `createdTime`, `trajectoryId`, `status` (`"CASCADE_RUN_STATUS_IDLE"` | `"CASCADE_RUN_STATUS_RUNNING"`), `trajectoryType` (`"CORTEX_TRAJECTORY_TYPE_CASCADE"` | `"CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION"`), `workspaces[]` (`workspaceFolderAbsoluteUri`, `gitRootAbsoluteUri`, `branchName`), `annotations`, `trajectoryMetadata`.
   - Note: Background `agy --hub` instances launched without `--add-dir` may return `{}` for `trajectorySummaries`; prefer the port from `google.google-antigravity.exports` or `--add-dir` processes matching the active workspace.
4. **`GetCascadeTrajectoryGeneratorMetadata`** (request: `{ metadata, cascadeId }`) -> `generatorMetadata[]`:
   - Entries contain `stepIndices`, `chatModel.usage` (`model`, `inputTokens` [fresh], `outputTokens`, `thinkingOutputTokens`, `responseOutputTokens`, `cacheReadTokens`, `apiProvider`), and `chatModel.chatStartMetadata` (`startStepIndex` [omitted until compacted], `contextWindowMetadata: { estimatedTokensUsed, maxContextTokens, tokenBreakdown }`).

### 3.3 Local SQLite & Protobuf Schemas (`~/.gemini/antigravity/`)
1. **`conversation_summaries.db`** (`conversation_summaries` table):
   - Columns used: `conversation_id`, `title`, `preview`, `step_count`, `last_modified_time`, `workspace_uris` (JSON string array), `status`, `parent_conversation_id`, `nesting_depth`, `agent_name`, `killed`, `not_fully_idle`, `last_user_input_time`, `raw_summary` (protobuf).
   - **Subagent rule (verified edge case):** Local data includes top-level chats (`parent_conversation_id == ""`, `nesting_depth == 0`) with non-empty `agent_name`. Subagents MUST be identified strictly by `parent_conversation_id !== "" || nesting_depth > 0` (and `raw_summary` path `Tag 17 -> Tag 8 -> Tag 2` provides optional subagent role text).
2. **`conversations/<id>.db`**:
   - **`gen_metadata (idx, data, size)`**: `data` protobuf has `Tag 1` = `chatModel` directly (sibling of `Tag 2` `stepIndices`, `Tag 4` `executionId`, `Tag 8` `plannerConfig` — not an outer wrapper). Inside `Tag 1`:
     - `Tag 19` (string): `modelName`.
     - `Tag 4` (`usage`, verified against `~/.gemini/bin/agy` descriptor): `Tag 2` = `input_tokens` (fresh), `Tag 3` = `output_tokens` (total output), `Tag 5` = `cache_read_tokens`, `Tag 9` = `thinking_output_tokens`, `Tag 10` = `response_output_tokens`.
     - `Tag 9` (`chatStartMetadata`): `Tag 2` = `startStepIndex` (`0xffffffffffffffff` = unset/uncompacted; positive step index once compacted), `Tag 10` = `contextWindowMetadata` (`Tag 1` = `rowContext`, `Tag 4` = `rowLimit`).
   - **`trajectory_metadata_blob (id='main', data)`**: used **only** as fallback workspace/title metadata if a live `.db` file appears in `conversations/` before being indexed in `conversation_summaries.db`.
   - **`parent_references (idx, data)`**: used only as fallback if `parent_conversation_id` is absent.
   - `steps` table is **not** queried in v1 (avoids full-table BLOB scans).
3. **VS Code Workspace `state.vscdb`**:
   - Resolved cleanly via `path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb')` (works identically across Linux, Windows, macOS, Remote-SSH, and WSL when a workspace is open).
   - Reads `ItemTable['google.google-antigravity']` JSON -> `lastConversationId` as an active-session affinity signal.

---

## 4. Decided Architecture & Behavior

### Decisions Agreed With the User
- **Project Location & Packaging:** Dedicated repository `/home/zahedrastgar/Documents/_Projects/antigravity-session-monitor`, TypeScript VS Code extension buildable to `.vsix`.
- **Target Platforms in v1:** Linux, Windows, macOS, and VS Code Remote-SSH / WSL.
- **Two-Layer UI Placement:** Always-on Status Bar (+ Hover Tooltip + QuickPick) and lazy Bottom Panel (`viewsContainers.panel` beside Terminal/Output).
- **Subagent Rollup + Separate View:** Roll up child subagent token consumption, calls, compactions, and `Running` state onto the parent session, AND allow expanding/selecting any child subagent in QuickPick and Bottom Panel to inspect it individually.
- **Status Bar Session Pinning:** Support auto-tracking by default, plus **pinning** any selected session (main or subagent) onto the Status Bar and unpinning back to `Auto`.
- **Read-Only & Lightweight Scope:** Zero disk delete/mutation features, zero heavy multi-day history storage, zero patching of host extensions.

### Architect/Builder Calls Made in This Spec (For User Review)
- **Extension Identity (`package.json` — My Call):** `publisher: "Zahed-r"`, `name: "antigravity-session-monitor"`, `"extensionKind": ["workspace"]`, `engines.vscode: "^1.99.0"` (or compatible fallback so `node:sqlite` runs natively on VS Code 1.146+/Node 24 while supporting older/other builds cleanly).
- **Cross-Platform SQLite Reader Hierarchy (My Call):**
  1. Primary: Built-in `node:sqlite` (`DatabaseSync(path, { readOnly: true })`) — zero deps, zero subprocess spawn, works on Linux/macOS/Windows/Remote.
  2. Fallback (if `node:sqlite` unavailable): Async `execFile` to resolved `sqlite3`/`sqlite3.exe` (`-readonly -json`, probing common install locations alongside `PATH`), then async `execFile` to verified Python (`python3`/`python` with `?mode=ro`, checking `--version` first to reject the Windows Store `WindowsApps\python3.exe` zero-byte alias). Never use `execSync`.
- **Cross-Platform `agy --hub` Fallback Discovery (My Call):**
  - Primary: `vscode.extensions.getExtension("google.google-antigravity")?.exports` (`port`, `csrfToken`).
  - Fallback process scanner: `ps -A -ww -o pid,ppid,args` on Linux/macOS; PowerShell `Get-CimInstance Win32_Process` on Windows; WSL host-IP probe if running inside WSL with no local `agy` process. Prioritizes processes whose `--add-dir` / `--workspace_id` matches the open workspace.
- **Incremental Caching (My Call):**
  - Cache parsed `gen_metadata` timelines in memory + `context.globalStorageUri` keyed by `(dbMtimeMs, dbSize, walMtimeMs, walSize, maxIdx)`. Never invalidate the whole cache on panel focus or window focus.
- **Trajectory Filtering & URI Matching (My Call):**
  - Exclude `CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION` from main session lists and active-session resolution.
  - Match workspace sessions via normalized URI path equality or descendant check (`sessionPath === wsPath || sessionPath.startsWith(wsPath + sep)` — case-insensitive on Windows drive letters).
- **Active Session Resolution Priority (My Call):**
  1. **Pinned session** (if user pinned a session ID and it still exists; shows unpin action if missing/deleted).
  2. Among workspace-scoped top-level sessions (`!isSubagent`, excluding `killed === 1` from `RUNNING` checks):
     - **Running** session (where the parent OR any non-killed descendant subagent has `status === 'CASCADE_RUN_STATUS_RUNNING'`, preferring live RPC state; ties broken by `lastConversationId` -> artifact UUID hint -> latest `lastModifiedTime`).
     - **`lastConversationId`** from workspace `state.vscdb` (or open Antigravity artifact tab `/brain/<uuid>/` / `?cascadeId=` hint if within workspace).
     - **Most recently modified** top-level session in the workspace.
  3. If the open workspace has zero sessions (or no workspace is open), display `"No workspace session"` in the Status Bar with one-click QuickPick access to all-workspace sessions.
- **Call Granularity, Context Window vs Token Rollup Semantics (My Call):**
  - **Unit label:** Each `gen_metadata` / `generatorMetadata` entry is an **LLM Call** (`N calls`), labeled explicitly as **Calls** on cards and chart X-axis.
  - **Context Window (`used / max %`) on Parent Sessions:** Because two subagents have separate context windows, the parent's **Context Window gauge** reflects the **parent's own latest-call window** (`usedContextTokens / maxContextTokens`, defaulting to `256_000` when `rowLimit` is absent — never `255_000`).
  - **Cumulative Rollup on Parent Sessions:** Cumulative token totals (`Fresh`, `Cache Read`, `Output = Thinking + Response`), `cacheVolumePct = totalCached / (totalFresh + totalCached)`, total calls, compaction counts, and `Running` indicator roll up **parent + all descendant subagents** (`Parent + N subagents` clearly noted in Tooltip and Detail Card). Selecting an individual subagent displays **that subagent's own** context window, cumulative tokens, calls, compactions, and SVG chart.
  - **RPC + SQLite Merge & Polling Scope:** Poll `GetAllCascadeTrajectories` once per cycle; poll `GetCascadeTrajectoryGeneratorMetadata` (memoized by `(cascadeId, stepCount)`) **only for the active/pinned/selected session and currently running workspace sessions** (never eagerly polling idle historical chats). Merge live RPC `generatorMetadata[]` over cached SQLite rows so in-flight calls and `tokenBreakdown` update immediately before WAL flush.
- **Exact Compaction Detection (My Call):**
  - Primary: `startStepIndex` transitions (`curr >= 0 && curr !== prev`) from RPC `chatStartMetadata.startStepIndex` or protobuf `tag9.2`, anchored at that LLM call index.
  - Fallback (only when `startStepIndex` is unavailable): drops in **`effectiveContext`** (`rowContext ?? (input_tokens + cache_read_tokens)`, never fresh `input_tokens` alone) where `prev > 0 && curr < prev - 10_000` and neither of the next 2 calls recovers to `>= prev * 0.85`.
- **UI Behavior Details (My Call):**
  - **Status Bar:** Two compact items:
    1. *Session Context Item* (click -> opens QuickPick): `$(pin)` if pinned, `$(sync~spin)` if parent or child subagent is running, short title, `used/max (pct%)`, `C:XX%` (token-volume cache); warning/error highlight at `>= 75%` / `>= 90%` context.
    2. *Quota Item* (click -> focuses/toggles Bottom Panel): `G XX% · C XX%` (5h pools), warning color when `<= 20%` or `0%`.
  - **Hover Tooltip:** Rich Markdown showing active/pinned mode, workspace scope, parent + subagent rollup vs individual view, model, latest context bar/numbers, cumulative token breakdown (`Fresh`, `Cache Read`, `Output = Thinking + Response`), `cacheVolumePct` + secondary call-hit ratio, calls & compactions, active/total subagents, and full 5h + weekly quota pools with reset timers.
  - **QuickPick:** Shows `Auto` / `Unpin` item (when pinned), workspace toggle (`Current Workspace` / `All Workspaces`), recursive parent + indented subagent items with status/context/calls/compactions, and item action buttons (`Pin to Status Bar`, `Open in Bottom Panel`). Clicking a row opens it in the Bottom Panel **without** changing Status Bar auto-tracking unless the user clicks Pin.
  - **Bottom Panel (`viewsContainers.panel`):** Lazy `WebviewView` with thin quota/filter header (`Current Workspace | All`, `Auto/Pinned` badge, refresh), collapsible parent->subagent tree on the left, and selected session/subagent detail card + inline SVG call-by-call context growth chart (with compaction markers and `Fresh` vs `Cache` visual breakdown) on the right.
- **Refresh Cadence & File Watching (My Call):**
  - Debounced `fs.watch` (`500ms`) on `~/.gemini/antigravity/` and `conversations/` (non-recursive watches for Linux compatibility), plus gentle RPC/fallback poll (`10s` while VS Code is focused, backing off to `30s` when unfocused; works cleanly even over Remote/WSL mounts).

---

## 5. What's Left to the Builder

- Source file layout, bundler choice (`esbuild` vs `tsc`), and test runner (`node:test` with VS Code API mocks).
- Exact VS Code contribution IDs (`commands`, `configuration` keys/defaults, `viewsContainers`, `views`), Codicon choices, and keybindings.
- Exact CSS layout, theme color tokens (`--vscode-*`), responsive panel sizing, and SVG chart rendering details inside the Bottom Panel webview.
- Retry/backoff and `http` vs `https` protocol-cache details for `agy --hub` connections and graceful offline/empty states.
