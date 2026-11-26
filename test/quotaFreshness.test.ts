import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFreshQuota, snapshotFreshnessMs } from '../src/core/quotaFreshness.ts';
import type { QuotaSnapshot, QuotaWindow } from '../src/types.ts';

function win(fraction: number, resetTime: string | null): QuotaWindow {
  const pct = Math.round(fraction * 100);
  return {
    window: '5h',
    remainingPct: pct,
    remainingFraction: fraction,
    resetTime,
    isReady: fraction > 0,
    isExhausted: fraction === 0,
  };
}

function snap(status: QuotaSnapshot['status'], gemini5h: QuotaWindow, fetchedAt = 0): QuotaSnapshot {
  return {
    status,
    source: status === 'online' ? 'summary' : 'none',
    pools: {
      gemini: { key: 'gemini', displayName: 'Gemini Models', fiveHour: gemini5h, weekly: null },
      nonGoogle: { key: 'nonGoogle', displayName: 'Claude & GPT', fiveHour: null, weekly: null },
    },
    fetchedAt,
  };
}

test('snapshotFreshnessMs returns the earliest resetTime across windows, -Infinity with none', () => {
  const s = snap('online', win(0.5, '2026-11-26T17:45:44Z'));
  s.pools.nonGoogle.weekly = win(0.2, '2026-12-03T09:15:42Z');
  assert.strictEqual(snapshotFreshnessMs(s), Date.parse('2026-11-26T17:45:44Z'));

  const empty = snap('online', null as any);
  empty.pools.gemini.fiveHour = null;
  assert.strictEqual(snapshotFreshnessMs(empty), Number.NEGATIVE_INFINITY);
});

test('selectFreshQuota prefers later resetTime over higher fraction', () => {
  // Live shape at 15:49Z: hub A lagging with an old exhausted window, hub B current.
  const lagging = snap('online', win(0, '2026-11-26T14:15:42Z'), 1000);
  const current = snap('online', win(0.436, '2026-11-26T19:25:51Z'), 1000);
  assert.strictEqual(selectFreshQuota([lagging, current]), current);
  assert.strictEqual(selectFreshQuota([current, lagging]), current, 'order independent');
});

test('selectFreshQuota ignores offline snapshots and falls back to the first when none are online', () => {
  const offline = snap('offline', null as any, 5000);
  offline.pools.gemini.fiveHour = null;
  const online = snap('online', win(0.1, '2026-11-26T19:25:51Z'), 1);
  assert.strictEqual(selectFreshQuota([offline, online]), online);
  assert.strictEqual(selectFreshQuota([offline]), offline);
  assert.strictEqual(selectFreshQuota([]).status, 'offline', 'empty poll yields an offline snapshot');
});

test('selectFreshQuota breaks resetTime ties by later fetchedAt', () => {
  const older = snap('online', win(0.9, '2026-11-26T19:25:51Z'), 1);
  const newer = snap('online', win(0.3, '2026-11-26T19:25:51Z'), 2);
  assert.strictEqual(selectFreshQuota([older, newer]), newer);
});
test('selectFreshQuota breaks a shared long window by the window that rolled most recently', () => {
  // Live case, 18:19Z: both hubs report the same weekly resetTime (a long, stable
  // window), but only the current one has rolled its 5h bucket forward. Taking the
  // latest resetTime across windows ties them and picks whichever hub came first.
  const sameWeekly = '2026-12-03T09:15:42Z';
  const lagging = snap('online', win(0.0131, '2026-11-26T17:45:44Z'), 1000);
  lagging.pools.gemini.weekly = win(0.4974, sameWeekly);
  const current = snap('online', win(1, '2026-11-26T22:45:44Z'), 1000);
  current.pools.gemini.weekly = win(0.4974, sameWeekly);

  assert.strictEqual(selectFreshQuota([lagging, current]), current);
  assert.strictEqual(selectFreshQuota([current, lagging]), current, 'order independent');
});
