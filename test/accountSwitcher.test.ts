import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type * as nodeSqlite from 'node:sqlite';

import {
  encodeOAuthInfo,
  encodeUnifiedOAuthToken,
  encodeUnifiedStateEntry,
  encodeUnifiedUserStatus,
  decodeOAuthInfo,
  decodeUnifiedStateEntry,
  OAUTH_TOKEN_SENTINEL_KEY,
  USER_STATUS_SENTINEL_KEY,
} from '../src/accounts/protobufSync.ts';
import {
  isAntigravityStandaloneIde,
  readStandaloneIdeAuthState,
  performStandaloneIdeSwitch,
  buildStandaloneSwitchWorkerScript,
  resolveStandaloneIdeInfo,
  OAUTH_TOKEN_STATE_KEY,
  USER_STATUS_STATE_KEY,
  ONBOARDING_STATE_KEY,
  PROFILE_URL_STATE_KEY,
  ONBOARDING_COMPLETE_JSON,
  type StandaloneIdeInfo,
  type StandaloneSwitchParams,
} from '../src/accounts/ideStateService.ts';
import { AccountSwitcher } from '../src/accounts/accountSwitcher.ts';
import { extractEmailFromIdeState } from '../src/accounts/tokenVaultService.ts';
import type { VaultCredentialRecord } from '../src/accounts/tokenVaultService.ts';
import type { HubEndpoint } from '../src/rpc/hubDiscovery.ts';

// ---------- fixtures / helpers ----------

const A_EMAIL = 'a@example.com';
const B_EMAIL = 'b@example.com';

const ENDPOINT = {
  host: '127.0.0.1',
  port: 51000,
  csrfToken: 'csrf',
  source: 'process',
} as unknown as HubEndpoint;

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function makeJwt(email: string | null): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(email === null ? { sub: '123' } : { sub: '123', email }));
  return `${header}.${payload}.sig`;
}

function entryValueB64(entry: string): string {
  return Buffer.from(entry, 'binary').toString('base64');
}

function utf8ValueB64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

