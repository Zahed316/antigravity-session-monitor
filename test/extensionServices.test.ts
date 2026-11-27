import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createCoreServices } from '../src/extensionServices.ts';
import type { SecretStorageAdapter } from '../src/accounts/tokenVaultService.ts';

function fakeSecrets(store = new Map<string, string>()): SecretStorageAdapter {
  return {
    get: async (k) => store.get(k),
    store: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
}

function baseDeps() {
  return {
    secrets: fakeSecrets(),
    globalState: { get: <T,>(_k: string) => undefined as T | undefined, update: async () => {} },
    globalStorageDir: '/tmp/gravitywatch-test',
    platform: 'darwin' as NodeJS.Platform,
    execFileAsync: async () => ({ stdout: '/usr/local/bin/secret-tool\n', stderr: '' }),
    isStandaloneIde: false,
    standaloneIdeInfo: null,
    workspacePaths: [],
    env: {},
    getActiveEmail: () => null,
    confirmSwitch: async () => true,
    quitIde: async () => {},
    getPendingKeyringTarget: () => null,
    getEndpoint: () => null,
  };
}

describe('createCoreServices', () => {
  it('builds a vault whose capture capability reflects a resolvable keyring tool (the C1 regression)', async () => {
    const services = await createCoreServices(baseDeps());
    const caps = await services.vaultService.getCapabilities();
    assert.equal(caps.osKeyringSupported, true, 'which() must be wired, not left null');
  });

  it('builds a vault that reports capture unavailable, not thrown, on a plain host', async () => {
    const services = await createCoreServices(baseDeps());
    const result = await services.vaultService.captureActiveCredential('a@example.com');
    assert.deepEqual(result, { captured: false, reason: 'ide_state_unavailable' });
  });

  it('reads the pending keyring target lazily, at verify time', async () => {
    // A target set only after construction must be visible: catches the factory
    // freezing the value at null instead of holding the closure.
    let target: string | null = null;
    let reads = 0;
    const services = await createCoreServices({
      ...baseDeps(),
      getPendingKeyringTarget: () => { reads++; return target; },
    });
    assert.equal(await services.verifyKeyringSync(), false, 'no pending target: fails closed');
    assert.equal(reads, 1, 'the target is read on each verify, not captured at construction');
    target = 'a@example.com';
    assert.equal(await services.verifyKeyringSync(), false, 'target pending but nothing stored: still closed');
    assert.equal(reads, 2, 'a target set after construction is still consulted');
  });

  it('returns every service the extension needs (no undefined members)', async () => {
    const services = await createCoreServices(baseDeps());
    for (const key of ['accountStore', 'historyStore', 'vaultService', 'switcher', 'alertService', 'hubClient', 'hubAuthClient'] as const) {
      assert.ok(services[key], `${key} must be constructed`);
    }
  });

  it('activate() constructs no services in its own body (the C1 seam must stay the only construction site)', () => {
    // npm test always runs from the repo root; import.meta is banned by the CJS tsconfig.
    const src = readFileSync(path.resolve('src', 'extension.ts'), 'utf8');
    // Scan the whole file, not the tail: a constructor moved into a helper defined
    // above activate() would otherwise escape this guard.
    for (const ctor of ['new TokenVaultService', 'new AccountSwitcher', 'new AccountStore', 'new QuotaHistoryStore']) {
      assert.equal(src.includes(ctor), false, `${ctor} belongs in extensionServices.ts`);
    }
    const body = src.slice(src.indexOf('export async function activate'));
    assert.ok(body.includes('createCoreServices('), 'activate() must delegate construction to the factory');
  });
});
