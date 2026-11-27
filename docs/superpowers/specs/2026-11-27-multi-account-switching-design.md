─────────────────────────────────────────────────
                                # GravityWatch Multi-Account Monitoring & Opt-In Switching — Design Specification

Date: 2026-11-27
Repository: `/home/zahedrastgar/Documents/_Projects/antigravity-session-monitor`
Related Docs: [`GLOSSARY.md`](../../../GLOSSARY.md), [`ADR 0001`](../../adr/0001-hub-freshness-by-earliest-reset.md), [`ADR 0002`](../../adr/0002-opt-in-credential-vault-and-no-direct-oauth.md)

---

## 1. Intent & Scope

Extend **GravityWatch for Antigravity** (`v0.1.9`) with multi-account awareness, cross-account quota comparison, 30-day daily quota history, actionable quota alerts, runtime hub diagnostics, and opt-in safe account switching—while preserving GravityWatch's existing session/subagent monitoring (`sessions`, `unattached`, `details`), zero-runtime-dependency architecture, and cross-platform support.

Simultaneously, remove the **Model Usage Forecast** (`forecast`) subsystem completely (UI section, Status Bar estimate lines, `QuotaEstimator`, and `quota-calibration.json`) to simplify quota state and keep the `Overview` tab focused on live quotas and sessions.

---

## 2. Architecture & Domain Boundaries

### 2.1 Domain Rules (per `GLOSSARY.md` & `ADR 0002`)
- **Account identity**: Identified uniquely by normalized Google `email` (`email.trim().toLowerCase()`). Stores `displayName`, `plan` (formatted e.g. `Google AI Pro`, `Google AI Ultra`, `Google AI Free`), `tier`, `profilePictureUrl`, `firstSeenAt`, `lastSeenAt`, `status` (`'active' | 'saved' | 'needs_reauth'`), and optional local metadata (`label`, `group`, `colorTag`).
- **Per-account snapshot isolation**: Every `QuotaSnapshot` belongs to a single `Account`. Switching accounts never blends `lastGoodQuota` across accounts. If an inactive account's `resetTime` has passed (`resetTime <= nowMs`) without a live check, its cached snapshot is marked `stale` / `Reset passed`—never optimistically clamped to `100%`.
- **Read-only telemetry + opt-in switching**: Local SQLite telemetry (`~/.gemini/antigravity/`) remains strictly read-only. Credentials are only captured or swapped through official Antigravity sign-in state and explicit user switch actions.
- **Rejected features**:
  - **No Direct Google OAuth (`OAuthService`)**: Avoids Google Terms of Service / anti-abuse restrictions.
  - **No `sql.js`**: Avoids bundling ASM/WASM SQLite and rewriting entire database files; uses existing `node:sqlite`, `sqlite3`, or `python3` backends for targeted key updates during Standalone IDE switches.
  - **No `autoRoundRobin`**: Never kills/restarts the IDE or backend automatically on `0%` quota.
  - **No Webview `AudioContext` chimes** (panel is lazy-loaded) and **no Proxy settings** (only `127.0.0.1` loopback hubs are contacted).

### 2.2 Subsystems

#### A. Forecast Removal
- Remove `OverviewSectionId` `'forecast'`, `WindowTokenEstimate`, `ModelTokenEstimate`, `MonitorState.modelEstimates`, `src/core/quotaEstimator.ts`, `test/quotaEstimator.test.ts`, `quota-calibration.json` wiring in `src/extension.ts` / `src/monitorService.ts`, forecast tooltip formatting in `src/ui/statusBar.ts`, and `renderModelForecastSection` / `model-forecast` help in `src/ui/bottomPanelHtml.ts` / `src/ui/bottomPanelProvider.ts`.
- Preserve `quota`, `sessions` (with full subagent rollups and active/pinned preservation), and `unattached` in `Overview`, plus the entire `Details` tab.

