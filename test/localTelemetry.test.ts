import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteClient, type SqliteClient } from '../src/data/sqliteClient.ts';
import {
  LocalTelemetryReader,
  FULL_SWEEP_INTERVAL_MS,
  RECENT_ACTIVITY_WINDOW_MS,
  type ReadAllOptions,
} from '../src/data/localTelemetry.ts';

const encoder = new TextEncoder();

function encodeVarint(val: number | bigint): Uint8Array {
  let v = typeof val === 'bigint' ? val : BigInt(val);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v > 0n);
  return Uint8Array.from(out);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function fieldVarint(fieldNumber: number, value: number | bigint): Uint8Array {
  const key = encodeVarint((BigInt(fieldNumber) << 3n) | 0n);
  return concatBytes(key, encodeVarint(value));
}

function fieldBytes(fieldNumber: number, payload: Uint8Array): Uint8Array {
  const key = encodeVarint((BigInt(fieldNumber) << 3n) | 2n);
  return concatBytes(key, encodeVarint(payload.length), payload);
}

function fieldString(fieldNumber: number, text: string): Uint8Array {
  return fieldBytes(fieldNumber, encoder.encode(text));
}

function fieldPackedVarints(fieldNumber: number, values: number[]): Uint8Array {
  return fieldBytes(fieldNumber, concatBytes(...values.map((v) => encodeVarint(v))));
}

function buildGenBlob(opts: {
  model: string;
  stepIndices: number[];
  fresh: number;
  cacheRead: number;
  output: number;
  thinking?: number;
  response?: number;
  rowContext?: number;
  rowLimit?: number;
  startStepIndex?: number;
}): Uint8Array {
  const usage = concatBytes(
    fieldVarint(2, opts.fresh),
    fieldVarint(3, opts.output),
    fieldVarint(5, opts.cacheRead),
    fieldVarint(9, opts.thinking ?? 0),
    fieldVarint(10, opts.response ?? opts.output),
  );

  const startParts: Uint8Array[] = [];
  if (opts.startStepIndex !== undefined) {
    startParts.push(fieldVarint(2, opts.startStepIndex));
  } else {
    startParts.push(fieldVarint(2, 0xffffffffffffffffn));
  }
  const ctxParts: Uint8Array[] = [];
  if (opts.rowContext !== undefined) {
    ctxParts.push(fieldVarint(1, opts.rowContext));
  }
  if (opts.rowLimit !== undefined) {
    ctxParts.push(fieldVarint(4, opts.rowLimit));
  }
  if (ctxParts.length > 0) {
    startParts.push(fieldBytes(10, concatBytes(...ctxParts)));
  }

  const chatModel = concatBytes(
    fieldBytes(4, usage),
    fieldBytes(9, concatBytes(...startParts)),
    fieldString(19, opts.model),
  );

  return concatBytes(
    fieldPackedVarints(2, opts.stepIndices),
    fieldBytes(1, chatModel),
  );
}

function buildRawSummaryRoleBlob(role: string): Uint8Array {
  return fieldBytes(17, fieldBytes(8, fieldString(2, role)));
}

function buildTrajectoryMetaBlob(workspaceUris: string[]): Uint8Array {
  const parts = workspaceUris.map((uri) => fieldBytes(1, fieldString(1, uri)));
  return concatBytes(...parts);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-local-telemetry-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createConversationSummariesDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      preview TEXT NOT NULL DEFAULT "",
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT "",
      agent_name TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      not_fully_idle NUMERIC NOT NULL DEFAULT false,
      killed NUMERIC NOT NULL DEFAULT false,
      last_user_input_time DATETIME NOT NULL,
      raw_summary BLOB
    );
  `);
  return db;
}

function createConversationDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      data BLOB,
      size INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE trajectory_metadata_blob (
      id TEXT PRIMARY KEY DEFAULT "main",
      data BLOB
    );
  `);
  return db;
}

interface QueryRecord {
  dbPath: string;
  sql: string;
  params: ReadonlyArray<string | number> | undefined;
}

function spySqliteClient(inner: SqliteClient): {
  client: SqliteClient;
  queries: QueryRecord[];
  countForDb: (dbPath: string) => number;
  queriesForDb: (dbPath: string) => QueryRecord[];
  reset: () => void;
} {
  const queries: QueryRecord[] = [];
  const client: SqliteClient = {
    backend: inner.backend,
    async queryAll<T>(
      dbPath: string,
      sql: string,
      params?: ReadonlyArray<string | number>,
    ): Promise<T[]> {
      queries.push({ dbPath, sql, params: params ? [...params] : undefined });
      return inner.queryAll<T>(dbPath, sql, params);
    },
    dispose(): void {
      inner.dispose();
    },
  };
  return {
    client,
    queries,
    countForDb(dbPath: string): number {
      const resolved = path.resolve(dbPath);
      return queries.filter((q) => path.resolve(q.dbPath) === resolved).length;
    },
    queriesForDb(dbPath: string): QueryRecord[] {
      const resolved = path.resolve(dbPath);
      return queries.filter((q) => path.resolve(q.dbPath) === resolved);
    },
    reset(): void {
      queries.length = 0;
    },
  };
}

