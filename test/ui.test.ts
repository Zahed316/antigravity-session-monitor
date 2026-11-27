import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_LIMIT,
  type CallUsagePoint,
  type ManagedAccount,
  type MonitorConfig,
  type MonitorDiagnostics,
  type MonitorState,
  type QuotaSnapshot,
  type SessionMetrics,
  type SessionNode,
  type PanelLayoutState,
} from '../src/types.ts';
import {
  formatCompactTokens,
  formatResetCountdown,
  formatResetDateTime,
  buildStatusBarViewModel,
  createStatusBarController,
  type StatusBarVscodeLike,
  type StatusBarItemLike,
} from '../src/ui/statusBar.ts';
import {
  buildQuickPickItems,
  showSessionQuickPick,
  type QuickPickEntry,
  type QuickPickVscodeLike,
} from '../src/ui/quickPick.ts';
import {
  renderBottomPanelBodyHtml,
  renderBottomPanelHtml,
  escapeHtml,
} from '../src/ui/bottomPanelHtml.ts';
import {
  BottomPanelController,
  createBottomPanelProvider,
  sanitizePanelLayout,
  type WebviewViewLike,
  type BottomPanelCallbacks,
} from '../src/ui/bottomPanelProvider.ts';

function createMetrics(partial: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    fresh: partial.fresh ?? 10_000,
    cacheRead: partial.cacheRead ?? 20_000,
    output: partial.output ?? 1_000,
    thinking: partial.thinking ?? 600,
    response: partial.response ?? 400,
    calls: partial.calls ?? 2,
    compactions: partial.compactions ?? 0,
    isRunning: partial.isRunning ?? false,
  };
}

function createCall(partial: Partial<CallUsagePoint> = {}): CallUsagePoint {
  return {
    idx: partial.idx ?? 0,
    stepIndices: partial.stepIndices ?? [1],
    model: partial.model ?? 'gemini-2.5-pro',
    fresh: partial.fresh ?? 10_000,
    cacheRead: partial.cacheRead ?? 20_000,
    output: partial.output ?? 1_000,
    thinking: partial.thinking ?? 600,
    response: partial.response ?? 400,
    effectiveContext: partial.effectiveContext ?? 30_000,
    contextLimit: partial.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
    startStepIndex: partial.startStepIndex ?? null,
    isCompacted: partial.isCompacted ?? false,
    compactedFromStep: partial.compactedFromStep ?? null,
    tokenBreakdownGroups: partial.tokenBreakdownGroups,
  };
}

function createNode(partial: Partial<SessionNode> = {}): SessionNode {
  const own = partial.own ?? createMetrics();
  const rolledUp = partial.rolledUp ?? { ...own };
  return {
    id: partial.id ?? 'session-1',
    title: partial.title ?? 'Implement Feature X',
    preview: partial.preview ?? 'Working on feature',
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
    own,
    rolledUp,
    contextUsed: partial.contextUsed ?? 120_000,
    contextLimit: partial.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
    contextPct: partial.contextPct ?? Math.round((120_000 / DEFAULT_CONTEXT_LIMIT) * 100),
    cacheVolumePct: partial.cacheVolumePct ?? 65,
    callHitPct: partial.callHitPct ?? 100,
    ownCacheVolumePct: partial.ownCacheVolumePct ?? 65,
    ownCallHitPct: partial.ownCallHitPct ?? 100,
    calls: partial.calls ?? [createCall()],
    children: partial.children ?? [],
    subagentCount: partial.subagentCount ?? 0,
    runningSubagentCount: partial.runningSubagentCount ?? 0,
    isPinned: partial.isPinned ?? false,
    isActive: partial.isActive ?? true,
    isSelected: partial.isSelected ?? false,
    dataSource: partial.dataSource ?? 'sqlite',
  };
}

