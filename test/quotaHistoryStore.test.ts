import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { QuotaHistoryStore } from '../src/accounts/quotaHistoryStore.ts';
import type { ManagedAccount, PoolKey, QuotaPool, QuotaSnapshot } from '../src/types.ts';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z
const DAY_MS = 86_400_000;

function makePool(fiveHourPct: number | null, weeklyPct: number | null): QuotaPool {
  const win = (window: '5h' | 'weekly', pct: number | null) =>
    pct === null
      ? null
      : {
          window,
          remainingPct: pct,
          remainingFraction: pct / 100,
          resetTime: null,
          isReady: pct > 0,
          isExhausted: pct === 0,
        };
  return {
    key: 'gemini',
    displayName: 'Gemini',
    fiveHour: win('5h', fiveHourPct),
    weekly: win('weekly', weeklyPct),
  };
}

function onlineSnapshot(pools: Partial<Record<PoolKey, QuotaPool>>, overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    status: 'online',
    source: 'summary',
    pools: pools as QuotaSnapshot['pools'],
    fetchedAt: NOW,
    ...overrides,
  };
}

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    email: 'dev@example.com',
    firstSeenAt: new Date(NOW).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    status: 'active',
    ...overrides,
  };
}

interface Harness {
  dir: string;
  store: QuotaHistoryStore;
}

async function makeStore(now: () => number = () => NOW): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-quota-hist-'));
  const store = new QuotaHistoryStore(dir, { now });
  return { dir, store };
}

test('keeps daily minimum per pool across multiple polls on the same UTC date', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot(
    'dev@example.com',
    onlineSnapshot({
      gemini: makePool(70, 50),
      nonGoogle: makePool(80, 60),
    }),
    NOW,
  );
  await store.recordSnapshot(
    'dev@example.com',
    onlineSnapshot({
      gemini: makePool(40, null),
      nonGoogle: makePool(90, 55),
    }),
    NOW + 1000,
  );
  const history = store.getHistory();
  assert.equal(history.length, 2);
  const gemini = history.find((r) => r.poolKey === 'gemini');
  const nonGoogle = history.find((r) => r.poolKey === 'nonGoogle');
  assert.deepEqual(
    { five: gemini?.fiveHourLowestPct, weekly: gemini?.weeklyLowestPct },
    { five: 40, weekly: 50 },
  );
  assert.deepEqual(
    { five: nonGoogle?.fiveHourLowestPct, weekly: nonGoogle?.weeklyLowestPct },
    { five: 80, weekly: 55 },
  );
  assert.equal(gemini?.date, '2026-01-15');
  assert.equal(gemini?.email, 'dev@example.com');
  assert.equal(typeof gemini?.updatedAt, 'number');
});

test('skips stale and non-online snapshots without throwing', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot('dev@example.com', onlineSnapshot({ gemini: makePool(70, 70) }, { isStale: true }), NOW);
  await store.recordSnapshot(
    'dev@example.com',
    onlineSnapshot({ gemini: makePool(70, 70) }, { status: 'offline' }),
    NOW,
  );
  await store.recordSnapshot(
    'dev@example.com',
    onlineSnapshot({ gemini: makePool(70, 70) }, { status: 'error' }),
    NOW,
  );
  assert.equal(store.getHistory().length, 0);
});

test('tolerates missing pools, null windows and missing numeric pct', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot('dev@example.com', onlineSnapshot({ gemini: makePool(null, null) }), NOW);
  await store.recordSnapshot('dev@example.com', onlineSnapshot({}), NOW);
  // Only a numeric window produces a record; null windows never create one.
  assert.equal(store.getHistory().length, 0);
  await store.recordSnapshot(
    'dev@example.com',
    onlineSnapshot({
      gemini: makePool(30, null),
      nonGoogle: makePool(null, 45),
    }),
    NOW,
  );
  const history = store.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history.find((r) => r.poolKey === 'gemini')?.weeklyLowestPct, null);
  assert.equal(history.find((r) => r.poolKey === 'nonGoogle')?.fiveHourLowestPct, null);
});

test('prunes records older than 30 days on record', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot('dev@example.com', onlineSnapshot({ gemini: makePool(70, 70) }), NOW);
  // New poll 31 days later: the old record is pruned, the new one kept.
  await store.recordSnapshot(
    'dev@example.com',
    onlineSnapshot({ gemini: makePool(20, 20) }),
    NOW + 31 * DAY_MS,
  );
  const history = store.getHistory({ nowMs: NOW + 31 * DAY_MS });
  assert.equal(history.length, 1);
  assert.equal(history[0]?.fiveHourLowestPct, 20);
  assert.equal(history[0]?.date, '2026-02-15');
});

