import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TokenVaultService,
  extractEmailFromCredentialBlob,
  extractEmailFromIdeState,
  extractEmailFromJwt,
  TOKEN_VAULT_INDEX_KEY,
  tokenKeyFor,
  type SecretStorageAdapter,
  type VaultCredentialRecord,
  type VaultExecFileAsync,
  type VaultIdeState,
  type VaultReadIdeState,
  type VaultWhich,
} from '../src/accounts/tokenVaultService.ts';

// ---------- fixtures / helpers ----------

const A_EMAIL = 'a@example.com';
const B_EMAIL = 'b@example.com';

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function makeJwt(email: string | null): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(email === null ? { sub: '123' } : { sub: '123', email }));
  return `${header}.${payload}.sig`;
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

class MockSecrets implements SecretStorageAdapter {
  readonly map = new Map<string, string>();
  readonly storedKeys: string[] = [];
  readonly deletedKeys: string[] = [];

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    this.storedKeys.push(key);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
    this.deletedKeys.push(key);
  }

  /** Sets raw values directly (simulates records written outside the guard). */
  seed(key: string, value: string): void {
    this.map.set(key, value);
  }
}

interface Harness {
  secrets: MockSecrets;
  execCalls: Array<{ file: string; args: string[]; options?: { env?: Record<string, string>; input?: string } }>;
  whichMap: Map<string, string | null>;
  ideState: VaultIdeState | null;
  service: TokenVaultService;
}

function makeService(overrides: {
  platform?: NodeJS.Platform;
  ideState?: VaultIdeState | null;
  which?: Record<string, string | null>;
  readIdeState?: VaultReadIdeState | null;
} = {}): Harness {
  const secrets = new MockSecrets();
  const execCalls: Harness['execCalls'] = [];
  const execFileAsync: VaultExecFileAsync = async (file, args, options) => {
    execCalls.push({ file, args: [...args], options });
    return { stdout: '', stderr: '' };
  };
  const whichMap = new Map(Object.entries(overrides.which ?? {}));
  const which: VaultWhich = async (cmd) => (whichMap.has(cmd) ? whichMap.get(cmd)! : `${overrides.platform ?? 'linux'}-path/${cmd}`);
  const ideState = overrides.ideState === undefined ? null : overrides.ideState;
  const readIdeState: VaultReadIdeState | null =
    overrides.readIdeState === null ? null : (overrides.readIdeState ?? (async () => ideState));
  const service = new TokenVaultService({
    secrets,
    platform: overrides.platform ?? 'linux',
    execFileAsync,
    which,
    ...(readIdeState ? { readIdeState } : {}),
  });
  return { secrets, execCalls, whichMap, ideState, service };
}

function ideStateFor(email: string, extra: Partial<VaultIdeState> = {}): VaultIdeState {
  return { oauthToken: makeJwt(email), ...extra };
}

// ---------- extractors ----------

test('extractEmailFromJwt decodes a standard payload', () => {
  assert.equal(extractEmailFromJwt(makeJwt('Dev@Example.COM')), 'dev@example.com');
});

test('extractEmailFromJwt returns null for malformed or email-less tokens', () => {
  assert.equal(extractEmailFromJwt('not-a-jwt'), null);
  assert.equal(extractEmailFromJwt('a.b'), null);
  assert.equal(extractEmailFromJwt(makeJwt(null)), null);
  assert.equal(extractEmailFromJwt(''), null);
});

test('extractEmailFromCredentialBlob reads a base64 JSON credential with email', () => {
  const blob = base64Json({ access_token: 'x', email: '  User@Example.COM  ' });
  assert.equal(extractEmailFromCredentialBlob(blob), 'user@example.com');
});

test('extractEmailFromCredentialBlob reads a nested user.email', () => {
  const blob = base64Json({ user: { email: 'nested@example.com' } });
  assert.equal(extractEmailFromCredentialBlob(blob), 'nested@example.com');
});

test('extractEmailFromCredentialBlob handles a base64-encoded JWT blob', () => {
  const blob = Buffer.from(makeJwt('jwtblob@example.com'), 'utf8').toString('base64');
  assert.equal(extractEmailFromCredentialBlob(blob), 'jwtblob@example.com');
});

