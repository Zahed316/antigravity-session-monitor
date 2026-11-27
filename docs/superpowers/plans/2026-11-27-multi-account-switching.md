# GravityWatch Multi-Account Monitoring & Opt-In Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `Model Usage Forecast` (`QuotaEstimator` + `forecast` UI) while keeping `sessions`, and add cross-platform multi-account identity, quota matrix, 30-day history/export, actionable quota alerts, hub diagnostics, and opt-in safe account switching without Direct Google OAuth or `sql.js`.

**Architecture:** Extend GravityWatch's existing `HubDiscovery` / `HubClient` / `MonitorService` pipeline with per-account isolation (`Account` keyed by normalized Google `email`), dedicated stores and services under `src/accounts/`, and unified UI integration inside the existing Status Bar, QuickPick, `Overview` header, and a new `Accounts` tab in the Bottom Panel. All telemetry remains read-only; credential capture (`vscode.SecretStorage` + OS keyring adapters) and targeted `state.vscdb` updates (`node:sqlite`/`sqlite3`/`python3`) occur only on official sign-in capture or explicit user-confirmed switching.

**Tech Stack:** TypeScript (`strict: true`), `node:test` + `node:assert/strict`, VS Code Extension API (`^1.99.0`), `esbuild`, native `node:sqlite` / `sqlite3` / `python3`, Connect-RPC over loopback HTTP/HTTPS.

**Spec:** [`docs/superpowers/specs/2026-11-27-multi-account-switching-design.md`](../specs/2026-11-27-multi-account-switching-design.md), [`GLOSSARY.md`](../../../GLOSSARY.md), [`ADR 0002`](../../adr/0002-opt-in-credential-vault-and-no-direct-oauth.md).

## Global Constraints

- Zero runtime npm dependencies (`package.json` `"dependencies"` remains empty/absent — do NOT add `sql.js`).
- Do NOT implement Direct Google OAuth (`OAuthService`), silent `autoRoundRobin`, Webview `AudioContext` chimes, or proxy settings.
- Keep `sessions`, `unattached`, and `details` session/subagent telemetry intact; never add a new Activity Bar container.
- Cross-platform (`linux`, `win32`, `darwin`, plus read-only compatibility in `wsl`): never throw on missing OS keyring CLI (`secret-tool`); fall back cleanly to official `Login` / `AuthLogout`.
- Preserve injectable `deps` patterns across all services (`fs`, `execFileAsync`, `timerFactory`, `now`, `secrets`, `globalState`).
- Verify `npm run check` and `npm test` (`node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/*.test.ts`) pass at the end of every task.

## Review Focus

1. **Cross-account `lastGoodQuota` bleed:** Switching from Account A (`85%`) to Account B while hubs are momentarily offline must NOT serve Account A's cached quota under Account B. (Task 8.)
2. **Expired inactive account snapshots:** An inactive account whose `resetTime` is in the past (`resetTime <= nowMs`) must render `stale` / `Reset passed`, never `100%`. (Task 3, Task 9.)
3. **Linux/headless host without `secret-tool`:** Missing OS keyring tooling must report `keyringSupported: false` and degrade gracefully to official `Login` / `AuthLogout` without crashing. (Task 6, Task 7.)
4. **Mismatched/corrupt vault credentials:** A credential whose JWT `id_token` or protobuf email differs from the target account email must be purged, marked `needs_reauth`, and never written to `state.vscdb` or OS keyring. (Task 6, Task 7.)
5. **Active account deletion & Standalone switch safety:** Deleting the active account must be blocked until signed out (Task 3), and Standalone IDE switching must abort before modifying `state.vscdb` if `.bak` creation fails or WAL files do not clear (Task 7).

---

### Task 1: Remove `Model Usage Forecast` & Fix Pre-Existing Date-Sensitive UI Test

**Files:**
- Delete: `src/core/quotaEstimator.ts`, `test/quotaEstimator.test.ts`
- Modify: `src/types.ts`, `src/monitorService.ts`, `src/extension.ts`, `src/ui/statusBar.ts`, `src/ui/quickPick.ts`, `src/ui/bottomPanelProvider.ts`, `src/ui/bottomPanelHtml.ts`, `test/ui.test.ts`, `test/monitorService.test.ts`