test('reads conversation_summaries, subagent roles, and uncataloged DBs via trajectory_metadata_blob', async () => {
  await withTempDir(async (dir) => {
    const agRoot = path.join(dir, 'antigravity');
    const convDir = path.join(agRoot, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    const parentId = '11111111-1111-4111-8111-111111111111';
    const topAgentId = '22222222-2222-4222-8222-222222222222';
    const childId = '33333333-3333-4333-8333-333333333333';
    const killedChildId = '44444444-4444-4444-8444-444444444444';
    const uncatalogedId = '55555555-5555-4555-8555-555555555555';

    const sumDb = createConversationSummariesDb(path.join(agRoot, 'conversation_summaries.db'));
    const insertSummary = sumDb.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, agent_name, parent_conversation_id,
        nesting_depth, not_fully_idle, killed, last_user_input_time, raw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertSummary.run(
      parentId,
      'Main Session',
      'Building monitor',
      42,
      '2026-11-13 23:42:03.702064511+00:00',
      '["file:///repo/app"]',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
      0,
      1,
      0,
      '2026-11-13 23:19:41.943332102+00:00',
      new Uint8Array(0),
    );
    insertSummary.run(
      topAgentId,
      'Top Chat With AgentName',
      'Top-level preview',
      5,
      '2026-11-13 23:30:00+00:00',
      '["file:///repo/app"]',
      'CASCADE_RUN_STATUS_IDLE',
      'main-agent',
      '',
      0,
      0,
      0,
      '2026-11-13 23:25:00+00:00',
      new Uint8Array(0),
    );
    insertSummary.run(
      childId,
      '',
      '',
      12,
      '2026-11-13 23:41:57.970241833+00:00',
      '["file:///repo/app"]',
      'CASCADE_RUN_STATUS_RUNNING',
      'research',
      parentId,
      1,
      1,
      0,
      '0001-01-01 00:00:00+00:00',
      buildRawSummaryRoleBlob('Codebase Researcher'),
    );
    insertSummary.run(
      killedChildId,
      'Killed Child',
      '',
      3,
      '2026-11-13 23:10:00+00:00',
      '{not-json',
      'CASCADE_RUN_STATUS_IDLE',
      'self',
      parentId,
      2,
      0,
      1,
      '0001-01-01 00:00:00+00:00',
      new Uint8Array(0),
    );
    sumDb.close();

    // Parent DB
    const parentDb = createConversationDb(path.join(convDir, `${parentId}.db`));
    parentDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(
        0,
        buildGenBlob({
          model: 'gemini-2.5-pro',
          stepIndices: [1, 2],
          fresh: 1000,
          cacheRead: 2000,
          output: 300,
          thinking: 100,
          response: 200,
          rowContext: 3200,
          rowLimit: 256000,
        }),
        64,
      );
    parentDb.close();

    // Uncataloged DB + ignore .pb files
    await fs.writeFile(path.join(convDir, 'legacy-session.pb'), Buffer.from([1, 2, 3]));
    const uncatDb = createConversationDb(path.join(convDir, `${uncatalogedId}.db`));
    uncatDb
      .prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)')
      .run('main', buildTrajectoryMetaBlob(['file:///repo/uncataloged']));
    uncatDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(
        0,
        buildGenBlob({
          model: 'claude-sonnet-4-5',
          stepIndices: [1],
          fresh: 500,
          cacheRead: 0,
          output: 50,
          rowContext: 550,
          rowLimit: 200000,
        }),
        48,
      );
    uncatDb.close();

    const sqlite = await createSqliteClient();
    try {
      const reader = new LocalTelemetryReader(sqlite, { antigravityRoot: agRoot });
      const snap = await reader.read();

      assert.equal(snap.lastConversationId, null);
      assert.equal(snap.summaries.length, 5);

      const byId = new Map(snap.summaries.map((s) => [s.conversationId, s]));

      const parent = byId.get(parentId);
      assert.ok(parent);
      assert.equal(parent.title, 'Main Session');
      assert.equal(parent.preview, 'Building monitor');
      assert.equal(parent.stepCount, 42);
      assert.equal(parent.parentConversationId, '');
      assert.equal(parent.nestingDepth, 0);
      assert.equal(parent.notFullyIdle, true);
      assert.equal(parent.killed, false);
      assert.deepEqual(parent.workspaceUris, ['file:///repo/app']);
      assert.equal(parent.isUncataloged, false);
      assert.equal(parent.lastModifiedTime, Date.parse('2026-11-13T23:42:03.702Z'));
      assert.equal(parent.lastUserInputTime, Date.parse('2026-11-13T23:19:41.943Z'));

      const topAgent = byId.get(topAgentId);
      assert.ok(topAgent);
      assert.equal(topAgent.agentName, 'main-agent');
      assert.equal(topAgent.parentConversationId, '');
      assert.equal(topAgent.nestingDepth, 0);

      const child = byId.get(childId);
      assert.ok(child);
      assert.equal(child.parentConversationId, parentId);
      assert.equal(child.nestingDepth, 1);
      assert.equal(child.agentName, 'research');
      assert.equal(child.subagentRole, 'Codebase Researcher');
      assert.equal(child.status, 'CASCADE_RUN_STATUS_RUNNING');
      assert.equal(child.lastUserInputTime, null);

      const killedChild = byId.get(killedChildId);
      assert.ok(killedChild);
      assert.equal(killedChild.killed, true);
      assert.equal(killedChild.notFullyIdle, false);
      assert.deepEqual(killedChild.workspaceUris, []);
      assert.equal(killedChild.lastUserInputTime, null);

      const uncataloged = byId.get(uncatalogedId);
      assert.ok(uncataloged);
      assert.equal(uncataloged.isUncataloged, true);
      assert.deepEqual(uncataloged.workspaceUris, ['file:///repo/uncataloged']);
      assert.ok(uncataloged.lastModifiedTime > 0);

      assert.equal(byId.has('legacy-session'), false);

      assert.equal(snap.callsById.get(parentId)?.length, 1);
      assert.equal(snap.callsById.get(parentId)?.[0].model, 'gemini-2.5-pro');
      assert.equal(snap.callsById.get(uncatalogedId)?.length, 1);
      assert.equal(snap.callsById.get(uncatalogedId)?.[0].contextLimit, 200000);
    } finally {
      sqlite.dispose();
    }
  });
});

