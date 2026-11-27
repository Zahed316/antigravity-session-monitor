# AGENTS.md

Agent operating guide for **GravityWatch for Antigravity** (`antigravity-session-monitor`), a zero-runtime-dependency VS Code / Antigravity extension that monitors session context windows, subagent token rollups, and multi-account quota pools (`gemini` and `nonGoogle`).

## Workflow & Exploration

1. **Find code with `codegraph_explore` before `grep`.** `.codegraph/` indexes this
   repo. One call returns the source of the symbols you need plus their callers and
   blast radius — the same information as several `grep`/`sed` passes. Use it for
   "where is X / who calls X / what breaks if I change X". Plain `grep` is for
   literals (error strings, config keys), not for finding code.
2. **Verify with `npm run check && npm test` after every edit; add `npm run build`
   when you touch `src/extension.ts`, `esbuild.config.mjs`, or `package.json`.**
   CI runs exactly this on every push (`.github/workflows/ci.yml`), so a green local
   run and a green branch are the same bar.
3. **Both syntax invariants are machine-enforced — do not re-check them by hand.**
   `npm run check` fails on `enum`/`namespace`/parameter properties
   (`erasableSyntaxOnly`, error TS1294). `npm test` fails on a relative import
   without its `.ts` extension (`ERR_MODULE_NOT_FOUND`). Keep `import type` for
   type-only imports.

## Architecture & Invariants

- **Zero runtime dependencies:** Ship zero `"dependencies"` in `package.json`. Implement wire protocols (`src/data/protobuf.ts`), Connect-RPC HTTP/HTTPS loopback calls (`src/rpc/`), and SQLite queries (`src/data/sqliteClient.ts` via `node:sqlite` with `sqlite3` CLI and `python3` fallbacks) on Node.js built-ins (`node20` CJS bundle with `vscode` and `node:sqlite` marked `external`).
- **Node type-stripping compatibility:** Keep all TypeScript compatible with `"erasableSyntaxOnly": true` and `"allowImportingTsExtensions": true` so `node --test test/*.test.ts` executes `.ts` files directly without a build step:
  - Write explicit `.ts` extensions on relative imports (`import { x } from './foo.ts'`).
  - Use `import type` for type-only imports.
  - Use string union types and `as const` objects instead of `enum`, `namespace`, or parameter properties (`constructor(private x: T)`).
- **VS Code host decoupling:** Import `'vscode'` at runtime only inside `src/extension.ts` (or behind structural adapter interfaces in `src/ui/` and `src/accounts/`). Keep `src/core/`, `src/data/`, `src/rpc/`, `src/accounts/`, and `src/monitorService.ts` testable under plain `node:test` without a VS Code Extension Host.
- **Read-only telemetry boundary:** Open Antigravity telemetry SQLite databases strictly read-only (`?mode=ro` / `immutable`). Contact only local loopback hubs (`127.0.0.1`). Account switching is strictly opt-in via official Antigravity sign-in state and `vscode.SecretStorage`—never add direct Google OAuth loopback flows, `sql.js`, or automatic IDE restarts (`autoRoundRobin`).
- **Per-account snapshot isolation & freshness:** Scope every `QuotaSnapshot` to a normalized account `email`. Rank competing hub snapshots by the **earliest** window reset time (`src/core/quotaFreshness.ts`), and mark cached snapshots whose `resetTime` has passed without a live re-check as `stale` (never clamp to `100%`).
- **Lazy, CSP-strict Webview:** Gate Bottom Panel HTML rendering and `postMessage` updates on `view.visible` (`src/ui/bottomPanelProvider.ts`). Escape all interpolated strings and enforce a nonce-based Content Security Policy (`src/ui/bottomPanelHtml.ts`).
- **Domain vocabulary:** Use the exact domain terms from `GLOSSARY.md` (`Session`, `Subagent`, `Unattached subagent`, `Account`, `Quota pool`, `Quota window`, `Snapshot`, `Hub`, `Preview list`) across types, UI copy, and tests.

## Record Map

| Trigger Condition | File | Holds |
|---|---|---|
| Before naming types, UI labels, or domain concepts | `GLOSSARY.md` | Canonical definitions (`Session`, `Subagent`, `Account`, `Quota pool`, `Snapshot`, `Hub`, `Preview list`) and banned synonyms |
| Before changing hub polling, snapshot ranking, or reset-time staleness | `docs/adr/0001-hub-freshness-by-earliest-reset.md` | Why competing hubs are ranked by earliest window reset time rather than latest |
| Before changing account storage, credential capture, keyring access, or account switching | `docs/adr/0002-opt-in-credential-vault-and-no-direct-oauth.md` | Security/ToS boundaries, `SecretStorage` rules, targeted `state.vscdb` updates, and rejected approaches |
| Before implementing or modifying multi-account features, alerts, history, or the Accounts tab | `docs/superpowers/specs/2026-11-27-multi-account-switching-design.md` | Active design spec and subsystem contracts for multi-account monitoring and opt-in switching |
| Before continuing phased multi-account implementation tasks | `docs/superpowers/plans/2026-11-27-multi-account-switching.md` | Step-by-step TDD task breakdown for the multi-account rollout |
