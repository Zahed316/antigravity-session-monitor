import type { HubAuthVscodeApi } from '../rpc/hubAuth.ts';
import type { HubEndpoint } from '../rpc/hubDiscovery.ts';
import type { AccountAuthStatus } from '../types.ts';
import {
  performStandaloneIdeSwitch as performStandaloneIdeSwitchDefault,
  type StandaloneIdeInfo,
  type StandaloneSwitchParams,
} from './ideStateService.ts';
import type { VaultCapabilities, VaultCredentialRecord, VaultIdeState } from './tokenVaultService.ts';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Structural surface of `TokenVaultService` used by the switcher. */
export interface SwitcherVault {
  getCredential(email: string): Promise<{ record: VaultCredentialRecord | null; corruptPurged: boolean }>;
  getCapabilities(): Promise<VaultCapabilities>;
  applyToOsKeyring(email: string): Promise<{ applied: boolean; reason?: string }>;
  captureActiveCredential(
    email: string,
    options?: { isStandaloneIde?: boolean },
  ): Promise<{ captured: boolean; reason?: string }>;
}

export interface SwitcherAccounts {
  setStatus(email: string, status: AccountAuthStatus): Promise<void> | void;
}

export interface SwitcherHubAuth {
  login(endpoint: HubEndpoint, vscodeApi?: HubAuthVscodeApi): Promise<boolean>;
  logout(endpoint: HubEndpoint): Promise<boolean>;
  syncOfficialUi(vscodeApi: HubAuthVscodeApi): Promise<boolean>;
}

export type AccountSwitchMode = 'standalone-restart' | 'keyring-sync' | 'official-login' | 'cancelled' | 'failed';

export interface AccountSwitchResult {
  ok: boolean;
  mode: AccountSwitchMode;
  requiresReload?: boolean;
  message?: string;
}

export type PerformStandaloneIdeSwitchFn = (
  params: StandaloneSwitchParams,
) => Promise<{ launched: boolean; reason?: string; backupPath?: string }> | { launched: boolean; reason?: string; backupPath?: string };

export interface AccountSwitcherDeps {
  vault: SwitcherVault;
  accounts: SwitcherAccounts;
  hubAuth: SwitcherHubAuth;
  getEndpoint: () => HubEndpoint | null;
  vscodeApi?: HubAuthVscodeApi;
  /** True on the Antigravity standalone IDE (see isAntigravityStandaloneIde). */
  isStandaloneIde?: boolean;
  /** Confirmation prompt for every credential-mutating mode; when absent the mutation is refused (fail closed). */
  confirmSwitch?: (targetEmail: string) => Promise<boolean> | boolean;
  performStandaloneIdeSwitch?: PerformStandaloneIdeSwitchFn;
  /** Asks the standalone IDE to quit after the worker is launched (e.g. the `workbench.action.quit` command). */
  quitIde?: () => Promise<void> | void;
  /** Parent environment passed to the detached switch worker (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Verifies the OS keyring write actually took effect for the target (re-read
   * the keyring, or observe that GetUserStatus reports the target email).
   * Without it the keyring write is treated as unverified and skipped.
   */
  verifyKeyringSync?: () => Promise<boolean> | boolean;
  getActiveEmail?: () => string | null;
  globalStorageDir?: string;
  ideInfo?: StandaloneIdeInfo;
  platform?: NodeJS.Platform;
}

