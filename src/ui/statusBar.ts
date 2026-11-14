import type * as vscode from 'vscode';
import type { MonitorConfig, MonitorState, QuotaWindow, SessionNode } from '../types.ts';

export interface StatusBarItemLike {
  text: string;
  tooltip: string | { value: string; isTrusted?: boolean; supportThemeIcons?: boolean };
  command?: string;
  backgroundColor?: { id: string } | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface StatusBarVscodeLike {
  window: {
    createStatusBarItem(alignment?: any, priority?: number): StatusBarItemLike;
  };
  ThemeColor: new (id: string) => { id: string };
  MarkdownString: new (value?: string) => { value: string; isTrusted?: boolean; supportThemeIcons?: boolean; appendMarkdown?(value: string): any };
  StatusBarAlignment?: { Left: number; Right: number };
}

export interface StatusBarViewModel {
  contextText: string;
  contextColor: 'normal' | 'warning' | 'error';
  quotaText: string;
  quotaColor: 'normal' | 'warning' | 'error';
  tooltipMarkdown: string;
}

export interface StatusBarController {
  readonly contextItem: StatusBarItemLike;
  readonly quotaItem: StatusBarItemLike;
  update(state: MonitorState, config: MonitorConfig): void;
  dispose(): void;
}

export function formatCompactTokens(n: number): string {
  if (!n || n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 1_000) {
    return `${sign}${Math.round(abs)}`;
  }
  if (abs < 1_000_000) {
    const k = abs / 1_000;
    const formatted = k >= 100 ? Math.round(k).toString() : (Math.round(k * 10) / 10).toString();
    return `${sign}${formatted}k`;
  }
  const m = abs / 1_000_000;
  const formatted = m >= 100 ? Math.round(m).toString() : (Math.round(m * 10) / 10).toString();
  return `${sign}${formatted}M`;
}

export function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\|*_`#]/g, '\\$&');
}

export function formatResetCountdown(resetTime: string | null, isReady: boolean, isExhausted: boolean): string {
  if (isReady) return 'Ready';
  if (!resetTime) return isExhausted ? 'Exhausted' : 'Active';
  const diffMs = Date.parse(resetTime) - Date.now();
  if (diffMs <= 0) return 'Ready';
  const totalMin = Math.ceil(diffMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return `Resets in ${days}d ${remH}h`;
  }
  if (hours > 0) {
    return `Resets in ${hours}h ${mins}m`;
  }
  return `Resets in ${mins}m`;
}

export function buildStatusBarViewModel(state: MonitorState, config: MonitorConfig): StatusBarViewModel {
  // 1. Context Item
  let contextText = '';
  let contextColor: 'normal' | 'warning' | 'error' = 'normal';

  if (state.pinMissing) {
    contextText = '$(pin) Missing — Click to unpin';
    contextColor = 'warning';
  } else if (!state.activeSession) {
    contextText = '$(pulse) No workspace session';
    contextColor = 'normal';
  } else {
    const active = state.activeSession;
    const isPinned = state.pinnedSessionId !== null && !state.pinMissing;
    const isRunning = active.rolledUp.isRunning;

    const prefixParts: string[] = [];
    if (isPinned) prefixParts.push('$(pin)');
    if (isRunning) prefixParts.push('$(sync~spin)');

    const rawTitle = (active.title || active.preview || 'Untitled').replace(/\s+/g, ' ').trim();
    const truncatedTitle = rawTitle.length > 20 ? `${rawTitle.slice(0, 19)}…` : rawTitle;

    const usedStr = formatCompactTokens(active.contextUsed);
    const limitStr = formatCompactTokens(active.contextLimit);
    const pct = Math.round(active.contextPct);
    const cacheStr = `C:${Math.round(active.cacheVolumePct)}%`;

    const parts = [...prefixParts, truncatedTitle, `${usedStr}/${limitStr} (${pct}%)`, cacheStr];
    contextText = parts.join(' ');

    if (active.contextPct >= config.contextCriticalPct) {
      contextColor = 'error';
    } else if (active.contextPct >= config.contextWarningPct) {
      contextColor = 'warning';
    } else {
      contextColor = 'normal';
    }
  }

  // 2. Quota Item
  let quotaText = '';
  let quotaColor: 'normal' | 'warning' | 'error' = 'normal';

  if (state.quota.status !== 'online') {
    quotaText = 'Quota offline';
    quotaColor = 'normal';
  } else {
    const g5h = state.quota.pools.gemini?.fiveHour;
    const c5h = state.quota.pools.nonGoogle?.fiveHour;

    const gStr = g5h ? `${Math.round(g5h.remainingPct)}%` : '--%';
    const cStr = c5h ? `${Math.round(c5h.remainingPct)}%` : '--%';
    quotaText = `G ${gStr} · C ${cStr}`;

    const pcts: number[] = [];
    if (g5h) pcts.push(g5h.remainingPct);
    if (c5h) pcts.push(c5h.remainingPct);

    if (pcts.length > 0) {
      const min = Math.min(...pcts);
      if (min <= 0) {
        quotaColor = 'error';
      } else if (min <= 20) {
        quotaColor = 'warning';
      } else {
        quotaColor = 'normal';
      }
    } else {
      quotaColor = 'normal';
    }
  }

  // 3. Tooltip Markdown
  const lines: string[] = [];
  lines.push('### Antigravity Session Monitor');
  lines.push('');

  if (state.pinMissing) {
    lines.push('⚠️ **Pinned session is missing or deleted.** Click to unpin.');
    lines.push('');
  }

  if (state.activeSession) {
    const active = state.activeSession;
    const isPinned = state.pinnedSessionId !== null && !state.pinMissing;
    const modeText = isPinned ? '$(pin) Pinned' : '$(target) Auto-Tracked';
    const runningText = active.rolledUp.isRunning ? '$(sync~spin) Running' : 'Idle';

    lines.push(`**Session:** ${escapeMarkdown(active.title || 'Untitled')}`);
    lines.push(`**Model:** \`${escapeMarkdown(active.model)}\` · **Status:** ${runningText} · **Mode:** ${modeText}`);
    if (active.subagentCount > 0) {
      const subCountText = active.subagentCount === 1 ? '1 subagent' : `${active.subagentCount} subagents`;
      lines.push(`**Hierarchy:** Parent + ${subCountText} (${active.runningSubagentCount} running)`);
    }
    lines.push('');
    lines.push('| Metric | Parent (Own) | Rolled-up (Total) |');
    lines.push('| :--- | :--- | :--- |');
    lines.push(`| **Context Window** | ${formatCompactTokens(active.contextUsed)} / ${formatCompactTokens(active.contextLimit)} (${Math.round(active.contextPct)}%) | — |`);
    lines.push(`| **Fresh Tokens** | ${formatCompactTokens(active.own.fresh)} | ${formatCompactTokens(active.rolledUp.fresh)} |`);
    lines.push(`| **Cache Read** | ${formatCompactTokens(active.own.cacheRead)} | ${formatCompactTokens(active.rolledUp.cacheRead)} |`);
    lines.push(`| **Output Tokens** | ${formatCompactTokens(active.own.output)} (Thinking: ${formatCompactTokens(active.own.thinking)}, Response: ${formatCompactTokens(active.own.response)}) | ${formatCompactTokens(active.rolledUp.output)} (Thinking: ${formatCompactTokens(active.rolledUp.thinking)}, Response: ${formatCompactTokens(active.rolledUp.response)}) |`);
    lines.push(`| **Cache Volume** | ${active.ownCacheVolumePct.toFixed(1)}% | ${active.cacheVolumePct.toFixed(1)}% |`);
    lines.push(`| **Call Cache Hit** | ${active.ownCallHitPct.toFixed(1)}% | ${active.callHitPct.toFixed(1)}% |`);
    lines.push(`| **Calls** | ${active.own.calls} | ${active.rolledUp.calls} |`);
    lines.push(`| **Compactions** | ${active.own.compactions} | ${active.rolledUp.compactions} |`);
  } else {
    lines.push('$(pulse) *No active workspace session*');
  }

  lines.push('');
  lines.push('---');
  lines.push(`### Quota Pools (${state.quota.status})`);
  lines.push('');

  if (state.quota.status === 'online') {
    lines.push('| Pool | 5-Hour Window | Weekly Window |');
    lines.push('| :--- | :--- | :--- |');
    const gemini = state.quota.pools.gemini;
    const nonGoogle = state.quota.pools.nonGoogle;

    const fmtWindow = (w: QuotaWindow | null) => {
      if (!w) return '—';
      const countdown = formatResetCountdown(w.resetTime, w.isReady, w.isExhausted);
      return `${Math.round(w.remainingPct)}% (${countdown})`;
    };

    lines.push(`| **Gemini** | ${fmtWindow(gemini?.fiveHour ?? null)} | ${fmtWindow(gemini?.weekly ?? null)} |`);
    lines.push(`| **Non-Google** | ${fmtWindow(nonGoogle?.fiveHour ?? null)} | ${fmtWindow(nonGoogle?.weekly ?? null)} |`);
  } else {
    lines.push(`*Quota status is currently ${state.quota.status}.*`);
  }

  const tooltipMarkdown = lines.join('\n');

  return {
    contextText,
    contextColor,
    quotaText,
    quotaColor,
    tooltipMarkdown,
  };
}

