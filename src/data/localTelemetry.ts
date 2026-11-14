import fs from 'node:fs/promises';
import path from 'node:path';
import {
  hexToBytes,
  parseGenMetadataBlob,
  parseSubagentRoleFromSummary,
  parseTrajectoryMetaBlob,
} from './protobuf.ts';
import type { SqliteClient } from './sqliteClient.ts';
import type { CallUsagePoint, RawConversationSummary } from '../types.ts';

const CACHE_VERSION = 1;
const DEFAULT_CACHE_DEBOUNCE_MS = 150;
const STATE_ITEM_KEY = 'google.google-antigravity';

const SUMMARIES_SQL = [
  'SELECT',
  '  conversation_id,',
  '  title,',
  '  preview,',
  '  step_count,',
  '  last_modified_time,',
  '  last_user_input_time,',
  '  workspace_uris,',
  '  status,',
  '  agent_name,',
  '  parent_conversation_id,',
  '  nesting_depth,',
  '  not_fully_idle,',
  '  killed,',
  '  hex(raw_summary) AS hex_raw',
  'FROM conversation_summaries',
].join('\n');

const GEN_METADATA_SQL =
  'SELECT idx, hex(data) AS hex_data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC';

const TRAJECTORY_META_SQL =
  'SELECT id, hex(data) AS hex_data FROM trajectory_metadata_blob';

const STATE_VSCDB_SQL =
  'SELECT hex(value) AS hex_value FROM ItemTable WHERE key = ? LIMIT 1';

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

export const FULL_SWEEP_INTERVAL_MS = 60_000;
export const RECENT_ACTIVITY_WINDOW_MS = 10 * 60_000;

export interface ReadAllOptions {
  forceRescan?: boolean;
  dirtyConversationIds?: ReadonlySet<string>;
  activeConversationIds?: ReadonlySet<string>;
  nowMs?: number;
}

export type ReadOptions = boolean | ReadAllOptions;

export interface LocalTelemetryReaderOptions {
  antigravityRoot: string;
  cacheFilePath?: string;
  workspaceStateDbPath?: string;
  cacheDebounceMs?: number;
  fullSweepIntervalMs?: number;
}

export interface LocalSnapshot {
  summaries: RawConversationSummary[];
  callsById: Map<string, CallUsagePoint[]>;
  lastConversationId: string | null;
}

interface FileStatInfo {
  mtimeMs: number;
  size: number;
  ino: number;
}

interface UncatalogedMeta {
  title?: string;
  workspaceUris: string[];
}

interface DbCacheEntry {
  signature: string;
  dbSize: number;
  dbMtimeMs: number;
  dbIno: number;
  walSize: number;
  walMtimeMs: number;
  lastIdx: number;
  calls: CallUsagePoint[];
  uncatalogedMeta?: UncatalogedMeta;
}

interface SerializedLocalCache {
  version: number;
  antigravityRoot: string;
  entries: Record<string, DbCacheEntry>;
}

interface SummaryRow {
  conversation_id: unknown;
  title: unknown;
  preview: unknown;
  step_count: unknown;
  last_modified_time: unknown;
  last_user_input_time: unknown;
  workspace_uris: unknown;
  status: unknown;
  agent_name: unknown;
  parent_conversation_id: unknown;
  nesting_depth: unknown;
  not_fully_idle: unknown;
  killed: unknown;
  hex_raw: unknown;
}

interface GenMetadataRow {
  idx: unknown;
  hex_data: unknown;
}

interface TrajectoryMetaRow {
  id: unknown;
  hex_data: unknown;
}

interface StateValueRow {
  hex_value: unknown;
}

function getErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return String(err ?? '');
  }
  const obj = err as { message?: unknown; stderr?: unknown };
  const parts: string[] = [];
  if (typeof obj.message === 'string') {
    parts.push(obj.message);
  }
  if (typeof obj.stderr === 'string') {
    parts.push(obj.stderr);
  }
  return parts.join('\n');
}

function isMissingTableError(err: unknown): boolean {
  return /no such table/i.test(getErrorText(err));
}

