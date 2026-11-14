import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalSnapshot, LocalTelemetryReader } from './data/localTelemetry.ts';
import type { HubClient } from './rpc/hubClient.ts';
import type { HubDiscoveryDeps, HubEndpoint } from './rpc/hubDiscovery.ts';
import { buildSessionTree } from './core/sessionTree.ts';
import { resolveActiveSession } from './core/sessionResolver.ts';
import {
  DEFAULT_CONFIG,
  type CallUsagePoint,
  type MonitorConfig,
  type MonitorState,
  type QuotaPool,
  type QuotaSnapshot,
  type ScopeMode,
  type SessionNode,
} from './types.ts';

const WATCH_DEBOUNCE_MS = 500;

export interface MonitorServiceDeps {
  localReader: LocalTelemetryReader;
  hubClient: HubClient;
  discoverEndpoints: (deps?: HubDiscoveryDeps) => Promise<HubEndpoint[]>;
  workspacePaths: string[];
  config?: MonitorConfig;
  pinnedSessionId?: string | null;
  scope?: ScopeMode;
  antigravityRoot?: string;
  sqliteBackend?: 'node:sqlite' | 'sqlite3-cli' | 'python3' | 'unavailable';
  onPersistPinnedId?: (id: string | null) => void | Promise<void>;
  onPersistScope?: (scope: ScopeMode) => void | Promise<void>;
  onDidUpdateState?: (state: MonitorState) => void;
  // Test injection hooks
  timerFactory?: {
    setTimeout: (fn: () => void, ms?: number) => any;
    clearTimeout: (id: any) => void;
    setInterval: (fn: () => void, ms?: number) => any;
    clearInterval: (id: any) => void;
  };
  watchFactory?: (
    dirPath: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => { close(): void } | null;
  now?: () => number;
}

function buildEmptyQuotaPool(key: 'gemini' | 'nonGoogle', displayName: string): QuotaPool {
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
      gemini: buildEmptyQuotaPool('gemini', 'Gemini'),
      nonGoogle: buildEmptyQuotaPool('nonGoogle', 'Non-Google'),
    },
    fetchedAt: nowMs,
    error,
  };
}

function createInitialState(
  scope: ScopeMode,
  workspacePaths: string[],
  sqliteBackend: 'node:sqlite' | 'sqlite3-cli' | 'python3' | 'unavailable',
  nowMs: number,
): MonitorState {
  return {
    scope,
    workspacePaths: [...workspacePaths],
    roots: [],
    unattachedSubagents: [],
    activeSession: null,
    selectedSession: null,
    pinnedSessionId: null,
    selectedSessionId: null,
    pinMissing: false,
    lastConversationId: null,
    artifactHintId: null,
    quota: buildOfflineQuota(nowMs),
    hubStatus: 'discovering',
    hubPort: null,
    hubSource: null,
    sqliteBackend,
    lastUpdatedAt: nowMs,
    isRefreshing: false,
    lastError: null,
    warnings: [],
  };
}

export class MonitorService {
  private readonly localReader: LocalTelemetryReader;
  private readonly hubClient: HubClient;
  private readonly discoverEndpoints: (deps?: HubDiscoveryDeps) => Promise<HubEndpoint[]>;
  private workspacePaths: string[];
  private config: MonitorConfig;
  private pinnedSessionId: string | null;
  private selectedSessionId: string | null = null;
  private scope: ScopeMode;
  private artifactHintId: string | null = null;
  private readonly antigravityRoot: string;
  private readonly sqliteBackend: 'node:sqlite' | 'sqlite3-cli' | 'python3' | 'unavailable';

  private readonly onPersistPinnedId?: (id: string | null) => void | Promise<void>;
  private readonly onPersistScope?: (scope: ScopeMode) => void | Promise<void>;
  private readonly onDidUpdateState?: (state: MonitorState) => void;

  private readonly timerFactory: NonNullable<MonitorServiceDeps['timerFactory']>;
  private readonly watchFactory?: MonitorServiceDeps['watchFactory'];
  private readonly now: () => number;

  private state: MonitorState;
  private isWindowFocused = true;
  private disposed = false;
  private started = false;

  private pollingTimer: any = null;
  private watchDebounceTimer: any = null;
  private watchers: Array<{ close(): void }> = [];

  private inFlight: Promise<void> | null = null;
  private pendingRefresh = false;
  private pendingForceRescan = false;

  private readonly cachedRpcCalls = new Map<string, CallUsagePoint[]>();