test('extractEmailFromCredentialBlob scans raw bytes for an email (protobuf-ish)', () => {
  const raw = '...\x00user@proto.example.org\x00rest';
  const blob = Buffer.from(raw, 'latin1').toString('base64');
  assert.equal(extractEmailFromCredentialBlob(blob), 'user@proto.example.org');
});

test('extractEmailFromCredentialBlob returns null without any email', () => {
  assert.equal(extractEmailFromCredentialBlob(base64Json({ foo: 'bar' })), null);
  assert.equal(extractEmailFromCredentialBlob('!!!not-base64-json!!!'), null);
  assert.equal(extractEmailFromCredentialBlob(''), null);
});

test('extractEmailFromIdeState reads userStatus JSON email first', () => {
  const ideState: VaultIdeState = {
    userStatus: JSON.stringify({ userStatus: { email: 'Status@Example.COM' } }),
    oauthToken: makeJwt(B_EMAIL),
  };
  assert.equal(extractEmailFromIdeState(ideState), 'status@example.com');
});

test('extractEmailFromIdeState falls back to oauthToken JWT then JSON blob', () => {
  assert.equal(extractEmailFromIdeState({ oauthToken: makeJwt(B_EMAIL) }), B_EMAIL);
  const ideState: VaultIdeState = {
    oauthToken: base64Json({ email: 'blob@example.com' }),
  };
  assert.equal(extractEmailFromIdeState(ideState), 'blob@example.com');
});

test('extractEmailFromIdeState returns null when nothing carries an email', () => {
  assert.equal(extractEmailFromIdeState({ profileUrl: 'https://example.com/u/1' }), null);
  assert.equal(extractEmailFromIdeState({}), null);
});

// ---------- capture + anti-contamination guard ----------

test('captureActiveCredential stores a matching credential and updates the index', async () => {
  const h = makeService({ ideState: ideStateFor(A_EMAIL) });
  const result = await h.service.captureActiveCredential(` ${A_EMAIL.toUpperCase()} `);
  assert.deepEqual(result, { captured: true });
  const stored = h.secrets.map.get(tokenKeyFor(A_EMAIL));
  assert.ok(stored, 'token secret key written');
  const record = JSON.parse(stored!) as VaultCredentialRecord;
  assert.equal(record.userName, A_EMAIL);
  assert.ok(record.updatedAt > 0);
  assert.ok(record.ideState?.oauthToken);
  assert.deepEqual(await h.service.listVaultedEmails(), [A_EMAIL]);
  const index = JSON.parse(h.secrets.map.get(TOKEN_VAULT_INDEX_KEY)!) as string[];
  assert.deepEqual(index, [A_EMAIL]);
});

test('captureActiveCredential rejects a mismatched-email credential and writes nothing', async () => {
  const h = makeService({ ideState: ideStateFor(B_EMAIL) });
  const result = await h.service.captureActiveCredential(A_EMAIL);
  assert.deepEqual(result, { captured: false, reason: 'email_mismatch' });
  assert.equal(h.secrets.map.size, 0, 'nothing written to SecretStorage');
  assert.equal(h.secrets.storedKeys.length, 0);
});

test('captureActiveCredential rejects an unverifiable credential (no embedded email)', async () => {
  const h = makeService({ ideState: { profileUrl: 'https://example.com' } });
  const result = await h.service.captureActiveCredential(A_EMAIL);
  assert.deepEqual(result, { captured: false, reason: 'unverifiable_credential' });
  assert.equal(h.secrets.map.size, 0);
});

test('captureActiveCredential reports missing active credential', async () => {
  const h = makeService({ ideState: null });
  const result = await h.service.captureActiveCredential(A_EMAIL);
  assert.deepEqual(result, { captured: false, reason: 'no_active_credential' });
});

test('captureActiveCredential without a readIdeState reader is unsupported', async () => {
  const h = makeService({ readIdeState: null });
  const result = await h.service.captureActiveCredential(A_EMAIL);
  assert.deepEqual(result, { captured: false, reason: 'ide_state_unavailable' });
});

