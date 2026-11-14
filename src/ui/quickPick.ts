import type * as vscode from 'vscode';
import type { MonitorState, SessionNode } from '../types.ts';
import { formatCompactTokens } from './statusBar.ts';

export interface QuickPickButtonLike {
  id?: string;
  iconPath: any;
  tooltip?: string;
}

export interface QuickPickEntry {
  label: string;
  description?: string;
  detail?: string;
  action?: 'unpin' | 'toggleScope' | 'session';
  sessionId?: string;
  depth?: number;
  buttons?: QuickPickButtonLike[];
  alwaysShow?: boolean;
}

export interface QuickPickCallbacks {
  onInspect: (sessionId: string) => void;
  onPin: (sessionId: string) => void;
  onUnpin: () => void;
  onToggleScope: () => void;
}

export interface QuickPickInstanceLike<T extends QuickPickEntry = QuickPickEntry> {
  title: string;
  placeholder: string;
  items: T[];
  selectedItems: readonly T[];
  onDidAccept(listener: () => void): { dispose(): void };
  onDidTriggerItemButton(listener: (e: { button: QuickPickButtonLike; item: T }) => void): { dispose(): void };
  onDidHide(listener: () => void): { dispose(): void };
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface QuickPickVscodeLike {
  window: {
    createQuickPick<T extends QuickPickEntry>(): QuickPickInstanceLike<T>;
  };
}

export function buildQuickPickItems(state: MonitorState): QuickPickEntry[] {
  const items: QuickPickEntry[] = [];

  // 1. Unpin action entry (top of list when pinned)
  if (state.pinnedSessionId !== null) {
    items.push({
      label: '$(pin) Unpin Session (Switch to Auto-Track)',
      description: state.pinMissing ? 'Pinned session is missing — click to unpin' : `Currently pinned: ${state.pinnedSessionId}`,
      action: 'unpin',
      alwaysShow: true,
    });
  }

  // 2. Scope toggle entry
  const isCurrent = state.scope === 'current';
  items.push({
    label: isCurrent ? '$(eye) Scope: Current Workspace' : '$(globe) Scope: All Workspaces',
    description: isCurrent ? 'Click to show all workspaces' : 'Click to filter to current workspace',
    action: 'toggleScope',
    alwaysShow: true,
  });

  // 3. Filter root sessions based on scope
  let roots = isCurrent ? state.roots.filter((r) => r.matchesWorkspace) : [...state.roots];

  // If a pinned session exists, ensure it is included even if scope would filter it
  if (state.pinnedSessionId !== null && !state.pinMissing) {
    const pinnedRoot = state.roots.find((r) => r.id === state.pinnedSessionId);
    if (pinnedRoot && !roots.some((r) => r.id === pinnedRoot.id)) {
      roots.unshift(pinnedRoot);
    }
  }

  function addNodeRecursive(node: SessionNode, depth: number): void {
    let prefix = '';
    if (depth > 0) {
      prefix = `${'  '.repeat(depth - 1)}↳ `;
      const role = node.subagentRole || node.agentName || 'Subagent';
      prefix += `[${role}] `;
    }

    const iconParts: string[] = [];
    if (node.isPinned || node.id === state.pinnedSessionId) {
      iconParts.push('$(pin)');
    }
    if (node.rolledUp.isRunning || node.own.isRunning) {
      iconParts.push('$(sync~spin)');
    }
    const iconPrefix = iconParts.length > 0 ? `${iconParts.join(' ')} ` : '';

    const title = node.title || node.preview || (node.isSubagent ? 'Subagent' : 'Untitled Session');
    const label = `${prefix}${iconPrefix}${title}`;

    const usedStr = formatCompactTokens(node.contextUsed);
    const limitStr = formatCompactTokens(node.contextLimit);
    const pctStr = `${Math.round(node.contextPct)}%`;
    const cacheStr = `C:${Math.round(node.cacheVolumePct)}%`;
    const subCountStr = depth === 0 && node.subagentCount > 0 ? ` · (${node.subagentCount} subagent${node.subagentCount === 1 ? '' : 's'})` : '';

    const description = `${usedStr}/${limitStr} (${pctStr}) · ${cacheStr}${subCountStr}`;

    const freshStr = formatCompactTokens(node.rolledUp.fresh);
    const cacheReadStr = formatCompactTokens(node.rolledUp.cacheRead);
    const outStr = formatCompactTokens(node.rolledUp.output);
    const detail = `Fresh: ${freshStr} · Cache: ${cacheReadStr} · Output: ${outStr} · ${node.rolledUp.calls} calls · ${node.rolledUp.compactions} compactions`;

    const isPinned = node.isPinned || node.id === state.pinnedSessionId;
    const buttons: QuickPickButtonLike[] = [
      {
        id: 'pin',
        iconPath: { id: 'pin' },
        tooltip: isPinned ? 'Unpin from Status Bar' : 'Pin to Status Bar',
      },
      {
        id: 'inspect',
        iconPath: { id: 'layout-panel' },
        tooltip: 'Open in Bottom Panel',
      },
    ];

    items.push({
      label,
      description,
      detail,
      action: 'session',
      sessionId: node.id,
      depth,
      buttons,
    });

    for (const child of node.children) {
      addNodeRecursive(child, depth + 1);
    }
  }

  for (const root of roots) {
    addNodeRecursive(root, 0);
  }

  if (state.unattachedSubagents && state.unattachedSubagents.length > 0) {
    for (const orphan of state.unattachedSubagents) {
      addNodeRecursive(orphan, 1);
    }
  }

  return items;
}

export async function showSessionQuickPick(
  vscodeApi: QuickPickVscodeLike,
  state: MonitorState,
  callbacks: QuickPickCallbacks,
): Promise<void> {
  const qp = vscodeApi.window.createQuickPick<QuickPickEntry>();
  qp.title = 'Antigravity Session Monitor';
  qp.placeholder = 'Select a session to inspect, or pin to Status Bar';
  qp.items = buildQuickPickItems(state);

  const disposables: Array<{ dispose(): void }> = [];

  disposables.push(
    qp.onDidTriggerItemButton((e) => {
      if (e.button.id === 'pin' || (e.button.tooltip && e.button.tooltip.includes('Pin'))) {
        const isCurrentlyPinned = e.item.sessionId === state.pinnedSessionId;
        if (isCurrentlyPinned) {
          callbacks.onUnpin();
        } else if (e.item.sessionId) {
          callbacks.onPin(e.item.sessionId);
        }
        qp.hide();
      } else if (e.button.id === 'inspect' || (e.button.tooltip && e.button.tooltip.includes('Panel'))) {
        if (e.item.sessionId) {
          callbacks.onInspect(e.item.sessionId);
        }
        qp.hide();
      }
    }),
  );

  disposables.push(
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected) {
        if (selected.action === 'unpin') {
          callbacks.onUnpin();
        } else if (selected.action === 'toggleScope') {
          callbacks.onToggleScope();
        } else if (selected.sessionId) {
          // Inspect in bottom panel WITHOUT changing status bar auto-tracking
          callbacks.onInspect(selected.sessionId);
        }
      }
      qp.hide();
    }),
  );

  disposables.push(
    qp.onDidHide(() => {
      for (const d of disposables) {
        d.dispose();
      }
      qp.dispose();
    }),
  );

  qp.show();
}