**Interfaces:**
- Removes: `WindowTokenEstimate`, `ModelTokenEstimate`, `QuotaEstimator`, `MonitorState.modelEstimates`, `MonitorServiceDeps.quotaCalibrationPath`, `OverviewSectionId` `'forecast'`, `formatWindowEstimateBrief`, `renderModelForecastSection`.
- Preserves: `OverviewSectionId = 'quota' | 'sessions' | 'unattached'`, `DEFAULT_OVERVIEW_SECTIONS = ['quota', 'sessions', 'unattached']`.

- [ ] **Step 1: Update failing/obsolete assertions in `test/ui.test.ts` (including fixing line 349 relative `fetchedAt`)**
  - Replace hardcoded `new Date('2026-11-26T10:00:00Z').getTime()` at `test/ui.test.ts:349` with `Date.now() - 3_600_000` so the `<12h` `toLocaleTimeString()` stale check is date-independent.
  - Remove `ModelTokenEstimate`, `manyEstimates`, `model-forecast` help assertions, and `'forecast'` assertions from `overview` section ordering/reordering tests in `test/ui.test.ts`; assert `Overview` renders `quota`, `sessions`, and `unattached` without `'forecast'`.

- [ ] **Step 2: Run UI tests to verify forecast references fail before code removal**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/ui.test.ts`
  - Expected: FAIL on `Overview` default sections containing `'forecast'`.

- [ ] **Step 3: Remove `forecast` and `QuotaEstimator` cleanly across `src/`**
  - Delete `src/core/quotaEstimator.ts` and `test/quotaEstimator.test.ts`.
  - Remove `WindowTokenEstimate`, `ModelTokenEstimate`, `MonitorState.modelEstimates`, and `'forecast'` from `OverviewSectionId` in `src/types.ts`.
  - Remove `quotaEstimator` / `quotaCalibrationPath` from `src/monitorService.ts` and `src/extension.ts`.
  - Remove `formatWindowEstimateBrief` and forecast tooltip lines from `src/ui/statusBar.ts`.
  - Update `openPanel` description in `src/ui/quickPick.ts` to `'Overview, subagents & context charts'`.
  - Remove `'forecast'` from `DEFAULT_OVERVIEW_SECTIONS`, `toggleListExpand`, `SECTION_HELP['model-forecast']`, `formatEstimateCell`, `renderModelForecastSection`, and `overviewSectionMap` in `src/ui/bottomPanelProvider.ts` and `src/ui/bottomPanelHtml.ts`.

- [ ] **Step 4: Run full typecheck and test suite**
  - Run: `npm run check && npm test`
  - Expected: `tsc --noEmit` exits `0` and all remaining tests pass (`0` failures).

- [ ] **Step 5: Commit**
  - `git add -A && git commit -m "refactor: remove Model Usage Forecast and fix stale timestamp test"`

---

### Task 2: Account Identity Extraction, `daemon/hub_<port>.json` Discovery & Official Auth RPCs

**Files:**
- Modify: `src/types.ts`, `src/rpc/hubDiscovery.ts`, `src/rpc/hubClient.ts`
- Create: `src/rpc/hubAuth.ts`
- Modify: `test/hubDiscovery.test.ts`, `test/hubClient.test.ts`
- Create: `test/hubAuth.test.ts`

**Interfaces:**
- Produces in `src/types.ts`:
  - `export interface AccountIdentity { email: string; displayName?: string; tier?: string; plan?: string; isPro?: boolean; profilePictureUrl?: string; }`
  - `HubEndpoint`: add optional `pid?: number; httpsPort?: number;` and extend `source` union to `'exports' | 'process' | 'wsl-host' | 'daemon-file'`.
- Produces in `src/rpc/hubDiscovery.ts`:
  - `discoverHubEndpoints(deps?: HubDiscoveryDeps)` checks `daemon/hub_*.json` (`antigravityRoot/daemon`, `~/.gemini/antigravity/daemon`, `~/.gemini/daemon`) for `{ csrfToken, httpsPort, httpPort, pid }`.
- Produces in `src/rpc/hubClient.ts`:
  - `export function extractUserIdentityFromUserStatus(raw: unknown): AccountIdentity | null`
  - `HubClient.fetchUserIdentity(endpoint: HubEndpoint): Promise<AccountIdentity | null>`
- Produces in `src/rpc/hubAuth.ts`:
  - `export class HubAuthClient` with `getAuthStatus(endpoint)`, `login(endpoint, vscodeExecCommand?)`, `logout(endpoint)`, `syncOfficialUi(vscodeApi)`, `restartBackendProcess(pid, execFileAsync?)`.

- [ ] **Step 1: Write failing tests for identity extraction, `daemon/hub_*.json` discovery, and auth RPCs**
  - In `test/hubClient.test.ts`: test `extractUserIdentityFromUserStatus` for `email` normalization, `g1Tier` / `plan` formatting (`ULTRA` -> `Google AI Ultra`, `PRO` / `pro: true` -> `Google AI Pro`, `FREE` -> `Google AI Free`), `profilePictureUrl` aliases, and `null` when `email` missing.
  - In `test/hubDiscovery.test.ts`: test `discoverHubEndpoints` reading mocked `daemon/hub_42100.json` (`{ csrfToken, httpsPort, httpPort, pid }`) and deduplicating against process endpoints.
  - In `test/hubAuth.test.ts`: test `Login` RPC fallback to `antigravity.login` on `"only supported in antigravity-hub mode"`, `AuthLogout`, and `syncOfficialUi` trying `antigravity.handleAuthRefresh` -> `antigravity.reconnect` -> `antigravity.triggerUpdate` -> `antigravity.connectHub`.

- [ ] **Step 2: Run tests to verify failure**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/hubDiscovery.test.ts test/hubClient.test.ts test/hubAuth.test.ts`
  - Expected: FAIL with missing functions/exports.

