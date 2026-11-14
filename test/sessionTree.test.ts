import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionTree } from '../src/core/sessionTree.ts';
import {
  DEFAULT_CONTEXT_LIMIT,
  type CallUsagePoint,
  type RawConversationSummary,
  type RpcTrajectorySummary,
} from '../src/types.ts';

function createSummary(partial: Partial<RawConversationSummary> = {}): RawConversationSummary {
  return {
    conversationId: partial.conversationId ?? 'conv-1',
    title: partial.title ?? 'Test Session',
    preview: partial.preview ?? 'Preview text',
    stepCount: partial.stepCount ?? 1,
    lastModifiedTime: partial.lastModifiedTime ?? 1763088000000,
    lastUserInputTime: partial.lastUserInputTime ?? null,
    workspaceUris: partial.workspaceUris ?? ['file:///home/user/project'],
    status: partial.status ?? 'CASCADE_RUN_STATUS_IDLE',
    trajectoryType: partial.trajectoryType ?? 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    parentConversationId: partial.parentConversationId ?? '',
    nestingDepth: partial.nestingDepth ?? 0,
    agentName: partial.agentName ?? '',
    subagentRole: partial.subagentRole ?? '',
    killed: partial.killed ?? false,
    notFullyIdle: partial.notFullyIdle ?? false,
  };
}

function createCall(partial: Partial<CallUsagePoint> = {}): CallUsagePoint {
  return {
    idx: partial.idx ?? 0,
    stepIndices: partial.stepIndices ?? [1],
    model: partial.model ?? 'gemini-2.5-pro',
    fresh: partial.fresh ?? 10_000,
    cacheRead: partial.cacheRead ?? 20_000,
    output: partial.output ?? 500,
    thinking: partial.thinking ?? 300,
    response: partial.response ?? 200,
    effectiveContext: partial.effectiveContext ?? 30_000,
    contextLimit: partial.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
    startStepIndex: partial.startStepIndex ?? null,
    isCompacted: partial.isCompacted ?? false,
    compactedFromStep: partial.compactedFromStep ?? null,
    tokenBreakdownGroups: partial.tokenBreakdownGroups,
    apiProvider: partial.apiProvider,
    source: partial.source ?? 'sqlite',
  };
}

test('Review Focus #3: top-level sessions with agentName !== "" remain roots; subagents attach recursively', () => {
  const summaries: RawConversationSummary[] = [
    // Top-level session that has an agentName set (must NOT be treated as subagent)
    createSummary({
      conversationId: 'root-agent',
      title: 'Agent Staffer Root',
      agentName: 'staffer',
      parentConversationId: '',
      nestingDepth: 0,
    }),
    // Standard top-level session
    createSummary({
      conversationId: 'root-main',
      title: 'Main Chat',
      agentName: '',
      parentConversationId: '',
      nestingDepth: 0,
    }),
    // Subagent of root-main
    createSummary({
      conversationId: 'sub-1',
      title: 'Subagent 1',
      parentConversationId: 'root-main',
      nestingDepth: 1,
      agentName: 'researcher',
      subagentRole: 'Codebase Researcher',
    }),
    // Subagent of sub-1 (nested depth 2)
    createSummary({
      conversationId: 'sub-2',
      title: 'Subagent 2',
      parentConversationId: 'sub-1',
      nestingDepth: 2,
      agentName: 'tester',
      subagentRole: 'Unit Tester',
    }),
  ];

  const tree = buildSessionTree({
    summaries,
    localCalls: new Map(),
    workspacePaths: ['/home/user/project'],
  });

  assert.equal(tree.roots.length, 2);
  const rootAgent = tree.byId.get('root-agent')!;
  const rootMain = tree.byId.get('root-main')!;
  const sub1 = tree.byId.get('sub-1')!;
  const sub2 = tree.byId.get('sub-2')!;

  assert.ok(rootAgent);
  assert.equal(rootAgent.isSubagent, false);
  assert.equal(rootAgent.parentId, null);
  assert.equal(rootAgent.children.length, 0);

  assert.ok(rootMain);
  assert.equal(rootMain.isSubagent, false);
  assert.equal(rootMain.parentId, null);
  assert.equal(rootMain.children.length, 1);
  assert.equal(rootMain.children[0].id, 'sub-1');

  assert.ok(sub1);
  assert.equal(sub1.isSubagent, true);
  assert.equal(sub1.parentId, 'root-main');
  assert.equal(sub1.nestingDepth, 1);
  assert.equal(sub1.children.length, 1);
  assert.equal(sub1.children[0].id, 'sub-2');

  assert.ok(sub2);
  assert.equal(sub2.isSubagent, true);
  assert.equal(sub2.parentId, 'sub-1');
  assert.equal(sub2.nestingDepth, 2);
  assert.equal(sub2.children.length, 0);

  assert.equal(tree.unattachedSubagents.length, 0);
});

