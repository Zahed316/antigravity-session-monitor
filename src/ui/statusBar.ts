import type {
  ModelTokenEstimate,
  MonitorConfig,
  MonitorState,
  PoolKey,
  QuotaWindow,
  SessionNode,
  WindowTokenEstimate,
} from '../types.ts';

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
  MarkdownString: new (
    value?: string,
  ) => { value: string; isTrusted?: boolean; supportThemeIcons?: boolean; appendMarkdown?(value: string): any };
  StatusBarAlignment?: { Left: number; Right: number };
}

export interface StatusBarViewModel {
  text: string;
  color: 'normal' | 'warning' | 'error';
  tooltipMarkdown: string;
}

export interface StatusBarController {
  readonly item: StatusBarItemLike;
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
  if (isExhausted) return 'Exhausted';
  if (!resetTime) return 'Active';
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

export function formatResetDateTime(resetTime: string | null): string | null {
  if (!resetTime) return null;
  const ms = Date.parse(resetTime);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = MONTHS[d.getMonth()];
  const day = d.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  return `${month} ${day}, ${hours}:${mins}`;
}

export function formatWindowEstimateBrief(est: WindowTokenEstimate | null | undefined): string {
  if (!est) return '—';
  if (est.status === 'calibrated' && est.estimatedTotalTokens !== null) {
    const totalStr = `~${formatCompactTokens(est.estimatedTotalTokens)} tok`;
    if (est.estimatedBilledTokens !== null) {
      return `${totalStr} (~${formatCompactTokens(est.estimatedBilledTokens)} fresh+out)`;
    }
    return totalStr;
  }
  if (est.windowUsedTotal > 0) {
    return `Calibrating (${formatCompactTokens(est.windowUsedTotal)} used)`;
  }
  return 'Calibrating…';
}

function summarizeSubagentModels(root: SessionNode): string {
  const counts = new Map<string, number>();
  function visit(node: SessionNode): void {
    for (const child of node.children) {
      const label = child.model && child.model !== 'unknown' ? child.model : 'Unknown';
      counts.set(label, (counts.get(label) ?? 0) + 1);
      visit(child);
    }
  }
  visit(root);
  if (counts.size === 0) return '';
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([name, cnt]) => `${cnt}× ${escapeMarkdown(name)}`);
  if (sorted.length > 3) {
    top.push(`+${sorted.length - 3} more`);
  }
  return top.join(', ');
}

function maxSeverity(
  a: 'normal' | 'warning' | 'error',
  b: 'normal' | 'warning' | 'error',
): 'normal' | 'warning' | 'error' {
  if (a === 'error' || b === 'error') return 'error';
  if (a === 'warning' || b === 'warning') return 'warning';
  return 'normal';
}

function buildCompactQuotaPart(state: MonitorState): {
  text: string;
  color: 'normal' | 'warning' | 'error';
} {
  if (state.quota.status !== 'online') {
    return { text: 'Quota offline', color: 'normal' };
  }

  const gWin = state.quota.pools.gemini?.fiveHour ?? state.quota.pools.gemini?.weekly;
  const cWin = state.quota.pools.nonGoogle?.fiveHour ?? state.quota.pools.nonGoogle?.weekly;

  const segments: string[] = [];
  const pcts: number[] = [];

  if (gWin) {
    segments.push(`G ${Math.round(gWin.remainingPct)}%`);
    pcts.push(gWin.remainingPct);
  } else {
    segments.push('G --%');
  }

  if (cWin) {
    segments.push(`C ${Math.round(cWin.remainingPct)}%`);
    pcts.push(cWin.remainingPct);
  } else {
    segments.push('C --%');
  }

  let color: 'normal' | 'warning' | 'error' = 'normal';
  if (pcts.length > 0) {
    const min = Math.min(...pcts);
    if (min <= 0) color = 'error';
    else if (min <= 20) color = 'warning';
  }

  return { text: segments.join(' · '), color };
}