test('getCredential returns a stored matching record without purging', async () => {
  const h = makeService({ ideState: ideStateFor(A_EMAIL) });
  await h.service.captureActiveCredential(A_EMAIL);
  const { record, corruptPurged } = await h.service.getCredential(A_EMAIL);
  assert.equal(corruptPurged, false);
  assert.ok(record);
  assert.equal(record!.userName, A_EMAIL);
  assert.deepEqual(await h.service.listVaultedEmails(), [A_EMAIL]);
});

test('getCredential purges a stored record whose embedded email mismatches', async () => {
  const h = makeService({});
  const corrupt: VaultCredentialRecord = {
    userName: A_EMAIL,
    persist: 1,
    updatedAt: 1,
    ideState: ideStateFor(B_EMAIL),
  };
  h.secrets.seed(tokenKeyFor(A_EMAIL), JSON.stringify(corrupt));
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL]));
  const { record, corruptPurged } = await h.service.getCredential(A_EMAIL);
  assert.equal(corruptPurged, true);
  assert.equal(record, null);
  assert.equal(h.secrets.map.has(tokenKeyFor(A_EMAIL)), false, 'token key deleted');
  assert.deepEqual(await h.service.listVaultedEmails(), [], 'index entry removed');
});

test('getCredential purges an unverifiable stored record and unparsable JSON', async () => {
  const h = makeService({});
  h.secrets.seed(tokenKeyFor(A_EMAIL), JSON.stringify({ userName: A_EMAIL, persist: 1, updatedAt: 1 }));
  h.secrets.seed(tokenKeyFor(B_EMAIL), '{not json');
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL, B_EMAIL]));
  const noEmbed = await h.service.getCredential(A_EMAIL);
  assert.deepEqual(noEmbed, { record: null, corruptPurged: true });
  const unparsable = await h.service.getCredential(B_EMAIL);
  assert.deepEqual(unparsable, { record: null, corruptPurged: true });
  assert.deepEqual(await h.service.listVaultedEmails(), []);
});

test('getCredential returns null without purging for an unknown email', async () => {
  const h = makeService({});
  const result = await h.service.getCredential(A_EMAIL);
  assert.deepEqual(result, { record: null, corruptPurged: false });
});

// ---------- capabilities ----------

test('capabilities: win32 reports the PowerShell CredMan backend', async () => {
  const h = makeService({ platform: 'win32', readIdeState: null });
  const caps = await h.service.getCapabilities();
  assert.equal(caps.secretStorageAvailable, true);
  assert.equal(caps.osKeyringSupported, true);
  assert.equal(caps.osKeyringBackend, 'wincred');
  assert.equal(caps.standaloneDbSupported, false);
});

test('capabilities: darwin reports the macOS keychain backend when security exists', async () => {
  const h = makeService({ platform: 'darwin', which: { security: '/usr/bin/security' } });
  const caps = await h.service.getCapabilities();
  assert.equal(caps.osKeyringSupported, true);
  assert.equal(caps.osKeyringBackend, 'macos-keychain');
});

test('capabilities: darwin without security degrades to none', async () => {
  const h = makeService({ platform: 'darwin', which: { security: null } });
  const caps = await h.service.getCapabilities();
  assert.deepEqual(
    { supported: caps.osKeyringSupported, backend: caps.osKeyringBackend },
    { supported: false, backend: 'none' },
  );
});

test('capabilities: linux with secret-tool is supported', async () => {
  const h = makeService({ platform: 'linux', which: { 'secret-tool': '/usr/bin/secret-tool' } });
  const caps = await h.service.getCapabilities();
  assert.equal(caps.osKeyringSupported, true);
  assert.equal(caps.osKeyringBackend, 'linux-secret-tool');
});

test('capabilities: linux without secret-tool reports none and never throws', async () => {
  const h = makeService({ platform: 'linux', which: { 'secret-tool': null } });
  const caps = await h.service.getCapabilities();
  assert.equal(caps.osKeyringSupported, false);
  assert.equal(caps.osKeyringBackend, 'none');
  h.secrets.seed(
    tokenKeyFor(A_EMAIL),
    JSON.stringify({ userName: A_EMAIL, blobBase64: base64Json({ email: A_EMAIL }), persist: 1, updatedAt: 1 }),
  );
  assert.deepEqual(await h.service.applyToOsKeyring(A_EMAIL), { applied: false, reason: 'keyring_unsupported' });
});

