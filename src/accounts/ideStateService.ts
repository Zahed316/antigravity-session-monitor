import { spawn as nodeSpawn } from 'node:child_process';
import fsModule from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSqliteClient, type SqliteClient } from '../data/sqliteClient.ts';
import {
  decodeOAuthInfo,
  decodeUnifiedStateEntry,
  encodeUnifiedOAuthToken,
  encodeUnifiedUserStatus,
} from './protobufSync.ts';
import type { VaultIdeState } from './tokenVaultService.ts';

/** The only ItemTable keys the standalone-IDE switch worker is allowed to write. */
export const OAUTH_TOKEN_STATE_KEY = 'antigravityUnifiedStateSync.oauthToken';
export const USER_STATUS_STATE_KEY = 'antigravityUnifiedStateSync.userStatus';
export const ONBOARDING_STATE_KEY = 'antigravityOnboarding';
export const PROFILE_URL_STATE_KEY = 'antigravity.profileUrl';

/**
 * Best-effort value for `antigravityOnboarding` so the post-switch onboarding
 * wizard does not reappear. The real on-disk shape is unverified (no live
 * capture on this host); the worker's `.bak` restore covers a wrong value.
 */
export const ONBOARDING_COMPLETE_JSON = '{"onboardingComplete":true}';

export const SWITCH_PAYLOAD_FILE = '.switch-payload.json';
export const SWITCH_WORKER_FILE = '.switch-worker.js';
export const SWITCH_RESULT_FILE = '.switch-result.json';

const DEFAULT_WAIT_TIMEOUT_MS = 12_000;
const DEFAULT_GRACE_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_SETTLE_MS = 1_500;

const HOST_HINT_RE = /visual studio code|vscodium|cursor|code - oss|code-oss/;

/**
 * True when this host is the Antigravity standalone IDE (not VS Code / Cursor
 * running the Antigravity extension). The host app name wins over the exec
 * path, because VS Code's extension host can sit under an arbitrary path.
 */
export function isAntigravityStandaloneIde(appName: string, execPath: string): boolean {
  const app = (appName ?? '').toLowerCase();
  if (app.includes('antigravity')) {
    return true;
  }
  if (HOST_HINT_RE.test(app)) {
    return false;
  }
  return (execPath ?? '').toLowerCase().includes('antigravity');
}

export interface StandaloneIdeInfo {
  dataPath: string;
  stateDbPath: string;
  processName: string;
  executablePath: string;
}

export interface ResolveStandaloneIdeInfoDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  executablePath?: string;
}

/**
 * Resolves the standalone-IDE user-data dir, `state.vscdb` path, process image
 * name and IDE executable per platform. `executablePath` is overridable because
 * install locations are install-method dependent.
 */
export function resolveStandaloneIdeInfo(deps: ResolveStandaloneIdeInfoDeps = {}): StandaloneIdeInfo {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();

  let dataPath: string;
  let processName: string;
  let executablePath: string;
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.win32.join(homeDir, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA ?? path.win32.join(homeDir, 'AppData', 'Local');
    dataPath = path.win32.join(appData, 'Antigravity');
    processName = 'Antigravity';
    executablePath =
      deps.executablePath ?? path.win32.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe');
  } else if (platform === 'darwin') {
    dataPath = path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
    processName = 'Antigravity';
    executablePath = deps.executablePath ?? '/Applications/Antigravity.app';
  } else {
    const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    dataPath = path.join(configHome, 'Antigravity');
    processName = 'antigravity';
    executablePath = deps.executablePath ?? 'antigravity';
  }
  const joinFor = (platform === 'win32' ? path.win32 : path).join;
  return {
    dataPath,
    stateDbPath: joinFor(dataPath, 'User', 'globalStorage', 'state.vscdb'),
    processName,
    executablePath,
  };
}

function valueToBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === 'string') {
    // TEXT-stored protobuf bytes: latin1 keeps the 1:1 byte mapping used at write time.
    return new Uint8Array(Buffer.from(value, 'binary'));
  }
  if (value == null) {
    return null;
  }
  return new Uint8Array(Buffer.from(String(value), 'binary'));
}