function isTransientOrCorruptDbError(err: unknown): boolean {
  return /file is not a database|database disk image is malformed|corrupt|unable to open database|database is locked|sqlite_busy/i.test(
    getErrorText(err),
  );
}

async function safeStatFile(filePath: string): Promise<FileStatInfo | null> {
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) {
      return null;
    }
    return {
      mtimeMs: st.mtimeMs,
      size: st.size,
      ino: st.ino,
    };
  } catch {
    return null;
  }
}

function buildDbSignature(dbStat: FileStatInfo, walStat: FileStatInfo | null): string {
  const walSize = walStat ? walStat.size : 0;
  const walMtime = walStat && walStat.size > 0 ? walStat.mtimeMs : 0;
  return `${dbStat.mtimeMs}:${dbStat.size}:${walMtime}:${walSize}`;
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }
  if (typeof value === 'bigint') {
    return value > 0n ? Number(value) : 0;
  }
  if (typeof value === 'string') {
    const num = Number(value.trim());
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
  }
  return 0;
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  // V8's Date.parse treats Go zero timestamps ("0001-01-01 ...") as year 2001.
  const yearMatch = /^(\d{1,4})[-/]/.exec(trimmed);
  if (yearMatch && Number(yearMatch[1]) < 1970) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseWorkspaceUris(raw: unknown): string[] {
  let items: unknown[] | null = null;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        items = parsed;
      }
    } catch {
      return [];
    }
  }

  if (!items) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item.length > 0 && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function hexColumnToBytes(hexValue: unknown): Uint8Array {
  if (typeof hexValue !== 'string' || hexValue.length === 0) {
    return new Uint8Array(0);
  }
  return hexToBytes(hexValue);
}

function isValidCallUsagePoint(value: unknown): value is CallUsagePoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.idx === 'number' &&
    Number.isInteger(obj.idx) &&
    Array.isArray(obj.stepIndices) &&
    typeof obj.model === 'string' &&
    typeof obj.fresh === 'number' &&
    typeof obj.cacheRead === 'number' &&
    typeof obj.output === 'number' &&
    typeof obj.thinking === 'number' &&
    typeof obj.response === 'number' &&
    typeof obj.effectiveContext === 'number' &&
    typeof obj.contextLimit === 'number' &&
    (obj.startStepIndex === null || typeof obj.startStepIndex === 'number') &&
    typeof obj.isCompacted === 'boolean' &&
    (obj.compactedFromStep === null || typeof obj.compactedFromStep === 'number')
  );
}

function normalizeUncatalogedMeta(raw: unknown): UncatalogedMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.workspaceUris)) {
    return undefined;
  }
  const workspaceUris = obj.workspaceUris.filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  const title = typeof obj.title === 'string' && obj.title.length > 0 ? obj.title : undefined;
  return title !== undefined ? { title, workspaceUris } : { workspaceUris };
}

function normalizeCacheEntry(raw: unknown): DbCacheEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.signature !== 'string' ||
    typeof obj.dbSize !== 'number' ||
    !Number.isFinite(obj.dbSize) ||
    obj.dbSize < 0 ||
    typeof obj.dbMtimeMs !== 'number' ||
    !Number.isFinite(obj.dbMtimeMs) ||
    typeof obj.lastIdx !== 'number' ||
    !Number.isInteger(obj.lastIdx) ||
    obj.lastIdx < -1 ||
    !Array.isArray(obj.calls)
  ) {
    return null;
  }

  const calls: CallUsagePoint[] = [];
  for (const item of obj.calls) {
    if (!isValidCallUsagePoint(item)) {
      return null;
    }
    calls.push(item);
  }

  const dbIno = typeof obj.dbIno === 'number' && Number.isFinite(obj.dbIno) ? obj.dbIno : 0;
  const walSize = typeof obj.walSize === 'number' && Number.isFinite(obj.walSize) ? obj.walSize : 0;
  const walMtimeMs =
    typeof obj.walMtimeMs === 'number' && Number.isFinite(obj.walMtimeMs) ? obj.walMtimeMs : 0;

  return {
    signature: obj.signature,
    dbSize: obj.dbSize,
    dbMtimeMs: obj.dbMtimeMs,
    dbIno,
    walSize,
    walMtimeMs,
    lastIdx: obj.lastIdx,
    calls,
    uncatalogedMeta: normalizeUncatalogedMeta(obj.uncatalogedMeta),
  };
}

