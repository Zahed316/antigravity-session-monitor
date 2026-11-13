# Antigravity Session Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-runtime-dependency, read-only TypeScript VS Code extension (`Zahed-r.antigravity-session-monitor`) showing accurate workspace-scoped per-session context, rolled-up & individual subagent telemetry, and live 5h/weekly quota in the Status Bar, Hover Tooltip, QuickPick, and a lazy Bottom Panel across Linux, Windows, macOS, and Remote-SSH/WSL.

**Architecture:** A hybrid local + live pipeline pairs built-in `node:sqlite` (`readOnly: true`, with async `sqlite3`/`python3` fallback) over `~/.gemini/antigravity/` and workspace `state.vscdb` with Connect-RPC queries to `agy --hub` (discovered via `google.google-antigravity` exports or cross-platform process inspection). Pure domain modules normalize quota, detect compactions via `startStepIndex`, roll up recursive subagent spend onto parents without summing separate context windows, and resolve the active/pinned session; thin VS Code UI controllers render the Status Bar, Tooltip, QuickPick, and lazy Bottom Panel `WebviewView`.

**Tech Stack:** TypeScript (strict, erasable syntax — `import type`, union types, no `enum` or constructor parameter properties so `node --test` executes `.ts` directly on Node 24+), `node:sqlite`, `esbuild`, `@vscode/vsce`, `node:test` + `node:assert/strict` with VS Code API mocks.

