import type { ManagedAccount, PoolKey, QuotaPool, QuotaSnapshot } from '../types.ts';

export interface QuotaAlertConfig {
  enableLowQuotaAlerts: boolean;
  lowQuotaThresholdPct: number;
  notifyQuotaReset: boolean;
}

export interface QuotaAlertPoolEntry {
  poolKey: PoolKey;
  window: '5h' | 'weekly';
  remainingPct: number;
  resetTime: string | null;
}

export interface QuotaAlertEvent {
  kind: 'low' | 'exhausted' | 'reset';
  email: string;
  pools: QuotaAlertPoolEntry[];
  bestAlternative?: { email: string; label?: string; minRemainingPct: number } | null;
}

export interface QuotaAlertEvaluateParams {
  email: string;
  snapshot: QuotaSnapshot;
  alternatives: Array<{ account: ManagedAccount; snapshot: QuotaSnapshot | null }>;
  config: QuotaAlertConfig;
  /** Accepted for signature symmetry; the service is pure and instantaneous, no timers. */
  nowMs?: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Highest min remainingPct across non-stale alternatives with > 0% quota, else null. */
function pickBestAlternative(
  alternatives: QuotaAlertEvaluateParams['alternatives'],
): QuotaAlertEvent['bestAlternative'] {
  let best: QuotaAlertEvent['bestAlternative'] = null;
  for (const { account, snapshot } of alternatives) {
    if (!snapshot || snapshot.isStale) {
      continue;
    }
    const pcts: number[] = [];
    for (const pool of Object.values(snapshot.pools)) {
      for (const window of [pool?.fiveHour, pool?.weekly]) {
        if (window) {
          pcts.push(window.remainingPct);
        }
      }
    }
    if (pcts.length === 0) {
      continue;
    }
    const minRemainingPct = Math.min(...pcts);
    if (minRemainingPct <= 0) {
      continue;
    }
    if (!best || minRemainingPct > best.minRemainingPct) {
      best = {
        email: account.email,
        ...(account.label !== undefined ? { label: account.label } : {}),
        minRemainingPct,
      };
    }
  }
  return best;
}

export class QuotaAlertService {
  /** Alert keys `${email}:${poolKey}:${window}:${resetTime}:${kind}` that already fired this session. */
  private readonly alerted = new Set<string>();
  /** Tuples `${email}:${poolKey}:${window}` that hit low/exhausted, mapped to the resetTime seen then. */
  private readonly flagged = new Map<string, string | null>();

  evaluate(params: QuotaAlertEvaluateParams): QuotaAlertEvent[] {
    const { snapshot, config } = params;
    const email = normalizeEmail(params.email);
    const lows: QuotaAlertPoolEntry[] = [];
    const exhaustions: QuotaAlertPoolEntry[] = [];
    const resets: QuotaAlertPoolEntry[] = [];

    // Offline/error/stale snapshots carry no trustworthy per-window numbers: no-data, never 0%.
    if (snapshot.status === 'online' && !snapshot.isStale) {
      for (const [poolKey, pool] of Object.entries(snapshot.pools) as [PoolKey, QuotaPool | undefined][]) {
        for (const window of [pool?.fiveHour, pool?.weekly]) {
          if (!window) {
            continue;
          }
          this.evaluateWindow(email, params, poolKey, window, lows, exhaustions, resets);
        }
      }
    }

    const events: QuotaAlertEvent[] = [];
    if (config.enableLowQuotaAlerts) {
      if (lows.length > 0) {
        events.push({ kind: 'low', email, pools: lows });
      }
      if (exhaustions.length > 0) {
        events.push({
          kind: 'exhausted',
          email,
          pools: exhaustions,
          bestAlternative: pickBestAlternative(params.alternatives),
        });
      }
    }
    if (config.notifyQuotaReset && resets.length > 0) {
      events.push({ kind: 'reset', email, pools: resets });
    }
    return events;
  }

  private evaluateWindow(
    email: string,
    params: QuotaAlertEvaluateParams,
    poolKey: PoolKey,
    window: { window: '5h' | 'weekly'; remainingPct: number; resetTime: string | null },
    lows: QuotaAlertPoolEntry[],
    exhaustions: QuotaAlertPoolEntry[],
    resets: QuotaAlertPoolEntry[],
  ): void {
    const { config } = params;
    // Reset detection compares against the resetTime seen when the tuple dropped below
    // threshold, so the flag key deliberately excludes resetTime and kind.
    const flagKey = `${email}:${poolKey}:${window.window}`;
    const alertedKey = (resetTime: string | null, kind: 'low' | 'exhausted') => `${flagKey}:${resetTime}:${kind}`;
    const clearAlerted = (resetTime: string | null) => {
      this.alerted.delete(alertedKey(resetTime, 'low'));
      this.alerted.delete(alertedKey(resetTime, 'exhausted'));
    };
    const entry = { poolKey, window: window.window, remainingPct: window.remainingPct, resetTime: window.resetTime };
    const flaggedResetTime = this.flagged.get(flagKey);
    if (flaggedResetTime !== undefined) {
      if (window.remainingPct > config.lowQuotaThresholdPct) {
        resets.push(entry);
        this.flagged.delete(flagKey);
        // Clearing the alert keys lets a re-drop within the same window alert again.
        clearAlerted(flaggedResetTime);
        return;
      }
      if (window.resetTime !== flaggedResetTime) {
        if (window.remainingPct <= 0) {
          // Rolled forward while still exhausted: no reset event; re-arm under the new
          // resetTime so the next poll can emit a fresh exhausted alert.
          this.flagged.set(flagKey, window.resetTime);
        } else {
          resets.push(entry);
          this.flagged.delete(flagKey);
        }
        clearAlerted(flaggedResetTime);
        return;
      }
      // Same window period, still below threshold: escalate low -> exhausted exactly once.
      if (window.remainingPct <= 0 && !this.alerted.has(alertedKey(flaggedResetTime, 'exhausted'))) {
        this.alerted.add(alertedKey(flaggedResetTime, 'exhausted'));
        exhaustions.push(entry);
      }
      return;
    }
    if (window.remainingPct > config.lowQuotaThresholdPct) {
      return;
    }
    // Flag even when low alerts are off so reset detection works with only notifyQuotaReset.
    this.flagged.set(flagKey, window.resetTime);
    const kind = window.remainingPct <= 0 ? 'exhausted' : 'low';
    if (!config.enableLowQuotaAlerts || this.alerted.has(alertedKey(window.resetTime, kind))) {
      return;
    }
    this.alerted.add(alertedKey(window.resetTime, kind));
    if (kind === 'exhausted') {
      exhaustions.push(entry);
    } else {
      lows.push(entry);
    }
  }
}