test('incremental gen_metadata caching skips unchanged DBs, queries WHERE idx > lastIdx, and invalidates on shrink or forceRescan', async () => {
  await withTempDir(async (dir) => {
    const agRoot = path.join(dir, 'antigravity');
    const convDir = path.join(agRoot, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    const convId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const convDbPath = path.join(convDir, `${convId}.db`);

    const sumDb = createConversationSummariesDb(path.join(agRoot, 'conversation_summaries.db'));
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, agent_name, parent_conversation_id,
          nesting_depth, not_fully_idle, killed, last_user_input_time, raw_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        convId,
        'Incremental Test',
        '',
        6,
        '2026-11-13 23:42:00+00:00',
        '["file:///repo/inc"]',
        'CASCADE_RUN_STATUS_IDLE',
        '',
        '',
        0,
        0,
        0,
        '2026-11-13 23:40:00+00:00',
        new Uint8Array(0),
      );
    sumDb.close();

    const writer = createConversationDb(convDbPath);
    const insertGen = writer.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
    for (let i = 0; i <= 2; i++) {
      insertGen.run(
        i,
        buildGenBlob({
          model: 'gemini-2.5-pro',
          stepIndices: [i * 2 + 1],
          fresh: 1000 + i * 100,
          cacheRead: 5000 + i * 500,
          output: 200,
          rowContext: 6000 + i * 600,
        }),
        64,
      );
    }

    const baseSqlite = await createSqliteClient();
    const spy = spySqliteClient(baseSqlite);

    try {
      const reader = new LocalTelemetryReader(spy.client, { antigravityRoot: agRoot });

      // Read 1: parses rows 0..2 using [-1]
      const snap1 = await reader.read();
      assert.deepEqual(
        snap1.callsById.get(convId)?.map((c) => c.idx),
        [0, 1, 2],
      );
      assert.equal(spy.countForDb(convDbPath), 1);
      assert.equal(
        spy.queriesForDb(convDbPath)[0].sql,
        'SELECT idx, hex(data) AS hex_data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC',
      );
      assert.deepEqual(spy.queriesForDb(convDbPath)[0].params, [-1]);

      // Read 2: unchanged (mtime, size, wal) -> 0 queries on convDbPath
      spy.reset();
      const snap2 = await reader.read();
      assert.deepEqual(
        snap2.callsById.get(convId)?.map((c) => c.idx),
        [0, 1, 2],
      );
      assert.equal(spy.countForDb(convDbPath), 0);

      // Append row idx = 3 while WAL writer is active
      insertGen.run(
        3,
        buildGenBlob({
          model: 'gemini-2.5-pro',
          stepIndices: [7, 8],
          fresh: 1300,
          cacheRead: 6500,
          output: 250,
          rowContext: 7800,
          startStepIndex: 7,
        }),
        64,
      );

      // Read 3: queries ONLY WHERE idx > 2
      spy.reset();
      const snap3 = await reader.read();
      assert.deepEqual(
        snap3.callsById.get(convId)?.map((c) => c.idx),
        [0, 1, 2, 3],
      );
      assert.equal(snap3.callsById.get(convId)?.[3].startStepIndex, 7);
      assert.equal(spy.countForDb(convDbPath), 1);
      assert.deepEqual(spy.queriesForDb(convDbPath)[0].params, [2]);

      // forceRescan = true -> forces [-1] query even when unchanged
      spy.reset();
      const snapForced = await reader.read(true);
      assert.equal(snapForced.callsById.get(convId)?.length, 4);
      assert.equal(spy.countForDb(convDbPath), 1);
      assert.deepEqual(spy.queriesForDb(convDbPath)[0].params, [-1]);

      // clearMemoryCache() -> forces [-1] query on next read()
      reader.clearMemoryCache();
      spy.reset();
      const snapCleared = await reader.read();
      assert.equal(snapCleared.callsById.get(convId)?.length, 4);
      assert.equal(spy.countForDb(convDbPath), 1);
      assert.deepEqual(spy.queriesForDb(convDbPath)[0].params, [-1]);

      // Shrink / recreate DB with fewer rows -> invalidates per-DB cache cleanly
      writer.close();
      // Add extra padding in a large DB first, then replace with smaller DB
      const paddedDb = new DatabaseSync(convDbPath);
      paddedDb
        .prepare('INSERT OR REPLACE INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
        .run(
          10,
          new Uint8Array(16_384),
          16_384,
        );
      paddedDb.close();
      await reader.read();

      // Now remove and replace with a much smaller DB having only idx = 0
      await fs.rm(convDbPath, { force: true });
      await fs.rm(`${convDbPath}-wal`, { force: true });
      await fs.rm(`${convDbPath}-shm`, { force: true });
      const smallDb = createConversationDb(convDbPath);
      smallDb
        .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
        .run(
          0,
          buildGenBlob({
            model: 'claude-opus-4',
            stepIndices: [1],
            fresh: 42,
            cacheRead: 0,
            output: 10,
          }),
          32,
        );
      smallDb.close();

      spy.reset();
      const snapShrunk = await reader.read();
      assert.equal(spy.countForDb(convDbPath), 1);
      assert.deepEqual(spy.queriesForDb(convDbPath)[0].params, [-1]);
      assert.equal(snapShrunk.callsById.get(convId)?.length, 1);
      assert.equal(snapShrunk.callsById.get(convId)?.[0].model, 'claude-opus-4');
      assert.equal(snapShrunk.callsById.get(convId)?.[0].fresh, 42);

      // Deleting the .db removes it from callsById
      await fs.rm(convDbPath, { force: true });
      await fs.rm(`${convDbPath}-wal`, { force: true });
      await fs.rm(`${convDbPath}-shm`, { force: true });
      const snapDeleted = await reader.read();
      assert.equal(snapDeleted.callsById.has(convId), false);
    } finally {
      try {
        writer.close();
      } catch {
        // already closed above
      }
      spy.client.dispose();
    }
  });
});

test('persists cache to cacheFilePath, restores cleanly on a fresh reader, and handles corrupted cache files', async () => {
  await withTempDir(async (dir) => {
    const agRoot = path.join(dir, 'antigravity');
    const convDir = path.join(agRoot, 'conversations');
    const cacheFilePath = path.join(dir, 'storage', 'telemetry-cache.json');
    await fs.mkdir(convDir, { recursive: true });

    const catId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const uncatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const sumDb = createConversationSummariesDb(path.join(agRoot, 'conversation_summaries.db'));
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, agent_name, parent_conversation_id,
          nesting_depth, not_fully_idle, killed, last_user_input_time, raw_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        catId,
        'Persisted Session',
        '',
        2,
        '2026-11-13 23:42:00+00:00',
        '["file:///repo/persist"]',
        'CASCADE_RUN_STATUS_IDLE',
        '',
        '',
        0,
        0,
        0,
        '2026-11-13 23:40:00+00:00',
        new Uint8Array(0),
      );
    sumDb.close();

    const catDbPath = path.join(convDir, `${catId}.db`);
    const catDb = createConversationDb(catDbPath);
    catDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(
        0,
        buildGenBlob({
          model: 'gemini-2.5-pro',
          stepIndices: [1],
          fresh: 777,
          cacheRead: 888,
          output: 99,
        }),
        48,
      );
    catDb.close();

    const uncatDbPath = path.join(convDir, `${uncatId}.db`);
    const uncatDb = createConversationDb(uncatDbPath);
    uncatDb
      .prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)')
      .run('main', buildTrajectoryMetaBlob(['file:///repo/uncat-persist']));
    uncatDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(
        0,
        buildGenBlob({
          model: 'claude-sonnet-4-5',
          stepIndices: [1],
          fresh: 111,
          cacheRead: 222,
          output: 33,
        }),
        48,
      );
    uncatDb.close();

    const baseSqlite = await createSqliteClient();
    const spy = spySqliteClient(baseSqlite);

    try {
      const reader1 = new LocalTelemetryReader(spy.client, {
        antigravityRoot: agRoot,
        cacheFilePath,
      });
      const snap1 = await reader1.read();
      await reader1.flushCache();

      assert.equal(snap1.callsById.get(catId)?.[0].fresh, 777);
      assert.equal(snap1.callsById.get(uncatId)?.[0].fresh, 111);

      const rawCache = await fs.readFile(cacheFilePath, 'utf8');
      assert.ok(rawCache.includes(catId));

      // Fresh LocalTelemetryReader restores from cacheFilePath with 0 SQL queries on unchanged DBs
      spy.reset();
      const reader2 = new LocalTelemetryReader(spy.client, {
        antigravityRoot: agRoot,
        cacheFilePath,
      });
      const snap2 = await reader2.read();
      assert.equal(spy.countForDb(catDbPath), 0);
      assert.equal(spy.countForDb(uncatDbPath), 0);
      assert.equal(snap2.callsById.get(catId)?.[0].fresh, 777);
      assert.equal(snap2.callsById.get(uncatId)?.[0].fresh, 111);
      const uncatSummary2 = snap2.summaries.find((s) => s.conversationId === uncatId);
      assert.deepEqual(uncatSummary2?.workspaceUris, ['file:///repo/uncat-persist']);

      // Append idx = 1 on catDb and read with reader2 -> only queries WHERE idx > 0
      const catWriter = new DatabaseSync(catDbPath);
      catWriter
        .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
        .run(
          1,
          buildGenBlob({
            model: 'gemini-2.5-pro',
            stepIndices: [2],
            fresh: 333,
            cacheRead: 999,
            output: 44,
          }),
          48,
        );
      catWriter.close();

      spy.reset();
      const snap2Updated = await reader2.read();
      assert.equal(spy.countForDb(catDbPath), 1);
      assert.deepEqual(spy.queriesForDb(catDbPath)[0].params, [0]);
      assert.equal(spy.countForDb(uncatDbPath), 0);
      assert.equal(snap2Updated.callsById.get(catId)?.length, 2);
      await reader2.flushCache();

      // Fresh reader3 picks up updated idx = 1 from persisted cache
      spy.reset();
      const reader3 = new LocalTelemetryReader(spy.client, {
        antigravityRoot: agRoot,
        cacheFilePath,
      });
      const snap3 = await reader3.read();
      assert.equal(spy.countForDb(catDbPath), 0);
      assert.equal(snap3.callsById.get(catId)?.length, 2);

      // Corrupted cache JSON does not throw and falls back to reading DBs cleanly
      await fs.writeFile(cacheFilePath, '{corrupted-json!!!', 'utf8');
      spy.reset();
      const readerCorrupt = new LocalTelemetryReader(spy.client, {
        antigravityRoot: agRoot,
        cacheFilePath,
      });
      const snapCorrupt = await readerCorrupt.read();
      assert.equal(spy.countForDb(catDbPath), 1);
      assert.equal(snapCorrupt.callsById.get(catId)?.length, 2);

      // Mismatched antigravityRoot or wrong version in cache file is safely ignored
      await fs.writeFile(
        cacheFilePath,
        JSON.stringify({ version: 999, antigravityRoot: agRoot, entries: {} }),
        'utf8',
      );
      spy.reset();
      const readerWrongVer = new LocalTelemetryReader(spy.client, {
        antigravityRoot: agRoot,
        cacheFilePath,
      });
      const snapWrongVer = await readerWrongVer.read();
      assert.equal(spy.countForDb(catDbPath), 1);
      assert.equal(snapWrongVer.callsById.get(catId)?.length, 2);
    } finally {
      spy.client.dispose();
    }
  });
});