let tmpSeq = 0;
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gw-switch-${Date.now()}-${tmpSeq++}-`));
}

async function makeStateDb(dbPath: string, rows: Array<{ key: string; value: Buffer | string }>): Promise<void> {
  const sqlite = (await import('node:sqlite')) as typeof nodeSqlite;
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const ins = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    for (const row of rows) {
      const value = typeof row.value === 'string' ? Buffer.from(row.value, 'utf8') : row.value;
      ins.run(row.key, value);
    }
  } finally {
    db.close();
  }
}

async function readDbRows(dbPath: string): Promise<Map<string, Buffer>> {
  const sqlite = (await import('node:sqlite')) as typeof nodeSqlite;
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM ItemTable').all() as Array<{ key: string; value: Uint8Array }>;
    const map = new Map<string, Buffer>();
    for (const row of rows) {
      map.set(row.key, Buffer.from(row.value));
    }
    return map;
  } finally {
    db.close();
  }
}

function baseFixtureRows(): Array<{ key: string; value: Buffer | string }> {
  return [
    { key: 'workbench.colorTheme', value: 'Default Dark Modern' },
    { key: 'unrelated.blob', value: Buffer.from([0x00, 0xff, 0x80, 0x61]) },
    {
      key: OAUTH_TOKEN_STATE_KEY,
      value: Buffer.from(
        encodeUnifiedOAuthToken({ accessToken: makeJwt(A_EMAIL), refreshToken: '', expirySeconds: 0, email: A_EMAIL }),
        'binary',
      ),
    },
    { key: USER_STATUS_STATE_KEY, value: Buffer.from(encodeUnifiedUserStatus(A_EMAIL), 'binary') },
    { key: ONBOARDING_STATE_KEY, value: '{"onboardingComplete":false}' },
    { key: PROFILE_URL_STATE_KEY, value: 'https://old.example/a.png' },
  ];
}

function newTargetKeys(): Array<{ key: string; valueB64: string }> {
  return [
    {
      key: OAUTH_TOKEN_STATE_KEY,
      valueB64: entryValueB64(
        encodeUnifiedOAuthToken({ accessToken: makeJwt(B_EMAIL), refreshToken: '', expirySeconds: 0, email: B_EMAIL }),
      ),
    },
    { key: USER_STATUS_STATE_KEY, valueB64: entryValueB64(encodeUnifiedUserStatus(B_EMAIL)) },
    { key: ONBOARDING_STATE_KEY, valueB64: utf8ValueB64(ONBOARDING_COMPLETE_JSON) },
    { key: PROFILE_URL_STATE_KEY, valueB64: utf8ValueB64('https://b.example/pic.png') },
  ];
}

function runWorker(tempDir: string, payload: Record<string, unknown>, env?: NodeJS.ProcessEnv): { status: number; result: Record<string, unknown> | null } {
  const workerPath = path.join(tempDir, '.switch-worker.js');
  fs.writeFileSync(workerPath, buildStandaloneSwitchWorkerScript(), 'utf8');
  const payloadPath = path.join(tempDir, '.switch-payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
  const run = spawnSync(process.execPath, [workerPath, payloadPath], { timeout: 30_000, env });
  let result: Record<string, unknown> | null = null;
  try {
    result = JSON.parse(fs.readFileSync(path.join(tempDir, '.switch-result.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    result = null;
  }
  return { status: run.status ?? 1, result };
}

// ---------- protobufSync: wire format ----------

test('encodeOAuthInfo encodes fields 1-6 and round-trips via decodeOAuthInfo', () => {
  const bytes = encodeOAuthInfo({
    accessToken: 'ACCESS',
    refreshToken: 'REFRESH',
    expirySeconds: 3600,
    idToken: 'ID',
    isGcpTos: true,
    email: 'u@corp.example.com',
  });
  const decoded = decodeOAuthInfo(bytes);
  assert.ok(decoded);
  assert.equal(decoded!.accessToken, 'ACCESS');
  assert.equal(decoded!.refreshToken, 'REFRESH');
  assert.equal(decoded!.expirySeconds, 3600n);
  assert.equal(decoded!.idToken, 'ID');
  assert.equal(decoded!.isGcpTos, true);
  assert.equal(decoded!.email, 'u@corp.example.com');
});

test('encodeOAuthInfo omits optional fields when absent', () => {
  const decoded = decodeOAuthInfo(encodeOAuthInfo({ accessToken: 'A', refreshToken: 'R', expirySeconds: 1 }));
  assert.ok(decoded);
  assert.equal(decoded!.idToken, undefined);
  assert.equal(decoded!.isGcpTos, false);
  assert.equal(decoded!.email, undefined);
});

test('encodeOAuthInfo forces isGcpTos=false for gmail addresses', () => {
  const gmail = decodeOAuthInfo(
    encodeOAuthInfo({ accessToken: 'A', refreshToken: 'R', expirySeconds: 1, isGcpTos: true, email: 'User@GMAIL.com' }),
  );
  assert.ok(gmail);
  assert.equal(gmail!.isGcpTos, false, '@gmail.com forces isGcpTos=false');
  const googlemail = decodeOAuthInfo(
    encodeOAuthInfo({ accessToken: 'A', refreshToken: 'R', expirySeconds: 1, isGcpTos: true, email: 'u@googlemail.com' }),
  );
  assert.ok(googlemail);
  assert.equal(googlemail!.isGcpTos, false, '@googlemail.com forces isGcpTos=false');
  const nonGmail = decodeOAuthInfo(
    encodeOAuthInfo({ accessToken: 'A', refreshToken: 'R', expirySeconds: 1, isGcpTos: true, email: 'u@corp.example.com' }),
  );
  assert.ok(nonGmail);
  assert.equal(nonGmail!.isGcpTos, true, 'non-gmail keeps isGcpTos=true');
  const noEmail = decodeOAuthInfo(encodeOAuthInfo({ accessToken: 'A', refreshToken: 'R', expirySeconds: 1, isGcpTos: true }));
  assert.ok(noEmail);
  assert.equal(noEmail!.isGcpTos, true, 'no email keeps isGcpTos=true');
});

test('encodeOAuthInfo round-trips a 64-bit expirySeconds', () => {
  const big = 1n << 40n;
  const decoded = decodeOAuthInfo(encodeOAuthInfo({ accessToken: 'A', refreshToken: 'R', expirySeconds: big }));
  assert.ok(decoded);
  assert.equal(decoded!.expirySeconds, big);
});

test('encodeUnifiedStateEntry wraps sentinelKey + payload as fields 1 and 2 (latin1 string)', () => {
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const entry = encodeUnifiedStateEntry(OAUTH_TOKEN_SENTINEL_KEY, payload);
  // Raw wire tag assertions on the string form: field 1 tag 0x0a, len, sentinel key.
  assert.equal(entry.charCodeAt(0), 0x0a, 'field 1 length-delimited tag');
  assert.equal(entry.slice(2, 2 + OAUTH_TOKEN_SENTINEL_KEY.length), OAUTH_TOKEN_SENTINEL_KEY, 'sentinel key in plaintext');
  const decoded = decodeUnifiedStateEntry(entry);
  assert.ok(decoded);
  assert.equal(decoded!.sentinelKey, OAUTH_TOKEN_SENTINEL_KEY);
  assert.deepEqual(Buffer.from(decoded!.payload), Buffer.from(payload));
});

test('encodeUnifiedOAuthToken uses the oauthTokenInfoSentinelKey sentinel', () => {
  const entry = encodeUnifiedOAuthToken({ accessToken: makeJwt(B_EMAIL), refreshToken: 'R', expirySeconds: 99, email: B_EMAIL });
  const decoded = decodeUnifiedStateEntry(entry);
  assert.ok(decoded);
  assert.equal(decoded!.sentinelKey, 'oauthTokenInfoSentinelKey');
  const info = decodeOAuthInfo(decoded!.payload);
  assert.ok(info);
  assert.equal(info!.accessToken, makeJwt(B_EMAIL));
  assert.equal(info!.email, B_EMAIL);
});

test('encodeUnifiedUserStatus uses the userStatusSentinelKey sentinel with fields 3 and 7', () => {
  const entry = encodeUnifiedUserStatus(B_EMAIL);
  const decoded = decodeUnifiedStateEntry(entry);
  assert.ok(decoded);
  assert.equal(decoded!.sentinelKey, 'userStatusSentinelKey');
  const payload = Buffer.from(decoded!.payload);
  // Field 7 encoded first (tag 0x38, varint 1) so the plaintext email
  // terminates the buffer and the loose email scan matches exactly.
  assert.equal(payload[0], 0x38, 'field 7 varint tag');
  assert.equal(payload[1], 1, 'field 7 value');
  assert.equal(payload[2], 0x1a, 'field 3 length-delimited tag');
  assert.equal(payload[3], B_EMAIL.length);
  assert.equal(payload.subarray(4, 4 + B_EMAIL.length).toString('utf8'), B_EMAIL);
});

test('extractEmailFromIdeState round-trips encoded unified entries', () => {
  const fromStatus = extractEmailFromIdeState({ userStatus: encodeUnifiedUserStatus(A_EMAIL) });
  assert.equal(fromStatus, A_EMAIL, 'userStatus entry exposes the email to the loose scan');
  const fromToken = extractEmailFromIdeState({
    oauthToken: encodeUnifiedOAuthToken({
      accessToken: makeJwt('jwt@example.com'),
      refreshToken: 'R',
      expirySeconds: 1,
      email: 'jwt@example.com',
    }),
  });
  assert.equal(fromToken, 'jwt@example.com', 'oauthToken entry exposes the email to the loose scan');
});

// ---------- ideStateService: detection + resolution ----------

test('isAntigravityStandaloneIde detects the standalone IDE only', () => {
  assert.equal(isAntigravityStandaloneIde('Antigravity', '/usr/bin/antigravity'), true);
  assert.equal(isAntigravityStandaloneIde('Antigravity', ''), true);
  assert.equal(isAntigravityStandaloneIde('', '/opt/antigravity/bin/antigravity'), true);
  assert.equal(isAntigravityStandaloneIde('Visual Studio Code', '/usr/share/code/code'), false);
  assert.equal(isAntigravityStandaloneIde('Cursor', '/opt/antigravity/bin/antigravity'), false, 'host app name wins over path');
  assert.equal(isAntigravityStandaloneIde('VSCodium', '/usr/bin/codium'), false);
  assert.equal(isAntigravityStandaloneIde('', ''), false);
});

test('resolveStandaloneIdeInfo resolves per-platform paths', () => {
  const home = '/home/tester';
  const linux = resolveStandaloneIdeInfo({ platform: 'linux', env: {}, homeDir: home });
  assert.equal(linux.dataPath, '/home/tester/.config/Antigravity');
  assert.equal(linux.stateDbPath, '/home/tester/.config/Antigravity/User/globalStorage/state.vscdb');
  assert.equal(linux.processName, 'antigravity');

  const linuxXdg = resolveStandaloneIdeInfo({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, homeDir: home });
  assert.equal(linuxXdg.dataPath, '/xdg/Antigravity');

  const darwin = resolveStandaloneIdeInfo({ platform: 'darwin', env: {}, homeDir: home });
  assert.equal(darwin.dataPath, '/home/tester/Library/Application Support/Antigravity');
  assert.equal(darwin.processName, 'Antigravity');

  const win = resolveStandaloneIdeInfo({ platform: 'win32', env: { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, homeDir: 'C:\\Users\\t' });
  assert.equal(win.dataPath, 'C:\\Users\\t\\AppData\\Roaming\\Antigravity');
  assert.equal(win.stateDbPath, path.win32.join('C:\\Users\\t\\AppData\\Roaming', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));

  const overridden = resolveStandaloneIdeInfo({ platform: 'linux', env: {}, homeDir: home, executablePath: '/custom/ide' });
  assert.equal(overridden.executablePath, '/custom/ide');
});

// ---------- ideStateService: readStandaloneIdeAuthState ----------

test('readStandaloneIdeAuthState decodes the three auth keys from a real temp DB', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  await makeStateDb(dbPath, baseFixtureRows());

  const state = await readStandaloneIdeAuthState(dbPath);
  assert.ok(state);
  assert.equal(state!.oauthToken, makeJwt(A_EMAIL), 'accessToken decoded from the unified oauthToken entry');
  assert.ok(state!.userStatus, 'userStatus raw entry preserved');
  assert.equal(state!.profileUrl, 'https://old.example/a.png');
  assert.equal(extractEmailFromIdeState(state!), A_EMAIL, 'email round-trips through extractEmailFromIdeState');
});

test('readStandaloneIdeAuthState returns null for a missing DB or missing keys', async () => {
  const dir = makeTempDir();
  assert.equal(await readStandaloneIdeAuthState(path.join(dir, 'missing.vscdb')), null);

  const emptyDb = path.join(dir, 'empty.vscdb');
  await makeStateDb(emptyDb, [{ key: 'workbench.colorTheme', value: 'Dark' }]);
  assert.equal(await readStandaloneIdeAuthState(emptyDb), null, 'no auth keys -> null');
});

// ---------- standalone switch worker: real temp SQLite DB ----------

test('worker switches the 4 auth keys and preserves unrelated ItemTable keys', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  await makeStateDb(dbPath, baseFixtureRows());
  const keys = newTargetKeys();

  const { status, result } = runWorker(dir, {
    stateDbPath: dbPath,
    keys,
    relaunch: { file: '/nonexistent-antigravity', args: [] },
    processName: 'antigravity',
    platform: process.platform,
    waitTimeoutMs: 300,
    graceKillTimeoutMs: 100,
    forceKillTimeoutMs: 100,
    minSettleMs: 0,
    killEnabled: false,
    resultPath: path.join(dir, '.switch-result.json'),
  });

  assert.equal(status, 0, 'worker exits 0 on success');
  assert.ok(result);
  assert.equal(result!.ok, true);
  assert.equal(result!.stage, 'done');

  const rows = await readDbRows(dbPath);
  assert.equal(rows.size, baseFixtureRows().length, 'no rows added or removed');
  const expected = new Map<string, Buffer>([
    ['workbench.colorTheme', Buffer.from('Default Dark Modern', 'utf8')],
    ['unrelated.blob', Buffer.from([0x00, 0xff, 0x80, 0x61])],
    [OAUTH_TOKEN_STATE_KEY, Buffer.from(keys[0]!.valueB64, 'base64')],
    [USER_STATUS_STATE_KEY, Buffer.from(keys[1]!.valueB64, 'base64')],
    [ONBOARDING_STATE_KEY, Buffer.from(ONBOARDING_COMPLETE_JSON, 'utf8')],
    [PROFILE_URL_STATE_KEY, Buffer.from('https://b.example/pic.png', 'utf8')],
  ]);
  assert.equal(rows.size, expected.size);
  for (const [key, value] of expected) {
    assert.ok(rows.has(key), `key ${key} present`);
    assert.ok(rows.get(key)!.equals(value), `key ${key} has the expected bytes`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'state.vscdb.bak')), '.bak safety copy retained');
  assert.equal(fs.existsSync(path.join(dir, '.switch-payload.json')), false, 'payload deleted after success');
});

test('worker aborts WITHOUT touching state.vscdb when the .bak copy fails', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  await makeStateDb(dbPath, baseFixtureRows());
  // A directory at the .bak path makes copyFileSync fail.
  fs.mkdirSync(path.join(dir, 'state.vscdb.bak'));

  const { status, result } = runWorker(dir, {
    stateDbPath: dbPath,
    keys: newTargetKeys(),
    relaunch: { file: '/nonexistent-antigravity', args: [] },
    processName: 'antigravity',
    platform: process.platform,
    waitTimeoutMs: 200,
    graceKillTimeoutMs: 100,
    forceKillTimeoutMs: 100,
    minSettleMs: 0,
    killEnabled: false,
    resultPath: path.join(dir, '.switch-result.json'),
  });

  assert.equal(status, 1);
  assert.ok(result);
  assert.equal(result!.ok, false);
  assert.equal(result!.stage, 'bak_copy_failed');

  const rows = await readDbRows(dbPath);
  const original = new Map<string, Buffer>();
  for (const row of baseFixtureRows()) {
    original.set(row.key, typeof row.value === 'string' ? Buffer.from(row.value, 'utf8') : row.value);
  }
  assert.equal(rows.size, original.size);
  for (const [key, value] of original) {
    assert.ok(rows.get(key)!.equals(value), `key ${key} untouched`);
  }
});

test('worker aborts WITHOUT touching state.vscdb when -wal never clears', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  await makeStateDb(dbPath, baseFixtureRows());
  // Simulate an IDE that never released the database.
  fs.writeFileSync(path.join(dir, 'state.vscdb-wal'), Buffer.from([0xff, 0xff]));

  const { status, result } = runWorker(dir, {
    stateDbPath: dbPath,
    keys: newTargetKeys(),
    relaunch: { file: '/nonexistent-antigravity', args: [] },
    processName: 'antigravity',
    platform: process.platform,
    waitTimeoutMs: 150,
    graceKillTimeoutMs: 100,
    forceKillTimeoutMs: 100,
    minSettleMs: 0,
    killEnabled: false,
    resultPath: path.join(dir, '.switch-result.json'),
  });

  assert.equal(status, 1);
  assert.ok(result);
  assert.equal(result!.ok, false);
  assert.equal(result!.stage, 'wal_timeout');
  assert.equal(fs.existsSync(path.join(dir, 'state.vscdb.bak')), false, 'aborted before any modification');

  const rows = await readDbRows(dbPath);
  const original = new Map<string, Buffer>();
  for (const row of baseFixtureRows()) {
    original.set(row.key, typeof row.value === 'string' ? Buffer.from(row.value, 'utf8') : row.value);
  }
  for (const [key, value] of original) {
    assert.ok(rows.get(key)!.equals(value), `key ${key} untouched`);
  }
});

// ---------- performStandaloneIdeSwitch (injected spawn/fs) ----------

function makeSpawnRecorder(): {
  calls: Array<{ file: string; args: string[]; options: { detached: boolean; stdio: string; env: Record<string, string | undefined> } }>;
  spawn: (file: string, args: readonly string[], options: { detached: boolean; stdio: 'ignore'; env: Record<string, string | undefined> }) => { unref(): void };
} {
  const calls: Array<{ file: string; args: string[]; options: { detached: boolean; stdio: string; env: Record<string, string | undefined> } }> = [];
  return {
    calls,
    spawn: (file, args, options) => {
      calls.push({ file, args: [...args], options });
      return { unref() {} };
    },
  };
}

test('performStandaloneIdeSwitch writes payload + worker, spawns detached node, then quits the IDE', async () => {
  const dir = makeTempDir();
  const recorder = makeSpawnRecorder();
  const quitCalls: string[] = [];
  const ideInfo: StandaloneIdeInfo = {
    dataPath: '/data',
    stateDbPath: '/data/User/globalStorage/state.vscdb',
    processName: 'antigravity',
    executablePath: '/usr/bin/antigravity',
  };

  const outcome = await performStandaloneIdeSwitch({
    targetEmail: B_EMAIL,
    ideState: { oauthToken: makeJwt(B_EMAIL), profileUrl: 'https://b.example/pic.png' },
    globalStorageDir: dir,
    ideInfo,
    timeouts: { settleMs: 0 },
    waitForResultMs: 0,
    spawn: recorder.spawn,
    quitIde: async () => {
      quitCalls.push('quit');
    },
  });

  assert.deepEqual(outcome, { launched: true, backupPath: `${ideInfo.stateDbPath}.bak` });
  assert.equal(recorder.calls.length, 1);
  const call = recorder.calls[0]!;
  assert.equal(call.file, process.execPath, 'spawned via the host node executable');
  assert.equal(path.basename(call.args[0]!), '.switch-worker.js');
  assert.equal(path.basename(call.args[1]!), '.switch-payload.json');
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1', 'worker runs Electron as plain node');

  const payload = JSON.parse(fs.readFileSync(call.args[1]!, 'utf8')) as Record<string, unknown>;
  assert.equal(payload.stateDbPath, ideInfo.stateDbPath);
  assert.equal(payload.processName, 'antigravity');
  const payloadKeys = payload.keys as Array<{ key: string; valueB64: string }>;
  assert.deepEqual(
    payloadKeys.map((k) => k.key),
    [OAUTH_TOKEN_STATE_KEY, USER_STATUS_STATE_KEY, ONBOARDING_STATE_KEY, PROFILE_URL_STATE_KEY],
    'exactly the 4 auth keys',
  );
  const oauthEntry = decodeUnifiedStateEntry(Buffer.from(payloadKeys[0]!.valueB64, 'base64').toString('binary'));
  assert.ok(oauthEntry);
  assert.equal(oauthEntry!.sentinelKey, 'oauthTokenInfoSentinelKey');
  const info = decodeOAuthInfo(oauthEntry!.payload);
  assert.ok(info);
  assert.equal(info!.accessToken, makeJwt(B_EMAIL));
  assert.equal(info!.email, B_EMAIL);

  assert.ok(fs.existsSync(path.join(dir, '.switch-worker.js')));
  assert.equal(quitCalls.length, 1, 'IDE quit requested after worker launch');
});

test('performStandaloneIdeSwitch reports worker_spawn_failed without quitting the IDE', async () => {
  const dir = makeTempDir();
  const quitCalls: string[] = [];
  const outcome = await performStandaloneIdeSwitch({
    targetEmail: B_EMAIL,
    ideState: { oauthToken: makeJwt(B_EMAIL) },
    globalStorageDir: dir,
    spawn: () => {
      throw new Error('ENOENT');
    },
    quitIde: () => {
      quitCalls.push('quit');
    },
  });
  assert.deepEqual(outcome, { launched: false, reason: 'worker_spawn_failed' });
  assert.equal(quitCalls.length, 0, 'never quits the IDE when the worker could not start');
  assert.equal(fs.existsSync(path.join(dir, '.switch-payload.json')), false, 'payload (access token) purged on spawn failure');
  assert.equal(fs.existsSync(path.join(dir, '.switch-worker.js')), false, 'worker purged on spawn failure');
});

test('performStandaloneIdeSwitch skips profileUrl when the vault state has none', async () => {
  const dir = makeTempDir();
  const recorder = makeSpawnRecorder();
  await performStandaloneIdeSwitch({
    targetEmail: B_EMAIL,
    ideState: { oauthToken: makeJwt(B_EMAIL) },
    globalStorageDir: dir,
    ideInfo: {
      dataPath: '/data',
      stateDbPath: '/data/User/globalStorage/state.vscdb',
      processName: 'antigravity',
      executablePath: '/usr/bin/antigravity',
    },
    timeouts: { settleMs: 0 },
    waitForResultMs: 0,
    spawn: recorder.spawn,
  });
  const payload = JSON.parse(fs.readFileSync(recorder.calls[0]!.args[1]!, 'utf8')) as { keys: Array<{ key: string }> };
  assert.deepEqual(payload.keys.map((k) => k.key), [OAUTH_TOKEN_STATE_KEY, USER_STATUS_STATE_KEY, ONBOARDING_STATE_KEY]);
});

test('performStandaloneIdeSwitch purges stale scratch files at entry and writes the payload with mode 0600', async () => {
  const dir = makeTempDir();
  const stalePayload = path.join(dir, '.switch-payload.json');
  const staleWorker = path.join(dir, '.switch-worker.js');
  const staleResult = path.join(dir, '.switch-result.json');
  fs.writeFileSync(stalePayload, '{"stale":"old-token"}');
  fs.writeFileSync(staleWorker, 'process.exit(1);');
  fs.writeFileSync(staleResult, '{"ok":false,"stage":"stale"}');
  const recorder = makeSpawnRecorder();
  const outcome = await performStandaloneIdeSwitch({
    targetEmail: B_EMAIL,
    ideState: { oauthToken: makeJwt(B_EMAIL) },
    globalStorageDir: dir,
    ideInfo: {
      dataPath: '/data',
      stateDbPath: '/data/User/globalStorage/state.vscdb',
      processName: 'antigravity',
      executablePath: '/usr/bin/antigravity',
    },
    timeouts: { settleMs: 0 },
    waitForResultMs: 0,
    spawn: recorder.spawn,
  });
  assert.equal(outcome.launched, true);
  assert.equal(fs.existsSync(staleResult), false, 'stale result file removed at entry');
  const fresh = JSON.parse(fs.readFileSync(stalePayload, 'utf8')) as { stale?: string; stateDbPath?: string };
  assert.equal(fresh.stale, undefined, 'stale payload replaced by the fresh one');
  assert.equal(fresh.stateDbPath, '/data/User/globalStorage/state.vscdb');
  // eslint-disable-next-line no-bitwise
  assert.equal(fs.statSync(stalePayload).mode & 0o777, 0o600, 'payload carries the access token: 0600');
});

test('performStandaloneIdeSwitch reports the real worker outcome (success) and purges scratch files', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  await makeStateDb(dbPath, baseFixtureRows());
  const outcome = await performStandaloneIdeSwitch({
    targetEmail: B_EMAIL,
    ideState: { oauthToken: makeJwt(B_EMAIL), profileUrl: 'https://b.example/pic.png' },
    globalStorageDir: dir,
    ideInfo: {
      dataPath: dir,
      stateDbPath: dbPath,
      processName: 'antigravity',
      executablePath: '/nonexistent/antigravity',
    },
    timeouts: { settleMs: 10, waitMs: 50, graceKillMs: 50, forceKillMs: 50 },
    waitForResultMs: 10_000,
    // default spawn: a real detached node process runs the real worker script
  });
  assert.deepEqual(outcome, { launched: true, backupPath: `${dbPath}.bak` }, 'the REAL worker result is surfaced');
  const rows = await readDbRows(dbPath);
  const entry = decodeUnifiedStateEntry(rows.get(OAUTH_TOKEN_STATE_KEY)!.toString('binary'));
  assert.ok(entry);
  assert.equal(decodeOAuthInfo(entry!.payload)!.email, B_EMAIL);
  assert.equal(fs.existsSync(path.join(dir, '.switch-payload.json')), false, 'payload (access token) purged on success');
  assert.equal(fs.existsSync(path.join(dir, '.switch-result.json')), false, 'result file deleted after being read');
});

test('worker restores the .bak copy on write_failed and purges the payload', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  const sqlite = (await import('node:sqlite')) as typeof nodeSqlite;
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    // No ItemTable: every write backend fails, forcing the restore branch.
    db.exec('CREATE TABLE Other (x TEXT)');
  } finally {
    db.close();
  }
  const { status, result } = runWorker(dir, {
    stateDbPath: dbPath,
    keys: newTargetKeys(),
    relaunch: { file: '/nonexistent/antigravity', args: [] },
    processName: 'antigravity',
    platform: process.platform,
    minSettleMs: 10,
    waitTimeoutMs: 50,
    graceKillTimeoutMs: 50,
    forceKillTimeoutMs: 50,
    killEnabled: false,
    resultPath: path.join(dir, '.switch-result.json'),
  });
  assert.equal(status, 1);
  assert.equal(result?.ok, false);
  assert.equal(result?.stage, 'write_failed');
  assert.equal(result?.restored, true, '.bak restored after write/verify failure');
  const restoredDb = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = restoredDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((t) => t.name), ['Other'], 'restored DB matches the pre-switch original');
  } finally {
    restoredDb.close();
  }
  assert.equal(fs.existsSync(path.join(dir, '.switch-payload.json')), false, 'payload purged on the failure path too');
});

test('worker kill escalation runs the injected kill command (term then force) before aborting', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  await makeStateDb(dbPath, baseFixtureRows());
  fs.writeFileSync(`${dbPath}-wal`, Buffer.from([1, 2, 3]), 'binary'); // sidecar never clears
  const killTrace = path.join(dir, 'kill-trace.txt');
  const { status, result } = runWorker(
    dir,
    {
      stateDbPath: dbPath,
      keys: newTargetKeys(),
      relaunch: { file: '/nonexistent/antigravity', args: [] },
      processName: 'antigravity',
      platform: process.platform,
      minSettleMs: 10,
      waitTimeoutMs: 60,
      graceKillTimeoutMs: 60,
      forceKillTimeoutMs: 60,
      killEnabled: true,
      killCommand: { file: '/bin/sh', args: ['-c', 'echo "$1" >> "$GW_KILL_TRACE"', 'sh'] },
      resultPath: path.join(dir, '.switch-result.json'),
    },
    { ...process.env, GW_KILL_TRACE: killTrace },
  );
  assert.equal(status, 1);
  assert.equal(result?.stage, 'wal_timeout');
  assert.equal(fs.existsSync(`${dbPath}.bak`), false, 'no .bak before the sidecars clear');
  assert.equal(fs.readFileSync(killTrace, 'utf8'), 'term\nforce\n', 'graceful kill then force kill, in order');
});

test('worker relaunches the IDE with ELECTRON_RUN_AS_NODE deleted from the environment', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  await makeStateDb(dbPath, baseFixtureRows());
  const envTrace = path.join(dir, 'env-trace.txt');
  const relaunchScript = path.join(dir, 'relaunch.sh');
  fs.writeFileSync(relaunchScript, `#!/bin/sh\nenv > '${envTrace}'\n`, { mode: 0o755 });
  const { status, result } = runWorker(
    dir,
    {
      stateDbPath: dbPath,
      keys: newTargetKeys(),
      relaunch: { file: relaunchScript, args: [] },
      processName: 'antigravity',
      platform: process.platform,
      minSettleMs: 10,
      waitTimeoutMs: 50,
      graceKillTimeoutMs: 50,
      forceKillTimeoutMs: 50,
      killEnabled: false,
      resultPath: path.join(dir, '.switch-result.json'),
    },
    // Simulate the production spawn contract: the worker itself runs Electron-as-node.
    { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  );
  assert.equal(status, 0);
  assert.equal(result?.ok, true);
  const envText = fs.readFileSync(envTrace, 'utf8');
  assert.equal(/^ELECTRON_RUN_AS_NODE=/m.test(envText), false, 'ELECTRON_RUN_AS_NODE deleted for the relaunched IDE');
  assert.ok(/^PATH=/m.test(envText), 'relaunched IDE keeps a usable PATH');
});