- [ ] **Step 3: Implement `AccountIdentity`, daemon JSON discovery, and `HubAuthClient`**
  - Update `src/types.ts`, `src/rpc/hubDiscovery.ts` (injectable `readdir` / `stat` / `readFile` / `antigravityRoot` on `HubDiscoveryDeps`), `src/rpc/hubClient.ts`, and create `src/rpc/hubAuth.ts`.

- [ ] **Step 4: Run typecheck and tests**
  - Run: `npm run check && node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/hubDiscovery.test.ts test/hubClient.test.ts test/hubAuth.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add src/types.ts src/rpc/ test/hubDiscovery.test.ts test/hubClient.test.ts test/hubAuth.test.ts && git commit -m "feat(rpc): extract user identity, add daemon hub JSON discovery and auth RPC client"`

---

### Task 3: `AccountStore` (Registry, Per-Account Stale Snapshots & Metadata Backup)

**Files:**
- Create: `src/accounts/accountStore.ts`, `test/accountStore.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces in `src/types.ts` & `src/accounts/accountStore.ts`:
  - `export type AccountAuthStatus = 'active' | 'saved' | 'needs_reauth';`
  - `export interface ManagedAccount extends AccountIdentity { label?: string; group?: string; colorTag?: string; firstSeenAt: string; lastSeenAt: string; status: AccountAuthStatus; }`
  - `export interface AccountSnapshotRecord { email: string; snapshot: QuotaSnapshot; updatedAt: number; }`
  - `export class AccountStore`:
    - `async load(): Promise<void>`
    - `upsertSeenAccount(identity: AccountIdentity, isActive: boolean, nowIso?: string): Promise<ManagedAccount>`
    - `updateMetadata(email: string, patch: { label?: string; group?: string; colorTag?: string }): Promise<ManagedAccount | null>`
    - `setStatus(email: string, status: AccountAuthStatus): Promise<void>`
    - `removeAccount(email: string, activeEmail: string | null): Promise<{ removed: boolean; reason?: 'active_account' | 'not_found' }>`
    - `saveSnapshot(email: string, snapshot: QuotaSnapshot): Promise<void>`
    - `getSnapshot(email: string, isActive: boolean, nowMs?: number): QuotaSnapshot | null` (marks inactive windows with `resetTime <= nowMs` as `isStale: true` while keeping last known `remainingPct`, never clamping to `100%`)
    - `listAccounts(): ManagedAccount[]`
    - `exportBackupJson(): string` (`schema: "gravitywatch.accounts.backup.v1"`, metadata only, zero secrets)
    - `importBackupJson(rawJson: string): Promise<{ imported: number; skipped: number }>`

- [ ] **Step 1: Write failing tests in `test/accountStore.test.ts`**
  - Test upserting accounts with normalized emails, updating `label`/`group`/`colorTag`, and blocking `removeAccount` when `email === activeEmail` (`reason: 'active_account'`).
  - Test `getSnapshot(email, false, nowMs)` when `resetTime` is in the past: returns `isStale: true` and preserves last recorded `remainingPct` (asserts it does NOT become `100%`).
  - Test `exportBackupJson` -> `importBackupJson` round-trip and assert exported JSON contains zero credential/token fields.

- [ ] **Step 2: Run test to verify failure**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/accountStore.test.ts`
  - Expected: FAIL (`accountStore.ts` missing).