/**
 * Read-only snapshot of the standalone IDE auth keys. Decodes the unified
 * oauthToken entry down to its access token so `extractEmailFromIdeState` /
 * `extractEmailFromJwt` can verify the embedded identity. Returns null when the
 * DB is unreadable or carries no auth keys.
 */
export async function readStandaloneIdeAuthState(
  stateDbPath: string,
  sqliteClient?: SqliteClient,
): Promise<VaultIdeState | null> {
  const createdClient = sqliteClient ?? (await createSqliteClient());
  let rows: Array<{ key: string; value: unknown }>;
  try {
    rows = await createdClient.queryAll<{ key: string; value: unknown }>(
      stateDbPath,
      'SELECT key, value FROM ItemTable WHERE key IN (?, ?, ?)',
      [OAUTH_TOKEN_STATE_KEY, USER_STATUS_STATE_KEY, PROFILE_URL_STATE_KEY],
    );
  } catch {
    return null;
  } finally {
    if (!sqliteClient) {
      createdClient.dispose();
    }
  }

  let oauthToken: string | undefined;
  let userStatus: string | undefined;
  let profileUrl: string | undefined;
  for (const row of rows) {
    const bytes = valueToBytes(row.value);
    if (bytes === null) {
      continue;
    }
    if (row.key === OAUTH_TOKEN_STATE_KEY) {
      const entry = decodeUnifiedStateEntry(bytes);
      if (entry) {
        const info = decodeOAuthInfo(entry.payload);
        if (info) {
          oauthToken = info.accessToken;
        }
      }
    } else if (row.key === USER_STATUS_STATE_KEY) {
      userStatus = Buffer.from(bytes).toString('binary');
    } else if (row.key === PROFILE_URL_STATE_KEY) {
      profileUrl = Buffer.from(bytes).toString('utf8');
    }
  }
  if (oauthToken === undefined && userStatus === undefined) {
    return null;
  }
  return {
    ...(oauthToken !== undefined ? { oauthToken } : {}),
    ...(userStatus !== undefined ? { userStatus } : {}),
    ...(profileUrl !== undefined ? { profileUrl } : {}),
  };
}

/**
 * Builds the self-contained detached switch worker script (CommonJS, zero npm
 * dependencies). Invoked as: `node .switch-worker.js <payload.json>`.
 *
 * Payload contract:
 * {
 *   stateDbPath: string,
 *   keys: [{ key: string, valueB64: string }],
 *   relaunch: { file: string, args: string[] },
 *   processName: string, platform: string,
 *   minSettleMs, waitTimeoutMs, graceKillTimeoutMs, forceKillTimeoutMs,
 *   killEnabled: boolean, killCommand?: { file, args } (test seam),
 *   resultPath: string
 * }
 *
 * Safety contract (task-7 rules):
 * 1. Aborts BEFORE modifying `state.vscdb` when the `-wal`/`-shm` sidecars
 *    never clear (escalating graceful->force kill of the IDE image first) or
 *    when the `.bak` copy fails its integrity check.
 * 2. Writes ONLY the payload keys via targeted `INSERT OR REPLACE` (node:sqlite
 *    -> sqlite3 CLI -> python3 backends), then re-reads and byte-verifies every
 *    key; on any failure restores the `.bak` copy.
 * 3. Relaunches the IDE with ELECTRON_RUN_AS_NODE cleared.
 * 4. The payload file carries the target access token and is deleted on EVERY
 *    exit path (success and failure alike).
 */
