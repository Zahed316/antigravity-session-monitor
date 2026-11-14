import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFsPath,
  isWorkspaceMatch,
  extractArtifactCascadeId,
  resolveActiveSession,
} from '../src/core/sessionResolver.ts';
import { DEFAULT_CONTEXT_LIMIT, type SessionMetrics, type SessionNode } from '../src/types.ts';

function createMetrics(partial: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    fresh: partial.fresh ?? 10_000,
    cacheRead: partial.cacheRead ?? 10_000,
    output: partial.output ?? 500,
    thinking: partial.thinking ?? 300,
    response: partial.response ?? 200,
    calls: partial.calls ?? 1,
    compactions: partial.compactions ?? 0,
    isRunning: partial.isRunning ?? false,
  };
}

function createNode(partial: Partial<SessionNode> = {}): SessionNode {
  const metrics = partial.own ?? createMetrics();
  return {
    id: partial.id ?? 'conv-1',
    title: partial.title ?? 'Session',
    preview: partial.preview ?? 'Preview',
    model: partial.model ?? 'gemini-2.5-pro',
    status: partial.status ?? 'CASCADE_RUN_STATUS_IDLE',
    trajectoryType: partial.trajectoryType ?? 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    lastModifiedTime: partial.lastModifiedTime ?? 1763088000000,
    lastUserInputTime: partial.lastUserInputTime ?? null,
    workspaceUris: partial.workspaceUris ?? ['file:///home/user/project'],
    matchesWorkspace: partial.matchesWorkspace ?? true,
    branchName: partial.branchName,
    isSubagent: partial.isSubagent ?? false,
    parentId: partial.parentId ?? null,
    nestingDepth: partial.nestingDepth ?? 0,
    agentName: partial.agentName ?? '',
    subagentRole: partial.subagentRole ?? '',
    killed: partial.killed ?? false,
    notFullyIdle: partial.notFullyIdle ?? false,
    own: metrics,
    rolledUp: partial.rolledUp ?? metrics,
    contextUsed: partial.contextUsed ?? 20_000,
    contextLimit: partial.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
    contextPct: partial.contextPct ?? (20_000 / DEFAULT_CONTEXT_LIMIT) * 100,
    cacheVolumePct: partial.cacheVolumePct ?? 50,
    callHitPct: partial.callHitPct ?? 100,
    ownCacheVolumePct: partial.ownCacheVolumePct ?? 50,
    ownCallHitPct: partial.ownCallHitPct ?? 100,
    calls: partial.calls ?? [],
    children: partial.children ?? [],
    subagentCount: partial.subagentCount ?? 0,
    runningSubagentCount: partial.runningSubagentCount ?? 0,
    isPinned: partial.isPinned ?? false,
    isActive: partial.isActive ?? false,
    isSelected: partial.isSelected ?? false,
    dataSource: partial.dataSource ?? 'sqlite',
  };
}

test('normalizeFsPath handles POSIX, file:// URIs, percent-encoding, and Windows platforms', () => {
  assert.equal(normalizeFsPath('file:///home/u/proj', 'linux'), '/home/u/proj');
  assert.equal(normalizeFsPath('file:///home/u/my%20project/sub', 'linux'), '/home/u/my project/sub');
  assert.equal(normalizeFsPath('/home/u/proj/', 'linux'), '/home/u/proj');

  // Windows drive letters and case insensitivity
  assert.equal(normalizeFsPath('file:///C:/Repo/Sub', 'win32'), 'c:/repo/sub');
  assert.equal(normalizeFsPath('c:\\Repo\\Sub\\', 'win32'), 'c:/repo/sub');
});