test('parent rollup vs own context: cumulative tokens sum recursively while context window stays parent-only', () => {
  const summaries: RawConversationSummary[] = [
    createSummary({
      conversationId: 'parent-1',
      title: 'Parent Session',
      parentConversationId: '',
      nestingDepth: 0,
      status: 'CASCADE_RUN_STATUS_IDLE',
    }),
    createSummary({
      conversationId: 'child-1',
      title: 'Child 1',
      parentConversationId: 'parent-1',
      nestingDepth: 1,
      status: 'CASCADE_RUN_STATUS_IDLE',
    }),
    createSummary({
      conversationId: 'child-2',
      title: 'Child 2',
      parentConversationId: 'child-1',
      nestingDepth: 2,
      status: 'CASCADE_RUN_STATUS_RUNNING',
      killed: false,
    }),
  ];

  const parentCalls: CallUsagePoint[] = [
    createCall({
      idx: 0,
      fresh: 30_000,
      cacheRead: 10_000,
      output: 1000,
      thinking: 600,
      response: 400,
      effectiveContext: 40_000,
      contextLimit: 256_000,
    }),
    createCall({
      idx: 1,
      fresh: 20_000,
      cacheRead: 40_000,
      output: 1000,
      thinking: 700,
      response: 300,
      effectiveContext: 60_000,
      contextLimit: 256_000,
      startStepIndex: 45, // 1 compaction on parent
    }),
  ];

  const child1Calls: CallUsagePoint[] = [
    createCall({
      idx: 0,
      fresh: 25_000,
      cacheRead: 15_000,
      output: 800,
      thinking: 500,
      response: 300,
      effectiveContext: 40_000,
      contextLimit: 256_000,
    }),
  ];

  const child2Calls: CallUsagePoint[] = [
    createCall({
      idx: 0,
      fresh: 15_000,
      cacheRead: 5_000,
      output: 400,
      thinking: 250,
      response: 150,
      effectiveContext: 20_000,
      contextLimit: 256_000,
    }),
  ];

  const localCalls = new Map<string, CallUsagePoint[]>([
    ['parent-1', parentCalls],
    ['child-1', child1Calls],
    ['child-2', child2Calls],
  ]);

  const tree = buildSessionTree({
    summaries,
    localCalls,
    workspacePaths: ['/home/user/project'],
  });

  const parent = tree.byId.get('parent-1')!;
  const child1 = tree.byId.get('child-1')!;
  const child2 = tree.byId.get('child-2')!;

  // Parent Own vs RolledUp
  assert.equal(parent.own.fresh, 50_000);
  assert.equal(parent.own.cacheRead, 50_000);
  assert.equal(parent.own.output, 2000);
  assert.equal(parent.own.thinking, 1300);
  assert.equal(parent.own.response, 700);
  assert.equal(parent.own.calls, 2);
  assert.equal(parent.own.compactions, 1);
  assert.equal(parent.own.isRunning, false);

  // RolledUp sums parent + child1 + child2:
  // fresh: 50k + 25k + 15k = 90k
  // cacheRead: 50k + 15k + 5k = 70k
  // output: 2000 + 800 + 400 = 3200
  // thinking: 1300 + 500 + 250 = 2050
  // response: 700 + 300 + 150 = 1150
  // calls: 2 + 1 + 1 = 4
  // compactions: 1 + 0 + 0 = 1
  assert.equal(parent.rolledUp.fresh, 90_000);
  assert.equal(parent.rolledUp.cacheRead, 70_000);
  assert.equal(parent.rolledUp.output, 3200);
  assert.equal(parent.rolledUp.thinking, 2050);
  assert.equal(parent.rolledUp.response, 1150);
  assert.equal(parent.rolledUp.calls, 4);
  assert.equal(parent.rolledUp.compactions, 1);
  assert.equal(parent.rolledUp.isRunning, true); // child2 is running

  // Parent Context: MUST stay parent-only (latest call 60k), NEVER summing child windows (not 120k!)
  assert.equal(parent.contextUsed, 60_000);
  assert.equal(parent.contextLimit, 256_000);
  assert.equal(parent.contextPct, (60_000 / 256_000) * 100);

  // Cache percentages:
  // own: cacheRead / (fresh + cacheRead) = 50k / 100k = 50%
  // rolledUp: 70k / (90k + 70k) = 70k / 160k = 43.75%
  assert.equal(parent.ownCacheVolumePct, 50);
  assert.equal(parent.cacheVolumePct, (70_000 / 160_000) * 100);

  // Subagent counts
  assert.equal(parent.subagentCount, 2);
  assert.equal(parent.runningSubagentCount, 1);

  // Children preserve separate independent contexts
  assert.equal(child1.contextUsed, 40_000);
  assert.equal(child1.subagentCount, 1);
  assert.equal(child1.runningSubagentCount, 1);
  assert.equal(child1.rolledUp.isRunning, true);

  assert.equal(child2.contextUsed, 20_000);
  assert.equal(child2.subagentCount, 0);
  assert.equal(child2.runningSubagentCount, 0);
  assert.equal(child2.own.isRunning, true);
});

