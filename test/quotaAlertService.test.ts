import test from 'node:test';
import assert from 'node:assert/strict';

import { QuotaAlertService } from '../src/accounts/quotaAlertService.ts';
import type { ManagedAccount, PoolKey, QuotaPool, QuotaSnapshot } from '../src/types.ts';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const CONFIG = { enableLowQuotaAlerts: true, lowQuotaThresholdPct: 20, notifyQuotaReset: true };

function makePool(fiveHourPct: number | null, weeklyPct: number | null, resetTime: string | null = 'T1'): QuotaPool {
  const win = (window: '5h' | 'weekly', pct: number | null) =>
    pct === null
      ? null
      : {
          window,
          remainingPct: pct,
          remainingFraction: pct / 100,
          resetTime,
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

function snapshot(
  pools: Partial<Record<PoolKey, QuotaPool>>,
  overrides: Partial<QuotaSnapshot> = {},
): QuotaSnapshot {
  return {
    status: 'online',
    source: 'summary',
    pools: pools as QuotaSnapshot['pools'],
    fetchedAt: NOW,
    ...overrides,
  };
}

function account(email: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    email,
    firstSeenAt: new Date(NOW).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    status: 'active',
    ...overrides,
  };
}

function evaluate(
  service: QuotaAlertService,
  email: string,
  snap: QuotaSnapshot,
  alternatives: Parameters<QuotaAlertService['evaluate']>[0]['alternatives'] = [],
  config = CONFIG,
) {
  return service.evaluate({ email, snapshot: snap, alternatives, config, nowMs: NOW });
}

test('low alert fires once and is deduplicated across repeated polls with the same tuple', () => {
  const service = new QuotaAlertService();
  const snap = snapshot({ gemini: makePool(15, 90) });

  const first = evaluate(service, 'dev@example.com', snap);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'low');
  assert.deepEqual(first[0].pools, [
    { poolKey: 'gemini', window: '5h', remainingPct: 15, resetTime: 'T1' },
  ]);

  assert.deepEqual(evaluate(service, 'dev@example.com', snap), []);
});

test('dedup key is stable against email case and surrounding whitespace', () => {
  const service = new QuotaAlertService();
  const snap = snapshot({ gemini: makePool(0, 50) });

  assert.equal(evaluate(service, 'dev@example.com', snap).length, 1);
  assert.deepEqual(evaluate(service, '  DEV@Example.COM ', snap), []);
});

test('multiple newly exhausted windows aggregate into ONE exhausted event', () => {
  const service = new QuotaAlertService();
  const snap = snapshot({
    gemini: makePool(0, 0),
    nonGoogle: makePool(0, 80),
  });

  const events = evaluate(service, 'dev@example.com', snap);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'exhausted');
  assert.deepEqual(
    events[0].pools.map((p) => `${p.poolKey}:${p.window}`),
    ['gemini:5h', 'gemini:weekly', 'nonGoogle:5h'],
  );
});

test('bestAlternative picks highest min remaining among non-stale alternatives with > 0%', () => {
  const service = new QuotaAlertService();
  const snap = snapshot({ gemini: makePool(0, 80) });
  const alternatives = [
    // Stale: excluded even with full quota.
    { account: account('stale@example.com'), snapshot: snapshot({ gemini: makePool(100, 100) }, { isStale: true }) },
    // null snapshot: excluded.
    { account: account('gone@example.com'), snapshot: null },
    // min 0%: not > 0, excluded.
    { account: account('empty@example.com'), snapshot: snapshot({ gemini: makePool(50, 0) }) },
    // min 30%: candidate.
    { account: account('ok@example.com', { label: 'Work' }), snapshot: snapshot({ gemini: makePool(30, 90) }) },
    // min 60%: best.
    { account: account('rich@example.com'), snapshot: snapshot({ gemini: makePool(60, 100) }) },
  ];

  const events = evaluate(service, 'dev@example.com', snap, alternatives);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'exhausted');
  assert.deepEqual(events[0].bestAlternative, { email: 'rich@example.com', minRemainingPct: 60 });
});

test('bestAlternative is null when no alternative has non-stale > 0% quota', () => {
  const service = new QuotaAlertService();
  const snap = snapshot({ gemini: makePool(0, 80) });
  const alternatives = [
    { account: account('empty@example.com'), snapshot: snapshot({ gemini: makePool(0, 10) }) },
  ];

  const events = evaluate(service, 'dev@example.com', snap, alternatives);
  assert.equal(events[0].bestAlternative, null);
});

test('reset fires when a flagged tuple rolls forward to a new resetTime', () => {
  const service = new QuotaAlertService();
  const low = snapshot({ gemini: makePool(10, 90, 'T1') });
  assert.equal(evaluate(service, 'dev@example.com', low).length, 1);

  const rolled = snapshot({ gemini: makePool(10, 90, 'T2') });
  const events = evaluate(service, 'dev@example.com', rolled);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'reset');
  assert.equal(events[0].pools[0].window, '5h');
});

test('reset fires when a flagged tuple recovers above threshold with the same resetTime', () => {
  const service = new QuotaAlertService();
  assert.equal(evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(10, 90) })).length, 1);

  const recovered = snapshot({ gemini: makePool(55, 90) });
  const events = evaluate(service, 'dev@example.com', recovered);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'reset');

  // After the reset, a fresh drop within the same window may alert again.
  const dropped = snapshot({ gemini: makePool(10, 90) });
  const again = evaluate(service, 'dev@example.com', dropped);
  assert.equal(again.length, 1);
  assert.equal(again[0].kind, 'low');
});

test('tuple that never dropped below threshold never produces a reset event', () => {
  const service = new QuotaAlertService();
  assert.deepEqual(evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(80, 70) })), []);
  // resetTime rolls forward while quota was always healthy: no reset.
  assert.deepEqual(evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(80, 70, 'T2') })), []);
});

test('reset notifications are gated by notifyQuotaReset', () => {
  const service = new QuotaAlertService();
  const config = { ...CONFIG, notifyQuotaReset: false };
  assert.equal(evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(10, 90) }), [], config).length, 1);
  assert.deepEqual(
    evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(10, 90, 'T2') }), [], config),
    [],
  );
});

test('low and exhausted alerts are gated by enableLowQuotaAlerts', () => {
  const service = new QuotaAlertService();
  const config = { ...CONFIG, enableLowQuotaAlerts: false };
  assert.deepEqual(
    evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(10, 0) }), [], config),
    [],
  );
  // No alerts were raised, so nothing is flagged: no reset on recovery either.
  assert.deepEqual(
    evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(80, 80) }), [], config),
    [],
  );
});

test('missing pools, missing windows, offline and stale snapshots are no-data, never 0%', () => {
  const service = new QuotaAlertService();
  const pool = makePool(null, null);
  assert.deepEqual(
    evaluate(service, 'dev@example.com', snapshot({ gemini: pool, nonGoogle: undefined as never })),
    [],
  );
  assert.deepEqual(
    evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(0, 0) }, { status: 'offline' })),
    [],
  );
  assert.deepEqual(
    evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(0, 0) }, { isStale: true })),
    [],
  );
});
