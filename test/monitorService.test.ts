import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorService, type MonitorServiceDeps } from '../src/monitorService.ts';
import type {
  CallUsagePoint,
  MonitorConfig,
  MonitorState,
  QuotaSnapshot,
  RawConversationSummary,
  RpcTrajectorySummary,
  ScopeMode,
} from '../src/types.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import type { HubEndpoint } from '../src/rpc/hubDiscovery.ts';

function createMockSummary(overrides: Partial<RawConversationSummary> = {}): RawConversationSummary {
  return {
    conversationId: 'conv-1',
    title: 'Test Session',
    preview: 'Testing...',
    stepCount: 5,
    lastModifiedTime: 1000,
    lastUserInputTime: 1000,
    workspaceUris: ['file:///workspace/project'],
    status: 'CASCADE_RUN_STATUS_IDLE',
    parentConversationId: '',
    nestingDepth: 0,
    agentName: '',
    subagentRole: '',
    killed: false,
    notFullyIdle: false,
    ...overrides,
  };
}

function createMockQuota(status: 'online' | 'offline' = 'online'): QuotaSnapshot {
  return {
    status,
    source: 'summary',
    pools: {
      gemini: {
        key: 'gemini',
        displayName: 'Gemini',
        fiveHour: {
          window: '5h',
          remainingPct: 85,
          remainingFraction: 0.85,
          resetTime: '2026-11-14T05:00:00Z',
          isReady: true,
          isExhausted: false,
        },
        weekly: null,
      },
      nonGoogle: {
        key: 'nonGoogle',
        displayName: 'Non-Google',
        fiveHour: {
          window: '5h',
          remainingPct: 90,
          remainingFraction: 0.9,
          resetTime: '2026-11-14T05:00:00Z',
          isReady: true,
          isExhausted: false,
        },
        weekly: null,
      },
    },
    fetchedAt: Date.now(),
  };
}

