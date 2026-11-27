import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as nodeSqlite from 'node:sqlite';

import {
  createTokenVaultDeps,
  createKeyringVerifier,
  readKeyringEntry,
  resolveCommandPath,
} from '../src/accounts/vaultWiring.ts';
import {
  TokenVaultService,
  type SecretStorageAdapter,
  type VaultCredentialRecord,
  type VaultExecFileAsync,
} from '../src/accounts/tokenVaultService.ts';
import {
  encodeUnifiedUserStatus,
} from '../src/accounts/protobufSync.ts';
import {
  USER_STATUS_STATE_KEY,
} from '../src/accounts/ideStateService.ts';

// ---------- fixtures / helpers ----------

const A_EMAIL = 'a@example.com';
const TOKEN = 'raw-credential-token-abc123';

class MockSecrets implements SecretStorageAdapter {
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

interface ExecCall {
  file: string;
  args: string[];
}

function execRecorder(stdoutByFile: Record<string, string | Error> = {}): {
  calls: ExecCall[];
  execFileAsync: VaultExecFileAsync;
} {
  const calls: ExecCall[] = [];
  const execFileAsync: VaultExecFileAsync = async (file, args) => {
    calls.push({ file, args: [...args] });
    const outcome = stdoutByFile[file];
    if (outcome instanceof Error) {
      throw outcome;
    }
    return { stdout: outcome ?? '', stderr: '' };
  };
  return { calls, execFileAsync };
}

let tmpSeq = 0;
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gw-wiring-${Date.now()}-${tmpSeq++}-`));
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

// ---------- createTokenVaultDeps: the production wiring shape (C1) ----------

test('deps factory constructed the way extension.ts does reports a supported keyring when which resolves', async () => {
  const { calls, execFileAsync } = execRecorder({ sh: '/usr/bin/secret-tool\n' });
  const service = new TokenVaultService(
    createTokenVaultDeps({
      secrets: new MockSecrets(),
      platform: 'linux',
      execFileAsync,
      isStandaloneIde: false,
      standaloneStateDbPath: null,
    }),
  );
  const caps = await service.getCapabilities();
  assert.equal(caps.osKeyringSupported, true, 'a wired which must surface the real keyring backend');
  assert.equal(caps.osKeyringBackend, 'linux-secret-tool');
  assert.equal(caps.standaloneDbSupported, false, 'plain VS Code host has no standalone DB reader');
  // PATH-aware resolution without a shell string: fixed sh script, command as $1.
  assert.equal(calls[0]!.file, 'sh');
  assert.deepEqual(calls[0]!.args, ['-c', 'command -v "$1"', 'sh', 'secret-tool']);
});

test('deps factory: capture with no readIdeState returns ide_state_unavailable without throwing', async () => {
  const { execFileAsync } = execRecorder();
  const service = new TokenVaultService(
    createTokenVaultDeps({
      secrets: new MockSecrets(),
      platform: 'linux',
      execFileAsync,
      isStandaloneIde: false,
      standaloneStateDbPath: null,
    }),
  );
  const result = await service.captureActiveCredential(A_EMAIL);
  assert.deepEqual(result, { captured: false, reason: 'ide_state_unavailable' });
});

test('deps factory: standalone IDE with an existing state.vscdb wires the real auth-state reader', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'state.vscdb');
  await makeStateDb(dbPath, [
    { key: USER_STATUS_STATE_KEY, value: Buffer.from(encodeUnifiedUserStatus(A_EMAIL), 'binary') },
  ]);
  const { execFileAsync } = execRecorder({ sh: '/usr/bin/secret-tool\n' });
  const secrets = new MockSecrets();
  const service = new TokenVaultService(
    createTokenVaultDeps({
      secrets,
      platform: 'linux',
      execFileAsync,
      isStandaloneIde: true,
      standaloneStateDbPath: dbPath,
    }),
  );
  const caps = await service.getCapabilities();
  assert.equal(caps.standaloneDbSupported, true);
  const captured = await service.captureActiveCredential(A_EMAIL);
  assert.deepEqual(captured, { captured: true }, 'capture reads the real standalone IDE state.vscdb');
  assert.ok(secrets.map.size > 0, 'credential written to SecretStorage');
});

test('deps factory: standalone IDE with a missing state.vscdb omits readIdeState (clean, no crash)', async () => {
  const dir = makeTempDir();
  const { execFileAsync } = execRecorder();
  const service = new TokenVaultService(
    createTokenVaultDeps({
      secrets: new MockSecrets(),
      platform: 'linux',
      execFileAsync,
      isStandaloneIde: true,
      standaloneStateDbPath: path.join(dir, 'missing.vscdb'),
    }),
  );
  const caps = await service.getCapabilities();
  assert.equal(caps.standaloneDbSupported, false, 'missing DB must not claim standalone support');
  const result = await service.captureActiveCredential(A_EMAIL);
  assert.deepEqual(result, { captured: false, reason: 'ide_state_unavailable' });
});

test('resolveCommandPath returns the absolute path, or null when the command is absent', async () => {
  const found = execRecorder({ sh: '/usr/bin/security\n' });
  assert.equal(await resolveCommandPath('security', 'darwin', found.execFileAsync), '/usr/bin/security');

  const missing = execRecorder({ sh: '' });
  assert.equal(await resolveCommandPath('security', 'darwin', missing.execFileAsync), null);

  const failing = execRecorder({ sh: new Error('ENOENT') });
  assert.equal(await resolveCommandPath('secret-tool', 'linux', failing.execFileAsync), null);

  const win = execRecorder({ where: 'C:\\Tools\\cmd.exe\r\nC:\\Other\\cmd.exe\r\n' });
  assert.equal(await resolveCommandPath('security', 'win32', win.execFileAsync), 'C:\\Tools\\cmd.exe');
});

// ---------- readKeyringEntry + createKeyringVerifier (I2) ----------

function recordWithIdeState(): VaultCredentialRecord {
  return { userName: A_EMAIL, persist: 1, updatedAt: 1, ideState: { oauthToken: TOKEN } };
}

function recordWithBlob(): VaultCredentialRecord {
  return {
    userName: A_EMAIL,
    blobBase64: Buffer.from(TOKEN, 'utf8').toString('base64'),
    persist: 1,
    updatedAt: 1,
  };
}

test('readKeyringEntry strips only the reader trailing newline and fails closed', async () => {
  const darwin = execRecorder({ security: `${TOKEN}\n` });
  assert.equal(await readKeyringEntry('darwin', darwin.execFileAsync, A_EMAIL), TOKEN);

  const linux = execRecorder({ 'secret-tool': `${TOKEN}\n` });
  assert.equal(await readKeyringEntry('linux', linux.execFileAsync, A_EMAIL), TOKEN);
  assert.deepEqual(linux.calls[0]!.args, ['lookup', 'service', 'gemini:antigravity', 'account', A_EMAIL]);

  const failing = execRecorder({ security: new Error('entry not found') });
  assert.equal(await readKeyringEntry('darwin', failing.execFileAsync, A_EMAIL), null);

  // Windows CredMan has no reader yet: null keeps the switch on the official-login fallback.
  assert.equal(await readKeyringEntry('win32', execRecorder().execFileAsync, A_EMAIL), null);
});

function makeVerifierHarness(overrides: {
  platform?: NodeJS.Platform;
  record?: VaultCredentialRecord | null;
  readerStdout?: string | Error;
  targetEmail?: string | null;
} = {}): { verifier: () => Promise<boolean>; readerCalls: ExecCall[] } {
  const record = overrides.record === undefined ? recordWithIdeState() : overrides.record;
  const { calls, execFileAsync } = execRecorder(
    overrides.readerStdout instanceof Error
      ? { security: overrides.readerStdout, 'secret-tool': overrides.readerStdout }
      : {
          security: `${overrides.readerStdout ?? TOKEN}\n`,
          'secret-tool': `${overrides.readerStdout ?? TOKEN}\n`,
        },
  );
  const verifier = createKeyringVerifier({
    platform: overrides.platform ?? 'linux',
    execFileAsync,
    getCredential: async () => ({ record }),
    getTargetEmail: () => overrides.targetEmail === undefined ? A_EMAIL : overrides.targetEmail,
  });
  return { verifier, readerCalls: calls };
}

test('keyring verifier byte-compares the re-read secret against the written payload', async () => {
  const h = makeVerifierHarness({ platform: 'linux' });
  assert.equal(await h.verifier(), true);
  assert.deepEqual(h.readerCalls[0]!.args, ['lookup', 'service', 'gemini:antigravity', 'account', A_EMAIL]);
});

test('keyring verifier rejects a stale/different non-empty entry (was fail-open before I2)', async () => {
  const h = makeVerifierHarness({ platform: 'linux', readerStdout: 'stale-secret-from-an-old-switch' });
  assert.equal(await h.verifier(), false, 'non-empty stdout alone must never verify');
});

test('keyring verifier rejects an empty re-read', async () => {
  const h = makeVerifierHarness({ platform: 'linux', readerStdout: '' });
  assert.equal(await h.verifier(), false);
});

test('keyring verifier fails closed on reader failure, no target, or missing record', async () => {
  const failing = makeVerifierHarness({ platform: 'darwin', readerStdout: new Error('boom') });
  assert.equal(await failing.verifier(), false);

  const noTarget = makeVerifierHarness({ targetEmail: null });
  assert.equal(await noTarget.verifier(), false);
  assert.equal(noTarget.readerCalls.length, 0);

  const noRecord = makeVerifierHarness({ record: null });
  assert.equal(await noRecord.verifier(), false);
  assert.equal(noRecord.readerCalls.length, 0);
});

test('keyring verifier accepts a blobBase64-only record: the re-read raw token matches the decoded payload', async () => {
  const h = makeVerifierHarness({ platform: 'darwin', record: recordWithBlob() });
  assert.equal(await h.verifier(), true, 'blobBase64 must decode to the same raw payload (I3 canonical form)');
});