test('capabilities: standaloneDbSupported reflects an injected standalone DB reader', async () => {
  const h = makeService({ platform: 'linux', which: { 'secret-tool': null } });
  const caps = await h.service.getCapabilities();
  assert.equal(caps.standaloneDbSupported, true);
});

// ---------- OS keyring adapters ----------

test('win32 apply passes the secret via env/stdin, never via argv', async () => {
  const h = makeService({ platform: 'win32', readIdeState: null });
  // Seed the vault directly so adapter tests do not depend on readIdeState.
  const secretJson = JSON.stringify({ email: A_EMAIL, access_token: 'SECRET-TOKEN-123' });
  const record: VaultCredentialRecord = {
    userName: A_EMAIL,
    blobBase64: Buffer.from(secretJson, 'utf8').toString('base64'),
    persist: 1,
    updatedAt: 1,
  };
  h.secrets.seed(tokenKeyFor(A_EMAIL), JSON.stringify(record));
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL]));

  const result = await h.service.applyToOsKeyring(A_EMAIL);
  assert.deepEqual(result, { applied: true });
  assert.equal(h.execCalls.length, 1);
  const call = h.execCalls[0]!;
  assert.equal(call.file, 'powershell.exe');
  const joinedArgs = call.args.join(' ');
  assert.ok(!joinedArgs.includes('SECRET-TOKEN-123'), 'secret never in argv');
  assert.ok(!joinedArgs.includes('a@example.com'), 'username kept out of argv too');
  assert.equal(call.options?.env?.GW_VAULT_SECRET, record.blobBase64, 'secret passed via env');
  assert.ok(!JSON.stringify(call).includes('SECRET-TOKEN-123'), 'plaintext token never passed around');
});

test('darwin apply uses security add-generic-password with stdin secret', async () => {
  const h = makeService({ platform: 'darwin', readIdeState: null });
  const record: VaultCredentialRecord = {
    userName: A_EMAIL,
    blobBase64: base64Json({ email: A_EMAIL, access_token: 'SECRET-TOKEN-456' }),
    persist: 1,
    updatedAt: 1,
  };
  h.secrets.seed(tokenKeyFor(A_EMAIL), JSON.stringify(record));
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL]));

  const result = await h.service.applyToOsKeyring(A_EMAIL);
  assert.deepEqual(result, { applied: true });
  const call = h.execCalls[0]!;
  assert.equal(call.file, 'security');
  assert.equal(call.args[0], 'add-generic-password');
  assert.ok(!call.args.some((a) => a.includes('SECRET-TOKEN-456')), 'secret never in argv');
  assert.equal(call.options?.input, record.blobBase64, 'secret passed via stdin');
});

test('linux apply uses secret-tool store with stdin secret', async () => {
  const h = makeService({ platform: 'linux', which: { 'secret-tool': '/usr/bin/secret-tool' }, readIdeState: null });
  const record: VaultCredentialRecord = {
    userName: A_EMAIL,
    blobBase64: base64Json({ email: A_EMAIL, access_token: 'SECRET-TOKEN-789' }),
    persist: 1,
    updatedAt: 1,
  };
  h.secrets.seed(tokenKeyFor(A_EMAIL), JSON.stringify(record));
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL]));

  const result = await h.service.applyToOsKeyring(A_EMAIL);
  assert.deepEqual(result, { applied: true });
  const call = h.execCalls[0]!;
  assert.equal(call.file, 'secret-tool');
  assert.equal(call.args[0], 'store');
  assert.ok(call.args.includes('gemini:antigravity'));
  assert.ok(!call.args.some((a) => a.includes('SECRET-TOKEN-789')), 'secret never in argv');
  assert.equal(call.options?.input, record.blobBase64, 'secret passed via stdin');
});

test('applyToOsKeyring refuses when the vault credential is missing', async () => {
  const h = makeService({ platform: 'win32', readIdeState: null });
  const result = await h.service.applyToOsKeyring(A_EMAIL);
  assert.deepEqual(result, { applied: false, reason: 'no_vaulted_credential' });
  assert.equal(h.execCalls.length, 0);
});