test('killed subagents never mark isRunning = true', () => {
  const summaries: RawConversationSummary[] = [
    createSummary({
      conversationId: 'root-killed',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      killed: true, // killed root!
    }),
    createSummary({
      conversationId: 'sub-killed',
      parentConversationId: 'root-killed',
      nestingDepth: 1,
      status: 'CASCADE_RUN_STATUS_RUNNING',
      killed: true, // killed subagent!
    }),
  ];

  const tree = buildSessionTree({
    summaries,
    localCalls: new Map(),
    workspacePaths: ['/home/user/project'],
  });

  const root = tree.byId.get('root-killed')!;
  const sub = tree.byId.get('sub-killed')!;

  assert.equal(root.own.isRunning, false);
  assert.equal(root.rolledUp.isRunning, false);
  assert.equal(root.runningSubagentCount, 0);
  assert.equal(sub.own.isRunning, false);
  assert.equal(sub.rolledUp.isRunning, false);
});

test('excludes CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION from roots, unattached, and byId', () => {
  const summaries: RawConversationSummary[] = [
    createSummary({
      conversationId: 'side-question-1',
      trajectoryType: 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION',
    }),
    createSummary({
      conversationId: 'normal-cascade',
      trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    }),
  ];

  const rpcSummaries = new Map<string, RpcTrajectorySummary>([
    [
      'rpc-side-q',
      {
        cascadeId: 'rpc-side-q',
        stepCount: 1,
        status: 'CASCADE_RUN_STATUS_IDLE',
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION',
        workspaces: [],
      },
    ],
  ]);

  const tree = buildSessionTree({
    summaries,
    localCalls: new Map(),
    rpcSummaries,
    workspacePaths: ['/home/user/project'],
  });

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, 'normal-cascade');
  assert.equal(tree.byId.has('side-question-1'), false);
  assert.equal(tree.byId.has('rpc-side-q'), false);
});

test('Review Focus #5 (Orphan subagents): subagents with missing parent go into unattachedSubagents', () => {
  const summaries: RawConversationSummary[] = [
    createSummary({
      conversationId: 'orphan-1',
      title: 'Orphan Subagent',
      parentConversationId: 'missing-parent-id',
      nestingDepth: 1,
      agentName: 'subagent',
    }),
    createSummary({
      conversationId: 'orphan-child',
      title: 'Child of Orphan',
      parentConversationId: 'orphan-1',
      nestingDepth: 2,
    }),
  ];

  const tree = buildSessionTree({
    summaries,
    localCalls: new Map(),
    workspacePaths: ['/home/user/project'],
  });

  assert.equal(tree.roots.length, 0);
  assert.equal(tree.unattachedSubagents.length, 1);
  assert.equal(tree.unattachedSubagents[0].id, 'orphan-1');
  assert.equal(tree.unattachedSubagents[0].children.length, 1);
  assert.equal(tree.unattachedSubagents[0].children[0].id, 'orphan-child');
  assert.ok(tree.byId.has('orphan-1'));
  assert.ok(tree.byId.has('orphan-child'));
});

test('RPC summaries and calls override and append over local summaries and calls cleanly', () => {
  const summaries: RawConversationSummary[] = [
    createSummary({
      conversationId: 'hybrid-1',
      status: 'CASCADE_RUN_STATUS_IDLE',
      stepCount: 2,
      workspaceUris: ['file:///home/user/project'],
    }),
  ];

  const localCalls = new Map<string, CallUsagePoint[]>([
    [
      'hybrid-1',
      [
        createCall({ idx: 0, fresh: 10_000, cacheRead: 5_000, source: 'sqlite' }),
        createCall({ idx: 1, fresh: 12_000, cacheRead: 6_000, source: 'sqlite' }),
      ],
    ],
  ]);

  const rpcSummaries = new Map<string, RpcTrajectorySummary>([
    [
      'hybrid-1',
      {
        cascadeId: 'hybrid-1',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 3,
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
        workspaces: [
          {
            workspaceFolderAbsoluteUri: 'file:///home/user/project',
            branchName: 'feature/hybrid',
          },
        ],
      },
    ],
  ]);

  const rpcCalls = new Map<string, CallUsagePoint[]>([
    [
      'hybrid-1',
      [
        // RPC updates call 1 with breakdown groups and appends call 2
        createCall({
          idx: 1,
          fresh: 12_000,
          cacheRead: 6_000,
          source: 'rpc',
          tokenBreakdownGroups: [{ name: 'System', tokens: 18_000, pct: 100 }],
        }),
        createCall({ idx: 2, fresh: 8_000, cacheRead: 14_000, source: 'rpc' }),
      ],
    ],
  ]);

  const tree = buildSessionTree({
    summaries,
    localCalls,
    rpcSummaries,
    rpcCalls,
    workspacePaths: ['/home/user/project'],
  });

  const node = tree.byId.get('hybrid-1')!;
  assert.ok(node);
  assert.equal(node.status, 'CASCADE_RUN_STATUS_RUNNING');
  assert.equal(node.branchName, 'feature/hybrid');
  assert.equal(node.dataSource, 'hybrid');
  assert.equal(node.calls.length, 3);
  assert.equal(node.calls[0].source, 'sqlite');
  assert.equal(node.calls[1].source, 'rpc');
  assert.ok(node.calls[1].tokenBreakdownGroups);
  assert.equal(node.calls[2].source, 'rpc');
});