function mapSummaryRow(row: SummaryRow): RawConversationSummary | null {
  const conversationId =
    typeof row.conversation_id === 'string' ? row.conversation_id.trim() : '';
  if (conversationId.length === 0) {
    return null;
  }

  const rawBytes = hexColumnToBytes(row.hex_raw);
  const subagentRole = rawBytes.length > 0 ? parseSubagentRoleFromSummary(rawBytes) : '';

  return {
    conversationId,
    title: typeof row.title === 'string' ? row.title : '',
    preview: typeof row.preview === 'string' ? row.preview : '',
    stepCount: toNonNegativeInt(row.step_count),
    lastModifiedTime: parseTimestampMs(row.last_modified_time) ?? 0,
    lastUserInputTime: parseTimestampMs(row.last_user_input_time),
    workspaceUris: parseWorkspaceUris(row.workspace_uris),
    status: typeof row.status === 'string' ? row.status : '',
    parentConversationId:
      typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.trim() : '',
    nestingDepth: toNonNegativeInt(row.nesting_depth),
    agentName: typeof row.agent_name === 'string' ? row.agent_name : '',
    subagentRole,
    killed: toBoolean(row.killed),
    notFullyIdle: toBoolean(row.not_fully_idle),
    isUncataloged: false,
  };
}

function buildUncatalogedSummary(
  conversationId: string,
  dbStat: FileStatInfo,
  walStat: FileStatInfo | null,
  meta: UncatalogedMeta,
): RawConversationSummary {
  const lastModifiedTime = Math.max(dbStat.mtimeMs, walStat ? walStat.mtimeMs : 0);
  return {
    conversationId,
    title: meta.title ?? '',
    preview: '',
    stepCount: 0,
    lastModifiedTime,
    lastUserInputTime: null,
    workspaceUris: [...meta.workspaceUris],
    status: '',
    parentConversationId: '',
    nestingDepth: 0,
    agentName: '',
    subagentRole: '',
    killed: false,
    notFullyIdle: false,
    isUncataloged: true,
  };
}

function buildUncatalogedSummaryFromCache(
  conversationId: string,
  entry: DbCacheEntry,
): RawConversationSummary {
  const lastModifiedTime = Math.max(entry.dbMtimeMs, entry.walMtimeMs);
  const meta = entry.uncatalogedMeta ?? { workspaceUris: [] };
  return {
    conversationId,
    title: meta.title ?? '',
    preview: '',
    stepCount: 0,
    lastModifiedTime,
    lastUserInputTime: null,
    workspaceUris: [...meta.workspaceUris],
    status: '',
    parentConversationId: '',
    nestingDepth: 0,
    agentName: '',
    subagentRole: '',
    killed: false,
    notFullyIdle: false,
    isUncataloged: true,
  };
}

function canReuseCachedEntry(
  cached: DbCacheEntry | undefined,
  dbStat: FileStatInfo,
  walStat: FileStatInfo | null,
  forceRescan: boolean,
): cached is DbCacheEntry {
  if (forceRescan || !cached) {
    return false;
  }
  if (dbStat.size < cached.dbSize) {
    return false;
  }
  if (cached.dbIno > 0 && dbStat.ino > 0 && dbStat.ino !== cached.dbIno) {
    return false;
  }
  // If an active WAL disappeared without touching the main DB file, treat as a rollback/reset.
  if (
    cached.walSize > 0 &&
    (walStat ? walStat.size : 0) === 0 &&
    dbStat.mtimeMs === cached.dbMtimeMs &&
    dbStat.size === cached.dbSize
  ) {
    return false;
  }
  return true;
}