export function buildStandaloneSwitchWorkerScript(): string {
  return String.raw`'use strict';
/*
 * GravityWatch standalone-IDE account switch worker. Self-contained: zero npm
 * dependencies (node:sqlite -> sqlite3 CLI -> python3 fallbacks).
 * Safety: aborts BEFORE touching state.vscdb when -wal/-shm never clear or the
 * .bak copy fails; restores .bak when the write or its verification fails.
 */
const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait fallback */ }
  }
}

function exists(p) {
  try { fs.statSync(p); return true; } catch (_) { return false; }
}

function sidecarFilesPresent(dbPath) {
  return exists(dbPath + '-wal') || exists(dbPath + '-shm');
}

function killProcess(payload, force) {
  try {
    if (payload.killCommand) {
      // Test seam: injected kill command; 'force'/'term' appended as the last arg.
      cp.execFileSync(payload.killCommand.file, payload.killCommand.args.concat(force ? 'force' : 'term'), { stdio: 'ignore', timeout: 8000 });
      return;
    }
    if (payload.platform === 'win32') {
      cp.execFileSync('taskkill', force ? ['/F', '/IM', payload.processName + '.exe'] : ['/IM', payload.processName + '.exe'], { stdio: 'ignore', timeout: 8000 });
    } else {
      // -x: exact image-name match only, so this worker is never its own victim.
      cp.execFileSync('pkill', [force ? '-9' : '-TERM', '-x', payload.processName], { stdio: 'ignore', timeout: 8000 });
    }
  } catch (_) {
    // No matching process or missing tool: nothing to kill.
  }
}

function waitIdeExit(payload) {
  sleepSync(payload.minSettleMs);
  const phases = [
    { timeout: payload.waitTimeoutMs, kill: null },
    { timeout: payload.graceKillTimeoutMs, kill: false },
    { timeout: payload.forceKillTimeoutMs, kill: true },
  ];
  for (const phase of phases) {
    const deadline = Date.now() + phase.timeout;
    while (Date.now() < deadline) {
      if (!sidecarFilesPresent(payload.stateDbPath)) return true;
      sleepSync(50);
    }
    if (phase.kill !== null && payload.killEnabled !== false) {
      killProcess(payload, phase.kill);
    }
  }
  return !sidecarFilesPresent(payload.stateDbPath);
}

function copyBackup(dbPath) {
  const bakPath = dbPath + '.bak';
  fs.copyFileSync(dbPath, bakPath);
  const dbBuf = fs.readFileSync(dbPath);
  const bakBuf = fs.readFileSync(bakPath);
  // Byte-length + content hash: a truncated or torn copy must abort the switch.
  if (bakBuf.length !== dbBuf.length || crypto.createHash('sha256').update(dbBuf).digest('hex') !== crypto.createHash('sha256').update(bakBuf).digest('hex')) {
    throw new Error('backup integrity check failed');
  }
  return bakPath;
}

function keyBytes(k) {
  return Buffer.from(k.valueB64, 'base64');
}

function writeViaNodeSqlite(dbPath, keys) {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (_) {
    return 'unavailable';
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') return 'unavailable';
  try {
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      const insert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
      for (const k of keys) insert.run(k.key, keyBytes(k));
      const select = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
      for (const k of keys) {
        const row = select.get(k.key);
        if (!row || Buffer.from(row.value).toString('base64') !== k.valueB64) return 'write_failed';
      }
    } finally {
      db.close();
    }
    return null;
  } catch (_) {
    return 'write_failed';
  }
}

function sqlQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function writeViaSqlite3Cli(dbPath, keys) {
  const inserts = keys.map(function (k) {
    return 'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (' + sqlQuote(k.key) + ", x'" + keyBytes(k).toString('hex') + "');";
  }).join(' ');
  const selects = keys.map(function (k) {
    return 'SELECT hex(value) FROM ItemTable WHERE key = ' + sqlQuote(k.key) + ';';
  }).join(' ');
  try {
    const out = cp.execFileSync('sqlite3', ['-batch', dbPath, inserts + ' ' + selects], { encoding: 'utf8', timeout: 15000 });
    const lines = String(out).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
    if (lines.length !== keys.length) return 'write_failed';
    for (let i = 0; i < keys.length; i++) {
      if (lines[i].toLowerCase() !== keyBytes(keys[i]).toString('hex')) return 'write_failed';
    }
    return null;
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'unavailable' : 'write_failed';
  }
}

const PYTHON_WRITE_SCRIPT = [
  'import base64, json, sqlite3, sys',
  'db_path, payload_path = sys.argv[1], sys.argv[2]',
  'payload = json.load(open(payload_path, "r", encoding="utf-8"))',
  'conn = sqlite3.connect(db_path, timeout=5.0)',
  'try:',
  '    cur = conn.cursor()',
  '    for k in payload["keys"]:',
  '        cur.execute("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", (k["key"], sqlite3.Binary(base64.b64decode(k["valueB64"]))))',
  '    for k in payload["keys"]:',
  '        row = cur.execute("SELECT value FROM ItemTable WHERE key = ?", (k["key"],)).fetchone()',
  '        if row is None or bytes(row[0]) != base64.b64decode(k["valueB64"]):',
  '            sys.exit(3)',
  '    conn.commit()',
  'finally:',
  '    conn.close()',
].join('\n');

function writeViaPython(dbPath, payloadPath, keys) {
  try {
    cp.execFileSync('python3', ['-c', PYTHON_WRITE_SCRIPT, dbPath, payloadPath], { stdio: 'ignore', timeout: 20000 });
    return null;
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'unavailable' : 'write_failed';
  }
}

function applyWrites(dbPath, payload, payloadPath) {
  const viaNode = writeViaNodeSqlite(dbPath, payload.keys);
  if (viaNode !== 'unavailable') return viaNode;
  const viaCli = writeViaSqlite3Cli(dbPath, payload.keys);
  if (viaCli !== 'unavailable') return viaCli;
  return writeViaPython(dbPath, payloadPath, payload.keys);
}

function relaunchIde(payload) {
  try {
    const env = Object.assign({}, process.env);
    // Never inherit the run-as-node flag into the relaunched IDE.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawn(payload.relaunch.file, payload.relaunch.args || [], { detached: true, stdio: 'ignore', env: env });
    child.on('error', function () { /* relaunch is best-effort */ });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function run(payload, payloadPath) {
  if (!waitIdeExit(payload)) {
    return { ok: false, stage: 'wal_timeout' };
  }
  let bakPath = null;
  try {
    bakPath = copyBackup(payload.stateDbPath);
  } catch (_) {
    return { ok: false, stage: 'bak_copy_failed' };
  }
  const failStage = applyWrites(payload.stateDbPath, payload, payloadPath);
  if (failStage) {
    try { fs.copyFileSync(bakPath, payload.stateDbPath); } catch (_) { /* best effort restore */ }
    return { ok: false, stage: failStage, restored: true };
  }
  return { ok: true, stage: 'done', relaunched: relaunchIde(payload), backupPath: bakPath };
}

function main() {
  const payloadPath = process.argv[2];
  let payload = null;
  let result;
  try {
    if (!payloadPath) throw new Error('usage: node .switch-worker.js <payload.json>');
    payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    result = run(payload, payloadPath);
  } catch (err) {
    result = { ok: false, stage: 'worker_error', message: String((err && err.message) || err) };
  }
  // The payload carries the target access token: purge it on EVERY exit path.
  if (payloadPath) {
    try { fs.unlinkSync(payloadPath); } catch (_) { /* best effort */ }
  }
  try { fs.unlinkSync(__filename); } catch (_) { /* best effort */ }
  if (payload && payload.resultPath) {
    try { fs.writeFileSync(payload.resultPath, JSON.stringify(result)); } catch (_) { /* best effort */ }
  }
  process.exit(result.ok ? 0 : 1);
}

main();
`;
}

