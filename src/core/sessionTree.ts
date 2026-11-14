import { DEFAULT_CONTEXT_LIMIT, type CallUsagePoint, type RawConversationSummary, type RpcTrajectorySummary, type SessionMetrics, type SessionNode } from '../types.ts';
import { annotateCompactions } from './compaction.ts';
import { isWorkspaceMatch } from './sessionResolver.ts';

const CORTEX_SIDE_QUESTION = 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION';
const CASCADE_RUNNING = 'CASCADE_RUN_STATUS_RUNNING';

interface SessionIntermediate {
  id: string;
  title: string;
  preview: string;
  status: string;
  stepCount: number;
  lastModifiedTime: number;
  lastUserInputTime: number | null;
  workspaceUris: string[];
  branchName?: string;
  trajectoryType: string;
  isSubagent: boolean;
  parentId: string | null;
  nestingDepth: number;
  agentName: string;
  subagentRole: string;
  killed: boolean;
  notFullyIdle: boolean;
}

interface RollupAccumulator {
  metrics: SessionMetrics;
  callsWithCacheHit: number;
  subagentCount: number;
  runningSubagentCount: number;
}

function rollupNode(node: SessionNode): RollupAccumulator {
  let fresh = node.own.fresh;
  let cacheRead = node.own.cacheRead;
  let output = node.own.output;
  let thinking = node.own.thinking;
  let response = node.own.response;
  let calls = node.own.calls;
  let compactions = node.own.compactions;
  let isRunning = node.own.isRunning;

  let callsWithCacheHit = 0;
  for (const c of node.calls) {
    if (c.cacheRead > 0) {
      callsWithCacheHit++;
    }
  }

  let totalSubagentCount = 0;
  let totalRunningSubagentCount = 0;

  // Sort children by lastModifiedTime descending
  node.children.sort((a, b) => b.lastModifiedTime - a.lastModifiedTime);

  for (const child of node.children) {
    const childRollup = rollupNode(child);
    fresh += childRollup.metrics.fresh;
    cacheRead += childRollup.metrics.cacheRead;
    output += childRollup.metrics.output;
    thinking += childRollup.metrics.thinking;
    response += childRollup.metrics.response;
    calls += childRollup.metrics.calls;
    compactions += childRollup.metrics.compactions;

    if (childRollup.metrics.isRunning) {
      isRunning = true;
    }

    callsWithCacheHit += childRollup.callsWithCacheHit;
    totalSubagentCount += 1 + childRollup.subagentCount;

    if (child.own.isRunning) {
      totalRunningSubagentCount += 1;
    }
    totalRunningSubagentCount += childRollup.runningSubagentCount;
  }

  const rolledUpMetrics: SessionMetrics = {
    fresh,
    cacheRead,
    output,
    thinking,
    response,
    calls,
    compactions,
    isRunning,
  };

  const totalTokens = fresh + cacheRead;
  const cacheVolumePct = totalTokens > 0 ? (cacheRead / totalTokens) * 100 : 0;
  const callHitPct = calls > 0 ? (callsWithCacheHit / calls) * 100 : 0;

  node.rolledUp = rolledUpMetrics;
  node.cacheVolumePct = cacheVolumePct;
  node.callHitPct = callHitPct;
  node.subagentCount = totalSubagentCount;
  node.runningSubagentCount = totalRunningSubagentCount;

  return {
    metrics: rolledUpMetrics,
    callsWithCacheHit,
    subagentCount: totalSubagentCount,
    runningSubagentCount: totalRunningSubagentCount,
  };
}

/**
 * Builds the session tree with recursive subagent rollup and orphan resolution.
 *
 * Rules:
 * - Subagents are identified strictly by `parentConversationId !== "" || nestingDepth > 0`.
 *   Top-level sessions with `agentName !== ""` (`parentConversationId === "" && nestingDepth === 0`)
 *   MUST remain top-level roots.
 * - Excludes `CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION`.
 * - Parent's `contextUsed / contextLimit / contextPct` stays parent-only (latest call), never
 *   summing child context windows.
 * - Parent's `rolledUp` recursively sums fresh, cacheRead, output, thinking, response, calls,
 *   compactions, and marks `isRunning = true` if any non-killed descendant is running.
 * - Killed sessions/subagents (`killed === true`) never set `isRunning = true`.
 * - Orphan subagents whose parent is absent from `byId` are placed in `unattachedSubagents`.
 * - RPC generatorMetadata overrides/appends over SQLite gen_metadata cleanly.
 */
