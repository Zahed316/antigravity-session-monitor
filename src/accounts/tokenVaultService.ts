/** Minimal surface of `vscode.SecretStorage` (thenables accepted). */
export interface SecretStorageAdapter {
  get(key: string): Promise<string | undefined> | string | undefined;
  store(key: string, value: string): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface VaultIdeState {
  oauthToken?: string;
  userStatus?: string;
  profileUrl?: string;
}

export interface VaultCredentialRecord {
  userName: string;
  blobBase64?: string;
  persist: number;
  updatedAt: number;
  ideState?: VaultIdeState;
}

export type VaultExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: { env?: Record<string, string>; input?: string },
) => Promise<{ stdout: string; stderr: string }>;

export type VaultReadIdeState = () => Promise<VaultIdeState | null> | VaultIdeState | null;

export type VaultWhich = (cmd: string) => Promise<string | null> | string | null;

export interface TokenVaultDeps {
  secrets: SecretStorageAdapter;
  platform: NodeJS.Platform;
  execFileAsync?: VaultExecFileAsync;
  readIdeState?: VaultReadIdeState;
  which?: VaultWhich;
  now?: () => number;
}

export interface VaultCapabilities {
  secretStorageAvailable: boolean;
  osKeyringSupported: boolean;
  osKeyringBackend: 'wincred' | 'macos-keychain' | 'linux-secret-tool' | 'none';
  standaloneDbSupported: boolean;
}

export const TOKEN_VAULT_INDEX_KEY = 'gravitywatch.vault.index';
export const TOKEN_KEY_PREFIX = 'gravitywatch.vault.token.';

/** OS keyring target used by Antigravity in VS Code / Cursor hosts. */
const KEYRING_SERVICE = 'gemini:antigravity';