export function buildStatusBarViewModel(state: MonitorState, config: MonitorConfig): StatusBarViewModel {
  const quotaPart = buildCompactQuotaPart(state);
  let text = '';
  let contextColor: 'normal' | 'warning' | 'error' = 'normal';

  if (state.pinMissing) {
    text = '$(pin) Missing — Click to unpin';
    contextColor = 'warning';
  } else if (!state.activeSession) {
    text = `$(pulse) No session · ${quotaPart.text}`;
  } else {
    const active = state.activeSession;
    const isPinned = state.pinnedSessionId !== null && !state.pinMissing;
    const isRunning = active.rolledUp.isRunning;

    const icons: string[] = [];
    if (isPinned) icons.push('$(pin)');
    if (isRunning) icons.push('$(sync~spin)');
    if (icons.length === 0) icons.push('$(pulse)');

    const rawTitle = (active.title || active.preview || 'Untitled').replace(/\s+/g, ' ').trim();
    const shortTitle = rawTitle.length > 18 ? `${rawTitle.slice(0, 17)}…` : rawTitle;
    const ctxPct = `${Math.round(active.contextPct)}%`;

    text = `${icons.join(' ')} ${shortTitle} ${ctxPct} · ${quotaPart.text}`;

    if (active.contextPct >= config.contextCriticalPct) {
      contextColor = 'error';
    } else if (active.contextPct >= config.contextWarningPct) {
      contextColor = 'warning';
    }
  }

  const color = state.pinMissing ? 'warning' : maxSeverity(contextColor, quotaPart.color);

  // Minimal, essential-only hover tooltip
  const lines: string[] = [];
  lines.push('### Antigravity Monitor');
  lines.push('');

  if (state.pinMissing) {
    lines.push('⚠️ **Pinned session is missing.** Click to unpin.');
    lines.push('');
  }

  const isCooldownActive = Boolean(
    state.quota.rateLimited ||
      (typeof state.quota.cooldownUntilMs === 'number' && state.quota.cooldownUntilMs > Date.now()),
  );
  if (isCooldownActive) {
    const untilStr = state.quota.cooldownUntilMs
      ? new Date(state.quota.cooldownUntilMs).toLocaleTimeString()
      : 'reset';
    lines.push(`⚠️ **Rate-limited / Cooldown until ${untilStr}**`);
    lines.push('');
  }

  if (state.activeSession) {
    const active = state.activeSession;
    const runningText = active.rolledUp.isRunning ? '$(sync~spin) Running' : 'Idle';
    const modelText = escapeMarkdown(active.model || 'Unknown');

    lines.push(`**Session:** ${escapeMarkdown(active.title || 'Untitled')}`);
    lines.push(`**Model:** ${modelText} · **Status:** ${runningText}`);
    lines.push(
      `**Context:** ${formatCompactTokens(active.contextUsed)} / ${formatCompactTokens(active.contextLimit)} (${Math.round(active.contextPct)}%) · **Cache:** ${Math.round(active.cacheVolumePct)}%`,
    );

    if (active.subagentCount > 0) {
      const modelSummary = summarizeSubagentModels(active);
      const runStr = active.runningSubagentCount > 0 ? ` (${active.runningSubagentCount} running)` : '';
      lines.push(`**Subagents:** ${active.subagentCount}${runStr}${modelSummary ? ` — ${modelSummary}` : ''}`);
    }

    const activeEst: ModelTokenEstimate | undefined = state.modelEstimates?.find(
      (e) => e.modelLabel === active.model,
    );
    if (activeEst) {
      const hasCalibrated =
        (activeEst.fiveHour?.status === 'calibrated' && activeEst.fiveHour.estimatedTotalTokens !== null) ||
        (activeEst.weekly?.status === 'calibrated' && activeEst.weekly.estimatedTotalTokens !== null);

      if (hasCalibrated) {
        const parts: string[] = [];
        if (activeEst.fiveHour) parts.push(`5h: ${formatWindowEstimateBrief(activeEst.fiveHour)}`);
        if (activeEst.weekly) parts.push(`Wk: ${formatWindowEstimateBrief(activeEst.weekly)}`);
        if (parts.length > 0) {
          lines.push(`**Est. Left:** ${parts.join(' · ')}`);
        }
      } else {
        const usedTotal =
          Math.max(activeEst.fiveHour?.windowUsedTotal ?? 0, activeEst.weekly?.windowUsedTotal ?? 0) ||
          (active.rolledUp.fresh + active.rolledUp.cacheRead + active.rolledUp.output);
        const usedBilled = Math.max(activeEst.fiveHour?.windowUsedBilled ?? 0, activeEst.weekly?.windowUsedBilled ?? 0);
        const billedStr = usedBilled > 0 ? ` (~${formatCompactTokens(usedBilled)} fresh+out)` : '';
        lines.push(`**Active model tokens:** ${formatCompactTokens(usedTotal)}${billedStr} (calibrating)`);
      }
    }
  } else {
    lines.push('$(pulse) *No active workspace session*');
  }

  lines.push('');
  lines.push('---');

  if (state.quota.status === 'online') {
    lines.push('| Pool | 5-Hour | Weekly |');
    lines.push('| :--- | :--- | :--- |');
    const fmtWindow = (w: QuotaWindow | null) => {
      if (!w) return '—';
      const countdown = formatResetCountdown(w.resetTime, w.isReady, w.isExhausted);
      const resetDate = formatResetDateTime(w.resetTime);
      const datePart = resetDate ? ` · ${resetDate}` : '';
      return `${Math.round(w.remainingPct)}% (${countdown}${datePart})`;
    };

    const poolOrder: Array<{ key: PoolKey; fallbackName: string }> = [
      { key: 'gemini', fallbackName: 'Gemini Models' },
      { key: 'nonGoogle', fallbackName: 'Claude & GPT' },
    ];
    for (const p of poolOrder) {
      const pool = state.quota.pools[p.key];
      if (!pool) continue;
      lines.push(
        `| **${escapeMarkdown(pool.displayName || p.fallbackName)}** | ${fmtWindow(pool.fiveHour)} | ${fmtWindow(pool.weekly)} |`,
      );
    }
  } else {
    lines.push(`*Quota status: ${state.quota.status}*`);
  }

  lines.push('');
  lines.push('*Click for sessions & overview*');

  return {
    text,
    color,
    tooltipMarkdown: lines.join('\n'),
  };
}

