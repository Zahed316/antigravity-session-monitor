import type {
  CallUsagePoint,
  ModelTokenEstimate,
  MonitorState,
  PoolKey,
  QuotaPool,
  QuotaWindow,
  SessionNode,
  WindowTokenEstimate,
} from '../types.ts';
import { formatCompactTokens, formatResetCountdown } from './statusBar.ts';

export interface PanelUiState {
  activeTab?: 'overview' | 'details';
  expandedIds?: ReadonlySet<string> | string[];
  breakdownOpen?: boolean;
}

const PCT_WIDTH_CSS = Array.from({ length: 101 }, (_, i) => `.p-${i}{width:${i}%;}`).join('');

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

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

function hasDescendant(node: SessionNode, targetId: string): boolean {
  if (node.id === targetId) return true;
  for (const child of node.children) {
    if (hasDescendant(child, targetId)) return true;
  }
  return false;
}

function pctSeverityClass(remainingPct: number): string {
  if (remainingPct <= 0) return 'err';
  if (remainingPct <= 20) return 'warn';
  return 'ok';
}

function ctxSeverityClass(usedPct: number): string {
  if (usedPct >= 90) return 'err';
  if (usedPct >= 75) return 'warn';
  return 'ok';
}

function ctxMeterTierClass(usedPct: number): string {
  if (usedPct >= 90) return 'tier-crit';
  if (usedPct >= 75) return 'tier-warn';
  if (usedPct >= 50) return 'tier-mid';
  return 'tier-low';
}

function renderContextMeter(used: number, limit: number, rawPct: number): string {
  const pct = clampPct(rawPct);
  const tier = ctxMeterTierClass(pct);
  const label = `${formatCompactTokens(used)}/${formatCompactTokens(limit)} (${pct}%)`;
  return `<div class="ctx-meter ${tier}" title="${escapeHtml(label)}"><div class="ctx-meter-fill ${tier} p-${pct}"></div><span class="ctx-meter-text">${escapeHtml(label)}</span></div>`;
}

function renderQuotaWindowRow(label: string, w: QuotaWindow | null): string {
  if (!w) {
    return `
      <div class="q-row muted">
        <span class="q-label">${escapeHtml(label)}</span>
        <span class="q-empty">—</span>
      </div>
    `;
  }
  const pct = clampPct(w.remainingPct);
  const sev = pctSeverityClass(w.remainingPct);
  const countdown = formatResetCountdown(w.resetTime, w.isReady, w.isExhausted);
  return `
    <div class="q-row">
      <div class="q-row-top">
        <span class="q-label">${escapeHtml(label)}</span>
        <span class="q-val ${sev}">${pct}% <span class="countdown">(${escapeHtml(countdown)})</span></span>
      </div>
      <div class="bar-track"><div class="bar-fill ${sev} p-${pct}"></div></div>
    </div>
  `;
}

function renderQuotaCard(pool: QuotaPool | undefined, fallbackTitle: string): string {
  const title = pool?.displayName || fallbackTitle;
  return `
    <div class="quota-card">
      <div class="quota-card-title">${escapeHtml(title)}</div>
      ${renderQuotaWindowRow('5-Hour', pool?.fiveHour ?? null)}
      ${renderQuotaWindowRow('Weekly', pool?.weekly ?? null)}
    </div>
  `;
}

function formatEstimateCell(est: WindowTokenEstimate | null): string {
  if (!est) {
    return '<span class="muted">—</span>';
  }
  if (est.status === 'calibrated' && est.estimatedTotalTokens !== null) {
    const total = formatCompactTokens(est.estimatedTotalTokens);
    const billed = est.estimatedBilledTokens !== null ? formatCompactTokens(est.estimatedBilledTokens) : null;
    return `
      <div class="est-main">~${total} <span class="est-unit">tok</span></div>
      ${billed ? `<div class="est-sub">~${billed} fresh+out</div>` : ''}
    `;
  }
  const used = est.windowUsedTotal > 0 ? `${formatCompactTokens(est.windowUsedTotal)} used` : 'waiting drop';
  return `<span class="est-cal">Calibrating <span class="muted">(${escapeHtml(used)})</span></span>`;
}