export function tokenKeyFor(email: string): string {
  return `${TOKEN_KEY_PREFIX}${normalizeEmail(email)}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

function b64urlDecode(segment: string): string | null {
  try {
    return Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

function emailFromParsedJson(obj: Record<string, unknown>): string | null {
  const candidates = [obj.email, (obj.user as Record<string, unknown> | undefined)?.email];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && EMAIL_RE.test(candidate)) {
      return normalizeEmail(candidate);
    }
  }
  return null;
}

function emailFromLooseString(raw: string): string | null {
  const match = EMAIL_RE.exec(raw);
  return match ? normalizeEmail(match[0]) : null;
}

function looksLikeJwt(raw: string): boolean {
  return raw.split('.').length === 3 && raw.includes('eyJ');
}

/**
 * Extracts the normalized embedded email from a JWT payload (`email` claim),
 * or null when the token is malformed / carries no email.
 */
export function extractEmailFromJwt(jwt: string): string | null {
  const parts = jwt.split('.');
  if (parts.length < 2) {
    return null;
  }
  const payloadRaw = b64urlDecode(parts[1]!);
  if (payloadRaw === null) {
    return null;
  }
  const payload = parseJsonObject(payloadRaw);
  if (!payload) {
    return null;
  }
  if (typeof payload.email === 'string' && payload.email.trim() !== '') {
    return normalizeEmail(payload.email);
  }
  return null;
}

/**
 * Extracts the embedded email from a base64 credential blob: JSON credential,
 * plain JWT, or raw bytes carrying an email (e.g. protobuf-ish payloads).
 */
export function extractEmailFromCredentialBlob(blobBase64: string): string | null {
  if (!blobBase64) {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(blobBase64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const trimmed = decoded.trim();
  if (looksLikeJwt(trimmed)) {
    const fromJwt = extractEmailFromJwt(trimmed);
    if (fromJwt) {
      return fromJwt;
    }
  }
  const asJson = parseJsonObject(trimmed);
  if (asJson) {
    const fromJson = emailFromParsedJson(asJson);
    if (fromJson) {
      return fromJson;
    }
  }
  return emailFromLooseString(decoded);
}

/**
 * Extracts the embedded email from a standalone-IDE state snapshot:
 * `userStatus` JSON first, then the `oauthToken` (JWT, JSON credential, raw).
 */
export function extractEmailFromIdeState(ideState: VaultIdeState): string | null {
  const { userStatus, oauthToken } = ideState;
  if (userStatus) {
    const status = parseJsonObject(userStatus);
    if (status) {
      const inner =
        status.userStatus && typeof status.userStatus === 'object'
          ? (status.userStatus as Record<string, unknown>)
          : status;
      const fromStatus = emailFromParsedJson(inner) ?? emailFromParsedJson(status);
      if (fromStatus) {
        return fromStatus;
      }
    } else {
      const fromLoose = emailFromLooseString(userStatus);
      if (fromLoose) {
        return fromLoose;
      }
    }
  }
  if (oauthToken) {
    const trimmed = oauthToken.trim();
    if (looksLikeJwt(trimmed)) {
      const fromJwt = extractEmailFromJwt(trimmed);
      if (fromJwt) {
        return fromJwt;
      }
    }
    const fromBase64 = extractEmailFromCredentialBlob(trimmed);
    if (fromBase64) {
      return fromBase64;
    }
    const asJson = parseJsonObject(trimmed);
    if (asJson) {
      const fromJson = emailFromParsedJson(asJson);
      if (fromJson) {
        return fromJson;
      }
    }
    const fromLoose = emailFromLooseString(trimmed);
    if (fromLoose) {
      return fromLoose;
    }
  }
  return null;
}

/**
 * Verifies a credential record's embedded identity against the target email.
 * 'ok' = every extractable email matches; 'mismatch' = contamination, must
 * purge; 'unverifiable' = no extractable identity — never trusted, purged on read.
 */
function verifyRecord(record: VaultCredentialRecord, normalizedEmail: string): 'ok' | 'mismatch' | 'unverifiable' {
  const emails: string[] = [];
  if (record.blobBase64) {
    const fromBlob = extractEmailFromCredentialBlob(record.blobBase64);
    if (fromBlob) {
      emails.push(fromBlob);
    }
  }
  if (record.ideState) {
    const fromIdeState = extractEmailFromIdeState(record.ideState);
    if (fromIdeState) {
      emails.push(fromIdeState);
    }
  }
  if (emails.length === 0) {
    return 'unverifiable';
  }
  return emails.every((e) => e === normalizedEmail) ? 'ok' : 'mismatch';
}

const WIN32_CREDMAN_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$secret = $env:GW_VAULT_SECRET',
  '$user = $env:GW_VAULT_USER',
  "if (-not $secret) { throw 'GW_VAULT_SECRET not set' }",
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class GwCredMan {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct CREDENTIAL {',
  '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
  '    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
  '  }',
  '  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);',
  '}',
  '"@',
  '$bytes = [System.Text.Encoding]::Unicode.GetBytes($secret)',
  '$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([int]$bytes.Length)',
  'try {',
  '  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)',
  '  $cred = New-Object GwCredMan+CREDENTIAL',
  '  $cred.Type = 1',
  "  $cred.TargetName = 'gemini:antigravity'",
  '  $cred.UserName = $user',
  '  $cred.CredentialBlobSize = [uint32]$bytes.Length',
  '  $cred.CredentialBlob = $ptr',
  '  $cred.Persist = 2',
  '  if (-not [GwCredMan]::CredWrite([ref]$cred, 0)) { throw "CredWrite failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
  '} finally {',
  '  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)',
  '}',
].join('\n');

function keyringPayloadFor(record: VaultCredentialRecord): string {
  return record.blobBase64 ?? record.ideState?.oauthToken ?? '';
}

export class TokenVaultService {
  private readonly secrets: SecretStorageAdapter;
  private readonly platform: NodeJS.Platform;
  private readonly execFileAsync: VaultExecFileAsync | null;
  private readonly readIdeState: VaultReadIdeState | null;
  private readonly which: VaultWhich;
  private readonly now: () => number;

  constructor(deps: TokenVaultDeps) {
    this.secrets = deps.secrets;
    this.platform = deps.platform;
    this.execFileAsync = deps.execFileAsync ?? null;
    this.readIdeState = deps.readIdeState ?? null;
    this.which = deps.which ?? (async () => null);
    this.now = deps.now ?? Date.now;
  }

  async getCapabilities(): Promise<VaultCapabilities> {
    let backend: VaultCapabilities['osKeyringBackend'] = 'none';
    if (this.platform === 'win32') {
      // PowerShell + Advapi32 CredMan ships with every supported Windows host.
      backend = 'wincred';
    } else if (this.platform === 'darwin') {
      backend = (await this.resolveWhich('security')) ? 'macos-keychain' : 'none';
    } else if (this.platform === 'linux') {
      backend = (await this.resolveWhich('secret-tool')) ? 'linux-secret-tool' : 'none';
    }
    return {
      secretStorageAvailable: this.secrets !== null && this.secrets !== undefined,
      osKeyringSupported: backend !== 'none',
      osKeyringBackend: backend,
      standaloneDbSupported: this.readIdeState !== null,
    };
  }

  async listVaultedEmails(): Promise<string[]> {
    // The index is the sole source of truth for vaulted accounts: an orphaned
    // token key without an index entry is benign and never listed here.
    const raw = await this.secrets.get(TOKEN_VAULT_INDEX_KEY);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((e): e is string => typeof e === 'string' && e.trim() !== '');
    } catch {
      return [];
    }
  }

  /**
   * Reads and verifies the vaulted credential. A record whose embedded email
   * mismatches (or cannot be verified at all) is purged immediately and
   * reported as `corruptPurged` — it is never returned to callers.
   */
  async getCredential(email: string): Promise<{ record: VaultCredentialRecord | null; corruptPurged: boolean }> {
    const normalized = normalizeEmail(email);
    const raw = await this.secrets.get(tokenKeyFor(normalized));
    if (!raw) {
      return { record: null, corruptPurged: false };
    }
    let record: VaultCredentialRecord | null = null;
    try {
      const parsed = JSON.parse(raw) as VaultCredentialRecord;
      if (parsed && typeof parsed === 'object' && typeof parsed.userName === 'string') {
        record = parsed;
      }
    } catch {
      record = null;
    }
    if (!record || verifyRecord(record, normalized) !== 'ok') {
      await this.purge(normalized);
      return { record: null, corruptPurged: true };
    }
    return { record, corruptPurged: false };
  }

  /**
   * Captures the currently active credential (via the injected IDE state
   * reader) into SecretStorage after verifying its embedded email matches the
   * target account. A mismatched or unverifiable credential is never written.
   */
  async captureActiveCredential(
    email: string,
    _options?: { isStandaloneIde?: boolean },
  ): Promise<{ captured: boolean; reason?: string }> {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      return { captured: false, reason: 'invalid_email' };
    }
    if (!this.readIdeState) {
      return { captured: false, reason: 'ide_state_unavailable' };
    }
    let ideState: VaultIdeState | null = null;
    try {
      ideState = (await this.readIdeState()) ?? null;
    } catch {
      ideState = null;
    }
    if (!ideState) {
      return { captured: false, reason: 'no_active_credential' };
    }
    const embedded = extractEmailFromIdeState(ideState);
    if (!embedded) {
      return { captured: false, reason: 'unverifiable_credential' };
    }
    if (embedded !== normalized) {
      return { captured: false, reason: 'email_mismatch' };
    }
    const record: VaultCredentialRecord = {
      userName: normalized,
      ...(ideState.oauthToken ? { blobBase64: Buffer.from(ideState.oauthToken, 'utf8').toString('base64') } : {}),
      persist: 1,
      updatedAt: this.now(),
      ideState,
    };
    await this.secrets.store(tokenKeyFor(normalized), JSON.stringify(record));
    const index = await this.listVaultedEmails();
    if (!index.includes(normalized)) {
      index.push(normalized);
      await this.secrets.store(TOKEN_VAULT_INDEX_KEY, JSON.stringify(index));
    }
    return { captured: true };
  }

  /**
   * Writes the vaulted credential to the host OS keyring (`gemini:antigravity`).
   * Secrets travel via stdin or environment variables only — never argv.
   */
  async applyToOsKeyring(email: string): Promise<{ applied: boolean; reason?: string }> {
    const normalized = normalizeEmail(email);
    const { record } = await this.getCredential(normalized);
    if (!record) {
      return { applied: false, reason: 'no_vaulted_credential' };
    }
    const caps = await this.getCapabilities();
    if (!caps.osKeyringSupported) {
      return { applied: false, reason: 'keyring_unsupported' };
    }
    if (!this.execFileAsync) {
      return { applied: false, reason: 'exec_unavailable' };
    }
    const secret = keyringPayloadFor(record);
    // Keyring byte-encoding contract for the Task 7 writer (same logical
    // string, per-platform storage): Windows CredMan stores UTF-16LE bytes;
    // macOS `security` and Linux `secret-tool` store UTF-8/ASCII.
    if (!secret) {
      return { applied: false, reason: 'empty_credential' };
    }
    try {
      if (this.platform === 'win32') {
        await this.execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '-'],
          {
            env: { GW_VAULT_SECRET: secret, GW_VAULT_USER: record.userName },
            input: WIN32_CREDMAN_SCRIPT,
          },
        );
      } else if (this.platform === 'darwin') {
        // `-w` with no value makes `security` read the password from stdin.
        await this.execFileAsync(
          'security',
          ['add-generic-password', '-U', '-s', KEYRING_SERVICE, '-a', record.userName, '-w'],
          { input: secret },
        );
      } else {
        // secret-tool reads the secret from stdin; attributes stay in argv.
        await this.execFileAsync(
          'secret-tool',
          ['store', '--label=GravityWatch', 'service', KEYRING_SERVICE, 'account', record.userName],
          { input: secret },
        );
      }
    } catch {
      return { applied: false, reason: 'keyring_write_failed' };
    }
    return { applied: true };
  }

  async deleteCredential(email: string): Promise<void> {
    await this.purge(normalizeEmail(email));
  }

  async clearAll(): Promise<void> {
    // Only index-listed entries are cleared: SecretStorage has no key scan,
    // so an orphaned token key from a failed capture-index write survives
    // clearAll. That orphan is benign per the listVaultedEmails contract and
    // is re-purged by email via deleteCredential/getCredential.
    const emails = await this.listVaultedEmails();
    for (const email of emails) {
      await this.secrets.delete(tokenKeyFor(email));
    }
    await this.secrets.delete(TOKEN_VAULT_INDEX_KEY);
  }

  /**
   * Removes a token key and its index entry (guard + explicit deletes).
   * The index is rewritten BEFORE the token key delete, unconditionally, so a
   * failed index write leaves a consistent retryable state (index + token both
   * intact) and a failure after it only orphans a benign token key — a ghost
   * index entry (email listed, record gone) can never be created.
   */
  private async purge(normalizedEmail: string): Promise<void> {
    const index = await this.listVaultedEmails();
    const next = index.filter((e) => e !== normalizedEmail);
    try {
      await this.secrets.store(TOKEN_VAULT_INDEX_KEY, JSON.stringify(next));
    } catch {
      // Transient SecretStorage failures must not leave a ghost index entry.
      await this.secrets.store(TOKEN_VAULT_INDEX_KEY, JSON.stringify(next));
    }
    await this.secrets.delete(tokenKeyFor(normalizedEmail));
  }

  private async resolveWhich(cmd: string): Promise<string | null> {
    try {
      return (await this.which(cmd)) ?? null;
    } catch {
      return null;
    }
  }
}