export interface StandaloneSwitchPayloadKey {
  key: string;
  valueB64: string;
}

export interface StandaloneSwitchRelaunch {
  file: string;
  args: string[];
}

export interface StandaloneSwitchPayload {
  stateDbPath: string;
  keys: StandaloneSwitchPayloadKey[];
  relaunch: StandaloneSwitchRelaunch;
  processName: string;
  platform: NodeJS.Platform;
  minSettleMs: number;
  waitTimeoutMs: number;
  graceKillTimeoutMs: number;
  forceKillTimeoutMs: number;
  killEnabled: boolean;
  /** Test seam: overrides the pkill/taskkill escalation when present. */
  killCommand?: { file: string; args: string[] };
  resultPath: string;
}

export type SpawnLike = (
  file: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; env: Record<string, string | undefined> },
) => { unref?(): void };

export interface StandaloneSwitchTimeouts {
  settleMs?: number;
  waitMs?: number;
  graceKillMs?: number;
  forceKillMs?: number;
}

export interface StandaloneSwitchParams {
  targetEmail: string;
  ideState: VaultIdeState;
  globalStorageDir: string;
  ideInfo?: StandaloneIdeInfo;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  fs?: Pick<typeof fsModule, 'mkdir' | 'writeFile' | 'unlink' | 'readFile'>;
  spawn?: SpawnLike;
  quitIde?: () => Promise<void> | void;
  timeouts?: StandaloneSwitchTimeouts;
  /** Max time to wait for the worker's result file; 0 = fire-and-forget (tests). */
  waitForResultMs?: number;
  delay?: (ms: number) => Promise<void>;
}