/**
 * Reads Antigravity local SQLite databases and VS Code `state.vscdb` strictly read-only,
 * maintaining incremental per-DB `gen_metadata` caches in memory and optional disk JSON.
 */
export class LocalTelemetryReader {
  private readonly sqlite: SqliteClient;
  private readonly antigravityRoot: string;
  private readonly cacheFilePath: string | undefined;
  private readonly workspaceStateDbPath: string | undefined;
  private readonly cacheDebounceMs: number;
  private readonly fullSweepIntervalMs: number;

  private readonly entries = new Map<string, DbCacheEntry>();
  private cacheLoaded = false;
  private dirty = false;
  private persistGeneration = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistInFlight: Promise<void> | null = null;
  private lastPersistAt = 0;
  private tmpWriteSeq = 0;
  private readLock: Promise<void> = Promise.resolve();

  private lastConversationsDirMtimeMs = -1;
  private cachedDbList: Array<{ conversationId: string; dbPath: string }> = [];
  private lastFullSweepMs = 0;

  constructor(sqlite: SqliteClient, options: LocalTelemetryReaderOptions) {
    this.sqlite = sqlite;
    this.antigravityRoot = path.resolve(options.antigravityRoot);
    this.cacheFilePath = options.cacheFilePath ? path.resolve(options.cacheFilePath) : undefined;
    this.workspaceStateDbPath = options.workspaceStateDbPath
      ? path.resolve(options.workspaceStateDbPath)
      : undefined;
    this.cacheDebounceMs = Math.max(0, options.cacheDebounceMs ?? DEFAULT_CACHE_DEBOUNCE_MS);
    this.fullSweepIntervalMs = options.fullSweepIntervalMs ?? FULL_SWEEP_INTERVAL_MS;
  }

