import http from 'node:http';
import https from 'node:https';
import {
  DEFAULT_CONTEXT_LIMIT,
  type CallUsagePoint,
  type ModelCatalogEntry,
  type PoolKey,
  type QuotaPool,
  type QuotaSnapshot,
  type QuotaWindow,
  type RpcGeneratorCall,
  type RpcTrajectorySummary,
  type TokenBreakdownGroup,
} from '../types.ts';
import { inferModelPool } from '../core/modelResolver.ts';
import type { AccountIdentity } from '../types.ts';
import type { HubEndpoint } from './hubDiscovery.ts';

const DEFAULT_TIMEOUT_MS = 4000;

function isLoopbackOrWsl(host: string): boolean {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('172.') ||
    host.startsWith('192.168.') ||
    host.startsWith('10.')
  );
}

function buildEmptyPool(key: PoolKey, displayName: string): QuotaPool {
  return {
    key,
    displayName,
    fiveHour: null,
    weekly: null,
  };
}

function buildOfflineQuota(nowMs: number, error?: string): QuotaSnapshot {
  return {
    status: 'offline',
    source: 'none',
    pools: {
      gemini: buildEmptyPool('gemini', 'Gemini Models'),
      nonGoogle: buildEmptyPool('nonGoogle', 'Claude & GPT'),
    },
    fetchedAt: nowMs,
    error,
  };
}

interface ParsedQuotaItem {
  poolKey: PoolKey;
  windowKey: '5h' | 'weekly';
  bucketId?: string;
  remainingFraction: number;
  remainingPct: number;
  resetTime: string | null;
  isReady: boolean;
  isExhausted: boolean;
}

function evaluateQuotaValues(
  rawFraction: unknown,
  rawResetTime: unknown,
  nowMs: number,
): { fraction: number; remainingPct: number; resetTime: string | null; isReady: boolean; isExhausted: boolean } | null {
  const hasResetTime = typeof rawResetTime === 'string' && rawResetTime.trim() !== '';
  const resetTimeStr = hasResetTime ? (rawResetTime as string).trim() : null;
  const hasRemaining = typeof rawFraction === 'number' && Number.isFinite(rawFraction);

  // Review Focus #4: quotaInfo: {} (no resetTime and no remainingFraction) -> ignore as unlimited!
  if (!hasResetTime && !hasRemaining) {
    return null;
  }

  // Review Focus #4: resetTime present + remainingFraction omitted -> 0% exhausted
  let fraction = hasRemaining ? Number(rawFraction) : 0;
  fraction = Math.max(0, Math.min(1, fraction));

  // Review Focus #4: resetTime passed with no reported fraction -> the window rolled over, treat as full.
  // An explicit remainingFraction (including 0) is authoritative; do not overwrite it.
  if (!hasRemaining && resetTimeStr !== null) {
    const resetMs = Date.parse(resetTimeStr);
    if (!Number.isNaN(resetMs) && resetMs <= nowMs) {
      fraction = 1.0;
    }
  }

  const remainingPct = Math.round(fraction * 100);
  const isReady = fraction > 0;
  const isExhausted = fraction === 0;

  return {
    fraction,
    remainingPct,
    resetTime: resetTimeStr,
    isReady,
    isExhausted,
  };
}

function mergeQuotaItem(pool: QuotaPool, item: ParsedQuotaItem): void {
  const targetProp = item.windowKey === 'weekly' ? 'weekly' : 'fiveHour';
  const existing = pool[targetProp];

  const candidateWindow: QuotaWindow = {
    window: item.windowKey,
    bucketId: item.bucketId,
    remainingPct: item.remainingPct,
    remainingFraction: item.remainingFraction,
    resetTime: item.resetTime,
    isReady: item.isReady,
    isExhausted: item.isExhausted,
  };

  if (!existing) {
    pool[targetProp] = candidateWindow;
    return;
  }

  // Take bottleneck (minimum remaining fraction)
  if (candidateWindow.remainingFraction < existing.remainingFraction) {
    pool[targetProp] = candidateWindow;
  } else if (candidateWindow.remainingFraction === existing.remainingFraction) {
    if (
      candidateWindow.resetTime &&
      (!existing.resetTime || candidateWindow.resetTime > existing.resetTime)
    ) {
      pool[targetProp] = candidateWindow;
    }
  }
}