export interface StandaloneSwitchOutcome {
  launched: boolean;
  reason?: string;
  /** Path of the safety backup copy, for user-visible recovery instructions. */
  backupPath?: string;
}

function bytesB64(bytes: Uint8Array | string): string {
  return Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).toString('base64');
}

function entryValueB64(entry: string): string {
  return Buffer.from(entry, 'binary').toString('base64');
}

function buildSwitchKeys(targetEmail: string, ideState: VaultIdeState): StandaloneSwitchPayloadKey[] {
  const keys: StandaloneSwitchPayloadKey[] = [];
  if (ideState.oauthToken) {
    // UNVERIFIED ASSUMPTION (no live capture): refreshToken '' and
    // expirySeconds 0 are written because VaultIdeState does not carry them —
    // no refresh/expiry data is invented here. Either the IDE re-derives the
    // refresh token via official refresh on next launch, OR it treats the
    // entry as expired/malformed and forces a full re-login (defeating the
    // switch). Live capture of the real entry is a release prerequisite
    // (task-7-report); the `.bak` copy reported to the user is the recovery
    // path for the forced-re-login outcome.
    keys.push({
      key: OAUTH_TOKEN_STATE_KEY,
      valueB64: entryValueB64(
        encodeUnifiedOAuthToken({
          accessToken: ideState.oauthToken,
          refreshToken: '',
          expirySeconds: 0,
          email: targetEmail,
        }),
      ),
    });
  }
  keys.push({ key: USER_STATUS_STATE_KEY, valueB64: entryValueB64(encodeUnifiedUserStatus(targetEmail)) });
  keys.push({ key: ONBOARDING_STATE_KEY, valueB64: bytesB64(ONBOARDING_COMPLETE_JSON) });
  if (ideState.profileUrl) {
    keys.push({ key: PROFILE_URL_STATE_KEY, valueB64: bytesB64(ideState.profileUrl) });
  }
  return keys;
}

function buildRelaunch(ideInfo: StandaloneIdeInfo, platform: NodeJS.Platform): StandaloneSwitchRelaunch {
  if (platform === 'darwin') {
    // `open -a` is the only reliable way to bring a macOS .app back up.
    const appName = path.basename(ideInfo.executablePath).replace(/\.app$/i, '') || 'Antigravity';
    return { file: '/usr/bin/open', args: ['-a', appName] };
  }
  return { file: ideInfo.executablePath, args: [] };
}

const RESULT_POLL_INTERVAL_MS = 100;
const RESULT_WAIT_MARGIN_MS = 5_000;

async function cleanupFiles(
  fsDep: Pick<typeof fsModule, 'unlink'>,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    try {
      await fsDep.unlink(file);
    } catch {
      // Absent or already removed: fine.
    }
  }
}

/**
 * Launches the detached switch worker for the standalone IDE, then asks the
 * host IDE to quit. The worker owns the whole DB transaction: it waits for the
 * IDE to exit and the `-wal`/`-shm` sidecars to clear, copies `state.vscdb` to
 * `.bak` (aborting untouched on failure), writes only the 4 auth keys with
 * byte verification, restores `.bak` on failure, deletes the payload (on every
 * exit path — it carries the target access token), and relaunches the IDE with
 * `ELECTRON_RUN_AS_NODE` cleared. The worker's result file is read back so the
 * caller gets the REAL outcome (wal_timeout / bak_copy_failed / write_failed
 * surface as a failed switch), and is deleted after being consumed.
 */