// ---------- AccountSwitcher routing ----------

interface SwitcherHarness {
  vaultCalls: string[];
  storeCalls: string[];
  hubCalls: string[];
  performCalls: StandaloneSwitchParams[];
  quitCalls: string[];
  switcher: AccountSwitcher;
}

function validRecordFor(email: string): VaultCredentialRecord {
  return { userName: email, persist: 1, updatedAt: 1, ideState: { oauthToken: makeJwt(email) } };
}

function makeSwitcherHarness(overrides: {
  record?: VaultCredentialRecord | null;
  corruptPurged?: boolean;
  keyringSupported?: boolean;
  applyResult?: { applied: boolean; reason?: string };
  loginOk?: boolean;
  syncOk?: boolean;
  endpoint?: HubEndpoint | null;
  isStandaloneIde?: boolean;
  confirmSwitch?: (email: string) => Promise<boolean> | boolean;
  verifyKeyringSync?: () => Promise<boolean> | boolean;
  performStandaloneIdeSwitch?: (params: StandaloneSwitchParams) => Promise<{ launched: boolean; reason?: string; backupPath?: string }>;
  activeEmail?: string | null;
} = {}): SwitcherHarness {
  const vaultCalls: string[] = [];
  const storeCalls: string[] = [];
  const hubCalls: string[] = [];
  const performCalls: StandaloneSwitchParams[] = [];
  const quitCalls: string[] = [];
  const endpoint = overrides.endpoint === undefined ? ENDPOINT : overrides.endpoint;
  const harness: SwitcherHarness = {
    vaultCalls,
    storeCalls,
    hubCalls,
    performCalls,
    quitCalls,
    switcher: new AccountSwitcher({
      vault: {
        getCredential: async (email: string) => {
          vaultCalls.push(`getCredential:${email}`);
          return { record: overrides.record === undefined ? null : overrides.record, corruptPurged: overrides.corruptPurged ?? false };
        },
        getCapabilities: async () => ({
          secretStorageAvailable: true,
          osKeyringSupported: overrides.keyringSupported ?? false,
          osKeyringBackend: (overrides.keyringSupported ?? false) ? 'linux-secret-tool' : 'none',
          standaloneDbSupported: false,
        }),
        applyToOsKeyring: async (email: string) => {
          vaultCalls.push(`apply:${email}`);
          return overrides.applyResult ?? { applied: true };
        },
        captureActiveCredential: async (email: string) => {
          vaultCalls.push(`capture:${email}`);
          return { captured: true };
        },
      },
      accounts: {
        setStatus: async (email: string, status) => {
          storeCalls.push(`setStatus:${email}:${status}`);
        },
      },
      hubAuth: {
        login: async () => {
          hubCalls.push('login');
          return overrides.loginOk ?? true;
        },
        logout: async () => {
          hubCalls.push('logout');
          return true;
        },
        syncOfficialUi: async () => {
          hubCalls.push('syncOfficialUi');
          return overrides.syncOk ?? true;
        },
      },
      getEndpoint: () => endpoint,
      vscodeApi: { commands: { executeCommand: async () => true } },
      isStandaloneIde: overrides.isStandaloneIde ?? false,
      confirmSwitch: overrides.confirmSwitch,
      performStandaloneIdeSwitch:
        overrides.performStandaloneIdeSwitch ??
        (async (params: StandaloneSwitchParams) => {
          performCalls.push(params);
          await params.quitIde?.();
          return { launched: true };
        }),
      verifyKeyringSync: overrides.verifyKeyringSync,
      getActiveEmail: () => overrides.activeEmail ?? null,
      globalStorageDir: '/tmp/gw-global',
      quitIde: async () => {
        quitCalls.push('quitIde');
      },
      env: { GW_TEST_PARENT_ENV: 'parent-env' },
    }),
  };
  return harness;
}