/**
 * Parses HTTP Retry-After header value into milliseconds.
 * Supports delta-seconds or HTTP-date format.
 */
export function parseRetryAfterMs(headerVal?: string, nowMs = Date.now()): number | undefined {
  if (!headerVal) {
    return undefined;
  }
  const trimmed = headerVal.trim();
  if (!trimmed) {
    return undefined;
  }
  const asSeconds = Number(trimmed);
  if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return undefined;
}

/**
 * Computes full jitter exponential backoff in milliseconds.
 */
export function computeBackoffWithJitterMs(
  attempt: number,
  baseMs = 2000,
  maxMs = 60000,
  randomFn = Math.random,
): number {
  return randomFn() * Math.min(maxMs, baseMs * 2 ** attempt);
}

/**
 * Normalizes Connect-RPC `RetrieveUserQuotaSummary` response into a QuotaSnapshot.
 */
export function normalizeQuotaFromSummary(raw: unknown, nowMs = Date.now()): QuotaSnapshot {
  const pools: Record<PoolKey, QuotaPool> = {
    gemini: buildEmptyPool('gemini', 'Gemini Models'),
    nonGoogle: buildEmptyPool('nonGoogle', 'Claude & GPT'),
  };

  if (!raw || typeof raw !== 'object') {
    return { status: 'online', source: 'summary', pools, fetchedAt: nowMs };
  }

  const root = raw as Record<string, unknown>;
  const resObj = (root.response ?? {}) as Record<string, unknown>;
  const summaryObj = (root.userQuotaSummary ?? resObj.userQuotaSummary ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(root.groups)
    ? root.groups
    : Array.isArray(resObj.groups)
      ? resObj.groups
      : Array.isArray(summaryObj.groups)
        ? summaryObj.groups
        : [];

  for (const grp of groups) {
    if (!grp || typeof grp !== 'object') {
      continue;
    }
    const g = grp as Record<string, unknown>;
    const groupName = String(g.displayName ?? g.name ?? '');

    const buckets = Array.isArray(g.buckets) ? g.buckets : [];
    for (const b of buckets) {
      if (!b || typeof b !== 'object') {
        continue;
      }
      const bucket = b as Record<string, unknown>;
      const bucketId = typeof bucket.bucketId === 'string' ? bucket.bucketId : undefined;
      const windowStr = String(bucket.window ?? '');

      const isWeekly = /week/i.test(windowStr) || /weekly/i.test(bucketId ?? '');
      const windowKey: '5h' | 'weekly' = isWeekly ? 'weekly' : '5h';

      const target = `${groupName} ${bucketId ?? ''}`;
      const poolKey: PoolKey = /gemini|argon/i.test(target) ? 'gemini' : 'nonGoogle';

      const evaluated = evaluateQuotaValues(bucket.remainingFraction, bucket.resetTime, nowMs);
      if (!evaluated) {
        continue; // Unlimited bucket ignored
      }

      mergeQuotaItem(pools[poolKey], {
        poolKey,
        windowKey,
        bucketId,
        remainingFraction: evaluated.fraction,
        remainingPct: evaluated.remainingPct,
        resetTime: evaluated.resetTime,
        isReady: evaluated.isReady,
        isExhausted: evaluated.isExhausted,
      });
    }
  }

  return {
    status: 'online',
    source: 'summary',
    pools,
    fetchedAt: nowMs,
  };
}

/**
 * Normalizes Connect-RPC `GetUserStatus` fallback response into a QuotaSnapshot.
 */
export function normalizeQuotaFromUserStatus(raw: unknown, nowMs = Date.now()): QuotaSnapshot {
  const pools: Record<PoolKey, QuotaPool> = {
    gemini: buildEmptyPool('gemini', 'Gemini Models'),
    nonGoogle: buildEmptyPool('nonGoogle', 'Claude & GPT'),
  };

  if (!raw || typeof raw !== 'object') {
    return { status: 'online', source: 'userStatus', pools, fetchedAt: nowMs };
  }

  const root = raw as Record<string, unknown>;
  const status = (root.userStatus ?? root) as Record<string, unknown>;
  const cascadeData = (status.cascadeModelConfigData ?? status) as Record<string, unknown>;
  const configs = Array.isArray(cascadeData.clientModelConfigs)
    ? cascadeData.clientModelConfigs
    : Array.isArray(root.clientModelConfigs)
      ? root.clientModelConfigs
      : [];

  for (const c of configs) {
    if (!c || typeof c !== 'object') {
      continue;
    }
    const cfg = c as Record<string, unknown>;
    const modelOrAlias = (cfg.modelOrAlias ?? {}) as Record<string, unknown>;
    const name = `${cfg.label ?? ''} ${modelOrAlias.model ?? ''}`.trim();

    const poolKey: PoolKey = /gemini|argon/i.test(name) ? 'gemini' : 'nonGoogle';

    const quotaInfo = (cfg.quotaInfo ?? {}) as Record<string, unknown>;
    const resetTimeStr = typeof quotaInfo.resetTime === 'string' ? quotaInfo.resetTime.trim() : '';
    const resetMs = resetTimeStr ? Date.parse(resetTimeStr) : NaN;
    const isFarFuture = !Number.isNaN(resetMs) && resetMs - nowMs > 6 * 3600_000;
    const isWeekly =
      /week/i.test(String(quotaInfo.window ?? '')) || /weekly/i.test(name) || isFarFuture;
    const windowKey: '5h' | 'weekly' = isWeekly ? 'weekly' : '5h';

    const evaluated = evaluateQuotaValues(quotaInfo.remainingFraction, quotaInfo.resetTime, nowMs);
    if (!evaluated) {
      continue; // Unlimited model (e.g. Gemini 4 Carbon {}) ignored
    }

    mergeQuotaItem(pools[poolKey], {
      poolKey,
      windowKey,
      remainingFraction: evaluated.fraction,
      remainingPct: evaluated.remainingPct,
      resetTime: evaluated.resetTime,
      isReady: evaluated.isReady,
      isExhausted: evaluated.isExhausted,
    });
  }

  return {
    status: 'online',
    source: 'userStatus',
    pools,
    fetchedAt: nowMs,
  };
}

/**
 * Extracts ModelCatalogEntry[] from GetUserStatus response payload.
 */
export function extractModelCatalogFromUserStatus(raw: unknown): ModelCatalogEntry[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }

  const root = raw as Record<string, unknown>;
  const status = (root.userStatus ?? root) as Record<string, unknown>;
  const cascadeData = (status.cascadeModelConfigData ?? status) as Record<string, unknown>;
  const configs = Array.isArray(cascadeData.clientModelConfigs)
    ? cascadeData.clientModelConfigs
    : Array.isArray(root.clientModelConfigs)
      ? root.clientModelConfigs
      : [];

  const catalog: ModelCatalogEntry[] = [];
  for (const c of configs) {
    if (!c || typeof c !== 'object') {
      continue;
    }
    const cfg = c as Record<string, unknown>;
    const modelOrAlias = (cfg.modelOrAlias ?? {}) as Record<string, unknown>;
    const cfgModelIdObj =
      cfg.modelId && typeof cfg.modelId === 'object' ? (cfg.modelId as Record<string, unknown>) : null;
    const slugId =
      typeof cfg.modelId === 'string'
        ? cfg.modelId.trim()
        : typeof cfgModelIdObj?.id === 'string'
          ? cfgModelIdObj.id.trim()
          : '';
    const aliasModel = typeof modelOrAlias.model === 'string' ? modelOrAlias.model.trim() : '';
    const rawId =
      (typeof cfg.rawId === 'string' ? cfg.rawId.trim() : '') ||
      aliasModel ||
      (typeof cfg.model === 'string' ? cfg.model.trim() : '') ||
      slugId;
    const modelId = slugId || aliasModel || rawId;
    const label = String(cfg.label ?? cfg.displayName ?? cfg.name ?? modelId ?? rawId).trim();

    if (!rawId && !modelId && !label) {
      continue;
    }

    const effectiveModelId = modelId || rawId;
    const effectiveRawId = rawId || modelId;
    const effectiveLabel = label || effectiveModelId;

    const poolKey = inferModelPool(`${effectiveLabel} ${effectiveModelId} ${effectiveRawId}`);

    catalog.push({
      rawId: effectiveRawId,
      modelId: effectiveModelId,
      label: effectiveLabel,
      poolKey,
    });
  }

  return catalog;
}