  constructor(deps: MonitorServiceDeps) {
    this.localReader = deps.localReader;
    this.hubClient = deps.hubClient;
    this.discoverEndpoints = deps.discoverEndpoints;
    this.workspacePaths = [...deps.workspacePaths];
    this.config = deps.config ? { ...deps.config } : { ...DEFAULT_CONFIG };
    this.pinnedSessionId = deps.pinnedSessionId ?? null;
    this.scope = deps.scope ?? this.config.defaultScope ?? 'current';

    this.antigravityRoot = deps.antigravityRoot
      ? path.resolve(deps.antigravityRoot)
      : path.join(os.homedir(), '.gemini', 'antigravity');

    const readerBackend = (deps.localReader as any)?.sqliteBackend;
    this.sqliteBackend = deps.sqliteBackend ?? readerBackend ?? 'unavailable';

    this.onPersistPinnedId = deps.onPersistPinnedId;
    this.onPersistScope = deps.onPersistScope;
    this.onDidUpdateState = deps.onDidUpdateState;

    this.timerFactory = deps.timerFactory ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
    };
    this.watchFactory = deps.watchFactory;
    this.now = deps.now ?? (() => Date.now());

    this.state = createInitialState(this.scope, this.workspacePaths, this.sqliteBackend, this.now());
    this.state.pinnedSessionId = this.pinnedSessionId;
  }

  public async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.started = true;
    this.initWatchers();
    this.resetPollingTimer();
    await this.refreshNow();
  }

  public getState(): MonitorState {
    return this.state;
  }

  public setWindowFocused(focused: boolean): void {
    if (this.isWindowFocused === focused) {
      return;
    }
    this.isWindowFocused = focused;
    this.resetPollingTimer();
  }

  public updateConfig(config: MonitorConfig): void {
    this.config = { ...config };
    this.resetPollingTimer();
  }

  public setWorkspacePaths(paths: string[]): void {
    this.workspacePaths = [...paths];
    void this.refreshNow();
  }

  public setArtifactHint(id: string | null): void {
    if (this.artifactHintId !== id) {
      this.artifactHintId = id;
      void this.refreshNow();
    }
  }

  public selectForPanel(id: string | null): void {
    this.selectedSessionId = id;
    this.updateSelectionState();
    if (id !== null && this.started) {
      void this.refreshNow();
    }
  }

  public async pinSession(id: string): Promise<void> {
    this.pinnedSessionId = id;
    this.selectedSessionId = id;
    await this.onPersistPinnedId?.(id);
    await this.refreshNow();
  }

  public async unpinSession(): Promise<void> {
    this.pinnedSessionId = null;
    await this.onPersistPinnedId?.(null);
    await this.refreshNow();
  }

  public async toggleScope(): Promise<void> {
    const nextScope: ScopeMode = this.scope === 'current' ? 'all' : 'current';
    return this.setScope(nextScope);
  }

  public async setScope(scope: ScopeMode): Promise<void> {
    this.scope = scope;
    await this.onPersistScope?.(scope);
    await this.refreshNow();
  }

  public async refreshNow(forceRescan = false): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.inFlight) {
      this.pendingRefresh = true;
      if (forceRescan) {
        this.pendingForceRescan = true;
      }
      return this.inFlight;
    }

    this.inFlight = this.performRefresh(forceRescan);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
      if (this.pendingRefresh && !this.disposed) {
        const force = this.pendingForceRescan;
        this.pendingRefresh = false;
        this.pendingForceRescan = false;
        await this.refreshNow(force);
      }
    }
  }

  private resetPollingTimer(): void {
    if (this.pollingTimer !== null) {
      this.timerFactory.clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    if (this.disposed) {
      return;
    }

    const intervalMs = this.isWindowFocused
      ? this.config.refreshIntervalMs
      : this.config.unfocusedRefreshIntervalMs;

    this.pollingTimer = this.timerFactory.setInterval(() => {
      void this.refreshNow();
    }, intervalMs);
  }

  private initWatchers(): void {
    const targets = [this.antigravityRoot, path.join(this.antigravityRoot, 'conversations')];

    for (const target of targets) {
      try {
        if (this.watchFactory) {
          const watcher = this.watchFactory(target, () => {
            this.handleWatchEvent();
          });
          if (watcher) {
            this.watchers.push(watcher);
          }
        } else {
          const watcher = fs.watch(target, { persistent: false }, () => {
            this.handleWatchEvent();
          });
          watcher.on('error', () => {
            // Tolerate errors on watched directories
          });
          this.watchers.push(watcher);
        }
      } catch {
        // Directory may not exist yet before first Antigravity launch; safely tolerate
      }
    }
  }

  private handleWatchEvent(): void {
    if (this.disposed) {
      return;
    }
    if (this.watchDebounceTimer !== null) {
      this.timerFactory.clearTimeout(this.watchDebounceTimer);
    }
    this.watchDebounceTimer = this.timerFactory.setTimeout(() => {
      this.watchDebounceTimer = null;
      void this.refreshNow();
    }, WATCH_DEBOUNCE_MS);
  }

  private async performRefresh(forceRescan: boolean): Promise<void> {
    const now = this.now();
    this.state.isRefreshing = true;

    try {
      // 1. Read local SQLite telemetry
      const localSnapshot: LocalSnapshot = await this.localReader.read(forceRescan);

      // 2. Discover Hub endpoints
      let endpoints: HubEndpoint[] = [];
      try {
        endpoints = await this.discoverEndpoints({ workspacePaths: this.workspacePaths });
      } catch {
        endpoints = [];
      }

      // 3. Quota and Trajectories with fallthrough
      let quotaSnapshot = buildOfflineQuota(now);
      let rpcSummaries: Map<string, any> | null = null;
      let activeEndpoint: HubEndpoint | null = null;

      if (endpoints.length > 0) {
        // Review Focus #1: Trajectory fallthrough across candidate endpoints
        rpcSummaries = await this.hubClient.fetchTrajectories(endpoints);

        // Review Focus #1: Prefer first online endpoint returning valid quota
        for (const ep of endpoints) {
          try {
            const q = await this.hubClient.fetchQuota(ep, now);
            if (q.status === 'online') {
              quotaSnapshot = q;
              activeEndpoint = ep;
              break;
            }
          } catch {
            // Fall through to next candidate
          }
        }

        if (!activeEndpoint && endpoints.length > 0) {
          activeEndpoint = endpoints[0];
        }
      }

      const hubStatus =
        endpoints.length === 0
          ? 'offline'
          : quotaSnapshot.status === 'online' || rpcSummaries !== null
            ? 'connected'
            : 'offline';

      // 4. Step counts map for selective RPC metadata polling
      const stepCounts = new Map<string, number>();
      for (const s of localSnapshot.summaries) {
        stepCounts.set(s.conversationId, s.stepCount);
      }
      if (rpcSummaries) {
        for (const [id, r] of rpcSummaries.entries()) {
          stepCounts.set(id, Math.max(stepCounts.get(id) ?? 0, r.stepCount ?? 0));
        }
      }

      // 5. Initial tree pass to identify candidates for selective RPC generator metadata
      const initialTree = buildSessionTree({
        summaries: localSnapshot.summaries,
        rpcSummaries,
        localCalls: localSnapshot.callsById,
        rpcCalls: this.cachedRpcCalls,
        workspacePaths: this.workspacePaths,
      });

      const { active: candidateActive } = resolveActiveSession({
        roots: initialTree.roots,
        byId: initialTree.byId,
        pinnedId: this.pinnedSessionId,
        scope: this.scope,
        lastConversationId: localSnapshot.lastConversationId,
        artifactHintId: this.artifactHintId,
      });

      // 6. Selective fetchGeneratorMetadata
      // ONLY active, pinned, selectedSessionId, and RUNNING workspace sessions (plus their active/running subagents)
      if (activeEndpoint && hubStatus === 'connected') {
        const targetIds = new Set<string>();

        const addWithRunningDescendants = (node: SessionNode | undefined | null) => {
          if (!node) return;
          targetIds.add(node.id);
          for (const child of node.children) {
            const childRunning =
              !child.killed &&
              (child.rolledUp.isRunning ||
                child.own.isRunning ||
                child.status === 'CASCADE_RUN_STATUS_RUNNING' ||
                child.notFullyIdle);
            if (childRunning) {
              addWithRunningDescendants(child);
            }
          }
        };

        if (candidateActive) {
          addWithRunningDescendants(candidateActive);
        }

        if (this.pinnedSessionId) {
          addWithRunningDescendants(initialTree.byId.get(this.pinnedSessionId));
        }

        if (this.selectedSessionId) {
          addWithRunningDescendants(initialTree.byId.get(this.selectedSessionId));
        }

        for (const node of initialTree.byId.values()) {
          const isRunningWorkspace =
            node.matchesWorkspace &&
            !node.killed &&
            (node.rolledUp.isRunning ||
              node.own.isRunning ||
              node.status === 'CASCADE_RUN_STATUS_RUNNING' ||
              node.notFullyIdle);
          if (isRunningWorkspace) {
            addWithRunningDescendants(node);
          }
        }

        // Fetch generator metadata only for identified target IDs
        for (const id of targetIds) {
          const stepCount = stepCounts.get(id) ?? 0;
          if (stepCount > 0) {
            try {
              const calls = await this.hubClient.fetchGeneratorMetadata(activeEndpoint, id, stepCount);
              if (calls && calls.length > 0) {
                this.cachedRpcCalls.set(id, calls);
              }
            } catch {
              // Ignore RPC call errors
            }
          }
        }
      }

      // 7. Build final tree with populated RPC calls
      const finalTree = buildSessionTree({
        summaries: localSnapshot.summaries,
        rpcSummaries,
        localCalls: localSnapshot.callsById,
        rpcCalls: this.cachedRpcCalls,
        workspacePaths: this.workspacePaths,
      });

      const { active, pinMissing } = resolveActiveSession({
        roots: finalTree.roots,
        byId: finalTree.byId,
        pinnedId: this.pinnedSessionId,
        scope: this.scope,
        lastConversationId: localSnapshot.lastConversationId,
        artifactHintId: this.artifactHintId,
      });

      // 7. Update node flags
      if (this.pinnedSessionId) {
        const pinnedNode = finalTree.byId.get(this.pinnedSessionId);
        if (pinnedNode) {
          pinnedNode.isPinned = true;
        }
      }

      if (active) {
        active.isActive = true;
      }

      let selectedSession: SessionNode | null = null;
      if (this.selectedSessionId) {
        selectedSession = finalTree.byId.get(this.selectedSessionId) ?? null;
      }
      if (!selectedSession) {
        selectedSession = active;
      }
      if (selectedSession) {
        selectedSession.isSelected = true;
      }

      const readerBackend = (this.localReader as any)?.sqliteBackend;
      const backend = readerBackend ?? this.sqliteBackend;

      this.state = {
        scope: this.scope,
        workspacePaths: [...this.workspacePaths],
        roots: finalTree.roots,
        unattachedSubagents: finalTree.unattachedSubagents,
        activeSession: active,
        selectedSession,
        pinnedSessionId: this.pinnedSessionId,
        selectedSessionId: this.selectedSessionId,
        pinMissing,
        lastConversationId: localSnapshot.lastConversationId,
        artifactHintId: this.artifactHintId,
        quota: quotaSnapshot,
        hubStatus,
        hubPort: activeEndpoint?.port ?? null,
        hubSource: activeEndpoint?.source ?? null,
        sqliteBackend: backend,
        lastUpdatedAt: this.now(),
        isRefreshing: false,
        lastError: null,
        warnings: [],
      };

      this.onDidUpdateState?.(this.state);
    } catch (err: any) {
      this.state.isRefreshing = false;
      this.state.lastError = err instanceof Error ? err.message : String(err);
      this.onDidUpdateState?.(this.state);
    }
  }

  private updateSelectionState(): void {
    if (!this.state) {
      return;
    }

    const byId = new Map<string, SessionNode>();
    const indexNode = (n: SessionNode) => {
      byId.set(n.id, n);
      n.isSelected = n.id === this.selectedSessionId;
      for (const child of n.children) {
        indexNode(child);
      }
    };

    for (const root of this.state.roots) {
      indexNode(root);
    }
    for (const orphan of this.state.unattachedSubagents) {
      indexNode(orphan);
    }

    let selectedNode: SessionNode | null = null;
    if (this.selectedSessionId) {
      selectedNode = byId.get(this.selectedSessionId) ?? null;
    }
    if (!selectedNode) {
      selectedNode = this.state.activeSession;
      if (selectedNode) {
        selectedNode.isSelected = true;
      }
    }

    this.state.selectedSessionId = this.selectedSessionId;
    this.state.selectedSession = selectedNode;
    this.onDidUpdateState?.(this.state);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.started = false;

    if (this.pollingTimer !== null) {
      this.timerFactory.clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    if (this.watchDebounceTimer !== null) {
      this.timerFactory.clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Safe close
      }
    }
    this.watchers = [];

    this.cachedRpcCalls.clear();
    void this.localReader.flushCache();
  }
}