- [ ] **Step 3: Implement `AccountStore` in `src/accounts/accountStore.ts`**
  - Persist account registry via injected `globalState` adapter (`antigravityMonitor.accounts.v1`) and snapshot map via atomic temp+rename JSON file in `globalStorageUri/account-snapshots.json`.

- [ ] **Step 4: Run typecheck and tests**
  - Run: `npm run check && node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/accountStore.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add src/types.ts src/accounts/accountStore.ts test/accountStore.test.ts && git commit -m "feat(accounts): add AccountStore with stale-past-reset snapshots and metadata backups"`

---

### Task 4: `QuotaHistoryStore` (30-Day Per-Account/Pool History & CSV/JSON Export)

**Files:**
- Create: `src/accounts/quotaHistoryStore.ts`, `test/quotaHistoryStore.test.ts`

**Interfaces:**
- Produces in `src/accounts/quotaHistoryStore.ts`:
  - `export interface DailyPoolQuotaRecord { date: string; email: string; poolKey: PoolKey; fiveHourLowestPct: number | null; weeklyLowestPct: number | null; updatedAt: number; }`
  - `export class QuotaHistoryStore`:
    - `constructor(storagePath: string)`
    - `async load(): Promise<void>`
    - `async recordSnapshot(email: string, snapshot: QuotaSnapshot, nowMs?: number): Promise<void>` (records lowest daily `%` per `gemini`/`nonGoogle` pool, prunes entries older than `30` days, skips stale/offline snapshots)
    - `getHistory(options?: { email?: string; days?: number; nowMs?: number }): DailyPoolQuotaRecord[]`
    - `exportCsv(accounts: ReadonlyMap<string, ManagedAccount>, days?: number, nowMs?: number): string`
    - `exportJson(accounts: ReadonlyMap<string, ManagedAccount>, days?: number, nowMs?: number): string`
    - `async flush(): Promise<void>`

- [ ] **Step 1: Write failing tests in `test/quotaHistoryStore.test.ts`**
  - Test daily minimum aggregation across multiple polls on the same UTC date for `gemini` and `nonGoogle`.
  - Test skipping `isStale: true` / `status !== 'online'` snapshots.
  - Test pruning records older than 30 days.
  - Test `exportCsv` (header + CSV quote escaping on `label`/`group`) and `exportJson` (`schema: "gravitywatch.analytics.v1"`).

- [ ] **Step 2: Run test to verify failure**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/quotaHistoryStore.test.ts`
  - Expected: FAIL (`quotaHistoryStore.ts` missing).

- [ ] **Step 3: Implement `QuotaHistoryStore` in `src/accounts/quotaHistoryStore.ts`**
  - Persist atomically to `globalStorageUri/quota-history.json`.

- [ ] **Step 4: Run typecheck and tests**
  - Run: `npm run check && node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/quotaHistoryStore.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add src/accounts/quotaHistoryStore.ts test/quotaHistoryStore.test.ts && git commit -m "feat(accounts): add 30-day QuotaHistoryStore with CSV and JSON export"`

---

### Task 5: `QuotaAlertService` (Low-Quota, Exhaustion & Conditional Reset Alerts)

**Files:**
- Create: `src/accounts/quotaAlertService.ts`, `test/quotaAlertService.test.ts`

**Interfaces:**
- Produces in `src/accounts/quotaAlertService.ts`:
  - `export interface QuotaAlertConfig { enableLowQuotaAlerts: boolean; lowQuotaThresholdPct: number; notifyQuotaReset: boolean; }`
  - `export interface QuotaAlertEvent { kind: 'low' | 'exhausted' | 'reset'; email: string; pools: { poolKey: PoolKey; window: '5h' | 'weekly'; remainingPct: number; resetTime: string | null }[]; bestAlternative?: { email: string; label?: string; minRemainingPct: number } | null; }`
  - `export class QuotaAlertService`:
    - `evaluate(params: { email: string; snapshot: QuotaSnapshot; alternatives: Array<{ account: ManagedAccount; snapshot: QuotaSnapshot | null }>; config: QuotaAlertConfig; nowMs?: number }): QuotaAlertEvent[]`

- [ ] **Step 1: Write failing tests in `test/quotaAlertService.test.ts`**
  - Test deduplication per `${email}:${poolKey}:${window}:${resetTime}` so repeated polls do not re-fire low/exhausted alerts.
  - Test aggregating multiple newly exhausted (`0%`) windows/pools in one poll into a single `'exhausted'` event with `bestAlternative` selected from accounts with non-stale `> 0%` quota.
  - Test `'reset'` event fires ONLY for a `(email, poolKey, window)` tuple previously flagged as `'low'` or `'exhausted'` in the current session when its window rolls forward (`resetTime` changed or fraction recovered above threshold)—and does NOT fire if the window never dropped below threshold.

- [ ] **Step 2: Run test to verify failure**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/quotaAlertService.test.ts`
  - Expected: FAIL (`quotaAlertService.ts` missing).

