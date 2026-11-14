import type { CallUsagePoint, MonitorState, QuotaPool, QuotaWindow, SessionNode } from '../types.ts';
import { formatCompactTokens, formatResetCountdown } from './statusBar.ts';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findNodeById(roots: SessionNode[], unattached: SessionNode[], id: string): SessionNode | null {
  function search(nodes: SessionNode[]): SessionNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      const childMatch = search(node.children);
      if (childMatch) return childMatch;
    }
    return null;
  }
  return search(roots) || search(unattached);
}

function renderQuotaPool(pool: QuotaPool | undefined, label: string): string {
  if (!pool) {
    return `<div class="quota-pool"><div class="quota-pool-title">${escapeHtml(label)}</div><div class="quota-pool-val">—</div></div>`;
  }
  const fmt = (w: QuotaWindow | null) => {
    if (!w) return '—';
    const countdown = formatResetCountdown(w.resetTime, w.isReady, w.isExhausted);
    const colorClass = w.remainingPct <= 0 ? 'err' : w.remainingPct <= 20 ? 'warn' : 'ok';
    return `<span class="val ${colorClass}">${Math.round(w.remainingPct)}%</span> <span class="countdown">(${countdown})</span>`;
  };

  return `
    <div class="quota-pool">
      <div class="quota-pool-title">${escapeHtml(label)}</div>
      <div class="quota-windows">
        <div class="quota-win"><strong>5h:</strong> ${fmt(pool.fiveHour)}</div>
        <div class="quota-win"><strong>Wk:</strong> ${fmt(pool.weekly)}</div>
      </div>
    </div>
  `;
}

