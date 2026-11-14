import type { CallUsagePoint } from '../types.ts';

/**
 * Annotates CallUsagePoints with exact compaction markers and counts total compactions.
 *
 * Rules:
 * 1. Primary signal: when `startStepIndex` transitions (`prev !== curr` and `curr !== null && curr > 0`),
 *    mark that call `{ isCompacted: true, compactedFromStep: curr }` and increment `compactionCount`.
 * 2. Fallback heuristic (only when `startStepIndex` is `null` throughout): detect genuine drop in
 *    `effectiveContext` (`prev.effectiveContext >= 40_000` and `curr.effectiveContext < prev.effectiveContext * 0.65`
 *    and drop `>= 25_000`), EXCEPT suppress transient V-dips that recover to `>= 0.85 * prev.effectiveContext`
 *    within the next 1–2 calls.
 *
 * Side-effect free: returns newly allocated objects without mutating input calls.
 */
export function annotateCompactions(calls: CallUsagePoint[]): {
  calls: CallUsagePoint[];
  compactionCount: number;
} {
  if (calls.length === 0) {
    return { calls: [], compactionCount: 0 };
  }

  const hasPrimarySignal = calls.some((c) => c.startStepIndex !== null);

  let compactionCount = 0;
  const annotatedCalls: CallUsagePoint[] = [];

  if (hasPrimarySignal) {
    let prevStartStep: number | null = null;

    for (const call of calls) {
      const curr = call.startStepIndex;
      let isCompacted = false;
      let compactedFromStep: number | null = null;

      if (curr !== null && curr > 0 && curr !== prevStartStep) {
        isCompacted = true;
        compactedFromStep = curr;
        compactionCount++;
      }

      prevStartStep = curr;

      annotatedCalls.push({
        ...call,
        isCompacted,
        compactedFromStep,
      });
    }

    return { calls: annotatedCalls, compactionCount };
  }

  // Fallback heuristic: only when startStepIndex is null throughout
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    let isCompacted = false;
    let compactedFromStep: number | null = null;

    if (i > 0) {
      const prev = calls[i - 1];
      const prevCtx = prev.effectiveContext;
      const currCtx = call.effectiveContext;
      const drop = prevCtx - currCtx;

      if (prevCtx >= 40_000 && currCtx < prevCtx * 0.65 && drop >= 25_000) {
        const next1 = i + 1 < calls.length ? calls[i + 1].effectiveContext : null;
        const next2 = i + 2 < calls.length ? calls[i + 2].effectiveContext : null;
        const recoveryThreshold = prevCtx * 0.85;

        const recovers =
          (next1 !== null && next1 >= recoveryThreshold) ||
          (next2 !== null && next2 >= recoveryThreshold);

        if (!recovers) {
          isCompacted = true;
          compactedFromStep = null;
          compactionCount++;
        }
      }
    }

    annotatedCalls.push({
      ...call,
      isCompacted,
      compactedFromStep,
    });
  }

  return { calls: annotatedCalls, compactionCount };
}