test('routing 1: standalone IDE + valid vault + confirmation -> performStandaloneIdeSwitch', async () => {
  const confirmCalls: string[] = [];
  const h = makeSwitcherHarness({
    isStandaloneIde: true,
    record: validRecordFor(B_EMAIL),
    confirmSwitch: async (email) => {
      confirmCalls.push(email);
      return true;
    },
  });
  const res = await h.switcher.switchToAccount(` ${B_EMAIL.toUpperCase()} `);
  assert.deepEqual(res, { ok: true, mode: 'standalone-restart', message: 'standalone_switch_launched' });
  assert.deepEqual(confirmCalls, [B_EMAIL]);
  assert.equal(h.performCalls.length, 1);
  assert.equal(h.performCalls[0]!.targetEmail, B_EMAIL);
  assert.equal(h.performCalls[0]!.ideState.oauthToken, makeJwt(B_EMAIL));
  assert.equal(typeof h.performCalls[0]!.quitIde, 'function', 'quitIde passed through to the worker launcher');
  assert.equal(h.performCalls[0]!.env?.GW_TEST_PARENT_ENV, 'parent-env', 'env passed through to the worker launcher');
  assert.deepEqual(h.quitCalls, ['quitIde'], 'the passed quitIde is the one invoked');
  assert.deepEqual(h.hubCalls, [], 'no hub RPC on the standalone path');
  assert.deepEqual(h.storeCalls, [], 'no status change on the standalone path');
});

