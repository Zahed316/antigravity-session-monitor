/**
 * The single place production services are constructed, extracted from
 * activate() so the dep wiring is testable under plain node:test with fake
 * adapters (branch-review C1: three production-dead code paths survived green
 * tests because construction was buried in the activate() closure).
 */
import { AccountStore, type GlobalStateAdapter } from './accounts/accountStore.ts';
import { QuotaHistoryStore } from './accounts/quotaHistoryStore.ts';
import {
  TokenVaultService,
  type SecretStorageAdapter,
  type VaultExecFileAsync,
} from './accounts/tokenVaultService.ts';
import { AccountSwitcher } from './accounts/accountSwitcher.ts';
import { QuotaAlertService } from './accounts/quotaAlertService.ts';
import { HubClient } from './rpc/hubClient.ts';
import { HubAuthClient, type HubAuthVscodeApi } from './rpc/hubAuth.ts';
import type { HubEndpoint } from './rpc/hubDiscovery.ts';
import type { StandaloneIdeInfo } from './accounts/ideStateService.ts';
import { createKeyringVerifier, createTokenVaultDeps } from './accounts/vaultWiring.ts';

export interface CoreServiceDeps {
  secrets: SecretStorageAdapter;
  globalState: GlobalStateAdapter;
  globalStorageDir: string;
  platform: NodeJS.Platform;
  execFileAsync: VaultExecFileAsync;
  isStandaloneIde: boolean;
  standaloneIdeInfo: StandaloneIdeInfo | null;
  workspacePaths: string[];
  env: NodeJS.ProcessEnv;
  getActiveEmail: () => string | null;
  confirmSwitch: (email: string) => Promise<boolean>;
  quitIde: () => Promise<void>;
  getPendingKeyringTarget: () => string | null;
  getEndpoint: () => HubEndpoint | null;
  vscodeApi?: HubAuthVscodeApi;
  now?: () => number;
}

export interface CoreServices {
  accountStore: AccountStore;
  historyStore: QuotaHistoryStore;
  vaultService: TokenVaultService;
  switcher: AccountSwitcher;
  alertService: QuotaAlertService;
  hubClient: HubClient;
  hubAuthClient: HubAuthClient;
  verifyKeyringSync: () => Promise<boolean>;
}

export async function createCoreServices(deps: CoreServiceDeps): Promise<CoreServices> {
  const accountStore = new AccountStore({
    globalState: deps.globalState,
    globalStorageUri: deps.globalStorageDir,
  });
  const historyStore = new QuotaHistoryStore(deps.globalStorageDir);
  // Full vault deps via the tested factory (accounts/vaultWiring.ts): a real
  // PATH-aware which, execFileAsync, and readIdeState only when the standalone
  // IDE's state.vscdb exists. Plain VS Code hosts stay a clean
  // `ide_state_unavailable` (no VS Code credential reader exists).
  const vaultService = new TokenVaultService(
    createTokenVaultDeps({
      secrets: deps.secrets,
      platform: deps.platform,
      execFileAsync: deps.execFileAsync,
      isStandaloneIde: deps.isStandaloneIde,
      standaloneStateDbPath: deps.standaloneIdeInfo?.stateDbPath ?? null,
      ...(deps.now ? { now: deps.now } : {}),
    }),
  );
  await accountStore.load();
  await historyStore.load();

  const hubClient = new HubClient();
  const hubAuthClient = new HubAuthClient();

  // Byte-compares the re-read keyring secret against the exact written
  // payload; any stale/different entry fails and the official-login
  // self-heal runs (fail closed).
  const verifyKeyringSync = createKeyringVerifier({
    platform: deps.platform,
    execFileAsync: deps.execFileAsync,
    getCredential: (email) => vaultService.getCredential(email),
    getTargetEmail: deps.getPendingKeyringTarget,
  });

  const switcher = new AccountSwitcher({
    vault: vaultService,
    accounts: accountStore,
    hubAuth: hubAuthClient,
    getEndpoint: deps.getEndpoint,
    vscodeApi: deps.vscodeApi,
    isStandaloneIde: deps.isStandaloneIde,
    confirmSwitch: deps.confirmSwitch,
    quitIde: deps.quitIde,
    env: deps.env,
    globalStorageDir: deps.globalStorageDir,
    ...(deps.standaloneIdeInfo ? { ideInfo: deps.standaloneIdeInfo } : {}),
    getActiveEmail: deps.getActiveEmail,
    verifyKeyringSync,
  });

  const alertService = new QuotaAlertService();

  return {
    accountStore,
    historyStore,
    vaultService,
    switcher,
    alertService,
    hubClient,
    hubAuthClient,
    verifyKeyringSync,
  };
}
