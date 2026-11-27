# ADR 0002 — Opt-in local credential vault and no direct Google OAuth

## Status

Accepted.

## Context

GravityWatch began as a strictly read-only, zero-runtime-dependency monitor for Antigravity sessions and quotas. Adding multi-account monitoring and account switching introduces a boundary choice: how to obtain and swap account credentials across Linux, macOS, and Windows for both Antigravity Standalone IDE and VS Code/Cursor without compromising user accounts or bundling fragile dependencies.

## Decision

Keep telemetry collection and monitoring strictly read-only by default, and support **opt-in** account switching only through credentials captured from Antigravity's official sign-in flow:

- Store captured credentials per **Account** in `vscode.SecretStorage` with email/JWT identity verification, never exporting tokens in plaintext backups.
- For **Antigravity Standalone IDE**, perform switches cross-platform only on explicit user confirmation: wait for IDE exit and WAL removal, write a `.bak` backup, and update only the four auth keys in `state.vscdb` via targeted `INSERT OR REPLACE` using the existing zero-dependency SQLite backends (`node:sqlite`, `sqlite3`, or `python3`) rather than adding `sql.js`.
- For **VS Code / Cursor**, read/write the host OS keyring target (`gemini:antigravity`) via platform adapters where available, and gracefully fall back to Antigravity's official `Login` / `AuthLogout` commands when keyring access is unavailable (e.g., Linux without `secret-tool`).
- Do **not** implement a direct Google OAuth loopback flow (`OAuthService`) or silent `autoRoundRobin` restarts.

## Considered Options

- **Strictly read-only multi-account monitoring**: Safer, but forces users to re-authenticate manually every time they rotate accounts.
- **Direct Google OAuth loopback flow (as in `antigravity-account-switcher`)**: Works across OSes without OS keyring access, but triggers Google anti-abuse / Terms of Service restrictions reported by users.
- **Bundling `sql.js` for whole-file `state.vscdb` rewrites**: Adds a runtime dependency and rewrites the entire database file instead of targeted key updates.

## Consequences

- GravityWatch is no longer "never writes anywhere": README and docs must distinguish read-only telemetry from explicit user-triggered account switches.
- Adding a brand-new account requires signing in once through the official Antigravity IDE/extension flow; expired vault tokens transition the account to `Needs re-auth` while preserving labels and quota history.
- Environments without accessible OS keyring tooling (such as headless or `secret-tool`-less Linux VS Code hosts) retain full multi-account monitoring, matrix, history, and official login/logout switching without crashing.
- Removing `OAuthService` means GravityWatch only contacts loopback (`127.0.0.1`) hubs and needs no proxy configuration.