  clearMemoryCache(): void {
    this.entries.clear();
    this.cacheLoaded = false;
    this.dirty = false;
    this.persistGeneration++;
    this.lastConversationsDirMtimeMs = -1;
    this.cachedDbList = [];
    this.lastFullSweepMs = 0;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  async read(options?: boolean | ReadAllOptions): Promise<LocalSnapshot> {
    const opts = typeof options === 'boolean' ? { forceRescan: options } : (options ?? {});
    const run = this.readLock.then(() => this.performRead(opts));
    this.readLock = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async readAll(options?: boolean | ReadAllOptions): Promise<LocalSnapshot> {
    return this.read(options);
  }

  async flushCache(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (this.persistInFlight) {
      await this.persistInFlight;
    }

    while (this.dirty && this.cacheFilePath) {
      const writePromise = this.writeCacheToDisk();
      this.persistInFlight = writePromise;
      try {
        await writePromise;
      } finally {
        if (this.persistInFlight === writePromise) {
          this.persistInFlight = null;
        }
      }
    }
  }

  private async performRead(options: ReadAllOptions): Promise<LocalSnapshot> {
    const forceRescan = options.forceRescan ?? false;
    const nowMs = options.nowMs ?? Date.now();

    if (forceRescan) {
      this.cacheLoaded = true;
    } else if (!this.cacheLoaded) {
      await this.loadCacheFromDisk();
    }

    const isFullSweep =
      forceRescan ||
      this.lastFullSweepMs === 0 ||
      nowMs - this.lastFullSweepMs >= this.fullSweepIntervalMs;

    if (isFullSweep) {
      this.lastFullSweepMs = nowMs;
    }

    const [catalogedSummaries, convFiles, lastConversationId] = await Promise.all([
      this.readCatalogedSummaries(),
      this.listConversationDbs(isFullSweep),
      this.readLastConversationId(),
    ]);

    const catalogedIds = new Set(catalogedSummaries.map((s) => s.conversationId));
    const discoveredIds = new Set<string>();
    const uncatalogedSummaries: RawConversationSummary[] = [];
    const callsById = new Map<string, CallUsagePoint[]>();

    for (const file of convFiles) {
      discoveredIds.add(file.conversationId);
      const isCataloged = catalogedIds.has(file.conversationId);
      const existing = this.entries.get(file.conversationId);

      let shouldStat = isFullSweep;
      if (!shouldStat) {
        if (!existing) {
          shouldStat = true;
        } else if (options.dirtyConversationIds?.has(file.conversationId)) {
          shouldStat = true;
        } else if (options.activeConversationIds?.has(file.conversationId)) {
          shouldStat = true;
        } else if (
          nowMs - Math.max(existing.dbMtimeMs, existing.walMtimeMs) < RECENT_ACTIVITY_WINDOW_MS
        ) {
          shouldStat = true;
        } else if (!isCataloged && existing.uncatalogedMeta === undefined) {
          shouldStat = true;
        }
      }

      if (!shouldStat && existing) {
        callsById.set(file.conversationId, [...existing.calls]);
        if (!isCataloged) {
          uncatalogedSummaries.push(
            buildUncatalogedSummaryFromCache(file.conversationId, existing),
          );
        }
        continue;
      }

      const isDirty = Boolean(options.dirtyConversationIds?.has(file.conversationId));
      const synced = await this.syncConversationDb(
        file.conversationId,
        file.dbPath,
        isCataloged,
        forceRescan,
        isDirty,
      );

      if (!synced) {
        continue;
      }

      callsById.set(file.conversationId, [...synced.entry.calls]);
      if (!isCataloged) {
        const meta = synced.entry.uncatalogedMeta ?? { workspaceUris: [] };
        uncatalogedSummaries.push(
          buildUncatalogedSummary(file.conversationId, synced.dbStat, synced.walStat, meta),
        );
      }
    }

    for (const cachedId of Array.from(this.entries.keys())) {
      if (!discoveredIds.has(cachedId)) {
        this.entries.delete(cachedId);
        this.markDirty();
      }
    }

    if (forceRescan && this.cacheFilePath) {
      this.markDirty();
    }

    try {
      const convDir = path.join(this.antigravityRoot, 'conversations');
      const st = await fs.stat(convDir);
      if (st.isDirectory()) {
        this.lastConversationsDirMtimeMs = st.mtimeMs;
      }
    } catch {
      // ignore
    }

    await this.schedulePersist();

    return {
      summaries: [...catalogedSummaries, ...uncatalogedSummaries],
      callsById,
      lastConversationId,
    };
  }

  private markDirty(): void {
    this.dirty = true;
    this.persistGeneration++;
  }

  private async loadCacheFromDisk(): Promise<void> {
    this.cacheLoaded = true;
    if (!this.cacheFilePath) {
      return;
    }

    let rawText: string;
    try {
      rawText = await fs.readFile(this.cacheFilePath, 'utf8');
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }

    const obj = parsed as Partial<SerializedLocalCache>;
    if (
      obj.version !== CACHE_VERSION ||
      typeof obj.antigravityRoot !== 'string' ||
      path.resolve(obj.antigravityRoot) !== this.antigravityRoot ||
      !obj.entries ||
      typeof obj.entries !== 'object' ||
      Array.isArray(obj.entries)
    ) {
      return;
    }

    for (const [convId, rawEntry] of Object.entries(obj.entries)) {
      if (!convId) {
        continue;
      }
      const normalized = normalizeCacheEntry(rawEntry);
      if (normalized) {
        this.entries.set(convId, normalized);
      }
    }
  }

  private async schedulePersist(): Promise<void> {
    if (!this.cacheFilePath || !this.dirty) {
      return;
    }

    const elapsed = Date.now() - this.lastPersistAt;
    const shouldFlushImmediately =
      this.cacheDebounceMs === 0 ||
      this.lastPersistAt === 0 ||
      (elapsed >= this.cacheDebounceMs && this.persistTimer === null && this.persistInFlight === null);

    if (shouldFlushImmediately) {
      try {
        await this.flushCache();
      } catch {
        // Cache persistence is best-effort and must not fail telemetry reads.
      }
      return;
    }

    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushCache().catch(() => {});
    }, this.cacheDebounceMs);
    this.persistTimer.unref?.();
  }