function createQuota(partial: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    status: partial.status ?? 'online',
    source: partial.source ?? 'summary',
    fetchedAt: partial.fetchedAt ?? Date.now(),
    isStale: partial.isStale,
    pools: partial.pools ?? {
      gemini: {
        key: 'gemini',
        displayName: 'Gemini Models',
        fiveHour: {
          window: '5h',
          remainingPct: 85,
          remainingFraction: 0.85,
          resetTime: new Date(Date.now() + 3_600_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
        weekly: {
          window: 'weekly',
          remainingPct: 92,
          remainingFraction: 0.92,
          resetTime: new Date(Date.now() + 86_400_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
      },
      nonGoogle: {
        key: 'nonGoogle',
        displayName: 'Non-Google Models',
        fiveHour: {
          window: '5h',
          remainingPct: 40,
          remainingFraction: 0.40,
          resetTime: new Date(Date.now() + 7_200_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
        weekly: {
          window: 'weekly',
          remainingPct: 65,
          remainingFraction: 0.65,
          resetTime: new Date(Date.now() + 172_800_000).toISOString(),
          isReady: false,
          isExhausted: false,
        },
      },
    },
  };
}

function createState(partial: Partial<MonitorState> = {}): MonitorState {
  const root = createNode();
  return {
    scope: partial.scope ?? 'current',
    workspacePaths: partial.workspacePaths ?? ['/home/user/project'],
    roots: partial.roots ?? [root],
    unattachedSubagents: partial.unattachedSubagents ?? [],
    activeSession: partial.activeSession !== undefined ? partial.activeSession : root,
    selectedSession: partial.selectedSession !== undefined ? partial.selectedSession : root,
    pinnedSessionId: partial.pinnedSessionId ?? null,
    selectedSessionId: partial.selectedSessionId ?? (root ? root.id : null),
    pinMissing: partial.pinMissing ?? false,
    lastConversationId: partial.lastConversationId ?? null,
    artifactHintId: partial.artifactHintId ?? null,
    quota: partial.quota ?? createQuota(),
    hubStatus: partial.hubStatus ?? 'connected',
    hubPort: partial.hubPort ?? 42100,
    hubSource: partial.hubSource ?? 'exports',
    sqliteBackend: partial.sqliteBackend ?? 'node:sqlite',
    lastUpdatedAt: partial.lastUpdatedAt ?? Date.now(),
    isRefreshing: partial.isRefreshing ?? false,
    lastError: partial.lastError ?? null,
    warnings: partial.warnings ?? [],
    modelCatalog: partial.modelCatalog,
    activeAccount: partial.activeAccount,
    accounts: partial.accounts,
    accountSnapshots: partial.accountSnapshots,
    accountHistory: partial.accountHistory,
    diagnostics: partial.diagnostics,
  };
}

// ============================================================================
// 1. Status Bar & Hover Tooltip Tests
// ============================================================================

test('formatCompactTokens formats token counts compactly across ranges', () => {
  assert.equal(formatCompactTokens(0), '0');
  assert.equal(formatCompactTokens(950), '950');
  assert.equal(formatCompactTokens(12_400), '12.4k');
  assert.equal(formatCompactTokens(256_000), '256k');
  assert.equal(formatCompactTokens(1_200_000), '1.2M');
});

test('formatResetDateTime formats ISO dates into local month, day, hour and minute', () => {
  assert.equal(formatResetDateTime(null), null);
  assert.equal(formatResetDateTime('not-a-date'), null);
  const sample = new Date(2026, 10, 15, 21, 30).toISOString();
  const formatted = formatResetDateTime(sample);
  assert.ok(formatted !== null);
  assert.match(formatted!, /Nov 15, \d{2}:\d{2}/);
});

test('buildStatusBarViewModel: active workspace session formatting, icons, and thresholds', () => {
  const config: MonitorConfig = { ...DEFAULT_CONFIG, contextWarningPct: 75, contextCriticalPct: 90 };

  // Normal running pinned session
  const active = createNode({
    title: 'SuperLongTitleThatExceedsNormalLengthLimitForDisplay',
    contextUsed: 120_000,
    contextLimit: 256_000,
    contextPct: 47,
    cacheVolumePct: 65,
    rolledUp: createMetrics({ isRunning: true }),
  });
  const state = createState({
    activeSession: active,
    pinnedSessionId: active.id,
    pinMissing: false,
  });

  const vm = buildStatusBarViewModel(state, config);

  // Consolidated single status bar item contains pin, spin icon, context %, and 3 quota pools
  assert.match(vm.text, /\$\(pin\)/);
  assert.match(vm.text, /\$\(sync~spin\)/);
  assert.match(vm.text, /47%/);
  assert.match(vm.text, /G 85%/);
  assert.match(vm.text, /C 40%/);
  assert.equal(vm.color, 'normal');

  // Warning threshold test (>= 75%)
  active.contextUsed = 195_000;
  active.contextPct = 76;
  const vmWarn = buildStatusBarViewModel(state, config);
  assert.equal(vmWarn.color, 'warning');

  // Error/critical threshold test (>= 90%)
  active.contextUsed = 240_000;
  active.contextPct = 94;
  const vmCrit = buildStatusBarViewModel(state, config);
  assert.equal(vmCrit.color, 'error');
});

test('buildStatusBarViewModel: Review Focus #5 missing pin shows $(pin) Missing — Click to unpin', () => {
  const state = createState({
    activeSession: createNode(),
    pinnedSessionId: 'deleted-session-id',
    pinMissing: true,
  });
  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.equal(vm.text, '$(pin) Missing — Click to unpin');
  assert.equal(vm.color, 'warning');
});

test('buildStatusBarViewModel: empty workspace returns $(pulse) No session + quota summary', () => {
  const state = createState({
    activeSession: null,
    pinnedSessionId: null,
    pinMissing: false,
  });
  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.match(vm.text, /^\$\(pulse\) No session · /);
  assert.match(vm.text, /G 85%/);
  assert.equal(vm.color, 'normal');
});

test('buildStatusBarViewModel: quota text and warning/error thresholds', () => {
  const state = createState();

  // Online with normal pools (Gemini 85%, Non-Google 40%)
  const vmOnline = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.match(vmOnline.text, /G 85% · C 40%/);
  assert.equal(vmOnline.color, 'normal');

  // Quota offline
  state.quota.status = 'offline';
  const vmOffline = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.match(vmOffline.text, /Quota offline/);
  assert.equal(vmOffline.color, 'normal');

  // Quota warning when min pool <= 20%
  state.quota.status = 'online';
  state.quota.pools.gemini.fiveHour!.remainingPct = 18;
  const vmWarn = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.equal(vmWarn.color, 'warning');

  // Quota error when min pool <= 0%
  state.quota.pools.gemini.fiveHour!.remainingPct = 0;
  state.quota.pools.gemini.fiveHour!.isExhausted = true;
  const vmCrit = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.equal(vmCrit.color, 'error');
});

test('status bar marks quota stale with a clock glyph and keeps the numbers', () => {
  const state = createState({ quota: createQuota({ isStale: true }) });
  const fresh = createState({ quota: createQuota() });
  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  const expected = buildStatusBarViewModel(fresh, DEFAULT_CONFIG).text.replace(' · G ', ' · $(clock) G ');
  assert.strictEqual(vm.text, expected);
  assert.match(vm.text, /\$\(clock\) G 85% · C 40%$/);
  assert.match(vm.tooltipMarkdown, /stale/i);
});

test('status bar and panel render <1% for a sub-1% window instead of 0%', () => {
  const quota = createQuota();
  quota.pools.gemini.fiveHour = {
    ...quota.pools.gemini.fiveHour!,
    remainingPct: 0,
    remainingFraction: 0.004,
    isReady: true,
    isExhausted: false,
  };
  const state = createState({ quota });

  assert.match(buildStatusBarViewModel(state, DEFAULT_CONFIG).text, /G <1%/);
  assert.match(buildStatusBarViewModel(state, DEFAULT_CONFIG).tooltipMarkdown, /<1% \(Ready/);
  assert.match(renderBottomPanelHtml(state, 'n', 'csp'), /&lt;1% <span class="countdown">\(Ready\)/);
});

test('status bar and panel render 0% for an exhausted window even with a stray fraction', () => {
  const quota = createQuota();
  quota.pools.gemini.fiveHour = {
    ...quota.pools.gemini.fiveHour!,
    remainingPct: 0,
    remainingFraction: 0.004,
    isExhausted: true,
  };
  const state = createState({ quota });

  assert.match(buildStatusBarViewModel(state, DEFAULT_CONFIG).text, /G 0%/);
  assert.ok(!buildStatusBarViewModel(state, DEFAULT_CONFIG).text.includes('<1%'));
  assert.ok(!renderBottomPanelHtml(state, 'n', 'csp').includes('&lt;1%'));
});

test('panel notes stale quota with the last successful fetch above the grid', () => {
  // An hour ago: inside the <12h stale window, so the rendered time stays date-independent.
  const fetchedAt = Date.now() - 3_600_000;
  const state = createState({ quota: createQuota({ isStale: true, fetchedAt }) });
  const html = renderBottomPanelHtml(state, 'n', 'csp');
  const lastFetched = new Date(fetchedAt).toLocaleTimeString();
  assert.match(html, /class="section-hint">Stale — last successful fetch /);
  assert.ok(html.includes(`Stale — last successful fetch ${lastFetched}`));
  assert.match(html, /class="quota-grid"/);
});

test('panel badge reads Stale, not Online, for a kept stale snapshot', () => {
  const stale = renderBottomPanelHtml(createState({ quota: createQuota({ isStale: true }) }), 'n', 'csp');
  const fresh = renderBottomPanelHtml(createState({ quota: createQuota() }), 'n', 'csp');

  assert.match(stale, /<span class="status-indicator warn">● Stale<\/span>/);
  assert.ok(!/status-indicator (online|offline)">● Online/.test(stale), 'stale quota must not claim Online');
  assert.match(fresh, /<span class="status-indicator online">● Online<\/span>/);
});

test('stale quota older than 12h shows the fetch date, a fresh one shows only the time', () => {
  const now = Date.now();
  const old = buildStatusBarViewModel(
    createState({ quota: createQuota({ isStale: true, fetchedAt: now - 26 * 3_600_000 }) }),
    DEFAULT_CONFIG,
  ).tooltipMarkdown;
  const recentFetchedAt = now - 3_600_000;
  const recent = buildStatusBarViewModel(
    createState({ quota: createQuota({ isStale: true, fetchedAt: recentFetchedAt }) }),
    DEFAULT_CONFIG,
  ).tooltipMarkdown;

  assert.match(old, /last successful fetch \w{3} \d{1,2}, \d{2}:\d{2}/);
  assert.ok(!old.includes(`last successful fetch ${new Date(now - 26 * 3_600_000).toLocaleTimeString()}`));
  assert.ok(recent.includes(`last successful fetch ${new Date(recentFetchedAt).toLocaleTimeString()}`));
});

test('buildStatusBarViewModel: minimal tooltip includes model, subagent model summary, and quota pools without escaping backticks', () => {
  const child = createNode({
    id: 'subagent-1',
    title: 'Research subagent <script>alert(1)</script>',
    isSubagent: true,
    parentId: 'root-1',
    model: 'Gemini 3.8 Flash',
    rawModel: 'MODEL_PLACEHOLDER_M400',
    agentName: 'researcher',
    subagentRole: 'Code Researcher',
    own: createMetrics({ fresh: 5_000, cacheRead: 15_000, output: 800, thinking: 500, response: 300, calls: 3 }),
  });
  const parent = createNode({
    id: 'root-1',
    title: 'Parent Session & "Untrusted" <Tags>',
    model: 'Claude Opus 4.6 (Thinking)',
    rawModel: 'claude-opus-4-6-thinking',
    children: [child],
    subagentCount: 1,
    runningSubagentCount: 1,
    own: createMetrics({ fresh: 10_000, cacheRead: 20_000, output: 1_000, thinking: 600, response: 400, calls: 2 }),
    rolledUp: createMetrics({ fresh: 15_000, cacheRead: 35_000, output: 1_800, thinking: 1_100, response: 700, calls: 5, isRunning: true }),
  });

  const state = createState({
    activeSession: parent,
    quota: createQuota({
      pools: {
        gemini: {
          key: 'gemini',
          displayName: 'Gemini Models',
          fiveHour: {
            window: '5h',
            remainingPct: 100,
            remainingFraction: 1.0,
            resetTime: null,
            isReady: true,
            isExhausted: false,
          },
          weekly: null,
        },
        nonGoogle: {
          key: 'nonGoogle',
          displayName: 'Non-Google Models',
          fiveHour: {
            window: '5h',
            remainingPct: 50,
            remainingFraction: 0.5,
            resetTime: new Date(Date.now() + 3600000).toISOString(),
            isReady: false,
            isExhausted: false,
          },
          weekly: null,
        },
      },
    }),
  });

  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);

  // Escaping untrusted strings & zero underscore-backslash escaping inside backticks
  assert.ok(!vm.tooltipMarkdown.includes('<Tags>'), 'Untrusted tags should be escaped');
  assert.ok(!vm.tooltipMarkdown.includes('\\_'), 'Must not backslash-escape underscores in model names');
  assert.match(vm.tooltipMarkdown, /\*\*Session:\*\*/);
  assert.match(vm.tooltipMarkdown, /\*\*Model:\*\* Claude Opus 4\.6 \(Thinking\)/);
  assert.match(vm.tooltipMarkdown, /\*\*Subagents:\*\* 1 \(1 running\) — 1× Gemini 3\.8 Flash/);
  assert.match(vm.tooltipMarkdown, /\| Pool \| 5-Hour \| Weekly \|/);
  assert.match(vm.tooltipMarkdown, /Ready/);
  assert.match(vm.tooltipMarkdown, /\*Click for sessions & overview\*/);
});

test('createStatusBarController wires single consolidated item with ThemeColor and MarkdownString', () => {
  let createdCount = 0;
  const items: any[] = [];

  class MockStatusBarItem implements StatusBarItemLike {
    text = '';
    tooltip: any = '';
    command?: string;
    backgroundColor?: any;
    visible = false;
    disposed = false;
    show() { this.visible = true; }
    hide() { this.visible = false; }
    dispose() { this.disposed = true; }
  }

  class MockMarkdownString {
    value: string;
    isTrusted = false;
    supportThemeIcons = false;
    constructor(val = '') { this.value = val; }
    appendMarkdown(val: string) { this.value += val; }
  }

  class MockThemeColor {
    id: string;
    constructor(id: string) { this.id = id; }
  }

  const mockVscode: StatusBarVscodeLike = {
    window: {
      createStatusBarItem: (_alignment?: any, _priority?: number) => {
        createdCount++;
        const it = new MockStatusBarItem();
        items.push(it);
        return it;
      },
    },
    MarkdownString: MockMarkdownString as any,
    ThemeColor: MockThemeColor as any,
  };

  const ctrl = createStatusBarController(mockVscode, 'cmd.click');
  assert.equal(createdCount, 1);
  assert.equal(items[0].command, 'cmd.click');

  const state = createState({
    pinMissing: true,
  });
  ctrl.update(state, DEFAULT_CONFIG);

  assert.equal(items[0].text, '$(pin) Missing — Click to unpin');
  assert.equal(items[0].backgroundColor?.id, 'statusBarItem.warningBackground');
  assert.equal(items[0].tooltip?.isTrusted, true);
  assert.equal(items[0].tooltip?.supportThemeIcons, true);

  ctrl.dispose();
  assert.equal(items[0].disposed, true);
});

// ============================================================================
// 2. QuickPick Tests
// ============================================================================

test('buildQuickPickItems: includes Unpin entry, Scope toggle, and recursive indented subagents', () => {
  const childLevel2 = createNode({
    id: 'subagent-deep',
    title: 'Deep subagent task',
    isSubagent: true,
    parentId: 'subagent-1',
    subagentRole: 'Architect',
    nestingDepth: 2,
    contextUsed: 30_000,
    contextLimit: 256_000,
  });
  const childLevel1 = createNode({
    id: 'subagent-1',
    title: 'Child subagent task',
    isSubagent: true,
    parentId: 'root-1',
    subagentRole: 'Implementer',
    nestingDepth: 1,
    children: [childLevel2],
    subagentCount: 1,
    contextUsed: 60_000,
    contextLimit: 256_000,
  });
  const root = createNode({
    id: 'root-1',
    title: 'Root session task',
    children: [childLevel1],
    subagentCount: 2,
    matchesWorkspace: true,
  });

  const state = createState({
    roots: [root],
    pinnedSessionId: 'root-1',
    pinMissing: false,
    scope: 'current',
  });

  const items = buildQuickPickItems(state);

  // First item is Open Monitor Panel
  assert.equal(items[0].action, 'openPanel');
  assert.match(items[0].label, /Open Monitor Panel/);

  // Second item is Unpin
  assert.equal(items[1].action, 'unpin');
  assert.match(items[1].label, /Unpin/);

  // Third item is Scope toggle
  assert.equal(items[2].action, 'toggleScope');
  assert.match(items[2].label, /Current Workspace/);

  // Find root item and child items
  const rootItem = items.find(it => it.sessionId === 'root-1');
  assert.ok(rootItem);
  assert.match(rootItem.label, /Root session task/);
  assert.ok(rootItem.buttons && rootItem.buttons.length >= 2, 'Root item has Pin and Inspect buttons');

  const child1Item = items.find(it => it.sessionId === 'subagent-1');
  assert.ok(child1Item);
  assert.match(child1Item.label, /↳ \[Implementer\] Child subagent task/);

  const child2Item = items.find(it => it.sessionId === 'subagent-deep');
  assert.ok(child2Item);
  assert.match(child2Item.label, /↳ \[Architect\] Deep subagent task/);
});

test('showSessionQuickPick wires onDidTriggerItemButton and onDidAccept without mutating status bar unless pinned', async () => {
  let acceptedCallback: (() => void) | null = null;
  let buttonCallback: ((e: any) => void) | null = null;
  let shown = false;
  let hidden = false;
  let disposed = false;

  const mockQp = {
    title: '',
    placeholder: '',
    items: [] as QuickPickEntry[],
    selectedItems: [] as QuickPickEntry[],
    onDidAccept(cb: () => void) { acceptedCallback = cb; return { dispose() {} }; },
    onDidTriggerItemButton(cb: (e: any) => void) { buttonCallback = cb; return { dispose() {} }; },
    onDidHide(cb: () => void) { return { dispose() {} }; },
    show() { shown = true; },
    hide() { hidden = true; },
    dispose() { disposed = true; },
  };

  const mockVscode: QuickPickVscodeLike = {
    window: {
      createQuickPick: () => mockQp as any,
    },
  };

  const state = createState({ pinnedSessionId: 'root-1' });
  const inspectedIds: string[] = [];
  const pinnedIds: string[] = [];
  let unpinned = false;
  let toggledScope = false;

  await showSessionQuickPick(mockVscode, state, {
    onInspect: (id) => inspectedIds.push(id),
    onPin: (id) => pinnedIds.push(id),
    onUnpin: () => { unpinned = true; },
    onToggleScope: () => { toggledScope = true; },
  });

  assert.equal(shown, true);
  assert.ok(mockQp.items.length > 0);

  // Accept session item -> triggers onInspect (NOT onPin)
  const sessionItem = mockQp.items.find(it => it.action === 'session');
  assert.ok(sessionItem);
  mockQp.selectedItems = [sessionItem];
  acceptedCallback!();
  assert.equal(inspectedIds.length, 1);
  assert.equal(inspectedIds[0], sessionItem.sessionId);
  assert.equal(pinnedIds.length, 0, 'Accepting a session inspects without pinning');

  // Trigger Pin button -> calls onPin
  buttonCallback!({ button: { id: 'pin' }, item: sessionItem });
  assert.equal(pinnedIds.length, 1);
  assert.equal(pinnedIds[0], sessionItem.sessionId);

  // Trigger unpin action
  const unpinItem = mockQp.items.find(it => it.action === 'unpin');
  assert.ok(unpinItem);
  mockQp.selectedItems = [unpinItem];
  acceptedCallback!();
  assert.equal(unpinned, true);
});

test('showSessionQuickPick wraps button iconPath with new vscodeApi.ThemeIcon when ThemeIcon constructor is provided', async () => {
  const mockQp = {
    title: '',
    placeholder: '',
    items: [] as QuickPickEntry[],
    selectedItems: [] as QuickPickEntry[],
    onDidAccept() { return { dispose() {} }; },
    onDidTriggerItemButton() { return { dispose() {} }; },
    onDidHide() { return { dispose() {} }; },
    show() {},
    hide() {},
    dispose() {},
  };

  class MockThemeIcon {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  }

  const mockVscode: QuickPickVscodeLike = {
    window: {
      createQuickPick: () => mockQp as any,
    },
    ThemeIcon: MockThemeIcon,
  };

  const state = createState();
  await showSessionQuickPick(mockVscode, state, {
    onInspect: () => {},
    onPin: () => {},
    onUnpin: () => {},
    onToggleScope: () => {},
  });

  const sessionItem = mockQp.items.find((it) => it.action === 'session' && it.buttons && it.buttons.length > 0);
  assert.ok(sessionItem && sessionItem.buttons);
  assert.ok(sessionItem.buttons[0].iconPath instanceof MockThemeIcon);
  assert.strictEqual((sessionItem.buttons[0].iconPath as MockThemeIcon).id, 'pin');
  assert.ok(sessionItem.buttons[1].iconPath instanceof MockThemeIcon);
  assert.strictEqual((sessionItem.buttons[1].iconPath as MockThemeIcon).id, 'layout-panel');
});

test('Minor #2: scope current filters unattachedSubagents and includes pinned subagent root', () => {
  // 1. Root in other workspace with a child subagent that is pinned
  const childSubagent = createNode({
    id: 'pinned-child-subagent',
    title: 'Pinned Child in other workspace',
    matchesWorkspace: false,
    workspaceUris: ['file:///workspace/other'],
  });
  const otherRoot = createNode({
    id: 'other-root',
    title: 'Other Workspace Root',
    matchesWorkspace: false,
    workspaceUris: ['file:///workspace/other'],
    children: [childSubagent],
  });

  // 2. Unattached subagents
  const unattachedWorkspace = createNode({
    id: 'unattached-ws',
    title: 'Unattached in WS',
    matchesWorkspace: true,
    workspaceUris: ['file:///workspace/current'],
  });
  const unattachedNoUris = createNode({
    id: 'unattached-nouris',
    title: 'Unattached no URIs',
    matchesWorkspace: false,
    workspaceUris: [],
  });
  const unattachedOther = createNode({
    id: 'unattached-other',
    title: 'Unattached other WS',
    matchesWorkspace: false,
    workspaceUris: ['file:///workspace/other'],
  });
  const unattachedPinned = createNode({
    id: 'unattached-pinned',
    title: 'Unattached Pinned',
    matchesWorkspace: false,
    workspaceUris: ['file:///workspace/other'],
  });

  const state = createState({
    roots: [otherRoot],
    unattachedSubagents: [unattachedWorkspace, unattachedNoUris, unattachedOther, unattachedPinned],
    pinnedSessionId: 'pinned-child-subagent',
    scope: 'current',
  });

  // Test buildQuickPickItems
  const qpItems = buildQuickPickItems(state);
  const qpIds = qpItems.map((it) => it.sessionId).filter(Boolean);
  assert.ok(qpIds.includes('other-root'), 'Root ancestor of pinned child subagent is included in current scope');
  assert.ok(qpIds.includes('pinned-child-subagent'), 'Pinned child subagent is included');
  assert.ok(qpIds.includes('unattached-ws'), 'Workspace unattached included');
  assert.ok(qpIds.includes('unattached-nouris'), 'Zero-URI unattached included');
  assert.ok(!qpIds.includes('unattached-other'), 'Non-matching unattached excluded');

  // Test renderBottomPanelBodyHtml
  const bodyHtml = renderBottomPanelBodyHtml(state);
  assert.ok(bodyHtml.includes('Other Workspace Root'), 'Body HTML includes root of pinned subagent');
  assert.ok(bodyHtml.includes('Unattached in WS'), 'Body HTML includes matching unattached');
  assert.ok(bodyHtml.includes('Unattached no URIs'), 'Body HTML includes zero-URI unattached');
  assert.ok(!bodyHtml.includes('Unattached other WS'), 'Body HTML excludes other unattached');
});

// ============================================================================
// 3. Bottom Panel HTML & SVG Tests
// ============================================================================

test('renderBottomPanelHtml: strict CSP, XSS safety, quota strip, tree, detail card, and SVG chart', () => {
  const nonce = 'testnonce123';
  const cspSource = 'vscode-webview:';

  const compactedCall = createCall({
    idx: 1,
    isCompacted: true,
    compactedFromStep: 14,
    effectiveContext: 45_000,
    contextLimit: 256_000,
    tokenBreakdownGroups: [
      { name: 'System Prompt', tokens: 5_000 },
      { name: 'Conversation', tokens: 40_000 },
    ],
  });

  const childSession = createNode({
    id: 'xss-child',
    isSubagent: true,
    parentId: 'xss-session',
    title: 'Subagent Research',
    model: 'Gemini 3.8 Flash',
    rawModel: 'MODEL_PLACEHOLDER_M400',
    subagentRole: 'Researcher',
    own: createMetrics({ calls: 2, fresh: 2_000, cacheRead: 8_000, output: 300 }),
  });

  const session = createNode({
    id: 'xss-session',
    title: '<script>alert("xss")</script> & "Dangerous"',
    model: 'Claude Opus 4.6 (Thinking)',
    rawModel: 'claude-opus-4-6-thinking',
    agentName: '<img src=x onerror=alert(1)>',
    subagentRole: '<b>Hacker</b>',
    children: [childSession],
    subagentCount: 1,
    calls: [createCall({ idx: 0, effectiveContext: 30_000 }), compactedCall],
  });

  const state = createState({
    roots: [session],
    unattachedSubagents: [createNode({ id: 'loose-1', isSubagent: true, parentId: null, title: 'Loose Subagent' })],
    selectedSession: session,
    selectedSessionId: session.id,
    pinMissing: true,
  });

  const html = renderBottomPanelHtml(state, nonce, cspSource, {
    activeTab: 'overview',
    expandedIds: ['xss-session'],
  });

  // 1. Strict CSP
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /nonce-testnonce123/);
  assert.ok(!html.includes('https://cdn'), 'Zero external CDN scripts allowed');

  // 2. XSS safety
  assert.ok(!html.includes('<script>alert("xss")</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.match(html, /&lt;script&gt;alert/);

  // 3. Pin Missing banner
  assert.match(html, /Pinned session is missing/);

  // 4. Quota strip (2 pools: Gemini, Non-Google)
  assert.match(html, /Gemini/);
  assert.match(html, /Non-Google/);

  // 5. Overview shows quota, sessions, and unattached sections without a forecast + CSP-safe bars & ctx-meter
  assert.ok(!html.includes('Model Usage Forecast'), 'forecast section removed');
  assert.match(html, /data-section-id="quota"/);
  assert.match(html, /data-section-id="sessions"/);
  assert.match(html, /data-section-id="unattached"/);
  assert.match(html, /Gemini 3\.8 Flash/);
  assert.match(html, /bar-fill ok p-85/);  assert.match(html, /bar-fill ok p-40/);
  assert.match(html, /class="ctx-meter /);
  assert.match(html, /class="ctx-meter-fill /);
  assert.match(html, /class="ctx-meter-text">/);
  assert.ok(!html.includes('style="'), 'Must not emit inline style attributes blocked by strict CSP');

  // 6. Help buttons, explanation boxes, and next reset date/time display
  assert.match(html, /class="help-btn"/);
  assert.match(html, /data-help-id="quota-pools"/);
  assert.match(html, /data-help-id="sessions"/);
  assert.match(html, /id="help-box-quota-pools"/);
  assert.ok(!html.includes('model-forecast'), 'forecast help entry removed');
  assert.match(html, /q-reset-time/);
  assert.match(html, /Next reset/);

  // Open help in Overview tab renders active button and visible help box
  const openHelpOverview = renderBottomPanelHtml(state, nonce, cspSource, {
    activeTab: 'overview',
    openHelpIds: ['quota-pools'],
  });
  assert.match(openHelpOverview, /<button class="help-btn active" data-action="toggleHelp" data-help-id="quota-pools"/);
  assert.match(openHelpOverview, /<div id="help-box-quota-pools" class="help-box">/);

  // 7. Details tab renders SVG Chart with compaction marker & subagents table & breakdown open state
  const detailsHtml = renderBottomPanelHtml(state, nonce, cspSource, {
    activeTab: 'details',
    expandedIds: ['xss-session'],
    breakdownOpen: true,
  });
  assert.match(detailsHtml, /<svg/);
  assert.match(detailsHtml, /stroke-dasharray/);
  assert.match(detailsHtml, /Compaction/);
  assert.match(detailsHtml, /14/);
  assert.match(detailsHtml, /Gemini 3\.8 Flash/);
  assert.match(detailsHtml, /<details class="breakdown-details" open>/);
  assert.match(detailsHtml, /data-help-id="session-kpis"/);
  assert.match(detailsHtml, /data-help-id="breakdown"/);
  assert.match(detailsHtml, /data-help-id="subagents"/);
  assert.match(detailsHtml, /data-help-id="context-growth"/);

  // 8. renderBottomPanelBodyHtml and DOM root wrapper
  const bodyHtml = renderBottomPanelBodyHtml(state);
  assert.ok(!bodyHtml.includes('<!DOCTYPE html>'));
  assert.ok(renderBottomPanelHtml(state, nonce, cspSource).includes(`<div id="panel-root">\n    ${bodyHtml}\n  </div>`));
  assert.match(html, /root\.innerHTML\s*=\s*message\.bodyHtml/);
  assert.match(html, /document\.getElementById\('panel-root'\)/);
});

// ============================================================================
// 3b. Capped session/agent lists (5 recent + show-more toggle)
// ============================================================================

function manyRoots(count: number, prefix = 'Root'): SessionNode[] {
  return Array.from({ length: count }, (_, i) =>
    createNode({ id: `${prefix.toLowerCase()}-${i + 1}`, title: `${prefix} ${i + 1}` }),
  );
}

function sectionHtml(bodyHtml: string, id: string): string {
  // Anchor on the outer card tag. `data-section-id` also appears in each header, so delimit by
  // card boundaries only.
  const at = bodyHtml.indexOf(`data-section-id="${id}" data-tab-id="`);
  assert.notEqual(at, -1, `section ${id} renders`);
  const cardStart = bodyHtml.lastIndexOf('<div class="section-card', at);
  // Skip this card's own drag attribute, then find the next card's tag.
  const ownDrag = bodyHtml.indexOf('data-drag-type="section"', at);
  const nextDrag = bodyHtml.indexOf('data-drag-type="section"', ownDrag + 1);
  const nextCardStart = nextDrag === -1 ? bodyHtml.length : bodyHtml.lastIndexOf('<div class="section-card', nextDrag);
  // The last overview card is followed by the Details tab, which has its own tables.
  const detailsStart = bodyHtml.indexOf('data-tab-view="details"');
  const end = detailsStart === -1 ? nextCardStart : Math.min(nextCardStart, detailsStart);
  return bodyHtml.slice(cardStart, end);
}

function countSessionRows(html: string): number {
  return (html.match(/class="session-row[ "]/g) ?? []).length;
}

test('renderBottomPanelBodyHtml: sessions list caps at 5 recent roots with a More toggle', () => {
  const roots = manyRoots(7);
  const state = createState({ roots, selectedSession: roots[0], activeSession: roots[0] });

  const bodyHtml = renderBottomPanelBodyHtml(state);
  const sessions = sectionHtml(bodyHtml, 'sessions');

  assert.equal(countSessionRows(sessions), 5, 'collapsed sessions list renders exactly 5 rows');
  assert.match(sessions, /Sessions \(7\)/, 'section title still shows the total count');
  assert.match(sessions, /data-action="toggleListExpand" data-list="sessions"/);
  assert.match(sessions, />More \(7\)</);
  assert.ok(sessions.includes('Root 1'), 'newest root kept');
  assert.ok(!sessions.includes('Root 6'), '6th root hidden when collapsed');
  assert.ok(!sessions.includes('Root 7'), '7th root hidden when collapsed');
});

test('renderBottomPanelBodyHtml: expandedLists sessions renders all roots with a Less toggle', () => {
  const roots = manyRoots(7);
  const state = createState({ roots, selectedSession: roots[0], activeSession: roots[0] });

  const sessions = sectionHtml(renderBottomPanelBodyHtml(state, { expandedLists: ['sessions'] }), 'sessions');

  assert.equal(countSessionRows(sessions), 7, 'expanded sessions list renders every root');
  assert.ok(sessions.includes('Root 6') && sessions.includes('Root 7'));
  assert.match(sessions, /data-action="toggleListExpand" data-list="sessions"/);
  assert.match(sessions, />Less</);
  assert.ok(!sessions.includes('More (7)'), 'expanded list shows Less, not More');
});

test('renderBottomPanelBodyHtml: unattached subagents cap independently of the sessions toggle', () => {
  const roots = manyRoots(7);
  const unattached = manyRoots(6, 'Loose');
  const state = createState({ roots, unattachedSubagents: unattached, selectedSession: roots[0], activeSession: roots[0] });

  const collapsed = renderBottomPanelBodyHtml(state);
  assert.equal(countSessionRows(sectionHtml(collapsed, 'sessions')), 5);
  const collapsedUnattached = sectionHtml(collapsed, 'unattached');
  assert.equal(countSessionRows(collapsedUnattached), 5, 'collapsed unattached list renders exactly 5 rows');
  assert.match(collapsedUnattached, /data-action="toggleListExpand" data-list="unattached"/);
  assert.match(collapsedUnattached, />More \(6\)</);
  assert.ok(!collapsedUnattached.includes('Loose 6'), '6th unattached hidden when collapsed');

  // Expanding sessions must not expand unattached.
  const sessionsOnly = renderBottomPanelBodyHtml(state, { expandedLists: ['sessions'] });
  assert.equal(countSessionRows(sectionHtml(sessionsOnly, 'sessions')), 7);
  const sessionsOnlyUnattached = sectionHtml(sessionsOnly, 'unattached');
  assert.equal(countSessionRows(sessionsOnlyUnattached), 5, 'unattached stays capped');
  assert.match(sessionsOnlyUnattached, />More \(6\)</);

  // And the reverse.
  const unattachedOnly = renderBottomPanelBodyHtml(state, { expandedLists: ['unattached'] });
  assert.equal(countSessionRows(sectionHtml(unattachedOnly, 'sessions')), 5, 'sessions stays capped');
  assert.equal(countSessionRows(sectionHtml(unattachedOnly, 'unattached')), 6);
  assert.match(sectionHtml(unattachedOnly, 'unattached'), />Less</);
});

test('renderBottomPanelBodyHtml: a pinned session outside the newest 5 stays visible', () => {
  const roots = manyRoots(8);
  // Pin the oldest: it is not in the newest 5 and would normally be sliced away.
  const state = createState({
    roots,
    pinnedSessionId: roots[7].id,
    activeSession: roots[0],
    selectedSession: roots[0],
  });

  const sessions = sectionHtml(renderBottomPanelBodyHtml(state), 'sessions');
  assert.equal(countSessionRows(sessions), 6, 'newest 5 plus the pinned outsider');
  assert.ok(sessions.includes('Root 8'), 'pinned session rendered despite being oldest');
  assert.ok(!sessions.includes('Root 7'), 'non-pinned outsider still hidden');
});

test('sanitizePanelLayout: default overview order puts sessions immediately after quota', () => {
  const order = sanitizePanelLayout().sectionOrder.overview;
  assert.deepEqual(order, ['quota', 'sessions', 'unattached']);
  assert.equal(order.indexOf('sessions'), order.indexOf('quota') + 1);
});

// ============================================================================
// 4. BottomPanelController & Provider Tests
// ============================================================================

test('renderBottomPanelBodyHtml: the top bar exposes a settings button that posts openSettings', () => {
  const html = renderBottomPanelBodyHtml(createState());
  assert.match(html, /data-action="openSettings"/, 'settings affordance present');
  assert.match(html, /aria-label="Extension settings"/);
  // The click handler ships in the document script, not the body fragment: check the full page.
  const page = renderBottomPanelHtml(createState(), 'nonce', 'vscode-webview:');
  assert.match(page, /vscode\.postMessage\(\{ type: 'openSettings' \}\)/, 'button is wired to a message, not a dead link');
});

test('BottomPanelController: settings button and layout reset reach their callbacks', () => {
  let msgListener: ((msg: any) => void) | null = null;
  let settingsOpened = 0;
  let savedLayout: PanelLayoutState | null = null;
  const mockView: WebviewViewLike = {
    visible: true,
    webview: {
      html: '',
      postMessage: () => true,
      onDidReceiveMessage: (cb: (msg: any) => void) => {
        msgListener = cb;
        return { dispose() {} };
      },
      cspSource: 'vscode-webview:',
    } as any,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };

  const ctrl = new BottomPanelController({
    onSelectSession: () => {},
    onPinSession: () => {},
    onUnpinSession: () => {},
    onToggleScope: () => {},
    onRefresh: () => {},
    onOpenSettings: () => {
      settingsOpened++;
    },
    initialLayout: { sectionOrder: { overview: ['sessions', 'quota', 'unattached'] } } as any,
    onLayoutChange: (layout) => {
      savedLayout = layout;
    },
  });
  ctrl.setView(mockView);
  ctrl.update(createState());

  msgListener!({ type: 'openSettings' });
  assert.equal(settingsOpened, 1, 'settings message reaches the extension');

  // A dragged order must survive until an explicit reset.
  assert.deepEqual(ctrl.getLayout().sectionOrder.overview, ['sessions', 'quota', 'unattached']);

  ctrl.resetLayout();
  assert.deepEqual(
    ctrl.getLayout().sectionOrder.overview,
    ['quota', 'sessions', 'unattached'],
    'reset restores the default order',
  );
  assert.deepEqual(savedLayout!.sectionOrder.overview, ['quota', 'sessions', 'unattached'], 'reset is persisted');
});

test('BottomPanelController: becoming visible refreshes an out-of-date quota instead of repainting it', () => {
  // Switching away to the terminal and back must not show the quota as it was when the
  // view was hidden: hidden updates are dropped, so the cached state is the old one.
  let visibilityListener: (() => void) | null = null;
  const mockView: WebviewViewLike = {
    visible: true,
    webview: {
      html: '',
      postMessage: () => true,
      onDidReceiveMessage: () => ({ dispose() {} }),
      cspSource: 'vscode-webview:',
    } as any,
    onDidChangeVisibility(cb: () => void) {
      visibilityListener = cb;
      return { dispose() {} };
    },
    onDidDispose: () => ({ dispose() {} }),
  };

  let visibleRefreshes = 0;
  const ctrl = new BottomPanelController({
    onSelectSession: () => {},
    onPinSession: () => {},
    onUnpinSession: () => {},
    onToggleScope: () => {},
    onRefresh: () => {},
    onOpenSettings: () => {},
    onViewVisible: () => {
      visibleRefreshes++;
    },
  });
  ctrl.setView(mockView);
  ctrl.update(createState());

  mockView.visible = false;
  visibilityListener!();
  mockView.visible = true;
  visibilityListener!();

  assert.equal(visibleRefreshes, 1, 'showing the panel asks for a fresh quota fetch');
});

test('BottomPanelController: gates setHtml and postMessage on view.visible, renders on show', () => {
  let htmlSetCount = 0;
  let postedMessages: any[] = [];
  let visibilityListener: (() => void) | null = null;
  let messageListener: ((msg: any) => void) | null = null;

  const mockWebview = {
    _html: '',
    get html() { return this._html; },
    set html(val: string) {
      this._html = val;
      htmlSetCount++;
    },
    postMessage(msg: any) {
      postedMessages.push(msg);
      return true;
    },
    onDidReceiveMessage(cb: (msg: any) => void) {
      messageListener = cb;
      return { dispose() {} };
    },
    cspSource: 'vscode-webview:',
  };

  const mockView: WebviewViewLike = {
    visible: false, // Initially hidden
    webview: mockWebview as any,
    onDidChangeVisibility(cb: () => void) {
      visibilityListener = cb;
      return { dispose() {} };
    },
    onDidDispose(cb: () => void) {
      return { dispose() {} };
    },
  };

  const selectedIds: string[] = [];
  const callbacks: BottomPanelCallbacks = {
    onSelectSession: (id) => selectedIds.push(id),
    onPinSession: () => {},
    onUnpinSession: () => {},
    onToggleScope: () => {},
    onRefresh: () => {},
    onOpenSettings: () => {},
  };

  const ctrl = new BottomPanelController(callbacks);
  ctrl.setView(mockView);

  const state = createState();

  // Hidden: updating state should NOT render html or postMessage
  ctrl.update(state);
  assert.equal(htmlSetCount, 0, 'No HTML rendered while hidden');
  assert.equal(postedMessages.length, 0, 'No postMessage sent while hidden');

  // Become visible: immediately renders HTML
  mockView.visible = true;
  visibilityListener!();
  assert.equal(htmlSetCount, 1, 'HTML rendered immediately on visibility transition');

  // No-op skip: identical state after full render posts nothing
  ctrl.update(state);
  assert.equal(postedMessages.length, 0, 'Identical state after full render is skipped (no-op)');

  // Subsequent update with changed state reflects updated bodyHtml
  const stateAll = createState({ scope: 'all' });
  ctrl.update(stateAll);
  assert.equal(postedMessages.length, 1, 'Changed state posts targeted updateState');
  assert.equal(postedMessages[0].type, 'updateState');
  assert.ok(postedMessages[0].bodyHtml.includes('Scope: All Workspaces'));
  assert.equal(postedMessages[0].state, undefined, 'Targeted update: unused state payload is not posted');

  // Inbound switchTab updates activeTab and posts details HTML
  messageListener!({ type: 'switchTab', tab: 'details' });
  assert.equal(ctrl.getUiState().activeTab, 'details');
  assert.equal(postedMessages.length, 2);
  assert.ok(postedMessages[1].bodyHtml.includes('<svg'));

  // Inbound toggleBreakdown persists breakdownOpen across subsequent updates
  messageListener!({ type: 'toggleBreakdown', open: true });
  assert.equal(ctrl.getUiState().breakdownOpen, true);
  assert.equal(postedMessages.length, 3);
  assert.ok(postedMessages[2].bodyHtml.includes('<details class="breakdown-details" open>'));

  // No-op skip: re-update with same state + UI state renders identical body -> no post
  ctrl.update(stateAll);
  assert.equal(postedMessages.length, 3, 'Unchanged rendered body skips postMessage');

  // UI state persists into later renders: toggling breakdown closed posts without open
  messageListener!({ type: 'toggleBreakdown', open: false });
  assert.equal(postedMessages.length, 4);
  assert.ok(!postedMessages[3].bodyHtml.includes('<details class="breakdown-details" open>'));

  // Inbound toggleExpand toggles expandedIds Set
  messageListener!({ type: 'toggleExpand', sessionId: 'root-1' });
  assert.deepEqual(Array.from(ctrl.getUiState().expandedIds ?? []), ['root-1']);
  messageListener!({ type: 'toggleExpand', sessionId: 'root-1' });
  assert.deepEqual(Array.from(ctrl.getUiState().expandedIds ?? []), []);

  // Inbound toggleListExpand toggles expandedLists Set both ways (independent of expandedIds)
  messageListener!({ type: 'toggleListExpand', list: 'sessions' });
  assert.deepEqual(Array.from(ctrl.getUiState().expandedLists ?? []), ['sessions']);
  assert.deepEqual(Array.from(ctrl.getUiState().expandedIds ?? []), [], 'list toggle does not touch expandedIds');
  messageListener!({ type: 'toggleListExpand', list: 'unattached' });
  assert.deepEqual(Array.from(ctrl.getUiState().expandedLists ?? []), ['sessions', 'unattached']);
  messageListener!({ type: 'toggleListExpand', list: 'sessions' });
  assert.deepEqual(Array.from(ctrl.getUiState().expandedLists ?? []), ['unattached']);
  messageListener!({ type: 'toggleListExpand', list: 'bogus' });
  assert.deepEqual(Array.from(ctrl.getUiState().expandedLists ?? []), ['unattached'], 'unknown list key ignored');

  // Inbound message dispatches to callback
  messageListener!({ type: 'selectSession', sessionId: 'target-123' });
  assert.equal(selectedIds.length, 1);
  assert.equal(selectedIds[0], 'target-123');

  // Inbound toggleHelp toggles openHelpIds and posts targeted updateState
  messageListener!({ type: 'toggleHelp', helpId: 'quota-pools', open: true });
  assert.deepEqual(Array.from(ctrl.getUiState().openHelpIds ?? []), ['quota-pools']);
  assert.ok(postedMessages[postedMessages.length - 1].bodyHtml.includes('id="help-box-quota-pools" class="help-box"'));

  messageListener!({ type: 'toggleHelp', helpId: 'quota-pools', open: false });
  assert.deepEqual(Array.from(ctrl.getUiState().openHelpIds ?? []), []);
  assert.ok(postedMessages[postedMessages.length - 1].bodyHtml.includes('id="help-box-quota-pools" class="help-box hidden"'));

  ctrl.dispose();
});

test('BottomPanelController: collapse/expand and reorder tabs and sections with persistence', () => {
  let savedLayout: any = null;
  let messageHandler: ((msg: any) => void) | null = null;
  const postedMessages: any[] = [];

  const controller = new BottomPanelController({
    onSelectSession: () => {},
    onPinSession: () => {},
    onUnpinSession: () => {},
    onToggleScope: () => {},
    onRefresh: () => {},
    onOpenSettings: () => {},
    onLayoutChange: (layout) => {
      savedLayout = layout;
    },
  });

  const view = {
    visible: true,
    webview: {
      html: '',
      cspSource: 'vscode-webview:',
      postMessage: (msg: unknown) => {
        postedMessages.push(msg);
        return true;
      },
      onDidReceiveMessage: (fn: (msg: any) => void) => {
        messageHandler = fn;
        return { dispose: () => {} };
      },
    },
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };

  controller.setView(view);
  controller.update(createState());
  const handler = messageHandler as ((msg: any) => void) | null;
  assert.ok(handler, 'messageHandler should be registered');

  // Reorder tabs ('accounts' is merged back in as the default third tab)
  handler({ type: 'reorderTabs', order: ['details', 'overview'] });
  assert.deepEqual(savedLayout.tabOrder, ['details', 'overview', 'accounts']);
  const lastHtml1 = postedMessages[postedMessages.length - 1].bodyHtml as string;
  assert.ok(lastHtml1.indexOf('data-tab-id="details"') < lastHtml1.indexOf('data-tab-id="overview"'));

  // Collapse a section
  handler({ type: 'toggleSectionCollapse', sectionId: 'quota' });
  assert.ok(savedLayout.collapsedSections.includes('quota'));
  const lastHtml2 = postedMessages[postedMessages.length - 1].bodyHtml as string;
  assert.match(lastHtml2, /is-collapsed" data-section-id="quota"/);

  // Reorder overview sections
  handler({ type: 'reorderSections', tab: 'overview', order: ['sessions', 'unattached', 'quota'] });
  assert.deepEqual(savedLayout.sectionOrder.overview, ['sessions', 'unattached', 'quota']);
  const lastHtml3 = postedMessages[postedMessages.length - 1].bodyHtml as string;
  assert.ok(lastHtml3.indexOf('data-section-id="sessions"') < lastHtml3.indexOf('data-section-id="quota"'));

  // Collapse active tab
  handler({ type: 'toggleTabCollapse', tab: 'overview' });
  assert.ok(savedLayout.collapsedTabs.includes('overview'));
  const lastHtml4 = postedMessages[postedMessages.length - 1].bodyHtml as string;
  assert.match(lastHtml4, /class="tab-view hidden" data-tab-view="overview"/);
});

test('formatResetCountdown reports Exhausted for 0% with a passed resetTime, Ready only when quota is actually back', () => {
  assert.strictEqual(formatResetCountdown('2026-11-26T14:15:42Z', false, true), 'Exhausted');
  assert.strictEqual(formatResetCountdown(null, false, true), 'Exhausted');
});

// ============================================================================
// 5. Task 9: Multi-account UI (StatusBar, QuickPick, Overview bar, Accounts tab)
// ============================================================================

function createAccount(partial: Partial<ManagedAccount> = {}): ManagedAccount {
  const seenAt = partial.firstSeenAt ?? new Date(0).toISOString();
  return {
    email: partial.email ?? 'user@example.com',
    displayName: partial.displayName,
    tier: partial.tier,
    plan: partial.plan,
    isPro: partial.isPro,
    profilePictureUrl: partial.profilePictureUrl,
    label: partial.label,
    group: partial.group,
    colorTag: partial.colorTag,
    firstSeenAt: seenAt,
    lastSeenAt: partial.lastSeenAt ?? seenAt,
    status: partial.status ?? 'active',
  };
}

function createDiagnostics(partial: Partial<MonitorDiagnostics> = {}): MonitorDiagnostics {
  return {
    hostEditor: 'Visual Studio Code',
    isStandaloneIde: false,
    platform: 'linux',
    osKeyringSupported: true,
    osKeyringBackend: 'linux-secret-tool',
    hubPid: 4242,
    hubPort: 42100,
    hubSource: 'exports',
    ...partial,
  };
}

// --- 5a. StatusBar: account tooltip + quotaAlertBackground gating ---

test('buildStatusBarViewModel: tooltip shows the active Account email and plan', () => {
  const account = createAccount({ email: 'dev@example.com', plan: 'Pro', status: 'active' });
  const state = createState({ activeAccount: account, accounts: [account] });
  state.accountSnapshots = { 'dev@example.com': state.quota };

  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.match(vm.tooltipMarkdown, /\*\*Account:\*\* dev@example\.com/);
  assert.match(vm.tooltipMarkdown, /Pro/);
  assert.ok(!/forecast/i.test(vm.tooltipMarkdown), 'no forecast text in the tooltip');
});

test('buildStatusBarViewModel: anonymous-bucket quota shows identity unknown, not a stale Account label', () => {
  // The identity fetch failed on the latest poll: the label in activeAccount is stale and
  // the quota snapshot came from the '__anonymous__' bucket (see monitorService.ts).
  const account = createAccount({ email: 'dev@example.com', plan: 'Pro' });
  const state = createState({ activeAccount: account, accounts: [account] });

  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.match(vm.tooltipMarkdown, /identity unknown/i);
  assert.ok(!vm.tooltipMarkdown.includes('dev@example.com'), 'stale label must not be shown as authoritative');
});

test('buildStatusBarViewModel: quotaAlertBackground gates warning/error tint at lowQuotaThresholdPct', () => {
  const state = createState();
  state.quota.pools.gemini.fiveHour!.remainingPct = 12;

  // Enabled with the default 20% threshold: 12% tints warning.
  assert.equal(buildStatusBarViewModel(state, DEFAULT_CONFIG).color, 'warning');

  // Custom threshold 10: 12% is above it, no tint.
  const cfg10: MonitorConfig = { ...DEFAULT_CONFIG, quotaAlertBackground: true, lowQuotaThresholdPct: 10 };
  assert.equal(buildStatusBarViewModel(state, cfg10).color, 'normal');

  // Disabled: quota never tints the badge.
  const cfgOff: MonitorConfig = { ...DEFAULT_CONFIG, quotaAlertBackground: false };
  assert.equal(buildStatusBarViewModel(state, cfgOff).color, 'normal');

  // 0% is always an error tint while the setting is enabled.
  state.quota.pools.gemini.fiveHour!.remainingPct = 0;
  state.quota.pools.gemini.fiveHour!.isExhausted = true;
  assert.equal(buildStatusBarViewModel(state, cfg10).color, 'error');
});

test('createStatusBarController: low-quota pool tints the background via ThemeColor', () => {
  const items: any[] = [];
  class MockStatusBarItem implements StatusBarItemLike {
    text = '';
    tooltip: any = '';
    command?: string;
    backgroundColor?: any;
    show() {}
    hide() {}
    dispose() {}
  }
  class MockMarkdownString {
    value: string;
    constructor(val = '') { this.value = val; }
  }
  class MockThemeColor {
    id: string;
    constructor(id: string) { this.id = id; }
  }
  const mockVscode: StatusBarVscodeLike = {
    window: { createStatusBarItem: () => { const it = new MockStatusBarItem(); items.push(it); return it; } },
    MarkdownString: MockMarkdownString as any,
    ThemeColor: MockThemeColor as any,
  };
  const ctrl = createStatusBarController(mockVscode, 'cmd.click');

  const state = createState();
  state.quota.pools.gemini.fiveHour!.remainingPct = 12;
  ctrl.update(state, DEFAULT_CONFIG);
  assert.equal(items[0].backgroundColor?.id, 'statusBarItem.warningBackground');

  const off = { ...DEFAULT_CONFIG, quotaAlertBackground: false };
  ctrl.update(state, off);
  assert.equal(items[0].backgroundColor, undefined, 'quotaAlertBackground: false removes the tint');

  ctrl.dispose();
});

// --- 5b. QuickPick: Switch / Manage Accounts entry ---

test('buildQuickPickItems: adds Switch / Manage Accounts while keeping sessions and pin buttons', () => {
  const state = createState({ pinnedSessionId: 'root-1' });
  const items = buildQuickPickItems(state);

  const manage = items.find((it) => it.action === 'manageAccounts');
  assert.ok(manage, 'manage entry present');
  assert.match(manage.label, /Switch \/ Manage Accounts/);

  // Existing entries stay intact
  assert.equal(items[0].action, 'openPanel');
  assert.equal(items[1].action, 'unpin');
  assert.equal(items[2].action, 'toggleScope');

  const session = items.find((it) => it.action === 'session');
  assert.ok(session && session.buttons && session.buttons.some((b) => b.id === 'pin'), 'pin buttons intact');
});

test('showSessionQuickPick: accepting the manage entry calls onManageAccounts', async () => {
  let acceptedCallback: (() => void) | null = null;
  const mockQp = {
    title: '',
    placeholder: '',
    items: [] as QuickPickEntry[],
    selectedItems: [] as QuickPickEntry[],
    onDidAccept(cb: () => void) { acceptedCallback = cb; return { dispose() {} }; },
    onDidTriggerItemButton() { return { dispose() {} }; },
    onDidHide() { return { dispose() {} }; },
    show() {},
    hide() {},
    dispose() {},
  };
  const mockVscode: QuickPickVscodeLike = { window: { createQuickPick: () => mockQp as any } };

  let managed = false;
  await showSessionQuickPick(mockVscode, createState(), {
    onInspect: () => {},
    onPin: () => {},
    onUnpin: () => {},
    onToggleScope: () => {},
    onManageAccounts: () => { managed = true; },
  });

  const manage = mockQp.items.find((it) => it.action === 'manageAccounts');
  assert.ok(manage);
  mockQp.selectedItems = [manage];
  acceptedCallback!();
  assert.equal(managed, true);
});

// --- 5c. Overview Active Account bar ---

test('renderBottomPanelBodyHtml: Overview renders Active Account bar without a forecast section', () => {
  const account = createAccount({ email: 'dev@example.com', plan: 'Pro', status: 'active', group: 'Team A' });
  const state = createState({ activeAccount: account, accounts: [account] });
  state.accountSnapshots = { 'dev@example.com': state.quota };
  state.unattachedSubagents = [createNode({ id: 'loose-1', isSubagent: true, title: 'Loose Subagent' })];

  const html = renderBottomPanelBodyHtml(state, { activeTab: 'overview' });
  assert.match(html, /dev@example\.com/);
  assert.match(html, /class="badge plan">Pro</);
  assert.match(html, /data-action="switchAccount"/);
  assert.match(html, /data-action="saveCurrentAccount"/);
  assert.match(html, /data-action="addAccount"/);
  assert.match(html, /5-Hour \/ Weekly Quota Pools/);
  assert.match(html, /Sessions \(/);
  assert.match(html, /Unattached Subagents/);
  assert.ok(!html.includes('Model Usage Forecast'), 'forecast stays absent');
});

test('renderBottomPanelBodyHtml: unknown identity renders an explicit identity-unknown bar', () => {
  const account = createAccount({ email: 'dev@example.com', plan: 'Pro' });
  const state = createState({ activeAccount: account, accounts: [account] });

  // Scope to the overview tab view: the hidden Accounts tab may legitimately list the
  // saved registry entries; the bar must not present the stale label as the Account.
  const html = renderBottomPanelBodyHtml(state, { activeTab: 'overview' });
  const overview = html.slice(
    html.indexOf('data-tab-view="overview"'),
    html.indexOf('data-tab-view="details"'),
  );
  assert.match(overview, /Identity unknown/);
  assert.ok(!overview.includes('dev@example.com'), 'stale label must not be presented as the Account');
});

// --- 5d. Accounts tab: 4 sections ---

function savedAccountsSection(html: string): string {
  const start = html.indexOf('Saved Accounts');
  const end = html.indexOf('Multi-Account Quota Matrix');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return html.slice(start, end);
}

function createAccountsState(): { state: MonitorState; active: ManagedAccount; saved: ManagedAccount } {
  const active = createAccount({ email: 'dev@example.com', label: 'Work', group: 'Team A', plan: 'Pro', status: 'active' });
  const saved = createAccount({ email: 'other@example.com', label: 'Backup', group: 'Team B', status: 'saved' });
  const state = createState({ activeAccount: active, accounts: [active, saved] });
  state.accountSnapshots = { 'dev@example.com': state.quota };
  state.diagnostics = createDiagnostics();
  return { state, active, saved };
}

test('renderBottomPanelBodyHtml: Accounts tab renders Saved Accounts with search, group filter, and row actions', () => {
  const { state } = createAccountsState();
  const html = renderBottomPanelBodyHtml(state, {
    activeTab: 'accounts',
    accountSearch: '',
    accountGroupFilter: '',
    matrixSnapshots: { 'dev@example.com': state.quota, 'other@example.com': state.quota },
  });

  assert.match(html, /Saved Accounts/);
  assert.match(html, /data-action="accountSearch"/);
  assert.match(html, /data-action="accountGroupFilter"/);
  assert.match(html, /other@example\.com/);
  assert.match(html, /data-action="switchAccount" data-email="other@example\.com"/);
  assert.match(html, /data-action="editAccount" data-email="other@example\.com" data-field="label"/);
  assert.match(html, /data-action="editAccount" data-email="other@example\.com" data-field="group"/);
  assert.match(html, /data-action="editAccount" data-email="other@example\.com" data-field="colorTag"/);
  assert.match(html, /data-action="reauthAccount" data-email="other@example\.com"/);
  assert.match(html, /data-action="removeAccount" data-email="other@example\.com"/);
  assert.match(html, /data-action="saveCurrentAccount"/);
});

test('renderBottomPanelBodyHtml: Accounts tab search and group filter narrow the rows', () => {
  const { state } = createAccountsState();
  const searched = savedAccountsSection(renderBottomPanelBodyHtml(state, {
    activeTab: 'accounts',
    accountSearch: 'other',
    matrixSnapshots: {},
  }));
  assert.ok(searched.includes('other@example.com'));
  assert.ok(!searched.includes('dev@example.com'), 'search filters the saved rows');

  const grouped = savedAccountsSection(renderBottomPanelBodyHtml(state, {
    activeTab: 'accounts',
    accountGroupFilter: 'Team A',
    matrixSnapshots: {},
  }));
  assert.ok(grouped.includes('dev@example.com'));
  assert.ok(!grouped.includes('other@example.com'), 'group filter filters the saved rows');
});

test('renderBottomPanelBodyHtml: Quota Matrix shows Reset passed · stale for expired inactive Accounts, never 100%', () => {
  const { state, saved } = createAccountsState();
  const expired = createQuota();
  expired.pools.gemini.fiveHour = {
    window: '5h',
    remainingPct: 100,
    remainingFraction: 1,
    resetTime: new Date(Date.now() - 3_600_000).toISOString(),
    isReady: true,
    isExhausted: false,
  };
  const html = renderBottomPanelBodyHtml(state, {
    activeTab: 'accounts',
    matrixSnapshots: {
      'dev@example.com': state.quota,
      'other@example.com': { ...expired, isStale: true },
    },
  });

  const matrix = html.slice(
    html.indexOf('Multi-Account Quota Matrix'),
    html.indexOf('30-Day Quota History'),
  );
  assert.match(html, /Multi-Account Quota Matrix/);
  assert.match(matrix, /Reset passed · stale/);
  assert.ok(!matrix.includes('100%'), 'stale windows never render as 100%');
  assert.match(matrix, /other@example\.com/);
});

test('renderBottomPanelBodyHtml: Accounts tab renders history backups and diagnostics card', () => {
  const { state } = createAccountsState();
  const html = renderBottomPanelBodyHtml(state, {
    activeTab: 'accounts',
    matrixSnapshots: {},
  });

  assert.match(html, /30-Day Quota History &amp; Backups/);
  assert.match(html, /data-action="exportHistory" data-format="csv"/);
  assert.match(html, /data-action="exportHistory" data-format="json"/);
  assert.match(html, /data-action="exportAccounts"/);
  assert.match(html, /data-action="importAccounts"/);

  assert.match(html, /Runtime &amp; Hub Diagnostics/);
  assert.match(html, /Visual Studio Code/);
  assert.match(html, /linux-secret-tool/);
  assert.match(html, /4242/);
  assert.match(html, /42100/);
  assert.match(html, /data-action="reconnectHub"/);
  assert.match(html, /data-action="restartBackend"/);
  assert.match(html, /data-action="inspectBridge"/);
});

// --- 5e. Controller: inbound actions + layout migration ---

test('BottomPanelController: account, backup, and diagnostics inbound actions reach their callbacks', () => {
  let msgListener: ((msg: any) => void) | null = null;
  const mockView: WebviewViewLike = {
    visible: true,
    webview: {
      html: '',
      postMessage: () => true,
      onDidReceiveMessage: (cb: (msg: any) => void) => {
        msgListener = cb;
        return { dispose() {} };
      },
      cspSource: 'vscode-webview:',
    } as any,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };

  const calls = {
    switch: [] as Array<string | undefined>,
    add: 0,
    save: 0,
    edit: [] as Array<{ email: string; field: string }>,
    remove: [] as string[],
    reauth: [] as string[],
    exportHistory: [] as string[],
    exportAccounts: 0,
    importAccounts: 0,
    reconnect: 0,
    restart: 0,
    inspect: 0,
  };

  const ctrl = new BottomPanelController({
    onSelectSession: () => {},
    onPinSession: () => {},
    onUnpinSession: () => {},
    onToggleScope: () => {},
    onRefresh: () => {},
    onOpenSettings: () => {},
    onSwitchAccount: (email) => calls.switch.push(email),
    onAddAccount: () => { calls.add++; },
    onSaveCurrentAccount: () => { calls.save++; },
    onEditAccount: (email, field) => calls.edit.push({ email, field }),
    onRemoveAccount: (email) => calls.remove.push(email),
    onReauthAccount: (email) => calls.reauth.push(email),
    onExportHistory: (format) => calls.exportHistory.push(format),
    onExportAccounts: () => { calls.exportAccounts++; },
    onImportAccounts: () => { calls.importAccounts++; },
    onReconnectHub: () => { calls.reconnect++; },
    onRestartBackend: () => { calls.restart++; },
    onInspectBridge: () => { calls.inspect++; },
  });
  ctrl.setView(mockView);
  ctrl.update(createState());
  const handler = msgListener!;

  handler({ type: 'switchAccount', email: 'a@x.com' });
  handler({ type: 'switchAccount' });
  handler({ type: 'addAccount' });
  handler({ type: 'saveCurrentAccount' });
  handler({ type: 'editAccount', email: 'a@x.com', field: 'label' });
  handler({ type: 'editAccount', email: 'a@x.com', field: 'colorTag' });
  handler({ type: 'editAccount', email: 'a@x.com', field: 'bogus' });
  handler({ type: 'removeAccount', email: 'a@x.com' });
  handler({ type: 'reauthAccount', email: 'a@x.com' });
  handler({ type: 'exportHistory', format: 'csv' });
  handler({ type: 'exportHistory', format: 'json' });
  handler({ type: 'exportHistory', format: 'xml' });
  handler({ type: 'exportAccounts' });
  handler({ type: 'importAccounts' });
  handler({ type: 'reconnectHub' });
  handler({ type: 'restartBackend' });
  handler({ type: 'inspectBridge' });

  assert.deepEqual(calls.switch, ['a@x.com', undefined]);
  assert.equal(calls.add, 1);
  assert.equal(calls.save, 1);
  assert.deepEqual(calls.edit, [{ email: 'a@x.com', field: 'label' }, { email: 'a@x.com', field: 'colorTag' }]);
  assert.deepEqual(calls.remove, ['a@x.com']);
  assert.deepEqual(calls.reauth, ['a@x.com']);
  assert.deepEqual(calls.exportHistory, ['csv', 'json']);
  assert.equal(calls.exportAccounts, 1);
  assert.equal(calls.importAccounts, 1);
  assert.equal(calls.reconnect, 1);
  assert.equal(calls.restart, 1);
  assert.equal(calls.inspect, 1);

  // Search and group filter update the UI state
  handler({ type: 'accountSearch', value: 'foo' });
  assert.equal(ctrl.getUiState().accountSearch, 'foo');
  handler({ type: 'accountGroupFilter', value: 'Team A' });
  assert.equal(ctrl.getUiState().accountGroupFilter, 'Team A');

  // Accounts tab reachable via switchTab
  handler({ type: 'switchTab', tab: 'accounts' });
  assert.equal(ctrl.getUiState().activeTab, 'accounts');

  ctrl.dispose();
});

test('BottomPanelController: getAccountSnapshots feeds the Quota Matrix and old layouts migrate', () => {
  let msgListener: ((msg: any) => void) | null = null;
  const postedMessages: any[] = [];
  const mockView: WebviewViewLike = {
    visible: true,
    webview: {
      html: '',
      postMessage: (msg: any) => { postedMessages.push(msg); return true; },
      onDidReceiveMessage: (cb: (msg: any) => void) => {
        msgListener = cb;
        return { dispose() {} };
      },
      cspSource: 'vscode-webview:',
    } as any,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };

  const saved = createAccount({ email: 'other@example.com', status: 'saved' });
  const state = createState({ accounts: [saved] });
  const staleSnapshot = { ...createQuota(), isStale: true };

  // A layout persisted before this release has no 'accounts' tab: it must be merged in.
  const ctrl = new BottomPanelController({
    onSelectSession: () => {},
    onPinSession: () => {},
    onUnpinSession: () => {},
    onToggleScope: () => {},
    onRefresh: () => {},
    onOpenSettings: () => {},
    initialLayout: { tabOrder: ['overview', 'details'] } as any,
    getAccountSnapshots: () => ({ 'other@example.com': staleSnapshot }),
  });
  ctrl.setView(mockView);
  ctrl.update(state);
  assert.deepEqual(ctrl.getLayout().tabOrder, ['overview', 'details', 'accounts'], 'old layout migrates');

  msgListener!({ type: 'switchTab', tab: 'accounts' });
  const body = postedMessages[postedMessages.length - 1].bodyHtml as string;
  assert.match(body, /other@example\.com/, 'matrix renders the snapshot from the provider callback');
  assert.match(body, /Reset passed · stale/);

  ctrl.dispose();
});

test('sanitizePanelLayout: migrates a pre-accounts layout by appending the Accounts tab', () => {
  const migrated = sanitizePanelLayout({
    tabOrder: ['details', 'overview'],
    sectionOrder: { overview: ['quota'], details: ['breakdown'] },
    collapsedTabs: ['details'],
    collapsedSections: ['quota'],
  } as any);
  assert.deepEqual(migrated.tabOrder, ['details', 'overview', 'accounts']);
  assert.deepEqual(migrated.sectionOrder.details, ['breakdown', 'sessionSummary', 'subagents', 'contextChart']);
  assert.deepEqual(migrated.collapsedTabs, ['details']);
});