test('reads ItemTable[google.google-antigravity].lastConversationId from state.vscdb safely and handles missing dirs/malformed data', async () => {
  await withTempDir(async (dir) => {
    const missingRoot = path.join(dir, 'does-not-exist');
    const missingStatePath = path.join(dir, 'missing-state.vscdb');
    const sqlite = await createSqliteClient();

    try {
      // Missing antigravityRoot + missing state.vscdb
      const missingReader = new LocalTelemetryReader(sqlite, {
        antigravityRoot: missingRoot,
        workspaceStateDbPath: missingStatePath,
      });
      const emptySnap = await missingReader.read();
      assert.deepEqual(emptySnap.summaries, []);
      assert.equal(emptySnap.callsById.size, 0);
      assert.equal(emptySnap.lastConversationId, null);

      // state.vscdb with valid JSON string
      const stateDbPath = path.join(dir, 'state.vscdb');
      const stateDb = new DatabaseSync(stateDbPath);
      stateDb.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
      stateDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('google.google-antigravity', JSON.stringify({ lastConversationId: 'conv-xyz-789' }));

      const reader = new LocalTelemetryReader(sqlite, {
        antigravityRoot: missingRoot,
        workspaceStateDbPath: stateDbPath,
      });
      assert.equal((await reader.read()).lastConversationId, 'conv-xyz-789');

      // state.vscdb with binary BLOB value (Uint8Array)
      stateDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run(
          'google.google-antigravity',
          encoder.encode(JSON.stringify({ lastConversationId: 'conv-blob-456' })),
        );
      assert.equal((await reader.read()).lastConversationId, 'conv-blob-456');

      // Malformed JSON -> null without throwing
      stateDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('google.google-antigravity', '{not valid json');
      assert.equal((await reader.read()).lastConversationId, null);

      // Empty or non-string lastConversationId -> null
      stateDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('google.google-antigravity', JSON.stringify({ lastConversationId: 123 }));
      assert.equal((await reader.read()).lastConversationId, null);

      // Missing key -> null
      stateDb.prepare('DELETE FROM ItemTable WHERE key = ?').run('google.google-antigravity');
      assert.equal((await reader.read()).lastConversationId, null);
      stateDb.close();

      // state.vscdb without ItemTable -> null without throwing
      const noTableDbPath = path.join(dir, 'empty-state.vscdb');
      const noTableDb = new DatabaseSync(noTableDbPath);
      noTableDb.exec('CREATE TABLE OtherTable (k TEXT);');
      noTableDb.close();
      const noTableReader = new LocalTelemetryReader(sqlite, {
        antigravityRoot: missingRoot,
        workspaceStateDbPath: noTableDbPath,
      });
      assert.equal((await noTableReader.read()).lastConversationId, null);
    } finally {
      sqlite.dispose();
    }
  });
});