test('isWorkspaceMatch matches exact and descendant paths, handles Windows casing, and rejects siblings', () => {
  // Exact match
  assert.equal(isWorkspaceMatch(['file:///home/u/proj'], ['/home/u/proj'], 'linux'), true);

  // Descendant session inside workspace
  assert.equal(isWorkspaceMatch(['file:///home/u/proj/sub/pkg'], ['/home/u/proj'], 'linux'), true);

  // Workspace subfolder matching session root
  assert.equal(isWorkspaceMatch(['file:///home/u/proj'], ['/home/u/proj/sub'], 'linux'), true);

  // Sibling paths must NEVER match
  assert.equal(isWorkspaceMatch(['file:///home/u/proj2'], ['/home/u/proj'], 'linux'), false);
  assert.equal(isWorkspaceMatch(['/home/u/proj-other'], ['/home/u/proj'], 'linux'), false);

  // Windows casing and slashes
  assert.equal(isWorkspaceMatch(['file:///C:/Repo/App'], ['c:\\repo'], 'win32'), true);
  assert.equal(isWorkspaceMatch(['c:/repo'], ['C:\\Repo\\Sub'], 'win32'), true);
  assert.equal(isWorkspaceMatch(['file:///C:/Repo2'], ['c:\\repo'], 'win32'), false);

  // Empty inputs
  assert.equal(isWorkspaceMatch([], ['/home/u/proj']), false);
  assert.equal(isWorkspaceMatch(['/home/u/proj'], []), false);
});

test('extractArtifactCascadeId extracts UUIDs from brain paths and jetski-artifact URIs', () => {
  const uuid = '0000677a-c5b7-404d-9330-7f1a856e5221';

  // Linux brain path
  assert.equal(
    extractArtifactCascadeId(`file:///home/u/.gemini/antigravity/brain/${uuid}/task.md`),
    uuid,
  );

  // Windows brain path
  assert.equal(
    extractArtifactCascadeId(`file:///C:/Users/u/.gemini/antigravity/brain/${uuid}/diagram.png`),
    uuid,
  );

  // jetski-artifact query param
  assert.equal(
    extractArtifactCascadeId(`jetski-artifact://view/?cascadeId=${uuid}`),
    uuid,
  );

  // jetski-artifact path segment
  assert.equal(
    extractArtifactCascadeId(`jetski-artifact://artifact/${uuid}/summary`),
    uuid,
  );

  // Irrelevant or invalid strings
  assert.equal(extractArtifactCascadeId('file:///home/u/project/src/index.ts'), null);
  assert.equal(extractArtifactCascadeId(''), null);
});

test('resolveActiveSession: pinned session wins even if idle or in another workspace or if child subagent', () => {
  const otherWsRoot = createNode({
    id: 'other-ws-root',
    matchesWorkspace: false,
    status: 'CASCADE_RUN_STATUS_IDLE',
  });
  const pinnedSubagent = createNode({
    id: 'sub-pin',
    parentId: 'other-ws-root',
    isSubagent: true,
    matchesWorkspace: false,
    status: 'CASCADE_RUN_STATUS_IDLE',
  });

  const runningWsRoot = createNode({
    id: 'running-root',
    matchesWorkspace: true,
    status: 'CASCADE_RUN_STATUS_RUNNING',
    own: createMetrics({ isRunning: true }),
    rolledUp: createMetrics({ isRunning: true }),
  });

  const roots = [runningWsRoot, otherWsRoot];
  const byId = new Map<string, SessionNode>([
    ['other-ws-root', otherWsRoot],
    ['sub-pin', pinnedSubagent],
    ['running-root', runningWsRoot],
  ]);

  const res = resolveActiveSession({
    roots,
    byId,
    pinnedId: 'sub-pin',
    scope: 'current',
    lastConversationId: 'running-root',
    artifactHintId: null,
  });

  assert.equal(res.pinMissing, false);
  assert.equal(res.active?.id, 'sub-pin');
});

test('Review Focus #5 (Missing pin): missing pinnedId flags pinMissing = true and falls back to auto resolution', () => {
  const runningWsRoot = createNode({
    id: 'running-root',
    matchesWorkspace: true,
    status: 'CASCADE_RUN_STATUS_RUNNING',
    own: createMetrics({ isRunning: true }),
    rolledUp: createMetrics({ isRunning: true }),
  });

  const roots = [runningWsRoot];
  const byId = new Map<string, SessionNode>([['running-root', runningWsRoot]]);

  const res = resolveActiveSession({
    roots,
    byId,
    pinnedId: 'non-existent-pin',
    scope: 'current',
    lastConversationId: null,
    artifactHintId: null,
  });

  assert.equal(res.pinMissing, true);
  assert.equal(res.active?.id, 'running-root');

  // Empty workspace with missing pin returns active: null and pinMissing: true
  const emptyRes = resolveActiveSession({
    roots: [],
    byId: new Map(),
    pinnedId: 'non-existent-pin',
    scope: 'current',
    lastConversationId: null,
    artifactHintId: null,
  });
  assert.equal(emptyRes.pinMissing, true);
  assert.equal(emptyRes.active, null);
});