  private async writeCacheToDisk(): Promise<void> {
    if (!this.cacheFilePath) {
      return;
    }

    const gen = this.persistGeneration;
    const entriesRecord: Record<string, DbCacheEntry> = {};
    for (const [id, entry] of this.entries) {
      entriesRecord[id] = entry;
    }

    const payload: SerializedLocalCache = {
      version: CACHE_VERSION,
      antigravityRoot: this.antigravityRoot,
      entries: entriesRecord,
    };

    const dir = path.dirname(this.cacheFilePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.cacheFilePath}.tmp.${process.pid}.${++this.tmpWriteSeq}`;

    try {
      await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8');
      await fs.rename(tmpPath, this.cacheFilePath);
      this.lastPersistAt = Date.now();
      if (this.persistGeneration === gen) {
        this.dirty = false;
      }
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async readCatalogedSummaries(): Promise<RawConversationSummary[]> {
    const summariesDbPath = path.join(this.antigravityRoot, 'conversation_summaries.db');
    const stat = await safeStatFile(summariesDbPath);
    if (!stat) {
      return [];
    }

    let rows: SummaryRow[];
    try {
      rows = await this.sqlite.queryAll<SummaryRow>(summariesDbPath, SUMMARIES_SQL);
    } catch (err) {
      if (isMissingTableError(err) || isTransientOrCorruptDbError(err)) {
        return [];
      }
      throw err;
    }

    const summaries: RawConversationSummary[] = [];
    for (const row of rows) {
      const mapped = mapSummaryRow(row);
      if (mapped) {
        summaries.push(mapped);
      }
    }
    return summaries;
  }

  private async listConversationDbs(
    isFullSweep: boolean,
  ): Promise<Array<{ conversationId: string; dbPath: string }>> {
    const convDir = path.join(this.antigravityRoot, 'conversations');
    let dirMtimeMs: number;
    try {
      const st = await fs.stat(convDir);
      if (!st.isDirectory()) {
        this.cachedDbList = [];
        this.lastConversationsDirMtimeMs = -1;
        return [];
      }
      dirMtimeMs = st.mtimeMs;
    } catch {
      this.cachedDbList = [];
      this.lastConversationsDirMtimeMs = -1;
      return [];
    }

    const dirMtimeChanged = dirMtimeMs !== this.lastConversationsDirMtimeMs;

    if (isFullSweep || dirMtimeChanged || this.lastConversationsDirMtimeMs === -1) {
      let dirEntries;
      try {
        dirEntries = await fs.readdir(convDir, { withFileTypes: true });
      } catch {
        this.cachedDbList = [];
        this.lastConversationsDirMtimeMs = -1;
        return [];
      }

      const out: Array<{ conversationId: string; dbPath: string }> = [];
      for (const entry of dirEntries) {
        if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith('.db')) {
          continue;
        }
        const conversationId = entry.name.slice(0, -3);
        if (conversationId.length === 0) {
          continue;
        }
        out.push({
          conversationId,
          dbPath: path.join(convDir, entry.name),
        });
      }
      out.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
      this.cachedDbList = out;
      this.lastConversationsDirMtimeMs = dirMtimeMs;
      return out;
    }

    return this.cachedDbList;
  }

  private async syncConversationDb(
    conversationId: string,
    dbPath: string,
    isCataloged: boolean,
    forceRescan: boolean,
    isDirty = false,
  ): Promise<{ entry: DbCacheEntry; dbStat: FileStatInfo; walStat: FileStatInfo | null } | null> {
    const dbStat = await safeStatFile(dbPath);
    if (!dbStat) {
      if (this.entries.delete(conversationId)) {
        this.markDirty();
      }
      return null;
    }

    const walStat = await safeStatFile(`${dbPath}-wal`);
    const signature = buildDbSignature(dbStat, walStat);
    const existing = this.entries.get(conversationId);
    const reusable = canReuseCachedEntry(existing, dbStat, walStat, forceRescan);

    if (!isDirty && reusable && existing.signature === signature) {
      if (!isCataloged && existing.uncatalogedMeta === undefined) {
        existing.uncatalogedMeta = await this.readUncatalogedMeta(dbPath);
        this.markDirty();
      }
      return { entry: existing, dbStat, walStat };
    }

    let lastIdx = reusable ? existing.lastIdx : -1;
    let calls = reusable ? [...existing.calls] : [];
    let uncatalogedMeta = reusable ? existing.uncatalogedMeta : undefined;

    let rows: GenMetadataRow[];
    try {
      rows = await this.queryGenMetadata(dbPath, lastIdx);
      const hasIdxReset = rows.some((r) => Number(r.idx) <= lastIdx);
      if (hasIdxReset && lastIdx !== -1) {
        lastIdx = -1;
        calls = [];
        rows = await this.queryGenMetadata(dbPath, -1);
      }
    } catch (err) {
      if (isTransientOrCorruptDbError(err)) {
        if (reusable) {
          return { entry: existing, dbStat, walStat };
        }
        return null;
      }
      throw err;
    }

    for (const row of rows) {
      const idx = typeof row.idx === 'number' ? row.idx : Number(row.idx);
      if (!Number.isInteger(idx)) {
        continue;
      }
      if (idx > lastIdx) {
        lastIdx = idx;
      }
      const bytes = hexColumnToBytes(row.hex_data);
      const parsed = parseGenMetadataBlob(idx, bytes);
      if (parsed !== null) {
        calls.push(parsed);
      }
    }

    if (!isCataloged) {
      uncatalogedMeta = await this.readUncatalogedMeta(dbPath);
    }

    const updated: DbCacheEntry = {
      signature,
      dbSize: dbStat.size,
      dbMtimeMs: dbStat.mtimeMs,
      dbIno: dbStat.ino,
      walSize: walStat ? walStat.size : 0,
      walMtimeMs: walStat && walStat.size > 0 ? walStat.mtimeMs : 0,
      lastIdx,
      calls,
      uncatalogedMeta,
    };

    this.entries.set(conversationId, updated);
    this.markDirty();

    return { entry: updated, dbStat, walStat };
  }

  private async queryGenMetadata(dbPath: string, lastIdx: number): Promise<GenMetadataRow[]> {
    try {
      return await this.sqlite.queryAll<GenMetadataRow>(dbPath, GEN_METADATA_SQL, [lastIdx]);
    } catch (err) {
      if (isMissingTableError(err)) {
        return [];
      }
      throw err;
    }
  }

  private async readUncatalogedMeta(dbPath: string): Promise<UncatalogedMeta> {
    let rows: TrajectoryMetaRow[];
    try {
      rows = await this.sqlite.queryAll<TrajectoryMetaRow>(dbPath, TRAJECTORY_META_SQL);
    } catch (err) {
      if (isMissingTableError(err) || isTransientOrCorruptDbError(err)) {
        return { workspaceUris: [] };
      }
      throw err;
    }

    if (rows.length === 0) {
      return { workspaceUris: [] };
    }

    const mainRow = rows.find((r) => r.id === 'main') ?? rows[0];
    const bytes = hexColumnToBytes(mainRow.hex_data);
    return parseTrajectoryMetaBlob(bytes);
  }

  private async readLastConversationId(): Promise<string | null> {
    if (!this.workspaceStateDbPath) {
      return null;
    }

    let rows: StateValueRow[];
    try {
      rows = await this.sqlite.queryAll<StateValueRow>(
        this.workspaceStateDbPath,
        STATE_VSCDB_SQL,
        [STATE_ITEM_KEY],
      );
    } catch (err) {
      if (isMissingTableError(err) || isTransientOrCorruptDbError(err)) {
        return null;
      }
      throw err;
    }

    if (rows.length === 0) {
      return null;
    }

    const bytes = hexColumnToBytes(rows[0].hex_value);
    if (bytes.length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(utf8Decoder.decode(bytes)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const lastId = (parsed as { lastConversationId?: unknown }).lastConversationId;
      if (typeof lastId !== 'string') {
        return null;
      }
      const trimmed = lastId.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }
}
