import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_CONFIG,
  type PoolKey,
  type QuotaWindow,
  type QuotaPool,
  type QuotaSnapshot,
  type TokenBreakdownGroup,
  type TokenTotals,
  type SessionMetrics,
  type CallUsagePoint,
  type RawConversationSummary,
  type RpcWorkspaceInfo,
  type RpcTrajectorySummary,
  type RpcGeneratorCall,
  type SessionNode,
  type ScopeMode,
  type MonitorConfig,
  type MonitorState,
} from '../src/types.ts';

test('default constants match spec constraints', () => {
  assert.equal(DEFAULT_CONTEXT_LIMIT, 256_000);
  assert.equal(DEFAULT_CONFIG.defaultScope, 'current');
  assert.equal(DEFAULT_CONFIG.refreshIntervalMs, 10_000);
  assert.equal(DEFAULT_CONFIG.unfocusedRefreshIntervalMs, 30_000);
  assert.equal(DEFAULT_CONFIG.quotaRefreshIntervalMs, 30_000);
  assert.equal(DEFAULT_CONFIG.quotaUnfocusedMultiplier, 2);
  assert.equal(DEFAULT_CONFIG.autoFollowActiveSession, true);
  assert.equal(DEFAULT_CONFIG.contextWarningPct, 75);
  assert.equal(DEFAULT_CONFIG.contextCriticalPct, 90);
  assert.equal(DEFAULT_CONFIG.dataRootOverride, '');
});