- [ ] **Step 3: Implement `QuotaAlertService` in `src/accounts/quotaAlertService.ts`**

- [ ] **Step 4: Run typecheck and tests**
  - Run: `npm run check && node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/quotaAlertService.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add src/accounts/quotaAlertService.ts test/quotaAlertService.test.ts && git commit -m "feat(accounts): add QuotaAlertService with deduplicated low, exhausted, and conditional reset alerts"`

---

### Task 6: `TokenVaultService` (SecretStorage Vault, Email Integrity Guard & Cross-Platform Keyring Adapters)

**Files:**
- Create: `src/accounts/tokenVaultService.ts`, `test/tokenVaultService.test.ts`

**Interfaces:**
- Produces in `src/accounts/tokenVaultService.ts`:
  - `export interface VaultIdeState { oauthToken?: string; userStatus?: string; profileUrl?: string; }`
  - `export interface VaultCredentialRecord { userName: string; blobBase64?: string; persist: number; updatedAt: number; ideState?: VaultIdeState; }`
  - `export interface VaultCapabilities { secretStorageAvailable: boolean; osKeyringSupported: boolean; osKeyringBackend: 'wincred' | 'macos-keychain' | 'linux-secret-tool' | 'none'; standaloneDbSupported: boolean; }`
  - `export function extractEmailFromJwt(jwt: string): string | null`
  - `export function extractEmailFromCredentialBlob(blobBase64: string): string | null`
  - `export function extractEmailFromIdeState(ideState: VaultIdeState): string | null`
  - `export class TokenVaultService`:
    - `constructor(deps: TokenVaultDeps)` (injectable `secrets`, `platform`, `execFileAsync`, `readIdeState`, `which`)
    - `async getCapabilities(): Promise<VaultCapabilities>`
    - `async listVaultedEmails(): Promise<string[]>`
    - `async getCredential(email: string): Promise<{ record: VaultCredentialRecord | null; corruptPurged: boolean }>`
    - `async captureActiveCredential(email: string, options?: { isStandaloneIde?: boolean }): Promise<{ captured: boolean; reason?: string }>`
    - `async applyToOsKeyring(email: string): Promise<{ applied: boolean; reason?: string }>`
    - `async deleteCredential(email: string): Promise<void>`
    - `async clearAll(): Promise<void>`

- [ ] **Step 1: Write failing tests in `test/tokenVaultService.test.ts`**
  - Test `extractEmailFromJwt`, `extractEmailFromCredentialBlob`, and `extractEmailFromIdeState` (`userStatus` + `oauthToken` JWT fallback).
  - Test anti-contamination guard: storing a token whose embedded email differs from `targetEmail` rejects capture, and reading a mismatched record auto-purges it from `SecretStorage` (`corruptPurged: true`).
  - Test OS keyring capability detection & commands across mocked `win32` (PowerShell CredMan via stdin/env, no raw secret interpolation), `darwin` (`security`), and `linux` (`secret-tool` present vs missing -> `osKeyringSupported: false`, `osKeyringBackend: 'none'`).