test('routing 1: a failed standalone worker outcome surfaces as a failed switch (no optimistic ok)', async () => {
  const h = makeSwitcherHarness({
    isStandaloneIde: true,
    record: validRecordFor(B_EMAIL),
    confirmSwitch: async () => true,
    performStandaloneIdeSwitch: async () => ({ launched: false, reason: 'wal_timeout', backupPath: '/data/User/globalStorage/state.vscdb.bak' }),
  });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.deepEqual(res, {
    ok: false,
    mode: 'failed',
    message: 'wal_timeout (backup at /data/User/globalStorage/state.vscdb.bak)',
  });
});

test('routing 1: standalone IDE switch cancelled by the user', async () => {
  const h = makeSwitcherHarness({
    isStandaloneIde: true,
    record: validRecordFor(B_EMAIL),
    confirmSwitch: async () => false,
  });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.deepEqual(res, { ok: false, mode: 'cancelled', message: 'switch_cancelled' });
  assert.equal(h.performCalls.length, 0);
});

test('routing 1: standalone IDE with vault record lacking usable ide state -> needs_reauth + official login', async () => {
  const h = makeSwitcherHarness({
    isStandaloneIde: true,
    record: { userName: B_EMAIL, persist: 1, updatedAt: 1 },
  });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.equal(res.mode, 'official-login');
  assert.ok(res.ok);
  assert.deepEqual(h.storeCalls, [`setStatus:${B_EMAIL}:needs_reauth`]);
  assert.deepEqual(h.hubCalls, ['logout', 'login']);
  assert.equal(h.performCalls.length, 0);
});

