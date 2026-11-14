import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ModelTokenEstimate,
  PoolKey,
  QuotaSnapshot,
  QuotaWindow,
  SessionNode,
  WindowTokenEstimate,
} from '../types.ts';
import { inferModelPool } from './modelResolver.ts';

const CALIBRATION_VERSION = 1;
const MIN_FRACTION_DROP = 0.0002;
const RESET_FRACTION_JUMP = 0.005;

interface ModelTokenTotals {
  fresh: number;
  cacheRead: number;
  output: number;
}

interface CalibrationEntry {
  sumDeltaPct: number;
  sumDeltaTotal: number;
  sumDeltaBilled: number;
  sampleCount: number;
  updatedAt: number;
}

interface WindowUsage {
  total: number;
  billed: number;
}

interface PersistedCalibration {
  version: number;
  entries: Record<string, CalibrationEntry>;
}

interface WindowSnapshot {
  remainingFraction: number;
  resetTime: string | null;
}

export interface QuotaEstimatorOptions {
  storagePath?: string;
  poolResolver?: (modelLabel: string) => PoolKey;
}

function calibrationKey(modelLabel: string, windowKey: '5h' | 'weekly'): string {
  return `${modelLabel}::${windowKey}`;
}

function aggregateTokensByModel(nodes: SessionNode[]): Map<string, ModelTokenTotals> {
  const byModel = new Map<string, ModelTokenTotals>();
  const visited = new Set<string>();

  function visit(node: SessionNode): void {
    if (!node) {
      return;
    }
    if (node.id) {
      if (visited.has(node.id)) {
        return;
      }
      visited.add(node.id);
    }

    const modelLabel = (node.model ?? '').trim();
    const isKnown = modelLabel.length > 0 && modelLabel.toLowerCase() !== 'unknown';
    const hasOwnTokens =
      node.own &&
      (node.own.calls > 0 ||
        node.own.fresh > 0 ||
        node.own.cacheRead > 0 ||
        node.own.output > 0);

    if (isKnown && hasOwnTokens) {
      const existing = byModel.get(modelLabel) ?? { fresh: 0, cacheRead: 0, output: 0 };
      existing.fresh += Math.max(0, node.own.fresh);
      existing.cacheRead += Math.max(0, node.own.cacheRead);
      existing.output += Math.max(0, node.own.output);
      byModel.set(modelLabel, existing);
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  }

  for (const node of nodes) {
    visit(node);
  }

  return byModel;
}

function buildWindowEstimate(
  win: QuotaWindow | null,
  cal: CalibrationEntry | undefined,
  used: WindowUsage | undefined,
): WindowTokenEstimate | null {
  if (!win && !cal) {
    return null;
  }

  const windowUsedTotal = used?.total ?? 0;
  const windowUsedBilled = used?.billed ?? 0;

  if (cal && cal.sumDeltaPct > 0 && cal.sampleCount > 0) {
    const tokensPerPctTotal = cal.sumDeltaTotal / cal.sumDeltaPct;
    const tokensPerPctBilled = cal.sumDeltaBilled / cal.sumDeltaPct;
    return {
      status: 'calibrated',
      estimatedTotalTokens: win ? Math.round(win.remainingPct * tokensPerPctTotal) : null,
      estimatedBilledTokens: win ? Math.round(win.remainingPct * tokensPerPctBilled) : null,
      tokensPerPctTotal,
      tokensPerPctBilled,
      windowUsedTotal,
      windowUsedBilled,
      sampleCount: cal.sampleCount,
    };
  }

  return {
    status: 'calibrating',
    estimatedTotalTokens: null,
    estimatedBilledTokens: null,
    tokensPerPctTotal: null,
    tokensPerPctBilled: null,
    windowUsedTotal,
    windowUsedBilled,
    sampleCount: 0,
  };
}

/**
 * Empirically calibrates tokens-per-1%-quota for each model across 5h and weekly windows
 * by observing quota remainingFraction drops alongside per-model token deltas.
 */
export class QuotaEstimator {
  private readonly storagePath?: string;
  private readonly poolResolver: (modelLabel: string) => PoolKey;

  private readonly calibration = new Map<string, CalibrationEntry>();
  private readonly windowUsed = new Map<string, WindowUsage>();
  private prevTokensByModel = new Map<string, ModelTokenTotals>();
  private prevWindows: Partial<Record<PoolKey, { fiveHour?: WindowSnapshot; weekly?: WindowSnapshot }>> = {};
  private hasBaseline = false;
  private dirty = false;
  private writeInFlight: Promise<void> | null = null;

  constructor(options: QuotaEstimatorOptions = {}) {
    this.storagePath = options.storagePath ? path.resolve(options.storagePath) : undefined;
    this.poolResolver = options.poolResolver ?? ((label) => inferModelPool(label));
  }

  async load(): Promise<void> {
    if (!this.storagePath) {
      return;
    }
    try {
      const raw = await fs.readFile(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedCalibration;
      if (!parsed || parsed.version !== CALIBRATION_VERSION || typeof parsed.entries !== 'object') {
        return;
      }
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (
          entry &&
          typeof entry.sumDeltaPct === 'number' &&
          Number.isFinite(entry.sumDeltaPct) &&
          entry.sumDeltaPct > 0 &&
          typeof entry.sumDeltaTotal === 'number' &&
          typeof entry.sumDeltaBilled === 'number' &&
          typeof entry.sampleCount === 'number' &&
          entry.sampleCount > 0
        ) {
          this.calibration.set(key, {
            sumDeltaPct: entry.sumDeltaPct,
            sumDeltaTotal: Math.max(0, entry.sumDeltaTotal),
            sumDeltaBilled: Math.max(0, entry.sumDeltaBilled),
            sampleCount: entry.sampleCount,
            updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
          });
        }
      }
    } catch {
      // Ignore missing or corrupt calibration file
    }
  }

  async flush(): Promise<void> {
    if (!this.storagePath || !this.dirty) {
      return;
    }
    if (this.writeInFlight) {
      await this.writeInFlight;
    }
    if (!this.dirty) {
      return;
    }

    const payload: PersistedCalibration = {
      version: CALIBRATION_VERSION,
      entries: Object.fromEntries(this.calibration.entries()),
    };

    const run = (async () => {
      const dir = path.dirname(this.storagePath!);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${this.storagePath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, this.storagePath!);
      this.dirty = false;
    })();

    this.writeInFlight = run;
    try {
      await run;
    } catch {
      // Non-fatal persistence failure
    } finally {
      if (this.writeInFlight === run) {
        this.writeInFlight = null;
      }
    }
  }

  observe(params: {
    quota: QuotaSnapshot;
    nodes: SessionNode[];
    nowMs?: number;
  }): ModelTokenEstimate[] {
    const { quota, nodes, nowMs = Date.now() } = params;
    const currTokensByModel = aggregateTokensByModel(nodes);

    if (!this.hasBaseline) {
      this.prevTokensByModel = currTokensByModel;
      if (quota.status === 'online') {
        this.captureWindowSnapshots(quota);
        this.hasBaseline = true;
      }
      return this.buildEstimates(quota, currTokensByModel);
    }

    if (quota.status !== 'online') {
      this.prevTokensByModel = currTokensByModel;
      return this.buildEstimates(quota, currTokensByModel);
    }

    // Compute per-model positive deltas since last observation
    const deltasByModel = new Map<string, { deltaTotal: number; deltaBilled: number; poolKey: PoolKey }>();
    for (const [modelLabel, curr] of currTokensByModel.entries()) {
      const prev = this.prevTokensByModel.get(modelLabel) ?? { fresh: 0, cacheRead: 0, output: 0 };
      const dFresh = Math.max(0, curr.fresh - prev.fresh);
      const dCache = Math.max(0, curr.cacheRead - prev.cacheRead);
      const dOutput = Math.max(0, curr.output - prev.output);
      const deltaTotal = dFresh + dCache + dOutput;
      const deltaBilled = dFresh + dOutput;
      if (deltaTotal > 0) {
        deltasByModel.set(modelLabel, {
          deltaTotal,
          deltaBilled,
          poolKey: this.poolResolver(modelLabel),
        });
      }
    }

    const poolKeys: PoolKey[] = ['gemini', 'argon', 'nonGoogle'];
    const windows: Array<{ prop: 'fiveHour' | 'weekly'; key: '5h' | 'weekly' }> = [
      { prop: 'fiveHour', key: '5h' },
      { prop: 'weekly', key: 'weekly' },
    ];

    for (const poolKey of poolKeys) {
      const pool = quota.pools[poolKey];
      if (!pool) continue;

      for (const w of windows) {
        const currWin = pool[w.prop];
        const prevWin = this.prevWindows[poolKey]?.[w.prop];
        if (!currWin) continue;

        const prevResetMs = prevWin?.resetTime ? Date.parse(prevWin.resetTime) : Number.NaN;
        const currResetMs = currWin.resetTime ? Date.parse(currWin.resetTime) : Number.NaN;
        const resetTimeAdvanced =
          Number.isFinite(prevResetMs) &&
          Number.isFinite(currResetMs) &&
          currResetMs - prevResetMs > 60_000;
        const resetOccurred =
          prevWin !== undefined &&
          (currWin.remainingFraction > prevWin.remainingFraction + RESET_FRACTION_JUMP ||
            resetTimeAdvanced);

        if (resetOccurred) {
          for (const key of Array.from(this.windowUsed.keys())) {
            if (key.endsWith(`::${w.key}`)) {
              const modelName = key.slice(0, -(`::${w.key}`.length));
              if (this.poolResolver(modelName) === poolKey) {
                this.windowUsed.delete(key);
              }
            }
          }
          continue;
        }

        // Accumulate window tokens & attribute drops when unambiguously caused by 1 model in pool
        const activeInPool: Array<{ modelLabel: string; deltaTotal: number; deltaBilled: number }> = [];
        for (const [modelLabel, delta] of deltasByModel.entries()) {
          if (delta.poolKey !== poolKey) continue;
          activeInPool.push({ modelLabel, deltaTotal: delta.deltaTotal, deltaBilled: delta.deltaBilled });
          const uKey = calibrationKey(modelLabel, w.key);
          const u = this.windowUsed.get(uKey) ?? { total: 0, billed: 0 };
          u.total += delta.deltaTotal;
          u.billed += delta.deltaBilled;
          this.windowUsed.set(uKey, u);
        }

        if (prevWin) {
          const drop = prevWin.remainingFraction - currWin.remainingFraction;
          if (drop > MIN_FRACTION_DROP && activeInPool.length === 1) {
            const target = activeInPool[0];
            const cKey = calibrationKey(target.modelLabel, w.key);
            const existing = this.calibration.get(cKey) ?? {
              sumDeltaPct: 0,
              sumDeltaTotal: 0,
              sumDeltaBilled: 0,
              sampleCount: 0,
              updatedAt: nowMs,
            };
            existing.sumDeltaPct += drop * 100;
            existing.sumDeltaTotal += target.deltaTotal;
            existing.sumDeltaBilled += target.deltaBilled;
            existing.sampleCount += 1;
            existing.updatedAt = nowMs;
            this.calibration.set(cKey, existing);
            this.dirty = true;
          }
        }
      }
    }

    this.prevTokensByModel = currTokensByModel;
    this.captureWindowSnapshots(quota);

    if (this.dirty) {
      void this.flush();
    }

    return this.buildEstimates(quota, currTokensByModel);
  }

  private captureWindowSnapshots(quota: QuotaSnapshot): void {
    const next: Partial<Record<PoolKey, { fiveHour?: WindowSnapshot; weekly?: WindowSnapshot }>> = {};
    for (const poolKey of ['gemini', 'argon', 'nonGoogle'] as PoolKey[]) {
      const pool = quota.pools[poolKey];
      if (!pool) continue;
      next[poolKey] = {
        fiveHour: pool.fiveHour
          ? { remainingFraction: pool.fiveHour.remainingFraction, resetTime: pool.fiveHour.resetTime }
          : undefined,
        weekly: pool.weekly
          ? { remainingFraction: pool.weekly.remainingFraction, resetTime: pool.weekly.resetTime }
          : undefined,
      };
    }
    this.prevWindows = next;
  }

  private buildEstimates(
    quota: QuotaSnapshot,
    currTokensByModel: Map<string, ModelTokenTotals>,
  ): ModelTokenEstimate[] {
    const allModels = new Set<string>(currTokensByModel.keys());
    for (const key of this.calibration.keys()) {
      const idx = key.lastIndexOf('::');
      if (idx > 0) {
        allModels.add(key.slice(0, idx));
      }
    }

    const estimates: ModelTokenEstimate[] = [];
    for (const modelLabel of allModels) {
      if (!modelLabel || modelLabel.toLowerCase() === 'unknown') {
        continue;
      }
      const poolKey = this.poolResolver(modelLabel);
      const pool = quota.pools[poolKey];
      const fiveHour = buildWindowEstimate(
        pool?.fiveHour ?? null,
        this.calibration.get(calibrationKey(modelLabel, '5h')),
        this.windowUsed.get(calibrationKey(modelLabel, '5h')),
      );
      const weekly = buildWindowEstimate(
        pool?.weekly ?? null,
        this.calibration.get(calibrationKey(modelLabel, 'weekly')),
        this.windowUsed.get(calibrationKey(modelLabel, 'weekly')),
      );

      if (fiveHour || weekly) {
        estimates.push({ modelLabel, poolKey, fiveHour, weekly });
      }
    }

    estimates.sort((a, b) => {
      const aCal = (a.fiveHour?.sampleCount ?? 0) + (a.weekly?.sampleCount ?? 0);
      const bCal = (b.fiveHour?.sampleCount ?? 0) + (b.weekly?.sampleCount ?? 0);
      if ((aCal > 0) !== (bCal > 0)) return aCal > 0 ? -1 : 1;
      const aTok = currTokensByModel.get(a.modelLabel);
      const bTok = currTokensByModel.get(b.modelLabel);
      const aSum = aTok ? aTok.fresh + aTok.cacheRead + aTok.output : 0;
      const bSum = bTok ? bTok.fresh + bTok.cacheRead + bTok.output : 0;
      return bSum - aSum;
    });

    return estimates;
  }
}