#### B. Account Identity, RPC & Daemon Discovery (`src/rpc/`)
- Extend `extractUserIdentityFromUserStatus(raw)` in `src/rpc/hubClient.ts` to extract `email`, `displayName`, `tier`, `isPro`, `plan`, and `profilePictureUrl` from `GetUserStatus`.
- Extend `discoverHubEndpoints` in `src/rpc/hubDiscovery.ts` to check `daemon/hub_<port>.json` (under `<antigravityRoot>/daemon` and `~/.gemini/daemon`) for `csrfToken`, `httpsPort`, `httpPort`, and `pid`, adding source `'daemon-file'` when discovered from daemon metadata. Retain `pid` and command-line metadata on discovered endpoints for diagnostics.
- Add `src/rpc/hubAuth.ts` for official auth RPCs (`HasAuthToken`, `GetAuthStatus`, `Login`, `AuthLogout`) and process/backend restart helpers (`antigravity.login`, `antigravity.handleAuthRefresh`, `antigravity.reconnect`, `antigravity.triggerUpdate`, `antigravity.connectHub`).

#### C. Multi-Account Persistence, History & Alerts (`src/accounts/`)
- **`AccountStore`** (`globalState` key `antigravityMonitor.accounts.v1` + snapshot cache in `globalStorageUri/account-snapshots.json`):
  - Upserts discovered active account, edits local `label`/`group`/`colorTag`, prevents deleting the currently active account until signed out, marks accounts `'needs_reauth'` when vaulted credentials fail verification/refresh, and supports **metadata-only** JSON export/import (`schema: "gravitywatch.accounts.backup.v1"` — never includes tokens).
- **`QuotaHistoryStore`** (`globalStorageUri/quota-history.json`):
  - Retains **30 days** of per-account, per-pool (`gemini` / `nonGoogle`) lowest daily `remainingPct` for the `5h` and `weekly` windows.
  - Exports up to 30 days to **CSV** or **JSON**.
- **`QuotaAlertService`**:
  - Low-quota warning (`lowQuotaThresholdPct`, default `20%`, configurable `5..50`) and aggregated `0%` exhaustion alert, deduplicated per `${email}:${poolKey}:${window}:${resetTime}`. Includes a 1-click **"Switch Account"** CTA when another saved account has cached remaining quota `> 0%`.
  - Optional reset-complete notification (`notifyQuotaReset`, default `true`) that fires **only** for `(email, poolKey, window, resetTime)` tuples that previously hit warning or exhaustion in the current runtime session.

#### D. Cross-Platform Credential Vault & Safe Switching (`src/accounts/`)
- **`TokenVaultService`**:
  - Stores captured credentials per normalized email in `vscode.SecretStorage` (`gravitywatch.vault.index` + `gravitywatch.vault.token.<email>`).
  - Enforces email identity matching via JWT `id_token` (`extractEmailFromJwt`), JSON credential blob, and `ideState` protobuf string inspection; auto-purges mismatched/corrupt vault entries.
  - **Cross-platform OS keyring adapters** for VS Code / Cursor (`gemini:antigravity`):
    - `win32`: PowerShell `Advapi32.dll` (`CredReadW` / `CredWriteW` / `CredDeleteW`) using safe environment/stdin passing (no unescaped string interpolation).
    - `darwin`: macOS `security` CLI (`find-generic-password` / `add-generic-password`).
    - `linux`: `secret-tool` (`lookup` / `store`) when available on `PATH`; reports `keyringSupported: false` cleanly when unavailable (no crash, automatic fallback to official `Login` / `AuthLogout`).
  - **Auto-capture**: When `MonitorService` observes an authenticated `email` from `GetUserStatus`, it registers the account and captures the active credential into `SecretStorage` if vault capture is supported on the current host/OS (plus an explicit `Save Current Account to Vault` command).
