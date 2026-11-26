import type { PoolKey, QuotaPool, QuotaSnapshot } from '../types.ts';

function emptyPool(key: PoolKey, displayName: string): QuotaPool {
  return { key, displayName, fiveHour: null, weekly: null };
}

function offlineSnapshot(fetchedAt: number): QuotaSnapshot {
  return {
    status: 'offline',
    source: 'none',
    pools: { gemini: emptyPool('gemini', 'Gemini Models'), nonGoogle: emptyPool('nonGoogle', 'Claude & GPT') },
    fetchedAt,
  };
}

/**
 * Earliest resetTime across every non-null window: the bucket that rolled most
 * recently is the earliest to reset next. Ranking by the latest instead would let a
 * shared long window (weekly, identical on every hub) mask a lagging 5h bucket.
 */
export function snapshotFreshnessMs(snapshot: QuotaSnapshot): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const pool of Object.values(snapshot.pools)) {
    for (const window of [pool.fiveHour, pool.weekly]) {
      if (!window?.resetTime) {
        continue;
      }
      const ms = Date.parse(window.resetTime);
      if (!Number.isNaN(ms)) {
        earliest = Math.min(earliest, ms);
      }
    }
  }
  return earliest === Number.POSITIVE_INFINITY ? Number.NEGATIVE_INFINITY : earliest;
}

export function selectFreshQuota(snapshots: QuotaSnapshot[]): QuotaSnapshot {
  if (snapshots.length === 0) {
    return offlineSnapshot(0);
  }
  // Iteration order (= endpoint order) breaks remaining ties, so a stable answer.
  let best = snapshots[0];
  for (const candidate of snapshots) {
    if (candidate.status !== 'online') {
      continue;
    }
    if (best.status !== 'online') {
      best = candidate;
      continue;
    }
    const candidateMs = snapshotFreshnessMs(candidate);
    const bestMs = snapshotFreshnessMs(best);
    if (candidateMs > bestMs || (candidateMs === bestMs && candidate.fetchedAt > best.fetchedAt)) {
      best = candidate;
    }
  }
  return best;
}