/**
 * Formats a raw tier/plan code (g1Tier, plan) into a display label.
 */
function formatTierLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return undefined;
  }
  const code = raw.trim().toUpperCase();
  if (code === 'ULTRA') return 'Google AI Ultra';
  if (code === 'PRO') return 'Google AI Pro';
  if (code === 'FREE') return 'Google AI Free';
  return raw.trim();
}

/**
 * Extracts AccountIdentity from a GetUserStatus response payload.
 * Returns null when no email is present (unauthenticated or malformed payload).
 */
export function extractUserIdentityFromUserStatus(raw: unknown): AccountIdentity | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const root = raw as Record<string, unknown>;
  const status = (root.userStatus ?? root) as Record<string, unknown>;

  const email = typeof status.email === 'string' ? status.email.trim().toLowerCase() : '';
  if (!email) {
    return null;
  }

  const displayName = typeof status.displayName === 'string' ? status.displayName.trim() : '';
  const profilePictureUrl =
    typeof status.profilePictureUrl === 'string'
      ? status.profilePictureUrl.trim()
      : typeof status.profile_picture_url === 'string'
        ? status.profile_picture_url.trim()
        : '';

  const identity: AccountIdentity = { email };
  if (displayName) {
    identity.displayName = displayName;
  }

  const tierLabel = formatTierLabel(status.g1Tier);
  const planLabel = formatTierLabel(status.plan);
  if (tierLabel) {
    identity.tier = tierLabel;
  }
  if (typeof status.plan === 'string' && status.plan.trim() !== '') {
    identity.plan = status.plan.trim();
  }
  // plan-only payloads still surface a tier label (e.g. plan: 'ultra')
  if (!tierLabel && planLabel) {
    identity.tier = planLabel;
  }

  if (typeof status.isPro === 'boolean') {
    identity.isPro = status.isPro;
  } else if (identity.tier && /ultra|pro/i.test(identity.tier)) {
    identity.isPro = true;
  }

  if (profilePictureUrl) {
    identity.profilePictureUrl = profilePictureUrl;
  }

  return identity;
}