test('handles concurrent reads, empty/corrupt DB files, and CLI fallback parity cleanly', async () => {
  await withTempDir(async (dir) => {
    const agRoot = path.join(dir, 'antigravity');
    const convDir = path.join(agRoot, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    const goodId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const emptyId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const corruptId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    const sumDb = createConversationSummariesDb(path.join(agRoot, 'conversation_summaries.db'));
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, agent_name, parent_conversation_id,
          nesting_depth, not_fully_idle, killed, last_user_input_time, raw_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goodId,
        'Concurrent & Fallback',
        '',
        1,
        '2026-11-13 23:42:00+00:00',
        '["file:///repo/parity"]',
        'CASCADE_RUN_STATUS_IDLE',
        '',
        '',
        0,
        0,
        0,
        '2026-11-13 23:40:00+00:00',
        buildRawSummaryRoleBlob('Parity Role'),
      );
    sumDb.close();

    const goodDb = createConversationDb(path.join(convDir, `${goodId}.db`));
    goodDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(
        0,
        buildGenBlob({
          model: 'gemini-2.5-pro',
          stepIndices: [1],
          fresh: 555,
          cacheRead: 111,
          output: 22,
        }),
        48,
      );
    goodDb.close();

    // Empty 0-byte DB and corrupted non-SQLite file must not crash read()
    await fs.writeFile(path.join(convDir, `${emptyId}.db`), new Uint8Array(0));
    await fs.writeFile(path.join(convDir, `${corruptId}.db`), 'not a sqlite file', 'utf8');

    const stateDbPath = path.join(dir, 'state.vscdb');
    const stateDb = new DatabaseSync(stateDbPath);
    stateDb.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
    stateDb
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('google.google-antigravity', JSON.stringify({ lastConversationId: goodId }));
    stateDb.close();

    const nodeClient = await createSqliteClient();
    let fallbackClient: SqliteClient | null = null;
    try {
      fallbackClient = await createSqliteClient({ forceCliFallback: true });
    } catch {
      fallbackClient = null;
    }

    try {
      const nodeReader = new LocalTelemetryReader(nodeClient, {
        antigravityRoot: agRoot,
        workspaceStateDbPath: stateDbPath,
      });
      const [snapA, snapB] = await Promise.all([nodeReader.read(), nodeReader.read()]);
      assert.equal(snapA.callsById.get(goodId)?.length, 1);
      assert.equal(snapB.callsById.get(goodId)?.length, 1);
      assert.equal(snapA.callsById.get(goodId)?.[0].fresh, 555);
      assert.equal(snapA.lastConversationId, goodId);

      if (fallbackClient) {
        const cliReader = new LocalTelemetryReader(fallbackClient, {
          antigravityRoot: agRoot,
          workspaceStateDbPath: stateDbPath,
        });
        const cliSnap = await cliReader.read();
        assert.equal(cliSnap.lastConversationId, goodId);
        assert.equal(cliSnap.callsById.get(goodId)?.length, 1);
        assert.equal(cliSnap.callsById.get(goodId)?.[0].fresh, 555);
        assert.equal(
          cliSnap.summaries.find((s) => s.conversationId === goodId)?.subagentRole,
          'Parity Role',
        );
      }
    } finally {
      nodeClient.dispose();
      fallbackClient?.dispose();
    }
  });
});

