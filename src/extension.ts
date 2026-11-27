import * as vscode from 'vscode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createSqliteClient, type SqliteClient } from './data/sqliteClient.ts';
import { LocalTelemetryReader } from './data/localTelemetry.ts';
import { HubClient } from './rpc/hubClient.ts';
import { HubAuthClient } from './rpc/hubAuth.ts';
import { discoverHubEndpoints, type HubEndpoint } from './rpc/hubDiscovery.ts';
import { extractArtifactCascadeId } from './core/sessionResolver.ts';
import { createStatusBarController, resolveActiveAccountView, type StatusBarController } from './ui/statusBar.ts';
import { showSessionQuickPick } from './ui/quickPick.ts';
import { createBottomPanelProvider, type AccountEditField } from './ui/bottomPanelProvider.ts';
import { MonitorService } from './monitorService.ts';
import { AccountStore } from './accounts/accountStore.ts';
import { QuotaHistoryStore } from './accounts/quotaHistoryStore.ts';
import { TokenVaultService } from './accounts/tokenVaultService.ts';
import { QuotaAlertService, type QuotaAlertEvent } from './accounts/quotaAlertService.ts';
import { AccountSwitcher } from './accounts/accountSwitcher.ts';
import {
  isAntigravityStandaloneIde,
  resolveStandaloneIdeInfo,
  switchFailureRecoveryHint,
} from './accounts/ideStateService.ts';
import { purgeRemovedAccountCredential } from './accounts/vaultPurge.ts';
import { createKeyringVerifier, createTokenVaultDeps } from './accounts/vaultWiring.ts';
import { DEFAULT_CONFIG, type MonitorConfig, type QuotaSnapshot, type ScopeMode } from './types.ts';