function renderSvgChart(calls: CallUsagePoint[]): string {
  if (calls.length === 0) {
    return '<div class="empty-chart">No call telemetry recorded</div>';
  }

  const width = 500;
  const height = 160;
  const padLeft = 45;
  const padRight = 15;
  const padTop = 20;
  const padBottom = 25;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxVal = Math.max(
    ...calls.map((c) => Math.max(c.effectiveContext, c.contextLimit > 0 ? c.contextLimit : 256_000)),
    256_000,
  );

  const getX = (i: number) => {
    if (calls.length === 1) return padLeft + chartW / 2;
    return padLeft + (i / (calls.length - 1)) * chartW;
  };

  const getY = (val: number) => {
    const clamped = Math.max(0, Math.min(val, maxVal));
    return padTop + (1 - clamped / maxVal) * chartH;
  };

  const points = calls.map((c, i) => ({ x: getX(i), y: getY(c.effectiveContext) }));
  const lineD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L ${points[points.length - 1].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`;

  const compactionsSvg = calls
    .map((c, i) => {
      if (!c.isCompacted && c.compactedFromStep === null) return '';
      const x = getX(i);
      const stepText = c.compactedFromStep !== null ? `Step ${c.compactedFromStep}` : 'Compaction';
      return `
        <line x1="${x.toFixed(1)}" y1="${padTop}" x2="${x.toFixed(1)}" y2="${(padTop + chartH).toFixed(1)}"
          stroke="var(--vscode-editorWarning-foreground, #cca700)" stroke-dasharray="3,3" stroke-width="1.5" />
        <text x="${x.toFixed(1)}" y="${padTop - 5}" fill="var(--vscode-editorWarning-foreground, #cca700)"
          font-size="9" text-anchor="middle">Compaction (${stepText})</text>
      `;
    })
    .join('');

  const dotsSvg = points
    .map((p, i) => {
      const c = calls[i];
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="var(--vscode-charts-blue, #007acc)">
        <title>Call #${c.idx} (Step ${c.stepIndices.join(',')}): ${formatCompactTokens(c.effectiveContext)} / ${formatCompactTokens(c.contextLimit)}</title>
      </circle>`;
    })
    .join('');

  const yLabels = [0, 0.5, 1]
    .map((frac) => {
      const yVal = frac * maxVal;
      const yPos = padTop + (1 - frac) * chartH;
      return `
      <line x1="${padLeft}" y1="${yPos.toFixed(1)}" x2="${(padLeft + chartW).toFixed(1)}" y2="${yPos.toFixed(1)}" stroke="var(--vscode-border, #444)" stroke-width="0.5" stroke-dasharray="2,2" />
      <text x="${padLeft - 5}" y="${(yPos + 3).toFixed(1)}" fill="var(--vscode-descriptionForeground, #888)" font-size="9" text-anchor="end">${formatCompactTokens(yVal)}</text>
    `;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="none">
      <defs>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--vscode-charts-blue, #007acc)" stop-opacity="0.3" />
          <stop offset="100%" stop-color="var(--vscode-charts-blue, #007acc)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${yLabels}
      <path d="${areaD}" fill="url(#areaGradient)" />
      <path d="${lineD}" fill="none" stroke="var(--vscode-charts-blue, #007acc)" stroke-width="2" />
      ${compactionsSvg}
      ${dotsSvg}
      <text x="${padLeft}" y="${height - 5}" fill="var(--vscode-descriptionForeground, #888)" font-size="9">Call #${calls[0].idx}</text>
      <text x="${(padLeft + chartW).toFixed(1)}" y="${height - 5}" fill="var(--vscode-descriptionForeground, #888)" font-size="9" text-anchor="end">Call #${calls[calls.length - 1].idx}</text>
    </svg>
  `;
}

export function renderBottomPanelHtml(state: MonitorState, nonce: string, cspSource: string): string {
  // Resolve selected session
  let selected = state.selectedSession;
  if (!selected && state.selectedSessionId) {
    selected = findNodeById(state.roots, state.unattachedSubagents, state.selectedSessionId);
  }
  if (!selected) {
    selected = state.activeSession;
  }
  if (!selected && state.roots.length > 0) {
    selected = state.roots[0];
  }

  // Filter roots according to scope
  const isCurrentScope = state.scope === 'current';
  const roots = isCurrentScope ? state.roots.filter((r) => r.matchesWorkspace) : state.roots;

  function renderTreeNodes(nodes: SessionNode[], depth = 0): string {
    return nodes
      .map((node) => {
        const isSelected = selected ? node.id === selected.id : false;
        const isActive = state.activeSession ? node.id === state.activeSession.id : false;
        const isPinned = node.id === state.pinnedSessionId;
        const isRunning = node.rolledUp.isRunning || node.own.isRunning;

        const role = node.subagentRole || node.agentName;
        const roleBadge = role ? `<span class="badge role">${escapeHtml(role)}</span>` : '';
        const runningBadge = isRunning ? '<span class="badge running">Running</span>' : '';
        const pinnedBadge = isPinned ? '<span class="badge pinned">Pinned</span>' : '';
        const activeBadge = isActive ? '<span class="badge active-tag">Active</span>' : '';

        const titleText = escapeHtml(node.title || node.preview || 'Untitled');
        const contextStr = `${formatCompactTokens(node.contextUsed)}/${formatCompactTokens(node.contextLimit)}`;
        const cacheStr = `C:${Math.round(node.cacheVolumePct)}%`;

        const childHtml = node.children.length > 0 ? renderTreeNodes(node.children, depth + 1) : '';

        return `
          <div class="tree-node depth-${depth}" style="padding-left: ${depth * 16}px;">
            <div class="tree-row ${isSelected ? 'selected' : ''}" data-action="selectSession" data-session-id="${escapeHtml(node.id)}">
              <span class="tree-title">${roleBadge} ${titleText}</span>
              <div class="tree-meta">
                ${activeBadge}
                ${pinnedBadge}
                ${runningBadge}
                <span class="tree-ctx">${contextStr} (${Math.round(node.contextPct)}%)</span>
                <span class="tree-cache">${cacheStr}</span>
                <button class="btn-icon" data-action="${isPinned ? 'unpinSession' : 'pinSession'}" data-session-id="${escapeHtml(node.id)}" title="${isPinned ? 'Unpin' : 'Pin to Status Bar'}">
                  ${isPinned ? 'Unpin' : 'Pin'}
                </button>
              </div>
            </div>
            ${childHtml}
          </div>
        `;
      })
      .join('');
  }

  const treeHtml = renderTreeNodes(roots);
  const unattachedHtml =
    state.unattachedSubagents.length > 0
      ? `<div class="unattached-section"><div class="section-title">Unattached Subagents</div>${renderTreeNodes(state.unattachedSubagents, 1)}</div>`
      : '';

  // Detail card for selected session
  let detailHtml = '<div class="empty-detail">No session selected</div>';
  let chartHtml = '';
  let tokenGroupsHtml = '';

  if (selected) {
    const isPinned = selected.id === state.pinnedSessionId;
    const isRunning = selected.rolledUp.isRunning;

    const latestCall = selected.calls.length > 0 ? selected.calls[selected.calls.length - 1] : null;
    if (latestCall?.tokenBreakdownGroups && latestCall.tokenBreakdownGroups.length > 0) {
      tokenGroupsHtml = `
        <div class="token-groups">
          <div class="token-groups-title">Latest Call Breakdown:</div>
          <div class="token-groups-pills">
            ${latestCall.tokenBreakdownGroups
              .map(
                (g) =>
                  `<span class="pill">${escapeHtml(g.name)}: <strong>${formatCompactTokens(g.tokens)}</strong></span>`,
              )
              .join(' ')}
          </div>
        </div>
      `;
    }

    chartHtml = renderSvgChart(selected.calls);

    detailHtml = `
      <div class="detail-card">
        <div class="detail-header">
          <div class="detail-title-row">
            <h2 class="detail-title">${escapeHtml(selected.title || 'Untitled')}</h2>
            <div class="detail-actions">
              <button class="btn" data-action="${isPinned ? 'unpinSession' : 'pinSession'}" data-session-id="${escapeHtml(selected.id)}">
                ${isPinned ? 'Unpin from Status Bar' : 'Pin to Status Bar'}
              </button>
            </div>
          </div>
          <div class="detail-subtitle">
            <span><strong>Model:</strong> ${escapeHtml(selected.model)}</span>
            <span><strong>Status:</strong> ${isRunning ? 'Running' : escapeHtml(selected.status)}</span>
            ${selected.subagentCount > 0 ? `<span><strong>Subagents:</strong> ${selected.subagentCount} (${selected.runningSubagentCount} running)</span>` : ''}
          </div>
        </div>

        <div class="detail-table-wrap">
          <table class="detail-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Own (Parent)</th>
                <th>Rolled-up (Total)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Context Window</td>
                <td><strong>${formatCompactTokens(selected.contextUsed)} / ${formatCompactTokens(selected.contextLimit)} (${Math.round(selected.contextPct)}%)</strong></td>
                <td>—</td>
              </tr>
              <tr>
                <td>Fresh Tokens</td>
                <td>${formatCompactTokens(selected.own.fresh)}</td>
                <td>${formatCompactTokens(selected.rolledUp.fresh)}</td>
              </tr>
              <tr>
                <td>Cache Read Tokens</td>
                <td>${formatCompactTokens(selected.own.cacheRead)}</td>
                <td>${formatCompactTokens(selected.rolledUp.cacheRead)}</td>
              </tr>
              <tr>
                <td>Output Tokens</td>
                <td>${formatCompactTokens(selected.own.output)} (T: ${formatCompactTokens(selected.own.thinking)}, R: ${formatCompactTokens(selected.own.response)})</td>
                <td>${formatCompactTokens(selected.rolledUp.output)} (T: ${formatCompactTokens(selected.rolledUp.thinking)}, R: ${formatCompactTokens(selected.rolledUp.response)})</td>
              </tr>
              <tr>
                <td>Cache Volume %</td>
                <td>${selected.ownCacheVolumePct.toFixed(1)}%</td>
                <td>${selected.cacheVolumePct.toFixed(1)}%</td>
              </tr>
              <tr>
                <td>Call Hit %</td>
                <td>${selected.ownCallHitPct.toFixed(1)}%</td>
                <td>${selected.callHitPct.toFixed(1)}%</td>
              </tr>
              <tr>
                <td>Total Calls</td>
                <td>${selected.own.calls}</td>
                <td>${selected.rolledUp.calls}</td>
              </tr>
              <tr>
                <td>Compactions</td>
                <td>${selected.own.compactions}</td>
                <td>${selected.rolledUp.compactions}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="detail-chart-section">
          <div class="chart-header">
            <h3>Context Growth &amp; Compactions (${selected.calls.length} calls)</h3>
          </div>
          ${chartHtml}
          ${tokenGroupsHtml}
        </div>
      </div>
    `;
  }

  // Quota strip
  const quota = state.quota;
  const quotaOnline = quota.status === 'online';
  const geminiPool = quota.pools.gemini;
  const nonGooglePool = quota.pools.nonGoogle;

  const quotaStripHtml = `
    <div class="quota-strip ${quotaOnline ? 'online' : 'offline'}">
      <div class="quota-pools-wrap">
        ${renderQuotaPool(geminiPool, 'Gemini')}
        ${renderQuotaPool(nonGooglePool, 'Non-Google')}
      </div>
      <div class="quota-meta">
        <span class="status-indicator ${quotaOnline ? 'online' : 'offline'}">● Quota ${escapeHtml(quota.status)}</span>
        <button class="btn-sm" data-action="refresh">Refresh</button>
      </div>
    </div>
  `;

  // Banner when pinMissing
  const pinMissingBanner = state.pinMissing
    ? `
      <div class="alert-banner warning">
        <span>⚠️ Pinned session is missing or deleted.</span>
        <button class="btn-sm" data-action="unpinSession">Click to unpin</button>
      </div>
    `
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Session Monitor</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --border: var(--vscode-border, #333333);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --err: var(--vscode-editorError-foreground, #f14c4c);
      --ok: var(--vscode-testing-iconPassed, #73c991);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --hover-bg: var(--vscode-list-hoverBackground, #2a2d2e);
      --select-bg: var(--vscode-list-activeSelectionBackground, #094771);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 10px;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      background: var(--bg);
      color: var(--fg);
    }
    .top-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .scope-toggle {
      display: flex;
      gap: 6px;
    }
    .alert-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 12px;
      margin-bottom: 8px;
      border-radius: 4px;
      background: rgba(204, 167, 0, 0.15);
      border: 1px solid var(--warn);
      color: var(--warn);
    }
    .quota-strip {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-bottom: 12px;
    }
    .quota-pools-wrap {
      display: flex;
      gap: 20px;
    }
    .quota-pool-title {
      font-weight: 600;
      margin-bottom: 2px;
    }
    .quota-windows {
      display: flex;
      gap: 10px;
    }
    .val.ok { color: var(--ok); }
    .val.warn { color: var(--warn); }
    .val.err { color: var(--err); }
    .countdown { opacity: 0.75; font-size: 0.9em; }
    .status-indicator.online { color: var(--ok); }
    .status-indicator.offline { color: var(--err); }
    .quota-meta {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .main-layout {
      display: grid;
      grid-template-columns: minmax(240px, 320px) 1fr;
      gap: 12px;
      height: calc(100vh - 120px);
    }
    @media (max-width: 600px) {
      .main-layout { grid-template-columns: 1fr; height: auto; }
    }
    .tree-pane {
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow-y: auto;
      background: rgba(0, 0, 0, 0.1);
    }
    .tree-header {
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      background: rgba(255, 255, 255, 0.02);
    }
    .tree-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 8px;
      cursor: pointer;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    .tree-row:hover { background: var(--hover-bg); }
    .tree-row.selected { background: var(--select-bg); }
    .tree-title {
      display: flex;
      align-items: center;
      gap: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tree-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .badge {
      display: inline-block;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 0.85em;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }
    .badge.running { background: #007acc; }
    .badge.pinned { background: #b86700; }
    .badge.active-tag { background: #388a34; }
    .badge.role { background: rgba(255, 255, 255, 0.1); }
    .detail-pane {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 12px;
      overflow-y: auto;
      background: rgba(0, 0, 0, 0.1);
    }
    .detail-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .detail-title {
      margin: 0;
      font-size: 1.2em;
    }
    .detail-subtitle {
      display: flex;
      gap: 16px;
      margin-bottom: 12px;
      opacity: 0.85;
    }
    .detail-table-wrap {
      margin-bottom: 16px;
      overflow-x: auto;
    }
    .detail-table {
      width: 100%;
      border-collapse: collapse;
    }
    .detail-table th, .detail-table td {
      padding: 5px 8px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .detail-table th {
      background: rgba(255, 255, 255, 0.03);
    }
    .chart-header {
      margin-bottom: 6px;
    }
    .chart-header h3 {
      margin: 0;
      font-size: 1em;
    }
    .chart-svg {
      width: 100%;
      height: 160px;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .token-groups {
      margin-top: 8px;
    }
    .token-groups-title {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .token-groups-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .pill {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 4px 10px;
      border-radius: 3px;
      cursor: pointer;
    }
    .btn-sm {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 2px 6px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.9em;
    }
    .btn-icon {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 1px 4px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.8em;
    }
    .btn-icon:hover { background: var(--hover-bg); }
  </style>
</head>
<body>
  <div class="top-controls">
    <div class="scope-toggle">
      <button class="btn-sm" data-action="toggleScope">
        ${isCurrentScope ? 'Scope: Current Workspace' : 'Scope: All Workspaces'}
      </button>
    </div>
  </div>

  ${pinMissingBanner}
  ${quotaStripHtml}

  <div class="main-layout">
    <div class="tree-pane">
      <div class="tree-header">Sessions (${roots.length})</div>
      ${treeHtml}
      ${unattachedHtml}
    </div>
    <div class="detail-pane">
      ${detailHtml}
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      const sessionId = target.getAttribute('data-session-id');

      if (action === 'selectSession' && sessionId) {
        vscode.postMessage({ type: 'selectSession', sessionId });
      } else if (action === 'pinSession' && sessionId) {
        vscode.postMessage({ type: 'pinSession', sessionId });
      } else if (action === 'unpinSession') {
        vscode.postMessage({ type: 'unpinSession' });
      } else if (action === 'toggleScope') {
        vscode.postMessage({ type: 'toggleScope' });
      } else if (action === 'refresh') {
        vscode.postMessage({ type: 'refresh' });
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message && message.type === 'updateState') {
        // State update notification
      }
    });
  </script>
</body>
</html>`;
}