/**
 * Connect-RPC client for interacting with `agy --hub` language server endpoints.
 */
export class HubClient {
  private readonly timeoutMs: number;
  private readonly protocolCache = new Map<string, 'http:' | 'https:'>();
  private readonly generatorMetadataCache = new Map<string, CallUsagePoint[]>();
  private readonly modelCatalogCache = new Map<string, { timestamp: number; data: ModelCatalogEntry[] }>();

  public consecutiveFailures = 0;
  public cooldownUntilMs = 0;
  public randomFn: () => number;

  constructor(
    optionsOrTimeout: { timeoutMs?: number; randomFn?: () => number } | number = {},
    randomFn?: () => number,
  ) {
    if (typeof optionsOrTimeout === 'number') {
      this.timeoutMs = optionsOrTimeout;
      this.randomFn = randomFn ?? Math.random;
    } else {
      this.timeoutMs = optionsOrTimeout.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.randomFn = optionsOrTimeout.randomFn ?? randomFn ?? Math.random;
    }
  }

  getCachedProtocol(endpoint: HubEndpoint): 'http:' | 'https:' | undefined {
    return this.protocolCache.get(`${endpoint.host}:${endpoint.port}`);
  }

  clearProtocolCache(hostKey?: string): void {
    if (hostKey) {
      this.protocolCache.delete(hostKey);
    } else {
      this.protocolCache.clear();
    }
  }

