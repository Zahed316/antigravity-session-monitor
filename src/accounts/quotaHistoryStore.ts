import nodeFs from 'node:fs/promises';
import nodePath from 'node:path';

import type { ManagedAccount, PoolKey, QuotaSnapshot } from '../types.ts';

export const HISTORY_FILE_NAME = 'quota-history.json';
export const ANALYTICS_SCHEMA = 'gravitywatch.analytics.v1';

export const HISTORY_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface DailyPoolQuotaRecord {
  date: string;
  email: string;
  poolKey: PoolKey;
  fiveHourLowestPct: number | null;
  weeklyLowestPct: number | null;
  updatedAt: number;
}

export interface QuotaHistoryStoreDeps {
  fs?: Pick<typeof nodeFs, 'readFile' | 'writeFile' | 'rename' | 'mkdir'>;
  path?: Pick<typeof nodePath, 'join'>;
  now?: () => number;
}

interface HistoryFile {
  version: 1;
  records: DailyPoolQuotaRecord[];
}

function utcDayBucket(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function csvCell(value: string): string {
  // M5: neutralize spreadsheet formula prefixes — label/group are free user text.
  const neutralized = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  // Quote only when needed, doubling embedded quotes per RFC 4180.
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

export class QuotaHistoryStore {
  private readonly storagePath: string;
  private readonly fs: QuotaHistoryStoreDeps['fs'];
  private readonly path: QuotaHistoryStoreDeps['path'];
  private readonly now: () => number;
  private records: DailyPoolQuotaRecord[] = [];
  private dirty = false;

  constructor(globalStorageUri: string, deps: QuotaHistoryStoreDeps = {}) {
    this.storagePath = globalStorageUri;
    this.fs = deps.fs ?? nodeFs;
    this.path = deps.path ?? nodePath;
    this.now = deps.now ?? Date.now;
  }

  async load(): Promise<void> {
    this.records = [];
    const file = this.path!.join(this.storagePath, HISTORY_FILE_NAME);
    let raw: string;
    try {
      raw = await this.fs!.readFile(file, 'utf8');
    } catch {
      return; // Missing history file: start empty.
    }
    this.dirty = false;
    try {
      const parsed = JSON.parse(raw) as Partial<HistoryFile>;
      if (!Array.isArray(parsed.records)) {
        return;
      }
      const cutoff = this.now() - HISTORY_RETENTION_DAYS * DAY_MS;
      this.records = parsed.records.filter(
        (r) => r && typeof r.email === 'string' && (r.poolKey === 'gemini' || r.poolKey === 'nonGoogle') && typeof r.updatedAt === 'number' && r.updatedAt >= cutoff,
      );
    } catch {
      // Corrupt history is disposable analytics cache: ignore, start empty.
    }
  }

  async recordSnapshot(email: string, snapshot: QuotaSnapshot, nowMs?: number): Promise<void> {
    if (snapshot.isStale || snapshot.status !== 'online') {
      return;
    }
    const updatedAt = nowMs ?? this.now();
    this.prune(updatedAt);
    for (const poolKey of ['gemini', 'nonGoogle'] as const) {
      const pool = snapshot.pools[poolKey];
      if (!pool) {
        continue;
      }
      const fiveHour = pool.fiveHour?.remainingPct;
      const weekly = pool.weekly?.remainingPct;
      const fiveHourLowestPct = typeof fiveHour === 'number' ? fiveHour : null;
      const weeklyLowestPct = typeof weekly === 'number' ? weekly : null;
      if (fiveHourLowestPct === null && weeklyLowestPct === null) {
        continue;
      }
      const date = utcDayBucket(updatedAt);
      const existing = this.records.find((r) => r.date === date && r.email === email && r.poolKey === poolKey);
      if (existing) {
        existing.updatedAt = updatedAt;
        if (fiveHourLowestPct !== null) {
          existing.fiveHourLowestPct = existing.fiveHourLowestPct === null ? fiveHourLowestPct : Math.min(existing.fiveHourLowestPct, fiveHourLowestPct);
        }
        if (weeklyLowestPct !== null) {
          existing.weeklyLowestPct = existing.weeklyLowestPct === null ? weeklyLowestPct : Math.min(existing.weeklyLowestPct, weeklyLowestPct);
        }
      } else {
        this.records.push({ date, email, poolKey, fiveHourLowestPct, weeklyLowestPct, updatedAt });
      }
      this.dirty = true;
    }
    await this.flushIfDirty();
  }

  getHistory(options?: { email?: string; days?: number; nowMs?: number }): DailyPoolQuotaRecord[] {
    const now = options?.nowMs ?? this.now();
    let out = this.records;
    if (options?.email !== undefined) {
      out = out.filter((r) => r.email === options.email);
    }
    if (options?.days !== undefined) {
      const cutoff = now - options.days * DAY_MS;
      out = out.filter((r) => r.updatedAt >= cutoff);
    }
    return [...out];
  }

  exportCsv(accounts: ReadonlyMap<string, ManagedAccount>, days?: number, nowMs?: number): string {
    const header = 'date,email,label,group,poolKey,fiveHourLowestPct,weeklyLowestPct,updatedAt';
    const lines = [header];
    for (const r of this.filteredForExport(days, nowMs)) {
      const account = accounts.get(r.email);
      lines.push(
        [
          r.date,
          csvCell(r.email),
          csvCell(account?.label ?? ''),
          csvCell(account?.group ?? ''),
          r.poolKey,
          r.fiveHourLowestPct === null ? '' : String(r.fiveHourLowestPct),
          r.weeklyLowestPct === null ? '' : String(r.weeklyLowestPct),
          String(r.updatedAt),
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  exportJson(accounts: ReadonlyMap<string, ManagedAccount>, days?: number, nowMs?: number): string {
    const exportedAt = new Date(nowMs ?? this.now()).toISOString();
    const records = this.filteredForExport(days, nowMs).map((r) => {
      const account = accounts.get(r.email);
      return {
        ...r,
        label: account?.label ?? '',
        group: account?.group ?? '',
      };
    });
    return JSON.stringify({ schema: ANALYTICS_SCHEMA, exportedAt, records });
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    const file = this.path!.join(this.storagePath, HISTORY_FILE_NAME);
    const tmp = `${file}.tmp`;
    const payload: HistoryFile = { version: 1, records: this.records };
    await this.fs!.mkdir(this.storagePath, { recursive: true });
    await this.fs!.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await this.fs!.rename(tmp, file);
    this.dirty = false;
  }

  private async flushIfDirty(): Promise<void> {
    if (this.dirty) {
      await this.flush();
    }
  }

  private filteredForExport(days?: number, nowMs?: number): DailyPoolQuotaRecord[] {
    return this.getHistory(days !== undefined ? { days, nowMs } : undefined).sort(
      (a, b) => a.updatedAt - b.updatedAt || a.email.localeCompare(b.email) || a.poolKey.localeCompare(b.poolKey),
    );
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - HISTORY_RETENTION_DAYS * DAY_MS;
    this.records = this.records.filter((r) => r.updatedAt >= cutoff);
  }
}