- **`IdeStateService` & `AccountSwitcher`**:
  - **Antigravity Standalone IDE** (Linux/macOS/Windows):
    - Resolves `state.vscdb` (`%APPDATA%/Antigravity IDE` or `Antigravity` on `win32`; `~/Library/Application Support/...` on `darwin`; `$XDG_CONFIG_HOME` / `~/.config/...` on `linux`).
    - Reads `antigravityUnifiedStateSync.oauthToken`, `antigravityUnifiedStateSync.userStatus`, and `antigravity.profileUrl` read-only for vault capture.
    - On user-confirmed switch: calls `saveAll(false)`, writes `.switch-payload.json` and `.switch-worker.js` to `globalStorageUri`, spawns detached Node worker (`ELECTRON_RUN_AS_NODE=1`), quits IDE (`workbench.action.quit` / `closeWindow`).
    - Worker waits up to 12s for IDE exit -> graceful close (`SIGTERM` / `taskkill`) -> force kill (`SIGKILL` / `taskkill /F`), waits for `-wal`/`-shm` removal, copies `state.vscdb` to `state.vscdb.bak`, runs targeted `INSERT OR REPLACE` for the 4 keys (`antigravityUnifiedStateSync.oauthToken`, `antigravityUnifiedStateSync.userStatus`, `antigravityOnboarding`, `antigravity.profileUrl`) via `node:sqlite`, `sqlite3`, or `python3`, deletes payload, and relaunches IDE.
  - **VS Code / Cursor**:
    - If target has a valid vault credential and OS keyring adapter is supported: captures current active account first, writes `gemini:antigravity` to OS keyring, refreshes/restarts `agy` backend and calls `syncAntigravityUi()`; if UI does not reflect the new email within ~2s, offers `"Reload Window"`.
    - Otherwise (or when keyring is unavailable): executes official `AuthLogout` + `Login` RPC / `antigravity.login` and captures the new account once `GetUserStatus` reports it.

#### E. Unified UI & Commands
- **No Activity Bar container**.
- **Status Bar (`src/ui/statusBar.ts`)**: Keep compact indicator; add low-quota warning/critical background color (configurable, alongside existing context % thresholds); show active account `email` + `plan` in tooltip; remove forecast lines.
- **QuickPick (`src/ui/quickPick.ts`)**: Add `Switch / Manage Accounts...` item at the top alongside `Open Monitor Panel`, `Scope`, and `Sessions`.
- **Bottom Panel (`src/ui/bottomPanelProvider.ts`, `src/ui/bottomPanelHtml.ts`)**:
  - `PanelTabId = 'overview' | 'details' | 'accounts'`.
  - `Overview`: compact Active Account bar at top (`email`, `plan`, vault/auth badge, `Switch` / `Save` / `Sign In` buttons) followed by `quota`, `sessions`, `unattached`.
  - `Accounts` tab:
    1. **Saved Accounts** (search input, group filter, label/group/color edit, Switch / Save Current / Re-auth / Remove).
    2. **Multi-Account Quota Matrix** (all accounts side-by-side showing 5h & weekly percentages + reset/stale status for `gemini` and `nonGoogle`).
    3. **30-Day History & Backup** (per-account/pool summary + `Export Analytics (CSV/JSON)`, `Export Accounts`, `Import Accounts`).
    4. **Runtime & Hub Diagnostics** (host editor, platform, keyring/vault capability, Hub PID/port/source, `Refresh`, `Reconnect Hub`, `Restart Backend`, `Inspect Bridge`).
- **Commands (`package.json` & `src/extension.ts`)**: Add `switchAccount`, `saveCurrentAccount`, `addAccount`, `editAccountLabel`, `removeSavedAccount`, `exportAccounts`, `importAccounts`, `exportQuotaAnalytics`, `reconnectHub`, `restartBackend`, `inspectBridge`, `clearTokenVault`.
- **Configuration (`package.json`)**: Add `enableLowQuotaAlerts` (`true`), `lowQuotaThresholdPct` (`20`), `notifyQuotaReset` (`true`), `quotaAlertBackground` (`true`), `autoCaptureVault` (`true`).