export function createStatusBarController(
  vscodeApi: StatusBarVscodeLike,
  onClickCmd: string,
): StatusBarController {
  const item = vscodeApi.window.createStatusBarItem(1, 100);
  item.command = onClickCmd;
  item.show();

  let initialized = false;
  let lastText: string | undefined;
  let lastTooltipMarkdown: string | undefined;
  let lastBackgroundColorId: string | undefined;

  return {
    item,
    update(state: MonitorState, config: MonitorConfig): void {
      const vm = buildStatusBarViewModel(state, config);
      const targetBgColorId =
        vm.color === 'warning'
          ? 'statusBarItem.warningBackground'
          : vm.color === 'error'
            ? 'statusBarItem.errorBackground'
            : undefined;

      if (
        initialized &&
        lastText === vm.text &&
        lastTooltipMarkdown === vm.tooltipMarkdown &&
        lastBackgroundColorId === targetBgColorId
      ) {
        return;
      }

      if (!initialized || lastText !== vm.text) {
        item.text = vm.text;
        lastText = vm.text;
      }

      if (!initialized || lastBackgroundColorId !== targetBgColorId) {
        if (targetBgColorId) {
          item.backgroundColor = new vscodeApi.ThemeColor(targetBgColorId);
        } else {
          item.backgroundColor = undefined;
        }
        lastBackgroundColorId = targetBgColorId;
      }

      if (!initialized || lastTooltipMarkdown !== vm.tooltipMarkdown) {
        const md = new vscodeApi.MarkdownString(vm.tooltipMarkdown);
        md.isTrusted = true;
        md.supportThemeIcons = true;
        item.tooltip = md;
        lastTooltipMarkdown = vm.tooltipMarkdown;
      }

      initialized = true;
    },
    dispose(): void {
      item.dispose();
    },
  };
}
