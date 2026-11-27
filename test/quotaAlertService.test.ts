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

test('low escalates to exhausted at the same resetTime; exhausted carries bestAlternative; repeats deduped', () => {
  const service = new QuotaAlertService();
  const low = evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(15, 90, 'T1') }));
  assert.equal(low.length, 1);
  assert.equal(low[0].kind, 'low');

  const alternatives = [
    { account: account('rich@example.com'), snapshot: snapshot({ gemini: makePool(60, 100) }) },
  ];
  const exhausted = evaluate(
    service,
    'dev@example.com',
    snapshot({ gemini: makePool(0, 90, 'T1') }),
    alternatives,
  );
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].kind, 'exhausted');
  assert.deepEqual(exhausted[0].bestAlternative, { email: 'rich@example.com', minRemainingPct: 60 });

  // Same kind again: deduped.
  assert.deepEqual(
    evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(0, 90, 'T1') }), alternatives),
    [],
  );
});

test('no reset event when a flagged tuple rolls forward while still exhausted', () => {
  const service = new QuotaAlertService();
  assert.equal(evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(0, 50, 'T1') })).length, 1);

  // resetTime rolls but quota is still 0%: no reset.
  assert.deepEqual(evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(0, 50, 'T2') })), []);

  // Next poll under the new resetTime emits a fresh exhausted alert, exactly once.
  const again = evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(0, 50, 'T2') }));
  assert.equal(again.length, 1);
  assert.equal(again[0].kind, 'exhausted');
  assert.deepEqual(evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(0, 50, 'T2') })), []);
});

// Old resetTime keys are cleared when a reset fires; a rolled-away key only lingers until
// the eventual reset, so growth stays bounded per (tuple, resetTime).
test('low and exhausted alerts are gated by enableLowQuotaAlerts, but resets are not', () => {
  const service = new QuotaAlertService();
  const config = { ...CONFIG, enableLowQuotaAlerts: false };
  assert.deepEqual(
    evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(10, 0) }), [], config),
    [],
  );
  // The drop was still tracked, so genuine recovery emits a reset.
  const recovered = evaluate(service, 'dev@example.com', snapshot({ gemini: makePool(80, 80) }), [], config);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].kind, 'reset');
});

test('emitted event email is normalized', () => {
  const service = new QuotaAlertService();
  const low = evaluate(service, '  DEV@Example.COM ', snapshot({ gemini: makePool(15, 90) }));
  assert.equal(low[0].email, 'dev@example.com');

  const service2 = new QuotaAlertService();
  const reset = evaluate(service2, '  DEV@Example.COM ', snapshot({ gemini: makePool(10, 90) }));
  assert.equal(reset[0].email, 'dev@example.com');
  const recovered = evaluate(service2, 'DEV@example.com', snapshot({ gemini: makePool(80, 90) }));
  assert.equal(recovered[0].email, 'dev@example.com');
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