export function buildSessionTree(params: {
  summaries: RawConversationSummary[];
  localCalls: Map<string, CallUsagePoint[]>;
  rpcSummaries?: Map<string, RpcTrajectorySummary> | null;
  rpcCalls?: Map<string, CallUsagePoint[]>;
  workspacePaths: string[];
}): {
  roots: SessionNode[];
  unattachedSubagents: SessionNode[];
  byId: Map<string, SessionNode>;
} {
  const { summaries, localCalls, rpcSummaries, rpcCalls, workspacePaths } = params;

  const intermediateMap = new Map<string, SessionIntermediate>();

  // 1. Process local summaries
  for (const s of summaries) {
    const rpc = rpcSummaries?.get(s.conversationId);

    const trajectoryType = rpc?.trajectoryType || s.trajectoryType || 'CORTEX_TRAJECTORY_TYPE_CASCADE';
    if (trajectoryType === CORTEX_SIDE_QUESTION) {
      continue;
    }

    const rpcMtime = rpc?.lastModifiedTimeMs ?? (rpc?.lastModifiedTime ? Date.parse(rpc.lastModifiedTime) : 0);
    const lastModifiedTime = Math.max(s.lastModifiedTime, !Number.isNaN(rpcMtime) ? rpcMtime : 0);

    const status = rpc?.status && rpc.status.trim() !== '' ? rpc.status : s.status;
    const stepCount = rpc ? Math.max(s.stepCount, rpc.stepCount) : s.stepCount;

    const wsSet = new Set<string>(s.workspaceUris);
    if (rpc?.workspaces) {
      for (const w of rpc.workspaces) {
        if (w.workspaceFolderAbsoluteUri) {
          wsSet.add(w.workspaceFolderAbsoluteUri);
        }
        if (w.gitRootAbsoluteUri) {
          wsSet.add(w.gitRootAbsoluteUri);
        }
      }
    }

    const branchName = rpc?.workspaces?.find((w) => Boolean(w.branchName))?.branchName;

    // Review Focus #3: Strictly identified by parentConversationId !== "" || nestingDepth > 0
    const isSubagent = Boolean(s.parentConversationId && s.parentConversationId.trim() !== '') || s.nestingDepth > 0;
    const parentId = isSubagent && s.parentConversationId.trim() !== '' ? s.parentConversationId : null;

    intermediateMap.set(s.conversationId, {
      id: s.conversationId,
      title: s.title || (rpc?.summary ? rpc.summary : s.conversationId),
      preview: s.preview || rpc?.summary || '',
      status,
      stepCount,
      lastModifiedTime,
      lastUserInputTime: s.lastUserInputTime,
      workspaceUris: Array.from(wsSet),
      branchName,
      trajectoryType,
      isSubagent,
      parentId,
      nestingDepth: s.nestingDepth,
      agentName: s.agentName,
      subagentRole: s.subagentRole,
      killed: Boolean(s.killed),
      notFullyIdle: Boolean(s.notFullyIdle),
    });
  }

  // 2. Add RPC-only trajectories not present in local summaries
  if (rpcSummaries) {
    for (const [cascadeId, rpc] of rpcSummaries.entries()) {
      if (intermediateMap.has(cascadeId)) {
        continue;
      }
      if (rpc.trajectoryType === CORTEX_SIDE_QUESTION) {
        continue;
      }

      const rpcMtime = rpc.lastModifiedTimeMs ?? (rpc.lastModifiedTime ? Date.parse(rpc.lastModifiedTime) : Date.now());
      const wsList: string[] = [];
      if (rpc.workspaces) {
        for (const w of rpc.workspaces) {
          if (w.workspaceFolderAbsoluteUri) {
            wsList.push(w.workspaceFolderAbsoluteUri);
          }
          if (w.gitRootAbsoluteUri) {
            wsList.push(w.gitRootAbsoluteUri);
          }
        }
      }

      const branchName = rpc.workspaces?.find((w) => Boolean(w.branchName))?.branchName;

      intermediateMap.set(cascadeId, {
        id: cascadeId,
        title: rpc.summary || cascadeId,
        preview: rpc.summary || '',
        status: rpc.status || 'CASCADE_RUN_STATUS_IDLE',
        stepCount: rpc.stepCount || 0,
        lastModifiedTime: !Number.isNaN(rpcMtime) ? rpcMtime : Date.now(),
        lastUserInputTime: null,
        workspaceUris: wsList,
        branchName,
        trajectoryType: rpc.trajectoryType || 'CORTEX_TRAJECTORY_TYPE_CASCADE',
        isSubagent: false,
        parentId: null,
        nestingDepth: 0,
        agentName: '',
        subagentRole: '',
        killed: false,
        notFullyIdle: false,
      });
    }
  }

  // 3. Construct SessionNode objects
  const byId = new Map<string, SessionNode>();

  for (const item of intermediateMap.values()) {
    const local = localCalls.get(item.id) || [];
    const rpc = rpcCalls?.get(item.id) || [];

    let dataSource: 'sqlite' | 'rpc' | 'hybrid' = 'sqlite';
    if (rpc.length > 0 && local.length > 0) {
      dataSource = 'hybrid';
    } else if (rpc.length > 0) {
      dataSource = 'rpc';
    } else if (rpcSummaries?.has(item.id)) {
      dataSource = 'rpc';
    }

    // Merge calls: index map where RPC overrides matching index and appends newer indices
    const mergedCallsMap = new Map<number, CallUsagePoint>();
    for (const c of local) {
      mergedCallsMap.set(c.idx, c);
    }
    for (const c of rpc) {
      mergedCallsMap.set(c.idx, c);
    }

    const rawCalls = Array.from(mergedCallsMap.values()).sort((a, b) => a.idx - b.idx);
    const { calls: annotatedCalls, compactionCount } = annotateCompactions(rawCalls);

    let fresh = 0;
    let cacheRead = 0;
    let output = 0;
    let thinking = 0;
    let response = 0;
    let callsWithCacheHit = 0;

    for (const c of annotatedCalls) {
      fresh += c.fresh;
      cacheRead += c.cacheRead;
      output += c.output;
      thinking += c.thinking;
      response += c.response;
      if (c.cacheRead > 0) {
        callsWithCacheHit++;
      }
    }

    const callsCount = annotatedCalls.length;
    // Killed sessions/subagents NEVER set isRunning = true
    const ownIsRunning = item.status === CASCADE_RUNNING && !item.killed;

    const ownMetrics: SessionMetrics = {
      fresh,
      cacheRead,
      output,
      thinking,
      response,
      calls: callsCount,
      compactions: compactionCount,
      isRunning: ownIsRunning,
    };

    const ownTotalTokens = fresh + cacheRead;
    const ownCacheVolumePct = ownTotalTokens > 0 ? (cacheRead / ownTotalTokens) * 100 : 0;
    const ownCallHitPct = callsCount > 0 ? (callsWithCacheHit / callsCount) * 100 : 0;

    let contextUsed = 0;
    let contextLimit = DEFAULT_CONTEXT_LIMIT;
    let model = 'unknown';

    if (annotatedCalls.length > 0) {
      const lastCall = annotatedCalls[annotatedCalls.length - 1];
      contextUsed = lastCall.effectiveContext;
      contextLimit = lastCall.contextLimit > 0 ? lastCall.contextLimit : DEFAULT_CONTEXT_LIMIT;
      model = lastCall.model || 'unknown';
    }
    const contextPct = contextLimit > 0 ? (contextUsed / contextLimit) * 100 : 0;

    const node: SessionNode = {
      id: item.id,
      title: item.title,
      preview: item.preview,
      model,
      status: item.status,
      trajectoryType: item.trajectoryType,
      lastModifiedTime: item.lastModifiedTime,
      lastUserInputTime: item.lastUserInputTime,
      workspaceUris: item.workspaceUris,
      matchesWorkspace: isWorkspaceMatch(item.workspaceUris, workspacePaths),
      branchName: item.branchName,
      isSubagent: item.isSubagent,
      parentId: item.parentId,
      nestingDepth: item.nestingDepth,
      agentName: item.agentName,
      subagentRole: item.subagentRole,
      killed: item.killed,
      notFullyIdle: item.notFullyIdle,
      own: ownMetrics,
      rolledUp: { ...ownMetrics },
      contextUsed,
      contextLimit,
      contextPct,
      cacheVolumePct: ownCacheVolumePct,
      callHitPct: ownCallHitPct,
      ownCacheVolumePct,
      ownCallHitPct,
      calls: annotatedCalls,
      children: [],
      subagentCount: 0,
      runningSubagentCount: 0,
      isPinned: false,
      isActive: false,
      isSelected: false,
      dataSource,
    };

    byId.set(node.id, node);
  }

  // 4. Assemble tree hierarchy
  const roots: SessionNode[] = [];
  const unattachedSubagents: SessionNode[] = [];

  // Sort candidate subagents by nestingDepth ascending to attach parents before children
  const nodes = Array.from(byId.values());
  const subagents = nodes.filter((n) => n.isSubagent).sort((a, b) => a.nestingDepth - b.nestingDepth);

  for (const node of nodes) {
    if (!node.isSubagent) {
      roots.push(node);
    }
  }

  for (const sub of subagents) {
    if (sub.parentId && byId.has(sub.parentId)) {
      const parent = byId.get(sub.parentId)!;
      parent.children.push(sub);
    } else {
      // Review Focus #5: Orphan subagents whose parent is absent go to unattachedSubagents
      unattachedSubagents.push(sub);
    }
  }

  // 5. Recursive rollup
  roots.sort((a, b) => b.lastModifiedTime - a.lastModifiedTime);
  for (const root of roots) {
    rollupNode(root);
  }

  unattachedSubagents.sort((a, b) => b.lastModifiedTime - a.lastModifiedTime);
  for (const orphan of unattachedSubagents) {
    rollupNode(orphan);
  }

  return { roots, unattachedSubagents, byId };
}