- [ ] **Step 2: Run test to verify failure**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/tokenVaultService.test.ts`
  - Expected: FAIL (`tokenVaultService.ts` missing).

- [ ] **Step 3: Implement `TokenVaultService` in `src/accounts/tokenVaultService.ts`**
  - Use keys `gravitywatch.vault.index` and `gravitywatch.vault.token.<normalizedEmail>` inside `vscode.SecretStorage`.
  - Pass sensitive values to child processes (`powershell.exe`, `secret-tool`, `security`) via `stdin` or environment variables rather than interpolating into shell command strings.

- [ ] **Step 4: Run typecheck and tests**
  - Run: `npm run check && node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/tokenVaultService.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add src/accounts/tokenVaultService.ts test/tokenVaultService.test.ts && git commit -m "feat(accounts): add cross-platform TokenVaultService with email integrity verification"`

---

### Task 7: `IdeStateService` & `AccountSwitcher` (Protobuf Sync, Targeted SQLite Switch Worker & Official Fallback)

**Files:**
- Create: `src/accounts/protobufSync.ts`, `src/accounts/ideStateService.ts`, `src/accounts/accountSwitcher.ts`, `test/accountSwitcher.test.ts`

**Interfaces:**
- Produces in `src/accounts/protobufSync.ts`:
  - `encodeOAuthInfo(params: { accessToken: string; refreshToken: string; expirySeconds: number | bigint; idToken?: string; isGcpTos?: boolean; email?: string }): Uint8Array`
  - `encodeUnifiedStateEntry(sentinelKey: string, payload: Uint8Array): string`
  - `encodeUnifiedOAuthToken(...)` (`sentinelKey = 'oauthTokenInfoSentinelKey'`)
  - `encodeUnifiedUserStatus(email: string)` (`sentinelKey = 'userStatusSentinelKey'`, fields `3` and `7`)
- Produces in `src/accounts/ideStateService.ts`:
  - `isAntigravityStandaloneIde(appName: string, execPath: string): boolean`
  - `resolveStandaloneIdeInfo(deps?): { dataPath: string; stateDbPath: string; processName: string; executablePath: string }`
  - `readStandaloneIdeAuthState(stateDbPath: string, sqliteClient?): Promise<VaultIdeState | null>` (read-only)
  - `buildStandaloneSwitchWorkerScript(): string` (zero external deps: uses `node:sqlite`, `sqlite3`, or `python3` to verify `.bak` copy succeeded, wait for IDE exit + WAL/SHM absence, execute `INSERT OR REPLACE INTO ItemTable`, and relaunch IDE with `ELECTRON_RUN_AS_NODE` cleared)
  - `performStandaloneIdeSwitch(params: { targetEmail: string; ideState: VaultIdeState; globalStorageDir: string; ... }): Promise<{ launched: boolean; reason?: string }>`
- Produces in `src/accounts/accountSwitcher.ts`:
  - `export class AccountSwitcher`:
    - `async switchToAccount(targetEmail: string): Promise<{ ok: boolean; mode: 'standalone-restart' | 'keyring-sync' | 'official-login' | 'cancelled' | 'failed'; requiresReload?: boolean; message?: string }>`
    - `async addAccountViaOfficialLogin(): Promise<{ ok: boolean; email?: string; message?: string }>`
    - `async reauthAccount(email: string): Promise<{ ok: boolean; message?: string }>`

- [ ] **Step 1: Write failing tests in `test/accountSwitcher.test.ts`**
  - Test `encodeOAuthInfo` + `encodeUnifiedStateEntry` + `encodeUnifiedUserStatus` wire tags (`oauthTokenInfoSentinelKey`, `userStatusSentinelKey`, `@gmail.com` forcing `isGcpTos = false`) and round-trip email extraction via `extractEmailFromIdeState`.
  - Test Standalone IDE switch aborting safely when `.bak` copy fails or `state.vscdb-wal` remains locked (does NOT overwrite `state.vscdb`), and succeeding against a temp SQLite `state.vscdb` updating only the 4 auth keys while preserving unrelated `ItemTable` keys.
  - Test `AccountSwitcher.switchToAccount` routing:
    1. Standalone IDE + valid vault -> confirmation -> `performStandaloneIdeSwitch`.
    2. VS Code + valid vault + supported OS keyring -> `applyToOsKeyring` -> `syncOfficialUi` (sets `requiresReload: true` if UI sync fails).
    3. VS Code on Linux without `secret-tool` (or missing/corrupt vault -> marks `needs_reauth`) -> falls back cleanly to `HubAuthClient.logout` + `login`.

- [ ] **Step 2: Run test to verify failure**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/accountSwitcher.test.ts`
  - Expected: FAIL (`protobufSync.ts`, `ideStateService.ts`, `accountSwitcher.ts` missing).

