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

const CALIBRATION_VERSION = 2;
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

interface SessionNodeTokens {
  modelLabel: string;
  fresh: number;
  cacheRead: number;
  output: number;
}

function collectSessionNodes(nodes: SessionNode[]): Map<string, SessionNodeTokens> {
  const result = new Map<string, SessionNodeTokens>();
  const visited = new Set<string>();

  function visit(node: SessionNode): void {
    if (!node) {
      return;
    }
    const id = node.id ? String(node.id) : '';
    if (id) {
      if (visited.has(id)) {
        return;
      }
      visited.add(id);
    }

    const modelLabel = (node.model ?? '').trim();
    const fresh = Math.max(0, node.own?.fresh ?? 0);
    const cacheRead = Math.max(0, node.own?.cacheRead ?? 0);
    const output = Math.max(0, node.own?.output ?? 0);

    if (id) {
      result.set(id, { modelLabel, fresh, cacheRead, output });
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

  return result;
}

function aggregateTokensByModel(sessions: Map<string, SessionNodeTokens>): Map<string, ModelTokenTotals> {
  const byModel = new Map<string, ModelTokenTotals>();

  for (const session of sessions.values()) {
    const modelLabel = session.modelLabel;
    const isKnown = modelLabel.length > 0 && modelLabel.toLowerCase() !== 'unknown';
    if (!isKnown) {
      continue;
    }

    const existing = byModel.get(modelLabel) ?? { fresh: 0, cacheRead: 0, output: 0 };
    existing.fresh += session.fresh;
    existing.cacheRead += session.cacheRead;
    existing.output += session.output;
    byModel.set(modelLabel, existing);
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
  private readonly pendingSinceDrop = new Map<string, { total: number; billed: number }>();
  private prevSessionTokens = new Map<string, { fresh: number; cacheRead: number; output: number }>();
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
    const currentSessions = collectSessionNodes(nodes);
    const currTokensByModel = aggregateTokensByModel(currentSessions);

    if (!this.hasBaseline) {
      for (const [id, session] of currentSessions) {
        this.prevSessionTokens.set(id, {
          fresh: session.fresh,
          cacheRead: session.cacheRead,
          output: session.output,
        });
      }
      if (quota.status === 'online') {
        this.captureWindowSnapshots(quota);
        this.hasBaseline = true;
      }
      return this.buildEstimates(quota, currTokensByModel);
    }

    if (quota.status !== 'online') {
      for (const [id, session] of currentSessions) {
        this.prevSessionTokens.set(id, {
          fresh: session.fresh,
          cacheRead: session.cacheRead,
          output: session.output,
        });
      }
      return this.buildEstimates(quota, currTokensByModel);
    }

    // Compute per-model positive deltas by iterating over current sessions
    const deltasByModel = new Map<string, { deltaTotal: number; deltaBilled: number; poolKey: PoolKey }>();
    for (const [id, session] of currentSessions) {
      const prev = this.prevSessionTokens.get(id) ?? { fresh: 0, cacheRead: 0, output: 0 };
      const dFresh = Math.max(0, session.fresh - prev.fresh);
      const dCache = Math.max(0, session.cacheRead - prev.cacheRead);
      const dOutput = Math.max(0, session.output - prev.output);
      const deltaTotal = dFresh + dCache + dOutput;
      const deltaBilled = dFresh + dOutput;

      const isKnown = session.modelLabel.length > 0 && session.modelLabel.toLowerCase() !== 'unknown';
      if (isKnown && deltaTotal > 0) {
        const existing = deltasByModel.get(session.modelLabel) ?? {
          deltaTotal: 0,
          deltaBilled: 0,
          poolKey: this.poolResolver(session.modelLabel),
        };
        existing.deltaTotal += deltaTotal;
        existing.deltaBilled += deltaBilled;
        deltasByModel.set(session.modelLabel, existing);
      }

      this.prevSessionTokens.set(id, {
        fresh: session.fresh,
        cacheRead: session.cacheRead,
        output: session.output,
      });
    }

    const poolKeys: PoolKey[] = ['gemini', 'nonGoogle'];
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

        if (!prevWin) {
          if (!this.prevWindows[poolKey]) {
            this.prevWindows[poolKey] = {};
          }
          this.prevWindows[poolKey]![w.prop] = {
            remainingFraction: currWin.remainingFraction,
            resetTime: currWin.resetTime,
          };
          continue;
        }

        const prevResetMs = prevWin.resetTime ? Date.parse(prevWin.resetTime) : Number.NaN;
        const currResetMs = currWin.resetTime ? Date.parse(currWin.resetTime) : Number.NaN;
        const resetTimeAdvanced =
          Number.isFinite(prevResetMs) &&
          Number.isFinite(currResetMs) &&
          currResetMs - prevResetMs > 60_000;
        const resetOccurred =
          currWin.remainingFraction > prevWin.remainingFraction + RESET_FRACTION_JUMP ||
          resetTimeAdvanced;

        if (resetOccurred) {
          const suffix = `::${w.key}`;
          for (const key of Array.from(this.windowUsed.keys())) {
            if (key.endsWith(suffix)) {
              const modelName = key.slice(0, -suffix.length);
              if (this.poolResolver(modelName) === poolKey) {
                this.windowUsed.delete(key);
              }
            }
          }
          for (const key of Array.from(this.pendingSinceDrop.keys())) {
            if (key.endsWith(suffix)) {
              const modelName = key.slice(0, -suffix.length);
              if (this.poolResolver(modelName) === poolKey) {
                this.pendingSinceDrop.delete(key);
              }
            }
          }
          if (!this.prevWindows[poolKey]) {
            this.prevWindows[poolKey] = {};
          }
          this.prevWindows[poolKey]![w.prop] = {
            remainingFraction: currWin.remainingFraction,
            resetTime: currWin.resetTime,
          };
          continue;
        }

        // Accumulate window tokens & pending tokens for each model in poolKey
        for (const [modelLabel, delta] of deltasByModel.entries()) {
          if (delta.poolKey !== poolKey) continue;
          const cKey = calibrationKey(modelLabel, w.key);

          const u = this.windowUsed.get(cKey) ?? { total: 0, billed: 0 };
          u.total += delta.deltaTotal;
          u.billed += delta.deltaBilled;
          this.windowUsed.set(cKey, u);

          const p = this.pendingSinceDrop.get(cKey) ?? { total: 0, billed: 0 };
          p.total += delta.deltaTotal;
          p.billed += delta.deltaBilled;
          this.pendingSinceDrop.set(cKey, p);
        }

        const drop = prevWin.remainingFraction - currWin.remainingFraction;
        if (drop > MIN_FRACTION_DROP) {
          const suffix = `::${w.key}`;
          const pendingInPool: Array<{ modelLabel: string; pending: { total: number; billed: number } }> = [];
          for (const [key, pending] of this.pendingSinceDrop.entries()) {
            if (key.endsWith(suffix)) {
              const modelName = key.slice(0, -suffix.length);
              if (this.poolResolver(modelName) === poolKey && pending.total > 0) {
                pendingInPool.push({ modelLabel: modelName, pending });
              }
            }
          }

          if (pendingInPool.length === 1 && pendingInPool[0].pending.total > 0) {
            const target = pendingInPool[0];
            const cKey = calibrationKey(target.modelLabel, w.key);
            const existing = this.calibration.get(cKey) ?? {
              sumDeltaPct: 0,
              sumDeltaTotal: 0,
              sumDeltaBilled: 0,
              sampleCount: 0,
              updatedAt: nowMs,
            };
            existing.sumDeltaPct += drop * 100;
            existing.sumDeltaTotal += target.pending.total;
            existing.sumDeltaBilled += target.pending.billed;
            existing.sampleCount += 1;
            existing.updatedAt = nowMs;
            this.calibration.set(cKey, existing);
            this.dirty = true;
          }

          // Whether pendingInPool.length === 1 or > 1, clear this.pendingSinceDrop for all models in that poolKey and w.key
          for (const key of Array.from(this.pendingSinceDrop.keys())) {
            if (key.endsWith(suffix)) {
              const modelName = key.slice(0, -suffix.length);
              if (this.poolResolver(modelName) === poolKey) {
                this.pendingSinceDrop.delete(key);
              }
            }
          }

          // Update prevWindows after processing the drop
          if (!this.prevWindows[poolKey]) {
            this.prevWindows[poolKey] = {};
          }
          this.prevWindows[poolKey]![w.prop] = {
            remainingFraction: currWin.remainingFraction,
            resetTime: currWin.resetTime,
          };
        }
      }
    }

    if (this.dirty) {
      void this.flush();
    }

    return this.buildEstimates(quota, currTokensByModel);
  }

  private captureWindowSnapshots(quota: QuotaSnapshot): void {
    const next: Partial<Record<PoolKey, { fiveHour?: WindowSnapshot; weekly?: WindowSnapshot }>> = {};
    for (const poolKey of ['gemini', 'nonGoogle'] as PoolKey[]) {
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