test('applyToOsKeyring refuses when the stored credential is corrupt', async () => {
  const h = makeService({ platform: 'win32', readIdeState: null });
  const corrupt: VaultCredentialRecord = {
    userName: A_EMAIL,
    persist: 1,
    updatedAt: 1,
    ideState: ideStateFor(B_EMAIL),
  };
  h.secrets.seed(tokenKeyFor(A_EMAIL), JSON.stringify(corrupt));
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL]));
  const result = await h.service.applyToOsKeyring(A_EMAIL);
  assert.deepEqual(result, { applied: false, reason: 'no_vaulted_credential' });
  assert.equal(h.execCalls.length, 0);
});

// ---------- delete / clearAll ----------

test('deleteCredential removes the token key and index entry', async () => {
  const h = makeService({ ideState: ideStateFor(A_EMAIL) });
  await h.service.captureActiveCredential(A_EMAIL);
  await h.service.deleteCredential(` ${A_EMAIL.toUpperCase()} `);
  assert.equal(h.secrets.map.has(tokenKeyFor(A_EMAIL)), false);
  assert.deepEqual(await h.service.listVaultedEmails(), []);
});

test('purge survives a transient throwing index write without a ghost entry', async () => {
  const h = makeService({ readIdeState: null });
  for (const email of [A_EMAIL, B_EMAIL]) {
    h.secrets.seed(
      tokenKeyFor(email),
      JSON.stringify({ userName: email, blobBase64: base64Json({ email }), persist: 1, updatedAt: 1 }),
    );
  }
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL, B_EMAIL]));
  // Flaky SecretStorage: the first index write during purge throws.
  let indexStoreCalls = 0;
  const originalStore = h.secrets.store.bind(h.secrets);
  h.secrets.store = async (key, value) => {
    if (key === TOKEN_VAULT_INDEX_KEY) {
      indexStoreCalls += 1;
      if (indexStoreCalls === 1) {
        throw new Error('transient SecretStorage failure');
      }
    }
    await originalStore(key, value);
  };

  await h.service.deleteCredential(A_EMAIL);
  assert.equal(indexStoreCalls, 2, 'index write retried once');
  assert.deepEqual(await h.service.listVaultedEmails(), [B_EMAIL], 'no ghost index entry for the purged email');
  assert.equal(h.secrets.map.has(tokenKeyFor(A_EMAIL)), false, 'token key deleted');
  assert.equal(h.secrets.map.has(tokenKeyFor(B_EMAIL)), true, 'other entries intact');
});

test('purge with a persistently throwing index write fails before deleting the token key', async () => {
  const h = makeService({ readIdeState: null });
  h.secrets.seed(
    tokenKeyFor(A_EMAIL),
    JSON.stringify({ userName: A_EMAIL, blobBase64: base64Json({ email: A_EMAIL }), persist: 1, updatedAt: 1 }),
  );
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL]));
  h.secrets.store = async (key) => {
    if (key === TOKEN_VAULT_INDEX_KEY) {
      throw new Error('persistent SecretStorage failure');
    }
  };

  await assert.rejects(h.service.deleteCredential(A_EMAIL), /persistent SecretStorage failure/);
  // Index-first ordering: nothing deleted, state stays consistent and retryable.
  assert.deepEqual(await h.service.listVaultedEmails(), [A_EMAIL]);
  assert.equal(h.secrets.map.has(tokenKeyFor(A_EMAIL)), true);
});

test('clearAll removes every vaulted token and the index', async () => {
  const h = makeService({ ideState: ideStateFor(A_EMAIL) });
  await h.service.captureActiveCredential(A_EMAIL);
  h.secrets.seed(
    tokenKeyFor(B_EMAIL),
    JSON.stringify({ userName: B_EMAIL, blobBase64: base64Json({ email: B_EMAIL }), persist: 1, updatedAt: 1 }),
  );
  h.secrets.seed(TOKEN_VAULT_INDEX_KEY, JSON.stringify([A_EMAIL, B_EMAIL]));
  assert.equal((await h.service.listVaultedEmails()).length, 2);
  await h.service.clearAll();
  assert.equal(h.secrets.map.size, 0);
  assert.deepEqual(await h.service.listVaultedEmails(), []);
});