test('cold historical DBs are skipped on fast ticks when not dirty/active, and re-scanned on forceRescan or after 60s sweep window; dirty DBs are synced immediately', async () => {
  await withTempDir(async (dir) => {
    const agRoot = path.join(dir, 'antigravity');
    const convDir = path.join(agRoot, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    const coldId = '11111111-aaaa-4aaa-8aaa-111111111111';
    const recentId = '22222222-bbbb-4bbb-8bbb-222222222222';
    const coldDirtyId = '33333333-cccc-4ccc-8ccc-333333333333';

    const sumDb = createConversationSummariesDb(path.join(agRoot, 'conversation_summaries.db'));
    const insertSummary = sumDb.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, agent_name, parent_conversation_id,
        nesting_depth, not_fully_idle, killed, last_user_input_time, raw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertSummary.run(
      coldId,
      'Cold Session',
      '',
      1,
      '2026-11-13 20:00:00+00:00',
      '["file:///repo/test"]',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
      0,
      0,
      0,
      '2026-11-13 20:00:00+00:00',
      new Uint8Array(0),
    );
    insertSummary.run(
      recentId,
      'Recent Session',
      '',
      1,
      new Date().toISOString(),
      '["file:///repo/test"]',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
      0,
      0,
      0,
      new Date().toISOString(),
      new Uint8Array(0),
    );
    insertSummary.run(
      coldDirtyId,
      'Cold Dirty Session',
      '',
      1,
      '2026-11-13 19:00:00+00:00',
      '["file:///repo/test"]',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
      0,
      0,
      0,
      '2026-11-13 19:00:00+00:00',
      new Uint8Array(0),
    );
    sumDb.close();

    const coldDbPath = path.join(convDir, `${coldId}.db`);
    const coldDb = createConversationDb(coldDbPath);
    coldDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(
        0,
        buildGenBlob({ model: 'gemini-2.5-pro', stepIndices: [1], fresh: 100, cacheRead: 0, output: 10 }),
        32,
      );
    coldDb.close();
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await fs.utimes(coldDbPath, twoHoursAgo, twoHoursAgo);

    const recentDbPath = path.join(convDir, `${recentId}.db`);
    const recentDb = createConversationDb(recentDbPath);
    recentDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(
        0,
        buildGenBlob({ model: 'gemini-2.5-pro', stepIndices: [1], fresh: 200, cacheRead: 0, output: 20 }),
        32,
      );
    recentDb.close();
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await fs.utimes(recentDbPath, twoMinutesAgo, twoMinutesAgo);

    const coldDirtyDbPath = path.join(convDir, `${coldDirtyId}.db`);
    const coldDirtyDb = createConversationDb(coldDirtyDbPath);
    coldDirtyDb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(
        0,
        buildGenBlob({ model: 'gemini-2.5-pro', stepIndices: [1], fresh: 300, cacheRead: 0, output: 30 }),
        32,
      );
    coldDirtyDb.close();
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
    await fs.utimes(coldDirtyDbPath, threeHoursAgo, threeHoursAgo);

    const statPaths: string[] = [];
    const origStat = fs.stat;
    fs.stat = async (p: any, ...args: any[]) => {
      statPaths.push(path.resolve(String(p)));
      return (origStat as any)(p, ...args);
    };

    const sqlite = await createSqliteClient();
    try {
      const reader = new LocalTelemetryReader(sqlite, { antigravityRoot: agRoot });

      // 1. Initial read: full sweep runs, stats all DBs
      const snap1 = await reader.read();
      assert.equal(snap1.callsById.get(coldId)?.length, 1);
      assert.equal(snap1.callsById.get(recentId)?.length, 1);
      assert.equal(snap1.callsById.get(coldDirtyId)?.length, 1);
      assert.ok(statPaths.includes(path.resolve(coldDbPath)));
      assert.ok(statPaths.includes(path.resolve(recentDbPath)));
      assert.ok(statPaths.includes(path.resolve(coldDirtyDbPath)));

      // 2. Fast tick: cold DBs are skipped on stat; recent DB is statted
      statPaths.length = 0;
      const snap2 = await reader.readAll();
      assert.equal(statPaths.includes(path.resolve(coldDbPath)), false);
      assert.equal(statPaths.includes(path.resolve(coldDirtyDbPath)), false);
      assert.equal(statPaths.includes(path.resolve(recentDbPath)), true);
      assert.equal(snap2.callsById.get(coldId)?.length, 1);
      assert.equal(snap2.callsById.get(recentId)?.length, 1);
      assert.equal(snap2.callsById.get(coldDirtyId)?.length, 1);

      // 3. Dirty-aware read: append row to coldDirtyId and pass dirtyConversationIds
      const dirtyWriter = new DatabaseSync(coldDirtyDbPath);
      dirtyWriter
        .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
        .run(
          1,
          buildGenBlob({ model: 'gemini-2.5-pro', stepIndices: [2], fresh: 999, cacheRead: 0, output: 99 }),
          32,
        );
      dirtyWriter.close();
      await fs.utimes(coldDirtyDbPath, threeHoursAgo, threeHoursAgo);
      try {
        await fs.utimes(`${coldDirtyDbPath}-wal`, threeHoursAgo, threeHoursAgo);
      } catch {}

      statPaths.length = 0;
      const snapDirty = await reader.readAll({ dirtyConversationIds: new Set([coldDirtyId]) });
      assert.equal(statPaths.includes(path.resolve(coldDirtyDbPath)), true);
      assert.equal(statPaths.includes(path.resolve(coldDbPath)), false);
      assert.equal(snapDirty.callsById.get(coldDirtyId)?.length, 2);
      assert.equal(snapDirty.callsById.get(coldDirtyId)?.[1].fresh, 999);

      // 4. Active conversation: active cold DB is statted even when not dirty
      statPaths.length = 0;
      const snapActive = await reader.readAll({ activeConversationIds: new Set([coldId]) });
      assert.equal(statPaths.includes(path.resolve(coldDbPath)), true);
      assert.equal(statPaths.includes(path.resolve(coldDirtyDbPath)), false);

      // 5. Sweep window expiration: after 60s, all DBs are re-scanned
      statPaths.length = 0;
      const snapSweep = await reader.readAll({ nowMs: Date.now() + 65_000 });
      assert.equal(statPaths.includes(path.resolve(coldDbPath)), true);
      assert.equal(statPaths.includes(path.resolve(coldDirtyDbPath)), true);
      assert.equal(statPaths.includes(path.resolve(recentDbPath)), true);

      // 6. forceRescan: all DBs are re-scanned on force
      statPaths.length = 0;
      const snapForce = await reader.readAll(true);
      assert.equal(statPaths.includes(path.resolve(coldDbPath)), true);
      assert.equal(statPaths.includes(path.resolve(coldDirtyDbPath)), true);
      assert.equal(statPaths.includes(path.resolve(recentDbPath)), true);
    } finally {
      fs.stat = origStat;
      sqlite.dispose();
    }
  });
});

test('conversations/ directory readdir is skipped when dir mtime has not changed within the sweep window', async () => {
  await withTempDir(async (dir) => {
    const agRoot = path.join(dir, 'antigravity');
    const convDir = path.join(agRoot, 'conversations');
    await fs.mkdir(convDir, { recursive: true });

    const c1 = createConversationDb(path.join(convDir, 'c1.db'));
    c1.close();

    const origReaddir = fs.readdir;
    const readdirCalls: string[] = [];
    fs.readdir = async (p: any, ...args: any[]) => {
      readdirCalls.push(path.resolve(String(p)));
      return (origReaddir as any)(p, ...args);
    };

    const sqlite = await createSqliteClient();
    try {
      const reader = new LocalTelemetryReader(sqlite, { antigravityRoot: agRoot });

      // 1. Initial read: readdir called
      await reader.read();
      assert.equal(readdirCalls.filter((p) => p === path.resolve(convDir)).length, 1);

      // 2. Fast tick: readdir skipped because dir mtime did not change
      readdirCalls.length = 0;
      await reader.read();
      assert.equal(readdirCalls.filter((p) => p === path.resolve(convDir)).length, 0);

      // 3. Fast tick with readAll({}): readdir skipped
      readdirCalls.length = 0;
      await reader.readAll({});
      assert.equal(readdirCalls.filter((p) => p === path.resolve(convDir)).length, 0);

      // 4. Adding a file to convDir updates dir mtime -> readdir runs
      const c2 = createConversationDb(path.join(convDir, 'c2.db'));
      c2.close();
      const futureTime = new Date(Date.now() + 5000);
      await fs.utimes(convDir, futureTime, futureTime);

      readdirCalls.length = 0;
      const snapNew = await reader.read();
      assert.equal(readdirCalls.filter((p) => p === path.resolve(convDir)).length, 1);
      assert.ok(snapNew.callsById.has('c2'));

      // 5. Fast tick with unchanged dir: readdir skipped again
      readdirCalls.length = 0;
      await reader.read();
      assert.equal(readdirCalls.filter((p) => p === path.resolve(convDir)).length, 0);

      // 6. After 60s sweep window: readdir runs
      readdirCalls.length = 0;
      await reader.read({ nowMs: Date.now() + 70_000 });
      assert.equal(readdirCalls.filter((p) => p === path.resolve(convDir)).length, 1);

      // 7. forceRescan = true: readdir runs
      readdirCalls.length = 0;
      await reader.readAll(true);
      assert.equal(readdirCalls.filter((p) => p === path.resolve(convDir)).length, 1);
    } finally {
      fs.readdir = origReaddir;
      sqlite.dispose();
    }
  });
});