**Spec:** [`2026-11-14-antigravity-session-monitor-design.md`](file:///home/zahedrastgar/Documents/_Projects/antigravity-session-monitor/docs/superpowers/specs/2026-11-14-antigravity-session-monitor-design.md)

## Global Constraints

- **Zero host patching:** Never read-write or patch `Google.google-antigravity` files or mutate files in `~/.gemini/antigravity/`; all DB access is strictly read-only.
- **Zero runtime npm dependencies & pure-Node testability:** Only devDependencies (`typescript`, `@types/vscode`, `@types/node`, `esbuild`, `@vscode/vsce`); use built-in `node:sqlite` + Node stdlib (`http`, `https`, `fs`, `path`, `os`, `child_process`). Keep `src/types.ts`, `src/data/*`, `src/rpc/*`, `src/core/*`, `src/monitorService.ts`, and pure UI view-model/HTML modules free of top-level `import 'vscode'` (inject minimal VS Code callbacks/adapters from `src/extension.ts` or thin controller classes) so `node --test` runs every test file directly in Node 24 without `vscode` module-loader hacks.
- **Non-blocking I/O:** Never use `execSync` / `execFileSync`; async subprocess fallback only (`execFile`).
- **Accurate metrics:** Default `maxContextTokens = 256_000` (never `255_000`); primary cache metric is `cacheVolumePct = totalCached / (totalFresh + totalCached) * 100`; subagents identified strictly by `parent_conversation_id !== "" || nesting_depth > 0` (never `!agent_name`); exclude `CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION` from main session lists and active resolution; exclude `killed === 1` from `RUNNING` checks.
- **No UI bloat or hijacking:** No disk deletion commands; no Activity Bar Sidebar view; Bottom Panel lives in `viewsContainers.panel` and renders lazily only when visible; clicking a session inspects it in Bottom Panel without overwriting Status Bar auto-tracking unless explicitly pinned.

## Review Focus

1. **Empty/offline `agy --hub` or background `--hub` without `--add-dir`:** When `GetAllCascadeTrajectories` returns `{}` on a background port or `agy` is offline, the extension falls back to `exports` / `--add-dir` hub ports, keeps rendering local SQLite session status, and surfaces `"Quota offline"` without throwing or blanking the Status Bar.
2. **Missing `sqlite3` on GUI `PATH` & Windows Store `python3.exe` stub:** When `node:sqlite` is absent, fallback probes well-known `sqlite3` paths alongside `PATH` and checks `python3 --version` output/exit code so Windows `WindowsApps\python3.exe` stubs are rejected cleanly.
3. **Top-level sessions with `agent_name` & `killed = 1` stale `RUNNING` rows:** Top-level sessions (`parent_conversation_id === "" && nesting_depth === 0`) with non-empty `agent_name` remain top-level chats, and `killed === 1` rows never trigger the `RUNNING` spinner or Priority-1 active status.
4. **Proto3 omitted `remainingFraction` (`0%` vs `{}` unlimited) & expired `resetTime`:** `quotaInfo` / bucket with `resetTime` and missing `remainingFraction` reports `0%`; `quotaInfo: {}` (no `resetTime`, no `remainingFraction`) is ignored as unlimited; `resetTime <= now` clamps to `100%` (`Ready`).
5. **Deleted/missing pinned session & orphan subagents:** If a pinned `cascadeId` disappears from summaries/DBs, Status Bar displays an unpin/missing indicator with click-to-recover instead of crashing or going blank; orphan subagents (`nesting_depth > 0` whose parent is absent) surface cleanly under an `"Unattached Subagents"` group rather than disappearing.

---

## File Structure

| File | Responsibility |
| :--- | :--- |
| `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `.gitignore`, `.vscodeignore`, `LICENSE`, `README.md` | Extension manifest (`viewsContainers.panel`, commands, settings, `"extensionKind": ["workspace"]`), build & `.vsix` packaging config |
| `src/types.ts` | Shared domain types (`QuotaPool`, `QuotaSnapshot`, `CallUsagePoint`, `SessionSummary`, `SessionDetail`, `SessionTreeNode`, `ExtensionState`, `MonitorConfig`) |
| `src/data/protobuf.ts` | Zero-dep binary protobuf wire parser for `gen_metadata.data`, `raw_summary` role (`17->8->2`), and `trajectory_metadata_blob` fallback |
| `src/data/sqliteClient.ts` | Cross-platform read-only SQLite driver (`node:sqlite` primary + async `sqlite3`/`python3` fallback with Windows Store stub guard) |
| `src/data/localTelemetry.ts` | Incremental reader for `conversation_summaries.db`, `conversations/*.db`, and workspace `state.vscdb` (`lastConversationId`) with `(mtime, size, wal, maxIdx)` cache |
| `src/rpc/hubDiscovery.ts` | Port/CSRF discovery via `google.google-antigravity` `exports` + cross-platform process scanner (Linux/macOS `ps`, Windows PowerShell, WSL host IP) |
| `src/rpc/hubClient.ts` | Connect-RPC HTTP/HTTPS client + quota normalization (`RetrieveUserQuotaSummary`, `GetUserStatus`) & `(cascadeId, stepCount)`-memoized `GetCascadeTrajectoryGeneratorMetadata` |
| `src/core/compaction.ts` | Compaction detector (`startStepIndex` transitions + `effectiveContext` drop fallback with 2-call V-dip suppression) |
| `src/core/sessionTree.ts` | Recursive parent->subagent tree builder, RPC+SQLite merge, parent rollup (tokens/calls/compactions/`RUNNING`) + individual subagent isolation |
| `src/core/sessionResolver.ts` | Normalized URI prefix matcher, artifact editor UUID parser, and active/pinned session resolver |
| `src/ui/statusBar.ts` | Dual Status Bar view-model + Markdown hover tooltip builder + thin `StatusBarController` adapter |
| `src/ui/quickPick.ts` | Interactive QuickPick item builder + session/subagent pinner (`Pin`/`Open in Panel`, `Auto/Unpin`, `Current/All Workspace`) |
| `src/ui/bottomPanelHtml.ts` | CSP-safe HTML/CSS/SVG/JS template for the Bottom Panel (quota strip, collapsible tree, detail card, SVG call-growth chart with compaction markers) |
| `src/ui/bottomPanelProvider.ts` | Lazy Bottom Panel visibility/message controller (`BottomPanelController`) + `vscode.WebviewViewProvider` adapter |
| `src/monitorService.ts` | Pure-Node orchestrator combining `fs.watch` (500ms debounce, non-recursive), focus-aware polling (`10s`/`30s`), state snapshot emission, and disposal |
| `src/extension.ts` | Extension `activate()`/`deactivate()`, VS Code commands, workspace/tab listeners, and wiring |
| `test/*.test.ts` | Unit & integration tests per module runnable directly via `node --test` |

---

### Task 1: Project Scaffolding, Build Pipeline & Shared Types

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `.gitignore`, `.vscodeignore`, `LICENSE`, `README.md`
- Create: `src/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Produces: All exported domain types in `src/types.ts`: `PoolKey`, `QuotaPool`, `QuotaSnapshot`, `CallUsagePoint`, `TokenTotals`, `RawConversationSummary`, `RpcTrajectorySummary`, `RpcGeneratorCall`, `SessionNode`, `MonitorState`, `ScopeMode`, `MonitorConfig`.
- Produces: Build scripts (`npm run check`, `npm run build`, `npm test`, `npm run package`).

- [ ] **Step 1: Initialize `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `.gitignore`, `.vscodeignore`, `LICENSE`, and `README.md`**

Create `package.json` with `"name": "antigravity-session-monitor"`, `"displayName": "Antigravity Session Monitor"`, `"publisher": "Zahed-r"`, `"version": "0.1.0"`, `"license": "MIT"`, `"engines": { "vscode": "^1.99.0" }`, `"extensionKind": ["workspace"]`, `"main": "./dist/extension.js"`, `"activationEvents": ["onStartupFinished"]`, `"scripts": { "check": "tsc --noEmit", "build": "node esbuild.config.mjs", "test": "node --test test/*.test.ts", "package": "vsce package" }`, `contributes.viewsContainers.panel` (`id: "antigravity-monitor"`, title `"Antigravity Monitor"`), `contributes.views["antigravity-monitor"]` (`id: "antigravityMonitor.panel"`, type `"webview"`), `contributes.commands` (`antigravityMonitor.openQuickPick`, `antigravityMonitor.openPanel`, `antigravityMonitor.pinSession`, `antigravityMonitor.unpinSession`, `antigravityMonitor.toggleScope`, `antigravityMonitor.refresh`), and `contributes.configuration` (`antigravityMonitor.refreshIntervalMs` default `10000`, `antigravityMonitor.unfocusedRefreshIntervalMs` default `30000`, `antigravityMonitor.contextWarningPct` default `75`, `antigravityMonitor.contextCriticalPct` default `90`, `antigravityMonitor.defaultScope` `"current"` | `"all"` default `"current"`, `antigravityMonitor.dataRootOverride` default `""`). Add zero `dependencies`; devDependencies: `typescript`, `@types/node`, `@types/vscode`, `esbuild`, `@vscode/vsce`. Configure `tsconfig.json` (`strict: true`, `erasableSyntaxOnly: true`, `module: "Node16"`, `moduleResolution: "Node16"`, `target: "ES2023"`, `noEmit: true`) and `esbuild.config.mjs` (bundle `src/extension.ts` -> `dist/extension.js`, external `vscode`, `node:sqlite`, platform `node`, format `cjs`, `--watch` support).

- [ ] **Step 2: Write failing smoke test in `test/types.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_CONFIG } from '../src/types.ts';

test('default constants match spec constraints', () => {
  assert.equal(DEFAULT_CONTEXT_LIMIT, 256_000);
  assert.equal(DEFAULT_CONFIG.defaultScope, 'current');
  assert.equal(DEFAULT_CONFIG.refreshIntervalMs, 10_000);
  assert.equal(DEFAULT_CONFIG.unfocusedRefreshIntervalMs, 30_000);
  assert.equal(DEFAULT_CONFIG.contextWarningPct, 75);
  assert.equal(DEFAULT_CONFIG.contextCriticalPct, 90);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/types.test.ts`
Expected: FAIL with module not found (`../src/types.ts`).

- [ ] **Step 4: Implement `src/types.ts`**

Define `DEFAULT_CONTEXT_LIMIT = 256_000`, `DEFAULT_CONFIG`, and interfaces/type aliases for `PoolKey` (`'gemini' | 'nonGoogle'`), `QuotaPool`, `QuotaSnapshot`, `TokenTotals` (`fresh`, `cacheRead`, `output`, `thinking`, `response`, `calls`), `CallUsagePoint` (`idx`, `stepIndices`, `model`, `fresh`, `cacheRead`, `output`, `thinking`, `response`, `effectiveContext`, `contextLimit`, `startStepIndex`, `isCompacted`, `compactedFromStep`, `tokenBreakdownGroups?`), `RawConversationSummary`, `RpcTrajectorySummary`, `RpcGeneratorCall`, `SessionNode` (both `own` and `rolledUp` token/call/compaction/running stats, `contextUsed`, `contextLimit`, `contextPct`, `cacheVolumePct`, `callHitPct`, `children`, `isPinned`, `isActive`), `ScopeMode`, `MonitorConfig`, and `MonitorState`. Use `export type` and plain object/union types only (no `enum`).

- [ ] **Step 5: Install devDependencies and run verification**

Run: `npm install && npm run check && node --test test/types.test.ts`
Expected: Type check exits 0 and `test/types.test.ts` PASSES.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json esbuild.config.mjs .gitignore .vscodeignore LICENSE README.md src/types.ts test/types.test.ts package-lock.json
git commit -m "chore: scaffold TypeScript VS Code extension and shared domain types"
```

---

### Task 2: Binary Protobuf Wire Decoder (`src/data/protobuf.ts`)

**Files:**
- Create: `src/data/protobuf.ts`
- Test: `test/protobuf.test.ts`

**Interfaces:**
- Consumes: `CallUsagePoint`, `DEFAULT_CONTEXT_LIMIT` from `src/types.ts`.
- Produces:
  - `parseGenMetadataBlob(idx: number, buf: Uint8Array): CallUsagePoint | null`
  - `parseSubagentRoleFromSummary(rawSummary: Uint8Array): string`
  - `parseTrajectoryMetaBlob(buf: Uint8Array): { title?: string; workspaceUris: string[] }`

- [ ] **Step 1: Write failing tests in `test/protobuf.test.ts`**

Construct synthetic protobuf `Uint8Array` fixtures using a small wire-encoder helper inside the test file to verify:
1. `parseGenMetadataBlob`: extracts `Tag 1` (`chatModel` sibling of `Tag 2` stepIndices, `Tag 4` executionId): `Tag 19` model string, `Tag 4` usage (`2: fresh=10806`, `3: output=40`, `5: cacheRead=122736`, `9: thinking=22`, `10: response=18`), `Tag 9` (`2: startStepIndex=0xffffffffffffffff` -> `null` vs `2: startStepIndex=76` -> `76`, `10 -> { 1: rowContext=134225, 4: rowLimit=256000 }`).
2. `parseGenMetadataBlob` preserves `DEFAULT_CONTEXT_LIMIT` (`256_000`) when `Tag 9 -> Tag 10 -> Tag 4` (`rowLimit`) is absent (explicitly never returning `255_000`) and respects non-256k limits (e.g., `200_000` or `1_000_000`).
3. `parseGenMetadataBlob` falls back `effectiveContext` to `fresh + cacheRead` when `rowContext` is absent, and handles omitted `cacheRead` (`0`) and BigInt/64-bit `uint64` varints (`0xffffffffffffffff` sentinel) without precision crashes.
4. `parseSubagentRoleFromSummary` extracts `Tag 17 -> Tag 8 -> Tag 2` UTF-8 string and returns `""` on empty/malformed buffers without throwing.
5. `parseTrajectoryMetaBlob` extracts `file://` URIs / string paths from `trajectory_metadata_blob` safely.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/protobuf.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/data/protobuf.ts`**

Implement bounded varint/length-delimited/fixed64/fixed32 protobuf field scanner (using `BigInt` for varints to compare `0xffffffffffffffffn` accurately before converting safe integers via `Number`). Implement `parseGenMetadataBlob`, `parseSubagentRoleFromSummary`, and `parseTrajectoryMetaBlob` with defensive bounds checks so truncated or corrupted blobs return `null`/`""` without throwing.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run check && node --test test/protobuf.test.ts`
Expected: PASS (all 5 test cases).

- [ ] **Step 5: Commit**

```bash
git add src/data/protobuf.ts test/protobuf.test.ts
git commit -m "feat: add zero-dep protobuf parser for gen_metadata and summary blobs"
```

---

### Task 3: Cross-Platform Read-Only SQLite Client (`src/data/sqliteClient.ts`)

**Files:**
- Create: `src/data/sqliteClient.ts`
- Test: `test/sqliteClient.test.ts`

**Interfaces:**
- Produces:
  - `export type SqliteBackend = 'node:sqlite' | 'sqlite3-cli' | 'python3'`
  - `export interface SqliteClient { backend: SqliteBackend; queryAll<T>(dbPath: string, sql: string): Promise<T[]>; dispose(): void }`
  - `createSqliteClient(options?: { forceCliFallback?: boolean; sqlite3Path?: string; pythonCandidates?: string[]; execFileFn?: ExecFileLike }): Promise<SqliteClient>`
  - `resolveBinaryCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDir: string): { sqlite3: string[]; python: string[] }`

- [ ] **Step 1: Write failing tests in `test/sqliteClient.test.ts`**

Using a temporary directory (`os.tmpdir()`) with a real WAL-mode SQLite test DB created via `node:sqlite` (plus mock `execFileFn` for fallback tests):
1. Primary `node:sqlite` client reads rows and BLOBs (`Uint8Array`) from a WAL-mode DB strictly read-only (`queryAll` succeeds while DB has WAL; `INSERT` fails).
2. `resolveBinaryCandidates` includes Android SDK (`~/Android/Sdk/platform-tools/sqlite3`) and Homebrew paths on Linux/macOS and `.exe` paths on Windows.
3. Fallback selection when `forceCliFallback: true` + mock `execFileFn`: uses `sqlite3 -readonly -json` when probing `--version` succeeds; falls back to `python3` when `sqlite3` is missing; **rejects a simulated Windows Store `WindowsApps\python3.exe` stub** (exits 9009 / empty stdout or "Microsoft Store" stderr) and continues to valid `python`.
4. Returns `[]` or clear non-fatal error when DB file does not exist (`ENOENT`) without throwing unhandled exceptions.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sqliteClient.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/data/sqliteClient.ts`**

Use dynamic `createRequire` / `import('node:sqlite')` check for `DatabaseSync(dbPath, { readOnly: true })` (returning `Uint8Array` blobs directly; fallback to `sqlite:file:...?mode=ro&immutable=1` only if needed on read-only mounts). Implement async `execFile` fallback (`sqlite3 -readonly -json` returning hex-encoded blobs when wrapped in `hex(...)` SQL if CLI JSON doesn't preserve raw bytes, and inline Python stdlib `sqlite3` `?mode=ro` returning JSON with base64/hex blobs). Never call `execSync`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run check && node --test test/sqliteClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/sqliteClient.ts test/sqliteClient.test.ts
git commit -m "feat: add cross-platform read-only SQLite client with node:sqlite and async CLI/Python fallback"
```

---

### Task 4: Incremental Local Telemetry & `state.vscdb` Reader (`src/data/localTelemetry.ts`)

**Files:**
- Create: `src/data/localTelemetry.ts`
- Test: `test/localTelemetry.test.ts`

**Interfaces:**
- Consumes: `SqliteClient` (`src/data/sqliteClient.ts`), `parseGenMetadataBlob`, `parseSubagentRoleFromSummary`, `parseTrajectoryMetaBlob` (`src/data/protobuf.ts`), `RawConversationSummary`, `CallUsagePoint` (`src/types.ts`).
- Produces:
  - `export interface LocalSnapshot { summaries: RawConversationSummary[]; callsById: Map<string, CallUsagePoint[]>; lastConversationId: string | null }`
  - `export class LocalTelemetryReader { constructor(sqlite: SqliteClient, options: { antigravityRoot: string; cacheFilePath?: string; workspaceStateDbPath?: string }); async read(forceRescan?: boolean): Promise<LocalSnapshot>; clearMemoryCache(): void }`

- [ ] **Step 1: Write failing tests in `test/localTelemetry.test.ts`**

Create temporary fixture DBs matching the exact verified Antigravity schemas (`conversation_summaries`, `gen_metadata`, `trajectory_metadata_blob`, and `state.vscdb` `ItemTable`):
1. Reads `conversation_summaries` including `parent_conversation_id`, `nesting_depth`, `agent_name`, `killed`, `status`, `workspace_uris`, and `raw_summary` subagent role; discovers uncataloged `<uuid>.db` in `conversations/` via `trajectory_metadata_blob`.
2. Incremental `gen_metadata` caching: first `read()` parses rows `0..2`; second `read()` with unchanged `(mtime, size, wal)` performs **0** SQL queries on that `.db` (`queryAll` spy count unchanged); appending row `idx = 3` only queries `WHERE idx > 2`.
3. Persists cache to `cacheFilePath` and restores cleanly on a fresh `LocalTelemetryReader` instance without re-parsing unchanged DBs.
4. Reads `ItemTable['google.google-antigravity'].lastConversationId` from `state.vscdb` safely (returning `null` if missing or malformed JSON).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/localTelemetry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/data/localTelemetry.ts`**

Implement `stat` signature checking (`dbMtimeMs:dbSize:walMtimeMs:walSize`), incremental `SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC`, uncataloged `.db` discovery in `conversations/`, `state.vscdb` reader, and debounced JSON persistence to `cacheFilePath`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run check && node --test test/localTelemetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/localTelemetry.ts test/localTelemetry.test.ts
git commit -m "feat: add incremental local SQLite telemetry and state.vscdb reader"
```

---

### Task 5: Cross-Platform `agy --hub` Discovery & Connect-RPC Client (`src/rpc/hubDiscovery.ts`, `src/rpc/hubClient.ts`)

**Files:**
- Create: `src/rpc/hubDiscovery.ts`, `src/rpc/hubClient.ts`
- Test: `test/hubDiscovery.test.ts`, `test/hubClient.test.ts`

**Interfaces:**
- Consumes: `QuotaSnapshot`, `QuotaPool`, `RpcTrajectorySummary`, `RpcGeneratorCall`, `CallUsagePoint` (`src/types.ts`).
- Produces:
  - `hubDiscovery.ts`: `export interface HubEndpoint { port: number; csrfToken: string; host: string; source: 'exports' | 'process' | 'wsl-host' }`, `parseProcessCandidates(stdout: string, workspacePaths: string[]): HubEndpoint[]`, `discoverHubEndpoints(deps): Promise<HubEndpoint[]>`
  - `hubClient.ts`: `export class HubClient { async fetchQuota(endpoint: HubEndpoint, nowMs?: number): Promise<QuotaSnapshot>; async fetchTrajectories(endpoint: HubEndpoint): Promise<Map<string, RpcTrajectorySummary> | null>; async fetchGeneratorMetadata(endpoint: HubEndpoint, cascadeId: string, stepCount: number): Promise<CallUsagePoint[] | null> }`, `normalizeQuotaFromSummary(raw: unknown, nowMs?: number): QuotaSnapshot`, `normalizeQuotaFromUserStatus(raw: unknown, nowMs?: number): QuotaSnapshot`

- [ ] **Step 1: Write failing tests in `test/hubDiscovery.test.ts` and `test/hubClient.test.ts`**

`test/hubDiscovery.test.ts`:
1. Prefers `google.google-antigravity` `exports` (`{ port, csrfToken }`) first when valid (`port > 0`, non-empty `csrfToken`).
2. `parseProcessCandidates`: parses Linux/macOS `ps` lines and Windows `Get-CimInstance` JSON lines matching `agy`/`language_server`, supporting both `--hub-port` and `--extension_server_port`, `--app_data_dir=antigravity` (case-insensitive), and ranking `--add-dir` / `--workspace_id` matches ahead of bare background `--hub` processes without `--add-dir`.
3. Redacts nothing functionally in-memory while never logging tokens; handles WSL `/etc/resolv.conf` nameserver fallback candidate cleanly.

`test/hubClient.test.ts` (using a local `node:http` & self-signed `node:https` test server):
1. Calls `RetrieveUserQuotaSummary` with `Connect-Protocol-Version: 1` and `x-codeium-csrf-token`; falls back automatically from HTTP to self-signed HTTPS and caches protocol per `host:port`.
2. **Review Focus #1:** When candidate #1 returns `{}` for `GetAllCascadeTrajectories` (empty background hub) and candidate #2 returns trajectories, `fetchTrajectories` / caller detects empty map and falls through / merges cleanly; when offline (`ECONNREFUSED`), returns `null` / `{ status: 'offline' }` without throwing.
3. **Review Focus #4:** `normalizeQuotaFromSummary` & `normalizeQuotaFromUserStatus`:
   - `resetTime` present + `remainingFraction` omitted -> **`0%`** exhausted.
   - `quotaInfo: {}` (no `resetTime`, no `remainingFraction`, e.g. `Gemini 4 Carbon`) -> **ignored as unlimited** (does not drag pool down to `0%`).
   - `resetTime <= nowMs` -> clamped to **`100%`** (`Ready`).
4. `fetchGeneratorMetadata`: caches responses by `(cascadeId, stepCount)` (zero duplicate HTTP calls when `stepCount` is unchanged), maps `chatModel.usage` (`inputTokens`, `cacheReadTokens`, `outputTokens`, `thinkingOutputTokens`, `responseOutputTokens`) and `chatStartMetadata` (`startStepIndex`, `estimatedTokensUsed`, `maxContextTokens`, `tokenBreakdown`) into `CallUsagePoint[]` using `used = Math.max(estimatedTokensUsed, inputTokens + cacheReadTokens)`.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/hubDiscovery.test.ts test/hubClient.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/rpc/hubDiscovery.ts` and `src/rpc/hubClient.ts`**

Implement platform-aware process discovery (`ps` on POSIX, PowerShell `Get-CimInstance` on `win32`, `/etc/resolv.conf` WSL fallback) and Connect-RPC HTTP/HTTPS client with `4s` request timeout, protocol cache, `(cascadeId, stepCount)` LRU/Map memoization, and exact quota normalizers.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run check && node --test test/hubDiscovery.test.ts test/hubClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rpc/hubDiscovery.ts src/rpc/hubClient.ts test/hubDiscovery.test.ts test/hubClient.test.ts
git commit -m "feat: add cross-platform agy hub discovery and Connect-RPC quota/context client"
```

---

### Task 6: Compaction, Subagent Tree Rollup & Session Resolver (`src/core/compaction.ts`, `src/core/sessionTree.ts`, `src/core/sessionResolver.ts`)

**Files:**
- Create: `src/core/compaction.ts`, `src/core/sessionTree.ts`, `src/core/sessionResolver.ts`
- Test: `test/compaction.test.ts`, `test/sessionTree.test.ts`, `test/sessionResolver.test.ts`

**Interfaces:**
- Consumes: `CallUsagePoint`, `RawConversationSummary`, `RpcTrajectorySummary`, `SessionNode`, `ScopeMode`, `DEFAULT_CONTEXT_LIMIT` (`src/types.ts`).
- Produces:
  - `compaction.ts`: `annotateCompactions(calls: CallUsagePoint[]): { calls: CallUsagePoint[]; compactionCount: number }`
  - `sessionTree.ts`: `buildSessionTree(params: { summaries: RawConversationSummary[]; localCalls: Map<string, CallUsagePoint[]>; rpcSummaries?: Map<string, RpcTrajectorySummary> | null; rpcCalls?: Map<string, CallUsagePoint[]>; workspacePaths: string[] }): { roots: SessionNode[]; unattachedSubagents: SessionNode[]; byId: Map<string, SessionNode> }`
  - `sessionResolver.ts`: `normalizeFsPath(uriOrPath: string, platform?: NodeJS.Platform): string`, `isWorkspaceMatch(sessionUris: string[], workspacePaths: string[], platform?: NodeJS.Platform): boolean`, `extractArtifactCascadeId(uriString: string): string | null`, `resolveActiveSession(params: { roots: SessionNode[]; byId: Map<string, SessionNode>; pinnedId: string | null; scope: ScopeMode; lastConversationId: string | null; artifactHintId: string | null }): { active: SessionNode | null; pinMissing: boolean }`

- [ ] **Step 1: Write failing tests across `test/compaction.test.ts`, `test/sessionTree.test.ts`, `test/sessionResolver.test.ts`**

`test/compaction.test.ts`:
1. Primary signal: `startStepIndex` transitioning `[null, null, 76, 76, 120]` marks calls index `2` (`compactedFromStep: 76`) and index `4` (`compactedFromStep: 120`) with `compactionCount === 2`.
2. Fallback heuristic (when `startStepIndex` is `null` throughout): drop in `effectiveContext` `150k -> 60k` increments `compactionCount`; transient V-dip `150k -> 20k -> 140k` (recovering `>= 0.85 * 150k` within 2 calls) is suppressed (`0` compactions); fluctuations in fresh `input_tokens` alone never trigger false compactions when `effectiveContext` grows monotonically.

`test/sessionTree.test.ts`:
1. **Review Focus #3:** Top-level sessions with `agent_name !== ""` (`parent_conversation_id === "" && nesting_depth === 0`) remain top-level `roots`; subagents (`parent_conversation_id !== "" || nesting_depth > 0`) attach recursively (`depth 1`, `depth 2`).
2. **Parent Rollup vs Own Context:** Parent `rolledUp` sums `fresh`, `cacheRead`, `output`, `thinking`, `response`, `calls`, and `compactions` across parent + all recursive descendants, and marks `rolledUp.isRunning = true` if any non-killed descendant is `CASCADE_RUN_STATUS_RUNNING` — while `killed === 1` subagents/sessions NEVER set `isRunning = true`. Parent `contextUsed / contextLimit / contextPct` stays **parent-only** (never exceeding 100% by summing child context windows), and each child `SessionNode` keeps its own independent context/tokens/calls/chart points for separate inspection.
3. Excludes `CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION`.
4. **Review Focus #5 (Orphan subagents):** Subagents (`nesting_depth > 0`) whose `parent_conversation_id` is missing from `summaries` are placed in `unattachedSubagents` (and indexed in `byId`) rather than dropped.
5. `cacheVolumePct` equals `totalCached / (totalFresh + totalCached) * 100`, and RPC `generatorMetadata` overrides/appends over SQLite `gen_metadata` cleanly.

`test/sessionResolver.test.ts`:
1. `isWorkspaceMatch`: matches exact and descendant paths (`file:///home/u/proj` matches `/home/u/proj` and `/home/u/proj/sub`, handles Windows `file:///C:/Repo` vs `c:\repo` casing, rejects sibling `/home/u/proj2`).
2. `extractArtifactCascadeId`: extracts UUID from `file:///.../.gemini/antigravity/brain/<uuid>/task.md` and `jetski-artifact://.../?cascadeId=<uuid>`.
3. Priority order: Pinned session wins (even if idle or in another workspace); otherwise within current workspace `RUNNING` (parent or non-killed child) > `lastConversationId` > `artifactHintId` > newest `lastModifiedTime` > `null` (`"No workspace session"`).
4. **Review Focus #5 (Missing pin):** When `pinnedId` is absent from `byId`, returns `{ active: fallbackActive, pinMissing: true }` (or `active: null` if workspace empty) so UI clearly alerts and offers unpin.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/compaction.test.ts test/sessionTree.test.ts test/sessionResolver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `compaction.ts`, `sessionTree.ts`, `sessionResolver.ts`**

Write pure, side-effect-free TypeScript functions implementing the exact rules verified in Steps 1–2.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run check && node --test test/compaction.test.ts test/sessionTree.test.ts test/sessionResolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/compaction.ts src/core/sessionTree.ts src/core/sessionResolver.ts test/compaction.test.ts test/sessionTree.test.ts test/sessionResolver.test.ts
git commit -m "feat: add compaction detector, recursive subagent tree rollup, and workspace session resolver"
```

---

### Task 7: UI Controllers — Status Bar, Hover Tooltip, QuickPick & Lazy Bottom Panel (`src/ui/statusBar.ts`, `src/ui/quickPick.ts`, `src/ui/bottomPanelHtml.ts`, `src/ui/bottomPanelProvider.ts`)

**Files:**
- Create: `src/ui/statusBar.ts`, `src/ui/quickPick.ts`, `src/ui/bottomPanelHtml.ts`, `src/ui/bottomPanelProvider.ts`
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: `SessionNode`, `QuotaSnapshot`, `MonitorState`, `MonitorConfig`, `ScopeMode` (`src/types.ts`).
- Produces:
  - `statusBar.ts`: `formatCompactTokens(n: number): string`, `buildStatusBarViewModel(state: MonitorState, config: MonitorConfig): { contextText: string; contextColor: 'normal' | 'warning' | 'error'; quotaText: string; quotaColor: 'normal' | 'warning' | 'error'; tooltipMarkdown: string }`, `createStatusBarController(vscodeApi, onClickContextCmd, onClickQuotaCmd)`
  - `quickPick.ts`: `buildQuickPickItems(state: MonitorState): QuickPickEntry[]`, `showSessionQuickPick(vscodeApi, state: MonitorState, callbacks: { onInspect: (id: string) => void; onPin: (id: string) => void; onUnpin: () => void; onToggleScope: () => void }): Promise<void>`
  - `bottomPanelHtml.ts`: `renderBottomPanelHtml(state: MonitorState, nonce: string, cspSource: string): string`
  - `bottomPanelProvider.ts`: pure `BottomPanelController` (gating `setHtml`/`postMessage` on `visible` state and dispatching inbound messages) + thin `createBottomPanelProvider(vscodeApi, callbacks)` wrapper implementing `WebviewViewProvider`

- [ ] **Step 1: Write failing tests in `test/ui.test.ts`**

Test pure view-model, Markdown tooltip, QuickPick item builder, and Bottom Panel HTML/SVG renderer (plus mocked `WebviewViewLike` visibility gating on `BottomPanelController`):
1. `buildStatusBarViewModel`:
   - Active workspace session: includes `$(sync~spin)` when `rolledUp.isRunning`, `$(pin)` when pinned, truncated title, `used/max (pct%)`, `C:XX%` (`cacheVolumePct`), and `warning` at `>= 75%` / `error` at `>= 90%`.
   - When `pinMissing === true`: shows clear `$(pin) Missing — Click to unpin` warning state.
   - When `active === null`: shows `"No workspace session"` cleanly rather than an unrelated project.
   - Quota text shows `G XX% · C XX%` (5h pools), `"Quota offline"` when hub offline, and warning/error when `<= 20%` or `0%`.
   - Tooltip Markdown includes `Parent + N subagents` breakdown, `Fresh`, `Cache Read`, `Output (Thinking + Response)`, `cacheVolumePct`, `callHitPct`, `compactions`, and 5h + weekly reset countdowns.
2. `buildQuickPickItems`: includes `Unpin` item when pinned, `Scope: Current Workspace` / `All Workspaces` toggle, recursive indented child subagent items (`↳ [Role]`), and `Pin` / `Open in Panel` button metadata.
3. `renderBottomPanelHtml`: produces strict CSP (`nonce-${nonce}`), escapes HTML in conversation titles/agent names (XSS-safe), renders quota strip, collapsible parent->subagent tree, detail card, and inline `<svg>` call-growth chart with compaction markers (`compactedFromStep`) without external CDN scripts.
4. `BottomPanelController`: does **not** render HTML or post messages while `view.visible === false`; renders immediately upon visibility changing to `true`.

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/ui.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `statusBar.ts`, `quickPick.ts`, `bottomPanelHtml.ts`, `bottomPanelProvider.ts`**

Keep `statusBar.ts`, `quickPick.ts`, `bottomPanelHtml.ts`, and `BottomPanelController` free of top-level `import 'vscode'` (using minimal structural types + `import type * as vscode from 'vscode'`), update DOM smoothly via `postMessage` once initialized, and escape all untrusted session strings (`title`, `agentName`, `model`) in HTML and Markdown tooltip.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run check && node --test test/ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/statusBar.ts src/ui/quickPick.ts src/ui/bottomPanelHtml.ts src/ui/bottomPanelProvider.ts test/ui.test.ts
git commit -m "feat: add Status Bar, Hover Tooltip, QuickPick, and lazy Bottom Panel UI"
```

---

### Task 8: Orchestrator, Extension Wiring, Live Smoke Check & `.vsix` Package (`src/monitorService.ts`, `src/extension.ts`)

**Files:**
- Create: `src/monitorService.ts`, `src/extension.ts`
- Test: `test/monitorService.test.ts`

**Interfaces:**
- Consumes: `LocalTelemetryReader`, `discoverHubEndpoints`, `HubClient`, `buildSessionTree`, `resolveActiveSession`, `createStatusBarController`, `createBottomPanelProvider`, `showSessionQuickPick`.
- Produces:
  - `MonitorService` (pure-Node orchestrator receiving injected workspace paths, config, persistence callbacks, and `onDidUpdateState`: `start()`, `refreshNow()`, `pinSession(id)`, `unpinSession()`, `selectForPanel(id)`, `toggleScope()`, `setArtifactHint(id)`, `setWorkspacePaths(paths)`, `setWindowFocused(focused)`, `dispose()`)
  - `activate(context: vscode.ExtensionContext)` & `deactivate()` in `src/extension.ts`

- [ ] **Step 1: Write failing tests in `test/monitorService.test.ts`**

Using injected mock `LocalTelemetryReader`, `HubClient`, `discoverHubEndpoints`, and fake timer/watcher hooks:
1. Refreshes quota + `GetAllCascadeTrajectories` once per cycle, and calls `fetchGeneratorMetadata` **only** for `active`, `pinned`, `selectedForPanel`, and `RUNNING` workspace sessions (verifying idle historical sessions are NOT polled over RPC).
2. Clicking/selecting a session via `selectForPanel(id)` updates `selectedSessionId` for the Bottom Panel **without** altering `pinnedSessionId` or Status Bar auto-resolution; calling `pinSession(id)` pins Status Bar and persists to `workspaceState`; calling `unpinSession()` restores Auto tracking.
3. Focus change switches polling cadence (`10s` focused -> `30s` unfocused), serialized refresh prevents overlapping concurrent runs (`inFlight` coalesce), and `dispose()` clears watchers/timers cleanly.

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/monitorService.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/monitorService.ts` and `src/extension.ts`**

Keep `src/monitorService.ts` free of `import 'vscode'`, wiring `fs.watch` (two non-recursive watches on `~/.gemini/antigravity/` and `~/.gemini/antigravity/conversations/` with `500ms` debounce, safely tolerating missing directories before first Antigravity launch). In `src/extension.ts`, wire `vscode.window.onDidChangeWindowState`, `vscode.window.tabGroups.onDidChangeTabs` (artifact UUID hint), `vscode.workspace.onDidChangeWorkspaceFolders`, `vscode.workspace.onDidChangeConfiguration`, `antigravityMonitor.panel` `WebviewViewProvider`, and all 6 commands.

- [ ] **Step 4: Run full test suite, type check, bundle build, and `.vsix` package**

Run:
`npm run check`
`node --test test/*.test.ts`
`npm run build`
`npx vsce package`
Expected: Zero TypeScript errors, all unit/integration tests pass, `dist/extension.js` builds cleanly with zero runtime deps, and `antigravity-session-monitor-0.1.0.vsix` packages cleanly.

- [ ] **Step 5: Run read-only live integration smoke test against local `~/.gemini/antigravity/`**

Run a one-shot Node smoke command invoking `LocalTelemetryReader`, `discoverHubEndpoints`, `HubClient`, `buildSessionTree`, and `resolveActiveSession` read-only against the current machine's `~/.gemini/antigravity/` and running `agy --hub` (redacting any private text/tokens) to verify real data parses without errors (`0` exceptions, valid workspace session + 5h/weekly quota pools).

- [ ] **Step 6: Commit**

```bash
git add src/monitorService.ts src/extension.ts test/monitorService.test.ts
git commit -m "feat: wire MonitorService orchestrator and VS Code extension entry point"
```