  clearCaches(): void {
    this.protocolCache.clear();
    this.generatorMetadataCache.clear();
    this.modelCatalogCache.clear();
  }

  private executeRequest(
    protocol: 'http:' | 'https:',
    endpoint: HubEndpoint,
    methodPath: string,
    body: string,
  ): Promise<{ statusCode: number; data: unknown; retryAfterMs?: number }> {
    return new Promise((resolve, reject) => {
      const isHttps = protocol === 'https:';
      const clientModule = isHttps ? https : http;

      const req = clientModule.request(
        {
          protocol,
          hostname: endpoint.host,
          port: endpoint.port,
          path: `/exa.language_server_pb.LanguageServerService/${methodPath}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': endpoint.csrfToken,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
          agent: isHttps
            ? new https.Agent({ rejectUnauthorized: !isLoopbackOrWsl(endpoint.host) })
            : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            if (text.trim().length > 0) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = text;
              }
            }
            const retryHeader = res.headers['retry-after'];
            const headerVal = Array.isArray(retryHeader) ? retryHeader[0] : retryHeader;
            const retryAfterMs = parseRetryAfterMs(headerVal);
            resolve({ statusCode: res.statusCode ?? 0, data: parsed, retryAfterMs });
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Connect-RPC request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  private async postRpc(
    endpoint: HubEndpoint,
    methodPath: string,
    payload: unknown,
  ): Promise<{ statusCode: number; data: any; protocol: 'http:' | 'https:'; retryAfterMs?: number } | null> {
    const body = JSON.stringify(payload);
    const hostKey = `${endpoint.host}:${endpoint.port}`;
    const cached = this.protocolCache.get(hostKey);

    const protocolsToTry: Array<'http:' | 'https:'> = cached
      ? [cached, cached === 'http:' ? 'https:' : 'http:']
      : ['http:', 'https:'];

    let lastError: unknown = null;
    for (const proto of protocolsToTry) {
      try {
        const res = await this.executeRequest(proto, endpoint, methodPath, body);
        if (proto === 'http:' && res.statusCode === 400) {
          continue;
        }
        if (res.statusCode === 401) {
          this.clearProtocolCache(hostKey);
        } else {
          this.protocolCache.set(hostKey, proto);
        }
        return { ...res, protocol: proto };
      } catch (err: any) {
        lastError = err;
        const code = err?.code ?? '';
        // If port is closed / refused or host unreachable, stop immediately
        if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
          this.clearProtocolCache(hostKey);
          throw err;
        }
        // If SSL or protocol error occurred on HTTP, next iteration will try HTTPS
      }
    }

    return null;
  }

  /**
   * Fetches quota summary with metadata, incorporating circuit-breaking and rate-limiting.
   */
  async fetchQuotaWithMeta(
    endpoint: HubEndpoint,
    nowMs = Date.now(),
  ): Promise<{
    quota: QuotaSnapshot;
    endpointFailed: boolean;
    rateLimited: boolean;
    cooldownUntilMs: number;
  }> {
    if (nowMs < this.cooldownUntilMs) {
      return {
        quota: {
          ...buildOfflineQuota(nowMs),
          cooldownUntilMs: this.cooldownUntilMs,
          rateLimited: true,
        },
        endpointFailed: false,
        rateLimited: true,
        cooldownUntilMs: this.cooldownUntilMs,
      };
    }

    const hostKey = `${endpoint.host}:${endpoint.port}`;

    try {
      const summaryRes = await this.postRpc(endpoint, 'RetrieveUserQuotaSummary', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
      });

      if (summaryRes?.statusCode === 429) {
        this.consecutiveFailures++;
        const duration = Math.max(summaryRes.retryAfterMs ?? 0, 60_000);
        this.cooldownUntilMs = nowMs + duration;
        return {
          quota: {
            ...buildOfflineQuota(nowMs),
            cooldownUntilMs: this.cooldownUntilMs,
            rateLimited: true,
          },
          endpointFailed: false,
          rateLimited: true,
          cooldownUntilMs: this.cooldownUntilMs,
        };
      }

      if (summaryRes?.statusCode === 401) {
        this.clearProtocolCache(hostKey);
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 3) {
          this.cooldownUntilMs = nowMs + 60_000;
        }
        return {
          quota: buildOfflineQuota(nowMs),
          endpointFailed: true,
          rateLimited: false,
          cooldownUntilMs: this.cooldownUntilMs,
        };
      }

      if (summaryRes && summaryRes.statusCode === 200 && summaryRes.data) {
        const snapshot = normalizeQuotaFromSummary(summaryRes.data, nowMs);
        const hasAnyWindow = Object.values(snapshot.pools).some(
          (p) => p.fiveHour !== null || p.weekly !== null,
        );
        if (hasAnyWindow) {
          this.consecutiveFailures = 0;
          return {
            quota: snapshot,
            endpointFailed: false,
            rateLimited: false,
            cooldownUntilMs: 0,
          };
        }
      }

      // Fallback to GetUserStatus
      const statusRes = await this.postRpc(endpoint, 'GetUserStatus', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
      });

      if (statusRes?.statusCode === 429) {
        this.consecutiveFailures++;
        const duration = Math.max(statusRes.retryAfterMs ?? 0, 60_000);
        this.cooldownUntilMs = nowMs + duration;
        return {
          quota: {
            ...buildOfflineQuota(nowMs),
            cooldownUntilMs: this.cooldownUntilMs,
            rateLimited: true,
          },
          endpointFailed: false,
          rateLimited: true,
          cooldownUntilMs: this.cooldownUntilMs,
        };
      }

      if (statusRes?.statusCode === 401) {
        this.clearProtocolCache(hostKey);
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 3) {
          this.cooldownUntilMs = nowMs + 60_000;
        }
        return {
          quota: buildOfflineQuota(nowMs),
          endpointFailed: true,
          rateLimited: false,
          cooldownUntilMs: this.cooldownUntilMs,
        };
      }

      if (statusRes && statusRes.statusCode === 200 && statusRes.data) {
        this.consecutiveFailures = 0;
        return {
          quota: normalizeQuotaFromUserStatus(statusRes.data, nowMs),
          endpointFailed: false,
          rateLimited: false,
          cooldownUntilMs: 0,
        };
      }

      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        this.cooldownUntilMs = nowMs + 60_000;
      }
      return {
        quota: buildOfflineQuota(nowMs),
        endpointFailed: false,
        rateLimited: false,
        cooldownUntilMs: this.cooldownUntilMs,
      };
    } catch (err: any) {
      const code = err?.code ?? '';
      const isEndpointError =
        code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH';
      if (isEndpointError) {
        this.clearProtocolCache(hostKey);
      }
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        this.cooldownUntilMs = nowMs + 60_000;
      }
      return {
        quota: buildOfflineQuota(nowMs),
        endpointFailed: isEndpointError,
        rateLimited: false,
        cooldownUntilMs: this.cooldownUntilMs,
      };
    }
  }

  /**
   * Fetches quota summary from RetrieveUserQuotaSummary, falling back to GetUserStatus.
   * Returns an offline QuotaSnapshot without throwing on ECONNREFUSED or network failure.
   */
  async fetchQuota(endpoint: HubEndpoint, nowMs = Date.now()): Promise<QuotaSnapshot> {
    const meta = await this.fetchQuotaWithMeta(endpoint, nowMs);
    return meta.quota;
  }

  /**
   * Fetches the model catalog from GetUserStatus with a 60-second cache per endpoint.
   */
  async fetchModelCatalog(endpoint: HubEndpoint, nowMs = Date.now()): Promise<ModelCatalogEntry[]> {
    const hostKey = `${endpoint.host}:${endpoint.port}`;
    const cached = this.modelCatalogCache.get(hostKey);
    if (cached && nowMs - cached.timestamp < 60_000) {
      return cached.data;
    }

    try {
      const res = await this.postRpc(endpoint, 'GetUserStatus', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
      });

      if (res && res.statusCode === 200 && res.data) {
        const catalog = extractModelCatalogFromUserStatus(res.data);
        this.modelCatalogCache.set(hostKey, { timestamp: nowMs, data: catalog });
        return catalog;
      }

      return cached ? cached.data : [];
    } catch {
      return cached ? cached.data : [];
    }
  }

  /**
   * Fetches the account identity from GetUserStatus. Returns null when offline or unauthenticated.
   */
  async fetchUserIdentity(endpoint: HubEndpoint): Promise<AccountIdentity | null> {
    try {
      const res = await this.postRpc(endpoint, 'GetUserStatus', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
      });
      if (res && res.statusCode === 200 && res.data) {
        return extractUserIdentityFromUserStatus(res.data);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetches trajectories from GetAllCascadeTrajectories.
   * Supports a single HubEndpoint or an array of candidates (falling through if candidate #1 returns empty {}).
   * Returns null if offline, an empty Map if online with zero trajectories, or populated Map.
   */
  async fetchTrajectories(
    endpoint: HubEndpoint | HubEndpoint[],
  ): Promise<Map<string, RpcTrajectorySummary> | null> {
    const candidates = Array.isArray(endpoint) ? endpoint : [endpoint];
    if (candidates.length === 0) {
      return null;
    }

    let emptyMapResult: Map<string, RpcTrajectorySummary> | null = null;

    for (const cand of candidates) {
      try {
        const res = await this.postRpc(cand, 'GetAllCascadeTrajectories', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
        });

        if (res && res.statusCode === 200) {
          const map = new Map<string, RpcTrajectorySummary>();
          const rawSummaries = res.data?.trajectorySummaries;
          if (rawSummaries && typeof rawSummaries === 'object') {
            for (const [id, val] of Object.entries(rawSummaries)) {
              if (val && typeof val === 'object') {
                const summary = val as RpcTrajectorySummary;
                if (!summary.cascadeId) {
                  summary.cascadeId = id;
                }
                map.set(id, summary);
              }
            }
          }

          if (map.size > 0) {
            return map;
          }
          if (emptyMapResult === null) {
            emptyMapResult = map;
          }
        }
      } catch {
        // Safe fallthrough
      }
    }

    return emptyMapResult;
  }

  /**
   * Fetches and maps generator metadata for a given cascadeId.
   * Caches responses by (cascadeId, stepCount) to make zero duplicate HTTP requests when unchanged.
   */
  async fetchGeneratorMetadata(
    endpoint: HubEndpoint,
    cascadeId: string,
    stepCount: number,
  ): Promise<CallUsagePoint[] | null> {
    if (!cascadeId || stepCount <= 0) {
      return [];
    }

    const cacheKey = `${cascadeId}:${stepCount}`;
    const cached = this.generatorMetadataCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const res = await this.postRpc(endpoint, 'GetCascadeTrajectoryGeneratorMetadata', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
        cascadeId,
      });

      if (!res || res.statusCode !== 200 || !res.data) {
        return null;
      }

      const rawList = res.data.generatorMetadata;
      if (!Array.isArray(rawList)) {
        return [];
      }

      const points: CallUsagePoint[] = [];
      for (let i = 0; i < rawList.length; i++) {
        const call = rawList[i] as RpcGeneratorCall;
        const chatModel = call?.chatModel ?? {};
        const usage = chatModel?.usage ?? {};
        const chatStart = chatModel?.chatStartMetadata ?? {};
        const ctxMeta = chatStart?.contextWindowMetadata ?? {};

        const fresh = Number(usage.inputTokens ?? 0);
        const cacheRead = Number(usage.cacheReadTokens ?? 0);
        const thinking = Number(usage.thinkingOutputTokens ?? 0);
        const response = Number(usage.responseOutputTokens ?? 0);
        const output =
          Number(usage.outputTokens ?? 0) > 0 ? Number(usage.outputTokens) : thinking + response;

        const estimatedTokensUsed = Number(ctxMeta.estimatedTokensUsed ?? 0);
        const effectiveContext = Math.max(estimatedTokensUsed, fresh + cacheRead);

        const maxContextTokens = Number(ctxMeta.maxContextTokens ?? 0);
        const contextLimit = maxContextTokens > 0 ? maxContextTokens : DEFAULT_CONTEXT_LIMIT;

        const rawStart = chatStart.startStepIndex;
        const numStart = rawStart !== undefined && rawStart !== null ? Number(rawStart) : null;
        const startStepIndex =
          numStart !== null && Number.isInteger(numStart) && numStart >= 0 && numStart < 1_000_000_000
            ? numStart
            : null;

        let tokenBreakdownGroups: TokenBreakdownGroup[] | undefined;
        if (Array.isArray(ctxMeta.tokenBreakdown)) {
          tokenBreakdownGroups = ctxMeta.tokenBreakdown.map((item) => {
            const name = String(item.name ?? item.label ?? item.category ?? '');
            const tokens = Number(item.tokens ?? item.tokenCount ?? 0);
            const pct = effectiveContext > 0 ? Math.round((tokens / effectiveContext) * 100) : 0;
            return { name, tokens, pct };
          });
        } else if (ctxMeta.tokenBreakdown && typeof ctxMeta.tokenBreakdown === 'object') {
          tokenBreakdownGroups = Object.entries(ctxMeta.tokenBreakdown).map(([name, val]) => {
            const tokens = Number(val ?? 0);
            const pct = effectiveContext > 0 ? Math.round((tokens / effectiveContext) * 100) : 0;
            return { name, tokens, pct };
          });
        }

        points.push({
          idx: i,
          stepIndices: Array.isArray(call.stepIndices) ? call.stepIndices.map(Number) : [],
          model: chatModel.model ?? usage.model ?? 'unknown',
          rawModel: chatModel.model ?? usage.model ?? undefined,
          fresh,
          cacheRead,
          output,
          thinking,
          response,
          effectiveContext,
          contextLimit,
          startStepIndex,
          isCompacted: false,
          compactedFromStep: null,
          tokenBreakdownGroups,
          apiProvider: usage.apiProvider ?? undefined,
          source: 'rpc',
        });
      }

      // Exact compaction detection pass
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];

        if (
          curr.startStepIndex !== null &&
          curr.startStepIndex > 0 &&
          curr.startStepIndex !== prev.startStepIndex
        ) {
          curr.isCompacted = true;
          curr.compactedFromStep = curr.startStepIndex;
        } else if (
          prev.startStepIndex === null &&
          curr.startStepIndex === null &&
          prev.effectiveContext > 0 &&
          curr.effectiveContext < prev.effectiveContext - 10_000
        ) {
          const next1 = points[i + 1]?.effectiveContext ?? 0;
          const next2 = points[i + 2]?.effectiveContext ?? 0;
          const threshold = prev.effectiveContext * 0.85;
          if (next1 < threshold && next2 < threshold) {
            curr.isCompacted = true;
            curr.compactedFromStep = null;
          }
        }
      }

      this.generatorMetadataCache.set(cacheKey, points);
      return points;
    } catch {
      return null;
    }
  }
}