export class AccountSwitcher {
  private readonly vault: SwitcherVault;
  private readonly accounts: SwitcherAccounts;
  private readonly hubAuth: SwitcherHubAuth;
  private readonly getEndpoint: () => HubEndpoint | null;
  private readonly vscodeApi: HubAuthVscodeApi | undefined;
  private readonly isStandaloneIde: boolean;
  private readonly confirmSwitch: ((targetEmail: string) => Promise<boolean> | boolean) | null;
  private readonly performSwitch: PerformStandaloneIdeSwitchFn;
  private readonly verifyKeyringSync: (() => Promise<boolean> | boolean) | null;
  private readonly getActiveEmail: (() => string | null) | null;
  private readonly globalStorageDir: string | undefined;
  private readonly ideInfo: StandaloneIdeInfo | undefined;
  private readonly platform: NodeJS.Platform | undefined;
  private readonly quitIde: (() => Promise<void> | void) | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(deps: AccountSwitcherDeps) {
    this.vault = deps.vault;
    this.accounts = deps.accounts;
    this.hubAuth = deps.hubAuth;
    this.getEndpoint = deps.getEndpoint;
    this.vscodeApi = deps.vscodeApi;
    this.isStandaloneIde = deps.isStandaloneIde ?? false;
    this.confirmSwitch = deps.confirmSwitch ?? null;
    this.performSwitch = deps.performStandaloneIdeSwitch ?? performStandaloneIdeSwitchDefault;
    this.verifyKeyringSync = deps.verifyKeyringSync ?? null;
    this.getActiveEmail = deps.getActiveEmail ?? null;
    this.globalStorageDir = deps.globalStorageDir;
    this.ideInfo = deps.ideInfo;
    this.platform = deps.platform;
    this.quitIde = deps.quitIde;
    this.env = deps.env;
  }

  /**
   * Switches the host to the target account.
   *
   * Routing:
   * 1. Standalone IDE + valid vault credential -> confirmation -> standalone
   *    switch worker (targeted SQLite write + IDE restart).
   * 2. VS Code / Cursor + valid vault + supported OS keyring -> capture the
   *    current account, write the keyring, VERIFY (task-7 rule 4), sync the
   *    official UI; `requiresReload` when the UI sync fails.
   * 3. Anything else (missing/corrupt vault, unsupported keyring, failed
   *    verification) -> official AuthLogout + Login via the hub.
   */
  async switchToAccount(targetEmail: string): Promise<AccountSwitchResult> {
    const email = normalizeEmail(targetEmail);
    if (!email) {
      return { ok: false, mode: 'failed', message: 'invalid_email' };
    }
    // Every credential-mutating mode below (standalone worker, keyring write,
    // official login fallback) requires explicit confirmation; an absent
    // confirmSwitch is a refusal (fail closed), never consent (I1).
    const confirmed = this.confirmSwitch !== null ? await this.confirmSwitch(email) : false;
    if (!confirmed) {
      return { ok: false, mode: 'cancelled', message: 'switch_cancelled' };
    }
    const { record, corruptPurged } = await this.vault.getCredential(email);
    if (!record || corruptPurged) {
      // Fail-closed (task-7 rule 3): a missing or email-mismatched vault
      // credential is never written to state.vscdb or the OS keyring.
      await this.accounts.setStatus(email, 'needs_reauth');
      return this.officialLoginFallback('no_valid_vault_credential');
    }

    if (this.isStandaloneIde) {
      const ideState = this.ideStateFromRecord(record);
      if (!ideState?.oauthToken) {
        await this.accounts.setStatus(email, 'needs_reauth');
        return this.officialLoginFallback('no_vaulted_ide_state');
      }
      const outcome = await this.performSwitch({
        targetEmail: email,
        ideState,
        globalStorageDir: this.globalStorageDir ?? '',
        ideInfo: this.ideInfo,
        platform: this.platform,
        env: this.env,
        quitIde: this.quitIde,
      });
      const backupHint = outcome.backupPath ? ` (backup at ${outcome.backupPath})` : '';
      if (!outcome.launched) {
        // Real worker outcome (wal_timeout / bak_copy_failed / write_failed /
        // switch_result_timeout): never report an optimistic success.
        return { ok: false, mode: 'failed', message: `${outcome.reason ?? 'standalone_switch_failed'}${backupHint}` };
      }
      return { ok: true, mode: 'standalone-restart', message: `standalone_switch_launched${backupHint}` };
    }

    // VS Code / Cursor host.
    const capabilities = await this.vault.getCapabilities();
    // SAFETY (task-7 rule 4): the OS keyring payload written by
    // TokenVaultService.applyToOsKeyring is an UNVERIFIED encoding for the real
    // Antigravity client (no repo artifact documents the expected
    // `gemini:antigravity` format). The write therefore only happens when a
    // verifier is wired, and is treated as successful only when the verifier
    // confirms it (re-read, or GetUserStatus reporting the target email). On
    // missing/failed verification we fall back to official AuthLogout + Login,
    // which rewrites the keyring entry through the official client
    // (self-healing) instead of clobbering a working entry with a bad payload.
    if (capabilities.osKeyringSupported && this.verifyKeyringSync !== null) {
      // Preserve the currently working credential before overwriting the keyring.
      // Note the unavoidable verify-after-write window: the keyring holds the
      // unverified payload from the applyToOsKeyring call until verification
      // completes; a failed verification is healed by the official login
      // fallback below, which rewrites the entry through the official client.
      const activeEmail = this.getActiveEmail?.() ?? null;
      if (activeEmail && normalizeEmail(activeEmail) !== email) {
        try {
          await this.vault.captureActiveCredential(normalizeEmail(activeEmail));
        } catch {
          // Best-effort capture: never block the switch on it.
        }
      }
      const applied = await this.vault.applyToOsKeyring(email);
      if (applied.applied) {
        const verified = await Promise.resolve()
          .then(() => this.verifyKeyringSync!())
          .catch(() => false);
        if (verified) {
          const synced = this.vscodeApi ? await this.hubAuth.syncOfficialUi(this.vscodeApi) : false;
          return {
            ok: true,
            mode: 'keyring-sync',
            ...(synced ? {} : { requiresReload: true, message: 'ui_sync_failed_reload_required' }),
          };
        }
      }
      return this.officialLoginFallback(applied.applied ? 'keyring_sync_unverified' : 'keyring_write_failed');
    }
    return this.officialLoginFallback(
      capabilities.osKeyringSupported ? 'keyring_sync_unverifiable' : 'keyring_unsupported',
    );
  }

