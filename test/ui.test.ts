import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_LIMIT,
  type CallUsagePoint,
  type MonitorConfig,
  type MonitorState,
  type QuotaSnapshot,
  type SessionMetrics,
  type SessionNode,
} from '../src/types.ts';
import {
  formatCompactTokens,
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

  // Status bar context text contains spin icon, pin icon, truncated title, used/max (pct%), and cache volume pct
  assert.match(vm.contextText, /\$\(pin\)/);
  assert.match(vm.contextText, /\$\(sync~spin\)/);
  assert.match(vm.contextText, /120k\/256k \(47%\)/);
  assert.match(vm.contextText, /C:65%/);
  assert.equal(vm.contextColor, 'normal');

  // Warning threshold test (>= 75%)
  active.contextUsed = 195_000;
  active.contextPct = 76;
  const vmWarn = buildStatusBarViewModel(state, config);
  assert.equal(vmWarn.contextColor, 'warning');

  // Error/critical threshold test (>= 90%)
  active.contextUsed = 240_000;
  active.contextPct = 94;
  const vmCrit = buildStatusBarViewModel(state, config);
  assert.equal(vmCrit.contextColor, 'error');
});

test('buildStatusBarViewModel: Review Focus #5 missing pin shows $(pin) Missing — Click to unpin', () => {
  const state = createState({
    activeSession: createNode(),
    pinnedSessionId: 'deleted-session-id',
    pinMissing: true,
  });
  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.equal(vm.contextText, '$(pin) Missing — Click to unpin');
  assert.equal(vm.contextColor, 'warning');
});

test('buildStatusBarViewModel: empty workspace returns $(pulse) No workspace session', () => {
  const state = createState({
    activeSession: null,
    pinnedSessionId: null,
    pinMissing: false,
  });
  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.equal(vm.contextText, '$(pulse) No workspace session');
  assert.equal(vm.contextColor, 'normal');
});

test('buildStatusBarViewModel: quota text and warning/error thresholds', () => {
  const state = createState();

  // Online with normal pools (Gemini 85%, Non-Google 40%)
  const vmOnline = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.match(vmOnline.quotaText, /G 85% · C 40%/);
  assert.equal(vmOnline.quotaColor, 'normal');

  // Quota offline
  state.quota.status = 'offline';
  const vmOffline = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.equal(vmOffline.quotaText, 'Quota offline');
  assert.equal(vmOffline.quotaColor, 'normal');

  // Quota warning when min pool <= 20%
  state.quota.status = 'online';
  state.quota.pools.gemini.fiveHour!.remainingPct = 18;
  const vmWarn = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.equal(vmWarn.quotaColor, 'warning');

  // Quota error when min pool <= 0%
  state.quota.pools.gemini.fiveHour!.remainingPct = 0;
  state.quota.pools.gemini.fiveHour!.isExhausted = true;
  const vmCrit = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  assert.equal(vmCrit.quotaColor, 'error');
});

test('buildStatusBarViewModel: tooltip Markdown includes Parent + N subagents breakdown and quota countdowns', () => {
  const child = createNode({
    id: 'subagent-1',
    title: 'Research subagent <script>alert(1)</script>',
    isSubagent: true,
    parentId: 'root-1',
    agentName: 'researcher',
    subagentRole: 'Code Researcher',
    own: createMetrics({ fresh: 5_000, cacheRead: 15_000, output: 800, thinking: 500, response: 300, calls: 3 }),
  });
  const parent = createNode({
    id: 'root-1',
    title: 'Parent Session & "Untrusted" <Tags>',
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

  // Escaping untrusted strings
  assert.ok(!vm.tooltipMarkdown.includes('<Tags>'), 'Untrusted tags should be escaped');
  assert.match(vm.tooltipMarkdown, /Parent \+ 1 subagent/);
  assert.match(vm.tooltipMarkdown, /Fresh/);
  assert.match(vm.tooltipMarkdown, /Cache Read/);
  assert.match(vm.tooltipMarkdown, /Output/);
  assert.match(vm.tooltipMarkdown, /Thinking/);
  assert.match(vm.tooltipMarkdown, /Response/);
  assert.match(vm.tooltipMarkdown, /compactions/i);
  assert.match(vm.tooltipMarkdown, /Ready/);
});

test('createStatusBarController wires context and quota items with ThemeColor and MarkdownString', () => {
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

  const ctrl = createStatusBarController(mockVscode, 'cmd.clickContext', 'cmd.clickQuota');
  assert.equal(createdCount, 2);
  assert.equal(items[0].command, 'cmd.clickContext');
  assert.equal(items[1].command, 'cmd.clickQuota');

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
  assert.equal(items[1].disposed, true);
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

  // First item is Unpin
  assert.equal(items[0].action, 'unpin');
  assert.match(items[0].label, /Unpin/);

  // Second item is Scope toggle
  assert.equal(items[1].action, 'toggleScope');
  assert.match(items[1].label, /Current Workspace/);

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

  const session = createNode({
    id: 'xss-session',
    title: '<script>alert("xss")</script> & "Dangerous"',
    agentName: '<img src=x onerror=alert(1)>',
    subagentRole: '<b>Hacker</b>',
    calls: [createCall({ idx: 0, effectiveContext: 30_000 }), compactedCall],
  });

  const state = createState({
    roots: [session],
    selectedSession: session,
    selectedSessionId: session.id,
    pinMissing: true,
  });

  const html = renderBottomPanelHtml(state, nonce, cspSource);

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

  // 4. Quota strip
  assert.match(html, /Gemini/);
  assert.match(html, /Non-Google/);

  // 5. SVG Chart with compaction marker
  assert.match(html, /<svg/);
  assert.match(html, /stroke-dasharray/);
  assert.match(html, /Compaction/);
  assert.match(html, /14/);

  // 6. renderBottomPanelBodyHtml and DOM root wrapper
  const bodyHtml = renderBottomPanelBodyHtml(state);
  assert.ok(!bodyHtml.includes('<!DOCTYPE html>'));
  assert.ok(html.includes(`<div id="panel-root">\n    ${bodyHtml}\n  </div>`));
  assert.match(html, /root\.innerHTML\s*=\s*message\.bodyHtml/);
  assert.match(html, /document\.getElementById\('panel-root'\)/);
});

// ============================================================================
// 4. BottomPanelController & Provider Tests
// ============================================================================

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

  // Subsequent update while visible posts message
  ctrl.update(state);
  assert.equal(postedMessages.length, 1, 'Message posted on subsequent update');
  assert.equal(postedMessages[0].type, 'updateState');
  assert.equal(typeof postedMessages[0].bodyHtml, 'string');
  assert.ok(postedMessages[0].bodyHtml.includes('Scope: Current Workspace'));

  // Subsequent update with changed state reflects updated bodyHtml
  const stateAll = createState({ scope: 'all' });
  ctrl.update(stateAll);
  assert.equal(postedMessages.length, 2, 'Second message posted on subsequent update');
  assert.equal(postedMessages[1].type, 'updateState');
  assert.ok(postedMessages[1].bodyHtml.includes('Scope: All Workspaces'));

  // Inbound message dispatches to callback
  messageListener!({ type: 'selectSession', sessionId: 'target-123' });
  assert.equal(selectedIds.length, 1);
  assert.equal(selectedIds[0], 'target-123');

  ctrl.dispose();
});
