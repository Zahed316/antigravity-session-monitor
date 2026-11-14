import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateCompactions } from '../src/core/compaction.ts';
import { DEFAULT_CONTEXT_LIMIT, type CallUsagePoint } from '../src/types.ts';

function createCall(partial: Partial<CallUsagePoint> = {}): CallUsagePoint {
  return {
    idx: partial.idx ?? 0,
    stepIndices: partial.stepIndices ?? [1],
    model: partial.model ?? 'gemini-2.5-pro',
    fresh: partial.fresh ?? 10_000,
    cacheRead: partial.cacheRead ?? 20_000,
    output: partial.output ?? 500,
    thinking: partial.thinking ?? 300,
    response: partial.response ?? 200,
    effectiveContext: partial.effectiveContext ?? 30_000,
    contextLimit: partial.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
    startStepIndex: partial.startStepIndex ?? null,
    isCompacted: partial.isCompacted ?? false,
    compactedFromStep: partial.compactedFromStep ?? null,
    tokenBreakdownGroups: partial.tokenBreakdownGroups,
    apiProvider: partial.apiProvider,
    source: partial.source ?? 'sqlite',
  };
}

test('primary signal: startStepIndex transitions [null, null, 76, 76, 120] marks index 2 and index 4', () => {
  const steps = [null, null, 76, 76, 120];
  const inputCalls = steps.map((s, idx) =>
    createCall({
      idx,
      startStepIndex: s,
      effectiveContext: 50_000 + idx * 10_000,
    }),
  );

  const inputSnapshot = JSON.stringify(inputCalls);
  const result = annotateCompactions(inputCalls);

  assert.equal(result.compactionCount, 2);
  assert.equal(result.calls.length, 5);

  assert.equal(result.calls[0].isCompacted, false);
  assert.equal(result.calls[0].compactedFromStep, null);

  assert.equal(result.calls[1].isCompacted, false);
  assert.equal(result.calls[1].compactedFromStep, null);

  assert.equal(result.calls[2].isCompacted, true);
  assert.equal(result.calls[2].compactedFromStep, 76);

  assert.equal(result.calls[3].isCompacted, false);
  assert.equal(result.calls[3].compactedFromStep, null);

  assert.equal(result.calls[4].isCompacted, true);
  assert.equal(result.calls[4].compactedFromStep, 120);

  // Pure function verification: input array/objects must not be mutated
  assert.equal(JSON.stringify(inputCalls), inputSnapshot);
});

test('primary signal: startStepIndex = 0 does not trigger compaction and primary suppresses fallback heuristics', () => {
  const inputCalls = [
    createCall({ idx: 0, startStepIndex: null, effectiveContext: 150_000 }),
    createCall({ idx: 1, startStepIndex: 0, effectiveContext: 30_000 }), // startStepIndex 0 is not > 0
    createCall({ idx: 2, startStepIndex: 0, effectiveContext: 35_000 }),
    createCall({ idx: 3, startStepIndex: 50, effectiveContext: 20_000 }), // genuine primary transition
  ];

  const result = annotateCompactions(inputCalls);
  assert.equal(result.compactionCount, 1);
  assert.equal(result.calls[1].isCompacted, false);
  assert.equal(result.calls[3].isCompacted, true);
  assert.equal(result.calls[3].compactedFromStep, 50);
});

test('fallback heuristic: genuine context drop 150k -> 60k is detected when startStepIndex is null throughout', () => {
  const inputCalls = [
    createCall({ idx: 0, startStepIndex: null, effectiveContext: 150_000 }),
    createCall({ idx: 1, startStepIndex: null, effectiveContext: 60_000 }), // drop 90k >= 25k, 60k < 150k * 0.65 (97.5k)
    createCall({ idx: 2, startStepIndex: null, effectiveContext: 65_000 }),
  ];

  const result = annotateCompactions(inputCalls);
  assert.equal(result.compactionCount, 1);
  assert.equal(result.calls[0].isCompacted, false);
  assert.equal(result.calls[1].isCompacted, true);
  assert.equal(result.calls[1].compactedFromStep, null);
  assert.equal(result.calls[2].isCompacted, false);
});

test('fallback heuristic: transient V-dip 150k -> 20k -> 140k recovering within 2 calls is suppressed', () => {
  // Recovers on next call (140k >= 0.85 * 150k = 127.5k)
  const inputCalls1 = [
    createCall({ idx: 0, startStepIndex: null, effectiveContext: 150_000 }),
    createCall({ idx: 1, startStepIndex: null, effectiveContext: 20_000 }),
    createCall({ idx: 2, startStepIndex: null, effectiveContext: 140_000 }),
  ];

  const result1 = annotateCompactions(inputCalls1);
  assert.equal(result1.compactionCount, 0);
  assert.equal(result1.calls[1].isCompacted, false);

  // Recovers on 2nd call (20k -> 30k -> 135k >= 127.5k)
  const inputCalls2 = [
    createCall({ idx: 0, startStepIndex: null, effectiveContext: 150_000 }),
    createCall({ idx: 1, startStepIndex: null, effectiveContext: 20_000 }),
    createCall({ idx: 2, startStepIndex: null, effectiveContext: 30_000 }),
    createCall({ idx: 3, startStepIndex: null, effectiveContext: 135_000 }),
  ];

  const result2 = annotateCompactions(inputCalls2);
  assert.equal(result2.compactionCount, 0);
  assert.equal(result2.calls[1].isCompacted, false);
});

test('fallback heuristic: fluctuations in fresh tokens alone never trigger false compaction when effectiveContext is monotonic', () => {
  const inputCalls = [
    createCall({ idx: 0, startStepIndex: null, fresh: 50_000, cacheRead: 0, effectiveContext: 50_000 }),
    createCall({ idx: 1, startStepIndex: null, fresh: 5_000, cacheRead: 55_000, effectiveContext: 60_000 }),
    createCall({ idx: 2, startStepIndex: null, fresh: 2_000, cacheRead: 68_000, effectiveContext: 70_000 }),
  ];

  const result = annotateCompactions(inputCalls);
  assert.equal(result.compactionCount, 0);
  assert.ok(result.calls.every((c) => !c.isCompacted));
});

test('fallback heuristic: small drops (< 25k or >= 0.65*prev or prev < 40k) do not trigger compaction', () => {
  const inputCalls = [
    createCall({ idx: 0, startStepIndex: null, effectiveContext: 150_000 }),
    createCall({ idx: 1, startStepIndex: null, effectiveContext: 130_000 }), // drop 20k < 25k
    createCall({ idx: 2, startStepIndex: null, effectiveContext: 35_000 }), // prev was 130k, drop 95k -> compaction!
    createCall({ idx: 3, startStepIndex: null, effectiveContext: 25_000 }), // prev 35k < 40k, no compaction
  ];

  const result = annotateCompactions(inputCalls);
  assert.equal(result.compactionCount, 1);
  assert.equal(result.calls[1].isCompacted, false);
  assert.equal(result.calls[2].isCompacted, true);
  assert.equal(result.calls[3].isCompacted, false);
});

test('annotateCompactions handles empty and single-call inputs gracefully', () => {
  assert.deepEqual(annotateCompactions([]), { calls: [], compactionCount: 0 });
  const single = [createCall({ idx: 0, startStepIndex: null, effectiveContext: 100_000 })];
  const res = annotateCompactions(single);
  assert.equal(res.compactionCount, 0);
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0].isCompacted, false);
});