export function createStatusBarController(
  vscodeApi: StatusBarVscodeLike,
  onClickContextCmd: string,
  onClickQuotaCmd: string,
): StatusBarController {
  const contextItem = vscodeApi.window.createStatusBarItem(1, 100);
  contextItem.command = onClickContextCmd;
  contextItem.show();

  const quotaItem = vscodeApi.window.createStatusBarItem(1, 99);
  quotaItem.command = onClickQuotaCmd;
  quotaItem.show();

  return {
    contextItem,
    quotaItem,
    update(state: MonitorState, config: MonitorConfig): void {
      const vm = buildStatusBarViewModel(state, config);

      contextItem.text = vm.contextText;
      if (vm.contextColor === 'warning') {
        contextItem.backgroundColor = new vscodeApi.ThemeColor('statusBarItem.warningBackground');
      } else if (vm.contextColor === 'error') {
        contextItem.backgroundColor = new vscodeApi.ThemeColor('statusBarItem.errorBackground');
      } else {
        contextItem.backgroundColor = undefined;
      }

      quotaItem.text = vm.quotaText;
      if (vm.quotaColor === 'warning') {
        quotaItem.backgroundColor = new vscodeApi.ThemeColor('statusBarItem.warningBackground');
      } else if (vm.quotaColor === 'error') {
        quotaItem.backgroundColor = new vscodeApi.ThemeColor('statusBarItem.errorBackground');
      } else {
        quotaItem.backgroundColor = undefined;
      }

      const md = new vscodeApi.MarkdownString(vm.tooltipMarkdown);
      md.isTrusted = true;
      md.supportThemeIcons = true;
      contextItem.tooltip = md;
      quotaItem.tooltip = md;
    },
    dispose(): void {
      contextItem.dispose();
      quotaItem.dispose();
    },
  };
}