test('routing 2: VS Code + valid vault + supported keyring + verified -> applyToOsKeyring then syncOfficialUi', async () => {
  const h = makeSwitcherHarness({
    record: validRecordFor(B_EMAIL),
    keyringSupported: true,
    activeEmail: A_EMAIL,
    verifyKeyringSync: async () => true,
  });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.deepEqual(res, { ok: true, mode: 'keyring-sync' });
  assert.equal(res.requiresReload, undefined);
  assert.ok(h.vaultCalls.includes('capture:a@example.com'), 'current account captured before the keyring write');
  assert.ok(h.vaultCalls.includes('apply:b@example.com'));
  assert.deepEqual(h.hubCalls, ['syncOfficialUi']);
  assert.deepEqual(h.storeCalls, [], 'no needs_reauth on the verified keyring path');
});

test('routing 2: keyring sync with failed UI sync sets requiresReload', async () => {
  const h = makeSwitcherHarness({
    record: validRecordFor(B_EMAIL),
    keyringSupported: true,
    verifyKeyringSync: async () => true,
    syncOk: false,
  });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'keyring-sync');
  assert.equal(res.requiresReload, true);
});

test('routing 2: unverified keyring write falls back to official login (never assumed)', async () => {
  const h = makeSwitcherHarness({
    record: validRecordFor(B_EMAIL),
    keyringSupported: true,
    verifyKeyringSync: async () => false,
  });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.equal(res.mode, 'official-login');
  assert.ok(res.ok);
  assert.deepEqual(h.hubCalls, ['logout', 'login']);
  assert.equal(h.hubCalls.includes('syncOfficialUi'), false);
});

