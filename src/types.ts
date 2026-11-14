export const DEFAULT_CONTEXT_LIMIT = 256_000;

export type ScopeMode = 'current' | 'all';

export interface MonitorConfig {
  refreshIntervalMs: number;
  unfocusedRefreshIntervalMs: number;
  quotaRefreshIntervalMs: number;
  quotaUnfocusedMultiplier: number;
  autoFollowActiveSession: boolean;
  contextWarningPct: number;
  contextCriticalPct: number;
  defaultScope: ScopeMode;
  dataRootOverride: string;
}

export const DEFAULT_CONFIG: MonitorConfig = {
  refreshIntervalMs: 10_000,
  unfocusedRefreshIntervalMs: 30_000,
  quotaRefreshIntervalMs: 30_000,
  quotaUnfocusedMultiplier: 2,
  autoFollowActiveSession: true,
  contextWarningPct: 75,
  contextCriticalPct: 90,
  defaultScope: 'current',
  dataRootOverride: '',
};

export type PoolKey = 'gemini' | 'argon' | 'nonGoogle';

export interface ModelCatalogEntry {
  rawId: string;
  modelId: string;
  label: string;
  poolKey: PoolKey;
}

export interface WindowTokenEstimate {
  status: 'calibrated' | 'calibrating';
  estimatedTotalTokens: number | null;
  estimatedBilledTokens: number | null;
  tokensPerPctTotal: number | null;
  tokensPerPctBilled: number | null;
  windowUsedTotal: number;
  windowUsedBilled: number;
  sampleCount: number;
}

export interface ModelTokenEstimate {
  modelLabel: string;
  poolKey: PoolKey;
  fiveHour: WindowTokenEstimate | null;
  weekly: WindowTokenEstimate | null;
}

export interface QuotaWindow {
  window: '5h' | 'weekly';
  bucketId?: string;
  remainingPct: number;
  remainingFraction: number;
  resetTime: string | null;
  isReady: boolean;
  isExhausted: boolean;
}

export interface QuotaPool {
  key: PoolKey;
  displayName: string;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
}

export interface QuotaSnapshot {
  status: 'online' | 'offline' | 'error';
  source: 'summary' | 'userStatus' | 'none';
  pools: Record<PoolKey, QuotaPool>;
  fetchedAt: number;
  cooldownUntilMs?: number;
  rateLimited?: boolean;
  error?: string;
}

export interface TokenBreakdownGroup {
  name: string;
  tokens: number;
  pct?: number;
}

export interface TokenTotals {
  fresh: number;
  cacheRead: number;
  output: number;
  thinking: number;
  response: number;
  calls: number;
}

export interface SessionMetrics extends TokenTotals {
  compactions: number;
  isRunning: boolean;
}

export interface CallUsagePoint {
  idx: number;
  stepIndices: number[];
  model: string;
  rawModel?: string;
  fresh: number;
  cacheRead: number;
  output: number;
  thinking: number;
  response: number;
  effectiveContext: number;
  contextLimit: number;
  startStepIndex: number | null;
  isCompacted: boolean;
  compactedFromStep: number | null;
  tokenBreakdownGroups?: TokenBreakdownGroup[];
  apiProvider?: string;
  source?: 'sqlite' | 'rpc';
}

export interface RawConversationSummary {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: number;
  lastUserInputTime: number | null;
  workspaceUris: string[];
  status: string;
  trajectoryType?: string;
  parentConversationId: string;
  nestingDepth: number;
  agentName: string;
  subagentRole: string;
  killed: boolean;
  notFullyIdle: boolean;
  isUncataloged?: boolean;
}

export interface RpcWorkspaceInfo {
  workspaceFolderAbsoluteUri?: string;
  gitRootAbsoluteUri?: string;
  branchName?: string;
}

export interface RpcTrajectorySummary {
  cascadeId: string;
  trajectoryId?: string;
  stepCount: number;
  lastModifiedTime?: string;
  lastModifiedTimeMs?: number;
  createdTime?: string;
  status: string;
  trajectoryType: string;
  workspaces: RpcWorkspaceInfo[];
  annotations?: Record<string, unknown>;
  trajectoryMetadata?: Record<string, unknown>;
  summary?: string;
}

export interface RpcTokenBreakdownItem {
  name?: string;
  label?: string;
  category?: string;
  tokens?: number | string;
  tokenCount?: number | string;
}

export interface RpcContextWindowMetadata {
  estimatedTokensUsed?: number | string;
  maxContextTokens?: number | string;
  tokenBreakdown?: RpcTokenBreakdownItem[] | Record<string, number | string>;
}

export interface RpcChatStartMetadata {
  startStepIndex?: number | string;
  contextWindowMetadata?: RpcContextWindowMetadata;
}

export interface RpcChatModelUsage {
  model?: string;
  inputTokens?: number | string;
  outputTokens?: number | string;
  thinkingOutputTokens?: number | string;
  responseOutputTokens?: number | string;
  cacheReadTokens?: number | string;
  apiProvider?: string;
}

export interface RpcGeneratorCall {
  stepIndices?: number[];
  chatModel?: {
    model?: string;
    usage?: RpcChatModelUsage;
    chatStartMetadata?: RpcChatStartMetadata;
  };
}

export interface SessionNode {
  id: string;
  title: string;
  preview: string;
  model: string;
  rawModel?: string;
  status: string;
  trajectoryType: string;
  lastModifiedTime: number;
  lastUserInputTime: number | null;
  workspaceUris: string[];
  matchesWorkspace: boolean;
  branchName?: string;
  isSubagent: boolean;
  parentId: string | null;
  nestingDepth: number;
  agentName: string;
  subagentRole: string;
  killed: boolean;
  notFullyIdle: boolean;
  own: SessionMetrics;
  rolledUp: SessionMetrics;
  contextUsed: number;
  contextLimit: number;
  contextPct: number;
  cacheVolumePct: number;
  callHitPct: number;
  ownCacheVolumePct: number;
  ownCallHitPct: number;
  calls: CallUsagePoint[];
  children: SessionNode[];
  subagentCount: number;
  runningSubagentCount: number;
  isPinned: boolean;
  isActive: boolean;
  isSelected: boolean;
  dataSource: 'sqlite' | 'rpc' | 'hybrid';
}

export interface MonitorState {
  scope: ScopeMode;
  workspacePaths: string[];
  roots: SessionNode[];
  unattachedSubagents: SessionNode[];
  activeSession: SessionNode | null;
  selectedSession: SessionNode | null;
  pinnedSessionId: string | null;
  selectedSessionId: string | null;
  pinMissing: boolean;
  lastConversationId: string | null;
  artifactHintId: string | null;
  quota: QuotaSnapshot;
  modelCatalog?: ModelCatalogEntry[];
  modelEstimates?: ModelTokenEstimate[];
  hubStatus: 'connected' | 'offline' | 'discovering';
  hubPort: number | null;
  hubSource: 'exports' | 'process' | 'wsl-host' | null;
  sqliteBackend: 'node:sqlite' | 'sqlite3-cli' | 'python3' | 'unavailable';
  lastUpdatedAt: number;
  isRefreshing: boolean;
  lastError: string | null;
  warnings: string[];
}