function poolDisplayLabel(poolKey: PoolKey): string {
  if (poolKey === 'gemini') return 'Gemini';
  if (poolKey === 'argon') return 'Argon';
  return 'Claude & GPT';
}

function renderModelForecastSection(estimates: ModelTokenEstimate[] | undefined): string {
  if (!estimates || estimates.length === 0) {
    return `
      <div class="section-card">
        <div class="section-header">
          <h3>Model Usage Forecast</h3>
          <span class="section-hint">Calibrates automatically from quota % drops</span>
        </div>
        <div class="empty-inline">No active model telemetry yet in this window.</div>
      </div>
    `;
  }

  const rows = estimates
    .map(
      (item) => `
      <tr>
        <td><span class="model-pill">${escapeHtml(item.modelLabel)}</span></td>
        <td><span class="pool-tag">${escapeHtml(poolDisplayLabel(item.poolKey))}</span></td>
        <td>${formatEstimateCell(item.fiveHour)}</td>
        <td>${formatEstimateCell(item.weekly)}</td>
      </tr>
    `,
    )
    .join('');

  return `
    <div class="section-card">
      <div class="section-header">
        <h3>Model Usage Forecast <span class="muted">(Est. Tokens Left)</span></h3>
        <span class="section-hint">Calibrates from observed % drop ÷ tokens used</span>
      </div>
      <div class="table-wrap">
        <table class="clean-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Pool</th>
              <th>5-Hour Left</th>
              <th>Weekly Left</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
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
          stroke="var(--warn)" stroke-dasharray="3,3" stroke-width="1.5" />
        <text x="${x.toFixed(1)}" y="${padTop - 5}" fill="var(--warn)"
          font-size="9" text-anchor="middle">Compaction (${stepText})</text>
      `;
    })
    .join('');

  const dotsSvg = points
    .map((p, i) => {
      const c = calls[i];
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="var(--accent)">
        <title>Call #${c.idx} (Step ${c.stepIndices.join(',')}): ${formatCompactTokens(c.effectiveContext)} / ${formatCompactTokens(c.contextLimit)}</title>
      </circle>`;
    })
    .join('');

  const yLabels = [0, 0.5, 1]
    .map((frac) => {
      const yVal = frac * maxVal;
      const yPos = padTop + (1 - frac) * chartH;
      return `
      <line x1="${padLeft}" y1="${yPos.toFixed(1)}" x2="${(padLeft + chartW).toFixed(1)}" y2="${yPos.toFixed(1)}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,2" />
      <text x="${padLeft - 5}" y="${(yPos + 3).toFixed(1)}" fill="var(--muted-fg)" font-size="9" text-anchor="end">${formatCompactTokens(yVal)}</text>
    `;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="none">
      <defs>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${yLabels}
      <path d="${areaD}" fill="url(#areaGradient)" />
      <path d="${lineD}" fill="none" stroke="var(--accent)" stroke-width="2" />
      ${compactionsSvg}
      ${dotsSvg}
      <text x="${padLeft}" y="${height - 5}" fill="var(--muted-fg)" font-size="9">Call #${calls[0].idx}</text>
      <text x="${(padLeft + chartW).toFixed(1)}" y="${height - 5}" fill="var(--muted-fg)" font-size="9" text-anchor="end">Call #${calls[calls.length - 1].idx}</text>
    </svg>
  `;
}

function collectDescendants(node: SessionNode, depth = 1): Array<{ node: SessionNode; depth: number }> {
  const out: Array<{ node: SessionNode; depth: number }> = [];
  for (const child of node.children) {
    out.push({ node: child, depth });
    out.push(...collectDescendants(child, depth + 1));
  }
  return out;
}

function nodeStatusLabel(node: SessionNode): { text: string; cls: string } {
  if (node.killed) return { text: 'Killed', cls: 'muted' };
  if (node.rolledUp.isRunning || node.own.isRunning) return { text: 'Running', cls: 'running' };
  return { text: 'Idle', cls: 'idle' };
}

export function renderBottomPanelBodyHtml(state: MonitorState, uiState?: PanelUiState): string {
  const activeTab: 'overview' | 'details' = uiState?.activeTab === 'details' ? 'details' : 'overview';
  const expandedSet =
    uiState?.expandedIds instanceof Set
      ? uiState.expandedIds
      : new Set<string>(Array.isArray(uiState?.expandedIds) ? uiState.expandedIds : []);
  const breakdownOpen = uiState?.breakdownOpen === true;

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
  let roots = isCurrentScope ? state.roots.filter((r) => r.matchesWorkspace) : [...state.roots];
  if (isCurrentScope && state.pinnedSessionId !== null && !state.pinMissing) {
    const pinnedRoot = state.roots.find((r) => hasDescendant(r, state.pinnedSessionId!));
    if (pinnedRoot && !roots.some((r) => r.id === pinnedRoot.id)) {
      roots.unshift(pinnedRoot);
    }
  }

  const unattached = isCurrentScope
    ? state.unattachedSubagents.filter(
        (u) => u.matchesWorkspace || u.id === state.pinnedSessionId || u.workspaceUris.length === 0,
      )
    : state.unattachedSubagents;

  function renderSessionRows(nodes: SessionNode[], depth = 0): string {
    return nodes
      .map((node) => {
        const isSelected = selected ? node.id === selected.id : false;
        const isActive = state.activeSession ? node.id === state.activeSession.id : false;
        const isPinned = node.id === state.pinnedSessionId;
        const isExpanded = expandedSet.has(node.id);
        const hasChildren = node.children.length > 0;
        const st = nodeStatusLabel(node);

        const role = node.subagentRole || node.agentName;
        const roleBadge = role ? `<span class="badge role">${escapeHtml(role)}</span>` : '';
        const modelLabel = node.model && node.model !== 'unknown' ? node.model : 'Unknown';
        const titleText = escapeHtml(node.title || node.preview || (node.isSubagent ? 'Subagent' : 'Untitled'));

        const expandBtn = hasChildren
          ? `<button class="btn-ghost expand-btn" data-action="toggleExpand" data-session-id="${escapeHtml(node.id)}" title="${isExpanded ? 'Collapse subagents' : 'Show subagents'}">
               ${isExpanded ? '▾' : '▸'} ${node.subagentCount} sub
             </button>`
          : '<span class="expand-spacer"></span>';

        const childHtml = hasChildren && isExpanded ? renderSessionRows(node.children, depth + 1) : '';

        return `
          <div class="session-row-wrap depth-${Math.min(depth, 3)}">
            <div class="session-row ${isSelected ? 'selected' : ''}" data-action="selectSession" data-session-id="${escapeHtml(node.id)}">
              <div class="session-main">
                ${depth === 0 ? expandBtn : '<span class="sub-arrow">↳</span>'}
                <span class="dot ${st.cls}" title="${st.text}"></span>
                ${roleBadge}
                <span class="session-title" title="${titleText}">${titleText}</span>
                ${isActive ? '<span class="badge active-tag">Active</span>' : ''}
                ${isPinned ? '<span class="badge pinned">Pinned</span>' : ''}
              </div>
              <div class="session-right">
                <span class="model-pill" title="${escapeHtml(modelLabel)}">${escapeHtml(modelLabel)}</span>
                ${renderContextMeter(node.contextUsed, node.contextLimit, node.contextPct)}
                <button class="btn-ghost" data-action="${isPinned ? 'unpinSession' : 'pinSession'}" data-session-id="${escapeHtml(node.id)}" title="${isPinned ? 'Unpin' : 'Pin to Status Bar'}">
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

  const sessionsHtml =
    roots.length > 0
      ? renderSessionRows(roots)
      : '<div class="empty-inline">No sessions match the current workspace scope.</div>';

  const unattachedHtml =
    unattached.length > 0
      ? `<div class="sub-group-title">Unattached Subagents (${unattached.length})</div>${renderSessionRows(unattached, 1)}`
      : '';

  // Quota Overview Section
  const quota = state.quota;
  const quotaOnline = quota.status === 'online';
  const argonPool = quota.pools.argon;
  const showArgonCard = Boolean(argonPool && (argonPool.fiveHour || argonPool.weekly));

  const quotaGridHtml = quotaOnline
    ? `
      <div class="quota-grid">
        ${renderQuotaCard(quota.pools.gemini, 'Gemini Models')}
        ${showArgonCard ? renderQuotaCard(argonPool, 'Gemini 4 Argon') : ''}
        ${renderQuotaCard(quota.pools.nonGoogle, 'Claude & GPT')}
      </div>
    `
    : `<div class="section-card empty-inline">Quota telemetry is currently ${escapeHtml(quota.status)}.</div>`;

  // Details Tab Content
  let detailsHtml = '<div class="section-card empty-inline">Select a session from Overview to inspect details.</div>';
  if (selected) {
    const isPinned = selected.id === state.pinnedSessionId;
    const st = nodeStatusLabel(selected);
    const modelLabel = selected.model && selected.model !== 'unknown' ? selected.model : 'Unknown';
    const ctxPct = clampPct(selected.contextPct);
    const ctxSev = ctxSeverityClass(ctxPct);

    const latestCall = selected.calls.length > 0 ? selected.calls[selected.calls.length - 1] : null;
    const tokenGroupsHtml =
      latestCall?.tokenBreakdownGroups && latestCall.tokenBreakdownGroups.length > 0
        ? `
          <div class="token-groups">
            <div class="token-groups-title">Latest Call Breakdown</div>
            <div class="token-groups-pills">
              ${latestCall.tokenBreakdownGroups
                .map(
                  (g) =>
                    `<span class="pill">${escapeHtml(g.name)}: <strong>${formatCompactTokens(g.tokens)}</strong></span>`,
                )
                .join('')}
            </div>
          </div>
        `
        : '';

    const descendants = collectDescendants(selected);
    const subagentsSectionHtml =
      descendants.length > 0
        ? `
          <div class="section-card">
            <div class="section-header">
              <h3>Subagents (${descendants.length})</h3>
              <span class="section-hint">${selected.runningSubagentCount} running</span>
            </div>
            <div class="table-wrap">
              <table class="clean-table">
                <thead>
                  <tr>
                    <th>Subagent</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th>Context</th>
                    <th>Tokens (Fresh / Out)</th>
                  </tr>
                </thead>
                <tbody>
                  ${descendants
                    .map(({ node: sub, depth }) => {
                      const subSt = nodeStatusLabel(sub);
                      const subModel = sub.model && sub.model !== 'unknown' ? sub.model : 'Unknown';
                      const subRole = sub.subagentRole || sub.agentName;
                      const subTitle = sub.title || sub.preview || 'Subagent';
                      return `
                        <tr class="clickable-row" data-action="selectSession" data-session-id="${escapeHtml(sub.id)}">
                          <td class="sub-depth-${Math.min(depth, 3)}">
                            ${subRole ? `<span class="badge role">${escapeHtml(subRole)}</span> ` : ''}
                            <span>${escapeHtml(subTitle)}</span>
                          </td>
                          <td><span class="model-pill">${escapeHtml(subModel)}</span></td>
                          <td><span class="status-pill ${subSt.cls}">${subSt.text}</span></td>
                          <td>${renderContextMeter(sub.contextUsed, sub.contextLimit, sub.contextPct)}</td>
                          <td>${formatCompactTokens(sub.own.fresh)} / ${formatCompactTokens(sub.own.output)}</td>
                        </tr>
                      `;
                    })
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>
        `
        : '';

    const chartHtml = renderSvgChart(selected.calls);

    detailsHtml = `
      <div class="detail-top-card">
        <div class="detail-header-row">
          <div class="detail-header-left">
            <button class="btn-ghost" data-action="switchTab" data-tab="overview">← Overview</button>
            <h2 class="detail-title">${escapeHtml(selected.title || 'Untitled')}</h2>
          </div>
          <button class="btn" data-action="${isPinned ? 'unpinSession' : 'pinSession'}" data-session-id="${escapeHtml(selected.id)}">
            ${isPinned ? 'Unpin' : 'Pin to Status Bar'}
          </button>
        </div>
        <div class="detail-meta-row">
          <span class="model-pill">${escapeHtml(modelLabel)}</span>
          <span class="status-pill ${st.cls}">${st.text}</span>
          ${selected.subagentCount > 0 ? `<span class="muted">${selected.subagentCount} subagents (${selected.runningSubagentCount} running)</span>` : ''}
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Context Window</div>
          <div class="kpi-value ${ctxSev}">${formatCompactTokens(selected.contextUsed)} <span class="muted">/ ${formatCompactTokens(selected.contextLimit)} (${ctxPct}%)</span></div>
          <div class="bar-track"><div class="bar-fill ${ctxSev} p-${ctxPct}"></div></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Rolled-up Usage</div>
          <div class="kpi-value">${formatCompactTokens(selected.rolledUp.fresh)} <span class="muted">fresh</span></div>
          <div class="kpi-sub">Cache ${formatCompactTokens(selected.rolledUp.cacheRead)} · Out ${formatCompactTokens(selected.rolledUp.output)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Cache Efficiency</div>
          <div class="kpi-value">${selected.cacheVolumePct.toFixed(1)}% <span class="muted">vol</span></div>
          <div class="kpi-sub">Call hit rate: ${selected.callHitPct.toFixed(1)}%</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Activity</div>
          <div class="kpi-value">${selected.rolledUp.calls} <span class="muted">calls</span></div>
          <div class="kpi-sub">${selected.rolledUp.compactions} compactions</div>
        </div>
      </div>

      <details class="breakdown-details"${breakdownOpen ? ' open' : ''}>
        <summary data-action="toggleBreakdown">Own (Parent) vs Rolled-up Breakdown</summary>
        <div class="table-wrap">
          <table class="clean-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Own (Parent)</th>
                <th>Rolled-up (Total)</th>
              </tr>
            </thead>
            <tbody>
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
                <td>Calls / Compactions</td>
                <td>${selected.own.calls} / ${selected.own.compactions}</td>
                <td>${selected.rolledUp.calls} / ${selected.rolledUp.compactions}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>

      ${subagentsSectionHtml}

      <div class="section-card">
        <div class="section-header">
          <h3>Context Growth &amp; Compactions</h3>
          <span class="section-hint">${selected.calls.length} own calls</span>
        </div>
        ${chartHtml}
        ${tokenGroupsHtml}
      </div>
    `;
  }

  const pinMissingBanner = state.pinMissing
    ? `
      <div class="alert-banner warning">
        <span>⚠️ Pinned session is missing or deleted.</span>
        <button class="btn-sm" data-action="unpinSession">Unpin</button>
      </div>
    `
    : '';

  return `
  <div class="top-bar">
    <div class="tab-group">
      <button class="tab-btn ${activeTab === 'overview' ? 'active' : ''}" data-action="switchTab" data-tab="overview">Overview</button>
      <button class="tab-btn ${activeTab === 'details' ? 'active' : ''}" data-action="switchTab" data-tab="details">Details${selected ? ` · ${escapeHtml((selected.title || 'Session').slice(0, 22))}` : ''}</button>
    </div>
    <div class="top-actions">
      <button class="btn-ghost" data-action="toggleScope">
        ${isCurrentScope ? 'Scope: Current Workspace' : 'Scope: All Workspaces'}
      </button>
      <span class="status-indicator ${quotaOnline ? 'online' : 'offline'}">● ${quotaOnline ? 'Online' : escapeHtml(quota.status)}</span>
      <button class="btn-sm" data-action="refresh">Refresh</button>
    </div>
  </div>

  ${pinMissingBanner}

  <div class="tab-view ${activeTab === 'overview' ? '' : 'hidden'}" data-tab-view="overview">
    ${quotaGridHtml}
    ${renderModelForecastSection(state.modelEstimates)}
    <div class="section-card">
      <div class="section-header">
        <h3>Sessions (${roots.length})</h3>
        <span class="section-hint">Click a session for details</span>
      </div>
      <div class="session-list">
        ${sessionsHtml}
        ${unattachedHtml}
      </div>
    </div>
  </div>

  <div class="tab-view ${activeTab === 'details' ? '' : 'hidden'}" data-tab-view="details">
    ${detailsHtml}
  </div>
`;
}

export function renderBottomPanelHtml(
  state: MonitorState,
  nonce: string,
  cspSource: string,
  uiState?: PanelUiState,
): string {
  const bodyHtml = renderBottomPanelBodyHtml(state, uiState);

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
      --card-bg: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.03));
      --fg: var(--vscode-editor-foreground, #cccccc);
      --muted-fg: var(--vscode-descriptionForeground, #8b949e);
      --border: var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      --accent: var(--vscode-charts-blue, #3794ff);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --err: var(--vscode-editorError-foreground, #f14c4c);
      --ok: var(--vscode-testing-iconPassed, #73c991);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --hover-bg: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
      --select-bg: var(--vscode-list-activeSelectionBackground, rgba(55, 148, 255, 0.16));
    }
    * { box-sizing: border-box; }
    ${PCT_WIDTH_CSS}
    .depth-0 { padding-left: 0; }
    .depth-1 { padding-left: 18px; }
    .depth-2 { padding-left: 36px; }
    .depth-3 { padding-left: 54px; }
    .sub-depth-0, .sub-depth-1 { padding-left: 8px; }
    .sub-depth-2 { padding-left: 22px; }
    .sub-depth-3 { padding-left: 36px; }
    body {
      margin: 0;
      padding: 10px 12px;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      background: var(--bg);
      color: var(--fg);
      line-height: 1.4;
    }
    .hidden { display: none !important; }
    .muted { color: var(--muted-fg); }

    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .tab-group {
      display: inline-flex;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 2px;
      gap: 2px;
    }
    .tab-btn {
      background: transparent;
      color: var(--muted-fg);
      border: none;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tab-btn.active {
      background: var(--btn-bg);
      color: var(--btn-fg);
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-indicator.online { color: var(--ok); font-weight: 500; }
    .status-indicator.offline { color: var(--err); font-weight: 500; }

    .alert-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px;
      margin-bottom: 10px;
      border-radius: 5px;
      background: rgba(204, 167, 0, 0.12);
      border: 1px solid var(--warn);
      color: var(--warn);
    }

    .quota-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 10px;
      margin-bottom: 10px;
    }
    .quota-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
    }
    .quota-card-title {
      font-weight: 600;
      margin-bottom: 8px;
      font-size: 1.02em;
    }
    .q-row { margin-bottom: 6px; }
    .q-row:last-child { margin-bottom: 0; }
    .q-row-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 3px;
    }
    .q-label { color: var(--muted-fg); font-size: 0.92em; }
    .q-val { font-weight: 600; }
    .q-val.ok { color: var(--ok); }
    .q-val.warn { color: var(--warn); }
    .q-val.err { color: var(--err); }
    .countdown { color: var(--muted-fg); font-weight: 400; font-size: 0.9em; }

    .bar-track {
      width: 100%;
      height: 5px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.08);
      overflow: hidden;
    }
    .bar-fill { height: 100%; border-radius: 3px; transition: width 0.2s ease; }
    .bar-fill.ok { background: var(--ok); }
    .bar-fill.warn { background: var(--warn); }
    .bar-fill.err { background: var(--err); }

    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 10px;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 8px;
    }
    .section-header h3 { margin: 0; font-size: 1.02em; font-weight: 600; }
    .section-hint { color: var(--muted-fg); font-size: 0.9em; }
    .empty-inline { color: var(--muted-fg); padding: 6px 0; }

    .table-wrap { overflow-x: auto; }
    .clean-table { width: 100%; border-collapse: collapse; }
    .clean-table th, .clean-table td {
      padding: 6px 8px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .clean-table th { color: var(--muted-fg); font-weight: 500; font-size: 0.92em; }
    .clean-table tr:last-child td { border-bottom: none; }
    .clickable-row { cursor: pointer; }
    .clickable-row:hover { background: var(--hover-bg); }

    .est-main { font-weight: 600; }
    .est-unit { font-weight: 400; color: var(--muted-fg); }
    .est-sub { font-size: 0.88em; color: var(--muted-fg); }
    .est-cal { font-size: 0.92em; color: var(--muted-fg); }

    .model-pill {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 0.88em;
      background: rgba(55, 148, 255, 0.14);
      color: var(--fg);
      border: 1px solid rgba(55, 148, 255, 0.25);
      white-space: nowrap;
      max-width: 190px;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: middle;
    }
    .pool-tag {
      font-size: 0.88em;
      color: var(--muted-fg);
    }

    .session-list {
      display: flex;
      flex-direction: column;
    }
    .session-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 4px;
      cursor: pointer;
    }
    .session-row:hover { background: var(--hover-bg); }
    .session-row.selected { background: var(--select-bg); }

    .session-main {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }
    .session-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .session-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .expand-btn {
      font-size: 0.85em;
      padding: 1px 5px;
      min-width: 56px;
      text-align: left;
    }
    .expand-spacer { display: inline-block; width: 56px; flex-shrink: 0; }
    .sub-arrow { color: var(--muted-fg); flex-shrink: 0; }
    .sub-group-title {
      margin-top: 8px;
      padding: 4px 8px;
      color: var(--muted-fg);
      font-weight: 600;
      font-size: 0.9em;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--muted-fg);
    }
    .dot.running { background: var(--accent); box-shadow: 0 0 6px var(--accent); }
    .dot.idle { background: var(--ok); opacity: 0.8; }
    .dot.muted { background: var(--muted-fg); opacity: 0.5; }

    .badge {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.82em;
      background: rgba(255, 255, 255, 0.1);
      flex-shrink: 0;
    }
    .badge.active-tag { background: rgba(115, 201, 145, 0.2); color: var(--ok); }
    .badge.pinned { background: rgba(204, 167, 0, 0.2); color: var(--warn); }
    .badge.role { color: var(--muted-fg); }

    .ctx-meter {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 140px;
      height: 22px;
      border-radius: 4px;
      background: rgba(20, 24, 31, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.16);
      overflow: hidden;
      flex-shrink: 0;
      vertical-align: middle;
    }
    .ctx-meter.tier-low { border-color: rgba(63, 185, 80, 0.48); }
    .ctx-meter.tier-mid { border-color: rgba(56, 139, 253, 0.55); }
    .ctx-meter.tier-warn { border-color: rgba(210, 153, 34, 0.65); }
    .ctx-meter.tier-crit { border-color: rgba(248, 81, 73, 0.75); }
    .ctx-meter-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      transition: width 0.2s ease;
    }
    .ctx-meter-fill.tier-low { background: linear-gradient(90deg, rgba(46, 160, 67, 0.55), rgba(63, 185, 80, 0.72)); }
    .ctx-meter-fill.tier-mid { background: linear-gradient(90deg, rgba(31, 111, 235, 0.55), rgba(56, 139, 253, 0.74)); }
    .ctx-meter-fill.tier-warn { background: linear-gradient(90deg, rgba(187, 128, 9, 0.62), rgba(210, 153, 34, 0.80)); }
    .ctx-meter-fill.tier-crit { background: linear-gradient(90deg, rgba(218, 54, 51, 0.68), rgba(248, 81, 73, 0.86)); }
    .ctx-meter-text {
      position: relative;
      z-index: 1;
      padding: 0 6px;
      font-variant-numeric: tabular-nums;
      font-size: 0.86em;
      font-weight: 600;
      color: #ffffff;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
      white-space: nowrap;
    }

    .status-pill {
      font-size: 0.88em;
      padding: 1px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.07);
    }
    .status-pill.running { color: var(--accent); }
    .status-pill.idle { color: var(--ok); }

    .detail-top-card {
      margin-bottom: 10px;
    }
    .detail-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .detail-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    .detail-title {
      margin: 0;
      font-size: 1.15em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-meta-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
      margin-bottom: 10px;
    }
    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 9px 11px;
    }
    .kpi-label { color: var(--muted-fg); font-size: 0.9em; margin-bottom: 4px; }
    .kpi-value { font-size: 1.12em; font-weight: 600; margin-bottom: 4px; }
    .kpi-value.warn { color: var(--warn); }
    .kpi-value.err { color: var(--err); }
    .kpi-sub { font-size: 0.88em; color: var(--muted-fg); }

    .breakdown-details {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 10px;
    }
    .breakdown-details summary {
      cursor: pointer;
      font-weight: 500;
      color: var(--muted-fg);
      user-select: none;
      padding: 2px 0;
    }
    .breakdown-details[open] summary { margin-bottom: 8px; color: var(--fg); }

    .chart-svg {
      width: 100%;
      height: 160px;
      background: rgba(0, 0, 0, 0.18);
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .token-groups { margin-top: 8px; }
    .token-groups-title { font-weight: 600; margin-bottom: 4px; font-size: 0.92em; }
    .token-groups-pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .pill {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.88em;
    }

    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn-sm {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9em;
    }
    .btn-ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 2px 7px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9em;
      white-space: nowrap;
    }
    .btn-ghost:hover { background: var(--hover-bg); }
  </style>
</head>
<body>
  <div id="panel-root">
    ${bodyHtml}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.addEventListener('click', (event) => {
      const origin = event.target instanceof Element ? event.target : event.target && event.target.parentElement;
      const target = origin ? origin.closest('[data-action]') : null;
      if (!target) return;
      const action = target.getAttribute('data-action');
      const sessionId = target.getAttribute('data-session-id');
      const tab = target.getAttribute('data-tab');

      if (action === 'toggleBreakdown') {
        event.preventDefault();
        event.stopPropagation();
        const detailsEl = target.closest('details');
        const nextOpen = detailsEl ? !detailsEl.open : true;
        if (detailsEl) detailsEl.open = nextOpen;
        vscode.postMessage({ type: 'toggleBreakdown', open: nextOpen });
      } else if (action === 'toggleExpand' && sessionId) {
        event.stopPropagation();
        vscode.postMessage({ type: 'toggleExpand', sessionId });
      } else if ((action === 'pinSession' || action === 'unpinSession')) {
        event.stopPropagation();
        if (action === 'pinSession' && sessionId) {
          vscode.postMessage({ type: 'pinSession', sessionId });
        } else {
          vscode.postMessage({ type: 'unpinSession' });
        }
      } else if (action === 'selectSession' && sessionId) {
        vscode.postMessage({ type: 'selectSession', sessionId });
      } else if (action === 'switchTab' && tab) {
        vscode.postMessage({ type: 'switchTab', tab });
      } else if (action === 'toggleScope') {
        vscode.postMessage({ type: 'toggleScope' });
      } else if (action === 'refresh') {
        vscode.postMessage({ type: 'refresh' });
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message && message.type === 'updateState') {
        const root = document.getElementById('panel-root');
        if (root && typeof message.bodyHtml === 'string') {
          const prevScroll = window.scrollY;
          root.innerHTML = message.bodyHtml;
          window.scrollTo(0, prevScroll);
        }
      }
    });
  </script>
</body>
</html>`;
}