describe('MonitorService Orchestrator', () => {
  it('1. Refreshes quota + trajectories once per cycle, and calls fetchGeneratorMetadata ONLY for active, pinned, selected, and running workspace sessions', async () => {
    // 5 sessions:
    // s-active: workspace, idle, newest (active)
    // s-pinned: pinned session
    // s-selected: selected for panel inspection
    // s-running: workspace, running, with child subagent-running and subagent-idle
    // s-historical: workspace, idle, older
    // s-other: other workspace, idle

    const summaries: RawConversationSummary[] = [
      createMockSummary({
        conversationId: 's-active',
        title: 'Active Session',
        lastModifiedTime: 5000,
        stepCount: 10,
      }),
      createMockSummary({
        conversationId: 's-pinned',
        title: 'Pinned Session',
        lastModifiedTime: 2000,
        stepCount: 8,
      }),
      createMockSummary({
        conversationId: 's-selected',
        title: 'Selected Session',
        lastModifiedTime: 3000,
        stepCount: 12,
      }),
      createMockSummary({
        conversationId: 's-running',
        title: 'Running Session',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        lastModifiedTime: 4000,
        stepCount: 15,
      }),
      createMockSummary({
        conversationId: 's-killed-running',
        title: 'Killed Running Session',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        killed: true,
        lastModifiedTime: 4020,
        stepCount: 8,
      }),
      createMockSummary({
        conversationId: 'subagent-running',
        parentConversationId: 's-running',
        nestingDepth: 1,
        title: 'Running Subagent',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        lastModifiedTime: 4100,
        stepCount: 4,
      }),
      createMockSummary({
        conversationId: 'subagent-killed-running',
        parentConversationId: 's-running',
        nestingDepth: 1,
        title: 'Killed Running Subagent',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        killed: true,
        lastModifiedTime: 4050,
        stepCount: 2,
      }),
      createMockSummary({
        conversationId: 'subagent-idle',
        parentConversationId: 's-running',
        nestingDepth: 1,
        title: 'Idle Subagent',
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: 3900,
        stepCount: 3,
      }),
      createMockSummary({
        conversationId: 's-historical',
        title: 'Historical Idle Session',
        lastModifiedTime: 1000,
        stepCount: 20,
      }),
      createMockSummary({
        conversationId: 's-other',
        title: 'Other Workspace Idle Session',
        workspaceUris: ['file:///workspace/other'],
        lastModifiedTime: 6000,
        stepCount: 25,
      }),
    ];

    const localCalls = new Map<string, CallUsagePoint[]>();
    for (const s of summaries) {
      localCalls.set(s.conversationId, [
        {
          idx: 0,
          stepIndices: [0],
          model: 'gemini-1.5-pro',
          fresh: 1000,
          cacheRead: 500,
          output: 200,
          thinking: 50,
          response: 150,
          effectiveContext: 1500,
          contextLimit: 256000,
          startStepIndex: null,
          isCompacted: false,
          compactedFromStep: null,
          source: 'sqlite',
        },
      ]);
    }

    const mockLocalReader: any = {
      read: async () => ({
        summaries,
        callsById: localCalls,
        lastConversationId: null,
      }),
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };

    const quotaCalls: HubEndpoint[] = [];
    const trajectoryCalls: any[] = [];
    const generatorCalls: Array<{ cascadeId: string; stepCount: number }> = [];

    const candidate1: HubEndpoint = { port: 41001, csrfToken: 'tok1', host: '127.0.0.1', source: 'exports' };
    const candidate2: HubEndpoint = { port: 41002, csrfToken: 'tok2', host: '127.0.0.1', source: 'process' };

    const mockHubClient: any = {
      fetchQuota: async (ep: HubEndpoint) => {
        quotaCalls.push(ep);
        return createMockQuota('online');
      },
      fetchTrajectories: async (candidates: HubEndpoint | HubEndpoint[]) => {
        trajectoryCalls.push(candidates);
        // Review Focus #1: candidate 1 returns empty, candidate 2 returns populated map
        const map = new Map<string, RpcTrajectorySummary>();
        map.set('s-running', {
          cascadeId: 's-running',
          stepCount: 15,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///workspace/project' }],
        });
        return map;
      },
      fetchGeneratorMetadata: async (_ep: HubEndpoint, cascadeId: string, stepCount: number) => {
        generatorCalls.push({ cascadeId, stepCount });
        return [];
      },
    };

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [candidate1, candidate2],
      workspacePaths: ['/workspace/project'],
      config: { ...DEFAULT_CONFIG },
      pinnedSessionId: 's-pinned',
    });

    service.selectForPanel('s-selected');

    await service.refreshNow();

    // Verify quota & trajectories polling: quota polls on its own cadence, trajectories with telemetry
    assert.strictEqual(quotaCalls.length, 0, 'telemetry refresh does not poll quota');
    assert.strictEqual(trajectoryCalls.length, 1, 'fetchTrajectories called once');
    await service.refreshQuotaNow();
    assert.deepStrictEqual(
      quotaCalls.map((ep) => ep.port),
      [candidate1.port, candidate2.port],
      'refreshQuotaNow polls every candidate hub once to rank freshness',
    );

    // Verify selective fetchGeneratorMetadata
    const polledIds = new Set(generatorCalls.map((g) => g.cascadeId));

    assert.ok(polledIds.has('s-pinned'), 'pinned session polled');
    assert.ok(polledIds.has('s-selected'), 'selected session polled');
    assert.ok(polledIds.has('s-running'), 'running workspace session polled');
    assert.ok(polledIds.has('subagent-running'), 'running subagent polled');

    // NEVER poll idle historical sessions or killed sessions
    assert.ok(!polledIds.has('s-historical'), 'historical idle session NOT polled');
    assert.ok(!polledIds.has('s-other'), 'other workspace idle session NOT polled');
    assert.ok(!polledIds.has('subagent-idle'), 'idle subagent NOT polled');
    assert.ok(!polledIds.has('s-killed-running'), 'killed workspace session NOT polled');
    assert.ok(!polledIds.has('subagent-killed-running'), 'killed subagent NOT polled');

    service.dispose();
  });

  it('2. Pinning vs Panel Inspection: selectForPanel updates selectedSessionId without changing pinnedSessionId or active auto-tracking; pin/unpin toggles and persists', async () => {
    const s1 = createMockSummary({ conversationId: 's1', title: 'Session 1', lastModifiedTime: 1000 });
    const s2 = createMockSummary({ conversationId: 's2', title: 'Session 2', lastModifiedTime: 2000 });

    const localCalls = new Map<string, CallUsagePoint[]>();
    localCalls.set('s1', []);
    localCalls.set('s2', []);

    const mockLocalReader: any = {
      read: async () => ({
        summaries: [s1, s2],
        callsById: localCalls,
        lastConversationId: null,
      }),
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };

    const mockHubClient: any = {
      fetchQuota: async () => createMockQuota('offline'),
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };

    const persistedPinned: Array<string | null> = [];

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [],
      workspacePaths: ['/workspace/project'],
      config: { ...DEFAULT_CONFIG },
      pinnedSessionId: null,
      onPersistPinnedId: async (id) => {
        persistedPinned.push(id);
      },
    });

    await service.refreshNow();

    const state1 = service.getState();
    assert.strictEqual(state1.activeSession?.id, 's2', 'Auto-tracks newest session s2');
    assert.strictEqual(state1.pinnedSessionId, null, 'No session pinned');

    // Select s1 for Bottom Panel inspection
    service.selectForPanel('s1');

    const state2 = service.getState();
    assert.strictEqual(state2.selectedSessionId, 's1', 'selectedSessionId is s1');
    assert.strictEqual(state2.selectedSession?.id, 's1', 'selectedSession node is s1');
    assert.strictEqual(state2.pinnedSessionId, null, 'pinnedSessionId remains null');
    assert.strictEqual(state2.activeSession?.id, 's2', 'activeSession auto-tracking STILL s2!');
    assert.strictEqual(persistedPinned.length, 0, 'onPersistPinnedId was NOT called');

    // Pin s1
    await service.pinSession('s1');

    const state3 = service.getState();
    assert.strictEqual(state3.pinnedSessionId, 's1', 'pinnedSessionId is now s1');
    assert.strictEqual(state3.activeSession?.id, 's1', 'activeSession pinned to s1');
    assert.strictEqual(state3.selectedSessionId, 's1', 'selectedSessionId set to s1');
    assert.deepStrictEqual(persistedPinned, ['s1'], 'persisted s1');

    // Unpin
    await service.unpinSession();

    const state4 = service.getState();
    assert.strictEqual(state4.pinnedSessionId, null, 'pinnedSessionId cleared to null');
    assert.strictEqual(state4.activeSession?.id, 's2', 'Restores Auto tracking to s2');
    assert.deepStrictEqual(persistedPinned, ['s1', null], 'persisted null');

    service.dispose();
  });

  it('3. Focus cadence (10s focused -> 30s unfocused), serialized inFlight coalescing, and clean disposal', async () => {
    const QUOTA_INTERVAL_MS = 45_000;
    const quotaMs = new Set([QUOTA_INTERVAL_MS, QUOTA_INTERVAL_MS * DEFAULT_CONFIG.quotaUnfocusedMultiplier]);
    let timerInterval: number | null = null;
    let timerIdCounter = 1;
    const liveTimers = new Set<number>();

    const fakeTimers = {
      setTimeout: (fn: any, ms?: number) => setTimeout(fn, ms),
      clearTimeout: (id: any) => clearTimeout(id),
      setInterval: (_fn: any, ms?: number) => {
        // Quota polls on its own timer; label the telemetry timer by its distinct cadence.
        if (!quotaMs.has(ms as number)) {
          timerInterval = ms ?? null;
        }
        const id = timerIdCounter++;
        liveTimers.add(id);
        return id as any;
      },
      clearInterval: (id: any) => {
        liveTimers.delete(id);
      },
    };

    let watchClosed = false;
    const fakeWatchFactory = () => ({
      close: () => {
        watchClosed = true;
      },
    });

    let readCallCount = 0;
    let blockRead = false;
    let releaseRead: (() => void) | null = null;

    const mockLocalReader: any = {
      read: async () => {
        readCallCount++;
        if (blockRead) {
          await new Promise<void>((res) => {
            releaseRead = res;
          });
        }
        return {
          summaries: [],
          callsById: new Map(),
          lastConversationId: null,
        };
      },
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };

    const mockHubClient: any = {
      fetchQuota: async () => createMockQuota('offline'),
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [],
      workspacePaths: ['/workspace/project'],
      config: {
        ...DEFAULT_CONFIG,
        refreshIntervalMs: 10_000,
        unfocusedRefreshIntervalMs: 30_000,
        quotaRefreshIntervalMs: QUOTA_INTERVAL_MS,
      },
      timerFactory: fakeTimers,
      watchFactory: fakeWatchFactory,
    });

    await service.start();

    // 1. Initial cadence when window is focused: 10s
    assert.strictEqual(timerInterval, 10_000, 'Polling cadence is 10s when focused');

    // 2. Unfocused switch to 30s
    service.setWindowFocused(false);
    assert.strictEqual(timerInterval, 30_000, 'Polling cadence switches to 30s when unfocused');

    // 3. Focused switch back to 10s
    service.setWindowFocused(true);
    assert.strictEqual(timerInterval, 10_000, 'Polling cadence returns to 10s when focused');

    // 4. InFlight coalescing: concurrent refreshes coalesce into one subsequent run
    blockRead = true;

    // Start inFlight run
    const p1 = service.refreshNow();
    // Fire concurrent requests
    const p2 = service.refreshNow();
    const p3 = service.refreshNow();

    // During inFlight, readCallCount should be 2 (1 from start(), 1 from p1)
    assert.strictEqual(readCallCount, 2, 'Only 1 new read running concurrently');

    // Finish inFlight run
    blockRead = false;
    if (releaseRead) {
      (releaseRead as () => void)();
    }
    await Promise.all([p1, p2, p3]);

    // Total read count should be at most 3 (initial start + p1 + coalesced follow-up)
    assert.strictEqual(readCallCount, 3, 'Concurrent calls coalesced into single follow-up read');

    // 5. Clean disposal: every timer still live must have been cleared by id
    assert.strictEqual(liveTimers.size, 2, 'telemetry + quota timers live before dispose');
    const liveIdsBeforeDispose = [...liveTimers];
    service.dispose();
    assert.deepStrictEqual(
      liveIdsBeforeDispose.filter((id) => liveTimers.has(id)),
      [],
      'Polling and quota timers cleared on dispose',
    );
    assert.strictEqual(watchClosed, true, 'Watchers closed on dispose');
  });

  it('4. Quota polls on its own cadence (focused, multiplied unfocused, paused at multiplier 0)', async () => {
    // Cadence values are all distinct so the active timer can be identified by its
    // interval, not by registration order (updateConfig re-registers only quota).
    // Fully fake: no real handle is ever created, so the test process can exit.
    const active = new Map<number, { ms: number | undefined; fn: () => void }>();
    const pendingTimeouts = new Map<number, () => void>();
    let nextId = 1;

    const fakeTimers = {
      setTimeout: (fn: any, _ms?: number) => {
        const id = nextId++;
        pendingTimeouts.set(id, fn);
        return id as any;
      },
      clearTimeout: (id: any) => {
        pendingTimeouts.delete(id);
      },
      setInterval: (fn: any, ms?: number) => {
        const id = nextId++;
        active.set(id, { ms, fn });
        return id as any;
      },
      clearInterval: (id: any) => {
        active.delete(id);
      },
    };

    const quotaIntervals = () => [...active.values()].filter((t) => t.ms === 30_000 || t.ms === 60_000);
    const telemetryIntervals = () => [...active.values()].filter((t) => t.ms === 10_000 || t.ms === 20_000);

    // Fire every registered interval once, drain any debounce timeouts, then let the
    // async polls settle. setImmediate leaves no handle behind.
    const tickAll = async () => {
      for (const t of [...active.values()]) {
        t.fn();
      }
      for (const fn of [...pendingTimeouts.values()]) {
        pendingTimeouts.clear();
        fn();
      }
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
    };

    let quotaCalls = 0;
    const mockHubClient: any = {
      fetchQuota: async () => {
        quotaCalls++;
        return createMockQuota('online');
      },
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };
    const mockLocalReader: any = {
      read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }),
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };

    const makeConfig = (multiplier: number): MonitorConfig => ({
      ...DEFAULT_CONFIG,
      refreshIntervalMs: 10_000,
      unfocusedRefreshIntervalMs: 20_000,
      quotaRefreshIntervalMs: 30_000,
      quotaUnfocusedMultiplier: multiplier,
    });

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [{ port: 1, csrfToken: 't', host: '127.0.0.1', source: 'process' }],
      workspacePaths: ['/w'],
      config: makeConfig(2),
      timerFactory: fakeTimers,
      watchFactory: () => ({ close() {} }),
    });

    await service.start();
    assert.strictEqual(telemetryIntervals().length, 1, 'telemetry timer registered');
    assert.strictEqual(telemetryIntervals()[0].ms, 10_000);
    assert.strictEqual(quotaIntervals().length, 1, 'quota timer registered');
    assert.strictEqual(quotaIntervals()[0].ms, 30_000, 'focused quota cadence is quotaRefreshIntervalMs');

    // The registered quota timer must actually poll when it fires.
    const callsBeforeTick = quotaCalls;
    await tickAll();
    assert.ok(quotaCalls > callsBeforeTick, 'firing the quota timer triggers a quota fetch');

    service.setWindowFocused(false);
    assert.deepStrictEqual(telemetryIntervals().map((t) => t.ms), [20_000]);
    assert.deepStrictEqual(quotaIntervals().map((t) => t.ms), [60_000], 'unfocused quota is interval * multiplier');

    service.updateConfig(makeConfig(0));
    assert.strictEqual(quotaIntervals().length, 0, 'multiplier 0 registers no quota timer while unfocused');
    // The paused timer was cleared, so no remaining timer can produce a quota fetch.
    const pausedCalls = quotaCalls;
    await tickAll();
    assert.strictEqual(quotaCalls, pausedCalls, 'no quota fetch while paused despite a stale timer reference');

    service.setWindowFocused(true);
    assert.deepStrictEqual(quotaIntervals().map((t) => t.ms), [30_000], 'quota polling resumes when focused');
    const resumedCalls = quotaCalls;
    await tickAll();
    assert.ok(quotaCalls > resumedCalls, 'quota polling resumes fetching after unpausing');

    service.dispose();
    service.dispose();
    assert.strictEqual(active.size, 0, 'no fake interval survives dispose');
    assert.strictEqual(pendingTimeouts.size, 0, 'no fake timeout survives dispose');
  });

  it('5. selectForPanel triggers refreshNow immediately when service is started', async () => {
    let refreshCount = 0;
    const mockLocalReader: any = {
      read: async () => {
        refreshCount++;
        return {
          summaries: [createMockSummary({ conversationId: 'sess-1' })],
          callsById: new Map(),
          lastConversationId: null,
        };
      },
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };

    const mockHubClient: any = {
      fetchQuota: async () => createMockQuota('offline'),
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [],
      workspacePaths: ['/workspace/project'],
      config: { ...DEFAULT_CONFIG },
    });

    await service.start();
    assert.strictEqual(refreshCount, 1, 'Initial refresh on start');

    // Calling selectForPanel with non-null ID triggers refreshNow
    service.selectForPanel('sess-1');

    // Allow event loop tick for inFlight refreshNow to start/complete
    await new Promise((r) => setTimeout(r, 15));
    assert.strictEqual(refreshCount, 2, 'selectForPanel triggered immediate refresh');

    // Calling selectForPanel(null) does NOT trigger refreshNow
    service.selectForPanel(null);
    await new Promise((r) => setTimeout(r, 15));
    assert.strictEqual(refreshCount, 2, 'selectForPanel(null) did not trigger refresh');

    service.dispose();
  });

  it('6. refreshQuotaNow discovers endpoints when none cached and updates hub fields', async () => {
    const mockLocalReader: any = {
      read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }),
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };
    let discoverCalls = 0;
    const mockHubClient: any = {
      fetchQuota: async () => createMockQuota('online'),
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => {
        discoverCalls++;
        return [{ port: 41001, csrfToken: 't', host: '127.0.0.1', source: 'process' }];
      },
      workspacePaths: ['/w'],
      config: { ...DEFAULT_CONFIG },
    });

    await service.refreshQuotaNow();
    assert.strictEqual(discoverCalls, 1, 'quota poll discovers endpoints when none cached');
    assert.strictEqual(service.getState().quota.status, 'online');
    assert.strictEqual(service.getState().hubStatus, 'connected');
    assert.strictEqual(service.getState().hubPort, 41001);
    assert.strictEqual(service.getState().hubSource, 'process');

    service.dispose();
  });

  it('7. refreshQuotaNow emits state on an all-offline poll and keeps the previous online numbers', async () => {
    const mockLocalReader: any = {
      read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }),
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };
    let quotaStatus: 'online' | 'offline' = 'online';
    const mockHubClient: any = {
      fetchQuota: async () => createMockQuota(quotaStatus),
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };

    const emitted: MonitorState[] = [];
    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [{ port: 41001, csrfToken: 't', host: '127.0.0.1', source: 'process' }],
      workspacePaths: ['/w'],
      config: { ...DEFAULT_CONFIG },
      onDidUpdateState: (state) => {
        emitted.push({ ...state, quota: { ...state.quota } });
      },
    });

    await service.refreshQuotaNow();
    assert.strictEqual(emitted.length, 1, 'online poll emits once');
    const onlinePct = service.getState().quota.pools.gemini.fiveHour?.remainingPct;
    assert.strictEqual(onlinePct, 85);

    quotaStatus = 'offline';
    await service.refreshQuotaNow();
    assert.strictEqual(emitted.length, 2, 'all-offline poll still emits state once');
    assert.strictEqual(service.getState().quota.status, 'online', 'offline result does not overwrite an online snapshot');
    assert.strictEqual(
      service.getState().quota.pools.gemini.fiveHour?.remainingPct,
      85,
      'previous online numbers retained',
    );

    service.dispose();
  });

  it('8. Telemetry RPCs follow the hub that answered quota, not a dead endpoints[0]', async () => {
    const mockLocalReader: any = {
      read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }),
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };
    const dead: HubEndpoint = { port: 41001, csrfToken: 'dead', host: '127.0.0.1', source: 'exports' };
    const live: HubEndpoint = { port: 41002, csrfToken: 'live', host: '127.0.0.1', source: 'process' };
    const catalogPorts: Array<number | undefined> = [];
    const mockHubClient: any = {
      fetchQuota: async (ep: HubEndpoint) => createMockQuota(ep.port === live.port ? 'online' : 'offline'),
      fetchTrajectories: async () => new Map(),
      fetchModelCatalog: async (ep: HubEndpoint) => {
        catalogPorts.push(ep.port);
        return [];
      },
      fetchGeneratorMetadata: async () => [],
    };

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [dead, live],
      workspacePaths: ['/w'],
      config: { ...DEFAULT_CONFIG },
    });

    await service.refreshQuotaNow();
    await service.refreshNow();

    assert.deepStrictEqual(catalogPorts, [live.port], 'model catalog fetched from the quota-answering hub');
    assert.strictEqual(service.getState().hubPort, live.port);

    service.dispose();
  });

  it('9. refreshQuotaNow picks the hub with the freshest window, not the first online one', async () => {
    const mockLocalReader: any = {
      read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }),
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };
    const lagging: HubEndpoint = { port: 45019, csrfToken: 'a', host: '127.0.0.1', source: 'exports' };
    const current: HubEndpoint = { port: 42643, csrfToken: 'b', host: '127.0.0.1', source: 'process' };
    const withReset = (resetTime: string): QuotaSnapshot => {
      const quota = createMockQuota('online');
      quota.pools.gemini.fiveHour!.resetTime = resetTime;
      quota.pools.gemini.fiveHour!.remainingPct = 0;
      quota.pools.gemini.fiveHour!.remainingFraction = 0;
      quota.pools.gemini.fiveHour!.isExhausted = true;
      quota.pools.gemini.fiveHour!.isReady = false;
      return quota;
    };
    const mockHubClient: any = {
      // Lagging hub is listed first and reports an old, already-reset window.
      fetchQuota: async (ep: HubEndpoint) =>
        withReset(ep.port === lagging.port ? '2026-11-26T14:15:42Z' : '2026-11-26T19:25:51Z'),
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [lagging, current],
      workspacePaths: ['/w'],
      config: { ...DEFAULT_CONFIG },
    });

    await service.refreshQuotaNow();

    assert.strictEqual(service.getState().hubPort, current.port, 'fresher hub selected');
    assert.strictEqual(service.getState().hubSource, 'process');
    assert.strictEqual(service.getState().quota.pools.gemini.fiveHour?.resetTime, '2026-11-26T19:25:51Z');

    service.dispose();
  });

  it('10. refreshNow publishes quota before the heavy telemetry read finishes', async () => {
    // read() blocks once per call: a queue of resolvers so each held read can be released separately.
    const readReleases: Array<() => void> = [];
    let quotaValue = 0.8;
    let quotaFetchCount = 0;
    const published: number[] = [];

    const mockLocalReader: any = {
      read: async () => {
        await new Promise<void>((res) => {
          readReleases.push(res);
        });
        return { summaries: [], callsById: new Map(), lastConversationId: null };
      },
      flushCache: async () => {},
      clearMemoryCache: () => {},
    };

    const mockHubClient: any = {
      fetchQuota: async () => {
        quotaFetchCount++;
        const q = createMockQuota('online');
        q.pools.gemini.fiveHour!.remainingFraction = quotaValue;
        q.pools.gemini.fiveHour!.remainingPct = Math.round(quotaValue * 100);
        return q;
      },
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };

    const service = new MonitorService({
      localReader: mockLocalReader,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [{ port: 1, csrfToken: 't', host: '127.0.0.1', source: 'process' }],
      workspacePaths: ['/w'],
      timerFactory: {
        setTimeout: (fn: any, ms?: number) => setTimeout(fn, ms),
        clearTimeout: (id: any) => clearTimeout(id),
        setInterval: () => 1,
        clearInterval: () => {},
      },
      watchFactory: () => ({ close() {} }),
      onDidUpdateState: (state) => published.push(state.quota.pools.gemini.fiveHour?.remainingFraction ?? -1),
    });

    // Let the start() refresh finish: it blocks in read(), so release it.
    void service.start();
    await new Promise((r) => setTimeout(r, 10));
    readReleases.shift()!();
    await new Promise((r) => setTimeout(r, 10));

    // Automatic refreshes (start, timers, watch events) leave quota to the quota timer.
    assert.strictEqual(quotaFetchCount, 0, 'refreshNow without forceRescan does not poll quota');

    // Now hold the heavy path open and ask for a manual refresh.
    const heavy = service.refreshNow();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(quotaFetchCount, 0, 'coalesced refresh without forceRescan does not poll quota');

    quotaValue = 0.4;
    const manual = service.refreshNow(true);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(quotaFetchCount, 1, 'manual refresh polls quota');

    // Quota must already be on screen although read() is still blocked.
    assert.ok(published.includes(0.4), 'quota published while heavy refresh is blocked');
    assert.strictEqual(service.getState().quota.pools.gemini.fiveHour?.remainingFraction, 0.4);

    // Drain every held read until both refreshes settle.
    let settled = false;
    const both = Promise.all([heavy, manual]).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 100 && !settled; i++) {
      readReleases.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await both;
    service.dispose();
  });
  it('11. an unreachable hub keeps the last good quota flagged stale', async () => {
    let online = true;
    let geminiPct = 85;
    const mockHubClient: any = {
      fetchQuota: async () => {
        const quota = createMockQuota(online ? 'online' : 'offline');
        quota.pools.gemini.fiveHour!.remainingPct = geminiPct;
        quota.pools.gemini.fiveHour!.remainingFraction = geminiPct / 100;
        return quota;
      },
      fetchTrajectories: async () => new Map(),
      fetchGeneratorMetadata: async () => [],
    };
    const service = new MonitorService({
      localReader: {
        read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }),
        flushCache: async () => {},
        clearMemoryCache: () => {},
      } as any,
      hubClient: mockHubClient,
      discoverEndpoints: async () => [{ port: 1, csrfToken: 't', host: '127.0.0.1', source: 'process' }],
      workspacePaths: ['/w'],
      timerFactory: {
        setTimeout: (fn: any, ms?: number) => setTimeout(fn, ms),
        clearTimeout: (id: any) => clearTimeout(id),
        setInterval: () => 1,
        clearInterval: () => {},
      },
      watchFactory: () => ({ close() {} }),
    });
    await service.start();
    await service.refreshQuotaNow();
    assert.strictEqual(service.getState().quota.pools.gemini.fiveHour?.remainingPct, 85);
    assert.ok(!service.getState().quota.isStale, 'a fresh online snapshot is not stale');

    online = false;
    await service.refreshQuotaNow();
    const q = service.getState().quota;
    assert.strictEqual(q.status, 'online', 'last good snapshot is kept');
    assert.strictEqual(q.isStale, true);
    assert.strictEqual(q.pools.gemini.fiveHour?.remainingPct, 85, 'numbers are not zeroed');

    // A consumer mutating the published snapshot must not poison the cached good one.
    q.pools.gemini.fiveHour!.remainingPct = 1;
    await service.refreshQuotaNow();
    assert.strictEqual(
      service.getState().quota.pools.gemini.fiveHour?.remainingPct,
      85,
      'last good snapshot is not shared with the published one',
    );

    // Recovery: a hub that answers again clears the flag and publishes current numbers.
    online = true;
    geminiPct = 40;
    await service.refreshQuotaNow();
    const recovered = service.getState().quota;
    assert.ok(!recovered.isStale, 'a recovered hub clears the stale flag');
    assert.strictEqual(recovered.pools.gemini.fiveHour?.remainingPct, 40, 'recovered numbers are current');
    service.dispose();
  });

  it('12. telemetry ignores a quota endpoint the latest discovery no longer lists', async () => {
    const first: HubEndpoint = { port: 41001, csrfToken: 'a', host: '127.0.0.1', source: 'exports' };
    const second: HubEndpoint = { port: 41002, csrfToken: 'b', host: '127.0.0.1', source: 'process' };
    let endpoints: HubEndpoint[] = [first, second];
    const catalogPorts: number[] = [];
    const mockHubClient: any = {
      fetchQuota: async (ep: HubEndpoint) => createMockQuota(ep.port === second.port ? 'online' : 'offline'),
      fetchTrajectories: async () => new Map(),
      fetchModelCatalog: async (ep: HubEndpoint) => {
        catalogPorts.push(ep.port);
        return [];
      },
      fetchGeneratorMetadata: async () => [],
    };

    const service = new MonitorService({
      localReader: {
        read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }),
        flushCache: async () => {},
        clearMemoryCache: () => {},
      } as any,
      hubClient: mockHubClient,
      discoverEndpoints: async () => endpoints,
      workspacePaths: ['/w'],
    });

    await service.refreshQuotaNow();
    endpoints = [first];
    await service.refreshNow();

    assert.deepStrictEqual(catalogPorts, [first.port], 'stale quota endpoint falls back to endpoints[0]');
    assert.strictEqual(service.getState().hubPort, first.port);
    service.dispose();
  });
});
