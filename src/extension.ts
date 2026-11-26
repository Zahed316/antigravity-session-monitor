import * as vscode from 'vscode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteClient, type SqliteClient } from './data/sqliteClient.ts';
import { LocalTelemetryReader } from './data/localTelemetry.ts';
import { HubClient } from './rpc/hubClient.ts';
import { discoverHubEndpoints } from './rpc/hubDiscovery.ts';
import { extractArtifactCascadeId } from './core/sessionResolver.ts';
import { createStatusBarController, type StatusBarController } from './ui/statusBar.ts';
import { showSessionQuickPick } from './ui/quickPick.ts';
import { createBottomPanelProvider } from './ui/bottomPanelProvider.ts';
import { MonitorService } from './monitorService.ts';
import { DEFAULT_CONFIG, type MonitorConfig, type ScopeMode } from './types.ts';

let monitorService: MonitorService | null = null;
let sqliteClient: SqliteClient | null = null;

function getConfiguration(): MonitorConfig {
  const cfg = vscode.workspace.getConfiguration('antigravityMonitor');
  return {
    refreshIntervalMs: cfg.get<number>('refreshIntervalMs', DEFAULT_CONFIG.refreshIntervalMs),
    unfocusedRefreshIntervalMs: cfg.get<number>(
      'unfocusedRefreshIntervalMs',
      DEFAULT_CONFIG.unfocusedRefreshIntervalMs,
    ),
    quotaRefreshIntervalMs: Math.max(
      5000,
      cfg.get<number>('quotaRefreshIntervalMs', DEFAULT_CONFIG.quotaRefreshIntervalMs),
    ),
    quotaUnfocusedMultiplier: Math.min(
      12,
      Math.max(
        0,
        cfg.get<number>('quotaUnfocusedMultiplier', DEFAULT_CONFIG.quotaUnfocusedMultiplier),
      ),
    ),
    autoFollowActiveSession: cfg.get<boolean>(
      'autoFollowActiveSession',
      DEFAULT_CONFIG.autoFollowActiveSession,
    ),
    contextWarningPct: cfg.get<number>('contextWarningPct', DEFAULT_CONFIG.contextWarningPct),
    contextCriticalPct: cfg.get<number>('contextCriticalPct', DEFAULT_CONFIG.contextCriticalPct),
    defaultScope: cfg.get<ScopeMode>('defaultScope', DEFAULT_CONFIG.defaultScope),
    dataRootOverride: cfg.get<string>('dataRootOverride', DEFAULT_CONFIG.dataRootOverride),
  };
}