test('prunes records older than 30 days on load', async () => {
  const { dir, store } = await makeStore();
  await store.recordSnapshot('dev@example.com', onlineSnapshot({ gemini: makePool(70, 70) }), NOW);
  await store.flush();
  const later = new QuotaHistoryStore(dir, { now: () => NOW + 31 * DAY_MS });
  await later.load();
  assert.equal(later.getHistory({ nowMs: NOW + 31 * DAY_MS }).length, 0);
});

test('roundtrips through atomic persistence', async () => {
  const { dir, store } = await makeStore();
  await store.recordSnapshot(
    'dev@example.com',
    onlineSnapshot({ gemini: makePool(70, 50), nonGoogle: makePool(80, 60) }),
    NOW,
  );
  await store.flush();
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['quota-history.json']);
  const reopened = new QuotaHistoryStore(dir, { now: () => NOW });
  await reopened.load();
  assert.deepEqual(reopened.getHistory(), store.getHistory());
});

test('flush is safe when nothing is dirty', async () => {
  const { dir, store } = await makeStore();
  await store.load(); // no file yet
  await store.flush();
  await store.flush();
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, []);
});

test('getHistory filters by email and day window', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot('a@example.com', onlineSnapshot({ gemini: makePool(10, 10) }), NOW - 3 * DAY_MS);
  await store.recordSnapshot('b@example.com', onlineSnapshot({ gemini: makePool(20, 20) }), NOW);
  await store.recordSnapshot('a@example.com', onlineSnapshot({ gemini: makePool(30, 30) }), NOW);
  assert.equal(store.getHistory({ email: 'a@example.com' }).length, 2);
  assert.equal(store.getHistory({ days: 1 }).length, 2); // both accounts, today only
  assert.equal(store.getHistory({ days: 30 }).length, 3);
});

test('exportCsv emits header and quote-escapes label and group', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot('dev@example.com', onlineSnapshot({ gemini: makePool(70, 50) }), NOW);
  const accounts = new Map<string, ManagedAccount>([
    ['dev@example.com', account({ label: 'Main, Work', group: 'Team "A"' })],
  ]);
  const csv = store.exportCsv(accounts, 30, NOW);
  const lines = csv.split('\n');
  assert.equal(
    lines[0],
    'date,email,label,group,poolKey,fiveHourLowestPct,weeklyLowestPct,updatedAt',
  );
  assert.match(lines[1] ?? '', /^2026-01-15,dev@example\.com,"Main, Work","Team ""A""",gemini,70,50,/);
});

test('exportCsv leaves plain label and group unquoted', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot('dev@example.com', onlineSnapshot({ gemini: makePool(70, 50) }), NOW);
  const accounts = new Map<string, ManagedAccount>([['dev@example.com', account({ label: 'Main', group: 'Team' })]]);
  const lines = store.exportCsv(accounts, 30, NOW).split('\n');
  assert.match(lines[1] ?? '', /^2026-01-15,dev@example\.com,Main,Team,gemini,70,50,/);
});

test('exportJson uses gravitywatch.analytics.v1 schema and embeds account metadata', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot('dev@example.com', onlineSnapshot({ gemini: makePool(70, 50) }), NOW);
  const accounts = new Map<string, ManagedAccount>([['dev@example.com', account({ label: 'Main', group: 'Team' })]]);
  const parsed = JSON.parse(store.exportJson(accounts, 30, NOW)) as {
    schema: string;
    exportedAt: string;
    records: Array<{ email: string; label?: string; group?: string; fiveHourLowestPct: number | null }>;
  };
  assert.equal(parsed.schema, 'gravitywatch.analytics.v1');
  assert.equal(parsed.exportedAt, new Date(NOW).toISOString());
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]?.label, 'Main');
  assert.equal(parsed.records[0]?.group, 'Team');
  assert.equal(parsed.records[0]?.fiveHourLowestPct, 70);
});

test('unknown emails export with empty label and group', async () => {
  const { store } = await makeStore();
  await store.recordSnapshot('ghost@example.com', onlineSnapshot({ gemini: makePool(70, 50) }), NOW);
  const csv = store.exportCsv(new Map(), 30, NOW);
  assert.match(csv.split('\n')[1] ?? '', /^2026-01-15,ghost@example\.com,,,gemini,70,50,/);
});