export async function performStandaloneIdeSwitch(params: StandaloneSwitchParams): Promise<StandaloneSwitchOutcome> {
  if (!params.globalStorageDir) {
    return { launched: false, reason: 'no_global_storage_dir' };
  }
  const fsDep = params.fs ?? fsModule;
  const platform = params.platform ?? process.platform;
  const ideInfo = params.ideInfo ?? resolveStandaloneIdeInfo({ platform, env: params.env });
  const backupPath = `${ideInfo.stateDbPath}.bak`;
  const payload: StandaloneSwitchPayload = {
    stateDbPath: ideInfo.stateDbPath,
    keys: buildSwitchKeys(params.targetEmail, params.ideState),
    relaunch: buildRelaunch(ideInfo, platform),
    processName: ideInfo.processName,
    platform,
    minSettleMs: params.timeouts?.settleMs ?? DEFAULT_SETTLE_MS,
    waitTimeoutMs: params.timeouts?.waitMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    graceKillTimeoutMs: params.timeouts?.graceKillMs ?? DEFAULT_GRACE_KILL_TIMEOUT_MS,
    forceKillTimeoutMs: params.timeouts?.forceKillMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS,
    killEnabled: true,
    resultPath: path.join(params.globalStorageDir, SWITCH_RESULT_FILE),
  };
  const payloadPath = path.join(params.globalStorageDir, SWITCH_PAYLOAD_FILE);
  const workerPath = path.join(params.globalStorageDir, SWITCH_WORKER_FILE);
  const resultPath = payload.resultPath;

  // Stale artifacts from a previous crashed run must never be mistaken for
  // this run's output (and may contain an old access token).
  await cleanupFiles(fsDep, [payloadPath, workerPath, resultPath]);

  try {
    await fsDep.mkdir(params.globalStorageDir, { recursive: true });
    // 0600: the payload carries the target account's access token.
    await fsDep.writeFile(payloadPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    await fsDep.writeFile(workerPath, buildStandaloneSwitchWorkerScript(), 'utf8');
  } catch {
    return { launched: false, reason: 'worker_files_write_failed' };
  }

  try {
    // ELECTRON_RUN_AS_NODE=1 turns the Electron host binary into a plain Node
    // runtime for the detached worker; the worker clears it before relaunching
    // the IDE. Default to the parent env so the worker inherits PATH for its
    // pkill/taskkill/sqlite3/python3 subprocesses.
    const child = (params.spawn ?? nodeSpawn)(params.nodeExecPath ?? process.execPath, [workerPath, payloadPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...(params.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref?.();
  } catch {
    await cleanupFiles(fsDep, [payloadPath, workerPath]);
    return { launched: false, reason: 'worker_spawn_failed' };
  }

  // The worker's kill escalation covers a failed quit, so this is fire-and-forget.
  try {
    await params.quitIde?.();
  } catch {
    // Ignored: worker forces the IDE exit if quit never happens.
  }

  const waitForResultMs =
    params.waitForResultMs ??
    payload.minSettleMs + payload.waitTimeoutMs + payload.graceKillTimeoutMs + payload.forceKillTimeoutMs + RESULT_WAIT_MARGIN_MS;
  if (waitForResultMs <= 0) {
    return { launched: true, backupPath };
  }
  const delay = params.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + waitForResultMs;
  while (Date.now() < deadline) {
    await delay(RESULT_POLL_INTERVAL_MS);
    try {
      const raw = await fsDep.readFile(resultPath, 'utf8');
      const parsed = JSON.parse(raw) as { ok?: boolean; stage?: string };
      // Consumed: the result file is transient scratch, not a kept artifact.
      await cleanupFiles(fsDep, [resultPath]);
      if (parsed.ok) {
        return { launched: true, backupPath };
      }
      return { launched: false, reason: parsed.stage ?? 'worker_error', backupPath };
    } catch {
      // Result not written yet: keep polling until the deadline.
    }
  }
  return { launched: false, reason: 'switch_result_timeout', backupPath };
}
