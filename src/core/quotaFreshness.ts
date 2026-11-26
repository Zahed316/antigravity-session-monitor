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
 * Latest resetTime across every non-null window: a hub whose window resets later is
 * serving a newer window than one whose window already reset.
 */
export function snapshotFreshnessMs(snapshot: QuotaSnapshot): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const pool of Object.values(snapshot.pools)) {
    for (const window of [pool.fiveHour, pool.weekly]) {
      if (!window?.resetTime) {
        continue;
      }
      const ms = Date.parse(window.resetTime);
      if (!Number.isNaN(ms)) {
        latest = Math.max(latest, ms);
      }
    }
  }
  return latest;
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