test('domain types compose cleanly for quota, telemetry, RPC, and state', () => {
  const scope: ScopeMode = 'current';
  const poolKey: PoolKey = 'gemini';
  const config: MonitorConfig = { ...DEFAULT_CONFIG, defaultScope: scope };

  const fiveHour: QuotaWindow = {
    window: '5h',
    bucketId: 'gemini-5h',
    remainingPct: 80,
    remainingFraction: 0.8,
    resetTime: '2026-11-14T05:00:00Z',
    isReady: false,
    isExhausted: false,
  };

  const geminiPool: QuotaPool = {
    key: poolKey,
    displayName: 'Gemini',
    fiveHour,
    weekly: null,
  };

  const nonGooglePool: QuotaPool = {
    key: 'nonGoogle',
    displayName: 'Claude / 3P',
    fiveHour: null,
    weekly: null,
  };

  const quota: QuotaSnapshot = {
    status: 'online',
    source: 'summary',
    pools: {
      gemini: geminiPool,
      nonGoogle: nonGooglePool,
    },
    fetchedAt: 1763088000000,
    cooldownUntilMs: 1763088060000,
    rateLimited: false,
  };

  const breakdown: TokenBreakdownGroup[] = [
    { name: 'System', tokens: 4000, pct: 3.0 },
    { name: 'History', tokens: 120000, pct: 97.0 },
  ];

  const callPoint: CallUsagePoint = {
    idx: 0,
    stepIndices: [1, 2],
    model: 'gemini-2.5-pro',
    fresh: 10_000,
    cacheRead: 120_000,
    output: 500,
    thinking: 300,
    response: 200,
    effectiveContext: 130_000,
    contextLimit: DEFAULT_CONTEXT_LIMIT,
    startStepIndex: null,
    isCompacted: false,
    compactedFromStep: null,
    tokenBreakdownGroups: breakdown,
  };

  const totals: TokenTotals = {
    fresh: 10_000,
    cacheRead: 120_000,
    output: 500,
    thinking: 300,
    response: 200,
    calls: 1,
  };

  const metrics: SessionMetrics = {
    ...totals,
    compactions: 0,
    isRunning: false,
  };

  const rawSummary: RawConversationSummary = {
    conversationId: 'conv-1',
    title: 'Sample Session',
    preview: 'Inspect workspace',
    stepCount: 2,
    lastModifiedTime: 1763088000000,
    lastUserInputTime: 1763087990000,
    workspaceUris: ['file:///home/user/repo'],
    status: 'CASCADE_RUN_STATUS_IDLE',
    parentConversationId: '',
    nestingDepth: 0,
    agentName: '',
    subagentRole: '',
    killed: false,
    notFullyIdle: false,
  };

  const rpcWs: RpcWorkspaceInfo = {
    workspaceFolderAbsoluteUri: 'file:///home/user/repo',
    gitRootAbsoluteUri: 'file:///home/user/repo',
    branchName: 'main',
  };

  const rpcSummary: RpcTrajectorySummary = {
    cascadeId: 'conv-1',
    trajectoryId: 'traj-1',
    stepCount: 2,
    lastModifiedTime: '2026-11-14T02:00:00Z',
    status: 'CASCADE_RUN_STATUS_IDLE',
    trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    workspaces: [rpcWs],
  };

  const rpcCall: RpcGeneratorCall = {
    stepIndices: [1, 2],
    chatModel: {
      model: 'gemini-2.5-pro',
      usage: {
        model: 'gemini-2.5-pro',
        inputTokens: 10_000,
        cacheReadTokens: 120_000,
        outputTokens: 500,
        thinkingOutputTokens: 300,
        responseOutputTokens: 200,
        apiProvider: 'google',
      },
      chatStartMetadata: {
        contextWindowMetadata: {
          estimatedTokensUsed: 130_000,
          maxContextTokens: DEFAULT_CONTEXT_LIMIT,
        },
      },
    },
  };

  const node: SessionNode = {
    id: 'conv-1',
    title: 'Sample Session',
    preview: 'Inspect workspace',
    model: 'gemini-2.5-pro',
    status: 'CASCADE_RUN_STATUS_IDLE',
    trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    lastModifiedTime: 1763088000000,
    lastUserInputTime: 1763087990000,
    workspaceUris: ['file:///home/user/repo'],
    matchesWorkspace: true,
    branchName: 'main',
    isSubagent: false,
    parentId: null,
    nestingDepth: 0,
    agentName: '',
    subagentRole: '',
    killed: false,
    notFullyIdle: false,
    own: metrics,
    rolledUp: metrics,
    contextUsed: 130_000,
    contextLimit: DEFAULT_CONTEXT_LIMIT,
    contextPct: (130_000 / DEFAULT_CONTEXT_LIMIT) * 100,
    cacheVolumePct: (120_000 / 130_000) * 100,
    callHitPct: 100,
    ownCacheVolumePct: (120_000 / 130_000) * 100,
    ownCallHitPct: 100,
    calls: [callPoint],
    children: [],
    subagentCount: 0,
    runningSubagentCount: 0,
    isPinned: false,
    isActive: true,
    isSelected: true,
    dataSource: 'hybrid',
  };

  const state: MonitorState = {
    scope: config.defaultScope,
    workspacePaths: ['/home/user/repo'],
    roots: [node],
    unattachedSubagents: [],
    activeSession: node,
    selectedSession: node,
    pinnedSessionId: null,
    selectedSessionId: 'conv-1',
    pinMissing: false,
    lastConversationId: 'conv-1',
    artifactHintId: null,
    quota,
    hubStatus: 'connected',
    hubPort: 41234,
    hubSource: 'exports',
    sqliteBackend: 'node:sqlite',
    lastUpdatedAt: 1763088000000,
    isRefreshing: false,
    lastError: null,
    warnings: [],
  };

  assert.equal(rawSummary.conversationId, rpcSummary.cascadeId);
  assert.equal(rpcCall.chatModel?.usage?.inputTokens, 10_000);
  assert.equal(state.activeSession?.contextLimit, 256_000);
  assert.equal(state.quota.pools.gemini.fiveHour?.remainingPct, 80);
  assert.equal(state.quota.cooldownUntilMs, 1763088060000);
  assert.equal(state.quota.rateLimited, false);
});