test('routing 2: no verifier available -> keyring write skipped entirely, official login', async () => {
  const h = makeSwitcherHarness({
    record: validRecordFor(B_EMAIL),
    keyringSupported: true,
  });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.equal(res.mode, 'official-login');
  assert.equal(h.vaultCalls.includes('apply:b@example.com'), false, 'never clobbers the keyring with an unverified payload');
  assert.deepEqual(h.hubCalls, ['logout', 'login']);
});

test('routing 3: linux without secret-tool -> official logout + login, keyring untouched', async () => {
  const h = makeSwitcherHarness({ record: validRecordFor(B_EMAIL), keyringSupported: false });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'official-login');
  assert.deepEqual(h.hubCalls, ['logout', 'login']);
  assert.equal(h.vaultCalls.includes('apply:b@example.com'), false);
  assert.deepEqual(h.storeCalls, [], 'valid vault is not marked needs_reauth');
});

test('routing 3: missing vault -> needs_reauth + official logout + login', async () => {
  const h = makeSwitcherHarness({ record: null, corruptPurged: false });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.equal(res.mode, 'official-login');
  assert.ok(res.ok);
  assert.deepEqual(h.storeCalls, [`setStatus:${B_EMAIL}:needs_reauth`]);
  assert.deepEqual(h.hubCalls, ['logout', 'login']);
});