  /** Triggers the official Antigravity sign-in flow for a brand-new account. */
  async addAccountViaOfficialLogin(): Promise<{ ok: boolean; email?: string; message?: string }> {
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      return { ok: false, message: 'hub_unreachable' };
    }
    const ok = await this.hubAuth.login(endpoint, this.vscodeApi).catch(() => false);
    if (!ok) {
      return { ok: false, message: 'login_refused' };
    }
    const email = this.getActiveEmail?.() ?? null;
    return { ok: true, ...(email ? { email } : {}) };
  }

  /** Marks the account for re-auth and runs the official logout + login cycle. */
  async reauthAccount(email: string): Promise<{ ok: boolean; message?: string }> {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      return { ok: false, message: 'invalid_email' };
    }
    // AuthLogout + Login mutates the official sign-in state: confirm first,
    // and treat an absent confirmSwitch as a refusal (fail closed, I1).
    const confirmed = this.confirmSwitch !== null ? await this.confirmSwitch(normalized) : false;
    if (!confirmed) {
      return { ok: false, message: 'switch_cancelled' };
    }
    await this.accounts.setStatus(normalized, 'needs_reauth');
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      return { ok: false, message: 'hub_unreachable' };
    }
    await this.hubAuth.logout(endpoint).catch(() => false);
    const ok = await this.hubAuth.login(endpoint, this.vscodeApi).catch(() => false);
    return ok ? { ok: true } : { ok: false, message: 'login_refused' };
  }

  private ideStateFromRecord(record: VaultCredentialRecord): VaultIdeState | null {
    if (record.ideState?.oauthToken) {
      return record.ideState;
    }
    if (record.blobBase64) {
      // blobBase64 is base64 of the captured ideState.oauthToken (utf8).
      const token = Buffer.from(record.blobBase64, 'base64').toString('utf8');
      if (token) {
        return { oauthToken: token };
      }
    }
    return null;
  }

  private async officialLoginFallback(reason: string): Promise<AccountSwitchResult> {
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      return { ok: false, mode: 'official-login', message: `${reason}: hub_unreachable` };
    }
    await this.hubAuth.logout(endpoint).catch(() => false);
    const loggedIn = await this.hubAuth.login(endpoint, this.vscodeApi).catch(() => false);
    return {
      ok: loggedIn,
      mode: 'official-login',
      message: loggedIn ? `official_login_started (${reason})` : `${reason}: login_refused`,
    };
  }
}
