import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QuotaEstimator } from '../src/core/quotaEstimator.ts';
import { DEFAULT_CONTEXT_LIMIT, type QuotaSnapshot, type SessionNode } from '../src/types.ts';

function makeQuota(params: {
  gemini5h?: number;
  geminiWeekly?: number;
  argonWeekly?: number;
  nonGoogle5h?: number;
  nonGoogleWeekly?: number;
  gemini5hReset?: string;
}): QuotaSnapshot {
  const now = Date.now();
  return {
    status: 'online',
    source: 'summary',
    fetchedAt: now,
    pools: {
      gemini: {
        key: 'gemini',
        displayName: 'Gemini Models',
        fiveHour: {
          window: "5h", remainingPct: params.gemini5h ?? 80, remainingFraction: (params.gemini5h ?? 80) / 100,
          resetTime: params.gemini5hReset ?? new Date(now + 3_600_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
        weekly: {
          window: "weekly", remainingPct: params.geminiWeekly ?? 90, remainingFraction: (params.geminiWeekly ?? 90) / 100,
          resetTime: new Date(now + 400_000_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
      },
      argon: {
        key: 'argon',
        displayName: 'Gemini 4 Argon',
        fiveHour: null,
        weekly: {
          window: "weekly", remainingPct: params.argonWeekly ?? 75, remainingFraction: (params.argonWeekly ?? 75) / 100,
          resetTime: new Date(now + 400_000_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
      },
      nonGoogle: {
        key: 'nonGoogle',
        displayName: 'Claude & GPT',
        fiveHour: {
          window: "5h", remainingPct: params.nonGoogle5h ?? 60, remainingFraction: (params.nonGoogle5h ?? 60) / 100,
          resetTime: new Date(now + 3_600_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
        weekly: {
          window: "weekly", remainingPct: params.nonGoogleWeekly ?? 85, remainingFraction: (params.nonGoogleWeekly ?? 85) / 100,
          resetTime: new Date(now + 400_000_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
      },
    },
  };
}

function makeSession(params: {
  id: string;
  model: string;
  fresh: number;
  cacheRead: number;
  output: number;
}): SessionNode {
  return {
    id: params.id,
    title: params.id,
    preview: '',
    model: params.model,
    status: 'CASCADE_RUN_STATUS_IDLE',
    trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    lastModifiedTime: Date.now(),
    lastUserInputTime: Date.now(),
    workspaceUris: [],
    matchesWorkspace: true,
    isSubagent: false,
    parentId: null,
    nestingDepth: 0,
    agentName: '',
    subagentRole: '',
    killed: false,
    notFullyIdle: false,
    own: {
      fresh: params.fresh,
      cacheRead: params.cacheRead,
      output: params.output,
      thinking: 0,
      response: params.output,
      calls: 1,
      compactions: 0,
      isRunning: false,
    },
    rolledUp: {
      fresh: params.fresh,
      cacheRead: params.cacheRead,
      output: params.output,
      thinking: 0,
      response: params.output,
      calls: 1,
      compactions: 0,
      isRunning: false,
    },
    contextUsed: params.fresh + params.cacheRead,
    contextLimit: DEFAULT_CONTEXT_LIMIT,
    contextPct: 10,
    cacheVolumePct: 50,
    callHitPct: 50,
    ownCacheVolumePct: 50,
    ownCallHitPct: 50,
    calls: [
      {
        idx: 0,
        stepIndices: [1],
        model: params.model,
        fresh: params.fresh,
        cacheRead: params.cacheRead,
        output: params.output,
        thinking: 0,
        response: params.output,
        effectiveContext: params.fresh + params.cacheRead,
        contextLimit: DEFAULT_CONTEXT_LIMIT,
        startStepIndex: 0,
        isCompacted: false,
        compactedFromStep: null,
      },
    ],
    children: [],
    subagentCount: 0,
    runningSubagentCount: 0,
    isPinned: false,
    isActive: false,
    isSelected: false,
    dataSource: 'hybrid',
  };
}

test('QuotaEstimator: cold start shows calibrating, single-model delta calibrates remaining tokens', async () => {
  const estimator = new QuotaEstimator();
  const s1 = makeSession({
    id: 's1',
    model: 'Gemini 3.8 Flash',
    fresh: 10_000,
    cacheRead: 40_000,
    output: 2_000,
  });

  // Observation 1: 80% remaining -> calibrating (0 samples)
  const res1 = estimator.observe({
    quota: makeQuota({ gemini5h: 80, geminiWeekly: 90 }),
    nodes: [s1],
    nowMs: 1_000_000,
  });
  const flash1 = res1.find((e) => e.modelLabel === 'Gemini 3.8 Flash');
  assert.ok(flash1);
  assert.equal(flash1.fiveHour?.status, 'calibrating');
  assert.equal(flash1.fiveHour?.estimatedTotalTokens, null);

  // Observation 2: tokens increased by +100k total (+20k billed), gemini 5h dropped 80% -> 75% (-5%)
  // -> 20k total/pct, 4k billed/pct; remaining 75% => 1.5M total, 300k billed
  const s1Updated = makeSession({
    id: 's1',
    model: 'Gemini 3.8 Flash',
    fresh: 25_000,
    cacheRead: 120_000,
    output: 7_000,
  });
  const res2 = estimator.observe({
    quota: makeQuota({ gemini5h: 75, geminiWeekly: 89 }),
    nodes: [s1Updated],
    nowMs: 1_060_000,
  });
  const flash2 = res2.find((e) => e.modelLabel === 'Gemini 3.8 Flash');
  assert.ok(flash2);
  assert.equal(flash2.fiveHour?.status, 'calibrated');
  assert.equal(flash2.fiveHour?.estimatedTotalTokens, 1_500_000);
  assert.equal(flash2.fiveHour?.estimatedBilledTokens, 300_000);
});

test('QuotaEstimator: skips attribution when 2+ models in same pool spend tokens in same interval', () => {
  const estimator = new QuotaEstimator();
  const s1 = makeSession({ id: 's1', model: 'Gemini 3.8 Flash', fresh: 10_000, cacheRead: 10_000, output: 1_000 });
  const s2 = makeSession({ id: 's2', model: 'Gemini 4 Hydrogen', fresh: 10_000, cacheRead: 10_000, output: 1_000 });

  estimator.observe({ quota: makeQuota({ gemini5h: 80 }), nodes: [s1, s2], nowMs: 1_000_000 });

  // Both models spend tokens in the same pool in the same interval
  const s1Next = makeSession({ id: 's1', model: 'Gemini 3.8 Flash', fresh: 20_000, cacheRead: 20_000, output: 2_000 });
  const s2Next = makeSession({ id: 's2', model: 'Gemini 4 Hydrogen', fresh: 30_000, cacheRead: 30_000, output: 3_000 });

  const res = estimator.observe({ quota: makeQuota({ gemini5h: 70 }), nodes: [s1Next, s2Next], nowMs: 1_060_000 });
  const flash = res.find((e) => e.modelLabel === 'Gemini 3.8 Flash');
  const hydrogen = res.find((e) => e.modelLabel === 'Gemini 4 Hydrogen');
  assert.equal(flash?.fiveHour?.status, 'calibrating');
  assert.equal(hydrogen?.fiveHour?.status, 'calibrating');
});

test('QuotaEstimator: persists calibration across load/flush and handles window reset', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-est-'));
  const storagePath = path.join(tmpDir, 'quota-calibration.json');

  try {
    const est1 = new QuotaEstimator({ storagePath });
    await est1.load();
    est1.observe({
      quota: makeQuota({ argonWeekly: 75 }),
      nodes: [makeSession({ id: 'a1', model: 'Gemini 4 Argon (Low)', fresh: 0, cacheRead: 0, output: 0 })],
      nowMs: 1_000,
    });
    est1.observe({
      quota: makeQuota({ argonWeekly: 70 }),
      nodes: [makeSession({ id: 'a1', model: 'Gemini 4 Argon (Low)', fresh: 10_000, cacheRead: 40_000, output: 5_000 })],
      nowMs: 2_000,
    });
    await est1.flush();

    // New instance loads calibration from disk and immediately provides calibrated estimate
    const est2 = new QuotaEstimator({ storagePath });
    await est2.load();
    const res = est2.observe({
      quota: makeQuota({ argonWeekly: 70 }),
      nodes: [makeSession({ id: 'a1', model: 'Gemini 4 Argon (Low)', fresh: 10_000, cacheRead: 40_000, output: 5_000 })],
      nowMs: 3_000,
    });
    const argon = res.find((e) => e.modelLabel === 'Gemini 4 Argon (Low)');
    assert.ok(argon?.weekly);
    assert.equal(argon.weekly.status, 'calibrated');
    assert.ok((argon.weekly.estimatedTotalTokens ?? 0) > 0);

    // Window reset: percentage jumps UP from 70% to 100%, retains calibration curve!
    const resReset = est2.observe({
      quota: makeQuota({ argonWeekly: 100 }),
      nodes: [makeSession({ id: 'a1', model: 'Gemini 4 Argon (Low)', fresh: 10_000, cacheRead: 40_000, output: 5_000 })],
      nowMs: 4_000,
    });
    const argonAfterReset = resReset.find((e) => e.modelLabel === 'Gemini 4 Argon (Low)');
    assert.equal(argonAfterReset?.weekly?.status, 'calibrated');
    assert.ok((argonAfterReset?.weekly?.estimatedTotalTokens ?? 0) > (argon.weekly.estimatedTotalTokens ?? 0));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('QuotaEstimator: recursive child-subagent token aggregation and pre-calibration live visibility', () => {
  const estimator = new QuotaEstimator();

  const grandchild = makeSession({
    id: 'grandchild-1',
    model: 'Gemini 3.8 Flash',
    fresh: 5_000,
    cacheRead: 10_000,
    output: 1_000,
  });

  const child1 = makeSession({
    id: 'child-1',
    model: 'Gemini 3.8 Flash',
    fresh: 10_000,
    cacheRead: 40_000,
    output: 2_000,
  });
  child1.children = [grandchild];

  const root = makeSession({
    id: 'root-coord',
    model: 'Gemini 3.8 Flash',
    fresh: 0,
    cacheRead: 0,
    output: 0,
  });
  root.own.calls = 0;
  // Include grandchild directly as well to verify deduplication
  root.children = [child1, grandchild];

  // Observation 1: root with own.calls === 0 delegating to children
  // Pre-calibration: status is calibrating, but model is discovered and visible
  const res1 = estimator.observe({
    quota: makeQuota({ gemini5h: 80, geminiWeekly: 90 }),
    nodes: [root],
    nowMs: 1_000_000,
  });

  const flash1 = res1.find((e) => e.modelLabel === 'Gemini 3.8 Flash');
  assert.ok(flash1, 'Gemini 3.8 Flash should be discovered from recursive child nodes');
  assert.equal(flash1.fiveHour?.status, 'calibrating');
  assert.equal(flash1.fiveHour?.estimatedTotalTokens, null);

  // Observation 2: Child consumes +100k total (+20k billed), quota drops by 5% (80% -> 75%)
  const child1Updated = makeSession({
    id: 'child-1',
    model: 'Gemini 3.8 Flash',
    fresh: 25_000,
    cacheRead: 120_000,
    output: 7_000,
  });
  child1Updated.children = [grandchild];

  const rootUpdated = makeSession({
    id: 'root-coord',
    model: 'Gemini 3.8 Flash',
    fresh: 0,
    cacheRead: 0,
    output: 0,
  });
  rootUpdated.own.calls = 0;
  rootUpdated.children = [child1Updated, grandchild];

  const res2 = estimator.observe({
    quota: makeQuota({ gemini5h: 75, geminiWeekly: 89 }),
    nodes: [rootUpdated],
    nowMs: 1_060_000,
  });

  const flash2 = res2.find((e) => e.modelLabel === 'Gemini 3.8 Flash');
  assert.ok(flash2);
  assert.equal(flash2.fiveHour?.status, 'calibrated');
  assert.equal(flash2.fiveHour?.estimatedTotalTokens, 1_500_000);
  assert.equal(flash2.fiveHour?.estimatedBilledTokens, 300_000);
});

