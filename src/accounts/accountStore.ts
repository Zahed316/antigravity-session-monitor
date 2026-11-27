import nodeFs from 'node:fs/promises';
import nodePath from 'node:path';

import type { AccountAuthStatus, AccountIdentity, ManagedAccount, QuotaSnapshot } from '../types.ts';

export const ACCOUNTS_STATE_KEY = 'antigravityMonitor.accounts.v1';
export const SNAPSHOT_FILE_NAME = 'account-snapshots.json';
export const BACKUP_SCHEMA = 'gravitywatch.accounts.backup.v1';

/** Minimal surface of `vscode.ExtensionContext#globalState` (thenables accepted). */
export interface GlobalStateAdapter {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void> | void;
}

export interface AccountSnapshotRecord {
  email: string;
  snapshot: QuotaSnapshot;
  updatedAt: number;
}

export interface AccountStoreDeps {
  globalState: GlobalStateAdapter;
  globalStorageUri: string;
  fs?: Pick<typeof nodeFs, 'mkdir' | 'readFile' | 'writeFile' | 'rename'>;
  path?: Pick<typeof nodePath, 'join'>;
  now?: () => number;
}

interface SnapshotFile {
  version: 1;
  snapshots: AccountSnapshotRecord[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AccountStore {
  private readonly globalState: GlobalStateAdapter;
  private readonly globalStorageUri: string;
  private readonly fs: AccountStoreDeps['fs'];
  private readonly path: AccountStoreDeps['path'];
  private readonly now: () => number;
  private accounts: ManagedAccount[] = [];
  private snapshots: Map<string, AccountSnapshotRecord> = new Map();

  constructor(deps: AccountStoreDeps) {
    this.globalState = deps.globalState;
    this.globalStorageUri = deps.globalStorageUri;
    this.fs = deps.fs ?? nodeFs;
    this.path = deps.path ?? nodePath;
    this.now = deps.now ?? Date.now;
  }

  async load(): Promise<void> {
    this.accounts = this.globalState.get<ManagedAccount[]>(ACCOUNTS_STATE_KEY) ?? [];
    this.snapshots = new Map();
    const file = this.path!.join(this.globalStorageUri, SNAPSHOT_FILE_NAME);
    let raw: string;
    try {
      raw = await this.fs!.readFile(file, 'utf8');
    } catch {
      return; // Missing or unreadable snapshot cache: start empty.
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SnapshotFile>;
      for (const record of parsed.snapshots ?? []) {
        if (record && typeof record.email === 'string' && record.snapshot) {
          this.snapshots.set(normalizeEmail(record.email), { ...record, email: normalizeEmail(record.email) });
        }
      }
    } catch {
      // Corrupt snapshot cache is disposable telemetry cache: ignore, keep registry.
    }
  }

  async upsertSeenAccount(identity: AccountIdentity, isActive: boolean, nowIso?: string): Promise<ManagedAccount> {
    const email = normalizeEmail(identity.email);
    const seenAt = nowIso ?? new Date(this.now()).toISOString();
    const existing = this.accounts.find((a) => a.email === email);
    let account: ManagedAccount;
    if (existing) {
      existing.displayName = identity.displayName ?? existing.displayName;
      existing.tier = identity.tier ?? existing.tier;
      existing.plan = identity.plan ?? existing.plan;
      existing.isPro = identity.isPro ?? existing.isPro;
      existing.profilePictureUrl = identity.profilePictureUrl ?? existing.profilePictureUrl;
      existing.lastSeenAt = seenAt;
      if (isActive) {
        existing.status = 'active';
      } else if (existing.status === 'active') {
        existing.status = 'saved';
      }
      account = existing;
    } else {
      account = {
        email,
        displayName: identity.displayName,
        tier: identity.tier,
        plan: identity.plan,
        isPro: identity.isPro,
        profilePictureUrl: identity.profilePictureUrl,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        status: isActive ? 'active' : 'saved',
      };
      this.accounts.push(account);
    }
    await this.persistAccounts();
    return account;
  }

  async updateMetadata(
    email: string,
    patch: { label?: string; group?: string; colorTag?: string },
  ): Promise<ManagedAccount | null> {
    const account = this.accounts.find((a) => a.email === normalizeEmail(email));
    if (!account) {
      return null;
    }
    if (patch.label !== undefined) {
      account.label = patch.label;
    }
    if (patch.group !== undefined) {
      account.group = patch.group;
    }
    if (patch.colorTag !== undefined) {
      account.colorTag = patch.colorTag;
    }
    await this.persistAccounts();
    return account;
  }

  async setStatus(email: string, status: AccountAuthStatus): Promise<void> {
    const account = this.accounts.find((a) => a.email === normalizeEmail(email));
    if (!account) {
      return;
    }
    account.status = status;
    await this.persistAccounts();
  }

  async removeAccount(
    email: string,
    activeEmail: string | null,
  ): Promise<{ removed: boolean; reason?: 'active_account' | 'not_found' }> {
    const normalized = normalizeEmail(email);
    if (activeEmail !== null && normalized === normalizeEmail(activeEmail)) {
      return { removed: false, reason: 'active_account' };
    }
    const idx = this.accounts.findIndex((a) => a.email === normalized);
    if (idx === -1) {
      return { removed: false, reason: 'not_found' };
    }
    this.accounts.splice(idx, 1);
    if (this.snapshots.delete(normalized)) {
      await this.persistSnapshots();
    }
    await this.persistAccounts();
    return { removed: true };
  }

  async saveSnapshot(email: string, snapshot: QuotaSnapshot): Promise<void> {
    const normalized = normalizeEmail(email);
    this.snapshots.set(normalized, { email: normalized, snapshot, updatedAt: this.now() });
    await this.persistSnapshots();
  }

  getSnapshot(email: string, isActive: boolean, nowMs?: number): QuotaSnapshot | null {
    const record = this.snapshots.get(normalizeEmail(email));
    if (!record) {
      return null;
    }
    // Inactive accounts with a passed reset window are stale, never optimistically
    // clamped to 100% (design rule 2.1): keep the last recorded remainingPct.
    if (isActive) {
      return record.snapshot;
    }
    const now = nowMs ?? this.now();
    let stale = false;
    for (const pool of Object.values(record.snapshot.pools)) {
      for (const window of [pool.fiveHour, pool.weekly]) {
        if (!window?.resetTime) {
          continue;
        }
        const resetMs = Date.parse(window.resetTime);
        if (!Number.isNaN(resetMs) && resetMs <= now) {
          stale = true;
          break;
        }
      }
      if (stale) {
        break;
      }
    }
    return stale ? { ...record.snapshot, isStale: true } : record.snapshot;
  }

  listAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  /** Metadata-only export: identity + local metadata, never snapshots or credentials. */
  exportBackupJson(): string {
    const accounts = this.accounts.map((a) => ({
      email: a.email,
      displayName: a.displayName,
      tier: a.tier,
      plan: a.plan,
      isPro: a.isPro,
      profilePictureUrl: a.profilePictureUrl,
      label: a.label,
      group: a.group,
      colorTag: a.colorTag,
      firstSeenAt: a.firstSeenAt,
      lastSeenAt: a.lastSeenAt,
      status: a.status,
    }));
    return JSON.stringify({ schema: BACKUP_SCHEMA, exportedAt: new Date(this.now()).toISOString(), accounts });
  }

  async importBackupJson(rawJson: string): Promise<{ imported: number; skipped: number }> {
    const parsed = JSON.parse(rawJson) as { schema?: string; accounts?: Array<Partial<ManagedAccount>> };
    if (parsed.schema !== BACKUP_SCHEMA || !Array.isArray(parsed.accounts)) {
      throw new Error(`Unsupported backup schema: expected ${BACKUP_SCHEMA}`);
    }
    let imported = 0;
    let skipped = 0;
    for (const entry of parsed.accounts) {
      const email = typeof entry?.email === 'string' ? normalizeEmail(entry.email) : '';
      if (!email) {
        skipped += 1;
        continue;
      }
      const existing = this.accounts.find((a) => a.email === email);
      if (existing) {
        // Local metadata wins; only fill in what is unset locally.
        existing.label = existing.label ?? entry.label;
        existing.group = existing.group ?? entry.group;
        existing.colorTag = existing.colorTag ?? entry.colorTag;
        existing.displayName = existing.displayName ?? entry.displayName;
        existing.plan = existing.plan ?? entry.plan;
      } else {
        this.accounts.push({
          email,
          displayName: entry.displayName,
          tier: entry.tier,
          plan: entry.plan,
          isPro: entry.isPro,
          profilePictureUrl: entry.profilePictureUrl,
          label: entry.label,
          group: entry.group,
          colorTag: entry.colorTag,
          firstSeenAt: typeof entry.firstSeenAt === 'string' ? entry.firstSeenAt : new Date(this.now()).toISOString(),
          lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : new Date(this.now()).toISOString(),
          // 'active' is runtime state for a specific install; imports never claim it.
          status: entry.status === 'needs_reauth' ? 'needs_reauth' : 'saved',
        });
      }
      imported += 1;
    }
    if (imported > 0) {
      await this.persistAccounts();
    }
    return { imported, skipped };
  }

  private async persistAccounts(): Promise<void> {
    await this.globalState.update(ACCOUNTS_STATE_KEY, this.accounts);
  }

  private async persistSnapshots(): Promise<void> {
    const file = this.path!.join(this.globalStorageUri, SNAPSHOT_FILE_NAME);
    const tmp = `${file}.tmp`;
    const payload: SnapshotFile = { version: 1, snapshots: [...this.snapshots.values()] };
    await this.fs!.mkdir(this.globalStorageUri, { recursive: true });
    await this.fs!.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await this.fs!.rename(tmp, file);
  }
}