function checkArtifactHint(monitor: MonitorService): void {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const hint = extractArtifactCascadeId(activeEditor.document.uri.toString());
    if (hint) {
      monitor.setArtifactHint(hint);
      return;
    }
  }

  if (vscode.window.tabGroups && vscode.window.tabGroups.all) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input && typeof tab.input === 'object') {
          const inputUri = (tab.input as any).uri;
          if (inputUri) {
            const hint = extractArtifactCascadeId(inputUri.toString());
            if (hint) {
              monitor.setArtifactHint(hint);
              return;
            }
          }
        }
      }
    }
  }

  monitor.setArtifactHint(null);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let config = getConfiguration();

  const antigravityRoot =
    config.dataRootOverride && config.dataRootOverride.trim() !== ''
      ? path.resolve(config.dataRootOverride.trim())
      : path.join(os.homedir(), '.gemini', 'antigravity');

  // Cache file strictly inside globalStorageUri (never mutating ~/.gemini/antigravity/)
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  } catch {
    // Directory creation safe ignore
  }
  const cacheFilePath = path.join(context.globalStorageUri.fsPath, 'cache.json');
  const quotaCalibrationPath = path.join(context.globalStorageUri.fsPath, 'quota-calibration.json');

  let workspaceStateDbPath: string | undefined;
  if (context.storageUri) {
    workspaceStateDbPath = path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb');
  }

  sqliteClient = await createSqliteClient();
  const localReader = new LocalTelemetryReader(sqliteClient, {
    antigravityRoot,
    cacheFilePath,
    workspaceStateDbPath,
  });

  const hubClient = new HubClient();

  const initialPinnedId = context.workspaceState.get<string | null>(
    'antigravityMonitor.pinnedSessionId',
    null,
  );
  const initialScope = context.workspaceState.get<ScopeMode>(
    'antigravityMonitor.scope',
    config.defaultScope,
  );

  const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  // Status Bar UI (single consolidated item)
  const statusBar: StatusBarController = createStatusBarController(
    vscode as any,
    'antigravityMonitor.openQuickPick',
  );
  context.subscriptions.push(statusBar);

  const initialPanelLayout = context.globalState.get<Record<string, unknown>>(
    'antigravityMonitor.panelLayout.v1',
  );

  // Bottom Panel Provider
  const panelProvider = createBottomPanelProvider(vscode, {
    onSelectSession: (id) => monitorService?.selectForPanel(id),
    onPinSession: (id) => void monitorService?.pinSession(id),
    onUnpinSession: () => void monitorService?.unpinSession(),
    onToggleScope: () => void monitorService?.toggleScope(),
    onRefresh: () => void monitorService?.refreshNow(true),
    initialLayout: initialPanelLayout as any,
    onLayoutChange: (layout) => {
      void context.globalState.update('antigravityMonitor.panelLayout.v1', layout);
    },
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('antigravityMonitor.panel', panelProvider),
  );
  context.subscriptions.push(panelProvider.controller);

  // MonitorService Orchestrator
  monitorService = new MonitorService({
    localReader,
    hubClient,
    discoverEndpoints: (deps) =>
      discoverHubEndpoints({
        ...deps,
        getExtension: (id) => vscode.extensions.getExtension(id),
      }),
    workspacePaths,
    config,
    pinnedSessionId: initialPinnedId,
    scope: initialScope,
    antigravityRoot,
    quotaCalibrationPath,
    sqliteBackend: sqliteClient.backend,
    onPersistPinnedId: async (id) => {
      await context.workspaceState.update('antigravityMonitor.pinnedSessionId', id);
    },
    onPersistScope: async (s) => {
      await context.workspaceState.update('antigravityMonitor.scope', s);
    },
    onDidUpdateState: (state) => {
      statusBar.update(state, config);
      panelProvider.controller.update(state);
    },
  });

  // Window Focus Listener
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      monitorService?.setWindowFocused(e.focused);
    }),
  );

  // Workspace Folders Listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const paths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      monitorService?.setWorkspacePaths(paths);
    }),
  );

  // Configuration Change Listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityMonitor')) {
        config = getConfiguration();
        monitorService?.updateConfig(config);
        if (monitorService) {
          statusBar.update(monitorService.getState(), config);
        }
      }
    }),
  );

  // Active Editor and Tab change listeners for artifact cascadeId hints
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (monitorService) {
        checkArtifactHint(monitorService);
      }
    }),
  );

  if (vscode.window.tabGroups) {
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        if (monitorService) {
          checkArtifactHint(monitorService);
        }
      }),
    );
  }

  // Register all 6 commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityMonitor.openQuickPick', async () => {
      if (!monitorService) {
        return;
      }
      await showSessionQuickPick(
        {
          window: vscode.window,
          ThemeIcon: vscode.ThemeIcon,
        },
        monitorService.getState(),
        {
        onOpenPanel: () => {
          panelProvider.controller.setTab('overview');
          void vscode.commands.executeCommand('antigravityMonitor.panel.focus');
        },
        onInspect: (sessionId) => {
          panelProvider.controller.setTab('details');
          monitorService?.selectForPanel(sessionId);
          void vscode.commands.executeCommand('antigravityMonitor.panel.focus');
        },
        onPin: (sessionId) => void monitorService?.pinSession(sessionId),
        onUnpin: () => void monitorService?.unpinSession(),
        onToggleScope: () => void monitorService?.toggleScope(),
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityMonitor.openPanel', async () => {
      panelProvider.controller.setTab('overview');
      await vscode.commands.executeCommand('antigravityMonitor.panel.focus');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityMonitor.pinSession', async (sessionId?: string) => {
      if (!monitorService) {
        return;
      }
      if (typeof sessionId === 'string' && sessionId.trim() !== '') {
        await monitorService.pinSession(sessionId.trim());
        return;
      }
      const active = monitorService.getState().activeSession;
      if (active) {
        await monitorService.pinSession(active.id);
      } else {
        await vscode.commands.executeCommand('antigravityMonitor.openQuickPick');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityMonitor.unpinSession', async () => {
      await monitorService?.unpinSession();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityMonitor.toggleScope', async () => {
      await monitorService?.toggleScope();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityMonitor.refresh', async () => {
      await monitorService?.refreshNow(true);
    }),
  );

  // Initial artifact hint check and service startup
  checkArtifactHint(monitorService);
  await monitorService.start();
}

export function deactivate(): void {
  if (monitorService) {
    monitorService.dispose();
    monitorService = null;
  }
  if (sqliteClient) {
    sqliteClient.dispose();
    sqliteClient = null;
  }
}