- [ ] **Step 3: Implement `protobufSync.ts`, `ideStateService.ts`, and `accountSwitcher.ts`**
  - Reuse existing read-only `createSqliteClient` for `readStandaloneIdeAuthState`, and keep the detached worker self-contained (`node:sqlite` -> `sqlite3` -> `python3`) with zero npm runtime dependencies.

- [ ] **Step 4: Run typecheck and tests**
  - Run: `npm run check && node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/accountSwitcher.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add src/accounts/protobufSync.ts src/accounts/ideStateService.ts src/accounts/accountSwitcher.ts test/accountSwitcher.test.ts && git commit -m "feat(accounts): add targeted Standalone IDE switch worker and cross-platform AccountSwitcher"`

---

### Task 8: `MonitorService` Integration & Configuration Settings

**Files:**
- Modify: `src/types.ts`, `src/monitorService.ts`, `package.json`, `test/monitorService.test.ts`

**Interfaces:**
- Modifies `MonitorConfig` & `DEFAULT_CONFIG` in `src/types.ts` (and `package.json` `contributes.configuration.properties`):
  - `enableLowQuotaAlerts: boolean` (`true`)
  - `lowQuotaThresholdPct: number` (`20`, min `5`, max `50`)
  - `notifyQuotaReset: boolean` (`true`)
  - `quotaAlertBackground: boolean` (`true`)
  - `autoCaptureVault: boolean` (`true`)
- Modifies `MonitorState` in `src/types.ts`:
  - `activeAccount: ManagedAccount | null`
  - `accounts: ManagedAccount[]`
  - `accountSnapshots: Record<string, QuotaSnapshot | null>`
  - `accountHistory: DailyPoolQuotaRecord[]`
  - `diagnostics: { hostEditor: string; isStandaloneIde: boolean; platform: NodeJS.Platform; osKeyringSupported: boolean; osKeyringBackend: string; hubPid: number | null; hubPort: number | null; hubSource: string | null }`
- Modifies `MonitorServiceDeps` & `MonitorService` in `src/monitorService.ts`:
  - Optional injected `accountStore`, `historyStore`, `alertService`, `vaultService`, `onQuotaAlerts`, `hostDiagnostics`.
  - Replaces single `lastGoodQuota` with `lastGoodQuotaByAccount: Map<string, QuotaSnapshot>` (keyed by normalized `email` or `'__anonymous__'`).
  - On quota poll: fetches `fetchUserIdentity(winner.endpoint)`, upserts `activeAccount`, triggers auto-capture if `autoCaptureVault` and new email observed, updates `accountSnapshots` + `historyStore`, evaluates `QuotaAlertService` and emits `onQuotaAlerts`.

- [ ] **Step 1: Write failing tests in `test/monitorService.test.ts`**
  - Test per-account `lastGoodQuota` isolation: Account A (`85%`) -> hub switches to Account B -> hub goes offline -> Account B does NOT inherit Account A's `85%` stale snapshot (Review Focus #1).
  - Test auto-capture trigger when active email transitions from `null` or `a@example.com` to `b@example.com` with `autoCaptureVault: true`.
  - Test `QuotaAlertService` integration firing `onQuotaAlerts` when quota drops below `lowQuotaThresholdPct`.

