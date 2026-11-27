import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AccountStore, BACKUP_SCHEMA, SNAPSHOT_FILE_NAME } from '../src/accounts/accountStore.ts';
import type { AccountIdentity, QuotaSnapshot, QuotaWindow } from '../src/types.ts';

function fakeGlobalState() {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        map.delete(key);
      } else {
        map.set(key, value);
      }
    },
  };
}

interface Harness {
  dir: string;
  store: AccountStore;
  state: Map<string, unknown>;
}

async function makeStore(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-acctstore-'));
  const state = fakeGlobalState();
  const store = new AccountStore({
    globalState: state,
    globalStorageUri: dir,
  });
  return { dir, store, state: state as unknown as Map<string, unknown> };
}

function identity(overrides: Partial<AccountIdentity> = {}): AccountIdentity {
  return {
    email: 'Dev@Example.COM',
    displayName: 'Dev One',
    plan: 'Google AI Pro',
    ...overrides,
  };
}

function win(remainingPct: number, resetTime: string | null, window: '5h' | 'weekly' = '5h'): QuotaWindow {
  return {
    window,
    remainingPct,
    remainingFraction: remainingPct / 100,
    resetTime,
    isReady: remainingPct > 0,
    isExhausted: remainingPct === 0,
  };
}

function snap(gemini5h: QuotaWindow, weekly: QuotaWindow | null = null, fetchedAt = 1000): QuotaSnapshot {
  return {
    status: 'online',
    source: 'summary',
    pools: {
      gemini: { key: 'gemini', displayName: 'Gemini Models', fiveHour: gemini5h, weekly },
      nonGoogle: { key: 'nonGoogle', displayName: 'Claude & GPT', fiveHour: null, weekly: null },
    },
    fetchedAt,
  };
}

test('upsertSeenAccount normalizes email, tracks first/last seen, and flips status', async () => {
  const { store } = await makeStore();
  const a = await store.upsertSeenAccount(identity(), true, '2026-11-27T10:00:00.000Z');
  assert.equal(a.email, 'dev@example.com');
  assert.equal(a.status, 'active');
  assert.equal(a.firstSeenAt, '2026-11-27T10:00:00.000Z');

  const again = await store.upsertSeenAccount(
    identity({ email: '  DEV@example.com ' }),
    false,
    '2026-11-27T11:00:00.000Z',
  );
  assert.equal(again.firstSeenAt, '2026-11-27T10:00:00.000Z', 'firstSeenAt preserved');
  assert.equal(again.lastSeenAt, '2026-11-27T11:00:00.000Z');
  assert.equal(again.status, 'saved', 'active account seen as inactive becomes saved');
  assert.equal(store.listAccounts().length, 1, 'no duplicate for case/whitespace variants');
});

test('updateMetadata edits label/group/colorTag and returns null for unknown email', async () => {
  const { store } = await makeStore();
  await store.upsertSeenAccount(identity(), true);
  const updated = await store.updateMetadata('dev@example.com', { label: 'Work', colorTag: '#0af' });
  assert.equal(updated?.label, 'Work');
  assert.equal(updated?.colorTag, '#0af');
  assert.equal(await store.updateMetadata('nobody@example.com', { label: 'X' }), null);
});

test('removeAccount refuses the active account, reports not_found, and otherwise removes', async () => {
  const { store } = await makeStore();
  await store.upsertSeenAccount(identity(), true, '2026-11-27T10:00:00.000Z');
  await store.upsertSeenAccount(identity({ email: 'Other@Example.com' }), false);

  const refused = await store.removeAccount('dev@example.com', 'dev@example.com');
  assert.deepEqual(refused, { removed: false, reason: 'active_account' });

  const missing = await store.removeAccount('ghost@example.com', 'dev@example.com');
  assert.deepEqual(missing, { removed: false, reason: 'not_found' });

  const ok = await store.removeAccount('OTHER@example.com', 'dev@example.com');
  assert.deepEqual(ok, { removed: true });
  assert.equal(store.listAccounts().length, 1);
});