test('routing 3: corrupt (purged) vault -> needs_reauth + official logout + login', async () => {
  const h = makeSwitcherHarness({ record: null, corruptPurged: true });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.equal(res.mode, 'official-login');
  assert.deepEqual(h.storeCalls, [`setStatus:${B_EMAIL}:needs_reauth`]);
  assert.deepEqual(h.hubCalls, ['logout', 'login']);
});

test('routing 3: hub unreachable -> official-login mode fails cleanly without RPC', async () => {
  const h = makeSwitcherHarness({ record: null, corruptPurged: true, endpoint: null });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.deepEqual(res, { ok: false, mode: 'official-login', message: 'no_valid_vault_credential: hub_unreachable' });
  assert.deepEqual(h.hubCalls, []);
});

test('routing 3: official login refused -> ok:false', async () => {
  const h = makeSwitcherHarness({ record: null, loginOk: false });
  const res = await h.switcher.switchToAccount(B_EMAIL);
  assert.equal(res.ok, false);
  assert.equal(res.mode, 'official-login');
  assert.deepEqual(h.hubCalls, ['logout', 'login']);
});

test('addAccountViaOfficialLogin triggers the official login and reports the observed email', async () => {
  const h = makeSwitcherHarness({ activeEmail: 'new@example.com' });
  const res = await h.switcher.addAccountViaOfficialLogin();
  assert.deepEqual(res, { ok: true, email: 'new@example.com' });
  assert.deepEqual(h.hubCalls, ['login']);
});

test('addAccountViaOfficialLogin without a hub reports failure', async () => {
  const h = makeSwitcherHarness({ endpoint: null });
  const res = await h.switcher.addAccountViaOfficialLogin();
  assert.deepEqual(res, { ok: false, message: 'hub_unreachable' });
});

test('reauthAccount marks needs_reauth and runs the official logout + login cycle', async () => {
  const h = makeSwitcherHarness({});
  const res = await h.switcher.reauthAccount(` ${A_EMAIL.toUpperCase()} `);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(h.storeCalls, [`setStatus:${A_EMAIL}:needs_reauth`]);
  assert.deepEqual(h.hubCalls, ['logout', 'login']);
});