test('resolveActiveSession priority: running (parent or non-killed child) > lastConversationId > artifactHintId > newest', () => {
  const childRunning = createNode({
    id: 'sub-running',
    parentId: 'parent-running',
    isSubagent: true,
    status: 'CASCADE_RUN_STATUS_RUNNING',
    own: createMetrics({ isRunning: true }),
    rolledUp: createMetrics({ isRunning: true }),
  });

  const parentWithRunningChild = createNode({
    id: 'parent-running',
    lastModifiedTime: 1000,
    matchesWorkspace: true,
    children: [childRunning],
    rolledUp: createMetrics({ isRunning: true }),
  });

  const recentIdleNode = createNode({
    id: 'recent-idle',
    lastModifiedTime: 9999, // newer lastModifiedTime
    matchesWorkspace: true,
  });

  const hintNode = createNode({
    id: 'hint-node',
    lastModifiedTime: 5000,
    matchesWorkspace: true,
  });

  const olderNode = createNode({
    id: 'older-node',
    lastModifiedTime: 3000,
    matchesWorkspace: true,
  });

  const roots = [parentWithRunningChild, recentIdleNode, hintNode, olderNode];
  const byId = new Map<string, SessionNode>([
    ['parent-running', parentWithRunningChild],
    ['sub-running', childRunning],
    ['recent-idle', recentIdleNode],
    ['hint-node', hintNode],
    ['older-node', olderNode],
  ]);

  // 1. Running session wins over more recently modified idle session
  const res1 = resolveActiveSession({
    roots,
    byId,
    pinnedId: null,
    scope: 'current',
    lastConversationId: 'recent-idle',
    artifactHintId: 'hint-node',
  });
  assert.equal(res1.active?.id, 'parent-running');

  // 2. When none are running: lastConversationId wins (even if pointing to a child subagent)
  parentWithRunningChild.rolledUp.isRunning = false;
  childRunning.rolledUp.isRunning = false;

  const res2 = resolveActiveSession({
    roots,
    byId,
    pinnedId: null,
    scope: 'current',
    lastConversationId: 'sub-running', // subagent whose parent is parent-running
    artifactHintId: 'hint-node',
  });
  assert.equal(res2.active?.id, 'parent-running');

  // 3. When lastConversationId is absent: artifactHintId wins
  const res3 = resolveActiveSession({
    roots,
    byId,
    pinnedId: null,
    scope: 'current',
    lastConversationId: null,
    artifactHintId: 'hint-node',
  });
  assert.equal(res3.active?.id, 'hint-node');

  // 4. When no hints: newest lastModifiedTime wins
  const res4 = resolveActiveSession({
    roots,
    byId,
    pinnedId: null,
    scope: 'current',
    lastConversationId: null,
    artifactHintId: null,
  });
  assert.equal(res4.active?.id, 'recent-idle');
});

test('resolveActiveSession: scope current filters out other workspaces, scope all includes them', () => {
  const currentWsNode = createNode({
    id: 'ws-node',
    matchesWorkspace: true,
    lastModifiedTime: 1000,
  });
  const otherWsNode = createNode({
    id: 'other-node',
    matchesWorkspace: false,
    lastModifiedTime: 2000, // Newer, but in another workspace
  });

  const roots = [currentWsNode, otherWsNode];
  const byId = new Map<string, SessionNode>([
    ['ws-node', currentWsNode],
    ['other-node', otherWsNode],
  ]);

  const resCurrent = resolveActiveSession({
    roots,
    byId,
    pinnedId: null,
    scope: 'current',
    lastConversationId: null,
    artifactHintId: null,
  });
  assert.equal(resCurrent.active?.id, 'ws-node');

  const resAll = resolveActiveSession({
    roots,
    byId,
    pinnedId: null,
    scope: 'all',
    lastConversationId: null,
    artifactHintId: null,
  });
  assert.equal(resAll.active?.id, 'other-node');
});