test('saveSnapshot/getSnapshot: inactive account with past resetTime is stale but keeps remainingPct', async () => {
  const { store } = await makeStore();
  await store.upsertSeenAccount(identity(), false);
  const past = snap(win(37.5, '2026-11-27T09:00:00.000Z'));
  past.pools.gemini.weekly = win(80, '2026-12-30T00:00:00.000Z', 'weekly');
  await store.saveSnapshot('dev@example.com', past);

  const nowMs = Date.parse('2026-11-27T12:00:00.000Z');
  const got = store.getSnapshot('dev@example.com', false, nowMs);
  assert.ok(got, 'snapshot exists');
  assert.equal(got.isStale, true, 'past resetTime marks stale');
  assert.equal(got.pools.gemini.fiveHour?.remainingPct, 37.5, 'last recorded pct kept');
  assert.notEqual(got.pools.gemini.fiveHour?.remainingPct, 100, 'never clamped to 100%');
  assert.equal(got.pools.gemini.fiveHour?.resetTime, '2026-11-27T09:00:00.000Z', 'resetTime untouched');
  assert.equal(got.pools.gemini.weekly?.remainingPct, 80, 'future window untouched');
});

test('getSnapshot: active account is never marked stale; future resetTime is not stale', async () => {
  const { store } = await makeStore();
  await store.upsertSeenAccount(identity(), false);
  const future = snap(win(37.5, '2026-11-27T23:00:00.000Z'));
  await store.saveSnapshot('dev@example.com', future);

  const nowMs = Date.parse('2026-11-27T12:00:00.000Z');
  assert.equal(store.getSnapshot('dev@example.com', false, nowMs)?.isStale ?? false, false);
  assert.equal(store.getSnapshot('dev@example.com', true, nowMs)?.isStale ?? false, false);

  const past = snap(win(10, '2026-11-27T09:00:00.000Z'));
  await store.saveSnapshot('dev@example.com', past);
  assert.equal(store.getSnapshot('dev@example.com', true, nowMs)?.isStale ?? false, false, 'active never stale');
  assert.equal(store.getSnapshot('nobody@example.com', false, nowMs), null);
});