const execFileAsync = promisify(execFileCb);

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
    enableLowQuotaAlerts: cfg.get<boolean>('enableLowQuotaAlerts', DEFAULT_CONFIG.enableLowQuotaAlerts!),
    lowQuotaThresholdPct: cfg.get<number>('lowQuotaThresholdPct', DEFAULT_CONFIG.lowQuotaThresholdPct!),
    notifyQuotaReset: cfg.get<boolean>('notifyQuotaReset', DEFAULT_CONFIG.notifyQuotaReset!),
    quotaAlertBackground: cfg.get<boolean>('quotaAlertBackground', DEFAULT_CONFIG.quotaAlertBackground!),
    autoCaptureVault: cfg.get<boolean>('autoCaptureVault', DEFAULT_CONFIG.autoCaptureVault!),
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

  // --- Multi-account services (telemetry stays read-only; switching is strictly opt-in) ---
  // vscode Memento/SecretStorage return Thenable, not Promise: thin adapters bridge that.
  const globalStateAdapter = {
    get: <T>(key: string) => context.globalState.get<T>(key),
    update: (key: string, value: unknown) => Promise.resolve(context.globalState.update(key, value)),
  };
  const secretsAdapter = {
    get: (key: string) => Promise.resolve(context.secrets.get(key)),
    store: (key: string, value: string) => Promise.resolve(context.secrets.store(key, value)),
    delete: (key: string) => Promise.resolve(context.secrets.delete(key)),
  };
  const accountStore = new AccountStore({
    globalState: globalStateAdapter,
    globalStorageUri: context.globalStorageUri.fsPath,
  });
  const historyStore = new QuotaHistoryStore(context.globalStorageUri.fsPath);
  const isStandaloneIde = isAntigravityStandaloneIde(vscode.env.appName, process.execPath);
  const standaloneIdeInfo = isStandaloneIde
    ? resolveStandaloneIdeInfo({ executablePath: process.execPath })
    : null;
  // Full vault deps via the tested factory (accounts/vaultWiring.ts): a real
  // PATH-aware which, execFileAsync, and readIdeState only when the standalone
  // IDE's state.vscdb exists. Plain VS Code hosts stay a clean
  // `ide_state_unavailable` (no VS Code credential reader exists).
  const vaultService = new TokenVaultService(
    createTokenVaultDeps({
      secrets: secretsAdapter,
      platform: process.platform,
      execFileAsync,
      isStandaloneIde,
      standaloneStateDbPath: standaloneIdeInfo?.stateDbPath ?? null,
    }),
  );
  await accountStore.load();
  await historyStore.load();

  const hubAuthClient = new HubAuthClient();

  // Last known hub endpoint for the auth RPCs (re-discovered on connect/reconnect).
  let cachedEndpoint: HubEndpoint | null = null;
  const refreshEndpointCache = async (): Promise<void> => {
    try {
      const endpoints = await discoverHubEndpoints({
        workspacePaths,
        getExtension: (id) => vscode.extensions.getExtension(id),
      });
      cachedEndpoint = endpoints[0] ?? null;
    } catch {
      cachedEndpoint = null;
    }
  };
  void refreshEndpointCache();

  // Target of the in-flight switch, so the keyring verifier knows which entry to re-read.
  let pendingKeyringTarget: string | null = null;
  const switcher = new AccountSwitcher({
    vault: vaultService,
    accounts: accountStore,
    hubAuth: hubAuthClient,
    getEndpoint: () => cachedEndpoint,
    vscodeApi: {
      commands: {
        executeCommand: async (cmd: string, ...args: unknown[]) => {
          await vscode.commands.executeCommand(cmd, ...args);
        },
      },
    },
    isStandaloneIde,
    confirmSwitch: async (email) =>
      (await vscode.window.showWarningMessage(
        `Switch the active Antigravity Account to ${email}?`,
        { modal: true },
        'Switch',
      )) === 'Switch',
    quitIde: async () => {
      await vscode.commands.executeCommand('workbench.action.quit');
    },
    env: process.env,
    globalStorageDir: context.globalStorageUri.fsPath,
    ...(standaloneIdeInfo ? { ideInfo: standaloneIdeInfo } : {}),
    getActiveEmail: () => monitorService?.getState().activeAccount?.email ?? null,
    // Byte-compares the re-read keyring secret against the exact written
    // payload; any stale/different entry fails and the official-login
    // self-heal runs (fail closed).
    verifyKeyringSync: createKeyringVerifier({
      platform: process.platform,
      execFileAsync,
      getCredential: (email) => vaultService.getCredential(email),
      getTargetEmail: () => pendingKeyringTarget,
    }),
  });

  const alertService = new QuotaAlertService();

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
    // Coming back from the terminal: pull fresh quota before the panel repaints.
    onViewVisible: () => void monitorService?.refreshQuotaNow(),
    // Every setting is native to VS Code; the panel only links to the settings UI.
    onOpenSettings: () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Zahed-r.antigravity-session-monitor');
    },
    initialLayout: initialPanelLayout as any,
    onLayoutChange: (layout) => {
      void context.globalState.update('antigravityMonitor.panelLayout.v1', layout);
    },
    onSwitchAccount: (email) => void handleSwitchAccount(email),
    onAddAccount: () => void handleAddAccount(),
    onSaveCurrentAccount: () => void handleSaveCurrentAccount(),
    onEditAccount: (email, field) => void handleEditAccount(email, field),
    onRemoveAccount: (email) => void handleRemoveAccount(email),
    onReauthAccount: (email) => void handleReauthAccount(email),
    onExportHistory: (format) => void handleExportHistory(format),
    onExportAccounts: () => void handleExportAccounts(),
    onImportAccounts: () => void handleImportAccounts(),
    onReconnectHub: () => void handleReconnectHub(),
    onRestartBackend: () => void handleRestartBackend(),
    onInspectBridge: () => void handleInspectBridge(),
    getAccountSnapshots: buildMatrixSnapshots,
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
    sqliteBackend: sqliteClient.backend,
    accountStore,
    historyStore,
    alertService,
    vaultService,
    onQuotaAlerts: handleQuotaAlerts,
    hostDiagnostics: { hostEditor: vscode.env.appName, isStandaloneIde },
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

  // Register all 12 commands
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
        onManageAccounts: () => void vscode.commands.executeCommand('antigravityMonitor.switchAccount'),
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

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityMonitor.resetPanelLayout', async () => {
      panelProvider.controller.resetLayout();
      await vscode.window.showInformationMessage('GravityWatch: panel layout reset to defaults.');
    }),
  );

  // --- Multi-account command implementations ---

  /** Publishes AccountStore changes into the live MonitorState so the panel repaints. */
  function publishAccounts(): void {
    if (!monitorService) return;
    const state = monitorService.getState();
    state.accounts = accountStore.listAccounts();
    panelProvider.controller.update(state);
  }

  /** Per-Account snapshots (AccountStore applies reset-time staleness for inactive ones). */
  function buildMatrixSnapshots(): Record<string, QuotaSnapshot | null> {
    const state = monitorService?.getState();
    // The activeAccount label can be stale on an anonymous-bucket poll (carry-forward #1):
    // only skip staleness for the row the header already trusts, so an expired snapshot
    // attributed to a non-authoritative account still renders its stale badge.
    const view = state ? resolveActiveAccountView(state) : { kind: 'none' as const };
    const verifiedActiveEmail = view.kind === 'known' ? view.email : null;
    const out: Record<string, QuotaSnapshot | null> = {};
    for (const account of accountStore.listAccounts()) {
      out[account.email] = accountStore.getSnapshot(account.email, account.email === verifiedActiveEmail);
    }
    return out;
  }

  async function switchToAccountFlow(email: string): Promise<void> {
    pendingKeyringTarget = email.trim().toLowerCase();
    try {
      const result = await switcher.switchToAccount(email);
      if (result.ok) {
        if (result.requiresReload) {
          const choice = await vscode.window.showWarningMessage(
            `GravityWatch: switched to ${email}. Reload the window to apply.${result.message ? ` (${result.message})` : ''}`,
            'Reload Window',
          );
          if (choice === 'Reload Window') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        } else {
          vscode.window.showInformationMessage(
            `GravityWatch: switch to ${email} started (${result.mode}).`,
          );
        }
      } else {
        // Never report success on failure; surface the reason and the real
        // recovery state: a restored .bak is NOT a manual-restore instruction (I5).
        const bakHint = switchFailureRecoveryHint(result.message);
        vscode.window.showErrorMessage(
          `GravityWatch: switch to ${email} failed${result.message ? ` (${result.message})` : ''}.${bakHint}`,
        );
      }
    } finally {
      pendingKeyringTarget = null;
    }
  }

  async function handleSwitchAccount(email?: string): Promise<void> {
    let target = email;
    if (!target) {
      const accounts = monitorService?.getState().accounts ?? accountStore.listAccounts();
      if (accounts.length === 0) {
        vscode.window.showInformationMessage('GravityWatch: no saved Accounts yet. Use Sign In to add one.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        accounts.map((a) => ({
          label: a.label ?? a.email,
          description: [a.group, a.plan].filter(Boolean).join(' · '),
          email: a.email,
        })),
        { placeHolder: 'Switch to which Account?' },
      );
      target = picked?.email;
    }
    if (target) {
      await switchToAccountFlow(target);
    }
  }

  async function handleSaveCurrentAccount(): Promise<void> {
    const active = monitorService?.getState().activeAccount;
    if (!active) {
      vscode.window.showInformationMessage('GravityWatch: no active Account to save.');
      return;
    }
    try {
      const result = await vaultService.captureActiveCredential(active.email);
      if (result.captured) {
        vscode.window.showInformationMessage(`GravityWatch: saved the credential for ${active.email} to the vault.`);
      } else {
        vscode.window.showWarningMessage(`GravityWatch: could not save the credential (${result.reason}).`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`GravityWatch: saving the credential failed (${String(err)}).`);
    }
  }

  async function handleAddAccount(): Promise<void> {
    const result = await switcher.addAccountViaOfficialLogin();
    if (result.ok) {
      vscode.window.showInformationMessage(
        `GravityWatch: official sign-in started${result.email ? ` for ${result.email}` : ''}.`,
      );
      await monitorService?.refreshQuotaNow();
    } else {
      vscode.window.showErrorMessage(`GravityWatch: sign-in failed (${result.message ?? 'unknown reason'}).`);
    }
  }

  async function handleEditAccount(email: string, field: AccountEditField): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const current = accountStore.listAccounts().find((a) => a.email === normalized);
    const prompt = field === 'label' ? 'Account label' : field === 'group' ? 'Account group' : 'Account color tag';
    const oldValue = field === 'label' ? current?.label : field === 'group' ? current?.group : current?.colorTag;
    const value = await vscode.window.showInputBox({ prompt, value: oldValue ?? '' });
    if (value === undefined) return;
    const patch =
      field === 'label' ? { label: value } : field === 'group' ? { group: value } : { colorTag: value };
    const updated = await accountStore.updateMetadata(normalized, patch);
    if (updated) {
      publishAccounts();
    } else {
      vscode.window.showWarningMessage(`GravityWatch: Account ${normalized} not found.`);
    }
  }

  async function handleRemoveAccount(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const confirm = await vscode.window.showWarningMessage(
      `Remove the saved Account ${normalized}?`,
      { modal: true },
      'Remove',
    );
    if (confirm !== 'Remove') return;
    const activeEmail = monitorService?.getState().activeAccount?.email ?? null;
    const result = await accountStore.removeAccount(normalized, activeEmail);
    if (result.removed) {
      // C4: the vault credential and index entry must not outlive the removed
      // Account. Best effort: a purge failure never undoes the removal but is
      // surfaced in the confirmation message instead of being swallowed.
      const purgeNote = await purgeRemovedAccountCredential(vaultService, normalized);
      vscode.window.showInformationMessage(`GravityWatch: removed ${normalized}.${purgeNote}`);
      publishAccounts();
    } else if (result.reason === 'active_account') {
      vscode.window.showWarningMessage(
        `GravityWatch: ${normalized} is the active Account. Switch to another Account or sign out before removing it.`,
      );
    } else {
      vscode.window.showWarningMessage(`GravityWatch: Account ${normalized} not found.`);
    }
  }

  async function handleReauthAccount(email: string): Promise<void> {
    // M3: re-auth logs the current session out — validate against the registry
    // and require the same modal confirmation as removeAccount.
    const normalized = email.trim().toLowerCase();
    if (!accountStore.listAccounts().some((a) => a.email === normalized)) {
      vscode.window.showWarningMessage(`GravityWatch: Account ${normalized} is not a known Account.`);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Sign out and re-authenticate the Account ${normalized}? The current session will be logged out.`,
      { modal: true },
      'Re-authenticate',
    );
    if (confirm !== 'Re-authenticate') return;
    const result = await switcher.reauthAccount(normalized);
    if (result.ok) {
      vscode.window.showInformationMessage(`GravityWatch: re-auth started for ${email}.`);
      await monitorService?.refreshQuotaNow();
    } else {
      vscode.window.showErrorMessage(`GravityWatch: re-auth failed (${result.message ?? 'unknown reason'}).`);
    }
  }

  async function pickSaveFile(fileName: string, filters: Record<string, string[]>): Promise<vscode.Uri | undefined> {
    return vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(fileName), filters });
  }

  async function handleExportHistory(format: 'csv' | 'json'): Promise<void> {
    const accountsMap = new Map(accountStore.listAccounts().map((a) => [a.email, a]));
    const content =
      format === 'csv' ? historyStore.exportCsv(accountsMap, 30) : historyStore.exportJson(accountsMap, 30);
    const target = await pickSaveFile(
      `gravitywatch-quota-history.${format}`,
      format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
    );
    if (!target) return;
    try {
      await fs.promises.writeFile(target.fsPath, content, 'utf8');
      vscode.window.showInformationMessage(`GravityWatch: quota history exported to ${target.fsPath}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`GravityWatch: export failed (${String(err)}).`);
    }
  }

  async function handleExportAccounts(): Promise<void> {
    const target = await pickSaveFile('gravitywatch-accounts.json', { JSON: ['json'] });
    if (!target) return;
    try {
      await fs.promises.writeFile(target.fsPath, accountStore.exportBackupJson(), 'utf8');
      vscode.window.showInformationMessage(`GravityWatch: Account metadata exported to ${target.fsPath}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`GravityWatch: export failed (${String(err)}).`);
    }
  }

  async function handleImportAccounts(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { JSON: ['json'] },
    });
    const file = picked?.[0];
    if (!file) return;
    let raw: string;
    try {
      raw = await fs.promises.readFile(file.fsPath, 'utf8');
    } catch (err) {
      vscode.window.showErrorMessage(`GravityWatch: could not read the backup file (${String(err)}).`);
      return;
    }
    try {
      const { imported, skipped } = await accountStore.importBackupJson(raw);
      vscode.window.showInformationMessage(
        `GravityWatch: imported ${imported} Account${imported === 1 ? '' : 's'} (${skipped} skipped).`,
      );
      publishAccounts();
    } catch (err) {
      // importBackupJson throws on unparseable/unsupported JSON: show it, never crash.
      vscode.window.showErrorMessage(`GravityWatch: Account import failed (${String(err)}).`);
    }
  }

  async function handleReconnectHub(): Promise<void> {
    await refreshEndpointCache();
    await monitorService?.refreshQuotaNow();
    const state = monitorService?.getState();
    if (state?.hubStatus === 'connected') {
      vscode.window.showInformationMessage(`GravityWatch: hub reconnected on port ${state.hubPort ?? '?'}.`);
    } else {
      vscode.window.showWarningMessage('GravityWatch: no local hub answered. Is Antigravity running?');
    }
  }

  async function handleRestartBackend(): Promise<void> {
    const pid = monitorService?.getState().diagnostics?.hubPid ?? null;
    if (!pid) {
      vscode.window.showWarningMessage('GravityWatch: no hub backend process detected.');
      return;
    }
    const ok = await hubAuthClient.restartBackendProcess(pid, execFileAsync);
    if (ok) {
      vscode.window.showInformationMessage('GravityWatch: backend restart requested; the hub is rediscovered on the next poll.');
      await monitorService?.refreshQuotaNow();
    } else {
      vscode.window.showErrorMessage('GravityWatch: failed to restart the backend process.');
    }
  }

  function handleInspectBridge(): void {
    const state = monitorService?.getState();
    const d = state?.diagnostics;
    const parts = [
      `editor: ${d?.hostEditor ?? 'unknown'}`,
      `os: ${d?.platform ?? 'unknown'}`,
      `keyring: ${d?.osKeyringSupported ? d.osKeyringBackend : 'unsupported'}`,
      `hub: ${state?.hubStatus ?? 'unknown'}`,
      `port: ${state?.hubPort ?? '—'}${state?.hubSource ? ` (${state.hubSource})` : ''}`,
      `pid: ${d?.hubPid ?? '—'}`,
      `sqlite: ${state?.sqliteBackend ?? 'unknown'}`,
    ];
    vscode.window.showInformationMessage(`GravityWatch bridge — ${parts.join(' · ')}`);
  }

  function handleQuotaAlerts(events: QuotaAlertEvent[]): void {
    for (const event of events) {
      const pct = event.pools.length > 0 ? Math.min(...event.pools.map((p) => p.remainingPct)) : null;
      if (event.kind === 'reset') {
        void vscode.window.showInformationMessage(`GravityWatch: a quota window reset for ${event.email}.`);
      } else if (event.kind === 'exhausted') {
        if (event.bestAlternative) {
          const alt = event.bestAlternative;
          void vscode.window
            .showWarningMessage(
              `GravityWatch: quota exhausted for ${event.email} (0%).`,
              `Switch to ${alt.label ?? alt.email}`,
            )
            .then((choice) => {
              if (choice) void switchToAccountFlow(alt.email);
            });
        } else {
          void vscode.window.showWarningMessage(`GravityWatch: quota exhausted for ${event.email} (0%).`);
        }
      } else {
        void vscode.window.showWarningMessage(
          `GravityWatch: low quota for ${event.email} (${pct ?? '?'}% remaining).`,
        );
      }
    }
  }

  function registerCommand(id: string, cb: (...args: any[]) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(id, cb));
  }

  registerCommand('antigravityMonitor.switchAccount', (email?: string) => handleSwitchAccount(typeof email === 'string' ? email : undefined));
  registerCommand('antigravityMonitor.saveCurrentAccount', () => handleSaveCurrentAccount());
  registerCommand('antigravityMonitor.addAccount', () => handleAddAccount());
  registerCommand('antigravityMonitor.editAccountLabel', () => handleEditAccountFlow());
  registerCommand('antigravityMonitor.removeSavedAccount', () => handleRemoveAccountFlow());
  registerCommand('antigravityMonitor.exportAccounts', () => handleExportAccounts());
  registerCommand('antigravityMonitor.importAccounts', () => handleImportAccounts());
  registerCommand('antigravityMonitor.exportQuotaAnalytics', () => handleExportQuotaAnalytics());
  registerCommand('antigravityMonitor.reconnectHub', () => handleReconnectHub());
  registerCommand('antigravityMonitor.restartBackend', () => handleRestartBackend());
  registerCommand('antigravityMonitor.inspectBridge', () => handleInspectBridge());
  registerCommand('antigravityMonitor.clearTokenVault', () => handleClearTokenVault());

  async function handleEditAccountFlow(): Promise<void> {
    const accounts = accountStore.listAccounts();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage('GravityWatch: no saved Accounts to edit.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((a) => ({ label: a.label ?? a.email, description: a.email, email: a.email })),
      { placeHolder: 'Edit which Account?' },
    );
    if (picked) await handleEditAccount(picked.email, 'label');
  }

  async function handleRemoveAccountFlow(): Promise<void> {
    const accounts = accountStore.listAccounts();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage('GravityWatch: no saved Accounts to remove.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((a) => ({ label: a.label ?? a.email, description: a.email, email: a.email })),
      { placeHolder: 'Remove which saved Account?' },
    );
    if (picked) await handleRemoveAccount(picked.email);
  }

  async function handleExportQuotaAnalytics(): Promise<void> {
    const format = await vscode.window.showQuickPick(
      [
        { label: '$(markdown) Export CSV', format: 'csv' as const },
        { label: '$(json) Export JSON', format: 'json' as const },
      ],
      { placeHolder: 'Export 30-day quota analytics as…' },
    );
    if (format) await handleExportHistory(format.format);
  }

  async function handleClearTokenVault(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Delete all vaulted Account credentials from SecretStorage? You will need to re-auth every saved Account.',
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') return;
    try {
      await vaultService.clearAll();
      vscode.window.showInformationMessage('GravityWatch: token vault cleared.');
    } catch (err) {
      vscode.window.showErrorMessage(`GravityWatch: clearing the token vault failed (${String(err)}).`);
    }
  }

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
