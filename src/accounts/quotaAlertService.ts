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
  /** Alert keys `${email}:${poolKey}:${window}:${resetTime}` that already fired this session. */
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
        events.push({ kind: 'low', email: params.email, pools: lows });
      }
      if (exhaustions.length > 0) {
        events.push({
          kind: 'exhausted',
          email: params.email,
          pools: exhaustions,
          bestAlternative: pickBestAlternative(params.alternatives),
        });
      }
    }
    if (config.notifyQuotaReset && resets.length > 0) {
      events.push({ kind: 'reset', email: params.email, pools: resets });
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
    // threshold, so the flag key deliberately excludes resetTime.
    const flagKey = `${email}:${poolKey}:${window.window}`;
    const flaggedResetTime = this.flagged.get(flagKey);
    if (flaggedResetTime !== undefined) {
      if (window.resetTime !== flaggedResetTime || window.remainingPct > config.lowQuotaThresholdPct) {
        resets.push({ poolKey, window: window.window, remainingPct: window.remainingPct, resetTime: window.resetTime });
        this.flagged.delete(flagKey);
        // Clearing the alert key lets a re-drop within the same window alert again.
        this.alerted.delete(`${flagKey}:${flaggedResetTime}`);
      }
      return;
    }
    if (!config.enableLowQuotaAlerts || this.alerted.has(`${flagKey}:${window.resetTime}`)) {
      return;
    }
    if (window.remainingPct > 0 && window.remainingPct > config.lowQuotaThresholdPct) {
      return;
    }
    this.alerted.add(`${flagKey}:${window.resetTime}`);
    this.flagged.set(flagKey, window.resetTime);
    const entry = { poolKey, window: window.window, remainingPct: window.remainingPct, resetTime: window.resetTime };
    if (window.remainingPct <= 0) {
      exhaustions.push(entry);
    } else {
      lows.push(entry);
    }
  }
}