test('registry persists via globalState and snapshots persist to account-snapshots.json', async () => {
  const h = await makeStore();
  await h.store.load();
  await h.store.upsertSeenAccount(identity(), true);
  await h.store.saveSnapshot('dev@example.com', snap(win(55, '2026-11-27T23:00:00.000Z')));

  const revived = new AccountStore({ globalState: h.state as never, globalStorageUri: h.dir });
  await revived.load();
  assert.equal(revived.listAccounts()[0]?.email, 'dev@example.com');
  assert.equal(revived.getSnapshot('dev@example.com', false, Date.now())?.pools.gemini.fiveHour?.remainingPct, 55);

  const raw = await fs.readFile(path.join(h.dir, SNAPSHOT_FILE_NAME), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'snapshot file is valid JSON');
  const leftovers = (await fs.readdir(h.dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');
});

test('load tolerates a missing or corrupt snapshot file', async () => {
  const { dir, store, state } = await makeStore();
  await store.upsertSeenAccount(identity(), true);
  await fs.writeFile(path.join(dir, SNAPSHOT_FILE_NAME), '{not json', 'utf8');
  const revived = new AccountStore({ globalState: state as never, globalStorageUri: dir });
  await assert.doesNotReject(() => revived.load());
  assert.equal(revived.listAccounts().length, 1);
  assert.equal(revived.getSnapshot('dev@example.com', false, Date.now()), null);
});

test('exportBackupJson is metadata-only with the v1 schema and zero secret fields', async () => {
  const { store } = await makeStore();
  await store.upsertSeenAccount(identity(), true);
  await store.saveSnapshot('dev@example.com', snap(win(12, '2026-11-27T09:00:00.000Z')));

  const json = store.exportBackupJson();
  const parsed = JSON.parse(json) as { schema: string; accounts: Array<Record<string, unknown>> };
  assert.equal(parsed.schema, 'gravitywatch.accounts.backup.v1');
  assert.equal(parsed.accounts.length, 1);
  assert.equal(parsed.accounts[0]!.email, 'dev@example.com');
  assert.equal(parsed.accounts[0]!.label, undefined);

  assert.ok(!/token|secret|credential|password|oauth/i.test(json), 'no credential-ish strings in export');
  assert.ok(!('snapshot' in parsed.accounts[0]!), 'no snapshot payload in export');
});

test('export -> import round-trip restores accounts and skips invalid entries', async () => {
  const source = await makeStore();
  await source.store.load();
  await source.store.upsertSeenAccount(identity(), true);
  await source.store.upsertSeenAccount(identity({ email: 'two@example.com', displayName: 'Two' }), false);
  await source.store.updateMetadata('dev@example.com', { label: 'Work', group: 'team-a', colorTag: '#f0a' });

  const json = source.store.exportBackupJson();

  const target = await makeStore();
  await target.store.load();
  const result = await target.store.importBackupJson(json);
  assert.deepEqual(result, { imported: 2, skipped: 0 });

  const restored = target.store.listAccounts().find((a) => a.email === 'dev@example.com');
  assert.ok(restored);
  assert.equal(restored.label, 'Work');
  assert.equal(restored.group, 'team-a');
  assert.equal(restored.colorTag, '#f0a');
  assert.equal(restored.status, 'saved', 'imported accounts are not marked active');
  assert.equal(target.store.getSnapshot('dev@example.com', false, Date.now()), null, 'no snapshots in backup');

  // Existing local metadata wins on re-import; entries without an email are skipped.
  await target.store.updateMetadata('dev@example.com', { label: 'Local' });
  const bad = JSON.stringify({
    schema: 'gravitywatch.accounts.backup.v1',
    accounts: [{ displayName: 'No Email' }, { email: '  ' }, restored],
  });
  const second = await target.store.importBackupJson(bad);
  assert.deepEqual(second, { imported: 1, skipped: 2 }, 'valid email merges, blanks skipped');
  assert.equal(target.store.listAccounts().find((a) => a.email === 'dev@example.com')?.label, 'Local');

  await assert.rejects(() => target.store.importBackupJson('{"schema":"other.v9"}'));
});

test('upsertSeenAccount demotes any other active row so exactly one Account stays active (C3)', async () => {
  const { store } = await makeStore();
  const a = await store.upsertSeenAccount(identity({ email: 'a@example.com' }), true, '2026-11-27T10:00:00.000Z');
  assert.equal(a.status, 'active');
  const b = await store.upsertSeenAccount(identity({ email: 'b@example.com' }), true, '2026-11-27T10:01:00.000Z');
  assert.equal(b.status, 'active');
  const accounts = store.listAccounts();
  assert.equal(accounts.filter((x) => x.status === 'active').length, 1, 'exactly one active Account after the second upsert');
  assert.equal(accounts.find((x) => x.email === 'a@example.com')?.status, 'saved', 'previous active demoted to saved');
  assert.equal(accounts.find((x) => x.email === 'b@example.com')?.status, 'active');
});

test('importBackupJson skips rows whose email is not a valid address (M4)', async () => {
  const { store } = await makeStore();
  const json = JSON.stringify({
    schema: BACKUP_SCHEMA,
    accounts: [
      { email: '../../x', displayName: 'Traversal' },
      { email: 'valid@example.com', displayName: 'Valid' },
    ],
  });
  const result = await store.importBackupJson(json);
  assert.deepEqual(result, { imported: 1, skipped: 1 }, 'invalid email row skipped and counted');
  assert.equal(store.listAccounts().some((a) => a.email === '../../x'), false, 'path-like email never seeded');
  assert.equal(store.listAccounts().some((a) => a.email === 'valid@example.com'), true);
});
