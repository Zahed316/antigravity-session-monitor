/**
 * Production wiring for the credential vault and its keyring verifier.
 * Extracted from src/extension.ts so the production dep shape is testable
 * under plain node:test (branch-review C1: the vault was constructed without
 * execFileAsync/which/readIdeState, leaving capture, switching, and keyring
 * diagnostics dead in production).
 */
import fs from 'node:fs';

import {
  KEYRING_SERVICE,
  keyringPayloadFor,
  type SecretStorageAdapter,
  type TokenVaultDeps,
  type VaultCredentialRecord,
  type VaultExecFileAsync,
  type VaultReadIdeState,
  type VaultWhich,
} from './tokenVaultService.ts';
import { readStandaloneIdeAuthState } from './ideStateService.ts';

/**
 * Resolves a command to an absolute PATH location, or null when absent.
 * PATH-aware, array args only — no shell string interpolation, ever.
 */
export async function resolveCommandPath(
  cmd: string,
  platform: NodeJS.Platform,
  execFileAsync: VaultExecFileAsync,
): Promise<string | null> {
  try {
    if (platform === 'win32') {
      // `where` is a real executable; it prints absolute paths, one per line.
      const { stdout } = await execFileAsync('where', [cmd]);
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
      return first ?? null;
    }
    // POSIX `command -v` is a shell builtin: run it with the command passed
    // as a positional parameter so the shell script stays fixed and secret-free.
    const { stdout } = await execFileAsync('sh', ['-c', 'command -v "$1"', 'sh', cmd]);
    const resolved = stdout.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
    return resolved.startsWith('/') ? resolved : null;
  } catch {
    return null;
  }
}

export interface CreateTokenVaultDepsParams {
  secrets: SecretStorageAdapter;
  platform: NodeJS.Platform;
  execFileAsync: VaultExecFileAsync;
  /** True only on the Antigravity standalone IDE host. */
  isStandaloneIde: boolean;
  /** Standalone IDE `state.vscdb` path; null when not resolvable. */
  standaloneStateDbPath: string | null;
  now?: () => number;
}

/**
 * Builds the full TokenVaultService deps the way extension.ts must: a real
 * PATH-aware `which`, and `readIdeState` only when the standalone IDE's
 * state.vscdb exists. Plain VS Code hosts keep `readIdeState` omitted, which
 * surfaces as a clean `ide_state_unavailable` (no VS Code credential reader
 * exists yet — its absence must stay quiet, not crash).
 */
export function createTokenVaultDeps(params: CreateTokenVaultDepsParams): TokenVaultDeps {
  const whichCache = new Map<string, Promise<string | null>>();
  const which: VaultWhich = (cmd) => {
    let cached = whichCache.get(cmd);
    if (!cached) {
      cached = resolveCommandPath(cmd, params.platform, params.execFileAsync);
      whichCache.set(cmd, cached);
    }
    return cached;
  };
  let readIdeState: VaultReadIdeState | null = null;
  if (params.isStandaloneIde && params.standaloneStateDbPath && fs.existsSync(params.standaloneStateDbPath)) {
    const stateDbPath = params.standaloneStateDbPath;
    readIdeState = () => readStandaloneIdeAuthState(stateDbPath);
  }
  return {
    secrets: params.secrets,
    platform: params.platform,
    execFileAsync: params.execFileAsync,
    which,
    ...(readIdeState ? { readIdeState } : {}),
    ...(params.now ? { now: params.now } : {}),
  };
}

/**
 * Re-reads the OS keyring entry for the service/account pair. Returns the
 * secret with the reader's single trailing newline stripped (macOS `security`
 * and Linux `secret-tool` echo one), or null when unreadable. Windows CredMan
 * has no reader yet: null keeps the switch on the official-login fallback
 * instead of trusting an unverified write.
 */
export async function readKeyringEntry(
  platform: NodeJS.Platform,
  execFileAsync: VaultExecFileAsync,
  userName: string,
): Promise<string | null> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password', '-s', KEYRING_SERVICE, '-a', userName, '-w',
      ]);
      return stdout.replace(/\n$/, '');
    }
    if (platform === 'linux') {
      const { stdout } = await execFileAsync('secret-tool', [
        'lookup', 'service', KEYRING_SERVICE, 'account', userName,
      ]);
      return stdout.replace(/\n$/, '');
    }
  } catch {
    return null;
  }
  return null;
}

export interface CreateKeyringVerifierParams {
  platform: NodeJS.Platform;
  execFileAsync: VaultExecFileAsync;
  getCredential(email: string): Promise<{ record: VaultCredentialRecord | null }>;
  getTargetEmail(): string | null;
}

/**
 * Builds the AccountSwitcher `verifyKeyringSync` dep: the re-read keyring
 * secret must byte-match the exact payload that was written (keyringPayloadFor
 * of the vault record). A stale or differently-encoded entry never verifies —
 * only a trailing newline is stripped, which is what the reader tools add.
 */
export function createKeyringVerifier(params: CreateKeyringVerifierParams): () => Promise<boolean> {
  return async () => {
    const target = params.getTargetEmail();
    if (!target) {
      return false;
    }
    let record: VaultCredentialRecord | null = null;
    try {
      ({ record } = await params.getCredential(target));
    } catch {
      return false;
    }
    if (!record) {
      return false;
    }
    const expected = keyringPayloadFor(record);
    if (!expected) {
      return false;
    }
    const actual = await readKeyringEntry(params.platform, params.execFileAsync, record.userName);
    return actual !== null && actual === expected;
  };
}