- [ ] **Step 2: Run test to verify failure**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/monitorService.test.ts`
  - Expected: FAIL (`activeAccount` / isolation missing).

- [ ] **Step 3: Update `src/types.ts`, `src/monitorService.ts`, and `package.json` configuration**

- [ ] **Step 4: Run typecheck and tests**
  - Run: `npm run check && node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/monitorService.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add src/types.ts src/monitorService.ts package.json test/monitorService.test.ts && git commit -m "feat(monitor): isolate quota snapshots per account and integrate account/history/alert hooks"`

---

### Task 9: Unified UI (`StatusBar`, `QuickPick`, `Overview` + `Accounts` Tab), Extension Wiring & Docs

**Files:**
- Modify: `src/ui/statusBar.ts`, `src/ui/quickPick.ts`, `src/ui/bottomPanelProvider.ts`, `src/ui/bottomPanelHtml.ts`, `src/extension.ts`, `package.json`, `test/ui.test.ts`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- `PanelTabId = 'overview' | 'details' | 'accounts'` (`DEFAULT_PANEL_LAYOUT.tabOrder = ['overview', 'details', 'accounts']`).
- `Overview`: renders compact Active Account header bar (`email`, `plan`, auth badge, `Switch` / `Save` / `Sign In`) above `quota`, `sessions`, `unattached`.
- `Accounts` tab renders:
  1. **Saved Accounts** (search filter, group filter, label/group/color edit, Switch / Save Current / Re-auth / Remove).
  2. **Multi-Account Quota Matrix** (all saved accounts with 5h/weekly `%`, reset time, and `Stale` / `Reset passed` badge when inactive & expired).
  3. **30-Day Quota History & Backups** (`Export CSV`, `Export JSON`, `Export Accounts`, `Import Accounts`).
  4. **Runtime & Hub Diagnostics** (editor, OS, keyring backend, Hub PID/port/source, `Reconnect Hub`, `Restart Backend`, `Inspect Bridge`).
- New commands in `package.json` & `src/extension.ts`: `antigravityMonitor.switchAccount`, `antigravityMonitor.saveCurrentAccount`, `antigravityMonitor.addAccount`, `antigravityMonitor.editAccountLabel`, `antigravityMonitor.removeSavedAccount`, `antigravityMonitor.exportAccounts`, `antigravityMonitor.importAccounts`, `antigravityMonitor.exportQuotaAnalytics`, `antigravityMonitor.reconnectHub`, `antigravityMonitor.restartBackend`, `antigravityMonitor.inspectBridge`, `antigravityMonitor.clearTokenVault`.

- [ ] **Step 1: Write failing UI tests in `test/ui.test.ts`**
  - Test `buildStatusBarViewModel`: tooltip displays active account `email` & `plan`, background uses warning/error `ThemeColor` when `quotaAlertBackground` is enabled and pool `remainingPct <= lowQuotaThresholdPct` (or `0%`), and contains no forecast text.
  - Test `buildQuickPickItems`: includes `Switch / Manage Accounts...` entry while keeping `sessions` and pin buttons intact.
  - Test `renderBottomPanelBodyHtml`:
    - `Overview` includes Active Account bar + `Quota Pools` + `Sessions` + `Unattached Subagents` (when present), and excludes `Model Usage Forecast`.
    - `Accounts` tab renders Saved Accounts, Multi-Account Quota Matrix (showing `Reset passed · stale` rather than `100%` for expired inactive accounts), 30-Day History + Export/Import buttons, and Diagnostics card.
  - Test `BottomPanelController` handling new webview inbound actions (`switchAccount`, `addAccount`, `saveCurrentAccount`, `editAccount`, `removeAccount`, `exportHistory`, `exportAccounts`, `importAccounts`, `reconnectHub`, `restartBackend`, `inspectBridge`, `accountSearch`, `accountGroupFilter`).

- [ ] **Step 2: Run UI tests to verify failure**
  - Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/ui.test.ts`
  - Expected: FAIL on missing `'accounts'` tab and account UI strings.

- [ ] **Step 3: Implement UI updates, `extension.ts` wiring, `package.json` commands, and English `README.md` / `CHANGELOG.md`**
  - Update `README.md` (and `package.json` description) accurately in English: telemetry remains strictly local & read-only, while opt-in account switching uses locally captured official credentials without Direct Google OAuth.
  - Update `CHANGELOG.md` in English for the new release section.

- [ ] **Step 4: Run full verification (`check`, `test`, `build`, `package`)**
  - Run: `npm run check && npm test && npm run build`
  - Expected: `tsc --noEmit` exits `0`, all unit tests pass (`0` failures), and `esbuild` produces `dist/extension.js` with zero external runtime npm deps.

- [ ] **Step 5: Commit**
  - `git add -A && git commit -m "feat(ui): integrate Accounts tab, matrix, alerts, diagnostics, and opt-in switching"`
